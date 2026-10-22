import assert from "node:assert/strict";
import {
  CancellationContext,
  type Context,
  joined,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import {
  WorkPullKind,
  type ExecutionRecord,
} from "../../scheduler/contract.ts";
import { Backoff, sleep } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import type { Registration } from "./registration.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const SERVER_ERROR = 500;
const REGISTRATION_REQUIRED = "gateway.registration.required";
const CONNECTION_SUPERSEDED = "gateway.jwt.connection_superseded";
const NO_DELAY = 0;
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
  while (!input.shutdown.signal.aborted) {
    if (input.idle) {
      await input.idle();
      if (input.shutdown.signal.aborted) break;
    }
    const round = input.round?.();
    const started = performance.now();
    const context = new CancellationContext(
      round ? joined(input.shutdown, round) : input.shutdown,
    );
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
        { idempotencyKey: createIdempotencyKey(), context },
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
    if (input.shutdown.signal.aborted) return null;
    if (round?.signal.aborted) continue;
    if (result.type === OperationResultType.Completed) {
      const rest = input.backoff.next() - (performance.now() - started);
      if (rest <= NO_DELAY) {
        input.backoff.reset();
        continue;
      }
      await sleep(rest, input.shutdown);
      continue;
    }
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
