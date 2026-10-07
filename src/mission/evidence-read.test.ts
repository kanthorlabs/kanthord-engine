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
const FIRST_ITEM_INDEX = 0;
const EMPTY_OBJECT_SIZE = 0;
const NO_ATTEMPT = 0;
const SECOND_ITEM_INDEX = 1;
const CREATED_AT = 1;
const SINGLE_RESULT = 1;
const FUTURE_EXPIRY = 2;
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
          node_id: h.node_id,
          attempt: index,
          subject: "Evidence",
          requirement_key: index === SECOND_ITEM_INDEX ? KEY : null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: CREATED_AT,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: id,
            kind: AssetKind.Object,
            content: canonicalJSON({
              location: "s3://bucket/key",
              size: EMPTY_OBJECT_SIZE,
              media_type: "text/plain",
              storage_binding_id: h.storageId,
            }),
            published_at: null,
            expired_at: FUTURE_EXPIRY,
          },
        ],
      );
  });
  const page = (query: object) =>
    h.invoke("evidence.list", {
      params: { node_id: h.node_id },
      query,
      body: null,
    });
  const first = await page({ limit: SINGLE_RESULT });
  assert.equal(first.items[FIRST_ITEM_INDEX]!.id, ids[SECOND_ITEM_INDEX]);
  assert.equal(first.items[FIRST_ITEM_INDEX]!.requirement_key, KEY);
  assert.equal(first.items[FIRST_ITEM_INDEX]!.end_state, undefined);
  assert.equal(
    first.items[FIRST_ITEM_INDEX]!.assets[FIRST_ITEM_INDEX]!.published_at,
    null,
  );
  const second = await page({ cursor: first.next_cursor });
  assert.equal(second.items[FIRST_ITEM_INDEX]!.id, ids[FIRST_ITEM_INDEX]);
  assert.equal(second.next_cursor, null);
  assert.equal(
    (await page({ attempt: NO_ATTEMPT })).items.length,
    SINGLE_RESULT,
  );
  const read = await h.invoke("evidence.get", {
    params: { evidence_id: ids[SECOND_ITEM_INDEX] },
    query: {},
    body: null,
  });
  assert.deepEqual(read, first.items[FIRST_ITEM_INDEX]);
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
      mission_id: h.mission_id,
      kind: NodeKind.Task,
      filename: "task.md",
      parent_id: h.node_id,
      created_at: CREATED_AT,
    }),
  );
  for (const [nodeId, code] of [
    [task, CONTROL_TASK],
    [createIdentity("node"), MissionErrorCode.NodeNotFound],
  ])
    await assert.rejects(
      h.invoke("evidence.list", {
        params: { node_id: nodeId },
        query: {},
        body: null,
      }),
      (error) => error instanceof OperationError && error.code === code,
    );
  await assert.rejects(
    h.invoke("evidence.get", {
      params: { evidence_id: createIdentity("evidence") },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
});
