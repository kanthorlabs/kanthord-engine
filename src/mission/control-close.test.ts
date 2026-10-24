import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import {
  AssessmentResult,
  ClosingEvent,
  Intent,
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
const VALIDATION = "gateway.request.validation_failed";
const COMMIT = "a".repeat(40);
const SECOND_ATTEMPT = 2;
test("implement override validates its attempt repository pin after the current revision changes", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const original = createIdentity("binding");
  const newer = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action: null,
    landing: "human",
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(Intent.Implement, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([original]), h.node_id);
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    const prior = revisionFromRow(tx, readCurrentRevision(tx, h.node_id)!);
    insertRevision(tx, {
      ...prior,
      revision: SECOND_ATTEMPT,
      content: { ...prior.content, bindings: [newer] },
    });
  });
  const input = {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Available, FIRST_ATTEMPT),
      result: AssessmentResult.Success,
      landed_commit: { kind: "repository", binding_id: newer, commit: COMMIT },
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
      landed_commit: { ...input.body.landed_commit, binding_id: original },
    },
  });
  assert.equal(answer.outcome?.node_revision, FIRST_ATTEMPT);
  assert.equal(answer.node.visible_revision, SECOND_ATTEMPT);
});

test("attempt-zero success override publishes a human repository evidence and satisfies dependents", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  const dependent = createIdentity("node");
  h.dependencies.bindings.getBindingRevision = () => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(Intent.Implement, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([bindingId]), h.node_id);
    insertNode(tx, {
      id: dependent,
      mission_id: h.mission_id,
      filename: "dependent.md",
      created_at: NOW,
    });
    insertDependency(tx, h.mission_id, dependent, h.node_id);
  });
  const result = await h.invoke("node.override", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(),
      result: AssessmentResult.Success,
      landed_commit: {
        kind: "repository",
        binding_id: bindingId,
        commit: COMMIT,
      },
    },
  });
  assert.equal(result.attempt, null);
  assert.equal(result.outcome?.closing_event, ClosingEvent.SuccessOverride);
  assert.equal(result.outcome?.evidence_ids.length, FIRST_ATTEMPT);
  const id = result.outcome!.evidence_ids[FIRST_ELEMENT]!;
  h.store.transaction((tx) => {
    assert.equal(readNode(tx, dependent)?.state, NodeState.Available);
    const evidence = readEvidence(tx, id)!;
    assert.equal(evidence.attempt, NO_ATTEMPT);
    assert.deepEqual(JSON.parse(evidence.provenance), h.actor);
    const assets = readAssets(tx, id);
    assert.deepEqual(JSON.parse(assets[FIRST_ELEMENT]!.content), {
      binding_id: bindingId,
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
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(),
        result: AssessmentResult.Success,
        landed_commit: {
          kind: "repository",
          binding_id: bindingId,
          commit: COMMIT,
        },
      },
    }),
    (error) =>
      error instanceof OperationError && error.code === BINDING_MISMATCH,
  );
  assert.equal(h.node().state, NodeState.Available);
  h.store.transaction((tx) =>
    setNodeState(tx, h.node_id, NodeState.Evaluating),
  );
  await assert.rejects(
    h.invoke("node.override", {
      params: { node_id: h.node_id },
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

test("override rejects a landed commit on the pinned repository of an examine node", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const bindingId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = () => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: "repo",
    resource_identity: "repository:github:owner/repo",
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) =>
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET intent = ?, bindings = ? WHERE node_id = ?",
      )
      .run(Intent.Examine, JSON.stringify([bindingId]), h.node_id),
  );
  await assert.rejects(
    h.invoke("node.override", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(),
        result: AssessmentResult.Success,
        landed_commit: {
          kind: "repository",
          binding_id: bindingId,
          commit: COMMIT,
        },
      },
    }),
    (error) =>
      error instanceof OperationError && error.code === BINDING_MISMATCH,
  );
  assert.equal(h.node().state, NodeState.Available);
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
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW),
    );
    if (state === NodeState.Blocked) {
      h.store.transaction((tx) =>
        setNodeState(tx, h.node_id, NodeState.Paused),
      );
      await h.invoke("node.block", {
        params: { node_id: h.node_id },
        query: {},
        body: h.body(NodeState.Paused, FIRST_ATTEMPT),
      });
    } else h.store.transaction((tx) => setNodeState(tx, h.node_id, state));
    const result = await h.invoke("node.override", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(state, FIRST_ATTEMPT),
        result: AssessmentResult.Success,
      },
    });
    assert.equal(result.node.state, NodeState.Completed);
    assert.equal(result.outcome?.closing_event, ClosingEvent.SuccessOverride);
    assert.ok(result.attempt?.closed_at);
  });
}

for (const attempt of [NO_ATTEMPT, FIRST_ATTEMPT]) {
  test(`block at attempt ${attempt} writes a human outcome; discard from Blocked closes nothing again`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      if (attempt > NO_ATTEMPT)
        openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, NodeState.Paused);
    });
    const blocked = await h.invoke("node.block", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Paused, attempt),
    });
    assert.equal(blocked.node.state, NodeState.Blocked);
    assert.equal(blocked.outcome?.attempt, attempt);
    assert.equal(blocked.outcome?.result, AssessmentResult.Undetermined);
    assert.equal(blocked.outcome?.closing_event, ClosingEvent.HumanBlock);
    assert.equal(blocked.node.blocked_context?.outcome.id, blocked.outcome?.id);
    const discarded = await h.invoke("node.discard", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Blocked, attempt),
    });
    assert.equal(discarded.outcome?.closing_event, ClosingEvent.HumanDiscard);
    const historical = await h.invoke("outcome.get", {
      params: { outcome_id: blocked.outcome!.id },
      query: {},
      body: null,
    });
    assert.equal(historical.closing_event, ClosingEvent.HumanBlock);
    assert.deepEqual(discarded.attempt?.closed_at, blocked.attempt?.closed_at);
  });
}

test("discard revokes execution and closes its open attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Executing);
  });
  const result = await h.invoke("node.discard", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Executing, FIRST_ATTEMPT),
  });
  assert.ok(result.attempt?.closed_at);
  assert.equal(result.outcome?.closing_event, ClosingEvent.HumanDiscard);
  assert.ok(h.calls.some((call) => call.method === REVOKE));
});

test("discard refuses unresolved request without revocation or closure", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Paused);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: h.node_id,
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
      params: { node_id: h.node_id },
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

test("discard does not satisfy dependencies", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const dependent = createIdentity("node");
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: dependent,
      mission_id: h.mission_id,
      filename: "dependent.md",
      created_at: NOW,
    });
    insertDependency(tx, h.mission_id, dependent, h.node_id);
  });
  const result = await h.invoke("node.discard", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(),
  });
  assert.equal(result.attempt, null);
  assert.equal(
    h.store.transaction((tx) => readNode(tx, dependent))?.state,
    NodeState.Pending,
  );
});

test("a success override of a node with two bindings lands a list in binding order", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const firstId = createIdentity("binding");
  const secondId = createIdentity("binding");
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: bindingId,
    resource_identity: `repository:github:owner/${bindingId}`,
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(Intent.Implement, h.node_id);
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET bindings = ? WHERE node_id = ?",
      )
      .run(JSON.stringify([firstId, secondId]), h.node_id);
  });
  const address = (bindingId: string) => ({
    kind: "repository" as const,
    binding_id: bindingId,
    commit: COMMIT,
  });
  const override = (landed: unknown) =>
    h.invoke("node.override", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(),
        result: AssessmentResult.Success,
        landed_commit: landed,
      },
    });
  await assert.rejects(
    override([address(secondId), address(firstId)]),
    (error) =>
      error instanceof OperationError &&
      error.code === BINDING_MISMATCH &&
      JSON.stringify(error.details) ===
        JSON.stringify({ binding_id: secondId }),
  );
  await assert.rejects(
    override(address(firstId)),
    (error) => error instanceof OperationError && error.code === VALIDATION,
  );
  assert.equal(h.node().state, NodeState.Available);
  const result = await override([address(firstId), address(secondId)]);
  const id = result.outcome!.evidence_ids[FIRST_ELEMENT]!;
  h.store.transaction((tx) =>
    assert.deepEqual(
      readAssets(tx, id)
        .map((asset) => JSON.parse(asset.content).binding_id)
        .sort(),
      [firstId, secondId].sort(),
    ),
  );
});
