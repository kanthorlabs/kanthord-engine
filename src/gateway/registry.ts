import { z } from "zod";
import type { CallerIdentity } from "./authentication.ts";
import type { Transaction } from "../store.ts";
import type { Context } from "../context.ts";
import { emitOpenAPI, validateOpenAPIScope } from "./openapi.ts";
import type { HttpMethod } from "../shared/http.ts";
import { AccessPolicy, OperationInteraction } from "./constants.ts";

export type { AccessPolicy } from "./constants.ts";
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
  input: I;
  output: O;
  status: number;
  body?: boolean;
  secret?: boolean;
  requiresRegistration?: boolean;
  maxBodyBytes?: number;
  replayGuard?: (recorded: unknown, identity: CallerIdentity) => boolean;
  interaction?: OperationInteraction;
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
  /** Commit a database mutation and its validated replay answer together. */
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
    validateOpenAPIScope(operation);
    if (!Object.values(AccessPolicy).includes(operation.access))
      throw new Error("Every route must declare an access policy.");
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
      operation.interaction === OperationInteraction.Delivery &&
      (operation.access !== AccessPolicy.Delivery || operation.mutation)
    )
      throw new Error(
        "Delivery verification and deduplication belong to the Scheduler Service.",
      );
    if (
      operation.access === AccessPolicy.Delivery &&
      operation.interaction !== OperationInteraction.Delivery
    )
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

  seal(): void {
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

  openapi() {
    return emitOpenAPI(this.entries.map(({ operation }) => operation));
  }
}
