import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  AssetKind,
  MissionErrorCode,
  PlatformAddressKind,
  AssessmentResult,
} from "./contract.ts";
import {
  insertEvidence,
  insertAssessment,
  insertOutcome,
} from "./record-store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_ATTEMPT = 1;
const DATA = "aGk=";
const FIRST_ASSET_INDEX = 0;
const VERSION = "v1";
const NOT_RUNNING = MissionErrorCode.AuthorizationRefused;
const Change = {
  Publish: "publish",
  Delete: "delete",
  Claim: "claim",
} as const;

test("initiative content bound includes only evidence of current child outcomes", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const submit = () =>
    h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.context,
        subject: "Content",
        assets: [
          {
            kind: AssetKind.Produced,
            content: {
              media_type: "text/plain",
              encoding: "base64",
              data: DATA,
            },
          },
        ],
      },
    });
  const named = await submit();
  const unreferenced = await submit();
  h.store.transaction((tx) => {
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Blocked",
      evidence_ids: canonicalJSON([named.evidence.id]),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_ATTEMPT,
      created_at: FIRST_ATTEMPT,
    });
    insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.node_id,
      assessment_id: assessmentId,
      result: AssessmentResult.Undetermined,
      evidence_ids: "[]",
      created_at: FIRST_ATTEMPT,
    });
  });
  h.claim.nodeId = h.node().parent_id!;
  const read = (assetId: string) =>
    h.invoke("execution.evidence.asset.content.get", {
      params: { asset_id: assetId, execution_id: h.claim.executionId },
      query: {},
      body: null,
    });
  const included = await read(named.evidence.assets[FIRST_ASSET_INDEX]!.id);
  assert.ok("data" in included);
  assert.equal(included.data, DATA);
  await assert.rejects(
    read(unreferenced.evidence.assets[FIRST_ASSET_INDEX]!.id),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(FIRST_ATTEMPT, h.node_id),
  );
  await assert.rejects(
    read(named.evidence.assets[FIRST_ASSET_INDEX]!.id),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
});

test("content signing repeats after publication and never releases a URL after deletion or claim loss", async (t) => {
  for (const change of Object.values(Change)) {
    const h = evidenceHarness(t, IDENTITY);
    h.dependencies.intakeStorage.put = async () => ({
      put_url: "https://example.com/put",
      headers: {},
      expires_at: Date.now() + FIRST_ATTEMPT,
    });
    const submitted = await h.invoke("evidence.submit", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.context,
        subject: "Object",
        assets: [
          {
            kind: AssetKind.Object,
            media_type: "text/plain",
            size: FIRST_ATTEMPT,
          },
        ],
      },
    });
    const assetId = submitted.evidence.assets[FIRST_ASSET_INDEX]!.id;
    const versions: (string | null)[] = [];
    h.dependencies.intakeStorage.executionGet = async (call, received) => {
      assert.equal(call.executionId, h.claim.executionId);
      assert.equal(received, assetId);
      const version = h.store.transaction(
        (tx) =>
          (
            JSON.parse(
              (
                tx.database
                  .prepare(
                    "SELECT content FROM mission_evidence_asset WHERE id = ?",
                  )
                  .get(assetId) as { content: string }
              ).content,
            ) as { object_version?: string }
          ).object_version ?? null,
      );
      versions.push(version);
      if (change === Change.Publish)
        h.store.transaction((tx) =>
          tx.database
            .prepare(
              "UPDATE mission_evidence_asset SET content = json_set(content, '$.object_version', ?), published_at = ? WHERE id = ?",
            )
            .run(VERSION, FIRST_ATTEMPT, assetId),
        );
      if (change === Change.Delete)
        h.store.transaction((tx) =>
          tx.database
            .prepare("DELETE FROM mission_evidence_asset WHERE id = ?")
            .run(assetId),
        );
      if (change === Change.Claim)
        h.dependencies.schedulerClaims.liveExecutionOf = () => null;
      return {
        get_url: `https://example.com/${version ?? "latest"}`,
        expires_at: FIRST_ATTEMPT,
      };
    };
    const read = () =>
      h.invoke("execution.evidence.asset.content.get", {
        params: { asset_id: assetId, execution_id: h.claim.executionId },
        query: {},
        body: null,
      });
    if (change !== Change.Publish) {
      await assert.rejects(
        read(),
        (error) =>
          error instanceof OperationError &&
          error.code ===
            (change === Change.Delete
              ? MissionErrorCode.RecordNotFound
              : NOT_RUNNING),
      );
      continue;
    }
    const result = await read();
    assert.ok(result.address.kind === AssetKind.Object && "get_url" in result);
    assert.equal(result.address.version, VERSION);
    assert.equal(result.get_url, `https://example.com/${VERSION}`);
    assert.deepEqual(versions, [null, VERSION]);
  }
});

test("content reads return inline bytes or sign the object asset with the correct reader seam", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const inline = await h.invoke("evidence.submit", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.context,
      subject: "Bytes",
      assets: [
        {
          kind: AssetKind.Produced,
          content: { media_type: "text/plain", encoding: "base64", data: DATA },
        },
      ],
    },
  });
  const assetId = inline.evidence.assets[0]!.id;
  const human = await h.invoke("evidence.asset.content.get", {
    params: { asset_id: assetId },
    query: {},
    body: null,
  });
  assert.ok("data" in human);
  assert.equal(human.data, DATA);
  assert.deepEqual(human.address, inline.evidence.assets[0]!.address);
  for (const objectVersion of [undefined, "version"]) {
    const id = createIdentity("evidence");
    const objectId = createIdentity("evidence_asset");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id,
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
          subject: "Object",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: FIRST_ATTEMPT,
        },
        [
          {
            id: objectId,
            evidence_id: id,
            kind: AssetKind.Object,
            content: canonicalJSON({
              location: "s3://bucket/key",
              size: FIRST_ATTEMPT,
              media_type: "text/plain",
              storage_binding_id: h.storageId,
              ...(objectVersion ? { object_version: objectVersion } : {}),
            }),
            published_at: FIRST_ATTEMPT,
            expired_at: null,
          },
        ],
      ),
    );
    const signed = {
      get_url: "https://storage.example/get",
      expires_at: FIRST_ATTEMPT,
    };
    const calls: unknown[] = [];
    h.dependencies.intakeStorage.get = async (call, received) => {
      calls.push(["get", received, "executionId" in call]);
      return signed;
    };
    h.dependencies.intakeStorage.executionGet = async (call, received) => {
      calls.push(["executionGet", received, call.executionId]);
      return signed;
    };
    await h.invoke("evidence.asset.content.get", {
      params: { asset_id: objectId },
      query: {},
      body: null,
    });
    await h.invoke("execution.evidence.asset.content.get", {
      params: { asset_id: objectId, execution_id: h.claim.executionId },
      query: {},
      body: null,
    });
    assert.deepEqual(calls, [
      ["get", objectId, false],
      ["executionGet", objectId, h.claim.executionId],
    ]);
  }
});

test("external addresses answer typed conflicts only after the execution bound and deleted assets answer not found", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  for (const [kind, content, code] of [
    [
      AssetKind.Repository,
      {
        kind: AssetKind.Repository,
        binding_id: h.repositoryId,
        commit: "a".repeat(40),
      },
      MissionErrorCode.EvidenceContentRepository,
    ],
    [
      AssetKind.Platform,
      {
        kind: PlatformAddressKind.PullRequest,
        resource_identity: "repository:github:owner/repo",
        number: FIRST_ATTEMPT,
      },
      MissionErrorCode.EvidenceContentPlatform,
    ],
  ] as const) {
    const evidenceId = createIdentity("evidence");
    const assetId = createIdentity("evidence_asset");
    h.store.transaction((tx) =>
      insertEvidence(
        tx,
        {
          id: evidenceId,
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
          subject: "Address",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: FIRST_ATTEMPT,
        },
        [
          {
            id: assetId,
            evidence_id: evidenceId,
            kind,
            content: canonicalJSON(content),
            published_at: FIRST_ATTEMPT,
            expired_at: null,
          },
        ],
      ),
    );
    await assert.rejects(
      h.invoke("evidence.asset.content.get", {
        params: { asset_id: assetId },
        query: {},
        body: null,
      }),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, code);
        assert.deepEqual(error.details, {
          evidence_id: evidenceId,
          address: content,
        });
        return true;
      },
    );
    h.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_evidence SET attempt = 0 WHERE id = ?")
        .run(evidenceId),
    );
    await assert.rejects(
      h.invoke("execution.evidence.asset.content.get", {
        params: { asset_id: assetId, execution_id: h.claim.executionId },
        query: {},
        body: null,
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.RecordNotFound,
    );
    const parentId = h.node().parent_id!;
    h.store.transaction((tx) =>
      tx.database
        .prepare(
          "UPDATE mission_evidence SET attempt = 1, node_id = ? WHERE id = ?",
        )
        .run(parentId, evidenceId),
    );
    await assert.rejects(
      h.invoke("execution.evidence.asset.content.get", {
        params: { asset_id: assetId, execution_id: h.claim.executionId },
        query: {},
        body: null,
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.RecordNotFound,
    );
    h.store.transaction((tx) =>
      tx.database
        .prepare("DELETE FROM mission_evidence_asset WHERE id = ?")
        .run(assetId),
    );
    await assert.rejects(
      h.invoke("evidence.asset.content.get", {
        params: { asset_id: assetId },
        query: {},
        body: null,
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.RecordNotFound,
    );
  }
});
