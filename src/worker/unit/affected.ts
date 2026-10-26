import { z } from "zod";
import type { Context } from "../../kernel/context.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import { ChangeStatus, fileAtRevision, type ChangeEntry } from "./local-git.ts";

export const AFFECTED_DECLARATION_FILE = ".kanthord/affected-tests.json";
export const AFFECTED_REPORT_MAX_BYTES = 1048576;
const MS_PER_SECOND = 1000;
const DECLARATION_VERSION = 1;
const REPORT_VERSION = 1;
const DEFAULT_TIME_LIMIT_S = COMMAND_LIMIT_MS / MS_PER_SECOND;
const MIN_TIME_LIMIT_S = 60;
const MAX_TIME_LIMIT_S = 3600;
const REASON_MAX_BYTES = 256;
const STRING_MAX_BYTES = 1024;
const LIST_MAX_ENTRIES = 10000;
const EXIT_SUCCESS = 0;
const EXIT_NOT_FOUND = 127;
const EMPTY_LENGTH = 0;
const ONE_ENTRY = 1;
const FAILED_ID_LIMIT = 20;
const NON_BLANK = /\S/;
const ID_SEPARATOR = " > ";
const LIST_SEPARATOR = "; ";
const ORIGIN_PREFIX = "origin/";
const NO_REPORT_ERROR = "the command wrote no report file";
const OVERSIZED_REPORT_ERROR = "the report is larger than the limit";
const NON_BLANK_MESSAGE = "must hold a nonblank character";

export const AffectedSelection = {
  Related: "related",
  All: "all",
  None: "none",
} as const;
export type AffectedSelection =
  (typeof AffectedSelection)[keyof typeof AffectedSelection];

export const AffectedVerdict = {
  Absent: "absent",
  Passed: "passed",
  Failed: "failed",
  BaseRed: "base_red",
} as const;
export type AffectedVerdict =
  (typeof AffectedVerdict)[keyof typeof AffectedVerdict];

export const HeadFailureKind = {
  InvalidReport: "invalid_report",
  TimedOut: "timed_out",
  NotFound: "not_found",
} as const;
export type HeadFailureKind =
  (typeof HeadFailureKind)[keyof typeof HeadFailureKind];

export const affectedDeclarationSchema = z.strictObject({
  version: z.literal(DECLARATION_VERSION),
  command: z.string().regex(NON_BLANK, NON_BLANK_MESSAGE),
  time_limit_s: z
    .number()
    .int()
    .min(MIN_TIME_LIMIT_S)
    .max(MAX_TIME_LIMIT_S)
    .default(DEFAULT_TIME_LIMIT_S),
});
export type AffectedDeclaration = z.output<typeof affectedDeclarationSchema>;

function boundedString(maxBytes: number) {
  return z.string().refine((value) => Buffer.byteLength(value) <= maxBytes, {
    message: `must hold at most ${maxBytes} bytes`,
  });
}

const testIdSchema = z.strictObject({
  file: boundedString(STRING_MAX_BYTES),
  name: boundedString(STRING_MAX_BYTES),
});
export type AffectedTestId = z.infer<typeof testIdSchema>;

export const affectedReportSchema = z
  .strictObject({
    version: z.literal(REPORT_VERSION),
    selection: z.enum(AffectedSelection),
    reason: boundedString(REASON_MAX_BYTES)
      .regex(NON_BLANK, NON_BLANK_MESSAGE)
      .nullable(),
    tests: z.array(boundedString(STRING_MAX_BYTES)).max(LIST_MAX_ENTRIES),
    failed: z.array(testIdSchema).max(LIST_MAX_ENTRIES),
    flaky: z.array(testIdSchema).max(LIST_MAX_ENTRIES),
    excluded_e2e: z
      .array(boundedString(STRING_MAX_BYTES))
      .max(LIST_MAX_ENTRIES),
  })
  .superRefine((report, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: "custom", path: [path], message });
    const needsReason = report.selection === AffectedSelection.All;
    if (needsReason !== (report.reason !== null))
      issue("reason", "is nonblank exactly for the selection all");
    if (
      report.selection === AffectedSelection.None &&
      report.tests.length > EMPTY_LENGTH
    )
      issue("tests", "is empty for the selection none");
    const selected = new Set(report.tests);
    for (const field of ["failed", "flaky"] as const)
      if (report[field].some((id) => !selected.has(id.file)))
        issue(field, "holds a file that is not in tests");
    const failedIds = new Set(report.failed.map(testIdText));
    if (report.flaky.some((id) => failedIds.has(testIdText(id))))
      issue("flaky", "holds an id of failed");
  });
export type AffectedReport = z.infer<typeof affectedReportSchema>;

export interface ChangesDocument {
  version: typeof DECLARATION_VERSION;
  binding_id: string;
  repository: string;
  base_commit: string;
  head_commit: string;
  files: ChangeEntry[];
}

export type HeadFailure =
  | { kind: typeof HeadFailureKind.InvalidReport; error: string }
  | { kind: typeof HeadFailureKind.TimedOut; time_limit_s: number }
  | { kind: typeof HeadFailureKind.NotFound };

interface FailureBase {
  repository: string;
  command: string;
  changed: number;
}

export type AffectedFailureInput = FailureBase &
  (
    | { tests: number; failed: readonly AffectedTestId[] }
    | { reason: HeadFailure }
  );

function issuesText(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".")} ${issue.message}`.trim())
    .join(LIST_SEPARATOR);
}

function jsonOf(text: string): { value: unknown } | { error: string } {
  try {
    return { value: JSON.parse(text) };
  } catch (error) {
    return {
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function parseDeclaration(
  text: string,
): { declaration: AffectedDeclaration } | { error: string } {
  const json = jsonOf(text);
  if ("error" in json) return json;
  const parsed = affectedDeclarationSchema.safeParse(json.value);
  if (!parsed.success)
    return { error: `invalid declaration: ${issuesText(parsed.error)}` };
  return { declaration: parsed.data };
}

export async function readDeclaration(
  env: NodeJS.ProcessEnv,
  directory: string,
  baseBranch: string,
  context: Context,
  deadlineMs: number,
): Promise<AffectedDeclaration | null | { error: string }> {
  const text = await fileAtRevision(
    env,
    directory,
    `${ORIGIN_PREFIX}${baseBranch}`,
    AFFECTED_DECLARATION_FILE,
    context,
    deadlineMs,
  );
  if (text === null) return null;
  const parsed = parseDeclaration(text);
  return "error" in parsed ? parsed : parsed.declaration;
}

export function changesDocumentOf(input: {
  binding_id: string;
  repository: string;
  base_commit: string;
  head_commit: string;
  files: readonly ChangeEntry[];
}): ChangesDocument {
  return {
    version: DECLARATION_VERSION,
    binding_id: input.binding_id,
    repository: input.repository,
    base_commit: input.base_commit,
    head_commit: input.head_commit,
    files: input.files.map((entry) =>
      entry.status === ChangeStatus.Renamed
        ? {
            path: entry.path,
            status: entry.status,
            previous_path: entry.previous_path!,
          }
        : { path: entry.path, status: entry.status },
    ),
  };
}

export function testIdText(id: AffectedTestId): string {
  return `${id.file}${ID_SEPARATOR}${id.name}`;
}

export function parseReport(
  text: string | null,
  exitCode: number,
): { report: AffectedReport } | { error: string } {
  if (text === null) return { error: NO_REPORT_ERROR };
  if (Buffer.byteLength(text) > AFFECTED_REPORT_MAX_BYTES)
    return { error: OVERSIZED_REPORT_ERROR };
  const json = jsonOf(text);
  if ("error" in json) return json;
  const parsed = affectedReportSchema.safeParse(json.value);
  if (!parsed.success)
    return { error: `invalid report: ${issuesText(parsed.error)}` };
  const hasFailed = parsed.data.failed.length > EMPTY_LENGTH;
  if (exitCode === EXIT_SUCCESS && hasFailed)
    return { error: "the command exited 0 but the report lists failed tests" };
  if (exitCode !== EXIT_SUCCESS && !hasFailed)
    return {
      error: `the command exited ${exitCode} but the report lists no failed test`,
    };
  return { report: parsed.data };
}

export function promotedFlaky(
  report: AffectedReport,
  files: readonly ChangeEntry[],
): AffectedTestId[] {
  const changed = new Set(files.map((entry) => entry.path));
  return report.flaky.filter((id) => changed.has(id.file));
}

export function headFailed(
  report: AffectedReport,
  files: readonly ChangeEntry[],
): AffectedTestId[] {
  return [...report.failed, ...promotedFlaky(report, files)];
}

export function isBaseRed(
  headFailedIds: readonly AffectedTestId[],
  baseReport: AffectedReport,
): boolean {
  const baseIds = new Set(baseReport.failed.map(testIdText));
  return headFailedIds.every((id) => baseIds.has(testIdText(id)));
}

export function nodeVerdict(
  verdicts: readonly AffectedVerdict[],
): AffectedVerdict {
  for (const verdict of [
    AffectedVerdict.Failed,
    AffectedVerdict.BaseRed,
    AffectedVerdict.Passed,
  ])
    if (verdicts.includes(verdict)) return verdict;
  return AffectedVerdict.Absent;
}

function reasonText(reason: HeadFailure): string {
  if (reason.kind === HeadFailureKind.InvalidReport)
    return `wrote no valid report: ${reason.error}`;
  if (reason.kind === HeadFailureKind.TimedOut)
    return `reached its time limit of ${reason.time_limit_s} s`;
  return `was not found (exit ${EXIT_NOT_FOUND})`;
}

function failedIdsText(failed: readonly AffectedTestId[]): string {
  const listed = failed.slice(0, FAILED_ID_LIMIT).map(testIdText);
  const rest = failed.length - listed.length;
  if (rest > EMPTY_LENGTH) listed.push(`and ${rest} more`);
  return listed.join(LIST_SEPARATOR);
}

export function affectedFailureText(input: AffectedFailureInput): string {
  const head = `The affected test run of repository ${input.repository} failed. KanthorD ran \`${input.command}\` for ${input.changed} changed files`;
  if ("reason" in input)
    return `${head}, and the command ${reasonText(input.reason)}. The same command gives a valid result on the base head, so the change of the node causes it. Change the code so that the command writes a valid report in time.`;
  const noun = input.failed.length === ONE_ENTRY ? "test" : "tests";
  return `${head}. The run selected ${input.tests} test files, and ${input.failed.length} ${noun} failed: ${failedIdsText(input.failed)}. Each selected test imports a changed file directly or through other files. Change the code or the test so that every selected test passes.`;
}
