import assert from "node:assert/strict";
import { ulid } from "ulid";
import { background, type Context } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import type { WorkerApi } from "./api.ts";

export interface Registration {
  runtimeIdentity: string;
  resourceIdentity: string;
  workerName: string;
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
