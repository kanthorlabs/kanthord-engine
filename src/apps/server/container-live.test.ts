import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import { deriveClientSecret } from "../../gateway/auth/jwt.ts";
import { isNumber } from "../../kernel/values.ts";
import { packageVersion } from "../../kernel/version.ts";
import { temporary } from "../../kernel/test-support.ts";
import { projectOperations } from "../../project/contract.ts";
import {
  InstancePlacement,
  PoolPlacement,
  workerOperations,
  type ContainerRuntime,
  type PoolSlot,
} from "../../worker/contract.ts";
import { SlotControl } from "../worker/thread-data.ts";
import { ContainerDriver } from "./container-driver.ts";
import {
  CONTAINER_UID,
  containerOwner,
  OWNER_LABEL,
  SLOT_HOME,
  slotName,
  SUCCESS_CODE,
  systemRuntimeHost,
} from "./container-runtime.ts";
import { slotClientIdentity } from "./slot-identity.ts";
import { humanCaller } from "./test-support.ts";
import { workerAcceptance, WORKER_DEFAULTS } from "./worker-acceptance.ts";

const IMAGE_NAME = process.env.KANTHORD_TEST_CONTAINER_IMAGE;
const SKIP = IMAGE_NAME
  ? false
  : "KANTHORD_TEST_CONTAINER_IMAGE names no image; make test-container sets it";
const LIVE_TIMEOUT_MS = 600000;
const STOP_LIMIT_MS = 5000;
const TERMINATE_LIMIT_MS = 5000;
const POLL_MS = 250;
const STOP_GRACE_MS = 1000;
const BINDING = "boxed";
const PROJECT = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = `worker:kanthord:${BINDING}`;
const GENERATION = 1;
const SERVE_SLOT_PID = "2";
const READY_MESSAGE = "Worker application ready";
const FAILED_MESSAGE = "worker.pool.instance_failed";
const MARKER_TEXT = "slot volume marker";
const TMPDIR_ANSWER = "tmpdir script ran";
const OTHER_OWNER = "7ZZZZZZZZZZZZZZZZZZZZZZZZZ";
const KEY_BYTES = 32;
const AUTH_VERSION = 1;
const NO_ITEMS = 0;
const ONE_ITEM = 1;
const FAILED_CODE = 1;
const RUNNING_STATE = "true";

interface CommandAnswer {
  code: number;
  stdout: string;
  stderr: string;
}

function runtimeCall(
  runtime: ContainerRuntime,
  args: string[],
): Promise<CommandAnswer> {
  return new Promise((resolve) => {
    execFile(runtime, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      const code: unknown = error ? Reflect.get(error, "code") : SUCCESS_CODE;
      resolve({ code: isNumber(code) ? code : FAILED_CODE, stdout, stderr });
    });
  });
}

async function waitUntil<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  signal: AbortSignal,
): Promise<T> {
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    await delay(POLL_MS, undefined, { signal });
  }
}

async function containerNames(
  runtime: ContainerRuntime,
  filter: string,
): Promise<string[]> {
  const answer = await runtimeCall(runtime, [
    "ps",
    "--all",
    "--filter",
    filter,
    "--format",
    "{{.Names}}",
  ]);
  assert.equal(answer.code, SUCCESS_CODE, answer.stderr);
  return answer.stdout.split("\n").filter(Boolean);
}

async function running(runtime: ContainerRuntime, name: string) {
  const answer = await runtimeCall(runtime, [
    "inspect",
    "--format",
    "{{.State.Running}}",
    name,
  ]);
  return answer.stdout.trim() === RUNNING_STATE;
}

async function volumeExists(runtime: ContainerRuntime, name: string) {
  return (
    (await runtimeCall(runtime, ["volume", "inspect", name])).code ===
    SUCCESS_CODE
  );
}

async function shell(runtime: ContainerRuntime, name: string, script: string) {
  const answer = await runtimeCall(runtime, [
    "exec",
    name,
    "/bin/sh",
    "-c",
    script,
  ]);
  assert.equal(answer.code, SUCCESS_CODE, answer.stderr);
  return answer.stdout.trim();
}

async function removeOwned(runtime: ContainerRuntime, owner: string) {
  for (const name of await containerNames(
    runtime,
    `label=${OWNER_LABEL}=${owner}`,
  ))
    await runtimeCall(runtime, ["rm", "--force", name]);
  const volumes = await runtimeCall(runtime, [
    "volume",
    "ls",
    "--filter",
    `label=${OWNER_LABEL}=${owner}`,
    "--format",
    "{{.Name}}",
  ]);
  for (const name of volumes.stdout.split("\n").filter(Boolean))
    await runtimeCall(runtime, ["volume", "rm", "--force", name]);
}

async function liveDriver(t: TestContext) {
  const masterKey = randomBytes(KEY_BYTES).toString("base64");
  const driver = new ContainerDriver({
    masterKey,
    image: `${IMAGE_NAME}:${packageVersion()}`,
    host: systemRuntimeHost(process.env),
  });
  const status = await driver.check();
  assert.ok(status.available, JSON.stringify(status));
  const runtime = status.container_runtime!;
  t.after(() => removeOwned(runtime, driver.owner));
  return { driver, runtime, masterKey };
}

function poolSlot(masterKey: string, slot: number): PoolSlot {
  return {
    project_id: PROJECT,
    resource_identity: RESOURCE,
    generation: GENERATION,
    placement: PoolPlacement.Container,
    slot,
    client_id: slotClientIdentity(
      masterKey,
      PROJECT,
      RESOURCE,
      GENERATION,
      slot,
    ),
    draining: false,
  };
}

async function containerPool(t: TestContext) {
  const stateDirectory = temporary(t);
  const setup = await workerAcceptance(t, true, {
    stateDirectory,
    containerImage: IMAGE_NAME,
  });
  const status = await setup.fixture.containerDriver.check();
  assert.ok(status.available, JSON.stringify(status));
  const runtime = status.container_runtime!;
  const owner = containerOwner(setup.fixture.masterKey);
  t.after(async () => {
    await setup.fixture.workerPool.stop();
    await removeOwned(runtime, owner);
  });
  const call = humanCaller(setup.fixture);
  const params = { project_id: setup.project_id };
  const setCount = async (instanceCount: number) => {
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
        bindings: {
          ...current.bindings,
          [BINDING]: {
            kind: "worker",
            config: {
              worker: "coder@1",
              instance_count: instanceCount,
              placement: InstancePlacement.Container,
              entries: [{ agent: "swe@1", ...WORKER_DEFAULTS }],
            },
          },
        } as never,
      },
    });
  };
  const instances = () =>
    call(workerOperations["registration.list"], {
      params: {},
      query: { project_id: setup.project_id },
      body: null,
    }).then((page) =>
      page.items.filter((item) => item.resource_identity === RESOURCE),
    );
  return { ...setup, stateDirectory, runtime, owner, setCount, instances };
}

test(
  "a container slot registers, keeps the containment, drains, resumes its volume and stops",
  { skip: SKIP, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const f = await containerPool(t);
    await f.setCount(1);
    f.fixture.worker.startPool();
    const started = performance.now();
    const [item] = await waitUntil(
      f.instances,
      (items) => items.length === ONE_ITEM,
      t.signal,
    );
    t.diagnostic(
      `criterion 1: registered in ${Math.round(performance.now() - started)} ms`,
    );
    assert.equal(item!.placement, InstancePlacement.Container);
    assert.equal(item!.draining, false);
    const clientId = item!.client_id!;
    const name = slotName(clientId);

    const inspected = await runtimeCall(f.runtime, ["inspect", name]);
    assert.equal(inspected.code, SUCCESS_CODE, inspected.stderr);
    const [container] = JSON.parse(inspected.stdout) as Array<{
      Config: { Env: string[]; Cmd: string[] | null };
      Args?: string[];
      HostConfig: {
        ReadonlyRootfs: boolean;
        CapDrop: string[] | null;
        CapAdd: string[] | null;
        SecurityOpt: string[] | null;
      };
    }>;
    const secret = deriveClientSecret(
      f.fixture.masterKey,
      f.fixture.authVersion,
      clientId,
    );
    const exposed = JSON.stringify([
      container!.Config.Env,
      container!.Config.Cmd,
      container!.Args ?? [],
    ]);
    assert.ok(!exposed.includes(secret), "criterion 2: no client_secret");
    assert.ok(!exposed.includes("KANTHORD_"), "criterion 2: no KANTHORD_*");
    assert.equal(container!.HostConfig.ReadonlyRootfs, true);
    assert.ok(
      (container!.HostConfig.CapDrop ?? []).length > NO_ITEMS,
      `criterion 2: CapDrop ${JSON.stringify(container!.HostConfig.CapDrop)}`,
    );
    const processStatus = await shell(
      f.runtime,
      name,
      `grep -E '^(CapEff|CapBnd|NoNewPrivs):' /proc/${SERVE_SLOT_PID}/status`,
    );
    t.diagnostic(`criterion 2: ${processStatus.replaceAll("\n", " ")}`);
    assert.match(processStatus, /^CapEff:\s+0+$/m);
    assert.match(processStatus, /^CapBnd:\s+0+$/m);
    assert.match(processStatus, /^NoNewPrivs:\s+1$/m);
    assert.deepEqual(container!.HostConfig.CapAdd ?? [], []);
    assert.ok(
      (container!.HostConfig.SecurityOpt ?? []).some((option) =>
        option.startsWith("no-new-privileges"),
      ),
      `criterion 2: SecurityOpt ${JSON.stringify(container!.HostConfig.SecurityOpt)}`,
    );
    t.diagnostic(
      `criterion 2: CapDrop ${JSON.stringify(container!.HostConfig.CapDrop)} SecurityOpt ${JSON.stringify(container!.HostConfig.SecurityOpt)}`,
    );

    const stderrLog = join(f.stateDirectory, "workers", clientId, "stderr.log");
    await waitUntil(
      () => Promise.resolve(readFileSync(stderrLog, "utf8")),
      (text) => text.includes(READY_MESSAGE),
      t.signal,
    );

    assert.equal(
      await shell(
        f.runtime,
        name,
        `script="$TMPDIR/probe.sh"; printf '#!/bin/sh\\necho ${TMPDIR_ANSWER}\\n' > "$script"; chmod 700 "$script"; "$script"`,
      ),
      TMPDIR_ANSWER,
    );
    await shell(
      f.runtime,
      name,
      `printf '${MARKER_TEXT}' > /var/lib/kanthord/marker`,
    );

    await f.setCount(0);
    const drainStarted = performance.now();
    await waitUntil(
      () => containerNames(f.runtime, `name=${name}`),
      (names) => names.length === NO_ITEMS,
      t.signal,
    );
    t.diagnostic(
      `criterion 3: container gone ${Math.round(performance.now() - drainStarted)} ms after the drain`,
    );
    assert.ok(await volumeExists(f.runtime, name), "criterion 3: volume stays");
    assert.ok(
      !f.fixture.logs.some((line) => line.includes(FAILED_MESSAGE)),
      "criterion 3: the drain exits 0",
    );

    await f.setCount(1);
    const [again] = await waitUntil(
      f.instances,
      (items) => items.length === ONE_ITEM,
      t.signal,
    );
    assert.equal(again!.client_id, clientId);
    assert.equal(
      await shell(
        f.runtime,
        name,
        `cat /var/lib/kanthord/marker; echo; stat -c %u /var/lib/kanthord/marker`,
      ),
      `${MARKER_TEXT}\n${CONTAINER_UID}`,
    );

    const stopStarted = performance.now();
    await f.fixture.workerPool.stop();
    const stopMs = performance.now() - stopStarted;
    t.diagnostic(`criterion 4: stop took ${Math.round(stopMs)} ms`);
    assert.ok(stopMs < STOP_LIMIT_MS, `criterion 4: stop took ${stopMs} ms`);
    await waitUntil(
      () => containerNames(f.runtime, `name=${name}`),
      (names) => names.length === NO_ITEMS,
      t.signal,
    );
    assert.ok(
      !f.fixture.logs.some((line) => line.includes(FAILED_MESSAGE)),
      f.fixture.logs.join("\n"),
    );
  },
);

test(
  "terminate ends a container that ignores the stop control within 5 s",
  { skip: SKIP, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const { driver, runtime, masterKey } = await liveDriver(t);
    const slot = poolSlot(masterKey, 0);
    const root = temporary(t);
    const { port1, port2 } = new MessageChannel();
    t.after(() => port1.close());
    const instance = driver.launch({
      slot,
      channel: port2,
      client_secret: deriveClientSecret(
        masterKey,
        AUTH_VERSION,
        slot.client_id,
      ),
      root,
      output: createWriteStream(join(root, "stderr.log")),
      environment: process.env,
    });
    const name = slotName(slot.client_id);
    await waitUntil(() => running(runtime, name), Boolean, t.signal);
    await shell(runtime, name, `kill -STOP ${SERVE_SLOT_PID}`);
    instance.control(SlotControl.Stop);
    await delay(STOP_GRACE_MS);
    assert.ok(await running(runtime, name), "the stopped process ignores stop");
    const started = performance.now();
    instance.terminate();
    const exit = await instance.exited;
    const elapsed = performance.now() - started;
    t.diagnostic(
      `criterion 4: terminate ended the instance in ${Math.round(elapsed)} ms with code ${exit.code}`,
    );
    assert.ok(elapsed < TERMINATE_LIMIT_MS, `terminate took ${elapsed} ms`);
    await waitUntil(
      () => containerNames(runtime, `name=${name}`),
      (names) => names.length === NO_ITEMS,
      t.signal,
    );
  },
);

test(
  "the next start removes the slot container of a launcher that died by SIGKILL",
  { skip: SKIP, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const { driver, runtime, masterKey } = await liveDriver(t);
    const slot = poolSlot(masterKey, 1);
    const root = temporary(t);
    const driverPath = join(import.meta.dirname, "container-driver.ts");
    const runtimePath = join(import.meta.dirname, "container-runtime.ts");
    const program = [
      `import { MessageChannel } from "node:worker_threads";`,
      `import { createWriteStream } from "node:fs";`,
      `import { ContainerDriver } from ${JSON.stringify(driverPath)};`,
      `import { systemRuntimeHost } from ${JSON.stringify(runtimePath)};`,
      `const driver = new ContainerDriver({ masterKey: ${JSON.stringify(masterKey)}, image: ${JSON.stringify(`${IMAGE_NAME}:${packageVersion()}`)}, host: systemRuntimeHost(process.env) });`,
      `const { port2 } = new MessageChannel();`,
      `driver.launch({ slot: ${JSON.stringify(slot)}, channel: port2, client_secret: ${JSON.stringify(deriveClientSecret(masterKey, AUTH_VERSION, slot.client_id))}, root: ${JSON.stringify(root)}, output: createWriteStream(${JSON.stringify(join(root, "stderr.log"))}), environment: process.env });`,
      `setInterval(() => {}, 1000);`,
    ].join("\n");
    const launcher = spawn(
      process.execPath,
      ["--input-type=module", "--eval", program],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    t.after(() => launcher.kill("SIGKILL"));
    const name = slotName(slot.client_id);
    await waitUntil(() => running(runtime, name), Boolean, t.signal);
    launcher.kill("SIGKILL");
    await once(launcher, "exit");
    await driver.prepare();
    assert.deepEqual(await containerNames(runtime, `name=${name}`), []);
  },
);

test(
  "prepare removes the containers of its owner and keeps the containers of another owner",
  { skip: SKIP, timeout: LIVE_TIMEOUT_MS },
  async (t) => {
    const { driver, runtime } = await liveDriver(t);
    const suffix = randomBytes(4).toString("hex");
    const own = `kanthord_slot_test_own_${suffix}`;
    const other = `kanthord_slot_test_other_${suffix}`;
    t.after(async () => {
      await runtimeCall(runtime, ["rm", "--force", other]);
      await runtimeCall(runtime, ["volume", "rm", "--force", own, other]);
    });
    for (const [name, owner] of [
      [own, driver.owner],
      [other, OTHER_OWNER],
    ] as const) {
      const created = await runtimeCall(runtime, [
        "create",
        "--name",
        name,
        "--label",
        `${OWNER_LABEL}=${owner}`,
        "--volume",
        `${name}:${SLOT_HOME}`,
        `${IMAGE_NAME}:${packageVersion()}`,
      ]);
      assert.equal(created.code, SUCCESS_CODE, created.stderr);
    }
    await driver.prepare();
    assert.deepEqual(await containerNames(runtime, `name=${own}`), []);
    assert.deepEqual(await containerNames(runtime, `name=${other}`), [other]);
    t.diagnostic("criterion 6: prepare removed the own container only");
  },
);
