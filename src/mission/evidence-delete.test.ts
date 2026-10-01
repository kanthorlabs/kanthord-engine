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
} from "./contract.ts";
import { insertEvidence, readAssets, readEvidence } from "./record-store.ts";
import { readMission, setNodeState } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ZERO = 0;
const ONE = 1;
const TWO = 2;
const VERSION = "version";
const KEY = "key";

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
        attempt: ONE,
        subject: "Stored",
        requirement_key: request ? "repo.pull_request" : null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.executionActor),
        created_at: ONE,
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
                  number: ONE,
                }
              : {
                  location: "s3://bucket/key",
                  size: ONE,
                  mediaType: "text/plain",
                  storageBindingId: h.storageId,
                  objectVersion: VERSION,
                },
          ),
          published_at: request ? ONE : null,
          expired_at: ONE,
        },
      ],
    ),
  );
  const remove = (force = false, expectedMissionVersion = ONE) =>
    h.invoke("evidence.asset.delete", {
      params: { assetId },
      query: {},
      body: {
        force,
        expectedMissionVersion,
        ...(force ? { reason: "Remove" } : {}),
      },
    });
  assert.equal(h.node().attempt, ONE);
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
  ) => {
    assert.equal(binding.bindingId, h.storageId);
    assert.equal(key, KEY);
    assert.equal(version, VERSION);
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
    assert.equal(readAssets(tx, h.evidenceId).length, ZERO);
    assert.ok(readEvidence(tx, h.evidenceId));
    assert.equal(readMission(tx, h.missionId)?.version, ONE);
  });
});

test("failed remote deletion preserves the row, force retries it, and stale versions refuse before remote deletion", async (t) => {
  const h = fixture(t);
  let calls = ZERO;
  const failure = new Error("delete failed");
  h.dependencies.intakeStorage.delete = async () => {
    calls++;
    throw failure;
  };
  await assert.rejects(
    h.remove(true, TWO),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.VersionConflict,
  );
  assert.equal(calls, ZERO);
  await assert.rejects(h.remove(true), (error) => error === failure);
  assert.equal(
    h.store.transaction((tx) => readAssets(tx, h.evidenceId).length),
    ONE,
  );
  h.dependencies.intakeStorage.delete = async () => {
    calls++;
  };
  await h.remove(true);
  assert.equal(calls, TWO);
  assert.equal(
    h.store.transaction((tx) => readAssets(tx, h.evidenceId).length),
    ZERO,
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
    ONE,
  );
});
