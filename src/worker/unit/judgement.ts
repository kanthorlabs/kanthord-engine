import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../../mission/contract.ts";
import type { WorkPrompt } from "../../agent/prompt-composer.ts";
import type { Verification, VerificationRun } from "./verification.ts";
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
export const REQUESTED_CHANGES_MAX_BYTES = 4096;
const AssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const UnmetGround = {
  Stated: "stated",
  Standard: "standard",
  Unstated: "unstated",
} as const;
export const unmetGroundSchema = z.enum(UnmetGround);
export type UnmetGround = z.infer<typeof unmetGroundSchema>;
const unmetItemSchema = z.strictObject({
  id: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  ground: unmetGroundSchema,
});
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
export const evaluationJudgementSchema = z
  .strictObject({
    result: z.enum(AssessmentResult),
    rationale: z.string().trim().min(1),
    unmet: z.array(unmetItemSchema).default([]),
    proposals: z.array(proposalSchema).default([]),
  })
  .refine(
    (judgement) =>
      judgement.result !== AssessmentResult.CriterionNotMet ||
      judgement.unmet.length > NO_ITEMS ||
      judgement.proposals.length > NO_ITEMS,
    { path: ["unmet"] },
  );

export function judgementRationale(judgement: {
  rationale: string;
  unmet: readonly { id: string; reason: string }[];
}): string {
  if (judgement.unmet.length === NO_ITEMS) return judgement.rationale;
  const lines = judgement.unmet.map((item) => `- ${item.id}: ${item.reason}`);
  return `${judgement.rationale}\nUnmet:\n${lines.join("\n")}`;
}

export function parseJudgement<T extends z.ZodType>(
  text: string | undefined,
  schema: T,
  marker: string = JUDGEMENT_MARKER,
): z.output<T> | null {
  const line = text?.split("\n").findLast((value) => value.startsWith(marker));
  if (!line) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(marker.length));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const ReplyRepair = {
  Invalid: "invalid",
  BudgetEnd: "budget_end",
} as const;
export type ReplyRepair = (typeof ReplyRepair)[keyof typeof ReplyRepair];

export function repairInstruction(
  templates: PromptTemplates,
  marker: string,
): string {
  assert.ok(marker);
  return renderTemplate(templates, PromptTemplate.Repair, { marker });
}

export async function parseRepaired<T extends z.ZodType>(
  templates: PromptTemplates,
  agent: NativeAgent,
  work: WorkPrompt,
  schema: T,
  marker: string = JUDGEMENT_MARKER,
): Promise<{ reply: z.output<T> | ReplyRepair; repaired: boolean }> {
  const first = parseJudgement(agent.lastText(), schema, marker);
  if (first !== null) return { reply: first, repaired: false };
  await agent.instruct(
    work,
    repairInstruction(templates, marker),
    PromptTemplate.Repair,
  );
  if (agent.budget.exhausted())
    return { reply: ReplyRepair.BudgetEnd, repaired: true };
  return {
    reply:
      parseJudgement(agent.lastText(), schema, marker) ?? ReplyRepair.Invalid,
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
  if (run.flaky.at(-1))
    parts.push(
      "The command passed on a rerun of the same commit, so the test is flaky. Make it deterministic.",
    );
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

export function criterionRevisionInstruction(
  templates: PromptTemplates,
  rationale: string,
): string {
  assert.ok(rationale.trim());
  assert.ok(rationale.length);
  return renderTemplate(templates, PromptTemplate.CriterionRevision, {
    rationale,
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
