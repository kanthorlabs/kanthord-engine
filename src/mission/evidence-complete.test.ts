import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  type StorageBinding,
  UPLOAD_LIFETIME_MS,
} from "./contract.ts";
import { IntakeErrorCode, ResultClass } from "../intake/contract.ts";
import { S3_RESULT_CODE_PREFIX } from "../storage/contract.ts";
import { AssetUse } from "./authorization.ts";
import {
  failedBindingsOf,
  insertEvidence,
  readEvidence,
} from "./record-store.ts";
import { evidenceRecord } from "./record-read.ts";
import { executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const SIZE = 12;
const SINGLE_ITEM = 1;
const ALREADY_EXPIRED = 0;
const FIRST_ASSET_INDEX = 0;
const NO_CALLS = 0;
const VERSION = "stored-version";
const NOT_RUNNING = MissionErrorCode.AuthorizationRefused;
const ISSUED_AT = 100;
const RACED_CHECK = 1;
const BOTH_CHECKS = 2;
const CONFLICT = 409;
const BAD_GATEWAY = 502;
const FIRST_FAILED_AT = 1;
const UPLOAD_CHECK_FAILED = "telemetry.uploadCheckFailed";

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
  h.dependencies.intakeStorage.check = async (call, received) => {
    checks++;
    assert.equal(call.executionId, h.claim.executionId);
    assert.equal(received, assetId);
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
    binding_id: binding.binding_id,
    checks: () => checks,
    failed: () =>
      h.store.transaction((tx) =>
        failedBindingsOf(tx, h.node_id, h.claim.attempt),
      ),
    failedAts: () =>
      h.store.transaction((tx) =>
        tx.database
          .prepare(
            "SELECT id, failed_at FROM mission_evidence_asset WHERE failed_at IS NOT NULL",
          )
          .all(),
      ),
    setFailedAt: (failedAt: number) =>
      h.store.transaction((tx) =>
        tx.database
          .prepare("UPDATE mission_evidence_asset SET failed_at = ?")
          .run(failedAt),
      ),
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

test("a complete that races a publishing complete refuses at its check", async (t) => {
  const h = fixture(t);
  const machine = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "Harness",
      resourceIdentity: "worker:claude",
      issuedAt: ISSUED_AT,
      projectId: h.project_id,
    },
    "jti",
    h.claim.runtimeIdentity,
  );
  let checks = NO_CALLS;
  let published: unknown = null;
  h.dependencies.intakeStorage.check = async (_call, assetId) => {
    checks++;
    if (checks === RACED_CHECK) {
      published = await h.complete();
      h.store.transaction((tx) =>
        h.service.authorizeEvidenceAsset(
          tx,
          machine,
          assetId,
          h.claim,
          AssetUse.Check,
        ),
      );
    }
    return { location: h.location, version: VERSION };
  };
  await assert.rejects(h.complete, {
    status: 403,
    code: MissionErrorCode.AuthorizationRefused,
    details: { reason: "node_mismatch" },
  });
  assert.equal(checks, BOTH_CHECKS);
  assert.deepEqual(published, {
    asset_id: h.asset_id,
    evidence_id: h.evidence_id,
    uri: h.location,
  });
  assert.notEqual(h.evidence().assets[FIRST_ASSET_INDEX]!.published_at, null);
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

function refusingCheck(h: ReturnType<typeof fixture>, error: OperationError) {
  h.dependencies.intakeStorage.check = async () => {
    throw error;
  };
  return error;
}

const mismatch = () =>
  new OperationError(
    CONFLICT,
    IntakeErrorCode.StorageObjectMismatch,
    "The stored object is absent or differs from the asset size or SHA-256.",
  );

test("a mismatch records the binding", async (t) => {
  const h = fixture(t);
  const error = refusingCheck(h, mismatch());
  await assert.rejects(h.complete, (thrown) => thrown === error);
  assert.deepEqual(h.failed(), [h.binding_id]);
  assert.equal(h.evidence().assets[FIRST_ASSET_INDEX]!.published_at, null);
});

test("a missing object records the binding", async (t) => {
  const h = fixture(t);
  refusingCheck(h, mismatch());
  await assert.rejects(h.complete, {
    code: IntakeErrorCode.StorageObjectMismatch,
  });
  await assert.rejects(h.complete, {
    code: IntakeErrorCode.StorageObjectMismatch,
  });
  assert.deepEqual(h.failed(), [h.binding_id]);
});

test("a store failure records the binding", async (t) => {
  const h = fixture(t);
  const code = S3_RESULT_CODE_PREFIX + ResultClass.UnknownOutcome;
  refusingCheck(h, new OperationError(BAD_GATEWAY, code, "The store fails."));
  await assert.rejects(h.complete, { status: BAD_GATEWAY, code });
  assert.deepEqual(h.failed(), [h.binding_id]);
  assert.equal(h.evidence().assets[FIRST_ASSET_INDEX]!.published_at, null);
});

test("the failed asset stays marked after the refusal", async (t) => {
  const h = fixture(t);
  refusingCheck(h, mismatch());
  const commits = h.commits();
  await assert.rejects(h.complete);
  const [row] = h.failedAts();
  assert.ok(row);
  assert.equal(h.failedAts().length, SINGLE_ITEM);
  assert.equal(row.id, h.asset_id);
  assert.notEqual(row.failed_at, null);
  assert.equal(h.commits(), commits);
});

test("a failed check sets failed_at of the asset once", async (t) => {
  const h = fixture(t);
  refusingCheck(h, mismatch());
  await assert.rejects(h.complete);
  h.setFailedAt(FIRST_FAILED_AT);
  await assert.rejects(h.complete);
  assert.deepEqual(
    h.failedAts().map((row) => ({ ...row })),
    [{ id: h.asset_id, failed_at: FIRST_FAILED_AT }],
  );
});

test("a failed check writes one Mission span under the root span", async (t) => {
  const h = fixture(t);
  refusingCheck(h, mismatch());
  const before = Date.now();
  await assert.rejects(h.complete);
  const reported = h.calls.filter(
    (call) => call.method === UPLOAD_CHECK_FAILED,
  );
  assert.equal(reported.length, SINGLE_ITEM);
  const [failure] = reported[FIRST_ASSET_INDEX]!.arguments as [
    {
      execution_id: string;
      asset_id: string;
      storage_binding_id: string;
      code: string;
      failed_at: number;
    },
  ];
  assert.equal(failure.execution_id, h.claim.executionId);
  assert.equal(failure.asset_id, h.asset_id);
  assert.equal(failure.storage_binding_id, h.binding_id);
  assert.equal(failure.code, IntakeErrorCode.StorageObjectMismatch);
  assert.ok(failure.failed_at >= before);
});

test("a refusal that is no check failure writes no Mission span", async (t) => {
  const h = fixture(t);
  refusingCheck(
    h,
    new OperationError(
      CONFLICT,
      MissionErrorCode.AuthorizationRefused,
      "The facility refuses the operation.",
      { reason: "claim_not_live" },
    ),
  );
  await assert.rejects(h.complete);
  assert.equal(
    h.calls.filter((call) => call.method === UPLOAD_CHECK_FAILED).length,
    NO_CALLS,
  );
});

test("a refusal that is no check failure records no binding", async (t) => {
  const h = fixture(t);
  refusingCheck(
    h,
    new OperationError(
      CONFLICT,
      MissionErrorCode.AuthorizationRefused,
      "The facility refuses the operation.",
      { reason: "claim_not_live" },
    ),
  );
  await assert.rejects(h.complete, {
    code: MissionErrorCode.AuthorizationRefused,
  });
  assert.deepEqual(h.failed(), []);
});
