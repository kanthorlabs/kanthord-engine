import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../mission/contract.ts";
import type { WorkPrompt } from "../agent/prompt-composer.ts";
import type { Verification } from "./verification.ts";
import { NodeKind, type NativeAgent } from "./native-agent.ts";
import { PromptTemplate, type PromptTemplates } from "../agent/contract.ts";
import { renderTemplate } from "../agent/prompt-templates.ts";

export const JUDGEMENT_MARKER = "kanthord-judgement:";
const SUCCESS_EXIT = 0;
const NO_ITEMS = 0;
const MIN_VERIFICATIONS = 1;
const AssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const taskJudgementSchema = z.strictObject({
  criterion_met: z.boolean(),
  rationale: z.string().trim().min(1),
});
const unmetItemSchema = z.strictObject({
  id: z.string().trim().min(1),
  reason: z.string().trim().min(1),
});
const proposalTextSchema = z.string().trim().min(1);
const proposalSchema = z.strictObject({
  objective_id: proposalTextSchema,
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
): Promise<z.output<T> | ReplyRepair> {
  const reply = parseJudgement(agent.lastText(), schema, marker);
  if (reply !== null) return reply;
  await agent.instruct(work, repairInstruction(templates, marker));
  if (agent.budget.exhausted()) return ReplyRepair.BudgetEnd;
  return (
    parseJudgement(agent.lastText(), schema, marker) ?? ReplyRepair.Invalid
  );
}

export function taskJudgementInstruction(
  templates: PromptTemplates,
  task: TaskContent,
  priorRationale: string | null = null,
): string {
  assert.ok(task.id);
  assert.ok(task.content.criterion);
  return renderTemplate(templates, PromptTemplate.TaskJudgement, {
    task_id: task.id,
    criterion: task.content.criterion,
    prior_rationale: priorRationale,
    marker: JUDGEMENT_MARKER,
  });
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

export function taskRevisionInstruction(
  templates: PromptTemplates,
  verification: Verification,
  commands: readonly string[],
): string {
  return renderTemplate(templates, PromptTemplate.TaskRevision, {
    rationale: failedVerificationRationale(verification, commands),
    results: verification.results,
  });
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
    kind?: NodeKind;
    tasks: readonly TaskContent[];
    verification: Verification;
    evidence: unknown;
    objectives?: unknown;
  },
): string {
  return renderTemplate(templates, PromptTemplate.Evaluation, {
    initiative: input.kind === NodeKind.Initiative,
    tasks: input.tasks.map((task) => ({
      id: task.id,
      criterion: task.content.criterion,
    })),
    tested_input: input.verification.tested_input,
    results: input.verification.results,
    evidence: input.evidence,
    objectives: input.objectives ?? null,
    marker: JUDGEMENT_MARKER,
  });
}

export function reportInstruction(
  templates: PromptTemplates,
  objectives: unknown,
  outcomes: unknown,
  evidence: unknown,
  verification: Verification | null,
): string {
  return renderTemplate(templates, PromptTemplate.Report, {
    objectives,
    outcomes,
    evidence,
    verification,
  });
}
