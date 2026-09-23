import { z } from "zod";
import type { Store } from "../kernel/store.ts";
import { digest } from "../kernel/json.ts";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { lifecycle } from "../kernel/service.ts";
import { Authentication } from "./authentication.ts";
import {
  isHumanIdentity,
  isMachineIdentity,
  type CallerIdentity,
} from "../kernel/caller.ts";
import { GatewayError, failure, unauthorized } from "./errors.ts";
import { AccessPolicy, OperationInteraction } from "../kernel/operation.ts";
import { HttpStatus } from "../kernel/http.ts";
import { resolveRequestId } from "./request-id.ts";
import {
  Idempotency,
  type RecordedResponse,
  type Reservation,
} from "./idempotency.ts";
import type {
  CallerContext,
  OperationRegistry,
  RegisteredOperation,
} from "../kernel/operation.ts";

export interface InvocationOptions {
  authorization?: string;
  identity?: CallerIdentity;
  idempotencyKey?: string;
  context?: Context;
  requestId?: string;
  traceparent?: string;
  tracestate?: string;
  delivery?: CallerContext["delivery"];
  request?: Request;
}

export class Invocation {
  readonly pending = new Set<Promise<RecordedResponse>>();
  private readonly registry: OperationRegistry;
  readonly authentication: Authentication;
  readonly idempotency: Idempotency;
  private readonly store: Store;
  private readonly shutdown: CancellationContext;
  private readonly streams = new Set<Promise<void>>();
  private stopTask?: Promise<Error | null>;

  constructor(
    registry: OperationRegistry,
    authentication: Authentication,
    idempotency: Idempotency,
    store: Store,
    shutdown: Context,
  ) {
    this.registry = registry;
    this.authentication = authentication;
    this.idempotency = idempotency;
    this.store = store;
    this.shutdown = new CancellationContext(shutdown);
  }

  healthcheck(): boolean {
    return (
      !this.shutdown.err() &&
      this.registry.healthcheck() &&
      this.store.healthcheck()
    );
  }

  async invoke(
    id: string,
    input: unknown,
    options: InvocationOptions = {},
  ): Promise<RecordedResponse> {
    const entry = this.registry.get(id);
    const requestId = resolveRequestId(options.requestId);
    if (this.shutdown.err())
      return failure(
        new GatewayError(
          503,
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
                    504,
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
    await Promise.all(this.pending);
    await Promise.all(this.streams);
  }

  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.stopTask ??= lifecycle(() => this.drain());
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
    let unsubscribe = () => {};
    const finish = () => {
      if (finished) return;
      finished = true;
      unsubscribe();
      dispose();
      this.streams.delete(completed.promise);
      completed.resolve();
    };
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        unsubscribe = context.onCancel(() => {
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

  private async execute(
    { operation, handler }: RegisteredOperation,
    raw: unknown,
    options: InvocationOptions & { requestId: string },
  ): Promise<RecordedResponse> {
    let reservation: Reservation | undefined;
    let committed: RecordedResponse | undefined;
    const context = new CancellationContext(
      this.shutdown,
      options.context?.deadline(),
    );
    const unsubscribe = options.context?.onCancel((error) =>
      context.cancel(error),
    );
    const dispose = () => {
      unsubscribe?.();
      context.cancel();
    };
    let streaming = false;
    try {
      let identity =
        options.identity === undefined
          ? undefined
          : await this.authentication.recheck(options.identity, context);
      const parsed =
        operation.interaction === OperationInteraction.Delivery
          ? { success: true as const, data: raw }
          : operation.input.safeParse(raw);
      if (!parsed.success)
        throw new GatewayError(
          400,
          "gateway.request.validation_failed",
          "Request validation failed.",
          parsed.error.issues.map((issue) => ({
            path: issue.path.map(String),
            code: issue.code,
          })),
        );
      const input = parsed.data as {
        params: unknown;
        query: unknown;
        body: unknown;
      };
      if (context.err())
        throw new GatewayError(
          503,
          "gateway.invocation.cancelled",
          "Request cancelled.",
        );
      if (
        operation.access === AccessPolicy.Human ||
        operation.access === AccessPolicy.Client
      ) {
        identity ??= await this.authentication.authenticate(
          options.authorization,
          context,
        );
        if (
          operation.access === AccessPolicy.Human
            ? !isHumanIdentity(identity)
            : !isMachineIdentity(identity)
        )
          throw unauthorized();
      }
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
      if (operation.mutation) {
        const caller = isHumanIdentity(identity)
          ? identity.accountId
          : isMachineIdentity(identity)
            ? identity.clientId
            : undefined;
        if (!caller || !identity) throw unauthorized();
        const held = this.idempotency.reserve(
          options.idempotencyKey,
          caller,
          operation.id,
          digest({
            operation: operation.id,
            params: input.params,
            query: input.query,
            body: input.body,
          }),
        );
        if (held.replay) {
          if (
            operation.replayGuard &&
            !operation.replayGuard(held.replay.body, identity)
          )
            throw new GatewayError(
              HttpStatus.Conflict,
              "gateway.registration.stale",
              "The recorded registration has ended; use a new idempotency key.",
            );
          return held.replay;
        }
        reservation = held.reservation;
      }
      let request: Request | undefined;
      if (
        operation.interaction === OperationInteraction.Stream &&
        options.request
      ) {
        const headers = new Headers(options.request.headers);
        headers.delete("authorization");
        request = new Request(options.request, { headers });
      }
      const caller: CallerContext = {
        identity,
        context,
        requestId: options.requestId,
        idempotencyKey: options.idempotencyKey,
        traceparent: options.traceparent,
        tracestate: options.tracestate,
        delivery: options.delivery,
        request,
        commit: <T>(
          write: (transaction: import("../kernel/store.ts").Transaction) => T,
        ): T => {
          if (!reservation || committed)
            throw new Error("A mutation commits exactly once.");
          const response = this.store.transaction((transaction) => {
            const body = operation.output.parse(write(transaction));
            const result = { status: operation.status, body };
            this.idempotency.complete(
              transaction,
              reservation!,
              result,
              operation.secret,
            );
            return result;
          });
          committed = response;
          return response.body as T;
        },
      };
      const output = await handler(parsed.data, caller);
      if (committed) return committed;
      if (
        operation.interaction === OperationInteraction.Stream &&
        output instanceof Response
      ) {
        const body = this.stream(output, context, dispose);
        streaming = true;
        return { status: output.status, body };
      }
      const body = operation.output.parse(output);
      const response = { status: operation.status, body };
      if (reservation)
        this.store.transaction((transaction) =>
          this.idempotency.complete(
            transaction,
            reservation!,
            response,
            operation.secret,
          ),
        );
      return response;
    } catch (error) {
      if (committed) return committed;
      const response = failure(
        error instanceof z.ZodError
          ? new GatewayError(
              500,
              "gateway.invocation.invalid_response",
              "Operation returned an invalid response.",
            )
          : error,
        options.requestId,
      );
      if (reservation) {
        try {
          this.store.transaction((transaction) =>
            this.idempotency.complete(
              transaction,
              reservation!,
              response,
              operation.secret,
            ),
          );
        } catch (persistenceError) {
          return failure(persistenceError, options.requestId);
        }
      }
      return response;
    } finally {
      if (!streaming) dispose();
    }
  }
}
