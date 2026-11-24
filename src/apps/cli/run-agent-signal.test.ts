import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { FORCED_EXIT_BOUND_MS, stopOnSignal } from "./run-agent-signal.ts";

const SHUTDOWN_LIMIT_MS = 10000;
const ONE_MS = 1;
const ONE_LISTENER = 1;
const ONE_FORCED_STOP = 1;

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
    mock.timers.tick(SHUTDOWN_LIMIT_MS - ONE_MS);
    assert.ok(!forceCalled);
    mock.timers.tick(ONE_MS);
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

test("stopOnSignal ignores a signal after ignoreSignals and keeps its listeners", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  let forceCalled = false;
  handlers.setForceStop(() => {
    forceCalled = true;
  });
  handlers.ignoreSignals();
  process.emit("SIGINT" as NodeJS.Signals);
  process.emit("SIGTERM" as NodeJS.Signals);
  assert.ok(!controller.signal.aborted);
  assert.ok(!forceCalled);
  assert.ok(!handlers.forcedWithoutResult);
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  handlers.release();
  assert.equal(process.listenerCount("SIGINT"), sigintListeners - ONE_LISTENER);
  assert.equal(
    process.listenerCount("SIGTERM"),
    sigtermListeners - ONE_LISTENER,
  );
});

test("stopOnSignal ignoreSignals after the first signal stops the time limit", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const handlers = stopOnSignal(controller);
    let forceCalled = false;
    handlers.setForceStop(() => {
      forceCalled = true;
    });
    process.emit("SIGINT" as NodeJS.Signals);
    handlers.ignoreSignals();
    mock.timers.tick(SHUTDOWN_LIMIT_MS);
    process.emit("SIGINT" as NodeJS.Signals);
    assert.ok(!forceCalled);
    assert.ok(!handlers.forcedWithoutResult);
    handlers.release();
  } finally {
    mock.timers.reset();
  }
});

test("stopOnSignal third signal makes no second forced stop and keeps its listeners", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  const sigintListeners = process.listenerCount("SIGINT");
  let forceCalls = 0;
  handlers.setForceStop(() => {
    forceCalls += 1;
  });
  process.emit("SIGINT" as NodeJS.Signals);
  process.emit("SIGINT" as NodeJS.Signals);
  process.emit("SIGINT" as NodeJS.Signals);
  assert.equal(forceCalls, ONE_FORCED_STOP);
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  handlers.release();
});

test("stopOnSignal second signal before setForceStop sets forcedWithoutResult", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  process.emit("SIGTERM" as NodeJS.Signals);
  process.emit("SIGTERM" as NodeJS.Signals);
  assert.ok(controller.signal.aborted);
  assert.ok(handlers.forcedWithoutResult);
  handlers.release();
});

test("stopOnSignal a signal after the time limit makes no second forced stop", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const handlers = stopOnSignal(controller);
    let forceCalls = 0;
    handlers.setForceStop(() => {
      forceCalls += 1;
    });
    process.emit("SIGTERM" as NodeJS.Signals);
    mock.timers.tick(SHUTDOWN_LIMIT_MS);
    process.emit("SIGTERM" as NodeJS.Signals);
    assert.equal(forceCalls, ONE_FORCED_STOP);
    assert.ok(!handlers.forcedWithoutResult);
    handlers.release();
  } finally {
    mock.timers.reset();
  }
});

const EXIT_CODE_STOPPED = 2;
const NO_CALLS = 0;
const ONE_CALL = 1;

test("S7: scheduleBoundedExit calls process.exit with the given code after FORCED_EXIT_BOUND_MS", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const mockExit = mock.method(process, "exit", () => {});
    try {
      const controller = new AbortController();
      const handlers = stopOnSignal(controller);
      handlers.setForceStop(() => {});
      process.emit("SIGINT" as NodeJS.Signals);
      process.emit("SIGINT" as NodeJS.Signals);
      handlers.scheduleBoundedExit(EXIT_CODE_STOPPED);
      mock.timers.tick(FORCED_EXIT_BOUND_MS - ONE_MS);
      assert.equal(mockExit.mock.callCount(), NO_CALLS);
      mock.timers.tick(ONE_MS);
      assert.equal(mockExit.mock.callCount(), ONE_CALL);
      assert.equal(mockExit.mock.calls[0]?.arguments[0], EXIT_CODE_STOPPED);
      handlers.release();
    } finally {
      mockExit.mock.restore();
    }
  } finally {
    mock.timers.reset();
  }
});

test("S7: scheduleBoundedExit is not called on a normal end and process.exit is not called", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const mockExit = mock.method(process, "exit", () => {});
    try {
      const controller = new AbortController();
      const handlers = stopOnSignal(controller);
      handlers.release();
      mock.timers.tick(FORCED_EXIT_BOUND_MS);
      assert.equal(mockExit.mock.callCount(), NO_CALLS);
    } finally {
      mockExit.mock.restore();
    }
  } finally {
    mock.timers.reset();
  }
});

test("S7: wasForceStopped is false before any signal and true after a forced stop", () => {
  const controller = new AbortController();
  const handlers = stopOnSignal(controller);
  assert.ok(!handlers.wasForceStopped);
  handlers.setForceStop(() => {});
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(!handlers.wasForceStopped);
  process.emit("SIGINT" as NodeJS.Signals);
  assert.ok(handlers.wasForceStopped);
  handlers.release();
});

test("S7: wasForceStopped is true after the time limit forced stop", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const controller = new AbortController();
    const handlers = stopOnSignal(controller);
    assert.ok(!handlers.wasForceStopped);
    handlers.setForceStop(() => {});
    process.emit("SIGINT" as NodeJS.Signals);
    mock.timers.tick(SHUTDOWN_LIMIT_MS);
    assert.ok(handlers.wasForceStopped);
    handlers.release();
  } finally {
    mock.timers.reset();
  }
});
