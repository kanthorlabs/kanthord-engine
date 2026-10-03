import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../mission/contract.ts";
import type { Verification, TestedInput } from "./verification.ts";

export const JUDGEMENT_MARKER = "kanthord-judgement:";
const SUCCESS_EXIT = 0;
const AssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const taskJudgementSchema = z.strictObject({
  criterionMet: z.boolean(),
  rationale: z.string().trim().min(1),
});
export const evaluationJudgementSchema = z.strictObject({
  result: z.enum(AssessmentResult),
  rationale: z.string().trim().min(1),
});

export function parseJudgement<T extends z.ZodType>(
  text: string | undefined,
  schema: T,
): z.output<T> | null {
  const line = text
    ?.split("\n")
    .findLast((value) => value.startsWith(JUDGEMENT_MARKER));
  if (!line) return null;
  let value: unknown;
  try {
    value = JSON.parse(line.slice(JUDGEMENT_MARKER.length));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function taskJudgementInstruction(task: TaskContent): string {
  assert.ok(task.id);
  assert.ok(task.content.criterion);
  return `Judge whether the task criterion is met, respecting the default standard. Task ${task.id}: ${task.content.criterion}\nEnd with exactly:\n${JUDGEMENT_MARKER} {"criterionMet": true, "rationale": "Explain your judgement"}`;
}

export function failedVerificationRationale(
  verification: Verification,
  commands: readonly string[],
): string {
  const index = verification.results.findIndex(
    (result) => result.exitCode !== SUCCESS_EXIT,
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
  if (result.timedOut) return `${prefix} reached its deadline.`;
  if (result.signal) return `${prefix} was ended by signal ${result.signal}.`;
  return `${prefix} failed with exit code ${result.exitCode}.`;
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
  testedInput: TestedInput;
  evidence: unknown;
}): string {
  return `Judge the evidence against the node criterion in the pinned work prompt, every current task criterion below, and the default standard. Give one result: success, criterion-not-met, or undetermined. A default-standard violation requires criterion-not-met. Name each current task whose criterion is unmet in the rationale.\nTasks: ${JSON.stringify(input.tasks.map((task) => ({ id: task.id, criterion: task.content.criterion })))}\nTested input: ${JSON.stringify(input.testedInput)}\nEvidence: ${JSON.stringify(input.evidence)}\nEnd with exactly:\n${JUDGEMENT_MARKER} {"result": "success", "rationale": "Explain your judgement"}`;
}

export function reportInstruction(
  objectives: unknown,
  outcomes: unknown,
  evidence: unknown,
): string {
  return `Write a Markdown report on the outcome of each current objective using its outcome and evidence.\nObjectives: ${JSON.stringify(objectives)}\nOutcomes: ${JSON.stringify(outcomes)}\nEvidence: ${JSON.stringify(evidence)}`;
}
