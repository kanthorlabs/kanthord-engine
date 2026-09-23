import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ExitCode } from "./apps/cli/constants.ts";
import {
  abortSignal,
  background,
  CancellationContext,
  ContextCancelled,
  DeadlineExceeded,
  throwIfCancelled,
} from "./context.ts";

const NO_NOTIFICATIONS = 0;
const NO_COMPLETED_TASKS = 0;
const ADMITTED_TASK_COUNT = 1;
const COMPLETED_TASK_RESULT = "finished";

test("Context cancellation flows down, preserves its first error, and releases subscriptions", async () => {
  const parent = new CancellationContext();
  const child = new CancellationContext(parent);
  const sibling = new CancellationContext(parent);
  let removed = 0;
  child.onCancel(() => removed++)();
  const reason = new Error("child stopped");
  child.cancel(reason);
  child.cancel(new Error("ignored"));
  await child.done();
  assert.equal(child.err(), reason);
  assert.equal(parent.err(), null);
  assert.equal(sibling.err(), null);
  assert.equal(removed, NO_NOTIFICATIONS);
  let observed: Error | null = null;
  child.onCancel((error) => {
    observed = error;
  });
  assert.equal(observed, reason);
  parent.cancel();
  await sibling.done();
  assert.ok(parent.err() instanceof ContextCancelled);
  assert.equal(sibling.err(), parent.err());
  const late = new CancellationContext(parent);
  assert.equal(late.err(), parent.err());
  assert.equal(background.err(), null);
});

test("Context inherits the earlier deadline and bridges cancellation to native transports", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const parent = new CancellationContext(background, Date.now() + 20);
  const child = new CancellationContext(parent, Date.now() + 60000);
  const native = abortSignal(child);
  assert.equal(child.deadline(), parent.deadline());
  t.mock.timers.tick(50);
  await child.done();
  assert.ok(child.err() instanceof DeadlineExceeded);
  assert.equal(native.signal.reason, parent.err());
  native.dispose();
  const expired = new CancellationContext(background, Date.now() - 1);
  assert.ok(expired.err() instanceof DeadlineExceeded);
  const detached = new CancellationContext();
  const bridge = abortSignal(detached);
  bridge.dispose();
  detached.cancel();
  assert.equal(bridge.signal.aborted, false);
});

test("CancellationContext lets an admitted task finish and rejects upcoming tasks at the admission guard", async () => {
  const context = new CancellationContext();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let started = 0;
  let finished = 0;
  const task = async () => {
    throwIfCancelled(context);
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
    await context.done();
    assert.ok(context.err() instanceof ContextCancelled);
    assert.equal(finished, NO_COMPLETED_TASKS);

    await assert.rejects(task(), (error) => error === context.err());
    assert.equal(started, ADMITTED_TASK_COUNT);
  } finally {
    release.resolve();
  }

  assert.equal(await ongoing, COMPLETED_TASK_RESULT);
  assert.equal(finished, ADMITTED_TASK_COUNT);
  await assert.rejects(task(), (error) => error === context.err());
  assert.equal(started, ADMITTED_TASK_COUNT);
  assert.equal(finished, ADMITTED_TASK_COUNT);
});

test("Context arms no timer for an inherited deadline and cancels through its parent", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const parent = new CancellationContext(background, Date.now() + 10);
  t.mock.timers.tick(1);
  const later = new CancellationContext(parent, Date.now() + 60000);
  const equal = new CancellationContext(parent, parent.deadline());
  t.mock.timers.tick(30);
  await Promise.all([parent.done(), later.done(), equal.done()]);
  assert.ok(parent.err() instanceof DeadlineExceeded);
  assert.equal(later.err(), parent.err());
  assert.equal(equal.err(), parent.err());
  const passed = Date.now() + 1;
  const stalled = new CancellationContext(background, passed);
  t.mock.timers.setTime(passed);
  const late = new CancellationContext(stalled);
  assert.ok(late.err() instanceof DeadlineExceeded);
  assert.equal(stalled.err(), null);
  stalled.cancel();
});

test("A throwing cancellation listener terminates the process on both registration paths", () => {
  for (const order of ["listener-first", "cancel-first"]) {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { writeSync } from 'node:fs';
    import { CancellationContext } from ${JSON.stringify(new URL("./context.ts", import.meta.url).href)};
    const context = new CancellationContext();
    const failing = () => { throw new Error('listener failed'); };
    const witness = () => writeSync(1, 'witness notified\\n');
    if (${JSON.stringify(order)} === 'listener-first') {
      context.onCancel(failing);
      context.onCancel(witness);
      context.cancel();
    } else {
      context.cancel();
      context.onCancel(failing);
      context.onCancel(witness);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeSync(1, 'survived\\n');
    `,
      ],
      { encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.status, ExitCode.Failure, order);
    assert.match(result.stderr, /listener failed/, order);
    assert.match(result.stdout, /witness notified/, order);
    assert.doesNotMatch(result.stdout, /survived/, order);
  }
});
