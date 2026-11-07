import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test, type TestContext } from "node:test";
import type { HumanActor } from "../kernel/actor.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  FindingRoute,
  Intent,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  ResumeTarget,
  RevokeCause,
  type RevokedExecution,
} from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import { ControlError } from "./control.ts";
import {
  closeAttempt,
  insertAssessment,
  insertEvidence,
  openAttempt,
  readAssets,
  readEvidence,
} from "./record-store.ts";
import {
  insertDependency,
  insertNode,
  readNode,
  setNodeState,
} from "./store.ts";
import {
  actCalls,
  controlHarness,
  databaseSnapshot,
  keptClaimHarness,
  reviewerFinding,
  reviewHarness,
  revokedExecution,
  settlesExpired,
} from "./test-support.ts";
import { insertRevision, readCurrentRevision } from "./store.ts";
import { revisionFromRow } from "./revision.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const NOW = 100;
const NO_ATTEMPT = 0;
const FIRST_ELEMENT = 0;
const NO_EVIDENCE = 0;
const FIRST_ATTEMPT = 1;
const REVOKE = "schedulerClaims.revoke";
const EXECUTION_REVOKED = "schedulerClaims.executionRevoked";
const EXECUTIONS_LOST = "schedulerClaims.executionsLost";
const BINDING_MISMATCH = "mission.evidence.binding_mismatch";
const VALIDATION = "gateway.request.validation_failed";
const COMMIT = "a".repeat(40);
const SECOND_ATTEMPT = 2;
const NO_ACTS = 0;
const FIRST_QUEUED_AT = 40;
const ONE_ACT = 1;
const GATE_FILE_PATHS = ["package.json"];
const REPOSITORY_RESOURCE = "repository:github:owner/repo";
const CONTROL_REFUSED = "mission.node.control_refused";
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

for (const [operation, extra] of [
  ["node.discard", {}],
  ["node.override", { result: AssessmentResult.Success }],
] as const) {
  test(`${operation} of a node with a live execution ends its root span with the human cause`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    const executionId = createIdentity("execution");
    h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now) =>
      revokedExecution(executionId, nodeId, now);
    h.store.transaction((tx) => {
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, NodeState.Executing);
    });
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(NodeState.Executing, FIRST_ATTEMPT), ...extra },
    });
    const ends = h.calls.filter((call) => call.method === EXECUTION_REVOKED);
    assert.equal(ends.length, FIRST_ATTEMPT);
    const [execution, cause] = ends[0]!.arguments as [RevokedExecution, string];
    assert.equal(execution.execution_id, executionId);
    assert.equal(cause, RevokeCause.Human);
  });

  test(`${operation} of a node with no live execution ends no root span`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, NodeState.Executing);
    });
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(NodeState.Executing, FIRST_ATTEMPT), ...extra },
    });
    assert.ok(h.calls.some((call) => call.method === REVOKE));
    assert.equal(
      h.calls.some((call) => call.method === EXECUTION_REVOKED),
      false,
    );
  });
}

test("a discard whose admission settles an expired execution writes one lost end after its commit", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const executionId = createIdentity("execution");
  settlesExpired(h.dependencies, executionId);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Waiting);
  });
  await h.invoke("node.discard", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Waiting, FIRST_ATTEMPT),
  });
  const ends = h.calls.filter((call) => call.method === EXECUTIONS_LOST);
  assert.equal(ends.length, FIRST_ATTEMPT);
  const [lost] = ends[0]!.arguments as [{ execution_id: string }[]];
  assert.deepEqual(
    lost.map((execution) => execution.execution_id),
    [executionId],
  );
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
});

test("a block of a Paused node ends no root span", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Paused);
  });
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
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

test("an override to Completed writes the lead time from the first queue time", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.dependencies.workQueue.firstQueuedAt = () => FIRST_QUEUED_AT;
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Executing);
  });
  await h.invoke("node.override", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Executing, FIRST_ATTEMPT),
      result: AssessmentResult.Success,
    },
  });
  const [, contribution] = actCalls(h)[FIRST_ELEMENT]!;
  assert.equal(
    contribution.attributes[ActAttribute.LeadTimeMs],
    contribution.start_time - FIRST_QUEUED_AT,
  );
});

test("an override of a node that never queued and another act write no lead time", async (t) => {
  for (const [operation, from, extra, queuedAt] of [
    [
      "node.override",
      NodeState.Executing,
      { result: AssessmentResult.Success },
      null,
    ],
    ["node.discard", NodeState.Executing, {}, FIRST_QUEUED_AT],
    ["node.block", NodeState.Paused, {}, FIRST_QUEUED_AT],
  ] as const) {
    const h = controlHarness(t, IDENTITY);
    h.dependencies.workQueue.firstQueuedAt = () => queuedAt;
    h.store.transaction((tx) => {
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, from);
    });
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(from, FIRST_ATTEMPT), ...extra },
    });
    const [, contribution] = actCalls(h)[FIRST_ELEMENT]!;
    assert.equal(ActAttribute.LeadTimeMs in contribution.attributes, false);
  }
});

for (const [operation, act, from, to, extra] of [
  ["node.block", Act.Block, NodeState.Paused, NodeState.Blocked, {}],
  ["node.discard", Act.Discard, NodeState.Executing, NodeState.Discarded, {}],
  [
    "node.override",
    Act.Override,
    NodeState.Executing,
    NodeState.Completed,
    { result: AssessmentResult.Success },
  ],
] as const) {
  test(`${operation} writes one act trace after the commit with the states before and after and the reason`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, from);
    });
    const statesAtAct: (NodeState | null)[] = [];
    h.dependencies.acts.act = (...args) => {
      statesAtAct.push(h.node().state);
      h.calls.push({ method: "acts.act", arguments: args });
    };
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(from, FIRST_ATTEMPT), ...extra },
    });
    const written = actCalls(h);
    assert.equal(written.length, ONE_ACT);
    assert.deepEqual(statesAtAct, [to]);
    const [trace, contribution] = written[0]!;
    assert.equal(contribution.operation, act);
    assert.equal(trace.project_id, h.project_id);
    assert.equal(trace.node_id, h.node_id);
    assert.equal(trace.attempt, FIRST_ATTEMPT);
    assert.equal(contribution.attributes[ActAttribute.StateFrom], from);
    assert.equal(contribution.attributes[ActAttribute.StateTo], to);
    assert.equal(
      contribution.attributes[ActAttribute.MissionVersion],
      FIRST_ATTEMPT,
    );
    assert.deepEqual(contribution.texts, [
      { text_id: `${trace.root_span_id}:reason`, text: "Hold" },
    ]);
  });
}

for (const [operation, extra] of [
  ["node.discard", {}],
  ["node.override", { result: AssessmentResult.Success }],
] as const) {
  test(`${operation} of a node with a live execution links the revoked execution`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    const revoked = revokedExecution(
      createIdentity("execution"),
      h.node_id,
      NOW,
    );
    h.dependencies.schedulerClaims.revoke = () => revoked;
    h.store.transaction((tx) => {
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, NodeState.Executing);
    });
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(NodeState.Executing, FIRST_ATTEMPT), ...extra },
    });
    const written = actCalls(h);
    assert.equal(written.length, ONE_ACT);
    assert.deepEqual(written[0]![1].links, [
      {
        trace_id: revoked.trace.trace_id,
        span_id: revoked.trace.root_span_id,
      },
    ]);
  });

  test(`${operation} that the state check refuses writes no act trace`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Waiting));
    await assert.rejects(
      h.invoke(operation, {
        params: { node_id: h.node_id },
        query: {},
        body: { ...h.body(NodeState.Executing), ...extra },
      }),
      (error) =>
        error instanceof OperationError &&
        error.code === ControlError.StateConflict,
    );
    assert.equal(actCalls(h).length, NO_ACTS);
  });
}

test("a block links nothing, because it admits only a Paused node", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Paused);
  });
  await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  assert.equal(actCalls(h)[0]![1].links, undefined);
});

test("a block of a node that is not Paused writes no act trace", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.store.transaction((tx) => setNodeState(tx, h.node_id, NodeState.Waiting));
  await assert.rejects(
    h.invoke("node.block", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Waiting),
    }),
    (error) =>
      error instanceof OperationError && error.code === ControlError.Refused,
  );
  assert.equal(actCalls(h).length, NO_ACTS);
});

type LandingSpec = {
  name: string;
  action: RepositoryAction;
  gateFiles: boolean;
  address: PlatformAddressKind;
};

function landingHarness(
  t: Parameters<typeof controlHarness>[0],
  specs: LandingSpec[],
) {
  const h = controlHarness(t, IDENTITY);
  const bindings = specs.map((spec) => ({
    ...spec,
    binding_id: createIdentity("binding"),
    evidence_id: createIdentity("evidence"),
  }));
  const bindingOf = (id: string) => bindings.find((b) => b.binding_id === id)!;
  h.dependencies.bindings.getBindingRevision = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: bindingOf(bindingId).name,
    resource_identity: REPOSITORY_RESOURCE,
    revision: FIRST_ATTEMPT,
    disabled: false,
    tombstone: false,
  });
  h.dependencies.bindings.repositoryPolicyOf = (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: h.project_id,
    name: bindingOf(bindingId).name,
    address: "git@github.com:owner/repo.git",
    platform: "github",
    ssh_credential: "github-ssh",
    credential: "github",
    base_branch: "main",
    action: bindingOf(bindingId).action,
    landing: "human",
  });
  const addressOf = (kind: PlatformAddressKind) =>
    kind === PlatformAddressKind.BranchPush
      ? {
          kind,
          resource_identity: REPOSITORY_RESOURCE,
          branch: "main",
          commit: COMMIT,
        }
      : { kind, resource_identity: REPOSITORY_RESOURCE, number: ONE_ACT };
  h.store.transaction((tx) => {
    tx.database
      .prepare(
        "UPDATE mission_node_revision SET intent = ?, bindings = ? WHERE node_id = ?",
      )
      .run(
        Intent.Implement,
        JSON.stringify(bindings.map((b) => b.binding_id)),
        h.node_id,
      );
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    insertAssessment(tx, {
      id: createIdentity("assessment"),
      node_id: h.node_id,
      attempt: FIRST_ATTEMPT,
      result: AssessmentResult.Success,
      rationale: "Reviewed",
      evidence_ids: "[]",
      dependency_outcome_ids: "[]",
      tested_input: canonicalJSON(
        bindings.map((b) => ({
          kind: AssetKind.Repository,
          binding_id: b.binding_id,
          commit: COMMIT,
        })),
      ),
      gate_files: canonicalJSON(
        bindings
          .filter((b) => b.gateFiles)
          .map((b) => ({ binding_id: b.binding_id, paths: GATE_FILE_PATHS })),
      ),
      execution_id: createIdentity("execution"),
      actor: null,
      node_revision: FIRST_ATTEMPT,
      created_at: NOW,
    });
    for (const b of bindings)
      insertEvidence(
        tx,
        {
          id: b.evidence_id,
          node_id: h.node_id,
          attempt: FIRST_ATTEMPT,
          subject: "Request",
          requirement_key: `${b.name}.${b.action}`,
          end_state: null,
          verification: null,
          provenance: canonicalJSON(h.actor),
          created_at: NOW,
        },
        [
          {
            id: createIdentity("evidence_asset"),
            evidence_id: b.evidence_id,
            kind: AssetKind.Platform,
            content: canonicalJSON(addressOf(b.address)),
            published_at: NOW,
            expired_at: null,
          },
        ],
      );
    setNodeState(tx, h.node_id, NodeState.ExternalRequested);
  });
  const discard = () =>
    h.invoke("node.discard", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.ExternalRequested, FIRST_ATTEMPT),
    });
  const endStates = () =>
    h.store.transaction((tx) =>
      bindings.map((b) => readEvidence(tx, b.evidence_id)!.end_state),
    );
  return { ...h, discard, endStates };
}

const HUMAN_LANDING: LandingSpec = {
  name: "repo",
  action: RepositoryAction.MergePush,
  gateFiles: true,
  address: PlatformAddressKind.BranchPush,
};
const OPEN_PULL_REQUEST: LandingSpec = {
  name: "other",
  action: RepositoryAction.PullRequest,
  gateFiles: false,
  address: PlatformAddressKind.PullRequest,
};

test("discard of an External.Requested node with a human-landing request sets the end state other and closes the attempt", async (t) => {
  const h = landingHarness(t, [HUMAN_LANDING]);
  const result = await h.discard();
  assert.equal(result.node.state, NodeState.Discarded);
  assert.ok(result.attempt?.closed_at);
  assert.deepEqual(h.endStates(), ["other"]);
});

test("discard of an External.Requested node refuses every other unresolved request without a write", async (t) => {
  for (const specs of [
    [OPEN_PULL_REQUEST],
    [{ ...HUMAN_LANDING, gateFiles: false }],
    [HUMAN_LANDING, OPEN_PULL_REQUEST],
  ]) {
    const h = landingHarness(t, specs);
    await assert.rejects(
      h.discard(),
      (error) =>
        error instanceof OperationError && error.code === CONTROL_REFUSED,
    );
    assert.equal(h.node().state, NodeState.ExternalRequested);
    assert.deepEqual(
      h.endStates(),
      specs.map(() => null),
    );
  }
});

async function openFixFinding(t: TestContext) {
  const h = await reviewHarness(t, IDENTITY);
  const first = await h.submit({
    ...h.notMet,
    findings: [reviewerFinding("S1")],
  });
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Fix);
  const undecided = async () =>
    (
      await h.invoke("finding.undecided.list", {
        params: { project_id: h.project_id },
        query: {},
        body: null,
      })
    ).items.map((item) => item.label);
  const act = (state: NodeState) => ({
    reason: "Close",
    expected_mission_version: FIRST_ATTEMPT,
    expected_state: state,
    expected_attempt: FIRST_ATTEMPT,
  });
  return { ...h, first, undecided, act };
}

test("an override and a block report the open fix findings of the closed attempt", async (t) => {
  for (const block of [false, true]) {
    const h = await openFixFinding(t);
    if (block) {
      h.store.transaction((tx) =>
        setNodeState(tx, h.node_id, NodeState.Paused),
      );
      await h.invoke("node.block", {
        params: { node_id: h.node_id },
        query: {},
        body: h.act(NodeState.Paused),
      });
    } else
      await h.invoke("node.override", {
        params: { node_id: h.node_id },
        query: {},
        body: {
          ...h.act(NodeState.Available),
          result: AssessmentResult.Success,
        },
      });
    assert.equal((await h.byLabel("S1")).route, FindingRoute.Report);
    assert.deepEqual(await h.undecided(), ["S1"]);
  }
});

test("a discard records the open fix findings of the closed attempt", async (t) => {
  const h = await openFixFinding(t);
  await h.invoke("node.discard", {
    params: { node_id: h.node_id },
    query: {},
    body: h.act(NodeState.Available),
  });
  assert.equal((await h.byLabel("S1")).route, FindingRoute.Record);
  assert.deepEqual(await h.undecided(), []);
});

test("an override or a discard of a Blocked node changes no route", async (t) => {
  for (const discard of [false, true]) {
    const h = await openFixFinding(t);
    h.store.transaction((tx) => {
      closeAttempt(tx, h.node_id, FIRST_ATTEMPT, NOW);
      setNodeState(tx, h.node_id, NodeState.Blocked);
    });
    const body = h.act(NodeState.Blocked);
    if (discard)
      await h.invoke("node.discard", {
        params: { node_id: h.node_id },
        query: {},
        body,
      });
    else
      await h.invoke("node.override", {
        params: { node_id: h.node_id },
        query: {},
        body: { ...body, result: AssessmentResult.Success },
      });
    assert.equal((await h.byLabel("S1")).route, FindingRoute.Fix);
  }
});

const HUMAN_PAUSED = "human_paused";
const CONFLICT = 409;
const TWO_ACTS = 2;
const WAKEUP = "wakeup.wake";
const OVERRIDE = "override";
const RESUME = "resume";
const INSTANCE_ARCHIVED = "instance_archived";
const CLAIM_LIVE = "mission.node.claim_live";
const CLOSE_DROPPED = "mission.node.close_dropped";
const ONE_ORDER = 1;
const NO_ORDERS = 0;

type Kept = ReturnType<typeof keptClaimHarness>;

function overrideBody(k: Kept, state: NodeState) {
  return {
    ...k.h.body(state, FIRST_ATTEMPT),
    result: AssessmentResult.Success,
  };
}

function act(k: Kept, name: "override" | "discard", state: NodeState) {
  return k.h.invoke(`node.${name}`, {
    params: { node_id: k.h.node_id },
    query: {},
    body:
      name === OVERRIDE
        ? overrideBody(k, state)
        : k.h.body(state, FIRST_ATTEMPT),
  });
}

function acts(k: Kept, name: "block" | "resume" | "pause" | "ready") {
  return k.h.invoke(`node.${name}`, {
    params: { node_id: k.h.node_id },
    query: {},
    body: {
      ...k.h.body(NodeState.Paused, FIRST_ATTEMPT),
      ...(name === RESUME ? { target: ResumeTarget.Waiting } : {}),
    },
  });
}

function assessments(k: Kept) {
  return k.h.store.database
    .prepare("SELECT result FROM mission_assessment WHERE node_id = ?")
    .all(k.h.node_id)
    .map((row) => (row as { result: string }).result);
}

function claimLive(k: Kept) {
  return (error: unknown) =>
    error instanceof OperationError &&
    error.status === CONFLICT &&
    error.code === CLAIM_LIVE &&
    isDeepStrictEqual(error.details, {
      node_id: k.h.node_id,
      execution_id: k.executionId,
    });
}

test("an override of a connected live execution pauses the node, keeps the claim, sends one order and completes after the release", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  const result = await act(k, "override", NodeState.Executing);
  assert.equal(result.node.state, NodeState.Paused);
  assert.equal(k.h.node().state, NodeState.Paused);
  assert.deepEqual(k.stops, []);
  assert.equal(
    k.h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
  assert.deepEqual(k.sent, [[k.executionId, "runtime-1", HUMAN_PAUSED, false]]);
  assert.deepEqual(assessments(k), []);
  k.keep.live = false;
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Completed);
  assert.deepEqual(assessments(k), [AssessmentResult.Success]);
  assert.equal(actCalls(k.h).length, TWO_ACTS);
  assert.equal(
    k.h.calls.filter((call) => call.method === WAKEUP).length,
    TWO_ACTS,
  );
});

test("a discard of a connected live execution reaches Discarded after the release", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Evaluating);
  const result = await act(k, "discard", NodeState.Evaluating);
  assert.equal(result.node.state, NodeState.Paused);
  assert.equal(k.sent.length, ONE_ORDER);
  k.keep.live = false;
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Discarded);
  assert.deepEqual(assessments(k), [AssessmentResult.Undetermined]);
});

test("the order deadline revokes the claim with human_paused and the hook ends the override", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  await act(k, "override", NodeState.Executing);
  const trace = k.h.service.revokePausedClaim(k.executionId);
  assert.equal(trace?.execution_id, k.executionId);
  assert.deepEqual(k.stops, [{ reason: HUMAN_PAUSED, code: null }]);
  assert.equal(k.h.node().state, NodeState.Paused);
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Completed);
});

test("an override of an execution that holds an archive order completes after the archive deadline revoke", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  k.keep.order = INSTANCE_ARCHIVED;
  await act(k, "override", NodeState.Executing);
  assert.equal(k.h.node().state, NodeState.Paused);
  const ends = k.h.store.transaction((tx) =>
    k.h.service.revokeForInstanceArchive(
      tx,
      k.executionId,
      "instance",
      k.h.actor as HumanActor,
    ),
  );
  assert.ok(ends);
  assert.equal(k.stops.length, ONE_ORDER);
  assert.equal((k.stops[0] as { reason: string }).reason, INSTANCE_ARCHIVED);
  assert.equal(k.h.node().state, NodeState.Paused);
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Completed);
});

test("an override whose kept claim expires completes when the hook runs after a null deadline revoke", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  await act(k, "override", NodeState.Executing);
  k.keep.live = false;
  assert.equal(k.h.service.revokePausedClaim(k.executionId), null);
  assert.equal(k.h.node().state, NodeState.Paused);
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Completed);
});

test("a discard with a pending close reaches Discarded after a forced archive of a disconnected instance", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  await act(k, "discard", NodeState.Executing);
  k.keep.connected = false;
  const ends = k.h.store.transaction((tx) =>
    k.h.service.revokeForInstanceArchive(
      tx,
      k.executionId,
      "instance",
      k.h.actor as HumanActor,
    ),
  );
  assert.ok(ends);
  assert.equal(k.keep.live, false);
  assert.equal(k.h.node().state, NodeState.Paused);
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Discarded);
});

test("an override and a discard of a disconnected execution revoke at once with the stop human_paused", async (t) => {
  for (const name of ["override", "discard"] as const) {
    const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
    k.keep.connected = false;
    const result = await act(k, name, NodeState.Executing);
    assert.equal(
      result.node.state,
      name === OVERRIDE ? NodeState.Completed : NodeState.Discarded,
    );
    assert.deepEqual(k.stops, [{ reason: HUMAN_PAUSED, code: null }]);
    assert.deepEqual(k.sent, []);
    assert.equal(
      k.h.calls.filter((call) => call.method === EXECUTION_REVOKED).length,
      ONE_ACT,
    );
  }
});

test("a repeated override answers the step one result and sends no second order", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  const first = await act(k, "override", NodeState.Executing);
  const commits = k.h.commits();
  const repeated = await act(k, "override", NodeState.Executing);
  assert.deepEqual(repeated, first);
  assert.equal(k.sent.length, ONE_ORDER);
  assert.equal(actCalls(k.h).length, ONE_ACT);
  assert.equal(k.h.commits(), commits + ONE_ACT);
});

test("an override during a pending pause stop records the close on the same order and completes after the release", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Paused);
  k.keep.order = HUMAN_PAUSED;
  const result = await act(k, "override", NodeState.Paused);
  assert.equal(result.node.state, NodeState.Paused);
  assert.deepEqual(k.stops, []);
  assert.equal(k.sent.length, NO_ORDERS);
  k.keep.live = false;
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Completed);
});

test("an override of a Paused node with a kept claim and no order revokes at once", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Paused);
  const result = await act(k, "override", NodeState.Paused);
  assert.equal(result.node.state, NodeState.Completed);
  assert.deepEqual(k.stops, [{ reason: HUMAN_PAUSED, code: null }]);
});

test("every other control during a pending override refuses with claim_live", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  await act(k, "override", NodeState.Executing);
  for (const name of ["block", "resume", "pause", "ready"] as const)
    await assert.rejects(acts(k, name), claimLive(k));
  await assert.rejects(act(k, "discard", NodeState.Paused), claimLive(k));
  assert.equal(k.h.node().state, NodeState.Paused);
  assert.equal(k.sent.length, ONE_ORDER);
});

test("step two writes nothing and logs close_dropped when the node left Paused", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  await act(k, "override", NodeState.Executing);
  k.h.store.transaction((tx) =>
    setNodeState(tx, k.h.node_id, NodeState.Waiting),
  );
  const before = databaseSnapshot(k.h.store);
  k.h.service.executionReleased(k.executionId, null);
  assert.deepEqual(databaseSnapshot(k.h.store), before);
  const dropped = k.logs.filter((line) => line.msg === CLOSE_DROPPED);
  assert.equal(dropped.length, ONE_ACT);
  assert.equal(dropped[0]?.node_id, k.h.node_id);
  assert.equal(dropped[0]?.act, Act.Override);
});

test("step two of a rejected act logs close_dropped and removes the pending close", async (t) => {
  const k = keptClaimHarness(t, IDENTITY, NodeState.Executing);
  await act(k, "discard", NodeState.Executing);
  k.h.dependencies.config.text_max_bytes = 1;
  k.keep.live = false;
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(k.h.node().state, NodeState.Paused);
  assert.equal(
    k.logs.filter((line) => line.msg === CLOSE_DROPPED).length,
    ONE_ACT,
  );
  k.h.service.executionReleased(k.executionId, null);
  assert.equal(
    k.logs.filter((line) => line.msg === CLOSE_DROPPED).length,
    ONE_ACT,
  );
});
