import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  execFile,
  spawn,
  spawnSync,
  type ExecFileException,
} from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { configuration, CONFIG_VERSION } from "../../config/index.ts";
import { temporary } from "../../kernel/test-support.ts";
import { createServer } from "node:http";
import { writePrivate } from "../../kernel/files.ts";
import {
  Store,
  type Migrations,
  type Transaction,
} from "../../kernel/store.ts";
import { CancellationContext } from "../../kernel/context.ts";
import { isNumber, isString } from "../../kernel/values.ts";
import {
  collectInventories,
  GATEWAY_STARTED_MESSAGE,
  resourceHealthReport,
} from "../../gateway/index.ts";
import {
  projectScopedIntakeInventory,
  serverMigrations,
  trackingDatabaseMigrations,
} from "./index.ts";
import { until } from "./cli-support.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import type { Material } from "../../custody/contract.ts";
import pino from "pino";
import { ulid } from "ulid";
import {
  domainHealth,
  fakeGitHub,
  gatewayFixture,
  FakeSlotInstance,
  humanCaller,
} from "./test-support.ts";
import { fakeContainerHost, fakeRepositoryFiles } from "./container-fakes.ts";
import { ContainerDriver } from "./container-driver.ts";
import { workerAcceptance, WORKER_DEFAULTS } from "./worker-acceptance.ts";
import type { EnvironmentRuntime } from "../../project/environment-state.ts";
import { packageVersion } from "../../kernel/version.ts";
import type { SlotDriver } from "./slot-driver.ts";
import { llmOperations } from "../../llm/contract.ts";
import { agentOperations } from "../../agent/contract.ts";
import { gatewayOperations, OWNER_INTAKE } from "../../gateway/contract.ts";
import {
  HealthRegistry,
  ResourceFailureReason,
  ResourceStatus,
} from "../../kernel/health.ts";
import { HealthStatus } from "../../kernel/service.ts";
import { IntakeService } from "../../intake/index.ts";
import {
  Consumer,
  INBOUND_CREATED_STATUS,
  InboundKind,
  InboundPlatform,
  intakeOperations,
  INTAKE_SERVICE_NAME,
  type IntakeInventoryEntry,
} from "../../intake/contract.ts";
import { repositoryOperations } from "../../repository/contract.ts";
import {
  BINDING_ID_PREFIX,
  PROJECT_ID_PREFIX,
  projectOperations,
} from "../../project/contract.ts";
import { createIdentity, createIdempotencyKey } from "../../kernel/identity.ts";
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
const POLL_CAPABILITY = "poll acquisition";
const POLL_CREDENTIAL = "health-github";
const POLL_KEY = "health_poll_github_key";
const POLL_OWNER = "owner";
const POLL_REPO = "repo";
const MALFORMED_CONFIGURATION = "{";
const HELD_EVENTS_PASS = 0;
const HELD_CHECK_RELEASES = 1;
const DEADLINE_LIMITS = {
  maxConcurrent: 1,
  checkDeadlineMs: 50,
  reportBudgetMs: 5000,
};
const execFileAsync = promisify(execFile);
const EVENTS_PATH = /^\/repos\/owner\/repo\/events(\?|$)/;
const entry = new URL("../../main.ts", import.meta.url).href;
async function nodeChild(
  args: string[],
  options: { env?: NodeJS.ProcessEnv; signal: AbortSignal },
) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, args, {
      ...options,
      encoding: "utf8",
    });
    return { status: ExitCode.Success, stdout, stderr };
  } catch (error) {
    if (options.signal.aborted) throw error;
    const { code, stdout, stderr } = error as ExecFileException & {
      stdout: string;
      stderr: string;
    };
    return { status: isNumber(code) ? code : null, stdout, stderr };
  }
}
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
    version: CONFIG_VERSION,
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
      "Idempotency-Key": createIdempotencyKey(),
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
          failure_reason: ResourceFailureReason.Unclassified,
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

type Fixture = Awaited<ReturnType<typeof gatewayFixture>>;

async function created(
  fixture: Fixture,
  operation: { path: string; method: string },
  status: number,
  body: unknown,
): Promise<unknown> {
  const response = await fixture.request(operation.path, {
    method: operation.method,
    headers: {
      Authorization: `Bearer ${fixture.token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": createIdempotencyKey(),
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

async function pollFixture(t: TestContext) {
  const gitHub = await fakeGitHub(t);
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
  });
  await created(fixture, repositoryOperations.create, HttpStatus.OK, {
    name: POLL_CREDENTIAL,
    platform: InboundPlatform.GitHub,
    metadata: null,
    secret: { key: POLL_KEY },
  });
  const project = projectOperations.create.output.parse(
    await created(fixture, projectOperations.create, HttpStatus.OK, {
      name: INVENTORY_PROJECT_NAME,
    }),
  );
  const pollInbound = async () =>
    intakeOperations["inbound.create"].output.parse(
      await created(
        fixture,
        intakeOperations["inbound.create"],
        INBOUND_CREATED_STATUS,
        {
          project_id: project.id,
          kind: InboundKind.Poll,
          platform: InboundPlatform.GitHub,
          consumer: Consumer.MissionDeliveryAdmit,
          credential: POLL_CREDENTIAL,
          configuration: { resource: `${POLL_OWNER}/${POLL_REPO}` },
        },
      ),
    ).id;
  const inboundRow = (id: string) =>
    fixture.store.transaction((tx) =>
      tx.database.prepare("SELECT * FROM intake_inbound WHERE id = ?").get(id),
    );
  return { gitHub, fixture, pollInbound, inboundRow };
}

test("a malformed poll inbound answers unknown for its own entry and the report answers the other entries", async (t) => {
  const { fixture, pollInbound } = await pollFixture(t);
  const good = await pollInbound();
  const malformed = await pollInbound();
  fixture.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE intake_inbound SET configuration = ? WHERE id = ?")
      .run(MALFORMED_CONFIGURATION, malformed),
  );
  const response = await requestHealthReport(fixture);
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body.services.intake, {
    global: {},
    projects: {
      [INVENTORY_PROJECT_NAME]: {
        [encodeURIComponent(good)]: {
          status: ResourceStatus.Healthy,
          capability: POLL_CAPABILITY,
          failure_reason: null,
        },
        [encodeURIComponent(malformed)]: {
          status: ResourceStatus.Unknown,
          capability: POLL_CAPABILITY,
          failure_reason: ResourceFailureReason.Unclassified,
        },
      },
    },
  });
});

function releasedMaterials(t: TestContext, fixture: Fixture) {
  const released: { materials: Material[]; drops: string[] } = {
    materials: [],
    drops: [],
  };
  const release = fixture.custody.release.bind(fixture.custody);
  t.mock.method(
    fixture.custody,
    "release",
    (...args: Parameters<typeof release>) => {
      const material = release(...args);
      const drop = material.drop.bind(material);
      material.drop = () => {
        released.drops.push(material.credential_id);
        drop();
      };
      released.materials.push(material);
      return material;
    },
  );
  return released;
}

function intakeOnlyReport(t: TestContext, fixture: Fixture) {
  const collect = () =>
    fixture.store.transaction((tx) =>
      collectInventories(tx, {
        llm: () => [],
        agent: () => [],
        repository: () => [],
        storage: () => [],
        worker: () => [],
        project: () => [],
        intake: projectScopedIntakeInventory(fixture.intake, fixture.project),
      }),
    );
  const context = new CancellationContext();
  t.after(() => context.cancel());
  const caller = {
    identity: testHumanIdentity("health-reader", "Health Reader", ulid()),
    context,
    requestId: ulid(),
    commit: <T>(write: (tx: Transaction) => T) =>
      fixture.store.transaction(write),
  };
  return resourceHealthReport(
    caller,
    collect,
    pino({ level: "silent" }),
    DEADLINE_LIMITS,
  );
}

test("the check deadline of a poll inbound answers unknown through the report, drops the material and changes no inbound", async (t) => {
  const { gitHub, fixture, pollInbound, inboundRow } = await pollFixture(t);
  const id = await pollInbound();
  const before = inboundRow(id);
  const eventsCalls = () =>
    gitHub.calls.filter((call) => EVENTS_PATH.test(call.path)).length;
  const calledBefore = eventsCalls();
  const releaseEvents = gitHub.holdEvents({ pass: HELD_EVENTS_PASS });
  t.after(() => releaseEvents());
  const released = releasedMaterials(t, fixture);
  const report = await intakeOnlyReport(t, fixture);
  assert.deepEqual(report.services.intake, {
    global: {},
    projects: {
      [INVENTORY_PROJECT_NAME]: {
        [encodeURIComponent(id)]: {
          status: ResourceStatus.Unknown,
          capability: POLL_CAPABILITY,
          failure_reason: ResourceFailureReason.Unclassified,
        },
      },
    },
  });
  assert.equal(released.materials.length, HELD_CHECK_RELEASES);
  assert.equal(eventsCalls(), calledBefore + HELD_CHECK_RELEASES);
  const drops = await until(
    () => released.drops,
    (items) => items.length === HELD_CHECK_RELEASES,
    t.signal,
  );
  assert.deepEqual(
    drops,
    released.materials.map((material) => material.credential_id),
  );
  assert.deepEqual(inboundRow(id), before);
});

test("injected repository connector skips the tool gate and probe", async (t) => {
  const health = new HealthRegistry();
  const repositoryConnector = {
    gitLsRemote: async () => {},
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
    "Idempotency-Key": createIdempotencyKey(),
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
      headers: { ...headers, "Idempotency-Key": createIdempotencyKey() },
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
      headers: { ...headers, "Idempotency-Key": createIdempotencyKey() },
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
        fallback_configurations: [],
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
    nodeChild(
      [
        "--input-type=module",
        "-e",
        `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
      ],
      { env: paths.env, signal: t.signal },
    );
  const data = join(paths.env.XDG_DATA_HOME!, "kanthord");
  chmodSync(data, 0o755);
  assert.match((await serve()).stderr, /mode 700/);
  chmodSync(data, 0o700);
  writeFileSync(paths.database, "", { mode: 0o600 });
  chmodSync(paths.database, 0o644);
  assert.match((await serve()).stderr, /mode 600/);
  chmodSync(paths.database, 0o600);
  const result = await serve();
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
  assert.deepEqual(readdirSync(data), ["kanthord.db", "tracking.db"]);
});

const MASTER_KEY_ROWS = 1;

test("serve refuses another master_key against an existing database and writes nothing", async (t) => {
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
  const serve = () =>
    nodeChild(
      [
        "--input-type=module",
        "-e",
        `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
      ],
      { env: paths.env, signal: t.signal },
    );
  const rows = () => {
    const store = new Store(paths.database);
    const snapshot = {
      keys: store.database.prepare("SELECT * FROM custody_master_key").all(),
      history: store.database.prepare("SELECT * FROM migration").all(),
    };
    store.close();
    return snapshot;
  };
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  assert.match((await serve()).stderr, /cannot bind/);
  const recorded = rows();
  assert.equal(recorded.keys.length, MASTER_KEY_ROWS);

  const foreign = {
    ...paths.config,
    master_key: Buffer.alloc(32, 7).toString("base64"),
  };
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(foreign), true);
  const refused = await serve();
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, /system\.config\.master_key_mismatch/);
  assert.match(refused.stderr, /restore the configuration file/);
  assert.doesNotMatch(refused.stderr, new RegExp(foreign.master_key));
  assert.deepEqual(rows(), recorded);

  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  assert.match((await serve()).stderr, /cannot bind/);
  assert.deepEqual(rows(), recorded);
});

const SCHEMA_MISMATCH = /system\.database\.migration\.schema_mismatch/;
const RESET_INSTRUCTION =
  /delete kanthord\.db, tracking\.db and their -wal and -shm files in the data directory, and start again/;

function withExtraText(migrations: Migrations, service: string): Migrations {
  return migrations.map((entry) =>
    entry.service === service
      ? {
          service,
          migrations: [
            (database) => {
              entry.migrations[0]!(database);
              database.exec(
                `CREATE TABLE ${service}_scratch_extra (value TEXT)`,
              );
            },
          ],
        }
      : entry,
  );
}

function createDatabase(path: string, migrations: Migrations): void {
  const store = new Store(path);
  store.migrate(migrations);
  store.close();
}

function serveOnce(env: NodeJS.ProcessEnv, signal: AbortSignal) {
  return nodeChild(
    [
      "--input-type=module",
      "-e",
      `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
    ],
    { env, signal },
  );
}

test("serve refuses a kanthord.db that another migration text created", async (t) => {
  const paths = layout(temporary(t));
  createDatabase(paths.database, withExtraText(serverMigrations, "mission"));
  const refused = await serveOnce(paths.env, t.signal);
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, SCHEMA_MISMATCH);
  assert.match(refused.stderr, /scratch_extra/);
  assert.match(refused.stderr, RESET_INSTRUCTION);
});

test("serve refuses a tracking.db that another migration text created", async (t) => {
  const paths = layout(temporary(t));
  createDatabase(paths.database, serverMigrations);
  createDatabase(
    join(dirname(paths.database), "tracking.db"),
    withExtraText(trackingDatabaseMigrations, "tracking"),
  );
  const refused = await serveOnce(paths.env, t.signal);
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, SCHEMA_MISMATCH);
  assert.match(refused.stderr, /tracking\.db/);
  assert.match(refused.stderr, RESET_INSTRUCTION);
});

test("serve refuses a stored hosted worker binding with no placement and names the binding", async (t) => {
  const paths = layout(temporary(t));
  createDatabase(paths.database, serverMigrations);
  const store = new Store(paths.database);
  store.transaction(({ database }) => {
    const projectId = createIdentity(PROJECT_ID_PREFIX);
    database
      .prepare(
        "INSERT INTO project_project (id, name, created_at) VALUES (?, ?, ?)",
      )
      .run(projectId, "planted", Date.now());
    database
      .prepare(
        "INSERT INTO project_binding (id, project_id, name, resource_identity, revision, config, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        createIdentity(BINDING_ID_PREFIX),
        projectId,
        "general",
        "worker:kanthord:general",
        1,
        JSON.stringify({ worker: "coder@1", instance_count: 1 }),
        Date.now(),
      );
  });
  store.close();
  const refused = await serveOnce(paths.env, t.signal);
  assert.equal(refused.status, ExitCode.Failure);
  assert.match(refused.stderr, /system\.database\.binding_placement_missing/);
  assert.match(refused.stderr, /general/);
  assert.match(refused.stderr, /docs\/reference\/upgrade\.md/);
  assert.match(refused.stderr, RESET_INSTRUCTION);
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
          if (record.msg.startsWith(GATEWAY_STARTED_MESSAGE))
            resolve(record.port);
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
      tracking: { store: 200 },
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

test("serve installs the pinned pi tools into the state directory before the gateway starts", async (t) => {
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
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.once("exit", () =>
      reject(new Error("server exited before readiness")),
    );
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
      if (stderr.includes(GATEWAY_STARTED_MESSAGE)) resolve();
    });
  });
  const exit = new Promise<number | null>((resolve) =>
    child.once("exit", resolve),
  );
  child.kill("SIGTERM");
  assert.equal(await exit, ExitCode.Success);
  const binDirectory = join(paths.env.XDG_STATE_HOME!, "kanthord", "pi", "bin");
  for (const tool of ["fd", "rg"])
    assert.equal(
      spawnSync(join(binDirectory, tool), ["--version"]).status,
      ExitCode.Success,
    );
});

test("serve refuses to start when the pi tool directory cannot be installed", async (t) => {
  const paths = layout(temporary(t));
  const piDirectory = join(paths.env.XDG_STATE_HOME!, "kanthord", "pi");
  mkdirSync(piDirectory, { mode: 0o700 });
  writeFileSync(join(piDirectory, "bin"), EMPTY_OUTPUT);
  const result = await nodeChild(
    [
      "--input-type=module",
      "-e",
      `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
    ],
    { env: paths.env, signal: t.signal },
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.match(result.stderr, /^worker\.start\.tool_missing:/m);
  assert.equal(result.stdout, EMPTY_OUTPUT);
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

test("server lifecycle returns errors, reports owned health and releases every resource even when cleanup fails", async (t) => {
  const paths = layout(temporary(t));
  paths.config.log.destination = "file";
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  const result = await nodeChild(
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
    assert.equal(await inactive.run(cancelled), cancelled.signal.reason);
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
    assert.equal(await running, context.signal.reason);
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
    assert.deepEqual(error.errors, [storeFailure, storeFailure, logFailure]);
    assert.equal(await joined, error);
    assert.deepEqual(await broken.healthcheck(), { gateway: 503, store: 503, log: 503 });
    assert.equal(output, '');
    write('verified\\n');
  `,
    ],
    { env: paths.env, signal: t.signal },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, LIFECYCLE_VERIFIED_OUTPUT);
  const reopened = new Store(paths.database);
  reopened.close();
});

test("server quiesces concurrently, drains Intake with direct calls available, joins the chain and releases Intake between Gateway and Project", async (t) => {
  const paths = layout(temporary(t));
  const result = await nodeChild(
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
    assert.deepEqual(shutdown.slice(drainEnd), ['stop-gateway', 'stop-intake', 'stop-project', 'stop-mission', 'stop-worker', 'stop-custody', 'stop-scheduler', 'store', 'store', 'log']);
  `,
    ],
    { env: paths.env, signal: t.signal },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
});

test("server starts the worker pool after the Gateway is ready and stops it before it quiesces", async (t) => {
  const paths = layout(temporary(t));
  paths.config.log.destination = "file";
  writePrivate(paths.env.KANTHORD_CONFIG!, stringify(paths.config), true);
  const result = await nodeChild(
    [
      "--input-type=module",
      "-e",
      `
    import assert from 'node:assert/strict';
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    import { SchedulerService } from ${JSON.stringify(new URL("../../scheduler/index.ts", import.meta.url).href)};
    import { WorkerService } from ${JSON.stringify(new URL("../../worker/index.ts", import.meta.url).href)};
    import { GatewayService } from ${JSON.stringify(new URL("../../gateway/index.ts", import.meta.url).href)};
    const events = [];
    const gatewayStart = GatewayService.prototype.start;
    GatewayService.prototype.start = async function() {
      const error = await gatewayStart.call(this);
      if (!events.includes('gateway-ready')) events.push('gateway-ready');
      return error;
    };
    const startPool = WorkerService.prototype.startPool;
    WorkerService.prototype.startPool = function() {
      events.push('startPool');
      return startPool.call(this);
    };
    const stopPool = WorkerService.prototype.stopPool;
    WorkerService.prototype.stopPool = async function() {
      events.push('stopPool');
      await stopPool.call(this);
      events.push('stopPool-done');
    };
    const quiesce = SchedulerService.prototype.quiesce;
    SchedulerService.prototype.quiesce = function() {
      if (!events.includes('quiesce')) events.push('quiesce');
      return quiesce.call(this);
    };
    const server = new Server();
    assert.equal(await server.start(), null);
    assert.deepEqual(events, ['gateway-ready', 'startPool']);
    assert.equal(await server.stop(), null);
    assert.deepEqual(events, ['gateway-ready', 'startPool', 'stopPool', 'stopPool-done', 'quiesce']);
    process.stdout.write('verified\\n');
  `,
    ],
    { env: paths.env, signal: t.signal },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, LIFECYCLE_VERIFIED_OUTPUT);
});

test("server startup failure releases Mission in reverse construction order and stop is idempotent", async (t) => {
  const paths = layout(temporary(t));
  const result = await nodeChild(
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
    { env: paths.env, signal: t.signal },
  );
  assert.equal(result.status, ExitCode.Success, result.stderr);
  assert.equal(result.stdout, LIFECYCLE_VERIFIED_OUTPUT);
});

test("the shutdown watchdog holds the event loop and exits the process when cleanup never settles", async (t) => {
  const started = Date.now();
  const result = await nodeChild(
    [
      "--input-type=module",
      "-e",
      `
    import { Server } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    Server.prototype.release = () => new Promise(() => {});
    await new Server().stop();
    `,
    ],
    { signal: t.signal },
  );
  assert.equal(result.status, ExitCode.Failure);
  assert.doesNotMatch(result.stderr, /unsettled top-level await/);
  assert.ok(Date.now() - started >= SHUTDOWN_DEADLINE_MS);
});

const CONTAINER_BINDING = "boxed";
const CONTAINER_IMAGE = "kanthord-test";
const STORED_BASE_IMAGE = "registry.example/base:1";
const CONTAINER_TEST_TIMEOUT_MS = 120000;
const NO_ITEMS = 0;
const Verb = { Build: "build", Image: "image", Inspect: "inspect" } as const;

async function containerSetup(
  t: TestContext,
  options: Parameters<typeof gatewayFixture>[1] = {},
) {
  const fake = fakeContainerHost(t);
  const setup = await workerAcceptance(t, true, {
    containerImage: CONTAINER_IMAGE,
    fixtureOptions: {
      containerRuntimeHost: fake.host,
      environmentDevcontainerCli: () => fake.cli,
      repositoryFiles: fakeRepositoryFiles(),
      ...options,
    },
  });
  const call = humanCaller(setup.fixture);
  const params = { project_id: setup.project_id };
  const writeContainer = async (
    instanceCount: number,
    environment?: { image: string },
  ) => {
    const current = await call(projectOperations["bindingSet.get"], {
      params,
      query: {},
      body: null,
    });
    const repository = current.bindings.repo;
    assert.ok(repository);
    return call(projectOperations["bindingSet.write"], {
      params,
      query: {},
      body: {
        version: current.version,
        bindings: {
          ...current.bindings,
          ...(environment === undefined
            ? {}
            : {
                repo: {
                  ...repository,
                  config: { ...repository.config, environment },
                },
              }),
          [CONTAINER_BINDING]: {
            kind: "worker",
            config: {
              worker: "coder@1",
              instance_count: instanceCount,
              placement: "container",
              entries: [{ agent: "swe@1", ...WORKER_DEFAULTS }],
            },
          },
        } as never,
      },
    });
  };
  return { fake, setup, writeContainer };
}

test(
  "the composed server takes a fake environment runtime, starts, and stops with no active run left",
  { timeout: CONTAINER_TEST_TIMEOUT_MS },
  async (t) => {
    const builds: AbortSignal[] = [];
    const environmentRuntime: EnvironmentRuntime = {
      runtimeName: "podman",
      imageId: async (reference) => `sha256:${reference}`,
      pullImage: async () => {},
      imageExists: async () => false,
      build: (_input, signal) => {
        builds.push(signal);
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      },
      prove: async () => [],
      proveOnHost: async () => [],
      tagProved: async () => {},
      removeTags: async () => {},
      collect: async () => {},
      removeStaleRuns: async () => {},
    };
    const { setup, writeContainer } = await containerSetup(t, {
      environmentRuntime,
    });
    await writeContainer(NO_ITEMS, { image: STORED_BASE_IMAGE });
    await until(
      () => builds.length,
      (count) => count > NO_ITEMS,
      t.signal,
    );
    const { project } = setup.fixture;
    assert.ok(
      project
        .environmentStates(setup.project_id)
        .some((state) => state.run_started_at !== null),
    );
    assert.equal(await project.stop(), null);
    assert.ok(builds.every((signal) => signal.aborted));
    assert.ok(
      project
        .environmentStates(setup.project_id)
        .every((state) => state.run_started_at === null),
    );
  },
);

test(
  "a binding-set write of a stored environment at the container placement builds the layer through the fake host",
  { timeout: CONTAINER_TEST_TIMEOUT_MS },
  async (t) => {
    const { fake, setup, writeContainer } = await containerSetup(t);
    await writeContainer(NO_ITEMS, { image: STORED_BASE_IMAGE });
    const builds = await until(
      () => fake.commands().filter((command) => command[0] === Verb.Build),
      (found) => found.length > NO_ITEMS,
      t.signal,
    );
    const command = builds[NO_ITEMS]!;
    const staging = command[command.indexOf("--tag") + 1]!;
    assert.match(staging, /-unchecked$/);
    const base = fake.calls
      .filter((call) => call[0] === Verb.Image && call[1] === Verb.Inspect)
      .map((call) => call.at(-1)!)
      .find((reference) => reference.endsWith("-base"));
    assert.ok(base);
    assert.equal(fake.containerfile(staging).split("\n")[1], `FROM ${base}`);
    await until(
      () => setup.fixture.project.environmentStates(setup.project_id),
      (states) => states.every((state) => state.run_started_at === null),
      t.signal,
    );
  },
);

test(
  "the container slot wrapper records the start of a slot and the image of the real driver",
  { timeout: CONTAINER_TEST_TIMEOUT_MS },
  async (t) => {
    const starts: string[] = [];
    const images: string[] = [];
    const wrap = (driver: SlotDriver): SlotDriver => ({
      placement: driver.placement,
      check: () => driver.check(),
      prepare: () => driver.prepare(),
      removeVolume: (clientId) => driver.removeVolume(clientId),
      sweepVolumes: (live) => driver.sweepVolumes(live),
      launch: (launch) => {
        assert.ok(driver instanceof ContainerDriver);
        starts.push(launch.slot.client_id);
        void driver
          .runtime()
          .then((runtime) => driver.imageFor(runtime, launch.slot))
          .then((image) => images.push(image));
        return new FakeSlotInstance();
      },
    });
    const { setup, writeContainer } = await containerSetup(t, {
      containerSlotDriver: wrap,
    });
    setup.fixture.worker.startPool();
    await writeContainer(1);
    await until(
      () => images.length,
      (count) => count > NO_ITEMS,
      t.signal,
    );
    assert.ok(starts.length > NO_ITEMS);
    assert.equal(images[NO_ITEMS], `${CONTAINER_IMAGE}:${packageVersion()}`);
  },
);
