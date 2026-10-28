import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  FREEZE_PASSES_MAX,
  killChildTree,
  killProcessTree,
  type ProcessRow,
  type ProcessSystem,
  procStatRow,
} from "./process-group.ts";
import { killIfPresent } from "./test-support.ts";

const OWN_GROUP = 500;
const LEADER = 1000;
const CHILD = 1001;
const GRANDCHILD = 1002;
const FORKED = 1003;
const FOREIGN = 2000;
const STOP = "SIGSTOP";
const KILL = "SIGKILL";
const ESCAPED_SECONDS = 60;
const FORK_INTERVAL_MS = 5;
const FORKS_BEFORE_KILL = 5;
const FORKS_MAX = 50;
const POLLS = 100;
const START_POLLS = 500;
const TWO_FAILURES = 2;
const NO_READS = 0;
const NO_PROCESSES = 0;
const ONE_ORPHAN = 1;
const FIRST_READ = 1;
const POLL_MS = 20;

const ownRow: ProcessRow = {
  pid: process.pid,
  ppid: process.ppid,
  group: OWN_GROUP,
};
const leaderRow: ProcessRow = { pid: LEADER, ppid: 1, group: LEADER };

function recordingSystem(tables: (() => ProcessRow[])[]) {
  const signals: string[] = [];
  let reads = 0;
  const system: ProcessSystem = {
    readTable: () => {
      const table = tables[Math.min(reads, tables.length - 1)]!;
      reads += 1;
      return table();
    },
    signalGroup: (group, signal) => {
      signals.push(`${signal} ${group}`);
    },
  };
  return { system, signals, reads: () => reads };
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

test("the tree kill never signals its own group, also when a descendant joins it", () => {
  const { system, signals } = recordingSystem([
    () => [
      ownRow,
      leaderRow,
      { pid: CHILD, ppid: LEADER, group: OWN_GROUP },
      { pid: GRANDCHILD, ppid: CHILD, group: GRANDCHILD },
      { pid: FOREIGN, ppid: 1, group: FOREIGN },
    ],
  ]);
  killProcessTree(LEADER, system);
  assert.deepEqual(signals, [
    `${STOP} ${LEADER}`,
    `${STOP} ${GRANDCHILD}`,
    `${KILL} ${LEADER}`,
    `${KILL} ${GRANDCHILD}`,
  ]);
});

test("a failed table read kills the leader group and throws the read error", () => {
  const failure = new Error("table read failed");
  const { system, signals } = recordingSystem([
    () => {
      throw failure;
    },
  ]);
  assert.throws(() => killProcessTree(LEADER, system), failure);
  assert.deepEqual(signals, [`${KILL} ${LEADER}`]);
});

test("a group that a descendant forks during the freeze is stopped and killed", () => {
  const { system, signals } = recordingSystem([
    () => [ownRow, leaderRow],
    () => [ownRow, leaderRow, { pid: FORKED, ppid: LEADER, group: FORKED }],
  ]);
  killProcessTree(LEADER, system);
  assert.deepEqual(signals, [
    `${STOP} ${LEADER}`,
    `${STOP} ${FORKED}`,
    `${KILL} ${LEADER}`,
    `${KILL} ${FORKED}`,
  ]);
});

test("a tree that still forks after the pass limit is killed with one more read and throws the limit", () => {
  let next = FORKED;
  const { system, signals, reads } = recordingSystem([
    () => {
      next += 1;
      return [ownRow, leaderRow, { pid: next, ppid: LEADER, group: next }];
    },
  ]);
  assert.throws(
    () => killProcessTree(LEADER, system),
    new RegExp(`kept forking after ${FREEZE_PASSES_MAX} passes`),
  );
  assert.equal(reads(), FREEZE_PASSES_MAX + 1);
  assert.equal(
    signals.filter((signal) => signal.startsWith(KILL)).length,
    FREEZE_PASSES_MAX + 2,
  );
});

test("a table read error after a stop still kills the stopped group and throws both failures", () => {
  const readFailure = new Error("table read failed");
  let reads = 0;
  const signals: string[] = [];
  const system: ProcessSystem = {
    readTable: () => {
      reads += 1;
      if (reads > FIRST_READ) throw readFailure;
      return [ownRow, leaderRow, { pid: CHILD, ppid: LEADER, group: CHILD }];
    },
    signalGroup: (group, signal) => {
      signals.push(`${signal} ${group}`);
      if (signal === KILL && group === CHILD) throw errorWithCode("EPERM");
    },
  };
  assert.throws(
    () => killProcessTree(LEADER, system),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.includes(readFailure) &&
      error.errors.length === TWO_FAILURES,
  );
  assert.deepEqual(
    signals.filter((signal) => signal.startsWith(KILL)),
    [`${KILL} ${LEADER}`, `${KILL} ${CHILD}`],
  );
});

test("an absent group is no failure, one failure throws itself and two throw an AggregateError", () => {
  const table = () => [
    ownRow,
    leaderRow,
    { pid: CHILD, ppid: LEADER, group: CHILD },
    { pid: GRANDCHILD, ppid: LEADER, group: GRANDCHILD },
  ];
  const failing = (codes: Record<number, string>): ProcessSystem => ({
    readTable: table,
    signalGroup: (group, signal) => {
      const code = codes[group];
      if (signal === KILL && code !== undefined) throw errorWithCode(code);
    },
  });
  killProcessTree(LEADER, failing({ [CHILD]: "ESRCH" }));
  assert.throws(
    () => killProcessTree(LEADER, failing({ [CHILD]: "EPERM" })),
    /EPERM/,
  );
  assert.throws(
    () =>
      killProcessTree(
        LEADER,
        failing({ [CHILD]: "EPERM", [GRANDCHILD]: "EPERM" }),
      ),
    (error: unknown) =>
      error instanceof AggregateError && error.errors.length === TWO_FAILURES,
  );
});

test("a kill after the leader exited signals only the leader group and walks no table", () => {
  for (const exited of [
    { exitCode: 0, signalCode: null },
    { exitCode: null, signalCode: KILL },
  ]) {
    const { system, signals, reads } = recordingSystem([() => [ownRow]]);
    killChildTree({ pid: LEADER, ...exited }, system);
    assert.equal(reads(), NO_READS);
    assert.deepEqual(signals, [`${KILL} ${LEADER}`]);
  }
});

function markedPids(marker: string): number[] {
  return execFileSync("/bin/ps", ["-A", "-o", "pid=,command="], {
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.includes(`sleep ${marker}`))
    .map((line) => Number.parseInt(line.trim(), 10));
}

async function settledPids(marker: string): Promise<number[]> {
  for (let poll = 0; poll < POLLS; poll += 1) {
    if (markedPids(marker).length === NO_PROCESSES) return [];
    await delay(POLL_MS);
  }
  return markedPids(marker);
}

function uniqueSeconds(): string {
  return `${ESCAPED_SECONDS}.${process.pid}${Date.now() % 100000}`;
}

function detachedLeader(t: TestContext, script: string) {
  const leader = spawn("/bin/sh", ["-c", script], {
    detached: true,
    stdio: "ignore",
  });
  assert.ok(leader.pid);
  t.after(() => {
    if (leader.exitCode === null && leader.signalCode === null)
      killIfPresent(leader.pid!);
  });
  return leader.pid;
}

test("a descendant that forks into new groups during the kill leaves no process", async (t) => {
  const seconds = uniqueSeconds();
  const forker = `const {spawn}=require("node:child_process");let n=0;setInterval(()=>{if(n<${FORKS_MAX}){n+=1;spawn("sleep",["${seconds}"],{detached:true,stdio:"ignore"})}},${FORK_INTERVAL_MS})`;
  const leader = detachedLeader(t, `"${process.execPath}" -e '${forker}'`);
  t.after(() => markedPids(seconds).forEach(killIfPresent));
  for (let poll = 0; poll < START_POLLS; poll += 1) {
    if (markedPids(seconds).length >= FORKS_BEFORE_KILL) break;
    await delay(POLL_MS);
  }
  assert.ok(markedPids(seconds).length >= FORKS_BEFORE_KILL);
  killProcessTree(leader);
  assert.deepEqual(await settledPids(seconds), []);
});

test("a descendant whose parent exited before the kill is no longer a descendant of the leader and survives the kill", async (t) => {
  const seconds = uniqueSeconds();
  const orphan = `require("node:child_process").spawn("sleep",["${seconds}"],{detached:true,stdio:"ignore"}).unref()`;
  const leader = detachedLeader(
    t,
    `"${process.execPath}" -e '${orphan}'; sleep ${ESCAPED_SECONDS}`,
  );
  t.after(() => markedPids(seconds).forEach(killIfPresent));
  for (let poll = 0; poll < START_POLLS; poll += 1) {
    if (markedPids(seconds).length === ONE_ORPHAN) break;
    await delay(POLL_MS);
  }
  assert.equal(markedPids(seconds).length, ONE_ORPHAN);
  killProcessTree(leader);
  await delay(POLL_MS * 5);
  assert.equal(markedPids(seconds).length, ONE_ORPHAN);
});

test("a Linux stat line gives the pid, the parent and the group, also for a name with a space and a parenthesis", () => {
  assert.deepEqual(
    procStatRow("4242 (node (test) run) S 4200 4100 4100 0 -1 4194560 120"),
    { pid: 4242, ppid: 4200, group: 4100 },
  );
});

test("a stat line with no name end is refused", () => {
  assert.throws(() => procStatRow("4242 node S 4200 4100"));
});
