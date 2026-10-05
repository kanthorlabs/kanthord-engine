import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  AssessmentResult,
  ClosingEvent,
} from "./contract.ts";
import {
  insertEvidence,
  readAssets,
  readEvidence,
  closeAttempt,
  insertAssessment,
  insertOutcome,
  readAssessment,
  readOutcome,
} from "./record-store.ts";
import { outcomeRecord } from "./record-read.ts";
import { readMission, setNodeState } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NO_CALLS = 0;
const FIRST_ATTEMPT = 1;
const SECOND_VERSION = 2;
const VERSION = "version";
const KEY = "key";
const DISABLED_FIELD = "disabled";

test("force never bypasses disabled or removed storage authorization", async (t) => {
  for (const field of ["disabled", "tombstone"] as const) {
    const h = fixture(t);
    const original = h.dependencies.bindings.getBindingRevision;
    h.dependencies.bindings.getBindingRevision = (tx, id) => ({
      ...original(tx, id)!,
      [field]: true,
    });
    const remote = t.mock.method(
      h.dependencies.intakeStorage,
      "delete",
      async () => undefined,
    );
    await assert.rejects(h.remove(true), {
      status: 403,
      code: MissionErrorCode.AuthorizationRefused,
      details: {
        reason:
          field === DISABLED_FIELD ? "binding_disabled" : "binding_removed",
      },
    });
    assert.equal(remote.mock.callCount(), NO_CALLS);
    assert.equal(
      h.store.transaction((tx) => readAssets(tx, h.evidenceId).length),
      FIRST_ATTEMPT,
    );
  }
});

function fixture(t: TestContext, request = false) {
  const h = evidenceHarness(t, IDENTITY);
  const evidenceId = createIdentity("evidence");
  const assetId = createIdentity("evidence_asset");
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: evidenceId,
        node_id: h.nodeId,
        attempt: FIRST_ATTEMPT,
        subject: "Stored",
        requirement_key: request ? "repo.pull_request" : null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.executionActor),
        created_at: FIRST_ATTEMPT,
      },
      [
        {
          id: assetId,
          evidence_id: evidenceId,
          kind: request ? AssetKind.Platform : AssetKind.Object,
          content: canonicalJSON(
            request
              ? {
                  kind: PlatformAddressKind.PullRequest,
                  resourceIdentity: "repository:github:owner/repo",
                  number: FIRST_ATTEMPT,
                }
              : {
                  location: "s3://bucket/key",
                  size: FIRST_ATTEMPT,
                  mediaType: "text/plain",
                  storageBindingId: h.storageId,
                  objectVersion: VERSION,
                },
          ),
          published_at: request ? FIRST_ATTEMPT : null,
          expired_at: FIRST_ATTEMPT,
        },
      ],
    ),
  );
  const remove = (force = false, expectedMissionVersion = FIRST_ATTEMPT) =>
    h.invoke("evidence.asset.delete", {
      params: { assetId },
      query: {},
      body: {
        force,
        expectedMissionVersion,
        ...(force ? { reason: "Remove" } : {}),
      },
    });
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
  assert.ok(assetId);
  return { ...h, evidenceId, assetId, remove };
}

test("asset deletes require a terminal ancestor chain or force and preserve the empty evidence", async (t) => {
  const h = fixture(t);
  h.dependencies.intakeStorage.delete = async (
    _call,
    binding,
    key,
    version,
    requestKey,
  ) => {
    assert.equal(binding.bindingId, h.storageId);
    assert.equal(key, KEY);
    assert.equal(version, VERSION);
    assert.equal(requestKey, h.assetId);
  };
  await assert.rejects(
    h.remove(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceRemoveNodeLive,
  );
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Completed));
  await assert.rejects(
    h.remove(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceRemoveNodeLive,
  );
  const parentId = h.node().parent_id!;
  h.store.transaction((tx) => setNodeState(tx, parentId, NodeState.Discarded));
  assert.equal(await h.remove(), null);
  h.store.transaction((tx) => {
    assert.equal(readAssets(tx, h.evidenceId).length, NO_CALLS);
    assert.ok(readEvidence(tx, h.evidenceId));
    assert.equal(readMission(tx, h.missionId)?.version, FIRST_ATTEMPT);
  });
});

test("failed remote deletion reads back on repeat and requires human request removal to redispatch", async (t) => {
  const h = fixture(t);
  let calls = NO_CALLS;
  const failure = new Error("delete failed");
  let failedRequest = false;
  let readBacks = NO_CALLS;
  let fail = true;
  h.dependencies.intakeStorage.delete = async (
    _call,
    binding,
    key,
    version,
    requestKey,
  ) => {
    assert.equal(requestKey, h.assetId);
    assert.equal(binding.bindingId, h.storageId);
    assert.equal(key, KEY);
    assert.equal(version, VERSION);
    if (failedRequest) {
      readBacks++;
      throw failure;
    }
    calls++;
    if (fail) {
      failedRequest = true;
      throw failure;
    }
  };
  await assert.rejects(
    h.remove(true, SECOND_VERSION),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.VersionConflict,
  );
  assert.equal(calls, NO_CALLS);
  await assert.rejects(h.remove(true), (error) => error === failure);
  assert.equal(
    h.store.transaction((tx) => readAssets(tx, h.evidenceId).length),
    FIRST_ATTEMPT,
  );
  await assert.rejects(h.remove(true), (error) => error === failure);
  assert.equal(calls, FIRST_ATTEMPT);
  assert.equal(readBacks, FIRST_ATTEMPT);
  // The fake models a human deleting the failed Intake outbound request.
  failedRequest = false;
  fail = false;
  await h.remove(true);
  assert.equal(calls, SECOND_VERSION);
  assert.equal(
    h.store.transaction((tx) => readAssets(tx, h.evidenceId).length),
    NO_CALLS,
  );
});

test("request platform assets cannot be removed separately even with force", async (t) => {
  const h = fixture(t, true);
  await assert.rejects(
    h.remove(true),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceRequestAssetRefused,
  );
  assert.equal(
    h.store.transaction((tx) => readAssets(tx, h.evidenceId).length),
    FIRST_ATTEMPT,
  );
});

test("whole evidence deletion clears assessment and outcome sets without changing outcome effects", async (t) => {
  const h = fixture(t);
  const assessmentId = createIdentity("assessment");
  const outcomeId = createIdentity("outcome");
  h.dependencies.intakeStorage.delete = async () => {};
  h.store.transaction((tx) => {
    insertAssessment(tx, {
      id: assessmentId,
      node_id: h.nodeId,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Human block",
      evidence_ids: canonicalJSON([h.evidenceId]),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_ATTEMPT,
      created_at: FIRST_ATTEMPT,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: h.nodeId,
      assessment_id: assessmentId,
      result: AssessmentResult.Undetermined,
      evidence_ids: canonicalJSON([h.evidenceId]),
      created_at: FIRST_ATTEMPT,
    });
  });
  await h.invoke("evidence.delete", {
    params: { evidenceId: h.evidenceId },
    query: {},
    body: {
      expectedMissionVersion: FIRST_ATTEMPT,
      force: true,
      reason: "Remove",
    },
  });
  h.store.transaction((tx) => {
    assert.equal(readEvidence(tx, h.evidenceId), null);
    assert.deepEqual(
      JSON.parse(readAssessment(tx, assessmentId)!.evidence_ids),
      [],
    );
    const outcome = readOutcome(tx, outcomeId)!;
    assert.deepEqual(JSON.parse(outcome.evidence_ids), []);
    assert.equal(outcome.result, AssessmentResult.Undetermined);
    assert.equal(
      outcomeRecord(tx, h.dependencies.bindings, outcome).closingEvent,
      ClosingEvent.HumanBlock,
    );
  });
  await assert.rejects(
    h.invoke("evidence.get", {
      params: { evidenceId: h.evidenceId },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
});

test("forced request deletion pauses and revokes only the open attempt", async (t) => {
  for (const closed of [false, true]) {
    const h = fixture(t, true);
    let revokes = NO_CALLS;
    h.dependencies.schedulerClaims.revoke = () => {
      revokes++;
      return h.claim.executionId;
    };
    if (closed)
      h.store.transaction((tx) => {
        closeAttempt(tx, h.nodeId, FIRST_ATTEMPT, SECOND_VERSION);
        setNodeState(tx, h.nodeId, NodeState.Completed);
      });
    await assert.rejects(
      h.invoke("evidence.delete", {
        params: { evidenceId: h.evidenceId },
        query: {},
        body: { expectedMissionVersion: FIRST_ATTEMPT, force: false },
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.EvidenceRequestForceRequired,
    );
    await h.invoke("evidence.delete", {
      params: { evidenceId: h.evidenceId },
      query: {},
      body: {
        expectedMissionVersion: FIRST_ATTEMPT,
        force: true,
        reason: "Remove request",
      },
    });
    assert.equal(
      h.node().state,
      closed ? NodeState.Completed : NodeState.Paused,
    );
    assert.equal(revokes, closed ? NO_CALLS : FIRST_ATTEMPT);
  }
});
