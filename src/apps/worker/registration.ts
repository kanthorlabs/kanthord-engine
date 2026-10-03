import assert from "node:assert/strict";
import { ulid } from "ulid";
import {
  background,
  CancellationContext,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import type { WorkerApi } from "./api.ts";

export interface Registration {
  runtimeIdentity: string;
  resourceIdentity: string;
  workerName: string;
}

export const HEARTBEAT_INTERVAL_MS = 60000;
export function startHeartbeat(
  api: WorkerApi,
  log: (record: { code: string; msg: string }) => void,
): { stop(): void } {
  assert.ok(api.worker.heartbeat);
  assert.ok(log);
  const context = new CancellationContext();
  let pending = false;
  const tick = async () => {
    if (pending || context.err()) return;
    pending = true;
    try {
      const result = await api.worker.heartbeat(
        { params: {}, query: {}, body: null },
        { context, idempotencyKey: ulid() },
      );
      if (context.err() || result.type === OperationResultType.Completed)
        return;
      log({
        code:
          result.type === OperationResultType.Failure
            ? result.error.error.code
            : "gateway.invocation.timeout",
        msg: "Worker heartbeat failed",
      });
    } finally {
      pending = false;
    }
  };
  const timer = setInterval(() => {
    void tick();
  }, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      context.cancel();
    },
  };
}

export async function register(
  api: WorkerApi,
  context: Context = background,
): Promise<Registration> {
  assert.ok(api.worker.register);
  assert.ok(context);
  const result = await api.worker.register(
    { params: {}, query: {}, body: null },
    { context, idempotencyKey: ulid() },
  );
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(result.error.error.code, result.error.error.message);
  throw new Diagnostic(
    "worker.start.registration_indeterminate",
    "worker: registration answer is indeterminate.",
  );
}
