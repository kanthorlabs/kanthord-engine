import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BindingEntryState,
  type PoolEntry,
  type PoolInstance,
  PoolPlacement,
} from "./contract.ts";
import { FakePoolHost } from "./test-support.ts";
import { Pool, type PoolTarget } from "./pool.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "worker:kanthord:coder";
const OTHER_RESOURCE = "worker:kanthord:reviewer";
const FIRST_AGE = 1;
const SECOND_AGE = 2;
const THIRD_AGE = 3;
const TWO_STARTS = 2;
const ONE_START = 1;

const instance = (
  name: string,
  createdAt: number,
  placement: PoolPlacement = PoolPlacement.Server,
): PoolInstance => ({
  id: `worker_instance_${name}`,
  name,
  placement,
  created_at: createdAt,
});
const entry = (
  resource: string,
  owner: string,
  state: BindingEntryState = BindingEntryState.Serving,
): PoolEntry => ({
  project_id: PROJECT_ID,
  resource_identity: resource,
  client_id: `client_identity_${owner}_${resource}`,
  state,
});
const target = (
  value: PoolInstance,
  entries: PoolEntry[] = [],
): PoolTarget => ({ instance: value, entries });

function fixture() {
  const host = new FakePoolHost();
  const pool = new Pool(host);
  const run = (targets: PoolTarget[]) => pool.execute(pool.reconcile(targets));
  return { host, pool, run };
}

test("the plan starts every live server instance", () => {
  const f = fixture();
  const first = instance("coder-1", FIRST_AGE);
  const second = instance("coder-2", SECOND_AGE, PoolPlacement.Container);
  f.run([target(first), target(second)]);
  assert.deepEqual(
    f.host.started.map(({ instance: started }) => started.name),
    ["coder-1", "coder-2"],
  );
  f.run([target(first), target(second)]);
  assert.equal(f.host.started.length, TWO_STARTS);
  assert.deepEqual(f.host.updated, []);
});

test("an unlisted instance keeps running with no entry and an archived one stops", () => {
  const f = fixture();
  const idle = instance("idle-1", FIRST_AGE);
  const gone = instance("gone-1", SECOND_AGE);
  f.run([target(idle), target(gone)]);
  assert.deepEqual(f.host.started[0]!.entries, []);
  f.run([target(idle)]);
  assert.deepEqual(f.host.archived, [gone]);
  assert.deepEqual(f.host.updated, []);
  assert.deepEqual(
    f.pool.instances().map(({ name }) => name),
    ["idle-1"],
  );
});

test("the plan lists the entries of each listing binding and sends a change as an update", () => {
  const f = fixture();
  const first = instance("coder-1", FIRST_AGE);
  const both = [entry(RESOURCE, "a"), entry(OTHER_RESOURCE, "a")];
  f.run([target(first, [both[0]!])]);
  f.run([target(first, both)]);
  assert.deepEqual(f.host.started[0]!.entries, [both[0]]);
  assert.deepEqual(
    f.host.updated.map((item) => item.entries),
    [both],
  );
  assert.equal(f.host.started.length, ONE_START);
  f.run([target(first, both)]);
  assert.equal(f.host.updated.length, ONE_START);
});

test("a binding that dropped an instance with a live registration stays as a draining entry", () => {
  const f = fixture();
  const first = instance("coder-1", FIRST_AGE);
  const serving = entry(RESOURCE, "a");
  f.run([target(first, [serving])]);
  const draining = { ...serving, state: BindingEntryState.Draining };
  f.run([target(first, [draining])]);
  assert.deepEqual(
    f.host.updated.map((item) => item.entries),
    [[draining]],
  );
  f.run([target(first, [])]);
  assert.deepEqual(f.host.updated.at(-1)!.entries, []);
});

test("an instance that arrives after the start starts and the others keep running", () => {
  const f = fixture();
  const first = instance("coder-1", FIRST_AGE);
  f.run([target(first)]);
  f.run([target(first), target(instance("coder-2", THIRD_AGE))]);
  assert.deepEqual(
    f.host.started.map(({ instance: started }) => started.name),
    ["coder-1", "coder-2"],
  );
  assert.deepEqual(f.host.archived, []);
});

test("a restart goes to the host for the instance", () => {
  const f = fixture();
  const first = instance("coder-1", FIRST_AGE, PoolPlacement.Container);
  f.run([target(first)]);
  f.pool.restart(first);
  assert.deepEqual(f.host.restarted, [first]);
});
