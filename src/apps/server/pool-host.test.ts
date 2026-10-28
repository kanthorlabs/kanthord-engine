import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Writable } from "node:stream";
import { MessagePort } from "node:worker_threads";
import type { Logger } from "pino";
import { deriveClientSecret } from "../../gateway/auth/jwt.ts";
import type { createInvocation } from "../../gateway/index.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  BindingEntryState,
  PlacementIssue,
  type PlacementStatus,
  type PoolEntry,
  type PoolInstance,
  PoolPlacement,
} from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import type {
  SlotDriver,
  SlotEntry,
  SlotExit,
  SlotInstance,
  SlotLaunch,
} from "./slot-driver.ts";
import {
  POOL_BACKOFF_INITIAL_MS,
  POOL_BACKOFF_MAX_MS,
  POOL_STOP_DEADLINE_MS,
  WorkerPool,
} from "./worker-pool.ts";

const AUTH_VERSION = 1;
const KEY_BYTES = 32;
const PROJECT = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "worker:kanthord:general";
const OTHER_RESOURCE = "worker:kanthord:reviewer";
const SLOT_ROOT_MODE = 0o700;
const MODE_MASK = 0o777;
const FAILURE_CODE = 1;
const CLEAN_CODE = 0;
const FIRST_LAUNCH = 1;
const RELAUNCH = 2;
const CONTAINER_IMAGE = "kanthord:test";
const SECOND_RELAUNCH = 3;
const THIRD_RELAUNCH = 4;
const NO_TERMINATE = 0;
const NO_LAUNCH = 0;
const ONE_TERMINATE = 1;
const TWO_ENTRIES = 2;
const LIMIT = 2;
const MIDDLE_NAME = "coder-2";
const LAUNCH_FAILURE = "launch refused";
const LIMIT_MESSAGE = "worker.pool.instance_limit";
const FAILED_MESSAGE = "worker.pool.instance_failed";
const CLEANUP_MESSAGE = "worker.pool.cleanup_failed";
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
const LAUNCH_KEYS = ["entries", "environment", "instance", "output", "root"];

class FakeInstance implements SlotInstance {
  readonly controls: string[] = [];
  readonly lists: Array<readonly SlotEntry[]> = [];
  terminated = 0;
  readonly exited: Promise<SlotExit>;
  private readonly settle: (exit: SlotExit) => void;

  constructor() {
    const exit = Promise.withResolvers<SlotExit>();
    this.exited = exit.promise;
    this.settle = exit.resolve;
  }

  control(kind: string): void {
    this.controls.push(kind);
  }

  bindings(entries: readonly SlotEntry[]): void {
    this.lists.push(entries);
  }

  terminate(): void {
    this.terminated++;
  }

  end(code: number, error: Error | null = null): void {
    this.settle({ code, error });
  }
}

class FakeDriver implements SlotDriver {
  readonly placement: PoolPlacement;
  readonly launches: SlotLaunch[] = [];
  prepares = 0;
  readonly volumeRemovals: string[] = [];
  readonly volumeSweeps: Array<ReadonlySet<string>> = [];
  volumeError: Error | null = null;
  readonly instances: FakeInstance[] = [];
  launchError: Error | null = null;

  constructor(placement: PoolPlacement = PoolPlacement.Server) {
    this.placement = placement;
  }

  check(): Promise<PlacementStatus> {
    if (this.unavailable) return Promise.resolve(this.unavailable);
    return Promise.resolve({
      placement: this.placement,
      available: true,
      reason: null,
      detail: null,
      container_runtime: null,
    });
  }

  prepare(): Promise<void> {
    this.prepares++;
    if (this.prepareError) return Promise.reject(this.prepareError);
    return Promise.resolve();
  }

  prepareError: Error | null = null;

  removeVolume(instanceName: string): Promise<void> {
    this.volumeRemovals.push(instanceName);
    return this.volumeError
      ? Promise.reject(this.volumeError)
      : Promise.resolve();
  }

  sweepVolumes(live: ReadonlySet<string>): Promise<void> {
    this.volumeSweeps.push(live);
    return this.volumeError
      ? Promise.reject(this.volumeError)
      : Promise.resolve();
  }

  unavailable: PlacementStatus | null = null;
  readonly images = new Map<string, string>();

  imageOf(instanceName: string): string | null {
    return this.images.get(instanceName) ?? null;
  }

  launch(launch: SlotLaunch): SlotInstance {
    this.launches.push(launch);
    if (this.launchError) throw this.launchError;
    const instance = new FakeInstance();
    this.instances.push(instance);
    return instance;
  }
}

interface LogRecord {
  fields: Record<string, unknown>;
  message: string;
}

function fixture(t: TestContext, options: { instanceLimit?: number } = {}) {
  const driver = new FakeDriver();
  const containerDriver = new FakeDriver(PoolPlacement.Container);
  const records: LogRecord[] = [];
  const record = (fields: Record<string, unknown>, message: string) =>
    records.push({ fields, message });
  const logger = { warn: record, error: record } as unknown as Logger;
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const stateDirectory = temporary(t);
  const pool = new WorkerPool({
    drivers: new Map([
      [driver.placement, driver],
      [containerDriver.placement, containerDriver],
    ]),
    invocation: {} as ReturnType<typeof createInvocation>,
    masterKey,
    authVersion: AUTH_VERSION,
    instanceLimit: options.instanceLimit ?? Number.MAX_SAFE_INTEGER,
    stateDirectory,
    logger,
  });
  t.after(() => {
    for (const launch of [...driver.launches, ...containerDriver.launches])
      for (const entry of launch.entries) entry.channel?.close();
    for (const instance of [...driver.instances, ...containerDriver.instances])
      for (const list of instance.lists)
        for (const entry of list) entry.channel?.close();
  });
  let age = 0;
  const instanceOf = (
    name: string,
    placement: PoolPlacement = PoolPlacement.Server,
  ): PoolInstance => ({
    id: `worker_instance_${name}`,
    name,
    placement,
    created_at: ++age,
  });
  const entryOf = (
    owner: string,
    resourceIdentity = RESOURCE,
    state: BindingEntryState = BindingEntryState.Serving,
  ): PoolEntry => ({
    project_id: PROJECT,
    resource_identity: resourceIdentity,
    client_id: `client_identity_${owner}_${resourceIdentity}`,
    state,
  });
  return {
    driver,
    containerDriver,
    records,
    pool,
    instanceOf,
    entryOf,
    masterKey,
    stateDirectory,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function crash(instance: FakeInstance): Promise<void> {
  instance.end(FAILURE_CODE);
  await flush();
}

test("the pool host prepares each driver once and a failed prepare raises no unhandled rejection", async (t) => {
  const f = fixture(t);
  f.containerDriver.prepareError = new Error("runtime refused");
  f.pool.prepare();
  await flush();
  assert.equal(f.driver.prepares, FIRST_LAUNCH);
  assert.equal(f.containerDriver.prepares, FIRST_LAUNCH);
  assert.equal(f.driver.launches.length, NO_LAUNCH);
  assert.deepEqual(f.records, []);
});

test("the pool host starts an instance through the driver with exactly the documented launch keys", (t) => {
  const f = fixture(t);
  const instance = f.instanceOf("coder-1");
  const entry = f.entryOf("a");
  f.pool.start(instance, [entry]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  const launch = f.driver.launches[0]!;
  assert.deepEqual(Object.keys(launch).sort(), LAUNCH_KEYS);
  assert.equal(launch.instance, instance);
  assert.equal(launch.entries.length, FIRST_LAUNCH);
  assert.equal(launch.entries[0]!.client_id, entry.client_id);
  assert.equal(launch.entries[0]!.state, BindingEntryState.Serving);
  assert.equal(
    launch.entries[0]!.client_secret,
    deriveClientSecret(f.masterKey, AUTH_VERSION, entry.client_id),
  );
  assert.ok(launch.entries[0]!.channel instanceof MessagePort);
  assert.equal(launch.root, join(f.stateDirectory, "workers", "coder-1"));
  assert.equal(statSync(launch.root).mode & MODE_MASK, SLOT_ROOT_MODE);
  assert.ok(launch.output instanceof Writable);
  assert.ok(!JSON.stringify(Object.keys(launch)).includes("master_key"));
  assert.ok(!Object.values(launch).includes(f.masterKey));
});

test("the pool host starts an instance that no binding lists with an empty entry list", (t) => {
  const f = fixture(t);
  f.pool.start(f.instanceOf("idle-1"), []);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  assert.deepEqual(f.driver.launches[0]!.entries, []);
});

test("the pool host launches each instance through the driver of its placement", (t) => {
  const f = fixture(t);
  const server = f.instanceOf("coder-1");
  const container = f.instanceOf("coder-2", PoolPlacement.Container);
  f.pool.start(server, []);
  f.pool.start(container, []);
  assert.deepEqual(
    f.driver.launches.map(({ instance }) => instance),
    [server],
  );
  assert.deepEqual(
    f.containerDriver.launches.map(({ instance }) => instance),
    [container],
  );
});

test("the limit 2 with three live instances starts the two oldest and the end of one starts the pending one", async (t) => {
  const f = fixture(t, { instanceLimit: LIMIT });
  const oldest = f.instanceOf("coder-1");
  const second = f.instanceOf("coder-2");
  const newest = f.instanceOf("coder-3");
  f.pool.start(oldest, []);
  f.pool.start(second, []);
  f.pool.start(newest, []);
  assert.deepEqual(
    f.driver.launches.map(({ instance }) => instance.name),
    ["coder-1", "coder-2"],
  );
  assert.deepEqual(
    f.records.map((entry) => [entry.message, entry.fields.instance]),
    [[LIMIT_MESSAGE, "coder-3"]],
  );
  const archived = f.pool.archive(oldest);
  f.driver.instances[0]!.end(CLEAN_CODE);
  await archived;
  assert.deepEqual(
    f.driver.launches.map(({ instance }) => instance.name),
    ["coder-1", "coder-2", "coder-3"],
  );
});

test("the oldest pending instance starts first", async (t) => {
  const f = fixture(t, { instanceLimit: 1 });
  const running = f.instanceOf("coder-1");
  const middle = f.instanceOf("coder-2");
  const youngest = f.instanceOf("coder-3");
  f.pool.start(running, []);
  f.pool.start(youngest, []);
  f.pool.start(middle, []);
  const archived = f.pool.archive(running);
  f.driver.instances[0]!.end(CLEAN_CODE);
  await archived;
  assert.equal(f.driver.launches.at(-1)!.instance.name, MIDDLE_NAME);
});

test("a binding write sends the new entry list to the running instance and starts no instance", (t) => {
  const f = fixture(t);
  const instance = f.instanceOf("coder-1");
  const first = f.entryOf("a");
  f.pool.start(instance, [first]);
  const second = f.entryOf("a", OTHER_RESOURCE);
  f.pool.update(instance, [first, second]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  const [list] = f.driver.instances[0]!.lists;
  assert.deepEqual(
    list!.map(({ client_id }) => client_id),
    [first.client_id, second.client_id],
  );
  assert.equal(list![0]!.channel, null);
  assert.ok(list![1]!.channel instanceof MessagePort);
  f.pool.update(instance, [{ ...first, state: BindingEntryState.Draining }]);
  const draining = f.driver.instances[0]!.lists[1]!;
  assert.deepEqual(
    draining.map(({ state, channel }) => [state, channel]),
    [[BindingEntryState.Draining, null]],
  );
});

test("a draining entry that holds no port gets no new port", (t) => {
  const f = fixture(t);
  const instance = f.instanceOf("coder-1");
  f.pool.start(instance, []);
  f.pool.update(instance, [
    f.entryOf("a", RESOURCE, BindingEntryState.Draining),
  ]);
  assert.equal(f.driver.instances[0]!.lists[0]![0]!.channel, null);
});

test("an archive stops the instance through stop, terminates it after 5 s and removes the slot root and the volume", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  const instance = f.instanceOf("coder-1");
  f.pool.start(instance, [f.entryOf("a")]);
  const root = join(f.stateDirectory, "workers", "coder-1");
  assert.equal(existsSync(root), true);
  const running = f.driver.instances[0]!;
  const archived = f.pool.archive(instance);
  assert.deepEqual(running.controls, [SlotControl.Stop]);
  t.mock.timers.tick(POOL_STOP_DEADLINE_MS - 1);
  assert.equal(running.terminated, NO_TERMINATE);
  t.mock.timers.tick(1);
  assert.equal(running.terminated, ONE_TERMINATE);
  running.end(FAILURE_CODE);
  await archived;
  assert.equal(existsSync(root), false);
  assert.deepEqual(f.driver.volumeRemovals, ["coder-1"]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
});

test("an archive removes the root and the volume of the driver of the placement", async (t) => {
  const f = fixture(t);
  const container = f.instanceOf("boxed-1", PoolPlacement.Container);
  f.pool.start(container, []);
  const archived = f.pool.archive(container);
  f.containerDriver.instances[0]!.end(CLEAN_CODE);
  await archived;
  assert.deepEqual(f.containerDriver.volumeRemovals, ["boxed-1"]);
  assert.deepEqual(f.driver.volumeRemovals, []);
});

test("an archive of a pending instance removes its slot root and starts none", async (t) => {
  const f = fixture(t, { instanceLimit: 1 });
  f.pool.start(f.instanceOf("coder-1"), []);
  const pending = f.instanceOf("coder-2");
  const root = plantRoot(f.stateDirectory, "coder-2");
  f.pool.start(pending, []);
  await f.pool.archive(pending);
  assert.equal(existsSync(root), false);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
});

test("an exit with no stop restarts the instance with the backoff, under the same client identities", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  const entries = [f.entryOf("a"), f.entryOf("a", OTHER_RESOURCE)];
  f.pool.start(f.instanceOf("coder-1"), entries);
  assert.equal(BACKOFF_STEPS[0], POOL_BACKOFF_INITIAL_MS);
  assert.equal(BACKOFF_STEPS.at(-1), POOL_BACKOFF_MAX_MS);
  for (const [index, delay] of BACKOFF_STEPS.entries()) {
    await crash(f.driver.instances[index]!);
    t.mock.timers.tick(delay - 1);
    assert.equal(f.driver.launches.length, index + 1);
    t.mock.timers.tick(1);
    assert.equal(f.driver.launches.length, index + 2);
  }
  for (const launch of f.driver.launches) {
    assert.deepEqual(
      launch.entries.map(({ client_id }) => client_id),
      entries.map(({ client_id }) => client_id),
    );
    assert.equal(launch.entries.length, TWO_ENTRIES);
  }
  const failures = f.records.filter(
    (entry) => entry.message === FAILED_MESSAGE,
  );
  assert.equal(failures.length, BACKOFF_STEPS.length);
  assert.equal(failures[0]!.fields.exit_code, FAILURE_CODE);
});

test("the log records name the instance and no binding or slot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t, { instanceLimit: 1 });
  f.pool.start(f.instanceOf("coder-1"), []);
  f.pool.start(f.instanceOf("coder-2"), []);
  await crash(f.driver.instances[0]!);
  assert.deepEqual(
    f.records.map((entry) => [entry.message, entry.fields.instance]),
    [
      [LIMIT_MESSAGE, "coder-2"],
      [FAILED_MESSAGE, "coder-1"],
    ],
  );
  for (const entry of f.records) {
    assert.equal("binding" in entry.fields, false);
    assert.equal("slot" in entry.fields, false);
  }
});

test("the backoff resets after an instance that stayed alive for 30 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  f.pool.start(f.instanceOf("coder-1"), []);
  await crash(f.driver.instances[0]!);
  t.mock.timers.tick(POOL_BACKOFF_INITIAL_MS);
  await crash(f.driver.instances[1]!);
  t.mock.timers.tick(BACKOFF_STEPS[1]!);
  assert.equal(f.driver.launches.length, SECOND_RELAUNCH);
  t.mock.timers.tick(POOL_BACKOFF_MAX_MS);
  await crash(f.driver.instances[2]!);
  t.mock.timers.tick(POOL_BACKOFF_INITIAL_MS - 1);
  assert.equal(f.driver.launches.length, SECOND_RELAUNCH);
  t.mock.timers.tick(1);
  assert.equal(f.driver.launches.length, THIRD_RELAUNCH);
});

test("a restart sends the drain control and starts the instance again after the exit with the same client identities", async (t) => {
  const f = fixture(t);
  const instance = f.instanceOf("coder-1");
  const entry = f.entryOf("a");
  f.pool.start(instance, [entry]);
  f.pool.restart(instance);
  f.pool.restart(instance);
  assert.deepEqual(f.driver.instances[0]!.controls, [SlotControl.Drain]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  f.driver.instances[0]!.end(CLEAN_CODE);
  await flush();
  assert.equal(f.driver.launches.length, RELAUNCH);
  assert.equal(f.driver.launches[1]!.entries[0]!.client_id, entry.client_id);
  assert.deepEqual(f.driver.instances[1]!.controls, []);
});

test("a restart of an unknown instance changes nothing", (t) => {
  const f = fixture(t);
  f.pool.restart(f.instanceOf("coder-1"));
  assert.equal(f.driver.launches.length, NO_LAUNCH);
});

test("imageOf asks the driver of the instance and answers null for a driver with no image", (t) => {
  const f = fixture(t);
  const container = f.instanceOf("boxed-1", PoolPlacement.Container);
  const server = f.instanceOf("coder-1");
  f.containerDriver.images.set("boxed-1", CONTAINER_IMAGE);
  assert.equal(f.pool.imageOf(container), CONTAINER_IMAGE);
  assert.equal(f.pool.imageOf(server), null);
});

test("stop sends the stop control and calls terminate after the stop deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.pool.start(f.instanceOf("coder-1"), []);
  const instance = f.driver.instances[0]!;
  const stopped = f.pool.stop();
  assert.deepEqual(instance.controls, [SlotControl.Stop]);
  t.mock.timers.tick(POOL_STOP_DEADLINE_MS - 1);
  assert.equal(instance.terminated, NO_TERMINATE);
  t.mock.timers.tick(1);
  assert.equal(instance.terminated, ONE_TERMINATE);
  instance.end(FAILURE_CODE);
  await stopped;
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
});

test("a throw of the driver launch counts as exit 1 and follows the backoff path", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  f.driver.launchError = new Error(LAUNCH_FAILURE);
  f.pool.start(f.instanceOf("coder-1"), []);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  const failure = f.records.find((entry) => entry.message === FAILED_MESSAGE);
  assert.equal(failure?.fields.exit_code, FAILURE_CODE);
  assert.equal((failure?.fields.err as Error).message, LAUNCH_FAILURE);
  t.mock.timers.tick(POOL_BACKOFF_INITIAL_MS - 1);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  t.mock.timers.tick(1);
  assert.equal(f.driver.launches.length, RELAUNCH);
  f.driver.launchError = null;
  t.mock.timers.tick(BACKOFF_STEPS[1]!);
  assert.equal(f.driver.launches.length, SECOND_RELAUNCH);
  assert.equal(f.driver.instances.length, FIRST_LAUNCH);
});

test("an exit that carries an error writes the error to the failure record", async (t) => {
  const f = fixture(t);
  f.pool.start(f.instanceOf("coder-1"), []);
  const error = new Error("thread crashed");
  f.driver.instances[0]!.end(FAILURE_CODE, error);
  await flush();
  const failure = f.records.find((entry) => entry.message === FAILED_MESSAGE);
  assert.equal(failure?.fields.err, error);
});

test("the pool host answers the placement status from the check of the driver of that placement", async (t) => {
  const f = fixture(t);
  const unavailable: PlacementStatus = {
    placement: PoolPlacement.Container,
    available: false,
    reason: PlacementIssue.RuntimeAbsent,
    detail: null,
    container_runtime: null,
  };
  f.containerDriver.unavailable = unavailable;
  assert.deepEqual(
    await f.pool.placementStatus(PoolPlacement.Container),
    unavailable,
  );
  assert.equal(
    (await f.pool.placementStatus(PoolPlacement.Server)).available,
    true,
  );
});

function plantRoot(stateDirectory: string, name: string): string {
  const root = join(stateDirectory, "workers", name);
  mkdirSync(join(root, "state"), { recursive: true });
  writeFileSync(join(root, "stderr.log"), "log");
  return root;
}

test("a failed volume removal is logged and does not throw", async (t) => {
  const f = fixture(t);
  f.containerDriver.volumeError = new Error("volume busy");
  const container = f.instanceOf("boxed-1", PoolPlacement.Container);
  const root = plantRoot(f.stateDirectory, "boxed-1");
  await f.pool.archive(container);
  assert.equal(existsSync(root), false);
  assert.deepEqual(
    f.records.map((entry) => [entry.message, entry.fields.instance]),
    [[CLEANUP_MESSAGE, "boxed-1"]],
  );
});

test("the sweep removes each slot root of no live instance and keeps the live roots", async (t) => {
  const f = fixture(t);
  const live = plantRoot(f.stateDirectory, "coder-1");
  const orphan = plantRoot(f.stateDirectory, "gone-1");
  await f.pool.sweep(new Set(["coder-1"]));
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(f.driver.volumeSweeps, [new Set(["coder-1"])]);
  assert.deepEqual(f.containerDriver.volumeSweeps, [new Set(["coder-1"])]);
  assert.deepEqual(f.records, []);
});

test("the sweep of a state directory with no workers directory does nothing and a failed volume sweep is logged", async (t) => {
  const f = fixture(t);
  f.containerDriver.volumeError = new Error("volume ls failed");
  await f.pool.sweep(new Set());
  assert.deepEqual(
    f.records.map((entry) => entry.message),
    [CLEANUP_MESSAGE],
  );
});
