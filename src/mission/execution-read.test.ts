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
const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const PINNED = "Pinned";
const PINNED_FILENAME = "initiative.md";

test("initiative reads use outcome revisions, include discarded children, minimize new children and exclude retired children", async (t) => {
  const h = executionHarness(t, IDENTITY);
  const childId = createIdentity("node");
  const freshId = createIdentity("node");
  const outcomeId = createIdentity("outcome");
  const evidenceId = createIdentity("evidence");
  h.store.transaction((tx) => {
    const base = getRevision(tx, h.nodeId, ONE);
    for (const id of [childId, freshId]) {
      insertNode(tx, {
        id,
        mission_id: h.missionId,
        kind: NodeKind.Objective,
        filename: `${id.toLowerCase()}.md`,
        parent_id: h.nodeId,
        created_at: ONE,
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
        attempt: ZERO,
        subject: "Historical",
        requirement_key: null,
        end_state: null,
        verification: null,
        provenance: canonicalJSON(h.actor),
        created_at: ONE,
      },
      [],
    );
    const assessmentId = createIdentity("assessment");
    insertAssessment(tx, {
      id: assessmentId,
      node_id: childId,
      attempt: ZERO,
      result: AssessmentResult.Undetermined,
      rationale: "Discard",
      evidence_ids: canonicalJSON([evidenceId]),
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: ONE,
      created_at: ONE,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: childId,
      result: AssessmentResult.Undetermined,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: ONE,
    });
    insertRevision(tx, {
      ...base,
      nodeId: childId,
      revision: TWO,
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
  assert.equal(child.visibleRevision, ONE);
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
      .run(THREE, childId),
  );
  assert.equal(
    (await h.invoke("execution.objective.list", input)).items.length,
    ONE,
  );
  assert.equal(
    (await h.invoke("execution.objective.outcome.list", input)).items.length,
    ZERO,
  );
  assert.equal(
    (await h.invoke("execution.objective.evidence.list", input)).items.length,
    ZERO,
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
      attempt: ONE,
      result: AssessmentResult.Undetermined,
      rationale: "Blocked",
      evidence_ids: "[]",
      child_outcome_ids: "[]",
      tested_input: null,
      execution_id: null,
      actor: canonicalJSON(h.actor),
      node_revision: ONE,
      created_at: ONE,
    });
    insertOutcome(tx, {
      id: outcomeId,
      node_id: h.nodeId,
      result: AssessmentResult.Undetermined,
      assessment_id: assessmentId,
      evidence_ids: "[]",
      created_at: ONE,
    });
    closeAttempt(tx, h.nodeId, ONE, TWO);
    openAttempt(tx, h.nodeId, ONE, h.actor, THREE);
    for (const attempt of [ONE, TWO])
      insertEvidence(
        tx,
        {
          id: attempt === TWO ? currentId : createIdentity("evidence"),
          node_id: h.nodeId,
          attempt,
          subject: "Attempt evidence",
          requirement_key: null,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.executionActor),
          created_at: THREE,
        },
        [],
      );
  });
  h.claim.attempt = TWO;
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
