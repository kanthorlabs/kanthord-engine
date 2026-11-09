import assert from "node:assert/strict";
import { test } from "node:test";
import { type BashProcess, processBashOperations } from "./bash-process.ts";
import { temporary } from "../kernel/test-support.ts";
import { spawnedPids, survivingProcesses } from "./test-support.ts";

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
