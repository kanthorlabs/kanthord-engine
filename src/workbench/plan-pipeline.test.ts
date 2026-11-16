import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { temporary } from "../kernel/test-support.ts";
import { type PlanDetails, WORKBENCH_PLAN_ENTRY } from "./contract.ts";
import {
  createPhaseSession,
  openPhaseSession,
  planOf,
} from "./plan-pipeline.ts";
import { sessionPlace } from "./sessions.ts";

const PHASE_ID = "workbench_session_1";
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

test("(security, argument guard) planOf answers null for a plan entry whose details fail the schema", () => {
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

test("(invariant guard) opening an absent phase session creates no phases directory and creating one does", async (t) => {
  const state = temporary(t);
  const directory = join(sessionPlace(state, "plan@1").sessionDir, "phases");
  assert.equal(await openPhaseSession(state, PHASE_ID), null);
  assert.equal(existsSync(directory), false);
  const manager = await createPhaseSession(state, PHASE_ID);
  assert.equal(existsSync(directory), true);
  assert.equal(manager.getSessionId(), PHASE_ID);
});
