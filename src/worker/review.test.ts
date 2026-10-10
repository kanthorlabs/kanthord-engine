import assert from "node:assert/strict";
import { test } from "node:test";
import { SHIPPED_TEMPLATES } from "../agent/prompt-templates.ts";
import type { TaskContent } from "../mission/contract.ts";
import {
  FindingKind,
  REVIEW_DIFF_MAX_CHARACTERS,
  reviewInstruction,
  type Finding,
} from "./review.ts";

const TRUNCATION_NOTE = `\n[The diff ends at ${REVIEW_DIFF_MAX_CHARACTERS} characters. Read the workspace files for the rest.]\nEnd with exactly one line:`;
const NO_REPLY = "Reply of the engineer to the earlier findings: none\n";
const ENGINEER_REPLY = "B1 - status:FIXED";
const DIFF = "diff --git a/x b/x";
const NODE_CRITERION = "The node is done.";
const task: TaskContent = {
  id: "task-a",
  filename: "task-a.md",
  content: {
    name: "Task A",
    requirement: "Do A.",
    criterion: "A is done.",
    verifications: ["true"],
    bindings: [],
  },
};
const finding: Finding = {
  id: "B1",
  kind: FindingKind.Blocker,
  name: "Defect",
  description: "The defect",
  fix: "The fix",
  why: "The reason",
};

test("a review instruction holds the diff, the findings and the reply of the engineer", () => {
  const text = reviewInstruction(SHIPPED_TEMPLATES, {
    task,
    nodeCriterion: NODE_CRITERION,
    diff: DIFF,
    findings: [finding],
    replies: ENGINEER_REPLY,
  });
  assert.ok(text.includes(`Diff:\n${DIFF}\nEnd with exactly one line:`));
  assert.ok(text.includes(`Earlier findings: ${JSON.stringify([finding])}`));
  assert.ok(text.includes(ENGINEER_REPLY));
  assert.ok(!text.includes(NO_REPLY));
});

test("a review instruction without a reply writes none and bounds a long diff", () => {
  const text = reviewInstruction(SHIPPED_TEMPLATES, {
    task,
    nodeCriterion: NODE_CRITERION,
    diff: "x".repeat(REVIEW_DIFF_MAX_CHARACTERS + 1),
    findings: [],
    replies: null,
  });
  assert.ok(text.includes(NO_REPLY));
  assert.ok(
    text.includes(
      `${"x".repeat(REVIEW_DIFF_MAX_CHARACTERS)}${TRUNCATION_NOTE}`,
    ),
  );
  assert.ok(!text.includes("x".repeat(REVIEW_DIFF_MAX_CHARACTERS + 1)));
});

test("the task review judges the task criterion, the touched node criterion items and the default standard", () => {
  const instruction = reviewInstruction(SHIPPED_TEMPLATES, {
    task: {
      id: "node_01M4HN8TEAWE05REAK13K4E6MA",
      filename: "hardening-routes.md",
      content: {
        name: "Drop the echo route",
        requirement: "Remove POST /echo.",
        criterion: "POST /echo answers 404.",
        verifications: ["npm run verify"],
        bindings: [],
      },
    },
    nodeCriterion: "No production route exists solely to make a test pass.",
    diff: "",
    findings: [],
    replies: null,
  });
  assert.match(
    instruction,
    /every item of the node criterion that the task touches, and the default standard/,
  );
  assert.match(instruction, /Task criterion: POST \/echo answers 404\./);
  assert.match(
    instruction,
    /Node criterion: No production route exists solely to make a test pass\./,
  );
});
