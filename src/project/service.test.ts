import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { ProjectService, type Dependencies } from "./service.ts";
import { background, CancellationContext } from "../kernel/context.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { mintHumanIdentity } from "../kernel/caller-mint.ts";
import { IdentityKind } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  BINDING_ID_PREFIX,
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  INSTANCE_COUNT_MIN,
  PROJECT_ID_PREFIX,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  projectOperations,
} from "./contract.ts";
import { projectMigrations } from "./migrations.ts";
import { writeBindingSet } from "./store.ts";

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
const EMPTY_QUERY = {};
const CORE_OPERATIONS = [
  "project.create",
  "project.list",
  "project.get",
  "project.rename",
];
const CURSOR_ENCODING = "base64url";
type OperationKey = "create" | "list" | "get" | "rename";

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
  const project = new ProjectService({
    config: {},
    operationalStore: store,
    health,
    createMission: unexpected,
    liveNodesPinning: unexpected,
    validateEntry: unexpected,
    custodySuitability: unexpected,
    repositoryConnector: { gitLsRemote: unexpected },
    workerAgentsOf: unexpected,
    workerAgentView: unexpected,
    ...overrides,
  });
  t.after(() => project.stop());
  const registry = new OperationRegistry();
  project.declare(registry);
  let commits = NO_CALLS;
  const caller: CallerContext = {
    identity: mintHumanIdentity(ACCOUNT, DISPLAY_NAME, "jti"),
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

test("Project declares exactly four operations and owns its lifecycle probe", async (t) => {
  const { project, registry, health } = fixture(t);
  assert.deepEqual(
    registry
      .all()
      .map(({ operation }) => operation.id)
      .sort(),
    [...CORE_OPERATIONS].sort(),
  );
  assert.equal(await project.resolveWorkerBinding("absent", background), null);
  assert.deepEqual(await health.check(), {
    project: { bindings: HealthStatus.Unavailable },
  });
  const starting = project.start();
  assert.equal(starting, project.start());
  assert.equal(await starting, null);
  assert.deepEqual(await health.check(), {
    project: { bindings: HealthStatus.Healthy },
  });
  const stopping = project.stop();
  assert.equal(stopping, project.stop());
  assert.equal(await stopping, null);
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
      project.resolveWorkerBinding("absent", context),
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
      workerBindingId: "binding",
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

function bindingFixture(t: TestContext) {
  const f = fixture(t, { createMission: allowMission });
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

test("resolveWorkerBinding returns current and pinned worker identities using the latest configuration", async (t) => {
  const f = bindingFixture(t);
  const pinned = f.write(SINGLE_INSTANCE);
  const identity = { workerBindingId: pinned, projectId: f.projectId };
  assert.deepEqual(
    await f.project.resolveWorkerBinding(pinned, background),
    identity,
  );
  const latest = f.write(TWO_INSTANCES);
  assert.deepEqual(
    await f.project.resolveWorkerBinding(pinned, background),
    identity,
  );
  assert.deepEqual(await f.project.resolveWorkerBinding(latest, background), {
    workerBindingId: latest,
    projectId: f.projectId,
  });
  f.write(INSTANCE_COUNT_MIN);
  assert.equal(await f.project.resolveWorkerBinding(pinned, background), null);
});

test("resolveWorkerBinding rejects absent and disabled bindings", async (t) => {
  const f = bindingFixture(t);
  assert.equal(
    await f.project.resolveWorkerBinding(
      createIdentity(BINDING_ID_PREFIX),
      background,
    ),
    null,
  );
  const disabled = f.write(INSTANCE_COUNT_MIN);
  assert.equal(
    await f.project.resolveWorkerBinding(disabled, background),
    null,
  );
});

test("resolveWorkerBinding rejects a removed row and a pin followed by a tombstone", async (t) => {
  const f = bindingFixture(t);
  const pinned = f.write(SINGLE_INSTANCE);
  const tombstone = f.write(null);
  assert.equal(
    await f.project.resolveWorkerBinding(tombstone, background),
    null,
  );
  assert.equal(await f.project.resolveWorkerBinding(pinned, background), null);
});

test("resolveWorkerBinding rejects non-worker bindings", async (t) => {
  const f = bindingFixture(t);
  const result = f.store.transaction((tx) =>
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
        [
          "storage",
          {
            kind: BindingKind.Storage,
            config: { endpoint: "https://s3.example.com", bucket: "bucket" },
          },
        ],
      ]),
    ),
  );
  for (const { bindingId } of result.changes)
    assert.equal(
      await f.project.resolveWorkerBinding(bindingId, background),
      null,
    );
});

test("the optional binding override retains its identity and context and never bypasses cancellation", async (t) => {
  const identity = {
    workerBindingId: "fake-binding",
    projectId: "fake-project",
  };
  let calls = NO_CALLS;
  const f = fixture(t, {
    bindings: {
      async resolveWorkerBinding(id, context) {
        calls++;
        assert.equal(id, identity.workerBindingId);
        assert.equal(context, background);
        return identity;
      },
    },
  });
  assert.equal(
    await f.project.resolveWorkerBinding(identity.workerBindingId, background),
    identity,
  );
  const context = new CancellationContext();
  context.cancel();
  await assert.rejects(
    f.project.resolveWorkerBinding(identity.workerBindingId, context),
    (error) => error === context.err(),
  );
  assert.equal(calls, ONE_CALL);
});
