import assert from "node:assert/strict";
import { z } from "zod";
import {
  type Finding,
  FINDING_MAX,
  FINDING_TEXT_MAX_BYTES,
  FindingAction,
  findingActionSchema,
  FindingGround,
  findingGroundSchema,
  FindingKind,
  REVIEWER_FINDING_LABEL_PATTERN,
  type TaskContent,
} from "../../mission/contract.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import type {
  FlakyFailure,
  Verification,
  VerificationRun,
} from "./verification.ts";
import {
  type AffectedResult,
  type AffectedRun,
  AffectedVerdict,
} from "./affected.ts";
import type { ChangeRequestRead, FailedChecks } from "../contract.ts";
import type { NativeAgent } from "./native-agent.ts";
import { PromptTemplate, type PromptTemplates } from "../../agent/contract.ts";
import { renderTemplate } from "../../agent/prompt-templates.ts";

export const JUDGEMENT_MARKER = "kanthord-judgement:";
const SUCCESS_EXIT = 0;
const NO_ITEMS = 0;
const MIN_VERIFICATIONS = 1;
const FIRST_ENTRY = 0;
const RATIONALE_SEPARATOR = "\n\n";
const ISSUE_PATH_SEPARATOR = ".";
const BLOCKER_LABEL_PREFIX = "B";
const SUGGESTION_LABEL_PREFIX = "S";
const FLAKY_FINDING_NAME = "Flaky verification";
const UTF8_CONTINUATION_MASK = 0xc0;
const UTF8_CONTINUATION = 0x80;
export const REQUESTED_CHANGES_MAX_BYTES = 4096;
const AssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const UnmetGround = FindingGround;
export const unmetGroundSchema = findingGroundSchema;
export type UnmetGround = FindingGround;
const findingTextSchema = z
  .string()
  .trim()
  .min(1)
  .refine((text) => Buffer.byteLength(text, "utf8") <= FINDING_TEXT_MAX_BYTES, {
    message: `A finding text holds at most ${FINDING_TEXT_MAX_BYTES} bytes`,
  });
const judgementFindingSchema = z.strictObject({
  label: z.string().regex(REVIEWER_FINDING_LABEL_PATTERN),
  action: findingActionSchema,
  task_id: z.string().nullable(),
  ground: findingGroundSchema.nullable(),
  name: findingTextSchema,
  description: findingTextSchema,
  fix: findingTextSchema,
  why: findingTextSchema,
});
export type JudgementFinding = z.infer<typeof judgementFindingSchema>;
const proposalTextSchema = z.string().trim().min(1);
const proposalSchema = z.strictObject({
  dependency_id: proposalTextSchema,
  name: proposalTextSchema,
  requirement: proposalTextSchema,
  criterion: proposalTextSchema,
  task: z.strictObject({
    name: proposalTextSchema,
    requirement: proposalTextSchema,
    criterion: proposalTextSchema,
    verifications: z.array(proposalTextSchema).min(MIN_VERIFICATIONS),
  }),
});

function isBlockerLabel(label: string): boolean {
  return label.startsWith(BLOCKER_LABEL_PREFIX);
}

export interface JudgementContext {
  priorIds: readonly string[];
  priorBlockerIds: readonly string[];
  taskIds: readonly string[];
}

export function evaluationJudgementSchemaOf(context: JudgementContext) {
  const priorIds = new Set(context.priorIds);
  const taskIds = new Set(context.taskIds);
  return z
    .strictObject({
      result: z.enum(AssessmentResult),
      rationale: z.string().trim().min(1),
      findings: z.array(judgementFindingSchema).max(FINDING_MAX).default([]),
      fixed_finding_ids: z.array(z.string()).default([]),
      proposals: z.array(proposalSchema).default([]),
    })
    .superRefine((judgement, issues) => {
      const fail = (path: (string | number)[], message: string) =>
        issues.addIssue({ code: "custom", path, message });
      const labels = new Set<string>();
      judgement.findings.forEach((finding, index) => {
        if (labels.has(finding.label))
          fail(["findings", index, "label"], "A finding label is unique");
        labels.add(finding.label);
        if (isBlockerLabel(finding.label)) {
          if (finding.action !== FindingAction.Yes)
            fail(["findings", index, "action"], "A blocker holds action yes");
          if (finding.ground === null)
            fail(["findings", index, "ground"], "A blocker holds a ground");
        } else if (finding.ground !== null)
          fail(["findings", index, "ground"], "A suggestion holds ground null");
        if (finding.task_id !== null && !taskIds.has(finding.task_id))
          fail(
            ["findings", index, "task_id"],
            "task_id is null or a task id of the work prompt",
          );
      });
      const listed = new Set<string>();
      judgement.fixed_finding_ids.forEach((id, index) => {
        if (!priorIds.has(id))
          fail(["fixed_finding_ids", index], "An id names a prior finding");
        if (listed.has(id))
          fail(["fixed_finding_ids", index], "An id appears once");
        listed.add(id);
      });
      const blockers =
        judgement.findings.some((finding) => isBlockerLabel(finding.label)) ||
        context.priorBlockerIds.some((id) => !listed.has(id));
      if (judgement.result === AssessmentResult.Success) {
        if (judgement.findings.some((finding) => isBlockerLabel(finding.label)))
          fail(["findings"], "success holds no blocker");
        if (context.priorBlockerIds.some((id) => !listed.has(id)))
          fail(
            ["fixed_finding_ids"],
            "success lists each prior blocker in fixed_finding_ids",
          );
      }
      if (
        judgement.result === AssessmentResult.CriterionNotMet &&
        !blockers &&
        judgement.proposals.length === NO_ITEMS
      )
        fail(["findings"], "criterion-not-met holds a blocker or a proposal");
    });
}

export type EvaluationJudgement = z.output<
  ReturnType<typeof evaluationJudgementSchemaOf>
>;

export interface Blocker {
  id: string;
  reason: string;
  ground: UnmetGround;
}

export function judgementBlockers(
  nodeId: string,
  judgement: Pick<EvaluationJudgement, "findings" | "fixed_finding_ids">,
  prior: readonly Finding[],
): Blocker[] {
  const listed = new Set(judgement.fixed_finding_ids);
  const blockerOf = (finding: {
    task_id: string | null;
    description: string;
    ground: UnmetGround | null;
  }): Blocker => {
    assert.ok(finding.ground !== null);
    return {
      id: finding.task_id ?? nodeId,
      reason: finding.description,
      ground: finding.ground,
    };
  };
  return [
    ...judgement.findings
      .filter((finding) => isBlockerLabel(finding.label))
      .map(blockerOf),
    ...prior
      .filter(
        (finding) =>
          finding.kind === FindingKind.Blocker && !listed.has(finding.id),
      )
      .map(blockerOf),
  ];
}

const RATIONALE_BLOCKS: readonly {
  heading: string;
  holds: (ground: UnmetGround) => boolean;
}[] = [
  {
    heading: "Plan conflict:",
    holds: (ground) => ground === UnmetGround.Conflict,
  },
  {
    heading: "Plan gap:",
    holds: (ground) => ground === UnmetGround.Unstated,
  },
  {
    heading: "Unmet:",
    holds: (ground) =>
      ground !== UnmetGround.Conflict && ground !== UnmetGround.Unstated,
  },
];

export function judgementRationale(judgement: {
  rationale: string;
  blockers: readonly Blocker[];
}): string {
  const blocks = RATIONALE_BLOCKS.flatMap(({ heading, holds }) => {
    const lines = judgement.blockers
      .filter((item) => holds(item.ground))
      .map((item) => `- ${item.id}: ${item.reason}`);
    return lines.length === NO_ITEMS ? [] : [`${heading}\n${lines.join("\n")}`];
  });
  return [judgement.rationale, ...blocks].join("\n");
}

function tailWithinBytes(text: string, limit: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= limit) return text;
  const tail = bytes.subarray(bytes.length - limit);
  const start = tail.findIndex(
    (byte) => (byte & UTF8_CONTINUATION_MASK) !== UTF8_CONTINUATION,
  );
  return start < NO_ITEMS ? "" : tail.subarray(start).toString("utf8");
}

function flakyDescription(failures: readonly FlakyFailure[]): string {
  const render = (outputOf: (failure: FlakyFailure) => string) =>
    failures
      .map((failure) => {
        const output = outputOf(failure);
        return [
          `Verification ${failure.index + 1} \`${failure.command}\` failed and passed on a rerun of the same commit.`,
          ...(output
            ? [
                `Output of the failed run (the last 4 KiB):\n\n\`\`\`text\n${output}\n\`\`\``,
              ]
            : []),
        ].join(RATIONALE_SEPARATOR);
      })
      .join(RATIONALE_SEPARATOR);
  const bare = render((failure) => (failure.output ? "-" : ""));
  const share = Math.floor(
    (FINDING_TEXT_MAX_BYTES - Buffer.byteLength(bare, "utf8")) /
      failures.length,
  );
  return render((failure) =>
    tailWithinBytes(failure.output, Math.max(share, NO_ITEMS)),
  );
}

function nextSuggestionLabel(findings: readonly JudgementFinding[]): string {
  const numbers = findings
    .filter((finding) => finding.label.startsWith(SUGGESTION_LABEL_PREFIX))
    .map((finding) =>
      Number(finding.label.slice(SUGGESTION_LABEL_PREFIX.length)),
    );
  return `${SUGGESTION_LABEL_PREFIX}${Math.max(NO_ITEMS, ...numbers) + 1}`;
}

export function withFlakyVerification(
  judged: { rationale: string; findings: JudgementFinding[] },
  failures: readonly FlakyFailure[],
): { rationale: string; findings: JudgementFinding[] } {
  if (failures.length === NO_ITEMS) return judged;
  const description = flakyDescription(failures);
  if (judged.findings.length >= FINDING_MAX)
    return {
      rationale: [
        judged.rationale,
        `${FLAKY_FINDING_NAME}:\n${description}`,
      ].join(RATIONALE_SEPARATOR),
      findings: judged.findings,
    };
  return {
    rationale: judged.rationale,
    findings: [
      ...judged.findings,
      {
        label: nextSuggestionLabel(judged.findings),
        action: FindingAction.No,
        task_id: null,
        ground: null,
        name: FLAKY_FINDING_NAME,
        description,
        fix: "Make the failed test deterministic in a separate node.",
        why: "The command passed on a rerun of the same commit, so the failure is not caused by this change.",
      },
    ],
  };
}

export interface JudgementIssue {
  path: string;
  message: string;
}

export type ParsedJudgement<T> =
  { reply: T; issues: null } | { reply: null; issues: JudgementIssue[] };

export function parseJudgement<T extends z.ZodType>(
  text: string | undefined,
  schema: T,
  marker: string = JUDGEMENT_MARKER,
): ParsedJudgement<z.output<T>> {
  const line = text?.split("\n").findLast((value) => value.startsWith(marker));
  if (!line) return { reply: null, issues: [] };
  let value: unknown;
  try {
    value = JSON.parse(line.slice(marker.length));
  } catch (error) {
    if (error instanceof SyntaxError)
      return { reply: null, issues: [{ path: "", message: error.message }] };
    throw error;
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { reply: parsed.data, issues: null };
  return {
    reply: null,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map(String).join(ISSUE_PATH_SEPARATOR),
      message: issue.message,
    })),
  };
}

export const ReplyRepair = {
  Invalid: "invalid",
  BudgetEnd: "budget_end",
} as const;
export type ReplyRepair = (typeof ReplyRepair)[keyof typeof ReplyRepair];

export function repairInstruction(
  templates: PromptTemplates,
  marker: string,
  issues: readonly JudgementIssue[] = [],
): string {
  assert.ok(marker);
  return renderTemplate(templates, PromptTemplate.Repair, { marker, issues });
}

export async function parseRepaired<T extends z.ZodType>(
  templates: PromptTemplates,
  agent: NativeAgent,
  work: WorkPrompt,
  schema: T,
  marker: string = JUDGEMENT_MARKER,
): Promise<{ reply: z.output<T> | ReplyRepair; repaired: boolean }> {
  const first = parseJudgement(agent.lastText(), schema, marker);
  if (first.issues === null) return { reply: first.reply, repaired: false };
  await agent.instruct(
    work,
    repairInstruction(templates, marker, first.issues),
    PromptTemplate.Repair,
  );
  if (agent.budget.exhausted())
    return { reply: ReplyRepair.BudgetEnd, repaired: true };
  const second = parseJudgement(agent.lastText(), schema, marker);
  return {
    reply: second.issues === null ? second.reply : ReplyRepair.Invalid,
    repaired: true,
  };
}

export function requestedChangesText(
  reads: readonly (ChangeRequestRead & { binding: string })[],
): string | null {
  const lines: string[] = [];
  for (const read of reads) {
    for (const request of read.change_requests) {
      lines.push(
        `Reviewer ${request.reviewer} requests changes on ${read.binding} at commit ${request.commit_id}: ${request.body}`,
      );
      for (const comment of request.comments)
        lines.push(
          `- ${comment.path}${comment.line === null ? "" : `:${comment.line}`}: ${comment.body}`,
        );
    }
  }
  if (lines.length === NO_ITEMS) return null;
  return cutAtLimit(
    `The pull request reviewers request these changes:\n${lines.join("\n")}`,
    "requested changes",
  );
}

export function failedChecksText(
  reads: readonly (FailedChecks["items"][number] & { binding: string })[],
): string | null {
  if (reads.length === NO_ITEMS) return null;
  const lines = reads.map(
    (read) =>
      `The required checks ${read.failed.join(", ")} failed on ${read.binding} at commit ${read.head_commit}.`,
  );
  return cutAtLimit(
    `The pull request cannot merge:\n${lines.join("\n")}`,
    "failed checks",
  );
}

function cutAtLimit(text: string, subject: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= REQUESTED_CHANGES_MAX_BYTES) return text;
  return `${bytes.subarray(0, REQUESTED_CHANGES_MAX_BYTES).toString("utf8")}\n[The ${subject} exceed 4 KiB and end here.]`;
}

export function failedVerificationRationale(
  verification: Verification,
  commands: readonly string[],
): string {
  const index = verification.results.findIndex(
    (result) => result.exit_code !== SUCCESS_EXIT,
  );
  const position = index < SUCCESS_EXIT ? verification.results.length : index;
  const result = verification.results[position];
  assert.ok(
    commands[position],
    "A failed or unrun verification must name its command",
  );
  assert.ok(position < commands.length);
  const prefix = `Verification ${position + 1} \`${commands[position]}\``;
  if (!result) return `${prefix} was not run.`;
  if (result.timed_out) return `${prefix} reached its deadline.`;
  if (result.signal) return `${prefix} was ended by signal ${result.signal}.`;
  return `${prefix} failed with exit code ${result.exit_code}.`;
}

export function failedVerificationReport(
  run: VerificationRun,
  commands: readonly string[],
): string {
  const rationale = failedVerificationRationale(run.verification, commands);
  const parts = [rationale];
  const output = run.outputs.at(-1);
  if (output)
    parts.push(
      `Output of the failed run (the last 4 KiB):\n\n\`\`\`text\n${output}\n\`\`\``,
    );
  return parts.join("\n\n");
}

function revisionInstruction(
  templates: PromptTemplates,
  verification: Verification,
  commands: readonly string[],
  output: string,
  release: boolean,
): string {
  return renderTemplate(templates, PromptTemplate.TaskRevision, {
    rationale: failedVerificationRationale(verification, commands),
    results: verification.results,
    output,
    release,
  });
}

export function taskRevisionInstruction(
  templates: PromptTemplates,
  verification: Verification,
  commands: readonly string[],
  output: string,
): string {
  return revisionInstruction(templates, verification, commands, output, false);
}

export function releaseRevisionInstruction(
  templates: PromptTemplates,
  verification: Verification,
  commands: readonly string[],
  output: string,
): string {
  return revisionInstruction(templates, verification, commands, output, true);
}

export function affectedRevisionInstruction(
  templates: PromptTemplates,
  failed: readonly AffectedRun[],
): string {
  assert.ok(failed.length > NO_ITEMS);
  return renderTemplate(templates, PromptTemplate.TaskRevision, {
    rationale: failed
      .map((run) => {
        assert.ok(run.failure_text);
        return run.failure_text;
      })
      .join(RATIONALE_SEPARATOR),
    results: failed.map((run) => run.head),
    output: failed[FIRST_ENTRY]!.output,
    release: true,
  });
}

export function affectedFailureReport(
  results: readonly AffectedResult[],
): string {
  const failed = results.filter(
    (result): result is AffectedRun =>
      result.verdict === AffectedVerdict.Failed,
  );
  assert.ok(failed.length > NO_ITEMS);
  const parts = failed.map((run) => {
    assert.ok(run.failure_text);
    return run.failure_text;
  });
  const output = failed[FIRST_ENTRY]!.output;
  if (output)
    parts.push(
      `Output of the failed run (the last 4 KiB):\n\n\`\`\`text\n${output}\n\`\`\``,
    );
  return parts.join(RATIONALE_SEPARATOR);
}

export interface RevisionFinding {
  id: string;
  label: string;
  round: number | null;
  name: string;
  description: string;
  fix: string;
  why: string;
}

export function criterionRevisionInstruction(
  templates: PromptTemplates,
  rationale: string,
  findings: readonly RevisionFinding[] = [],
): string {
  assert.ok(rationale.trim());
  assert.ok(rationale.length);
  return renderTemplate(templates, PromptTemplate.CriterionRevision, {
    rationale,
    findings: findings.map((finding) => ({
      id: finding.id,
      label: finding.label,
      round: finding.round,
      name: finding.name,
      description: finding.description,
      fix: finding.fix,
      why: finding.why,
    })),
  });
}

export function evaluationInstruction(
  templates: PromptTemplates,
  input: {
    examine?: boolean;
    tasks: readonly TaskContent[];
    verification: Verification;
    evidence: unknown;
    dependencies?: unknown;
    affected: unknown;
    round: { number: number; review_base: unknown };
    priorFindings: readonly Finding[];
  },
): string {
  return renderTemplate(templates, PromptTemplate.Evaluation, {
    examine: input.examine === true,
    tasks: input.tasks.map((task) => ({
      id: task.id,
      criterion: task.content.criterion,
    })),
    tested_input: input.verification.tested_input,
    results: input.verification.results,
    evidence: input.evidence,
    dependencies: input.dependencies ?? null,
    affected: input.affected,
    marker: JUDGEMENT_MARKER,
    round: input.round,
    prior_findings: input.priorFindings.map((finding) => ({
      id: finding.id,
      label: finding.label,
      round: finding.round,
      kind: finding.kind,
      action: finding.action,
      task_id: finding.task_id,
      ground: finding.ground,
      name: finding.name,
      description: finding.description,
      fix: finding.fix,
      why: finding.why,
    })),
  });
}

export function examineInstruction(
  templates: PromptTemplates,
  input: {
    repositories: readonly unknown[];
    verification: Verification | null;
    dependencies: readonly unknown[];
    outcomes: unknown;
    evidence: unknown;
  },
): string {
  return renderTemplate(templates, PromptTemplate.Examine, input);
}
