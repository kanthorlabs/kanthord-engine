import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../mission/contract.ts";
import type { WorkPrompt } from "../agent/prompt-composer.ts";
import type { Verification } from "./verification.ts";
import type { NativeAgent } from "./native-agent.ts";

export const JUDGEMENT_MARKER = "kanthord-judgement:";
const SUCCESS_EXIT = 0;
const NO_ITEMS = 0;
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
export const evaluationJudgementSchema = z
  .strictObject({
    result: z.enum(AssessmentResult),
    rationale: z.string().trim().min(1),
    unmet: z.array(unmetItemSchema).default([]),
  })
  .refine(
    (judgement) =>
      judgement.result !== AssessmentResult.CriterionNotMet ||
      judgement.unmet.length > NO_ITEMS,
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

export function repairInstruction(marker: string): string {
  assert.ok(marker);
  return `The reply holds no valid ${marker} line. Reply again with exactly one such line.`;
}

export async function parseRepaired<T extends z.ZodType>(
  agent: NativeAgent,
  work: WorkPrompt,
  schema: T,
  marker: string = JUDGEMENT_MARKER,
): Promise<z.output<T> | ReplyRepair> {
  const reply = parseJudgement(agent.lastText(), schema, marker);
  if (reply !== null) return reply;
  await agent.instruct(work, repairInstruction(marker));
  if (agent.budget.exhausted()) return ReplyRepair.BudgetEnd;
  return (
    parseJudgement(agent.lastText(), schema, marker) ?? ReplyRepair.Invalid
  );
}

export function taskJudgementInstruction(
  task: TaskContent,
  priorRationale: string | null = null,
): string {
  assert.ok(task.id);
  assert.ok(task.content.criterion);
  const prior =
    priorRationale === null
      ? ""
      : `\nPrevious judgement: ${priorRationale}. Judge whether the task criterion is met now.`;
  return `Judge whether the task criterion is met, respecting the default standard. Task ${task.id}: ${task.content.criterion}${prior}\nEnd with exactly:\n${JUDGEMENT_MARKER} {"criterion_met": true, "rationale": "Explain your judgement"}`;
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
  verification: Verification,
  commands: readonly string[],
): string {
  return `Revise the task work to satisfy its criterion and verifications. ${failedVerificationRationale(verification, commands)}\nVerification results: ${JSON.stringify(verification.results)}`;
}

export function criterionRevisionInstruction(rationale: string): string {
  assert.ok(rationale.trim());
  assert.ok(rationale.length);
  return `Revise the task work to meet its criterion. Previous judgement: ${rationale}`;
}

export function evaluationInstruction(input: {
  tasks: readonly TaskContent[];
  verification: Verification;
  evidence: unknown;
  objectives?: unknown;
}): string {
  return `Judge the evidence against the node criterion in the pinned work prompt, every current task criterion below, and the default standard. Inspect the supporting assets at the workspace-relative paths in the review bundle. Weigh each current objective outcome in the supplied objective context. Judge the work, the code and the recorded facts. The prose style and the finding format of a produced report are no ground for criterion-not-met. Give one result: success, criterion-not-met, or undetermined. A default-standard violation requires criterion-not-met. List every unmet item that you find in this one judgement. For criterion-not-met, list each unmet task id, or the node id for an unmet node criterion or default-standard violation, in unmet with the concrete defect as its reason. Write every reason in full; do not cite a finding label such as B1.\nTasks: ${JSON.stringify(input.tasks.map((task) => ({ id: task.id, criterion: task.content.criterion })))}\nTested input: ${JSON.stringify(input.verification.tested_input)}\nVerification results of this evaluation: ${JSON.stringify(input.verification.results)}\nEvidence: ${JSON.stringify(input.evidence)}\nCurrent objective context: ${JSON.stringify(input.objectives ?? null)}\nEnd with exactly:\n${JUDGEMENT_MARKER} {"result": "criterion-not-met", "rationale": "Explain your judgement", "unmet": [{"id": "node_or_task_id", "reason": "The concrete defect"}]}`;
}

export function reportInstruction(
  objectives: unknown,
  outcomes: unknown,
  evidence: unknown,
  verification: Verification | null,
): string {
  return `Write a Markdown report on the outcome of each current objective using its outcome and evidence. Your reply is the report: give the full report in the reply and write no file, because the reply is the only content that KanthorD stores. KanthorD puts a facts section before your reply. That section lists every objective, node, outcome and assessment identifier and the final-snapshot verification below. Do not copy an identifier or a commit. Assess each objective, the adequacy of its tests and the security behavior against the node criterion, using the data below. Write each blocker or suggestion in the full finding format, with every field including fix: and why:.\nObjectives: ${JSON.stringify(objectives)}\nOutcomes: ${JSON.stringify(outcomes)}\nEvidence: ${JSON.stringify(evidence)}\nFinal-snapshot verification: ${JSON.stringify(verification)}`;
}
