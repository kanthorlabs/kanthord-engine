import type { ZodType } from "zod";

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

export type Operation = Readonly<{
  operationId: string;
  method: Method;
  path: readonly Segment[];
  introducedIn: IntroducedIn;
  status: "routed" | "stubbed";
  successStatus?: number;
  request?: ZodType;
  response?: ZodType;
}>;

export function operations(
  entries: readonly Operation[],
): readonly Operation[] {
  return entries;
}
