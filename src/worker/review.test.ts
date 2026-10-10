import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewInstruction } from "./review.ts";

test("the task review judges the task criterion, the touched node criterion items and the default standard", () => {
  const instruction = reviewInstruction({
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
