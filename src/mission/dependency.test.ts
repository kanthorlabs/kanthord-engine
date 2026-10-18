import assert from "node:assert/strict";
import { test } from "node:test";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { hasDependencyCycle } from "./graph.ts";
import {
  dependencyReaches,
  insertDependency,
  insertMission,
  insertNode,
  readDependencies,
} from "./store.ts";
import { missionHarness } from "./test-support.ts";

const NOW = 100;
const NO_REACHING_PAIRS = 0;
const NODE_COUNT = 40;
const RETIRED_EVERY = 6;
const RETIRED_REMAINDER = 0;
const EDGE_ODDS = 0.08;
const GENERATOR_SEED = 20261019;

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

test("dependencyReaches answers the cycle check of the whole graph", (t) => {
  const h = missionHarness(t, testHumanIdentity("ulrich", "Ulrich", "token"));
  const missionId = h.store.transaction((tx) =>
    insertMission(tx, createIdentity("project"), NOW),
  );
  const random = seededGenerator(GENERATOR_SEED);
  const ids: string[] = [];
  for (let index = 0; index < NODE_COUNT; index++) {
    const id = createIdentity("node");
    ids.push(id);
    h.store.transaction((tx) =>
      insertNode(tx, {
        id,
        mission_id: missionId,
        filename: `${id}.md`,
        created_at: NOW,
      }),
    );
  }
  for (let high = 1; high < NODE_COUNT; high++) {
    for (let low = 0; low < high; low++) {
      if (random() >= EDGE_ODDS) continue;
      const dependent = itemAt(ids, high);
      const dependsOn = itemAt(ids, low);
      h.store.transaction((tx) =>
        insertDependency(tx, missionId, dependent, dependsOn),
      );
    }
  }
  ids.forEach((id, index) => {
    if (index % RETIRED_EVERY !== RETIRED_REMAINDER) return;
    h.store.transaction((tx) =>
      tx.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(NOW, id),
    );
  });
  let reaching = 0;
  h.store.transaction((tx) => {
    const edges = readDependencies(tx, missionId);
    for (const dependent of ids) {
      for (const dependsOn of ids) {
        const reaches = dependencyReaches(tx, missionId, dependsOn, dependent);
        assert.equal(
          reaches,
          hasDependencyCycle([...edges, { dependent, depends_on: dependsOn }]),
        );
        if (reaches && dependent !== dependsOn) reaching++;
      }
    }
  });
  assert.ok(
    reaching > NO_REACHING_PAIRS,
    "The graph holds a path of one edge or more.",
  );
});
