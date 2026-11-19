import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { canonicalJSON } from "../../kernel/json.ts";
import { isString } from "../../kernel/values.ts";
import { OutputFile, STATE_DIRECTORY } from "./tasks-output.ts";
import { tasksDiagnostic, TasksErrorCode } from "./tasks-seed.ts";
import { CHECKOUTS_DIRECTORY } from "./workspace-layout.ts";
import { commitLog } from "./tasks-verify.ts";

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

interface CheckoutRecord {
  binding_id: string;
  name: string;
}

interface RunRecord {
  result: Record<string, unknown>;
  context: {
    input?: {
      checkouts?: CheckoutRecord[];
      heads?: Record<string, string>;
    };
    result?: {
      heads?: Record<string, string>;
      route?: unknown;
      currentUnit?: { id?: string } | null;
      completedUnits?: string[];
    } | null;
  };
  metrics: unknown;
}

const COMMIT_SEPARATOR = "\0";
const FIELD_SEPARATOR = "\n";
const OPTIONS = ["<output-a>", "<output-b>"] as const;

function readRecord(folder: string, option: string): RunRecord {
  const read = (name: string) =>
    JSON.parse(readFileSync(join(folder, name), "utf8")) as never;
  try {
    return {
      result: read(OutputFile.Result),
      context: read(OutputFile.Context),
      metrics: read(OutputFile.Metrics),
    };
  } catch {
    throw tasksDiagnostic(
      TasksErrorCode.OptionInvalid,
      "worker tasks compare: the folder holds no run output.",
      [["option", option]],
    );
  }
}

function checkoutDirectory(folder: string, name: string): string | null {
  const root = resolve(folder, STATE_DIRECTORY, CHECKOUTS_DIRECTORY);
  const directory = resolve(root, name);
  return directory.startsWith(`${root}${sep}`) ? directory : null;
}

interface CommitRange {
  directory: string;
  range: string;
}

function rangeOf(
  folder: string,
  record: RunRecord,
  checkout: CheckoutRecord,
): CommitRange | null {
  const { input, result } = record.context;
  const start = input?.heads?.[checkout.binding_id];
  const end = result?.heads?.[checkout.binding_id];
  const directory = checkoutDirectory(folder, checkout.name);
  if (start === undefined || end === undefined || directory === null)
    return null;
  return { directory, range: `${start}..${end}` };
}

function commitNames(log: string): string[] {
  return log
    .split(COMMIT_SEPARATOR)
    .filter(Boolean)
    .map((entry) => entry.split(FIELD_SEPARATOR).slice(1).join(FIELD_SEPARATOR))
    .reverse();
}

async function commitsOf(
  folder: string,
  record: RunRecord,
  env: NodeJS.ProcessEnv,
): Promise<Record<string, string[]>> {
  const commits: Record<string, string[]> = {};
  for (const checkout of record.context.input?.checkouts ?? []) {
    const commitRange = rangeOf(folder, record, checkout);
    if (commitRange === null) continue;
    commits[checkout.binding_id] = commitNames(
      await commitLog(commitRange.directory, commitRange.range, env),
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
  folder: string,
  record: RunRecord,
  env: NodeJS.ProcessEnv,
): Promise<Record<CompareSection, unknown>> {
  return {
    [CompareSection.Route]: record.context.result?.route ?? null,
    [CompareSection.End]: endOf(record),
    [CompareSection.Commits]: await commitsOf(folder, record, env),
    [CompareSection.Units]: unitsOf(record),
    [CompareSection.Metrics]: record.metrics,
  };
}

export async function compareRuns(input: CompareInput): Promise<RunComparison> {
  const [first, second] = input.outputs.map((folder, index) =>
    readRecord(folder, OPTIONS[index]!),
  ) as [RunRecord, RunRecord];
  const digest = first.result.seed_digest;
  if (!isString(digest) || digest !== second.result.seed_digest)
    throw tasksDiagnostic(
      TasksErrorCode.SeedMismatch,
      "worker tasks compare: the two runs have different seed digests.",
    );
  const a = await sectionsOf(input.outputs[0], first, input.env);
  const b = await sectionsOf(input.outputs[1], second, input.env);
  return {
    seed_digest: digest,
    differences: Object.values(CompareSection)
      .filter(
        (section) => canonicalJSON(a[section]) !== canonicalJSON(b[section]),
      )
      .map((section) => ({ section, a: a[section], b: b[section] })),
  };
}
