import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  MissionErrorCode,
  NodeState,
  PlatformAddressKind,
  RevokeCause,
} from "./contract.ts";
import {
  closeAttempt,
  insertAssessment,
  insertEvidence,
  insertOutcome,
  readAssessment,
  readAssets,
  readEvidence,
  readOutcome,
} from "./record-store.ts";
import { outcomeRecord } from "./record-read.ts";
import { readMission, setNodeState } from "./store.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import {
  actCalls,
  evidenceHarness,
  revokedExecution,
  settlesExpired,
} from "./test-support.ts";

const EXECUTION_REVOKED = "schedulerClaims.executionRevoked";
const EXECUTIONS_LOST = "schedulerClaims.executionsLost";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NO_CALLS = 0;
const ONE_ACT = 1;
const FIRST_ATTEMPT = 1;
const SECOND_VERSION = 2;
const VERSION = "version";
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
      h.store.transaction((tx) => readAssets(tx, h.evidence_id).length),
      FIRST_ATTEMPT,
    );
  }
});

test("asset delete authorizes the storage binding that the object pins", async (t) => {
  const h = fixture(t);
  const pinnedId = createIdentity("binding");
  h.store.database
    .prepare("UPDATE mission_evidence_asset SET content = ? WHERE id = ?")
    .run(
      canonicalJSON({
        location: "s3://bucket/key",
        size: FIRST_ATTEMPT,
        media_type: "text/plain",
        storage_binding_id: pinnedId,
        object_version: VERSION,
      }),
      h.asset_id,
    );
  const storage = t.mock.method(h.dependencies.bindings, "storageBindingOf");
  h.dependencies.intakeStorage.delete = async () => undefined;
  assert.equal(await h.remove(true), null);
  assert.deepEqual(
    storage.mock.calls.map((call) => call.arguments[1]),
    [pinnedId],
  );
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
        node_id: h.node_id,
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
                  resource_identity: "repository:github:owner/repo",
                  number: FIRST_ATTEMPT,
                }
              : {
                  location: "s3://bucket/key",
                  size: FIRST_ATTEMPT,
                  media_type: "text/plain",
                  storage_binding_id: h.storageId,
                  object_version: VERSION,
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
      params: { asset_id: assetId },
      query: {},
      body: {
        force,
        expected_mission_version: expectedMissionVersion,
        ...(force ? { reason: "Remove" } : {}),
      },
    });
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
  assert.ok(assetId);
  return { ...h, evidence_id: evidenceId, asset_id: assetId, remove };
}

test("asset deletes require a terminal node and terminal direct examine dependents or force and preserve the empty evidence", async (t) => {
  const h = fixture(t);
  h.dependencies.intakeStorage.delete = async (_call, assetId) => {
    assert.equal(assetId, h.asset_id);
  };
  await assert.rejects(
    h.remove(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceRemoveNodeLive,
  );
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Completed));
  await assert.rejects(
    h.remove(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceRemoveNodeLive,
  );
  const parentId = h.examine_id;
  h.store.transaction((tx) => setNodeState(tx, parentId, NodeState.Discarded));
  assert.equal(await h.remove(), null);
  h.store.transaction((tx) => {
    assert.equal(readAssets(tx, h.evidence_id).length, NO_CALLS);
    assert.ok(readEvidence(tx, h.evidence_id));
    assert.equal(readMission(tx, h.mission_id)?.version, FIRST_ATTEMPT);
  });
});

test("failed remote deletion reads back on repeat and requires human request removal to redispatch", async (t) => {
  const h = fixture(t);
  let calls = NO_CALLS;
  const failure = new Error("delete failed");
  let failedRequest = false;
  let readBacks = NO_CALLS;
  let fail = true;
  h.dependencies.intakeStorage.delete = async (_call, assetId) => {
    assert.equal(assetId, h.asset_id);
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
    h.store.transaction((tx) => readAssets(tx, h.evidence_id).length),
    FIRST_ATTEMPT,
  );
  await assert.rejects(h.remove(true), (error) => error === failure);
  assert.equal(calls, FIRST_ATTEMPT);
  assert.equal(readBacks, FIRST_ATTEMPT);
  failedRequest = false;
  fail = false;
  await h.remove(true);
  assert.equal(calls, SECOND_VERSION);
  assert.equal(
    h.store.transaction((tx) => readAssets(tx, h.evidence_id).length),
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
    h.store.transaction((tx) => readAssets(tx, h.evidence_id).length),
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
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Human block",
      evidence_ids: canonicalJSON([h.evidence_id]),
      dependency_outcome_ids: "[]",
      tested_input: null,
      gate_files: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_ATTEMPT,
      created_at: FIRST_ATTEMPT,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: h.node_id,
      assessment_id: assessmentId,
      result: AssessmentResult.Undetermined,
      evidence_ids: canonicalJSON([h.evidence_id]),
      created_at: FIRST_ATTEMPT,
    });
  });
  await h.invoke("evidence.delete", {
    params: { evidence_id: h.evidence_id },
    query: {},
    body: {
      expected_mission_version: FIRST_ATTEMPT,
      force: true,
      reason: "Remove",
    },
  });
  h.store.transaction((tx) => {
    assert.equal(readEvidence(tx, h.evidence_id), null);
    assert.deepEqual(
      JSON.parse(readAssessment(tx, assessmentId)!.evidence_ids),
      [],
    );
    const outcome = readOutcome(tx, outcomeId)!;
    assert.deepEqual(JSON.parse(outcome.evidence_ids), []);
    assert.equal(outcome.result, AssessmentResult.Undetermined);
    assert.equal(
      outcomeRecord(tx, h.dependencies.bindings, outcome).closing_event,
      ClosingEvent.HumanBlock,
    );
  });
  await assert.rejects(
    h.invoke("evidence.get", {
      params: { evidence_id: h.evidence_id },
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
    h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now) => {
      revokes++;
      return revokedExecution(h.claim.executionId, nodeId, now);
    };
    if (closed)
      h.store.transaction((tx) => {
        closeAttempt(tx, h.node_id, FIRST_ATTEMPT, SECOND_VERSION);
        setNodeState(tx, h.node_id, NodeState.Completed);
      });
    await assert.rejects(
      h.invoke("evidence.delete", {
        params: { evidence_id: h.evidence_id },
        query: {},
        body: { expected_mission_version: FIRST_ATTEMPT, force: false },
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.EvidenceRequestForceRequired,
    );
    await h.invoke("evidence.delete", {
      params: { evidence_id: h.evidence_id },
      query: {},
      body: {
        expected_mission_version: FIRST_ATTEMPT,
        force: true,
        reason: "Remove request",
      },
    });
    assert.equal(
      h.node().state,
      closed ? NodeState.Completed : NodeState.Paused,
    );
    assert.equal(revokes, closed ? NO_CALLS : FIRST_ATTEMPT);
    const ends = h.calls.filter((call) => call.method === EXECUTION_REVOKED);
    assert.equal(ends.length, closed ? NO_CALLS : FIRST_ATTEMPT);
    if (!closed) assert.equal(ends[0]?.arguments[1], RevokeCause.Human);
  }
});

test("a forced request deletion that settles an expired execution inline writes one lost end after its commit", async (t) => {
  const h = fixture(t, true);
  const executionId = createIdentity("execution");
  settlesExpired(h.dependencies, executionId);
  await h.invoke("evidence.delete", {
    params: { evidence_id: h.evidence_id },
    query: {},
    body: {
      expected_mission_version: FIRST_ATTEMPT,
      force: true,
      reason: "Remove request",
    },
  });
  const ends = h.calls.filter((call) => call.method === EXECUTIONS_LOST);
  assert.equal(ends.length, FIRST_ATTEMPT);
  const [lost] = ends[0]!.arguments as [{ execution_id: string }[]];
  assert.deepEqual(
    lost.map((execution) => execution.execution_id),
    [executionId],
  );
});

test("a forced request deletion rolled back after the settlement writes no end", async (t) => {
  const h = fixture(t, true);
  settlesExpired(h.dependencies, createIdentity("execution"));
  h.caller.commit = (write) =>
    h.store.transaction((tx) => {
      write(tx);
      throw new Error("rollback");
    });
  await assert.rejects(
    h.invoke("evidence.delete", {
      params: { evidence_id: h.evidence_id },
      query: {},
      body: {
        expected_mission_version: FIRST_ATTEMPT,
        force: true,
        reason: "Remove request",
      },
    }),
    { message: "rollback" },
  );
  assert.equal(
    h.calls.some((call) => call.method === EXECUTIONS_LOST),
    false,
  );
});

test("both deletes log the human, the force and the reason after the commit", async (t) => {
  const h = fixture(t);
  h.dependencies.intakeStorage.delete = async () => undefined;
  const records: { fields: unknown; message: string }[] = [];
  h.dependencies.logger.info = ((fields: unknown, message: string) => {
    records.push({ fields, message });
  }) as typeof h.dependencies.logger.info;
  await h.remove(true);
  const parentId = h.examine_id;
  h.store.transaction((tx) => {
    setNodeState(tx, h.node_id, NodeState.Completed);
    setNodeState(tx, parentId, NodeState.Discarded);
  });
  await h.invoke("evidence.delete", {
    params: { evidence_id: h.evidence_id },
    query: {},
    body: { expected_mission_version: FIRST_ATTEMPT, force: false },
  });
  assert.deepEqual(records, [
    {
      fields: {
        asset_id: h.asset_id,
        account: IDENTITY.accountId,
        force: true,
        reason: "Remove",
      },
      message: "evidence asset deleted",
    },
    {
      fields: {
        evidence_id: h.evidence_id,
        account: IDENTITY.accountId,
        force: false,
        reason: null,
      },
      message: "evidence deleted",
    },
  ]);
});

test("a delete writes one act trace with the evidence, the reason and equal states", async (t) => {
  const h = fixture(t);
  h.dependencies.intakeStorage.delete = async () => undefined;
  const state = h.node().state;
  await h.invoke("evidence.delete", {
    params: { evidence_id: h.evidence_id },
    query: {},
    body: {
      expected_mission_version: FIRST_ATTEMPT,
      force: true,
      reason: "Remove stored",
    },
  });
  const written = actCalls(h);
  assert.equal(written.length, ONE_ACT);
  const [trace, contribution] = written[0]!;
  assert.equal(contribution.operation, Act.DeleteEvidence);
  assert.equal(trace.project_id, h.project_id);
  assert.equal(trace.node_id, h.node_id);
  assert.equal(trace.attempt, FIRST_ATTEMPT);
  assert.equal(contribution.attributes[ActAttribute.EvidenceId], h.evidence_id);
  assert.equal(contribution.attributes[ActAttribute.StateFrom], state);
  assert.equal(contribution.attributes[ActAttribute.StateTo], state);
  assert.equal(
    contribution.attributes[ActAttribute.MissionVersion],
    FIRST_ATTEMPT,
  );
  assert.equal(contribution.links, undefined);
  assert.deepEqual(contribution.texts, [
    { text_id: `${trace.root_span_id}:reason`, text: "Remove stored" },
  ]);
});

test("a forced delete of a request evidence holds the states and links the revoked execution", async (t) => {
  const h = fixture(t, true);
  const revoked = revokedExecution(
    h.claim.executionId,
    h.node_id,
    FIRST_ATTEMPT,
  );
  h.dependencies.schedulerClaims.revoke = () => revoked;
  const before = h.node().state;
  await h.invoke("evidence.delete", {
    params: { evidence_id: h.evidence_id },
    query: {},
    body: {
      expected_mission_version: FIRST_ATTEMPT,
      force: true,
      reason: "Remove request",
    },
  });
  const written = actCalls(h);
  assert.equal(written.length, ONE_ACT);
  const [, contribution] = written[0]!;
  assert.equal(contribution.attributes[ActAttribute.StateFrom], before);
  assert.equal(contribution.attributes[ActAttribute.StateTo], NodeState.Paused);
  assert.deepEqual(contribution.links, [
    { trace_id: revoked.trace.trace_id, span_id: revoked.trace.root_span_id },
  ]);
});

test("a refused delete writes no act trace", async (t) => {
  const h = fixture(t, true);
  await assert.rejects(
    h.invoke("evidence.delete", {
      params: { evidence_id: h.evidence_id },
      query: {},
      body: { expected_mission_version: FIRST_ATTEMPT, force: false },
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceRequestForceRequired,
  );
  assert.equal(actCalls(h).length, NO_CALLS);
});

test("a delete rolled back after the commit write writes no act trace", async (t) => {
  const h = fixture(t, true);
  h.caller.commit = (write) =>
    h.store.transaction((tx) => {
      write(tx);
      throw new Error("rollback");
    });
  await assert.rejects(
    h.invoke("evidence.delete", {
      params: { evidence_id: h.evidence_id },
      query: {},
      body: {
        expected_mission_version: FIRST_ATTEMPT,
        force: true,
        reason: "Remove request",
      },
    }),
    { message: "rollback" },
  );
  assert.equal(actCalls(h).length, NO_CALLS);
});

test("a delete with an act telemetry that throws keeps its answer", async (t) => {
  const h = fixture(t, true);
  h.dependencies.acts.act = () => {
    throw new Error("telemetry down");
  };
  assert.equal(
    await h.invoke("evidence.delete", {
      params: { evidence_id: h.evidence_id },
      query: {},
      body: {
        expected_mission_version: FIRST_ATTEMPT,
        force: true,
        reason: "Remove request",
      },
    }),
    null,
  );
  assert.equal(h.node().state, NodeState.Paused);
});
