import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import { addAbortListener, getEventListeners } from "node:events";
import { test } from "node:test";
import { promisify } from "node:util";
const ExitCode = { Success: 0, Failure: 1 } as const;
const execFileAsync = promisify(execFile);
import {
  background,
  CancellationContext,
  cancelled,
  ContextCancelled,
  DeadlineExceeded,
} from "./context.ts";

const NO_NOTIFICATIONS = 0;
const NO_LISTENERS = 0;
const NO_COMPLETED_TASKS = 0;
const ADMITTED_TASK_COUNT = 1;
const COMPLETED_TASK_RESULT = "finished";
const CHILD_COUNT = 1000;
const Registration = {
  ListenerFirst: "listener-first",
  CancelFirst: "cancel-first",
} as const;

test("Context cancellation flows down, preserves its first reason, and releases subscriptions", async () => {
  const parent = new CancellationContext();
  const child = new CancellationContext(parent);
  const sibling = new CancellationContext(parent);
  let removed = 0;
  addAbortListener(child.signal, () => removed++)[Symbol.dispose]();
  const reason = new Error("child stopped");
  child.cancel(reason);
  child.cancel(new Error("ignored"));
  await cancelled(child.signal);
  assert.equal(child.signal.reason, reason);
  assert.equal(parent.signal.aborted, false);
  assert.equal(sibling.signal.aborted, false);
  assert.equal(removed, NO_NOTIFICATIONS);
  const observed = Promise.withResolvers<unknown>();
  addAbortListener(child.signal, () => observed.resolve(child.signal.reason));
  assert.equal(await observed.promise, reason);
  parent.cancel();
  await cancelled(sibling.signal);
  assert.ok(parent.signal.reason instanceof ContextCancelled);
  assert.equal(sibling.signal.reason, parent.signal.reason);
  const late = new CancellationContext(parent);
  assert.equal(late.signal.reason, parent.signal.reason);
  assert.equal(background.signal.aborted, false);
});

test("Context inherits the earlier deadline and carries its reason on the native signal", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const parent = new CancellationContext(background, Date.now() + 20);
  const child = new CancellationContext(parent, Date.now() + 60000);
  assert.equal(child.deadline, parent.deadline);
  t.mock.timers.tick(50);
  await cancelled(child.signal);
  assert.ok(child.signal.reason instanceof DeadlineExceeded);
  assert.equal(child.signal.reason, parent.signal.reason);
  assert.throws(() => child.signal.throwIfAborted(), parent.signal.reason);
  const expired = new CancellationContext(background, Date.now() - 1);
  assert.ok(expired.signal.reason instanceof DeadlineExceeded);
});

test("A child holds no listener on its parent signal", () => {
  const parent = new CancellationContext();
  for (let index = 0; index < CHILD_COUNT; index++)
    new CancellationContext(parent, Date.now() + 60000).cancel();
  assert.equal(getEventListeners(parent.signal, "abort").length, NO_LISTENERS);
  assert.equal(
    getEventListeners(background.signal, "abort").length,
    NO_LISTENERS,
  );
});

test("CancellationContext lets an admitted task finish and rejects upcoming tasks at the admission guard", async () => {
  const context = new CancellationContext();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = 0;
  let finished = 0;
  const task = async () => {
    context.signal.throwIfAborted();
    started++;
    entered.resolve();
    await release.promise;
    finished++;
    return "finished";
  };

  const ongoing = task();
  try {
    await entered.promise;
    context.cancel();
    await cancelled(context.signal);
    assert.ok(context.signal.reason instanceof ContextCancelled);
    assert.equal(finished, NO_COMPLETED_TASKS);

    await assert.rejects(task(), (error) => error === context.signal.reason);
    assert.equal(started, ADMITTED_TASK_COUNT);
  } finally {
    release.resolve();
  }

  assert.equal(await ongoing, COMPLETED_TASK_RESULT);
  assert.equal(finished, ADMITTED_TASK_COUNT);
  await assert.rejects(task(), (error) => error === context.signal.reason);
  assert.equal(started, ADMITTED_TASK_COUNT);
  assert.equal(finished, ADMITTED_TASK_COUNT);
});

test("Context arms no timer for an inherited deadline and cancels through its parent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const parent = new CancellationContext(background, Date.now() + 10);
  t.mock.timers.tick(1);
  const later = new CancellationContext(parent, Date.now() + 60000);
  const equal = new CancellationContext(parent, parent.deadline);
  t.mock.timers.tick(30);
  await Promise.all([
    cancelled(parent.signal),
    cancelled(later.signal),
    cancelled(equal.signal),
  ]);
  assert.ok(parent.signal.reason instanceof DeadlineExceeded);
  assert.equal(later.signal.reason, parent.signal.reason);
  assert.equal(equal.signal.reason, parent.signal.reason);
  const passed = Date.now() + 1;
  const stalled = new CancellationContext(background, passed);
  t.mock.timers.setTime(passed);
  const late = new CancellationContext(stalled);
  assert.ok(late.signal.reason instanceof DeadlineExceeded);
  assert.equal(stalled.signal.aborted, false);
  stalled.cancel();
});

test("A throwing cancellation listener terminates the process on both registration paths", async (t) => {
  for (const order of Object.values(Registration)) {
    const result = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { addAbortListener } from 'node:events';
    import { writeSync } from 'node:fs';
    import { CancellationContext } from ${JSON.stringify(new URL("./context.ts", import.meta.url).href)};
    const context = new CancellationContext();
    const failing = () => { throw new Error('listener failed'); };
    const witness = () => writeSync(1, 'witness notified\\n');
    if (${JSON.stringify(order)} === 'listener-first') {
      addAbortListener(context.signal, failing);
      addAbortListener(context.signal, witness);
      context.cancel();
    } else {
      context.cancel();
      addAbortListener(context.signal, failing);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeSync(1, 'survived\\n');
    `,
      ],
      { encoding: "utf8", signal: t.signal },
    ).then(
      () => assert.fail(order),
      (error: ExecFileException & { stdout: string; stderr: string }) => error,
    );
    assert.equal(result.code, ExitCode.Failure, order);
    assert.match(result.stderr, /listener failed/, order);
    if (order === Registration.ListenerFirst)
      assert.match(result.stdout, /witness notified/, order);
    assert.doesNotMatch(result.stdout, /survived/, order);
  }
});
