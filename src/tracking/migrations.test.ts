import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { TRACKING_SERVICE_NAME } from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";

const TEXT_TABLE = "tracking_telemetry_text";
const TRACE_TABLE = "tracking_trace";
const CASCADE = "CASCADE";

function migratedStore(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

test("the telemetry text table holds its identity, a required content and its creation time", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA table_info(${TEXT_TABLE})`)
      .all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
    [
      { name: "trace_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "text_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "content", type: "TEXT", notnull: 1, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
    ],
  );
});

test("the telemetry text table cascades from its trace", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA foreign_key_list(${TEXT_TABLE})`)
      .all()
      .map((row) => ({
        table: row.table,
        from: row.from,
        to: row.to,
        on_delete: row.on_delete,
      })),
    [
      {
        table: TRACE_TABLE,
        from: "trace_id",
        to: "trace_id",
        on_delete: CASCADE,
      },
    ],
  );
});

test("the tracking schema holds no CHECK constraint", (t) => {
  const store = migratedStore(t);
  for (const row of store.database
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL")
    .all())
    assert.doesNotMatch(String(row.sql), /\bCHECK\b/i);
});
