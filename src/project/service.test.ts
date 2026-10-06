import assert from "node:assert/strict";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { test, type TestContext } from "node:test";
import { ProjectService, type Dependencies } from "./service.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import {
  HealthRegistry,
  HealthScope,
  ResourceStatus,
} from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { temporary } from "../kernel/test-support.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { WorkerErrorCode } from "../worker/contract.ts";
import {
  BINDING_ID_PREFIX,
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  BindingState,
  ChangeKind,
  BINDING_CHECK_TIMEOUT_MS,
  FollowsType,
  GitHubAction,
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
  WorkerField,
  bindingSetWriteInputSchema,
  type BindingCheckEntry,
  type WorkerEntry,
  PROJECT_ID_PREFIX,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  projectOperations,
} from "./contract.ts";
import { projectMigrations } from "./migrations.ts";
import { SshErrorCode, type SshIdentity } from "../repository/ssh-identity.ts";
import {
  insertProject,
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
const TWO_INSTANCES = 2;
const NO_CALLS = 0;
const ONE_CALL = 1;
const NO_ITEMS = 0;
const WORKER_GROUP = "worker:kanthord:worker";
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
  "project.bindingSet.write",
  "project.bindingSet.get",
  "project.binding.list",
  "project.binding.get",
  "project.bindingRevision.list",
  "project.agentConfiguration.list",
  "project.agentConfiguration.get",
  "project.binding.verify",
  "project.binding.check",
];
const CURSOR_ENCODING = "base64url";
type OperationKey = Exclude<
  keyof typeof projectOperations,
  "bindingSet.write" | "binding.check"
>;
type AsyncOperationKey = "binding.verify";

function unexpected(): never {
  throw new Error("Unexpected peer collaboration call.");
}

function fixture(t: TestContext, overrides: Partial<Dependencies> = {}) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  ]);
  const health = new HealthRegistry();
  const stateDirectory = temporary(t);
  const wakes: string[] = [];
  const registrationEnds: Array<{
    projectId: string;
    resourceIdentity: string;
    now: number;
  }> = [];
  const project = new ProjectService({
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
    validateEntry: unexpected,
    custodySuitability: unexpected,
    repositoryConnector: {
      gitLsRemote: unexpected,
      resolveSshIdentity: unexpected,
    },
    verifyRepositoryCredential: unexpected,
    credentialMetadata: (_tx, name) => sshPinMetadata(name),
    workerAgentsOf: unexpected,
    workerAgentView: unexpected,
    endRegistrations: (tx, projectId, resourceIdentity, now) => {
      assert.ok(tx.database.isTransaction);
      assert.equal(tx.database, store.database);
      registrationEnds.push({ projectId, resourceIdentity, now });
    },
    ...overrides,
  });
  t.after(() => project.stop());
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
    wakes,
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
    assert.equal(await running, context.err());
    await assert.rejects(
      project.resolveWorkerGroup(
        "absent",
        "worker:kanthord:absent",
        0,
        context,
      ),
      (error) => error === context.err(),
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
  assert.equal(record.bindingSetVersion, BINDING_SET_INITIAL_VERSION);
  assert.ok(record.createdAt >= before && record.createdAt <= Date.now());
  assert.equal(missionCalls, ONE_CALL);
  assert.deepEqual(f.invoke("get", null, { projectId: record.id }), record);
  assert.deepEqual(f.invoke("list").items, [record]);
});

test("create, get and list answer the workspace directory and create answers after it exists", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const record = f.invoke("create", { name: PROJECT_NAME });
  assert.equal(
    record.workspaceDirectory,
    join(f.stateDirectory, "projects", record.id),
  );
  assert.ok(isAbsolute(record.workspaceDirectory));
  assert.ok(statSync(record.workspaceDirectory).isDirectory());
  f.invoke("create", { name: OTHER_NAME });
  assert.equal(
    f.invoke("get", null, { projectId: record.id }).workspaceDirectory,
    record.workspaceDirectory,
  );
  const listed = f.invoke("list").items;
  assert.equal(listed.length, PROJECTS_CREATED);
  for (const item of listed)
    assert.equal(
      item.workspaceDirectory,
      join(f.stateDirectory, "projects", item.id),
    );
});

test("create answers the committed project when its workspace directory cannot be created", (t) => {
  const f = fixture(t, { createMission: allowMission });
  writeFileSync(join(f.stateDirectory, "projects"), "");
  const record = f.invoke("create", { name: PROJECT_NAME });
  assert.equal(
    record.workspaceDirectory,
    join(f.stateDirectory, "projects", record.id),
  );
  assert.ok(!existsSync(record.workspaceDirectory));
  assert.deepEqual(f.invoke("get", null, { projectId: record.id }), record);
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
  assert.deepEqual(f.invoke("list"), { items: [], nextCursor: null });
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
  assert.deepEqual(f.invoke("list"), { items: [], nextCursor: null });
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
    cursor = page.nextCursor;
    if (expected !== records.at(-FIRST_PAGE_LIMIT))
      assert.equal(cursor, Buffer.from(expected.id).toString(CURSOR_ENCODING));
  }
  assert.equal(cursor, null);
  assert.deepEqual(seen, records);
  assert.deepEqual(f.invoke("list", null, {}, { limit: records.length }), {
    items: records,
    nextCursor: null,
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
    nextCursor: null,
  });
});

test("get and rename reject an absent project", (t) => {
  const f = fixture(t);
  const params = { projectId: createIdentity(PROJECT_ID_PREFIX) };
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

test("rename preserves fields, accepts its current name, and rejects another holder", (t) => {
  const f = fixture(t, { createMission: allowMission });
  const project = f.invoke("create", { name: PROJECT_NAME });
  const holder = f.invoke("create", { name: OTHER_NAME });
  const params = { projectId: project.id };
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

function bindingFixture(t: TestContext, overrides: Partial<Dependencies> = {}) {
  const f = fixture(t, { createMission: allowMission, ...overrides });
  const project = f.invoke("create", { name: PROJECT_NAME });
  let version = BINDING_SET_INITIAL_VERSION;
  function write(instanceCount: number | null) {
    const submission = new Map();
    if (instanceCount !== null)
      submission.set("worker", {
        kind: BindingKind.Worker,
        config: { worker: "developer", instanceCount },
      });
    const result = f.store.transaction((tx) =>
      writeBindingSet(tx, project.id, version, submission),
    );
    version = result.newVersion;
    const change = result.changes.at(-FIRST_PAGE_LIMIT);
    assert.ok(change);
    assert.ok(
      identitySchema(BINDING_ID_PREFIX).safeParse(change.bindingId).success,
    );
    return change.bindingId;
  }
  return { ...f, projectId: project.id, write };
}

test("worker group resolution rejects absence, disablement and removal", async (t) => {
  const f = bindingFixture(t);
  const resolve = (resourceIdentity = WORKER_GROUP) =>
    f.project.resolveWorkerGroup(
      f.projectId,
      resourceIdentity,
      GROUP_ISSUED_AT,
      background,
    );
  assert.equal(await resolve(), null);
  f.write(SINGLE_INSTANCE);
  assert.deepEqual(await resolve(), {
    projectId: f.projectId,
    resourceIdentity: WORKER_GROUP,
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
  t.mock.method(Date, "now", () => GROUP_ISSUED_AT);
  f.write(SINGLE_INSTANCE);
  t.mock.method(Date, "now", () => TOMBSTONE_AT);
  f.write(null);
  f.write(SINGLE_INSTANCE);
  assert.equal(
    await f.project.resolveWorkerGroup(
      f.projectId,
      WORKER_GROUP,
      GROUP_ISSUED_AT,
      background,
    ),
    null,
  );
  assert.deepEqual(
    await f.project.resolveWorkerGroup(
      f.projectId,
      WORKER_GROUP,
      TOMBSTONE_AT,
      background,
    ),
    { projectId: f.projectId, resourceIdentity: WORKER_GROUP },
  );
  const secondTombstoneAt = TOMBSTONE_AT + GROUP_ISSUED_AT;
  t.mock.method(Date, "now", () => secondTombstoneAt);
  f.write(null);
  f.write(SINGLE_INSTANCE);
  assert.equal(
    await f.project.resolveWorkerGroup(
      f.projectId,
      WORKER_GROUP,
      TOMBSTONE_AT,
      background,
    ),
    null,
  );
  assert.deepEqual(
    await f.project.resolveWorkerGroup(
      f.projectId,
      WORKER_GROUP,
      secondTombstoneAt,
      background,
    ),
    { projectId: f.projectId, resourceIdentity: WORKER_GROUP },
  );
});

test("workerBindingOf reads current configuration, disablement and tombstone in the caller transaction", (t) => {
  const f = bindingFixture(t);
  const read = () =>
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.projectId, WORKER_GROUP),
    );
  assert.equal(read(), null);
  const first = f.write(SINGLE_INSTANCE);
  assert.deepEqual(read(), {
    bindingId: first,
    name: GROUP_BINDING_NAME,
    projectName: PROJECT_NAME,
    revision: REVISION_ONE,
    workerName: GROUP_WORKER_NAME,
    instanceCount: SINGLE_INSTANCE,
    resourceBudget: null,
    entries: [],
    tombstone: false,
  });
  const next = f.write(TWO_INSTANCES);
  const txResult = f.store.transaction((tx) => {
    t.mock.method(f.store, "transaction", unexpected);
    return f.project.workerBindingOf(tx, f.projectId, WORKER_GROUP);
  });
  t.mock.restoreAll();
  assert.equal(txResult?.bindingId, next);
  assert.equal(txResult?.revision, REVISION_TWO);
  assert.equal(txResult?.instanceCount, TWO_INSTANCES);
  f.write(INSTANCE_COUNT_MIN);
  assert.equal(read()?.instanceCount, INSTANCE_COUNT_MIN);
  f.write(null);
  assert.equal(read()?.tombstone, true);
  assert.equal(read()?.name, GROUP_BINDING_NAME);
  f.invoke("rename", { name: RENAMED_NAME }, { projectId: f.projectId });
  assert.equal(read()?.projectName, RENAMED_NAME);
});

test("worker group reads reject a repository group and preserve cancellation", async (t) => {
  const f = bindingFixture(t);
  const repositoryGroup = "repository:github:owner/repo";
  f.store.transaction((tx) =>
    writeBindingSet(
      tx,
      f.projectId,
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
      f.projectId,
      repositoryGroup,
      GROUP_ISSUED_AT,
      background,
    ),
    null,
  );
  assert.equal(
    f.store.transaction((tx) =>
      f.project.workerBindingOf(tx, f.projectId, repositoryGroup),
    ),
    null,
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    f.project.resolveWorkerGroup(
      f.projectId,
      WORKER_GROUP,
      GROUP_ISSUED_AT,
      context,
    ),
    (error) => error === context.err(),
  );
});

test("worker group override receives the exact group, issuance and context without bypassing cancellation", async (t) => {
  const group = { projectId: "fake-project", resourceIdentity: WORKER_GROUP };
  let calls = NO_CALLS;
  const f = fixture(t, {
    bindings: {
      async resolveWorkerGroup(projectId, resourceIdentity, issuedAt, context) {
        calls++;
        assert.deepEqual({ projectId, resourceIdentity }, group);
        assert.equal(issuedAt, GROUP_ISSUED_AT);
        assert.equal(context, background);
        return group;
      },
    },
  });
  t.mock.method(f.store, "transaction", unexpected);
  assert.equal(
    await f.project.resolveWorkerGroup(
      group.projectId,
      group.resourceIdentity,
      GROUP_ISSUED_AT,
      background,
    ),
    group,
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    f.project.resolveWorkerGroup(
      group.projectId,
      group.resourceIdentity,
      GROUP_ISSUED_AT,
      context,
    ),
    (error) => error === context.err(),
  );
  assert.equal(calls, ONE_CALL);
});

const REPOSITORY_NAME = "repository";
const SECOND_REPOSITORY_NAME = "other-repository";
const WORKER_NAME = "worker";
const STORAGE_NAME = "storage";
const NATIVE_WORKER = "general@1";
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
const ALIAS_HOST = "kanthorlabs.github.com";
const ALIAS_ADDRESS = `git@${ALIAS_HOST}:owner/repo.git`;
const SECOND_REPOSITORY_ADDRESS = "git@github.com:owner/other.git";
const REPOSITORY_CREDENTIAL = "github-key";
const SSH_CREDENTIAL_PREFIX = "ssh-";
const IDENTITY_FILE = "~/.ssh/id_test";
const SSH_PORT = 22;
const PIN_HOSTNAMES: Readonly<Record<string, string>> = {
  [ALIAS_HOST]: "ssh.github.com",
};

function sshIdentity(hostname: string): SshIdentity {
  return {
    hostname,
    port: SSH_PORT,
    identityFiles: [IDENTITY_FILE],
    identitiesOnly: true,
  };
}

function sshCredentialOf(address: string): string {
  return `${SSH_CREDENTIAL_PREFIX}${/^git@([^:]+):/.exec(address)?.[1] ?? ""}`;
}

function sshPinMetadata(credentialName: string) {
  const host = credentialName.slice(SSH_CREDENTIAL_PREFIX.length);
  return {
    platform: SSH_CREDENTIAL_PLATFORM,
    metadata: {
      host,
      hostname: PIN_HOSTNAMES[host] ?? host,
      port: SSH_PORT,
      identity_file: IDENTITY_FILE,
    },
  };
}
const STORAGE_CREDENTIAL = "s3-key";
const SSH_FAILURE_STATUS = 422;
const VERSION_INCREMENT = 1;
const REVISION_ONE = 1;
const REVISION_TWO = 2;
const REVISION_THREE = 3;
const TWO_CALLS = 2;
const ONE_BYTE_OVER = 1;
const UTF8 = "utf8";
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
      strategy: { baseBranch: "main" },
      sshCredential: sshCredentialOf(address),
      credential: REPOSITORY_CREDENTIAL,
    },
  };
}

function workerBinding(worker = NATIVE_WORKER) {
  return {
    kind: BindingKind.Worker,
    config: { worker, instanceCount: SINGLE_INSTANCE },
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
      async resolveSshIdentity(host) {
        return sshIdentity(host);
      },
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
  const params = { projectId: project.id };
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
  assert.deepEqual(f.wakes, [f.params.projectId]);
  assert.equal(
    f.store.transaction((tx) => requireProject(tx, f.params.projectId))
      .bindingSetVersion,
    result.bindingSetVersion,
  );
  await assert.rejects(f.write({}));
  assert.deepEqual(f.wakes, [f.params.projectId]);
});

function storedBindings(f: ReturnType<typeof writeFixture>) {
  return f.store.transaction((tx) =>
    Object.fromEntries(
      Array.from(
        readCurrentBindingSet(tx, f.params.projectId),
        ([name, binding]) => [name, binding],
      ),
    ),
  );
}

test("binding edits end registrations only for removed or zero-count worker groups in the write transaction", async (t) => {
  const f = writeFixture(t);
  const config = { ...workerBinding().config, instanceCount: TWO_INSTANCES };
  let result = await f.write({
    worker: { kind: BindingKind.Worker, config },
    repository: repositoryBinding(),
  });
  result = await f.write(
    { worker: workerBinding(), repository: repositoryBinding() },
    result.bindingSetVersion,
  );
  assert.equal(f.registrationEnds.length, NO_CALLS);
  result = await f.write(
    {
      worker: {
        kind: BindingKind.Worker,
        config: { ...config, resourceBudget: { turns: 10, wallTimeMs: 1000 } },
      },
    },
    result.bindingSetVersion,
  );
  assert.equal(f.registrationEnds.length, NO_CALLS);
  result = await f.write(
    {
      worker: {
        kind: BindingKind.Worker,
        config: { ...config, instanceCount: INSTANCE_COUNT_MIN },
      },
    },
    result.bindingSetVersion,
  );
  assert.equal(f.registrationEnds.length, ONE_CALL);
  assert.equal(f.registrationEnds[0]!.projectId, f.params.projectId);
  assert.equal(f.registrationEnds[0]!.resourceIdentity, WORKER_GROUP);
  assert.ok(Number.isSafeInteger(f.registrationEnds[0]!.now));
  result = await f.write({ worker: workerBinding() }, result.bindingSetVersion);
  await rejectsWrite(
    f.write({}, result.bindingSetVersion - VERSION_INCREMENT),
    HttpStatus.Conflict,
    ProjectErrorCode.VersionConflict,
    { bindingSetVersion: result.bindingSetVersion },
  );
  assert.equal(f.registrationEnds.length, ONE_CALL);
  await f.write({}, result.bindingSetVersion);
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
    f.store.transaction((tx) => requireProject(tx, f.params.projectId))
      .bindingSetVersion,
    result.bindingSetVersion,
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
        entries: [{ agent: AGENT, modelIdentifier: MODEL }],
      },
    },
    [STORAGE_NAME]: storageBinding(),
  };
  const before = f.commits();
  const result = await f.write(bindings);
  assert.equal(result.projectId, f.params.projectId);
  assert.equal(
    result.bindingSetVersion,
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
    { worker: NATIVE_WORKER, entry: { modelIdentifier: MODEL } },
    { worker: NATIVE_WORKER, entry: null },
  ]);
  assert.deepEqual(
    result.changes,
    Object.keys(bindings).map((name) => ({
      kind: ChangeKind.Created,
      bindingId: result.bindings[name]!.id,
    })),
  );
  for (const binding of Object.values(result.bindings))
    assert.equal(binding.revision, REVISION_ONE);
  assertCurrent(f, result);
  const exported = f.invoke("bindingSet.get", null, f.params);
  assert.deepEqual(bindingSetWriteInputSchema.parse(exported), {
    version: result.bindingSetVersion,
    bindings,
  });
  const repeated = await f.write(exported.bindings, exported.version);
  assert.equal(f.ssh.length, TWO_CALLS + TWO_CALLS);
  assert.deepEqual(repeated.bindings, result.bindings);
  assert.equal(repeated.bindingSetVersion, result.bindingSetVersion);
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
    config: { instanceCount: SINGLE_INSTANCE, worker: NATIVE_WORKER },
  };
  for (const binding of [reordered, original]) {
    const version = f.invoke("bindingSet.get", null, f.params).version;
    const result = await f.write({ [WORKER_NAME]: binding }, version);
    assert.equal(result.bindingSetVersion, version);
    assert.deepEqual(result.bindings, first.bindings);
    assert.deepEqual(result.changes, [
      {
        kind: ChangeKind.Unchanged,
        bindingId: first.bindings[WORKER_NAME]!.id,
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
    { bindingSetVersion: first.bindingSetVersion },
  );
  await rejectsWrite(
    f.write(
      { [WORKER_NAME]: workerBinding(OTHER_WORKER) },
      first.bindingSetVersion,
    ),
    HttpStatus.Conflict,
    ProjectErrorCode.WorkerResourceChanged,
  );
  assert.deepEqual(f.snapshot(), before);
});

test("concurrent writes probe before committing and only one expected version wins", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = NO_CALLS;
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        return sshIdentity("github.com");
      },
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
  await new Promise((resolve) => setImmediate(resolve));
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
    bindingSetVersion: success.value.bindingSetVersion,
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

test("an SSH alias that resolves to a GitHub SSH host is accepted and probed with the alias address", async (t) => {
  const hosts: string[] = [];
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity(host, context, deadlineMs) {
        hosts.push(host);
        assert.equal(f.store.database.isTransaction, false);
        assert.equal(context, f.caller.context);
        assert.ok(deadlineMs <= LS_REMOTE_TIMEOUT_MS);
        return sshIdentity("ssh.github.com");
      },
      async gitLsRemote(address, _context, remaining) {
        f.ssh.push({
          address,
          context: null,
          timeout: remaining,
          transaction: false,
          commits: f.commits(),
        });
        assert.ok(remaining <= LS_REMOTE_TIMEOUT_MS);
      },
    },
  });
  const result = await f.write({
    [REPOSITORY_NAME]: repositoryBinding(ALIAS_ADDRESS),
  });
  assert.ok(result.bindings[REPOSITORY_NAME]);
  assert.deepEqual(hosts, [ALIAS_HOST]);
  assert.deepEqual(
    f.ssh.map((call) => call.address),
    [ALIAS_ADDRESS],
  );
});

test("an alias that resolves outside the GitHub SSH host set is refused before the read and the commit", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        return sshIdentity("gitlab.com");
      },
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
    credentialMetadata: (_tx, name) => {
      const record = sshPinMetadata(name);
      return {
        ...record,
        metadata: { ...record.metadata, hostname: "gitlab.com" },
      };
    },
  });
  const before = f.snapshot();
  const commits = f.commits();
  await rejectsWrite(
    f.write({ [REPOSITORY_NAME]: repositoryBinding(ALIAS_ADDRESS) }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryAddressInvalid,
  );
  assert.equal(f.commits(), commits);
  assert.deepEqual(f.snapshot(), before);
});

test("a failed host resolution is refused with address_invalid before the read and the commit", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        throw new Error("ssh -G failed");
      },
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const before = f.snapshot();
  const commits = f.commits();
  await rejectsWrite(
    f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryAddressInvalid,
  );
  assert.equal(f.commits(), commits);
  assert.deepEqual(f.snapshot(), before);
});

test("a host that starts with a hyphen is refused without a resolution", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        assert.fail("The resolution must not run.");
      },
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  await rejectsWrite(
    f.write({
      [REPOSITORY_NAME]: repositoryBinding("git@-oProxyCommand:owner/repo.git"),
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositoryAddressInvalid,
  );
});

test("an SSH credential whose resolution drifts from its pin is refused before the read and the commit", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        return {
          ...sshIdentity("github.com"),
          identityFiles: ["~/.ssh/id_other"],
        };
      },
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const before = f.snapshot();
  await rejectsWrite(
    f.write({ [REPOSITORY_NAME]: repositoryBinding() }),
    HttpStatus.BadRequest,
    SshErrorCode.Drift,
    { host: "github.com", keys: ["identity_file"] },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("an SSH credential of another host is refused with ssh_host_mismatch before the resolution", async (t) => {
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        assert.fail("The resolution must not run.");
      },
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const binding = repositoryBinding();
  await rejectsWrite(
    f.write({
      [REPOSITORY_NAME]: {
        ...binding,
        config: {
          ...binding.config,
          sshCredential: sshCredentialOf(ALIAS_ADDRESS),
        },
      },
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositorySshHostMismatch,
  );
});

const GITLAB_IDENTITY = "repository:gitlab:acme/api";

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
    result.bindings[REPOSITORY_NAME]?.resourceIdentity,
    GITLAB_IDENTITY,
  );
  assert.deepEqual(
    f.ssh.map((call) => call.address),
    [address],
  );
});

test("the resource check reports an unresolved host as unhealthy and skips the read", async (t) => {
  const reasons: string[] = [];
  const f = fixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        throw new Error("ssh -G failed");
      },
      async gitLsRemote() {
        assert.fail("The read must not run.");
      },
    },
  });
  const entry = f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, project.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return f.project.resourceInventory(tx)[NO_ITEMS];
  });
  assert.ok(entry);
  const context = new CancellationContext(
    background,
    Date.now() + HEALTH_DEADLINE_MS,
  );
  t.after(() => context.cancel());
  assert.equal(
    await entry.check(context, (reason) => reasons.push(reason)),
    ResourceStatus.Unhealthy,
  );
  assert.deepEqual(reasons, [ProjectErrorCode.RepositoryAddressInvalid]);
});

test("SSH failure leaves all rows and the version unchanged without entering commit", async (t) => {
  const failure = new Error("SSH failed");
  let fail = false;
  const addresses: string[] = [];
  const f = writeFixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        return sshIdentity("github.com");
      },
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
        [WORKER_NAME]: workerBinding(),
      },
      first.bindingSetVersion,
    ),
    SSH_FAILURE_STATUS,
    ProjectErrorCode.RepositorySshUnreachable,
  );
  assert.deepEqual(addresses, [REPOSITORY_ADDRESS, REPOSITORY_ADDRESS]);
  assert.equal(f.commits(), commits);
  assert.deepEqual(f.snapshot(), before);
});

test("cancellation during gitLsRemote propagates the context error, whether the connector rejects or resolves", async (t) => {
  for (const rejects of [true, false]) {
    const context = new CancellationContext();
    let calls = NO_CALLS;
    const f = writeFixture(t, {
      repositoryConnector: {
        async resolveSshIdentity() {
          return sshIdentity("github.com");
        },
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
      (error) => error === context.err(),
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
          config: { ...workerBinding().config, instanceCount },
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
        config: { ...repositoryBinding().config, projectPrompt },
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
          projectPrompt: "a".repeat(PROJECT_PROMPT_MAX_BYTES + ONE_BYTE_OVER),
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
          config: { ...workerBinding().config, instanceCount },
        },
        [REPOSITORY_NAME]: {
          ...repositoryBinding(),
          config: {
            ...repositoryBinding().config,
            projectPrompt: "a".repeat(PROJECT_PROMPT_MAX_BYTES),
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
    WorkerErrorCode.InvalidConfiguration,
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
  assert.equal(failure.code, WorkerErrorCode.InvalidConfiguration);
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
          : { turns: SINGLE_INSTANCE, wallTimeMs: SINGLE_INSTANCE },
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
        baseBranch: "main",
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
    params: { projectId: "project" },
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
  const params = { projectId: createIdentity(PROJECT_ID_PREFIX) };
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
    nextCursor: null,
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
    f.invoke("binding.get", null, { ...f.params, bindingId: pinned.id }),
    pinned,
  );
  const second = await f.write(
    {
      [WORKER_NAME]: {
        ...workerBinding(),
        config: { ...workerBinding().config, instanceCount: TWO_INSTANCES },
      },
      [STORAGE_NAME]: storageBinding(),
    },
    first.bindingSetVersion,
  );
  const third = await f.write(
    { [STORAGE_NAME]: storageBinding() },
    second.bindingSetVersion,
  );
  const removedId = third.changes.find(
    ({ kind }) => kind === ChangeKind.Removed,
  )!.bindingId;
  const removed = f.invoke("binding.get", null, {
    ...f.params,
    bindingId: removedId,
  });
  assert.notEqual(removed.removedAt, null);
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
    cursor = page.nextCursor;
    if (binding !== expected.at(-FIRST_PAGE_LIMIT))
      assert.equal(cursor, Buffer.from(binding.id).toString(CURSOR_ENCODING));
  }
  assert.equal(cursor, null);
  const params = { ...f.params, bindingId: pinned.id };
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
    cursor = page.nextCursor;
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
          bindingId: createIdentity(BINDING_ID_PREFIX),
        }),
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
    );
    refuses(
      () =>
        f.invoke(operation, null, {
          projectId: other.id,
          bindingId: pinned.id,
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
    agentProvider: "default",
    modelIdentifier: MODEL,
    reasoningEffort: "low",
  };
  const effective = {
    ...defaults,
    provider: "provider",
    credential: "credential",
  };
  const issues = [{ path: ["modelIdentifier"], code: "example.issue" }];
  const view = { defaults, effective, valid: false, issues };
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
        instanceCount: SINGLE_INSTANCE,
        entries: [{ agent: SECOND_AGENT, modelIdentifier: MODEL }],
      },
    },
  });
  const bindingId = result.bindings[WORKER_NAME]!.id;
  const params = { ...f.params, bindingId };
  const expected = (agent: string, entry: WorkerEntry | null) => ({
    agent,
    worker: NATIVE_WORKER,
    workerBindingId: bindingId,
    bindingSetVersion: result.bindingSetVersion,
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
      expected(SECOND_AGENT, { modelIdentifier: MODEL }),
    ],
    nextCursor: Buffer.from(SECOND_AGENT).toString(CURSOR_ENCODING),
  });
  const last = f.invoke("agentConfiguration.list", null, params, {
    limit: AGENT_PAGE_LIMIT,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(last, {
    items: [expected(THIRD_AGENT, null)],
    nextCursor: null,
  });
  assert.deepEqual(
    f.invoke("agentConfiguration.get", null, {
      ...params,
      agentName: SECOND_AGENT,
    }),
    expected(SECOND_AGENT, { modelIdentifier: MODEL }),
  );
  assert.deepEqual(calls, [
    { agent: AGENT, entry: null },
    { agent: SECOND_AGENT, entry: { modelIdentifier: MODEL } },
    { agent: THIRD_AGENT, entry: null },
    { agent: SECOND_AGENT, entry: { modelIdentifier: MODEL } },
  ]);
  assert.equal(f.commits(), before + REVISION_THREE);
  for (const cursor of [MALFORMED_CURSOR, `${first.nextCursor}=`])
    refuses(
      () => f.invoke("agentConfiguration.list", null, params, { cursor }),
      HttpStatus.BadRequest,
      ProjectErrorCode.CursorInvalid,
    );
  refuses(
    () =>
      f.invoke("agentConfiguration.get", null, {
        ...params,
        agentName: UNKNOWN_AGENT,
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
  const params = { ...f.params, bindingId: workerId };
  assert.deepEqual(f.invoke("agentConfiguration.list", null, params), {
    items: [],
    nextCursor: null,
  });
  const missingProject = {
    ...params,
    projectId: createIdentity(PROJECT_ID_PREFIX),
  };
  const other = f.invoke("create", { name: OTHER_NAME });
  const foreign = { ...params, projectId: other.id };
  const absent = { ...params, bindingId: createIdentity(BINDING_ID_PREFIX) };
  const nonWorker = { ...params, bindingId: result.bindings[STORAGE_NAME]!.id };
  for (const operation of [
    "agentConfiguration.list",
    "agentConfiguration.get",
  ] as const) {
    const input: Record<string, string> =
      operation === AGENT_GET_KEY ? { agentName: AGENT } : {};
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
    project.bindingSetVersion,
    new Map(Object.entries(bindings)),
  );
  assert.ok(result.newVersion >= project.bindingSetVersion);
  return {
    ...result,
    bindings: Object.fromEntries(readCurrentBindingSet(tx, projectId)),
  };
}

test("resource inventory reads current repository revisions and excludes removed and non-repository bindings", (t) => {
  let calls = NO_CALLS;
  const f = fixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        return sshIdentity("github.com");
      },
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
      async resolveSshIdentity() {
        return sshIdentity("github.com");
      },
      async gitLsRemote(address, context, remaining) {
        calls++;
        assert.equal(address, REPOSITORY_ADDRESS);
        const deadline = context.deadline();
        assert.ok(deadline !== null);
        assert.ok(remaining > NO_ITEMS);
        assert.ok(remaining <= deadline - beforeCall);
        assert.equal(f.store.database.isTransaction, false);
        if (context.err()) throw context.err();
        if (failure) throw failure;
      },
    },
  });
  const entry = f.store.transaction((tx) => {
    const project = insertProject(tx, PROJECT_NAME);
    persistBindings(tx, project.id, { [REPOSITORY_NAME]: repositoryBinding() });
    return f.project.resourceInventory(tx)[NO_ITEMS];
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
  failure = new Error("SSH failed");
  beforeCall = Date.now();
  assert.equal(await entry.check(context), ResourceStatus.Unhealthy);
  const cancelled = new CancellationContext(
    background,
    Date.now() + HEALTH_DEADLINE_MS,
  );
  t.after(() => cancelled.cancel());
  cancelled.cancel();
  beforeCall = Date.now();
  assert.equal(await entry.check(cancelled), ResourceStatus.Unknown);
  assert.equal(calls, TWO_CALLS);
});

test("resource inventory keeps separate checks for the same repository address across projects", async (t) => {
  let calls = NO_CALLS;
  const f = fixture(t, {
    repositoryConnector: {
      async resolveSshIdentity() {
        return sshIdentity("github.com");
      },
      async gitLsRemote(address, context, remaining) {
        calls++;
        assert.equal(address, REPOSITORY_ADDRESS);
        assert.ok(context.deadline() !== null);
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
      agentProvider: ENTRY_PROVIDER,
      modelIdentifier: MODEL,
      reasoningEffort: ENTRY_REASONING,
    };
    persistBindings(tx, first.id, { [WORKER_NAME]: workerBinding() });
    const explicit = persistBindings(tx, first.id, {
      [WORKER_NAME]: {
        kind: BindingKind.Worker,
        config: {
          ...workerBinding().config,
          instanceCount: INSTANCE_COUNT_MIN,
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
          .map((item) => [item.bindingId, item]),
      ),
      new Map([
        [
          explicit.id,
          { bindingId: explicit.id, workerName: NATIVE_WORKER, entry },
        ],
        [
          implicit.id,
          { bindingId: implicit.id, workerName: NATIVE_WORKER, entry: null },
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
        .find(({ bindingId }) => bindingId === explicit.id)?.entry,
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
      new Set(results.map(({ bindingId }) => bindingId)),
      new Set([repository.id, storage.id]),
    );
    assert.equal(results.length, TWO_CALLS);
    assert.deepEqual(
      results.find(({ bindingId }) => bindingId === repository.id),
      {
        bindingId: repository.id,
        projectId: first.id,
        projectName: PROJECT_NAME,
        name: REPOSITORY_NAME,
      },
    );
    assert.deepEqual(
      results.find(({ bindingId }) => bindingId === storage.id),
      {
        bindingId: storage.id,
        projectId: second.id,
        projectName: OTHER_NAME,
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
          .map(({ bindingId }) => bindingId),
      ),
      new Set([original.id, latest.id]),
    );
    assert.deepEqual(calls, [original.id]);
    calls.length = NO_CALLS;
    pinned.clear();
    assert.deepEqual(f.project.bindingsNaming(tx, REPOSITORY_CREDENTIAL), [
      {
        bindingId: latest.id,
        projectId: project.id,
        projectName: PROJECT_NAME,
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
        bindingId: rebound.id,
        projectId: first.id,
        projectName: PROJECT_NAME,
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
        { bindingId: current.id, resourceIdentity: current.resourceIdentity },
      );
      assert.deepEqual(
        f.project.resolveBinding(tx, second.id, REPOSITORY_NAME),
        { bindingId: other.id, resourceIdentity: other.resourceIdentity },
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
        bindingId: latest.id,
        resourceIdentity: latest.resourceIdentity,
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
      f.project.resolveBindingIdentity(tx, first.id, replacement.id)?.bindingId,
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
    assert.equal(added.resourceIdentity, before.resourceIdentity);
    assert.equal(
      f.project.resolveBindingIdentity(tx, project.id, before.id),
      null,
    );
    for (const id of [added.id, latest.id])
      assert.deepEqual(f.project.resolveBindingIdentity(tx, project.id, id), {
        bindingId: latest.id,
        resourceIdentity: latest.resourceIdentity,
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
      bindingId: pinned.id,
      projectId: project.id,
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
          f.project.storageBindingOf(tx, bindingId)?.bindingId,
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
        agentProvider: "default",
        modelIdentifier: "claude-sonnet-4-5",
        reasoningEffort: "off",
      },
    ];
    persistBindings(tx, project.id, {
      [WORKER_NAME]: { ...original, config: { ...original.config, entries } },
    });
    const nested = t.mock.method(f.store, "transaction", unexpected);
    assert.deepEqual(
      f.project.workerBindingRowOf(tx, pinned[WORKER_NAME]!.id),
      {
        bindingId: pinned[WORKER_NAME]!.id,
        projectId: project.id,
        workerName: original.config.worker,
        resourceIdentity: pinned[WORKER_NAME]!.resourceIdentity,
        tombstone: false,
        disabled: false,
        entries: [],
        resourceBudget: null,
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
    original.config.projectPrompt = projectPrompt;
    const pinned = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: original,
    }).bindings[REPOSITORY_NAME]!;
    const later = persistBindings(tx, project.id, {
      [REPOSITORY_NAME]: {
        ...original,
        config: {
          ...original.config,
          strategy: {
            baseBranch,
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
      bindingId: pinned.id,
      projectId: project.id,
      name: REPOSITORY_NAME,
      address: original.config.address,
      platform: original.config.platform,
      sshCredential: original.config.sshCredential,
      credential: original.config.credential,
      baseBranch: original.config.strategy.baseBranch,
      action: GitHubAction.PullRequest,
      projectPrompt,
    });
    const latest = f.project.repositoryPolicyOf(tx, later.id);
    assert.equal(latest?.action, GitHubAction.MergePush);
    assert.equal(latest?.baseBranch, baseBranch);
  });
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
        assert.equal(policy.bindingId, bindingId);
        assert.equal(policy.action, null);
        assert.equal(policy.projectPrompt, null);
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
            instanceCount: disabled ? INSTANCE_COUNT_MIN : SINGLE_INSTANCE,
          },
        },
        [STORAGE_NAME]: {
          ...storageBinding(),
          config: { ...storageBinding().config, available: !disabled },
        },
      });
      for (const row of Object.values(original))
        assert.deepEqual(f.project.getBindingRevision(tx, row.id), {
          projectId: project.id,
          bindingId: row.id,
          name: row.name,
          resourceIdentity: row.resourceIdentity,
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
      f.project.getBindingRevision(tx, removed.bindingId)?.tombstone,
      true,
    );
    const rebound = persistBindings(tx, first.id, {
      [WORKER_NAME]: {
        ...workerBinding(),
        config: {
          ...workerBinding().config,
          instanceCount: INSTANCE_COUNT_MIN,
        },
      },
    }).bindings[WORKER_NAME]!;
    assert.equal(f.project.getBindingRevision(tx, old.id)?.tombstone, true);
    assert.equal(f.project.getBindingRevision(tx, old.id)?.disabled, true);
    assert.equal(
      f.project.getBindingRevision(tx, removed.bindingId)?.tombstone,
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
          f.project.resolveBinding(tx, project.id, WORKER_NAME)?.bindingId,
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
      async resolveSshIdentity(host: string) {
        return sshIdentity(host);
      },
      async gitLsRemote(address: string, context: Context, timeout: number) {
        sshCalls.push({ address, timeout });
        sshStarted.resolve();
        if (addressBehavior === ADDRESS_SSH_FAIL) throw new Error("SSH failed");
        if (addressBehavior === ADDRESS_SSH_HANG) {
          await context.done();
          throw context.err();
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
    projectId: project.id,
    bindingId: binding.id,
  });
  assert.deepEqual(result.address, {
    status: ResourceStatus.Healthy,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  });
  assert.deepEqual(result.sshCredential, credentialAnswer);
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
    projectId: project.id,
    bindingId: binding.id,
  });
  assert.equal(result.address.status, ResourceStatus.Unhealthy);
  assert.equal(result.address.capability, RESOURCE_CAPABILITY_NETWORK_GIT_READ);
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
    projectId: project.id,
    bindingId: binding.id,
  });
  await sshStarted.promise;
  t.mock.timers.tick(BINDING_CHECK_TIMEOUT_MS);
  const result = await pending;
  assert.deepEqual(result.address, {
    status: ResourceStatus.Unknown,
    capability: RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  });
  assert.deepEqual(credentialCalls, [
    sshCredentialOf(REPOSITORY_ADDRESS),
    REPOSITORY_CREDENTIAL,
  ]);
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
      projectId: project.id,
      bindingId: binding.id,
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
      projectId: project.id,
      bindingId: `${BINDING_ID_PREFIX}_01ARZ3NDEKTSV4RRFFQ69G5FAV`,
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
      p.bindingSetVersion,
      new Map([[REPOSITORY_NAME, repositoryBinding()]]),
    );
    const bindingId = result.changes[NO_ITEMS]?.bindingId;
    assert.ok(bindingId);
    writeBindingSet(
      tx,
      p.id,
      p.bindingSetVersion + VERSION_INCREMENT,
      new Map(),
    );
    return { projectId: p.id, bindingId };
  });
  await assert.rejects(
    f.invokeAsync("binding.verify", {
      projectId: project.projectId,
      bindingId: project.bindingId,
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
      p.bindingSetVersion,
      new Map([[WORKER_NAME, workerBinding()]]),
    );
    const bindingId = result.changes[NO_ITEMS]?.bindingId;
    assert.ok(bindingId);
    return { projectId: p.id, bindingId };
  });
  await assert.rejects(
    f.invokeAsync("binding.verify", {
      projectId: project.projectId,
      bindingId: project.bindingId,
    }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, ProjectErrorCode.BindingNotFound);
      return true;
    },
  );
});

async function checkBinding(
  f: ReturnType<typeof fixture>,
  projectId: string,
  config: unknown,
) {
  const operation = projectOperations["binding.check"];
  const input = operation.input.parse({
    params: { projectId },
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
    },
    sshCredential: credentialAnswer,
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
  assert.deepEqual(suitability, [
    { credential: REPOSITORY_CREDENTIAL, platform: REPOSITORY_PLATFORM },
    {
      credential: sshCredentialOf(REPOSITORY_ADDRESS),
      platform: SSH_CREDENTIAL_PLATFORM,
    },
  ]);
  assert.equal(f.commits(), commits + ONE_CALL);
  assert.equal(
    f.store.database.prepare("SELECT id FROM project_binding").all().length,
    NO_ITEMS,
  );
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
      sshCredential: sshCredentialOf(ALIAS_ADDRESS),
    }),
    HttpStatus.BadRequest,
    ProjectErrorCode.RepositorySshHostMismatch,
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
