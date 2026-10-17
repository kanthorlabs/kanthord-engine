import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  importAdmissible,
  isTerminal,
  nodeApiWriteAdmissible,
  reconcileJob,
} from "./admission.ts";
import { MISSION_SERVICE_NAME, NodeState, type WorkQueue } from "./contract.ts";
import { missionMigrations } from "./migrations.ts";

const PROJECT_ID = "project_00000000000000000000000000";
const QUEUED_NODE_ID = "node-id";
const INITIAL_ATTEMPT = 0;
const NEXT_ATTEMPT = 1;
const PRIORITY = 9;
const DEFAULT_PRIORITY = 0;
const STATES = Object.values(NodeState);
const UNEXPECTED_CALL = "unexpected priority update";

function fixture(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  return store;
}

for (const state of [...STATES, null]) {
  test(`isTerminal: ${state}`, () => {
    assert.equal(
      isTerminal(state),
      state === NodeState.Completed || state === NodeState.Discarded,
    );
  });
  test(`nodeApiWriteAdmissible: ${state}`, () => {
    assert.equal(
      nodeApiWriteAdmissible(state),
      state !== NodeState.Completed && state !== NodeState.Discarded,
    );
  });
}

for (const [state, attempt, expected] of [
  [NodeState.Pending, INITIAL_ATTEMPT, true],
  [NodeState.Available, INITIAL_ATTEMPT, true],
  [NodeState.Executing, INITIAL_ATTEMPT, false],
  [NodeState.Pending, NEXT_ATTEMPT, false],
  [null, INITIAL_ATTEMPT, false],
  [NodeState.Available, null, true],
] as const) {
  test(`importAdmissible: ${state}, ${attempt}`, () => {
    assert.equal(importAdmissible(state, attempt), expected);
  });
}

for (const [previous, current, expected] of [
  [false, false, []],
  [false, true, ["insert"]],
  [true, false, ["delete"]],
  [true, true, []],
] as const) {
  test(`reconcileJob: ${previous} -> ${current}`, (t) => {
    const store = fixture(t);
    const calls: string[] = [];
    const workQueue: WorkQueue = {
      insert(tx, nodeId, projectId, priority) {
        assert.equal(tx.database, store.database);
        assert.equal(nodeId, QUEUED_NODE_ID);
        assert.equal(projectId, PROJECT_ID);
        assert.equal(priority, PRIORITY);
        calls.push("insert");
      },
      delete(tx, nodeId) {
        assert.equal(tx.database, store.database);
        assert.equal(nodeId, QUEUED_NODE_ID);
        calls.push("delete");
      },
      priorityUpdate() {
        throw new Error(UNEXPECTED_CALL);
      },
    };
    store.transaction((tx) =>
      reconcileJob(
        tx,
        workQueue,
        QUEUED_NODE_ID,
        PROJECT_ID,
        PRIORITY,
        previous,
        current,
      ),
    );
    assert.deepEqual(calls, expected);
  });
}

test("reconcileJob maps null priority to zero", (t) => {
  const store = fixture(t);
  let receivedPriority: number | null = null;
  const workQueue: WorkQueue = {
    insert(_tx, _nodeId, _projectId, priority) {
      receivedPriority = priority;
    },
    delete() {
      throw new Error(UNEXPECTED_CALL);
    },
    priorityUpdate() {
      throw new Error(UNEXPECTED_CALL);
    },
  };
  store.transaction((tx) =>
    reconcileJob(tx, workQueue, QUEUED_NODE_ID, PROJECT_ID, null, false, true),
  );
  assert.equal(receivedPriority, DEFAULT_PRIORITY);
});
