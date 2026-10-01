import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { MissionErrorCode } from "./contract.ts";
import { getRevision } from "./node-read.ts";
import { insertRevision } from "./store.ts";
import { evidenceHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const PINNED = "Pinned";

test("execution revision reads carry the pinned tasks and exclude later human revisions from every page", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.nodeId, ONE);
    insertRevision(tx, {
      ...revision,
      revision: TWO,
      content: { ...revision.content, name: PINNED },
      tasks: [
        {
          id: createIdentity("node"),
          filename: "task.md",
          content: { ...revision.content, bindings: [] },
        },
      ],
    });
    insertRevision(tx, { ...revision, revision: THREE });
    tx.database
      .prepare(
        "UPDATE mission_attempt SET node_revision = ? WHERE node_id = ? AND attempt = ?",
      )
      .run(TWO, h.nodeId, ONE);
  });
  h.claim.pinnedRevision = TWO;
  const pinned = await h.invoke("execution.pinnedRevision.get", {
    params: { executionId: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.equal(pinned.revision, TWO);
  assert.equal(pinned.content.name, PINNED);
  assert.equal(pinned.tasks?.length, ONE);
  const first = await h.invoke("execution.revision.list", {
    params: { executionId: h.claim.executionId },
    query: { limit: ONE },
    body: null,
  });
  assert.equal(first.items[ZERO]!.revision, TWO);
  const second = await h.invoke("execution.revision.list", {
    params: { executionId: h.claim.executionId },
    query: { cursor: first.nextCursor, limit: ONE },
    body: null,
  });
  assert.equal(second.items[ZERO]!.revision, ONE);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    h.invoke("execution.revision.get", {
      params: { executionId: h.claim.executionId, revision: THREE },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ExecutionRevisionAbovePin,
  );
});
