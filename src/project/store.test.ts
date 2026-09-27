import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  BINDING_ID_PREFIX,
  BINDING_SET_INITIAL_VERSION,
  BindingKind,
  BindingState,
  ChangeKind,
  LIST_LIMIT_DEFAULT,
  PROJECT_ID_PREFIX,
  PROJECT_SERVICE_NAME,
  ProjectErrorCode,
  REPOSITORY_PLATFORM,
} from "./contract.ts";
import { projectMigrations } from "./migrations.ts";
import {
  deriveResourceIdentity,
  kindOf,
  listBindings,
  listRevisions,
  readBindingRevision,
  readCurrentBindingSet,
  writeBindingSet,
} from "./store.ts";

const NONE = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const FOUR = 4;
const SIX = 6;
const FIRST = 0;
const SECOND = 1;
const PAGE_LIMIT = 1;
const PROJECT_NAME = "atlas";
const OTHER_PROJECT_NAME = "other-project";
const MAIN = "main";
const OTHER = "other";
const AGENT = "agent";
const EVIDENCE = "evidence";
const REPOSITORY_IDENTITY = "repository:github:owner/first";
const OTHER_REPOSITORY_IDENTITY = "repository:github:owner/second";
const WORKER_IDENTITY = "worker:kanthord:agent";
const STORAGE_IDENTITY = "storage:s3:objects.example:9443/evidence";
const UNKNOWN_KIND = "unknown";
const UNKNOWN_ID = "binding_00000000000000000000000000";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const ROLLBACK = new Error("Caller aborts transaction.");

type Entry = { kind: string; config: unknown };
const repository = (
  address = "git@github.com:owner/first.git",
  available = true,
): Entry => ({
  kind: BindingKind.Repository,
  config: {
    platform: REPOSITORY_PLATFORM,
    address,
    available,
    credential: "github",
    strategy: { baseBranch: "main" },
  },
});
const worker = (name = "general", instanceCount = ONE): Entry => ({
  kind: BindingKind.Worker,
  config: { worker: name, instanceCount },
});
const storage = (): Entry => ({
  kind: BindingKind.Storage,
  config: {
    available: true,
    endpoint: "https://objects.example:9443/path",
    bucket: "evidence",
    region: "local",
    prefix: "",
    credential: "s3",
  },
});
const submission = (...entries: [string, Entry][]) => new Map(entries);
const encode = (value: string) =>
  Buffer.from(value, TEXT_ENCODING).toString(CURSOR_ENCODING);

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: PROJECT_SERVICE_NAME, migrations: projectMigrations },
  ]);
  const projectId = createIdentity(PROJECT_ID_PREFIX);
  store.transaction(({ database }) =>
    database
      .prepare("INSERT INTO project_project VALUES (?, ?, ?, ?)")
      .run(projectId, PROJECT_NAME, BINDING_SET_INITIAL_VERSION, Date.now()),
  );
  const write = (version: number, entries: Map<string, Entry>) =>
    store.transaction((tx) => writeBindingSet(tx, projectId, version, entries));
  const current = () =>
    store.transaction((tx) => readCurrentBindingSet(tx, projectId));
  const rows = () =>
    store.database
      .prepare(
        "SELECT rowid, * FROM project_binding WHERE project_id = ? ORDER BY rowid",
      )
      .all(projectId);
  const version = () =>
    store.database
      .prepare("SELECT binding_set_version FROM project_project WHERE id = ?")
      .get(projectId)!.binding_set_version;
  return { store, projectId, write, current, rows, version };
}

function errorIs(
  status: number,
  code: string,
  details: OperationError["details"] = null,
) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  };
}

function assertChange(
  result: ReturnType<typeof writeBindingSet>,
  kind: string,
  bindingId: string,
) {
  assert.deepEqual(result.changes, [{ kind, bindingId }]);
  assert.ok(identitySchema(BINDING_ID_PREFIX).safeParse(bindingId).success);
}

test("resource identities normalize each kind and kindOf enforces the closed set", () => {
  assert.equal(
    deriveResourceIdentity(BindingKind.Repository, MAIN, repository().config),
    REPOSITORY_IDENTITY,
  );
  assert.equal(
    deriveResourceIdentity(BindingKind.Worker, AGENT, worker().config),
    WORKER_IDENTITY,
  );
  assert.equal(
    deriveResourceIdentity(BindingKind.Storage, EVIDENCE, storage().config),
    STORAGE_IDENTITY,
  );
  for (const [identity, kind] of [
    [REPOSITORY_IDENTITY, BindingKind.Repository],
    [WORKER_IDENTITY, BindingKind.Worker],
    [STORAGE_IDENTITY, BindingKind.Storage],
  ]) {
    assert.equal(kindOf(identity!), kind);
  }
  assert.throws(
    () => kindOf("unknown:github:owner/repo"),
    /Unknown binding kind/,
  );
  assert.throws(
    () => deriveResourceIdentity(UNKNOWN_KIND, MAIN, {}),
    /Unknown binding kind/,
  );
  assert.throws(
    () => deriveResourceIdentity(BindingKind.Storage, EVIDENCE, {}),
    TypeError,
  );
  assert.throws(
    () =>
      deriveResourceIdentity(BindingKind.Storage, EVIDENCE, {
        endpoint: "not-a-url",
        bucket: "bucket",
      }),
    TypeError,
  );
});

test("invalid repository addresses have the public address-invalid error", () => {
  for (const address of [
    "https://github.com/owner/repo.git",
    "git@gitlab.com:owner/repo.git",
    "git@github.com:owner/repo",
    "git@github.com:owner/repo.git\n",
    "git@github.com:owner/nested/repo.git",
    "git@github.com:/repo.git",
    null,
  ]) {
    assert.throws(
      () => deriveResourceIdentity(BindingKind.Repository, MAIN, { address }),
      errorIs(HttpStatus.BadRequest, ProjectErrorCode.RepositoryAddressInvalid),
    );
  }
});

test("new names create revision one with canonical JSON and a new version", (t) => {
  const f = fixture(t);
  const entry = repository();
  const result = f.write(
    BINDING_SET_INITIAL_VERSION,
    submission([MAIN, entry]),
  );
  const binding = f.current().get(MAIN)!;
  assertChange(result, ChangeKind.Created, binding.id);
  assert.equal(result.newVersion, TWO);
  assert.equal(f.version(), TWO);
  assert.equal(binding.revision, ONE);
  assert.equal(binding.removedAt, null);
  assert.equal(binding.projectId, f.projectId);
  assert.deepEqual(binding.config, entry.config);
  assert.equal(f.rows().length, ONE);
  assert.equal(f.rows()[FIRST]!.config, canonicalJSON(entry.config));
  assert.equal(f.rows()[FIRST]!.created_at, binding.createdAt);
});

test("unchanged configuration retains its row and still advances the version", (t) => {
  const f = fixture(t);
  const entries = submission([MAIN, repository()]);
  f.write(ONE, entries);
  const before = f.current().get(MAIN)!;
  const result = f.write(TWO, entries);
  assertChange(result, ChangeKind.Unchanged, before.id);
  assert.equal(result.newVersion, THREE);
  assert.equal(f.version(), THREE);
  assert.equal(f.rows().length, ONE);
  assert.deepEqual(f.current().get(MAIN), before);
});

test("reordered nested JSON is canonical-equal and creates no revision", (t) => {
  const f = fixture(t);
  const config = {
    address: "git@github.com:owner/first.git",
    strategy: {
      baseBranch: "main",
      action: { name: "merge_push", follows: { type: "assessment_passed" } },
    },
    available: true,
  };
  f.write(ONE, submission([MAIN, { kind: BindingKind.Repository, config }]));
  const id = f.current().get(MAIN)!.id;
  const reordered = {
    available: true,
    strategy: {
      action: { follows: { type: "assessment_passed" }, name: "merge_push" },
      baseBranch: "main",
    },
    address: config.address,
  };
  assertChange(
    f.write(
      TWO,
      submission([MAIN, { kind: BindingKind.Repository, config: reordered }]),
    ),
    ChangeKind.Unchanged,
    id,
  );
  assert.equal(f.rows().length, ONE);
  assert.equal(f.version(), THREE);
});

test("same-resource changes append a revision and retain the pinned configuration", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const original = f.current().get(MAIN)!;
  const disabled = repository(undefined, false);
  const result = f.write(TWO, submission([MAIN, disabled]));
  const revised = f.current().get(MAIN)!;
  assertChange(result, ChangeKind.Revised, revised.id);
  assert.notEqual(revised.id, original.id);
  assert.equal(revised.revision, TWO);
  assert.equal(revised.resourceIdentity, original.resourceIdentity);
  assert.deepEqual(revised.config, disabled.config);
  assert.deepEqual(
    f.store.transaction((tx) => readBindingRevision(tx, original.id)),
    original,
  );
  assert.deepEqual(
    f.rows().map((row) => [row.revision, row.removed_at]),
    [
      [1, null],
      [2, null],
    ],
  );
});

test("identity replacement tombstones the old resource before inserting the new one", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const original = f.current().get(MAIN)!;
  const result = f.write(
    TWO,
    submission([MAIN, repository("git@github.com:owner/second.git")]),
  );
  const current = f.current().get(MAIN)!;
  assertChange(result, ChangeKind.Created, current.id);
  assert.equal(current.resourceIdentity, OTHER_REPOSITORY_IDENTITY);
  assert.equal(current.revision, ONE);
  const rows = f.rows();
  assert.equal(rows.length, THREE);
  assert.deepEqual(
    rows.map((row) => [row.resource_identity, row.revision]),
    [
      [REPOSITORY_IDENTITY, 1],
      [REPOSITORY_IDENTITY, 2],
      [OTHER_REPOSITORY_IDENTITY, 1],
    ],
  );
  assert.equal(rows[SECOND]!.config, canonicalJSON(original.config));
  assert.equal(rows[SECOND]!.removed_at, rows[SECOND]!.created_at);
  assert.notEqual(rows[SECOND]!.removed_at, null);
  assert.notEqual(rows[SECOND]!.id, original.id);
  assert.equal(rows[TWO]!.removed_at, null);
});

test("resource swaps insert every tombstone before any new revision", (t) => {
  const f = fixture(t);
  const first = repository();
  const second = repository("git@github.com:owner/second.git");
  f.write(ONE, submission([MAIN, first], [OTHER, second]));
  const result = f.write(TWO, submission([MAIN, second], [OTHER, first]));
  const rows = f.rows();
  assert.equal(rows.length, SIX);
  assert.deepEqual(
    rows.map((row) => [
      row.name,
      row.resource_identity,
      row.revision,
      row.removed_at !== null,
    ]),
    [
      [MAIN, REPOSITORY_IDENTITY, 1, false],
      [OTHER, OTHER_REPOSITORY_IDENTITY, 1, false],
      [MAIN, REPOSITORY_IDENTITY, 2, true],
      [OTHER, OTHER_REPOSITORY_IDENTITY, 2, true],
      [MAIN, OTHER_REPOSITORY_IDENTITY, 3, false],
      [OTHER, REPOSITORY_IDENTITY, 3, false],
    ],
  );
  assert.deepEqual(
    result.changes,
    Array.from(f.current().values())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((binding) => ({ kind: ChangeKind.Created, bindingId: binding.id })),
  );
  assert.equal(f.current().size, TWO);
  assert.equal(f.version(), THREE);
});

test("omission retains all rows and returns the newly inserted tombstone identity", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const original = f.current().get(MAIN)!;
  const result = f.write(TWO, submission());
  const rows = f.rows();
  const tombstone = f.store.transaction((tx) =>
    readBindingRevision(tx, result.changes[FIRST]!.bindingId),
  )!;
  assertChange(result, ChangeKind.Removed, tombstone.id);
  assert.equal(rows.length, TWO);
  assert.equal(f.current().size, NONE);
  assert.equal(tombstone.revision, TWO);
  assert.notEqual(tombstone.removedAt, null);
  assert.deepEqual(tombstone.config, original.config);
  assert.equal(tombstone.resourceIdentity, original.resourceIdentity);
  assert.deepEqual(
    f.store.transaction((tx) => readBindingRevision(tx, original.id)),
    original,
  );
});

test("rebinding a removed resource continues after its tombstone even under a new name", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  f.write(TWO, submission());
  const result = f.write(THREE, submission([OTHER, repository()]));
  const binding = f.current().get(OTHER)!;
  assertChange(result, ChangeKind.Created, binding.id);
  assert.equal(binding.revision, THREE);
  assert.equal(f.rows().length, THREE);
  assert.equal(f.current().has(MAIN), false);
  assert.equal(f.version(), FOUR);
});

test("renaming an allocated resource tombstones its old name before rebinding", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const result = f.write(TWO, submission([OTHER, repository()]));
  assert.deepEqual(
    f.rows().map((row) => [row.name, row.revision, row.removed_at !== null]),
    [
      [MAIN, 1, false],
      [MAIN, 2, true],
      [OTHER, 3, false],
    ],
  );
  assert.deepEqual(
    result.changes.map((change) => change.kind),
    [ChangeKind.Created, ChangeKind.Removed],
  );
  assert.equal(result.changes[FIRST]!.bindingId, f.current().get(OTHER)!.id);
  assert.equal(result.changes[SECOND]!.bindingId, f.rows()[SECOND]!.id);
});

test("worker resource change refuses the entire diff before any write", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()], [AGENT, worker()]));
  const before = f.rows();
  f.store.transaction((tx) => {
    assert.throws(
      () =>
        writeBindingSet(
          tx,
          f.projectId,
          TWO,
          submission(
            [MAIN, repository("git@github.com:owner/second.git")],
            [AGENT, worker("different")],
          ),
        ),
      errorIs(HttpStatus.Conflict, ProjectErrorCode.WorkerResourceChanged),
    );
    assert.deepEqual(f.rows(), before);
    assert.equal(f.version(), TWO);
  });
  assert.deepEqual(f.rows(), before);
});

test("replacing a worker with another kind cannot bypass the worker resource guard", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([AGENT, worker()]));
  const before = f.rows();
  assert.throws(
    () => f.write(TWO, submission([AGENT, repository()])),
    errorIs(HttpStatus.Conflict, ProjectErrorCode.WorkerResourceChanged),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.version(), TWO);
});

test("worker disablement revises the same group without changing its worker", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([AGENT, worker()]));
  const result = f.write(TWO, submission([AGENT, worker(undefined, NONE)]));
  const binding = f.current().get(AGENT)!;
  assertChange(result, ChangeKind.Revised, binding.id);
  assert.equal(binding.resourceIdentity, WORKER_IDENTITY);
  assert.equal(binding.revision, TWO);
  assert.deepEqual(binding.config, worker(undefined, NONE).config);
});

test("invalid configuration in a later diff entry writes no earlier outcomes", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const before = f.rows();
  f.store.transaction((tx) => {
    assert.throws(
      () =>
        writeBindingSet(
          tx,
          f.projectId,
          TWO,
          submission(
            [MAIN, repository("git@github.com:owner/second.git")],
            [OTHER, repository("https://github.com/owner/third.git")],
          ),
        ),
      errorIs(HttpStatus.BadRequest, ProjectErrorCode.RepositoryAddressInvalid),
    );
    assert.deepEqual(f.rows(), before);
    assert.equal(f.version(), TWO);
  });
});

test("stale and concurrent submissions expose the current binding-set version", (t) => {
  const f = fixture(t);
  const readVersion = BINDING_SET_INITIAL_VERSION;
  f.write(readVersion, submission([MAIN, repository()]));
  const before = f.rows();
  assert.throws(
    () => f.write(readVersion, submission()),
    errorIs(HttpStatus.Conflict, ProjectErrorCode.VersionConflict, {
      bindingSetVersion: TWO,
    }),
  );
  assert.throws(
    () => f.write(FOUR, submission()),
    errorIs(HttpStatus.Conflict, ProjectErrorCode.VersionConflict, {
      bindingSetVersion: TWO,
    }),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.version(), TWO);
});

test("missing project and binding reads have explicit absent behavior", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    assert.throws(
      () =>
        writeBindingSet(
          tx,
          createIdentity(PROJECT_ID_PREFIX),
          ONE,
          submission(),
        ),
      errorIs(HttpStatus.NotFound, ProjectErrorCode.ProjectNotFound),
    );
    assert.equal(readBindingRevision(tx, UNKNOWN_ID), null);
    assert.throws(
      () => listRevisions(tx, UNKNOWN_ID, { limit: PAGE_LIMIT }),
      errorIs(HttpStatus.NotFound, ProjectErrorCode.BindingNotFound),
    );
  });
  assert.equal(f.rows().length, NONE);
  assert.equal(f.version(), ONE);
});

test("equal multi-binding and empty submissions advance versions without new rows", (t) => {
  const f = fixture(t);
  assert.deepEqual(f.write(ONE, submission()), {
    newVersion: TWO,
    changes: [],
  });
  const entries = submission(
    [MAIN, repository()],
    [AGENT, worker()],
    [EVIDENCE, storage()],
  );
  f.write(TWO, entries);
  const before = f.rows();
  const result = f.write(THREE, entries);
  assert.deepEqual(
    result.changes,
    Array.from(entries.keys(), (name) => ({
      kind: ChangeKind.Unchanged,
      bindingId: f.current().get(name)!.id,
    })),
  );
  assert.equal(result.newVersion, FOUR);
  assert.deepEqual(f.rows(), before);
});

test("caller owns the transaction and may roll back binding rows and version together", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        writeBindingSet(tx, f.projectId, ONE, submission([MAIN, repository()]));
        assert.equal(f.rows().length, ONE);
        assert.equal(f.version(), TWO);
        throw ROLLBACK;
      }),
    (error) => error === ROLLBACK,
  );
  assert.equal(f.rows().length, NONE);
  assert.equal(f.version(), ONE);
});

test("binding lists select latest rows before filtering state and exact kinds", (t) => {
  const f = fixture(t);
  f.write(
    ONE,
    submission([MAIN, repository()], [AGENT, worker()], [EVIDENCE, storage()]),
  );
  f.write(TWO, submission([AGENT, worker()], [EVIDENCE, storage()]));
  f.store.transaction((tx) => {
    const list = (filter: { kind?: string[]; state?: string } = {}) =>
      listBindings(tx, f.projectId, { limit: LIST_LIMIT_DEFAULT, ...filter });
    assert.deepEqual(
      new Set(list().items.map((binding) => binding.name)),
      new Set([AGENT, EVIDENCE]),
    );
    assert.equal(list({ state: BindingState.Current }).items.length, TWO);
    const removed = list({ state: BindingState.Removed });
    assert.deepEqual(
      removed.items.map((binding) => binding.name),
      [MAIN],
    );
    assert.equal(removed.items[FIRST]!.revision, TWO);
    assert.notEqual(removed.items[FIRST]!.removedAt, null);
    assert.equal(list({ state: BindingState.All }).items.length, THREE);
    assert.equal(list({ kind: [BindingKind.Repository] }).items.length, NONE);
    assert.deepEqual(
      list({ kind: [BindingKind.Worker] }).items.map((binding) => binding.name),
      [AGENT],
    );
    assert.deepEqual(
      new Set(
        list({ kind: [BindingKind.Worker, BindingKind.Storage] }).items.map(
          (binding) => binding.name,
        ),
      ),
      new Set([AGENT, EVIDENCE]),
    );
    assert.equal(
      list({ kind: ["work"], state: BindingState.All }).items.length,
      NONE,
    );
    assert.equal(
      list({ kind: [BindingKind.Repository], state: BindingState.Removed })
        .items.length,
      ONE,
    );
    assert.equal(list({ kind: [] }).items.length, TWO);
    assert.equal(list().nextCursor, null);
  });
});

test("binding lists paginate by descending identity and emit no terminal cursor", (t) => {
  const f = fixture(t);
  f.write(
    ONE,
    submission([MAIN, repository()], [AGENT, worker()], [EVIDENCE, storage()]),
  );
  f.store.transaction((tx) => {
    const expected = Array.from(
      readCurrentBindingSet(tx, f.projectId).values(),
    ).sort((a, b) => b.id.localeCompare(a.id));
    const first = listBindings(tx, f.projectId, { limit: PAGE_LIMIT });
    assert.deepEqual(first.items, expected.slice(NONE, ONE));
    assert.equal(first.nextCursor, encode(first.items[FIRST]!.id));
    const second = listBindings(tx, f.projectId, {
      limit: PAGE_LIMIT,
      cursor: first.nextCursor,
    });
    assert.deepEqual(second.items, expected.slice(ONE, TWO));
    assert.equal(second.nextCursor, encode(second.items[FIRST]!.id));
    const third = listBindings(tx, f.projectId, {
      limit: PAGE_LIMIT,
      cursor: second.nextCursor,
    });
    assert.deepEqual(third.items, expected.slice(TWO));
    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      listBindings(tx, f.projectId, {
        limit: PAGE_LIMIT,
        cursor: encode(third.items[FIRST]!.id),
      }),
      { items: [], nextCursor: null },
    );
    assert.equal(
      listBindings(tx, f.projectId, { limit: THREE }).nextCursor,
      null,
    );
  });
});

test("revision lists paginate descending within the pinned row's group, including tombstones", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()], [AGENT, worker()]));
  const pinned = f.current().get(MAIN)!;
  f.write(
    TWO,
    submission([MAIN, repository(undefined, false)], [AGENT, worker()]),
  );
  f.write(THREE, submission([AGENT, worker()]));
  f.store.transaction((tx) => {
    const first = listRevisions(tx, pinned.id, { limit: PAGE_LIMIT });
    assert.deepEqual(
      first.items.map((binding) => binding.revision),
      [3],
    );
    assert.notEqual(first.items[FIRST]!.removedAt, null);
    assert.equal(first.nextCursor, encode(String(THREE)));
    const second = listRevisions(tx, pinned.id, {
      limit: PAGE_LIMIT,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((binding) => binding.revision),
      [2],
    );
    assert.equal(second.nextCursor, encode(String(TWO)));
    const third = listRevisions(tx, pinned.id, {
      limit: PAGE_LIMIT,
      cursor: second.nextCursor,
    });
    assert.deepEqual(third.items, [pinned]);
    assert.equal(third.nextCursor, null);
    assert.deepEqual(
      listRevisions(tx, pinned.id, {
        limit: PAGE_LIMIT,
        cursor: encode(String(ONE)),
      }),
      { items: [], nextCursor: null },
    );
    const all = listRevisions(tx, first.items[FIRST]!.id, { limit: THREE });
    assert.deepEqual(
      all.items.map((binding) => binding.revision),
      [3, 2, 1],
    );
    assert.equal(all.nextCursor, null);
  });
});

test("project boundaries isolate current sets, allocation, and both lists", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const first = f.current().get(MAIN)!;
  f.store.transaction((tx) => {
    const projectId = createIdentity(PROJECT_ID_PREFIX);
    tx.database
      .prepare("INSERT INTO project_project VALUES (?, ?, ?, ?)")
      .run(projectId, OTHER_PROJECT_NAME, ONE, Date.now());
    const result = writeBindingSet(
      tx,
      projectId,
      ONE,
      submission([OTHER, repository()]),
    );
    const second = readCurrentBindingSet(tx, projectId).get(OTHER)!;
    assertChange(result, ChangeKind.Created, second.id);
    assert.equal(second.revision, ONE);
    assert.deepEqual(
      listBindings(tx, projectId, { limit: LIST_LIMIT_DEFAULT }).items,
      [second],
    );
    assert.deepEqual(
      listBindings(tx, f.projectId, { limit: LIST_LIMIT_DEFAULT }).items,
      [first],
    );
    assert.deepEqual(
      listRevisions(tx, first.id, { limit: LIST_LIMIT_DEFAULT }).items,
      [first],
    );
    assert.deepEqual(
      listRevisions(tx, second.id, { limit: LIST_LIMIT_DEFAULT }).items,
      [second],
    );
  });
});

test("both lists reject malformed and noncanonical cursors with the shared 400 code", (t) => {
  const f = fixture(t);
  f.write(ONE, submission([MAIN, repository()]));
  const bindingId = f.current().get(MAIN)!.id;
  const check = (
    tx: Transaction,
    list: (cursor: string) => unknown,
    cursors: string[],
  ) => {
    assert.ok(tx.database);
    assert.ok(cursors.length > NONE);
    for (const cursor of cursors)
      assert.throws(
        () => list(cursor),
        errorIs(HttpStatus.BadRequest, ProjectErrorCode.CursorInvalid),
      );
  };
  f.store.transaction((tx) => {
    check(
      tx,
      (cursor) => listBindings(tx, f.projectId, { limit: PAGE_LIMIT, cursor }),
      [
        "",
        "!",
        encode("not-a-binding"),
        encode(createIdentity(PROJECT_ID_PREFIX)),
        encode(bindingId.toLowerCase()),
        `${encode(bindingId)}=`,
        encode("binding_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
      ],
    );
    check(
      tx,
      (cursor) => listRevisions(tx, bindingId, { limit: PAGE_LIMIT, cursor }),
      [
        "",
        "!",
        encode("0"),
        encode("-1"),
        encode("1.5"),
        encode("01"),
        encode("1e2"),
        encode(" 1"),
        encode("1\n"),
        encode("9007199254740992"),
        `${encode("1")}=`,
        encode(bindingId),
      ],
    );
  });
});
