import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  ActorKind,
  ActorService,
  AssessmentResult,
  AssetKind,
  NodeKind,
} from "./contract.ts";
import { insertMission, insertNode, readNode } from "./store.ts";
import { missionHarness } from "./test-support.ts";
import {
  openAttempt,
  closeAttempt,
  readAttempt,
  readOpenAttempt,
  listAttempts,
  readAttemptPins,
  insertAssessment,
  readAssessment,
  listAssessments,
  readAssessmentsOfAttempt,
  insertOutcome,
  readOutcome,
  listOutcomes,
  readCurrentOutcome,
  readOutcomesOfAttempt,
  insertEvidence,
  readEvidence,
  readAssets,
  readRequests,
  readReleaseEvidence,
  readLandedCommitEvidence,
  type AssessmentRow,
  type EvidenceRow,
  type AssetRow,
} from "./record-store.ts";

const FIRST = 1;
const SECOND = 2;
const THIRD = 3;
const NOW = 100;
const LATER = 200;
const PAGE_SIZE = 10;
const ACTOR = { kind: ActorKind.Human, account: "ulrich", name: "Ulrich" };
const EMPTY_SET = "[]";
const SORTED_SET = '["a","z"]';
const CANONICAL_ASSET = '{"bindingId":"repo","commit":"head"}';
const RATIONALE = "Reviewed";
const ROLLBACK = new Error("Rollback");

function fixture(t: TestContext) {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const nodeId = createIdentity("node");
  const projectId = createIdentity("project");
  const missionId = h.store.transaction((tx) => {
    const id = insertMission(tx, projectId, NOW);
    insertNode(tx, {
      id: nodeId,
      mission_id: id,
      kind: NodeKind.Objective,
      filename: "objective.md",
      parent_id: null,
      created_at: NOW,
    });
    return id;
  });
  const assessment = (attempt = FIRST): Omit<AssessmentRow, "sequence"> => ({
    id: createIdentity("assessment"),
    node_id: nodeId,
    attempt,
    result: AssessmentResult.Undetermined,
    rationale: RATIONALE,
    evidence_ids: EMPTY_SET,
    child_outcome_ids: EMPTY_SET,
    tested_input: null,
    execution_id: null,
    actor: canonicalJSON(ACTOR),
    node_revision: FIRST,
    created_at: NOW,
  });
  return { ...h, nodeId, projectId, missionId, assessment };
}

test("attempts stay contiguous across rollback and never reopen a closed attempt", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    assert.equal(readOpenAttempt(tx, h.nodeId), null);
    assert.equal(openAttempt(tx, h.nodeId, FIRST, ACTOR, NOW).attempt, FIRST);
    assert.throws(
      () => openAttempt(tx, h.nodeId, SECOND, ACTOR, NOW),
      /UNIQUE constraint failed/,
    );
    assert.equal(readNode(tx, h.nodeId)?.attempt, FIRST);
    closeAttempt(tx, h.nodeId, FIRST, LATER);
    assert.equal(readAttempt(tx, h.nodeId, FIRST)?.closed_at, LATER);
    assert.equal(readOpenAttempt(tx, h.nodeId), null);
    assert.throws(() => closeAttempt(tx, h.nodeId, FIRST, LATER));
  });
  assert.throws(
    () =>
      h.store.transaction((tx) => {
        openAttempt(tx, h.nodeId, SECOND, ACTOR, LATER);
        throw ROLLBACK;
      }),
    (error) => error === ROLLBACK,
  );
  h.store.transaction((tx) => {
    const second = openAttempt(tx, h.nodeId, SECOND, ACTOR, LATER);
    assert.equal(second.attempt, SECOND);
    assert.deepEqual(
      listAttempts(tx, h.nodeId, null, PAGE_SIZE).map((row) => row.attempt),
      [SECOND, FIRST],
    );
    assert.deepEqual(
      listAttempts(tx, h.nodeId, SECOND, PAGE_SIZE).map((row) => row.attempt),
      [FIRST],
    );
    assert.deepEqual(
      readAttemptPins(tx, h.nodeId).map((row) => ({ ...row })),
      [
        { attempt: FIRST, node_revision: FIRST },
        { attempt: SECOND, node_revision: SECOND },
      ],
    );
  });
});

test("assessment and outcome sequences and pagination use node-local acceptance order", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    const first = insertAssessment(tx, h.assessment());
    const second = insertAssessment(tx, h.assessment(SECOND));
    assert.equal(first.sequence, FIRST);
    assert.equal(second.sequence, SECOND);
    const outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.nodeId,
      result: first.result,
      assessment_id: first.id,
      evidence_ids: EMPTY_SET,
      created_at: NOW,
    });
    const later = insertOutcome(tx, {
      ...outcome,
      id: createIdentity("outcome"),
      assessment_id: second.id,
    });
    assert.equal(later.sequence, SECOND);
    assert.deepEqual({ ...readCurrentOutcome(tx, h.nodeId) }, later);
    assert.deepEqual({ ...readOutcome(tx, outcome.id) }, outcome);
    assert.deepEqual({ ...readAssessment(tx, first.id) }, first);
    assert.deepEqual(
      listAssessments(tx, h.nodeId, null, SECOND, PAGE_SIZE).map((row) => ({
        ...row,
      })),
      [first],
    );
    assert.deepEqual(
      readAssessmentsOfAttempt(tx, h.nodeId, SECOND).map((row) => ({ ...row })),
      [second],
    );
    assert.deepEqual(
      listOutcomes(tx, h.nodeId, FIRST, null, PAGE_SIZE).map((row) => ({
        ...row,
      })),
      [outcome],
    );
    assert.deepEqual(
      readOutcomesOfAttempt(tx, h.nodeId, SECOND).map((row) => ({ ...row })),
      [later],
    );
  });
  assert.throws(() =>
    h.store.transaction((tx) => {
      insertAssessment(tx, h.assessment());
      throw ROLLBACK;
    }),
  );
  h.store.transaction((tx) =>
    assert.equal(insertAssessment(tx, h.assessment()).sequence, THIRD),
  );
});

test("JSON sets canonicalize order, reject duplicates and preserve sequence on refusal", (t) => {
  const h = fixture(t);
  h.store.transaction((tx) => {
    const row = h.assessment();
    row.evidence_ids = '["z", "a"]';
    const stored = insertAssessment(tx, row);
    assert.equal(readAssessment(tx, stored.id)?.evidence_ids, SORTED_SET);
    assert.throws(() =>
      insertAssessment(tx, {
        ...h.assessment(),
        child_outcome_ids: '["a","a"]',
      }),
    );
    assert.equal(insertAssessment(tx, h.assessment()).sequence, SECOND);
    const outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.nodeId,
      assessment_id: stored.id,
      result: stored.result,
      evidence_ids: row.evidence_ids,
      created_at: NOW,
    });
    assert.equal(outcome.evidence_ids, SORTED_SET);
  });
});

test("evidence writes all assets atomically and scopes requests, release and landed reads", (t) => {
  const h = fixture(t);
  const executionId = createIdentity("execution");
  const row: EvidenceRow = {
    id: createIdentity("evidence"),
    node_id: h.nodeId,
    attempt: FIRST,
    subject: RATIONALE,
    requirement_key: "repo.pull_request",
    end_state: null,
    verification: null,
    provenance: canonicalJSON({
      kind: ActorKind.Execution,
      executionId,
      clientId: null,
      name: null,
    }),
    created_at: NOW,
  };
  const asset: AssetRow = {
    id: createIdentity("asset"),
    evidence_id: row.id,
    kind: AssetKind.Repository,
    content: '{"commit":"head","bindingId":"repo"}',
    published_at: NOW,
    expired_at: null,
  };
  assert.throws(() =>
    h.store.transaction((tx) => insertEvidence(tx, row, [asset, asset])),
  );
  h.store.transaction((tx) => {
    assert.equal(readEvidence(tx, row.id), null);
    assert.deepEqual(readAssets(tx, row.id), []);
    insertEvidence(tx, row, [asset]);
    assert.deepEqual(
      readRequests(tx, h.nodeId, FIRST).map((row) => ({ ...row })),
      [row],
    );
    assert.deepEqual(
      readReleaseEvidence(tx, h.nodeId, FIRST, executionId).map((row) => ({
        ...row,
      })),
      [row],
    );
    assert.deepEqual(
      readReleaseEvidence(tx, h.nodeId, SECOND, executionId),
      [],
    );
    assert.equal(readAssets(tx, row.id)[0]?.content, CANONICAL_ASSET);
    const landed = {
      ...row,
      id: createIdentity("evidence"),
      requirement_key: null,
      provenance: canonicalJSON({
        kind: ActorKind.Service,
        service: ActorService.Mission,
      }),
    };
    insertEvidence(tx, landed, []);
    assert.deepEqual(
      readLandedCommitEvidence(tx, h.nodeId, FIRST).map((row) => ({ ...row })),
      [landed],
    );
  });
});

test("mission harness parses operation contracts and records the one caller transaction", async (t) => {
  const h = fixture(t);
  const result = await h.invoke("get", {
    params: { projectId: h.projectId },
    query: {},
    body: null,
  });
  assert.equal(result.id, h.missionId);
  assert.equal(h.commits(), FIRST);
  await assert.rejects(
    h.invoke("get", {
      params: { projectId: h.projectId },
      query: {},
      body: null,
      actor: ACTOR,
    }),
  );
  assert.equal(h.commits(), FIRST);
});
