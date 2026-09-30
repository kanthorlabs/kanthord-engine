import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  AssessmentResult,
  ClosingEvent,
  NodeKind,
  NodeState,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { openAttempt, insertEvidence } from "./record-store.ts";
import {
  insertNode,
  insertDependency,
  setNodeState,
  readNode,
} from "./store.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NOW = 100;
const ZERO = 0;
const FIRST = 1;
const REVOKE = "schedulerClaims.revoke";

for (const attempt of [ZERO, FIRST]) {
  test(`block at attempt ${attempt} writes a human outcome; discard from Blocked closes nothing again`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      if (attempt > ZERO) openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
      setNodeState(tx, h.nodeId, NodeState.Paused);
    });
    const blocked = await h.invoke("node.block", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Paused, attempt),
    });
    assert.ok(blocked.node.kind !== NodeKind.Task);
    assert.equal(blocked.node.state, NodeState.Blocked);
    assert.equal(blocked.outcome?.attempt, attempt);
    assert.equal(blocked.outcome?.result, AssessmentResult.Undetermined);
    assert.equal(blocked.outcome?.closingEvent, ClosingEvent.HumanBlock);
    assert.equal(blocked.node.blockedContext?.outcome.id, blocked.outcome?.id);
    const discarded = await h.invoke("node.discard", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Blocked, attempt),
    });
    assert.equal(discarded.outcome?.closingEvent, ClosingEvent.HumanDiscard);
    assert.deepEqual(discarded.attempt?.closedAt, blocked.attempt?.closedAt);
  });
}

test("discard revokes execution and closes its open attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
    setNodeState(tx, h.nodeId, NodeState.Executing);
  });
  const result = await h.invoke("node.discard", {
    params: { nodeId: h.nodeId },
    query: {},
    body: h.body(NodeState.Executing, FIRST),
  });
  assert.ok(result.attempt?.closedAt);
  assert.equal(result.outcome?.closingEvent, ClosingEvent.HumanDiscard);
  assert.ok(h.calls.some((call) => call.method === REVOKE));
});

test("discard refuses unresolved request without revocation or closure", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
    setNodeState(tx, h.nodeId, NodeState.Paused);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.nodeId,
        attempt: FIRST,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(h.actor),
        created_at: NOW,
      },
      [],
    );
  });
  await assert.rejects(
    h.invoke("node.discard", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Paused, FIRST),
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Unresolved,
  );
  assert.equal(h.node().state, NodeState.Paused);
  assert.equal(
    h.calls.some((call) => call.method === REVOKE),
    false,
  );
});

test("discard does not satisfy dependencies and admits the last objective's initiative", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const parent = createIdentity("node");
  const dependent = createIdentity("node");
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: parent,
      mission_id: h.missionId,
      kind: NodeKind.Initiative,
      filename: "parent.md",
      parent_id: null,
      created_at: NOW,
    });
    insertNode(tx, {
      id: dependent,
      mission_id: h.missionId,
      kind: NodeKind.Initiative,
      filename: "dependent.md",
      parent_id: null,
      created_at: NOW,
    });
    tx.database
      .prepare("UPDATE mission_node SET kind = ?, parent_id = ? WHERE id = ?")
      .run(NodeKind.Objective, parent, h.nodeId);
    setNodeState(tx, parent, NodeState.Available);
    insertDependency(tx, h.missionId, dependent, h.nodeId);
  });
  const result = await h.invoke("node.discard", {
    params: { nodeId: h.nodeId },
    query: {},
    body: h.body(),
  });
  assert.equal(result.attempt, null);
  assert.equal(
    h.store.transaction((tx) => readNode(tx, dependent))?.state,
    NodeState.Pending,
  );
  assert.ok(h.calls.some((call) => call.arguments.includes(parent)));
});
