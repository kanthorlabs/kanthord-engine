import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../mission/contract.ts";
import type { WorkPrompt } from "../agent/prompt-composer.ts";
import type { Verification, TestedInput } from "./verification.ts";
import type { NativeAgent } from "./native-agent.ts";

export const JUDGEMENT_MARKER = "kanthord-judgement:";
const SUCCESS_EXIT = 0;
const AssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const taskJudgementSchema = z.strictObject({
  criterion_met: z.boolean(),
  rationale: z.string().trim().min(1),
});
export const evaluationJudgementSchema = z.strictObject({
  result: z.enum(AssessmentResult),
  rationale: z.string().trim().min(1),
});

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

export function taskJudgementInstruction(task: TaskContent): string {
  assert.ok(task.id);
  assert.ok(task.content.criterion);
  return `Judge whether the task criterion is met, respecting the default standard. Task ${task.id}: ${task.content.criterion}\nEnd with exactly:\n${JUDGEMENT_MARKER} {"criterion_met": true, "rationale": "Explain your judgement"}`;
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
  tested_input: TestedInput;
  evidence: unknown;
  objectives?: unknown;
}): string {
  return `Judge the evidence against the node criterion in the pinned work prompt, every current task criterion below, and the default standard. Inspect the supporting assets at the workspace-relative paths in the review bundle. Weigh each current objective outcome in the supplied objective context. Give one result: success, criterion-not-met, or undetermined. A default-standard violation requires criterion-not-met. Name each current task whose criterion is unmet in the rationale.\nTasks: ${JSON.stringify(input.tasks.map((task) => ({ id: task.id, criterion: task.content.criterion })))}\nTested input: ${JSON.stringify(input.tested_input)}\nEvidence: ${JSON.stringify(input.evidence)}\nCurrent objective context: ${JSON.stringify(input.objectives ?? null)}\nEnd with exactly:\n${JUDGEMENT_MARKER} {"result": "success", "rationale": "Explain your judgement"}`;
}

export function reportInstruction(
  objectives: unknown,
  outcomes: unknown,
  evidence: unknown,
): string {
  return `Write a Markdown report on the outcome of each current objective using its outcome and evidence.\nObjectives: ${JSON.stringify(objectives)}\nOutcomes: ${JSON.stringify(outcomes)}\nEvidence: ${JSON.stringify(evidence)}`;
}
