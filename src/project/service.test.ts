import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ProjectService, type Dependencies } from "./service.ts";
import { background, CancellationContext } from "../kernel/context.ts";
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
import {
  testHumanIdentity,
  testMachineIdentity,
} from "../kernel/test-identity.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { WorkerErrorCode } from "../worker/contract.ts";
import {
  BINDING_ID_PREFIX,
  AuthorizationRefusal,
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  BindingState,
  ChangeKind,
  FollowsType,
  GitHubAction,
  INSTANCE_COUNT_MIN,
  INSTANCE_COUNT_MAX,
  LS_REMOTE_TIMEOUT_MS,
  PROJECT_PROMPT_MAX_BYTES,
  REPOSITORY_PLATFORM,
  RESOURCE_CAPABILITY_NETWORK_GIT_READ,
  RESOURCE_TARGET_KIND_REPOSITORY,
  STORAGE_PLATFORM,
  WorkerField,
  bindingSetWriteInputSchema,
  type WorkerEntry,
  PROJECT_ID_PREFIX,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  projectOperations,
} from "./contract.ts";
import { projectMigrations } from "./migrations.ts";
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
];
const CURSOR_ENCODING = "base64url";
type OperationKey = Exclude<keyof typeof projectOperations, "bindingSet.write">;

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
  const wakes: string[] = [];
  const registrationEnds: Array<{
    projectId: string;
    resourceIdentity: string;
    now: number;
  }> = [];
  const project = new ProjectService({
    config: {},
    operationalStore: store,
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
    repositoryConnector: { gitLsRemote: unexpected },
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
  return {
    store,
    project,
    health,
    registry,
    caller,
    invoke,
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

test("model inference authorization preserves pinned entries and checks every chain break", (t) => {
  const nativeAgent = "swe@1";
  const provider = "anthropic";
  const credential = "anthro-1";
  const selected = "override";
  let agents = [nativeAgent];
  let valid = true;
  const issues = [{ path: ["agent"], code: WorkerErrorCode.Unavailable }];
  const f = bindingFixture(t, {
    workerAgentsOf: () => agents,
    workerAgentView: (tx, worker, agent, entry) => {
      assert(tx.database.isTransaction);
      assert.equal(agent, nativeAgent);
      assert.equal(worker, GROUP_WORKER_NAME);
      return {
        valid,
        issues: valid ? [] : issues,
        defaults: null,
        effective: valid
          ? {
              agentProvider: entry?.agentProvider ?? "default",
              provider,
              credential,
              modelIdentifier: "claude-sonnet-4-5",
              reasoningEffort: "off",
            }
          : null,
      };
    },
  });
  const bindingId = f.write(SINGLE_INSTANCE);
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      name: "test",
      projectId: f.projectId,
      resourceIdentity: WORKER_GROUP,
      issuedAt: 0,
    },
    "jti",
  );
  const execution = {
    executionId: createIdentity("execution"),
    projectId: f.projectId,
    workerBindingId: bindingId,
    resourceIdentity: WORKER_GROUP,
  };
  const authorize = (change = {}) =>
    f.store.transaction((tx) =>
      f.project.authorizeModelInference(tx, identity, {
        ...execution,
        ...change,
      }),
    );
  assert.deepEqual(authorize(), {
    credential,
    platform: provider,
    providerId: provider,
    agentProvider: "default",
  });
  f.store.transaction((tx) =>
    tx.database
      .prepare("UPDATE project_binding SET config = ? WHERE id = ?")
      .run(
        JSON.stringify({
          worker: GROUP_WORKER_NAME,
          instanceCount: SINGLE_INSTANCE,
          entries: [{ agent: nativeAgent, agentProvider: selected }],
        }),
        bindingId,
      ),
  );
  assert.equal(authorize().agentProvider, selected);
  f.write(TWO_INSTANCES);
  assert.equal(authorize().agentProvider, selected);
  for (const change of [
    { workerBindingId: "absent" },
    { projectId: "other" },
    { resourceIdentity: MISSING_GROUP },
  ])
    refuses(
      () => authorize(change),
      HttpStatus.Forbidden,
      ProjectErrorCode.AuthorizationRefused,
      { reason: AuthorizationRefusal.BindingMismatch },
    );
  agents = [];
  refuses(
    authorize,
    HttpStatus.Forbidden,
    ProjectErrorCode.AuthorizationRefused,
    { reason: AuthorizationRefusal.NoNativeAgent },
  );
  agents = [nativeAgent];
  valid = false;
  refuses(authorize, HttpStatus.BadRequest, WorkerErrorCode.Unavailable, {
    issues,
  });
  valid = true;
  f.write(INSTANCE_COUNT_MIN);
  refuses(
    authorize,
    HttpStatus.Forbidden,
    ProjectErrorCode.AuthorizationRefused,
    { reason: AuthorizationRefusal.BindingDisabled },
  );
  f.write(null);
  refuses(
    authorize,
    HttpStatus.Forbidden,
    ProjectErrorCode.AuthorizationRefused,
    { reason: AuthorizationRefusal.BindingRemoved },
  );
  f.write(SINGLE_INSTANCE);
  refuses(
    authorize,
    HttpStatus.Forbidden,
    ProjectErrorCode.AuthorizationRefused,
    { reason: AuthorizationRefusal.BindingRemoved },
  );
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
const SECOND_REPOSITORY_ADDRESS = "git@github.com:owner/other.git";
const REPOSITORY_CREDENTIAL = "github-key";
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
    BINDING_SET_INITIAL_VERSION + VERSION_INCREMENT,
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
  assert.deepEqual(f.custody, [
    { credential: REPOSITORY_CREDENTIAL, platform: REPOSITORY_PLATFORM },
    { credential: REPOSITORY_CREDENTIAL, platform: REPOSITORY_PLATFORM },
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
  assert.equal(
    repeated.bindingSetVersion,
    result.bindingSetVersion + VERSION_INCREMENT,
  );
  assert.ok(
    repeated.changes.every(({ kind }) => kind === ChangeKind.Unchanged),
  );
  assertCurrent(f, repeated);
});

test("equal and reordered configurations increment the version without inserting revisions", async (t) => {
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
    assert.equal(result.bindingSetVersion, version + VERSION_INCREMENT);
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
  assert.deepEqual(f.custody, []);
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
  assert.equal(
    result.newVersion,
    project.bindingSetVersion + VERSION_INCREMENT,
  );
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
  assert.equal(calls, REVISION_THREE);
});

test("resource inventory keeps separate checks for the same repository address across projects", async (t) => {
  let calls = NO_CALLS;
  const f = fixture(t, {
    repositoryConnector: {
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
      { bindingId: repository.id, projectId: first.id },
    );
    assert.deepEqual(
      results.find(({ bindingId }) => bindingId === storage.id),
      { bindingId: storage.id, projectId: second.id },
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
      { bindingId: latest.id, projectId: project.id },
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
      { bindingId: rebound.id, projectId: first.id },
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
