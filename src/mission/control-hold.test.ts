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
const FIRST_ATTEMPT = 1;
const NO_ATTEMPT = 0;
const NOW = 100;
const REVOKE = "schedulerClaims.revoke";
const WAKE = "wakeup.wake";
const INSERT = "workQueue.insert";
const NOT_READY = "mission.node.not_ready";
const REASON_LIMIT = 12;
const CONTENT_INVALID = "mission.node.content_invalid";
test("controls reject blank and oversized UTF-8 reasons without writes, preserving exact-limit text", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.dependencies.config.text_max_bytes = REASON_LIMIT;
  const before = h.node();
  for (const reason of [
    "   ",
    "x".repeat(REASON_LIMIT + FIRST_ATTEMPT),
    "界".repeat(REASON_LIMIT),
  ]) {
    await assert.rejects(
      h.invoke("node.pause", {
        params: { node_id: h.node_id },
        query: {},
        body: { ...h.body(), reason },
      }),
      (error) =>
        error instanceof OperationError && error.code === CONTENT_INVALID,
    );
    assert.deepEqual(h.node(), before);
    assert.equal(
      h.calls.some((call) => call.method === WAKE || call.method === INSERT),
      false,
    );
  }
  const result = await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: { ...h.body(), reason: "界界界界" },
  });
  assert.ok(result.node.kind !== NodeKind.Task);
  assert.equal(result.node.state, NodeState.Paused);
});

for (const kind of [NodeKind.Initiative, NodeKind.Objective]) {
  test(`ready opens an attempt and enqueues ${kind} atomically; resume preserves its pin`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(kind, h.node_id);
    const result = await h.invoke("node.ready", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(),
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, NodeState.Waiting);
    assert.equal(result.attempt?.node_revision, FIRST_ATTEMPT);
    assert.deepEqual(result.attempt?.opened_by, h.actor);
    assert.ok(h.calls.some((call) => call.method === INSERT));
    await h.invoke("node.pause", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Waiting, FIRST_ATTEMPT),
    });
    const resumed = await h.invoke("node.resume", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(NodeState.Paused, FIRST_ATTEMPT),
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
      mission_id: h.mission_id,
      kind: NodeKind.Objective,
      filename: "child.md",
      parent_id: h.node_id,
      created_at: NOW,
    }),
  );
  await assert.rejects(
    h.invoke("node.ready", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(),
    }),
    (error) => error instanceof OperationError && error.code === NOT_READY,
  );
  assert.equal(h.node().attempt, NO_ATTEMPT);
  assert.equal(h.node().state, NodeState.Available);
  assert.equal(
    h.calls.some((call) => call.method === INSERT),
    false,
  );
});

test("resume Waiting at attempt 0 opens attempt 1 as ready does; Available opens none", async (t) => {
  const h = controlHarness(t, IDENTITY);
  await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(),
  });
  const resumed = await h.invoke("node.resume", {
    params: { node_id: h.node_id },
    query: {},
    body: { ...h.body(NodeState.Paused), target: ResumeTarget.Waiting },
  });
  assert.ok(resumed.node.kind !== NodeKind.Task);
  assert.equal(resumed.node.state, NodeState.Waiting);
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
  assert.equal(resumed.attempt?.node_revision, FIRST_ATTEMPT);
  assert.deepEqual(resumed.attempt?.opened_by, h.actor);
  assert.ok(h.calls.some((call) => call.method === INSERT));
});

test("resume Waiting keeps an open attempt; resume Available at attempt 0 opens none", async (t) => {
  const open = controlHarness(t, IDENTITY);
  await open.invoke("node.ready", {
    params: { node_id: open.node_id },
    query: {},
    body: open.body(),
  });
  await open.invoke("node.pause", {
    params: { node_id: open.node_id },
    query: {},
    body: open.body(NodeState.Waiting, FIRST_ATTEMPT),
  });
  const kept = await open.invoke("node.resume", {
    params: { node_id: open.node_id },
    query: {},
    body: {
      ...open.body(NodeState.Paused, FIRST_ATTEMPT),
      target: ResumeTarget.Waiting,
    },
  });
  assert.equal(open.node().attempt, FIRST_ATTEMPT);
  assert.equal(kept.attempt?.node_revision, FIRST_ATTEMPT);
  const fresh = controlHarness(t, IDENTITY);
  await fresh.invoke("node.pause", {
    params: { node_id: fresh.node_id },
    query: {},
    body: fresh.body(),
  });
  const result = await fresh.invoke("node.resume", {
    params: { node_id: fresh.node_id },
    query: {},
    body: { ...fresh.body(NodeState.Paused), target: ResumeTarget.Available },
  });
  assert.equal(result.attempt, null);
  assert.equal(fresh.node().attempt, NO_ATTEMPT);
});

test("resume Waiting refuses unsatisfied closure; Available routes to Pending without opening an attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const target = createIdentity("node");
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: target,
      mission_id: h.mission_id,
      kind: NodeKind.Initiative,
      filename: "dependency.md",
      parent_id: null,
      created_at: NOW,
    });
    insertDependency(tx, h.mission_id, h.node_id, target);
    setNodeState(tx, h.node_id, NodeState.Paused);
  });
  await assert.rejects(
    h.invoke("node.resume", {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(NodeState.Paused), target: ResumeTarget.Waiting },
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, NOT_READY);
      assert.deepEqual(error.details, {
        objectives_not_terminal: [],
        unresolved_actions: [],
        unsatisfied_ids: [target],
      });
      return true;
    },
  );
  const result = await h.invoke("node.resume", {
    params: { node_id: h.node_id },
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
      project_id: h.project_id,
      binding_id: bindingId,
      name: "repo",
      resource_identity: "repository:github:owner/repo",
      revision: FIRST_ATTEMPT,
      disabled: false,
      tombstone: false,
    });
    h.dependencies.bindings.repositoryPolicyOf = () => ({
      project_id: h.project_id,
      binding_id: bindingId,
      name: "repo",
      address: "git@github.com:owner/repo.git",
      platform: "github",
      ssh_credential: "github-ssh",
      credential: "github",
      base_branch: "main",
      action: RepositoryAction.PullRequest,
      project_prompt: null,
    });
    h.store.transaction((tx) => {
      tx.database
        .prepare("UPDATE mission_node SET kind = ?, state = ? WHERE id = ?")
        .run(NodeKind.Objective, NodeState.Paused, h.node_id);
      tx.database
        .prepare(
          "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
        )
        .run(JSON.stringify([bindingId]), h.node_id);
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      insertEvidence(
        tx,
        {
          id: createIdentity("evidence"),
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
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
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(NodeState.Paused, FIRST_ATTEMPT),
        target: ResumeTarget.Waiting,
      },
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, target);
    assert.equal(result.attempt?.closed_at, null);
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
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, state);
    });
    const result = await h.invoke("node.pause", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(state, FIRST_ATTEMPT),
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, NodeState.Paused);
    assert.equal(result.attempt?.closed_at, null);
    assert.equal(result.attempt?.attempt, FIRST_ATTEMPT);
    assert.equal(result.outcome, null);
    assert.equal(
      h.store.transaction((tx) => readAttempt(tx, h.node_id, FIRST_ATTEMPT))
        ?.closed_at,
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
      params: { project_id: h.project_id },
      query: {},
      body: null,
    });
    assert.equal(mission.version, FIRST_ATTEMPT);
  });
}

test("pause refuses Blocked without a write or wakeup", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Blocked));
  await assert.rejects(
    h.invoke("node.pause", {
      params: { node_id: h.node_id },
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
