import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import type { z } from "zod";
import type { CredentialAnswer } from "../../custody/contract.ts";
import { writePrivate } from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  BINDING_ID_PREFIX,
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  bindingSetWriteInputSchema,
  ChangeKind,
  PROJECT_ID_PREFIX,
  projectOperations,
  REPOSITORY_PLATFORM,
} from "../../project/contract.ts";
import {
  type AgentEnablement,
  WorkerErrorCode,
} from "../../worker/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const BINDING_LIFECYCLE_TIMEOUT_MS = 60000;
const PROJECT_LIFECYCLE_TIMEOUT_MS = 60000;
const UNIX_EPOCH = 0;
const EMPTY = "";
const ROOT = "/";
const JSON_SUFFIX = ".json";
const ONE = 1;
const TWO = 2;
const THREE = 3;
const NAME = "my-proj";
const RENAMED = "my-proj-2";
const INVALID_NAME = "INVALID_NAME";
const INVALID_NAME_CODE = "cli.project.create.invalid_name";
const FILE_NOT_FOUND = "cli.file.not_found";
const ANTHROPIC = "anthropic";
const CREDENTIAL = "anthro-1";
const SECRET = { key: "e2e-project-secret" };
const AGENT = "swe@1";
const WORKER = "general@1";
const DEFAULT = "default";
const BACKUP = "backup";
const SONNET = "claude-sonnet-4-5";
const SONNET_MAX = "claude-sonnet-4-6";
const MAX = "max";
const OFF = "off";
const ENABLED = "enabled";
const REPOSITORY_NAME = "repo";
const WORKER_NAME = "general";
const ADDRESS = "git@github.com:owner/repo.git";
const RESOURCE_IDENTITY = `${BindingKind.Repository}:${REPOSITORY_PLATFORM}:owner/repo`;
const BASE_BRANCH = "main";
const ENABLEMENT_COMMAND = ["worker", "agent", "enablement"];
const CONFIGURATION = {
  agentProvider: DEFAULT,
  modelIdentifier: SONNET,
  reasoningEffort: OFF,
};
const PROVIDERS = [
  { name: DEFAULT, provider: ANTHROPIC, credential: CREDENTIAL },
];
const REPOSITORY: BindingSet["bindings"][string] = {
  kind: BindingKind.Repository,
  config: {
    available: true,
    platform: REPOSITORY_PLATFORM,
    address: ADDRESS,
    strategy: { baseBranch: BASE_BRANCH },
    credential: REPOSITORY_PLATFORM,
  },
};
const WORKER_BINDING = {
  kind: BindingKind.Worker,
  config: {
    worker: WORKER,
    instanceCount: ONE,
    entries: [{ agent: AGENT, ...CONFIGURATION }],
  },
};

test("binding apply refuses action-end-state follows through CLI validation", async (t) => {
  const f = await setup(t);
  const path = join(f.directory, "follows.json");
  const repository = {
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: ADDRESS,
      credential: "github",
      strategy: {
        baseBranch: BASE_BRANCH,
        action: {
          name: "pull_request",
          follows: { type: "action_end_state", binding: "repo" },
        },
      },
    },
  };
  writePrivate(
    path,
    JSON.stringify({ version: ONE, bindings: { repo: repository } }),
  );
  const result = await kanthord(
    [
      "project",
      "binding",
      "apply",
      "project_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--file",
      path,
    ],
    f.env,
  );
  assert.equal(result.code, FAILURE);
  assert.ok(
    result.stderr.startsWith("cli.file.schema_invalid:"),
    result.stderr,
  );
  assert.ok(
    result.stderr.includes(
      '"path":["bindings","repo","config","strategy","action","follows","binding"]',
    ),
    result.stderr,
  );
  assert.equal(result.stdout, EMPTY);
});

type Result = Awaited<ReturnType<typeof kanthord>>;
type Fixture = { directory: string; env: NodeJS.ProcessEnv };
type Project = z.infer<typeof projectOperations.get.output>;
type Binding = z.infer<(typeof projectOperations)["binding.get"]["output"]>;
type Agent = z.infer<
  (typeof projectOperations)["agentConfiguration.get"]["output"]
>;
type BindingSet = z.infer<typeof bindingSetWriteInputSchema>;
type Applied = z.infer<
  (typeof projectOperations)["bindingSet.write"]["output"]
> & { idempotencyKey: string };
type Mutation = Project & { idempotencyKey: string };
type Page<T> = { items: T[]; nextCursor: string | null };

async function setup(t: TestContext): Promise<Fixture> {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshHostname: async () => "github.com",
    },
  });
  const directory = temporary(t);
  const env = {
    ...environment(directory),
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  assert.ok(env.KANTHORD_ENDPOINT);
  assert.ok(env.KANTHORD_TOKEN);
  return { directory, env };
}

function file(directory: string, name: string, value: unknown): string {
  assert.ok(directory.startsWith(ROOT));
  assert.ok(name.endsWith(JSON_SUFFIX));
  const path = join(directory, name);
  writePrivate(path, JSON.stringify(value));
  return path;
}

function success<T>(result: Result): T {
  assert.equal(result.code, SUCCESS, result.stderr);
  assert.equal(result.stderr, EMPTY);
  return JSON.parse(result.stdout) as T;
}

function refusal(result: Result, code: string): void {
  assert.equal(result.code, FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, EMPTY);
}

async function createCredential(
  fixture: Fixture,
  name = CREDENTIAL,
  platform = ANTHROPIC,
): Promise<void> {
  const path = file(fixture.directory, `${platform}-cred.json`, {
    name,
    platform,
    metadata: null,
    secret: SECRET,
  });
  const answer = success<CredentialAnswer>(
    await kanthord(
      [
        platform === REPOSITORY_PLATFORM ? "repository" : "llm",
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
}

async function createProject(
  fixture: Fixture,
  key = ulid(),
): Promise<Mutation> {
  const answer = success<Mutation>(
    await kanthord(
      ["project", "create", "--name", NAME, "--idempotency-key", key],
      fixture.env,
    ),
  );
  assert.ok(answer.id.startsWith(`${PROJECT_ID_PREFIX}_`));
  assert.equal(answer.bindingSetVersion, BINDING_SET_INITIAL_VERSION);
  assert.equal(answer.idempotencyKey, key);
  return answer;
}

async function apply(
  fixture: Fixture,
  projectId: string,
  body: BindingSet,
  key = ulid(),
): Promise<Applied> {
  const path = file(fixture.directory, `v${body.version}.json`, body);
  const answer = success<Applied>(
    await kanthord(
      [
        "project",
        "binding",
        "apply",
        projectId,
        "--file",
        path,
        "--idempotency-key",
        key,
      ],
      fixture.env,
    ),
  );
  assert.equal(answer.projectId, projectId);
  assert.equal(answer.idempotencyKey, key);
  return answer;
}

async function bindRepository(
  fixture: Fixture,
  projectId: string,
  key = ulid(),
): Promise<Applied> {
  await createCredential(fixture, REPOSITORY_PLATFORM, REPOSITORY_PLATFORM);
  const answer = await apply(
    fixture,
    projectId,
    {
      version: BINDING_SET_INITIAL_VERSION,
      bindings: { [REPOSITORY_NAME]: REPOSITORY },
    },
    key,
  );
  assert.equal(answer.bindingSetVersion, TWO);
  assert.equal(answer.changes[0]?.kind, ChangeKind.Created);
  return answer;
}

async function enableAgent(
  fixture: Fixture,
  defaultConfiguration = CONFIGURATION,
): Promise<AgentEnablement> {
  await createCredential(fixture);
  const path = file(fixture.directory, "enablement.json", {
    agentProviders: PROVIDERS,
    defaultConfiguration,
  });
  const answer = success<AgentEnablement>(
    await kanthord(
      [...ENABLEMENT_COMMAND, "put", AGENT, "--file", path],
      fixture.env,
    ),
  );
  assert.equal(answer.revision, ONE);
  assert.equal(answer.state, ENABLED);
  return answer;
}

async function boundAgent(fixture: Fixture) {
  const project = await createProject(fixture);
  const enablement = await enableAgent(fixture);
  const applied = await apply(fixture, project.id, {
    version: project.bindingSetVersion,
    bindings: { [WORKER_NAME]: WORKER_BINDING },
  });
  const binding = applied.bindings[WORKER_NAME];
  assert.ok(binding);
  assert.equal(applied.bindingSetVersion, TWO);
  return { project, enablement, binding };
}

async function readAgent(
  fixture: Fixture,
  projectId: string,
  bindingId: string,
): Promise<Agent> {
  const answer = success<Agent>(
    await kanthord(
      ["project", "agent", "get", projectId, bindingId, AGENT],
      fixture.env,
    ),
  );
  assert.equal(answer.agent, AGENT);
  assert.equal(answer.worker, WORKER);
  assert.equal(answer.workerBindingId, bindingId);
  assert.equal(answer.valid, true);
  assert.deepEqual(answer.issues, []);
  return answer;
}

async function repositoryReads(
  fixture: Fixture,
  projectId: string,
  bindingId: string,
) {
  const listed = success<Page<Binding>>(
    await kanthord(["project", "binding", "list", projectId], fixture.env),
  );
  assert.equal(listed.items.length, ONE);
  assert.equal(listed.items[0]?.kind, BindingKind.Repository);
  assert.equal(listed.nextCursor, null);
  const read = success<Binding>(
    await kanthord(
      ["project", "binding", "get", projectId, bindingId],
      fixture.env,
    ),
  );
  assert.equal(read.id, bindingId);
  assert.equal(read.projectId, projectId);
  assert.equal(read.name, REPOSITORY_NAME);
  assert.equal(read.kind, BindingKind.Repository);
  assert.equal(read.resourceIdentity, RESOURCE_IDENTITY);
  assert.equal(read.revision, ONE);
  assert.ok(
    Number.isSafeInteger(read.createdAt) && read.createdAt > UNIX_EPOCH,
  );
  assert.equal(read.removedAt, null);
  assert.deepEqual(listed.items, [read]);
  const exported = bindingSetWriteInputSchema.parse(
    success<unknown>(
      await kanthord(["project", "binding", "export", projectId], fixture.env),
    ),
  );
  assert.equal(exported.version, TWO);
  assert.deepEqual(Object.keys(exported.bindings), [REPOSITORY_NAME]);
  assert.deepEqual(exported.bindings[REPOSITORY_NAME], REPOSITORY);
  const revisions = success<Page<Binding>>(
    await kanthord(
      ["project", "binding", "revision", "list", projectId, bindingId],
      fixture.env,
    ),
  );
  assert.equal(revisions.items.length, ONE);
  assert.deepEqual(revisions.items, [read]);
  assert.equal(revisions.nextCursor, null);
}

test(
  "E05.1-E05.5 create, replay, list, get and rename a project",
  { timeout: PROJECT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    await createCredential(fixture);
    const key = ulid();
    const created = await createProject(fixture, key);
    const replayed = await createProject(fixture, key);
    assert.equal(replayed.id, created.id);
    assert.deepEqual(replayed, created);
    const listed = success<Page<Project>>(
      await kanthord(["project", "list"], fixture.env),
    );
    assert.equal(listed.items.length, ONE);
    assert.equal(listed.items[0]?.name, NAME);
    assert.equal(
      listed.items[0]?.bindingSetVersion,
      BINDING_SET_INITIAL_VERSION,
    );
    assert.equal(listed.nextCursor, null);
    const read = success<Project>(
      await kanthord(["project", "get", created.id], fixture.env),
    );
    assert.equal(read.id, created.id);
    assert.equal(read.name, NAME);
    assert.equal(read.bindingSetVersion, BINDING_SET_INITIAL_VERSION);
    assert.equal(read.createdAt, created.createdAt);
    assert.ok(
      Number.isSafeInteger(read.createdAt) && read.createdAt > UNIX_EPOCH,
    );
    const renamed = success<Mutation>(
      await kanthord(
        ["project", "rename", created.id, "--name", RENAMED],
        fixture.env,
      ),
    );
    assert.equal(renamed.name, RENAMED);
    assert.ok(renamed.idempotencyKey);
    const reread = success<Project>(
      await kanthord(["project", "get", created.id], fixture.env),
    );
    assert.equal(reread.name, RENAMED);
    assert.equal(reread.id, created.id);
  },
);

test(
  "E05.6-E05.11 apply, replay, list, get, export and list repository revisions",
  { timeout: BINDING_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    const project = await createProject(fixture);
    const key = ulid();
    const applied = await bindRepository(fixture, project.id, key);
    const replayed = success<Applied>(
      await kanthord(
        [
          "project",
          "binding",
          "apply",
          project.id,
          "--file",
          join(fixture.directory, `v${BINDING_SET_INITIAL_VERSION}.json`),
          "--idempotency-key",
          key,
        ],
        fixture.env,
      ),
    );
    assert.equal(replayed.bindingSetVersion, TWO);
    assert.deepEqual(replayed, applied);
    const binding = applied.bindings[REPOSITORY_NAME];
    assert.ok(binding);
    assert.ok(binding.id.startsWith(`${BINDING_ID_PREFIX}_`));
    await repositoryReads(fixture, project.id, binding.id);
  },
);

test(
  "E05.12-E05.13 add a worker binding and list and get its agent",
  { timeout: BINDING_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    const project = await createProject(fixture);
    await bindRepository(fixture, project.id);
    await enableAgent(fixture);
    const applied = await apply(fixture, project.id, {
      version: TWO,
      bindings: {
        [REPOSITORY_NAME]: REPOSITORY,
        [WORKER_NAME]: WORKER_BINDING,
      },
    });
    assert.equal(applied.bindingSetVersion, THREE);
    const binding = applied.bindings[WORKER_NAME];
    assert.ok(binding);
    const listed = success<Page<Agent>>(
      await kanthord(
        ["project", "agent", "list", project.id, binding.id],
        fixture.env,
      ),
    );
    assert.equal(listed.items.length, ONE);
    assert.equal(listed.items[0]?.agent, AGENT);
    assert.equal(listed.items[0]?.valid, true);
    assert.equal(listed.nextCursor, null);
    const read = await readAgent(fixture, project.id, binding.id);
    assert.equal(read.bindingSetVersion, THREE);
    assert.deepEqual(listed.items, [read]);
  },
);

test("E05.14 invalid project name is refused", async (t) => {
  const fixture = await setup(t);
  refusal(
    await kanthord(["project", "create", "--name", INVALID_NAME], fixture.env),
    INVALID_NAME_CODE,
  );
});

test("E05.15 binding apply refuses a nonexistent absolute file", async (t) => {
  const fixture = await setup(t);
  const project = await createProject(fixture);
  refusal(
    await kanthord(
      [
        "project",
        "binding",
        "apply",
        project.id,
        "--file",
        join(fixture.directory, "nonexistent.json"),
      ],
      fixture.env,
    ),
    FILE_NOT_FOUND,
  );
});

test("E05.16 tuning entry without an enablement is refused", async (t) => {
  const fixture = await setup(t);
  const project = await createProject(fixture);
  const path = file(fixture.directory, "w.json", {
    version: BINDING_SET_INITIAL_VERSION,
    bindings: {
      [WORKER_NAME]: {
        kind: BindingKind.Worker,
        config: {
          worker: WORKER,
          instanceCount: ONE,
          entries: [{ agent: AGENT, modelIdentifier: SONNET }],
        },
      },
    },
  });
  refusal(
    await kanthord(
      ["project", "binding", "apply", project.id, "--file", path],
      fixture.env,
    ),
    WorkerErrorCode.Unavailable,
  );
  const exported = bindingSetWriteInputSchema.parse(
    success<unknown>(
      await kanthord(["project", "binding", "export", project.id], fixture.env),
    ),
  );
  assert.equal(exported.version, BINDING_SET_INITIAL_VERSION);
  assert.deepEqual(exported.bindings, {});
});

test("E05.17 removing an enablement used by a binding is refused", async (t) => {
  const fixture = await setup(t);
  const { project, binding, enablement } = await boundAgent(fixture);
  refusal(
    await kanthord(
      [
        ...ENABLEMENT_COMMAND,
        "remove",
        AGENT,
        "--expected-revision",
        String(ONE),
      ],
      fixture.env,
    ),
    WorkerErrorCode.InUse,
  );
  const read = success<AgentEnablement>(
    await kanthord([...ENABLEMENT_COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(read.revision, enablement.revision);
  assert.deepEqual(read.agentProviders, enablement.agentProviders);
  await readAgent(fixture, project.id, binding.id);
});

test("E05.18 replacing a referenced provider is refused atomically", async (t) => {
  const fixture = await setup(t);
  const { project, binding, enablement } = await boundAgent(fixture);
  const path = file(fixture.directory, "invalidating.json", {
    expectedRevision: enablement.revision,
    agentProviders: [
      { name: BACKUP, provider: ANTHROPIC, credential: CREDENTIAL },
    ],
    defaultConfiguration: { ...CONFIGURATION, agentProvider: BACKUP },
  });
  refusal(
    await kanthord(
      [...ENABLEMENT_COMMAND, "put", AGENT, "--file", path],
      fixture.env,
    ),
    WorkerErrorCode.ProviderInUse,
  );
  const read = success<AgentEnablement>(
    await kanthord([...ENABLEMENT_COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(read.revision, enablement.revision);
  assert.deepEqual(read.agentProviders, enablement.agentProviders);
  assert.deepEqual(read.defaultConfiguration, CONFIGURATION);
  assert.equal(read.state, ENABLED);
  const agent = await readAgent(fixture, project.id, binding.id);
  assert.equal(agent.bindingSetVersion, TWO);
  assert.deepEqual(agent.entry, CONFIGURATION);
});

test("E05.19 changing defaults that invalidate a tuning entry is refused atomically", async (t) => {
  const fixture = await setup(t);
  const project = await createProject(fixture);
  const defaults = { ...CONFIGURATION, modelIdentifier: SONNET_MAX };
  const enablement = await enableAgent(fixture, defaults);
  const entry = { reasoningEffort: MAX };
  const applied = await apply(fixture, project.id, {
    version: project.bindingSetVersion,
    bindings: {
      [WORKER_NAME]: {
        kind: BindingKind.Worker,
        config: {
          worker: WORKER,
          instanceCount: ONE,
          entries: [{ agent: AGENT, ...entry }],
        },
      },
    },
  });
  const binding = applied.bindings[WORKER_NAME];
  assert.ok(binding);
  assert.equal(applied.bindingSetVersion, TWO);
  const before = await readAgent(fixture, project.id, binding.id);
  assert.deepEqual(before.entry, entry);
  const path = file(fixture.directory, "invalidating.json", {
    expectedRevision: enablement.revision,
    agentProviders: PROVIDERS,
    defaultConfiguration: CONFIGURATION,
  });
  refusal(
    await kanthord(
      [...ENABLEMENT_COMMAND, "put", AGENT, "--file", path],
      fixture.env,
    ),
    WorkerErrorCode.InvalidatesBindings,
  );
  const read = success<AgentEnablement>(
    await kanthord([...ENABLEMENT_COMMAND, "get", AGENT], fixture.env),
  );
  assert.equal(read.revision, enablement.revision);
  assert.deepEqual(read.agentProviders, enablement.agentProviders);
  assert.deepEqual(read.defaultConfiguration, defaults);
  assert.equal(read.defaultConfiguration.modelIdentifier, SONNET_MAX);
  const after = await readAgent(fixture, project.id, binding.id);
  assert.deepEqual(after.entry, entry);
  assert.deepEqual(after, before);
});
