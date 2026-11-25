import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  type BashProcess,
  KILL_FAILURE_SETTLE_MS,
  processBashOperations,
} from "./bash-process.ts";
import { killIfPresent, temporary } from "../kernel/test-support.ts";
import {
  endProcessGroups,
  markedGroups,
  removeMarkerFile,
} from "../kernel/process-group.ts";
import { pidsIn, spawnedPids, survivingProcesses } from "./test-support.ts";

const SHELL = { shell: "/bin/bash", args: ["-c"] };
const ABORT_BOUND_MS = 2000;
const BACKGROUND_CHILD = "sleep 30 >/dev/null 2>&1 & echo $!";
const SUCCESS = 0;
const ONE_CHILD = 1;

test("an abort during the directory check kills the command", async (t) => {
  const ended: BashProcess[] = [];
  const controller = new AbortController();
  let output = "";
  const started = Date.now();
  const running = processBashOperations(
    SHELL,
    (bashProcess) => ended.push(bashProcess),
    { killGroupAtEnd: true },
  ).exec("sleep 3; echo done", temporary(t), {
    onData: (data) => {
      output += data.toString();
    },
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(running, /^Error: aborted$/);
  assert.ok(Date.now() - started < ABORT_BOUND_MS);
  assert.doesNotMatch(output, /done/);
  assert.equal(ended[0]?.killed, true);
});

test("a background child of a worker bash call is dead when the call ends", async (t) => {
  let output = "";
  const ended = await processBashOperations(SHELL, () => {}, {
    killGroupAtEnd: true,
  }).exec(BACKGROUND_CHILD, temporary(t), {
    onData: (data) => {
      output += data.toString();
    },
  });
  assert.equal(ended.exitCode, SUCCESS);
  const spawned = spawnedPids(t, [{ type: "text", text: output }]);
  assert.equal(spawned.length, ONE_CHILD);
  assert.deepEqual(await survivingProcesses(spawned), []);
});

const CASE_TIMEOUT_MS = 30_000;
const KILL_TIMEOUT_SECONDS = 1;
const PRINT_POLLS = 100;
const PRINT_POLL_MS = 50;
const KILL_TIME_MARGIN_MS = 750;
const GROUP_CHILDREN =
  "sleep 30 >/dev/null 2>&1 & echo $!; (sleep 30 >/dev/null 2>&1 & echo $!)";
const GROUP_PIDS = 2;
const ESCAPED_CHILD = "set -m; sleep 30 >/dev/null 2>&1 & echo $!";
const TREE_COMMAND = `${GROUP_CHILDREN}; (set -m; sleep 30 >/dev/null 2>&1 & echo $!; wait) & sleep 30`;
const TREE_PIDS = 3;
const HANDLER_READY = "ready";
const HANDLER_CHILD = `node -e "process.on('SIGTERM', () => process.exit(0)); console.log('${HANDLER_READY}'); setTimeout(() => {}, 30000)" & echo $!; wait`;
const STOPPED_STATE = /^T/;
const NOT_PERMITTED = "EPERM";
const SIGNAL_KILL = "SIGKILL";
const SIGNAL_TERM = "SIGTERM";
const ABORTED = "aborted";
const GROUP_PID_LIMIT = 0;
const NO_PIDS = 0;

function processField(field: string, pid: number): string {
  return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)])
    .toString()
    .trim();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function printedUntil(
  output: () => string,
  done: (text: string) => boolean,
): Promise<string> {
  for (let poll = 0; poll < PRINT_POLLS; poll += 1) {
    if (done(output())) return output();
    await delay(PRINT_POLL_MS);
  }
  return assert.fail("the command printed too little");
}

function printedPids(output: () => string, count: number): Promise<string> {
  return printedUntil(
    output,
    (text) => pidsIn([{ type: "text", text }]).length >= count,
  );
}

async function endedCall(
  t: TestContext,
  command: string,
): Promise<{ exitCode: number | null; spawned: number[]; groups: number[] }> {
  let output = "";
  const marker = randomUUID();
  t.after(() => removeMarkerFile(marker));
  const ended = await processBashOperations(SHELL, () => {}, {
    killGroupAtEnd: true,
    marker,
  }).exec(command, temporary(t), {
    onData: (data) => {
      output += data.toString();
    },
  });
  return {
    exitCode: ended.exitCode,
    spawned: spawnedPids(t, [{ type: "text", text: output }]),
    groups: markedGroups(marker),
  };
}

interface KillTrigger {
  timeoutSeconds?: number;
  abort?: boolean;
}

async function killedTreeCall(
  t: TestContext,
  trigger: KillTrigger,
): Promise<{ failure: Error; spawned: number[] }> {
  let output = "";
  const controller = new AbortController();
  const running = processBashOperations(SHELL, () => {}, {
    killGroupAtEnd: true,
  }).exec(TREE_COMMAND, temporary(t), {
    onData: (data) => {
      output += data.toString();
    },
    signal: controller.signal,
    ...(trigger.timeoutSeconds === undefined
      ? {}
      : { timeout: trigger.timeoutSeconds }),
  });
  if (trigger.abort) {
    await printedPids(() => output, TREE_PIDS);
    controller.abort();
  }
  const failure = await running.then(
    () => assert.fail("the call ended without a kill"),
    (error: Error) => error,
  );
  return {
    failure,
    spawned: spawnedPids(t, [{ type: "text", text: output }]),
  };
}

test(
  "F79 path 1: a descendant in the leader group is dead when the call ends",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const { exitCode, spawned } = await endedCall(t, GROUP_CHILDREN);
    assert.equal(exitCode, SUCCESS);
    assert.equal(spawned.length, GROUP_PIDS);
    assert.deepEqual(await survivingProcesses(spawned), []);
  },
);

test(
  "F79 path 2: a descendant outside the leader group is gone after the tracked groups end",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const { exitCode, spawned, groups } = await endedCall(t, ESCAPED_CHILD);
    assert.equal(exitCode, SUCCESS);
    assert.equal(spawned.length, ONE_CHILD);
    assert.deepEqual(await survivingProcesses(spawned), spawned);
    assert.notEqual(Number(processField("ppid", spawned[0]!)), process.pid);
    await endProcessGroups(groups);
    assert.deepEqual(await survivingProcesses(spawned), []);
  },
);

test(
  "F79 path 3: a call that times out kills a descendant in the leader group and one outside it",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const { failure, spawned } = await killedTreeCall(t, {
      timeoutSeconds: KILL_TIMEOUT_SECONDS,
    });
    assert.match(failure.message, /^timeout:1$/);
    assert.equal(spawned.length, TREE_PIDS);
    assert.deepEqual(await survivingProcesses(spawned), []);
  },
);

test(
  "F79 path 3: a call that is aborted kills a descendant in the leader group and one outside it",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const { failure, spawned } = await killedTreeCall(t, { abort: true });
    assert.equal(failure.message, ABORTED);
    assert.equal(spawned.length, TREE_PIDS);
    assert.deepEqual(await survivingProcesses(spawned), []);
  },
);

test(
  "F79 path 5: a kill failure resumes each stopped group and the call rejects with the failure",
  { timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const signal = process.kill.bind(process);
    const refused = t.mock.method(
      process,
      "kill",
      (pid: number, name?: string | number) => {
        if (pid < GROUP_PID_LIMIT && name === SIGNAL_KILL)
          throw Object.assign(new Error("kill not permitted"), {
            code: NOT_PERMITTED,
          });
        return signal(pid, name);
      },
    );
    let output = "";
    const controller = new AbortController();
    const running = processBashOperations(SHELL, () => {}, {
      killGroupAtEnd: true,
    }).exec(HANDLER_CHILD, temporary(t), {
      onData: (data) => {
        output += data.toString();
      },
      signal: controller.signal,
    });
    const printed = await printedUntil(
      () => output,
      (text) =>
        text.includes(HANDLER_READY) &&
        pidsIn([{ type: "text", text }]).length > NO_PIDS,
    );
    const [descendant] = spawnedPids(t, [{ type: "text", text: printed }]);
    assert.ok(descendant);
    const group = Number(processField("pgid", descendant));
    t.after(() => {
      refused.mock.restore();
      killIfPresent(-group);
    });
    const aborted = Date.now();
    controller.abort();
    await assert.rejects(running, /kill not permitted/);
    assert.ok(
      Date.now() - aborted < KILL_FAILURE_SETTLE_MS + KILL_TIME_MARGIN_MS,
    );
    assert.doesNotMatch(processField("stat", descendant), STOPPED_STATE);
    process.kill(descendant, SIGNAL_TERM);
    for (let poll = 0; poll < PRINT_POLLS && alive(descendant); poll += 1)
      await delay(PRINT_POLL_MS);
    assert.equal(alive(descendant), false);
  },
);
