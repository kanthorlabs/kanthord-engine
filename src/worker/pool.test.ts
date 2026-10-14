import assert from "node:assert/strict";
import { test } from "node:test";
import { POOL_SLOT_COUNT } from "./contract.ts";
import { FakePoolHost } from "./test-support.ts";
import { Pool, planPool, type PoolProbes, type PoolTarget } from "./pool.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OTHER_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const RESOURCE = "worker:kanthord:coder";
const GENERATION = 7;
const NEXT_GENERATION = 8;
const THREE_SLOTS = 3;
const TWO_SLOTS = 2;

const load = (slot: number, draining = false, busy = false) => ({
  slot,
  draining,
  busy,
});

test("a raise clears the drain flag of the lowest draining slots before it starts the lowest free numbers", () => {
  assert.deepEqual(planPool([load(0), load(1, true), load(3, true)], 3), {
    start: [],
    resume: [1, 3],
    drain: [],
  });
  assert.deepEqual(planPool([load(0), load(1, true)], 3), {
    start: [2],
    resume: [1],
    drain: [],
  });
  assert.deepEqual(planPool([], 2), { start: [0, 1], resume: [], drain: [] });
  assert.deepEqual(planPool([load(0), load(2)], 3), {
    start: [1],
    resume: [],
    drain: [],
  });
});

test("a lowered count drains idle slots first and busy slots next, highest slot number first in each group", () => {
  const slots = [
    load(0, false, true),
    load(1),
    load(2, false, true),
    load(3),
    load(4, true),
  ];
  assert.deepEqual(planPool(slots, 3).drain, [3]);
  assert.deepEqual(planPool(slots, 2).drain, [3, 1]);
  assert.deepEqual(planPool(slots, 1).drain, [3, 1, 2]);
  assert.deepEqual(planPool(slots, 0).drain, [3, 1, 2, 0]);
});

test("a count equal to the active slots plans nothing and a count above the slot space is refused", () => {
  assert.deepEqual(planPool([load(0), load(1)], 2), {
    start: [],
    resume: [],
    drain: [],
  });
  assert.throws(() => planPool([], POOL_SLOT_COUNT + 1));
});

const target = (
  count: number,
  generation = GENERATION,
  projectId = PROJECT_ID,
): PoolTarget => ({
  project_id: projectId,
  resource_identity: RESOURCE,
  generation,
  count,
});
const probes = (busy: string[] = [], live: string[] = []): PoolProbes => ({
  busy: (clientId) => busy.includes(clientId),
  live: (clientId) => live.includes(clientId),
});

function fixture() {
  const host = new FakePoolHost();
  const pool = new Pool(host);
  const slotId = (slot: number, generation = GENERATION) =>
    host.clientIdentity(PROJECT_ID, RESOURCE, generation, slot);
  const run = (
    scope: string | null,
    targets: PoolTarget[],
    options = probes(),
    restore = false,
  ) => pool.execute(pool.reconcile(scope, targets, options, restore));
  return { host, pool, slotId, run };
}

test("a reconciliation starts one slot for each unit of the count and records them as pool slots", () => {
  const f = fixture();
  f.run(null, [target(THREE_SLOTS)]);
  assert.deepEqual(
    f.host.started.map(({ slot, draining }) => [slot, draining]),
    [
      [0, false],
      [1, false],
      [2, false],
    ],
  );
  assert.ok(f.pool.isSlot(PROJECT_ID, RESOURCE, f.slotId(1)));
  assert.ok(!f.pool.isSlot(OTHER_PROJECT_ID, RESOURCE, f.slotId(1)));
  assert.ok(!f.pool.isSlot(PROJECT_ID, RESOURCE, "client_identity_other"));
  f.run(null, [target(THREE_SLOTS)]);
  assert.equal(f.host.started.length, THREE_SLOTS);
});

test("a lowered count drains the excess slots and keeps them as pool slots that drain until the host ends them", () => {
  const f = fixture();
  f.run(null, [target(THREE_SLOTS)]);
  f.run(null, [target(1)], probes([f.slotId(2)]));
  assert.deepEqual(
    f.host.drained.map(({ slot }) => slot),
    [1, 0],
  );
  assert.ok(f.pool.draining(f.slotId(1)));
  assert.ok(f.pool.draining(f.slotId(0)));
  assert.ok(!f.pool.draining(f.slotId(2)));
  assert.ok(f.pool.isSlot(PROJECT_ID, RESOURCE, f.slotId(0)));
  f.host.end(f.slotId(1));
  assert.ok(!f.pool.isSlot(PROJECT_ID, RESOURCE, f.slotId(1)));
});

test("a raise during a drain starts the draining slot again instead of a new slot", () => {
  const f = fixture();
  f.run(null, [target(2)]);
  f.run(null, [target(1)]);
  f.run(null, [target(2)]);
  assert.ok(!f.pool.draining(f.slotId(1)));
  const last = f.host.started.at(-1)!;
  assert.deepEqual([last.slot, last.draining], [1, false]);
  assert.equal(f.host.started.length, THREE_SLOTS);
});

test("a removed binding takes the target 0 and drains every slot", () => {
  const f = fixture();
  f.run(null, [target(2)]);
  f.run(PROJECT_ID, []);
  assert.deepEqual(
    f.host.drained.map(({ slot }) => slot),
    [1, 0],
  );
});

test("a reconciliation of one project leaves the slots of another project alone", () => {
  const f = fixture();
  f.run(null, [target(2), target(2, GENERATION, OTHER_PROJECT_ID)]);
  f.host.drained.length = 0;
  f.run(PROJECT_ID, [target(2)]);
  assert.deepEqual(f.host.drained, []);
});

test("a binding that a project adds again gets slots of a new generation", () => {
  const f = fixture();
  f.run(null, [target(1)]);
  f.run(PROJECT_ID, [target(1, NEXT_GENERATION)]);
  assert.deepEqual(
    f.host.started.map(({ generation, slot }) => [generation, slot]),
    [
      [GENERATION, 0],
      [NEXT_GENERATION, 0],
    ],
  );
  assert.deepEqual(
    f.host.drained.map(({ generation }) => generation),
    [GENERATION],
  );
});

test("a restore starts a slot above the target with a live registration in drain mode after the target slots", () => {
  const f = fixture();
  f.run(
    null,
    [target(2)],
    probes([], [f.slotId(0), f.slotId(3), f.slotId(5)]),
    true,
  );
  assert.deepEqual(
    f.host.started.map(({ slot, draining }) => [slot, draining]),
    [
      [0, false],
      [1, false],
      [3, true],
      [5, true],
    ],
  );
  assert.ok(f.pool.draining(f.slotId(3)));
});

test("an unstarted slot that the host ends leaves the pool state", () => {
  const f = fixture();
  f.run(null, [target(1)]);
  f.host.end(f.slotId(0));
  f.run(null, [target(1)]);
  assert.equal(f.host.started.length, TWO_SLOTS);
});
