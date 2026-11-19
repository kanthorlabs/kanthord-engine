import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { identitySchema } from "../../kernel/identity.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { OutputFile, STATE_DIRECTORY } from "./tasks-output.ts";
import { tasksDiagnostic, TasksErrorCode } from "./tasks-seed.ts";
import { CHECKOUTS_DIRECTORY } from "./workspace-layout.ts";
import {
  COMMIT_ID_PATTERN,
  commitLog,
  type CommitRange,
  RunEndKind,
} from "./tasks-verify.ts";

export const CompareSection = {
  Route: "route",
  End: "end",
  Commits: "commits",
  Units: "units",
  Metrics: "metrics",
} as const;
export type CompareSection =
  (typeof CompareSection)[keyof typeof CompareSection];

export interface SectionDifference {
  section: CompareSection;
  a: unknown;
  b: unknown;
}

export interface RunComparison {
  seed_digest: string;
  differences: SectionDifference[];
}

export interface CompareInput {
  outputs: readonly [string, string];
  env: NodeJS.ProcessEnv;
}

const commitIdSchema = z.string().regex(COMMIT_ID_PATTERN);
const headsSchema = z.record(identitySchema("binding"), commitIdSchema);
const checkoutSchema = z.object({
  binding_id: identitySchema("binding"),
  name: z.string().min(1),
});
const resultFileSchema = z.strictObject({
  end: z.enum(RunEndKind),
  exit_code: z.number().int(),
  stop: z.unknown(),
  step: z.string().nullable(),
  mode: z.string(),
  provider_id: z.string(),
  overrides: z.unknown(),
  seed_digest: z.string().min(1),
  checks: z.unknown(),
  code: z.string().optional(),
  fields: z.unknown().optional(),
});
const contextFileSchema = z.strictObject({
  input: z
    .object({ checkouts: z.array(checkoutSchema), heads: headsSchema })
    .nullable(),
  result: z
    .object({
      heads: headsSchema,
      route: z.unknown(),
      currentUnit: z.object({ id: z.string() }).nullable(),
      completedUnits: z.array(z.string()),
    })
    .nullable(),
});
type CheckoutRecord = z.infer<typeof checkoutSchema>;

interface RunRecord {
  folder: string;
  option: string;
  result: z.infer<typeof resultFileSchema>;
  context: z.infer<typeof contextFileSchema>;
  metrics: unknown;
}

const COMMIT_SEPARATOR = "\0";
const FIELD_SEPARATOR = "\n";
const OPTIONS = ["<output-a>", "<output-b>"] as const;

function folderInvalid(option: string, message: string) {
  return tasksDiagnostic(
    TasksErrorCode.OptionInvalid,
    `worker tasks compare: ${message}`,
    [["option", option]],
  );
}

function readRecord(folder: string, option: string): RunRecord {
  const read = (name: string): unknown =>
    JSON.parse(readFileSync(join(folder, name), "utf8"));
  try {
    return {
      folder,
      option,
      result: resultFileSchema.parse(read(OutputFile.Result)),
      context: contextFileSchema.parse(read(OutputFile.Context)),
      metrics: read(OutputFile.Metrics),
    };
  } catch {
    throw folderInvalid(option, "the folder holds no valid run output.");
  }
}

function checkoutDirectory(folder: string, name: string): string | null {
  const root = resolve(folder, STATE_DIRECTORY, CHECKOUTS_DIRECTORY);
  const directory = resolve(root, name);
  return directory.startsWith(`${root}${sep}`) ? directory : null;
}

interface CheckoutRange {
  directory: string;
  range: CommitRange;
}

function rangeOf(
  record: RunRecord,
  checkout: CheckoutRecord,
): CheckoutRange | null {
  const { input, result } = record.context;
  const from = input?.heads[checkout.binding_id];
  const to = result?.heads[checkout.binding_id];
  const directory = checkoutDirectory(record.folder, checkout.name);
  if (from === undefined || to === undefined || directory === null) return null;
  return { directory, range: { from, to } };
}

async function logOf(
  record: RunRecord,
  checkoutRange: CheckoutRange,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    return await commitLog(checkoutRange.directory, checkoutRange.range, env);
  } catch {
    throw folderInvalid(record.option, "a checkout holds no commit range.");
  }
}

function commitNames(log: string): string[] {
  return log
    .split(COMMIT_SEPARATOR)
    .filter(Boolean)
    .map((entry) => entry.split(FIELD_SEPARATOR).slice(1).join(FIELD_SEPARATOR))
    .reverse();
}

async function commitsOf(
  record: RunRecord,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string[]>> {
  const commits: Record<string, string[]> = {};
  for (const checkout of record.context.input?.checkouts ?? []) {
    const checkoutRange = rangeOf(record, checkout);
    if (checkoutRange === null) continue;
    commits[checkout.binding_id] = commitNames(
      await logOf(record, checkoutRange, env),
    );
  }
  return commits;
}

function endOf(record: RunRecord): unknown {
  const { end, exit_code, stop, step } = record.result;
  return { end, exit_code, stop, step };
}

function unitsOf(record: RunRecord): unknown {
  const result = record.context.result;
  return {
    completed: [...(result?.completedUnits ?? [])].sort(),
    current: result?.currentUnit?.id ?? null,
  };
}

async function sectionsOf(
  record: RunRecord,
  env: NodeJS.ProcessEnv,
): Promise<Record<CompareSection, unknown>> {
  return {
    [CompareSection.Route]: record.context.result?.route ?? null,
    [CompareSection.End]: endOf(record),
    [CompareSection.Commits]: await commitsOf(record, env),
    [CompareSection.Units]: unitsOf(record),
    [CompareSection.Metrics]: record.metrics,
  };
}

export async function compareRuns(input: CompareInput): Promise<RunComparison> {
  const [first, second] = input.outputs.map((folder, index) =>
    readRecord(folder, OPTIONS[index]!),
  ) as [RunRecord, RunRecord];
  const digest = first.result.seed_digest;
  if (digest !== second.result.seed_digest)
    throw tasksDiagnostic(
      TasksErrorCode.SeedMismatch,
      "worker tasks compare: the two runs have different seed digests.",
    );
  const a = await sectionsOf(first, input.env);
  const b = await sectionsOf(second, input.env);
  return {
    seed_digest: digest,
    differences: Object.values(CompareSection)
      .filter(
        (section) => canonicalJSON(a[section]) !== canonicalJSON(b[section]),
      )
      .map((section) => ({ section, a: a[section], b: b[section] })),
  };
}
