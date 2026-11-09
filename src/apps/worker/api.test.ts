import assert from "node:assert/strict";
import { test } from "node:test";
import { background, CancellationContext } from "../../kernel/context.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { retryIndeterminate, sleep } from "./api.ts";
const FIRST_ATTEMPT = 1;
const NO_CALLS = 0;

test("indeterminate retries use fresh keys and stop on completion or deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10000 });
  const keys: string[] = [];
  const complete = {
    type: OperationResultType.Completed,
    status: 200,
    data: null,
  };
  const pending = retryIndeterminate(
    async (key) => {
      keys.push(key);
      return keys.length === FIRST_ATTEMPT
        ? { type: OperationResultType.Indeterminate }
        : complete;
    },
    Date.now() + 5000,
    background,
  );
  await Promise.resolve();
  t.mock.timers.tick(1000);
  assert.deepEqual(await pending, complete);
  assert.equal(new Set(keys).size, keys.length);
  const before = keys.length;
  assert.deepEqual(
    await retryIndeterminate(
      async (key) => {
        keys.push(key);
        return { type: OperationResultType.Indeterminate };
      },
      Date.now() + 500,
      background,
    ),
    { type: OperationResultType.Indeterminate },
  );
  assert.equal(keys.length, before + 1);
});

test("sleep and retry stop when cancelled", async () => {
  const context = new CancellationContext();
  const pending = sleep(60000, context);
  context.cancel();
  await pending;
  let calls = 0;
  const result = await retryIndeterminate(
    async () => {
      calls++;
      return { type: OperationResultType.Indeterminate };
    },
    Date.now() + 60000,
    context,
  );
  assert.deepEqual(result, { type: OperationResultType.Indeterminate });
  assert.equal(calls, NO_CALLS);
});

test("retry stops at once when the transport is closed", async () => {
  let calls = 0;
  const closed = {
    type: OperationResultType.Indeterminate,
    closed: true,
  } as const;
  const result = await retryIndeterminate(
    async () => {
      calls++;
      return closed;
    },
    Date.now() + 60000,
    background,
  );
  assert.deepEqual(result, closed);
  assert.equal(calls, FIRST_ATTEMPT);
});
