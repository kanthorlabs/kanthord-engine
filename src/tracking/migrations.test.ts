import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { TRACKING_SERVICE_NAME } from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const TEXT_TABLE = "tracking_telemetry_text";
const ENTRY_TABLE = "tracking_session_entry";
const ENTRY_SEQUENCE_INDEX = "tracking_session_entry_sequence";
const TRACE_TABLE = "tracking_trace";
const CASCADE = "CASCADE";
const UNIQUE_INDEX = 1;

function migratedStore(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
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

test("the session entry table holds its identity, its sequence and its content", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA table_info(${ENTRY_TABLE})`)
      .all()
      .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
    [
      { name: "trace_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "session_id", type: "TEXT", notnull: 1, pk: 2 },
      { name: "entry_id", type: "TEXT", notnull: 1, pk: 3 },
      { name: "parent_entry_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "sequence", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "entry_type", type: "TEXT", notnull: 1, pk: 0 },
      { name: "entry_time", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "tool_call_id", type: "TEXT", notnull: 0, pk: 0 },
      { name: "truncated", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "content", type: "TEXT", notnull: 1, pk: 0 },
      { name: "created_at", type: "INTEGER", notnull: 1, pk: 0 },
    ],
  );
});

test("the session entry table cascades from its trace", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA foreign_key_list(${ENTRY_TABLE})`)
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

test("the session entry sequence is a unique index on the trace, the session and the sequence", (t) => {
  const store = migratedStore(t);
  const index = store.database
    .prepare(`PRAGMA index_list(${ENTRY_TABLE})`)
    .all()
    .find((row) => row.name === ENTRY_SEQUENCE_INDEX);
  assert.equal(index?.unique, UNIQUE_INDEX);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA index_info(${ENTRY_SEQUENCE_INDEX})`)
      .all()
      .map((row) => row.name),
    ["trace_id", "session_id", "sequence"],
  );
});

test("the trace table holds the summary columns with their defaults", (t) => {
  const store = migratedStore(t);
  assert.deepEqual(
    store.database
      .prepare(`PRAGMA table_info(${TRACE_TABLE})`)
      .all()
      .slice(5)
      .map(({ name, type, notnull, dflt_value }) => ({
        name,
        type,
        notnull,
        dflt_value,
      })),
    [
      { name: "node_id", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "attempt", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "state", type: "TEXT", notnull: 1, dflt_value: "'open'" },
      { name: "started_at", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "ended_at", type: "INTEGER", notnull: 0, dflt_value: null },
      { name: "stop_reason", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "worker_name", type: "TEXT", notnull: 0, dflt_value: null },
      { name: "agent_names", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "models", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "error_types", type: "TEXT", notnull: 1, dflt_value: "'[]'" },
      { name: "input_tokens", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "output_tokens", type: "INTEGER", notnull: 1, dflt_value: "0" },
      {
        name: "cache_read_tokens",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      },
      {
        name: "cache_creation_tokens",
        type: "INTEGER",
        notnull: 1,
        dflt_value: "0",
      },
      { name: "cost_usd", type: "REAL", notnull: 1, dflt_value: "0" },
      { name: "span_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "turn_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "tool_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      { name: "error_count", type: "INTEGER", notnull: 1, dflt_value: "0" },
      {
        name: "first_error_span_id",
        type: "TEXT",
        notnull: 0,
        dflt_value: null,
      },
    ],
  );
});
