import type { ErrorBody } from "./errors.ts";
import { z } from "zod";
import type { CallerIdentity } from "./caller.ts";
import type { Transaction } from "./store.ts";
import type { Context } from "./context.ts";
import type { HttpMethod } from "./http.ts";

export const AccessPolicy = {
  Human: "human",
  Client: "client",
  Public: "public",
  Delivery: "delivery",
} as const;
export type AccessPolicy = (typeof AccessPolicy)[keyof typeof AccessPolicy];

export const OperationLifetime = {
  Unary: "unary",
  Wait: "wait",
  Stream: "stream",
} as const;
export type OperationLifetime =
  (typeof OperationLifetime)[keyof typeof OperationLifetime];

export const StoreName = { Operational: "operational" } as const;
export type StoreName = (typeof StoreName)[keyof typeof StoreName];

const NO_TIMEOUT_MS = 0;
const EMPTY_REGISTRY_SIZE = 0;
export const emptyInput = z.strictObject({
  params: z.strictObject({}),
  query: z.strictObject({}),
  body: z.null(),
});
export interface Operation<
  I extends z.ZodType = z.ZodType,
  O extends z.ZodType = z.ZodType,
> {
  id: string;
  service: string;
  method: Exclude<
    (typeof HttpMethod)[keyof typeof HttpMethod],
    typeof HttpMethod.Options
  >;
  path: string;
  access: AccessPolicy;
  timeoutMs: number;
  mutation: boolean;
  store: StoreName;
  input: I;
  output: O;
  status: number;
  body?: boolean;
  secret?: boolean;
  requiresRegistration?: boolean;
  maxBodyBytes?: number;
  replayGuard?: (recorded: unknown, identity: CallerIdentity) => boolean;
  lifetime: OperationLifetime;
  delivery?: true;
  contentType?: string;
  errors?: readonly number[];
  description: string;
}

export interface CallerContext {
  identity?: CallerIdentity;
  context: Context;
  requestId: string;
  traceparent?: string;
  tracestate?: string;
  idempotencyKey?: string;
  /** Exact delivery bytes and headers; never reconstructed from parsed JSON. */
  delivery?: { bytes: ArrayBuffer; headers: Headers };
  request?: Request;
  commit<T>(write: (transaction: Transaction) => T): T;
}
export type Handler<I extends z.ZodType, O extends z.ZodType> = (
  input: z.output<I>,
  caller: CallerContext,
) => z.input<O> | Response | Promise<z.input<O> | Response>;
export interface RegisteredOperation {
  operation: Operation;
  handler: Handler<z.ZodType, z.ZodType>;
}

export class OperationRegistry {
  private entries: RegisteredOperation[] = [];
  private sealed = false;

  register<I extends z.ZodType, O extends z.ZodType>(
    operation: Operation<I, O>,
    handler: Handler<I, O>,
  ): void {
    if (this.sealed) throw new Error("Route registration is closed.");
    if (!Object.values(AccessPolicy).includes(operation.access))
      throw new Error("Every route must declare an access policy.");
    if (!Object.values(OperationLifetime).includes(operation.lifetime))
      throw new Error("Every route must declare a valid lifetime.");
    if (
      !operation.path.startsWith("/api/") ||
      /^\/api\/v\d+(\/|$)/.test(operation.path)
    )
      throw new Error("Routes require the unversioned /api prefix.");
    if (
      !Number.isFinite(operation.timeoutMs) ||
      operation.timeoutMs <= NO_TIMEOUT_MS
    )
      throw new Error("Every route requires a positive timeout.");
    if (
      operation.delivery &&
      (operation.access !== AccessPolicy.Delivery || operation.mutation)
    )
      throw new Error(
        "Delivery verification and deduplication belong to the Scheduler Service.",
      );
    if (operation.access === AccessPolicy.Delivery && !operation.delivery)
      throw new Error("A delivery requires the exact-byte adapter.");
    if (operation.mutation && operation.access === AccessPolicy.Public)
      throw new Error("A mutation requires a verified caller.");
    if (
      this.entries.some(
        ({ operation: entry }) =>
          entry.id === operation.id ||
          (entry.path.replace(/:[^/]+/g, ":") ===
            operation.path.replace(/:[^/]+/g, ":") &&
            entry.method === operation.method),
      )
    )
      throw new Error("Duplicate operation or route.");
    if (
      this.entries.some(
        ({ operation: entry }) =>
          entry.path === operation.path && entry.service !== operation.service,
      )
    )
      throw new Error(
        "All operations at one path must belong to the same service.",
      );
    this.entries.push({
      operation,
      handler: handler as Handler<z.ZodType, z.ZodType>,
    });
  }

  seal(stores: Readonly<Partial<Record<StoreName, unknown>>>): void {
    for (const { operation } of this.entries)
      if (!stores[operation.store])
        throw new Error(
          `Operation ${operation.id} declares unavailable store: ${operation.store}.`,
        );
    this.sealed = true;
  }
  healthcheck(): boolean {
    return this.sealed && this.entries.length > EMPTY_REGISTRY_SIZE;
  }
  all(): readonly RegisteredOperation[] {
    return this.entries;
  }
  get(id: string): RegisteredOperation {
    const entry = this.entries.find(({ operation }) => operation.id === id);
    if (!entry) throw new Error("Unknown operation.");
    return entry;
  }
}

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
  identity?: CallerIdentity;
  idempotencyKey?: string;
  context?: Context;
  traceparent?: string;
  tracestate?: string;
}
export type ServiceClient<T extends Record<string, Operation>> = {
  [K in keyof T]: (
    input: z.input<T[K]["input"]>,
    options?: ClientOptions,
  ) => Promise<
    OperationResult<
      T[K]["lifetime"] extends typeof OperationLifetime.Stream
        ? Response
        : z.output<T[K]["output"]>
    >
  >;
};
