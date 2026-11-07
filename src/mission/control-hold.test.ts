import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  EndState,
  Intent,
  NodeState,
  RepositoryAction,
  ResumeTarget,
  RevokeCause,
  type RevokedExecution,
  StartPoint,
} from "./contract.ts";
import { Act, ActAttribute } from "./act-telemetry.ts";
import { ControlError } from "./control.ts";
import { insertEvidence, openAttempt, readAttempt } from "./record-store.ts";
import { insertDependency, insertNode, setNodeState } from "./store.ts";
import { actCalls, controlHarness, revokedExecution } from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_ATTEMPT = 1;
const NO_ATTEMPT = 0;
const NOW = 100;
const REVOKE = "schedulerClaims.revoke";
const EXECUTION_REVOKED = "schedulerClaims.executionRevoked";
const WAKE = "wakeup.wake";
const INSERT = "workQueue.insert";
const NOT_READY = "mission.node.not_ready";
const REASON_LIMIT = 12;
const ROLLBACK = "rollback";
const CONTENT_INVALID = "mission.node.content_invalid";
const ACT = "acts.act";
const NO_ACTS = 0;
const ONE_ACT = 1;
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
  assert.equal(result.node.state, NodeState.Paused);
});

for (const intent of [Intent.Examine, Intent.Implement]) {
  test(`ready opens an attempt and enqueues ${intent} atomically; resume preserves its pin`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.database
      .prepare("UPDATE mission_node_revision SET intent = ? WHERE node_id = ?")
      .run(intent, h.node_id);
    const result = await h.invoke("node.ready", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(),
    });
    assert.equal(result.node.state, NodeState.Waiting);
    assert.equal(result.attempt?.node_revision, FIRST_ATTEMPT);
    assert.equal(result.attempt?.start_point, StartPoint.BaseBranch);
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

test("ready refuses an unsatisfied dependency before opening an attempt", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const target = createIdentity("node");
  h.store.transaction((tx) => {
    insertNode(tx, {
      id: target,
      mission_id: h.mission_id,
      filename: "dependency.md",
      created_at: NOW,
    });
    insertDependency(tx, h.mission_id, h.node_id, target);
  });
  await assert.rejects(
    h.invoke("node.ready", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(),
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, NOT_READY);
      assert.deepEqual(error.details, { unsatisfied_ids: [target] });
      return true;
    },
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
  assert.equal(resumed.node.state, NodeState.Waiting);
  assert.equal(h.node().attempt, FIRST_ATTEMPT);
  assert.equal(resumed.attempt?.node_revision, FIRST_ATTEMPT);
  assert.equal(resumed.attempt?.start_point, StartPoint.BaseBranch);
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
      filename: "dependency.md",
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
      assert.deepEqual(error.details, { unsatisfied_ids: [target] });
      return true;
    },
  );
  const result = await h.invoke("node.resume", {
    params: { node_id: h.node_id },
    query: {},
    body: { ...h.body(NodeState.Paused), target: ResumeTarget.Available },
  });
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
      landing: "human",
    });
    h.store.transaction((tx) => {
      tx.database
        .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
        .run(NodeState.Paused, h.node_id);
      tx.database
        .prepare(
          "UPDATE mission_node_revision SET intent = ? WHERE node_id = ?",
        )
        .run(Intent.Implement, h.node_id);
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

test("a pause of a node with a live execution ends its root span with the human cause after the commit", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const executionId = createIdentity("execution");
  h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now) =>
    revokedExecution(executionId, nodeId, now);
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Executing);
  });
  await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Executing, FIRST_ATTEMPT),
  });
  const ends = h.calls.filter((call) => call.method === EXECUTION_REVOKED);
  assert.equal(ends.length, FIRST_ATTEMPT);
  const [execution, cause] = ends[0]!.arguments as [RevokedExecution, string];
  assert.equal(execution.execution_id, executionId);
  assert.equal(cause, RevokeCause.Human);
  assert.equal(ends[0]!.arguments[2], null);
  assert.equal(ends[0]!.arguments[3], null);
  assert.ok(
    h.calls.findIndex((call) => call.method === EXECUTION_REVOKED) <
      h.calls.findIndex((call) => call.method === WAKE),
  );
});

test("a pause of a node with no live execution ends no root span", async (t) => {
  for (const state of [NodeState.Executing, NodeState.Waiting]) {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => {
      openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
      setNodeState(tx, h.node_id, state);
    });
    await h.invoke("node.pause", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(state, FIRST_ATTEMPT),
    });
    assert.equal(
      h.calls.some((call) => call.method === EXECUTION_REVOKED),
      false,
    );
  }
});

test("a pause rolled back after the revocation ends no root span", async (t) => {
  const h = controlHarness(t, IDENTITY);
  let revokes = 0;
  h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now) => {
    revokes++;
    return revokedExecution(createIdentity("execution"), nodeId, now);
  };
  h.caller.commit = (write) =>
    h.store.transaction((tx) => {
      write(tx);
      throw new Error(ROLLBACK);
    });
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Executing);
  });
  await assert.rejects(
    h.invoke("node.pause", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Executing, FIRST_ATTEMPT),
    }),
    { message: ROLLBACK },
  );
  assert.equal(revokes, FIRST_ATTEMPT);
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
});

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

for (const [operation, act, from, to, body] of [
  ["node.ready", Act.Ready, NodeState.Available, NodeState.Waiting, {}],
  [
    "node.resume",
    Act.Resume,
    NodeState.Paused,
    NodeState.Waiting,
    { target: ResumeTarget.Waiting },
  ],
  ["node.pause", Act.Pause, NodeState.Available, NodeState.Paused, {}],
] as const) {
  test(`${operation} writes one act trace after the commit with the states before and after`, async (t) => {
    const h = controlHarness(t, IDENTITY);
    h.store.transaction((tx) => setNodeState(tx, h.node_id, from));
    const statesAtAct: (NodeState | null)[] = [];
    h.dependencies.acts.act = (...args) => {
      statesAtAct.push(h.node().state);
      h.calls.push({ method: ACT, arguments: args });
    };
    await h.invoke(operation, {
      params: { node_id: h.node_id },
      query: {},
      body: { ...h.body(from), ...body },
    });
    const written = actCalls(h);
    assert.equal(written.length, ONE_ACT);
    assert.deepEqual(statesAtAct, [to]);
    const [trace, contribution] = written[0]!;
    assert.equal(contribution.operation, act);
    assert.equal(trace.project_id, h.project_id);
    assert.equal(trace.node_id, h.node_id);
    assert.equal(contribution.attributes[ActAttribute.StateFrom], from);
    assert.equal(contribution.attributes[ActAttribute.StateTo], to);
    assert.equal(
      contribution.attributes[ActAttribute.MissionVersion],
      FIRST_ATTEMPT,
    );
    assert.deepEqual(contribution.texts, [
      { text_id: `${trace.root_span_id}:reason`, text: "Hold" },
    ]);
    assert.equal(contribution.links, undefined);
  });
}

test("a pause of a node with a live execution links the root span of that execution", async (t) => {
  const h = controlHarness(t, IDENTITY);
  const revoked = revokedExecution(createIdentity("execution"), h.node_id, NOW);
  h.dependencies.schedulerClaims.revoke = () => revoked;
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, NodeState.Executing);
  });
  await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Executing, FIRST_ATTEMPT),
  });
  const written = actCalls(h);
  assert.equal(written.length, ONE_ACT);
  const [trace, contribution] = written[0]!;
  assert.equal(trace.attempt, FIRST_ATTEMPT);
  assert.deepEqual(contribution.links, [
    { trace_id: revoked.trace.trace_id, span_id: revoked.trace.root_span_id },
  ]);
});

test("a refused pause writes no act trace", async (t) => {
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
  assert.equal(actCalls(h).length, NO_ACTS);
});

test("an act telemetry that throws changes no answer and no state", async (t) => {
  const h = controlHarness(t, IDENTITY);
  h.dependencies.acts.act = () => {
    throw new Error("telemetry down");
  };
  const result = await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(),
  });
  assert.equal(result.node.state, NodeState.Paused);
  assert.equal(h.node().state, NodeState.Paused);
  assert.equal(h.calls.at(-1)?.method, WAKE);
});

const RUNTIME_IDENTITY = "runtime-1";
const HUMAN_PAUSED = "human_paused";
const CLAIM_LIVE = "mission.node.claim_live";

function pausedClaim(
  t: Parameters<typeof controlHarness>[0],
  state: NodeState,
) {
  const h = controlHarness(t, IDENTITY);
  const executionId = createIdentity("execution");
  const keep = { live: true, connected: true, order: null as string | null };
  const sent: unknown[][] = [];
  const stops: unknown[] = [];
  h.dependencies.schedulerClaims.liveExecutionOf = () =>
    keep.live
      ? {
          execution_id: executionId,
          runtime_identity: RUNTIME_IDENTITY,
          attempt: FIRST_ATTEMPT,
          pinned_revision: FIRST_ATTEMPT,
        }
      : null;
  h.dependencies.schedulerClaims.revoke = (_tx, nodeId, now, stop) => {
    stops.push(stop);
    keep.live = false;
    return revokedExecution(executionId, nodeId, now);
  };
  h.dependencies.workerStopOrders.connected = () => keep.connected;
  h.dependencies.workerStopOrders.orderOf = () =>
    keep.order as ReturnType<typeof h.dependencies.workerStopOrders.orderOf>;
  h.dependencies.workerStopOrders.sendStopOrder = (...args) => {
    sent.push([...args, h.store.database.isTransaction]);
  };
  h.store.transaction((tx) => {
    openAttempt(tx, h.node_id, FIRST_ATTEMPT, h.actor, NOW);
    setNodeState(tx, h.node_id, state);
  });
  return { h, executionId, keep, sent, stops };
}

test("a pause of a connected execution keeps the claim and sends one stop order after the commit", async (t) => {
  const { h, executionId, sent, stops } = pausedClaim(t, NodeState.Executing);
  const result = await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Executing, FIRST_ATTEMPT),
  });
  assert.equal(result.node.state, NodeState.Paused);
  assert.deepEqual(stops, []);
  assert.equal(
    h.calls.some((call) => call.method === EXECUTION_REVOKED),
    false,
  );
  assert.deepEqual(sent, [
    [executionId, RUNTIME_IDENTITY, HUMAN_PAUSED, false],
  ]);
});

test("a pause rolled back sends no stop order", async (t) => {
  const { h, sent } = pausedClaim(t, NodeState.Executing);
  h.caller.commit = (write) =>
    h.store.transaction((tx) => {
      write(tx);
      throw new Error(ROLLBACK);
    });
  await assert.rejects(
    h.invoke("node.pause", {
      params: { node_id: h.node_id },
      query: {},
      body: h.body(NodeState.Executing, FIRST_ATTEMPT),
    }),
    { message: ROLLBACK },
  );
  assert.deepEqual(sent, []);
});

test("a pause of an execution with no connection revokes the claim at once with the stop human_paused", async (t) => {
  const { h, keep, sent, stops } = pausedClaim(t, NodeState.Executing);
  keep.connected = false;
  const result = await h.invoke("node.pause", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Executing, FIRST_ATTEMPT),
  });
  assert.equal(result.node.state, NodeState.Paused);
  assert.deepEqual(stops, [{ reason: HUMAN_PAUSED, code: null }]);
  assert.equal(
    h.calls.filter((call) => call.method === EXECUTION_REVOKED).length,
    ONE_ACT,
  );
  assert.deepEqual(sent, []);
});

test("a block of a Paused node with a pending pause stop revokes the claim", async (t) => {
  const { h, keep, stops } = pausedClaim(t, NodeState.Paused);
  keep.order = HUMAN_PAUSED;
  const blocked = await h.invoke("node.block", {
    params: { node_id: h.node_id },
    query: {},
    body: h.body(NodeState.Paused, FIRST_ATTEMPT),
  });
  assert.equal(blocked.node.state, NodeState.Blocked);
  assert.deepEqual(stops, [{ reason: HUMAN_PAUSED, code: null }]);
});

test("a resume of a Paused node with a kept claim and an order refuses until the release", async (t) => {
  const { h, executionId, keep, stops } = pausedClaim(t, NodeState.Paused);
  keep.order = HUMAN_PAUSED;
  const resume = () =>
    h.invoke("node.resume", {
      params: { node_id: h.node_id },
      query: {},
      body: {
        ...h.body(NodeState.Paused, FIRST_ATTEMPT),
        target: ResumeTarget.Waiting,
      },
    });
  await assert.rejects(
    resume(),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Conflict &&
      error.code === CLAIM_LIVE &&
      isDeepStrictEqual(error.details, {
        node_id: h.node_id,
        execution_id: executionId,
      }),
  );
  assert.equal(h.node().state, NodeState.Paused);
  assert.deepEqual(stops, []);
  keep.live = false;
  keep.order = null;
  const resumed = await resume();
  assert.equal(resumed.node.state, NodeState.Waiting);
});

test("a resume of a Paused node with a kept claim and no order revokes the claim and resumes", async (t) => {
  const { h, stops } = pausedClaim(t, NodeState.Paused);
  const resumed = await h.invoke("node.resume", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Paused, FIRST_ATTEMPT),
      target: ResumeTarget.Waiting,
    },
  });
  assert.equal(resumed.node.state, NodeState.Waiting);
  assert.deepEqual(stops, [{ reason: HUMAN_PAUSED, code: null }]);
  assert.equal(
    h.calls.filter((call) => call.method === EXECUTION_REVOKED).length,
    ONE_ACT,
  );
});

test("revokePausedClaim revokes the kept claim with human_paused, keeps Paused and answers null on a second call", (t) => {
  const { h, executionId, stops } = pausedClaim(t, NodeState.Paused);
  const trace = h.service.revokePausedClaim(executionId);
  assert.equal(trace?.execution_id, executionId);
  assert.deepEqual(stops, [{ reason: HUMAN_PAUSED, code: null }]);
  assert.equal(h.node().state, NodeState.Paused);
  const reported = h.calls.filter((call) => call.method === EXECUTION_REVOKED);
  assert.equal(reported.length, ONE_ACT);
  assert.equal(
    (reported[0]!.arguments[0] as RevokedExecution).execution_id,
    executionId,
  );
  assert.equal(h.service.revokePausedClaim(executionId), null);
  assert.equal(
    h.calls.filter((call) => call.method === EXECUTION_REVOKED).length,
    ONE_ACT,
  );
});

test("revokePausedClaim ignores a node that is not Paused", (t) => {
  const { h, executionId, stops } = pausedClaim(t, NodeState.Executing);
  assert.equal(h.service.revokePausedClaim(executionId), null);
  assert.deepEqual(stops, []);
  assert.equal(h.node().state, NodeState.Executing);
});

test("a control on a Paused node passes after the loss of its expired kept claim", async (t) => {
  const { h, keep } = pausedClaim(t, NodeState.Paused);
  const limit = h.dependencies.config.consecutive_failure_limit;
  const answers: unknown[] = [];
  h.dependencies.schedulerClaims.settle = (tx, nodeId, now) => {
    if (!keep.live) return [];
    keep.live = false;
    answers.push(h.service.failure(tx, nodeId, limit, now));
    return [];
  };
  const resumed = await h.invoke("node.resume", {
    params: { node_id: h.node_id },
    query: {},
    body: {
      ...h.body(NodeState.Paused, FIRST_ATTEMPT),
      target: ResumeTarget.Waiting,
    },
  });
  assert.equal(resumed.node.state, NodeState.Waiting);
  assert.deepEqual(answers, [
    {
      from: NodeState.Paused,
      to: NodeState.Paused,
      rule: "none",
      count: null,
      limit: null,
      first_available_at: null,
    },
  ]);
});
