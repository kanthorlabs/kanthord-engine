import { ulid } from "ulid";
import { z } from "zod";
import type { Operation } from "./registry.ts";
import type { Invocation, InvocationOptions } from "./invocation.ts";
import { errorSchema, type ErrorBody } from "./errors.ts";
import { resolveRequestId } from "./request-id.ts";
import type { RecordedResponse } from "./idempotency.ts";
import {
  abortSignal,
  background,
  CancellationContext,
  type Context,
} from "../context.ts";

export const OperationResultType = {
  Completed: "completed",
  Failure: "failure",
  Indeterminate: "indeterminate",
} as const;

export type OperationResult<T> =
  | {
      type: typeof OperationResultType.Completed;
      status: number;
      data: T;
      idempotencyKey?: string;
    }
  | {
      type: typeof OperationResultType.Failure;
      status: number;
      error: ErrorBody;
      idempotencyKey?: string;
    }
  | { type: typeof OperationResultType.Indeterminate; idempotencyKey?: string };
export interface ClientOptions {
  idempotencyKey?: string;
  context?: Context;
  traceparent?: string;
  tracestate?: string;
}
export type ServiceClient<T extends Record<string, Operation>> = {
  [K in keyof T]: (
    input: z.input<T[K]["input"]>,
    options?: ClientOptions,
  ) => Promise<OperationResult<z.output<T[K]["output"]>>>;
};

function createClient<T extends Record<string, Operation>>(
  operations: T,
  call: (
    operation: Operation,
    input: unknown,
    options: ClientOptions,
  ) => Promise<RecordedResponse>,
): ServiceClient<T> {
  return Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [
      name,
      async (input: unknown, options: ClientOptions = {}) => {
        const idempotencyKey = operation.mutation
          ? (options.idempotencyKey ?? ulid())
          : undefined;
        try {
          const result = await call(operation, input, {
            ...options,
            idempotencyKey,
          });
          if (result.status === operation.status)
            return {
              type: OperationResultType.Completed,
              status: result.status,
              data: operation.output.parse(result.body),
              idempotencyKey,
            };
          return {
            type: OperationResultType.Failure,
            status: result.status,
            error: errorSchema.parse(result.body),
            idempotencyKey,
          };
        } catch {
          return { type: OperationResultType.Indeterminate, idempotencyKey };
        }
      },
    ]),
  ) as ServiceClient<T>;
}

export function directClient<T extends Record<string, Operation>>(
  operations: T,
  invocation: Invocation,
  caller: InvocationOptions = {},
): ServiceClient<T> {
  return createClient(operations, (operation, input, options) =>
    invocation.invoke(operation.id, input, { ...caller, ...options }),
  );
}

export function httpClient<T extends Record<string, Operation>>(
  operations: T,
  endpoint: string,
  token?: string,
  transport: typeof fetch = fetch,
): ServiceClient<T> {
  return createClient(operations, async (operation, raw, options) => {
    const parsed = operation.input.safeParse(raw);
    if (!parsed.success) {
      return {
        status: 400,
        body: {
          error: {
            code: "gateway.request.validation_failed",
            message: "Request validation failed.",
            details: parsed.error.issues.map((issue) => ({
              path: issue.path.map(String),
              code: issue.code,
            })),
          },
          requestId: resolveRequestId(),
        },
      };
    }
    const input = parsed.data as {
      params: Record<string, unknown>;
      query: Record<string, unknown>;
      body: unknown;
    };
    const path = operation.path.replace(/:([^/]+)/g, (_, key: string) =>
      encodeURIComponent(String(input.params[key])),
    );
    const url = new URL(path, endpoint);
    for (const [key, value] of Object.entries(input.query))
      for (const entry of Array.isArray(value) ? value : [value])
        if (entry !== undefined) url.searchParams.append(key, String(entry));
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (options.idempotencyKey)
      headers.set("Idempotency-Key", options.idempotencyKey);
    if (options.traceparent) headers.set("traceparent", options.traceparent);
    if (options.tracestate) headers.set("tracestate", options.tracestate);
    if (operation.body) headers.set("Content-Type", "application/json");
    const context = new CancellationContext(
      options.context ?? background,
      Date.now() + operation.timeoutMs + 1000,
    );
    const native = abortSignal(context);
    try {
      const response = await transport(url, {
        method: operation.method,
        headers,
        ...(operation.body ? { body: JSON.stringify(input.body) } : {}),
        signal: native.signal,
        redirect: "error",
      });
      return {
        status: response.status,
        body:
          operation.contentType && response.ok
            ? await response.text()
            : await response.json(),
      };
    } finally {
      native.dispose();
      context.cancel();
    }
  });
}
