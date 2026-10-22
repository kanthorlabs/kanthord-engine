import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import type { Context } from "../../kernel/context.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

export const BACKOFF_INITIAL_MS = 1000;
export const BACKOFF_MAX_MS = 30000;
const BACKOFF_FACTOR = 2;
const NO_DELAY = 0;

export class Backoff {
  private delay = BACKOFF_INITIAL_MS;
  next(): number {
    assert.ok(this.delay >= BACKOFF_INITIAL_MS);
    assert.ok(this.delay <= BACKOFF_MAX_MS);
    const delay = this.delay;
    this.delay = Math.min(delay * BACKOFF_FACTOR, BACKOFF_MAX_MS);
    return delay;
  }
  reset(): void {
    assert.ok(this.delay >= BACKOFF_INITIAL_MS);
    this.delay = BACKOFF_INITIAL_MS;
    assert.ok(this.delay <= BACKOFF_MAX_MS);
  }
}

export function sleep(ms: number, context: Context): Promise<void> {
  assert.ok(Number.isFinite(ms));
  assert.ok(ms >= NO_DELAY);
  if (context.signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancellation[Symbol.dispose]();
      resolve();
    }, ms);
    const cancellation = addAbortListener(context.signal, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function retryIndeterminate<T>(
  call: (key: string) => Promise<OperationResult<T>>,
  deadline: number,
  context: Context,
): Promise<OperationResult<T>> {
  assert.ok(Number.isSafeInteger(deadline));
  assert.ok(call);
  const backoff = new Backoff();
  let result: OperationResult<T> = { type: OperationResultType.Indeterminate };
  const maximumAttempts = Math.max(
    1,
    Math.ceil((deadline - Date.now()) / BACKOFF_INITIAL_MS),
  );
  for (
    let attempt = 0;
    attempt < maximumAttempts &&
    !context.signal.aborted &&
    Date.now() < deadline;
    attempt++
  ) {
    result = await call(createIdempotencyKey());
    if (result.type !== OperationResultType.Indeterminate) return result;
    const delay = backoff.next();
    if (Date.now() + delay >= deadline) return result;
    await sleep(delay, context);
  }
  return result;
}
