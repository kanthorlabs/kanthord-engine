import assert from "node:assert/strict";
import { ulid } from "ulid";
import { CancellationContext, type Context } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { Backoff, sleep } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import type { Registration } from "./registration.ts";

const SERVER_ERROR = 500;
const REGISTRATION_REQUIRED = "gateway.registration.required";
const CONNECTION_SUPERSEDED = "gateway.jwt.connection_superseded";
export interface PullLoopInput {
  api: WorkerTransport;
  registration: Registration;
  backoff: Backoff;
  shutdown: Context;
  host(execution: ExecutionRecord): Promise<Diagnostic | null>;
  register(): Promise<Registration>;
  pulling(task: Promise<unknown>): void;
  claimed(execution: ExecutionRecord): void;
  idle?(): Promise<void>;
  round?(): Context;
}

export async function pullLoop(
  input: PullLoopInput,
): Promise<Diagnostic | null> {
  assert.ok(input.registration.runtime_identity);
  assert.ok(input.api.scheduler.workPull);
  let registration = input.registration;
  while (!input.shutdown.err()) {
    if (input.idle) {
      await input.idle();
      if (input.shutdown.err()) break;
    }
    const round = input.round?.();
    const context = new CancellationContext(input.shutdown);
    const preempted = round?.onCancel(() => context.cancel());
    const task = input.api.scheduler
      .workPull(
        {
          params: {},
          query: {},
          body: {
            resource_identity: registration.resource_identity,
            runtime_identity: registration.runtime_identity,
          },
        },
        { idempotencyKey: ulid(), context },
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
    preempted?.();
    context.cancel();
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
    if (round?.err()) continue;
    if (
      result.type === OperationResultType.Failure &&
      result.status < SERVER_ERROR &&
      result.error.error.code !== CONNECTION_SUPERSEDED
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
