import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import {
  BudgetLimit,
  ClaimState,
  EnvironmentFailure,
  ExecutionStopReason,
  TransitionRule,
} from "./contract.ts";
import {
  executionFixture,
  FIRST_LOSS_WITHOUT_JOB,
  FIXTURE_DEADLINE,
  FIXTURE_NOW,
  schedulerHarness,
  transitionFixture,
} from "./test-support.ts";
import { executionTrace } from "./telemetry.ts";
import {
  claimStateOf,
  consecutiveStalls,
  endExecution,
  insertExecution,
  readExecution,
} from "./execution-store.ts";
import {
  consecutiveFailures,
  countsFailure,
  EXECUTION_NOT_RUNNING,
  requireRunning,
  revoke,
  settleNode,
  settleRuntime,
} from "./settlement.ts";

const NO_FAILURES = 0;
const ONE_LOSS = 1;
const SECOND_LOSS = 2;
const THIRD_FAILURE = 3;
const STOP = { reason: ExecutionStopReason.OperationFailed, code: null };
const VERIFICATION_TIMEOUT_STOP = {
  reason: ExecutionStopReason.EnvironmentFailed,
  code: EnvironmentFailure.VerificationTimeout,
  detail: JSON.stringify({
    index: 0,
    limit_ms: 600000,
    exit_code: null,
    command: "sleep 1000",
  }),
};

test("credential pins append once in order, retain after end and select only unended executions", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  const other = executionFixture();
  const first = createIdentity("credential");
  const second = createIdentity("credential");
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    insertExecution(tx, other);
    h.service.pinCredential(tx, row.execution_id, first);
    h.service.pinCredential(tx, row.execution_id, second);
    h.service.pinCredential(tx, row.execution_id, first);
    h.service.pinCredential(tx, other.execution_id, first);
    assert.deepEqual(readExecution(tx, row.execution_id)?.credentials, [
      first,
      second,
    ]);
    assert.deepEqual(
      h.service.liveExecutionsPinning(tx, first),
      [row.execution_id, other.execution_id].sort(),
    );
    h.service.revoke(tx, row.node_id, FIXTURE_NOW);
    assert.throws(() => h.service.pinCredential(tx, row.execution_id, second), {
      code: EXECUTION_NOT_RUNNING,
    });
    assert.throws(
      () => h.service.pinCredential(tx, createIdentity("execution"), first),
      { code: EXECUTION_NOT_RUNNING },
    );
    assert.deepEqual(h.service.liveExecutionsPinning(tx, first), [
      other.execution_id,
    ]);
    assert.deepEqual(readExecution(tx, row.execution_id)?.credentials, [
      first,
      second,
    ]);
  });
});

test("execution attribution reads retained registration and tombstoned binding and allows hosted attribution", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture({ ended_at: FIXTURE_NOW });
  const attribution = {
    client_id: createIdentity("client_identity"),
    name: "retired-program",
  };
  const workerName = "coder@1";
  h.dependencies.registrations.clientAttributionOf = (_tx, runtimeIdentity) => {
    assert.equal(runtimeIdentity, row.runtime_identity);
    return attribution;
  };
  h.dependencies.bindings.workerBindingOf = (
    _tx,
    projectId,
    resourceIdentity,
  ) => {
    assert.equal(projectId, row.project_id);
    assert.equal(resourceIdentity, row.resource_identity);
    return {
      binding_id: row.worker_binding_id,
      worker_name: workerName,
      instance_count: 0,
      tags: [],
      environment: null,
      tombstone: true,
    };
  };
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(h.service.executionAttribution(tx, row.execution_id), {
      client_id: attribution.client_id,
      name: attribution.name,
      worker_name: workerName,
    });
    assert.equal(
      h.service.executionAttribution(tx, createIdentity("execution")),
      null,
    );
    h.dependencies.registrations.clientAttributionOf = () => null;
    assert.deepEqual(h.service.executionAttribution(tx, row.execution_id), {
      client_id: null,
      name: null,
      worker_name: workerName,
    });
  });
});

test("settlement records exactly one loss at the transaction reading", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.equal(
      settleNode(tx, h.dependencies, row.node_id, FIXTURE_NOW),
      null,
    );
    assert.equal(
      h.service.liveExecutionOf(tx, row.node_id, FIXTURE_NOW)?.execution_id,
      row.execution_id,
    );
    assert.deepEqual(
      settleRuntime(tx, h.dependencies, row.runtime_identity, FIXTURE_DEADLINE),
      {
        execution_id: row.execution_id,
        trace: executionTrace(row),
        ended_at: FIXTURE_DEADLINE,
        transition: transitionFixture(),
        hold: FIRST_LOSS_WITHOUT_JOB,
      },
    );
    assert.equal(
      settleNode(tx, h.dependencies, row.node_id, FIXTURE_DEADLINE),
      null,
    );
    assert.equal(
      readExecution(tx, row.execution_id)?.ended_at,
      FIXTURE_DEADLINE,
    );
    assert.equal(
      h.service.runningExecutionOfRuntime(
        tx,
        row.runtime_identity,
        FIXTURE_DEADLINE,
      ),
      null,
    );
  });
  assert.equal(h.calls.length, ONE_LOSS);
  assert.deepEqual(h.calls[0]!.arguments.slice(1), [
    row.node_id,
    ONE_LOSS,
    FIXTURE_DEADLINE,
  ]);
});

test("a loss answers the transition of the failure count below the limit and at the limit", (t) => {
  const h = schedulerHarness(t);
  const limit = SECOND_LOSS;
  const paused = transitionFixture({
    to: "Paused",
    rule: TransitionRule.FailureLimit,
    count: limit,
    limit,
  });
  h.dependencies.transitions.failure = (_tx, _nodeId, count) =>
    count >= limit ? paused : transitionFixture();
  const row = executionFixture();
  const next = executionFixture({ node_id: row.node_id });
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(
      settleNode(tx, h.dependencies, row.node_id, FIXTURE_DEADLINE)?.transition,
      transitionFixture(),
    );
    insertExecution(tx, next);
    assert.deepEqual(
      settleNode(tx, h.dependencies, row.node_id, FIXTURE_DEADLINE + 1)
        ?.transition,
      paused,
    );
  });
});

test("consecutive losses reset after a finished row or revocation and isolate attempts", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    h.service.settle(tx, row.node_id, FIXTURE_DEADLINE);
    const next = executionFixture({ node_id: row.node_id });
    insertExecution(tx, next);
    h.service.settle(tx, row.node_id, FIXTURE_DEADLINE + 1);
    assert.equal(h.calls.at(-1)!.arguments[2], SECOND_LOSS);
    const revoked = executionFixture({
      node_id: row.node_id,
      expired_at: FIXTURE_DEADLINE + 100,
    });
    insertExecution(tx, revoked);
    assert.deepEqual(revoke(tx, row.node_id, FIXTURE_DEADLINE + 2), {
      execution_id: revoked.execution_id,
      trace: executionTrace(revoked),
      ended_at: FIXTURE_DEADLINE + 2,
      stop: null,
    });
    assert.equal(readExecution(tx, revoked.execution_id)?.stop, null);
    assert.equal(
      claimStateOf(
        readExecution(tx, revoked.execution_id)!,
        FIXTURE_DEADLINE + 3,
      ),
      ClaimState.Finished,
    );
    const last = executionFixture({
      node_id: row.node_id,
      expired_at: FIXTURE_DEADLINE + 100,
    });
    insertExecution(tx, last);
    h.service.settle(tx, row.node_id, FIXTURE_DEADLINE + 100);
    assert.equal(h.calls.at(-1)!.arguments[2], ONE_LOSS);
    insertExecution(tx, executionFixture({ node_id: row.node_id, attempt: 2 }));
    h.service.settle(tx, row.node_id, FIXTURE_DEADLINE + 101);
    assert.equal(h.calls.at(-1)!.arguments[2], ONE_LOSS);
  });
});

test("lost and stopped rows count together until a finished row with no stop", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture({ expired_at: FIXTURE_DEADLINE + 100 });
  const at = (offset: number, overrides = {}) =>
    executionFixture({
      node_id: row.node_id,
      expired_at: FIXTURE_DEADLINE + 100,
      ...overrides,
      created_at: FIXTURE_NOW + offset,
    });
  h.store.transaction((tx) => {
    const stopped = at(1);
    insertExecution(tx, stopped);
    endExecution(tx, stopped.execution_id, FIXTURE_DEADLINE, STOP);
    assert.deepEqual(readExecution(tx, stopped.execution_id)?.stop, STOP);
    assert.equal(consecutiveFailures(tx, stopped), ONE_LOSS);
    insertExecution(tx, at(2));
    h.service.settle(tx, row.node_id, FIXTURE_DEADLINE + 100);
    assert.equal(h.calls.at(-1)!.arguments[2], SECOND_LOSS);
    const second = at(3, { expired_at: FIXTURE_DEADLINE + 200 });
    insertExecution(tx, second);
    endExecution(tx, second.execution_id, FIXTURE_DEADLINE + 101, STOP);
    assert.equal(consecutiveFailures(tx, second), THIRD_FAILURE);
    const released = at(4, { expired_at: FIXTURE_DEADLINE + 200 });
    insertExecution(tx, released);
    endExecution(tx, released.execution_id, FIXTURE_DEADLINE + 102);
    assert.equal(readExecution(tx, released.execution_id)?.stop, null);
    const after = at(5, { expired_at: FIXTURE_DEADLINE + 200 });
    insertExecution(tx, after);
    endExecution(tx, after.execution_id, FIXTURE_DEADLINE + 102, STOP);
    assert.equal(consecutiveFailures(tx, after), ONE_LOSS);
  });
});

test("neither operator stop reason counts as a failure", () => {
  for (const reason of [
    ExecutionStopReason.InstanceArchived,
    ExecutionStopReason.WorkerStopped,
  ])
    assert.equal(countsFailure({ reason, code: null }), false);
});

test("a revocation stores the stop it receives", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture({ expired_at: FIXTURE_DEADLINE + 100 });
  const stop = {
    reason: ExecutionStopReason.InstanceArchived,
    code: null,
    detail: JSON.stringify({ instance: "relay-a", actor: "Ulrich" }),
  };
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    const revoked = revoke(tx, row.node_id, FIXTURE_NOW + 1, stop);
    assert.deepEqual(revoked?.stop, stop);
    assert.deepEqual(readExecution(tx, row.execution_id)?.stop, stop);
  });
});

test("an archive row neither counts nor resets the failure count and a null stop row resets it", (t) => {
  const h = schedulerHarness(t);
  const node = createIdentity("node");
  const archived = {
    reason: ExecutionStopReason.InstanceArchived,
    code: null,
  };
  const sequence = (middle: typeof archived | null) => {
    let count = NO_FAILURES;
    h.store.transaction((tx) => {
      const at = (offset: number) =>
        executionFixture({
          node_id: node,
          expired_at: FIXTURE_DEADLINE + 100,
          created_at: FIXTURE_NOW + offset,
        });
      const first = at(1);
      insertExecution(tx, first);
      endExecution(tx, first.execution_id, FIXTURE_NOW + 2, STOP);
      const revoked = at(3);
      insertExecution(tx, revoked);
      endExecution(
        tx,
        revoked.execution_id,
        FIXTURE_NOW + 4,
        middle ?? undefined,
      );
      const last = at(5);
      insertExecution(tx, last);
      endExecution(tx, last.execution_id, FIXTURE_NOW + 6, STOP);
      count = consecutiveFailures(tx, last);
    });
    return count;
  };
  assert.equal(sequence(archived), SECOND_LOSS);
  assert.equal(sequence(null), ONE_LOSS);
});

test("pause facts answer the counts of the count functions and the last stop of the attempt", (t) => {
  const h = schedulerHarness(t);
  const nodeId = createIdentity("node");
  const at = (offset: number, overrides = {}) =>
    executionFixture({
      node_id: nodeId,
      expired_at: FIXTURE_DEADLINE + 100,
      ...overrides,
      created_at: FIXTURE_NOW + offset,
    });
  const detailed = { ...STOP, detail: "boom" };
  const stalled = {
    reason: ExecutionStopReason.BudgetEnd,
    code: BudgetLimit.Turns,
  };
  h.store.transaction((tx) => {
    assert.deepEqual(h.service.pauseFacts(tx, nodeId, 1), {
      consecutive_failures: 0,
      consecutive_stalls: 0,
      last_stop: null,
    });
    const lost = at(1);
    insertExecution(tx, lost);
    endExecution(tx, lost.execution_id, FIXTURE_DEADLINE + 100);
    const first = at(2);
    insertExecution(tx, first);
    endExecution(tx, first.execution_id, FIXTURE_DEADLINE, STOP);
    const last = at(3);
    insertExecution(tx, last);
    endExecution(tx, last.execution_id, FIXTURE_DEADLINE, detailed);
    const other = at(4, { attempt: 2 });
    insertExecution(tx, other);
    endExecution(tx, other.execution_id, FIXTURE_DEADLINE, STOP);
    const facts = h.service.pauseFacts(tx, nodeId, 1);
    assert.equal(facts.consecutive_failures, THIRD_FAILURE);
    assert.equal(facts.consecutive_failures, consecutiveFailures(tx, last));
    assert.equal(facts.consecutive_stalls, consecutiveStalls(tx, nodeId, 1));
    assert.deepEqual(facts.last_stop, {
      execution_id: last.execution_id,
      reason: detailed.reason,
      code: null,
      detail: "boom",
      trace_id: last.trace_id,
    });
    const released = at(5);
    insertExecution(tx, released);
    endExecution(tx, released.execution_id, FIXTURE_DEADLINE);
    assert.deepEqual(h.service.pauseFacts(tx, nodeId, 1), {
      consecutive_failures: 0,
      consecutive_stalls: 0,
      last_stop: null,
    });
    for (const offset of [6, 7]) {
      const row = at(offset);
      insertExecution(tx, row);
      endExecution(tx, row.execution_id, FIXTURE_DEADLINE, stalled);
    }
    const stalls = h.service.pauseFacts(tx, nodeId, 1);
    assert.equal(stalls.consecutive_stalls, SECOND_LOSS);
    assert.equal(stalls.consecutive_stalls, consecutiveStalls(tx, nodeId, 1));
    assert.equal(stalls.consecutive_failures, NO_FAILURES);
    assert.equal(stalls.last_stop?.reason, stalled.reason);
    assert.equal(stalls.last_stop?.code, BudgetLimit.Turns);
    assert.equal(stalls.last_stop?.detail, null);
  });
});

test("a stopped row that ends in the same millisecond after a finished row counts", (t) => {
  const h = schedulerHarness(t);
  const node = createIdentity("node");
  const row = (offset: number) =>
    executionFixture({
      node_id: node,
      expired_at: FIXTURE_DEADLINE + 100,
      created_at: FIXTURE_NOW + offset,
    });
  h.store.transaction((tx) => {
    const released = row(1);
    insertExecution(tx, released);
    endExecution(tx, released.execution_id, FIXTURE_DEADLINE);
    const first = row(2);
    insertExecution(tx, first);
    endExecution(tx, first.execution_id, FIXTURE_DEADLINE, STOP);
    const second = row(3);
    insertExecution(tx, second);
    endExecution(tx, second.execution_id, FIXTURE_DEADLINE, STOP);
    assert.equal(consecutiveFailures(tx, second), SECOND_LOSS);
  });
});

test("revocation at expiry writes nothing and runtime lookup settles first", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.equal(revoke(tx, row.node_id, FIXTURE_DEADLINE), null);
    assert.equal(revoke(tx, row.node_id, FIXTURE_DEADLINE + 1), null);
    assert.equal(readExecution(tx, row.execution_id)?.ended_at, null);
    assert.equal(
      h.service.runningExecutionOfRuntime(
        tx,
        row.runtime_identity,
        FIXTURE_DEADLINE,
      ),
      null,
    );
    assert.equal(
      readExecution(tx, row.execution_id)?.ended_at,
      FIXTURE_DEADLINE,
    );
  });
  assert.equal(h.calls.length, ONE_LOSS);
});

test("transactional proof rejects wrong claimants, ended claims and equality", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(
      requireRunning(tx, row.execution_id, row.runtime_identity, FIXTURE_NOW),
      row,
    );
    for (const [id, runtime, now] of [
      [createIdentity("execution"), row.runtime_identity, FIXTURE_NOW],
      [row.execution_id, createIdentity("worker_registration"), FIXTURE_NOW],
      [row.execution_id, row.runtime_identity, FIXTURE_DEADLINE],
    ] as const)
      assert.throws(() => requireRunning(tx, id, runtime, now), {
        code: EXECUTION_NOT_RUNNING,
      });
    h.service.revoke(tx, row.node_id, FIXTURE_NOW);
    assert.throws(
      () =>
        requireRunning(tx, row.execution_id, row.runtime_identity, FIXTURE_NOW),
      { code: EXECUTION_NOT_RUNNING },
    );
  });
  assert.deepEqual(h.calls, []);
});

test("a failed Mission loss rolls back the terminal write", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  const failure = new Error("Mission loss failed");
  h.dependencies.transitions.failure = () => {
    throw failure;
  };
  h.store.transaction((tx) => insertExecution(tx, row));
  assert.throws(
    () =>
      h.store.transaction((tx) =>
        h.service.settle(tx, row.node_id, FIXTURE_DEADLINE),
      ),
    failure,
  );
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, row.execution_id))?.ended_at,
    null,
  );
});

test("a verification_timeout stop counts as a failure and the third in a row pauses the node with failure_limit", (t) => {
  const h = schedulerHarness(t);
  assert.equal(countsFailure(VERIFICATION_TIMEOUT_STOP), true);
  const paused = transitionFixture({
    to: "Paused",
    rule: TransitionRule.FailureLimit,
    count: THIRD_FAILURE,
    limit: THIRD_FAILURE,
  });
  h.dependencies.transitions.failure = (_tx, _nodeId, count) =>
    count >= THIRD_FAILURE ? paused : transitionFixture();
  const nodeId = createIdentity("node");
  const at = (offset: number) =>
    executionFixture({
      node_id: nodeId,
      expired_at: FIXTURE_DEADLINE + 100,
      created_at: FIXTURE_NOW + offset,
    });
  h.store.transaction((tx) => {
    const counts = [];
    for (const offset of [1, 2, 3]) {
      const row = at(offset);
      insertExecution(tx, row);
      endExecution(
        tx,
        row.execution_id,
        FIXTURE_DEADLINE,
        VERIFICATION_TIMEOUT_STOP,
      );
      counts.push(consecutiveFailures(tx, row));
    }
    assert.deepEqual(counts, [ONE_LOSS, SECOND_LOSS, THIRD_FAILURE]);
    assert.equal(
      h.service.pauseFacts(tx, nodeId, 1).consecutive_failures,
      THIRD_FAILURE,
    );
    const failure = h.dependencies.transitions.failure;
    assert.deepEqual(
      failure(tx, nodeId, counts[0]!, FIXTURE_DEADLINE),
      transitionFixture(),
    );
    assert.deepEqual(failure(tx, nodeId, counts[2]!, FIXTURE_DEADLINE), paused);
  });
});
