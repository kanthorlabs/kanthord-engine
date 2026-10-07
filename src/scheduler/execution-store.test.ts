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
      claimStateOf({ ...row, ended_at: FIXTURE_DEADLINE - 1 }, now),
      ClaimState.Finished,
    );
    assert.equal(
      claimStateOf({ ...row, ended_at: FIXTURE_DEADLINE }, now),
      ClaimState.Lost,
    );
    assert.equal(
      claimStateOf({ ...row, ended_at: FIXTURE_DEADLINE + 1 }, now),
      ClaimState.Lost,
    );
  }
});

test("execution uniqueness and terminal writes are transactional", (t) => {
  const { store } = schedulerHarness(t);
  const row = executionFixture({ credentials: [createIdentity("credential")] });
  store.transaction((tx) => {
    insertExecution(tx, row);
    assert.deepEqual(readExecution(tx, row.execution_id), row);
    assert.deepEqual(readUnendedOfNode(tx, row.node_id), row);
    assert.deepEqual(readUnendedOfRuntime(tx, row.runtime_identity), row);
    assert.throws(
      () => insertExecution(tx, executionFixture({ node_id: row.node_id })),
      /UNIQUE/,
    );
    assert.throws(
      () =>
        insertExecution(
          tx,
          executionFixture({ runtime_identity: row.runtime_identity }),
        ),
      /UNIQUE/,
    );
    assert.equal(
      countRunningOfGroup(
        tx,
        row.project_id,
        row.resource_identity,
        FIXTURE_NOW,
      ),
      ONE_EXECUTION,
    );
    assert.equal(
      countRunningOfGroup(
        tx,
        row.project_id,
        row.resource_identity,
        FIXTURE_DEADLINE,
      ),
      NO_EXECUTIONS,
    );
    assert.deepEqual(readExpiredUnsettled(tx, FIXTURE_DEADLINE), [row]);
    endExecution(tx, row.execution_id, FIXTURE_NOW);
    assert.throws(() => endExecution(tx, row.execution_id, FIXTURE_NOW));
    assert.equal(readUnendedOfNode(tx, row.node_id), null);
    insertExecution(tx, {
      ...row,
      execution_id: createIdentity("execution"),
      credentials: [],
    });
  });
  const sentinel = new Error("rollback");
  assert.throws(
    () =>
      store.transaction((tx) => {
        endExecution(
          tx,
          readUnendedOfNode(tx, row.node_id)!.execution_id,
          FIXTURE_NOW,
        );
        throw sentinel;
      }),
    sentinel,
  );
  assert.ok(store.transaction((tx) => readUnendedOfNode(tx, row.node_id)));
});

test("execution listing isolates projects, filters attempts, and bounds pages", (t) => {
  const { store } = schedulerHarness(t);
  const first = executionFixture({ ended_at: FIXTURE_NOW });
  const second = executionFixture({
    project_id: first.project_id,
    node_id: first.node_id,
    attempt: 2,
  });
  const third = executionFixture({ project_id: first.project_id });
  store.transaction((tx) => {
    for (const row of [first, second, third, executionFixture()])
      insertExecution(tx, row);
    const ordered = [first, second, third].sort((a, b) =>
      b.execution_id.localeCompare(a.execution_id),
    );
    assert.deepEqual(
      listExecutions(tx, first.project_id, {}, undefined, 1),
      ordered.slice(0, 2),
    );
    assert.deepEqual(
      listExecutions(tx, first.project_id, {}, ordered[1]!.execution_id, 1),
      ordered.slice(2),
    );
    assert.deepEqual(
      listExecutions(
        tx,
        first.project_id,
        { node_id: first.node_id, attempt: 2 },
        undefined,
        10,
      ),
      [second],
    );
    assert.deepEqual(
      listExecutions(
        tx,
        first.project_id,
        { node_id: first.node_id, attempt: 3 },
        undefined,
        10,
      ),
      [],
    );
    assert.deepEqual(
      listExecutions(
        tx,
        first.project_id,
        { node_id: createIdentity("node") },
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
    assert.equal(Object.hasOwn(hosted.claimant, "client_id"), false);
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
      { ...row, ended_at: FIXTURE_NOW },
      FIXTURE_DEADLINE,
    );
    assert.equal(retained.claimant.client_id, attribution.client_id);
    assert.equal(retained.claimant.name, attribution.name);
    assert.equal(retained.claim_state, ClaimState.Finished);
  });
});
