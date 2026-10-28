import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { projectOperations } from "../../project/contract.ts";
import { requirePiTools, temporary } from "../../kernel/test-support.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  alwaysAvailable,
  InstancePlacement,
  PlacementIssue,
  type PlacementStatus,
  WorkerErrorCode,
  workerOperations,
} from "../../worker/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { until } from "./cli-test-support.ts";
import { humanCaller } from "./test-support.ts";
import { threadEnvironment } from "./thread-driver.ts";
import { POOL_BACKOFF_INITIAL_MS } from "./worker-pool.ts";
import {
  serverInstanceName,
  WORKER_DEFAULTS,
  workerAcceptance,
} from "./worker-acceptance-test-support.ts";

const BINDING = "general";
const RESOURCE_IDENTITY = `worker:kanthord:${BINDING}`;
const SLOT_ROOT_MODE = 0o700;
const MODE_MASK = 0o777;
const ONE_INSTANCE = 1;
const TWO_INSTANCES = 2;
const THREE_INSTANCES = 3;
const FIRST_SLOT = 0;
const CLEAN_EXIT_CODE = 0;
const SLOT_ROOT = "/slot";
const POOL_TEST_TIMEOUT = 120000;
const TOMBSTONE_SETTLE_MS = 1100;
const READY_MESSAGE = "Worker application ready";
const FAILED_MESSAGE = "worker.pool.instance_failed";

async function serverPool(t: TestContext, count: number) {
  requirePiTools();
  const stateDirectory = temporary(t);
  const setup = await workerAcceptance(t, true, { stateDirectory });
  const call = humanCaller(setup.fixture);
  const params = { project_id: setup.project_id };
  const started = t.mock.method(setup.fixture.workerPool, "start");
  const rewrite = async (
    change: (bindings: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const current = await call(projectOperations["bindingSet.get"], {
      params,
      query: {},
      body: null,
    });
    return call(projectOperations["bindingSet.write"], {
      params,
      query: {},
      body: {
        version: current.version,
        bindings: change({ ...current.bindings }) as never,
      },
    });
  };
  const created = new Set([serverInstanceName(0)]);
  const instancesOf = async (instanceCount: number) => {
    const names = Array.from({ length: instanceCount }, (_value, index) =>
      serverInstanceName(index),
    );
    for (const name of names) {
      if (created.has(name)) continue;
      created.add(name);
      await call(workerOperations["instance.create"], {
        params: {},
        query: {},
        body: { name, worker: "coder@1", placement: InstancePlacement.Server },
      });
    }
    return names;
  };
  const worker = (names: readonly string[]) => ({
    kind: "worker",
    config: {
      worker: "coder@1",
      worker_instances: [...names],
      entries: [{ agent: "swe@1", ...WORKER_DEFAULTS }],
    },
  });
  const remove = () =>
    rewrite((bindings) =>
      Object.fromEntries(
        Object.entries(bindings).filter(([name]) => name !== BINDING),
      ),
    );
  await remove();
  const initial = await instancesOf(count);
  await rewrite((bindings) => ({ ...bindings, [BINDING]: worker(initial) }));
  await delay(TOMBSTONE_SETTLE_MS);
  const instances = () =>
    call(workerOperations["registration.list"], {
      params: {},
      query: { project_id: setup.project_id },
      body: null,
    }).then((page) => page.items);
  const setCount = async (instanceCount: number) => {
    const names = await instancesOf(instanceCount);
    return rewrite((bindings) => ({ ...bindings, [BINDING]: worker(names) }));
  };
  const waitFor = (size: number) =>
    until(instances, (items) => items.length === size, t.signal);
  const slots = () => started.mock.calls.map((call) => call.arguments[0]);
  const settled = async (ended = slots()) => {
    for (const slot of ended)
      await until(
        () => setup.fixture.threadDriver.threadOf(slot.client_id),
        (thread) => thread === undefined,
        t.signal,
      );
    await delay(POOL_BACKOFF_INITIAL_MS);
    for (const slot of ended)
      assert.equal(
        setup.fixture.threadDriver.threadOf(slot.client_id),
        undefined,
      );
    const failures = setup.fixture.logs.filter((line) =>
      line.includes(FAILED_MESSAGE),
    );
    assert.ok(
      !setup.fixture.logs.some((line) => line.includes(FAILED_MESSAGE)),
      `${FAILED_MESSAGE} logged, see the reason field: ${failures.join("\n")}`,
    );
  };
  return {
    ...setup,
    stateDirectory,
    instances,
    rewrite,
    setCount,
    remove,
    slots,
    settled,
    waitFor,
  };
}

test(
  "the pool starts one instance for each slot with a private slot root and no worker record in the server log",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, TWO_INSTANCES);
    f.fixture.worker.startPool();
    const items = await f.waitFor(TWO_INSTANCES);
    assert.deepEqual(
      items.map((item) => [item.placement, item.draining]),
      [
        [InstancePlacement.Server, false],
        [InstancePlacement.Server, false],
      ],
    );
    assert.equal(
      new Set(items.map((item) => item.client_id)).size,
      TWO_INSTANCES,
    );
    for (const item of items) {
      const root = join(f.stateDirectory, "workers", item.client_id!);
      assert.equal(statSync(root).mode & MODE_MASK, SLOT_ROOT_MODE);
      assert.ok(existsSync(join(root, "state", "kanthord", "kanthord.log")));
      assert.ok(existsSync(join(root, "stderr.log")));
      assert.ok(!existsSync(join(f.stateDirectory, "kanthord.log")));
      assert.match(item.name!, /^server slot [01]$/);
    }
    assert.ok(!f.fixture.logs.some((line) => line.includes(READY_MESSAGE)));
    assert.ok(f.fixture.logs.some((line) => line.includes("Request finished")));
  },
);

test(
  "a binding of an external harness starts no slot",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    await f.rewrite((bindings) => ({
      ...bindings,
      harness: {
        kind: "worker",
        config: { worker: "claude-code@1", instance_count: TWO_INSTANCES },
      },
    }));
    f.fixture.worker.startPool();
    const items = await f.waitFor(ONE_INSTANCE);
    await delay(POOL_BACKOFF_INITIAL_MS);
    assert.deepEqual(
      (await f.instances()).map((item) => item.resource_identity),
      [RESOURCE_IDENTITY],
    );
    assert.equal(f.slots().length, items.length);
  },
);

test(
  "a human machine token of a binding at the server placement cannot register",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    const stranger = await f.machine("stranger");
    const response = await f.fixture.request(workerOperations.register.path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${stranger.token}`,
        "idempotency-key": "idempotency_key_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      },
    });
    assert.equal(response.status, HttpStatus.Conflict);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      WorkerErrorCode.PlacementMismatch,
    );
  },
);

async function assertCleanExits(
  instances: { exited: Promise<{ code: number }> }[],
) {
  assert.ok(instances.length);
  for (const instance of instances)
    assert.equal((await instance.exited).code, CLEAN_EXIT_CODE);
}

test(
  "a count change adds slots and drains the excess slots through deregistration",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    const launch = t.mock.method(f.fixture.threadDriver, "launch");
    f.fixture.worker.startPool();
    const first = await f.waitFor(ONE_INSTANCE);
    await f.setCount(THREE_INSTANCES);
    const grown = await f.waitFor(THREE_INSTANCES);
    assert.ok(grown.some((item) => item.client_id === first[0]!.client_id));
    await f.setCount(ONE_INSTANCE);
    const shrunk = await f.waitFor(ONE_INSTANCE);
    assert.equal(shrunk[0]!.client_id, first[0]!.client_id);
    assert.equal(shrunk[0]!.runtime_identity, first[0]!.runtime_identity);
    await f.setCount(0);
    await until(
      () => f.fixture.worker.registrations.findByClient(first[0]!.client_id!),
      (registration) => registration === undefined,
      t.signal,
    );
    await f.settled();
    await assertCleanExits(launch.mock.calls.map((call) => call.result!));
  },
);

test(
  "a removed binding ends its threads without a restart",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, TWO_INSTANCES);
    const launch = t.mock.method(f.fixture.threadDriver, "launch");
    f.fixture.worker.startPool();
    await f.waitFor(TWO_INSTANCES);
    await f.remove();
    await f.waitFor(0);
    await f.settled();
    await assertCleanExits(launch.mock.calls.map((call) => call.result!));
  },
);

test(
  "a slot that drains before it registers ends without a restart",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    await f.waitFor(ONE_INSTANCE);
    await f.setCount(THREE_INSTANCES);
    await f.setCount(ONE_INSTANCE);
    await f.waitFor(ONE_INSTANCE);
    assert.equal(f.slots().length, THREE_INSTANCES);
    await f.settled(f.slots().slice(ONE_INSTANCE));
  },
);

test(
  "a crashed thread restarts after a backoff and resumes its live registration",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    const [first] = await f.waitFor(ONE_INSTANCE);
    const thread = f.fixture.threadDriver.threadOf(first!.client_id!);
    assert.ok(thread);
    await thread.terminate();
    await until(
      () => f.fixture.logs,
      (lines) => lines.some((line) => line.includes(FAILED_MESSAGE)),
      t.signal,
    );
    await until(
      () => f.fixture.threadDriver.threadOf(first!.client_id!),
      (restarted) => restarted !== undefined && restarted !== thread,
      t.signal,
    );
    await delay(0);
    const [again] = await f.waitFor(ONE_INSTANCE);
    assert.equal(again!.runtime_identity, first!.runtime_identity);
    const failure = f.fixture.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === FAILED_MESSAGE);
    assert.equal(failure?.runtime_identity, first!.runtime_identity);
    assert.equal(failure?.slot, FIRST_SLOT);
  },
);

test(
  "stopping the pool deregisters every idle instance",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, TWO_INSTANCES);
    f.fixture.worker.startPool();
    await f.waitFor(TWO_INSTANCES);
    await f.fixture.worker.stopPool();
    await f.waitFor(0);
  },
);

test(
  "a restart marks the slot as draining before it returns and starts the slot again after the exit with the same client identity",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    await f.waitFor(ONE_INSTANCE);
    const [slot] = f.slots();
    assert.ok(slot);
    const thread = f.fixture.threadDriver.threadOf(slot.client_id);
    assert.ok(thread);
    f.fixture.workerPool.restart(slot);
    assert.equal(slot.draining, true);
    const restarted = await until(
      () => f.fixture.threadDriver.threadOf(slot.client_id),
      (current) => current !== undefined && current !== thread,
      t.signal,
    );
    assert.ok(restarted);
    assert.equal(slot.draining, false);
    const [again] = await f.waitFor(ONE_INSTANCE);
    assert.equal(again!.client_id, slot.client_id);
    assert.equal(f.slots().length, ONE_INSTANCE);
  },
);

test(
  "a restart of an idle slot ends its work pull with no claim and starts the slot again with no failure",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    const [first] = await f.waitFor(ONE_INSTANCE);
    const [slot] = f.slots();
    assert.ok(slot);
    const thread = f.fixture.threadDriver.threadOf(slot.client_id);
    f.fixture.workerPool.restart(slot);
    await until(
      () => f.fixture.threadDriver.threadOf(slot.client_id),
      (current) => current !== undefined && current !== thread,
      t.signal,
    );
    const [again] = await f.waitFor(ONE_INSTANCE);
    assert.equal(again!.client_id, first!.client_id);
    assert.ok(!f.fixture.logs.some((line) => line.includes(FAILED_MESSAGE)));
  },
);

test("the thread environment holds the allowlist and the slot directories only", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/server",
    USER: "server",
    SSH_AUTH_SOCK: "/tmp/agent",
    GIT_AUTHOR_NAME: "Server",
    KANTHORD_TOKEN: "secret",
    NODE_OPTIONS: "--require x",
    XDG_STATE_HOME: "/server/state",
    OPENAI_API_KEY: "secret",
  };
  const env = threadEnvironment(source, SLOT_ROOT);
  assert.deepEqual(Object.keys(env).sort(), [
    "GIT_AUTHOR_NAME",
    "HOME",
    "PATH",
    "USER",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
  ]);
  assert.equal(env.XDG_STATE_HOME, `${SLOT_ROOT}/state`);
  assert.equal(env.XDG_CONFIG_HOME, `${SLOT_ROOT}/config`);
  assert.equal(env.XDG_DATA_HOME, `${SLOT_ROOT}/data`);
  assert.equal(env.XDG_CACHE_HOME, `${SLOT_ROOT}/cache`);
  assert.equal(threadEnvironment({}, SLOT_ROOT).PATH, undefined);
});

test(
  "the placement list and the instance create read the placement status of the pool host",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const setup = await workerAcceptance(t, true, {
      stateDirectory: temporary(t),
    });
    const unavailable: PlacementStatus = {
      placement: InstancePlacement.Container,
      available: false,
      reason: PlacementIssue.RuntimeAbsent,
      detail: null,
      container_runtime: null,
    };
    t.mock.method(setup.fixture.workerPool, "placementStatus", async () => ({
      ...unavailable,
    }));
    const listed = await setup.read<{ items: PlacementStatus[] }>([
      "worker",
      "placement",
      "list",
    ]);
    assert.deepEqual(listed.items, [
      alwaysAvailable(InstancePlacement.Server),
      unavailable,
      alwaysAvailable(InstancePlacement.Worker),
    ]);
    const refused = await httpClient(
      { operation: workerOperations["instance.create"] },
      setup.fixture.endpoint,
      setup.fixture.token,
    ).operation({
      params: {},
      query: {},
      body: {
        name: "container-1",
        worker: "coder@1",
        placement: InstancePlacement.Container,
      },
    });
    assert.equal(refused.type, OperationResultType.Failure);
    assert.ok(refused.type === OperationResultType.Failure);
    assert.equal(refused.status, HttpStatus.Conflict);
    assert.equal(
      refused.error.error.code,
      WorkerErrorCode.InstancePlacementUnavailable,
    );
    assert.deepEqual(refused.error.error.details, {
      placement: InstancePlacement.Container,
      reason: PlacementIssue.RuntimeAbsent,
    });
  },
);
