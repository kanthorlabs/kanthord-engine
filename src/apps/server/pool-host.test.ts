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
  PlacementIssue,
  PoolPlacement,
  type PlacementStatus,
  type PoolSlot,
} from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import type {
  SlotDriver,
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
const GENERATION = 3;
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
const LAUNCH_FAILURE = "launch refused";
const LIMIT_MESSAGE = "worker.pool.slot_limit";
const FAILED_MESSAGE = "worker.pool.instance_failed";
const CLEANUP_MESSAGE = "worker.pool.cleanup_failed";
const RUNTIME_IDENTITY = "runtime_identity";
const LOWEST_SLOT = 0;
const MIDDLE_SLOT = 1;
const HIGHEST_SLOT = 2;
const BACKOFF_STEPS = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
const LAUNCH_KEYS = [
  "channel",
  "client_secret",
  "environment",
  "output",
  "root",
  "slot",
];

class FakeInstance implements SlotInstance {
  readonly controls: string[] = [];
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

  removeVolume(clientId: string): Promise<void> {
    this.volumeRemovals.push(clientId);
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

  imageOf(clientId: string): string | null {
    return this.images.get(clientId) ?? null;
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

function fixture(
  t: TestContext,
  options: { slotLimit?: number; registered?: boolean } = {},
) {
  const driver = new FakeDriver();
  const containerDriver = new FakeDriver(PoolPlacement.Container);
  const records: LogRecord[] = [];
  const record = (fields: Record<string, unknown>, message: string) =>
    records.push({ fields, message });
  const logger = { warn: record, error: record } as unknown as Logger;
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const stateDirectory = temporary(t);
  const registered = options.registered ?? true;
  const pool = new WorkerPool({
    drivers: new Map([
      [driver.placement, driver],
      [containerDriver.placement, containerDriver],
    ]),
    invocation: {} as ReturnType<typeof createInvocation>,
    masterKey,
    authVersion: AUTH_VERSION,
    slotLimit: options.slotLimit ?? Number.MAX_SAFE_INTEGER,
    stateDirectory,
    logger,
    runtimeIdentity: () => (registered ? RUNTIME_IDENTITY : undefined),
  });
  const ended: string[] = [];
  pool.onEnded((clientId) => ended.push(clientId));
  t.after(() => {
    for (const launch of [...driver.launches, ...containerDriver.launches])
      launch.channel.close();
  });
  const slotOf = (
    slot: number,
    draining = false,
    placement: PoolPlacement = PoolPlacement.Server,
  ): PoolSlot => ({
    project_id: PROJECT,
    resource_identity: RESOURCE,
    generation: GENERATION,
    placement,
    slot,
    client_id: pool.clientIdentity(PROJECT, RESOURCE, GENERATION, slot),
    draining,
  });
  return {
    driver,
    containerDriver,
    records,
    pool,
    ended,
    slotOf,
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

test("the pool host starts a slot through the driver with exactly the documented launch keys", (t) => {
  const f = fixture(t);
  const slot = f.slotOf(LOWEST_SLOT);
  f.pool.start(slot);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  const launch = f.driver.launches[0]!;
  assert.deepEqual(Object.keys(launch).sort(), LAUNCH_KEYS);
  assert.equal(launch.slot, slot);
  assert.equal(
    launch.client_secret,
    deriveClientSecret(f.masterKey, AUTH_VERSION, slot.client_id),
  );
  assert.equal(launch.root, join(f.stateDirectory, "workers", slot.client_id));
  assert.equal(statSync(launch.root).mode & MODE_MASK, SLOT_ROOT_MODE);
  assert.ok(launch.output instanceof Writable);
  assert.ok(launch.channel instanceof MessagePort);
  assert.ok(!JSON.stringify(Object.keys(launch)).includes("master_key"));
  assert.ok(!Object.values(launch).includes(f.masterKey));
});

test("the pool host launches each slot through the driver of its placement", (t) => {
  const f = fixture(t);
  const server = f.slotOf(LOWEST_SLOT);
  const container = f.slotOf(MIDDLE_SLOT, false, PoolPlacement.Container);
  f.pool.start(server);
  f.pool.start(container);
  assert.deepEqual(
    f.driver.launches.map(({ slot }) => slot),
    [server],
  );
  assert.deepEqual(
    f.containerDriver.launches.map(({ slot }) => slot),
    [container],
  );
});

test("a slot above the limit stays pending and the lowest pending slot starts when a started slot ends", async (t) => {
  const f = fixture(t, { slotLimit: 1 });
  const first = f.slotOf(HIGHEST_SLOT);
  f.pool.start(first);
  f.pool.start(f.slotOf(MIDDLE_SLOT));
  f.pool.start(f.slotOf(LOWEST_SLOT));
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  assert.deepEqual(
    f.records.map((entry) => [entry.message, entry.fields.slot]),
    [
      [LIMIT_MESSAGE, MIDDLE_SLOT],
      [LIMIT_MESSAGE, LOWEST_SLOT],
    ],
  );
  f.pool.drain({ ...first, draining: true });
  assert.deepEqual(f.driver.instances[0]!.controls, [SlotControl.Drain]);
  f.driver.instances[0]!.end(CLEAN_CODE);
  await flush();
  assert.deepEqual(f.ended, [first.client_id]);
  assert.equal(f.driver.launches.length, RELAUNCH);
  assert.equal(f.driver.launches[1]!.slot.slot, LOWEST_SLOT);
});

test("a failed instance restarts after a backoff that doubles from 1 s to 30 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  f.pool.start(f.slotOf(LOWEST_SLOT));
  assert.equal(BACKOFF_STEPS[0], POOL_BACKOFF_INITIAL_MS);
  assert.equal(BACKOFF_STEPS.at(-1), POOL_BACKOFF_MAX_MS);
  for (const [index, delay] of BACKOFF_STEPS.entries()) {
    await crash(f.driver.instances[index]!);
    t.mock.timers.tick(delay - 1);
    assert.equal(f.driver.launches.length, index + 1);
    t.mock.timers.tick(1);
    assert.equal(f.driver.launches.length, index + 2);
  }
  const failures = f.records.filter(
    (entry) => entry.message === FAILED_MESSAGE,
  );
  assert.equal(failures.length, BACKOFF_STEPS.length);
  assert.equal(failures[0]!.fields.exit_code, FAILURE_CODE);
});

test("the backoff resets after an instance that stayed alive for 30 s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  f.pool.start(f.slotOf(LOWEST_SLOT));
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

test("a drain request reaches the driver once and a raise of the slot resumes it after the drain ends", async (t) => {
  const f = fixture(t);
  const slot = f.slotOf(LOWEST_SLOT);
  f.pool.start(slot);
  f.pool.drain({ ...slot, draining: true });
  f.pool.drain({ ...slot, draining: true });
  assert.deepEqual(f.driver.instances[0]!.controls, [SlotControl.Drain]);
  f.pool.start({ ...slot, draining: false });
  f.driver.instances[0]!.end(CLEAN_CODE);
  await flush();
  assert.equal(f.driver.launches.length, RELAUNCH);
  assert.equal(f.driver.launches[1]!.slot.draining, false);
  assert.deepEqual(f.ended, []);
  assert.deepEqual(f.driver.instances[1]!.controls, []);
});

test("a restart marks the slot as draining at once and starts it again after the exit with the same client identity", async (t) => {
  const f = fixture(t);
  const slot = f.slotOf(LOWEST_SLOT);
  f.pool.start(slot);
  f.pool.restart(slot);
  assert.equal(slot.draining, true);
  assert.deepEqual(f.driver.instances[0]!.controls, [SlotControl.Drain]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
  f.driver.instances[0]!.end(CLEAN_CODE);
  await flush();
  assert.equal(f.driver.launches.length, RELAUNCH);
  assert.equal(f.driver.launches[1]!.slot.client_id, slot.client_id);
  assert.equal(slot.draining, false);
  assert.deepEqual(f.ended, []);
  assert.deepEqual(f.driver.instances[1]!.controls, []);
});

test("a restart of an unknown slot changes nothing", (t) => {
  const f = fixture(t);
  const slot = f.slotOf(LOWEST_SLOT);
  f.pool.restart(slot);
  assert.equal(slot.draining, false);
  assert.deepEqual(f.ended, []);
  assert.equal(f.driver.launches.length, NO_LAUNCH);
});

test("imageOf asks the driver of the slot and answers null for a driver with no image", (t) => {
  const f = fixture(t);
  const container = f.slotOf(MIDDLE_SLOT, false, PoolPlacement.Container);
  const server = f.slotOf(LOWEST_SLOT);
  f.containerDriver.images.set(container.client_id, CONTAINER_IMAGE);
  assert.equal(f.pool.imageOf(container), CONTAINER_IMAGE);
  assert.equal(f.pool.imageOf(server), null);
});

test("a slot that starts in drain mode receives the drain control at once", (t) => {
  const f = fixture(t);
  f.pool.start(f.slotOf(LOWEST_SLOT, true));
  assert.deepEqual(f.driver.instances[0]!.controls, [SlotControl.Drain]);
});

test("a slot that drains with no registration ends when its instance fails", async (t) => {
  const f = fixture(t, { registered: false });
  const slot = f.slotOf(LOWEST_SLOT);
  f.pool.start(slot);
  f.pool.drain({ ...slot, draining: true });
  await crash(f.driver.instances[0]!);
  assert.deepEqual(f.ended, [slot.client_id]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
});

test("a pending slot that drains with no registration ends without a start", (t) => {
  const f = fixture(t, { slotLimit: 1, registered: false });
  f.pool.start(f.slotOf(LOWEST_SLOT));
  const pending = f.slotOf(MIDDLE_SLOT);
  f.pool.start(pending);
  f.pool.drain({ ...pending, draining: true });
  assert.deepEqual(f.ended, [pending.client_id]);
  assert.equal(f.driver.launches.length, FIRST_LAUNCH);
});

test("a drain of an unknown slot ends it at once", (t) => {
  const f = fixture(t);
  const slot = f.slotOf(LOWEST_SLOT, true);
  f.pool.drain(slot);
  assert.deepEqual(f.ended, [slot.client_id]);
});

test("stop sends the stop control and calls terminate after the stop deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.pool.start(f.slotOf(LOWEST_SLOT));
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
  assert.deepEqual(f.ended, []);
});

test("a throw of the driver launch counts as exit 1 and follows the backoff path", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture(t);
  f.driver.launchError = new Error(LAUNCH_FAILURE);
  f.pool.start(f.slotOf(LOWEST_SLOT));
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
  f.pool.start(f.slotOf(LOWEST_SLOT));
  const error = new Error("thread crashed");
  f.driver.instances[0]!.end(FAILURE_CODE, error);
  await flush();
  const failure = f.records.find((entry) => entry.message === FAILED_MESSAGE);
  assert.equal(failure?.fields.err, error);
  assert.equal(failure?.fields.runtime_identity, RUNTIME_IDENTITY);
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

test("remove deletes the slot root and asks the driver of the placement to remove the volume", async (t) => {
  const f = fixture(t);
  const thread = f.slotOf(LOWEST_SLOT);
  const container = f.slotOf(MIDDLE_SLOT, false, PoolPlacement.Container);
  const threadRoot = plantRoot(f.stateDirectory, thread.client_id);
  const containerRoot = plantRoot(f.stateDirectory, container.client_id);
  await Promise.all([f.pool.remove(thread), f.pool.remove(container)]);
  assert.equal(existsSync(threadRoot), false);
  assert.equal(existsSync(containerRoot), false);
  assert.deepEqual(f.driver.volumeRemovals, [thread.client_id]);
  assert.deepEqual(f.containerDriver.volumeRemovals, [container.client_id]);
});

test("a failed volume removal is logged and does not throw", async (t) => {
  const f = fixture(t);
  f.containerDriver.volumeError = new Error("volume busy");
  const container = f.slotOf(LOWEST_SLOT, false, PoolPlacement.Container);
  const root = plantRoot(f.stateDirectory, container.client_id);
  await f.pool.remove(container);
  assert.equal(existsSync(root), false);
  assert.deepEqual(
    f.records.map((entry) => [entry.message, entry.fields.client_id]),
    [[CLEANUP_MESSAGE, container.client_id]],
  );
});

test("the sweep removes each slot root of no live identity and keeps the live roots", async (t) => {
  const f = fixture(t);
  const live = plantRoot(f.stateDirectory, "client_identity_live");
  const orphan = plantRoot(f.stateDirectory, "client_identity_orphan");
  await f.pool.sweep(new Set(["client_identity_live"]));
  assert.equal(existsSync(live), true);
  assert.equal(existsSync(orphan), false);
  assert.deepEqual(f.driver.volumeSweeps, [new Set(["client_identity_live"])]);
  assert.deepEqual(f.containerDriver.volumeSweeps, [
    new Set(["client_identity_live"]),
  ]);
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
