import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test, type TestContext } from "node:test";
import { stringify } from "yaml";
import { z } from "zod";
import { configuration } from "../../config/index.ts";
import type { CredentialAnswer } from "../../custody/contract.ts";
import {
  gatewayOperations,
  OWNER_PROJECT,
  RESOURCE_CHECK_DEADLINE_MS,
} from "../../gateway/contract.ts";
import { GATEWAY_STARTED_MESSAGE } from "../../gateway/index.ts";
import { errorSchema } from "../../kernel/errors.ts";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  writePrivate,
} from "../../kernel/files.ts";
import {
  HealthScope,
  ResourceStatus,
  type ResourceCheck,
  type ResourceEntry,
} from "../../kernel/health.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  type Mission,
  type NodeChange,
  NodeKind,
} from "../../mission/contract.ts";
import { BindingKind, projectOperations } from "../../project/contract.ts";
import type { Job } from "../../scheduler/contract.ts";
import type { AgentEnablement } from "../../agent/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { FAKE_SSH_IDENTITY, gatewayFixture } from "./test-support.ts";

const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const NO_OUTPUT = "";
const INITIAL_STRING = "";
const UNSET_PORT = 0;
const NO_HEALTH_CHECKS = 0;
const FIRST_REVISION = 1;
const SINGLE_HEALTH_CHECK = 1;
const DOUBLE_TIMEOUT = 2;
const SECOND_REVISION = 2;
const MODE_MASK = 0o777;
const STARTUP_TIMEOUT_MS = 10000;
const SHUTDOWN_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const LATE_CHECK_DELAY_MS = RESOURCE_CHECK_DEADLINE_MS + 5000;
const ANTHROPIC = "anthropic";
const GITHUB = "github";
const OPENAI_COMPATIBLE = "openai-compatible";
const CREDENTIAL = "anthro-1";
const COMPAT_CREDENTIAL = "compat-1";
const PROJECT_NAME = "my-project";
const CREDENTIAL_PREFIX = "credential_";
const PROJECT_PREFIX = "project_";
const MISSION_PREFIX = "mission_";
const AGENT = "swe@1";
const ENABLED = "enabled";
const SONNET = "claude-sonnet-4-5";
const GPT = "gpt-4o";
const BASE_URL = "https://api.openai.com/v1";
const DEFAULT_PROVIDER = "default";
const REASONING_OFF = "off";
const SECRET_FIELD = "secret";
const SECRET_VALUE = "e2e-gateway-secret-never-print";
const IDEMPOTENCY_KEY = "idempotency_key";
const ENABLEMENT_COMMAND = ["agent", "enablement"];
const MODEL_IN_USE = "llm.metadata.model_in_use";
const LIVENESS_UNHEALTHY = "gateway.liveness.unhealthy";
const UNAUTHORIZED = "gateway.authentication.unauthorized";
const INVENTORY_FAILED = "gateway.healthcheck.inventory_failed";
const FIXTURE_SERVICE_NAMES = [
  "gateway",
  "custody",
  "scheduler",
  "worker",
  "repository",
  "project",
  "mission",
];
const SERVER_SERVICE_NAMES = ["server", ...FIXTURE_SERVICE_NAMES];
const EMPTY_OWNER = { global: {}, projects: {} };
const FIRST_RESOURCE = "credential-first";
const SECOND_RESOURCE = "credential-second";
const RESOURCE_TARGET = "credential:e2e-target";
const CAPABILITY = "model-inference";
const FAKE_REPOSITORY = {
  gitLsRemote: async () => {},
  resolveSshIdentity: async () => FAKE_SSH_IDENTITY,
};

type Result = Awaited<ReturnType<typeof kanthord>>;
type Fixture = { directory: string; env: NodeJS.ProcessEnv };
type Project = z.infer<typeof projectOperations.get.output>;
type Applied = z.infer<
  (typeof projectOperations)["bindingSet.write"]["output"]
>;

async function setup(t: TestContext): Promise<Fixture> {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
  });
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  assert.ok(env.KANTHORD_ENDPOINT);
  assert.ok(env.KANTHORD_TOKEN);
  return { directory, env };
}

function file(directory: string, name: string, value: unknown): string {
  assert.ok(directory.startsWith("/"));
  assert.ok(name.endsWith(".json"));
  const path = join(directory, name);
  writePrivate(path, JSON.stringify(value));
  assert.equal(statSync(path).mode & MODE_MASK, PRIVATE_FILE_MODE);
  return path;
}

function success<T>(result: Result): T {
  assert.equal(result.code, EXIT_SUCCESS, result.stderr);
  assert.equal(result.stderr, NO_OUTPUT);
  assert.ok(!result.stdout.includes(SECRET_VALUE), "stdout leaked the secret");
  return JSON.parse(result.stdout, (key, value: unknown) => {
    assert.notEqual(key, SECRET_FIELD, "JSON contains a secret field");
    assert.notEqual(value, SECRET_VALUE, "JSON contains the secret value");
    return key === IDEMPOTENCY_KEY ? undefined : value;
  }) as T;
}

function refusal(result: Result, code: string): void {
  assert.equal(result.code, EXIT_FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, NO_OUTPUT);
}

async function createCredential(
  fixture: Fixture,
  name = CREDENTIAL,
  platform = ANTHROPIC,
  metadata: Record<string, unknown> | null = null,
): Promise<CredentialAnswer> {
  const path = file(fixture.directory, `${name}.json`, {
    name,
    platform,
    metadata,
    secret: { key: SECRET_VALUE },
  });
  const answer = success<CredentialAnswer>(
    await kanthord(
      [
        platform === GITHUB ? "repository" : "llm",
        "credential",
        "create",
        "--file",
        path,
      ],
      fixture.env,
    ),
  );
  assert.equal(answer.name, name);
  assert.equal(answer.platform, platform);
  return answer;
}

function enablementFile(
  fixture: Fixture,
  credential = CREDENTIAL,
  provider = ANTHROPIC,
  modelIdentifier = SONNET,
): string {
  assert.ok(credential);
  assert.ok(modelIdentifier);
  return file(fixture.directory, "enablement.json", {
    agent_providers: [{ name: DEFAULT_PROVIDER, provider, credential }],
    default_configuration: {
      agent_provider: DEFAULT_PROVIDER,
      model_identifier: modelIdentifier,
      reasoning_effort: REASONING_OFF,
    },
  });
}

async function createProject(fixture: Fixture): Promise<Project> {
  const project = success<Project>(
    await kanthord(["project", "create", "--name", PROJECT_NAME], fixture.env),
  );
  assert.ok(project.id.startsWith(PROJECT_PREFIX));
  assert.equal(project.bindingSetVersion, FIRST_REVISION);
  return project;
}

function serveEnvironment(directory: string): NodeJS.ProcessEnv {
  const env = {
    ...environment(directory),
    KANTHORD_CONFIG: join(directory, "kanthord.yaml"),
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
  };
  for (const path of [
    env.XDG_CONFIG_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
  ])
    mkdirSync(join(path, "kanthord"), {
      mode: PRIVATE_DIRECTORY_MODE,
      recursive: true,
    });
  const config = configuration({
    master_key: randomBytes(32).toString("base64"),
    gateway: { port: 0, allowed_hosts: ["localhost"] },
  }).getProperties();
  writePrivate(env.KANTHORD_CONFIG, stringify(config));
  assert.equal(config.gateway.port, UNSET_PORT);
  assert.notEqual(env.XDG_DATA_HOME, env.XDG_STATE_HOME);
  return env;
}

async function stopServe(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const killTimer = setTimeout(
      () => child.kill("SIGKILL"),
      SHUTDOWN_TIMEOUT_MS,
    );
    const deadline = setTimeout(() => {
      reject(new Error("serve did not exit after SIGTERM and SIGKILL"));
    }, SHUTDOWN_TIMEOUT_MS * DOUBLE_TIMEOUT);
    child.once("close", () => {
      clearTimeout(killTimer);
      clearTimeout(deadline);
      resolve();
    });
    child.kill("SIGTERM");
  });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(child.stdout.destroyed);
}

async function servePort(
  child: ChildProcessWithoutNullStreams,
): Promise<number> {
  const lines = createInterface({ input: child.stderr });
  let diagnostics = INITIAL_STRING;
  let timer: NodeJS.Timeout | undefined;
  let onExit: () => void;
  let onError: (error: Error) => void;
  try {
    return await new Promise<number>((resolve, reject) => {
      onError = reject;
      onExit = () =>
        reject(new Error(`serve exited before readiness: ${diagnostics}`));
      child.once("error", onError);
      child.once("exit", onExit);
      timer = setTimeout(
        () => reject(new Error(`serve startup timed out: ${diagnostics}`)),
        STARTUP_TIMEOUT_MS,
      );
      lines.on("line", (line) => {
        diagnostics += `${line}\n`;
        if (!line.startsWith("{")) return;
        try {
          const record = JSON.parse(line);
          if (record.msg !== GATEWAY_STARTED_MESSAGE) return;
          assert.ok(Number.isSafeInteger(record.port));
          assert.ok(record.port > UNSET_PORT);
          resolve(record.port);
        } catch (error) {
          reject(error);
        }
      });
    });
  } finally {
    clearTimeout(timer);
    lines.close();
    child.removeListener("exit", onExit!);
    child.removeListener("error", onError!);
    child.stderr.resume();
  }
}

function serveLiveness(
  port: number,
): Promise<{ status: number; body: string }> {
  assert.ok(Number.isSafeInteger(port));
  assert.ok(port > UNSET_PORT);
  return new Promise((resolve, reject) => {
    const call = request(
      `http://127.0.0.1:${port}${gatewayOperations.liveness.path}`,
      { headers: { Host: "localhost" } },
      (response) => {
        let body = INITIAL_STRING;
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
    call.setTimeout(REQUEST_TIMEOUT_MS, () =>
      call.destroy(new Error("liveness request timed out")),
    );
    call.once("error", reject);
    call.end();
  });
}

function resource(name: string, check: ResourceCheck): ResourceEntry {
  assert.ok(name);
  assert.equal(encodeURIComponent(name), name);
  return {
    scope: HealthScope.Global,
    project: null,
    name,
    target: RESOURCE_TARGET,
    capability: CAPABILITY,
    check,
  };
}

test("E07.1 credential create and get return the same secret-free record", async (t) => {
  const fixture = await setup(t);
  const created = await createCredential(fixture);
  assert.ok(created.revisions[0]);
  assert.ok(created.revisions[0].id.startsWith(CREDENTIAL_PREFIX));
  assert.equal(created.revisions[0].revision, FIRST_REVISION);
  assert.equal(created.revisions[0].ended_at, null);
  const read = success<CredentialAnswer>(
    await kanthord(["llm", "credential", "get", CREDENTIAL], fixture.env),
  );
  assert.deepEqual(read, { ...created, agent_providers: [] });
});

test("E07.2 anthropic credential enables swe@1 at revision one", async (t) => {
  const fixture = await setup(t);
  await createCredential(fixture);
  const path = enablementFile(fixture);
  const put = success<AgentEnablement>(
    await kanthord(
      [...ENABLEMENT_COMMAND, "put", AGENT, "--file", path],
      fixture.env,
    ),
  );
  assert.equal(put.state, ENABLED);
  assert.equal(put.revision, FIRST_REVISION);
  const read = success<AgentEnablement>(
    await kanthord([...ENABLEMENT_COMMAND, "get", AGENT], fixture.env),
  );
  assert.deepEqual(read, put);
});

test("E07.3 project creation also creates its mission", async (t) => {
  const fixture = await setup(t);
  const project = await createProject(fixture);
  const mission = success<Mission>(
    await kanthord(["mission", "get", project.id], fixture.env),
  );
  assert.ok(mission.id.startsWith(MISSION_PREFIX));
  assert.equal(mission.projectId, project.id);
});

test("E07.4 github repository binding advances the binding set to version two", async (t) => {
  const fixture = await setup(t);
  const project = await createProject(fixture);
  await createCredential(fixture, GITHUB, GITHUB);
  const sshPath = file(fixture.directory, "github-ssh.json", {
    name: "github-ssh",
    platform: "ssh",
    metadata: {
      host: "github.com",
      hostname: "github.com",
      port: 22,
      identity_file: "~/.ssh/id_rsa",
    },
    secret: {},
  });
  success<CredentialAnswer>(
    await kanthord(
      ["repository", "credential", "create", "--file", sshPath],
      fixture.env,
    ),
  );
  const path = file(fixture.directory, "bindings.json", {
    version: project.bindingSetVersion,
    bindings: {
      repo: {
        kind: BindingKind.Repository,
        config: {
          available: true,
          platform: GITHUB,
          address: "git@github.com:owner/repo.git",
          sshCredential: "github-ssh",
          strategy: { baseBranch: "main" },
          credential: GITHUB,
        },
      },
    },
  });
  const applied = success<Applied>(
    await kanthord(
      ["project", "binding", "apply", project.id, "--file", path],
      fixture.env,
    ),
  );
  assert.equal(applied.bindingSetVersion, SECOND_REVISION);
  assert.equal(applied.projectId, project.id);
  const read = success<Project>(
    await kanthord(["project", "get", project.id], fixture.env),
  );
  assert.equal(read.bindingSetVersion, SECOND_REVISION);
});

test("E07.5 mission initiative creation queues the created node", async (t) => {
  const fixture = await setup(t);
  const project = await createProject(fixture);
  const mission = success<Mission>(
    await kanthord(["mission", "get", project.id], fixture.env),
  );
  const path = file(fixture.directory, "node.json", {
    kind: NodeKind.Initiative,
    filename: "initiative.md",
    content: {
      name: "Plan",
      requirement: "Do the work",
      criterion: "Work is done",
      verifications: ["Check result"],
      bindings: [],
    },
    reason: "planning edit",
    expectedMissionVersion: FIRST_REVISION,
  });
  const created = success<NodeChange>(
    await kanthord(
      ["mission", "node", "create", mission.id, "--file", path],
      fixture.env,
    ),
  );
  assert.ok(created.revisions[0]);
  const peek = success<{ job: Job | null }>(
    await kanthord(["scheduler", "queue", "peek", project.id], fixture.env),
  );
  assert.ok(peek.job);
  assert.equal(peek.job.nodeId, created.revisions[0].nodeId);
});

test("E07.6 custody refuses removing a model used by an enablement", async (t) => {
  const fixture = await setup(t);
  await createCredential(fixture, COMPAT_CREDENTIAL, OPENAI_COMPATIBLE, {
    base_url: BASE_URL,
    models: [],
  });
  const add = file(fixture.directory, "add-model.json", {
    expected_revision: FIRST_REVISION,
    metadata: { base_url: BASE_URL, models: [{ id: GPT }] },
  });
  const updated = success<CredentialAnswer>(
    await kanthord(
      [
        "llm",
        "credential",
        "update-metadata",
        COMPAT_CREDENTIAL,
        "--file",
        add,
      ],
      fixture.env,
    ),
  );
  const path = enablementFile(
    fixture,
    COMPAT_CREDENTIAL,
    OPENAI_COMPATIBLE,
    GPT,
  );
  const put = success<AgentEnablement>(
    await kanthord(
      [...ENABLEMENT_COMMAND, "put", AGENT, "--file", path],
      fixture.env,
    ),
  );
  assert.equal(put.default_configuration.model_identifier, GPT);
  const remove = file(fixture.directory, "remove-model.json", {
    expected_revision: SECOND_REVISION,
    metadata: { base_url: BASE_URL, models: [] },
  });
  refusal(
    await kanthord(
      [
        "llm",
        "credential",
        "update-metadata",
        COMPAT_CREDENTIAL,
        "--file",
        remove,
      ],
      fixture.env,
    ),
    MODEL_IN_USE,
  );
  const read = success<CredentialAnswer>(
    await kanthord(
      ["llm", "credential", "get", COMPAT_CREDENTIAL],
      fixture.env,
    ),
  );
  assert.deepEqual(read.revisions[0], updated.revisions[0]);
  assert.ok(read.revisions[1]);
  assert.notEqual(read.revisions[1].ended_at, null);
  assert.deepEqual(read, {
    ...updated,
    revisions: updated.revisions.map((revision, index) => ({
      ...revision,
      ended_at: read.revisions[index]!.ended_at,
    })),
    agent_providers: [{ agent: AGENT, name: DEFAULT_PROVIDER }],
  });
});

test("E07.7 real serve liveness exposes all eight maps (requires local git and ssh)", async (t) => {
  const env = serveEnvironment(temporary(t));
  const entry = new URL("../../main.ts", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.argv=[process.execPath,'kanthord','serve'];await import(${JSON.stringify(entry)});`,
    ],
    { env, stdio: "pipe" },
  );
  t.after(() => stopServe(child));
  child.stdout.resume();
  const response = await serveLiveness(await servePort(child));
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.liveness.output.parse(
    JSON.parse(response.body),
  );
  assert.deepEqual(
    Object.keys(body.services).sort(),
    [...SERVER_SERVICE_NAMES].sort(),
  );
  for (const name of SERVER_SERVICE_NAMES) {
    const checks = body.services[name];
    assert.ok(checks);
    assert.ok(Object.keys(checks).length > NO_HEALTH_CHECKS, name);
  }
});

test("E07.8 stopped scheduler returns the complete unhealthy liveness map", async (t) => {
  const fixture = await gatewayFixture(t);
  const before = await fixture.request(gatewayOperations.liveness.path);
  assert.equal(before.status, HttpStatus.OK);
  const healthy = gatewayOperations.liveness.output.parse(await before.json());
  assert.equal(await fixture.scheduler.stop(), null);
  const response = await fixture.request(gatewayOperations.liveness.path);
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  const { error } = errorSchema.parse(await response.json());
  assert.equal(error.code, LIVENESS_UNHEALTHY);
  const details = gatewayOperations.liveness.output.shape.services.parse(
    error.details,
  );
  assert.equal(details.scheduler?.queue, HttpStatus.ServiceUnavailable);
  assert.deepEqual(
    Object.keys(details).sort(),
    [...FIXTURE_SERVICE_NAMES].sort(),
  );
  assert.deepEqual(details, {
    ...healthy.services,
    scheduler: {
      ...healthy.services.scheduler,
      queue: HttpStatus.ServiceUnavailable,
    },
  });
});

test("E07.9 human healthcheck returns exactly four empty owners", async (t) => {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body, {
    services: {
      project: EMPTY_OWNER,
      intake: EMPTY_OWNER,
      worker: EMPTY_OWNER,
    },
    shared: {
      llm: EMPTY_OWNER,
      repository: EMPTY_OWNER,
      storage: EMPTY_OWNER,
      agent: EMPTY_OWNER,
    },
  });
});

test("E07.10 healthcheck refuses an unauthenticated request", async (t) => {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path);
  assert.equal(response.status, HttpStatus.Unauthorized);
  const { error } = errorSchema.parse(await response.json());
  assert.equal(error.code, UNAUTHORIZED);
});

test("E07.11 healthcheck deduplicates targets but reports both resource names", async (t) => {
  let checks = NO_HEALTH_CHECKS;
  const check: ResourceCheck = async () => {
    checks += SINGLE_HEALTH_CHECK;
    return ResourceStatus.Healthy;
  };
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
    inventoryOverrides: {
      llm: () => [
        resource(FIRST_RESOURCE, check),
        resource(SECOND_RESOURCE, check),
      ],
    },
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.equal(checks, SINGLE_HEALTH_CHECK);
  const expected = { status: ResourceStatus.Healthy, capability: CAPABILITY };
  assert.deepEqual(body.shared.llm.global, {
    [FIRST_RESOURCE]: expected,
    [SECOND_RESOURCE]: expected,
  });
});

test("E07.12 a failed project inventory refuses the healthcheck report", async (t) => {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
    inventoryOverrides: {
      project: () => {
        throw new Error("project inventory unavailable");
      },
    },
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.ServiceUnavailable);
  const { error } = errorSchema.parse(await response.json());
  assert.equal(error.code, INVENTORY_FAILED);
  const details = z
    .object({ missing_inventories: z.array(z.string()) })
    .parse(error.details);
  assert.ok(details.missing_inventories.includes(OWNER_PROJECT));
});

test("E07.13 a resource check past its deadline reports unknown", async (t) => {
  let timer: NodeJS.Timeout | undefined;
  t.after(() => clearTimeout(timer));
  const check: ResourceCheck = () =>
    new Promise((resolve) => {
      timer = setTimeout(
        () => resolve(ResourceStatus.Healthy),
        LATE_CHECK_DELAY_MS,
      );
      timer.unref();
    });
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
    inventoryOverrides: { llm: () => [resource(FIRST_RESOURCE, check)] },
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body.shared.llm.global[FIRST_RESOURCE], {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY,
  });
});

test("E07.14 a throwing resource check reports unknown", async (t) => {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: FAKE_REPOSITORY,
    inventoryOverrides: {
      llm: () => [
        resource(FIRST_RESOURCE, () => {
          throw new Error("resource probe failed");
        }),
      ],
    },
  });
  const response = await fixture.request(gatewayOperations.healthcheck.path, {
    headers: { Authorization: `Bearer ${fixture.token}` },
  });
  assert.equal(response.status, HttpStatus.OK);
  const body = gatewayOperations.healthcheck.output.parse(
    await response.json(),
  );
  assert.deepEqual(body.shared.llm.global[FIRST_RESOURCE], {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY,
  });
});
