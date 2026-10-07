import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  NodeState,
  UPLOAD_LIFETIME_MS,
  type EvidenceSubmit,
} from "./contract.ts";
import { evidenceHarness, executionHarness } from "./test-support.ts";
import { setNodeState } from "./store.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const SUCCESSFUL_EXIT_CODE = 0;
const FIRST_ASSET_INDEX = 0;
const NO_ITEMS = 0;
const SINGLE_ITEM = 1;
const NOT_RUNNING = MissionErrorCode.AuthorizationRefused;
const VALIDATION = "gateway.request.validation_failed";
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
      testedInput: {
        kind: AssetKind.Repository,
        bindingId: h.repositoryId,
        commit: "a".repeat(40),
      },
      results: [
        {
          command: field === Field.Command ? long : "true",
          signal: field === Field.Signal ? long : null,
          exitCode: SUCCESSFUL_EXIT_CODE,
          timedOut: false,
        },
      ],
    };
    await assert.rejects(
      h.invoke("evidence.submit", {
        params: { nodeId: h.nodeId },
        query: {},
        body: {
          ...h.context,
          subject,
          verification,
          assets: [
            {
              kind: AssetKind.Object,
              size: SINGLE_ITEM,
              mediaType: "text/plain",
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
          bindingId: h.repositoryId,
          commit: "a".repeat(40),
        },
      },
      {
        kind: AssetKind.Produced,
        content: { mediaType: "text/plain", encoding: "base64", data: "aGk=" },
      },
    ],
  };
  const submit = () =>
    h.invoke("evidence.submit", {
      params: { nodeId: h.nodeId },
      query: {},
      body,
    });
  const first = await submit();
  assert.equal(first.uploads.length, NO_ITEMS);
  assert.ok(first.evidence.assets.every((asset) => asset.publishedAt !== null));
  assert.deepEqual(first.evidence.provenance, h.executionActor);
  const produced = first.evidence.assets.find(
    (asset) => asset.kind === AssetKind.Produced,
  )!;
  assert.deepEqual(produced.address, {
    kind: AssetKind.Produced,
    sha256: createHash("sha256").update("hi").digest("hex"),
  });
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  assert.notEqual((await submit()).evidence.id, first.evidence.id);
});

test("object submissions sign pinned keys and commit pending assets after PUT preparation", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const sha256 = "b".repeat(64);
  h.dependencies.intakeStorage.put = async (
    _call,
    binding,
    key,
    size,
    checksum,
  ) => {
    assert.deepEqual(binding, h.storage);
    assert.ok(
      key.startsWith(
        `prefix/${h.projectId}/${h.missionId}/${h.nodeId}/1/evidence_asset_`,
      ),
    );
    assert.equal(size, SINGLE_ITEM);
    assert.equal(checksum, sha256);
    return {
      putUrl: "https://storage.example/put",
      headers: { checksum: sha256 },
      expiresAt: Date.now() + UPLOAD_LIFETIME_MS,
    };
  };
  const result = await h.invoke("evidence.submit", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      subject: "Object",
      assets: [
        {
          kind: AssetKind.Object,
          size: SINGLE_ITEM,
          mediaType: "text/plain",
          sha256,
        },
      ],
    },
  });
  assert.equal(result.uploads.length, SINGLE_ITEM);
  const asset = result.evidence.assets[FIRST_ASSET_INDEX]!;
  assert.equal(asset.publishedAt, null);
  assert.equal(
    asset.expiredAt! - result.evidence.createdAt,
    UPLOAD_LIFETIME_MS,
  );
  assert.equal(result.uploads[FIRST_ASSET_INDEX]!.assetId, asset.id);
});

test("storage absence, failed signing and revoked claims write no evidence", async (t) => {
  const empty = executionHarness(t, IDENTITY);
  const body = {
    ...empty.context,
    subject: "Object",
    assets: [
      { kind: AssetKind.Object, size: SINGLE_ITEM, mediaType: "text/plain" },
    ],
  };
  await assert.rejects(
    empty.invoke("evidence.submit", {
      params: { nodeId: empty.nodeId },
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
      params: { nodeId: h.nodeId },
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
      putUrl: "https://storage.example/put",
      headers: {},
      expiresAt: Date.now() + UPLOAD_LIFETIME_MS,
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
