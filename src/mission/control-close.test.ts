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
import {
  openAttempt,
  insertEvidence,
  readEvidence,
  readAssets,
} from "./record-store.ts";
import {
  insertNode,
  insertDependency,
  setNodeState,
  readNode,
} from "./store.ts";
import { controlHarness } from "./test-support.ts";
import { readCurrentRevision, insertRevision } from "./store.ts";
import { revisionFromRow } from "./revision.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NOW = 100;
const NO_ATTEMPT = 0;
const FIRST_ELEMENT = 0;
const NO_EVIDENCE = 0;
const FIRST_ATTEMPT = 1;
const REVOKE = "schedulerClaims.revoke";
const BINDING_MISMATCH = "mission.evidence.binding_mismatch";
const COMMIT = "a".repeat(40);
const SECOND_ATTEMPT = 2;
test("objective override validates its attempt repository pin after the current revision changes", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const original = createIdentity("binding");
  const newer = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    bindingId,
    projectId: h.projectId,
    name: "repo",
    resourceIdentity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = (_tx, bindingId) => ({
    bindingId,
    projectId: h.projectId,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    sshCredential: "github-ssh",
    credential: "github",
    baseBranch: "main",
    action: null,
    projectPrompt: null,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(NodeKind.Objective, h.nodeId);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([original]), h.nodeId);
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
    const prior = revisionFromRow(tx, readCurrentRevision(tx, h.nodeId)!);
    insertRevision(tx, {
      ...prior,
      revision: SECOND_ATTEMPT,
      content: { ...prior.content, bindings: [newer] },
    });
  });
  const input = {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.body(NodeState.Available, FIRST_ATTEMPT),
      result: AssessmentResult.Success,
      landedCommit: { kind: "repository", bindingId: newer, commit: COMMIT },
    },
  };
  await assert.rejects(
    h.invoke("node.override", input),
    (error) =>
      error instanceof OperationError && error.code === BINDING_MISMATCH,
  );
  const answer = await h.invoke("node.override", {
    ...input,
    body: {
      ...input.body,
      landedCommit: { ...input.body.landedCommit, bindingId: original },
    },
  });
  assert.equal(answer.outcome?.nodeRevision, FIRST_ATTEMPT);
  assert.equal(answer.node.visibleRevision, SECOND_ATTEMPT);
});

test("attempt-zero success override publishes a human repository evidence and satisfies dependents", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const dependent = createIdentity("node");
  h.dependencies.bindings.getBindingRevision = () => ({
    bindingId,
    projectId: h.projectId,
    name: "repo",
    resourceIdentity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET kind = ? WHERE id = ?")
      .run(NodeKind.Objective, h.nodeId);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([bindingId]), h.nodeId);
    insertNode(tx, {
      id: dependent,
      mission_id: h.missionId,
      kind: NodeKind.Initiative,
      filename: "dependent.md",
      parent_id: null,
      created_at: NOW,
    });
    insertDependency(tx, h.missionId, dependent, h.nodeId);
  });
  const result = await h.invoke("node.override", {
    params: { nodeId: h.nodeId },
    query: {},
    body: {
      ...h.body(),
      result: AssessmentResult.Success,
      landedCommit: { kind: "repository", bindingId, commit: COMMIT },
    },
  });
  assert.equal(result.attempt, null);
  assert.equal(result.outcome?.closingEvent, ClosingEvent.SuccessOverride);
  assert.equal(result.outcome?.evidenceIds.length, FIRST_ATTEMPT);
  const id = result.outcome!.evidenceIds[FIRST_ELEMENT]!;
  h.store.transaction((tx) => {
    assert.equal(readNode(tx, dependent)?.state, NodeState.Available);
    const evidence = readEvidence(tx, id)!;
    assert.equal(evidence.attempt, NO_ATTEMPT);
    assert.deepEqual(JSON.parse(evidence.provenance), h.actor);
    const assets = readAssets(tx, id);
    assert.deepEqual(JSON.parse(assets[FIRST_ELEMENT]!.content), {
      bindingId,
      commit: COMMIT,
    });
    assert.ok(assets[FIRST_ELEMENT]!.published_at);
  });
});

test("override rejects another binding and Evaluating before any evidence write", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  await assert.rejects(
    h.invoke("node.override", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.body(),
        result: AssessmentResult.Success,
        landedCommit: { kind: "repository", bindingId, commit: COMMIT },
      },
    }),
    (error) =>
      error instanceof OperationError && error.code === BINDING_MISMATCH,
  );
  assert.equal(h.node().state, NodeState.Available);
  h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Evaluating));
  await assert.rejects(
    h.invoke("node.override", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.body(NodeState.Evaluating),
        result: AssessmentResult.Success,
      },
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
  assert.equal(
    h.store.database
      .prepare("SELECT count(*) AS count FROM mission_evidence")
      .get()!.count,
    NO_EVIDENCE,
  );
});

for (const state of [NodeState.ExternalFailed, NodeState.Blocked]) {
  test(`success override from ${state} writes a new success outcome`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) =>
      openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW),
    );
    if (state === NodeState.Blocked) {
      h.store.transaction((tx) => setNodeState(tx, h.nodeId, NodeState.Paused));
      await h.invoke("node.block", {
        params: { nodeId: h.nodeId },
        query: {},
        body: h.body(NodeState.Paused, FIRST_ATTEMPT),
      });
    } else h.store.transaction((tx) => setNodeState(tx, h.nodeId, state));
    const result = await h.invoke("node.override", {
      params: { nodeId: h.nodeId },
      query: {},
      body: {
        ...h.body(state, FIRST_ATTEMPT),
        result: AssessmentResult.Success,
      },
    });
    assert.ok(result.node.kind !== NodeKind.Task);
    assert.equal(result.node.state, NodeState.Completed);
    assert.equal(result.outcome?.closingEvent, ClosingEvent.SuccessOverride);
    assert.ok(result.attempt?.closedAt);
  });
}

for (const attempt of [NO_ATTEMPT, FIRST_ATTEMPT]) {
  test(`block at attempt ${attempt} writes a human outcome; discard from Blocked closes nothing again`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      if (attempt > NO_ATTEMPT)
        openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
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
    const historical = await h.invoke("outcome.get", {
      params: { outcomeId: blocked.outcome!.id },
      query: {},
      body: null,
    });
    assert.equal(historical.closingEvent, ClosingEvent.HumanBlock);
    assert.deepEqual(discarded.attempt?.closedAt, blocked.attempt?.closedAt);
  });
}

test("discard revokes execution and closes its open attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.nodeId, NodeState.Executing);
  });
  const result = await h.invoke("node.discard", {
    params: { nodeId: h.nodeId },
    query: {},
    body: h.body(NodeState.Executing, FIRST_ATTEMPT),
  });
  assert.ok(result.attempt?.closedAt);
  assert.equal(result.outcome?.closingEvent, ClosingEvent.HumanDiscard);
  assert.ok(h.calls.some((call) => call.method === REVOKE));
});

test("discard refuses unresolved request without revocation or closure", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.nodeId, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.nodeId, NodeState.Paused);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.nodeId,
        attempt: FIRST_ATTEMPT,
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
      body: h.body(NodeState.Paused, FIRST_ATTEMPT),
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
