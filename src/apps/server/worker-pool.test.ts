import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { projectOperations } from "../../project/contract.ts";
import { requirePiTools } from "../../kernel/test-support.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  alwaysAvailable,
  BindingEntryState,
  InstancePlacement,
  PlacementIssue,
  type PlacementStatus,
  WorkerErrorCode,
  workerOperations,
} from "../../worker/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { createIdentity } from "../../kernel/identity.ts";
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
const CLEAN_EXIT_CODE = 0;
const SLOT_ROOT = "/slot";
const POOL_TEST_TIMEOUT = 120000;
const TOMBSTONE_SETTLE_MS = 1100;
const READY_MESSAGE = "Worker application ready";
const FAILED_MESSAGE = "worker.pool.instance_failed";
const INSTANCE_REQUIRED_CODE = "gateway.jwt.instance_required";

async function serverPool(t: TestContext, count: number) {
  requirePiTools();
  const setup = await workerAcceptance(t, true);
  const stateDirectory = setup.fixture.stateDirectory;
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
  const setList = async (instanceCount: number) => {
    const names = await instancesOf(instanceCount);
    return rewrite((bindings) => ({ ...bindings, [BINDING]: worker(names) }));
  };
  const waitFor = (size: number) =>
    until(instances, (items) => items.length === size, t.signal);
  const hosted = () => started.mock.calls.map((call) => call.arguments[0]);
  const running = (name: string) =>
    until(
      () => setup.fixture.threadDriver.threadOf(name),
      (thread) => thread !== undefined,
      t.signal,
    );
  const noFailure = () => {
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
    setList,
    instancesOf,
    remove,
    hosted,
    running,
    noFailure,
    waitFor,
    call,
  };
}

test(
  "the pool runs each server instance with a private slot root that carries the instance name and no worker record in the server log",
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
    assert.deepEqual(items.map((item) => item.name).sort(), [
      serverInstanceName(0),
      serverInstanceName(1),
    ]);
    for (const item of items) {
      const root = join(f.stateDirectory, "workers", item.name!);
      assert.equal(statSync(root).mode & MODE_MASK, SLOT_ROOT_MODE);
      assert.ok(existsSync(join(root, "state", "kanthord", "kanthord.log")));
      assert.ok(existsSync(join(root, "stderr.log")));
      assert.ok(!existsSync(join(f.stateDirectory, "kanthord.log")));
    }
    assert.ok(!f.fixture.logs.some((line) => line.includes(READY_MESSAGE)));
    assert.ok(f.fixture.logs.some((line) => line.includes("Request finished")));
  },
);

test(
  "a binding of an external harness starts no instance",
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
    await f.waitFor(ONE_INSTANCE);
    await delay(POOL_BACKOFF_INITIAL_MS);
    assert.deepEqual(
      (await f.instances()).map((item) => item.resource_identity),
      [RESOURCE_IDENTITY],
    );
    assert.equal(f.hosted().length, ONE_INSTANCE);
  },
);

test(
  "a machine token with no instance claim and an identity that no instance derives cannot register",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    await f.waitFor(ONE_INSTANCE);
    const register = (token: string) =>
      f.fixture.request(workerOperations.register.path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": "idempotency_key_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        },
      });
    const stranger = await f.machine("stranger");
    const missing = await register(stranger.token);
    assert.equal(missing.status, HttpStatus.Unauthorized);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      INSTANCE_REQUIRED_CODE,
    );
    const instance = await f.call(workerOperations["instance.get"], {
      params: { instance_name: serverInstanceName(0) },
      query: {},
      body: null,
    });
    const foreign = await f.fixture.slotTokenOf(
      {
        id: instance.id,
        name: instance.name,
        placement: InstancePlacement.Server,
        created_at: instance.created_at,
      },
      {
        project_id: f.project_id,
        resource_identity: RESOURCE_IDENTITY,
        client_id: createIdentity("client_identity"),
        state: BindingEntryState.Serving,
      },
    );
    const mismatch = await register(foreign);
    assert.equal(mismatch.status, HttpStatus.Conflict);
    assert.equal(
      ((await mismatch.json()) as { error: { code: string } }).error.code,
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
  "a binding write lists and unlists instances while every instance keeps running",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    const first = await f.waitFor(ONE_INSTANCE);
    await f.setList(THREE_INSTANCES);
    const created = await Promise.all(
      [1, 2].map((index) => f.running(serverInstanceName(index))),
    );
    const grown = await f.waitFor(THREE_INSTANCES);
    assert.ok(grown.some((item) => item.client_id === first[0]!.client_id));
    assert.equal(f.hosted().length, THREE_INSTANCES);
    await f.setList(ONE_INSTANCE);
    const shrunk = await f.waitFor(ONE_INSTANCE);
    assert.equal(shrunk[0]!.client_id, first[0]!.client_id);
    assert.equal(shrunk[0]!.runtime_identity, first[0]!.runtime_identity);
    for (const [index, thread] of created.entries())
      assert.equal(
        f.fixture.threadDriver.threadOf(serverInstanceName(index + 1)),
        thread,
      );
    await f.setList(0);
    await until(
      () => f.fixture.worker.registrations.findByClient(first[0]!.client_id!),
      (registration) => registration === undefined,
      t.signal,
    );
    await f.running(serverInstanceName(0));
    f.noFailure();
  },
);

test(
  "a removed binding drains its registrations and leaves every thread running",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, TWO_INSTANCES);
    f.fixture.worker.startPool();
    await f.waitFor(TWO_INSTANCES);
    await f.remove();
    await f.waitFor(0);
    await delay(POOL_BACKOFF_INITIAL_MS);
    for (const name of [serverInstanceName(0), serverInstanceName(1)])
      assert.ok(f.fixture.threadDriver.threadOf(name));
    f.noFailure();
  },
);

test(
  "an archive ends the thread of the instance with a clean exit and removes its slot root",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    const launch = t.mock.method(f.fixture.threadDriver, "launch");
    f.fixture.worker.startPool();
    await f.waitFor(ONE_INSTANCE);
    const name = serverInstanceName(0);
    const root = join(f.stateDirectory, "workers", name);
    assert.ok(existsSync(root));
    await f.setList(0);
    await f.waitFor(0);
    const record = await f.call(workerOperations["instance.get"], {
      params: { instance_name: name },
      query: {},
      body: null,
    });
    await f.call(workerOperations["instance.archive"], {
      params: { instance_name: name },
      query: {},
      body: { expected_revision: record.revision },
    });
    await until(
      () => f.fixture.threadDriver.threadOf(name),
      (thread) => thread === undefined,
      t.signal,
    );
    await until(() => !existsSync(root), Boolean, t.signal);
    await assertCleanExits(launch.mock.calls.map((call) => call.result!));
    f.noFailure();
  },
);

test(
  "a crashed thread restarts after a backoff and resumes its live registration",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    const [first] = await f.waitFor(ONE_INSTANCE);
    const name = serverInstanceName(0);
    const thread = f.fixture.threadDriver.threadOf(name);
    assert.ok(thread);
    await thread.terminate();
    await until(
      () => f.fixture.logs,
      (lines) => lines.some((line) => line.includes(FAILED_MESSAGE)),
      t.signal,
    );
    await until(
      () => f.fixture.threadDriver.threadOf(name),
      (restarted) => restarted !== undefined && restarted !== thread,
      t.signal,
    );
    await delay(0);
    const [again] = await f.waitFor(ONE_INSTANCE);
    assert.equal(again!.runtime_identity, first!.runtime_identity);
    const failure = f.fixture.logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record.msg === FAILED_MESSAGE);
    assert.equal(failure?.instance, name);
    assert.equal("slot" in (failure ?? {}), false);
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
  "a restart starts the thread again after the exit with the same client identity",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    await f.waitFor(ONE_INSTANCE);
    const [instance] = f.hosted();
    assert.ok(instance);
    const thread = f.fixture.threadDriver.threadOf(instance.name);
    assert.ok(thread);
    f.fixture.workerPool.restart(instance);
    const restarted = await until(
      () => f.fixture.threadDriver.threadOf(instance.name),
      (current) => current !== undefined && current !== thread,
      t.signal,
    );
    assert.ok(restarted);
    const [again] = await f.waitFor(ONE_INSTANCE);
    assert.equal(again!.name, instance.name);
    assert.equal(f.hosted().length, ONE_INSTANCE);
    f.noFailure();
  },
);

test(
  "a restart of an idle instance ends its work pull with no claim and starts the thread again with no failure",
  { timeout: POOL_TEST_TIMEOUT },
  async (t) => {
    const f = await serverPool(t, ONE_INSTANCE);
    f.fixture.worker.startPool();
    const [first] = await f.waitFor(ONE_INSTANCE);
    const [instance] = f.hosted();
    assert.ok(instance);
    const thread = f.fixture.threadDriver.threadOf(instance.name);
    f.fixture.workerPool.restart(instance);
    await until(
      () => f.fixture.threadDriver.threadOf(instance.name),
      (current) => current !== undefined && current !== thread,
      t.signal,
    );
    const [again] = await f.waitFor(ONE_INSTANCE);
    assert.equal(again!.client_id, first!.client_id);
    f.noFailure();
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
    const setup = await workerAcceptance(t, true);
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
