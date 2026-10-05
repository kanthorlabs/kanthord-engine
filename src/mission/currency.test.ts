import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  AssessmentResult,
  NodeKind,
  NodeState,
} from "./contract.ts";
import { currencyOf, currentAssessmentOf, CurrencyReason } from "./currency.ts";
import { assessmentRecord } from "./record-read.ts";
import {
  openAttempt,
  closeAttempt,
  insertAssessment,
  insertOutcome,
  insertEvidence,
  type AssessmentRow,
} from "./record-store.ts";
import { insertMission, insertNode, setNodeState } from "./store.ts";
import { missionHarness } from "./test-support.ts";

const FIRST_ATTEMPT = 1;
const SECOND_ATTEMPT = 2;
const NOW = 100;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const WORKER = "general@1";

function fixture(t: TestContext, kind: NodeKind = NodeKind.Objective) {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"), {
    executionAttribution: {
      of: () => ({ clientId: null, name: null, workerName: WORKER }),
    },
  });
  const nodeId = createIdentity("node");
  const missionId = h.store.transaction((tx) => {
    const missionId = insertMission(tx, createIdentity("project"), NOW);
    insertNode(tx, {
      id: nodeId,
      mission_id: missionId,
      kind,
      filename: "node.md",
      parent_id: null,
      created_at: NOW,
    });
    openAttempt(tx, nodeId, FIRST_ATTEMPT, ACTOR, NOW);
    return missionId;
  });
  const assessment = (
    overrides: Partial<Omit<AssessmentRow, "sequence">> = {},
  ) =>
    h.store.transaction((tx) =>
      insertAssessment(tx, {
        id: createIdentity("assessment"),
        node_id: nodeId,
        attempt: FIRST_ATTEMPT,
        result: AssessmentResult.Success,
        rationale: "Reviewed",
        evidence_ids: "[]",
        child_outcome_ids: "[]",
        tested_input: null,
        execution_id: createIdentity("execution"),
        actor: null,
        node_revision: FIRST_ATTEMPT,
        created_at: NOW,
        ...overrides,
      }),
    );
  const row = assessment();
  return {
    ...h,
    nodeId,
    missionId,
    row,
    assessment,
    currency: () => h.store.transaction((tx) => currencyOf(tx, row)),
  };
}

test("a later human revision and unrelated evidence preserve the pinned assessment currency", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO mission_node_revision (node_id, revision, filename, name, requirement, criterion, verifications, bindings, change, reason, actor, created_at) VALUES (?, ?, 'node.md', 'changed', 'requirement', 'criterion', '[]', '[]', '{}', 'reason', ?, ?)",
      )
      .run(h.nodeId, SECOND_ATTEMPT, canonicalJSON(ACTOR), NOW);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.nodeId,
        attempt: FIRST_ATTEMPT,
        subject: "Unselected evidence",
        requirement_key: null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(ACTOR),
        created_at: NOW,
      },
      [],
    );
  });
  assert.equal(h.currency().current, true);
  assert.deepEqual(h.currency().reasons, []);
});

test("pause and resume preserve a passing assessment", (t) => {
  const h = fixture(t);
  for (const state of [NodeState.Paused, NodeState.Waiting]) {
    h.store.transaction((tx) => setNodeState(tx, h.nodeId, state));
    assert.equal(h.currency().current, true);
    assert.equal(h.currency().authorityAdmits, true);
  }
});

test("a later human block assessment defeats authority in its own attempt", (t) => {
  const h = fixture(t);
  h.assessment({
    execution_id: null,
    actor: canonicalJSON(ACTOR),
    result: AssessmentResult.Undetermined,
  });
  assert.equal(h.currency().authorityAdmits, false);
  assert.deepEqual(h.currency().reasons, [
    CurrencyReason.Authority,
    CurrencyReason.Order,
  ]);
  assert.equal(
    h.store.transaction((tx) =>
      currentAssessmentOf(tx, h.nodeId, FIRST_ATTEMPT),
    ),
    null,
  );
});

test("a human act of the next attempt leaves the prior attempt admitted", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    closeAttempt(tx, h.nodeId, FIRST_ATTEMPT, NOW);
    openAttempt(tx, h.nodeId, SECOND_ATTEMPT, ACTOR, NOW);
  });
  h.assessment({
    attempt: SECOND_ATTEMPT,
    node_revision: SECOND_ATTEMPT,
    execution_id: null,
    actor: canonicalJSON(ACTOR),
    result: AssessmentResult.Undetermined,
  });
  assert.equal(h.currency().authorityAdmits, true);
  assert.equal(h.currency().current, true);
});

test("closure whose outcome names the assessment preserves its currency", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.nodeId,
      result: AssessmentResult.Success,
      assessment_id: h.row.id,
      evidence_ids: "[]",
      created_at: NOW,
    });
    closeAttempt(tx, h.nodeId, FIRST_ATTEMPT, NOW);
    setNodeState(tx, h.nodeId, NodeState.Completed);
  });
  assert.equal(h.currency().current, true);
  assert.equal(h.currency().contextMatches, true);
});

test("a changed child outcome invalidates the initiative's selected context without state changes", (t) => {
  const h = fixture(t, NodeKind.Initiative);
  const childId = createIdentity("node");
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: childId,
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.nodeId,
      created_at: NOW,
    }),
  );
  const childAssessment = h.assessment({
    node_id: childId,
    attempt: 0,
    execution_id: null,
    actor: canonicalJSON(ACTOR),
  });
  const outcome = h.store.transaction((tx) =>
    insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: childId,
      result: AssessmentResult.Success,
      assessment_id: childAssessment.id,
      evidence_ids: "[]",
      created_at: NOW,
    }),
  );
  const parent = h.assessment({
    child_outcome_ids: canonicalJSON([outcome.id]),
  });
  assert.equal(
    h.store.transaction((tx) => currencyOf(tx, parent)).current,
    true,
  );
  h.store.transaction((tx) =>
    insertOutcome(tx, { ...outcome, id: createIdentity("outcome") }),
  );
  assert.equal(
    h.store.transaction((tx) => currencyOf(tx, parent)).contextMatches,
    false,
  );
  assert.equal(
    h.store.transaction((tx) =>
      currentAssessmentOf(tx, h.nodeId, FIRST_ATTEMPT),
    ),
    null,
  );
});

test("order selects the latest admitted execution and rejects a newer mismatched pin", (t) => {
  const h = fixture(t);
  const later = h.assessment();
  h.assessment({ node_revision: SECOND_ATTEMPT });
  assert.equal(h.currency().orderSelected, false);
  assert.deepEqual(h.currency().reasons, [CurrencyReason.Order]);
  assert.equal(
    h.store.transaction((tx) =>
      currentAssessmentOf(tx, h.nodeId, FIRST_ATTEMPT),
    )?.id,
    later.id,
  );
});

test("human assessment projection has no currency and execution projection derives attribution", (t) => {
  const h = fixture(t);
  const human = h.assessment({
    actor: canonicalJSON(ACTOR),
    execution_id: null,
  });
  h.store.transaction((tx) => {
    const record = assessmentRecord(tx, h.dependencies, human);
    assert.equal(record.currency, null);
    assert.equal(record.testedInput, null);
    assert.equal(record.workerVersion, null);
    assert.deepEqual(record.actor, ACTOR);
    const execution = assessmentRecord(tx, h.dependencies, h.row);
    assert.deepEqual(execution.actor, {
      kind: ActorKind.Execution,
      executionId: h.row.execution_id,
      clientId: null,
      name: null,
    });
    assert.equal(execution.workerVersion, WORKER);
    assert.equal(execution.currency?.authorityAdmits, false);
  });
});
