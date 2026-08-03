import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { dirname, join } from "node:path";

import { createTemporaryDatabase } from "../../../test/helpers/database.ts";
import { openDatabase, pragmas, runInTransaction } from "./connection.ts";
import { StorageError, type Transaction } from "./index.ts";

type SqliteFailure = { errcode: number; message: string };

describe("src/services/storage/connection.test", () => {
  it("pragmas list WAL, foreign keys, full synchronous and a 5s busy timeout, in that order", () => {
    assert.deepEqual(pragmas, [
      "PRAGMA journal_mode = WAL",
      "PRAGMA foreign_keys = ON",
      "PRAGMA synchronous = FULL",
      "PRAGMA busy_timeout = 5000",
    ]);
  });

  it("openDatabase applies each pragma and a committed write switches the file to WAL", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    const readPragma = (sql: string): unknown => {
      const row = database.prepare(sql).get() as Record<string, unknown>;
      return Object.values({ ...row })[0];
    };

    assert.equal(readPragma("PRAGMA journal_mode"), "wal");
    assert.equal(readPragma("PRAGMA foreign_keys"), 1);
    assert.equal(readPragma("PRAGMA synchronous"), 2);
    assert.equal(readPragma("PRAGMA busy_timeout"), 5000);

    database.exec("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
    assert.ok(fs.existsSync(`${temporary.path}-wal`));
  });

  it("runInTransaction commits the work and returns its result", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    const result = runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
      t.run("INSERT INTO a (id) VALUES (?)", ["x"]);
      return 42;
    });

    assert.equal(result, 42);
    const row = database.prepare("SELECT COUNT(*) AS c FROM a").get() as {
      c: number;
    };
    assert.equal(row.c, 1);
  });

  it("runInTransaction rolls back a throwing work and rethrows the original error", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
      t.run("INSERT INTO a (id) VALUES (?)", ["x"]);
    });

    let thrown: unknown;
    try {
      runInTransaction(database, (t) => {
        t.run("INSERT INTO a (id) VALUES (?)", ["y"]);
        throw new Error("boom");
      });
      assert.fail("expected a throw");
    } catch (error) {
      thrown = error;
    }

    assert.equal((thrown as Error).message, "boom");
    assert.ok(!(thrown instanceof StorageError));
    assert.equal((thrown as Error).cause, undefined);
    const row = database.prepare("SELECT COUNT(*) AS c FROM a").get() as {
      c: number;
    };
    assert.equal(row.c, 1);
  });

  it("a constraint failure inside the work reaches the caller unwrapped", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
    });

    let thrown: unknown;
    try {
      runInTransaction(database, (t) => {
        t.run("INSERT INTO a (id) VALUES (?)", ["x"]);
        t.run("INSERT INTO a (id) VALUES (?)", ["x"]);
      });
      assert.fail("expected a throw");
    } catch (error) {
      thrown = error;
    }

    assert.ok(!(thrown instanceof StorageError));
    assert.equal((thrown as SqliteFailure).errcode & 0xff, 19);
  });

  it("a committed context refuses run, get and all with the same StorageError", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    let captured: Transaction | undefined;
    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
      captured = t;
      return 1;
    });
    assert.ok(captured);
    const closed = captured;

    for (const method of ["run", "get", "all"] as const) {
      assert.throws(
        () => closed[method]("SELECT 1"),
        (error: unknown) =>
          error instanceof StorageError &&
          error.code === "storage-transaction-failed" &&
          error.message === "the transaction is closed",
      );
    }
  });

  it("a rolled-back context refuses run, get and all with the same StorageError", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    let captured: Transaction | undefined;
    try {
      runInTransaction(database, (t) => {
        captured = t;
        throw new Error("boom");
      });
    } catch {
      // the rollback is the point; the context must come out dead
    }
    assert.ok(captured);
    const closed = captured;

    for (const method of ["run", "get", "all"] as const) {
      assert.throws(
        () => closed[method]("SELECT 1"),
        (error: unknown) =>
          error instanceof StorageError &&
          error.code === "storage-transaction-failed" &&
          error.message === "the transaction is closed",
      );
    }
  });

  it("a commit-failure rollback closes the context and a later run throws", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE p (id TEXT PRIMARY KEY) STRICT");
      t.run(
        "CREATE TABLE c (id TEXT PRIMARY KEY, p_id TEXT NOT NULL REFERENCES p(id)) STRICT",
      );
    });

    let captured: Transaction | undefined;
    assert.throws(
      () =>
        runInTransaction(database, (t) => {
          t.run("PRAGMA defer_foreign_keys = ON");
          t.run("INSERT INTO c (id, p_id) VALUES (?, ?)", ["c1", "missing"]);
          captured = t;
          return 1;
        }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-transaction-failed" &&
        error.message.startsWith("commit failed:"),
    );
    assert.ok(captured);
    const closed = captured;

    assert.throws(
      () => closed.run("SELECT 1"),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-transaction-failed" &&
        error.message === "the transaction is closed",
    );
  });

  it("a thenable work result rolls back and is refused", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
      t.run("INSERT INTO a (id) VALUES (?)", ["x"]);
    });

    assert.throws(
      () =>
        runInTransaction(database, (t) => {
          t.run("INSERT INTO a (id) VALUES (?)", ["y"]);
          return Promise.resolve(1);
        }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-transaction-failed" &&
        error.message === "transact work must be synchronous",
    );
    const row = database.prepare("SELECT COUNT(*) AS c FROM a").get() as {
      c: number;
    };
    assert.equal(row.c, 1);
  });

  it("a non-callable then property is not a thenable and the work commits", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
      t.run("INSERT INTO a (id) VALUES (?)", ["x"]);
      return { then: 1 };
    });
    const row = database.prepare("SELECT COUNT(*) AS c FROM a").get() as {
      c: number;
    };
    assert.equal(row.c, 1);
  });

  it("a failed BEGIN surfaces as storage-transaction-failed with a cause", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    database.exec("BEGIN IMMEDIATE");
    assert.throws(
      () => runInTransaction(database, () => 1),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-transaction-failed" &&
        error.message.startsWith("begin failed:") &&
        error.cause !== undefined,
    );
    database.exec("ROLLBACK");
  });

  it("get on an empty table returns undefined", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
    });
    const value = runInTransaction(database, (t) => t.get("SELECT id FROM a"));
    assert.equal(value, undefined);
  });

  it("foreign keys are enforced inside the transaction", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id TEXT PRIMARY KEY) STRICT");
      t.run(
        "CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT NOT NULL REFERENCES a(id)) STRICT",
      );
    });

    let thrown: unknown;
    try {
      runInTransaction(database, (t) => {
        t.run("INSERT INTO b (id, a_id) VALUES (?, ?)", ["1", "missing"]);
      });
      assert.fail("expected a throw");
    } catch (error) {
      thrown = error;
    }

    const failure = thrown as SqliteFailure;
    assert.equal(failure.errcode & 0xff, 19);
    assert.ok(failure.message.includes("FOREIGN KEY constraint failed"));
  });

  it("STRICT refuses a TEXT value bound into an INTEGER column", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const database = openDatabase(temporary.path);
    after(() => database.close());

    runInTransaction(database, (t) => {
      t.run("CREATE TABLE a (id INTEGER NOT NULL) STRICT");
    });
    assert.throws(() =>
      runInTransaction(database, (t) => {
        t.run("INSERT INTO a (id) VALUES (?)", ["y"]);
      }),
    );
  });

  it("openDatabase throws on a non-database file and leaks no handle", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    fs.writeFileSync(temporary.path, "not a database");
    assert.throws(() => openDatabase(temporary.path));

    const freshPath = join(dirname(temporary.path), "kanthord-2.db");
    const second = openDatabase(freshPath);
    second.close();
  });
});
