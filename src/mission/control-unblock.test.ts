import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import { MissionErrorCode, NodeKind, NodeState } from "./contract.ts";
import { ControlError } from "./control.ts";
import { openAttempt } from "./record-store.ts";
import {
  insertNode,
  insertDependency,
  setNodeState,
  readCurrentRevision,
} from "./store.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const SECOND = 2;
const ZERO = 0;
const NOW = 100;
test("objective unblock validates the exact task set and writes the changed task snapshot", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const taskId = createIdentity("node");
  const content = {
    name: "Task",
    requirement: "Requirement",
    criterion: "Criterion",
    verifications: ["true"],
    bindings: [],
  };
  h.dependencies.bindings.resolveBinding = () => ({
    bindingId,
    resourceIdentity: "repository:github:owner/repo",
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ?, state = ? WHERE id = ?")
      .run(NodeKind.Objective, NodeState.Paused, h.nodeId);
    insertNode(tx, {
      id: taskId,
      mission_id: h.missionId,
      kind: NodeKind.Task,
      filename: "task.md",
      parent_id: h.nodeId,
      created_at: NOW,
    });
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ?, tasks = ? WHERE node_id = ?",
      )
      .run(
        JSON.stringify([bindingId]),
        JSON.stringify([{ id: taskId, filename: "task.md", content }]),
        h.nodeId,
      );
  });
  await h.invoke("node.block", {
    params: { nodeId: h.nodeId },
    query: {},
    body: h.body(NodeState.Paused),
  });
  const change = {
    content: { ...content, bindings: ["repo"] },
    reason: "Redirect",
    tasks: [
      {
        id: taskId,
        filename: "task.md",
        content: { ...content, criterion: "New criterion" },
      },
    ],
  };
  const input = {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      blockedAttempt: ZERO,
      expectedRevision: FIRST,
      expectedMissionVersion: FIRST,
      change,
    },
  };
  await assert.rejects(
    h.invoke("node.unblock", {
      ...input,
      body: { ...input.body, change: { ...change, tasks: [] } },
    }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ContentInvalid,
  );
  assert.equal(h.node().state, NodeState.Blocked);
  const result = await h.invoke("node.unblock", input);
  assert.equal(result.node.visibleRevision, SECOND);
  const stored = h.store.transaction((tx) =>
    readCurrentRevision(tx, h.nodeId),
  )!;
  assert.deepEqual(JSON.parse(stored.tasks!), change.tasks);
});
for (const attempt of [ZERO, FIRST]) {
  test(`unblock attempt ${attempt} is atomic, preserves zero and rejects retry`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      if (attempt > ZERO) openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
      setNodeState(tx, h.nodeId, NodeState.Paused);
    });
    await h.invoke("node.block", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Paused, attempt),
    });
    const input = {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        blockedAttempt: attempt,
        expectedRevision: FIRST,
        expectedMissionVersion: FIRST,
      },
    };
    const result = await h.invoke("node.unblock", input);
    assert.equal(
      result.attempt?.attempt ?? ZERO,
      attempt === ZERO ? ZERO : SECOND,
    );
    if (result.attempt !== null)
      assert.deepEqual(result.attempt.openedBy, h.actor);
    assert.equal(result.outcome, null);
    await assert.rejects(
      h.invoke("node.unblock", input),
      (error) =>
        error instanceof OperationError && error.code === ControlError.Refused,
    );
  });
}

test("unblock checks attempt and revision before changing content; changed content is pinned once", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
    setNodeState(tx, h.nodeId, NodeState.Paused);
  });
  const blocked = await h.invoke("node.block", {
    params: { nodeId: h.nodeId },
    query: {},
    body: h.body(NodeState.Paused, FIRST),
  });
  const body = {
    blockedAttempt: FIRST,
    expectedRevision: FIRST,
    expectedMissionVersion: FIRST,
    change: {
      content: { ...blocked.node.content, name: "New direction" },
      reason: "Redirect",
    },
  };
  const invoke = (changes: Partial<typeof body>) =>
    h.invoke("node.unblock", {
      params: { nodeId: h.nodeId },
      query: {},
      body: { ...body, ...changes },
    });
  await assert.rejects(
    invoke({ blockedAttempt: ZERO }),
    (error) =>
      error instanceof OperationError &&
      error.code === ControlError.StateConflict,
  );
  await assert.rejects(
    invoke({ expectedRevision: SECOND }),
    (error) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.RevisionConflict,
  );
  const result = await invoke({});
  assert.equal(result.attempt?.nodeRevision, SECOND);
  assert.equal(result.node.visibleRevision, SECOND);
  const mission = await h.invoke("get", {
    params: { projectId: h.projectId },
    query: {},
    body: null,
  });
  assert.equal(mission.version, SECOND);
});

test("unchanged content makes no revision and unsatisfied closure routes unblock to Pending", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const target = createIdentity("node");
  h.store.transaction((tx) => {
    setNodeState(tx, h.nodeId, NodeState.Paused);
    insertNode(tx, {
      id: target,
      mission_id: h.missionId,
      kind: NodeKind.Initiative,
      filename: "target.md",
      parent_id: null,
      created_at: NOW,
    });
    insertDependency(tx, h.missionId, h.nodeId, target);
  });
  const blocked = await h.invoke("node.block", {
    params: { nodeId: h.nodeId },
    query: {},
    body: h.body(NodeState.Paused),
  });
  const result = await h.invoke("node.unblock", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      blockedAttempt: ZERO,
      expectedRevision: FIRST,
      expectedMissionVersion: FIRST,
      change: { content: blocked.node.content, reason: "Preserve" },
    },
  });
  assert.ok(result.node.kind !== NodeKind.Task);
  assert.equal(result.node.state, NodeState.Pending);
  assert.equal(result.node.visibleRevision, FIRST);
  assert.equal(
    h.store.transaction((tx) => readCurrentRevision(tx, h.nodeId))?.revision,
    FIRST,
  );
});
