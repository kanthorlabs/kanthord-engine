import assert from "node:assert/strict";
import { ulid } from "ulid";
import { background, type Context } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { Backoff, sleep, type WorkerApi } from "./api.ts";
import type { Registration } from "./registration.ts";

const SERVER_ERROR = 500;
const REGISTRATION_REQUIRED = "gateway.registration.required";
export interface PullLoopInput {
  api: WorkerApi;
  registration: Registration;
  backoff: Backoff;
  shutdown: Context;
  host(execution: ExecutionRecord): Promise<Diagnostic | null>;
  register(): Promise<Registration>;
  pulling(task: Promise<unknown>): void;
  claimed(execution: ExecutionRecord): void;
}

export async function pullLoop(
  input: PullLoopInput,
): Promise<Diagnostic | null> {
  assert.ok(input.registration.runtimeIdentity);
  assert.ok(input.api.scheduler.workPull);
  let registration = input.registration;
  while (!input.shutdown.err()) {
    const task = input.api.scheduler
      .workPull(
        {
          params: {},
          query: {},
          body: {
            resourceIdentity: registration.resourceIdentity,
            runtimeIdentity: registration.runtimeIdentity,
          },
        },
        { idempotencyKey: ulid(), context: background },
      )
      .then((result) => {
        if (
          result.type === OperationResultType.Completed &&
          result.data.kind === WorkPullKind.Claimed
        )
          input.claimed(result.data.execution);
        return result;
      });
    input.pulling(task);
    const result = await task;
    if (
      result.type === OperationResultType.Completed &&
      result.data.kind === WorkPullKind.Claimed
    ) {
      input.backoff.reset();
      const failure = await input.host(result.data.execution);
      if (failure) return failure;
      continue;
    }
    if (input.shutdown.err()) return null;
    if (
      result.type === OperationResultType.Failure &&
      result.status < SERVER_ERROR
    ) {
      if (result.error.error.code !== REGISTRATION_REQUIRED)
        return new Diagnostic(
          result.error.error.code,
          result.error.error.message,
        );
      registration = await input.register();
      continue;
    }
    await sleep(input.backoff.next(), input.shutdown);
  }
  return null;
}
