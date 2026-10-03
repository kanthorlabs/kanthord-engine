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
const FIRST = 1;
const ZERO = 0;
const VERSION = "stored-version";
const KEY = "prefix/key";
const NOT_RUNNING = MissionErrorCode.AuthorizationRefused;

function fixture(t: TestContext, expired = false) {
  const h = executionHarness(t, IDENTITY);
  const binding: StorageBinding = {
    bindingId: createIdentity("binding"),
    projectId: h.projectId,
    endpoint: "https://storage.example",
    bucket: "bucket",
    region: "region",
    prefix: "prefix",
    credential: "storage",
    available: true,
  };
  h.dependencies.bindings.storageBindingOf = (_tx, id) => {
    assert.equal(id, binding.bindingId);
    return binding;
  };
  h.dependencies.bindings.getBindingRevision = (_tx, id) => ({
    bindingId: id,
    projectId: h.projectId,
    name: "storage",
    resourceIdentity: "storage:s3:bucket",
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
        node_id: h.nodeId,
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
            mediaType: "text/plain",
            storageBindingId: binding.bindingId,
          }),
          published_at: null,
          expired_at: expired ? ZERO : Date.now() + UPLOAD_LIFETIME_MS,
        },
      ],
    ),
  );
  let checks = ZERO;
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
      params: { assetId },
      query: {},
      body: h.context,
    });
  const evidence = () =>
    h.store.transaction((tx) =>
      evidenceRecord(tx, readEvidence(tx, evidenceId)!),
    );
  assert.equal(evidence().assets.length, FIRST);
  assert.equal(evidence().assets[ZERO]!.publishedAt, null);
  return {
    ...h,
    complete,
    evidence,
    evidenceId,
    assetId,
    location,
    checks: () => checks,
  };
}

test("completion publishes a checked version and a repeat skips Intake", async (t) => {
  const h = fixture(t);
  const result = await h.complete();
  assert.deepEqual(result, {
    assetId: h.assetId,
    evidenceId: h.evidenceId,
    uri: h.location,
  });
  const asset = h.evidence().assets[ZERO]!;
  assert.notEqual(asset.publishedAt, null);
  assert.equal(asset.kind, AssetKind.Object);
  if (asset.kind !== AssetKind.Object) assert.fail();
  assert.equal(asset.address.version, VERSION);
  assert.deepEqual(await h.complete(), result);
  assert.equal(h.checks(), FIRST);
});

test("failed remote checks and claims ending during the check keep uploads pending", async (t) => {
  const h = fixture(t);
  const failure = new Error("size mismatch");
  h.dependencies.intakeStorage.check = async () => {
    throw failure;
  };
  await assert.rejects(h.complete, (error) => error === failure);
  assert.equal(h.evidence().assets[ZERO]!.publishedAt, null);
  h.dependencies.intakeStorage.check = async () => {
    h.dependencies.schedulerClaims.liveExecutionOf = () => null;
    return { location: h.location, version: null };
  };
  await assert.rejects(
    h.complete,
    (error) => error instanceof OperationError && error.code === NOT_RUNNING,
  );
  assert.equal(h.evidence().assets[ZERO]!.publishedAt, null);
});

test("expired uploads fail before Intake and foreign claimed nodes fail context admission", async (t) => {
  const expired = fixture(t, true);
  await assert.rejects(
    expired.complete,
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceUploadExpired,
  );
  assert.equal(expired.checks(), ZERO);
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
  assert.equal(foreign.checks(), ZERO);
});
