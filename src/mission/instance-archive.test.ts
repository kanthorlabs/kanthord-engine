import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { NodeState, RevokeCause, type RevokedExecution } from "./contract.ts";
import { readOpenAttempt } from "./record-store.ts";
import { setNodeState } from "./store.ts";
import {
  databaseSnapshot,
  executionHarness,
  revokedExecution,
} from "./test-support.ts";

const IDENTITY = testHumanIdentity("ulrich", "Ulrich", "token");
const FIRST_ATTEMPT = 1;
const NO_CALLS = 0;
const ONE_CALL = 1;
const ENDED_AT = 500;
const INSERT = "workQueue.insert";
const LOST = "schedulerClaims.executionsLost";
const ACT = "acts.act";
const KINDS = [
  { claim: NodeState.Executing, after: NodeState.Available },
  { claim: NodeState.Evaluating, after: NodeState.Waiting },
] as const;

function fixture(t: TestContext, claim: NodeState) {
  const h = executionHarness(t, IDENTITY);
  const executionId = createIdentity("execution");
  const execution = { ended_at: null as number | null };
  const reported: unknown[][] = [];
  const claims = h.dependencies.schedulerClaims;
  claims.liveExecutionOf = (_tx, nodeId) =>
    nodeId === h.node_id && execution.ended_at === null
      ? {
          execution_id: executionId,
          runtime_identity: h.claim.runtimeIdentity,
          attempt: FIRST_ATTEMPT,
          pinned_revision: FIRST_ATTEMPT,
        }
      : null;
  claims.revoke = (_tx, nodeId, now) => {
    assert.equal(execution.ended_at, null);
    execution.ended_at = now;
    return revokedExecution(executionId, nodeId, now);
  };
  claims.executionRevoked = (...args) => {
    reported.push(args);
  };
  h.store.transaction((tx) => setNodeState(tx, h.node_id, claim));
  const revoke = (id = executionId) =>
    h.store.transaction((tx) => h.service.revokeForInstanceArchive(tx, id));
  const jobs = () =>
    h.calls.filter(
      (call) => call.method === INSERT && call.arguments[1] === h.node_id,
    );
  return { ...h, executionId, execution, reported, revoke, jobs };
}

for (const { claim, after } of KINDS) {
  test(`a forced archive of a live ${claim} claim moves the node to ${after} and keeps the attempt open`, (t) => {
    const h = fixture(t, claim);
    const failure = t.mock.method(h.service, "failure");
    const attempt = h.node().attempt;
    assert.equal(h.execution.ended_at, null);
    assert.equal(h.jobs().length, NO_CALLS);
    const ends = h.revoke();
    assert.ok(ends);
    assert.equal(h.node().state, after);
    assert.equal(h.node().attempt, attempt);
    assert.equal(
      h.store.transaction((tx) => readOpenAttempt(tx, h.node_id))?.attempt,
      FIRST_ATTEMPT,
    );
    assert.notEqual(h.execution.ended_at, null);
    assert.equal(h.execution.ended_at, ends.revoked[0]!.execution.ended_at);
    assert.equal(failure.mock.callCount(), NO_CALLS);
    assert.equal(
      h.calls.filter((call) => call.method === LOST).length,
      NO_CALLS,
    );
    assert.deepEqual(ends.lost, []);
    assert.equal(h.jobs().length, ONE_CALL);
  });
}

test("the call answers the revoked claim with the human cause and reports nothing before the commit", (t) => {
  const h = fixture(t, NodeState.Executing);
  const ends = h.store.transaction((tx) => {
    const ends = h.service.revokeForInstanceArchive(tx, h.executionId);
    assert.equal(h.reported.length, NO_CALLS);
    return ends;
  });
  assert.ok(ends);
  assert.equal(h.reported.length, NO_CALLS);
  assert.equal(ends.revoked.length, ONE_CALL);
  assert.equal(ends.revoked[0]!.execution.execution_id, h.executionId);
  assert.equal(ends.revoked[0]!.cause, RevokeCause.Human);
  assert.equal(ends.revoked[0]!.transition, null);
  assert.equal(ends.revoked[0]!.failure_cause, null);
});

test("reportExecutionEnds reports one human revocation without a transition or a failure cause", (t) => {
  const h = fixture(t, NodeState.Evaluating);
  const ends = h.revoke();
  assert.ok(ends);
  h.service.reportExecutionEnds(ends);
  assert.equal(h.reported.length, ONE_CALL);
  const [execution, cause, transition, failureCause] = h.reported[0]! as [
    RevokedExecution,
    string,
    unknown,
    unknown,
  ];
  assert.deepEqual(execution, ends.revoked[0]!.execution);
  assert.equal(execution.trace.execution_id, h.executionId);
  assert.equal(cause, RevokeCause.Human);
  assert.equal(transition, null);
  assert.equal(failureCause, null);
});

test("the revocation writes no act trace", (t) => {
  const h = fixture(t, NodeState.Executing);
  const ends = h.revoke();
  assert.ok(ends);
  h.service.reportExecutionEnds(ends);
  assert.equal(h.calls.filter((call) => call.method === ACT).length, NO_CALLS);
});

test("a second call for the same execution answers null and changes nothing", (t) => {
  const h = fixture(t, NodeState.Executing);
  assert.ok(h.revoke());
  const before = databaseSnapshot(h.store);
  const endedAt = h.execution.ended_at;
  const jobs = h.jobs().length;
  assert.equal(h.revoke(), null);
  assert.deepEqual(databaseSnapshot(h.store), before);
  assert.equal(h.execution.ended_at, endedAt);
  assert.equal(h.jobs().length, jobs);
  assert.equal(h.node().state, NodeState.Available);
});

test("a call for an execution that ended answers null and keeps the node", (t) => {
  const h = fixture(t, NodeState.Executing);
  h.execution.ended_at = ENDED_AT;
  const before = databaseSnapshot(h.store);
  assert.equal(h.revoke(), null);
  assert.deepEqual(databaseSnapshot(h.store), before);
  assert.equal(h.node().state, NodeState.Executing);
});

test("a call for an unknown execution answers null", (t) => {
  const h = fixture(t, NodeState.Executing);
  const before = databaseSnapshot(h.store);
  assert.equal(h.revoke(createIdentity("execution")), null);
  assert.deepEqual(databaseSnapshot(h.store), before);
  assert.equal(h.execution.ended_at, null);
});
