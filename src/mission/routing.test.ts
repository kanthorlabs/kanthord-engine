import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { isTerminal } from "./admission.ts";
import { continuationHolds, readinessOf } from "./conditions.ts";
import { NodeState } from "./contract.ts";
import { type DepEdge, directDependenciesOf } from "./graph.ts";
import {
  claimableMap,
  nodeClaimable,
  reconcileMission,
  routeMission,
} from "./routing.ts";
import {
  insertDependency,
  insertMission,
  insertNode,
  readMissionNodes,
  readNode,
  setNodeState,
} from "./store.ts";
import { missionHarness } from "./test-support.ts";

const NOW = 100;
const NODE_COUNT = 60;
const RETIRED_EVERY = 7;
const RETIRED_REMAINDER = 0;
const NO_CHANGES = 0;
const EDGE_ODDS = 0.08;
const GENERATOR_SEED = 20261018;
const QUEUE_PREFIX = "workQueue.";
const QUEUE_DELETE = "workQueue.delete";
const NODE_ID_ARGUMENT = 1;
const NODE_STATES = Object.values(NodeState);
const ROUTED_STATES: string[] = [NodeState.Pending, NodeState.Available];

function seededGenerator(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function itemAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  assert.ok(item !== undefined, "The index holds an item.");
  return item;
}

function routingHarness(t: TestContext) {
  const projectId = createIdentity("project");
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const missionId = h.store.transaction((tx) =>
    insertMission(tx, projectId, NOW),
  );
  const create = (state: NodeState) => {
    const id = createIdentity("node");
    h.store.transaction((tx) => {
      insertNode(tx, {
        id,
        mission_id: missionId,
        filename: `${id}.md`,
        created_at: NOW,
      });
      setNodeState(tx, id, state);
    });
    return id;
  };
  const depend = (dependent: string, dependsOn: string) =>
    h.store.transaction((tx) =>
      insertDependency(tx, missionId, dependent, dependsOn),
    );
  const retire = (id: string) =>
    h.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(NOW, id),
    );
  const route = () => h.store.transaction((tx) => routeMission(tx, missionId));
  const states = () =>
    new Map(
      h.store.transaction((tx) =>
        readMissionNodes(tx, missionId).map((node) => [node.id, node.state]),
      ),
    );
  return { ...h, projectId, missionId, create, depend, retire, route, states };
}

function randomGraph(h: ReturnType<typeof routingHarness>) {
  const random = seededGenerator(GENERATOR_SEED);
  const ids: string[] = [];
  const retired = new Set<string>();
  for (let index = 0; index < NODE_COUNT; index++) {
    const state = itemAt(
      NODE_STATES,
      index < NODE_STATES.length
        ? index
        : Math.floor(random() * NODE_STATES.length),
    );
    ids.push(h.create(state));
  }
  const edges: DepEdge[] = [];
  for (let high = 1; high < NODE_COUNT; high++) {
    for (let low = 0; low < high; low++) {
      if (random() >= EDGE_ODDS) continue;
      const dependent = itemAt(ids, high);
      const dependsOn = itemAt(ids, low);
      h.depend(dependent, dependsOn);
      edges.push({ dependent, depends_on: dependsOn });
    }
  }
  ids.forEach((id, index) => {
    if (index % RETIRED_EVERY !== RETIRED_REMAINDER) return;
    h.retire(id);
    retired.add(id);
  });
  return { ids, edges, retired };
}

function expectedStates(
  before: Map<string, string>,
  edges: DepEdge[],
  retired: Set<string>,
) {
  const live = edges.filter(
    (edge) => !retired.has(edge.dependent) && !retired.has(edge.depends_on),
  );
  const expected = new Map(before);
  for (const [id, state] of before) {
    if (retired.has(id) || !ROUTED_STATES.includes(state)) continue;
    const available = directDependenciesOf(id, live).every(
      (dependencyId) => before.get(dependencyId) === NodeState.Completed,
    );
    expected.set(id, available ? NodeState.Available : NodeState.Pending);
  }
  return expected;
}

test("routing with the dependency map answers the per-node routing", (t) => {
  const h = routingHarness(t);
  const { edges, retired } = randomGraph(h);
  const before = h.states();
  assert.deepEqual(
    new Set(before.values()),
    new Set(NODE_STATES),
    "The graph holds every node state.",
  );
  h.route();
  assert.deepEqual(h.states(), expectedStates(before, edges, retired));
});

test("routing writes the state of a node only when the state changes", (t) => {
  const h = routingHarness(t);
  const { edges, retired } = randomGraph(h);
  const before = h.states();
  const expected = expectedStates(before, edges, retired);
  const changed = [...before.keys()]
    .filter((id) => before.get(id) !== expected.get(id))
    .sort();
  assert.ok(
    changed.length > NO_CHANGES,
    "The graph changes at least one node.",
  );
  h.store.database.exec("CREATE TEMP TABLE state_log (node_id TEXT NOT NULL)");
  h.store.database.exec(
    `CREATE TEMP TRIGGER state_log_write AFTER UPDATE OF state ON main.mission_node
    BEGIN INSERT INTO state_log (node_id) VALUES (new.id); END`,
  );
  const logged = () =>
    (
      h.store.database
        .prepare("SELECT node_id FROM state_log ORDER BY node_id")
        .all() as { node_id: string }[]
    ).map((row) => row.node_id);
  h.route();
  assert.deepEqual(logged(), changed);
  h.route();
  assert.deepEqual(logged(), changed);
});

function queueCalls(h: ReturnType<typeof routingHarness>) {
  return h.calls
    .filter((call) => call.method.startsWith(QUEUE_PREFIX))
    .map((call) => [call.method, call.arguments[NODE_ID_ARGUMENT]]);
}

test("claimableMap answers each live node and no terminal or retired node", (t) => {
  const h = routingHarness(t);
  const { ids, retired } = randomGraph(h);
  h.store.transaction((tx) => {
    const map = claimableMap(tx, h.missionId, h.dependencies.bindings);
    const nodes = new Map(ids.map((id) => [id, readNode(tx, id)!]));
    const live = ids
      .filter((id) => !retired.has(id) && !isTerminal(nodes.get(id)!.state))
      .sort();
    assert.deepEqual([...map.keys()].sort(), live);
    for (const [id, claimable] of map) {
      const node = nodes.get(id)!;
      const expected =
        node.state === NodeState.Available ||
        (node.state === NodeState.Waiting && readinessOf(tx, node).holds) ||
        (node.state === NodeState.ExternalRequested &&
          continuationHolds(tx, h.dependencies.bindings, node));
      assert.equal(claimable, expected, id);
    }
  });
});

test("reconcileMission deletes the job of a node that becomes terminal or retired in the write", (t) => {
  const h = routingHarness(t);
  const done = h.create(NodeState.Available);
  const gone = h.create(NodeState.Available);
  h.store.transaction((tx) => {
    const before = claimableMap(tx, h.missionId, h.dependencies.bindings);
    setNodeState(tx, done, NodeState.Completed);
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(NOW, gone);
    reconcileMission(
      tx,
      h.dependencies.workQueue,
      h.missionId,
      h.projectId,
      before,
      h.dependencies.bindings,
    );
  });
  assert.deepEqual(
    queueCalls(h),
    [done, gone].sort().map((id) => [QUEUE_DELETE, id]),
  );
});

test("reconcileMission makes no queue call for a node that stays terminal or retired", (t) => {
  const h = routingHarness(t);
  const { ids, retired } = randomGraph(h);
  h.store.transaction((tx) => {
    const before = claimableMap(tx, h.missionId, h.dependencies.bindings);
    const nodes = ids.map((id) => readNode(tx, id)!);
    const retiring = nodes.find(
      (node) => node.state === NodeState.Completed && !retired.has(node.id),
    );
    assert.ok(retiring, "A live Completed node exists.");
    for (const node of nodes) {
      if (node.state === NodeState.Completed)
        setNodeState(tx, node.id, NodeState.Discarded);
      if (node.state === NodeState.Discarded)
        setNodeState(tx, node.id, NodeState.Completed);
    }
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(NOW, retiring.id);
    reconcileMission(
      tx,
      h.dependencies.workQueue,
      h.missionId,
      h.projectId,
      before,
      h.dependencies.bindings,
    );
  });
  assert.deepEqual(queueCalls(h), []);
});

test("nodeClaimable answers the claimable map value of each node", (t) => {
  const h = routingHarness(t);
  const { ids, retired } = randomGraph(h);
  assert.ok(
    ids.some((id) => retired.has(id)),
    "The graph holds a retired node.",
  );
  h.store.transaction((tx) => {
    const map = claimableMap(tx, h.missionId, h.dependencies.bindings);
    for (const id of ids) {
      assert.equal(
        nodeClaimable(tx, readNode(tx, id)!, h.dependencies.bindings),
        map.get(id) ?? false,
        id,
      );
    }
  });
});
