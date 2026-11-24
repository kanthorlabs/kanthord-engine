import type { Api, Model } from "@earendil-works/pi-ai";
import { Diagnostic } from "../../kernel/errors.ts";

const OPTION_INVALID = "cli.run.agent.option_invalid";
const BUDGET_UNPRICED = "cli.run.agent.budget_unpriced";
const OPTION_BUDGET = "--budget";

const DURATION_PATTERN = /^([1-9][0-9]*)(s|m|h)$/;
const USD_PATTERN = /^[0-9]+(\.[0-9]{1,6})?usd$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60000,
  h: 3600000,
};
const DEFAULT_WALL_MS = 7200000;
const USD_SUFFIX_LEN = 3;
const ZERO_USD = 0;

export interface ParsedBudget {
  wallMs: number;
  usd: number | null;
}

export interface BudgetResultFields {
  wall_ms: number;
  usd: number | null;
  display: string;
}

function parseDuration(value: string): number | null {
  const match = DURATION_PATTERN.exec(value);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]!;
  return amount * UNIT_MS[unit]!;
}

function optionInvalid(): never {
  throw new Diagnostic(
    OPTION_INVALID,
    "run agent: --budget value is not a valid wall duration or cost amount.",
    { fields: [["option", OPTION_BUDGET]] },
  );
}

export function parseBudget(values: readonly string[]): ParsedBudget {
  let wallMs: number | null = null;
  let usd: number | null = null;
  for (const value of values) {
    if (USD_PATTERN.test(value)) {
      if (usd !== null)
        throw new Diagnostic(
          OPTION_INVALID,
          "run agent: --budget may not give the usd form more than once.",
          { fields: [["option", OPTION_BUDGET]] },
        );
      const amount = Number(value.slice(0, -USD_SUFFIX_LEN));
      if (amount === ZERO_USD) optionInvalid();
      usd = amount;
      continue;
    }
    const ms = parseDuration(value);
    if (ms === null) optionInvalid();
    if (wallMs !== null)
      throw new Diagnostic(
        OPTION_INVALID,
        "run agent: --budget may not give the wall form more than once.",
        { fields: [["option", OPTION_BUDGET]] },
      );
    wallMs = ms;
  }
  return { wallMs: wallMs ?? DEFAULT_WALL_MS, usd };
}

export function budgetResultFields(
  parsed: ParsedBudget,
  rawValues: readonly string[],
): BudgetResultFields {
  const wallRaw = rawValues.find((v) => DURATION_PATTERN.test(v));
  const usdRaw = rawValues.find((v) => USD_PATTERN.test(v));
  const wallDisplay =
    wallRaw === undefined ? "2h wall (default)" : `${wallRaw} wall`;
  const display =
    usdRaw === undefined ? wallDisplay : `${wallDisplay}, ${usdRaw}`;
  return { wall_ms: parsed.wallMs, usd: parsed.usd, display };
}

export function checkBudgetUnpriced(
  usd: number | null,
  cost: Model<Api>["cost"],
): void {
  if (usd === null) return;
  if (
    cost.input === ZERO_USD &&
    cost.output === ZERO_USD &&
    cost.cacheRead === ZERO_USD &&
    cost.cacheWrite === ZERO_USD
  ) {
    throw new Diagnostic(
      BUDGET_UNPRICED,
      "run agent: the resolved model has no price; a cost budget cannot be used.",
      { fields: [["option", OPTION_BUDGET]] },
    );
  }
}
