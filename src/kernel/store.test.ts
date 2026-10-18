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
const FILLER_RESERVED_COUNT = 2;
const B_VALUE = "b";
const X_VALUE = "x";
const Y_VALUE = "y";
const FIRST_KEY = 1;
const SECOND_KEY = 2;
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

test("prepare answers one statement for one SQL text in one transaction", () => {
  const store = new Store(":memory:");
  try {
    const sql = "SELECT 1 AS value";
    const first = store.transaction(({ database }) => {
      const statement = database.prepare(sql);
      assert.equal(database.prepare(sql), statement);
      return statement;
    });
    store.transaction(({ database }) => {
      assert.notEqual(database.prepare(sql), first);
    });
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
