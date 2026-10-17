import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test, type TestContext } from "node:test";
import { background, CancellationContext } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  NodeState,
  UPLOAD_LIFETIME_MS,
  type EvidenceSubmit,
} from "./contract.ts";
import { ResultClass } from "../intake/contract.ts";
import { S3_RESULT_CODE_PREFIX } from "../storage/contract.ts";
import { AuthorizationRefusal, authorizationRefused } from "./authorization.ts";
import { insertUploadFailure } from "./record-store.ts";
import { evidenceHarness, executionHarness } from "./test-support.ts";
import { setNodeState } from "./store.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const SUCCESSFUL_EXIT_CODE = 0;
const FIRST_ASSET_INDEX = 0;
const NO_ITEMS = 0;
const SINGLE_ITEM = 1;
const NOT_RUNNING = MissionErrorCode.AuthorizationRefused;
const VALIDATION = "gateway.request.validation_failed";
const SECOND_ATTEMPT = 2;
const BAD_GATEWAY = 502;
const FAILED_AT = 100;
const Field = {
  Subject: "subject",
  Command: "command",
  Signal: "signal",
} as const;

test("submission rejects blank and oversized nested Text before signing or insertion", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  for (const field of Object.values(Field)) {
    const subject = field === Field.Subject ? " \t " : "Valid";
    const long = "é".repeat(h.dependencies.config.text_max_bytes);
    const verification = {
      tested_input: {
        kind: AssetKind.Repository,
        binding_id: h.repositoryId,
        commit: "a".repeat(40),
      },
      results: [
        {
          command: field === Field.Command ? long : "true",
          signal: field === Field.Signal ? long : null,
          exit_code: SUCCESSFUL_EXIT_CODE,
          timed_out: false,
        },
      ],
    };
    await assert.rejects(
      h.invoke("evidence.submit", {
        params: { node_id: h.node_id },
        query: {},
        body: {
          ...h.context,
          subject,
          verification,
          assets: [
            {
              kind: AssetKind.Object,
              size: SINGLE_ITEM,
              media_type: "text/plain",
            },
          ],
        },
      }),
      (error) => error instanceof OperationError && error.code === VALIDATION,
    );
  }
  h.store.transaction((tx) => {
    assert.equal(
      (
        tx.database
          .prepare("SELECT count(*) AS count FROM mission_evidence")
          .get() as { count: number }
      ).count,
      NO_ITEMS,
    );
    assert.equal(
      (
        tx.database
          .prepare("SELECT count(*) AS count FROM mission_evidence_asset")
          .get() as { count: number }
      ).count,
      NO_ITEMS,
    );
  });
});

test("repository and produced submissions publish atomically and repeated submissions mint new evidence", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const body: EvidenceSubmit = {
    ...h.context,
    subject: "Work",
    assets: [
      {
        kind: AssetKind.Repository,
        address: {
          kind: AssetKind.Repository,
          binding_id: h.repositoryId,
          commit: "a".repeat(40),
        },
      },
      {
        kind: AssetKind.Produced,
        content: { media_type: "text/plain", encoding: "base64", data: "aGk=" },
      },
    ],
  };
  const submit = () =>
    h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body,
    });
  const first = await submit();
  assert.equal(first.uploads.length, NO_ITEMS);
  assert.ok(
    first.evidence.assets.every((asset) => asset.published_at !== null),
  );
  assert.deepEqual(first.evidence.provenance, h.executionActor);
  const produced = first.evidence.assets.find(
    (asset) => asset.kind === AssetKind.Produced,
  )!;
  assert.deepEqual(produced.address, {
    kind: AssetKind.Produced,
    sha256: createHash("sha256").update("hi").digest("hex"),
  });
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  assert.notEqual((await submit()).evidence.id, first.evidence.id);
});

test("object submissions sign pinned keys and commit pending assets after PUT preparation", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const sha256 = "b".repeat(64);
  h.dependencies.intakeStorage.put = async (call, input) => {
    assert.equal(call.executionId, h.claim.executionId);
    assert.equal(input.nodeId, h.node_id);
    assert.ok(input.assetId.startsWith("evidence_asset_"));
    assert.equal(input.storageBindingId, h.storage.binding_id);
    assert.equal(input.size, SINGLE_ITEM);
    assert.equal(input.sha256, sha256);
    return {
      put_url: "https://storage.example/put",
      headers: { checksum: sha256 },
      expires_at: Date.now() + UPLOAD_LIFETIME_MS,
    };
  };
  const result = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Object",
      assets: [
        {
          kind: AssetKind.Object,
          size: SINGLE_ITEM,
          media_type: "text/plain",
          sha256,
        },
      ],
    },
  });
  assert.equal(result.uploads.length, SINGLE_ITEM);
  const asset = result.evidence.assets[FIRST_ASSET_INDEX]!;
  assert.equal(asset.published_at, null);
  assert.equal(
    asset.expired_at! - result.evidence.created_at,
    UPLOAD_LIFETIME_MS,
  );
  assert.equal(result.uploads[FIRST_ASSET_INDEX]!.asset_id, asset.id);
  if (asset.kind !== AssetKind.Object) assert.fail();
  assert.equal(
    asset.address.location,
    `s3://bucket/prefix/${h.project_id}/${h.mission_id}/${h.node_id}/1/${asset.id}`,
  );
});

test("storage absence, failed signing and revoked claims write no evidence", async (t) => {
  const empty = executionHarness(t, IDENTITY);
  const body = {
    ...empty.context,
    subject: "Object",
    assets: [
      { kind: AssetKind.Object, size: SINGLE_ITEM, media_type: "text/plain" },
    ],
  };
  await assert.rejects(
    empty.invoke("evidence.submit", {
      params: { node_id: empty.node_id },
      query: {},
      body,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.EvidenceStorageBindingAbsent,
  );
  const h = evidenceHarness(t, IDENTITY);
  const submit = () =>
    h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: { ...body, ...h.context },
    });
  const failure = new Error("signing failed");
  h.dependencies.intakeStorage.put = async () => {
    throw failure;
  };
  await assert.rejects(submit, (error) => error === failure);
  h.dependencies.intakeStorage.put = async () => {
    h.dependencies.schedulerClaims.liveExecutionOf = () => null;
    return {
      put_url: "https://storage.example/put",
      headers: {},
      expires_at: Date.now() + UPLOAD_LIFETIME_MS,
    };
  };
  await assert.rejects(
    submit,
    (error) => error instanceof OperationError && error.code === NOT_RUNNING,
  );
  const count = h.store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT COUNT(*) AS count FROM mission_evidence")
        .get() as { count: number },
  );
  assert.equal(count.count, NO_ITEMS);
});

test("two storage bindings grant the first", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const second = createIdentity("binding");
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([h.repositoryId, h.storageId, second]), h.node_id),
  );
  const granted: string[] = [];
  h.dependencies.intakeStorage.put = async (_call, input) => {
    granted.push(input.storageBindingId);
    return {
      put_url: "https://storage.example/put",
      headers: {},
      expires_at: Date.now() + UPLOAD_LIFETIME_MS,
    };
  };
  const result = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Object",
      assets: [
        { kind: AssetKind.Object, size: SINGLE_ITEM, media_type: "text/plain" },
      ],
    },
  });
  assert.deepEqual(granted, [h.storageId]);
  const asset = result.evidence.assets[FIRST_ASSET_INDEX]!;
  if (asset.kind !== AssetKind.Object) assert.fail();
  const stored = h.store.transaction(
    (tx) =>
      tx.database
        .prepare("SELECT content FROM mission_evidence_asset WHERE id = ?")
        .get(asset.id) as { content: string },
  );
  assert.equal(JSON.parse(stored.content).storage_binding_id, h.storageId);
});

test("a node with no storage binding answers mission.evidence.storage_binding_absent", async (t) => {
  const h = executionHarness(t, IDENTITY);
  await assert.rejects(
    h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.context,
        subject: "Object",
        assets: [
          {
            kind: AssetKind.Object,
            size: SINGLE_ITEM,
            media_type: "text/plain",
          },
        ],
      },
    }),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === MissionErrorCode.EvidenceStorageBindingAbsent,
  );
});

function failoverFixture(t: TestContext) {
  const h = evidenceHarness(t, IDENTITY);
  const second = createIdentity("binding");
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([h.repositoryId, h.storageId, second]), h.node_id),
  );
  const resolve = h.dependencies.bindings.getBindingRevision;
  const states = new Map<string, { tombstone: boolean; disabled: boolean }>();
  h.dependencies.bindings.getBindingRevision = (tx, bindingId) => {
    const binding = resolve(tx, bindingId);
    assert.ok(binding);
    return { ...binding, ...states.get(bindingId) };
  };
  const granted: string[] = [];
  const refusals = new Map<string, () => never>();
  h.dependencies.intakeStorage.put = async (_call, input) => {
    granted.push(input.storageBindingId);
    refusals.get(input.storageBindingId)?.();
    return {
      put_url: "https://storage.example/put",
      headers: {},
      expires_at: Date.now() + UPLOAD_LIFETIME_MS,
    };
  };
  const fail = (bindingId: string, attempt: number) =>
    h.store.transaction((tx) =>
      insertUploadFailure(tx, {
        node_id: h.node_id,
        attempt,
        storage_binding_id: bindingId,
        asset_id: createIdentity("evidence_asset"),
        failed_at: FAILED_AT,
      }),
    );
  const submit = () =>
    h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.context,
        subject: "Object",
        assets: [
          {
            kind: AssetKind.Object,
            size: SINGLE_ITEM,
            media_type: "text/plain",
          },
        ],
      },
    });
  const pinned = (result: Awaited<ReturnType<typeof submit>>) => {
    const asset = result.evidence.assets[FIRST_ASSET_INDEX]!;
    if (asset.kind !== AssetKind.Object) assert.fail();
    return asset.storage_binding_id;
  };
  const evidenceCount = () =>
    h.store.transaction(
      (tx) =>
        (
          tx.database
            .prepare("SELECT COUNT(*) AS count FROM mission_evidence")
            .get() as { count: number }
        ).count,
    );
  return {
    ...h,
    second,
    states,
    granted,
    refusals,
    fail,
    submit,
    pinned,
    evidenceCount,
  };
}

test("an unavailable first binding grants the second", async (t) => {
  const h = failoverFixture(t);
  h.states.set(h.storageId, { tombstone: false, disabled: true });
  assert.equal(h.pinned(await h.submit()), h.second);
  assert.deepEqual(h.granted, [h.second]);
});

test("a removed first binding grants the second", async (t) => {
  const h = failoverFixture(t);
  h.states.set(h.storageId, { tombstone: true, disabled: false });
  assert.equal(h.pinned(await h.submit()), h.second);
  assert.deepEqual(h.granted, [h.second]);
});

test("a disabled or removed binding at the signing call grants the next binding", async (t) => {
  for (const reason of [
    AuthorizationRefusal.BindingDisabled,
    AuthorizationRefusal.BindingRemoved,
  ]) {
    const h = failoverFixture(t);
    h.refusals.set(h.storageId, () => authorizationRefused(reason));
    assert.equal(h.pinned(await h.submit()), h.second);
    assert.deepEqual(h.granted, [h.storageId, h.second]);
  }
});

test("an s3 failure of the signing call grants the next binding", async (t) => {
  const h = failoverFixture(t);
  h.refusals.set(h.storageId, () => {
    throw new OperationError(
      BAD_GATEWAY,
      S3_RESULT_CODE_PREFIX + ResultClass.RetryableRefusal,
      "The store refuses.",
    );
  });
  assert.equal(h.pinned(await h.submit()), h.second);
  assert.deepEqual(h.granted, [h.storageId, h.second]);
});

test("a lost claim during signing stops with no failover", async (t) => {
  const h = failoverFixture(t);
  h.refusals.set(h.storageId, () =>
    authorizationRefused(AuthorizationRefusal.ClaimNotLive),
  );
  await assert.rejects(h.submit, {
    code: MissionErrorCode.AuthorizationRefused,
    details: { reason: AuthorizationRefusal.ClaimNotLive },
  });
  assert.deepEqual(h.granted, [h.storageId]);
  assert.equal(h.evidenceCount(), NO_ITEMS);
});

test("a binding with a failure row of the attempt is skipped", async (t) => {
  const h = failoverFixture(t);
  h.fail(h.storageId, h.claim.attempt);
  assert.equal(h.pinned(await h.submit()), h.second);
  assert.deepEqual(h.granted, [h.second]);
});

test("a failure row of another attempt leaves every binding grantable", async (t) => {
  const h = failoverFixture(t);
  h.fail(h.storageId, SECOND_ATTEMPT);
  assert.equal(h.pinned(await h.submit()), h.storageId);
  assert.deepEqual(h.granted, [h.storageId]);
});

test("no binding left answers mission.evidence.storage_exhausted", async (t) => {
  const h = failoverFixture(t);
  const exhausted = (bindings: string[]) => ({
    status: HttpStatus.Conflict,
    code: MissionErrorCode.EvidenceStorageExhausted,
    details: { node_id: h.node_id, attempt: h.claim.attempt, bindings },
  });
  h.states.set(h.storageId, { tombstone: false, disabled: true });
  h.fail(h.second, h.claim.attempt);
  await assert.rejects(h.submit, exhausted([h.second]));
  assert.deepEqual(h.granted, []);
  h.fail(h.storageId, h.claim.attempt);
  h.states.clear();
  await assert.rejects(h.submit, exhausted([h.storageId, h.second]));
  assert.equal(h.evidenceCount(), NO_ITEMS);
});

test("an exhausted answer with no failure row lists no binding", async (t) => {
  const h = failoverFixture(t);
  h.states.set(h.storageId, { tombstone: false, disabled: true });
  h.states.set(h.second, { tombstone: false, disabled: true });
  const exhausted = {
    code: MissionErrorCode.EvidenceStorageExhausted,
    details: { node_id: h.node_id, attempt: h.claim.attempt, bindings: [] },
  };
  await assert.rejects(h.submit, exhausted);
  assert.deepEqual(h.granted, []);
  h.states.clear();
  for (const id of [h.storageId, h.second])
    h.refusals.set(id, () =>
      authorizationRefused(AuthorizationRefusal.BindingRemoved),
    );
  await assert.rejects(h.submit, exhausted);
  assert.deepEqual(h.granted, [h.storageId, h.second]);
});

test("a cancelled context during signing stops with no failover", async (t) => {
  const h = failoverFixture(t);
  const context = new CancellationContext(background);
  h.caller.context = context;
  h.refusals.set(h.storageId, () => {
    context.cancel();
    throw new OperationError(
      BAD_GATEWAY,
      S3_RESULT_CODE_PREFIX + ResultClass.UnknownOutcome,
      "The store fails.",
    );
  });
  await assert.rejects(h.submit, {
    code: S3_RESULT_CODE_PREFIX + ResultClass.UnknownOutcome,
  });
  assert.deepEqual(h.granted, [h.storageId]);
  assert.equal(h.evidenceCount(), NO_ITEMS);
});
