import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  NodeKind,
  NodeState,
  ResumeTarget,
  EndState,
  RepositoryAction,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { openAttempt, readAttempt, insertEvidence } from "./record-store.ts";
import { setNodeState, insertNode, insertDependency } from "./store.ts";
import { controlHarness } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST = 1;
const ZERO = 0;
const NOW = 100;
const REVOKE = "schedulerClaims.revoke";
const WAKE = "wakeup.wake";
const INSERT = "workQueue.insert";
const NOT_READY = "mission.node.not_ready";

for (const kind of [NodeKind.Initiative, NodeKind.Objective]) {
  test(`ready opens an attempt and enqueues ${kind} atomically; resume preserves its pin`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(kind, h.nodeId);
    const result = await h.invoke("node.ready", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(),
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, NodeState.Waiting);
    assert.equal(result.attempt?.nodeRevision, FIRST);
    assert.deepEqual(result.attempt?.openedBy, h.actor);
    assert.ok(h.calls.some((call) => call.method === INSERT));
    await h.invoke("node.pause", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Waiting, FIRST),
    });
    const resumed = await h.invoke("node.resume", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.body(NodeState.Paused, FIRST),
        target: ResumeTarget.Waiting,
      },
    });
    assert.deepEqual(resumed.attempt, result.attempt);
    assert.equal(resumed.outcome, null);
  });
}

test("ready refuses a nonterminal objective child before opening an attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) =>
    insertNode(tx, {
      id: createIdentity("node"),
      mission_id: h.missionId,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.nodeId,
      created_at: NOW,
    }),
  );
  await assert.rejects(
    h.invoke("node.ready", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(),
    }),
    (error) => error instanceof OperationError && error.code === NOT_READY,
  );
  assert.equal(h.node().attempt, ZERO);
  assert.equal(h.node().state, NodeState.Available);
  assert.equal(
    h.calls.some((call) => call.method === INSERT),
    false,
  );
});

test("resume Waiting refuses unsatisfied closure; Available routes to Pending without opening an attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const target = createIdentity("node");
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: target,
      mission_id: h.missionId,
      kind: NodeKind.Initiative,
      filename: "dependency.md",
      parent_id: null,
      created_at: NOW,
    });
    insertDependency(tx, h.missionId, h.nodeId, target);
    setNodeState(tx, h.nodeId, NodeState.Paused);
  });
  await assert.rejects(
    h.invoke("node.resume", {
      params: { nodeId: h.nodeId },
      query: {},
      body: { ...h.body(NodeState.Paused), target: ResumeTarget.Waiting },
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, NOT_READY);
      assert.deepEqual(error.details, {
        objectivesNotTerminal: [],
        unresolvedActions: [],
        unsatisfiedIds: [target],
      });
      return true;
    },
  );
  const result = await h.invoke("node.resume", {
    params: { nodeId: h.nodeId },
    query: {},
    body: { ...h.body(NodeState.Paused), target: ResumeTarget.Available },
  });
  assert.ok(result.node.kind !== NodeKind.Task);
  assert.equal(result.node.state, NodeState.Pending);
  assert.equal(result.attempt, null);
});

for (const [end, target] of [
  [null, NodeState.ExternalRequested],
  [EndState.Expected, NodeState.ExternalSuccess],
  [EndState.Other, NodeState.ExternalFailed],
] as const) {
  test(`resume request precedence selects ${target} over Waiting`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    const bindingId = createIdentity("binding");
    h.dependencies.bindings.getBindingRevision = () => ({
      projectId: h.projectId,
      bindingId,
      name: "repo",
      resourceIdentity: "repository:github:owner/repo",
      revision: FIRST,
      disabled: false,
      tombstone: false,
    });
    h.dependencies.bindings.repositoryPolicyOf = () => ({
      projectId: h.projectId,
      bindingId,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      credential: "github",
      baseBranch: "main",
      action: RepositoryAction.PullRequest,
      projectPrompt: null,
    });
    h.store.transaction((tx) => {
      tx.database
        .prepare("UPDATE mission_node SET kind = ?, state = ? WHERE id = ?")
        .run(NodeKind.Objective, NodeState.Paused, h.nodeId);
      tx.database
        .prepare(
          "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
        )
        .run(JSON.stringify([bindingId]), h.nodeId);
      openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
      insertEvidence(
        tx,
        {
          id: createIdentity("evidence"),
          node_id: h.nodeId,
          attempt: FIRST,
          subject: "Request",
          requirement_key: "repo.pull_request",
          end_state: end,
          verification: null,
          provenance: JSON.stringify(h.actor),
          created_at: NOW,
        },
        [],
      );
    });
    const result = await h.invoke("node.resume", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.body(NodeState.Paused, FIRST),
        target: ResumeTarget.Waiting,
      },
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, target);
    assert.equal(result.attempt?.closedAt, null);
    assert.equal(result.outcome, null);
  });
}
for (const state of [
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.ExternalRequested,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
]) {
  test(`pause from ${state} preserves the open attempt and revokes only active claims`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      openAttempt(tx, h.nodeId, FIRST, h.actor, NOW);
      setNodeState(tx, h.nodeId, state);
    });
    const result = await h.invoke("node.pause", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(state, FIRST),
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, NodeState.Paused);
    assert.equal(result.attempt?.closedAt, null);
    assert.equal(result.attempt?.attempt, FIRST);
    assert.equal(result.outcome, null);
    assert.equal(
      h.store.transaction((tx) => readAttempt(tx, h.nodeId, FIRST))?.closed_at,
      null,
    );
    assert.equal(
      h.calls.some((call) => call.method === REVOKE),
      state === NodeState.Executing || state === NodeState.Evaluating,
    );
    assert.equal(h.calls.at(-1)?.method, WAKE);
    assert.equal(
      h.calls.some((call) => call.method === INSERT),
      false,
    );
    const mission = await h.invoke("get", {
      params: { projectId: h.projectId },
      query: {},
      body: null,
    });
    assert.equal(mission.version, FIRST);
  });
}

test("pause refuses Blocked without a write or wakeup", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Blocked));
  await assert.rejects(
    h.invoke("node.pause", {
      params: { nodeId: h.nodeId },
      query: {},
      body: h.body(NodeState.Blocked),
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
  assert.equal(h.node().state, NodeState.Blocked);
  assert.equal(
    h.calls.some((call) => call.method === WAKE),
    false,
  );
});
