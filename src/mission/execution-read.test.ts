import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import {
  MissionErrorCode,
  AssessmentResult,
  NodeKind,
  NodeState,
} from "./contract.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  closeAttempt,
  openAttempt,
  insertEvidence,
  insertAssessment,
  insertOutcome,
} from "./record-store.ts";
import { getRevision } from "./node-read.ts";
import { insertRevision, insertNode, setNodeState } from "./store.ts";
import { evidenceHarness, executionHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NO_ATTEMPT = 0;
const NO_ITEMS = 0;
const FIRST_ITEM_INDEX = 0;
const FIRST_REVISION = 1;
const CREATED_AT = 1;
const FIRST_ATTEMPT = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const CLOSE_AT = 2;
const SECOND_ATTEMPT = 2;
const LATER_TS = 3;
const THIRD_REVISION = 3;
const PINNED = "Pinned";
const PINNED_FILENAME = "initiative.md";

test("initiative reads use outcome revisions, include discarded children, minimize new children and exclude retired children", async (t) => {
  const h = executionHarness(t, IDENTITY);
  const childId = createIdentity("node");
  const freshId = createIdentity("node");
  const outcomeId = createIdentity("outcome");
  const evidenceId = createIdentity("evidence");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.nodeId, FIRST_REVISION);
    for (const id of [childId, freshId]) {
      insertNode(tx, {
        id,
        mission_id: h.missionId,
        kind: NodeKind.Objective,
        filename: `${id.toLowerCase()}.md`,
        parent_id: h.nodeId,
        created_at: CREATED_AT,
      });
      insertRevision(tx, {
        ...base,
        nodeId: id,
        content: { ...base.content, name: PINNED },
        tasks: [],
      });
    }
    setNodeState(tx, childId, NodeState.Discarded);
    insertEvidence(
      tx,
      {
        id: evidenceId,
        node_id: childId,
        attempt: NO_ATTEMPT,
        subject: "Historical",
        requirement_key: null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.actor),
        created_at: CREATED_AT,
      },
      [],
    );
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: childId,
      attempt: NO_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Discard",
      evidence_ids: canonicalJSON([evidenceId]),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_REVISION,
      created_at: CREATED_AT,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: childId,
      result: AssessmentResult.Undetermined,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: CREATED_AT,
    });
    insertRevision(tx, {
      ...base,
      nodeId: childId,
      revision: SECOND_REVISION,
      filename: "renamed.md",
      content: { ...base.content, name: "Later" },
      tasks: [],
    });
    tx.database
      .prepare("UPDATE mission_node SET filename = ? WHERE id = ?")
      .run("renamed.md", childId);
  });
  const input = {
    params: { executionId: h.claim.executionId },
    query: {},
    body: null,
  };
  const page = await h.invoke("execution.objective.list", input);
  const child = page.items.find((item) => item.id === childId)!;
  assert.ok("content" in child);
  assert.equal(child.content.name, PINNED);
  assert.equal(child.visibleRevision, FIRST_REVISION);
  assert.equal(child.filename, PINNED_FILENAME);
  assert.deepEqual(
    page.items.find((item) => item.id === freshId),
    { id: freshId, state: NodeState.Pending },
  );
  assert.deepEqual(
    (await h.invoke("execution.objective.outcome.list", input)).items.map(
      (item) => item.id,
    ),
    [outcomeId],
  );
  assert.deepEqual(
    (await h.invoke("execution.objective.evidence.list", input)).items.map(
      (item) => item.id,
    ),
    [evidenceId],
  );
  h.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(LATER_TS, childId),
  );
  assert.equal(
    (await h.invoke("execution.objective.list", input)).items.length,
    SINGLE_ITEM,
  );
  assert.equal(
    (await h.invoke("execution.objective.outcome.list", input)).items.length,
    NO_ITEMS,
  );
  assert.equal(
    (await h.invoke("execution.objective.evidence.list", input)).items.length,
    NO_ITEMS,
  );
  const objective = evidenceHarness(t, IDENTITY);
  for (const operation of [
    "execution.objective.list",
    "execution.objective.outcome.list",
    "execution.objective.evidence.list",
  ] as const)
    assert.deepEqual(
      await objective.invoke(operation, {
        params: { executionId: objective.claim.executionId },
        query: {},
        body: null,
      }),
      { items: [], nextCursor: null },
    );
});

test("execution evidence is attempt-bound and cleared outcome appears only after a human opens the next attempt", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  const readCleared = () =>
    h.invoke("execution.clearedOutcome.get", {
      params: { executionId: h.claim.executionId },
      query: {},
      body: null,
    });
  await assert.rejects(
    readCleared(),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RecordNotFound,
  );
  const outcomeId = createIdentity("outcome");
  const currentId = createIdentity("evidence");
  h.store.transaction((tx) => {
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: h.nodeId,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Undetermined,
      rationale: "Blocked",
      evidence_ids: "[]",
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: FIRST_REVISION,
      created_at: CREATED_AT,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: h.nodeId,
      result: AssessmentResult.Undetermined,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: CREATED_AT,
    });
    closeAttempt(tx, h.nodeId, FIRST_ATTEMPT, CLOSE_AT);
    openAttempt(tx, h.nodeId, FIRST_REVISION, h.actor, LATER_TS);
    for (const attempt of [FIRST_ATTEMPT, SECOND_ATTEMPT])
      insertEvidence(
        tx,
        {
          id:
            attempt === SECOND_ATTEMPT ? currentId : createIdentity("evidence"),
          node_id: h.nodeId,
          attempt,
          subject: "Attempt evidence",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: LATER_TS,
        },
        [],
      );
  });
  h.claim.attempt = SECOND_ATTEMPT;
  assert.equal((await readCleared()).id, outcomeId);
  const page = await h.invoke("execution.evidence.list", {
    params: { executionId: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.deepEqual(
    page.items.map((item) => item.id),
    [currentId],
  );
});

test("execution revision reads carry the pinned tasks and exclude later human revisions from every page", async (t) => {
  const h = evidenceHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    const revision = getRevision(tx, h.nodeId, FIRST_REVISION);
    insertRevision(tx, {
      ...revision,
      revision: SECOND_REVISION,
      content: { ...revision.content, name: PINNED },
      tasks: [
        {
          id: createIdentity("node"),
          filename: "task.md",
          content: { ...revision.content, bindings: [] },
        },
      ],
    });
    insertRevision(tx, { ...revision, revision: THIRD_REVISION });
    tx.database
      .prepare(
        "UPDATE mission_attempt SET node_revision = ? WHERE node_id = ? AND attempt = ?",
      )
      .run(SECOND_REVISION, h.nodeId, FIRST_ATTEMPT);
  });
  h.claim.pinnedRevision = SECOND_REVISION;
  const pinned = await h.invoke("execution.pinnedRevision.get", {
    params: { executionId: h.claim.executionId },
    query: {},
    body: null,
  });
  assert.equal(pinned.revision, SECOND_REVISION);
  assert.equal(pinned.content.name, PINNED);
  assert.equal(pinned.tasks?.length, SINGLE_ITEM);
  const first = await h.invoke("execution.revision.list", {
    params: { executionId: h.claim.executionId },
    query: { limit: SINGLE_ITEM },
    body: null,
  });
  assert.equal(first.items[FIRST_ITEM_INDEX]!.revision, SECOND_REVISION);
  const second = await h.invoke("execution.revision.list", {
    params: { executionId: h.claim.executionId },
    query: { cursor: first.nextCursor, limit: SINGLE_ITEM },
    body: null,
  });
  assert.equal(second.items[FIRST_ITEM_INDEX]!.revision, FIRST_REVISION);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    h.invoke("execution.revision.get", {
      params: { executionId: h.claim.executionId, revision: THIRD_REVISION },
      query: {},
      body: null,
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ExecutionRevisionAbovePin,
  );
});
