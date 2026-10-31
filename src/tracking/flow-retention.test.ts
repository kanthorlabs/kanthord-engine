import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { FlowGrain, TRACKING_SERVICE_NAME } from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import {
  DAY_MS,
  FLOW_SWEEP_BATCH_ROWS,
  sweepExpiredFlow,
} from "./retention.ts";

const NOW = Date.UTC(2026, 9, 31, 10, 30);
const NO_ROWS = 0;
const ONE_ROW = 1;
const TWO_ROWS = 2;
const BATCHES_EXPECTED = 3;
const ROLLUP_TABLES = [
  "tracking_flow_rollup",
  "tracking_flow_histogram",
  "tracking_usage_rollup",
] as const;
const SQL_TEXT = "TEXT";
const SQL_BLOB = "BLOB";

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function insertRow(
  store: Store,
  table: string,
  grain: FlowGrain,
  bucketStart: number,
  worker: string,
): void {
  const columns = store.database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => ({
      name: String(column.name),
      type: String(column.type),
    }));
  const fixed: Record<string, string> = {
    grain: `'${grain}'`,
    bucket_start: String(bucketStart),
    worker_name: `'${worker}'`,
  };
  const values = columns.map(
    ({ name, type }) =>
      fixed[name] ??
      (type === SQL_TEXT ? "'x'" : type === SQL_BLOB ? "x'00'" : "1"),
  );
  store.database.exec(
    `INSERT INTO ${table} (${columns.map(({ name }) => name).join(", ")}) VALUES (${values.join(", ")})`,
  );
}

function countOf(store: Store, table: string, grain?: FlowGrain): number {
  const row =
    grain === undefined
      ? store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()
      : store.database
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE grain = ?`)
          .get(grain);
  return Number(row?.count);
}

test("the sweep deletes the hour rows older than 8 days and the day rows older than 64 days", (t) => {
  const store = memoryStore(t);
  for (const table of ROLLUP_TABLES) {
    insertRow(store, table, FlowGrain.Hour, NOW - 9 * DAY_MS, "old_hour");
    insertRow(store, table, FlowGrain.Hour, NOW - 7 * DAY_MS, "new_hour");
    insertRow(store, table, FlowGrain.Day, NOW - 65 * DAY_MS, "old_day");
    insertRow(store, table, FlowGrain.Day, NOW - 63 * DAY_MS, "new_day");
    insertRow(store, table, FlowGrain.Day, NOW - 20 * DAY_MS, "newer_day");
  }
  assert.equal(sweepExpiredFlow(store, NOW), 2 * ROLLUP_TABLES.length);
  for (const table of ROLLUP_TABLES) {
    assert.equal(countOf(store, table, FlowGrain.Hour), ONE_ROW);
    assert.equal(countOf(store, table, FlowGrain.Day), TWO_ROWS);
    const kept = store.database
      .prepare(`SELECT worker_name FROM ${table} ORDER BY worker_name`)
      .all()
      .map((row) => String(row.worker_name));
    assert.deepEqual(kept, ["new_day", "new_hour", "newer_day"]);
  }
});

test("a table with more rows than one batch empties over several transactions", (t) => {
  const store = memoryStore(t);
  const rows = 2 * FLOW_SWEEP_BATCH_ROWS + 1;
  for (let index = 0; index < rows; index++)
    insertRow(
      store,
      "tracking_usage_rollup",
      FlowGrain.Hour,
      NOW - 9 * DAY_MS,
      `worker_${index.toString().padStart(4, "0")}`,
    );
  insertRow(store, "tracking_usage_rollup", FlowGrain.Hour, NOW, "fresh");
  const original = store.transaction.bind(store);
  let transactions = 0;
  store.transaction = ((work) => {
    transactions += 1;
    return original(work);
  }) as Store["transaction"];
  assert.equal(sweepExpiredFlow(store, NOW), rows);
  assert.equal(countOf(store, "tracking_usage_rollup"), ONE_ROW);
  assert.equal(
    transactions,
    BATCHES_EXPECTED +
      (ROLLUP_TABLES.length * Object.values(FlowGrain).length - 1),
  );
});

test("a sweep of empty tables deletes nothing", (t) => {
  const store = memoryStore(t);
  assert.equal(sweepExpiredFlow(store, NOW), NO_ROWS);
});
