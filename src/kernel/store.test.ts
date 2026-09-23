import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { temporary } from "./test-support.ts";
import { Store } from "./store.ts";
const ExitCode = { Success: 0, Failure: 1 } as const;

const WAL_JOURNAL_MODE = "wal";
const FULL_SYNCHRONOUS_MODE = 2;
const PRESERVED_VALUE = "preserved";
const COMMITTED_PREFIX_LENGTH = 1;
const COMPLETE_HISTORY_LENGTH = 2;

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
    assert.throws(() =>
      store.migrate([
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
      ]),
    );
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
