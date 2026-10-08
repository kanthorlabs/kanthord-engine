import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../mission/contract.ts";
import { parseJudgement } from "./judgement.ts";

export const REVIEW_MARKER = "kanthord-review:";
export const REVIEW_ROUNDS = 3;
export const REVIEW_DIFF_MAX_CHARACTERS = 100000;
export const FindingKind = {
  Blocker: "blocker",
  Suggestion: "suggestion",
} as const;
const findingSchema = z.strictObject({
  id: z.string().regex(/^[BS][1-9][0-9]*$/),
  kind: z.enum(FindingKind),
  name: z.string().trim().min(1),
  description: z.string().trim().min(1),
  fix: z.string().trim().min(1),
  why: z.string().trim().min(1),
});
export const reviewSchema = z.strictObject({
  findings: z.array(findingSchema),
});
export type Finding = z.infer<typeof findingSchema>;
export type Review = z.infer<typeof reviewSchema>;

export function parseReview(text: string | undefined): Review | null {
  return parseJudgement(text, reviewSchema, REVIEW_MARKER);
}

export function hasBlocker(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.kind === FindingKind.Blocker);
}

export function boundedDiff(diff: string): string {
  if (diff.length <= REVIEW_DIFF_MAX_CHARACTERS) return diff;
  return `${diff.slice(0, REVIEW_DIFF_MAX_CHARACTERS)}\n[The diff ends at ${REVIEW_DIFF_MAX_CHARACTERS} characters. Read the workspace files for the rest.]`;
}

export function reviewInstruction(input: {
  task: TaskContent;
  diff: string;
  findings: readonly Finding[];
  replies: string | null;
}): string {
  assert.ok(input.task.id);
  assert.ok(input.task.content.criterion);
  return `Review the change of task ${input.task.id} against its criterion and the default standard. Task criterion: ${input.task.content.criterion}
The diff below is the change. Read the workspace files when the diff does not give enough context.
Report every finding that stands now. Keep the id of an earlier finding that still stands. Drop an earlier finding when the change fixes it or when the reply of the engineer refutes it. A change that widens the task is no finding.
Earlier findings: ${JSON.stringify(input.findings)}
Reply of the engineer to the earlier findings: ${input.replies ?? "none"}
Diff:
${boundedDiff(input.diff)}
End with exactly one line:
${REVIEW_MARKER} {"findings": [{"id": "B1", "kind": "blocker", "name": "Short name", "description": "The defect", "fix": "The recommended change", "why": "The violated criterion or standard"}]}
Write ${REVIEW_MARKER} {"findings": []} when no finding stands.`;
}

export function fixInstruction(findings: readonly Finding[]): string {
  assert.ok(findings.length);
  return `Address the review findings of the task. Fix every blocker. Apply a suggestion when it stays inside the task. Reject a finding only with a reason. Answer each finding in the finding format of the default standard, with status FIXED or action NO.
Findings: ${JSON.stringify(findings)}`;
}
