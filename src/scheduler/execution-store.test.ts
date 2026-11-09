import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
const ONE_EXECUTION = 1;
const NO_EXECUTIONS = 0;
import {
  executionFixture,
  FIXTURE_DEADLINE,
  FIXTURE_NOW,
  schedulerHarness,
} from "./test-support.ts";
import {
  countRunningOfGroup,
  endExecution,
  insertExecution,
  readExecution,
  readExpiredUnsettled,
  readUnendedOfNode,
  readUnendedOfRuntime,
} from "./execution-store.ts";

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

test("the stored agent_selections column holds only the agent name, the enablement revision and the position", (t) => {
  const h = schedulerHarness(t);
  const pin = {
    agent_name: "swe@1",
    enablement_id: createIdentity("agent_enablement"),
    position: 2,
  };
  const row = executionFixture({ agent_pins: [pin] });
  h.store.transaction((tx) => insertExecution(tx, row));
  const stored = h.store.transaction(
    (tx) =>
      tx.database
        .prepare(
          "SELECT agent_selections FROM scheduler_execution WHERE id = ?",
        )
        .get(row.execution_id)!.agent_selections,
  );
  assert.deepEqual(JSON.parse(stored as string), [pin]);
  assert.deepEqual(
    h.store.transaction(
      (tx) => readExecution(tx, row.execution_id)?.agent_pins,
    ),
    [pin],
  );
  assert.throws(() =>
    h.store.transaction((tx) =>
      insertExecution(
        tx,
        executionFixture({
          agent_pins: [{ ...pin, credential: "qwen-key" } as never],
        }),
      ),
    ),
  );
});
