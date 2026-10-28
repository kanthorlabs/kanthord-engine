import assert from "node:assert/strict";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { createIdentity } from "../kernel/identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  AssessmentResult,
  AssetKind,
  ClosingEvent,
  Intent,
  NodeState,
  PlatformAddressKind,
  RepositoryAction,
  RevokeCause,
  type RevokedExecution,
} from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import { ControlError } from "./control.ts";
import {
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
