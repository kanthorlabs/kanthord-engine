import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { AssetKind, MissionErrorCode, NodeKind } from "./contract.ts";
import { insertEvidence } from "./record-store.ts";
import { insertNode } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ZERO = 0;
const ONE = 1;
const TWO = 2;
const KEY = "repo.pull_request";
const CONTROL_TASK = "mission.node.control_task";

test("evidence reads paginate descending identities, include attempt zero and preserve pending request fields", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const ids = [createIdentity("evidence"), createIdentity("evidence")].sort();
  h.store.transaction((tx) => {
    for (const [index, id] of ids.entries())
      insertEvidence(
        tx,
        {
          id,
          node_id: h.nodeId,
          attempt: index,
          subject: "Evidence",
          requirement_key: index === ONE ? KEY : null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: ONE,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Object,
            content: canonicalJSON({
              location: "s3://bucket/key",
              size: ZERO,
              mediaType: "text/plain",
              storageBindingId: h.storageId,
            }),
            published_at: null,
            expired_at: TWO,
          },
        ],
      );
  });
  const page = (query: object) =>
    h.invoke("evidence.list", {
      params: { nodeId: h.nodeId },
      query,
      body: null,
    });
  const first = await page({ limit: ONE });
  assert.equal(first.items[ZERO]!.id, ids[ONE]);
  assert.equal(first.items[ZERO]!.requirementKey, KEY);
  assert.equal(first.items[ZERO]!.endState, undefined);
  assert.equal(first.items[ZERO]!.assets[ZERO]!.publishedAt, null);
  const second = await page({ cursor: first.nextCursor });
  assert.equal(second.items[ZERO]!.id, ids[ZERO]);
  assert.equal(second.nextCursor, null);
  assert.equal((await page({ attempt: ZERO })).items.length, ONE);
  const read = await h.invoke("evidence.get", {
    params: { evidenceId: ids[ONE] },
    query: {},
    body: null,
  });
  assert.deepEqual(read, first.items[ZERO]);
  await assert.rejects(
    page({ cursor: "invalid" }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.CursorInvalid,
  );
});

test("evidence reads refuse tasks and absent nodes or records", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const task = createIdentity("node");
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: task,
      mission_id: h.missionId,
      kind: NodeKind.Task,
      filename: "task.md",
      parent_id: h.nodeId,
      created_at: ONE,
    }),
  );
  for (const [nodeId, code] of [
    [task, CONTROL_TASK],
    [createIdentity("node"), MissionErrorCode.NodeNotFound],
  ])
    await assert.rejects(
      h.invoke("evidence.list", { params: { nodeId }, query: {}, body: null }),
      (error) => error instanceof OperationError && error.code === code,
    );
  await assert.rejects(
    h.invoke("evidence.get", {
      params: { evidenceId: createIdentity("evidence") },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
});
