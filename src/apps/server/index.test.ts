import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { configuration } from "../../config/index.ts";
import { temporary } from "../../kernel/test-support.ts";
import { createServer } from "node:http";
import { writePrivate } from "../../kernel/files.ts";
import { Store } from "../../kernel/store.ts";
import { isString } from "../../kernel/values.ts";
import { GATEWAY_STARTED_MESSAGE } from "../../gateway/index.ts";
import { ulid } from "ulid";
import {
  domainHealth,
  FAKE_SSH_IDENTITY,
  gatewayFixture,
} from "./test-support.ts";
import { llmOperations } from "../../llm/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import { gatewayOperations, OWNER_INTAKE } from "../../gateway/contract.ts";
import { HealthRegistry, ResourceStatus } from "../../kernel/health.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { IntakeService } from "../../intake/index.ts";
import {
  INTAKE_SERVICE_NAME,
  type IntakeInventoryEntry,
} from "../../intake/contract.ts";
import {
  PROJECT_ID_PREFIX,
  projectOperations,
} from "../../project/contract.ts";
import { createIdentity } from "../../kernel/identity.ts";
import { errorSchema } from "../../kernel/errors.ts";

const ExitCode = { Success: 0, Failure: 1 } as const;
import { HttpStatus } from "../../kernel/http.ts";

const EMPTY_OUTPUT = "";
const EMPTY_LOG_CONTENT = "";
const LIFECYCLE_VERIFIED_OUTPUT = "verified\n";
const SHUTDOWN_DEADLINE_MS = 10000;
const CREDENTIAL_NAME = "composition-credential";
const AGENT_NAME = "swe@1";
const PROVIDER_NAME = "primary";
const PROVIDER_KIND = "openai-compatible";
const MODEL_NAME = "composition-model";
const FIRST_REVISION = 1;
const REASONING_LEVEL = "off";
const BASE_URL = "https://example.com/v1";
const INVENTORY_PROJECT_NAME = "inventory";
const INBOUND_NAME = "inbound";
const INBOUND_TARGET = "inbound:composition";
const WEBHOOK_CAPABILITY = "webhook";
const INVENTORY_FAILED = "gateway.healthcheck.inventory_failed";
const entry = new URL("../../main.ts", import.meta.url).href;
function layout(directory: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KANTHORD_CONFIG: join(directory, "kanthord.yaml"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
  };
  for (const path of [
    env.XDG_CONFIG_HOME!,
    env.XDG_DATA_HOME!,
    env.XDG_STATE_HOME!,
  ])
    mkdirSync(join(path, "kanthord"), { mode: 0o700, recursive: true });
  const config = configuration({
    master_key: Buffer.alloc(32).toString("base64"),
    gateway: { port: 0, allowed_hosts: ["localhost"] },
  }).getProperties();
  writePrivate(env.KANTHORD_CONFIG!, stringify(config));
  return {
    env,
    config,
    database: join(env.XDG_DATA_HOME!, "kanthord", "kanthord.db"),
    log: join(env.XDG_STATE_HOME!, "kanthord", "kanthord.log"),
  };
}

test("composition starts all six services and registers the real repository toolchain probe", async (t) => {
  const fixture = await gatewayFixture(t);
  const response = await fixture.request(gatewayOperations.liveness.path);
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.liveness.output.parse(await response.json());
  for (const [name, checks] of Object.entries(domainHealth))
    assert.deepEqual(body.services[name], checks, name);
  assert.equal(body.services.gateway?.listener, HealthStatus.Healthy);
  assert.deepEqual(await fixture.mission.healthcheck(), domainHealth.mission);
});

test("composed services hold Intake and start its probe", async (t) => {
  const health = new HealthRegistry();
  const fixture = await gatewayFixture(t, { health });
  assert.ok(fixture.intake instanceof IntakeService);
  const checks = await health.check();
  assert.deepEqual(checks[INTAKE_SERVICE_NAME], {
    events: HealthStatus.Healthy,
  });
});

function inboundEntry(projectId: string): IntakeInventoryEntry {
  return {
    project_id: projectId,
    name: INBOUND_NAME,
    target: INBOUND_TARGET,
    capability: WEBHOOK_CAPABILITY,
    check: async () => ResourceStatus.Unknown,
  };
}

async function requestHealthReport(
  fixture: Awaited<ReturnType<typeof gatewayFixture>>,
) {
  return fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
}

test("the composition root reports an Intake entry under the name of its project", async (t) => {
  const fixture = await gatewayFixture(t);
  const created = await fixture.request(projectOperations.create.path, {
    method: projectOperations.create.method,
    headers: {
      Authorization: `Bearer ${fixture.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": ulid(),
    },
    body: JSON.stringify({ name: INVENTORY_PROJECT_NAME }),
  });
  assert.equal(created.status, HttpStatus.OK);
  const project = projectOperations.create.output.parse(await created.json());
  t.mock.method(fixture.intake, "resourceInventory", () => [
    inboundEntry(project.id),
  ]);
  const response = await requestHealthReport(fixture);
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body.services.intake, {
    global: {},
    projects: {
      [INVENTORY_PROJECT_NAME]: {
        [INBOUND_NAME]: {
          status: ResourceStatus.Unknown,
          capability: WEBHOOK_CAPABILITY,
        },
      },
    },
  });
});

test("an Intake entry of an unknown project reports intake in missing_inventories", async (t) => {
  const fixture = await gatewayFixture(t);
  t.mock.method(fixture.intake, "resourceInventory", () => [
    inboundEntry(createIdentity(PROJECT_ID_PREFIX)),
  ]);
  const response = await requestHealthReport(fixture);
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  const { error } = errorSchema.parse(await response.json());
  assert.equal(error.code, INVENTORY_FAILED);
  assert.deepEqual(error.details, { missing_inventories: [OWNER_INTAKE] });
});

test("injected repository connector skips the tool gate and probe", async (t) => {
  const health = new HealthRegistry();
  const repositoryConnector = {
    gitLsRemote: async () => {},
    resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
  };
  const fixture = await gatewayFixture(t, { health, repositoryConnector });
  const checks = await health.check();
  assert.equal(Object.hasOwn(checks, "repository"), false);
  assert.equal(fixture.repoConnector, repositoryConnector);
});

test("composed Custody and Worker share credential and enablement collaborations", async (t) => {
  const fixture = await gatewayFixture(t);
  const headers = {
    Authorization: `Bearer ${fixture.token}`,
    "Content-Type": "application/json",
    "Idempotency-Key": ulid(),
  };
  const created = await fixture.request(llmOperations.create.path, {
    method: llmOperations.create.method,
    headers,
    body: JSON.stringify({
      name: CREDENTIAL_NAME,
      platform: PROVIDER_KIND,
      metadata: {
        base_url: BASE_URL,
        models: [],
      },
      secret: { key: "composition-secret" },
    }),
  });
  assert.equal(created.status, HttpStatus.OK, await created.text());
  const updated = await fixture.request(
    llmOperations.update_metadata.path.replace(
      ":credential_name",
      CREDENTIAL_NAME,
    ),
    {
      method: llmOperations.update_metadata.method,
      headers: { ...headers, "Idempotency-Key": ulid() },
      body: JSON.stringify({
        expected_revision: FIRST_REVISION,
        metadata: {
          base_url: BASE_URL,
          models: [{ id: MODEL_NAME, reasoning_levels: [REASONING_LEVEL] }],
        },
      }),
    },
  );
  assert.equal(updated.status, HttpStatus.OK, await updated.text());
  const put = await fixture.request(
    agentOperations["enablement.put"].path.replace(":agent_name", AGENT_NAME),
    {
      method: agentOperations["enablement.put"].method,
      headers: { ...headers, "Idempotency-Key": ulid() },
      body: JSON.stringify({
        agent_providers: [
          {
            name: PROVIDER_NAME,
            provider: PROVIDER_KIND,
            credential: CREDENTIAL_NAME,
          },
        ],
        default_configuration: {
          agent_provider: PROVIDER_NAME,
          model_identifier: MODEL_NAME,
          reasoning_effort: REASONING_LEVEL,
        },
      }),
    },
  );
  assert.equal(put.status, HttpStatus.OK, await put.text());
  fixture.store.transaction((tx) => {
    assert.deepEqual(
      fixture.custody.credentialDependents(tx, CREDENTIAL_NAME),
      {
        agent_providers: [
          { agent_name: AGENT_NAME, provider_name: PROVIDER_NAME },
        ],
        bindings: [],
        inbounds: [],
      },
    );
    assert.equal(
      fixture.custody.credentialMetadata(tx, CREDENTIAL_NAME)?.name,
      CREDENTIAL_NAME,
    );
  });
});

test("serve rejects unsafe owned directories/files and releases earlier resources after startup failure", async (t) => {
  const paths = layout(temporary(t));
  const listener = createServer();
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => listener.close(() => resolve())),
  );
  const address = listener.address();
  assert.ok(address && !isString(address));
  paths.config.gateway.port = address.port;
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  const serve = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
      ],
      { env: paths.env, encoding: "utf8", timeout: 10000 },
    );
  const data = join(paths.env.XDG_DATA_HOME!, "kanthord");
  chmodSync(data, 0o755);
  assert.match(serve().stderr, /mode 700/);
  chmodSync(data, 0o700);
  writeFileSync(paths.database, "", { mode: 0o600 });
  chmodSync(paths.database, 0o644);
  assert.match(serve().stderr, /mode 600/);
  chmodSync(paths.database, 0o600);
  const result = serve();
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /cannot bind/);
  assert.equal(result.stdout, EMPTY_OUTPUT);
  const store = new Store(paths.database);
  assert.equal(
    store.database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'gateway_account'")
      .get(),
    undefined,
  );
  store.close();
  assert.deepEqual(readdirSync(data), ["kanthord.db"]);
});

test("serve starts with redirected stdout without issuing a JWT; SIGTERM drains and releases the database", async (t) => {
  const paths = layout(temporary(t));
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
    ],
    { env: paths.env, stdio: "pipe" },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.once("exit", () =>
      reject(new Error("server exited before readiness")),
    );
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      for (const line of stderr.split("\n")) {
        try {
          const record = JSON.parse(line);
          if (record.msg === GATEWAY_STARTED_MESSAGE) resolve(record.port);
        } catch {
          /* Wait for a complete JSON log record. */
        }
      }
    });
  });
  // Hono's in-process request and the real listener have the same Host policy.
  const { request } = await import("node:http");
  const health = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const call = request(
        `http://127.0.0.1:${port}/api/liveness`,
        { headers: { Host: "localhost" } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.once("end", () =>
            resolve({ status: response.statusCode!, body }),
          );
          response.once("error", reject);
        },
      );
      call.on("error", reject);
      call.end();
    },
  );
  assert.equal(health.status, HttpStatus.OK);
  assert.deepEqual(JSON.parse(health.body), {
    status: "ok",
    services: {
      repository: { toolchain: HealthStatus.Healthy },
      server: { gateway: 200, store: 200, log: 200 },
      scheduler: { queue: HttpStatus.OK },
      custody: { credential: 200 },
      worker: { registrations: 200 },
      mission: { operations: 200 },
      project: { bindings: 200 },
      intake: { events: 200 },
      gateway: {
        listener: 200,
        authentication: 200,
        idempotency: 200,
        registry: 200,
        invocation: 200,
      },
    },
  });
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  child.kill("SIGTERM");
  assert.equal(await exit, ExitCode.Success);
  assert.equal(stdout, EMPTY_OUTPUT);
  assert.doesNotMatch(stderr, /Username:|JWT:|eyJ[A-Za-z0-9_-]*\./);
  const reopened = new Store(paths.database);
  reopened.close();
});

test("unsafe SIGHUP replacement initiates shutdown and receives no log record", async (t) => {
  const paths = layout(temporary(t));
  paths.config.log.destination = "file";
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  // The server's run/start boundary supplies deterministic readiness to this subprocess test.
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const server=new Server(); const running=server.run();
    if (await server.start()) process.exit(1);
    process.stdout.write('ready\\n'); process.exitCode = await running ? 1 : 0;
  `,
    ],
    { env: paths.env, stdio: "pipe" },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.endsWith("ready\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error("server exited before readiness")),
    );
  });
  const old = paths.log + ".old";
  renameSync(paths.log, old);
  writeFileSync(paths.log, "", { mode: 0o600 });
  chmodSync(paths.log, 0o644);
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  child.kill("SIGHUP");
  assert.equal(await exit, ExitCode.Failure);
  assert.equal(readFileSync(paths.log, "utf8"), EMPTY_LOG_CONTENT);
  assert.match(readFileSync(old, "utf8"), /Gateway Service started/);
  const reopened = new Store(paths.database);
  reopened.close();
});

test("server lifecycle returns errors, reports owned health and releases every resource even when cleanup fails", (t) => {
  const paths = layout(temporary(t));
  paths.config.log.destination = "file";
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { CancellationContext } from ${JSON.stringify(new URL("../../kernel/context.ts", import.meta.url).href)};
    import { Store } from ${JSON.stringify(new URL("../../kernel/store.ts", import.meta.url).href)};
    import { OperationalLog } from ${JSON.stringify(new URL("../../kernel/log.ts", import.meta.url).href)};
    const write = process.stdout.write.bind(process.stdout);
    let output = '';
    process.stdout.write = (text) => { output += String(text); return true; };
    const inactive = new Server();
    assert.deepEqual(await inactive.healthcheck(), { gateway: 503, store: 503, log: 503 });
    const cancelled = new CancellationContext(); cancelled.cancel();
    assert.equal(await inactive.run(cancelled), cancelled.err());
    assert.equal(await inactive.stop(), null);
    const failed = new Server(${JSON.stringify(join(paths.env.XDG_CONFIG_HOME!, "absent.yaml"))});
    assert.ok(await failed.start() instanceof Error);
    assert.equal(await failed.stop(), null);
    const server = new Server(); const context = new CancellationContext();
    const signals = process.listenerCount('SIGTERM');
    const running = server.run(context);
    assert.equal(server.start(), server.start());
    assert.equal(await server.start(), null);
    assert.deepEqual(await server.healthcheck(), { gateway: 200, store: 200, log: 200 });
    server.health.register('test-worker', () => ({ 'instance-one': 200 }));
    const report = await server.health.check();
    assert.deepEqual(report.server, { gateway: 200, store: 200, log: 200 });
    assert.deepEqual(report['test-worker'], { 'instance-one': 200 });
    assert.deepEqual(report.scheduler, { queue: 200 });
    assert.deepEqual(report.custody, { credential: 200 });
    assert.deepEqual(report.worker, { registrations: 200 });
    assert.deepEqual(report.mission, { operations: 200 });
    assert.deepEqual(report.project, { bindings: 200 });
    assert.equal(report.gateway.listener, 200);
    const logHealth = OperationalLog.prototype.healthcheck;
    OperationalLog.prototype.healthcheck = () => false;
    assert.deepEqual((await server.health.check()).server, { gateway: 200, store: 200, log: 503 });
    OperationalLog.prototype.healthcheck = logHealth;
    context.cancel();
    assert.equal(await running, context.err());
    assert.equal(await server.stop(), null);
    assert.deepEqual(await server.healthcheck(), { gateway: 503, store: 503, log: 503 });
    assert.equal(process.listenerCount('SIGTERM'), signals);
    assert.ok(await server.start() instanceof Error);
    const { WorkerService } = await import(${JSON.stringify(new URL("../../worker/index.ts", import.meta.url).href)});
    const originalRun = WorkerService.prototype.run;
    const runFailure = new Error('worker run failed');
    WorkerService.prototype.run = async () => runFailure;
    const failedRun = new Server();
    assert.equal(await failedRun.run(), runFailure);
    assert.deepEqual(await failedRun.healthcheck(), { gateway: 503, store: 503, log: 503 });
    WorkerService.prototype.run = originalRun;
    const broken = new Server(); const joined = broken.run();
    assert.equal(await broken.start(), null);
    const storeFailure = new Error('store cleanup failed');
    const logFailure = new Error('log cleanup failed');
    const closeStore = Store.prototype.close;
    Store.prototype.close = function() { closeStore.call(this); throw storeFailure; };
    const closeLog = OperationalLog.prototype.close;
    OperationalLog.prototype.close = async function() { await closeLog.call(this); throw logFailure; };
    const quiescing = broken.quiesce(); assert.equal(quiescing, broken.quiesce());
    assert.equal(await quiescing, null);
    const stopping = broken.stop(); assert.equal(stopping, broken.stop());
    const error = await stopping;
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [storeFailure, logFailure]);
    assert.equal(await joined, error);
    assert.deepEqual(await broken.healthcheck(), { gateway: 503, store: 503, log: 503 });
    assert.equal(output, '');
    write('verified\\n');
  `,
    ],
    { env: paths.env, encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, LIFECYCLE_VERIFIED_OUTPUT);
  const reopened = new Store(paths.database);
  reopened.close();
});

test("server quiesces concurrently, drains Intake with direct calls available, joins the chain and releases Intake between Gateway and Project", (t) => {
  const paths = layout(temporary(t));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { SchedulerService } from ${JSON.stringify(new URL("../../scheduler/index.ts", import.meta.url).href)};
    import { CustodyComponent } from ${JSON.stringify(new URL("../../custody/index.ts", import.meta.url).href)};
    import { MissionService } from ${JSON.stringify(new URL("../../mission/index.ts", import.meta.url).href)};
    import { ProjectService } from ${JSON.stringify(new URL("../../project/index.ts", import.meta.url).href)};
    import { WorkerService } from ${JSON.stringify(new URL("../../worker/index.ts", import.meta.url).href)};
    import { IntakeService } from ${JSON.stringify(new URL("../../intake/index.ts", import.meta.url).href)};
    import { GatewayService } from ${JSON.stringify(new URL("../../gateway/index.ts", import.meta.url).href)};
    import { Store } from ${JSON.stringify(new URL("../../kernel/store.ts", import.meta.url).href)};
    import { OperationalLog } from ${JSON.stringify(new URL("../../kernel/log.ts", import.meta.url).href)};
    const server = new Server();
    const events = [];
    const gate = Promise.withResolvers();
    let quiesced = 0;
    const signalled = new Set();
    const released = new Set();
    const services = [['scheduler', SchedulerService], ['custody', CustodyComponent], ['worker', WorkerService], ['mission', MissionService], ['project', ProjectService], ['intake', IntakeService], ['gateway', GatewayService]];
    const serviceCount = services.length;
    for (const [name, type] of services) {
      const start = type.prototype.start;
      type.prototype.start = function() {
        events.push('start-' + name);
        return start.call(this);
      };
      const quiesce = type.prototype.quiesce;
      type.prototype.quiesce = function() {
        if (signalled.has(name)) return quiesce.call(this);
        signalled.add(name);
        events.push('quiesce-' + name);
        const task = quiesce.call(this);
        if (++quiesced === serviceCount) gate.resolve();
        return gate.promise.then(() => task);
      };
      const drain = type.prototype.drain;
      type.prototype.drain = async function() {
        if (!released.size) {
          assert.equal(quiesced, serviceCount);
          assert.equal(server.store.healthcheck(), true);
          assert.equal(server.log.healthcheck(), true);
          const result = await server.gateway.invocation.invoke('gateway.openapi', { params: {}, query: {}, body: null });
          assert.equal(result.status, 200);
          events.push('drain-' + name);
        }
        await drain?.call(this);
      };
      const stop = type.prototype.stop;
      type.prototype.stop = async function() {
        if (!released.has(name)) {
          released.add(name);
          const result = await server.gateway.invocation.invoke('gateway.openapi', { params: {}, query: {}, body: null });
          assert.equal(result.status, 503);
          assert.equal(server.store.healthcheck(), true);
          events.push('stop-' + name);
        }
        return stop.call(this);
      };
    }
    const closeStore = Store.prototype.close;
    Store.prototype.close = function() { events.push('store'); return closeStore.call(this); };
    const closeLog = OperationalLog.prototype.close;
    OperationalLog.prototype.close = function() { events.push('log'); return closeLog.call(this); };
    assert.equal(await server.start(), null);
    assert.equal(await server.stop(), null);
    assert.deepEqual([...new Set(events.filter(event => event.startsWith('start-')))], ['start-scheduler', 'start-custody', 'start-worker', 'start-mission', 'start-project', 'start-intake', 'start-gateway']);
    const shutdown = events.filter(event => !event.startsWith('start-'));
    const drainEnd = serviceCount + serviceCount;
    assert.deepEqual(shutdown.slice(0, serviceCount), ['quiesce-scheduler', 'quiesce-custody', 'quiesce-worker', 'quiesce-mission', 'quiesce-project', 'quiesce-intake', 'quiesce-gateway']);
    assert.deepEqual(shutdown.slice(serviceCount, drainEnd).sort(), ['drain-custody', 'drain-gateway', 'drain-intake', 'drain-mission', 'drain-project', 'drain-scheduler', 'drain-worker']);
    assert.deepEqual(shutdown.slice(drainEnd), ['stop-gateway', 'stop-intake', 'stop-project', 'stop-mission', 'stop-worker', 'stop-custody', 'stop-scheduler', 'store', 'log']);
  `,
    ],
    { env: paths.env, encoding: "utf8", timeout: 15000 },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
});

test("server startup failure releases Mission in reverse construction order and stop is idempotent", (t) => {
  const paths = layout(temporary(t));
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { SchedulerService } from ${JSON.stringify(new URL("../../scheduler/index.ts", import.meta.url).href)};
    import { CustodyComponent } from ${JSON.stringify(new URL("../../custody/index.ts", import.meta.url).href)};
    import { WorkerService } from ${JSON.stringify(new URL("../../worker/index.ts", import.meta.url).href)};
    import { MissionService } from ${JSON.stringify(new URL("../../mission/index.ts", import.meta.url).href)};
    import { ProjectService } from ${JSON.stringify(new URL("../../project/index.ts", import.meta.url).href)};
    import { GatewayService } from ${JSON.stringify(new URL("../../gateway/index.ts", import.meta.url).href)};
    const events = [];
    const starts = [];
    const failure = new Error('gateway startup failed');
    for (const [name, type] of [['scheduler', SchedulerService], ['custody', CustodyComponent], ['worker', WorkerService], ['mission', MissionService], ['project', ProjectService], ['gateway', GatewayService]]) {
      const start = type.prototype.start;
      type.prototype.start = function() {
        starts.push(name);
        return name === 'gateway' ? Promise.resolve(failure) : start.call(this);
      };
      const stop = type.prototype.stop;
      type.prototype.stop = function() {
        events.push(name);
        return stop.call(this);
      };
    }
    const server = new Server();
    assert.equal(await server.start(), failure);
    assert.deepEqual(starts, ['scheduler', 'custody', 'worker', 'mission', 'project', 'gateway']);
    assert.deepEqual(events, ['gateway', 'project', 'mission', 'worker', 'custody', 'scheduler']);
    assert.equal(await server.stop(), null);
    assert.equal(await server.stop(), null);
    assert.deepEqual(events, ['gateway', 'project', 'mission', 'worker', 'custody', 'scheduler']);
    assert.deepEqual(await server.healthcheck(), { gateway: 503, store: 503, log: 503 });
    process.stdout.write('verified\\n');
  `,
    ],
    { env: paths.env, encoding: "utf8", timeout: SHUTDOWN_DEADLINE_MS },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, LIFECYCLE_VERIFIED_OUTPUT);
});

test("the shutdown watchdog holds the event loop and exits the process when cleanup never settles", () => {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    Server.prototype.release = () => new Promise(() => {});
    await new Server().stop();
    `,
    ],
    { encoding: "utf8", timeout: 20000 },
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  assert.ok(Date.now() - started >= SHUTDOWN_DEADLINE_MS);
});
