import assert from "node:assert/strict";
import {
  background,
  CancellationContext,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import type { WorkerTransport } from "./transport.ts";
import { WorkerErrorCode } from "../../worker/contract.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

export interface Registration {
  runtime_identity: string;
  resource_identity: string;
  worker_name: string;
}

export const HEARTBEAT_INTERVAL_MS = 60000;
export function startHeartbeat(
  api: WorkerTransport,
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
        { context, idempotencyKey: createIdempotencyKey() },
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
  api: WorkerTransport,
  context: Context = background,
): Promise<Registration> {
  assert.ok(api.worker.register);
  assert.ok(context);
  const result = await api.worker.register(
    { params: {}, query: {}, body: null },
    { context, idempotencyKey: createIdempotencyKey() },
  );
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new Diagnostic(result.error.error.code, result.error.error.message);
  throw new Diagnostic(
    "worker.start.registration_indeterminate",
    "worker: registration answer is indeterminate.",
  );
}

export async function deregister(
  api: WorkerTransport,
  runtimeIdentity: string,
): Promise<Diagnostic | null> {
  assert.ok(runtimeIdentity);
  assert.ok(api.worker["registration.deregister"]);
  const result = await api.worker["registration.deregister"](
    { params: { runtime_identity: runtimeIdentity }, query: {}, body: null },
    { idempotencyKey: createIdempotencyKey(), context: background },
  );
  if (result.type === OperationResultType.Completed) return null;
  if (result.type === OperationResultType.Indeterminate)
    return new Diagnostic(
      "worker.stop.deregistration_indeterminate",
      "worker: deregistration answer is indeterminate.",
    );
  const notFound = 404;
  if (
    result.status === notFound &&
    result.error.error.code === WorkerErrorCode.RegistrationNotFound
  )
    return null;
  return new Diagnostic(result.error.error.code, result.error.error.message);
}
