import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { ClaimState } from "./contract.ts";
const ONE_EXECUTION = 1;
const NO_EXECUTIONS = 0;
import {
  executionFixture,
  schedulerHarness,
  FIXTURE_NOW,
  FIXTURE_DEADLINE,
} from "./test-support.ts";
import {
  insertExecution,
  readExecution,
  readUnendedOfNode,
  readUnendedOfRuntime,
  readExpiredUnsettled,
  countRunningOfGroup,
  endExecution,
  listExecutions,
  claimStateOf,
  executionRecord,
} from "./execution-store.ts";

test("claim state derives at the deadline, independently of settlement", () => {
  const row = executionFixture();
  for (const now of [
    FIXTURE_DEADLINE - 1,
    FIXTURE_DEADLINE,
    FIXTURE_DEADLINE + 1,
  ]) {
    assert.equal(
      claimStateOf(row, now),
      now < FIXTURE_DEADLINE ? ClaimState.Running : ClaimState.Lost,
    );
    assert.equal(
      claimStateOf({ ...row, endedAt: FIXTURE_DEADLINE - 1 }, now),
      ClaimState.Finished,
    );
    assert.equal(
      claimStateOf({ ...row, endedAt: FIXTURE_DEADLINE }, now),
      ClaimState.Lost,
    );
    assert.equal(
      claimStateOf({ ...row, endedAt: FIXTURE_DEADLINE + 1 }, now),
      ClaimState.Lost,
    );
  }
});

test("execution uniqueness and terminal writes are transactional", (t) => {
  const { store } = schedulerHarness(t);
  const row = executionFixture({ credentials: [createIdentity("credential")] });
  store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(readExecution(tx, row.executionId), row);
    assert.deepEqual(readUnendedOfNode(tx, row.nodeId), row);
    assert.deepEqual(readUnendedOfRuntime(tx, row.runtimeIdentity), row);
    assert.throws(
      () => insertExecution(tx, executionFixture({ nodeId: row.nodeId })),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        insertExecution(
          tx,
          executionFixture({ runtimeIdentity: row.runtimeIdentity }),
        ),
      /UNIQUE/,
    );
    assert.equal(
      countRunningOfGroup(tx, row.projectId, row.resourceIdentity, FIXTURE_NOW),
      ONE_EXECUTION,
    );
    assert.equal(
      countRunningOfGroup(
        tx,
        row.projectId,
        row.resourceIdentity,
        FIXTURE_DEADLINE,
      ),
      NO_EXECUTIONS,
    );
    assert.deepEqual(readExpiredUnsettled(tx, FIXTURE_DEADLINE), [row]);
    endExecution(tx, row.executionId, FIXTURE_NOW);
    assert.throws(() => endExecution(tx, row.executionId, FIXTURE_NOW));
    assert.equal(readUnendedOfNode(tx, row.nodeId), null);
    insertExecution(tx, {
      ...row,
      executionId: createIdentity("execution"),
      credentials: [],
    });
  });
  const sentinel = new Error("rollback");
  assert.throws(
    () =>
      store.transaction((tx) => {
        endExecution(
          tx,
          readUnendedOfNode(tx, row.nodeId)!.executionId,
          FIXTURE_NOW,
        );
        throw sentinel;
      }),
    sentinel,
  );
  assert.ok(store.transaction((tx) => readUnendedOfNode(tx, row.nodeId)));
});

test("execution listing isolates projects, filters attempts, and bounds pages", (t) => {
  const { store } = schedulerHarness(t);
  const first = executionFixture({ endedAt: FIXTURE_NOW });
  const second = executionFixture({
    projectId: first.projectId,
    nodeId: first.nodeId,
    attempt: 2,
  });
  const third = executionFixture({ projectId: first.projectId });
  store.transaction((tx) => {
    for (const row of [first, second, third, executionFixture()])
      insertExecution(tx, row);
    const ordered = [first, second, third].sort((a, b) =>
      b.executionId.localeCompare(a.executionId),
    );
    assert.deepEqual(
      listExecutions(tx, first.projectId, {}, undefined, 1),
      ordered.slice(0, 2),
    );
    assert.deepEqual(
      listExecutions(tx, first.projectId, {}, ordered[1]!.executionId, 1),
      ordered.slice(2),
    );
    assert.deepEqual(
      listExecutions(
        tx,
        first.projectId,
        { nodeId: first.nodeId, attempt: 2 },
        undefined,
        10,
      ),
      [second],
    );
    assert.deepEqual(
      listExecutions(
        tx,
        first.projectId,
        { nodeId: first.nodeId, attempt: 3 },
        undefined,
        10,
      ),
      [],
    );
    assert.deepEqual(
      listExecutions(
        tx,
        first.projectId,
        { nodeId: createIdentity("node") },
        undefined,
        10,
      ),
      [],
    );
  });
});

test("record mapping omits hosted attribution and keeps ended registration attribution", (t) => {
  const h = schedulerHarness(t);
  const row = executionFixture();
  h.store.transaction((tx) => {
    const hosted = executionRecord(
      tx,
      h.dependencies.registrations,
      row,
      FIXTURE_NOW,
    );
    assert.equal(Object.hasOwn(hosted.claimant, "clientId"), false);
    assert.equal(Object.hasOwn(hosted.claimant, "name"), false);
    const attribution = {
      client_id: createIdentity("client_identity"),
      name: "ended worker",
    };
    const retained = executionRecord(
      tx,
      {
        ...h.dependencies.registrations,
        clientAttributionOf: () => attribution,
      },
      { ...row, endedAt: FIXTURE_NOW },
      FIXTURE_DEADLINE,
    );
    assert.equal(retained.claimant.clientId, attribution.client_id);
    assert.equal(retained.claimant.name, attribution.name);
    assert.equal(retained.claimState, ClaimState.Finished);
  });
});
