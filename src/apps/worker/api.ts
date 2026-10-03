import assert from "node:assert/strict";
import { ulid } from "ulid";
import { httpClient } from "../../gateway/client.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import type { Context } from "../../kernel/context.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";

export function workerApi(endpoint: string, token?: string) {
  assert.ok(endpoint);
  const api = {
    gateway: httpClient(gatewayOperations, endpoint, token),
    worker: httpClient(workerOperations, endpoint, token),
    scheduler: httpClient(schedulerOperations, endpoint, token),
    mission: httpClient(missionOperations, endpoint, token),
  };
  assert.ok(api.worker.register);
  return api;
}
export type WorkerApi = ReturnType<typeof workerApi>;
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
  if (context.err()) return Promise.resolve();
  return new Promise((resolve) => {
    let unlink = () => {};
    const timer = setTimeout(() => {
      unlink();
      resolve();
    }, ms);
    unlink = context.onCancel(() => {
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
    attempt < maximumAttempts && !context.err() && Date.now() < deadline;
    attempt++
  ) {
    result = await call(ulid());
    if (result.type !== OperationResultType.Indeterminate) return result;
    const delay = backoff.next();
    if (Date.now() + delay >= deadline) return result;
    await sleep(delay, context);
  }
  return result;
}
