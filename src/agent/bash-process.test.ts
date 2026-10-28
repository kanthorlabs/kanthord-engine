import assert from "node:assert/strict";
import { test } from "node:test";
import { type BashProcess, processBashOperations } from "./bash-process.ts";
import { temporary } from "../kernel/test-support.ts";

const SHELL = { shell: "/bin/bash", args: ["-c"] };
const ABORT_BOUND_MS = 2000;

test("an abort during the directory check kills the command", async (t) => {
  const ended: BashProcess[] = [];
  const controller = new AbortController();
  let output = "";
  const started = Date.now();
  const running = processBashOperations(SHELL, (bashProcess) =>
    ended.push(bashProcess),
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
