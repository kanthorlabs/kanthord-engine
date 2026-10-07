import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  UPLOAD_LIFETIME_MS,
  type StorageBinding,
} from "./contract.ts";
import { insertEvidence, readEvidence } from "./record-store.ts";
import { evidenceRecord } from "./record-read.ts";
import { executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const SIZE = 12;
const SINGLE_ITEM = 1;
const ALREADY_EXPIRED = 0;
const FIRST_ASSET_INDEX = 0;
const NO_CALLS = 0;
const VERSION = "stored-version";
const KEY = "prefix/key";
const NOT_RUNNING = MissionErrorCode.AuthorizationRefused;

function fixture(t: TestContext, expired = false) {
  const h = executionHarness(t, IDENTITY);
  const binding: StorageBinding = {
    binding_id: createIdentity("binding"),
    project_id: h.project_id,
    endpoint: "https://storage.example",
    bucket: "bucket",
    region: "region",
    prefix: "prefix",
    credential: "storage",
    available: true,
  };
  h.dependencies.bindings.storageBindingOf = (_tx, id) => {
    assert.equal(id, binding.binding_id);
    return binding;
  };
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    binding_id: id,
    project_id: h.project_id,
    name: "storage",
    resource_identity: "storage:s3:bucket",
    revision: 1,
    tombstone: false,
    disabled: false,
  });
  const evidenceId = createIdentity("evidence");
  const assetId = createIdentity("evidence_asset");
  const location = "s3://bucket/prefix/key";
  h.store.transaction((tx) =>
    insertEvidence(
      tx,
      {
        id: evidenceId,
        node_id: h.node_id,
        attempt: h.claim.attempt,
        subject: "Upload",
        requirement_key: null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.executionActor),
        created_at: Date.now(),
      },
      [
        {
          id: assetId,
          evidence_id: evidenceId,
          kind: AssetKind.Object,
          content: canonicalJSON({
            location,
            size: SIZE,
            media_type: "text/plain",
            storage_binding_id: binding.binding_id,
          }),
          published_at: null,
          expired_at: expired
            ? ALREADY_EXPIRED
            : Date.now() + UPLOAD_LIFETIME_MS,
        },
      ],
    ),
  );
  let checks = NO_CALLS;
  h.dependencies.intakeStorage.check = async (
    _call,
    received,
    key,
    size,
    sha256,
  ) => {
    checks++;
    assert.deepEqual(received, binding);
    assert.equal(key, KEY);
    assert.equal(size, SIZE);
    assert.equal(sha256, null);
    return { location, version: VERSION };
  };
  const complete = () =>
    h.invoke("evidence.asset.complete", {
      params: { asset_id: assetId },
      query: {},
      body: h.context,
    });
  const evidence = () =>
    h.store.transaction((tx) =>
      evidenceRecord(tx, readEvidence(tx, evidenceId)!),
    );
  assert.equal(evidence().assets.length, SINGLE_ITEM);
  assert.equal(evidence().assets[FIRST_ASSET_INDEX]!.published_at, null);
  return {
    ...h,
    complete,
    evidence,
    evidence_id: evidenceId,
    asset_id: assetId,
    location,
    checks: () => checks,
  };
}

test("completion publishes a checked version and a repeat skips Intake", async (t) => {
  const h = fixture(t);
  const result = await h.complete();
  assert.deepEqual(result, {
    asset_id: h.asset_id,
    evidence_id: h.evidence_id,
    uri: h.location,
  });
  const asset = h.evidence().assets[FIRST_ASSET_INDEX]!;
  assert.notEqual(asset.published_at, null);
  assert.equal(asset.kind, AssetKind.Object);
  if (asset.kind !== AssetKind.Object) assert.fail();
  assert.equal(asset.address.version, VERSION);
  assert.deepEqual(await h.complete(), result);
  assert.equal(h.checks(), SINGLE_ITEM);
});

test("failed remote checks and claims ending during the check keep uploads pending", async (t) => {
  const h = fixture(t);
  const failure = new Error("size mismatch");
  h.dependencies.intakeStorage.check = async () => {
    throw failure;
  };
  await assert.rejects(h.complete, (error) => error === failure);
  assert.equal(h.evidence().assets[FIRST_ASSET_INDEX]!.published_at, null);
  h.dependencies.intakeStorage.check = async () => {
    h.dependencies.schedulerClaims.liveExecutionOf = () => null;
    return { location: h.location, version: null };
  };
  await assert.rejects(
    h.complete,
    (error) => error instanceof OperationError && error.code === NOT_RUNNING,
  );
  assert.equal(h.evidence().assets[FIRST_ASSET_INDEX]!.published_at, null);
});

test("expired uploads fail before Intake and foreign claimed nodes fail context admission", async (t) => {
  const expired = fixture(t, true);
  await assert.rejects(
    expired.complete,
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceUploadExpired,
  );
  assert.equal(expired.checks(), NO_CALLS);
  const foreign = fixture(t);
  foreign.claim.nodeId = createIdentity("node");
  await assert.rejects(
    foreign.complete,
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.AuthorizationRefused &&
      JSON.stringify(error.details) ===
        JSON.stringify({ reason: "node_mismatch" }),
  );
  assert.equal(foreign.checks(), NO_CALLS);
});
