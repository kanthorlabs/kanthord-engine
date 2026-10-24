import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { detectEnvironment } from "./detection.ts";
import { ProjectService, type Dependencies } from "./service.ts";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
} from "../kernel/context.ts";
import {
  HealthRegistry,
  HealthScope,
  ResourceFailureReason,
  ResourceStatus,
} from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  AccessPolicy,
  OperationRegistry,
  type CallerContext,
} from "../kernel/operation.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { AgentErrorCode, type HolderScope } from "../agent/contract.ts";
import { SERVER_HOLDER } from "../custody/contract.ts";
import {
  InvalidReason,
  PROMPT_SOURCE_MAX_BYTES,
} from "../agent/prompt-source.ts";
import {
  BINDING_ID_PREFIX,
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  BindingState,
  ChangeKind,
  BINDING_CHECK_TIMEOUT_MS,
  EnvironmentSource,
  FollowsType,
  GitHubAction,
  Landing,
  InstructionFileState,
  INSTANCE_COUNT_MIN,
  INSTANCE_COUNT_MAX,
  LS_REMOTE_TIMEOUT_MS,
  PROJECT_PROMPT_MAX_BYTES,
  REPOSITORY_PLATFORM,
  SSH_CREDENTIAL_PLATFORM,
  RepositoryPlatform,
  repositoryConfigSchema,
  RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  RESOURCE_TARGET_KIND_REPOSITORY,
  STORAGE_PLATFORM,
  StablePlacementIssue,
  WorkerField,
  WorkerPlacement,
  bindingSetWriteInputSchema,
  type BindingCheckEntry,
  type WorkerEntry,
  PROJECT_ID_PREFIX,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  projectOperations,
} from "./contract.ts";
import {
  HostKeyErrorCode,
  RepositoryErrorCode,
  RepositoryFileState,
} from "../repository/contract.ts";
import { TAG_MAX_BYTES } from "../kernel/tag.ts";
import { PlacementIssue } from "../worker/contract.ts";
import { projectMigrations } from "./migrations.ts";
import { EnvironmentErrorCode } from "./environment.ts";
import { inertEnvironmentRuntime } from "./test-support.ts";
import { Onboarding } from "./onboarding.ts";
import {
  EnvironmentFailureClass,
  EnvironmentStatus,
  environmentStateSchema,
  type EnvironmentRuntime,
} from "./environment-state.ts";
import {
  DEVCONTAINER_FILE,
  EnvironmentRefusalReason,
} from "../kernel/devcontainer.ts";
import {
  GrantKind,
  SshIdentitySubjectKind,
  type Grant,
  type GrantFacts,
  type Material,
  type SshIdentitySubject,
} from "../custody/contract.ts";
import type { CallerIdentity, ServiceIdentity } from "../kernel/caller.ts";
import {
  RepositoryComponent,
  repositoryMigrations,
} from "../repository/index.ts";
import { generateSshKey } from "../repository/ssh-key.ts";
import { gitLsRemote } from "../repository/connector.ts";
import {
  createBareRepository,
  DEFAULT_SSH_PORT,
  startTestSshd,
} from "../repository/test-sshd.ts";
import type { SshAccess } from "../repository/index.ts";
import {
  insertProject,
  readBindingRevision,
  readCurrentBindingSet,
  requireProject,
  writeBindingSet,
} from "./store.ts";

const ACCOUNT = "alice";
const DISPLAY_NAME = "Alice";
const PROJECT_NAME = "alpha";
const OTHER_NAME = "beta";
const PROJECTS_CREATED = 2;
const RENAMED_NAME = "renamed";
const FIRST_PAGE_LIMIT = 1;
const SINGLE_INSTANCE = 1;
const NO_INSTANCES = 0;
const NO_BINDING_CHANGES = 0;
const TWO_INSTANCES = 2;
const NO_CALLS = 0;
const SLOT_IMAGE = "registry/kanthord:1.0.0";
const ENVIRONMENT_VERSION = "1.0.0";
const ONE_CALL = 1;
const NO_ITEMS = 0;
const WORKER_GROUP = "worker:kanthord:worker";
const NO_GENERATION = 0;
const MISSING_GROUP = "worker:kanthord:absent";
const GROUP_ISSUED_AT = 1000;
const TOMBSTONE_AT = 2000;
const GROUP_WORKER_NAME = "developer";
const GROUP_BINDING_NAME = "worker";
const EMPTY_QUERY = {};
const CORE_OPERATIONS = [
  "project.create",
  "project.list",
  "project.get",
  "project.rename",
  "project.pause",
  "project.resume",
  "project.bindingSet.write",
  "project.bindingSet.get",
  "project.binding.list",
  "project.binding.get",
  "project.bindingRevision.list",
  "project.agentConfiguration.list",
  "project.agentConfiguration.get",
  "project.binding.verify",
  "project.binding.instruction_files.get",
  "project.binding.environment.get",
  "project.binding.environment.set",
  "project.binding.environment.rebuild",
  "project.environment.list",
  "project.binding.check",
  "project.credential.platform_list",
  "project.credential.create",
  "project.credential.list",
  "project.credential.get",
  "project.credential.rotate",
  "project.credential.update_metadata",
  "project.credential.revoke",
  "project.credential.archive",
  "project.credential.verify",
  "project.credential.check",
];
const CURSOR_ENCODING = "base64url";
type OperationKey = Exclude<
  keyof typeof projectOperations,
  | "bindingSet.write"
  | "binding.check"
  | "binding.environment.set"
  | "binding.environment.rebuild"
>;
type AsyncOperationKey =
  | "binding.verify"
  | "binding.instruction_files.get"
  | "binding.environment.get"
  | "binding.environment.rebuild";

function unexpected(): never {
  throw new Error("Unexpected peer collaboration call.");
}

delete process.env.SSH_AUTH_SOCK;
delete process.env.SSH_AGENT_PID;

const SSH_KEY = generateSshKey("project");
const PINNED_HOSTS = ["github.com", "gitlab.com"];
const HOST_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
const PROJECT_IDENTITY: ServiceIdentity = {
  kind: IdentityKind.Service,
  service: PROJECT_SERVICE_NAME,
};
const HOST_KEY_UNPINNED = HostKeyErrorCode.Unpinned;
const SSH_KEY_LEGACY = RepositoryErrorCode.SshKeyLegacy;

type Release = {
  identity: CallerIdentity;
  subject: SshIdentitySubject;
  credential: string;
  address: string;
  transaction: boolean;
};

function pinHosts(store: Store, hosts: readonly string[]): void {
  for (const host of hosts)
    store.database
      .prepare(
        "INSERT INTO repository_host_key (id, host, public_key, created_at) VALUES (?, ?, ?, 1)",
      )
      .run(createIdentity("host_key"), host, HOST_KEY);
}

function fakeCustody(
  store: Store,
  dependencies: () => Dependencies,
  secrets: Map<string, unknown>,
) {
  const releases: Release[] = [];
  const dropped: string[] = [];
  const grantAddress: { value?: string } = {};
  const requests = new WeakMap<
    object,
    { identity: CallerIdentity; subject: SshIdentitySubject }
  >();
  const authorized = (tx: Transaction, subject: SshIdentitySubject) => {
    if (subject.kind === SshIdentitySubjectKind.Draft) {
      dependencies().custodySuitability(tx, {
        credential: subject.credential,
        platform: SSH_CREDENTIAL_PLATFORM,
      });
      return {
        credential: subject.credential,
        project_id: subject.project_id,
        facts: { binding_id: null, address: subject.address },
      };
    }
    assert.equal(subject.kind, SshIdentitySubjectKind.Binding);
    const binding = readBindingRevision(tx, subject.binding_id);
    assert.ok(binding);
    const config = repositoryConfigSchema.parse(binding.config);
    return {
      credential: config.ssh_credential,
      project_id: binding.project_id,
      facts: { binding_id: binding.id, address: config.address },
    };
  };
  const custody: Dependencies["custody"] = {
    authorizeOperation: (tx, request) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(request.kind, GrantKind.SshIdentity);
      assert.equal(request.claim, null);
      const granted = authorized(tx, request.subject);
      const address = grantAddress.value ?? granted.facts.address;
      const grant = Object.freeze({
        kind: GrantKind.SshIdentity,
        platform: SSH_CREDENTIAL_PLATFORM,
        execution: null,
        ...granted,
        facts: { ...granted.facts, address },
      });
      requests.set(grant, {
        identity: request.identity,
        subject: request.subject,
      });
      return grant as never;
    },
    grantFacts: <G extends Grant>(grant: G): GrantFacts<G> => ({
      project_id: grant.project_id,
      credential: grant.credential,
      facts: grant.facts,
    }),
    release: (tx, grant): Material => {
      assert.ok(tx.database.isTransaction);
      assert.ok(grant.credential !== null);
      assert.equal(grant.kind, GrantKind.SshIdentity);
      const request = requests.get(grant);
      assert.ok(request);
      const name = grant.credential;
      releases.push({
        ...request,
        credential: name,
        address: grant.facts.address,
        transaction: store.database.isTransaction,
      });
      return {
        credential_id: createIdentity("credential"),
        platform: SSH_CREDENTIAL_PLATFORM,
        value: () =>
          secrets.has(name)
            ? secrets.get(name)
            : { private_key: SSH_KEY.private_key },
        drop: () => void dropped.push(name),
      };
    },
  };
  return { custody, releases, dropped, grantAddress };
}

function fixture(t: TestContext, overrides: Partial<Dependencies> = {}) {
  const store = new Store(IN_MEMORY_DATABASE);
  store.migrate([
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
    { service: "repository", migrations: repositoryMigrations },
  ]);
  pinHosts(store, PINNED_HOSTS);
  const secrets = new Map<string, unknown>();
  const repository = new RepositoryComponent({ checkTools: () => {} });
  const health = new HealthRegistry();
  const stateDirectory = temporary(t);
  const wakes: string[] = [];
  const registrationEnds: Array<{
    project_id: string;
    resource_identity: string;
    now: number;
  }> = [];
  const bindingChanges: string[] = [];
  const held: { dependencies?: Dependencies } = {};
  const ssh = fakeCustody(
    store,
    () => {
      assert.ok(held.dependencies);
      return held.dependencies;
    },
    secrets,
  );
  const dependencies: Dependencies = {
    config: {},
    operationalStore: store,
    stateDirectory,
    health,
    wakeup: {
      wake: (projectId) => {
        assert.equal(store.database.isTransaction, false);
        wakes.push(projectId);
      },
    },
    createMission: unexpected,
    liveNodesPinning: unexpected,
    unmatchedClaims: () => [],
    validateEntry: unexpected,
    custodySuitability: unexpected,
    repositoryConnector: { gitLsRemote: unexpected },
    repositoryFiles: {
      resolveBranchCommit: unexpected,
      readFilesAtCommit: unexpected,
      listFilesAtCommit: async () => [],
      readObjectIds: unexpected,
      cloneSnapshot: unexpected,
    },
    verifyRepositoryCredential: unexpected,
    identity: PROJECT_IDENTITY,
    custody: ssh.custody,
    credentialRecords: {} as never,
    sshAccessOf: (tx, granted, material) =>
      repository.sshAccessOf(tx, granted, material),
    workerAgentsOf: unexpected,
    workerAgentView: unexpected,
    placementStatus: unexpected,
    instanceOf: unexpected,
    endRegistrations: (tx, projectId, resourceIdentity, now) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(tx.database, store.database);
      registrationEnds.push({
        project_id: projectId,
        resource_identity: resourceIdentity,
        now,
      });
    },
    bindingsChanged: (projectId) => {
      assert.equal(store.database.isTransaction, false);
      bindingChanges.push(projectId);
    },
    environmentRuntime: inertEnvironmentRuntime(),
    slotImage: SLOT_IMAGE,
    version: ENVIRONMENT_VERSION,
    environmentReady: async () => {},
    ...overrides,
  };
  held.dependencies = dependencies;
  const project = new ProjectService(dependencies);
  t.after(() => project.stop());
  t.after(() => store.close());
  const registry = new OperationRegistry();
  project.declare(registry);
  let commits = NO_CALLS;
  const caller: CallerContext = {
    identity: testHumanIdentity(ACCOUNT, DISPLAY_NAME, "jti"),
    context: background,
    requestId: "request",
    commit: (fn) => {
      commits++;
      return store.transaction(fn);
    },
  };
  function invoke<K extends OperationKey>(
    key: K,
    body: unknown = null,
    params: Record<string, string> = {},
    query: Record<string, unknown> = EMPTY_QUERY,
  ): (typeof projectOperations)[K]["output"]["_output"] {
    const operation = projectOperations[key];
    const input = operation.input.parse({ params, query, body });
    return operation.output.parse(
      registry.get(operation.id).handler(input, caller),
    ) as (typeof projectOperations)[K]["output"]["_output"];
  }
  async function invokeAsync<K extends AsyncOperationKey>(
    key: K,
    params: Record<string, string> = {},
  ): Promise<(typeof projectOperations)[K]["output"]["_output"]> {
    const operation = projectOperations[key];
    const input = operation.input.parse({ params, query: {}, body: null });
    const result = await registry.get(operation.id).handler(input, caller);
    return operation.output.parse(
      result,
    ) as (typeof projectOperations)[K]["output"]["_output"];
  }
  return {
    store,
    project,
    stateDirectory,
    health,
    registry,
    caller,
    invoke,
    invokeAsync,
    commits: () => commits,
    registrationEnds,
    bindingChanges,
    wakes,
    secrets,
    releases: ssh.releases,
    dropped: ssh.dropped,
    grantAddress: ssh.grantAddress,
  };
}

function refuses(
  fn: () => unknown,
  status: number,
  code: string,
  details: OperationError["details"] = null,
) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}

function allowMission(
  tx: Parameters<Dependencies["createMission"]>[0],
  id: string,
) {
  assert.ok(tx.database.isTransaction);
  assert.ok(
    tx.database.prepare("SELECT id FROM project_project WHERE id = ?").get(id),
  );
}

test("Project declares every operation and owns its lifecycle probe", async (t) => {
  const { project, registry, health } = fixture(t);
  assert.deepEqual(
    registry
      .all()
      .map(({ operation }) => operation.id)
      .sort(),
    [...CORE_OPERATIONS].sort(),
  );
  assert.equal(
    await project.resolveWorkerGroup(
      "absent",
      "worker:kanthord:absent",
      0,
      background,
    ),
    null,
  );
  assert.deepEqual(await project.healthcheck(), {
    bindings: HealthStatus.Unavailable,
  });
  assert.deepEqual(await health.check(), {
    project: { bindings: HealthStatus.Unavailable },
  });
  const starting = project.start();
  assert.equal(starting, project.start());
  assert.equal(await starting, null);
  assert.deepEqual(await project.healthcheck(), {
    bindings: HealthStatus.Healthy,
  });
  assert.deepEqual(await health.check(), {
    project: { bindings: HealthStatus.Healthy },
  });
  const stopping = project.stop();
  assert.equal(stopping, project.stop());
  assert.equal(await stopping, null);
  assert.deepEqual(await project.healthcheck(), {
    bindings: HealthStatus.Unavailable,
  });
  assert.ok((await project.start()) instanceof Error);
});

test("Project propagates cancellation to binding resolution and joins run", async (t) => {
  for (const before of [true, false]) {
    const { project } = fixture(t);
    const context = new CancellationContext();
    if (before) context.cancel();
    const running = project.run(context);
    if (!before) context.cancel();
    assert.equal(await running, context.signal.reason);
    await assert.rejects(
      project.resolveWorkerGroup(
        "absent",
        "worker:kanthord:absent",
        0,
        context,
      ),
      (error) => error === context.signal.reason,
    );
    assert.equal(await project.stop(), null);
  }
});

test("create persists a project and creates its mission inside the caller commit with the verified actor", (t) => {
  let missionCalls = NO_CALLS;
  const f = fixture(t, {
    createMission: (tx, id, actor) => {
      missionCalls++;
      assert.equal(f.commits(), ONE_CALL);
      assert.equal(tx.database, f.store.database);
      allowMission(tx, id);
      assert.deepEqual(actor, {
        kind: IdentityKind.Human,
        account: ACCOUNT,
        name: DISPLAY_NAME,
      });
    },
  });
  const before = Date.now();
  const record = f.invoke("create", { name: PROJECT_NAME });
  assert.ok(identitySchema(PROJECT_ID_PREFIX).safeParse(record.id).success);
  assert.equal(record.name, PROJECT_NAME);
  assert.equal(record.binding_set_version, BINDING_SET_INITIAL_VERSION);
  assert.ok(record.created_at >= before && record.created_at <= Date.now());
  assert.equal(missionCalls, ONE_CALL);
  assert.deepEqual(f.invoke("get", null, { project_id: record.id }), record);
  assert.deepEqual(f.invoke("list").items, [record]);
});

test("create, get and list answer the workspace directory and create answers after it exists", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const record = f.invoke("create", { name: PROJECT_NAME });
  assert.equal(
    record.workspace_directory,
    join(f.stateDirectory, "projects", record.id),
  );
  assert.ok(isAbsolute(record.workspace_directory));
  assert.ok(statSync(record.workspace_directory).isDirectory());
  f.invoke("create", { name: OTHER_NAME });
  assert.equal(
    f.invoke("get", null, { project_id: record.id }).workspace_directory,
    record.workspace_directory,
  );
  const listed = f.invoke("list").items;
  assert.equal(listed.length, PROJECTS_CREATED);
  for (const item of listed)
    assert.equal(
      item.workspace_directory,
      join(f.stateDirectory, "projects", item.id),
    );
});

test("create, get and list write the home directory of the workspace directory as ~", (t) => {
  const state = temporary(t);
  const f = fixture(t, {
    createMission: allowMission,
    stateDirectory: join(state, "kanthord"),
    hostHome: state,
  });
  const record = f.invoke("create", { name: PROJECT_NAME });
  const expected = join("~", "kanthord", "projects", record.id);
  assert.equal(record.workspace_directory, expected);
  assert.ok(
    statSync(join(state, "kanthord", "projects", record.id)).isDirectory(),
  );
  assert.equal(
    f.invoke("get", null, { project_id: record.id }).workspace_directory,
    expected,
  );
  assert.equal(f.invoke("list").items[0]!.workspace_directory, expected);
});

test("create answers the committed project when its workspace directory cannot be created", (t) => {
  const f = fixture(t, { createMission: allowMission });
  writeFileSync(join(f.stateDirectory, "projects"), "");
  const record = f.invoke("create", { name: PROJECT_NAME });
  assert.equal(
    record.workspace_directory,
    join(f.stateDirectory, "projects", record.id),
  );
  assert.ok(!existsSync(record.workspace_directory));
  assert.deepEqual(f.invoke("get", null, { project_id: record.id }), record);
});

test("create rejects duplicate names with the holder identity without calling mission again", (t) => {
  let missionCalls = NO_CALLS;
  const f = fixture(t, {
    createMission: (tx, id) => {
      missionCalls++;
      allowMission(tx, id);
    },
  });
  const holder = f.invoke("create", { name: PROJECT_NAME });
  refuses(
    () => f.invoke("create", { name: PROJECT_NAME }),
    HttpStatus.Conflict,
    ProjectErrorCode.NameConflict,
    { id: holder.id },
  );
  assert.equal(missionCalls, ONE_CALL);
  assert.deepEqual(f.invoke("list").items, [holder]);
});

test("mission failure rolls back the project inserted using the same Transaction object", (t) => {
  const failure = new Error("Mission failed.");
  let committedTransaction: Transaction | undefined;
  let missionCalls = NO_CALLS;
  const f = fixture(t, {
    createMission: (tx, id) => {
      missionCalls++;
      assert.equal(tx, committedTransaction);
      allowMission(tx, id);
      throw failure;
    },
  });
  const before = f.invoke("list");
  const count = f.store.database.prepare(
    "SELECT COUNT(*) AS count FROM project_project",
  );
  const countBefore = count.get();
  f.caller.commit = (fn) =>
    f.store.transaction((tx) => {
      committedTransaction = tx;
      return fn(tx);
    });
  assert.throws(
    () => f.invoke("create", { name: PROJECT_NAME }),
    (error) => error === failure,
  );
  assert.equal(missionCalls, ONE_CALL);
  assert.deepEqual(f.invoke("list"), before);
  assert.deepEqual(count.get(), countBefore);
});

test("create refuses a structurally identical but unminted human identity without writing a project", (t) => {
  const f = fixture(t);
  const minted = f.caller.identity;
  const unminted = {
    kind: IdentityKind.Human,
    accountId: ACCOUNT,
    name: DISPLAY_NAME,
    jti: "jti",
  };
  assert.deepEqual(unminted, minted);
  assert.notEqual(unminted, minted);
  f.caller.identity = unminted;
  assert.throws(
    () => f.invoke("create", { name: PROJECT_NAME }),
    assert.AssertionError,
  );
  assert.deepEqual(f.invoke("list"), { items: [], next_cursor: null });
  assert.equal(
    f.store.database
      .prepare("SELECT COUNT(*) AS count FROM project_project")
      .get()?.count,
    NO_ITEMS,
  );
});

test("create refuses unauthenticated and machine callers before inserting a project", (t) => {
  const f = fixture(t);
  for (const identity of [
    undefined,
    {
      kind: IdentityKind.Client,
      clientId: "client",
      name: "worker",
      resourceIdentity: "worker:kanthord:binding",
      issuedAt: 0,
      projectId: "project",
      jti: "jti",
    },
  ]) {
    f.caller.identity = identity;
    assert.throws(
      () => f.invoke("create", { name: PROJECT_NAME }),
      assert.AssertionError,
    );
    assert.equal(f.invoke("list").items.length, NO_ITEMS);
  }
});

test("list uses descending project identities and limit-plus-one pagination", (t) => {
  const f = fixture(t, { createMission: allowMission });
  assert.deepEqual(f.invoke("list"), { items: [], next_cursor: null });
  const records = [PROJECT_NAME, OTHER_NAME, RENAMED_NAME].map((name) =>
    f.invoke("create", { name }),
  );
  records.sort((left, right) => right.id.localeCompare(left.id));
  let cursor: string | null = null;
  const seen = [];
  for (const expected of records) {
    const page: (typeof projectOperations.list.output)["_output"] = f.invoke(
      "list",
      null,
      {},
      { limit: FIRST_PAGE_LIMIT, ...(cursor ? { cursor } : {}) },
    );
    assert.deepEqual(page.items, [expected]);
    seen.push(...page.items);
    cursor = page.next_cursor;
    if (expected !== records.at(-FIRST_PAGE_LIMIT))
      assert.equal(cursor, Buffer.from(expected.id).toString(CURSOR_ENCODING));
  }
  assert.equal(cursor, null);
  assert.deepEqual(seen, records);
  assert.deepEqual(f.invoke("list", null, {}, { limit: records.length }), {
    items: records,
    next_cursor: null,
  });
});

test("list rejects malformed, noncanonical, and non-project cursors", (t) => {
  const f = fixture(t);
  const valid = Buffer.from(createIdentity(PROJECT_ID_PREFIX)).toString(
    CURSOR_ENCODING,
  );
  for (const cursor of [
    "!",
    "not-a-cursor",
    `${valid}=`,
    Buffer.from(createIdentity(BINDING_ID_PREFIX)).toString(CURSOR_ENCODING),
  ]) {
    refuses(
      () => f.invoke("list", null, {}, { cursor }),
      HttpStatus.BadRequest,
      ProjectErrorCode.CursorInvalid,
    );
  }
  assert.deepEqual(f.invoke("list", null, {}, { cursor: valid }), {
    items: [],
    next_cursor: null,
  });
});

test("get and rename reject an absent project", (t) => {
  const f = fixture(t);
  const params = { project_id: createIdentity(PROJECT_ID_PREFIX) };
  refuses(
    () => f.invoke("get", null, params),
    HttpStatus.NotFound,
    ProjectErrorCode.ProjectNotFound,
  );
  refuses(
    () => f.invoke("rename", { name: PROJECT_NAME }, params),
    HttpStatus.NotFound,
    ProjectErrorCode.ProjectNotFound,
  );
});

test("projectNameOf answers the current name after a rename", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const nameOf = () =>
    f.store.transaction((tx) => f.project.projectNameOf(tx, project.id));
  assert.equal(nameOf(), PROJECT_NAME);
  f.invoke("rename", { name: RENAMED_NAME }, { project_id: project.id });
  assert.equal(nameOf(), RENAMED_NAME);
});

test("projectNameOf throws for an absent project", (t) => {
  const f = fixture(t);
  const projectId = createIdentity(PROJECT_ID_PREFIX);
  refuses(
    () => f.store.transaction((tx) => f.project.projectNameOf(tx, projectId)),
    HttpStatus.NotFound,
    ProjectErrorCode.ProjectNotFound,
  );
});

test("projectNameOf opens no transaction", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  f.store.transaction((tx) => {
    const transactions = t.mock.method(f.store, "transaction");
    assert.equal(f.project.projectNameOf(tx, project.id), PROJECT_NAME);
    assert.equal(transactions.mock.callCount(), NO_CALLS);
  });
});

test("rename preserves fields, accepts its current name, and rejects another holder", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const holder = f.invoke("create", { name: OTHER_NAME });
  const params = { project_id: project.id };
  refuses(
    () => f.invoke("rename", { name: OTHER_NAME }, params),
    HttpStatus.Conflict,
    ProjectErrorCode.NameConflict,
    { id: holder.id },
  );
  assert.deepEqual(f.invoke("rename", { name: PROJECT_NAME }, params), project);
  const renamed = { ...project, name: RENAMED_NAME };
  assert.deepEqual(f.invoke("rename", { name: RENAMED_NAME }, params), renamed);
  assert.deepEqual(f.invoke("get", null, params), renamed);
  assert.equal(f.invoke("create", { name: PROJECT_NAME }).name, PROJECT_NAME);
});

test("a created project is active", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  assert.equal(project.paused_at, null);
  assert.deepEqual(f.invoke("get", null, { project_id: project.id }), project);
});

test("pause and resume change paused_at, and a repeated call writes nothing", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const params = { project_id: project.id };
  assert.deepEqual(f.invoke("resume", null, params), project);
  const paused = f.invoke("pause", null, params);
  assert.ok(Number.isSafeInteger(paused.paused_at));
  assert.deepEqual(paused, { ...project, paused_at: paused.paused_at });
  assert.deepEqual(f.invoke("get", null, params), paused);
  assert.deepEqual(f.invoke("pause", null, params), paused);
  assert.deepEqual(
    f.invoke("list", null, {}).items.find((item) => item.id === project.id),
    paused,
  );
  assert.deepEqual(f.invoke("resume", null, params), project);
  assert.deepEqual(f.invoke("get", null, params), project);
  assert.deepEqual(f.invoke("resume", null, params), project);
});

test("pause and resume reject an absent project", (t) => {
  const f = fixture(t);
  const params = { project_id: createIdentity(PROJECT_ID_PREFIX) };
  for (const key of ["pause", "resume"] as const)
    refuses(
      () => f.invoke(key, null, params),
      HttpStatus.NotFound,
      ProjectErrorCode.ProjectNotFound,
    );
  assert.deepEqual(f.wakes, []);
});

test("resume wakes Scheduler once after commit and pause wakes nothing", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const params = { project_id: project.id };
  f.invoke("pause", null, params);
  assert.deepEqual(f.wakes, []);
  f.invoke("resume", null, params);
  assert.deepEqual(f.wakes, [project.id]);
});

test("projectPaused answers the pause and throws for an absent project", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const params = { project_id: project.id };
  const paused = () =>
    f.store.transaction((tx) => f.project.projectPaused(tx, project.id));
  assert.equal(paused(), false);
  f.invoke("pause", null, params);
  assert.equal(paused(), true);
  f.invoke("resume", null, params);
  assert.equal(paused(), false);
  refuses(
    () =>
      f.store.transaction((tx) =>
        f.project.projectPaused(tx, createIdentity(PROJECT_ID_PREFIX)),
      ),
    HttpStatus.NotFound,
    ProjectErrorCode.ProjectNotFound,
  );
});

function storedPlacement(result: {
  bindings: Record<string, { config: unknown }>;
}) {
  return (result.bindings[WORKER_NAME]!.config as { placement?: string })
    .placement;
}

function revisionOf(f: ReturnType<typeof fixture>, bindingId: string) {
  const row = f.store.database
    .prepare("SELECT revision FROM project_binding WHERE id = ?")
    .get(bindingId) as { revision: number };
  return row.revision;
}

function bindingFixture(t: TestContext, overrides: Partial<Dependencies> = {}) {
  const f = fixture(t, { createMission: allowMission, ...overrides });
  const project = f.invoke("create", { name: PROJECT_NAME });
  let version = BINDING_SET_INITIAL_VERSION;
  function write(instanceCount: number | null, placement?: WorkerPlacement) {
    const submission = new Map();
    if (instanceCount !== null)
      submission.set("worker", {
        kind: BindingKind.Worker,
        config: {
          worker: "developer",
          instance_count: instanceCount,
          ...(placement === undefined ? {} : { placement }),
        },
      });
    const result = f.store.transaction((tx) =>
      writeBindingSet(tx, project.id, version, submission),
    );
    version = result.newVersion;
    const change = result.changes.at(-FIRST_PAGE_LIMIT);
    assert.ok(change);
    assert.ok(
      identitySchema(BINDING_ID_PREFIX).safeParse(change.binding_id).success,
    );
    return change.binding_id;
  }
  return { ...f, project_id: project.id, write };
}

test("worker group resolution rejects absence, disablement and removal", async (t) => {
  const f = bindingFixture(t);
  const resolve = (resourceIdentity = WORKER_GROUP) =>
    f.project.resolveWorkerGroup(
      f.project_id,
      resourceIdentity,
      GROUP_ISSUED_AT,
      background,
    );
  assert.equal(await resolve(), null);
  f.write(SINGLE_INSTANCE);
  assert.deepEqual(await resolve(), {
    project_id: f.project_id,
    resource_identity: WORKER_GROUP,
    placement: null,
    worker_instances: [],
  });
  assert.equal(await resolve(MISSING_GROUP), null);
  f.write(INSTANCE_COUNT_MIN);
  assert.equal(await resolve(), null);
  f.write(SINGLE_INSTANCE);
  assert.notEqual(await resolve(), null);
  f.write(null);
  assert.equal(await resolve(), null);
});

test("worker binding resolution retains pinned configuration and reports later disablement and removal", (t) => {
  const f = bindingFixture(t);
  const bindingId = f.write(SINGLE_INSTANCE);
  const read = () =>
    f.store.transaction((tx) => f.project.workerBindingRowOf(tx, bindingId));
  const pinned = read();
  assert.ok(pinned);
  f.write(TWO_INSTANCES);
  assert.deepEqual(read(), pinned);
  f.write(INSTANCE_COUNT_MIN);
  assert.deepEqual(read(), { ...pinned, disabled: true });
  f.write(null);
  assert.equal(read()?.tombstone, true);
  f.write(SINGLE_INSTANCE);
  assert.equal(read()?.tombstone, true);
});

test("worker group resolution uses the latest tombstone and accepts equality at its creation", async (t) => {
  const f = bindingFixture(t);
  let now = GROUP_ISSUED_AT;
  t.mock.method(Date, "now", () => now);
  f.write(SINGLE_INSTANCE);
  now = TOMBSTONE_AT;
  f.write(null);
  f.write(SINGLE_INSTANCE);
  assert.equal(
    await f.project.resolveWorkerGroup(
      f.project_id,
      WORKER_GROUP,
      GROUP_ISSUED_AT,
      background,
    ),
    null,
  );
  assert.deepEqual(
    await f.project.resolveWorkerGroup(
      f.project_id,
      WORKER_GROUP,
      TOMBSTONE_AT,
      background,
    ),
    {
      project_id: f.project_id,
      resource_identity: WORKER_GROUP,
      placement: null,
      worker_instances: [],
    },
  );
  const secondTombstoneAt = TOMBSTONE_AT + GROUP_ISSUED_AT;
  now = secondTombstoneAt;
  f.write(null);
  f.write(SINGLE_INSTANCE);
  assert.equal(
    await f.project.resolveWorkerGroup(
      f.project_id,
      WORKER_GROUP,
      TOMBSTONE_AT,
      background,
    ),
    null,
  );
  assert.deepEqual(
    await f.project.resolveWorkerGroup(
      f.project_id,
      WORKER_GROUP,
      secondTombstoneAt,
      background,
    ),
    {
      project_id: f.project_id,
      resource_identity: WORKER_GROUP,
      placement: null,
      worker_instances: [],
    },
  );
});

test("workerBindingOf reads current configuration, disablement and tombstone in the caller transaction", (t) => {
  const f = bindingFixture(t);
  const read = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.project_id, WORKER_GROUP),
    );
  assert.equal(read(), null);
  const first = f.write(SINGLE_INSTANCE);
  assert.deepEqual(read(), {
    binding_id: first,
    name: GROUP_BINDING_NAME,
    project_name: PROJECT_NAME,
    revision: REVISION_ONE,
    worker_name: GROUP_WORKER_NAME,
    instance_count: SINGLE_INSTANCE,
    worker_instances: [],
    placement: null,
    environment: null,
    generation: revisionOf(f, first),
    resource_budget: null,
    entries: [],
    tags: [],
    tombstone: false,
  });
  const next = f.write(TWO_INSTANCES);
  const txResult = f.store.transaction((tx) => {
    t.mock.method(f.store, "transaction", unexpected);
    return f.project.workerBindingOf(tx, f.project_id, WORKER_GROUP);
  });
  t.mock.restoreAll();
  assert.equal(txResult?.binding_id, next);
  assert.equal(txResult?.revision, REVISION_TWO);
  assert.equal(txResult?.instance_count, TWO_INSTANCES);
  f.write(INSTANCE_COUNT_MIN);
  assert.equal(read()?.instance_count, INSTANCE_COUNT_MIN);
  f.write(null);
  assert.equal(read()?.tombstone, true);
  assert.equal(read()?.name, GROUP_BINDING_NAME);
  f.invoke("rename", { name: RENAMED_NAME }, { project_id: f.project_id });
  assert.equal(read()?.project_name, RENAMED_NAME);
});

test("workerBindingOf reads the placement and the generation of a binding group", (t) => {
  const f = bindingFixture(t);
  const read = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.project_id, WORKER_GROUP),
    );
  const first = f.write(SINGLE_INSTANCE, WorkerPlacement.Server);
  assert.equal(read()?.placement, WorkerPlacement.Server);
  assert.equal(read()?.generation, revisionOf(f, first));
  f.write(TWO_INSTANCES, WorkerPlacement.Server);
  assert.equal(read()?.generation, revisionOf(f, first));
  f.write(null);
  assert.equal(read()?.generation, NO_GENERATION);
  const second = f.write(SINGLE_INSTANCE, WorkerPlacement.Worker);
  assert.equal(read()?.placement, WorkerPlacement.Worker);
  assert.equal(read()?.generation, revisionOf(f, second));
  assert.notEqual(read()?.generation, revisionOf(f, first));
});

test("workerBindingsOf lists the current worker bindings of one project or of every project", (t) => {
  const f = bindingFixture(t);
  f.write(SINGLE_INSTANCE, WorkerPlacement.Server);
  const list = (projectId: string | null) =>
    f.store.transaction((tx) => f.project.workerBindingsOf(tx, projectId));
  assert.deepEqual(
    list(f.project_id).map(({ project_id, resource_identity, placement }) => ({
      project_id,
      resource_identity,
      placement,
    })),
    [
      {
        project_id: f.project_id,
        resource_identity: WORKER_GROUP,
        placement: WorkerPlacement.Server,
      },
    ],
  );
  assert.equal(list(null).length, SINGLE_INSTANCE);
  assert.deepEqual(list(createIdentity(PROJECT_ID_PREFIX)), []);
  f.write(null);
  assert.deepEqual(list(null), []);
});

test("worker group reads reject a repository group and preserve cancellation", async (t) => {
  const f = bindingFixture(t);
  const repositoryGroup = "repository:github:owner/repo";
  f.store.transaction((tx) =>
    writeBindingSet(
      tx,
      f.project_id,
      BINDING_SET_INITIAL_VERSION,
      new Map([
        [
          "repository",
          {
            kind: BindingKind.Repository,
            config: { address: "git@github.com:owner/repo.git" },
          },
        ],
      ]),
    ),
  );
  assert.equal(
    await f.project.resolveWorkerGroup(
      f.project_id,
      repositoryGroup,
      GROUP_ISSUED_AT,
      background,
    ),
    null,
  );
  assert.equal(
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.project_id, repositoryGroup),
    ),
    null,
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    f.project.resolveWorkerGroup(
      f.project_id,
      WORKER_GROUP,
      GROUP_ISSUED_AT,
      context,
    ),
    (error) => error === context.signal.reason,
  );
});

test("worker group override receives the exact group, issuance and context without bypassing cancellation", async (t) => {
  const group = { project_id: "fake-project", resource_identity: WORKER_GROUP };
  let calls = NO_CALLS;
  const f = fixture(t, {
    bindings: {
      async resolveWorkerGroup(projectId, resourceIdentity, issuedAt, context) {
        calls++;
        assert.deepEqual(
          { project_id: projectId, resource_identity: resourceIdentity },
          group,
        );
        assert.equal(issuedAt, GROUP_ISSUED_AT);
        assert.equal(context, background);
        return group;
      },
    },
  });
  t.mock.method(f.store, "transaction", unexpected);
  assert.equal(
    await f.project.resolveWorkerGroup(
      group.project_id,
      group.resource_identity,
      GROUP_ISSUED_AT,
      background,
    ),
    group,
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    f.project.resolveWorkerGroup(
      group.project_id,
      group.resource_identity,
      GROUP_ISSUED_AT,
      context,
    ),
    (error) => error === context.signal.reason,
  );
  assert.equal(calls, ONE_CALL);
});

const REPOSITORY_NAME = "repository";
const SECOND_REPOSITORY_NAME = "other-repository";
const WORKER_NAME = "worker";
const STORAGE_NAME = "storage";
const NATIVE_WORKER = "coder@1";
const OTHER_WORKER = "reviewer@1";
const EXTERNAL_WORKER = "external@1";
const UNKNOWN_WORKER = "unknown@1";
const AGENT = "general";
const SECOND_AGENT = "reviewer";
const THIRD_AGENT = "writer";
const AGENT_PAGE_LIMIT = 2;
const MALFORMED_CURSOR = "!";
const AGENT_GET_KEY = "agentConfiguration.get";
const UNKNOWN_AGENT = "undeclared";
const MODEL = "model";
const REPOSITORY_ADDRESS = "git@github.com:owner/repo.git";
const HEALTH_DEADLINE_MS = 1000;
const ALIAS_ADDRESS = "git@github:owner/alias.git";
const UNPINNED_ADDRESS = "git@ssh.github.com:owner/unpinned.git";
const SECOND_REPOSITORY_ADDRESS = "git@github.com:owner/other.git";
const REPOSITORY_CREDENTIAL = "github-key";
const SSH_CREDENTIAL_PREFIX = "ssh-";

function sshCredentialOf(address: string): string {
  return `${SSH_CREDENTIAL_PREFIX}${/^git@([^:]+):/.exec(address)?.[1] ?? ""}`;
}

const STORAGE_CREDENTIAL = "s3-key";
const SSH_FAILURE_STATUS = 422;
const GIT_FAILED = "repository.connector.git_failed";
const KEY_REFUSED_STDERR =
  "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.";
const HOST_KEY_CHANGED_STDERR =
  "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\nHost key verification failed.";
const REPOSITORY_NOT_FOUND_STDERR =
  "ERROR: Repository not found.\nfatal: Could not read from remote repository.";

function gitFailure(stderr: string): Diagnostic {
  return new Diagnostic(GIT_FAILED, "ls-remote: git failed.", {
    cause: new Error(`ls-remote: git exited with 128: ${stderr}`),
  });
}
const VERSION_INCREMENT = 1;
const REVISION_ONE = 1;
const REVISION_TWO = 2;
const REVISION_THREE = 3;
const TWO_CALLS = 2;
const ONE_BYTE_OVER = 1;
const UTF8 = "utf8";
const FIRST_REVISION = 1;
const SECOND_REVISION = 2;
const CUSTOM_ISSUE = "custom";
const FULFILLED = "fulfilled";
const REJECTED = "rejected";
const Peer = { Custody: "custody", Worker: "worker" } as const;
type Bindings = typeof bindingSetWriteInputSchema._output.bindings;

function repositoryBinding(
  address = REPOSITORY_ADDRESS,
): Extract<Bindings[string], { kind: typeof BindingKind.Repository }> {
  return {
    kind: BindingKind.Repository,
    config: {
      available: true,
      platform: REPOSITORY_PLATFORM,
      address,
      strategy: { base_branch: "main" },
      ssh_credential: sshCredentialOf(address),
      credential: REPOSITORY_CREDENTIAL,
      working_layer: {
        agents_md: true,
        agents_local_md: true,
        claude_md: true,
        claude_local_md: true,
        project_prompt: true,
      },
    },
  };
}

function workerBinding(worker = NATIVE_WORKER) {
  const hosted = worker === NATIVE_WORKER || worker === OTHER_WORKER;
  return {
    kind: BindingKind.Worker,
    config: {
      worker,
      instance_count: SINGLE_INSTANCE,
      ...(hosted ? { placement: WorkerPlacement.Server } : {}),
    },
  };
}

function storageBinding() {
  return {
    kind: BindingKind.Storage,
    config: {
      available: true,
      endpoint: "https://s3.example.com",
      bucket: "evidence",
      region: "eu-central-1",
      prefix: "",
      credential: STORAGE_CREDENTIAL,
    },
  };
}

function writeFixture(t: TestContext, overrides: Partial<Dependencies> = {}) {
  const ssh: Array<{
    address: string;
    context: unknown;
    timeout: number;
    transaction: boolean;
    commits: number;
  }> = [];
  const custody: Array<{ credential: string; platform: string }> = [];
  const entries: Array<{ worker: string; entry: WorkerEntry | null }> = [];
  const workers: string[] = [];
  const f = fixture(t, {
    createMission: allowMission,
    repositoryConnector: {
      async gitLsRemote(address, context, timeout) {
        ssh.push({
          address,
          context,
          timeout,
          transaction: f.store.database.isTransaction,
          commits: f.commits(),
        });
      },
    },
    custodySuitability: (tx, request) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(tx.database, f.store.database);
      custody.push(request);
    },
    workerAgentsOf: (worker) => {
      assert.ok(f.store.database.isTransaction);
      workers.push(worker);
      return worker === EXTERNAL_WORKER ? [] : [AGENT, SECOND_AGENT];
    },
    validateEntry: (tx, worker, entry) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(tx.database, f.store.database);
      entries.push({ worker, entry });
    },
    ...overrides,
  });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const params = { project_id: project.id };
  async function write(
    bindings: Bindings,
    version = BINDING_SET_INITIAL_VERSION,
  ) {
    const operation = projectOperations["bindingSet.write"];
    const input = operation.input.parse({
      params,
      query: EMPTY_QUERY,
      body: { version, bindings },
    });
    const result = await f.registry.get(operation.id).handler(input, f.caller);
    return operation.output.parse(result);
  }
  function snapshot() {
    return {
      projects: f.store.database
        .prepare("SELECT * FROM project_project ORDER BY id")
        .all(),
      bindings: f.store.database
        .prepare("SELECT * FROM project_binding ORDER BY id")
        .all(),
    };
  }
  return { ...f, params, write, snapshot, ssh, custody, entries, workers };
}

async function rejectsWrite(
  promise: Promise<unknown>,
  status: number,
  code: string,
  details: OperationError["details"] = null,
) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}

test("binding writes wake Scheduler once after commit and refused writes wake nothing", async (t) => {
  const f = writeFixture(t);
  assert.deepEqual(f.wakes, []);
  const result = await f.write({ general: workerBinding() });
  assert.deepEqual(f.wakes, [f.params.project_id]);
  assert.equal(
    f.store.transaction((tx) => requireProject(tx, f.params.project_id))
      .binding_set_version,
    result.binding_set_version,
  );
  await assert.rejects(f.write({}));
  assert.deepEqual(f.wakes, [f.params.project_id]);
});

function storedBindings(f: ReturnType<typeof writeFixture>) {
  return f.store.transaction((tx) =>
    Object.fromEntries(
      Array.from(
        readCurrentBindingSet(tx, f.params.project_id),
        ([name, binding]) => [name, binding],
      ),
    ),
  );
}

test("binding edits end registrations only for removed or zero-count worker groups in the write transaction", async (t) => {
  const f = writeFixture(t);
  const config = { ...workerBinding().config, instance_count: TWO_INSTANCES };
  let result = await f.write({
    worker: { kind: BindingKind.Worker, config },
    repository: repositoryBinding(),
  });
  result = await f.write(
    { worker: workerBinding(), repository: repositoryBinding() },
    result.binding_set_version,
  );
  assert.equal(f.registrationEnds.length, NO_CALLS);
  result = await f.write(
    {
      worker: {
        kind: BindingKind.Worker,
        config: {
          ...config,
          resource_budget: { turns: 10, wall_time_ms: 1000 },
        },
      },
    },
    result.binding_set_version,
  );
  assert.equal(f.registrationEnds.length, NO_CALLS);
  result = await f.write(
    {
      worker: {
        kind: BindingKind.Worker,
        config: { ...config, instance_count: INSTANCE_COUNT_MIN },
      },
    },
    result.binding_set_version,
  );
  assert.equal(f.registrationEnds.length, ONE_CALL);
  assert.equal(f.registrationEnds[0]!.project_id, f.params.project_id);
  assert.equal(f.registrationEnds[0]!.resource_identity, WORKER_GROUP);
  assert.ok(Number.isSafeInteger(f.registrationEnds[0]!.now));
  result = await f.write(
    { worker: workerBinding() },
    result.binding_set_version,
  );
  await rejectsWrite(
    f.write({}, result.binding_set_version - VERSION_INCREMENT),
    HttpStatus.Conflict,
    ProjectErrorCode.VersionConflict,
    { binding_set_version: result.binding_set_version },
  );
  assert.equal(f.registrationEnds.length, ONE_CALL);
  await f.write({}, result.binding_set_version);
  assert.equal(f.registrationEnds.length, TWO_CALLS);
});

function assertCurrent(
  f: ReturnType<typeof writeFixture>,
  result: Awaited<ReturnType<typeof f.write>>,
) {
  const stored = storedBindings(f);
  assert.deepEqual(
    Object.keys(result.bindings).sort(),
    Object.keys(stored).sort(),
  );
  for (const [name, binding] of Object.entries(result.bindings)) {
    const { kind, ...record } = binding;
    assert.deepEqual(record, stored[name]);
    assert.ok(Object.values(BindingKind).includes(kind));
  }
  assert.equal(
    f.store.transaction((tx) => requireProject(tx, f.params.project_id))
      .binding_set_version,
    result.binding_set_version,
  );
}

test("binding write probes every repository outside and before commit, validates peers inside it, and persists the response", async (t) => {
  const f = writeFixture(t);
  const bindings: Bindings = {
    [REPOSITORY_NAME]: repositoryBinding(),
    [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
    [WORKER_NAME]: {
      ...workerBinding(),
      config: {
        ...workerBinding().config,
        entries: [{ agent: AGENT, model_identifier: MODEL }],
      },
    },
    [STORAGE_NAME]: storageBinding(),
  };
  const before = f.commits();
  const result = await f.write(bindings);
  assert.equal(result.project_id, f.params.project_id);
  assert.equal(
    result.binding_set_version,
    BINDING_SET_INITIAL_VERSION + Object.keys(bindings).length,
  );
  assert.equal(f.commits(), before + ONE_CALL);
  assert.deepEqual(
    f.ssh,
    [REPOSITORY_ADDRESS, SECOND_REPOSITORY_ADDRESS].map((address) => ({
      address,
      context: f.caller.context,
      timeout: LS_REMOTE_TIMEOUT_MS,
      transaction: false,
      commits: before,
    })),
  );
  const sshSuitability = {
    credential: sshCredentialOf(REPOSITORY_ADDRESS),
    platform: SSH_CREDENTIAL_PLATFORM,
  };
  const keySuitability = {
    credential: REPOSITORY_CREDENTIAL,
    platform: REPOSITORY_PLATFORM,
  };
  assert.deepEqual(f.custody, [
    sshSuitability,
    sshSuitability,
    sshSuitability,
    keySuitability,
    sshSuitability,
    keySuitability,
    { credential: STORAGE_CREDENTIAL, platform: STORAGE_PLATFORM },
  ]);
  assert.deepEqual(f.workers, [NATIVE_WORKER]);
  assert.deepEqual(f.entries, [
    { worker: NATIVE_WORKER, entry: { model_identifier: MODEL } },
    { worker: NATIVE_WORKER, entry: null },
  ]);
  assert.deepEqual(
    result.changes,
    Object.keys(bindings).map((name) => ({
      kind: ChangeKind.Created,
      binding_id: result.bindings[name]!.id,
    })),
  );
  for (const binding of Object.values(result.bindings))
    assert.equal(binding.revision, REVISION_ONE);
  assertCurrent(f, result);
  const exported = f.invoke("bindingSet.get", null, f.params);
  assert.deepEqual(bindingSetWriteInputSchema.parse(exported), {
    version: result.binding_set_version,
    bindings,
  });
  const repeated = await f.write(exported.bindings, exported.version);
  assert.equal(f.ssh.length, TWO_CALLS);
  assert.deepEqual(repeated.bindings, result.bindings);
  assert.equal(repeated.binding_set_version, result.binding_set_version);
  assert.ok(
    repeated.changes.every(({ kind }) => kind === ChangeKind.Unchanged),
  );
  assertCurrent(f, repeated);
});

test("equal and reordered configurations keep the version without inserting revisions", async (t) => {
  const f = writeFixture(t);
  const original = workerBinding();
  const first = await f.write({ [WORKER_NAME]: original });
  const rows = f.snapshot().bindings;
  const reordered = {
    kind: BindingKind.Worker,
    config: {
      instance_count: SINGLE_INSTANCE,
      worker: NATIVE_WORKER,
      placement: WorkerPlacement.Server,
    },
  };
  for (const binding of [reordered, original]) {
    const version = f.invoke("bindingSet.get", null, f.params).version;
    const result = await f.write({ [WORKER_NAME]: binding }, version);
    assert.equal(result.binding_set_version, version);
    assert.deepEqual(result.bindings, first.bindings);
    assert.deepEqual(result.changes, [
      {
        kind: ChangeKind.Unchanged,
        binding_id: first.bindings[WORKER_NAME]!.id,
      },
    ]);
    assert.deepEqual(f.snapshot().bindings, rows);
  }
});

test("stale versions and changed worker names refuse the entire edit", async (t) => {
  const f = writeFixture(t);
  const first = await f.write({ [WORKER_NAME]: workerBinding() });
  const before = f.snapshot();
  await rejectsWrite(
    f.write({}),
    HttpStatus.Conflict,
    ProjectErrorCode.VersionConflict,
    { binding_set_version: first.binding_set_version },
  );
  await rejectsWrite(
    f.write(
      { [WORKER_NAME]: workerBinding(OTHER_WORKER) },
      first.binding_set_version,
    ),
    HttpStatus.Conflict,
    ProjectErrorCode.WorkerResourceChanged,
  );
  assert.deepEqual(f.snapshot(), before);
});

test("a worker binding stores each placement as written", async (t) => {
  const f = probedFixture(t, null);
  const read = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.params.project_id, WORKER_GROUP),
    );
  const worker = workerBinding();
  const first = await f.write({ [WORKER_NAME]: worker });
  assert.equal(read()?.placement, WorkerPlacement.Server);
  assert.equal(storedPlacement(first), WorkerPlacement.Server);
  const unchanged = await f.write(
    { [WORKER_NAME]: worker },
    first.binding_set_version,
  );
  assert.equal(unchanged.binding_set_version, first.binding_set_version);
  const removed = await f.write({}, first.binding_set_version);
  const container = {
    kind: BindingKind.Worker,
    config: { ...worker.config, placement: WorkerPlacement.Container },
  };
  const second = await f.write(
    { [WORKER_NAME]: container },
    removed.binding_set_version,
  );
  assert.equal(read()?.placement, WorkerPlacement.Container);
  assert.equal(storedPlacement(second), WorkerPlacement.Container);
});

test("a hosted worker binding refuses a write without a placement", async (t) => {
  const f = writeFixture(t);
  const config = { worker: NATIVE_WORKER, instance_count: SINGLE_INSTANCE };
  const before = f.snapshot();
  await rejectsWrite(
    f.write({ [WORKER_NAME]: { kind: BindingKind.Worker, config } }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerPlacementRequired,
    { binding: WORKER_NAME },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("an external worker binding reads a null placement", async (t) => {
  const f = writeFixture(t);
  const written = await f.write({
    [WORKER_NAME]: workerBinding(EXTERNAL_WORKER),
  });
  assert.equal(storedPlacement(written), undefined);
  const row = f.store.transaction((tx) =>
    f.project.workerBindingOf(tx, f.params.project_id, WORKER_GROUP),
  );
  assert.equal(row?.placement, null);
});

test("a placement change of a worker binding refuses the entire edit and a removal frees the name", async (t) => {
  const f = writeFixture(t);
  const server = {
    kind: BindingKind.Worker,
    config: { ...workerBinding().config, placement: WorkerPlacement.Server },
  };
  const first = await f.write({ [WORKER_NAME]: server });
  const before = f.snapshot();
  const changes = f.bindingChanges.length;
  for (const config of [
    {
      worker: workerBinding().config.worker,
      placement: WorkerPlacement.Worker,
      worker_instances: [],
    },
    { ...workerBinding().config, placement: WorkerPlacement.Container },
  ])
    await rejectsWrite(
      f.write(
        { [WORKER_NAME]: { kind: BindingKind.Worker, config } },
        first.binding_set_version,
      ),
      HttpStatus.Conflict,
      ProjectErrorCode.WorkerPlacementChanged,
    );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.bindingChanges.length, changes);
  const removed = await f.write({}, first.binding_set_version);
  const again = await f.write(
    { [WORKER_NAME]: workerBinding() },
    removed.binding_set_version,
  );
  assert.equal(storedPlacement(again), WorkerPlacement.Server);
});

test("an external worker refuses the placement field", async (t) => {
  const f = writeFixture(t);
  const before = f.snapshot();
  await rejectsWrite(
    f.write({
      [WORKER_NAME]: {
        kind: BindingKind.Worker,
        config: {
          ...workerBinding(EXTERNAL_WORKER).config,
          placement: WorkerPlacement.Server,
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerFieldForbidden,
    { binding: WORKER_NAME, field: WorkerField.Placement },
  );
  assert.deepEqual(f.snapshot(), before);
});

function containerBinding(count = SINGLE_INSTANCE, worker = NATIVE_WORKER) {
  return {
    kind: BindingKind.Worker,
    config: {
      worker,
      instance_count: count,
      placement: WorkerPlacement.Container,
    },
  };
}

function probedFixture(t: TestContext, reason: string | null) {
  const probes: boolean[] = [];
  const holder: { store?: Store } = {};
  const f = writeFixture(t, {
    placementStatus: async () => {
      probes.push(holder.store!.database.isTransaction);
      return { available: reason === null, reason };
    },
  });
  holder.store = f.store;
  return { ...f, probes };
}

for (const reason of Object.values(StablePlacementIssue))
  test(`an added container binding refuses the write on ${reason}`, async (t) => {
    const f = probedFixture(t, reason);
    const before = f.snapshot();
    await rejectsWrite(
      f.write({ [WORKER_NAME]: containerBinding() }),
      HttpStatus.Conflict,
      ProjectErrorCode.WorkerPlacementUnavailable,
      {
        binding: WORKER_NAME,
        placement: WorkerPlacement.Container,
        reason,
      },
    );
    assert.deepEqual(f.probes, [false]);
    assert.deepEqual(f.snapshot(), before);
    assert.equal(f.bindingChanges.length, NO_BINDING_CHANGES);
  });

function instanceBinding(config: Record<string, unknown>) {
  return {
    kind: BindingKind.Worker,
    config: {
      worker: NATIVE_WORKER,
      placement: WorkerPlacement.Worker,
      ...config,
    },
  };
}

const LIVE_INSTANCES: Record<string, string> = {
  "coder-a": NATIVE_WORKER,
  "coder-b": NATIVE_WORKER,
  "reviewer-a": OTHER_WORKER,
};

function instanceFixture(t: TestContext) {
  return writeFixture(t, {
    instanceOf: (tx, name) => {
      assert.ok(tx.database.isTransaction);
      const worker = LIVE_INSTANCES[name];
      return worker === undefined ? null : { name, worker };
    },
  });
}

test("a worker placement binding stores its instances and answers their count", async (t) => {
  const f = instanceFixture(t);
  const written = await f.write({
    [WORKER_NAME]: instanceBinding({
      worker_instances: ["coder-a", "coder-b"],
    }),
  });
  assert.deepEqual(
    (written.bindings[WORKER_NAME]!.config as { worker_instances: string[] })
      .worker_instances,
    ["coder-a", "coder-b"],
  );
  const row = f.store.transaction((tx) =>
    f.project.workerBindingOf(
      tx,
      f.params.project_id,
      `worker:kanthord:${WORKER_NAME}`,
    ),
  );
  assert.equal(row?.instance_count, TWO_INSTANCES);
  assert.deepEqual(row?.worker_instances, ["coder-a", "coder-b"]);
});

test("the agent view of a native worker at the worker placement checks the holders of its instances and claims no cooldown", async (t) => {
  const view = {
    defaults: null,
    effective: null,
    chain: [],
    active_position: null,
    cooling: null,
    valid: true,
    issues: [],
  };
  const scopes: HolderScope[] = [];
  const f = writeFixture(t, {
    instanceOf: (_tx, name) => {
      const worker = LIVE_INSTANCES[name];
      return worker === undefined ? null : { name, worker };
    },
    workerAgentsOf: () => [AGENT],
    workerAgentView: (_tx, _worker, _agent, _entry, scope) => {
      scopes.push(scope);
      return view;
    },
  });
  const written = await f.write({
    [WORKER_NAME]: instanceBinding({ worker_instances: ["coder-a"] }),
  });
  const params = {
    ...f.params,
    binding_id: written.bindings[WORKER_NAME]!.id,
  };
  const [item] = f.invoke("agentConfiguration.list", null, params).items;
  assert.equal(item?.valid, true);
  assert.deepEqual(scopes, [{ holders: ["coder-a"], claimant: null }]);
});

const INSTANCE_REFUSALS: Array<
  [string, Record<string, unknown>, string, OperationError["details"]]
> = [
  [
    "instance_count at the worker placement",
    { instance_count: SINGLE_INSTANCE, worker_instances: ["coder-a"] },
    ProjectErrorCode.WorkerFieldForbidden,
    { binding: WORKER_NAME, field: WorkerField.InstanceCount },
  ],
  [
    "an absent list",
    {},
    ProjectErrorCode.WorkerInstancesRequired,
    { binding: WORKER_NAME },
  ],
  [
    "a list of another shape",
    { worker_instances: "coder-a" },
    ProjectErrorCode.WorkerInstancesInvalid,
    { binding: WORKER_NAME, instance: null },
  ],
  [
    "a repeated name",
    { worker_instances: ["coder-a", "coder-a"] },
    ProjectErrorCode.WorkerInstancesInvalid,
    { binding: WORKER_NAME, instance: "coder-a" },
  ],
  [
    "a list above 64 names",
    {
      worker_instances: Array.from(
        { length: 65 },
        (_value, index) => `coder-${index}`,
      ),
    },
    ProjectErrorCode.WorkerInstancesInvalid,
    { binding: WORKER_NAME, instance: null },
  ],
  [
    "an unknown or archived name",
    { worker_instances: ["coder-z"] },
    ProjectErrorCode.WorkerInstanceUnknown,
    { binding: WORKER_NAME, instance: "coder-z" },
  ],
  [
    "an instance of another worker",
    { worker_instances: ["reviewer-a"] },
    ProjectErrorCode.WorkerInstanceWorkerMismatch,
    { binding: WORKER_NAME, instance: "reviewer-a", worker: OTHER_WORKER },
  ],
];

for (const [label, config, code, details] of INSTANCE_REFUSALS)
  test(`a worker placement binding refuses ${label}`, async (t) => {
    const f = instanceFixture(t);
    const before = f.snapshot();
    await rejectsWrite(
      f.write({ [WORKER_NAME]: instanceBinding(config) }),
      HttpStatus.BadRequest,
      code,
      details,
    );
    assert.deepEqual(f.snapshot(), before);
  });

test("a server placement binding refuses worker_instances", async (t) => {
  const f = instanceFixture(t);
  await rejectsWrite(
    f.write({
      [WORKER_NAME]: {
        kind: BindingKind.Worker,
        config: {
          ...containerBinding().config,
          placement: WorkerPlacement.Server,
          worker_instances: ["coder-a"],
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerFieldForbidden,
    { binding: WORKER_NAME, field: WorkerField.WorkerInstances },
  );
});

test("an added container binding passes on a transient runtime failure", async (t) => {
  const f = probedFixture(t, PlacementIssue.RuntimeFailed);
  const written = await f.write({ [WORKER_NAME]: containerBinding() });
  assert.equal(storedPlacement(written), WorkerPlacement.Container);
  assert.deepEqual(f.probes, [false]);
});

test("an added container binding passes when the placement is available", async (t) => {
  const f = probedFixture(t, null);
  const written = await f.write({ [WORKER_NAME]: containerBinding() });
  assert.equal(storedPlacement(written), WorkerPlacement.Container);
});

test("an edit of a live container binding reads no placement status", async (t) => {
  let reason: string | null = null;
  const f = writeFixture(t, {
    placementStatus: async () => ({ available: reason === null, reason }),
  });
  const first = await f.write({ [WORKER_NAME]: containerBinding() });
  reason = PlacementIssue.RuntimeAbsent;
  const lowered = await f.write(
    { [WORKER_NAME]: containerBinding(NO_INSTANCES) },
    first.binding_set_version,
  );
  assert.equal(storedPlacement(lowered), WorkerPlacement.Container);
  assert.deepEqual(
    lowered.bindings[WORKER_NAME]!.config,
    containerBinding(NO_INSTANCES).config,
  );
});

test("a container binding name reused after a removal counts as added", async (t) => {
  let reason: string | null = null;
  const f = writeFixture(t, {
    placementStatus: async () => ({ available: reason === null, reason }),
  });
  const first = await f.write({ [WORKER_NAME]: containerBinding() });
  const removed = await f.write({}, first.binding_set_version);
  reason = PlacementIssue.ServerInContainer;
  await rejectsWrite(
    f.write({ [WORKER_NAME]: containerBinding() }, removed.binding_set_version),
    HttpStatus.Conflict,
    ProjectErrorCode.WorkerPlacementUnavailable,
    {
      binding: WORKER_NAME,
      placement: WorkerPlacement.Container,
      reason,
    },
  );
});

test("an external worker with the container placement refuses the field before the placement", async (t) => {
  const f = probedFixture(t, PlacementIssue.RuntimeAbsent);
  await rejectsWrite(
    f.write({
      [WORKER_NAME]: containerBinding(SINGLE_INSTANCE, EXTERNAL_WORKER),
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerFieldForbidden,
    { binding: WORKER_NAME, field: WorkerField.Placement },
  );
});

function containerWithEnvironment(environment?: string) {
  const binding = containerBinding();
  return {
    ...binding,
    config: {
      ...binding.config,
      ...(environment === undefined ? {} : { environment }),
    },
  };
}

function workerRows(f: ReturnType<typeof probedFixture>) {
  return f.store.transaction((tx) => ({
    one: f.project.workerBindingOf(tx, f.params.project_id, WORKER_GROUP),
    all: f.project.workerBindingsOf(tx, f.params.project_id),
  }));
}

function repositoryIdentity(f: ReturnType<typeof probedFixture>, name: string) {
  return f.store.transaction(
    (tx) =>
      readCurrentBindingSet(tx, f.params.project_id).get(name)!
        .resource_identity,
  );
}

for (const environment of [undefined, REPOSITORY_NAME])
  test(`a container binding with environment ${environment ?? "absent"} resolves the only repository binding`, async (t) => {
    const f = probedFixture(t, null);
    await f.write({
      [REPOSITORY_NAME]: repositoryBinding(),
      [WORKER_NAME]: containerWithEnvironment(environment),
    });
    const expected = repositoryIdentity(f, REPOSITORY_NAME);
    const rows = workerRows(f);
    assert.equal(rows.one?.environment, expected);
    assert.deepEqual(
      rows.all.map(({ environment }) => environment),
      [expected],
    );
  });

test("a container binding with a named environment resolves among two repository bindings", async (t) => {
  const f = probedFixture(t, null);
  await f.write({
    [REPOSITORY_NAME]: repositoryBinding(),
    [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
    [WORKER_NAME]: containerWithEnvironment(SECOND_REPOSITORY_NAME),
  });
  assert.equal(
    workerRows(f).one?.environment,
    repositoryIdentity(f, SECOND_REPOSITORY_NAME),
  );
});

test("a container binding with two repository bindings and no environment refuses the write", async (t) => {
  const f = probedFixture(t, null);
  const before = f.snapshot();
  await rejectsWrite(
    f.write({
      [REPOSITORY_NAME]: repositoryBinding(),
      [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
      [WORKER_NAME]: containerWithEnvironment(),
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerEnvironmentRequired,
    { binding: WORKER_NAME },
  );
  assert.deepEqual(f.snapshot(), before);
});

for (const environment of ["missing", STORAGE_NAME])
  test(`a container binding with the environment ${environment} refuses the write`, async (t) => {
    const f = probedFixture(t, null);
    const before = f.snapshot();
    await rejectsWrite(
      f.write({
        [REPOSITORY_NAME]: repositoryBinding(),
        [STORAGE_NAME]: storageBinding(),
        [WORKER_NAME]: containerWithEnvironment(environment),
      }),
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerEnvironmentUnknown,
      { binding: WORKER_NAME, environment },
    );
    assert.deepEqual(f.snapshot(), before);
  });

test("environment refuses at the server placement, the worker placement and an external harness", async (t) => {
  const f = instanceFixture(t);
  const before = f.snapshot();
  const configs = [
    { ...workerBinding().config, environment: REPOSITORY_NAME },
    instanceBinding({ worker_instances: [], environment: REPOSITORY_NAME })
      .config,
    { ...workerBinding(EXTERNAL_WORKER).config, environment: REPOSITORY_NAME },
  ];
  for (const config of configs) {
    await rejectsWrite(
      f.write({
        [REPOSITORY_NAME]: repositoryBinding(),
        [WORKER_NAME]: { kind: BindingKind.Worker, config },
      }),
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerFieldForbidden,
      { binding: WORKER_NAME, field: WorkerField.Environment },
    );
    assert.deepEqual(f.snapshot(), before);
  }
});

test("a write that adds a second repository binding to a keyless container binding refuses", async (t) => {
  const f = probedFixture(t, null);
  const first = await f.write({
    [REPOSITORY_NAME]: repositoryBinding(),
    [WORKER_NAME]: containerWithEnvironment(),
  });
  const before = f.snapshot();
  await rejectsWrite(
    f.write(
      {
        [REPOSITORY_NAME]: repositoryBinding(),
        [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
        [WORKER_NAME]: containerWithEnvironment(),
      },
      first.binding_set_version,
    ),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerEnvironmentRequired,
    { binding: WORKER_NAME },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("the server placement answers a null environment", async (t) => {
  const f = writeFixture(t);
  await f.write({
    [REPOSITORY_NAME]: repositoryBinding(),
    [WORKER_NAME]: workerBinding(),
  });
  const rows = f.store.transaction((tx) => ({
    one: f.project.workerBindingOf(tx, f.params.project_id, WORKER_GROUP),
    all: f.project.workerBindingsOf(tx, f.params.project_id),
  }));
  assert.equal(rows.one?.environment, null);
  assert.deepEqual(
    rows.all.map(({ environment }) => environment),
    [null],
  );
});

const TAG_PREFIX = "platform.";
const TAG_MAX = `${TAG_PREFIX}${"a".repeat(TAG_MAX_BYTES - TAG_PREFIX.length)}`;

function tracedWorker(tags: unknown, worker = NATIVE_WORKER) {
  const binding = workerBinding(worker);
  return { ...binding, config: { ...binding.config, tags } };
}

test("worker tags accept a tag of 64 bytes and read an absent field as an empty list", async (t) => {
  const f = writeFixture(t);
  const read = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.params.project_id, WORKER_GROUP),
    );
  const list = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingsOf(tx, f.params.project_id),
    );
  assert.equal(Buffer.byteLength(TAG_MAX), TAG_MAX_BYTES);
  const first = await f.write({ [WORKER_NAME]: workerBinding() });
  assert.deepEqual(read()?.tags, []);
  await f.write(
    { [WORKER_NAME]: tracedWorker([TAG_MAX, "toolchain.xcode_16"]) },
    first.binding_set_version,
  );
  assert.deepEqual(read()?.tags, [TAG_MAX, "toolchain.xcode_16"]);
  assert.deepEqual(
    list().map(({ tags }) => tags),
    [[TAG_MAX, "toolchain.xcode_16"]],
  );
});

test("worker tags refuse a longer tag, an upper-case tag, an empty segment, a repeated tag and a nonlist value", async (t) => {
  const f = writeFixture(t);
  const before = f.snapshot();
  const cases: Array<{ tags: unknown; tag: string | null }> = [
    { tags: [`${TAG_MAX}a`], tag: `${TAG_MAX}a` },
    { tags: ["platform.macOS"], tag: "platform.macOS" },
    { tags: ["platform..macos"], tag: "platform..macos" },
    {
      tags: ["platform.macos", "platform.macos"],
      tag: "platform.macos",
    },
    { tags: "platform.macos", tag: null },
    { tags: [7], tag: null },
  ];
  for (const { tags, tag } of cases)
    await rejectsWrite(
      f.write({ [WORKER_NAME]: tracedWorker(tags) }),
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerTagsInvalid,
      { binding: WORKER_NAME, tag },
    );
  await rejectsWrite(
    f.write({ [WORKER_NAME]: tracedWorker(["Platform"], EXTERNAL_WORKER) }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerTagsInvalid,
    { binding: WORKER_NAME, tag: "Platform" },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("a change of worker tags creates the next revision of the binding", async (t) => {
  const f = writeFixture(t);
  const read = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.params.project_id, WORKER_GROUP),
    );
  const first = await f.write({
    [WORKER_NAME]: tracedWorker(["platform.linux"], EXTERNAL_WORKER),
  });
  assert.equal(read()?.revision, REVISION_ONE);
  const unchanged = await f.write(
    { [WORKER_NAME]: tracedWorker(["platform.linux"], EXTERNAL_WORKER) },
    first.binding_set_version,
  );
  assert.equal(unchanged.binding_set_version, first.binding_set_version);
  const second = await f.write(
    { [WORKER_NAME]: tracedWorker(["platform.macos"], EXTERNAL_WORKER) },
    first.binding_set_version,
  );
  assert.deepEqual(
    second.changes.map(({ kind }) => kind),
    [ChangeKind.Revised],
  );
  assert.equal(read()?.revision, REVISION_TWO);
  assert.deepEqual(read()?.tags, ["platform.macos"]);
});

const MACOS_NODE = "node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const MACOS_REVIEWER = "macos-reviewer";

function macosCoverage(project: () => ProjectService) {
  const reads: number[] = [];
  const unmatchedClaims: Dependencies["unmatchedClaims"] = (tx, projectId) => {
    assert.ok(tx.database.isTransaction);
    const covered = project()
      .workerBindingsOf(tx, projectId)
      .some(({ tags }) => tags.includes("platform.macos"));
    reads.push(covered ? 0 : 1);
    return covered
      ? []
      : [{ node_id: MACOS_NODE, revision: REVISION_ONE, claim: "Waiting" }];
  };
  return { reads, unmatchedClaims };
}

test("a binding set without the only macOS reviewer answers project.bindings.worker.node_unmatched", async (t) => {
  const services: ProjectService[] = [];
  const coverage = macosCoverage(() => services[0]!);
  const f = writeFixture(t, { unmatchedClaims: coverage.unmatchedClaims });
  services.push(f.project);
  const first = await f.write({
    [MACOS_REVIEWER]: tracedWorker(["platform.macos"], EXTERNAL_WORKER),
  });
  const before = f.snapshot();
  await rejectsWrite(
    f.write({}, first.binding_set_version),
    HttpStatus.Conflict,
    ProjectErrorCode.WorkerNodeUnmatched,
    { node_ids: [MACOS_NODE] },
  );
  assert.deepEqual(f.snapshot(), before);
  await rejectsWrite(
    f.write(
      { [MACOS_REVIEWER]: tracedWorker([], EXTERNAL_WORKER) },
      first.binding_set_version,
    ),
    HttpStatus.Conflict,
    ProjectErrorCode.WorkerNodeUnmatched,
    { node_ids: [MACOS_NODE] },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("a write that keeps an earlier unmatched pair succeeds", async (t) => {
  const services: ProjectService[] = [];
  const coverage = macosCoverage(() => services[0]!);
  const f = writeFixture(t, { unmatchedClaims: coverage.unmatchedClaims });
  services.push(f.project);
  const first = await f.write({
    [WORKER_NAME]: workerBinding(EXTERNAL_WORKER),
  });
  const second = await f.write(
    { [WORKER_NAME]: tracedWorker(["platform.linux"], EXTERNAL_WORKER) },
    first.binding_set_version,
  );
  assert.ok(second.binding_set_version > first.binding_set_version);
  assert.deepEqual(coverage.reads, [1, 1, 1, 1]);
});

test("a committed binding-set write notifies the bindings change once after the commit and a refused write notifies nothing", async (t) => {
  const f = writeFixture(t);
  assert.deepEqual(f.bindingChanges, []);
  await f.write({ [WORKER_NAME]: workerBinding() });
  assert.deepEqual(f.bindingChanges, [f.params.project_id]);
  await assert.rejects(f.write({}));
  assert.deepEqual(f.bindingChanges, [f.params.project_id]);
});

test("concurrent writes probe before committing and only one expected version wins", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = NO_CALLS;
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        calls++;
        assert.equal(f.store.database.isTransaction, false);
        await gate;
      },
    },
  });
  const before = f.snapshot();
  const submissions = [
    f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
    f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
  ];
  while (calls < TWO_CALLS) await turn(undefined, { signal: t.signal });
  assert.equal(calls, TWO_CALLS);
  assert.deepEqual(f.snapshot(), before);
  release();
  const results = await Promise.allSettled(submissions);
  const successes = results.filter((result) => result.status === FULFILLED);
  const failures = results.filter((result) => result.status === REJECTED);
  assert.equal(successes.length, ONE_CALL);
  assert.equal(failures.length, ONE_CALL);
  const success = successes[NO_ITEMS]!;
  const failure = failures[NO_ITEMS]!;
  assert.ok(failure.reason instanceof OperationError);
  assert.equal(failure.reason.status, HttpStatus.Conflict);
  assert.equal(failure.reason.code, ProjectErrorCode.VersionConflict);
  assert.deepEqual(failure.reason.details, {
    binding_set_version: success.value.binding_set_version,
  });
  assert.equal(f.snapshot().bindings.length, ONE_CALL);
  assertCurrent(f, success.value);
});

test("invalid repository addresses and duplicate resources are refused before any SSH call or commit", async (t) => {
  const f = writeFixture(t);
  const before = f.snapshot();
  const commits = f.commits();
  for (const address of [
    "https://github.com/owner/repo.git",
    "git@gitlab.com:owner/repo.git",
  ])
    await rejectsWrite(
      f.write({ [REPOSITORY_NAME]: repositoryBinding(address) }),
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryAddressInvalid,
    );
  for (const duplicate of [repositoryBinding(), storageBinding()])
    await rejectsWrite(
      f.write({
        [REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
        first: duplicate,
        second: duplicate,
      }),
      HttpStatus.BadRequest,
      ProjectErrorCode.DuplicateResource,
    );
  assert.deepEqual(f.ssh, []);
  assert.equal(f.commits(), commits);
  assert.deepEqual(f.snapshot(), before);
});

test("a new binding releases the key of its SSH credential under the human draft subject and reads with that key", async (t) => {
  const reads: Array<{ address: string; ssh: SshAccess }> = [];
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote(address, _context, _timeout, ssh) {
        assert.equal(f.store.database.isTransaction, false);
        reads.push({ address, ssh });
      },
    },
  });
  f.project.cancelEnvironmentRuns();
  await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  const credential = sshCredentialOf(REPOSITORY_ADDRESS);
  assert.deepEqual(f.releases, [
    {
      identity: f.caller.identity,
      subject: {
        kind: SshIdentitySubjectKind.Draft,
        project_id: f.params.project_id,
        credential,
        address: REPOSITORY_ADDRESS,
      },
      credential,
      address: REPOSITORY_ADDRESS,
      transaction: true,
    },
  ]);
  assert.deepEqual(f.dropped, [credential]);
  assert.deepEqual(reads, [
    {
      address: REPOSITORY_ADDRESS,
      ssh: {
        private_key: SSH_KEY.private_key,
        public_key: SSH_KEY.public_key,
        known_hosts: `github.com ${HOST_KEY}\n`,
        port: DEFAULT_SSH_PORT,
      },
    },
  ]);
});

test("a write with a pinned host passes through the private agent of the released key to a local sshd", async (t) => {
  const sshd = await startTestSshd(t);
  const bare = await createBareRepository(t);
  await sshd.authorize(SSH_KEY.public_key);
  const repository = new RepositoryComponent({
    checkTools: () => {},
    knownHostsOf: () => sshd.known_hosts,
    portOf: () => sshd.port,
  });
  const reads: string[] = [];
  const f = writeFixture(t, {
    sshAccessOf: (tx, granted, material) =>
      repository.sshAccessOf(tx, granted, material),
    repositoryConnector: {
      async gitLsRemote(address, context, timeout, ssh) {
        reads.push(address);
        await gitLsRemote(sshd.url(bare), context, timeout, ssh);
      },
    },
  });
  const result = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  assert.ok(result.bindings[REPOSITORY_NAME]);
  assert.deepEqual(reads, [REPOSITORY_ADDRESS]);
  await sshd.authorize(generateSshKey("other").public_key);
  f.secrets.set(sshCredentialOf(SECOND_REPOSITORY_ADDRESS), {
    private_key: generateSshKey("refused").private_key,
  });
  await rejectsWrite(
    f.write(
      {
        [REPOSITORY_NAME]: repositoryBinding(),
        [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
      },
      result.binding_set_version,
    ),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    { failure_reason: ResourceFailureReason.KeyRefused },
  );
});

test("a new or changed binding with an unpinned host refuses 409 before the read and the commit", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const before = f.snapshot();
  const commits = f.commits();
  await rejectsWrite(
    f.write({ [REPOSITORY_NAME]: repositoryBinding(UNPINNED_ADDRESS) }),
    HttpStatus.Conflict,
    HOST_KEY_UNPINNED,
    { host: "ssh.github.com" },
  );
  assert.deepEqual(f.dropped, [sshCredentialOf(UNPINNED_ADDRESS)]);
  assert.equal(f.commits(), commits);
  assert.deepEqual(f.snapshot(), before);
});

test("a host outside the SSH host set of the platform refuses address_invalid before any release", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  for (const address of [
    ALIAS_ADDRESS,
    "git@gitlab.com:owner/repo.git",
    "git@-oProxyCommand:owner/repo.git",
  ])
    await rejectsWrite(
      f.write({ [REPOSITORY_NAME]: repositoryBinding(address) }),
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryAddressInvalid,
    );
  assert.deepEqual(f.releases, []);
});

test("a legacy SSH credential refuses the write with ssh_key_legacy before the read", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const credential = sshCredentialOf(REPOSITORY_ADDRESS);
  f.secrets.set(credential, {});
  await rejectsWrite(
    f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
    HttpStatus.Conflict,
    SSH_KEY_LEGACY,
    { credential },
  );
  assert.deepEqual(f.dropped, [credential]);
});

test("an unchanged alias-model binding does not block a worker save and its check answers address_invalid", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
    verifyRepositoryCredential: async () => CREDENTIAL_HEALTHY,
  });
  const version = f.store.transaction(
    (tx) =>
      writeBindingSet(
        tx,
        f.params.project_id,
        BINDING_SET_INITIAL_VERSION,
        new Map([[REPOSITORY_NAME, repositoryBinding(ALIAS_ADDRESS)]]),
      ).newVersion,
  );
  const result = await f.write(
    {
      [REPOSITORY_NAME]: repositoryBinding(ALIAS_ADDRESS),
      [WORKER_NAME]: workerBinding(),
    },
    version,
  );
  assert.deepEqual(
    result.changes.map(({ kind }) => kind),
    [ChangeKind.Unchanged, ChangeKind.Created],
  );
  assert.deepEqual(f.releases, []);
  const health = await checkBinding(
    f,
    f.params.project_id,
    repositoryBinding(ALIAS_ADDRESS).config,
  );
  assert.deepEqual(health.address, {
    status: ResourceStatus.Unhealthy,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
    failure_reason: ResourceFailureReason.AddressInvalid,
  });
  assert.deepEqual(f.releases, []);
});

const GITLAB_IDENTITY = "repository:gitlab:acme/api";

function withoutWorkingLayer<T extends { working_layer?: unknown }>(
  config: T,
): Omit<T, "working_layer"> {
  const copy: Partial<T> = { ...config };
  delete copy.working_layer;
  return copy as Omit<T, "working_layer">;
}

function withoutCredential<T extends { credential?: string }>(
  config: T,
): Omit<T, "credential"> {
  const copy: Partial<T> = { ...config };
  delete copy.credential;
  return copy as Omit<T, "credential">;
}

test("the credential is optional and pull_request requires it", async (t) => {
  const f = writeFixture(t);
  const config = withoutCredential(repositoryBinding().config);
  const pullRequest = {
    name: GitHubAction.PullRequest,
    follows: { type: FollowsType.AssessmentPassed },
  };
  await rejectsWrite(
    f.write({
      [REPOSITORY_NAME]: {
        kind: BindingKind.Repository,
        config: {
          ...config,
          strategy: { ...config.strategy, action: pullRequest },
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryCredentialRequired,
  );
  assert.deepEqual(f.ssh, []);
  const result = await f.write({
    [REPOSITORY_NAME]: { kind: BindingKind.Repository, config },
  });
  assert.ok(
    !Object.hasOwn(
      repositoryConfigSchema.parse(result.bindings[REPOSITORY_NAME]?.config),
      "credential",
    ),
  );
  assert.ok(
    !f.custody.some(({ platform }) => platform === REPOSITORY_PLATFORM),
  );
});

test("a write stores the full working layer map and a switch change revises the binding", async (t) => {
  const f = writeFixture(t);
  const config = withoutWorkingLayer(repositoryBinding().config);
  const allOn = {
    agents_md: true,
    agents_local_md: true,
    claude_md: true,
    claude_local_md: true,
    project_prompt: true,
  };
  const first = await f.write({
    [REPOSITORY_NAME]: {
      kind: BindingKind.Repository,
      config,
    } as Bindings[string],
  });
  assert.deepEqual(
    repositoryConfigSchema.parse(first.bindings[REPOSITORY_NAME]?.config)
      .working_layer,
    allOn,
  );
  assert.equal(first.bindings[REPOSITORY_NAME]?.revision, FIRST_REVISION);
  const second = await f.write(
    {
      [REPOSITORY_NAME]: {
        kind: BindingKind.Repository,
        config: { ...config, working_layer: { agents_local_md: false } },
      } as Bindings[string],
    },
    first.binding_set_version,
  );
  assert.equal(second.bindings[REPOSITORY_NAME]?.revision, SECOND_REVISION);
  assert.deepEqual(
    (second.bindings[REPOSITORY_NAME]?.config as { working_layer: unknown })
      .working_layer,
    { ...allOn, agents_local_md: false },
  );
});

test("a git-only platform accepts merge_push and refuses a credential or pull_request", async (t) => {
  const address = "git@gitlab.com:acme/api.git";
  const f = writeFixture(t);
  const config = withoutCredential(repositoryBinding(address).config);
  const gitlab = { ...config, platform: RepositoryPlatform.GitLab };
  for (const refused of [
    { ...gitlab, credential: REPOSITORY_CREDENTIAL },
    {
      ...gitlab,
      strategy: {
        ...gitlab.strategy,
        action: {
          name: GitHubAction.PullRequest,
          follows: { type: FollowsType.AssessmentPassed },
        },
      },
    },
  ])
    await rejectsWrite(
      f.write({
        [REPOSITORY_NAME]: { kind: BindingKind.Repository, config: refused },
      }),
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryActionUnsupported,
    );
  const result = await f.write({
    [REPOSITORY_NAME]: {
      kind: BindingKind.Repository,
      config: {
        ...gitlab,
        strategy: {
          ...gitlab.strategy,
          action: {
            name: GitHubAction.MergePush,
            follows: { type: FollowsType.AssessmentPassed },
          },
        },
      },
    },
  });
  assert.equal(
    result.bindings[REPOSITORY_NAME]?.resource_identity,
    GITLAB_IDENTITY,
  );
  assert.deepEqual(
    f.ssh.map((call) => call.address),
    [address],
  );
});

test("the resource check reports an alias-model host, an unpinned host and a legacy key, and skips the read", async (t) => {
  const f = fixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const entries = f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(ALIAS_ADDRESS),
      [SECOND_REPOSITORY_NAME]: repositoryBinding(UNPINNED_ADDRESS),
      legacy: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
    });
    return new Map(
      f.project
        .resourceInventory(tx)
        .map((entry) => [decodeURIComponent(entry.name), entry]),
    );
  });
  f.secrets.set(sshCredentialOf(SECOND_REPOSITORY_ADDRESS), {});
  const context = new CancellationContext(
    background,
    Date.now() + HEALTH_DEADLINE_MS,
  );
  t.after(() => context.cancel());
  const expected = [
    [
      REPOSITORY_NAME,
      ProjectErrorCode.RepositoryAddressInvalid,
      ResourceFailureReason.AddressInvalid,
    ],
    [
      SECOND_REPOSITORY_NAME,
      HOST_KEY_UNPINNED,
      ResourceFailureReason.HostKeyUnknown,
    ],
    ["legacy", SSH_KEY_LEGACY, ResourceFailureReason.IdentityUnavailable],
  ] as const;
  for (const [name, code, failureReason] of expected) {
    const reasons: string[] = [];
    const entry = entries.get(name);
    assert.ok(entry);
    assert.equal(
      await entry.check(context, (reason, observed) =>
        reasons.push(`${reason}:${observed}`),
      ),
      ResourceStatus.Unhealthy,
    );
    assert.deepEqual(reasons, [`${code}:${failureReason}`]);
  }
});

test("SSH failure leaves all rows and the version unchanged without entering commit", async (t) => {
  const failure = new Error("SSH failed");
  let fail = false;
  const addresses: string[] = [];
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote(address, context, timeout) {
        addresses.push(address);
        assert.equal(f.store.database.isTransaction, false);
        assert.equal(context, f.caller.context);
        assert.equal(timeout, LS_REMOTE_TIMEOUT_MS);
        if (fail) throw failure;
      },
    },
  });
  const first = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  const before = f.snapshot();
  const commits = f.commits();
  fail = true;
  await rejectsWrite(
    f.write(
      {
        [REPOSITORY_NAME]: repositoryBinding(),
        [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
        [WORKER_NAME]: workerBinding(),
      },
      first.binding_set_version,
    ),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    { failure_reason: ResourceFailureReason.Unclassified },
  );
  assert.deepEqual(addresses, [REPOSITORY_ADDRESS, SECOND_REPOSITORY_ADDRESS]);
  assert.equal(f.commits(), commits);
  assert.deepEqual(f.snapshot(), before);
});

function unreachableAfterSave(t: TestContext) {
  const state = { fail: false, reads: [] as string[] };
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote(address) {
        state.reads.push(address);
        if (state.fail) throw gitFailure(REPOSITORY_NOT_FOUND_STDERR);
      },
    },
  });
  return { f, state };
}

async function rejectsUnreachable(
  f: ReturnType<typeof writeFixture>,
  bindings: Bindings,
  version: number,
) {
  const before = f.snapshot();
  await rejectsWrite(
    f.write(bindings, version),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    { failure_reason: ResourceFailureReason.RepositoryNotFound },
  );
  assert.deepEqual(f.snapshot(), before);
}

test("an unchanged repository binding with an unreachable address does not block a worker save", async (t) => {
  const { f, state } = unreachableAfterSave(t);
  const first = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  state.fail = true;
  const result = await f.write(
    { [REPOSITORY_NAME]: repositoryBinding(), [WORKER_NAME]: workerBinding() },
    first.binding_set_version,
  );
  assert.deepEqual(state.reads, [REPOSITORY_ADDRESS]);
  assert.deepEqual(
    result.changes.map(({ kind }) => kind),
    [ChangeKind.Unchanged, ChangeKind.Created],
  );
});

test("a changed repository address is read and refused when unreachable", async (t) => {
  const { f, state } = unreachableAfterSave(t);
  const first = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  state.fail = true;
  await rejectsUnreachable(
    f,
    { [REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS) },
    first.binding_set_version,
  );
  assert.deepEqual(state.reads, [
    REPOSITORY_ADDRESS,
    SECOND_REPOSITORY_ADDRESS,
  ]);
});

test("a new repository binding is read and refused when unreachable", async (t) => {
  const { f, state } = unreachableAfterSave(t);
  const first = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  state.fail = true;
  await rejectsUnreachable(
    f,
    {
      [REPOSITORY_NAME]: repositoryBinding(),
      [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
    },
    first.binding_set_version,
  );
  assert.deepEqual(state.reads, [
    REPOSITORY_ADDRESS,
    SECOND_REPOSITORY_ADDRESS,
  ]);
});

test("a repository binding with a changed ssh_credential is read and refused when unreachable", async (t) => {
  const { f, state } = unreachableAfterSave(t);
  const first = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  state.fail = true;
  const binding = repositoryBinding();
  await rejectsUnreachable(
    f,
    {
      [REPOSITORY_NAME]: {
        ...binding,
        config: { ...binding.config, ssh_credential: "ssh-other" },
      },
    },
    first.binding_set_version,
  );
  assert.deepEqual(state.reads, [REPOSITORY_ADDRESS, REPOSITORY_ADDRESS]);
});

test("a save at a stale version reads every repository binding and answers a version conflict", async (t) => {
  const { f, state } = unreachableAfterSave(t);
  const first = await f.write({ [REPOSITORY_NAME]: repositoryBinding() });
  const second = await f.write(
    { [REPOSITORY_NAME]: repositoryBinding(), [WORKER_NAME]: workerBinding() },
    first.binding_set_version,
  );
  await rejectsWrite(
    f.write(
      { [REPOSITORY_NAME]: repositoryBinding() },
      first.binding_set_version,
    ),
    HttpStatus.Conflict,
    ProjectErrorCode.VersionConflict,
    { binding_set_version: second.binding_set_version },
  );
  assert.deepEqual(state.reads, [REPOSITORY_ADDRESS, REPOSITORY_ADDRESS]);
});

test("a refused binding write names the git failure reason in its details", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        throw gitFailure(KEY_REFUSED_STDERR);
      },
    },
  });
  await rejectsWrite(
    f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    { failure_reason: ResourceFailureReason.KeyRefused },
  );
});

test("cancellation during gitLsRemote propagates the context error, whether the connector rejects or resolves", async (t) => {
  for (const rejects of [true, false]) {
    const context = new CancellationContext();
    let calls = NO_CALLS;
    const f = writeFixture(t, {
      repositoryConnector: {
        async gitLsRemote(_address, received) {
          calls++;
          assert.equal(received, context);
          assert.equal(f.store.database.isTransaction, false);
          context.cancel();
          if (rejects) throw new Error("Connector cancelled");
        },
      },
    });
    f.caller.context = context;
    const before = f.snapshot();
    const commits = f.commits();
    await assert.rejects(
      f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
      (error) => error === context.signal.reason,
    );
    assert.equal(calls, ONE_CALL);
    assert.equal(f.commits(), commits);
    assert.deepEqual(f.snapshot(), before);
  }
});

test("instance count and UTF-8 prompt bounds return domain refusals and roll back", async (t) => {
  const f = writeFixture(t);
  const before = f.snapshot();
  for (const instanceCount of [
    INSTANCE_COUNT_MIN - SINGLE_INSTANCE,
    INSTANCE_COUNT_MAX + SINGLE_INSTANCE,
  ]) {
    await rejectsWrite(
      f.write({
        [WORKER_NAME]: {
          ...workerBinding(),
          config: { ...workerBinding().config, instance_count: instanceCount },
        },
      }),
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerInstanceCountRange,
    );
    assert.deepEqual(f.snapshot(), before);
  }
  const projectPrompt = "é".repeat(PROJECT_PROMPT_MAX_BYTES);
  assert.ok(Buffer.byteLength(projectPrompt, UTF8) > PROJECT_PROMPT_MAX_BYTES);
  await rejectsWrite(
    f.write({
      [REPOSITORY_NAME]: {
        ...repositoryBinding(),
        config: {
          ...repositoryBinding().config,
          project_prompt: projectPrompt,
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryPromptTooLarge,
  );
  await rejectsWrite(
    f.write({
      [REPOSITORY_NAME]: {
        ...repositoryBinding(),
        config: {
          ...repositoryBinding().config,
          project_prompt: "a".repeat(PROJECT_PROMPT_MAX_BYTES + ONE_BYTE_OVER),
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryPromptTooLarge,
  );
  assert.deepEqual(f.snapshot(), before);
  assert.deepEqual(
    f.custody,
    Array.from({ length: TWO_CALLS }, () => ({
      credential: sshCredentialOf(REPOSITORY_ADDRESS),
      platform: SSH_CREDENTIAL_PLATFORM,
    })),
  );
  assert.deepEqual(f.entries, []);
  for (const instanceCount of [INSTANCE_COUNT_MIN, INSTANCE_COUNT_MAX]) {
    const version = f.invoke("bindingSet.get", null, f.params).version;
    const result = await f.write(
      {
        [WORKER_NAME]: {
          ...workerBinding(),
          config: { ...workerBinding().config, instance_count: instanceCount },
        },
        [REPOSITORY_NAME]: {
          ...repositoryBinding(),
          config: {
            ...repositoryBinding().config,
            project_prompt: "a".repeat(PROJECT_PROMPT_MAX_BYTES),
          },
        },
      },
      version,
    );
    assertCurrent(f, result);
  }
});

test("unknown workers propagate Worker refusal before external-field validation", async (t) => {
  const failure = new OperationError(
    HttpStatus.BadRequest,
    AgentErrorCode.InvalidConfiguration,
    "Unknown worker",
  );
  const calls: Array<{ worker: string; entry: WorkerEntry | null }> = [];
  const f = writeFixture(t, {
    workerAgentsOf: () => [],
    validateEntry: (tx, worker, entry) => {
      assert.ok(tx.database.isTransaction);
      calls.push({ worker, entry });
      throw failure;
    },
  });
  const before = f.snapshot();
  await assert.rejects(
    f.write({
      [WORKER_NAME]: {
        ...workerBinding(UNKNOWN_WORKER),
        config: { ...workerBinding(UNKNOWN_WORKER).config, entries: [] },
      },
    }),
    (error) => error === failure,
  );
  assert.equal(failure.status, HttpStatus.BadRequest);
  assert.equal(failure.code, AgentErrorCode.InvalidConfiguration);
  assert.deepEqual(calls, [{ worker: UNKNOWN_WORKER, entry: null }]);
  assert.deepEqual(f.snapshot(), before);
});

test("known external workers reject either native field after the null-entry check and accept neither", async (t) => {
  const f = writeFixture(t);
  const before = f.snapshot();
  for (const field of [WorkerField.Entries, WorkerField.ResourceBudget]) {
    const config = {
      ...workerBinding(EXTERNAL_WORKER).config,
      [field]:
        field === WorkerField.Entries
          ? []
          : { turns: SINGLE_INSTANCE, wall_time_ms: SINGLE_INSTANCE },
    };
    await rejectsWrite(
      f.write({ [WORKER_NAME]: { kind: BindingKind.Worker, config } }),
      HttpStatus.BadRequest,
      ProjectErrorCode.WorkerFieldForbidden,
      { binding: WORKER_NAME, field },
    );
    assert.deepEqual(f.snapshot(), before);
  }
  assert.deepEqual(f.entries, [
    { worker: EXTERNAL_WORKER, entry: null },
    { worker: EXTERNAL_WORKER, entry: null },
  ]);
  assert.deepEqual(f.workers, [EXTERNAL_WORKER, EXTERNAL_WORKER]);
  const result = await f.write({
    [WORKER_NAME]: workerBinding(EXTERNAL_WORKER),
  });
  assertCurrent(f, result);
});

test("undeclared agent selectors refuse before calling validateEntry", async (t) => {
  const f = writeFixture(t);
  const before = f.snapshot();
  await rejectsWrite(
    f.write({
      [WORKER_NAME]: {
        ...workerBinding(),
        config: {
          ...workerBinding().config,
          entries: [{ agent: UNKNOWN_AGENT }],
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.WorkerAgentUnknown,
  );
  assert.deepEqual(f.entries, []);
  assert.deepEqual(f.workers, [NATIVE_WORKER]);
  assert.deepEqual(f.snapshot(), before);
});

test("peer validation failures propagate unchanged and roll back the complete set", async (t) => {
  const failure = new OperationError(
    HttpStatus.BadRequest,
    "peer.validation.refused",
    "Refused",
  );
  for (const peer of Object.values(Peer)) {
    const calls: unknown[] = [];
    const f = writeFixture(
      t,
      peer === Peer.Custody
        ? {
            custodySuitability: (tx, request) => {
              assert.ok(tx.database.isTransaction);
              calls.push(request);
              throw failure;
            },
          }
        : {
            validateEntry: (tx, worker, entry) => {
              assert.ok(tx.database.isTransaction);
              calls.push({ worker, entry });
              throw failure;
            },
          },
    );
    const before = f.snapshot();
    await assert.rejects(
      f.write({
        [STORAGE_NAME]: storageBinding(),
        [WORKER_NAME]: workerBinding(),
      }),
      (error) => error === failure,
    );
    assert.equal(calls.length, ONE_CALL);
    assert.deepEqual(f.snapshot(), before);
  }
});

function followingRepository(target?: string) {
  return {
    ...repositoryBinding(),
    config: {
      ...repositoryBinding().config,
      strategy: {
        base_branch: "main",
        action: {
          name: GitHubAction.PullRequest,
          follows:
            target === undefined
              ? { type: FollowsType.AssessmentPassed }
              : { type: FollowsType.ActionEndState, binding: target },
        },
      },
    },
  };
}

function schemaIssues(bindings: unknown) {
  const result = projectOperations["bindingSet.write"].input.safeParse({
    params: { project_id: "project" },
    query: EMPTY_QUERY,
    body: { version: BINDING_SET_INITIAL_VERSION, bindings },
  });
  assert.equal(result.success, false);
  assert.ok(result.error);
  return result.error.issues.map(({ code, path }) => ({ code, path }));
}

function forbiddenFollows(name: string) {
  return {
    code: CUSTOM_ISSUE,
    path: [
      "body",
      "bindings",
      name,
      "config",
      "strategy",
      "action",
      "follows",
      "binding",
    ],
  };
}

test("whole-set schema rejects missing, wrong-kind and actionless follows targets at the reference path", () => {
  for (const target of [
    undefined,
    workerBinding(),
    storageBinding(),
    repositoryBinding(),
  ]) {
    const bindings = {
      [REPOSITORY_NAME]: followingRepository(SECOND_REPOSITORY_NAME),
      ...(target ? { [SECOND_REPOSITORY_NAME]: target } : {}),
    };
    assert.deepEqual(schemaIssues(bindings), [
      forbiddenFollows(REPOSITORY_NAME),
      {
        code: CUSTOM_ISSUE,
        path: [
          "body",
          "bindings",
          REPOSITORY_NAME,
          "config",
          "strategy",
          "action",
          "follows",
          "binding",
        ],
      },
    ]);
  }
});

test("whole-set schema rejects self and multi-binding cycles and duplicate agent selectors with precise paths", () => {
  assert.deepEqual(
    schemaIssues({ [REPOSITORY_NAME]: followingRepository(REPOSITORY_NAME) }),
    [
      forbiddenFollows(REPOSITORY_NAME),
      {
        code: CUSTOM_ISSUE,
        path: [
          "body",
          "bindings",
          REPOSITORY_NAME,
          "config",
          "strategy",
          "action",
          "follows",
          "binding",
        ],
      },
    ],
  );
  assert.deepEqual(
    schemaIssues({
      [REPOSITORY_NAME]: followingRepository(SECOND_REPOSITORY_NAME),
      [SECOND_REPOSITORY_NAME]: followingRepository(REPOSITORY_NAME),
    }),
    [
      forbiddenFollows(REPOSITORY_NAME),
      forbiddenFollows(SECOND_REPOSITORY_NAME),
      {
        code: CUSTOM_ISSUE,
        path: [
          "body",
          "bindings",
          SECOND_REPOSITORY_NAME,
          "config",
          "strategy",
          "action",
          "follows",
          "binding",
        ],
      },
    ],
  );
  assert.deepEqual(
    schemaIssues({
      [WORKER_NAME]: {
        ...workerBinding(),
        config: {
          ...workerBinding().config,
          entries: [{ agent: AGENT }, { agent: AGENT }],
        },
      },
    }),
    [
      {
        code: CUSTOM_ISSUE,
        path: [
          "body",
          "bindings",
          WORKER_NAME,
          "config",
          WorkerField.Entries,
          ONE_CALL,
          "agent",
        ],
      },
    ],
  );
  const valid = bindingSetWriteInputSchema.safeParse({
    version: BINDING_SET_INITIAL_VERSION,
    bindings: {
      [REPOSITORY_NAME]: followingRepository(),
      [SECOND_REPOSITORY_NAME]: followingRepository(),
      [WORKER_NAME]: {
        ...workerBinding(),
        config: {
          ...workerBinding().config,
          entries: [{ agent: AGENT }, { agent: SECOND_AGENT }],
        },
      },
    },
  });
  assert.equal(valid.success, true);
});

test("binding set and binding list reads refuse an absent project", (t) => {
  const f = writeFixture(t);
  const params = { project_id: createIdentity(PROJECT_ID_PREFIX) };
  for (const operation of ["bindingSet.get", "binding.list"] as const)
    refuses(
      () => f.invoke(operation, null, params),
      HttpStatus.NotFound,
      ProjectErrorCode.ProjectNotFound,
    );
  assert.deepEqual(f.invoke("bindingSet.get", null, f.params), {
    version: BINDING_SET_INITIAL_VERSION,
    bindings: {},
  });
  assert.deepEqual(f.invoke("binding.list", null, f.params), {
    items: [],
    next_cursor: null,
  });
});

test("binding reads preserve ownership and paginate filtered current, removed and historical revisions", async (t) => {
  const f = writeFixture(t);
  const first = await f.write({
    [WORKER_NAME]: workerBinding(),
    [STORAGE_NAME]: storageBinding(),
  });
  const pinned = first.bindings[WORKER_NAME]!;
  assert.deepEqual(
    f.invoke("binding.get", null, { ...f.params, binding_id: pinned.id }),
    pinned,
  );
  const second = await f.write(
    {
      [WORKER_NAME]: {
        ...workerBinding(),
        config: { ...workerBinding().config, instance_count: TWO_INSTANCES },
      },
      [STORAGE_NAME]: storageBinding(),
    },
    first.binding_set_version,
  );
  const third = await f.write(
    { [STORAGE_NAME]: storageBinding() },
    second.binding_set_version,
  );
  const removedId = third.changes.find(
    ({ kind }) => kind === ChangeKind.Removed,
  )!.binding_id;
  const removed = f.invoke("binding.get", null, {
    ...f.params,
    binding_id: removedId,
  });
  assert.notEqual(removed.removed_at, null);
  assert.equal(removed.revision, REVISION_THREE);
  assertCurrent(f, third);
  assert.deepEqual(f.invoke("binding.list", null, f.params).items, [
    third.bindings[STORAGE_NAME],
  ]);
  assert.deepEqual(
    f.invoke("binding.list", null, f.params, { state: BindingState.Removed })
      .items,
    [removed],
  );
  assert.deepEqual(
    f.invoke("binding.list", null, f.params, {
      state: BindingState.All,
      kind: BindingKind.Worker,
    }).items,
    [removed],
  );
  assert.deepEqual(
    f.invoke("binding.list", null, f.params, { kind: [BindingKind.Storage] })
      .items,
    [third.bindings[STORAGE_NAME]],
  );
  assert.deepEqual(
    f.invoke("binding.list", null, f.params, { kind: BindingKind.Repository })
      .items,
    [],
  );
  const expected = [removed, third.bindings[STORAGE_NAME]!].sort((a, b) =>
    b.id.localeCompare(a.id),
  );
  let cursor: string | null = null;
  for (const binding of expected) {
    const page: (typeof projectOperations)["binding.list"]["output"]["_output"] =
      f.invoke("binding.list", null, f.params, {
        state: BindingState.All,
        limit: FIRST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
    assert.deepEqual(page.items, [binding]);
    cursor = page.next_cursor;
    if (binding !== expected.at(-FIRST_PAGE_LIMIT))
      assert.equal(cursor, Buffer.from(binding.id).toString(CURSOR_ENCODING));
  }
  assert.equal(cursor, null);
  const params = { ...f.params, binding_id: pinned.id };
  const history = [removed, second.bindings[WORKER_NAME]!, pinned];
  assert.deepEqual(
    f.invoke("bindingRevision.list", null, params).items,
    history,
  );
  assert.deepEqual(
    history.map(({ revision }) => revision),
    [REVISION_THREE, REVISION_TWO, REVISION_ONE],
  );
  for (const binding of history) {
    const page: (typeof projectOperations)["bindingRevision.list"]["output"]["_output"] =
      f.invoke("bindingRevision.list", null, params, {
        limit: FIRST_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
    assert.deepEqual(page.items, [binding]);
    cursor = page.next_cursor;
    if (binding !== history.at(-FIRST_PAGE_LIMIT))
      assert.equal(
        cursor,
        Buffer.from(String(binding.revision)).toString(CURSOR_ENCODING),
      );
  }
  assert.equal(cursor, null);
  const other = f.invoke("create", { name: OTHER_NAME });
  for (const operation of ["binding.get", "bindingRevision.list"] as const) {
    refuses(
      () =>
        f.invoke(operation, null, {
          ...f.params,
          binding_id: createIdentity(BINDING_ID_PREFIX),
        }),
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
    );
    refuses(
      () =>
        f.invoke(operation, null, {
          project_id: other.id,
          binding_id: pinned.id,
        }),
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
    );
  }
  assert.deepEqual(f.invoke("binding.get", null, params), pinned);
});

test("agent views page sorted declarations and copy worker views with stripped entries", async (t) => {
  const calls: Array<{ agent: string; entry: WorkerEntry | null }> = [];
  const defaults = {
    agent_provider: "default",
    model_identifier: MODEL,
    reasoning_effort: "low",
  };
  const effective = {
    ...defaults,
    provider: "provider",
    credential: "credential",
  };
  const issues = [{ path: ["model_identifier"], code: "example.issue" }];
  const view = {
    defaults,
    effective,
    chain: [],
    active_position: null,
    cooling: null,
    valid: false,
    issues,
  };
  const f = writeFixture(t, {
    workerAgentsOf: (worker) => {
      assert.equal(worker, NATIVE_WORKER);
      assert.ok(f.store.database.isTransaction);
      return [THIRD_AGENT, AGENT, SECOND_AGENT];
    },
    workerAgentView: (tx, worker, agent, entry) => {
      assert.equal(tx.database, f.store.database);
      assert.equal(worker, NATIVE_WORKER);
      assert.ok(tx.database.isTransaction);
      calls.push({ agent, entry });
      return view;
    },
  });
  const result = await f.write({
    [WORKER_NAME]: {
      kind: BindingKind.Worker,
      config: {
        worker: NATIVE_WORKER,
        instance_count: SINGLE_INSTANCE,
        placement: WorkerPlacement.Server,
        entries: [{ agent: SECOND_AGENT, model_identifier: MODEL }],
      },
    },
  });
  const bindingId = result.bindings[WORKER_NAME]!.id;
  const params = { ...f.params, binding_id: bindingId };
  const expected = (agent: string, entry: WorkerEntry | null) => ({
    agent,
    worker: NATIVE_WORKER,
    worker_binding_id: bindingId,
    binding_set_version: result.binding_set_version,
    ...view,
    entry,
  });
  const before = f.commits();
  const first = f.invoke("agentConfiguration.list", null, params, {
    limit: AGENT_PAGE_LIMIT,
  });
  assert.deepEqual(first, {
    items: [
      expected(AGENT, null),
      expected(SECOND_AGENT, { model_identifier: MODEL }),
    ],
    next_cursor: Buffer.from(SECOND_AGENT).toString(CURSOR_ENCODING),
  });
  const last = f.invoke("agentConfiguration.list", null, params, {
    limit: AGENT_PAGE_LIMIT,
    cursor: first.next_cursor!,
  });
  assert.deepEqual(last, {
    items: [expected(THIRD_AGENT, null)],
    next_cursor: null,
  });
  assert.deepEqual(
    f.invoke("agentConfiguration.get", null, {
      ...params,
      agent_name: SECOND_AGENT,
    }),
    expected(SECOND_AGENT, { model_identifier: MODEL }),
  );
  assert.deepEqual(calls, [
    { agent: AGENT, entry: null },
    { agent: SECOND_AGENT, entry: { model_identifier: MODEL } },
    { agent: THIRD_AGENT, entry: null },
    { agent: SECOND_AGENT, entry: { model_identifier: MODEL } },
  ]);
  assert.equal(f.commits(), before + REVISION_THREE);
  for (const cursor of [MALFORMED_CURSOR, `${first.next_cursor}=`])
    refuses(
      () => f.invoke("agentConfiguration.list", null, params, { cursor }),
      HttpStatus.BadRequest,
      ProjectErrorCode.CursorInvalid,
    );
  refuses(
    () =>
      f.invoke("agentConfiguration.get", null, {
        ...params,
        agent_name: UNKNOWN_AGENT,
      }),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
});

test("agent views reject missing, foreign and non-worker bindings; external list is empty", async (t) => {
  const f = writeFixture(t, {
    workerAgentsOf: (worker) => {
      assert.equal(worker, EXTERNAL_WORKER);
      return [];
    },
    workerAgentView: unexpected,
  });
  const result = await f.write({
    [WORKER_NAME]: workerBinding(EXTERNAL_WORKER),
    [STORAGE_NAME]: storageBinding(),
  });
  const workerId = result.bindings[WORKER_NAME]!.id;
  const params = { ...f.params, binding_id: workerId };
  assert.deepEqual(f.invoke("agentConfiguration.list", null, params), {
    items: [],
    next_cursor: null,
  });
  const missingProject = {
    ...params,
    project_id: createIdentity(PROJECT_ID_PREFIX),
  };
  const other = f.invoke("create", { name: OTHER_NAME });
  const foreign = { ...params, project_id: other.id };
  const absent = { ...params, binding_id: createIdentity(BINDING_ID_PREFIX) };
  const nonWorker = {
    ...params,
    binding_id: result.bindings[STORAGE_NAME]!.id,
  };
  for (const operation of [
    "agentConfiguration.list",
    "agentConfiguration.get",
  ] as const) {
    const input: Record<string, string> =
      operation === AGENT_GET_KEY ? { agent_name: AGENT } : {};
    refuses(
      () => f.invoke(operation, null, { ...missingProject, ...input }),
      HttpStatus.NotFound,
      ProjectErrorCode.ProjectNotFound,
    );
    for (const rejected of [foreign, absent, nonWorker])
      refuses(
        () => f.invoke(operation, null, { ...rejected, ...input }),
        HttpStatus.NotFound,
        ProjectErrorCode.BindingNotFound,
      );
  }
});

const LIVE_NODE = "node-live";
const MISSING_NAME = "missing";
const ROTATED_CREDENTIAL = "rotated-key";
const ENTRY_PROVIDER = "provider";
const ENTRY_REASONING = "high";

function persistBindings(
  tx: Transaction,
  projectId: string,
  bindings: Record<string, { kind: string; config: unknown }>,
) {
  assert.ok(tx.database.isTransaction);
  const project = requireProject(tx, projectId);
  const result = writeBindingSet(
    tx,
    projectId,
    project.binding_set_version,
    new Map(Object.entries(bindings)),
  );
  assert.ok(result.newVersion >= project.binding_set_version);
  return {
    ...result,
    bindings: Object.fromEntries(readCurrentBindingSet(tx, projectId)),
  };
}

test("resource inventory reads current repository revisions and excludes removed and non-repository bindings", (t) => {
  let calls = NO_CALLS;
  const f = fixture(t, {
    repositoryConnector: {
      async gitLsRemote() {
        calls++;
      },
    },
  });
  const entries = f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const removed = insertProject(tx, OTHER_NAME);
    persistBindings(tx, removed.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    });
    persistBindings(tx, removed.id, {});
    persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
      [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
      [WORKER_NAME]: workerBinding(),
      [STORAGE_NAME]: storageBinding(),
    });
    persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: {
        ...repositoryBinding(),
        config: { ...repositoryBinding().config, available: false },
      },
      [SECOND_REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
      [WORKER_NAME]: workerBinding(),
      [STORAGE_NAME]: storageBinding(),
    });
    return f.project.resourceInventory(tx);
  });
  assert.equal(calls, NO_CALLS);
  assert.equal(entries.length, TWO_CALLS);
  assert.deepEqual(
    entries
      .map(({ scope, project, name, target, capability }) => ({
        scope,
        project,
        name,
        target,
        capability,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: REPOSITORY_NAME, address: REPOSITORY_ADDRESS },
      { name: SECOND_REPOSITORY_NAME, address: SECOND_REPOSITORY_ADDRESS },
    ]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, address }) => ({
        scope: HealthScope.Project,
        project: PROJECT_NAME,
        name: encodeURIComponent(name),
        target: `${RESOURCE_TARGET_KIND_REPOSITORY}:${address}`,
        capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
      })),
  );
  assert.equal(entries[NO_ITEMS]?.check instanceof Function, true);
});

test("resource checks pass the caller deadline and distinguish success, failure and cancellation", async (t) => {
  let calls = NO_CALLS;
  let failure: Error | null = null;
  const f = fixture(t, {
    repositoryConnector: {
      async gitLsRemote(address, context, remaining) {
        calls++;
        assert.equal(address, REPOSITORY_ADDRESS);
        const deadline = context.deadline;
        assert.ok(deadline !== null);
        assert.ok(remaining > NO_ITEMS);
        assert.ok(remaining <= deadline - beforeCall);
        assert.equal(f.store.database.isTransaction, false);
        if (context.signal.aborted) throw context.signal.reason;
        if (failure) throw failure;
      },
    },
  });
  const { entry, bindingId } = f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, project.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return {
      entry: f.project.resourceInventory(tx)[NO_ITEMS],
      bindingId: readCurrentBindingSet(tx, project.id).get(REPOSITORY_NAME)?.id,
    };
  });
  assert.ok(entry);
  assert.equal(calls, NO_CALLS);
  let beforeCall = Date.now();
  const context = new CancellationContext(
    background,
    beforeCall + HEALTH_DEADLINE_MS,
  );
  t.after(() => context.cancel());
  assert.equal(await entry.check(context), ResourceStatus.Healthy);
  failure = gitFailure(REPOSITORY_NOT_FOUND_STDERR);
  beforeCall = Date.now();
  const observed: string[] = [];
  assert.equal(
    await entry.check(context, (reason, failureReason) =>
      observed.push(`${reason}:${failureReason}`),
    ),
    ResourceStatus.Unhealthy,
  );
  assert.deepEqual(observed, [
    `${ProjectErrorCode.RepositorySshUnreachable}:${ResourceFailureReason.RepositoryNotFound}`,
  ]);
  const cancelled = new CancellationContext(
    background,
    Date.now() + HEALTH_DEADLINE_MS,
  );
  t.after(() => cancelled.cancel());
  cancelled.cancel();
  beforeCall = Date.now();
  assert.equal(await entry.check(cancelled), ResourceStatus.Unknown);
  assert.equal(calls, TWO_CALLS);
  assert.deepEqual(
    f.releases.map(({ identity, subject }) => ({ identity, subject })),
    [TWO_CALLS, TWO_CALLS].map(() => ({
      identity: PROJECT_IDENTITY,
      subject: { kind: SshIdentitySubjectKind.Binding, binding_id: bindingId },
    })),
  );
});

test("resource inventory keeps separate checks for the same repository address across projects", async (t) => {
  let calls = NO_CALLS;
  const f = fixture(t, {
    repositoryConnector: {
      async gitLsRemote(address, context, remaining) {
        calls++;
        assert.equal(address, REPOSITORY_ADDRESS);
        assert.ok(context.deadline !== null);
        assert.ok(remaining > NO_ITEMS);
      },
    },
  });
  const entries = f.store.transaction((tx) => {
    for (const name of [PROJECT_NAME, OTHER_NAME]) {
      const project = insertProject(tx, name);
      persistBindings(tx, project.id, {
        [REPOSITORY_NAME]: repositoryBinding(),
      });
    }
    return f.project.resourceInventory(tx);
  });
  assert.equal(calls, NO_CALLS);
  assert.equal(entries.length, TWO_CALLS);
  assert.deepEqual(
    new Set(entries.map((entry) => entry.project)),
    new Set([PROJECT_NAME, OTHER_NAME]),
  );
  assert.notEqual(entries[NO_ITEMS]?.check, entries[ONE_CALL]?.check);
  const context = new CancellationContext(
    background,
    Date.now() + HEALTH_DEADLINE_MS,
  );
  t.after(() => context.cancel());
  for (const entry of entries) {
    assert.equal(await entry.check(context), ResourceStatus.Healthy);
    assert.ok(calls <= TWO_CALLS);
  }
  assert.equal(calls, TWO_CALLS);
});

test("entriesOfAgent selects latest workers across projects, strips selectors and preserves null and empty entries", (t) => {
  const workers: string[] = [];
  const f = fixture(t, {
    workerAgentsOf: (worker) => {
      workers.push(worker);
      return worker === NATIVE_WORKER ? [AGENT, SECOND_AGENT] : [THIRD_AGENT];
    },
  });
  f.store.transaction((tx) => {
    const first = insertProject(tx, PROJECT_NAME);
    const second = insertProject(tx, OTHER_NAME);
    const entry = {
      agent_provider: ENTRY_PROVIDER,
      model_identifier: MODEL,
      reasoning_effort: ENTRY_REASONING,
    };
    persistBindings(tx, first.id, { [WORKER_NAME]: workerBinding() });
    const explicit = persistBindings(tx, first.id, {
      [WORKER_NAME]: {
        kind: BindingKind.Worker,
        config: {
          ...workerBinding().config,
          instance_count: INSTANCE_COUNT_MIN,
          entries: [{ agent: SECOND_AGENT }, { agent: AGENT, ...entry }],
        },
      },
      [REPOSITORY_NAME]: repositoryBinding(),
      [STORAGE_NAME]: storageBinding(),
    }).bindings[WORKER_NAME]!;
    persistBindings(tx, second.id, { removed: workerBinding() });
    const implicit = persistBindings(tx, second.id, {
      [WORKER_NAME]: workerBinding(),
      unrelated: workerBinding(OTHER_WORKER),
    }).bindings[WORKER_NAME]!;
    assert.deepEqual(
      new Map(
        f.project
          .entriesOfAgent(tx, AGENT)
          .map((item) => [item.binding_id, item]),
      ),
      new Map([
        [
          explicit.id,
          {
            binding_id: explicit.id,
            worker_name: NATIVE_WORKER,
            entry,
            holders: [SERVER_HOLDER],
          },
        ],
        [
          implicit.id,
          {
            binding_id: implicit.id,
            worker_name: NATIVE_WORKER,
            entry: null,
            holders: [SERVER_HOLDER],
          },
        ],
      ]),
    );
    assert.deepEqual(
      workers.sort(),
      [NATIVE_WORKER, NATIVE_WORKER, OTHER_WORKER].sort(),
    );
    assert.deepEqual(
      f.project
        .entriesOfAgent(tx, SECOND_AGENT)
        .find(({ binding_id }) => binding_id === explicit.id)?.entry,
      {},
    );
    assert.deepEqual(f.project.entriesOfAgent(tx, UNKNOWN_AGENT), []);
  });
});

test("bindingsNaming finds exact credential keys at any depth across projects and deduplicates current rows without checking pins", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const first = insertProject(tx, PROJECT_NAME);
    const second = insertProject(tx, OTHER_NAME);
    const repository = persistBindings(tx, first.id, {
      [REPOSITORY_NAME]: {
        ...repositoryBinding(),
        config: {
          ...repositoryBinding().config,
          credential: ROTATED_CREDENTIAL,
          nested: {
            items: [
              { credential: REPOSITORY_CREDENTIAL },
              { credential: REPOSITORY_CREDENTIAL },
            ],
          },
        },
      },
      unrelated: {
        ...storageBinding(),
        config: {
          ...storageBinding().config,
          description: REPOSITORY_CREDENTIAL,
          credentials: REPOSITORY_CREDENTIAL,
        },
      },
    }).bindings[REPOSITORY_NAME]!;
    const storage = persistBindings(tx, second.id, {
      [STORAGE_NAME]: {
        ...storageBinding(),
        config: {
          ...storageBinding().config,
          available: false,
          nested: [{ deeper: { credential: REPOSITORY_CREDENTIAL } }],
        },
      },
    }).bindings[STORAGE_NAME]!;
    const results = f.project.bindingsNaming(tx, REPOSITORY_CREDENTIAL);
    assert.deepEqual(
      new Set(results.map(({ binding_id }) => binding_id)),
      new Set([repository.id, storage.id]),
    );
    assert.equal(results.length, TWO_CALLS);
    assert.deepEqual(
      results.find(({ binding_id }) => binding_id === repository.id),
      {
        binding_id: repository.id,
        project_id: first.id,
        project_name: PROJECT_NAME,
        name: REPOSITORY_NAME,
      },
    );
    assert.deepEqual(
      results.find(({ binding_id }) => binding_id === storage.id),
      {
        binding_id: storage.id,
        project_id: second.id,
        project_name: OTHER_NAME,
        name: STORAGE_NAME,
      },
    );
    assert.deepEqual(f.project.bindingsNaming(tx, MISSING_NAME), []);
  });
});

test("bindingsNaming checks only matching older live revisions and frees dependencies after nodes rebind", (t) => {
  const calls: string[] = [];
  const pinned = new Set<string>();
  let callerTransaction: Transaction;
  const f = fixture(t, {
    liveNodesPinning: (tx, bindingId) => {
      assert.equal(tx, callerTransaction);
      assert.ok(tx.database.isTransaction);
      calls.push(bindingId);
      return pinned.has(bindingId) ? [LIVE_NODE] : [];
    },
  });
  f.store.transaction((tx) => {
    callerTransaction = tx;
    const project = insertProject(tx, PROJECT_NAME);
    const original = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    const rotated = {
      ...repositoryBinding(),
      config: { ...repositoryBinding().config, credential: ROTATED_CREDENTIAL },
    };
    const middle = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: rotated,
    }).bindings[REPOSITORY_NAME]!;
    const latest = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    pinned.add(original.id);
    pinned.add(middle.id);
    assert.deepEqual(
      new Set(
        f.project
          .bindingsNaming(tx, REPOSITORY_CREDENTIAL)
          .map(({ binding_id }) => binding_id),
      ),
      new Set([original.id, latest.id]),
    );
    assert.deepEqual(calls, [original.id]);
    calls.length = NO_CALLS;
    pinned.clear();
    assert.deepEqual(f.project.bindingsNaming(tx, REPOSITORY_CREDENTIAL), [
      {
        binding_id: latest.id,
        project_id: project.id,
        project_name: PROJECT_NAME,
        name: REPOSITORY_NAME,
      },
    ]);
    assert.deepEqual(calls, [original.id]);
  });
});

test("bindingsNaming excludes tombstones and earlier pins even after the group is rebound", (t) => {
  const calls: string[] = [];
  const f = fixture(t, {
    liveNodesPinning: (_tx, bindingId) => {
      calls.push(bindingId);
      return [LIVE_NODE];
    },
  });
  f.store.transaction((tx) => {
    const first = insertProject(tx, PROJECT_NAME);
    const second = insertProject(tx, OTHER_NAME);
    persistBindings(tx, first.id, { [REPOSITORY_NAME]: repositoryBinding() });
    persistBindings(tx, second.id, { [REPOSITORY_NAME]: repositoryBinding() });
    persistBindings(tx, first.id, {});
    persistBindings(tx, second.id, {});
    assert.deepEqual(f.project.bindingsNaming(tx, REPOSITORY_CREDENTIAL), []);
    const rebound = persistBindings(tx, first.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    assert.deepEqual(f.project.bindingsNaming(tx, REPOSITORY_CREDENTIAL), [
      {
        binding_id: rebound.id,
        project_id: first.id,
        project_name: PROJECT_NAME,
        name: REPOSITORY_NAME,
      },
    ]);
    assert.deepEqual(calls, []);
  });
});

test("resolveBinding selects the latest named group in its project after revision, replacement and removal", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const first = insertProject(tx, PROJECT_NAME);
    const second = insertProject(tx, OTHER_NAME);
    const other = persistBindings(tx, second.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    for (const binding of [
      repositoryBinding(),
      {
        ...repositoryBinding(),
        config: { ...repositoryBinding().config, available: false },
      },
      repositoryBinding(SECOND_REPOSITORY_ADDRESS),
    ]) {
      const current = persistBindings(tx, first.id, {
        [REPOSITORY_NAME]: binding,
      }).bindings[REPOSITORY_NAME]!;
      assert.deepEqual(
        f.project.resolveBinding(tx, first.id, REPOSITORY_NAME),
        {
          binding_id: current.id,
          resource_identity: current.resource_identity,
        },
      );
      assert.deepEqual(
        f.project.resolveBinding(tx, second.id, REPOSITORY_NAME),
        { binding_id: other.id, resource_identity: other.resource_identity },
      );
    }
    assert.equal(f.project.resolveBinding(tx, first.id, MISSING_NAME), null);
    assert.equal(
      f.project.resolveBinding(tx, MISSING_NAME, REPOSITORY_NAME),
      null,
    );
    persistBindings(tx, first.id, {});
    assert.equal(f.project.resolveBinding(tx, first.id, REPOSITORY_NAME), null);
  });
});

test("resolveBindingIdentity pins the latest revision of a live binding of its project", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const first = insertProject(tx, PROJECT_NAME);
    const second = insertProject(tx, OTHER_NAME);
    const other = persistBindings(tx, second.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    const older = persistBindings(tx, first.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    const latest = persistBindings(tx, first.id, {
      [REPOSITORY_NAME]: {
        ...repositoryBinding(),
        config: { ...repositoryBinding().config, available: false },
      },
    }).bindings[REPOSITORY_NAME]!;
    assert.notEqual(older.id, latest.id);
    for (const id of [older.id, latest.id])
      assert.deepEqual(f.project.resolveBindingIdentity(tx, first.id, id), {
        binding_id: latest.id,
        resource_identity: latest.resource_identity,
      });
    assert.equal(
      f.project.resolveBindingIdentity(tx, first.id, other.id),
      null,
    );
    assert.equal(
      f.project.resolveBindingIdentity(tx, first.id, REPOSITORY_NAME),
      null,
    );
    const replacement = persistBindings(tx, first.id, {
      [REPOSITORY_NAME]: repositoryBinding(SECOND_REPOSITORY_ADDRESS),
    }).bindings[REPOSITORY_NAME]!;
    assert.equal(
      f.project.resolveBindingIdentity(tx, first.id, latest.id),
      null,
    );
    assert.equal(
      f.project.resolveBindingIdentity(tx, first.id, replacement.id)
        ?.binding_id,
      replacement.id,
    );
    persistBindings(tx, first.id, {});
    assert.equal(
      f.project.resolveBindingIdentity(tx, first.id, replacement.id),
      null,
    );
  });
});

test("resolveBindingIdentity refuses an identity from before a removal of the binding", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const before = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    persistBindings(tx, project.id, {});
    const added = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    const latest = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: {
        ...repositoryBinding(),
        config: { ...repositoryBinding().config, available: false },
      },
    }).bindings[REPOSITORY_NAME]!;
    assert.equal(added.resource_identity, before.resource_identity);
    assert.equal(
      f.project.resolveBindingIdentity(tx, project.id, before.id),
      null,
    );
    for (const id of [added.id, latest.id])
      assert.deepEqual(f.project.resolveBindingIdentity(tx, project.id, id), {
        binding_id: latest.id,
        resource_identity: latest.resource_identity,
      });
  });
});

test("storageBindingOf reads the pinned configuration after a prefix revision", (t) => {
  const f = fixture(t);
  const prefix = "later";
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const original = storageBinding();
    const pinned = persistBindings(tx, project.id, {
      [STORAGE_NAME]: original,
    }).bindings[STORAGE_NAME]!;
    const later = persistBindings(tx, project.id, {
      [STORAGE_NAME]: { ...original, config: { ...original.config, prefix } },
    }).bindings[STORAGE_NAME]!;
    assert.notEqual(pinned.id, later.id);
    assert.deepEqual(f.project.storageBindingOf(tx, pinned.id), {
      binding_id: pinned.id,
      project_id: project.id,
      ...original.config,
    });
    assert.equal(f.project.storageBindingOf(tx, later.id)?.prefix, prefix);
  });
});

test("storageBindingOf refuses a repository binding", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const row = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!;
    assert.equal(f.project.storageBindingOf(tx, row.id), null);
    assert.ok(tx.database.isTransaction);
  });
});

test("storageBindingOf answers null for an unknown identity", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    assert.equal(f.project.storageBindingOf(tx, MISSING_NAME), null);
    assert.ok(tx.database.isTransaction);
  });
});

test("storageBindingOf shares the caller transaction and rollback", (t) => {
  const f = fixture(t);
  const failure = new Error("Caller rollback");
  let bindingId = MISSING_NAME;
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        const project = insertProject(tx, PROJECT_NAME);
        bindingId = persistBindings(tx, project.id, {
          [STORAGE_NAME]: storageBinding(),
        }).bindings[STORAGE_NAME]!.id;
        const nested = t.mock.method(f.store, "transaction", unexpected);
        assert.equal(
          f.project.storageBindingOf(tx, bindingId)?.binding_id,
          bindingId,
        );
        assert.equal(nested.mock.callCount(), NO_CALLS);
        nested.mock.restore();
        assert.ok(tx.database.isTransaction);
        throw failure;
      }),
    (error) => error === failure,
  );
  f.store.transaction((tx) => {
    assert.equal(f.project.storageBindingOf(tx, bindingId), null);
    assert.ok(tx.database.isTransaction);
  });
});

test("workerBindingRowOf retains the pinned configuration in the caller transaction", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const original = workerBinding();
    const pinned = persistBindings(tx, project.id, {
      [WORKER_NAME]: original,
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings;
    const entries = [
      {
        agent: "swe@1",
        agent_provider: "default",
        model_identifier: "claude-sonnet-4-5",
        reasoning_effort: "off",
      },
    ];
    persistBindings(tx, project.id, {
      [WORKER_NAME]: { ...original, config: { ...original.config, entries } },
    });
    const nested = t.mock.method(f.store, "transaction", unexpected);
    assert.deepEqual(
      f.project.workerBindingRowOf(tx, pinned[WORKER_NAME]!.id),
      {
        binding_id: pinned[WORKER_NAME]!.id,
        project_id: project.id,
        worker_name: original.config.worker,
        resource_identity: pinned[WORKER_NAME]!.resource_identity,
        tombstone: false,
        disabled: false,
        placement: WorkerPlacement.Server,
        worker_instances: [],
        environment: null,
        entries: [],
        resource_budget: null,
      },
    );
    assert.equal(
      f.project.workerBindingRowOf(tx, pinned[REPOSITORY_NAME]!.id),
      null,
    );
    assert.equal(f.project.workerBindingRowOf(tx, MISSING_NAME), null);
    assert.equal(nested.mock.callCount(), NO_CALLS);
    nested.mock.restore();
  });
});

test("repositoryPolicyOf preserves the named revision after a strategy change", (t) => {
  const f = fixture(t);
  const baseBranch = "develop";
  const projectPrompt = "Follow the repository conventions.";
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const original = repositoryBinding();
    original.config.strategy.action = {
      name: GitHubAction.PullRequest,
      follows: { type: FollowsType.AssessmentPassed },
    };
    original.config.project_prompt = projectPrompt;
    const pinned = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: original,
    }).bindings[REPOSITORY_NAME]!;
    const later = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: {
        ...original,
        config: {
          ...original.config,
          strategy: {
            base_branch: baseBranch,
            action: {
              name: GitHubAction.MergePush,
              follows: { type: FollowsType.AssessmentPassed },
            },
          },
        },
      },
    }).bindings[REPOSITORY_NAME]!;
    assert.notEqual(pinned.id, later.id);
    assert.deepEqual(f.project.repositoryPolicyOf(tx, pinned.id), {
      binding_id: pinned.id,
      resource_identity: pinned.resource_identity,
      project_id: project.id,
      name: REPOSITORY_NAME,
      address: original.config.address,
      platform: original.config.platform,
      ssh_credential: original.config.ssh_credential,
      credential: original.config.credential,
      base_branch: original.config.strategy.base_branch,
      action: GitHubAction.PullRequest,
      landing: Landing.Human,
      project_prompt: projectPrompt,
      working_layer: original.config.working_layer,
      environment: null,
      repository_environment: true,
    });
    const latest = f.project.repositoryPolicyOf(tx, later.id);
    assert.equal(latest?.action, GitHubAction.MergePush);
    assert.equal(latest?.base_branch, baseBranch);
  });
});

test("a working layer switch change inserts the next binding revision and the policy keeps the pinned map", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const original = repositoryBinding();
    const pinned = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: original,
    }).bindings[REPOSITORY_NAME]!;
    const switched = {
      ...original,
      config: {
        ...original.config,
        working_layer: {
          ...original.config.working_layer,
          claude_md: false,
          project_prompt: false,
        },
      },
    };
    const later = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: switched,
    }).bindings[REPOSITORY_NAME]!;
    assert.equal(later.revision, pinned.revision + 1);
    assert.deepEqual(
      f.project.repositoryPolicyOf(tx, pinned.id)?.working_layer,
      {
        agents_md: true,
        agents_local_md: true,
        claude_md: true,
        claude_local_md: true,
        project_prompt: true,
      },
    );
    assert.deepEqual(
      f.project.repositoryPolicyOf(tx, later.id)?.working_layer,
      {
        agents_md: true,
        agents_local_md: true,
        claude_md: false,
        claude_local_md: true,
        project_prompt: false,
      },
    );
  });
});

test("a repository config without working_layer parses with every switch on and a partial map fills the rest", () => {
  const config = withoutWorkingLayer(repositoryBinding().config);
  const allOn = {
    agents_md: true,
    agents_local_md: true,
    claude_md: true,
    claude_local_md: true,
    project_prompt: true,
  };
  assert.deepEqual(repositoryConfigSchema.parse(config).working_layer, allOn);
  assert.deepEqual(
    repositoryConfigSchema.parse({
      ...config,
      working_layer: { agents_md: false },
    }).working_layer,
    { ...allOn, agents_md: false },
  );
  assert.throws(() =>
    repositoryConfigSchema.parse({
      ...config,
      working_layer: { agents: false },
    }),
  );
});

test("repositoryPolicyOf answers null for an absent or nonrepository binding", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const rows = persistBindings(tx, project.id, {
      [WORKER_NAME]: workerBinding(),
      [STORAGE_NAME]: storageBinding(),
    }).bindings;
    assert.equal(f.project.repositoryPolicyOf(tx, MISSING_NAME), null);
    assert.equal(f.project.repositoryPolicyOf(tx, rows[WORKER_NAME]!.id), null);
    assert.equal(
      f.project.repositoryPolicyOf(tx, rows[STORAGE_NAME]!.id),
      null,
    );
  });
});

test("repositoryPolicyOf shares the caller transaction and does not retain rolled-back rows", (t) => {
  const f = fixture(t);
  const failure = new Error("Caller rollback");
  let bindingId = MISSING_NAME;
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        const project = insertProject(tx, PROJECT_NAME);
        bindingId = persistBindings(tx, project.id, {
          [REPOSITORY_NAME]: repositoryBinding(),
        }).bindings[REPOSITORY_NAME]!.id;
        const nested = t.mock.method(f.store, "transaction", unexpected);
        const policy = f.project.repositoryPolicyOf(tx, bindingId);
        assert.ok(policy);
        assert.equal(policy.binding_id, bindingId);
        assert.equal(policy.action, null);
        assert.equal(policy.project_prompt, null);
        assert.equal(nested.mock.callCount(), NO_CALLS);
        nested.mock.restore();
        assert.ok(tx.database.isTransaction);
        throw failure;
      }),
    (error) => error === failure,
  );
  f.store.transaction((tx) => {
    assert.equal(f.project.repositoryPolicyOf(tx, bindingId), null);
    assert.equal(f.store.database.isTransaction, true);
  });
});

test("getBindingRevision keeps pinned fields and derives disablement from the latest row for every kind", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    const original = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
      [WORKER_NAME]: workerBinding(),
      [STORAGE_NAME]: storageBinding(),
    }).bindings;
    assert.equal(f.project.getBindingRevision(tx, MISSING_NAME), null);
    for (const disabled of [false, true, false]) {
      persistBindings(tx, project.id, {
        [REPOSITORY_NAME]: {
          ...repositoryBinding(),
          config: { ...repositoryBinding().config, available: !disabled },
        },
        [WORKER_NAME]: {
          ...workerBinding(),
          config: {
            ...workerBinding().config,
            instance_count: disabled ? INSTANCE_COUNT_MIN : SINGLE_INSTANCE,
          },
        },
        [STORAGE_NAME]: {
          ...storageBinding(),
          config: { ...storageBinding().config, available: !disabled },
        },
      });
      for (const row of Object.values(original))
        assert.deepEqual(f.project.getBindingRevision(tx, row.id), {
          project_id: project.id,
          binding_id: row.id,
          name: row.name,
          resource_identity: row.resource_identity,
          revision: REVISION_ONE,
          tombstone: false,
          disabled,
        });
    }
  });
});

test("getBindingRevision marks removed rows and preceding pins without reviving them on rebind or affecting another project", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    const first = insertProject(tx, PROJECT_NAME);
    const second = insertProject(tx, OTHER_NAME);
    const old = persistBindings(tx, first.id, {
      [WORKER_NAME]: workerBinding(),
    }).bindings[WORKER_NAME]!;
    const other = persistBindings(tx, second.id, {
      [WORKER_NAME]: workerBinding(),
    }).bindings[WORKER_NAME]!;
    const removed = persistBindings(tx, first.id, {}).changes.find(
      ({ kind }) => kind === ChangeKind.Removed,
    )!;
    assert.equal(f.project.getBindingRevision(tx, old.id)?.tombstone, true);
    assert.equal(
      f.project.getBindingRevision(tx, removed.binding_id)?.tombstone,
      true,
    );
    const rebound = persistBindings(tx, first.id, {
      [WORKER_NAME]: {
        ...workerBinding(),
        config: {
          ...workerBinding().config,
          instance_count: INSTANCE_COUNT_MIN,
        },
      },
    }).bindings[WORKER_NAME]!;
    assert.equal(f.project.getBindingRevision(tx, old.id)?.tombstone, true);
    assert.equal(f.project.getBindingRevision(tx, old.id)?.disabled, true);
    assert.equal(
      f.project.getBindingRevision(tx, removed.binding_id)?.tombstone,
      true,
    );
    assert.equal(
      f.project.getBindingRevision(tx, rebound.id)?.tombstone,
      false,
    );
    assert.equal(f.project.getBindingRevision(tx, other.id)?.tombstone, false);
    assert.equal(f.project.getBindingRevision(tx, other.id)?.disabled, false);
  });
});

test("collaborations read uncommitted rows without opening or committing a transaction or calling the network", (t) => {
  const f = fixture(t, { workerAgentsOf: () => [AGENT] });
  const failure = new Error("Caller rollback");
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        const project = insertProject(tx, PROJECT_NAME);
        const current = persistBindings(tx, project.id, {
          [WORKER_NAME]: workerBinding(),
          [REPOSITORY_NAME]: repositoryBinding(),
        }).bindings;
        assert.equal(f.project.entriesOfAgent(tx, AGENT).length, ONE_CALL);
        assert.equal(
          f.project.bindingsNaming(tx, REPOSITORY_CREDENTIAL).length,
          ONE_CALL,
        );
        assert.equal(
          f.project.resolveBinding(tx, project.id, WORKER_NAME)?.binding_id,
          current[WORKER_NAME]!.id,
        );
        assert.equal(
          f.project.getBindingRevision(tx, current[WORKER_NAME]!.id)?.tombstone,
          false,
        );
        assert.ok(tx.database.isTransaction);
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.deepEqual(f.invoke("list").items, []);
  assert.equal(f.store.database.isTransaction, false);
});

const BINDING_VERIFY_TIMEOUT = BINDING_CHECK_TIMEOUT_MS;
const CREDENTIAL_NOT_FOUND = "credential.credential.not_found";
const PLATFORM_ACTION_CAPABILITY = "platform action";
const ADDRESS_SSH_FAIL = "ssh_fail";
const CREDENTIAL_REFUSAL = "refusal";
const ADDRESS_SSH_HANG = "ssh_hang";
const CREDENTIAL_HEALTHY: BindingCheckEntry = {
  status: ResourceStatus.Healthy,
  capability: PLATFORM_ACTION_CAPABILITY,
  failure_reason: null,
};

function verifyFixture(
  t: TestContext,
  addressBehavior:
    "healthy" | typeof ADDRESS_SSH_FAIL | typeof ADDRESS_SSH_HANG,
  credentialBehavior: "healthy" | typeof CREDENTIAL_REFUSAL,
  overrides: Partial<Dependencies> = {},
) {
  const sshCalls: Array<{ address: string; timeout: number }> = [];
  const sshStarted = Promise.withResolvers<void>();
  const credentialCalls: string[] = [];
  const credentialAnswer: BindingCheckEntry = CREDENTIAL_HEALTHY;
  const f = fixture(t, {
    repositoryConnector: {
      async gitLsRemote(address: string, context: Context, timeout: number) {
        sshCalls.push({ address, timeout });
        sshStarted.resolve();
        if (addressBehavior === ADDRESS_SSH_FAIL) throw new Error("SSH failed");
        if (addressBehavior === ADDRESS_SSH_HANG) {
          await cancelled(context.signal);
          throw context.signal.reason;
        }
      },
    },
    verifyRepositoryCredential: async (name: string) => {
      credentialCalls.push(name);
      if (credentialBehavior === CREDENTIAL_REFUSAL)
        throw new OperationError(
          HttpStatus.NotFound,
          CREDENTIAL_NOT_FOUND,
          "Not found.",
        );
      return credentialAnswer;
    },
    ...overrides,
  });
  return { f, sshCalls, sshStarted, credentialCalls, credentialAnswer };
}

test("binding.verify returns healthy for a valid repository binding", async (t) => {
  const { f, sshCalls, credentialCalls, credentialAnswer } = verifyFixture(
    t,
    "healthy",
    "healthy",
  );
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, p.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return p;
  });
  const bindings = f.store.transaction((tx) =>
    Array.from(readCurrentBindingSet(tx, project.id).values()),
  );
  const binding = bindings[NO_ITEMS];
  assert.ok(binding);
  const result = await f.invokeAsync("binding.verify", {
    project_id: project.id,
    binding_id: binding.id,
  });
  assert.deepEqual(result.address, {
    status: ResourceStatus.Healthy,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
    failure_reason: null,
  });
  assert.deepEqual(result.ssh_credential, credentialAnswer);
  assert.deepEqual(result.credential, credentialAnswer);
  assert.equal(sshCalls.length, ONE_CALL);
  assert.equal(sshCalls[0]?.address, REPOSITORY_ADDRESS);
  assert.ok(
    (sshCalls[0]?.timeout ?? 0) > NO_CALLS &&
      (sshCalls[0]?.timeout ?? 0) <= BINDING_VERIFY_TIMEOUT,
  );
  assert.deepEqual(credentialCalls, [
    sshCredentialOf(REPOSITORY_ADDRESS),
    REPOSITORY_CREDENTIAL,
  ]);
});

test("binding.verify returns unhealthy for address when SSH read fails", async (t) => {
  const { f, sshCalls, credentialCalls } = verifyFixture(
    t,
    "ssh_fail",
    "healthy",
  );
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, p.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return p;
  });
  const bindings = f.store.transaction((tx) =>
    Array.from(readCurrentBindingSet(tx, project.id).values()),
  );
  const binding = bindings[NO_ITEMS];
  assert.ok(binding);
  const result = await f.invokeAsync("binding.verify", {
    project_id: project.id,
    binding_id: binding.id,
  });
  assert.equal(result.address.status, ResourceStatus.Unhealthy);
  assert.equal(result.address.capability, RESOURCE_CAPABILITY_NETWORK_GIT_READ);
  assert.equal(
    result.address.failure_reason,
    ResourceFailureReason.Unclassified,
  );
  assert.equal(sshCalls.length, ONE_CALL);
  assert.deepEqual(credentialCalls, [
    sshCredentialOf(REPOSITORY_ADDRESS),
    REPOSITORY_CREDENTIAL,
  ]);
});

test("binding.verify returns unknown for address when the SSH read exceeds its deadline", async (t) => {
  const { f, sshStarted, credentialCalls } = verifyFixture(
    t,
    ADDRESS_SSH_HANG,
    "healthy",
  );
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, p.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return p;
  });
  const bindings = f.store.transaction((tx) =>
    Array.from(readCurrentBindingSet(tx, project.id).values()),
  );
  const binding = bindings[NO_ITEMS];
  assert.ok(binding);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const pending = f.invokeAsync("binding.verify", {
    project_id: project.id,
    binding_id: binding.id,
  });
  await sshStarted.promise;
  t.mock.timers.tick(BINDING_CHECK_TIMEOUT_MS);
  const result = await pending;
  assert.deepEqual(result.address, {
    status: ResourceStatus.Unknown,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
    failure_reason: ResourceFailureReason.Unclassified,
  });
  assert.deepEqual(credentialCalls, [
    sshCredentialOf(REPOSITORY_ADDRESS),
    REPOSITORY_CREDENTIAL,
  ]);
});

test("binding.verify names each failure reason of the address and releases the key under the human identity", async (t) => {
  const cases: ReadonlyArray<
    readonly [string, Diagnostic | null, boolean, ResourceFailureReason]
  > = [
    [
      REPOSITORY_ADDRESS,
      gitFailure(KEY_REFUSED_STDERR),
      false,
      ResourceFailureReason.KeyRefused,
    ],
    [
      REPOSITORY_ADDRESS,
      gitFailure(REPOSITORY_NOT_FOUND_STDERR),
      false,
      ResourceFailureReason.RepositoryNotFound,
    ],
    [
      REPOSITORY_ADDRESS,
      gitFailure(HOST_KEY_CHANGED_STDERR),
      false,
      ResourceFailureReason.HostKeyChanged,
    ],
    [REPOSITORY_ADDRESS, null, true, ResourceFailureReason.IdentityUnavailable],
    [UNPINNED_ADDRESS, null, false, ResourceFailureReason.HostKeyUnknown],
    [ALIAS_ADDRESS, null, false, ResourceFailureReason.AddressInvalid],
  ];
  for (const [address, failure, legacy, expected] of cases) {
    const { f } = verifyFixture(t, "healthy", "healthy", {
      repositoryConnector: {
        async gitLsRemote() {
          if (failure) throw failure;
        },
      },
    });
    if (legacy) f.secrets.set(sshCredentialOf(address), {});
    const project = f.store.transaction((tx) => {
      const p = insertProject(tx, PROJECT_NAME);
      persistBindings(tx, p.id, {
        [REPOSITORY_NAME]: repositoryBinding(address),
      });
      return p;
    });
    const [binding] = f.store.transaction((tx) =>
      Array.from(readCurrentBindingSet(tx, project.id).values()),
    );
    assert.ok(binding);
    const result = await f.invokeAsync("binding.verify", {
      project_id: project.id,
      binding_id: binding.id,
    });
    assert.deepEqual(result.address, {
      status: ResourceStatus.Unhealthy,
      capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
      failure_reason: expected,
    });
    assert.deepEqual(
      f.releases.map(({ identity, subject }) => ({ identity, subject })),
      address === ALIAS_ADDRESS
        ? []
        : [
            {
              identity: f.caller.identity,
              subject: {
                kind: SshIdentitySubjectKind.Binding,
                binding_id: binding.id,
              },
            },
          ],
    );
  }
});

test("binding.verify checks the host set on the granted address, not on the address of the config read", async (t) => {
  const { f, sshCalls } = verifyFixture(t, "healthy", "healthy");
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, p.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return p;
  });
  const [binding] = f.store.transaction((tx) =>
    Array.from(readCurrentBindingSet(tx, project.id).values()),
  );
  assert.ok(binding);
  f.grantAddress.value = ALIAS_ADDRESS;
  const result = await f.invokeAsync("binding.verify", {
    project_id: project.id,
    binding_id: binding.id,
  });
  assert.deepEqual(result.address, {
    status: ResourceStatus.Unhealthy,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
    failure_reason: ResourceFailureReason.AddressInvalid,
  });
  assert.deepEqual(f.releases, []);
  assert.deepEqual(sshCalls, []);
});

test("binding.verify propagates a credential record-verify refusal unchanged", async (t) => {
  const { f } = verifyFixture(t, "healthy", "refusal");
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, p.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return p;
  });
  const bindings = f.store.transaction((tx) =>
    Array.from(readCurrentBindingSet(tx, project.id).values()),
  );
  const binding = bindings[NO_ITEMS];
  assert.ok(binding);
  await assert.rejects(
    f.invokeAsync("binding.verify", {
      project_id: project.id,
      binding_id: binding.id,
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, CREDENTIAL_NOT_FOUND);
      return true;
    },
  );
});

test("binding.verify returns 404 for an absent binding", async (t) => {
  const { f } = verifyFixture(t, "healthy", "healthy");
  const project = f.store.transaction((tx) => insertProject(tx, PROJECT_NAME));
  await assert.rejects(
    f.invokeAsync("binding.verify", {
      project_id: project.id,
      binding_id: `${BINDING_ID_PREFIX}_01ARZ3NDEKTSV4RRFFQ69G5FAV`,
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, ProjectErrorCode.BindingNotFound);
      return true;
    },
  );
});

test("binding.verify returns 404 for a removed binding", async (t) => {
  const { f } = verifyFixture(t, "healthy", "healthy");
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    const result = writeBindingSet(
      tx,
      p.id,
      p.binding_set_version,
      new Map([[REPOSITORY_NAME, repositoryBinding()]]),
    );
    const bindingId = result.changes[NO_ITEMS]?.binding_id;
    assert.ok(bindingId);
    writeBindingSet(
      tx,
      p.id,
      p.binding_set_version + VERSION_INCREMENT,
      new Map(),
    );
    return { project_id: p.id, binding_id: bindingId };
  });
  await assert.rejects(
    f.invokeAsync("binding.verify", {
      project_id: project.project_id,
      binding_id: project.binding_id,
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, ProjectErrorCode.BindingNotFound);
      return true;
    },
  );
});

test("binding.verify returns 404 for a non-repository binding", async (t) => {
  const { f } = verifyFixture(t, "healthy", "healthy");
  const project = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    const result = writeBindingSet(
      tx,
      p.id,
      p.binding_set_version,
      new Map([[WORKER_NAME, workerBinding()]]),
    );
    const bindingId = result.changes[NO_ITEMS]?.binding_id;
    assert.ok(bindingId);
    return { project_id: p.id, binding_id: bindingId };
  });
  await assert.rejects(
    f.invokeAsync("binding.verify", {
      project_id: project.project_id,
      binding_id: project.binding_id,
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, ProjectErrorCode.BindingNotFound);
      return true;
    },
  );
});

const BASE_BRANCH = "main";
const INSTRUCTION_COMMIT = "a".repeat(40);
const TREE_PREFIX = "tree-";
const NEXT_INSTRUCTION_COMMIT = "b".repeat(40);
const INSTRUCTION_PATHS = [
  "AGENTS.md",
  "AGENTS.local.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
];
const INSTRUCTION_SOURCES = [
  "agents_md",
  "agents_local_md",
  "claude_md",
  "claude_local_md",
];
const AGENTS_TEXT = "# Agents\n";
const CONTROL_TEXT = "bad\u0000text";
const BASE_BRANCH_ABSENT_MESSAGE = "The base branch is absent on the remote.";
const OTHER_PROJECT_NAME = "gamma";

type InstructionTexts = Array<string | null>;

function instructionFixture(
  t: TestContext,
  behavior: {
    commits?: Array<string | null>;
    texts?: InstructionTexts;
    states?: RepositoryFileState[];
    files?: Record<string, string>;
    listed?: string[];
    placement?: WorkerPlacement;
    resolveFails?: boolean;
    resolveFailure?: Error;
    address?: string;
    readFails?: boolean;
    hang?: boolean;
  } = {},
  overrides: Partial<Dependencies> = {},
) {
  const commits = [...(behavior.commits ?? [INSTRUCTION_COMMIT])];
  const resolveCalls: Array<{
    address: string;
    branch: string;
    timeout: number;
    ssh: SshAccess;
  }> = [];
  const readCalls: Array<{
    address: string;
    commit: string;
    paths: readonly string[];
    maxBytes: number;
    timeout: number;
    ssh: SshAccess;
  }> = [];
  const objectCalls: string[][] = [];
  const started = Promise.withResolvers<void>();
  const f = fixture(t, {
    repositoryConnector: {
      gitLsRemote: unexpected,
    },
    repositoryFiles: {
      async resolveBranchCommit(address, branch, context, timeout, ssh) {
        resolveCalls.push({ address, branch, timeout, ssh });
        started.resolve();
        if (behavior.hang) {
          await cancelled(context.signal);
          throw context.signal.reason;
        }
        if (behavior.resolveFailure) throw behavior.resolveFailure;
        if (behavior.resolveFails) throw new Error("ls-remote failed");
        return commits.length > ONE_CALL
          ? commits.shift()!
          : commits[NO_ITEMS]!;
      },
      async readFilesAtCommit(
        address,
        commit,
        paths,
        maxBytes,
        _context,
        timeout,
        ssh,
      ) {
        readCalls.push({ address, commit, paths, maxBytes, timeout, ssh });
        if (behavior.readFails) throw new Error("fetch failed");
        return paths.map((path, index) => {
          const text =
            behavior.files === undefined
              ? (behavior.texts?.[index] ?? null)
              : (behavior.files[path] ?? null);
          return {
            path,
            state:
              behavior.states?.[index] ??
              (text === null
                ? RepositoryFileState.Absent
                : RepositoryFileState.Present),
            text,
          };
        });
      },
      listFilesAtCommit: async () => behavior.listed ?? [],
      async readObjectIds(_address, _commit, paths) {
        objectCalls.push([...paths]);
        if (behavior.resolveFails) throw new Error("fetch failed");
        return paths.map((_path, index) => `${TREE_PREFIX}${index}`);
      },
      cloneSnapshot: unexpected,
    },
    ...overrides,
  });
  const saved = f.store.transaction((tx) => {
    const p = insertProject(tx, PROJECT_NAME);
    const result = writeBindingSet(
      tx,
      p.id,
      p.binding_set_version,
      new Map(
        Object.entries({
          [REPOSITORY_NAME]: repositoryBinding(behavior.address),
          ...(behavior.placement === undefined
            ? {}
            : {
                general: {
                  ...workerBinding(),
                  config: {
                    ...workerBinding().config,
                    placement: behavior.placement,
                  },
                },
              }),
        } as Bindings),
      ),
    );
    const bindingId = result.changes[NO_ITEMS]?.binding_id;
    assert.ok(bindingId);
    return { project_id: p.id, binding_id: bindingId };
  });
  return { f, saved, resolveCalls, readCalls, objectCalls, started };
}

function refusesInstructionFiles(
  promise: Promise<unknown>,
  status: number,
  code: string,
  details?: OperationError["details"],
) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  });
}

test("binding.instruction_files.get answers the four files with their states", async (t) => {
  const { f, saved, resolveCalls, readCalls } = instructionFixture(t, {
    texts: [
      AGENTS_TEXT,
      null,
      CONTROL_TEXT,
      "x".repeat(PROMPT_SOURCE_MAX_BYTES + ONE_BYTE_OVER),
    ],
  });
  const before = Date.now();
  const result = await f.invokeAsync("binding.instruction_files.get", saved);
  assert.equal(result.commit, INSTRUCTION_COMMIT);
  assert.ok(result.read_at >= before && result.read_at <= Date.now());
  assert.deepEqual(result.files, [
    {
      source: INSTRUCTION_SOURCES[0],
      path: INSTRUCTION_PATHS[0],
      state: InstructionFileState.Present,
      reason: null,
      text: AGENTS_TEXT,
    },
    {
      source: INSTRUCTION_SOURCES[1],
      path: INSTRUCTION_PATHS[1],
      state: InstructionFileState.Absent,
      reason: null,
      text: null,
    },
    {
      source: INSTRUCTION_SOURCES[2],
      path: INSTRUCTION_PATHS[2],
      state: InstructionFileState.Invalid,
      reason: InvalidReason.ControlCharacter,
      text: null,
    },
    {
      source: INSTRUCTION_SOURCES[3],
      path: INSTRUCTION_PATHS[3],
      state: InstructionFileState.Invalid,
      reason: InvalidReason.TooLarge,
      text: null,
    },
  ]);
  assert.equal(resolveCalls.length, ONE_CALL);
  assert.equal(resolveCalls[NO_ITEMS]?.address, REPOSITORY_ADDRESS);
  assert.equal(resolveCalls[NO_ITEMS]?.branch, BASE_BRANCH);
  assert.ok(
    (resolveCalls[NO_ITEMS]?.timeout ?? NO_CALLS) > NO_CALLS &&
      (resolveCalls[NO_ITEMS]?.timeout ?? NO_CALLS) <= BINDING_CHECK_TIMEOUT_MS,
  );
  assert.equal(readCalls.length, ONE_CALL);
  assert.equal(readCalls[NO_ITEMS]?.commit, INSTRUCTION_COMMIT);
  assert.deepEqual(readCalls[NO_ITEMS]?.paths, INSTRUCTION_PATHS);
  assert.equal(readCalls[NO_ITEMS]?.maxBytes, PROMPT_SOURCE_MAX_BYTES);
});

test("binding.instruction_files.get releases the key under the Project identity and reads with it", async (t) => {
  const { f, saved, resolveCalls, readCalls } = instructionFixture(t);
  await f.invokeAsync("binding.instruction_files.get", saved);
  assert.deepEqual(
    f.releases.map(({ identity, subject }) => ({ identity, subject })),
    [
      {
        identity: PROJECT_IDENTITY,
        subject: {
          kind: SshIdentitySubjectKind.Binding,
          binding_id: saved.binding_id,
        },
      },
    ],
  );
  const ssh = {
    private_key: SSH_KEY.private_key,
    public_key: SSH_KEY.public_key,
    known_hosts: `github.com ${HOST_KEY}\n`,
    port: DEFAULT_SSH_PORT,
  };
  assert.deepEqual(resolveCalls[NO_ITEMS]?.ssh, ssh);
  assert.deepEqual(readCalls[NO_ITEMS]?.ssh, ssh);
});

test("binding.instruction_files.get maps the connector reasons of unreadable files to the invalid reasons of the working layer", async (t) => {
  const { f, saved } = instructionFixture(t, {
    states: [
      RepositoryFileState.NotRegularFile,
      RepositoryFileState.OutsideRoot,
      RepositoryFileState.Unreadable,
      RepositoryFileState.Absent,
    ],
  });
  const result = await f.invokeAsync("binding.instruction_files.get", saved);
  assert.deepEqual(
    result.files.map(({ state, reason, text }) => [state, reason, text]),
    [
      [InstructionFileState.Invalid, InvalidReason.NotRegularFile, null],
      [InstructionFileState.Invalid, InvalidReason.OutsideWorkspace, null],
      [InstructionFileState.Invalid, InvalidReason.Unreadable, null],
      [InstructionFileState.Absent, null, null],
    ],
  );
});

test("binding.instruction_files.get maps an oversized file and a file that is not UTF-8 to the invalid reasons of the working layer", async (t) => {
  const { f, saved } = instructionFixture(t, {
    states: [
      RepositoryFileState.TooLarge,
      RepositoryFileState.NotUtf8,
      RepositoryFileState.Absent,
      RepositoryFileState.Absent,
    ],
  });
  const result = await f.invokeAsync("binding.instruction_files.get", saved);
  assert.deepEqual(
    result.files.map(({ state, reason, text }) => [state, reason, text]),
    [
      [InstructionFileState.Invalid, InvalidReason.TooLarge, null],
      [InstructionFileState.Invalid, InvalidReason.NotUtf8, null],
      [InstructionFileState.Absent, null, null],
      [InstructionFileState.Absent, null, null],
    ],
  );
});

test("binding.instruction_files.get answers four absent files for a repository without instructions", async (t) => {
  const { f, saved } = instructionFixture(t);
  const result = await f.invokeAsync("binding.instruction_files.get", saved);
  assert.deepEqual(
    result.files.map(({ state, reason, text }) => [state, reason, text]),
    INSTRUCTION_PATHS.map(() => [InstructionFileState.Absent, null, null]),
  );
});

test("binding.instruction_files.get serves the cache for the same commit and reads again for a new commit", async (t) => {
  const { f, saved, resolveCalls, readCalls } = instructionFixture(t, {
    commits: [INSTRUCTION_COMMIT, INSTRUCTION_COMMIT, NEXT_INSTRUCTION_COMMIT],
    texts: [AGENTS_TEXT, null, null, null],
  });
  const first = await f.invokeAsync("binding.instruction_files.get", saved);
  const second = await f.invokeAsync("binding.instruction_files.get", saved);
  assert.deepEqual(second, first);
  assert.equal(resolveCalls.length, TWO_CALLS);
  assert.equal(readCalls.length, ONE_CALL);
  const third = await f.invokeAsync("binding.instruction_files.get", saved);
  assert.equal(third.commit, NEXT_INSTRUCTION_COMMIT);
  assert.equal(resolveCalls.length, TWO_CALLS + ONE_CALL);
  assert.equal(readCalls.length, TWO_CALLS);
  assert.equal(readCalls[ONE_CALL]?.commit, NEXT_INSTRUCTION_COMMIT);
});

test("binding.instruction_files.get stores nothing in the database", async (t) => {
  const { f, saved } = instructionFixture(t, { texts: [AGENTS_TEXT] });
  const rows = () =>
    f.store.database
      .prepare("SELECT COUNT(*) AS count FROM project_binding")
      .get();
  const before = rows();
  await f.invokeAsync("binding.instruction_files.get", saved);
  assert.deepEqual(rows(), before);
});

test("binding.instruction_files.get refuses an absent base branch", async (t) => {
  const { f, saved, readCalls } = instructionFixture(t, { commits: [null] });
  await assert.rejects(
    f.invokeAsync("binding.instruction_files.get", saved),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, SSH_FAILURE_STATUS);
      assert.equal(error.code, ProjectErrorCode.RepositoryBaseBranchAbsent);
      assert.equal(error.message, BASE_BRANCH_ABSENT_MESSAGE);
      return true;
    },
  );
  assert.equal(readCalls.length, NO_CALLS);
});

test("binding.instruction_files.get refuses a failed commit resolution", async (t) => {
  const { f, saved } = instructionFixture(t, { resolveFails: true });
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", saved),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    { failure_reason: ResourceFailureReason.Unclassified },
  );
});

test("binding.instruction_files.get refuses an alias-model binding and an unpinned host before any read", async (t) => {
  for (const [address, status, code, details] of [
    [
      ALIAS_ADDRESS,
      HttpStatus.BadRequest,
      ProjectErrorCode.RepositoryAddressInvalid,
      null,
    ],
    [
      UNPINNED_ADDRESS,
      HttpStatus.Conflict,
      HOST_KEY_UNPINNED,
      { host: "ssh.github.com" },
    ],
  ] as const) {
    const { f, saved, resolveCalls } = instructionFixture(t, { address });
    await refusesInstructionFiles(
      f.invokeAsync("binding.instruction_files.get", saved),
      status,
      code,
      details,
    );
    assert.deepEqual(resolveCalls, []);
  }
});

test("binding.instruction_files.get names the git failure reason of a failed read", async (t) => {
  const { f, saved } = instructionFixture(t, {
    resolveFailure: gitFailure(REPOSITORY_NOT_FOUND_STDERR),
  });
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", saved),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
    { failure_reason: ResourceFailureReason.RepositoryNotFound },
  );
});

test("binding.instruction_files.get refuses a failed file read and caches nothing", async (t) => {
  const { f, saved, readCalls } = instructionFixture(t, { readFails: true });
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", saved),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
  );
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", saved),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
  );
  assert.equal(readCalls.length, TWO_CALLS);
});

test("binding.instruction_files.get refuses a read that exceeds the deadline", async (t) => {
  const { f, saved, started } = instructionFixture(t, { hang: true });
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const refusal = refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", saved),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
  );
  await started.promise;
  t.mock.timers.tick(BINDING_CHECK_TIMEOUT_MS);
  await refusal;
});

test("binding.instruction_files.get answers 404 for an absent project", async (t) => {
  const { f, saved } = instructionFixture(t);
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", {
      ...saved,
      project_id: `${PROJECT_ID_PREFIX}_01ARZ3NDEKTSV4RRFFQ69G5FAV`,
    }),
    HttpStatus.NotFound,
    ProjectErrorCode.ProjectNotFound,
  );
});

test("binding.instruction_files.get answers 404 for an absent binding and a binding of another project", async (t) => {
  const { f, saved } = instructionFixture(t);
  const other = f.store.transaction((tx) =>
    insertProject(tx, OTHER_PROJECT_NAME),
  );
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", {
      ...saved,
      binding_id: `${BINDING_ID_PREFIX}_01ARZ3NDEKTSV4RRFFQ69G5FAV`,
    }),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", {
      ...saved,
      project_id: other.id,
    }),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
});

test("binding.instruction_files.get answers 404 for a removed binding", async (t) => {
  const { f, saved } = instructionFixture(t);
  f.store.transaction((tx) => {
    const project = requireProject(tx, saved.project_id);
    writeBindingSet(tx, project.id, project.binding_set_version, new Map());
  });
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", saved),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
});

test("binding.instruction_files.get answers 404 for a non-repository binding", async (t) => {
  const { f } = instructionFixture(t);
  const worker = f.store.transaction((tx) => {
    const p = insertProject(tx, OTHER_PROJECT_NAME);
    const result = writeBindingSet(
      tx,
      p.id,
      p.binding_set_version,
      new Map([[WORKER_NAME, workerBinding()]]),
    );
    const bindingId = result.changes[NO_ITEMS]?.binding_id;
    assert.ok(bindingId);
    return { project_id: p.id, binding_id: bindingId };
  });
  await refusesInstructionFiles(
    f.invokeAsync("binding.instruction_files.get", worker),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
});

async function checkBinding(
  f: ReturnType<typeof fixture>,
  projectId: string,
  config: unknown,
) {
  const operation = projectOperations["binding.check"];
  const input = operation.input.parse({
    params: { project_id: projectId },
    query: EMPTY_QUERY,
    body: { kind: BindingKind.Repository, config },
  });
  return operation.output.parse(
    await f.registry.get(operation.id).handler(input, f.caller),
  );
}

test("binding.check answers the verify badges of an unsaved configuration and writes nothing", async (t) => {
  const suitability: Array<{ credential: string; platform: string }> = [];
  const { f, sshCalls, credentialCalls, credentialAnswer } = verifyFixture(
    t,
    "healthy",
    "healthy",
    { custodySuitability: (_tx, request) => void suitability.push(request) },
  );
  const project = f.store.transaction((tx) => insertProject(tx, PROJECT_NAME));
  const commits = f.commits();
  const result = await checkBinding(f, project.id, repositoryBinding().config);
  assert.deepEqual(result, {
    address: {
      status: ResourceStatus.Healthy,
      capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
      failure_reason: null,
    },
    ssh_credential: credentialAnswer,
    credential: credentialAnswer,
  });
  assert.deepEqual(
    sshCalls.map(({ address }) => address),
    [REPOSITORY_ADDRESS],
  );
  assert.deepEqual(credentialCalls, [
    sshCredentialOf(REPOSITORY_ADDRESS),
    REPOSITORY_CREDENTIAL,
  ]);
  const sshSuitability = {
    credential: sshCredentialOf(REPOSITORY_ADDRESS),
    platform: SSH_CREDENTIAL_PLATFORM,
  };
  assert.deepEqual(suitability, [
    { credential: REPOSITORY_CREDENTIAL, platform: REPOSITORY_PLATFORM },
    sshSuitability,
    sshSuitability,
  ]);
  assert.deepEqual(
    f.releases.map(({ identity, subject }) => ({ identity, subject })),
    [
      {
        identity: f.caller.identity,
        subject: {
          kind: SshIdentitySubjectKind.Draft,
          project_id: project.id,
          credential: sshCredentialOf(REPOSITORY_ADDRESS),
          address: REPOSITORY_ADDRESS,
        },
      },
    ],
  );
  assert.equal(f.commits(), commits + ONE_CALL);
  assert.equal(
    f.store.database.prepare("SELECT id FROM project_binding").all().length,
    NO_ITEMS,
  );
});

test("binding.check answers unclassified for an address read that exceeds its deadline", async (t) => {
  const { f, sshStarted } = verifyFixture(t, ADDRESS_SSH_HANG, "healthy", {
    custodySuitability: () => {},
  });
  const project = f.store.transaction((tx) => insertProject(tx, PROJECT_NAME));
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const pending = checkBinding(f, project.id, repositoryBinding().config);
  await sshStarted.promise;
  t.mock.timers.tick(BINDING_CHECK_TIMEOUT_MS);
  assert.deepEqual((await pending).address, {
    status: ResourceStatus.Unknown,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
    failure_reason: ResourceFailureReason.Unclassified,
  });
});

test("binding.check refuses a static violation with the write code before any SSH call", async (t) => {
  const { f, sshCalls, credentialCalls } = verifyFixture(
    t,
    "healthy",
    "healthy",
    { custodySuitability: () => {} },
  );
  const project = f.store.transaction((tx) => insertProject(tx, PROJECT_NAME));
  const config = withoutCredential(repositoryBinding().config);
  await rejectsWrite(
    checkBinding(f, project.id, {
      ...config,
      strategy: {
        ...config.strategy,
        action: {
          name: GitHubAction.PullRequest,
          follows: { type: FollowsType.AssessmentPassed },
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryCredentialRequired,
  );
  await rejectsWrite(
    checkBinding(f, project.id, {
      ...config,
      address: "git@-oProxyCommand:owner/repo.git",
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryAddressInvalid,
  );
  await assert.rejects(
    checkBinding(f, "project_01ARZ3NDEKTSV4RRFFQ69G5FAV", config),
    (error) =>
      error instanceof OperationError &&
      error.code === ProjectErrorCode.ProjectNotFound,
  );
  assert.deepEqual(sshCalls, []);
  assert.deepEqual(credentialCalls, []);
});

test("a pull request strategy holds a landing choice and other actions refuse one", () => {
  const strategy = (name: string, landing?: string) =>
    repositoryConfigSchema.shape.strategy.safeParse({
      base_branch: "main",
      action: {
        name,
        follows: { type: FollowsType.AssessmentPassed },
        ...(landing === undefined ? {} : { landing }),
      },
    });
  assert.equal(
    strategy(GitHubAction.PullRequest, Landing.KanthorD).success,
    true,
  );
  assert.equal(strategy(GitHubAction.PullRequest).success, true);
  assert.equal(
    strategy(GitHubAction.MergePush, Landing.KanthorD).success,
    false,
  );
  assert.equal(strategy(GitHubAction.PullRequest, "robot").success, false);
});

const WRITABLE: Partial<Dependencies> = { custodySuitability: () => {} };
const STORED_ENVIRONMENT = {
  image: "mcr.microsoft.com/devcontainers/python:3.12",
  postCreateCommand: "pip install -r requirements.txt",
};
const DEVCONTAINER_TEXT = `{
  // the repository environment
  "image": "mcr.microsoft.com/devcontainers/javascript-node:24",
  "postCreateCommand": "npm ci",
}`;

async function setEnvironment(
  f: ReturnType<typeof fixture>,
  params: { project_id: string; binding_id: string },
  environment: unknown,
) {
  const operation = projectOperations["binding.environment.set"];
  const input = operation.input.parse({
    params,
    query: {},
    body: { environment },
  });
  return operation.output.parse(
    await f.registry.get(operation.id).handler(input, f.caller),
  );
}

test("binding.environment.set stores the environment as a new revision with no repository check", async (t) => {
  const { f, saved, resolveCalls } = instructionFixture(t, {}, WRITABLE);
  f.project.cancelEnvironmentRuns();
  const answer = await setEnvironment(f, saved, STORED_ENVIRONMENT);
  const stored = answer.bindings[REPOSITORY_NAME];
  assert.ok(stored);
  assert.equal(stored.revision, SECOND_REVISION);
  assert.deepEqual(
    (stored.config as { environment: unknown }).environment,
    STORED_ENVIRONMENT,
  );
  assert.deepEqual(answer.changes, [
    { kind: ChangeKind.Revised, binding_id: stored.id },
  ]);
  assert.deepEqual(resolveCalls, []);
  assert.deepEqual(
    f.store.transaction((tx) => f.project.repositoryPolicyOf(tx, stored.id))
      ?.environment,
    STORED_ENVIRONMENT,
  );
});

test("a revision pinned before an environment set takes the environment of the current revision", async (t) => {
  const { f, saved } = instructionFixture(t, {}, WRITABLE);
  const pinned = f.store.transaction((tx) =>
    f.project.repositoryPolicyOf(tx, saved.binding_id),
  );
  assert.equal(pinned?.environment, null);
  await setEnvironment(f, saved, STORED_ENVIRONMENT);
  const policy = f.store.transaction((tx) =>
    f.project.repositoryPolicyOf(tx, saved.binding_id),
  );
  assert.equal(policy?.binding_id, saved.binding_id);
  assert.deepEqual(policy?.environment, STORED_ENVIRONMENT);
});

test("binding.environment.get answers the stored environment with no repository read", async (t) => {
  const { f, saved, resolveCalls, readCalls } = instructionFixture(
    t,
    {},
    WRITABLE,
  );
  f.project.cancelEnvironmentRuns();
  const answer = await setEnvironment(f, saved, STORED_ENVIRONMENT);
  const stored = answer.bindings[REPOSITORY_NAME];
  assert.ok(stored);
  const read = await f.invokeAsync("binding.environment.get", {
    project_id: saved.project_id,
    binding_id: stored.id,
  });
  assert.deepEqual(read, {
    source: EnvironmentSource.Stored,
    commit: null,
    environment: STORED_ENVIRONMENT,
    reason: null,
  });
  assert.deepEqual(resolveCalls, []);
  assert.deepEqual(readCalls, []);
});

test("binding.environment.get reads the devcontainer file of the repository at the base head", async (t) => {
  const present = instructionFixture(t, {
    texts: [DEVCONTAINER_TEXT],
    placement: WorkerPlacement.Container,
  });
  assert.deepEqual(
    await present.f.invokeAsync("binding.environment.get", present.saved),
    {
      source: EnvironmentSource.Repository,
      commit: INSTRUCTION_COMMIT,
      environment: {
        image: "mcr.microsoft.com/devcontainers/javascript-node:24",
        postCreateCommand: "npm ci",
      },
      reason: null,
    },
  );
  assert.deepEqual(present.readCalls[NO_ITEMS]?.paths, [DEVCONTAINER_FILE]);
  const invalid = instructionFixture(t, {
    texts: ["{"],
    placement: WorkerPlacement.Container,
  });
  const answer = await invalid.f.invokeAsync(
    "binding.environment.get",
    invalid.saved,
  );
  assert.equal(answer.source, EnvironmentSource.Repository);
  assert.equal(answer.environment, null);
  assert.match(answer.reason ?? "", /invalid JSON/);
});

const PACKAGE_JSON_TEXT = '{"engines":{"node":"22"}}';
const PACKAGE_LOCK_TEXT = "{}";

test("binding.environment.get answers the detected source at the image target with no devcontainer", async (t) => {
  const files = {
    "package.json": PACKAGE_JSON_TEXT,
    "package-lock.json": PACKAGE_LOCK_TEXT,
  };
  const { f, saved } = instructionFixture(t, {
    files,
    placement: WorkerPlacement.Container,
  });
  const detected = detectEnvironment([
    {
      path: "package.json",
      state: RepositoryFileState.Present,
      text: PACKAGE_JSON_TEXT,
    },
    {
      path: "package-lock.json",
      state: RepositoryFileState.Present,
      text: PACKAGE_LOCK_TEXT,
    },
  ]);
  assert.ok(detected);
  assert.deepEqual(await f.invokeAsync("binding.environment.get", saved), {
    source: EnvironmentSource.Detected,
    commit: INSTRUCTION_COMMIT,
    environment: detected.document,
    reason: null,
  });
});

test("binding.environment.get answers the universal source at the image target with no manifest", async (t) => {
  const { f, saved } = instructionFixture(t, {
    files: {},
    placement: WorkerPlacement.Container,
  });
  assert.deepEqual(await f.invokeAsync("binding.environment.get", saved), {
    source: EnvironmentSource.Universal,
    commit: INSTRUCTION_COMMIT,
    environment: JSON.parse(
      readFileSync(
        new URL("../../static/environment/universal.json", import.meta.url),
        "utf8",
      ),
    ),
    reason: null,
  });
});

test("binding.environment.get at the host target ignores the repository devcontainer", async (t) => {
  const none = instructionFixture(t, {
    files: { [DEVCONTAINER_FILE]: DEVCONTAINER_TEXT },
  });
  assert.deepEqual(
    await none.f.invokeAsync("binding.environment.get", none.saved),
    {
      source: EnvironmentSource.None,
      commit: INSTRUCTION_COMMIT,
      environment: null,
      reason: null,
    },
  );
  assert.ok(
    none.readCalls.every((call) => !call.paths.includes(DEVCONTAINER_FILE)),
  );
  const detected = instructionFixture(t, {
    files: {
      [DEVCONTAINER_FILE]: DEVCONTAINER_TEXT,
      "package.json": PACKAGE_JSON_TEXT,
    },
  });
  const answer = await detected.f.invokeAsync(
    "binding.environment.get",
    detected.saved,
  );
  assert.equal(answer.source, EnvironmentSource.Detected);
});

test("binding.environment.get and set refuse a binding that is not a repository binding", async (t) => {
  const { f, saved } = instructionFixture(t, {}, WRITABLE);
  const worker = f.store.transaction((tx) => {
    const written = persistBindings(tx, saved.project_id, {
      [REPOSITORY_NAME]: repositoryBinding(),
      general: workerBinding(),
    }).bindings.general;
    assert.ok(written);
    return { project_id: saved.project_id, binding_id: written.id };
  });
  await refusesInstructionFiles(
    f.invokeAsync("binding.environment.get", worker),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
  await refusesInstructionFiles(
    setEnvironment(f, worker, STORED_ENVIRONMENT),
    HttpStatus.NotFound,
    ProjectErrorCode.BindingNotFound,
  );
});

test("binding.environment.set refuses a key or a value that the build path does not allow and names the key", async (t) => {
  const { f, saved } = instructionFixture(t, {}, WRITABLE);
  await refusesInstructionFiles(
    setEnvironment(f, saved, {
      build: { dockerfile: "Dockerfile", options: ["--volume=/:/host"] },
    }),
    HttpStatus.BadRequest,
    EnvironmentErrorCode.KeyRefused,
    { key: "build.options", reason: EnvironmentRefusalReason.KeyNotAllowed },
  );
  await refusesInstructionFiles(
    setEnvironment(f, saved, {
      image: STORED_ENVIRONMENT.image,
      containerEnv: { TOKEN: "${localEnv:GH_TOKEN}" },
    }),
    HttpStatus.BadRequest,
    EnvironmentErrorCode.KeyRefused,
    {
      key: "containerEnv.TOKEN",
      reason: EnvironmentRefusalReason.ServerVariable,
    },
  );
});

test("a repository devcontainer with a refused key names the key in environment show", async (t) => {
  const refused = instructionFixture(t, {
    texts: [`{ "image": "base", "runArgs": ["--privileged"] }`],
    placement: WorkerPlacement.Container,
  });
  const answer = await refused.f.invokeAsync(
    "binding.environment.get",
    refused.saved,
  );
  assert.equal(answer.environment, null);
  assert.match(answer.reason ?? "", /runArgs: the key is not allowed/);
});

const OTHER_REPOSITORY_NAME = "other";
const OTHER_ADDRESS = "git@github.com:owner/other.git";

function twoRepositories(
  t: TestContext,
  behavior: Parameters<typeof instructionFixture>[1],
  overrides: Partial<Dependencies> = {},
) {
  const fixed = instructionFixture(t, behavior, { ...WRITABLE, ...overrides });
  const other = fixed.f.store.transaction((tx) => {
    const version = requireProject(
      tx,
      fixed.saved.project_id,
    ).binding_set_version;
    const result = writeBindingSet(
      tx,
      fixed.saved.project_id,
      version,
      new Map([
        [REPOSITORY_NAME, repositoryBinding()],
        [OTHER_REPOSITORY_NAME, repositoryBinding(OTHER_ADDRESS)],
      ]),
    );
    const added = result.changes.find(
      (change) => change.binding_id !== fixed.saved.binding_id,
    );
    assert.ok(added);
    return { project_id: fixed.saved.project_id, binding_id: added.binding_id };
  });
  return { ...fixed, other };
}

test("at a stored environment of one binding, no other binding takes its repository devcontainer", async (t) => {
  const { f, saved, other } = twoRepositories(t, {
    texts: [DEVCONTAINER_TEXT],
  });
  const policies = () =>
    f.store.transaction((tx) =>
      [saved.binding_id, other.binding_id].map((id) => {
        const policy = f.project.repositoryPolicyOf(tx, id);
        return [policy?.environment, policy?.repository_environment];
      }),
    );
  assert.deepEqual(policies(), [
    [null, true],
    [null, true],
  ]);
  await setEnvironment(f, saved, STORED_ENVIRONMENT);
  assert.deepEqual(policies(), [
    [STORED_ENVIRONMENT, false],
    [null, false],
  ]);
});

const MIXED_FIRST_ENVIRONMENT = {
  image: "mcr.microsoft.com/devcontainers/python:3.12",
  postCreateCommand: "pip install -r requirements.txt",
};
const MIXED_SECOND_ENVIRONMENT = {
  image: "mcr.microsoft.com/devcontainers/javascript-node:24",
  postCreateCommand: "npm ci",
};
const ONBOARDING_TABLE = /onboarding/i;

async function environmentFixture(
  t: TestContext,
  placement: "container" | "server",
  environments: [unknown, unknown],
) {
  const f = probedFixture(t, null);
  const [first, second] = environments;
  const withEnvironment = (
    binding: ReturnType<typeof repositoryBinding>,
    environment: unknown,
  ) =>
    environment === undefined
      ? binding
      : {
          ...binding,
          config: {
            ...binding.config,
            environment: environment as typeof MIXED_FIRST_ENVIRONMENT,
          },
        };
  await f.write({
    [REPOSITORY_NAME]: withEnvironment(repositoryBinding(), first),
    [SECOND_REPOSITORY_NAME]: withEnvironment(
      repositoryBinding(SECOND_REPOSITORY_ADDRESS),
      second,
    ),
    [WORKER_NAME]:
      placement === WorkerPlacement.Container
        ? containerWithEnvironment(REPOSITORY_NAME)
        : workerBinding(),
  });
  const identity = (name: string) => repositoryIdentity(f, name);
  const mixed = (identities: string[]) =>
    f.store.transaction((tx) =>
      f.project.environmentsMixed(tx, f.params.project_id, identities),
    );
  return {
    ...f,
    identity,
    mixed,
    both: () => [identity(REPOSITORY_NAME), identity(SECOND_REPOSITORY_NAME)],
  };
}

test("environmentsMixed answers true for different stored environments at the container placement and reads no onboarding record", async (t) => {
  const f = await environmentFixture(t, WorkerPlacement.Container, [
    MIXED_FIRST_ENVIRONMENT,
    MIXED_SECOND_ENVIRONMENT,
  ]);
  assert.equal(f.mixed(f.both()), true);
  const tables = f.store.database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  assert.deepEqual(
    tables.filter(({ name }) => ONBOARDING_TABLE.test(name)),
    [],
  );
});

test("environmentsMixed answers false at the server placement", async (t) => {
  const f = await environmentFixture(t, WorkerPlacement.Server, [
    MIXED_FIRST_ENVIRONMENT,
    MIXED_SECOND_ENVIRONMENT,
  ]);
  assert.equal(f.mixed(f.both()), false);
});

test("environmentsMixed answers false for equal documents after key order normalisation", async (t) => {
  const f = await environmentFixture(t, WorkerPlacement.Container, [
    {
      image: MIXED_FIRST_ENVIRONMENT.image,
      postCreateCommand: MIXED_FIRST_ENVIRONMENT.postCreateCommand,
    },
    {
      postCreateCommand: MIXED_FIRST_ENVIRONMENT.postCreateCommand,
      image: MIXED_FIRST_ENVIRONMENT.image,
    },
  ]);
  assert.equal(f.mixed(f.both()), false);
});

test("environmentsMixed answers false when one binding has no stored document", async (t) => {
  const f = await environmentFixture(t, WorkerPlacement.Container, [
    MIXED_FIRST_ENVIRONMENT,
    undefined,
  ]);
  assert.equal(f.mixed(f.both()), false);
});

test("environmentsMixed counts an identity that is no repository binding as no environment", async (t) => {
  const f = await environmentFixture(t, WorkerPlacement.Container, [
    MIXED_FIRST_ENVIRONMENT,
    MIXED_SECOND_ENVIRONMENT,
  ]);
  const worker = f.store.transaction(
    (tx) =>
      readCurrentBindingSet(tx, f.params.project_id).get(WORKER_NAME)!
        .resource_identity,
  );
  assert.equal(f.mixed([f.identity(REPOSITORY_NAME), worker]), false);
  assert.equal(
    f.mixed([f.identity(REPOSITORY_NAME), "repository:github:owner/absent"]),
    false,
  );
});

const UNKNOWN_WORKER_IDENTITY = "worker:missing";
const UNTIL_ATTEMPTS = 1000;

async function untilTrue(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < UNTIL_ATTEMPTS; attempt++) {
    if (condition()) return;
    await turn();
  }
  assert.fail("The condition did not hold.");
}

function identityOf(
  f: ReturnType<typeof fixture>,
  saved: { binding_id: string },
): string {
  const binding = f.store.transaction((tx) =>
    readBindingRevision(tx, saved.binding_id),
  );
  assert.ok(binding);
  return binding.resource_identity;
}

test("a binding-set write notifies the onboarding component after the commit and before the wake, and a refused write notifies neither", async (t) => {
  const events: string[] = [];
  const f = writeFixture(t, {
    bindingsChanged: () => void events.push("worker"),
    wakeup: { wake: () => void events.push("wake") },
  });
  t.mock.method(Onboarding.prototype, "bindingsChanged", () => {
    assert.equal(f.store.database.isTransaction, false);
    events.push("onboarding");
  });
  await f.write({ [WORKER_NAME]: workerBinding() });
  assert.deepEqual(events, ["onboarding", "worker", "wake"]);
  await assert.rejects(f.write({}));
  assert.deepEqual(events, ["onboarding", "worker", "wake"]);
});

test("a wake of a binding-set write finds a changed repository binding not claimable", async (t) => {
  let armed = false;
  const answers: boolean[] = [];
  const { f, saved } = instructionFixture(
    t,
    {},
    {
      ...WRITABLE,
      wakeup: {
        wake: (projectId) => {
          if (!armed) return;
          answers.push(
            f.project.environmentsClaimable(projectId, [identityOf(f, saved)]),
          );
        },
      },
    },
  );
  const identity = identityOf(f, saved);
  await untilTrue(() =>
    f.project.environmentsClaimable(saved.project_id, [identity]),
  );
  armed = true;
  await setEnvironment(f, saved, STORED_ENVIRONMENT);
  assert.deepEqual(answers.slice(0, 1), [false]);
});

test("binding.environment.set notifies the onboarding component once", async (t) => {
  const { f, saved } = instructionFixture(t, {}, WRITABLE);
  const mocked = t.mock.method(
    Onboarding.prototype,
    "bindingsChanged",
    () => {},
  );
  await setEnvironment(f, saved, STORED_ENVIRONMENT);
  assert.equal(mocked.mock.callCount(), ONE_CALL);
  assert.deepEqual(mocked.mock.calls[NO_CALLS]?.arguments, [saved.project_id]);
});

test("Project answers the environment methods through the onboarding component", async (t) => {
  const { f, saved, resolveCalls } = instructionFixture(t, {}, WRITABLE);
  const { project_id: projectId, binding_id: bindingId } = saved;
  const identity = identityOf(f, saved);
  const claimable = () =>
    f.project.environmentsClaimable(projectId, [identity]);
  assert.equal(claimable(), false);
  await untilTrue(claimable);
  assert.equal(
    await f.project.slotImage(
      projectId,
      UNKNOWN_WORKER_IDENTITY,
      AbortSignal.timeout(BINDING_CHECK_TIMEOUT_MS),
    ),
    SLOT_IMAGE,
  );
  const [state] = f.project.environmentStates(projectId);
  assert.equal(state?.status, EnvironmentStatus.None);
  const digest = f.project.environmentDigestOf(projectId, identity);
  assert.ok(digest);
  const calls = resolveCalls.length;
  assert.equal(f.project.environmentClaimed(projectId, identity), undefined);
  await untilTrue(() => resolveCalls.length > calls);
  f.project.environmentFailed({
    project_id: projectId,
    execution_id: "execution_1",
    resource_identities: [identity],
    stop: { code: EnvironmentFailureClass.SetupFailed, detail: "failed" },
    digests: { [identity]: digest },
  });
  assert.equal(
    f.project.environmentStates(projectId)[NO_CALLS]?.status,
    EnvironmentStatus.Failed,
  );
  const rebuilt = await f.project.rebuildEnvironment(projectId, bindingId);
  assert.equal(rebuilt.binding_id, bindingId);
  assert.equal(rebuilt.status, EnvironmentStatus.None);
});

const ENVIRONMENT_LIST = projectOperations["environment.list"];
const ENVIRONMENT_REBUILD = projectOperations["binding.environment.rebuild"];
const BASE_IMAGE_ID = "sha256:base";

function loggedRuntime(overrides: Partial<EnvironmentRuntime> = {}): {
  runtime: EnvironmentRuntime;
  calls: string[];
} {
  const calls: string[] = [];
  const members = { ...inertEnvironmentRuntime(), ...overrides };
  const runtime = Object.fromEntries(
    Object.entries(members).map(([name, member]) => [
      name,
      member instanceof Function
        ? (...args: unknown[]) => {
            calls.push(name);
            return (member as (...values: unknown[]) => unknown)(...args);
          }
        : member,
    ]),
  ) as unknown as EnvironmentRuntime;
  return { runtime, calls };
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) =>
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    }),
  );
}

function imageGroupFixture(t: TestContext, provedTag: boolean) {
  const state = { proved: provedTag };
  const logged = loggedRuntime({
    imageId: async () => BASE_IMAGE_ID,
    imageExists: async () => state.proved,
    removeTags: async () => {
      state.proved = false;
    },
    build: async (_input, signal) => untilAborted(signal),
  });
  const fixed = instructionFixture(
    t,
    { texts: [DEVCONTAINER_TEXT] },
    { ...WRITABLE, environmentRuntime: logged.runtime },
  );
  const written = fixed.f.store.transaction(
    (tx) =>
      persistBindings(tx, fixed.saved.project_id, {
        [REPOSITORY_NAME]: repositoryBinding(),
        [WORKER_NAME]: containerBinding(),
      }).bindings,
  );
  const repository = written[REPOSITORY_NAME];
  assert.ok(repository);
  const params = {
    project_id: fixed.saved.project_id,
    binding_id: repository.id,
  };
  fixed.f.project.environmentClaimed(
    params.project_id,
    repository.resource_identity,
  );
  return { ...fixed, ...logged, params, written };
}

test("environment.list answers the states in binding name order and reads nothing", async (t) => {
  const logged = loggedRuntime();
  const { f, saved, other, readCalls, resolveCalls } = twoRepositories(
    t,
    {},
    { environmentRuntime: logged.runtime },
  );
  for (const binding of [saved, other])
    f.project.environmentClaimed(saved.project_id, identityOf(f, binding));
  await untilTrue(
    () => f.project.environmentStates(saved.project_id).length === TWO_CALLS,
  );
  const runtimeCalls = logged.calls.length;
  const reads = readCalls.length;
  const resolves = resolveCalls.length;
  const answer = f.invoke("environment.list", null, {
    project_id: saved.project_id,
  });
  assert.deepEqual(
    answer.items.map((item) => item.binding_name),
    [OTHER_REPOSITORY_NAME, REPOSITORY_NAME],
  );
  for (const item of answer.items) environmentStateSchema.parse(item);
  assert.deepEqual(answer.items, f.project.environmentStates(saved.project_id));
  assert.equal(logged.calls.length, runtimeCalls);
  assert.equal(readCalls.length, reads);
  assert.equal(resolveCalls.length, resolves);
});

test("environment.list answers 404 for an unknown project", (t) => {
  const f = fixture(t);
  refuses(
    () =>
      f.invoke("environment.list", null, {
        project_id: "project_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      }),
    HttpStatus.NotFound,
    ProjectErrorCode.ProjectNotFound,
  );
});

test("binding.environment.rebuild answers the state of the group with the status of the new run", async (t) => {
  const { f, params, calls } = imageGroupFixture(t, true);
  await untilTrue(
    () =>
      f.project.environmentStates(params.project_id)[NO_ITEMS]?.status ===
      EnvironmentStatus.Ready,
  );
  const state = await f.invokeAsync("binding.environment.rebuild", params);
  assert.equal(state.binding_id, params.binding_id);
  assert.equal(state.binding_name, REPOSITORY_NAME);
  assert.ok(
    state.status === EnvironmentStatus.Building ||
      state.status === EnvironmentStatus.Proving,
  );
  assert.ok(calls.includes("removeTags"));
});

test("binding.environment.rebuild answers 409 during an active run of the group", async (t) => {
  const { f, params } = imageGroupFixture(t, false);
  await untilTrue(
    () =>
      f.project.environmentStates(params.project_id)[NO_ITEMS]
        ?.run_started_at !== null &&
      f.project.environmentStates(params.project_id).length === ONE_CALL,
  );
  await refusesInstructionFiles(
    f.invokeAsync("binding.environment.rebuild", params),
    HttpStatus.Conflict,
    ProjectErrorCode.EnvironmentRunActive,
  );
});

test("binding.environment.rebuild answers 404 for an unknown, a foreign, a removed and a worker binding", async (t) => {
  const { f, params, written } = imageGroupFixture(t, true);
  const worker = written[WORKER_NAME];
  assert.ok(worker);
  const foreign = f.store.transaction((tx) => {
    const project = insertProject(tx, OTHER_NAME);
    return persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!.id;
  });
  const removed = f.store.transaction((tx) => {
    const project = insertProject(tx, RENAMED_NAME);
    const id = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: repositoryBinding(),
    }).bindings[REPOSITORY_NAME]!.id;
    persistBindings(tx, project.id, {});
    return { project_id: project.id, binding_id: id };
  });
  for (const refused of [
    { ...params, binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    { ...params, binding_id: foreign },
    removed,
    { ...params, binding_id: worker.id },
  ])
    await refusesInstructionFiles(
      f.invokeAsync("binding.environment.rebuild", refused),
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
    );
});

test("both environment operations refuse a machine caller by their access policy", () => {
  for (const operation of [ENVIRONMENT_LIST, ENVIRONMENT_REBUILD]) {
    assert.equal(operation.access, AccessPolicy.Human);
    assert.equal(operation.mutation, operation === ENVIRONMENT_REBUILD);
  }
});

const REFUSED_KEY = "runArgs";

test("binding.environment.set answers key_refused for a document with runArgs and invalid for a non-object or a wrong type", async (t) => {
  const { f, saved } = instructionFixture(t, {}, WRITABLE);
  await refusesInstructionFiles(
    setEnvironment(f, saved, { image: "base", runArgs: ["--privileged"] }),
    HttpStatus.BadRequest,
    EnvironmentErrorCode.KeyRefused,
    { key: REFUSED_KEY, reason: EnvironmentRefusalReason.KeyNotAllowed },
  );
  for (const invalid of [[], "image", 5, { image: 5 }])
    await refusesInstructionFiles(
      setEnvironment(f, saved, invalid),
      HttpStatus.BadRequest,
      EnvironmentErrorCode.Invalid,
    );
});

test("binding.environment.set with null removes the key and the source returns to the repository file", async (t) => {
  const { f, saved } = instructionFixture(
    t,
    { texts: [DEVCONTAINER_TEXT], placement: WorkerPlacement.Container },
    { ...WRITABLE, workerAgentsOf: () => [AGENT], validateEntry: () => {} },
  );
  f.project.cancelEnvironmentRuns();
  const stored = (await setEnvironment(f, saved, STORED_ENVIRONMENT)).bindings[
    REPOSITORY_NAME
  ];
  assert.ok(stored);
  assert.equal(
    (
      await f.invokeAsync("binding.environment.get", {
        ...saved,
        binding_id: stored.id,
      })
    ).source,
    EnvironmentSource.Stored,
  );
  const changes = f.bindingChanges.length;
  const answer = await setEnvironment(f, saved, null);
  const removed = answer.bindings[REPOSITORY_NAME];
  assert.ok(removed);
  assert.equal(removed.revision, REVISION_THREE);
  assert.equal(Object.hasOwn(removed.config as object, "environment"), false);
  assert.equal(f.bindingChanges.length, changes + ONE_CALL);
  const read = await f.invokeAsync("binding.environment.get", {
    ...saved,
    binding_id: removed.id,
  });
  assert.equal(read.source, EnvironmentSource.Repository);
  assert.equal(read.commit, INSTRUCTION_COMMIT);
});
