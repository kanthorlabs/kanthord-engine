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
    h.service.pinCredential(tx, row.executionId, first);
    h.service.pinCredential(tx, row.executionId, second);
    h.service.pinCredential(tx, row.executionId, first);
    h.service.pinCredential(tx, other.executionId, first);
    assert.deepEqual(readExecution(tx, row.executionId)?.credentials, [
      first,
      second,
    ]);
    assert.deepEqual(
      h.service.liveExecutionsPinning(tx, first),
      [row.executionId, other.executionId].sort(),
    );
    h.service.revoke(tx, row.nodeId, FIXTURE_NOW);
    assert.throws(() => h.service.pinCredential(tx, row.executionId, second), {
      code: EXECUTION_NOT_RUNNING,
    });
    assert.throws(
      () => h.service.pinCredential(tx, createIdentity("execution"), first),
      { code: EXECUTION_NOT_RUNNING },
    );
    assert.deepEqual(h.service.liveExecutionsPinning(tx, first), [
      other.executionId,
    ]);
    assert.deepEqual(readExecution(tx, row.executionId)?.credentials, [
      first,
      second,
    ]);
  });
});

test("execution attribution reads retained registration and tombstoned binding and allows hosted attribution", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture({ endedAt: FIXTURE_NOW });
  const attribution = {
    client_id: createIdentity("client_identity"),
    name: "retired-program",
  };
  const workerName = "general@1";
  h.dependencies.registrations.clientAttributionOf = (_tx, runtimeIdentity) => {
    assert.equal(runtimeIdentity, row.runtimeIdentity);
    return attribution;
  };
  h.dependencies.bindings.workerBindingOf = (
    _tx,
    projectId,
    resourceIdentity,
  ) => {
    assert.equal(projectId, row.projectId);
    assert.equal(resourceIdentity, row.resourceIdentity);
    return {
      bindingId: row.workerBindingId,
      workerName,
      instanceCount: 0,
      tombstone: true,
    };
  };
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(h.service.executionAttribution(tx, row.executionId), {
      clientId: attribution.client_id,
      name: attribution.name,
      workerName,
    });
    assert.equal(
      h.service.executionAttribution(tx, createIdentity("execution")),
      null,
    );
    h.dependencies.registrations.clientAttributionOf = () => null;
    assert.deepEqual(h.service.executionAttribution(tx, row.executionId), {
      clientId: null,
      name: null,
      workerName,
    });
  });
});

test("settlement records exactly one loss at the transaction reading", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.equal(
      settleNode(tx, h.dependencies, row.nodeId, FIXTURE_NOW),
      false,
    );
    assert.equal(
      h.service.liveExecutionOf(tx, row.nodeId, FIXTURE_NOW)?.executionId,
      row.executionId,
    );
    assert.equal(
      settleRuntime(tx, h.dependencies, row.runtimeIdentity, FIXTURE_DEADLINE),
      true,
    );
    assert.equal(
      settleNode(tx, h.dependencies, row.nodeId, FIXTURE_DEADLINE),
      false,
    );
    assert.equal(readExecution(tx, row.executionId)?.endedAt, FIXTURE_DEADLINE);
    assert.equal(
      h.service.runningExecutionOfRuntime(
        tx,
        row.runtimeIdentity,
        FIXTURE_DEADLINE,
      ),
      null,
    );
  });
  assert.equal(h.calls.length, ONE_LOSS);
  assert.deepEqual(h.calls[0]!.arguments.slice(1), [
    row.nodeId,
    ONE_LOSS,
    FIXTURE_DEADLINE,
  ]);
});

test("consecutive losses reset after a finished row or revocation and isolate attempts", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    h.service.settle(tx, row.nodeId, FIXTURE_DEADLINE);
    const next = executionFixture({ nodeId: row.nodeId });
    insertExecution(tx, next);
    h.service.settle(tx, row.nodeId, FIXTURE_DEADLINE + 1);
    assert.equal(h.calls.at(-1)!.arguments[2], SECOND_LOSS);
    const revoked = executionFixture({
      nodeId: row.nodeId,
      expiredAt: FIXTURE_DEADLINE + 100,
    });
    insertExecution(tx, revoked);
    assert.equal(
      revoke(tx, row.nodeId, FIXTURE_DEADLINE + 2),
      revoked.executionId,
    );
    assert.equal(
      claimStateOf(
        readExecution(tx, revoked.executionId)!,
        FIXTURE_DEADLINE + 3,
      ),
      ClaimState.Finished,
    );
    const last = executionFixture({
      nodeId: row.nodeId,
      expiredAt: FIXTURE_DEADLINE + 100,
    });
    insertExecution(tx, last);
    h.service.settle(tx, row.nodeId, FIXTURE_DEADLINE + 100);
    assert.equal(h.calls.at(-1)!.arguments[2], ONE_LOSS);
    insertExecution(tx, executionFixture({ nodeId: row.nodeId, attempt: 2 }));
    h.service.settle(tx, row.nodeId, FIXTURE_DEADLINE + 101);
    assert.equal(h.calls.at(-1)!.arguments[2], ONE_LOSS);
  });
});

test("revocation at expiry writes nothing and runtime lookup settles first", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.equal(revoke(tx, row.nodeId, FIXTURE_DEADLINE), null);
    assert.equal(revoke(tx, row.nodeId, FIXTURE_DEADLINE + 1), null);
    assert.equal(readExecution(tx, row.executionId)?.endedAt, null);
    assert.equal(
      h.service.runningExecutionOfRuntime(
        tx,
        row.runtimeIdentity,
        FIXTURE_DEADLINE,
      ),
      null,
    );
    assert.equal(readExecution(tx, row.executionId)?.endedAt, FIXTURE_DEADLINE);
  });
  assert.equal(h.calls.length, ONE_LOSS);
});

test("transactional proof rejects wrong claimants, ended claims and equality", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(
      requireRunning(tx, row.executionId, row.runtimeIdentity, FIXTURE_NOW),
      row,
    );
    for (const [id, runtime, now] of [
      [createIdentity("execution"), row.runtimeIdentity, FIXTURE_NOW],
      [row.executionId, createIdentity("worker_instance"), FIXTURE_NOW],
      [row.executionId, row.runtimeIdentity, FIXTURE_DEADLINE],
    ] as const)
      assert.throws(() => requireRunning(tx, id, runtime, now), {
        code: EXECUTION_NOT_RUNNING,
      });
    h.service.revoke(tx, row.nodeId, FIXTURE_NOW);
    assert.throws(
      () =>
        requireRunning(tx, row.executionId, row.runtimeIdentity, FIXTURE_NOW),
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
        h.service.settle(tx, row.nodeId, FIXTURE_DEADLINE),
      ),
    failure,
  );
  assert.equal(
    h.store.transaction((tx) => readExecution(tx, row.executionId))?.endedAt,
    null,
  );
});
