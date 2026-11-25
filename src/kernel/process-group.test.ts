import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  endMarkedGroups,
  endProcessGroups,
  FREEZE_PASSES_MAX,
  GROUP_END_WARNING,
  GROUP_GRACE_MS,
  GROUP_MARKER_VARIABLE,
  killChildTree,
  killProcessTree,
  markedGroups,
  markerFile,
  type ProcessEnvironment,
  type ProcessRow,
  type ProcessSystem,
  procStatRow,
} from "./process-group.ts";
import { killIfPresent, stopAfter } from "./test-support.ts";

const OWN_GROUP = 500;
const LEADER = 1000;
const CHILD = 1001;
const GRANDCHILD = 1002;
const FORKED = 1003;
const FOREIGN = 2000;
const STOP = "SIGSTOP";
const KILL = "SIGKILL";
const CONT = "SIGCONT";
const TERM = "SIGTERM";
const ONE_MS = 1;
const ESCAPED_SECONDS = 60;
const FORK_INTERVAL_MS = 5;
const FORKS_BEFORE_KILL = 5;
const FORKS_MAX = 50;
const POLLS = 100;
const START_POLLS = 500;
const TWO_FAILURES = 2;
const BOTH_CODES = "EPERM,EACCES";
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

function recordingSystem(
  tables: (() => ProcessRow[])[],
  environments: ProcessEnvironment[] = [],
) {
  const signals: string[] = [];
  let reads = 0;
  const system: ProcessSystem = {
    readTable: () => {
      const table = tables[Math.min(reads, tables.length - 1)]!;
      reads += 1;
      return table();
    },
    readEnvironments: () => environments,
    readHolders: () => [],
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
    readEnvironments: () => [],
    readHolders: () => [],
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
    readEnvironments: () => [],
    readHolders: () => [],
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

interface RefusedSignal {
  signal: string;
  group: number;
  code: string;
}

function refusingSystem(refused: RefusedSignal[]) {
  const { system, signals } = recordingSystem([
    () => [ownRow, leaderRow, { pid: CHILD, ppid: LEADER, group: CHILD }],
  ]);
  const record = system.signalGroup;
  system.signalGroup = (group, signal) => {
    record(group, signal);
    const match = refused.find(
      (entry) => entry.signal === signal && entry.group === group,
    );
    if (match) throw errorWithCode(match.code);
  };
  return { system, signals };
}

function resumed(signals: readonly string[]): string[] {
  return signals.filter((signal) => signal.startsWith(CONT));
}

test("a stopped group whose kill is refused is resumed and the refusal is thrown", () => {
  const { system, signals } = refusingSystem([
    { signal: KILL, group: CHILD, code: "EPERM" },
  ]);
  assert.throws(() => killProcessTree(LEADER, system), /EPERM/);
  assert.deepEqual(resumed(signals), [`${CONT} ${CHILD}`]);
  assert.ok(
    signals.lastIndexOf(`${KILL} ${CHILD}`) <
      signals.indexOf(`${CONT} ${CHILD}`),
  );
});

test("a stopped group whose kill passes is not resumed", () => {
  const { system, signals } = refusingSystem([]);
  killProcessTree(LEADER, system);
  assert.deepEqual(resumed(signals), []);
});

test("a stopped group that is absent at the kill is not resumed and is no failure", () => {
  const { system, signals } = refusingSystem([
    { signal: KILL, group: CHILD, code: "ESRCH" },
  ]);
  killProcessTree(LEADER, system);
  assert.deepEqual(resumed(signals), []);
});

test("a refused resume is a second failure next to the refused kill", () => {
  const { system } = refusingSystem([
    { signal: KILL, group: CHILD, code: "EPERM" },
    { signal: CONT, group: CHILD, code: "EACCES" },
  ]);
  assert.throws(
    () => killProcessTree(LEADER, system),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.length === TWO_FAILURES &&
      error.errors.map((inner: Error) => inner.message).join() === BOTH_CODES,
  );
});

test("a resume that finds the group absent is no failure", () => {
  const { system } = refusingSystem([
    { signal: KILL, group: CHILD, code: "EPERM" },
    { signal: CONT, group: CHILD, code: "ESRCH" },
  ]);
  assert.throws(() => killProcessTree(LEADER, system), /EPERM/);
});

test("a group that was never stopped is not resumed when its kill is refused", () => {
  const { system, signals } = recordingSystem([
    () => {
      throw new Error("table read failed");
    },
  ]);
  const record = system.signalGroup;
  system.signalGroup = (group, signal) => {
    record(group, signal);
    if (signal === KILL) throw errorWithCode("EPERM");
  };
  assert.throws(() => killProcessTree(LEADER, system), AggregateError);
  assert.deepEqual(resumed(signals), []);
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
  stopAfter(t, () => {
    if (leader.exitCode === null && leader.signalCode === null)
      killIfPresent(leader.pid!);
  });
  return leader.pid;
}

test("a descendant that forks into new groups during the kill leaves no process", async (t) => {
  const seconds = uniqueSeconds();
  const forker = `const {spawn}=require("node:child_process");let n=0;setInterval(()=>{if(n<${FORKS_MAX}){n+=1;spawn("sleep",["${seconds}"],{detached:true,stdio:"ignore"})}},${FORK_INTERVAL_MS})`;
  const leader = detachedLeader(t, `"${process.execPath}" -e '${forker}'`);
  stopAfter(t, () => markedPids(seconds).forEach(killIfPresent));
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
  const parked = seconds.replace(
    `${ESCAPED_SECONDS}`,
    `${ESCAPED_SECONDS + 1}`,
  );
  const orphan = `require("node:child_process").spawn("sleep",["${seconds}"],{detached:true,stdio:"ignore"}).unref()`;
  const leader = detachedLeader(
    t,
    `"${process.execPath}" -e '${orphan}'; sleep ${parked}`,
  );
  stopAfter(t, () => markedPids(seconds).forEach(killIfPresent));
  stopAfter(t, () => markedPids(parked).forEach(killIfPresent));
  for (let poll = 0; poll < START_POLLS; poll += 1) {
    if (
      markedPids(seconds).length === ONE_ORPHAN &&
      markedPids(parked).length > NO_PROCESSES
    )
      break;
    await delay(POLL_MS);
  }
  assert.equal(markedPids(seconds).length, ONE_ORPHAN);
  assert.ok(markedPids(parked).length > NO_PROCESSES);
  killProcessTree(leader);
  await delay(POLL_MS * 5);
  assert.equal(markedPids(seconds).length, ONE_ORPHAN);
});

test("a stat line with no name end is refused", () => {
  assert.throws(() => procStatRow("4242 node S 4200 4100"));
});

function groupRow(group: number): ProcessRow {
  return { pid: group, ppid: 1, group };
}

function mockedGraceTimer(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  return {
    beforeGrace: () => t.mock.timers.tick(GROUP_GRACE_MS - ONE_MS),
    atGrace: () => t.mock.timers.tick(ONE_MS),
    graceEnds: () => t.mock.timers.tick(GROUP_GRACE_MS),
  };
}

test("a live group gets SIGTERM and a group that ends before the grace time gets no SIGKILL", async (t) => {
  const timer = mockedGraceTimer(t);
  const { system, signals } = recordingSystem([
    () => [ownRow, groupRow(LEADER), groupRow(FOREIGN)],
    () => [ownRow, groupRow(FOREIGN)],
  ]);
  const ended = endProcessGroups([LEADER, CHILD], system);
  assert.deepEqual(signals, [`${TERM} ${LEADER}`]);
  timer.beforeGrace();
  assert.deepEqual(signals, [`${TERM} ${LEADER}`]);
  timer.atGrace();
  await ended;
  assert.deepEqual(signals, [`${TERM} ${LEADER}`]);
});

test("a group that is still live after the grace time gets SIGKILL", async (t) => {
  const timer = mockedGraceTimer(t);
  const { system, signals } = recordingSystem([
    () => [ownRow, groupRow(LEADER), groupRow(CHILD)],
    () => [ownRow, groupRow(CHILD)],
  ]);
  const ended = endProcessGroups([LEADER, CHILD], system);
  timer.beforeGrace();
  assert.deepEqual(signals, [`${TERM} ${LEADER}`, `${TERM} ${CHILD}`]);
  timer.atGrace();
  await ended;
  assert.deepEqual(signals, [
    `${TERM} ${LEADER}`,
    `${TERM} ${CHILD}`,
    `${KILL} ${CHILD}`,
  ]);
});

test("ESRCH on a group is no failure and another error is a failure", async (t) => {
  const timer = mockedGraceTimer(t);
  const live = () => [ownRow, groupRow(LEADER)];
  const refusing = (code: string): ProcessSystem => ({
    readTable: live,
    readEnvironments: () => [],
    readHolders: () => [],
    signalGroup: () => {
      throw errorWithCode(code);
    },
  });
  const gone = endProcessGroups([LEADER], refusing("ESRCH"));
  timer.graceEnds();
  await gone;
  const refused = endProcessGroups([LEADER], refusing("EPERM"));
  const rejection = assert.rejects(refused, AggregateError);
  timer.graceEnds();
  await rejection;
});

test("a group list with no live group arms no timer and signals nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { system, signals } = recordingSystem([() => [ownRow]]);
  await endProcessGroups([LEADER], system);
  assert.deepEqual(signals, []);
});

const MARKER = "marker-a";
const OTHER_MARKER = "marker-b";
const MARKED_GROUP = 3000;
const OTHER_GROUP = 3001;

function environmentRow(
  pid: number,
  group: number,
  marker: string,
): ProcessEnvironment {
  return {
    pid,
    group,
    variables: ["A=1", `${GROUP_MARKER_VARIABLE}=${marker}`],
  };
}

test("a process of an unrecorded group that holds the marker value is answered by its group", () => {
  const { system } = recordingSystem(
    [() => [ownRow]],
    [
      environmentRow(MARKED_GROUP, MARKED_GROUP, MARKER),
      environmentRow(OTHER_GROUP, OTHER_GROUP, OTHER_MARKER),
      { pid: FOREIGN, group: FOREIGN, variables: ["A=1"] },
    ],
  );
  assert.deepEqual(markedGroups(MARKER, system), [MARKED_GROUP]);
});

test("a holder of the marker file in an unrecorded group is answered by its group", () => {
  const files: string[] = [];
  const { system } = recordingSystem([() => [ownRow]]);
  const answered = markedGroups(MARKER, {
    ...system,
    readHolders: (file) => {
      files.push(file);
      return [
        { pid: MARKED_GROUP, group: MARKED_GROUP },
        { pid: process.pid, group: OWN_GROUP },
      ];
    },
  });
  assert.deepEqual(files, [markerFile(MARKER)]);
  assert.deepEqual(answered, [MARKED_GROUP]);
});

test("a marked process in the group of the caller is not answered", () => {
  const { system } = recordingSystem(
    [() => [ownRow]],
    [environmentRow(MARKED_GROUP, OWN_GROUP, MARKER)],
  );
  assert.deepEqual(markedGroups(MARKER, system), []);
});

test("the system environment read answers the group of a descendant that holds the marker after its parent exits", async (t) => {
  const marker = `live-${process.pid}-${Date.now()}`;
  const parent = `const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, ${ESCAPED_SECONDS}000)"], { detached: true, stdio: "ignore" }); console.log(child.pid); child.unref(); setTimeout(() => {}, ${ESCAPED_SECONDS}000)`;
  const leader = spawn(process.execPath, ["-e", parent], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, [GROUP_MARKER_VARIABLE]: marker },
  });
  assert.ok(leader.pid);
  stopAfter(t, () => killIfPresent(leader.pid!));
  const [printed] = await once(leader.stdout, "data");
  const descendant = Number.parseInt(String(printed), 10);
  stopAfter(t, () => killIfPresent(descendant));
  assert.deepEqual(
    markedGroups(marker).sort(),
    [leader.pid, descendant].sort(),
  );
  assert.deepEqual(markedGroups(`${marker}-other`), []);
});

test("(invariant guard) a signal failure at the marked group end emits one warning and resolves", async (t) => {
  const timer = mockedGraceTimer(t);
  const warnings: Error[] = [];
  const listener = (warning: Error) => warnings.push(warning);
  process.on("warning", listener);
  t.after(() => process.off("warning", listener));
  const ended = endMarkedGroups(MARKER, {
    readTable: () => [ownRow, groupRow(MARKED_GROUP)],
    readEnvironments: () => [
      environmentRow(MARKED_GROUP, MARKED_GROUP, MARKER),
    ],
    readHolders: () => [],
    signalGroup: () => {
      throw errorWithCode("EPERM");
    },
  });
  timer.graceEnds();
  await ended;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    warnings.map((warning) => warning.name),
    [GROUP_END_WARNING],
  );
  assert.match(warnings[0]!.message, /EPERM, EPERM$/);
});

test("(invariant guard) a failed table read at the marked group end emits one warning and resolves", async (t) => {
  const warnings: Error[] = [];
  const listener = (warning: Error) => warnings.push(warning);
  process.on("warning", listener);
  t.after(() => process.off("warning", listener));
  await endMarkedGroups(MARKER, {
    readTable: () => {
      throw errorWithCode("EIO");
    },
    readEnvironments: () => [],
    readHolders: () => [],
    signalGroup: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    warnings.map((warning) => warning.name),
    [GROUP_END_WARNING],
  );
});

test("a live group that holds no marked process gets no signal at the marked group end", async (t) => {
  const timer = mockedGraceTimer(t);
  const { system, signals } = recordingSystem(
    [() => [ownRow, groupRow(MARKED_GROUP), groupRow(OTHER_GROUP)]],
    [
      environmentRow(MARKED_GROUP, MARKED_GROUP, MARKER),
      environmentRow(OTHER_GROUP, OTHER_GROUP, OTHER_MARKER),
    ],
  );
  const ended = endMarkedGroups(MARKER, system);
  timer.graceEnds();
  await ended;
  assert.deepEqual(signals, [
    `${TERM} ${MARKED_GROUP}`,
    `${KILL} ${MARKED_GROUP}`,
  ]);
});
