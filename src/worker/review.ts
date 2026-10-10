import assert from "node:assert/strict";
import { z } from "zod";
import type { TaskContent } from "../mission/contract.ts";
import { parseRepaired } from "./judgement.ts";
import type { WorkPrompt } from "../agent/prompt-composer.ts";
import type { NativeAgent } from "./native-agent.ts";
import { PromptTemplate, type PromptTemplates } from "../agent/contract.ts";
import { renderTemplate } from "../agent/prompt-templates.ts";

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

export function parseRepairedReview(
  templates: PromptTemplates,
  agent: NativeAgent,
  work: WorkPrompt,
) {
  return parseRepaired(templates, agent, work, reviewSchema, REVIEW_MARKER);
}

export function hasBlocker(findings: readonly Finding[]): boolean {
  return findings.some((finding) => finding.kind === FindingKind.Blocker);
}

export function reviewInstruction(
  templates: PromptTemplates,
  input: {
    task: TaskContent;
    nodeCriterion: string;
    diff: string;
    findings: readonly Finding[];
    replies: string | null;
  },
): string {
  assert.ok(input.task.id);
  assert.ok(input.task.content.criterion);
  assert.ok(input.nodeCriterion);
  return renderTemplate(templates, PromptTemplate.Review, {
    task_id: input.task.id,
    criterion: input.task.content.criterion,
    node_criterion: input.nodeCriterion,
    findings: input.findings,
    replies: input.replies,
    diff: input.diff.slice(0, REVIEW_DIFF_MAX_CHARACTERS),
    diff_truncated: input.diff.length > REVIEW_DIFF_MAX_CHARACTERS,
    diff_max_characters: REVIEW_DIFF_MAX_CHARACTERS,
    marker: REVIEW_MARKER,
  });
}

export function fixInstruction(
  templates: PromptTemplates,
  findings: readonly Finding[],
): string {
  assert.ok(findings.length);
  return renderTemplate(templates, PromptTemplate.Fix, { findings });
}
