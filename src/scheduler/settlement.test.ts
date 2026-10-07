import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { ClaimState } from "./contract.ts";
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  FIXTURE_DEADLINE,
} from "./test-support.ts";
import {
  insertExecution,
  readExecution,
  claimStateOf,
} from "./execution-store.ts";
import {
  settleNode,
  settleRuntime,
  revoke,
  requireRunning,
  EXECUTION_NOT_RUNNING,
} from "./settlement.ts";

const ONE_LOSS = 1;
const SECOND_LOSS = 2;

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
  const workerName = "general@1";
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
      false,
    );
    assert.equal(
      h.service.liveExecutionOf(tx, row.node_id, FIXTURE_NOW)?.execution_id,
      row.execution_id,
    );
    assert.equal(
      settleRuntime(tx, h.dependencies, row.runtime_identity, FIXTURE_DEADLINE),
      true,
    );
    assert.equal(
      settleNode(tx, h.dependencies, row.node_id, FIXTURE_DEADLINE),
      false,
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
    assert.equal(
      revoke(tx, row.node_id, FIXTURE_DEADLINE + 2),
      revoked.execution_id,
    );
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
      [row.execution_id, createIdentity("worker_instance"), FIXTURE_NOW],
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
  h.dependencies.transitions.loss = () => {
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
