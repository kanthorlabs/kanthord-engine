import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createMockClock } from "../../../test/helpers/clock.ts";
import { createTemporaryDatabase } from "../../../test/helpers/database.ts";
import { StorageError } from "./index.ts";
import type { Migration } from "./migration.ts";
import { SqliteStorage } from "./sqlite.ts";

const alpha: Migration = {
  version: 1,
  name: "0001-alpha",
  statements: ["CREATE TABLE alpha (id TEXT PRIMARY KEY) STRICT"],
};

const beta: Migration = {
  version: 2,
  name: "0002-beta",
  statements: [
    "CREATE TABLE beta (id TEXT PRIMARY KEY) STRICT",
    "INSERT INTO beta (id) VALUES ('b1')",
  ],
};

const broken: Migration = {
  version: 3,
  name: "0003-broken",
  statements: [
    "CREATE TABLE gamma (id TEXT PRIMARY KEY) STRICT",
    "INSERT INTO gamma (id) VALUES",
  ],
};

describe("src/services/storage/sqlite.test", () => {
  it("status on a fresh file reports every migration pending", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha, beta],
    });
    after(() => storage.close());

    assert.deepEqual(storage.status(), {
      applied: [],
      pending: [
        { version: 1, name: "0001-alpha" },
        { version: 2, name: "0002-beta" },
      ],
    });
  });

  it("migrate applies every migration in version order and returns the status", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha, beta],
    });
    after(() => storage.close());

    assert.deepEqual(storage.migrate(), {
      applied: [
        { version: 1, name: "0001-alpha", appliedAt: 1700000000000 },
        { version: 2, name: "0002-beta", appliedAt: 1700000001000 },
      ],
      pending: [],
    });
  });

  it("a second migrate over the same path applies nothing and keeps the appliedAt values", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha, beta],
    });
    first.migrate();
    first.close();

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 9000000000000 }),
      migrations: [alpha, beta],
    });
    after(() => second.close());

    assert.deepEqual(second.migrate(), {
      applied: [
        { version: 1, name: "0001-alpha", appliedAt: 1700000000000 },
        { version: 2, name: "0002-beta", appliedAt: 1700000001000 },
      ],
      pending: [],
    });

    const row = second.transact((t) =>
      t.get("SELECT COUNT(*) AS c FROM migration"),
    ) as { c: number };
    assert.equal(row.c, 2);
  });

  it("applies in version order regardless of the array order", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [beta, alpha],
    });
    after(() => storage.close());

    assert.deepEqual(storage.migrate().applied, [
      { version: 1, name: "0001-alpha", appliedAt: 1700000000000 },
      { version: 2, name: "0002-beta", appliedAt: 1700000001000 },
    ]);
  });

  it("a failing migration throws storage-migration-failed with a cause and rolls back", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha, beta, broken],
    });
    after(() => storage.close());

    assert.throws(
      () => storage.migrate(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed" &&
        error.message.startsWith("migration 3 0003-broken failed:") &&
        error.cause !== undefined,
    );

    assert.deepEqual(
      storage.status().applied.map((m) => m.version),
      [1, 2],
    );

    const gamma = storage.transact((t) =>
      t.get("SELECT name FROM sqlite_master WHERE name = 'gamma'"),
    );
    assert.equal(gamma, undefined);
  });

  it("refuses an applied version this binary does not know", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha, beta],
    });
    first.migrate();
    first.transact((t) => {
      t.run(
        "INSERT INTO migration (version, name, applied_at) VALUES (?, ?, ?)",
        [99, "0099-unknown", 5],
      );
    });
    first.close();

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha, beta],
    });
    after(() => second.close());

    assert.throws(
      () => second.migrate(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed" &&
        error.message ===
          "the database holds migration 99 0099-unknown, which this binary does not know",
    );

    assert.deepEqual(
      second.status().applied.map((m) => m.version),
      [1, 2, 99],
    );
    assert.deepEqual(second.status().pending, []);
  });

  it("refuses a renamed applied migration", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });
    first.migrate();
    first.close();

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [{ ...alpha, name: "0001-renamed" }],
    });
    after(() => second.close());

    assert.throws(
      () => second.migrate(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed" &&
        error.message ===
          "migration 1 is recorded as 0001-alpha and declared as 0001-renamed",
    );
  });

  it("rejects a duplicated version before opening the database", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    assert.throws(
      () =>
        new SqliteStorage({
          path: temporary.path,
          clock: createMockClock({ start: 1700000000000, step: 1000 }),
          migrations: [alpha, { ...beta, version: 1 }],
        }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed" &&
        error.message ===
          "the migration list is invalid: version 1 appears twice",
    );
    assert.equal(fs.existsSync(temporary.path), false);
  });

  it("rejects a non-positive or fractional version and creates no file", () => {
    for (const version of [0, -1, 1.5]) {
      const temporary = createTemporaryDatabase();
      after(() => temporary.dispose());

      assert.throws(
        () =>
          new SqliteStorage({
            path: temporary.path,
            clock: createMockClock({ start: 1700000000000, step: 1000 }),
            migrations: [{ ...alpha, version }],
          }),
        (error: unknown) =>
          error instanceof StorageError &&
          error.code === "storage-migration-failed" &&
          error.message ===
            `the migration list is invalid: version ${version} is not a positive integer`,
      );
      assert.equal(fs.existsSync(temporary.path), false);
    }
  });

  it("transact commits the work and returns its value", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });
    after(() => storage.close());
    storage.migrate();

    const result = storage.transact((t) => {
      t.run("INSERT INTO alpha (id) VALUES (?)", ["x"]);
      return 42;
    });
    assert.equal(result, 42);

    const row = storage.transact((t) =>
      t.get("SELECT COUNT(*) AS c FROM alpha"),
    ) as { c: number };
    assert.equal(row.c, 1);
  });

  it("transact rolls back a throwing work and rethrows its error", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });
    after(() => storage.close());
    storage.migrate();

    assert.throws(
      () =>
        storage.transact((t) => {
          t.run("INSERT INTO alpha (id) VALUES (?)", ["y"]);
          throw new Error("boom");
        }),
      (error: unknown) => error instanceof Error && error.message === "boom",
    );

    const row = storage.transact((t) =>
      t.get("SELECT COUNT(*) AS c FROM alpha"),
    ) as { c: number };
    assert.equal(row.c, 0);
  });

  it("refuses a nested transact, migrate and status while a transaction is open", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });
    after(() => storage.close());
    storage.migrate();

    storage.transact((transaction) => {
      transaction.run("INSERT INTO alpha (id) VALUES (?)", ["outer"]);
      for (const attempt of ["transact", "migrate", "status"] as const) {
        assert.throws(
          () => {
            if (attempt === "transact") storage.transact(() => 0);
            else if (attempt === "migrate") storage.migrate();
            else storage.status();
          },
          (error: unknown) =>
            error instanceof StorageError &&
            error.code === "storage-transaction-failed" &&
            error.message === "a transaction is already open",
        );
      }
      return 1;
    });

    const row = storage.transact((t) =>
      t.get("SELECT COUNT(*) AS c FROM alpha"),
    ) as { c: number };
    assert.equal(row.c, 1);
  });

  it("refuses transact, migrate and status after close", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });
    storage.close();

    for (const attempt of ["transact", "migrate", "status"] as const) {
      assert.throws(
        () => {
          if (attempt === "transact") storage.transact(() => 0);
          else if (attempt === "migrate") storage.migrate();
          else storage.status();
        },
        (error: unknown) =>
          error instanceof StorageError &&
          error.code === "storage-transaction-failed" &&
          error.message === "the storage is closed",
      );
    }
  });

  it("close is a no-op when already closed", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });
    storage.close();
    storage.close();
  });

  it("ping returns undefined on a fresh database and throws after close", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      migrations: [alpha],
    });

    assert.equal(storage.ping(), undefined);
    storage.close();
    assert.throws(() => storage.ping());
  });
});
