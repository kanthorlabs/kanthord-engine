import { Diagnostic } from "../../kernel/errors.ts";

const OPTION_INVALID = "cli.run.agent.option_invalid";
const OPTION_BUDGET = "--budget";

const DURATION_PATTERN = /^([1-9][0-9]*)(s|m|h)$/;
const USD_PATTERN = /^[0-9]+(\.[0-9]+)?usd$/;
const UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60000,
  h: 3600000,
};
const DEFAULT_WALL_MS = 7200000;

export interface ParsedBudget {
  wallMs: number;
  usdText: string | null;
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
  const usdText = null;
  for (const value of values) {
    if (USD_PATTERN.test(value)) {
      throw new Diagnostic(
        OPTION_INVALID,
        "run agent: a cost budget is not supported in this version.",
        { fields: [["option", OPTION_BUDGET]] },
      );
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
  return { wallMs: wallMs ?? DEFAULT_WALL_MS, usdText };
}

export function budgetResultFields(
  parsed: ParsedBudget,
  rawValues: readonly string[],
): {
  wall_ms: number;
  usd: null;
  display: string;
} {
  const isDefault =
    !rawValues.length || !rawValues.some((v) => DURATION_PATTERN.test(v));
  const display = isDefault
    ? "2h wall (default)"
    : `${rawValues.find((v) => DURATION_PATTERN.test(v))!} wall`;
  return { wall_ms: parsed.wallMs, usd: null, display };
}
