import type { ZodType } from "zod";

import type { ErrorCode } from "./errors.ts";
import type { Segment } from "./path.ts";

export const methods = ["DELETE", "GET", "POST", "PUT"] as const;
export type Method = (typeof methods)[number];

export const introducedInValues = [
  "phase-1",
  "phase-2",
  "phase-3",
  "post-mvp",
] as const;
export type IntroducedIn = (typeof introducedInValues)[number];

export const statusValues = ["routed", "stubbed", "deferred"] as const;
export type OperationStatus = (typeof statusValues)[number];

export const idempotencyPolicies = ["none", "memory", "durable"] as const;
export type IdempotencyPolicy = (typeof idempotencyPolicies)[number];

export type OperationErrors = Partial<Record<ErrorCode, ZodType | null>>;

export type OperationExamples = Readonly<{
  query?: unknown;
  request?: unknown;
  success: unknown;
  error: unknown;
}>;

export type Operation = Readonly<{
  operationId: string;
  method: Method;
  path: readonly Segment[];
  introducedIn: IntroducedIn;
  status: "routed" | "stubbed";
  idempotency?: IdempotencyPolicy;
  replayable?: readonly number[];
  successStatus?: number;
  query?: ZodType;
  request?: ZodType;
  response?: ZodType;
  responseMedia?: string;
  errors?: OperationErrors;
  examples?: OperationExamples;
}>;

export function idempotencyOf(entry: Operation): IdempotencyPolicy {
  return entry.idempotency ?? "none";
}

export function operations(
  entries: readonly Operation[],
): readonly Operation[] {
  return entries;
}
