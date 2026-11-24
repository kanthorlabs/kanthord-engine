import { digest } from "../../kernel/json.ts";
import type { ParsedBudget } from "./run-agent-budget.ts";

export interface BudgetDigestField {
  wall_ms: number;
  usd: null | number;
}

export interface DigestInput {
  prompt: readonly string[];
  system_prompt: readonly string[];
  provider: string;
  model: string;
  reasoning_effort: string;
  budget: BudgetDigestField;
}

export function inputDigest(input: DigestInput): string {
  return digest({
    prompt: input.prompt,
    system_prompt: input.system_prompt,
    provider: input.provider,
    model: input.model,
    reasoning_effort: input.reasoning_effort,
    budget: input.budget,
  });
}

export function budgetDigestField(parsed: ParsedBudget): BudgetDigestField {
  return {
    wall_ms: parsed.wallMs,
    usd: parsed.usd,
  };
}
