import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  computeInitiativeClaimable,
  importAdmissible,
  isObjectiveClaimable,
  isTerminal,
  nodeApiWriteAdmissible,
  parentCreateAdmissible,
  reconcileJob,
} from "./admission.ts";
import {
  MISSION_SERVICE_NAME,
  NodeKind,
  NodeState,
  type WorkQueue,
} from "./contract.ts";
import { missionMigrations } from "./migrations.ts";

const PROJECT_ID = "project_00000000000000000000000000";
const QUEUED_NODE_ID = "node-id";
const CREATED_AT = 1000;
const RETIRED_AT = 2000;
const FIRST_VERSION = 1;
const INITIAL_ATTEMPT = 0;
const NEXT_ATTEMPT = 1;
const PRIORITY = 9;
const DEFAULT_PRIORITY = 0;
const STATES = Object.values(NodeState);
const ADMITTED_PARENTS: ReadonlySet<string> = new Set([
  NodeState.Pending,
  NodeState.Available,
  NodeState.Executing,
  NodeState.Blocked,
  NodeState.Paused,
]);
const UNEXPECTED_CALL = "unexpected priority update";

function fixture(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  return store;
}

function insertNode(
  tx: Transaction,
  missionId: string,
  state: string,
  parentId: string | null = null,
  retiredAt: number | null = null,
): string {
  const id = createIdentity("node");
  tx.database
    .prepare(
      `INSERT INTO mission_node (id, mission_id, kind, filename, parent_id, state, retired_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      missionId,
      parentId === null ? NodeKind.Initiative : NodeKind.Objective,
      `${id}.md`,
      parentId,
      state,
      retiredAt,
      CREATED_AT,
    );
  return id;
}

function insertMission(tx: Transaction): string {
  const id = createIdentity("mission");
  tx.database
    .prepare(
      "INSERT INTO mission_mission (id, project_id, version, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, PROJECT_ID, FIRST_VERSION, CREATED_AT);
  return id;
}

for (const state of [...STATES, null]) {
  test(`isTerminal: ${state}`, () => {
    assert.equal(
      isTerminal(state),
      state === NodeState.Completed || state === NodeState.Discarded,
    );
  });
  test(`parentCreateAdmissible: ${state}`, () => {
    assert.equal(
      parentCreateAdmissible(state),
      state !== null && ADMITTED_PARENTS.has(state),
    );
  });
  test(`isObjectiveClaimable: ${state}`, () => {
    assert.equal(isObjectiveClaimable(state), state === NodeState.Available);
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

for (const [label, children, initiativeState, expected] of [
  [
    "all terminal",
    [NodeState.Completed, NodeState.Discarded],
    NodeState.Available,
    true,
  ],
  [
    "one nonterminal",
    [NodeState.Completed, NodeState.Pending],
    NodeState.Available,
    false,
  ],
  ["no objectives", [], NodeState.Available, true],
  ["pending initiative", [NodeState.Completed], NodeState.Pending, false],
] as const) {
  test(`computeInitiativeClaimable: ${label}`, (t) => {
    const store = fixture(t);
    store.transaction((tx) => {
      const missionId = insertMission(tx);
      const initiativeId = insertNode(tx, missionId, initiativeState);
      for (const state of children)
        insertNode(tx, missionId, state, initiativeId);
      assert.equal(computeInitiativeClaimable(tx, initiativeId), expected);
    });
  });
}

test("computeInitiativeClaimable ignores retired nonterminal objectives", (t) => {
  const store = fixture(t);
  store.transaction((tx) => {
    const missionId = insertMission(tx);
    const initiativeId = insertNode(tx, missionId, NodeState.Available);
    insertNode(tx, missionId, NodeState.Completed, initiativeId);
    insertNode(tx, missionId, NodeState.Pending, initiativeId, RETIRED_AT);
    assert.equal(computeInitiativeClaimable(tx, initiativeId), true);
  });
});

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
