import assert from "node:assert/strict";
import { test } from "node:test";
import { stopOnSignal } from "./run-agent-signal.ts";

test("stopOnSignal aborts the controller on SIGINT", async () => {
  const controller = new AbortController();
  const release = stopOnSignal(controller);
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(controller.signal.aborted);
  release();
});

test("stopOnSignal cleanup removes the listener", () => {
  const controller = new AbortController();
  const release = stopOnSignal(controller);
  release();
  const before = controller.signal.aborted;
  process.emit("SIGINT" as NodeJS.Signals);
  assert.equal(controller.signal.aborted, before);
  assert.ok(!controller.signal.aborted);
});
