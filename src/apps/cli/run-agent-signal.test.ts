import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mock, test } from "node:test";
import { ExitCode } from "./constants.ts";
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

const EXIT_CODE = 7;
const NO_CALLS = 0;
const ONE_CALL = 1;
const CHILD_LIMIT_MS = 30000;

test("after a forced stop by the second signal, the exit bound calls process.exit once at FORCED_EXIT_BOUND_MS", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const exit = mock.method(process, "exit", () => {});
  try {
    const handlers = stopOnSignal(new AbortController());
    handlers.setForceStop(() => {});
    process.emit("SIGINT" as NodeJS.Signals);
    process.emit("SIGINT" as NodeJS.Signals);
    handlers.release();
    handlers.exitWithinBoundAfterForcedStop(EXIT_CODE);
    mock.timers.tick(FORCED_EXIT_BOUND_MS - ONE_MS);
    assert.equal(exit.mock.callCount(), NO_CALLS);
    mock.timers.tick(ONE_MS);
    assert.equal(exit.mock.callCount(), ONE_CALL);
  } finally {
    exit.mock.restore();
    mock.timers.reset();
  }
});

test("after the time limit forced stop, the exit bound calls process.exit once at FORCED_EXIT_BOUND_MS", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const exit = mock.method(process, "exit", () => {});
  try {
    const handlers = stopOnSignal(new AbortController());
    handlers.setForceStop(() => {});
    process.emit("SIGINT" as NodeJS.Signals);
    mock.timers.tick(SHUTDOWN_LIMIT_MS);
    handlers.release();
    handlers.exitWithinBoundAfterForcedStop(EXIT_CODE);
    mock.timers.tick(FORCED_EXIT_BOUND_MS);
    assert.equal(exit.mock.callCount(), ONE_CALL);
  } finally {
    exit.mock.restore();
    mock.timers.reset();
  }
});

test("with no forced stop, the exit bound makes no process.exit call, also after one signal", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const exit = mock.method(process, "exit", () => {});
  try {
    const handlers = stopOnSignal(new AbortController());
    handlers.setForceStop(() => {});
    process.emit("SIGTERM" as NodeJS.Signals);
    handlers.ignoreSignals();
    handlers.release();
    handlers.exitWithinBoundAfterForcedStop(EXIT_CODE);
    mock.timers.tick(SHUTDOWN_LIMIT_MS + FORCED_EXIT_BOUND_MS);
    assert.equal(exit.mock.callCount(), NO_CALLS);
  } finally {
    exit.mock.restore();
    mock.timers.reset();
  }
});

function forcedStopChild(openHandle: boolean): number | null {
  const module = new URL("./run-agent-signal.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    const { stopOnSignal } = await import(${JSON.stringify(module)});
    const handlers = stopOnSignal(new AbortController());
    handlers.setForceStop(() => {});
    process.emit("SIGINT");
    process.emit("SIGINT");
    if (${JSON.stringify(openHandle)}) setInterval(() => {}, ${CHILD_LIMIT_MS});
    handlers.release();
    handlers.exitWithinBoundAfterForcedStop(${EXIT_CODE});
  `,
    ],
    { encoding: "utf8", timeout: CHILD_LIMIT_MS },
  );
  return result.status;
}

test("after a forced stop, a process with an open handle exits with the given exit code", () => {
  assert.equal(forcedStopChild(true), EXIT_CODE);
});

test("after a forced stop, the exit bound does not hold a process with no open handle, and the process keeps its own exit code", () => {
  assert.equal(forcedStopChild(false), ExitCode.Success);
});
