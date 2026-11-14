import { z } from "zod";
import { CodedError } from "../kernel/errors.ts";

export const PASS_RATE_THRESHOLD = 2 / 3;

const nonnegativeNumber = z.number().nonnegative();
const rateSchema = z.number().min(0).max(1);

const promptDigestSchema = z.strictObject({
  layer: z.number().int().nullable(),
  source: z.string(),
  digest: z.string(),
});

const runCheckSchema = z.strictObject({
  kind: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});

const historyCheckSchema = z.strictObject({
  kind: z.string(),
  passed: z.boolean(),
});

const comparisonSchema = z.strictObject({
  baseline_run: z.string().nullable(),
  regressed: z.array(z.string()),
  improved: z.array(z.string()),
  new: z.array(z.string()),
  dropped: z.array(z.string()),
  tokens_delta: z.number(),
  cost_delta: z.number(),
});
export type Comparison = z.infer<typeof comparisonSchema>;

function runSchemaOf<Check extends z.ZodType>(check: Check) {
  const resultSchema = z.strictObject({
    passed: z.boolean(),
    checks: z.array(check),
    input_tokens: nonnegativeNumber,
    output_tokens: nonnegativeNumber,
    cost: nonnegativeNumber,
    duration_ms: nonnegativeNumber,
  });
  return z.strictObject({
    run: z.string(),
    subject: z.string(),
    engine_revision: z.string(),
    configuration: z.record(z.string(), z.string()),
    prompt_digests: z.array(promptDigestSchema),
    repeat: z.int().positive(),
    comparison: comparisonSchema,
    cases: z.array(
      z.strictObject({
        case_id: z.string(),
        case_digest: z.string(),
        pass_rate: rateSchema,
        rerun_pass_rate: rateSchema.nullable(),
        runs: z.array(resultSchema),
        reruns: z.array(resultSchema),
      }),
    ),
  });
}

export const evalRunSchema = runSchemaOf(runCheckSchema);
export type EvalRun = z.infer<typeof evalRunSchema>;
export type RunResult = EvalRun["cases"][number]["runs"][number];

export const historyEntrySchema = runSchemaOf(historyCheckSchema);
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export const historySchema = z.array(historyEntrySchema);

type CaseRates = Pick<
  EvalRun["cases"][number],
  "pass_rate" | "rerun_pass_rate"
>;

interface Spend {
  input_tokens: number;
  output_tokens: number;
  cost: number;
}

interface SpendCase {
  runs: readonly Spend[];
  reruns: readonly Spend[];
}

export function passRateOf(
  results: readonly Pick<RunResult, "passed">[],
  repeat: number,
): number {
  return results.filter((result) => result.passed).length / repeat;
}

export function casePassed(value: CaseRates): boolean {
  return (
    value.pass_rate >= PASS_RATE_THRESHOLD ||
    (value.rerun_pass_rate !== null &&
      value.rerun_pass_rate >= PASS_RATE_THRESHOLD)
  );
}

function spendOf(value: SpendCase): { tokens: number; cost: number } {
  const results = [...value.runs, ...value.reruns];
  return {
    tokens: results.reduce(
      (sum, result) => sum + result.input_tokens + result.output_tokens,
      0,
    ),
    cost: results.reduce((sum, result) => sum + result.cost, 0),
  };
}

export function compare(
  run: Pick<EvalRun, "cases">,
  history: readonly HistoryEntry[],
): Comparison {
  const baseline = history.at(-1);
  const comparison: Comparison = {
    baseline_run: baseline?.run ?? null,
    regressed: [],
    improved: [],
    new: [],
    dropped: [],
    tokens_delta: 0,
    cost_delta: 0,
  };
  const before = new Map(
    (baseline?.cases ?? []).map((value) => [value.case_digest, value]),
  );
  const current = new Set(run.cases.map((value) => value.case_digest));
  for (const value of run.cases) {
    const previous = before.get(value.case_digest);
    if (!previous) {
      comparison.new.push(value.case_id);
      continue;
    }
    const passedBefore = casePassed(previous);
    const passedNow = casePassed(value);
    if (passedBefore && !passedNow) comparison.regressed.push(value.case_id);
    if (!passedBefore && passedNow) comparison.improved.push(value.case_id);
    const now = spendOf(value);
    const then = spendOf(previous);
    comparison.tokens_delta += now.tokens - then.tokens;
    comparison.cost_delta += now.cost - then.cost;
  }
  comparison.dropped = [...before.values()]
    .filter((value) => !current.has(value.case_digest))
    .map((value) => value.case_id);
  return comparison;
}

export function mergeReruns(
  run: EvalRun,
  reruns: Readonly<Record<string, RunResult[]>>,
): EvalRun {
  const known = new Set(run.cases.map((value) => value.case_id));
  const unknown = Object.keys(reruns).filter((id) => !known.has(id));
  if (unknown.length)
    throw new CodedError(
      "eval.compare.unknown_case",
      `The run holds no case to rerun: ${unknown.join(", ")}.`,
    );
  return {
    ...run,
    cases: run.cases.map((value) => {
      const results = reruns[value.case_id];
      if (!results) return value;
      return {
        ...value,
        reruns: results,
        rerun_pass_rate: passRateOf(results, run.repeat),
      };
    }),
  };
}

function historyResultOf(
  result: RunResult,
): HistoryEntry["cases"][number]["runs"][number] {
  return {
    ...result,
    checks: result.checks.map(({ kind, passed }) => ({ kind, passed })),
  };
}

export function historyEntryOf(run: EvalRun): HistoryEntry {
  return {
    ...run,
    cases: run.cases.map((value) => ({
      ...value,
      runs: value.runs.map(historyResultOf),
      reruns: value.reruns.map(historyResultOf),
    })),
  };
}
