import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { stopOnSignal } from "./run-agent-signal.ts";

const SHUTDOWN_LIMIT_MS = 10000;

test("stopOnSignal aborts the controller on SIGINT", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(controller.signal.aborted);
  handlers.release();
});

test("stopOnSignal aborts the controller on SIGTERM", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  process.emit("SIGTERM" as NodeJS.Signals);
  assert.ok(controller.signal.aborted);
  handlers.release();
});

test("stopOnSignal cleanup removes the SIGINT listener", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  handlers.release();
  const before = controller.signal.aborted;
  process.emit("SIGINT" as NodeJS.Signals);
  assert.equal(controller.signal.aborted, before);
  assert.ok(!controller.signal.aborted);
});

test("stopOnSignal cleanup removes the SIGTERM listener", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  handlers.release();
  const before = controller.signal.aborted;
  process.emit("SIGTERM" as NodeJS.Signals);
  assert.equal(controller.signal.aborted, before);
  assert.ok(!controller.signal.aborted);
});

test("stopOnSignal second signal calls forceStop immediately", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  let forceCalled = false;
  handlers.setForceStop(() => {
    forceCalled = true;
  });
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(controller.signal.aborted);
  assert.ok(!forceCalled);
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(forceCalled);
  assert.ok(handlers.forcedWithoutResult);
  handlers.release();
});

test("stopOnSignal second signal sets forcedWithoutResult", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  handlers.setForceStop(() => {});
  assert.ok(!handlers.forcedWithoutResult);
  process.emit("SIGTERM" as NodeJS.Signals);
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(handlers.forcedWithoutResult);
  handlers.release();
});

test("stopOnSignal timeout calls forceStop after the limit", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const handlers = stopOnSignal(controller);
    let forceCalled = false;
    handlers.setForceStop(() => {
      forceCalled = true;
    });
    process.emit("SIGINT" as NodeJS.Signals);
    assert.ok(!forceCalled);
    mock.timers.tick(SHUTDOWN_LIMIT_MS);
    assert.ok(forceCalled);
    assert.ok(!handlers.forcedWithoutResult);
    handlers.release();
  } finally {
    mock.timers.reset();
  }
});

test("stopOnSignal release before signal prevents abort", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  handlers.release();
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(!controller.signal.aborted);
});

test("stopOnSignal forcedWithoutResult is false with no signal", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  assert.ok(!handlers.forcedWithoutResult);
  handlers.release();
});
