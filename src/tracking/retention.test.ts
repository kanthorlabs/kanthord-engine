import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  type ExecutionTrace,
  type ServerTrace,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import {
  DAY_MS,
  retentionCutoff,
  sweepExpiredFlow,
  sweepExpiredTraces,
} from "./retention.ts";
import { insertTrace, traceRowOf } from "./trace-store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const NOW = 1751566593132;
const RETENTION_DAYS = 30;
const EXPIRED_AT = NOW - 31 * DAY_MS;
const FRESH_AT = NOW - DAY_MS;
const EXPIRED_TRACES = 45;
const EXPECTED_BATCHES = 3;
const CUTOFF_30_DAYS = NOW - 2592000000;
const NO_ROWS = 0;
const ONE_ROW = 1;
const TWO_ROWS = 2;
const TABLES = [
  "tracking_span",
  "tracking_record",
  "tracking_telemetry_text",
  "tracking_session_entry",
] as const;

function memoryStore(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function traceOf(index: number): ExecutionTrace {
  return {
    trace_id: index.toString(16).padStart(32, "0"),
    root_span_id: index.toString(16).padStart(16, "0"),
    execution_id: `execution_${index.toString().padStart(26, "0")}`,
    project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
    node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
    attempt: 1,
  };
}

function serverTraceOf(index: number, createdAt: number): ServerTrace {
  return {
    trace_id: index.toString(16).padStart(32, "0"),
    root_span_id: index.toString(16).padStart(16, "0"),
    project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
    created_at: createdAt,
    node_id: null,
    attempt: null,
  };
}

function insertTraceWithChildren(
  store: Store,
  index: number,
  createdAt: number,
  trace: ExecutionTrace | ServerTrace = traceOf(index),
): void {
  store.transaction((tx) => {
    insertTrace(tx, traceRowOf(trace), createdAt);
    tx.database
      .prepare(
        "INSERT INTO tracking_span VALUES (?, ?, NULL, 'p', 'observed', 'op', NULL, NULL, 'unset', '{}', '[]', '[]', '[]', ?)",
      )
      .run(trace.trace_id, trace.root_span_id, createdAt);
    tx.database
      .prepare("INSERT INTO tracking_record VALUES (?, 'r', 'span', 's', ?)")
      .run(trace.trace_id, createdAt);
    tx.database
      .prepare("INSERT INTO tracking_telemetry_text VALUES (?, 't', 'x', ?)")
      .run(trace.trace_id, createdAt);
    tx.database
      .prepare(
        "INSERT INTO tracking_session_entry VALUES (?, 's', 'e', NULL, 1, 'message', ?, NULL, 0, '{}', ?)",
      )
      .run(trace.trace_id, createdAt, createdAt);
  });
}

function countOf(store: Store, table: string): number {
  const row = store.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return Number(row.count);
}

test("the sweep deletes the expired traces with their children and keeps the newer traces", (t) => {
  const store = memoryStore(t);
  insertTraceWithChildren(store, 1, EXPIRED_AT);
  insertTraceWithChildren(store, 2, FRESH_AT);
  const deleted = sweepExpiredTraces(
    store,
    retentionCutoff(NOW, RETENTION_DAYS),
  );
  assert.equal(deleted, ONE_ROW);
  assert.equal(countOf(store, "tracking_trace"), ONE_ROW);
  for (const table of TABLES) assert.equal(countOf(store, table), ONE_ROW);
  const kept = store.database
    .prepare("SELECT trace_id FROM tracking_trace")
    .get() as { trace_id: string };
  assert.equal(kept.trace_id, traceOf(2).trace_id);
});

test("one sweep deletes 45 expired traces in three batches", (t) => {
  const store = memoryStore(t);
  for (let index = 1; index <= EXPIRED_TRACES; index++)
    insertTraceWithChildren(store, index, EXPIRED_AT);
  const original = store.transaction.bind(store);
  let batches = 0;
  store.transaction = ((work) => {
    batches += 1;
    return original(work);
  }) as Store["transaction"];
  const deleted = sweepExpiredTraces(
    store,
    retentionCutoff(NOW, RETENTION_DAYS),
  );
  assert.equal(deleted, EXPIRED_TRACES);
  assert.equal(batches, EXPECTED_BATCHES);
  assert.equal(countOf(store, "tracking_trace"), NO_ROWS);
  for (const table of TABLES) assert.equal(countOf(store, table), NO_ROWS);
});

const SQL_TEXT = "TEXT";
const SQL_BLOB = "BLOB";
const ROLLUP_TABLES = [
  "tracking_flow_rollup",
  "tracking_flow_histogram",
  "tracking_usage_rollup",
] as const;

function insertRollupRow(store: Store, table: string): void {
  const columns = store.database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => ({
      name: String(column.name),
      type: String(column.type),
    }));
  const values = columns.map(({ type }) =>
    type === SQL_TEXT ? "'x'" : type === SQL_BLOB ? "x'00'" : "1",
  );
  store.database.exec(
    `INSERT INTO ${table} (${columns.map(({ name }) => name).join(", ")}) VALUES (${values.join(", ")})`,
  );
}

test("the sweep of a trace keeps the rollup rows", (t) => {
  const store = memoryStore(t);
  insertTraceWithChildren(store, 1, EXPIRED_AT);
  for (const table of ROLLUP_TABLES) insertRollupRow(store, table);
  const deleted = sweepExpiredTraces(
    store,
    retentionCutoff(NOW, RETENTION_DAYS),
  );
  assert.equal(deleted, ONE_ROW);
  assert.equal(countOf(store, "tracking_trace"), NO_ROWS);
  for (const table of ROLLUP_TABLES)
    assert.equal(countOf(store, table), ONE_ROW);
});

test("the sweep keeps the rollup rows of a deleted trace until their own cutoff", (t) => {
  const store = memoryStore(t);
  insertTraceWithChildren(store, 1, EXPIRED_AT);
  const insertUsage = store.database.prepare(
    "INSERT INTO tracking_usage_rollup VALUES (?, ?, 'p', 'w', 'm', 1, 1, 1, 1, 1, 0)",
  );
  insertUsage.run("day", NOW - 40 * DAY_MS);
  insertUsage.run("hour", NOW - 40 * DAY_MS);
  assert.equal(
    sweepExpiredTraces(store, retentionCutoff(NOW, RETENTION_DAYS)),
    ONE_ROW,
  );
  assert.equal(countOf(store, "tracking_usage_rollup"), TWO_ROWS);
  assert.equal(sweepExpiredFlow(store, NOW), ONE_ROW);
  const kept = store.database
    .prepare("SELECT grain FROM tracking_usage_rollup")
    .all()
    .map((row) => String(row.grain));
  assert.deepEqual(kept, ["day"]);
});

test("the cutoff lies the retention before now", () => {
  assert.equal(retentionCutoff(NOW, RETENTION_DAYS), CUTOFF_30_DAYS);
});

test("the sweep deletes an expired server trace with its children by created_at", (t) => {
  const store = memoryStore(t);
  insertTraceWithChildren(store, 1, EXPIRED_AT, serverTraceOf(1, EXPIRED_AT));
  insertTraceWithChildren(store, 2, FRESH_AT, serverTraceOf(2, FRESH_AT));
  const deleted = sweepExpiredTraces(
    store,
    retentionCutoff(NOW, RETENTION_DAYS),
  );
  assert.equal(deleted, ONE_ROW);
  assert.equal(countOf(store, "tracking_trace"), ONE_ROW);
  for (const table of TABLES) assert.equal(countOf(store, table), ONE_ROW);
  const kept = store.database
    .prepare("SELECT trace_id FROM tracking_trace")
    .get() as { trace_id: string };
  assert.equal(kept.trace_id, serverTraceOf(2, FRESH_AT).trace_id);
});
