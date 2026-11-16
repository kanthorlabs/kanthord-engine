import assert from "node:assert/strict";
import { test } from "node:test";
import { type PlanDetails, WORKBENCH_PLAN_ENTRY } from "./contract.ts";
import { planOf } from "./plan-pipeline.ts";

const VALID_DETAILS: PlanDetails = {
  phases: [{ phase: "planner", session_id: "workbench_session_1" }],
  unresolved: null,
};

function planEntry(details: unknown) {
  return {
    type: "custom_message",
    id: "entry_1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: WORKBENCH_PLAN_ENTRY,
    content: "The plan.",
    display: true,
    details,
  };
}

test("security: planOf answers null for a plan entry whose details fail the schema", () => {
  assert.deepEqual(planOf(planEntry(VALID_DETAILS)), {
    text: "The plan.",
    details: VALID_DETAILS,
  });
  assert.equal(planOf(planEntry({ ...VALID_DETAILS, extra: 1 })), null);
  assert.equal(planOf(planEntry({ ...VALID_DETAILS, unresolved: "x" })), null);
  assert.equal(
    planOf(
      planEntry({
        phases: [{ phase: "other", session_id: "s" }],
        unresolved: null,
      }),
    ),
    null,
  );
  assert.equal(planOf(planEntry(undefined)), null);
});
