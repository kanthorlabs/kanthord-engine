import assert from "node:assert/strict";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "../kernel/store.ts";
import { stopAfter, temporary } from "../kernel/test-support.ts";
import {
  FOOTPRINT_SCAN_BUDGET_MS,
  FootprintKind,
} from "../footprint/contract.ts";
import { TrackingFootprint } from "./footprint.ts";
import { trackingMigrations } from "./migrations.ts";
import { TRACKING_SERVICE_NAME, trackingOperations } from "./contract.ts";

const NOW = Date.UTC(2026, 10, 3);
const OLDEST_BUCKET = 1000;
const NO_TRACES = 0;
const ROLLUP_ROW = "rollup";
const ROLLUP_TABLE = "tracking_usage_rollup";
const TRACE_TABLE = "tracking_trace";
const MEASURED_TABLE_BYTES = 1;
const MEASURED_TABLES = 1;

function owner(t: TestContext) {
  const path = join(temporary(t), "tracking.db");
  const store = new Store(path);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return {
    store,
    footprint: new TrackingFootprint({ store, path, now: () => NOW }),
  };
}

test("trace.bytes is the used bytes of tracking.db with no subtraction and the periodic measure runs no dbstat", async (t) => {
  const { store, footprint } = owner(t);
  t.mock.method(store, "treeBytes", () => {
    throw new Error("dbstat must not run");
  });
  const [trace] = await footprint.measure();
  const pages = store.pages();
  assert.equal(trace?.kind, FootprintKind.Trace);
  assert.equal(
    trace?.bytes,
    (pages.page_count - pages.freelist_count) * pages.page_size,
  );
  assert.equal(trace?.count, NO_TRACES);
  assert.equal(trace?.measure_error, null);
});

test("the rollup row sums the three tables and holds the oldest bucket", async (t) => {
  const { store, footprint } = owner(t);
  store.transaction((tx) =>
    tx.database
      .prepare(
        "INSERT INTO tracking_usage_rollup (grain, bucket_start, project_id, worker_name, model, turn_count, input_tokens, output_tokens, cache_read_tokens, cost_usd, unpriced_tokens) VALUES ('hour', ?, 'p', 'w', 'm', 1, 1, 1, 1, 0, 0)",
      )
      .run(OLDEST_BUCKET),
  );
  const tables =
    (await footprint.tables(FootprintKind.Trace, AbortSignal.timeout(5000))) ??
    [];
  const rollup = tables.find((table) => table.name === ROLLUP_ROW);
  const expected = [
    "tracking_flow_rollup",
    "tracking_flow_histogram",
    "tracking_usage_rollup",
  ]
    .map((name) => store.treeBytes(name) ?? 0)
    .reduce((sum, bytes) => sum + bytes, 0);
  assert.equal(rollup?.bytes, expected);
  assert.equal(rollup?.oldest_at, OLDEST_BUCKET);
  assert.ok(!tables.some((table) => table.name === ROLLUP_TABLE));
  assert.equal(
    tables.find((table) => table.name === TRACE_TABLE)?.delete_operation,
    trackingOperations.traceDelete.id,
  );
});

test("the breakdown stops at the budget", async (t) => {
  const { store, footprint } = owner(t);
  t.mock.method(store, "treeBytes", () => {
    const until = performance.now() + FOOTPRINT_SCAN_BUDGET_MS + 1;
    while (performance.now() < until);
    return MEASURED_TABLE_BYTES;
  });
  const tables =
    (await footprint.tables(FootprintKind.Trace, AbortSignal.timeout(10000))) ??
    [];
  assert.equal(
    tables.filter((table) => table.bytes === MEASURED_TABLE_BYTES).length,
    MEASURED_TABLES,
  );
  assert.ok(tables.some((table) => table.bytes === null));
});
