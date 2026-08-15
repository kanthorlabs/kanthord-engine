import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, dirname } from "node:path";
import {
  createTemporaryDatabase,
  createMigratedStorage,
  tableBytes,
  tableCounts,
} from "./database.ts";
import { rows } from "../../src/domain/rows.ts";
import { migrations } from "../../src/services/storage/migrations.ts";
import { bootstrapActorId } from "../../src/domain/actor.ts";

describe("test/helpers/database.test", () => {
  it("path ends with kanthord.db, parent exists, file does not", () => {
    const db = createTemporaryDatabase();
    after(() => db.dispose());

    assert.equal(basename(db.path), "kanthord.db");
    assert.ok(fs.statSync(dirname(db.path)).isDirectory());
    assert.equal(fs.existsSync(db.path), false);
  });

  it("opening with node:sqlite, creating table, inserting row works", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = createTemporaryDatabase();
    after(() => db.dispose());

    const conn = new DatabaseSync(db.path);
    conn.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    conn.prepare("INSERT INTO t (id, val) VALUES (?, ?)").run(1, "hello");
    const row = conn.prepare("SELECT id, val FROM t WHERE id = 1").get() as {
      id: number;
      val: string;
    };
    conn.close();

    assert.equal(row.id, 1);
    assert.equal(row.val, "hello");
  });

  it("dispose removes parent, second dispose does not throw", () => {
    const db = createTemporaryDatabase();
    const parent = dirname(db.path);

    db.dispose();
    assert.equal(fs.existsSync(parent), false);

    assert.doesNotThrow(() => db.dispose());
  });

  it("reports every table name in bytewise order", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const expected = (Object.keys(rows) as readonly string[])
      .slice()
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    assert.deepEqual(Object.keys(tableCounts(temporary.storage)), expected);
  });

  it("reports 0 for every table except migration and the bootstrap actor row on a fresh database", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const counts = tableCounts(temporary.storage);
    for (const [table, count] of Object.entries(counts)) {
      if (table === "migration") {
        assert.equal(count, migrations.length, table);
      } else if (table === "actor") {
        assert.equal(count, 1, table);
      } else {
        assert.equal(count, 0, table);
      }
    }
  });

  it("one inserted event row moves event from 0 to 1 and no other entry", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());

    const before = tableCounts(temporary.storage);
    temporary.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO event (id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          "event_01HZY8QF3M4N5P6R7S8T9V0W1B",
          "node",
          "node_01HZY8QF3M4N5P6R7S8T9V0W1A",
          "witness",
          "daemon",
          "d1",
          "{}",
        ],
      );
    });
    const after1 = tableCounts(temporary.storage);
    for (const table of Object.keys(before)) {
      const expected =
        table === "event"
          ? (before as Record<string, number>)[table]! + 1
          : (before as Record<string, number>)[table]!;
      assert.equal((after1 as Record<string, number>)[table], expected, table);
    }
  });

  it("tableBytes changes on an insert and on a cell update and stays stable when nothing changes", () => {
    const temporary = createMigratedStorage();
    after(() => temporary.dispose());
    const storage = temporary.storage;

    const empty = tableBytes(storage, "actor");
    storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          "actor_01HZY8QF3M4N5P6R7S8T9V0W1X",
          "harness",
          "worker-a",
          new Uint8Array(32),
          bootstrapActorId,
          1000,
        ],
      );
    });
    const withRow = tableBytes(storage, "actor");
    assert.equal(empty.equals(withRow), false);

    storage.transact((transaction) => {
      transaction.run("UPDATE actor SET name = ? WHERE id = ?", [
        "worker-b",
        "actor_01HZY8QF3M4N5P6R7S8T9V0W1X",
      ]);
    });
    const renamed = tableBytes(storage, "actor");
    assert.equal(withRow.equals(renamed), false);

    assert.equal(tableBytes(storage, "actor").equals(renamed), true);
  });
});
