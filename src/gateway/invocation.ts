import { addAbortListener } from "node:events";
import assert from "node:assert/strict";
import type { Logger } from "pino";
import { z } from "zod";
import type { Store, Transaction } from "../kernel/store.ts";
import { digest } from "../kernel/json.ts";
import { validationIssues } from "../kernel/errors.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  CancellationContext,
  type Context,
  joined,
} from "../kernel/context.ts";
import { lifecycle } from "../kernel/service.ts";
import type { Authentication } from "./auth/authentication.ts";
import {
  type CallerIdentity,
  isHumanIdentity,
  isMachineIdentity,
  isServiceIdentity,
  isWorkerIdentity,
} from "../kernel/caller.ts";
import {
  failure,
  GatewayError,
  unauthorized,
  WorkerGroupEnded,
} from "./errors.ts";
import {
  AccessPolicy,
  type ExecutionClaim,
  type ExecutionProofRow,
  type Operation,
  OperationLifetime,
  type StoreMap,
} from "../kernel/operation.ts";
import { HttpStatus } from "../kernel/http.ts";
import { resolveRequestId } from "./request-id.ts";
import type { Idempotency } from "./idempotency.ts";
import type { RecordedResponse, Reservation } from "./idempotency.ts";
import type {
  CallerContext,
  OperationRegistry,
  RegisteredOperation,
} from "../kernel/operation.ts";

const AUTHENTICATED_POLICIES: Partial<
  Record<
    AccessPolicy,
    (identity: CallerIdentity, operation: Operation) => boolean
  >
> = {
  [AccessPolicy.Human]: isHumanIdentity,
  [AccessPolicy.Client]: isMachineIdentity,
  [AccessPolicy.Worker]: isWorkerIdentity,
  [AccessPolicy.HumanOrWorker]: (identity) =>
    isHumanIdentity(identity) || isWorkerIdentity(identity),
  [AccessPolicy.HumanOrService]: (identity, operation) => {
    if (isHumanIdentity(identity)) return true;
    if (!isServiceIdentity(identity)) return false;
    if (operation.services?.includes(identity.service)) return true;
    throw new GatewayError(
      HttpStatus.Forbidden,
      "gateway.access.service_refused",
      "The operation does not accept this service identity.",
    );
  },
};

export interface InvocationOptions {
  authorization?: string;
  identity?: CallerIdentity;
  onIdentity?: (identity: CallerIdentity) => void;
  idempotencyKey?: string;
  context?: Context;
  requestId?: string;
  traceparent?: string;
  tracestate?: string;
  delivery?: CallerContext["delivery"];
  rejection?: GatewayError;
  request?: Request;
  host?: string;
  logger?: Logger;
}

export interface ExecutionLookup {
  executionOf(executionId: string): ExecutionProofRow | undefined;
}

interface ExecutionInput {
  params: unknown;
  query: unknown;
  body: unknown;
}

interface ExecutionOptions extends InvocationOptions {
  requestId: string;
}

interface ExecutionState {
  reservation?: Reservation;
  committed?: RecordedResponse;
  streaming: boolean;
}

interface ExecutionRun {
  options: ExecutionOptions;
  context: CancellationContext;
  state: ExecutionState;
  dispose: () => void;
}

interface MutationRequest {
  identity: CallerIdentity | undefined;
  input: ExecutionInput;
  idempotencyKey: string | undefined;
}

interface CallerParts {
  identity: CallerIdentity | undefined;
  execution: ExecutionClaim | undefined;
}

function recordOf(value: unknown): Record<string, unknown> {
  return isObject(value) ? (value as Record<string, unknown>) : {};
}

function liveExecutionRow(
  row: ExecutionProofRow | undefined,
  identity: CallerIdentity | undefined,
): ExecutionProofRow {
  if (
    !isMachineIdentity(identity) ||
    !identity.runtimeIdentity ||
    !row ||
    row.runtime_identity !== identity.runtimeIdentity ||
    row.ended_at !== null ||
    Date.now() >= row.expired_at
  )
    throw new GatewayError(
      HttpStatus.Forbidden,
      "gateway.invocation.execution_proof_failed",
      "The execution is not a live claim of this registration.",
    );
  return row;
}

function claimOf(row: ExecutionProofRow): ExecutionClaim {
  return {
    executionId: row.execution_id,
    projectId: row.project_id,
    nodeId: row.node_id,
    attempt: row.attempt,
    pinnedRevision: row.pinned_revision,
    nodeBranch: row.node_branch,
    runtimeIdentity: row.runtime_identity,
    workerBindingId: row.worker_binding_id,
  };
}

function endedGroupRefusal(thrown: unknown, operation: Operation): unknown {
  if (!(thrown instanceof WorkerGroupEnded) || !operation.endedGroup)
    return thrown;
  return new GatewayError(
    HttpStatus.NotFound,
    operation.endedGroup.code,
    operation.endedGroup.message,
  );
}

function refuseAdmission(
  operation: Operation,
  identity: CallerIdentity | undefined,
): void {
  if (operation.access === AccessPolicy.Service && !isServiceIdentity(identity))
    throw unauthorized();
  if (
    operation.access === AccessPolicy.Client &&
    operation.requiresRegistration !== false &&
    isMachineIdentity(identity) &&
    !identity.runtimeIdentity
  )
    throw new GatewayError(
      HttpStatus.Forbidden,
      "gateway.registration.required",
      "A live worker registration is required.",
    );
}

function parsedInput(operation: Operation, raw: unknown): ExecutionInput {
  if (operation.delivery) return raw as ExecutionInput;
  const parsed = operation.input.safeParse(raw);
  if (!parsed.success)
    throw new GatewayError(
      HttpStatus.BadRequest,
      "gateway.request.validation_failed",
      "Request validation failed.",
      validationIssues(parsed.error).map((issue) => ({
        path: issue.path.map(String),
        code: issue.code,
      })),
    );
  return parsed.data as ExecutionInput;
}

function refuseCancelled(context: CancellationContext): void {
  if (context.signal.aborted)
    throw new GatewayError(
      HttpStatus.ServiceUnavailable,
      "gateway.invocation.cancelled",
      "Request cancelled.",
    );
}

function idempotencyCaller(
  identity: CallerIdentity | undefined,
): string | undefined {
  if (isHumanIdentity(identity)) return identity.accountId;
  if (isMachineIdentity(identity)) return identity.clientId;
  if (isWorkerIdentity(identity)) return identity.instanceId;
  if (isServiceIdentity(identity)) return identity.service;
  return undefined;
}

function refuseStaleReplay(
  operation: Operation,
  replay: RecordedResponse,
  identity: CallerIdentity,
): void {
  if (operation.replayGuard && !operation.replayGuard(replay.body, identity))
    throw new GatewayError(
      HttpStatus.Conflict,
      "gateway.registration.stale",
      "The recorded registration has ended; use a new idempotency key.",
    );
}

function streamRequest(
  operation: Operation,
  options: InvocationOptions,
): Request | undefined {
  if (operation.lifetime !== OperationLifetime.Stream || !options.request)
    return undefined;
  const headers = new Headers(options.request.headers);
  headers.delete("authorization");
  return new Request(options.request, { headers });
}

function cancelledOrThrown(thrown: unknown, context: CancellationContext) {
  return thrown !== null && thrown === context.signal.reason
    ? new GatewayError(
        HttpStatus.ServiceUnavailable,
        "gateway.invocation.cancelled",
        "Request cancelled.",
      )
    : thrown;
}

export class Invocation {
  readonly pending = new Set<Promise<RecordedResponse>>();
  private readonly registry: OperationRegistry;
  readonly authentication: Authentication;
  readonly idempotency: Idempotency;
  private readonly stores: StoreMap<Store>;
  private readonly shutdown = new CancellationContext();
  private readonly streams = new Set<Promise<void>>();
  private stopTask?: Promise<Error | null>;
  private stopped = false;
  private readonly scheduler?: ExecutionLookup;

  constructor(
    registry: OperationRegistry,
    authentication: Authentication,
    idempotency: Idempotency,
    stores: StoreMap<Store>,
    scheduler?: ExecutionLookup,
  ) {
    this.registry = registry;
    this.authentication = authentication;
    this.idempotency = idempotency;
    this.stores = stores;
    this.scheduler = scheduler;
  }

  private executionRowOf(
    input: Pick<ExecutionInput, "params" | "body">,
  ): ExecutionProofRow | undefined {
    const params = recordOf(input.params);
    const body = recordOf(input.body);
    const executionId = [params.execution_id, body.execution_id].find(isString);
    return isString(executionId)
      ? this.scheduler?.executionOf(executionId)
      : undefined;
  }

  private proveExecution(
    input: { params: unknown; body: unknown },
    identity: CallerIdentity | undefined,
  ): ExecutionClaim {
    const row = this.executionRowOf(input);
    return claimOf(liveExecutionRow(row, identity));
  }

  healthcheck(): boolean {
    return (
      !this.stopped &&
      this.registry.healthcheck() &&
      Object.values(this.stores).every((store) => store?.healthcheck() ?? false)
    );
  }

  async invoke(
    id: string,
    input: unknown,
    options: InvocationOptions = {},
  ): Promise<RecordedResponse> {
    const entry = this.registry.get(id);
    const requestId = resolveRequestId(options.requestId);
    if (this.stopped)
      return failure(
        new GatewayError(
          HttpStatus.ServiceUnavailable,
          "gateway.invocation.stopping",
          "Server is stopping.",
        ),
        requestId,
      );
    const task = this.execute(entry, input, { ...options, requestId });
    this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        task,
        new Promise<RecordedResponse>((resolve) => {
          timer = setTimeout(
            () =>
              resolve(
                failure(
                  new GatewayError(
                    HttpStatus.GatewayTimeout,
                    "gateway.invocation.timeout",
                    "Request timed out; the operation may still complete.",
                  ),
                  requestId,
                ),
              ),
            entry.operation.timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size || this.streams.size) {
      await Promise.all([...this.pending, ...this.streams]);
    }
  }

  stop(): Promise<Error | null> {
    this.stopTask ??= lifecycle(async () => {
      while (this.pending.size || this.streams.size)
        await Promise.all([...this.pending, ...this.streams]);
      this.stopped = true;
      this.shutdown.cancel();
      this.idempotency.stop();
    });
    return this.stopTask;
  }

  private stream(
    response: Response,
    context: Context,
    dispose: () => void,
  ): Response {
    if (!response.body) {
      dispose();
      return response;
    }
    const reader = response.body.getReader();
    const completed = Promise.withResolvers<void>();
    this.streams.add(completed.promise);
    let finished = false;
    let cancellation: Disposable | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancellation?.[Symbol.dispose]();
      dispose();
      this.streams.delete(completed.promise);
      completed.resolve();
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        cancellation = addAbortListener(context.signal, () => {
          void reader.cancel().then(
            () => {
              if (!finished) controller.close();
              finish();
            },
            (error) => {
              if (!finished) controller.error(error);
              finish();
            },
          );
        });
      },
      pull: async (controller) => {
        try {
          const result = await reader.read();
          if (finished) return;
          if (result.done) {
            controller.close();
            finish();
          } else controller.enqueue(result.value);
        } catch (error) {
          if (!finished) controller.error(error);
          finish();
        }
      },
      cancel: async () => {
        try {
          await reader.cancel();
        } finally {
          finish();
        }
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  private async identityOf(
    operation: Operation,
    options: InvocationOptions,
    context: Context,
  ): Promise<CallerIdentity | undefined> {
    let identity =
      options.identity === undefined
        ? undefined
        : await this.authentication.recheck(
            options.identity,
            context,
            operation.requiresRegistration !== false,
          );
    const admits = AUTHENTICATED_POLICIES[operation.access];
    if (admits) {
      identity ??= await this.authentication.authenticate(
        options.authorization,
        context,
      );
      options.onIdentity?.(identity);
      if (!admits(identity, operation)) throw unauthorized();
    } else if (identity) options.onIdentity?.(identity);
    return identity;
  }

  private async callerOf(
    operation: Operation,
    options: InvocationOptions,
    context: Context,
  ): Promise<CallerIdentity | undefined> {
    try {
      return await this.identityOf(operation, options, context);
    } catch (thrown) {
      throw endedGroupRefusal(thrown, operation);
    }
  }

  private async admit(
    operation: Operation,
    run: ExecutionRun,
  ): Promise<CallerIdentity | undefined> {
    const { options, context } = run;
    const identity = await this.callerOf(operation, options, context);
    refuseAdmission(operation, identity);
    if (options.rejection) throw options.rejection;
    return identity;
  }

  private replayOrReserve(
    operation: Operation,
    request: MutationRequest,
    state: ExecutionState,
  ): RecordedResponse | undefined {
    const { identity, input } = request;
    const caller = idempotencyCaller(identity);
    if (!caller || !identity) throw unauthorized();
    const held = this.idempotency.reserve(
      request.idempotencyKey,
      caller,
      operation.id,
      digest({
        operation: operation.id,
        params: input.params,
        query: input.query,
        body: input.body,
      }),
    );
    if (!held.replay) {
      state.reservation = held.reservation;
      return undefined;
    }
    refuseStaleReplay(operation, held.replay, identity);
    return held.replay;
  }

  private committer(
    operation: Operation,
    state: ExecutionState,
  ): CallerContext["commit"] {
    return <T>(write: (transaction: Transaction) => T): T => {
      if (state.committed) throw new Error("caller.commit: called twice.");
      const store = this.stores[operation.store];
      assert.ok(store, `caller.commit: store ${operation.store} is absent`);
      const response = store.transaction((transaction) => {
        const body = operation.output.parse(write(transaction));
        return { status: operation.status, body };
      });
      state.committed = response;
      return response.body as T;
    };
  }

  private callerContext(
    operation: Operation,
    run: ExecutionRun,
    parts: CallerParts,
  ): CallerContext {
    const { options } = run;
    return {
      identity: parts.identity,
      execution: parts.execution,
      context: run.context,
      requestId: options.requestId,
      idempotencyKey: options.idempotencyKey,
      traceparent: options.traceparent,
      tracestate: options.tracestate,
      delivery: options.delivery,
      request: streamRequest(operation, options),
      host: options.host,
      commit: this.committer(operation, run.state),
    };
  }

  private completeRecorded(
    operation: Operation,
    response: RecordedResponse,
    state: ExecutionState,
  ): void {
    if (state.reservation)
      this.idempotency.complete(state.reservation, response, operation.secret);
  }

  private settle(
    operation: Operation,
    output: unknown,
    run: ExecutionRun,
  ): RecordedResponse {
    const { state } = run;
    if (operation.delivery && output instanceof Response)
      return { status: output.status, body: output };
    if (state.committed) {
      this.completeRecorded(operation, state.committed, state);
      return state.committed;
    }
    if (
      operation.lifetime === OperationLifetime.Stream &&
      output instanceof Response
    ) {
      const body = this.stream(output, run.context, run.dispose);
      state.streaming = true;
      return { status: output.status, body };
    }
    const body = operation.output.parse(output);
    const response = { status: operation.status, body };
    this.completeRecorded(operation, response, state);
    return response;
  }

  private recordFailure(
    operation: Operation,
    thrown: unknown,
    run: ExecutionRun,
  ): RecordedResponse {
    const { options } = run;
    const error = cancelledOrThrown(thrown, run.context);
    if (!(error instanceof GatewayError))
      options.logger?.error(
        {
          err: error,
          request_id: options.requestId,
          operation: operation.id,
        },
        "Request failed",
      );
    const response = failure(
      error instanceof z.ZodError
        ? new GatewayError(
            HttpStatus.InternalServerError,
            "gateway.invocation.invalid_response",
            "Operation returned an invalid response.",
          )
        : error,
      options.requestId,
    );
    this.completeRecorded(operation, response, run.state);
    return response;
  }

  private async execute(
    { operation, handler }: RegisteredOperation,
    raw: unknown,
    options: InvocationOptions & { requestId: string },
  ): Promise<RecordedResponse> {
    const context = new CancellationContext(
      options.context ? joined(this.shutdown, options.context) : this.shutdown,
    );
    const run: ExecutionRun = {
      options,
      context,
      state: { streaming: false },
      dispose: () => context.cancel(),
    };
    try {
      const identity = await this.admit(operation, run);
      const input = parsedInput(operation, raw);
      refuseCancelled(context);
      const execution = operation.requiresExecution
        ? this.proveExecution(input, identity)
        : undefined;
      if (operation.mutation) {
        const replay = this.replayOrReserve(
          operation,
          { identity, input, idempotencyKey: options.idempotencyKey },
          run.state,
        );
        if (replay) return replay;
      }
      const caller = this.callerContext(operation, run, {
        identity,
        execution,
      });
      const output = await handler(input, caller);
      return this.settle(operation, output, run);
    } catch (thrown) {
      return this.recordFailure(operation, thrown, run);
    } finally {
      if (!run.state.streaming) run.dispose();
    }
  }
}
