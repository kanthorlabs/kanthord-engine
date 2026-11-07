import assert from "node:assert/strict";
import { z } from "zod";
import type { Attributes } from "../../tracking/contract.ts";
import { STOP_DETAIL_MAX_LENGTH } from "../../scheduler/contract.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import type { Verification } from "./verification.ts";

export const NoProgressRule = {
  UnchangedRevision: "unchanged_revision",
  VerdictRuleUnmet: "verdict_rule_unmet",
} as const;
export type NoProgressRule =
  (typeof NoProgressRule)[keyof typeof NoProgressRule];

const COMMAND_MAX_LENGTH = 2048;
const NO_OVERFLOW = 0;
const countSchema = z.number().int().positive();
const noProgressFactsSchema = z.strictObject({
  rule: z.enum(NoProgressRule),
  count: countSchema,
  limit: countSchema,
  verification: z
    .strictObject({
      passed: z.boolean(),
      ran: z.number().int().nonnegative(),
      index: z.number().int().nonnegative().nullable(),
      command: z.string().max(COMMAND_MAX_LENGTH).nullable(),
      limit_ms: countSchema,
      exit_code: z.number().int().nullable(),
      timed_out: z.boolean(),
    })
    .nullable(),
});
export type NoProgressFacts = z.infer<typeof noProgressFactsSchema>;
export type VerificationFacts = NoProgressFacts["verification"];

export function verificationFactsOf(
  passed: boolean,
  verification: Verification,
): VerificationFacts {
  const last = verification.results.at(-1);
  return {
    passed,
    ran: verification.results.length,
    index: last === undefined ? null : verification.results.length - 1,
    command: last?.command.slice(0, COMMAND_MAX_LENGTH) ?? null,
    limit_ms: COMMAND_LIMIT_MS,
    exit_code: last?.exit_code ?? null,
    timed_out: last?.timed_out ?? false,
  };
}

function fitted(facts: NoProgressFacts): NoProgressFacts {
  const { verification } = facts;
  const overflow = JSON.stringify(facts).length - STOP_DETAIL_MAX_LENGTH;
  if (overflow <= NO_OVERFLOW || verification === null) return facts;
  if (verification.command === null) return facts;
  const kept = Math.max(NO_OVERFLOW, verification.command.length - overflow);
  return {
    ...facts,
    verification: {
      ...verification,
      command: verification.command.slice(NO_OVERFLOW, kept),
    },
  };
}

export function noProgressDetail(facts: NoProgressFacts): string {
  assert.ok(facts.count >= facts.limit);
  const detail = JSON.stringify(fitted(noProgressFactsSchema.parse(facts)));
  assert.ok(detail.length <= STOP_DETAIL_MAX_LENGTH);
  return detail;
}

function factsOf(detail: string): NoProgressFacts | null {
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return null;
  }
  const parsed = noProgressFactsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function verificationAttributes(verification: VerificationFacts): Attributes {
  if (verification === null) return {};
  return {
    "kanthord.stop.verification.passed": verification.passed,
    "kanthord.stop.verification.timed_out": verification.timed_out,
    ...(verification.index === null
      ? {}
      : { "kanthord.stop.verification.index": verification.index }),
    ...(verification.exit_code === null
      ? {}
      : { "kanthord.stop.verification.exit_code": verification.exit_code }),
  };
}

export function noProgressAttributes(error: unknown): Attributes {
  if (
    !(error instanceof ExecutionStop) ||
    error.reason !== EndReason.NoProgress ||
    error.detail === null
  )
    return {};
  const facts = factsOf(error.detail);
  if (facts === null) return {};
  return {
    "kanthord.stop.reason": error.reason,
    "kanthord.stop.rule": facts.rule,
    "kanthord.stop.count": facts.count,
    "kanthord.stop.limit": facts.limit,
    ...verificationAttributes(facts.verification),
  };
}
