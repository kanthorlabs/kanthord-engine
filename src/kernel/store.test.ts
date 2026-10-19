import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  mkdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { temporary } from "./test-support.ts";
import { Diagnostic } from "./errors.ts";
import {
  type PendingMigration,
  STATEMENT_CACHE_LIMIT,
  Store,
} from "./store.ts";
const ExitCode = { Success: 0, Failure: 1 } as const;

const WAL_JOURNAL_MODE = "wal";
const LOCKED_REASON = "cannot initialize database: database is locked";
const FULL_SYNCHRONOUS_MODE = 2;
const PRESERVED_VALUE = "preserved";
const COMMITTED_PREFIX_LENGTH = 1;
const COMPLETE_HISTORY_LENGTH = 2;
const PRIVATE_FILE_MODE = 0o600;
const SELECT_ALL_SQL = "SELECT * FROM t";
const TRANSACTION_COUNT = 1000;
const DISTINCT_SQL_COUNT = 3;
const ROLLBACK_MESSAGE = "rolled back";
const ORPHAN_KEY = 99;
const NO_ROWS = 0;
const DEFERRED_FOREIGN_KEY_SQL =
  "CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)";
const FILLER_RESERVED_COUNT = 2;
const B_VALUE = "b";
const X_VALUE = "x";
const Y_VALUE = "y";
const FIRST_KEY = 1;
const SECOND_KEY = 2;
const DUPLICATE_SERVICE_CODE = "system.database.migration.duplicate_service";
const INCOMPATIBLE_HISTORY_CODE =
  "system.database.migration.incompatible_history";
const SCHEMA_MISMATCH_CODE = "system.database.migration.schema_mismatch";
const SCHEMA_MISMATCH_MESSAGE =
  "the schema of this service differs from its migration text; stop the server, delete kanthord.db, tracking.db and their -wal and -shm files in the data directory, and start again";
const DATABASE_NOT_OPEN = {
  code: "ERR_INVALID_STATE",
  message: "database is not open",
};

test("exclusive WAL ownership refuses a second process and releases after close", (t) => {
  const path = join(temporary(t), "kanthord.db");
  const store = new Store(path);
  assert.equal(
    store.database.prepare("PRAGMA journal_mode").get()?.journal_mode,
    WAL_JOURNAL_MODE,
  );
  assert.equal(
    store.database.prepare("PRAGMA synchronous").get()?.synchronous,
    FULL_SYNCHRONOUS_MODE,
  );
  const attempt = () =>
    spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { Store } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)}; new Store(${JSON.stringify(path)}).close();`,
      ],
      { encoding: "utf8" },
    );
  const blocked = attempt();
  assert.notEqual(blocked.status, ExitCode.Success);
  assert.ok(blocked.stderr.includes(path));
  assert.ok(blocked.stderr.includes(LOCKED_REASON), blocked.stderr);
  store.close();
  assert.equal(attempt().status, ExitCode.Success);
});

test("database and sidecars enforce expected kinds, exact modes and no symlinks", (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.db");
  writeFileSync(path, "", { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.throws(() => new Store(path), /mode 600/);
  chmodSync(path, 0o600);
  symlinkSync(path, path + "-wal");
  assert.throws(() => new Store(path), /owned file/);
  const other = join(directory, "directory.db");
  mkdirSync(other, { mode: 0o700 });
  assert.throws(() => new Store(other), /owned file/);
});

test("migrations rollback partial schemas, retain committed prefixes, and validate all history before applying", () => {
  const store = new Store(":memory:");
  try {
    const first = (database: Store["database"]) =>
      database.exec(
        "CREATE TABLE first (value TEXT); INSERT INTO first VALUES ('preserved')",
      );
    const migrated: PendingMigration[] = [];
    assert.throws(() =>
      store.migrate(
        [
          { service: "one", migrations: [first] },
          {
            service: "two",
            migrations: [
              (database) => {
                database.exec("CREATE TABLE second(value TEXT)");
                database.exec("INVALID SQL");
              },
            ],
          },
        ],
        (step) => migrated.push(step),
      ),
    );
    assert.deepEqual(migrated, [{ service: "one", from: 0, to: 1 }]);
    assert.equal(
      store.database.prepare("SELECT value FROM first").get()?.value,
      PRESERVED_VALUE,
    );
    assert.equal(
      store.database
        .prepare("SELECT name FROM sqlite_master WHERE name='second'")
        .get(),
      undefined,
    );
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM migration").get()
        ?.count,
      COMMITTED_PREFIX_LENGTH,
    );
    store.migrate([
      { service: "one", migrations: [first] },
      {
        service: "two",
        migrations: [
          (database) => database.exec("CREATE TABLE second(value TEXT)"),
        ],
      },
    ]);
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM migration").get()
        ?.count,
      COMPLETE_HISTORY_LENGTH,
    );
    store.transaction(({ database }) =>
      database
        .prepare("UPDATE migration SET version=3 WHERE service='two'")
        .run(),
    );
    assert.throws(
      () =>
        store.migrate([
          {
            service: "one",
            migrations: [
              first,
              (database) => database.exec("CREATE TABLE must_not_exist(value)"),
            ],
          },
          { service: "two", migrations: [() => {}, () => {}, () => {}] },
        ]),
      /history/,
    );
    assert.equal(
      store.database
        .prepare("SELECT name FROM sqlite_master WHERE name='must_not_exist'")
        .get(),
      undefined,
    );
    assert.throws(
      () => store.migrate([{ service: "one", migrations: [first] }]),
      /history/,
    );
  } finally {
    store.close();
  }
});

test("transactions reject async and nested writes, and roll back the operation", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(
      () => store.transaction(() => Promise.resolve()),
      /synchronous/,
    );
    assert.throws(
      () => store.transaction(() => store.transaction(() => {})),
      /Nested/,
    );
    assert.equal(store.healthcheck(), true);
  } finally {
    store.close();
  }
  assert.equal(store.healthcheck(), false);
});

test("plan reads the history without a write and backup copies a consistent private file", (t) => {
  const directory = temporary(t);
  const path = join(directory, "kanthord.db");
  const backup = join(directory, "kanthord.db.bak");
  const create = (database: Store["database"]) =>
    database.exec(
      "CREATE TABLE first (value TEXT); INSERT INTO first VALUES ('preserved')",
    );
  const extend = (database: Store["database"]) =>
    database.exec("CREATE TABLE second (value TEXT)");
  const store = new Store(path);
  try {
    assert.deepEqual(store.plan([{ service: "one", migrations: [create] }]), {
      fresh: true,
      pending: [{ service: "one", from: 0, to: 1 }],
    });
    assert.equal(
      store.database
        .prepare("SELECT name FROM sqlite_master WHERE name='migration'")
        .get(),
      undefined,
    );
    store.migrate([{ service: "one", migrations: [create] }]);
    const services = [{ service: "one", migrations: [create, extend] }];
    assert.deepEqual(store.plan(services), {
      fresh: false,
      pending: [{ service: "one", from: 1, to: 2 }],
    });
    store.backup(backup);
    assert.throws(() => store.backup(backup), /the file exists/);
    store.migrate(services);
    assert.deepEqual(store.plan(services), { fresh: false, pending: [] });
  } finally {
    store.close();
  }
  assert.equal(statSync(backup).mode & 0o7777, PRIVATE_FILE_MODE);
  const copy = new Store(backup);
  try {
    assert.equal(
      copy.database.prepare("SELECT value FROM first").get()?.value,
      PRESERVED_VALUE,
    );
    assert.deepEqual(
      copy.plan([{ service: "one", migrations: [create, extend] }]).pending,
      [{ service: "one", from: 1, to: 2 }],
    );
  } finally {
    copy.close();
  }
});

test("prepare answers one statement for one SQL text across transactions", () => {
  const store = new Store(":memory:");
  try {
    const sql = "SELECT 1 AS value";
    const first = store.transaction(({ database }) => {
      const statement = database.prepare(sql);
      assert.equal(database.prepare(sql), statement);
      return statement;
    });
    store.transaction(({ database }) => {
      assert.equal(database.prepare(sql), first);
    });
  } finally {
    store.close();
  }
});

test("the connection prepares one statement for each SQL text over many transactions", () => {
  const store = new Store(":memory:");
  try {
    const statements = new Set<unknown>();
    for (let index = 0; index < TRANSACTION_COUNT; index++)
      store.transaction(({ database }) => {
        for (let value = 1; value <= DISTINCT_SQL_COUNT; value++)
          statements.add(database.prepare(`SELECT ${value} AS value`));
      });
    assert.equal(statements.size, DISTINCT_SQL_COUNT);
  } finally {
    store.close();
  }
});

test("a rollback clears the statement cache", () => {
  const store = new Store(":memory:");
  try {
    const sql = "SELECT 1 AS value";
    let rolledBack: unknown;
    assert.throws(
      () =>
        store.transaction(({ database }) => {
          rolledBack = database.prepare(sql);
          throw new Error(ROLLBACK_MESSAGE);
        }),
      { message: ROLLBACK_MESSAGE },
    );
    store.transaction(({ database }) => {
      assert.notEqual(database.prepare(sql), rolledBack);
    });
  } finally {
    store.close();
  }
});

test("a rollback after a schema change answers the old columns", () => {
  const store = new Store(":memory:");
  try {
    store.database.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    assert.throws(
      () =>
        store.transaction(({ database }) => {
          database.exec("ALTER TABLE t ADD COLUMN w TEXT");
          const inside = database.prepare(SELECT_ALL_SQL).all();
          assert.deepEqual(Object.keys(inside[0]!), ["a", "w"]);
          throw new Error(ROLLBACK_MESSAGE);
        }),
      { message: ROLLBACK_MESSAGE },
    );
    const after = store.database.prepare(SELECT_ALL_SQL).all();
    assert.deepEqual(Object.keys(after[0]!), ["a"]);
  } finally {
    store.close();
  }
});

test("a failed commit clears the statement cache and leaves the store usable", () => {
  const store = new Store(":memory:");
  try {
    store.database.exec(DEFERRED_FOREIGN_KEY_SQL);
    const sql = "SELECT 1 AS value";
    let failed: unknown;
    assert.throws(
      () =>
        store.transaction(({ database }) => {
          failed = database.prepare(sql);
          database.prepare("INSERT INTO child VALUES (?)").run(ORPHAN_KEY);
        }),
      /FOREIGN KEY/,
    );
    store.transaction(({ database }) => {
      assert.notEqual(database.prepare(sql), failed);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM child").get()?.count,
        NO_ROWS,
      );
    });
  } finally {
    store.close();
  }
});

test("a transaction that SQLite ended keeps the error of the work", () => {
  const store = new Store(":memory:");
  try {
    store.database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    const sql = "SELECT 1 AS value";
    let ended: unknown;
    assert.throws(
      () =>
        store.transaction(({ database }) => {
          ended = database.prepare(sql);
          const insert = database.prepare(
            "INSERT OR ROLLBACK INTO t VALUES (?)",
          );
          insert.run(FIRST_KEY);
          insert.run(FIRST_KEY);
        }),
      /UNIQUE|PRIMARY/,
    );
    assert.equal(store.database.isTransaction, false);
    store.transaction(({ database }) => {
      assert.notEqual(database.prepare(sql), ended);
      database.prepare("INSERT INTO t VALUES (?)").run(FIRST_KEY);
    });
    assert.equal(
      store.database.prepare("SELECT COUNT(*) AS count FROM t").get()?.count,
      FIRST_KEY,
    );
  } finally {
    store.close();
  }
});

test("prepare with options answers a new statement", () => {
  const store = new Store(":memory:");
  try {
    const sql = "SELECT 1 AS value";
    store.transaction(({ database }) => {
      assert.notEqual(
        database.prepare(sql, { readBigInts: false }),
        database.prepare(sql, { readBigInts: false }),
      );
    });
  } finally {
    store.close();
  }
});

test("the statement cache drops the least recently used statement above the limit", () => {
  const store = new Store(":memory:");
  try {
    const sqlA = "SELECT 'a' AS value";
    const sqlB = `SELECT '${B_VALUE}' AS value`;
    const filler = (index: number) => `SELECT ${index} AS value`;
    store.transaction(({ database }) => {
      const statementA = database.prepare(sqlA);
      database.prepare(sqlB);
      for (
        let index = 0;
        index < STATEMENT_CACHE_LIMIT - FILLER_RESERVED_COUNT;
        index++
      )
        database.prepare(filler(index));
      assert.equal(database.prepare(sqlA), statementA);
      database.prepare(filler(STATEMENT_CACHE_LIMIT));
      const statementB = database.prepare(sqlB);
      assert.equal(statementB.get()?.value, B_VALUE);
      assert.equal(database.prepare(sqlA), statementA);
    });
  } finally {
    store.close();
  }
});

test("a cached statement runs again after a constraint failure", () => {
  const store = new Store(":memory:");
  try {
    store.database.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    store.transaction(({ database }) => {
      const insert = () => database.prepare("INSERT INTO t VALUES (?)");
      insert().run(FIRST_KEY);
      assert.throws(() => insert().run(FIRST_KEY), /UNIQUE|PRIMARY/);
      insert().run(SECOND_KEY);
      assert.equal(
        database.prepare("SELECT COUNT(*) AS count FROM t").get()?.count,
        SECOND_KEY,
      );
    });
  } finally {
    store.close();
  }
});

test("a cached statement binds no value of an earlier call", () => {
  const store = new Store(":memory:");
  try {
    store.transaction(({ database }) => {
      const sql = "SELECT ? AS a, ? AS b";
      assert.equal(database.prepare(sql).get(X_VALUE, Y_VALUE)?.b, Y_VALUE);
      const second = database.prepare(sql).get(X_VALUE);
      assert.equal(second?.a, X_VALUE);
      assert.equal(second?.b, null);
    });
  } finally {
    store.close();
  }
});

test("a prepare after a schema change answers the new columns", () => {
  const store = new Store(":memory:");
  try {
    store.database.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    const before = store.database.prepare(SELECT_ALL_SQL).all();
    assert.deepEqual(Object.keys(before[0]!), ["a"]);
    store.database.exec("ALTER TABLE t ADD COLUMN w TEXT");
    const after = store.database.prepare(SELECT_ALL_SQL).all();
    assert.deepEqual(Object.keys(after[0]!), ["a", "w"]);
  } finally {
    store.close();
  }
});

test("a prepare after close throws database is not open", () => {
  const store = new Store(":memory:");
  const sql = "SELECT 1 AS value";
  store.database.prepare(sql);
  store.close();
  assert.throws(() => store.database.prepare(sql), DATABASE_NOT_OPEN);
});

test("a failed exec clears the statement cache", () => {
  const store = new Store(":memory:");
  try {
    store.database.exec("CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('x')");
    store.database.prepare(SELECT_ALL_SQL).all();
    assert.throws(() =>
      store.database.exec("ALTER TABLE t ADD COLUMN w TEXT; SELEC 1"),
    );
    const rows = store.database.prepare(SELECT_ALL_SQL).all();
    assert.deepEqual(Object.keys(rows[0]!), ["a", "w"]);
  } finally {
    store.close();
  }
});

type Database = Store["database"];

const createOne = (database: Database) =>
  database.exec(
    "CREATE TABLE one_first (value TEXT, other TEXT, key TEXT UNIQUE); CREATE UNIQUE INDEX one_first_value ON one_first (value)",
  );
const createOneChanged = (database: Database) =>
  database.exec(
    "CREATE TABLE one_first (value TEXT, other TEXT, key TEXT UNIQUE); CREATE UNIQUE INDEX one_first_value ON one_first (value, other)",
  );
const extendOne = (database: Database) =>
  database.exec("CREATE TABLE one_second (value TEXT)");
const createTwo = (database: Database) =>
  database.exec("CREATE TABLE two_first (value TEXT)");
const ONE_SERVICES = [{ service: "one", migrations: [createOne] }];

function migratedStore(path = ":memory:"): Store {
  const store = new Store(path);
  store.migrate(ONE_SERVICES);
  return store;
}

function refusal(work: () => unknown): Diagnostic {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof Diagnostic, String(error));
    return error;
  }
  return assert.fail("expected a refusal");
}

function snapshot(store: Store) {
  return {
    schema: store.database
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY name")
      .all(),
    history: store.database.prepare("SELECT * FROM migration").all(),
  };
}

test("plan refuses a recorded service whose migration text changed and writes nothing", (t) => {
  const path = join(temporary(t), "kanthord.db");
  const store = migratedStore(path);
  try {
    const before = snapshot(store);
    const changed = [{ service: "one", migrations: [createOneChanged] }];
    const refused = refusal(() => store.plan(changed));
    assert.equal(refused.code, SCHEMA_MISMATCH_CODE);
    assert.equal(refused.message, SCHEMA_MISMATCH_MESSAGE);
    assert.deepEqual(refused.fields, [
      ["path", path],
      ["service", "one"],
      ["object", "one_first_value"],
    ]);
    assert.equal(
      refusal(() => store.migrate(changed)).code,
      SCHEMA_MISMATCH_CODE,
    );
    assert.deepEqual(snapshot(store), before);
  } finally {
    store.close();
  }
});

test("plan refuses a hand edit of the schema of a service", () => {
  const edits: ReadonlyArray<readonly [string, string]> = [
    ["ALTER TABLE one_first ADD COLUMN extra TEXT", "one_first"],
    ["DROP INDEX one_first_value", "one_first_value"],
    [
      "CREATE UNIQUE INDEX hand_index ON one_first (value, other)",
      "hand_index",
    ],
    [
      "CREATE TRIGGER hand_trigger BEFORE INSERT ON one_first BEGIN SELECT RAISE(ABORT, 'x'); END",
      "hand_trigger",
    ],
  ];
  for (const [sql, object] of edits) {
    const store = migratedStore();
    try {
      store.database.exec(sql);
      const refused = refusal(() => store.plan(ONE_SERVICES));
      assert.equal(refused.code, SCHEMA_MISMATCH_CODE, sql);
      assert.deepEqual(refused.fields.slice(1), [
        ["service", "one"],
        ["object", object],
      ]);
    } finally {
      store.close();
    }
  }
});

test("plan ignores a table of no service and every sqlite_ object", () => {
  const store = new Store(":memory:");
  try {
    const services = [
      {
        service: "one",
        migrations: [
          (database: Database) =>
            database.exec(
              "CREATE TABLE one_keyed (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE)",
            ),
        ],
      },
    ];
    store.migrate(services);
    store.database.exec(
      "CREATE TABLE unowned_extra (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE)",
    );
    assert.deepEqual(store.plan(services), { fresh: false, pending: [] });
  } finally {
    store.close();
  }
});

test("plan runs the duplicate check, then the history check, then the compare", () => {
  const store = new Store(":memory:");
  try {
    store.migrate([{ service: "one", migrations: [createOne, extendOne] }]);
    const changedShort = [{ service: "one", migrations: [createOneChanged] }];
    assert.equal(
      refusal(() => store.plan([...changedShort, ...changedShort])).code,
      DUPLICATE_SERVICE_CODE,
    );
    assert.equal(
      refusal(() => store.plan(changedShort)).code,
      INCOMPATIBLE_HISTORY_CODE,
    );
    assert.equal(
      refusal(() => store.plan([{ service: "one", migrations: [createOne] }]))
        .code,
      INCOMPATIBLE_HISTORY_CODE,
    );
    assert.equal(
      refusal(() =>
        store.plan([
          { service: "one", migrations: [createOneChanged, extendOne] },
        ]),
      ).code,
      SCHEMA_MISMATCH_CODE,
    );
    assert.equal(
      refusal(() => store.plan([{ service: "two", migrations: [createTwo] }]))
        .code,
      INCOMPATIBLE_HISTORY_CODE,
    );
  } finally {
    store.close();
  }
  const forged = migratedStore();
  try {
    forged.database.exec("INSERT INTO migration VALUES ('one', 2, 0)");
    assert.equal(
      refusal(() => forged.plan(ONE_SERVICES)).code,
      INCOMPATIBLE_HISTORY_CODE,
    );
  } finally {
    forged.close();
  }
});

test("plan refuses a recorded version above the list length with incompatible_history and writes nothing", (t) => {
  const path = join(temporary(t), "kanthord.db");
  const store = new Store(path);
  try {
    store.migrate([{ service: "one", migrations: [createOne, extendOne] }]);
    const before = snapshot(store);
    const refused = refusal(() => store.plan(ONE_SERVICES));
    assert.equal(refused.code, INCOMPATIBLE_HISTORY_CODE);
    assert.deepEqual(refused.fields, [["path", path]]);
    assert.deepEqual(snapshot(store), before);
  } finally {
    store.close();
  }
});

test("plan answers a service with no recorded row as pending with no compare", () => {
  const store = migratedStore();
  try {
    store.database.exec("CREATE TABLE two_first (value INTEGER)");
    assert.deepEqual(
      store.plan([
        ...ONE_SERVICES,
        { service: "two", migrations: [createTwo] },
      ]),
      { fresh: false, pending: [{ service: "two", from: 0, to: 1 }] },
    );
  } finally {
    store.close();
  }
});

test("plan answers a recorded prefix with a pending version as pending", () => {
  const store = migratedStore();
  try {
    assert.deepEqual(
      store.plan([{ service: "one", migrations: [createOne, extendOne] }]),
      { fresh: false, pending: [{ service: "one", from: 1, to: 2 }] },
    );
    assert.equal(
      refusal(() =>
        store.plan([
          { service: "one", migrations: [createOneChanged, extendOne] },
        ]),
      ).code,
      SCHEMA_MISMATCH_CODE,
    );
  } finally {
    store.close();
  }
});
