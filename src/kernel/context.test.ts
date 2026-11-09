import assert from "node:assert/strict";
import { execFile, type ExecFileException } from "node:child_process";
import { addAbortListener } from "node:events";
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
