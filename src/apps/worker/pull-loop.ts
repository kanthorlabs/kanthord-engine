import assert from "node:assert/strict";
import {
  CancellationContext,
  type Context,
  joined,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  type ExecutionRecord,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import type { Backoff } from "./api.ts";
import { sleep } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import type { Registration } from "./registration.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const REGISTRATION_REQUIRED = "gateway.registration.required";
const CONNECTION_SUPERSEDED = "gateway.jwt.connection_superseded";
const NO_DELAY = 0;
export const GATE_POLL_MS = 250;
export const SETUP_UNAVAILABLE = "setup_unavailable";
export interface PullLoopInput {
  api: WorkerTransport;
  registration: Registration;
  backoff: Backoff;
  shutdown: Context;
  host(
    execution: ExecutionRecord,
  ): Promise<Diagnostic | null | typeof SETUP_UNAVAILABLE>;
  register(): Promise<Registration>;
  pulling(task: Promise<unknown>): void;
  claimed(execution: ExecutionRecord): void;
  gate?(): boolean;
  idle?(): Promise<void>;
  round?(): Context;
}

type PullStep = Diagnostic | null | undefined;
type WorkPullResult = Awaited<
  ReturnType<WorkerTransport["scheduler"]["workPull"]>
>;
type WorkPullFailure = Extract<
  WorkPullResult,
  { type: typeof OperationResultType.Failure }
>;

interface PullState {
  registration: Registration;
}

interface PullRequest {
  task: Promise<WorkPullResult>;
  context: CancellationContext;
}

interface PullAnswer {
  result: WorkPullResult;
  round: Context | undefined;
  started: number;
}

export async function pullLoop(
  input: PullLoopInput,
): Promise<Diagnostic | null> {
  assert.ok(input.registration.runtime_identity);
  assert.ok(input.api.scheduler.workPull);
  const state: PullState = { registration: input.registration };
  while (!input.shutdown.signal.aborted) {
    if (input.idle) {
      await input.idle();
      if (input.shutdown.signal.aborted) break;
    }
    if (input.gate && !input.gate()) {
      await sleep(GATE_POLL_MS, input.shutdown);
      continue;
    }
    const round = input.round?.();
    const started = performance.now();
    const request = requestWork(input, state.registration, round);
    const result = await request.task;
    request.context.cancel();
    const step = await nextStep(input, state, { result, round, started });
    if (step !== undefined) return step;
  }
  return null;
}

function claimedExecution(result: WorkPullResult): ExecutionRecord | null {
  if (
    result.type === OperationResultType.Completed &&
    result.data.kind === WorkPullKind.Claimed
  )
    return result.data.execution;
  return null;
}

function requestWork(
  input: PullLoopInput,
  registration: Registration,
  round: Context | undefined,
): PullRequest {
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
      const claimed = claimedExecution(result);
      if (claimed) input.claimed(claimed);
      return result;
    });
  input.pulling(task);
  return { task, context };
}

function nextStep(
  input: PullLoopInput,
  state: PullState,
  answer: PullAnswer,
): PullStep | Promise<PullStep> {
  const { result, round, started } = answer;
  const claimed = claimedExecution(result);
  if (claimed) return hostClaimed(input, claimed);
  if (input.shutdown.signal.aborted) return null;
  if (round?.signal.aborted) return undefined;
  if (result.type === OperationResultType.Completed)
    return waitForNextPull(input, started);
  if (
    result.type === OperationResultType.Failure &&
    result.status < HttpStatus.InternalServerError &&
    result.error.error.code !== CONNECTION_SUPERSEDED
  )
    return answerRefusal(input, state, result);
  return pause(input.backoff.next(), input.shutdown);
}

async function pause(ms: number, shutdown: Context): Promise<PullStep> {
  await sleep(ms, shutdown);
  return undefined;
}

async function hostClaimed(
  input: PullLoopInput,
  execution: ExecutionRecord,
): Promise<PullStep> {
  const failure = await input.host(execution);
  if (failure === SETUP_UNAVAILABLE)
    return pause(input.backoff.next(), input.shutdown);
  if (failure) return failure;
  input.backoff.reset();
  return undefined;
}

function waitForNextPull(
  input: PullLoopInput,
  started: number,
): PullStep | Promise<PullStep> {
  const rest = input.backoff.next() - (performance.now() - started);
  if (rest > NO_DELAY) return pause(rest, input.shutdown);
  input.backoff.reset();
  return undefined;
}

function answerRefusal(
  input: PullLoopInput,
  state: PullState,
  result: WorkPullFailure,
): PullStep | Promise<PullStep> {
  if (result.error.error.code !== REGISTRATION_REQUIRED)
    return new Diagnostic(result.error.error.code, result.error.error.message);
  return registerAgain(input, state);
}

async function registerAgain(
  input: PullLoopInput,
  state: PullState,
): Promise<PullStep> {
  state.registration = await input.register();
  return undefined;
}
