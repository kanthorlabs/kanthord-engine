import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Context } from "../../kernel/context.ts";
import {
  ensureDirectory,
  FILE_NOT_FOUND,
  writePrivate,
} from "../../kernel/files.ts";
import { redactReason } from "../../kernel/probe.ts";
import { EnvironmentFailure } from "../../scheduler/contract.ts";
import { SpanStatus } from "../../tracking/contract.ts";
import { COMMAND_LIMIT_MS } from "./budget.ts";
import type { BaseHead } from "./environment-setup.ts";
import { EndReason, ExecutionStop } from "./execution-run.ts";
import {
  ChangeStatus,
  changedEntries,
  fileAtRevision,
  mergeBase,
  type ChangeEntry,
} from "./local-git.ts";
import {
  affectedBaseEnd,
  affectedEnd,
  affectedSpan,
  VerificationKind,
  type VerificationContext,
} from "./method-telemetry.ts";
import type { SpanRecorder } from "./telemetry.ts";
import {
  CommandEnd,
  infrastructureStop,
  runVerificationsWithOutput,
  VerificationClass,
  type CommandObserver,
  type CommandRun,
  type VerificationRun,
} from "./verification.ts";

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
const AFFECTED_DIRECTORY = "affected";
const CHANGES_FILE = "changes.json";
const REPORT_FILE = "report.json";
const BASE_REPORT_FILE = "base-report.json";
const CHANGES_VARIABLE = "KANTHORD_CHANGES";
const REPORT_VARIABLE = "KANTHORD_AFFECTED_REPORT";
const BASE_COMMIT_VARIABLE = "KANTHORD_BASE_COMMIT";
const EVIDENCE_VERSION = 1;
const NO_EXIT_ERROR = "the command ended without an exit code";
const NO_REPORT_ERROR = "the command wrote no report file";
const OVERSIZED_REPORT_ERROR = "the report is larger than the limit";
const NON_BLANK_MESSAGE = "must hold a nonblank character";

export const AFFECTED_SUBJECT = "Affected test results";

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
  gate_files: z
    .array(z.string().regex(NON_BLANK, NON_BLANK_MESSAGE))
    .max(LIST_MAX_ENTRIES)
    .default([]),
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

export function changedGateFiles(
  declaration: AffectedDeclaration,
  files: readonly ChangeEntry[],
): string[] {
  const changed = new Set(
    files.flatMap((entry) =>
      entry.previous_path === undefined
        ? [entry.path]
        : [entry.path, entry.previous_path],
    ),
  );
  return [...new Set(declaration.gate_files)]
    .filter((path) => changed.has(path))
    .sort();
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

type CommandResult = CommandRun["result"];

export interface BaseRunResult {
  commit: string;
  exit_code: number | null;
  failed: AffectedTestId[];
}

export interface AffectedRun {
  verdict: Exclude<AffectedVerdict, typeof AffectedVerdict.Absent>;
  binding_id: string;
  repository: string;
  base_commit: string;
  head_commit: string;
  declaration: AffectedDeclaration;
  changed: number;
  gate_files: string[];
  report: AffectedReport | null;
  failed: AffectedTestId[];
  promoted_flaky: AffectedTestId[];
  head: CommandResult;
  output: string;
  duration_ms: number;
  base_run: BaseRunResult | null;
  failure_text: string | null;
}

export type AffectedResult =
  { verdict: typeof AffectedVerdict.Absent } | AffectedRun;

export interface AffectedBudgetEnd {
  budgetEnd: true;
}

export interface AffectedCheckout {
  binding_id: string;
  name: string;
  directory: string;
  base_branch: string;
  head: string;
}

export interface AffectedInput {
  env: NodeJS.ProcessEnv;
  context: Context;
  deadline: number;
  exhausted: () => boolean;
  spans: SpanRecorder;
  scope:
    typeof VerificationContext.Release | typeof VerificationContext.Evaluation;
  workspaceKey: string;
  checkout: AffectedCheckout;
  digests: readonly string[];
  base: BaseHead;
  commandLimitMs?: number;
}

interface Prepared {
  declaration: AffectedDeclaration;
  files: readonly ChangeEntry[];
  mergeBase: string;
  directory: string;
  commandLimitMs: number;
}

interface Executed {
  run: VerificationRun;
  end: CommandEnd;
}

type Outcome = { report: AffectedReport } | { failure: HeadFailure };

function remaining(input: AffectedInput): number {
  return Math.max(ONE_ENTRY, input.deadline - Date.now());
}

function endTracker(reportPath: string) {
  let end: CommandEnd = CommandEnd.Cancelled;
  const observe: CommandObserver = async (_attempt, execute) => {
    rmSync(reportPath, { force: true });
    const ran = await execute();
    end = ran.end;
    return ran;
  };
  return { observe, end: () => end };
}

function readReport(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND) return null;
    throw error;
  }
}

function resultOf(run: VerificationRun, command: string): CommandResult {
  return (
    run.verification.results.at(-1) ?? {
      command,
      exit_code: null,
      signal: null,
      timed_out: false,
    }
  );
}

function outcomeOf(
  executed: Executed,
  reportPath: string,
  prepared: Prepared,
): Outcome | null {
  const { run, end } = executed;
  if (run.outcome === VerificationClass.BudgetEnd) return null;
  const stop = infrastructureStop(run);
  if (stop) throw stop;
  if (end === CommandEnd.CommandLimit)
    return {
      failure: {
        kind: HeadFailureKind.TimedOut,
        time_limit_s: prepared.commandLimitMs / MS_PER_SECOND,
      },
    };
  const { exit_code: exitCode } = resultOf(run, prepared.declaration.command);
  if (exitCode === EXIT_NOT_FOUND)
    return { failure: { kind: HeadFailureKind.NotFound } };
  if (exitCode === null)
    return {
      failure: { kind: HeadFailureKind.InvalidReport, error: NO_EXIT_ERROR },
    };
  const parsed = parseReport(readReport(reportPath), exitCode);
  return "report" in parsed
    ? { report: parsed.report }
    : {
        failure: { kind: HeadFailureKind.InvalidReport, error: parsed.error },
      };
}

function variablesOf(
  prepared: Prepared,
  reportFile: string,
): Record<string, string> {
  return {
    [CHANGES_VARIABLE]: join(prepared.directory, CHANGES_FILE),
    [REPORT_VARIABLE]: join(prepared.directory, reportFile),
    [BASE_COMMIT_VARIABLE]: prepared.mergeBase,
  };
}

async function runHead(
  input: AffectedInput,
  prepared: Prepared,
): Promise<Executed> {
  const tracker = endTracker(join(prepared.directory, REPORT_FILE));
  const run = await runVerificationsWithOutput({
    directory: input.checkout.directory,
    commands: [prepared.declaration.command],
    tested_input: {
      kind: "repository",
      binding_id: input.checkout.binding_id,
      commit: input.checkout.head,
    },
    deadline: input.deadline,
    context: input.context,
    env: input.env,
    exhausted: input.exhausted,
    variables: variablesOf(prepared, REPORT_FILE),
    commandLimitMs: prepared.commandLimitMs,
    observe: tracker.observe,
  });
  return { run, end: tracker.end() };
}

interface BaseCheck {
  commit: string;
  executed: Executed;
  outcome: Outcome;
}

async function runBase(
  input: AffectedInput,
  prepared: Prepared,
): Promise<BaseCheck | null> {
  const { checkout } = input;
  const command = prepared.declaration.command;
  const commit = await input.base.commitOf(checkout.name);
  const executed = await input.spans.within(
    affectedSpan(input.spans, {
      context: input.scope,
      kind: VerificationKind.AffectedBase,
      binding_id: checkout.binding_id,
      commit,
      digests: input.digests,
      command,
    }),
    async () => {
      const tracker = endTracker(join(prepared.directory, BASE_REPORT_FILE));
      const run = await input.base.runIn(checkout.name, {
        command,
        variables: variablesOf(prepared, BASE_REPORT_FILE),
        commandLimitMs: prepared.commandLimitMs,
        observe: tracker.observe,
      });
      return run === null ? null : { run, end: tracker.end() };
    },
    (ran) =>
      ran === null
        ? { status: SpanStatus.Error }
        : affectedBaseEnd(
            resultOf(ran.run, command),
            ran.run.outputs.at(-1) ?? "",
          ),
  );
  if (executed === null) return null;
  const outcome = outcomeOf(
    executed,
    join(prepared.directory, BASE_REPORT_FILE),
    prepared,
  );
  return outcome === null ? null : { commit, executed, outcome };
}

function baseStop(
  input: AffectedInput,
  prepared: Prepared,
  base: BaseCheck,
): ExecutionStop {
  assert.ok(!("report" in base.outcome));
  const { failure } = base.outcome;
  const detail = {
    binding_id: input.checkout.binding_id,
    commit: base.commit,
    command: prepared.declaration.command,
    exit_code: resultOf(base.executed.run, prepared.declaration.command)
      .exit_code,
  };
  if (failure.kind === HeadFailureKind.NotFound)
    return environmentStop(EnvironmentFailure.CommandAbsent, detail);
  if (failure.kind === HeadFailureKind.TimedOut)
    return environmentStop(EnvironmentFailure.AffectedTimeout, {
      ...detail,
      time_limit_s: failure.time_limit_s,
    });
  return environmentStop(EnvironmentFailure.AffectedInvalid, {
    ...detail,
    error: failure.error,
  });
}

function environmentStop(code: string, detail: object): ExecutionStop {
  return new ExecutionStop(
    EndReason.EnvironmentFailed,
    code,
    redactReason(JSON.stringify(detail)),
  );
}

function baseRunOf(base: BaseCheck, prepared: Prepared): BaseRunResult {
  return {
    commit: base.commit,
    exit_code: resultOf(base.executed.run, prepared.declaration.command)
      .exit_code,
    failed: "report" in base.outcome ? base.outcome.report.failed : [],
  };
}

function verdictOf(
  report: AffectedReport | null,
  failedIds: readonly AffectedTestId[],
  base: BaseCheck,
): AffectedRun["verdict"] {
  const red =
    report !== null &&
    "report" in base.outcome &&
    isBaseRed(failedIds, base.outcome.report);
  return red ? AffectedVerdict.BaseRed : AffectedVerdict.Failed;
}

function failureTextOf(
  input: AffectedInput,
  prepared: Prepared,
  head: Outcome,
  failedIds: readonly AffectedTestId[],
): string {
  const base = {
    repository: input.checkout.name,
    command: prepared.declaration.command,
    changed: prepared.files.length,
  };
  return affectedFailureText(
    "report" in head
      ? { ...base, tests: head.report.tests.length, failed: failedIds }
      : { ...base, reason: head.failure },
  );
}

async function decide(
  input: AffectedInput,
  prepared: Prepared,
): Promise<AffectedRun | AffectedBudgetEnd> {
  const { checkout } = input;
  const { declaration, files } = prepared;
  const started = Date.now();
  const executed = await runHead(input, prepared);
  const durationMs = Date.now() - started;
  const head = outcomeOf(
    executed,
    join(prepared.directory, REPORT_FILE),
    prepared,
  );
  if (head === null) return { budgetEnd: true };
  const report = "report" in head ? head.report : null;
  const failedIds = report ? headFailed(report, files) : [];
  const result: AffectedRun = {
    verdict: AffectedVerdict.Passed,
    binding_id: checkout.binding_id,
    repository: checkout.name,
    base_commit: prepared.mergeBase,
    head_commit: checkout.head,
    declaration,
    changed: files.length,
    gate_files: changedGateFiles(declaration, files),
    report,
    failed: failedIds,
    promoted_flaky: report ? promotedFlaky(report, files) : [],
    head: resultOf(executed.run, declaration.command),
    output: executed.run.outputs.at(-1) ?? "",
    duration_ms: durationMs,
    base_run: null,
    failure_text: null,
  };
  if (report && failedIds.length === EMPTY_LENGTH) return result;
  const base = await runBase(input, prepared);
  if (base === null) return { budgetEnd: true };
  if (!report && !("report" in base.outcome))
    throw baseStop(input, prepared, base);
  const verdict = verdictOf(report, failedIds, base);
  return {
    ...result,
    verdict,
    base_run: baseRunOf(base, prepared),
    failure_text:
      verdict === AffectedVerdict.Failed
        ? failureTextOf(input, prepared, head, failedIds)
        : null,
  };
}

async function declarationOf(
  input: AffectedInput,
): Promise<AffectedDeclaration | null> {
  const { checkout } = input;
  const declaration = await readDeclaration(
    input.env,
    checkout.directory,
    checkout.base_branch,
    input.context,
    remaining(input),
  );
  if (declaration === null || !("error" in declaration)) return declaration;
  throw environmentStop(EnvironmentFailure.AffectedInvalid, {
    binding_id: checkout.binding_id,
    commit: await input.base.commitOf(checkout.name),
    file: AFFECTED_DECLARATION_FILE,
    error: declaration.error,
  });
}

export async function runAffected(
  input: AffectedInput,
): Promise<AffectedResult | AffectedBudgetEnd> {
  const { checkout } = input;
  const declaration = await declarationOf(input);
  if (declaration === null) return { verdict: AffectedVerdict.Absent };
  const mergeBaseCommit = await mergeBase(
    input.env,
    checkout.directory,
    `${ORIGIN_PREFIX}${checkout.base_branch}`,
    checkout.head,
    input.context,
    remaining(input),
  );
  const files = await changedEntries(
    input.env,
    checkout.directory,
    mergeBaseCommit,
    checkout.head,
    input.context,
    remaining(input),
  );
  const directory = join(input.workspaceKey, AFFECTED_DIRECTORY, checkout.name);
  const prepared: Prepared = {
    declaration,
    files,
    mergeBase: mergeBaseCommit,
    directory,
    commandLimitMs:
      input.commandLimitMs ?? declaration.time_limit_s * MS_PER_SECOND,
  };
  try {
    ensureDirectory(directory);
    writePrivate(
      join(directory, CHANGES_FILE),
      JSON.stringify(
        changesDocumentOf({
          binding_id: checkout.binding_id,
          repository: checkout.name,
          base_commit: mergeBaseCommit,
          head_commit: checkout.head,
          files,
        }),
      ),
      true,
    );
    return await input.spans.within(
      affectedSpan(input.spans, {
        context: input.scope,
        kind: VerificationKind.Affected,
        binding_id: checkout.binding_id,
        commit: checkout.head,
        digests: input.digests,
        command: declaration.command,
      }),
      () => decide(input, prepared),
      (result) =>
        "budgetEnd" in result
          ? { status: SpanStatus.Error }
          : affectedEnd(result),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export interface AffectedEvidenceRepository {
  binding_id: string;
  repository: string;
  command: string;
  base_commit: string;
  head_commit: string;
  changed_files: number;
  verdict: AffectedRun["verdict"];
  exit_code: number | null;
  signal: string | null;
  duration_ms: number;
  report: AffectedReport | null;
  promoted_flaky: AffectedTestId[];
  base_run: BaseRunResult | null;
  output: string;
}

export interface AffectedEvidence {
  version: typeof EVIDENCE_VERSION;
  verdict: AffectedVerdict;
  repositories: AffectedEvidenceRepository[];
}

export function affectedEvidenceOf(
  results: readonly AffectedResult[],
): AffectedEvidence {
  return {
    version: EVIDENCE_VERSION,
    verdict: nodeVerdict(results.map((result) => result.verdict)),
    repositories: results.flatMap((result) =>
      result.verdict === AffectedVerdict.Absent
        ? []
        : [
            {
              binding_id: result.binding_id,
              repository: result.repository,
              command: result.declaration.command,
              base_commit: result.base_commit,
              head_commit: result.head_commit,
              changed_files: result.changed,
              verdict: result.verdict,
              exit_code: result.head.exit_code,
              signal: result.head.signal,
              duration_ms: result.duration_ms,
              report: result.report,
              promoted_flaky: result.promoted_flaky,
              base_run: result.base_run,
              output: result.output,
            },
          ],
    ),
  };
}
