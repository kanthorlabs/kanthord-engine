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
const ONE = 1;
const DATA = "aGk=";
const KEY = "key";
const ZERO = 0;
const VERSION = "v1";
const NOT_RUNNING = "scheduler.execution.not_running";
const Change = {
  Publish: "publish",
  Delete: "delete",
  Claim: "claim",
} as const;

test("initiative content bound includes only evidence of current child outcomes", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const submit = () =>
    h.invoke("evidence.submit", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.context,
        subject: "Content",
        assets: [
          {
            kind: AssetKind.Produced,
            content: {
              mediaType: "text/plain",
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
      node_id: h.nodeId,
      attempt: ONE,
      result: AssessmentResult.Undetermined,
      rationale: "Blocked",
      evidence_ids: canonicalJSON([named.evidence.id]),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: ONE,
      created_at: ONE,
    });
    insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: h.nodeId,
      assessment_id: assessmentId,
      result: AssessmentResult.Undetermined,
      evidence_ids: "[]",
      created_at: ONE,
    });
  });
  h.claim.nodeId = h.node().parent_id!;
  const read = (assetId: string) =>
    h.invoke("execution.evidence.asset.content.get", {
      params: { assetId, executionId: h.claim.executionId },
      query: {},
      body: null,
    });
  const included = await read(named.evidence.assets[ZERO]!.id);
  assert.ok("data" in included);
  assert.equal(included.data, DATA);
  await assert.rejects(
    read(unreferenced.evidence.assets[ZERO]!.id),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(ONE, h.nodeId),
  );
  await assert.rejects(
    read(named.evidence.assets[ZERO]!.id),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
});

test("content signing repeats after publication and never releases a URL after deletion or claim loss", async (t) => {
  for (const change of Object.values(Change)) {
    const h = evidenceHarness(t, IDENTITY);
    h.dependencies.intakeStorage.put = async () => ({
      putUrl: "https://example.com/put",
      headers: {},
      expiresAt: Date.now() + ONE,
    });
    const submitted = await h.invoke("evidence.submit", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.context,
        subject: "Object",
        assets: [
          { kind: AssetKind.Object, mediaType: "text/plain", size: ONE },
        ],
      },
    });
    const assetId = submitted.evidence.assets[ZERO]!.id;
    const versions: (string | null)[] = [];
    h.dependencies.intakeStorage.executionGet = async (
      _call,
      _binding,
      _key,
      version,
    ) => {
      versions.push(version);
      if (change === Change.Publish)
        h.store.transaction((tx) =>
          tx.database
            .prepare(
              "UPDATE mission_evidence_asset SET content = json_set(content, '$.objectVersion', ?), published_at = ? WHERE id = ?",
            )
            .run(VERSION, ONE, assetId),
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
        getUrl: `https://example.com/${version ?? "latest"}`,
        expiresAt: ONE,
      };
    };
    const read = () =>
      h.invoke("execution.evidence.asset.content.get", {
        params: { assetId, executionId: h.claim.executionId },
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
    assert.ok(result.address.kind === AssetKind.Object && "getUrl" in result);
    assert.equal(result.address.version, VERSION);
    assert.equal(result.getUrl, `https://example.com/${VERSION}`);
    assert.deepEqual(versions, [null, VERSION]);
  }
});

test("content reads return inline bytes or sign only the recorded object version with the correct reader seam", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const inline = await h.invoke("evidence.submit", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.context,
      subject: "Bytes",
      assets: [
        {
          kind: AssetKind.Produced,
          content: { mediaType: "text/plain", encoding: "base64", data: DATA },
        },
      ],
    },
  });
  const assetId = inline.evidence.assets[0]!.id;
  const human = await h.invoke("evidence.asset.content.get", {
    params: { assetId },
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
          node_id: h.nodeId,
          attempt: ONE,
          subject: "Object",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: ONE,
        },
        [
          {
            id: objectId,
            evidence_id: id,
            kind: AssetKind.Object,
            content: canonicalJSON({
              location: "s3://bucket/key",
              size: ONE,
              mediaType: "text/plain",
              storageBindingId: h.storageId,
              ...(objectVersion ? { objectVersion } : {}),
            }),
            published_at: ONE,
            expired_at: null,
          },
        ],
      ),
    );
    const calls: string[] = [];
    for (const method of ["get", "executionGet"] as const)
      h.dependencies.intakeStorage[method] = async (
        _call,
        _binding,
        key,
        version,
      ) => {
        calls.push(method);
        assert.equal(key, KEY);
        assert.equal(version, objectVersion ?? null);
        return { getUrl: "https://storage.example/get", expiresAt: ONE };
      };
    await h.invoke("evidence.asset.content.get", {
      params: { assetId: objectId },
      query: {},
      body: null,
    });
    await h.invoke("execution.evidence.asset.content.get", {
      params: { assetId: objectId, executionId: h.claim.executionId },
      query: {},
      body: null,
    });
    assert.deepEqual(calls, ["get", "executionGet"]);
  }
});

test("external addresses answer typed conflicts only after the execution bound and deleted assets answer not found", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  for (const [kind, content, code] of [
    [
      AssetKind.Repository,
      {
        kind: AssetKind.Repository,
        bindingId: h.repositoryId,
        commit: "a".repeat(40),
      },
      MissionErrorCode.EvidenceContentRepository,
    ],
    [
      AssetKind.Platform,
      {
        kind: PlatformAddressKind.PullRequest,
        resourceIdentity: "repository:github:owner/repo",
        number: ONE,
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
          node_id: h.nodeId,
          attempt: ONE,
          subject: "Address",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: ONE,
        },
        [
          {
            id: assetId,
            evidence_id: evidenceId,
            kind,
            content: canonicalJSON(content),
            published_at: ONE,
            expired_at: null,
          },
        ],
      ),
    );
    await assert.rejects(
      h.invoke("evidence.asset.content.get", {
        params: { assetId },
        query: {},
        body: null,
      }),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, code);
        assert.deepEqual(error.details, { evidenceId, address: content });
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
        params: { assetId, executionId: h.claim.executionId },
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
        params: { assetId, executionId: h.claim.executionId },
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
        params: { assetId },
        query: {},
        body: null,
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === MissionErrorCode.RecordNotFound,
    );
  }
});
