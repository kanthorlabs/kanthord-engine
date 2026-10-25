import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { IdentityKind, type ServiceIdentity } from "../kernel/caller.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { temporary } from "../kernel/test-support.ts";
import { repositoryMigrations } from "../repository/index.ts";
import {
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  bindingSetWriteInputSchema,
  projectOperations,
  repositoryConfigSchema,
} from "./contract.ts";
import {
  DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS,
  DEFAULT_ENVIRONMENT_MEMORY_MB,
} from "./config.ts";
import {
  PROBE_ALLOWLIST,
  environmentAgentTools,
  parseProbeCommand,
  writeStoredEnvironment,
  type EnvironmentAgentPort,
} from "./environment-agent-tools.ts";
import { ProjectEnvironments } from "./environment.ts";
import type {
  ProbeAnswer,
  ProbeCommand,
} from "./environment-probe-contract.ts";
import { projectMigrations } from "./migrations.ts";
import { ProjectService } from "./service.ts";
import {
  inertEnvironmentAgent,
  inertEnvironmentProbe,
  inertEnvironmentRuntime,
} from "./test-support.ts";
import {
  insertProject,
  readCurrentBindingSet,
  requireProject,
  writeBindingSet,
} from "./store.ts";

const SERVICE_IDENTITY: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: "environment-agent",
};
const PROJECT_IDENTITY: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: PROJECT_SERVICE_NAME,
};
const REPOSITORY_NAME = "repository";
const STORAGE_NAME = "evidence";
const ADDRESS = "git@github.com:owner/repo.git";
const VALID_ENVIRONMENT = {
  image: "mcr.microsoft.com/devcontainers/python:3.12",
};
const BUMP_PREFIX = "bumped";
const NO_CALLS = 0;
const ONE_CALL = 1;
const REQUEST_ID = /^env_agent_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const REFUSAL = "Refused: the command is not in the allowlist.";
const COMMAND_TEXT_LENGTH = 300;
const PROBE_TOOL = "probe";
const WRITE_TOOL = "environment_write";

const ACCEPTED: ReadonlyArray<readonly [string, string[]]> = [
  ["cat /etc/os-release", ["cat", "/etc/os-release"]],
  ["uname -a", ["uname", "-a"]],
  ["command -v node", ["sh", "-c", 'command -v "$1"', "sh", "node"]],
  ["pnpm --version", ["pnpm", "--version"]],
  ["ls /usr/local/bin", ["ls", "/usr/local/bin"]],
  ["dpkg -l", ["dpkg", "-l"]],
  ["apk info", ["apk", "info"]],
];
const REFUSED = [
  "cat /etc/passwd",
  "uname",
  "command -v node; rm -rf /",
  "node --version --eval x",
  "$(id) --version",
  "ls -la /",
  "ls /tmp/a b",
  "curl --version https://x",
  "",
  "a".repeat(COMMAND_TEXT_LENGTH),
  "ls /usr/../etc",
  "ls  /usr",
];

test("parseProbeCommand answers the argv of each allowed form", () => {
  for (const [text, argv] of ACCEPTED)
    assert.deepEqual(parseProbeCommand(text), { argv }, text);
  assert.deepEqual(parseProbeCommand("  uname -a \n"), {
    argv: ["uname", "-a"],
  });
  assert.equal(PROBE_ALLOWLIST.length, ACCEPTED.length);
});

test("parseProbeCommand answers null for each other text", () => {
  for (const text of REFUSED) assert.equal(parseProbeCommand(text), null, text);
});

function fakePort() {
  const probes: ProbeCommand[] = [];
  const writes: unknown[] = [];
  const answer: ProbeAnswer = {
    image: "image:tag",
    exit_code: 0,
    output: "node",
  };
  const port: EnvironmentAgentPort = {
    probe: (command) => {
      probes.push(command);
      return Promise.resolve(answer);
    },
    write: (environment) => {
      writes.push(environment);
      return Promise.resolve({ outcome: "built" });
    },
  };
  return { port, probes, writes, answer };
}

function toolNamed(port: EnvironmentAgentPort, name: string) {
  const tool = environmentAgentTools(port).find((entry) => entry.name === name);
  assert.ok(tool);
  return tool;
}

function textOf(result: { content: ReadonlyArray<unknown> }): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  assert.ok(first);
  return first.text;
}

test("the probe tool calls the port with the parsed command", async () => {
  const { port, probes, answer } = fakePort();
  const tool = toolNamed(port, PROBE_TOOL);
  const result = await tool.execute(
    "call",
    { command: "uname -a" },
    new AbortController().signal,
    undefined,
    undefined as never,
  );
  assert.deepEqual(probes, [{ argv: ["uname", "-a"] }]);
  assert.equal(textOf(result), canonicalJSON(answer));
});

test("the probe tool refuses a command outside the allowlist and does not call the port", async () => {
  const { port, probes } = fakePort();
  const tool = toolNamed(port, PROBE_TOOL);
  const result = await tool.execute(
    "call",
    { command: "cat /etc/passwd" },
    new AbortController().signal,
    undefined,
    undefined as never,
  );
  assert.equal(textOf(result), [REFUSAL, ...PROBE_ALLOWLIST].join("\n"));
  assert.equal(probes.length, NO_CALLS);
});

test("the environment_write tool calls the port with the object", async () => {
  const { port, writes } = fakePort();
  const tool = toolNamed(port, WRITE_TOOL);
  const result = await tool.execute(
    "call",
    { environment: VALID_ENVIRONMENT },
    new AbortController().signal,
    undefined,
    undefined as never,
  );
  assert.deepEqual(writes, [VALID_ENVIRONMENT]);
  assert.equal(textOf(result), canonicalJSON({ outcome: "built" }));
});

function submission(storagePrefix: string) {
  return new Map(
    Object.entries(
      bindingSetWriteInputSchema.shape.bindings.parse({
        [REPOSITORY_NAME]: {
          kind: BindingKind.Repository,
          config: {
            available: true,
            platform: "github",
            address: ADDRESS,
            strategy: { base_branch: "main" },
            ssh_credential: "ssh-github.com",
            credential: "github-key",
          },
        },
        [STORAGE_NAME]: {
          kind: BindingKind.Storage,
          config: {
            available: true,
            endpoint: "https://s3.example.com",
            bucket: "evidence",
            region: "eu-central-1",
            prefix: storagePrefix,
            credential: "s3-key",
          },
        },
      }),
    ),
  );
}

function storeFixture(t: TestContext, beforeWrite: () => void = () => {}) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
    { service: "repository", migrations: repositoryMigrations },
  ]);
  const unexpected = (): never => {
    throw new Error("Unexpected peer collaboration call.");
  };
  const service = new ProjectService({
    config: {
      environment_build_timeout_ms: DEFAULT_ENVIRONMENT_BUILD_TIMEOUT_MS,
      environment_memory_mb: DEFAULT_ENVIRONMENT_MEMORY_MB,
    },
    operationalStore: store,
    stateDirectory: temporary(t),
    createMission: unexpected,
    liveNodesPinning: unexpected,
    liveNodePins: () => [],
    unmatchedClaims: () => [],
    validateEntry: unexpected,
    custodySuitability: () => {},
    repositoryConnector: { gitLsRemote: () => Promise.resolve() },
    repositoryFiles: {
      resolveBranchCommit: unexpected,
      readFilesAtCommit: unexpected,
      listFilesAtCommit: async () => [],
      readObjectIds: unexpected,
      cloneSnapshot: unexpected,
    },
    verifyRepositoryCredential: unexpected,
    identity: PROJECT_IDENTITY,
    custody: {
      authorizeOperation: () => ({}),
      grantFacts: () => ({ facts: { address: ADDRESS } }),
      release: () => ({}),
    } as never,
    credentialRecords: {} as never,
    sshAccessOf: () => ({}) as never,
    workerAgentsOf: unexpected,
    workerAgentView: unexpected,
    placementStatus: unexpected,
    instanceOf: unexpected,
    endRegistrations: () => {},
    bindingsChanged: () => {},
    wakeup: { wake: () => {} },
    environmentRuntime: inertEnvironmentRuntime(),
    environmentAgent: inertEnvironmentAgent(),
    environmentProbe: inertEnvironmentProbe(),
    telemetry: { span: () => undefined },
    slotImage: "kanthord:test",
    version: "0.0.0",
    environmentReady: async () => {},
  });
  t.after(() => service.stop());
  const registry = new OperationRegistry();
  service.declare(registry);
  const callers: CallerContext[] = [];
  const environments = new ProjectEnvironments({
    store,
    repositoryFiles: {
      resolveBranchCommit: unexpected,
      readFilesAtCommit: unexpected,
      listFilesAtCommit: async () => [],
      readObjectIds: unexpected,
      cloneSnapshot: unexpected,
    },
    identity: PROJECT_IDENTITY,
    targetOf: unexpected,
    sshAccess: unexpected,
    writeBindings: async (projectId, body, caller) => {
      callers.push(caller);
      beforeWrite();
      const operation = projectOperations["bindingSet.write"];
      const input = operation.input.parse({
        params: { project_id: projectId },
        query: {},
        body,
      });
      return operation.output.parse(
        await registry.get(operation.id).handler(input, caller),
      );
    },
  });
  const saved = store.transaction((tx) => {
    const project = insertProject(tx, "alpha");
    writeBindingSet(
      tx,
      project.id,
      project.binding_set_version,
      submission(""),
    );
    const binding = readCurrentBindingSet(tx, project.id).get(REPOSITORY_NAME);
    assert.ok(binding);
    return { project_id: project.id, binding_id: binding.id };
  });
  function bump(): void {
    store.transaction((tx) => {
      const version = requireProject(tx, saved.project_id).binding_set_version;
      writeBindingSet(tx, saved.project_id, version, submission(BUMP_PREFIX));
    });
  }
  function write(environment: unknown) {
    return writeStoredEnvironment({
      environments,
      store,
      identity: SERVICE_IDENTITY,
      ...saved,
      environment,
      context: background,
    });
  }
  function current() {
    return store.transaction((tx) => ({
      version: requireProject(tx, saved.project_id).binding_set_version,
      bindings: readCurrentBindingSet(tx, saved.project_id),
    }));
  }
  return { store, saved, write, current, callers, bump };
}

test("writeStoredEnvironment refuses an invalid document and keeps the binding set version", async (t) => {
  const f = storeFixture(t);
  const before = f.current();
  const answer = await f.write({ image: 1 });
  assert.equal(answer.written, false);
  assert.ok(!answer.written && answer.reason.startsWith("invalid environment"));
  assert.equal(f.current().version, before.version);
  assert.equal(f.callers.length, NO_CALLS);
});

test("writeStoredEnvironment stores a valid document in a new binding revision", async (t) => {
  const f = storeFixture(t);
  const before = f.current();
  assert.deepEqual(await f.write(VALID_ENVIRONMENT), { written: true });
  const after = f.current();
  assert.equal(
    Number(after.version),
    Number(before.version) + BINDING_SET_INITIAL_VERSION,
  );
  const repository = after.bindings.get(REPOSITORY_NAME);
  assert.ok(repository);
  assert.notEqual(repository.id, f.saved.binding_id);
  assert.deepEqual(
    repositoryConfigSchema.parse(repository.config).environment,
    VALID_ENVIRONMENT,
  );
  const storage = after.bindings.get(STORAGE_NAME);
  assert.deepEqual(storage, before.bindings.get(STORAGE_NAME));
});

test("writeStoredEnvironment passes a caller of the service identity", async (t) => {
  const f = storeFixture(t);
  await f.write(VALID_ENVIRONMENT);
  assert.equal(f.callers.length, ONE_CALL);
  const [caller] = f.callers;
  assert.deepEqual(caller?.identity, SERVICE_IDENTITY);
  assert.match(caller?.requestId ?? "", REQUEST_ID);
});

test("writeStoredEnvironment answers the code of a binding set version conflict", async (t) => {
  const holder: { bump: () => void } = { bump: () => {} };
  const f = storeFixture(t, () => holder.bump());
  holder.bump = f.bump;
  const answer = await f.write(VALID_ENVIRONMENT);
  assert.equal(answer.written, false);
  assert.ok(
    !answer.written &&
      answer.reason.startsWith(ProjectErrorCode.VersionConflict),
  );
});
