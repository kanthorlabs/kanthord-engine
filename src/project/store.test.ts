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
  bindingSetWriteInputSchema,
} from "./contract.ts";

test("action follows accepts assessment and refuses action dependencies before relation diagnostics", () => {
  const refusal =
    "Action follows must name the passing assessment until a claim-source contract exists.";
  const repository = (follows: unknown) => ({
    kind: "repository",
    config: {
      available: true,
      platform: "github",
      address: "git@github.com:owner/repo.git",
      ssh_credential: "github-ssh",
      credential: "github",
      strategy: {
        base_branch: "main",
        action: { name: "pull_request", follows },
      },
    },
  });
  const passing = repository({ type: "assessment_passed" });
  assert.equal(
    bindingSetWriteInputSchema.safeParse({
      version: INITIAL_BINDING_VERSION,
      bindings: { repo: passing },
    }).success,
    true,
  );
  const path = [
    "bindings",
    "repo",
    "config",
    "strategy",
    "action",
    "follows",
    "binding",
  ];
  for (const target of ["repo", "other", "missing"]) {
    const parsed = bindingSetWriteInputSchema.safeParse({
      version: INITIAL_BINDING_VERSION,
      bindings: {
        repo: repository({ type: "action_end_state", binding: target }),
        other: passing,
      },
    });
    assert.equal(parsed.success, false);
    assert.ok(!parsed.success);
    assert.equal(parsed.error.issues[0]?.message, refusal);
    assert.deepEqual(parsed.error.issues[0]?.path, path);
  }
});
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

const EMPTY_BINDING_COUNT = 0;
const INITIAL_BINDING_VERSION = 1;
const DEFAULT_INSTANCE_COUNT = 1;
const SINGLE_BINDING_ROW = 1;
const SECOND_BINDING_VERSION = 2;
const THIRD_ROW_INDEX = 2;
const BINDING_PAIR_COUNT = 2;
const THIRD_BINDING_VERSION = 3;
const TRIPLE_ROW_COUNT = 3;
const FOURTH_BINDING_VERSION = 4;
const SIX_BINDING_ROWS = 6;
const FIRST_ROW_INDEX = 0;
const SECOND_ROW_INDEX = 1;
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
    strategy: { base_branch: "main" },
  },
});
const worker = (
  name = "general",
  instanceCount = DEFAULT_INSTANCE_COUNT,
): Entry => ({
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
      .prepare("INSERT INTO project_project VALUES (?, ?, ?)")
      .run(projectId, PROJECT_NAME, Date.now()),
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
    Number(
      store.database
        .prepare(
          "SELECT COUNT(*) + ? AS version FROM project_binding WHERE project_id = ?",
        )
        .get(BINDING_SET_INITIAL_VERSION, projectId)!.version,
    );
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
  assert.deepEqual(result.changes, [{ kind, binding_id: bindingId }]);
  assert.ok(identitySchema(BINDING_ID_PREFIX).safeParse(bindingId).success);
}

test("an SSH alias address and the github.com address derive the same repository identity", () => {
  const identity = (address: string) =>
    deriveResourceIdentity(
      BindingKind.Repository,
      MAIN,
      repository(address).config,
    );
  assert.equal(
    identity("git@kanthorlabs.github.com:owner/repo.git"),
    identity("git@github.com:owner/repo.git"),
  );
  assert.throws(() => identity("git@-oProxyCommand:owner/repo.git"));
  assert.throws(() => identity("git@.github.com:owner/repo.git"));
});

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
    "git@-github.com:owner/repo.git",
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
    assert.throws(
      () => deriveResourceIdentity(BindingKind.Repository, MAIN, { address }),
      {
        message:
          "Repository address must have the form git@<host>:<owner>/<repository>.git.",
      },
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
  assert.equal(result.newVersion, SECOND_BINDING_VERSION);
  assert.equal(f.version(), SECOND_BINDING_VERSION);
  assert.equal(binding.revision, INITIAL_BINDING_VERSION);
  assert.equal(binding.removed_at, null);
  assert.equal(binding.project_id, f.projectId);
  assert.deepEqual(binding.config, entry.config);
  assert.equal(f.rows().length, SINGLE_BINDING_ROW);
  assert.equal(f.rows()[FIRST_ROW_INDEX]!.config, canonicalJSON(entry.config));
  assert.equal(f.rows()[FIRST_ROW_INDEX]!.created_at, binding.created_at);
});

test("unchanged configuration retains its row and keeps the version", (t) => {
  const f = fixture(t);
  const entries = submission([MAIN, repository()]);
  f.write(INITIAL_BINDING_VERSION, entries);
  const before = f.current().get(MAIN)!;
  const result = f.write(SECOND_BINDING_VERSION, entries);
  assertChange(result, ChangeKind.Unchanged, before.id);
  assert.equal(result.newVersion, SECOND_BINDING_VERSION);
  assert.equal(f.version(), SECOND_BINDING_VERSION);
  assert.equal(f.rows().length, SINGLE_BINDING_ROW);
  assert.deepEqual(f.current().get(MAIN), before);
});

test("reordered nested JSON is canonical-equal and creates no revision", (t) => {
  const f = fixture(t);
  const config = {
    address: "git@github.com:owner/first.git",
    strategy: {
      base_branch: "main",
      action: { name: "merge_push", follows: { type: "assessment_passed" } },
    },
    available: true,
  };
  f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, { kind: BindingKind.Repository, config }]),
  );
  const id = f.current().get(MAIN)!.id;
  const reordered = {
    available: true,
    strategy: {
      action: { follows: { type: "assessment_passed" }, name: "merge_push" },
      base_branch: "main",
    },
    address: config.address,
  };
  assertChange(
    f.write(
      SECOND_BINDING_VERSION,
      submission([MAIN, { kind: BindingKind.Repository, config: reordered }]),
    ),
    ChangeKind.Unchanged,
    id,
  );
  assert.equal(f.rows().length, SINGLE_BINDING_ROW);
  assert.equal(f.version(), SECOND_BINDING_VERSION);
});

test("same-resource changes append a revision and retain the pinned configuration", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const original = f.current().get(MAIN)!;
  const disabled = repository(undefined, false);
  const result = f.write(SECOND_BINDING_VERSION, submission([MAIN, disabled]));
  const revised = f.current().get(MAIN)!;
  assertChange(result, ChangeKind.Revised, revised.id);
  assert.notEqual(revised.id, original.id);
  assert.equal(revised.revision, SECOND_BINDING_VERSION);
  assert.equal(revised.resource_identity, original.resource_identity);
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
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const original = f.current().get(MAIN)!;
  const result = f.write(
    SECOND_BINDING_VERSION,
    submission([MAIN, repository("git@github.com:owner/second.git")]),
  );
  const current = f.current().get(MAIN)!;
  assertChange(result, ChangeKind.Created, current.id);
  assert.equal(current.resource_identity, OTHER_REPOSITORY_IDENTITY);
  assert.equal(current.revision, INITIAL_BINDING_VERSION);
  const rows = f.rows();
  assert.equal(rows.length, TRIPLE_ROW_COUNT);
  assert.deepEqual(
    rows.map((row) => [row.resource_identity, row.revision]),
    [
      [REPOSITORY_IDENTITY, 1],
      [REPOSITORY_IDENTITY, 2],
      [OTHER_REPOSITORY_IDENTITY, 1],
    ],
  );
  assert.equal(rows[SECOND_ROW_INDEX]!.config, canonicalJSON(original.config));
  assert.equal(
    rows[SECOND_ROW_INDEX]!.removed_at,
    rows[SECOND_ROW_INDEX]!.created_at,
  );
  assert.notEqual(rows[SECOND_ROW_INDEX]!.removed_at, null);
  assert.notEqual(rows[SECOND_ROW_INDEX]!.id, original.id);
  assert.equal(rows[THIRD_ROW_INDEX]!.removed_at, null);
});

test("resource swaps insert every tombstone before any new revision", (t) => {
  const f = fixture(t);
  const first = repository();
  const second = repository("git@github.com:owner/second.git");
  const firstResult = f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, first], [OTHER, second]),
  );
  const result = f.write(
    firstResult.newVersion,
    submission([MAIN, second], [OTHER, first]),
  );
  const rows = f.rows();
  assert.equal(rows.length, SIX_BINDING_ROWS);
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
      .map((binding) => ({ kind: ChangeKind.Created, binding_id: binding.id })),
  );
  assert.equal(f.current().size, BINDING_PAIR_COUNT);
  assert.equal(f.version(), result.newVersion);
});

test("omission retains all rows and returns the newly inserted tombstone identity", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const original = f.current().get(MAIN)!;
  const result = f.write(SECOND_BINDING_VERSION, submission());
  const rows = f.rows();
  const tombstone = f.store.transaction((tx) =>
    readBindingRevision(tx, result.changes[FIRST_ROW_INDEX]!.binding_id),
  )!;
  assertChange(result, ChangeKind.Removed, tombstone.id);
  assert.equal(rows.length, BINDING_PAIR_COUNT);
  assert.equal(f.current().size, EMPTY_BINDING_COUNT);
  assert.equal(tombstone.revision, SECOND_BINDING_VERSION);
  assert.notEqual(tombstone.removed_at, null);
  assert.deepEqual(tombstone.config, original.config);
  assert.equal(tombstone.resource_identity, original.resource_identity);
  assert.deepEqual(
    f.store.transaction((tx) => readBindingRevision(tx, original.id)),
    original,
  );
});

test("rebinding a removed resource continues after its tombstone even under a new name", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  f.write(SECOND_BINDING_VERSION, submission());
  const result = f.write(
    THIRD_BINDING_VERSION,
    submission([OTHER, repository()]),
  );
  const binding = f.current().get(OTHER)!;
  assertChange(result, ChangeKind.Created, binding.id);
  assert.equal(binding.revision, THIRD_BINDING_VERSION);
  assert.equal(f.rows().length, TRIPLE_ROW_COUNT);
  assert.equal(f.current().has(MAIN), false);
  assert.equal(f.version(), FOURTH_BINDING_VERSION);
});

test("renaming an allocated resource tombstones its old name before rebinding", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const result = f.write(
    SECOND_BINDING_VERSION,
    submission([OTHER, repository()]),
  );
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
  assert.equal(
    result.changes[FIRST_ROW_INDEX]!.binding_id,
    f.current().get(OTHER)!.id,
  );
  assert.equal(
    result.changes[SECOND_ROW_INDEX]!.binding_id,
    f.rows()[SECOND_ROW_INDEX]!.id,
  );
});

test("worker resource change refuses the entire diff before any write", (t) => {
  const f = fixture(t);
  const firstResult = f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, repository()], [AGENT, worker()]),
  );
  const before = f.rows();
  f.store.transaction((tx) => {
    assert.throws(
      () =>
        writeBindingSet(
          tx,
          f.projectId,
          firstResult.newVersion,
          submission(
            [MAIN, repository("git@github.com:owner/second.git")],
            [AGENT, worker("different")],
          ),
        ),
      errorIs(HttpStatus.Conflict, ProjectErrorCode.WorkerResourceChanged),
    );
    assert.deepEqual(f.rows(), before);
    assert.equal(f.version(), firstResult.newVersion);
  });
  assert.deepEqual(f.rows(), before);
});

test("replacing a worker with another kind cannot bypass the worker resource guard", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([AGENT, worker()]));
  const before = f.rows();
  assert.throws(
    () => f.write(SECOND_BINDING_VERSION, submission([AGENT, repository()])),
    errorIs(HttpStatus.Conflict, ProjectErrorCode.WorkerResourceChanged),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.version(), SECOND_BINDING_VERSION);
});

test("worker disablement revises the same group without changing its worker", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([AGENT, worker()]));
  const result = f.write(
    SECOND_BINDING_VERSION,
    submission([AGENT, worker(undefined, EMPTY_BINDING_COUNT)]),
  );
  const binding = f.current().get(AGENT)!;
  assertChange(result, ChangeKind.Revised, binding.id);
  assert.equal(binding.resource_identity, WORKER_IDENTITY);
  assert.equal(binding.revision, SECOND_BINDING_VERSION);
  assert.deepEqual(
    binding.config,
    worker(undefined, EMPTY_BINDING_COUNT).config,
  );
});

test("invalid configuration in a later diff entry writes no earlier outcomes", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const before = f.rows();
  f.store.transaction((tx) => {
    assert.throws(
      () =>
        writeBindingSet(
          tx,
          f.projectId,
          SECOND_BINDING_VERSION,
          submission(
            [MAIN, repository("git@github.com:owner/second.git")],
            [OTHER, repository("https://github.com/owner/third.git")],
          ),
        ),
      errorIs(HttpStatus.BadRequest, ProjectErrorCode.RepositoryAddressInvalid),
    );
    assert.deepEqual(f.rows(), before);
    assert.equal(f.version(), SECOND_BINDING_VERSION);
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
      binding_set_version: SECOND_BINDING_VERSION,
    }),
  );
  assert.throws(
    () => f.write(FOURTH_BINDING_VERSION, submission()),
    errorIs(HttpStatus.Conflict, ProjectErrorCode.VersionConflict, {
      binding_set_version: SECOND_BINDING_VERSION,
    }),
  );
  assert.deepEqual(f.rows(), before);
  assert.equal(f.version(), SECOND_BINDING_VERSION);
});

test("missing project and binding reads have explicit absent behavior", (t) => {
  const f = fixture(t);
  f.store.transaction((tx) => {
    assert.throws(
      () =>
        writeBindingSet(
          tx,
          createIdentity(PROJECT_ID_PREFIX),
          INITIAL_BINDING_VERSION,
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
  assert.equal(f.rows().length, EMPTY_BINDING_COUNT);
  assert.equal(f.version(), INITIAL_BINDING_VERSION);
});

test("equal and empty submissions on an equal or empty set keep the version", (t) => {
  const f = fixture(t);
  const emptyResult = f.write(INITIAL_BINDING_VERSION, submission());
  assert.deepEqual(emptyResult, {
    newVersion: INITIAL_BINDING_VERSION,
    changes: [],
  });
  const entries = submission(
    [MAIN, repository()],
    [AGENT, worker()],
    [EVIDENCE, storage()],
  );
  const firstResult = f.write(emptyResult.newVersion, entries);
  const before = f.rows();
  const result = f.write(firstResult.newVersion, entries);
  assert.deepEqual(
    result.changes,
    Array.from(entries.keys(), (name) => ({
      kind: ChangeKind.Unchanged,
      binding_id: f.current().get(name)!.id,
    })),
  );
  assert.equal(result.newVersion, firstResult.newVersion);
  assert.deepEqual(f.rows(), before);
});

test("a write that inserts two rows raises the version by two", (t) => {
  const f = fixture(t);
  const result = f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, repository()], [AGENT, worker()]),
  );
  assert.equal(
    result.newVersion,
    INITIAL_BINDING_VERSION + SECOND_BINDING_VERSION,
  );
  assert.equal(f.version(), result.newVersion);
  assert.equal(f.rows().length, BINDING_PAIR_COUNT);
});

test("caller owns the transaction and may roll back binding rows and version together", (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.store.transaction((tx) => {
        writeBindingSet(
          tx,
          f.projectId,
          INITIAL_BINDING_VERSION,
          submission([MAIN, repository()]),
        );
        assert.equal(f.rows().length, SINGLE_BINDING_ROW);
        assert.equal(f.version(), SECOND_BINDING_VERSION);
        throw ROLLBACK;
      }),
    (error) => error === ROLLBACK,
  );
  assert.equal(f.rows().length, EMPTY_BINDING_COUNT);
  assert.equal(f.version(), INITIAL_BINDING_VERSION);
});

test("binding lists select latest rows before filtering state and exact kinds", (t) => {
  const f = fixture(t);
  const firstResult = f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, repository()], [AGENT, worker()], [EVIDENCE, storage()]),
  );
  f.write(
    firstResult.newVersion,
    submission([AGENT, worker()], [EVIDENCE, storage()]),
  );
  f.store.transaction((tx) => {
    const list = (filter: { kind?: string[]; state?: string } = {}) =>
      listBindings(tx, f.projectId, { limit: LIST_LIMIT_DEFAULT, ...filter });
    assert.deepEqual(
      new Set(list().items.map((binding) => binding.name)),
      new Set([AGENT, EVIDENCE]),
    );
    assert.equal(
      list({ state: BindingState.Current }).items.length,
      SECOND_BINDING_VERSION,
    );
    const removed = list({ state: BindingState.Removed });
    assert.deepEqual(
      removed.items.map((binding) => binding.name),
      [MAIN],
    );
    assert.equal(
      removed.items[FIRST_ROW_INDEX]!.revision,
      SECOND_BINDING_VERSION,
    );
    assert.notEqual(removed.items[FIRST_ROW_INDEX]!.removed_at, null);
    assert.equal(
      list({ state: BindingState.All }).items.length,
      THIRD_BINDING_VERSION,
    );
    assert.equal(
      list({ kind: [BindingKind.Repository] }).items.length,
      EMPTY_BINDING_COUNT,
    );
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
      EMPTY_BINDING_COUNT,
    );
    assert.equal(
      list({ kind: [BindingKind.Repository], state: BindingState.Removed })
        .items.length,
      INITIAL_BINDING_VERSION,
    );
    assert.equal(list({ kind: [] }).items.length, SECOND_BINDING_VERSION);
    assert.equal(list().next_cursor, null);
  });
});

test("binding lists paginate by descending identity and emit no terminal cursor", (t) => {
  const f = fixture(t);
  f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, repository()], [AGENT, worker()], [EVIDENCE, storage()]),
  );
  f.store.transaction((tx) => {
    const expected = Array.from(
      readCurrentBindingSet(tx, f.projectId).values(),
    ).sort((a, b) => b.id.localeCompare(a.id));
    const first = listBindings(tx, f.projectId, { limit: PAGE_LIMIT });
    assert.deepEqual(
      first.items,
      expected.slice(EMPTY_BINDING_COUNT, INITIAL_BINDING_VERSION),
    );
    assert.equal(first.next_cursor, encode(first.items[FIRST_ROW_INDEX]!.id));
    const second = listBindings(tx, f.projectId, {
      limit: PAGE_LIMIT,
      cursor: first.next_cursor,
    });
    assert.deepEqual(
      second.items,
      expected.slice(INITIAL_BINDING_VERSION, SECOND_BINDING_VERSION),
    );
    assert.equal(second.next_cursor, encode(second.items[FIRST_ROW_INDEX]!.id));
    const third = listBindings(tx, f.projectId, {
      limit: PAGE_LIMIT,
      cursor: second.next_cursor,
    });
    assert.deepEqual(third.items, expected.slice(SECOND_BINDING_VERSION));
    assert.equal(third.next_cursor, null);
    assert.deepEqual(
      listBindings(tx, f.projectId, {
        limit: PAGE_LIMIT,
        cursor: encode(third.items[FIRST_ROW_INDEX]!.id),
      }),
      { items: [], next_cursor: null },
    );
    assert.equal(
      listBindings(tx, f.projectId, { limit: THIRD_BINDING_VERSION })
        .next_cursor,
      null,
    );
  });
});

test("revision lists paginate descending within the pinned row's group, including tombstones", (t) => {
  const f = fixture(t);
  const firstResult = f.write(
    INITIAL_BINDING_VERSION,
    submission([MAIN, repository()], [AGENT, worker()]),
  );
  const pinned = f.current().get(MAIN)!;
  const secondResult = f.write(
    firstResult.newVersion,
    submission([MAIN, repository(undefined, false)], [AGENT, worker()]),
  );
  f.write(secondResult.newVersion, submission([AGENT, worker()]));
  f.store.transaction((tx) => {
    const first = listRevisions(tx, pinned.id, { limit: PAGE_LIMIT });
    assert.deepEqual(
      first.items.map((binding) => binding.revision),
      [3],
    );
    assert.notEqual(first.items[FIRST_ROW_INDEX]!.removed_at, null);
    assert.equal(first.next_cursor, encode(String(THIRD_BINDING_VERSION)));
    const second = listRevisions(tx, pinned.id, {
      limit: PAGE_LIMIT,
      cursor: first.next_cursor,
    });
    assert.deepEqual(
      second.items.map((binding) => binding.revision),
      [2],
    );
    assert.equal(second.next_cursor, encode(String(SECOND_BINDING_VERSION)));
    const third = listRevisions(tx, pinned.id, {
      limit: PAGE_LIMIT,
      cursor: second.next_cursor,
    });
    assert.deepEqual(third.items, [pinned]);
    assert.equal(third.next_cursor, null);
    assert.deepEqual(
      listRevisions(tx, pinned.id, {
        limit: PAGE_LIMIT,
        cursor: encode(String(INITIAL_BINDING_VERSION)),
      }),
      { items: [], next_cursor: null },
    );
    const all = listRevisions(tx, first.items[FIRST_ROW_INDEX]!.id, {
      limit: THIRD_BINDING_VERSION,
    });
    assert.deepEqual(
      all.items.map((binding) => binding.revision),
      [3, 2, 1],
    );
    assert.equal(all.next_cursor, null);
  });
});

test("project boundaries isolate current sets, allocation, and both lists", (t) => {
  const f = fixture(t);
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const first = f.current().get(MAIN)!;
  f.store.transaction((tx) => {
    const projectId = createIdentity(PROJECT_ID_PREFIX);
    tx.database
      .prepare("INSERT INTO project_project VALUES (?, ?, ?)")
      .run(projectId, OTHER_PROJECT_NAME, Date.now());
    const result = writeBindingSet(
      tx,
      projectId,
      INITIAL_BINDING_VERSION,
      submission([OTHER, repository()]),
    );
    const second = readCurrentBindingSet(tx, projectId).get(OTHER)!;
    assertChange(result, ChangeKind.Created, second.id);
    assert.equal(second.revision, INITIAL_BINDING_VERSION);
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
  f.write(INITIAL_BINDING_VERSION, submission([MAIN, repository()]));
  const bindingId = f.current().get(MAIN)!.id;
  const check = (
    tx: Transaction,
    list: (cursor: string) => unknown,
    cursors: string[],
  ) => {
    assert.ok(tx.database);
    assert.ok(cursors.length > EMPTY_BINDING_COUNT);
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
