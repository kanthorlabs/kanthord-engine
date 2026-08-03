import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { basename, dirname } from "node:path";
import { createTemporaryDatabase } from "./database.ts";

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
});
