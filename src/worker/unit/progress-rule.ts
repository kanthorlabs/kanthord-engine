import assert from "node:assert/strict";
import { z } from "zod";
import type { Attributes } from "../../tracking/contract.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import type { Verification } from "./verification.ts";

export const NoProgressRule = {
  UnchangedRevision: "unchanged_revision",
  VerdictRuleHolds: "verdict_rule_holds",
} as const;
export type NoProgressRule =
  (typeof NoProgressRule)[keyof typeof NoProgressRule];

const countSchema = z.number().int().positive();
const noProgressFactsSchema = z.strictObject({
  rule: z.enum(NoProgressRule),
  count: countSchema,
  limit: countSchema,
  verification: z
    .strictObject({
      passed: z.boolean(),
      exit_codes: z.array(z.number().int().nullable()),
    })
    .nullable(),
});
export type NoProgressFacts = z.infer<typeof noProgressFactsSchema>;
export type VerificationFacts = NoProgressFacts["verification"];

export function verificationFactsOf(
  passed: boolean,
  verification: Verification,
): VerificationFacts {
  return {
    passed,
    exit_codes: verification.results.map((result) => result.exit_code),
  };
}

export function noProgressDetail(facts: NoProgressFacts): string {
  assert.ok(facts.count >= facts.limit);
  return JSON.stringify(noProgressFactsSchema.parse(facts));
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
    ...(facts.verification === null
      ? {}
      : { "kanthord.stop.verification.passed": facts.verification.passed }),
  };
}
