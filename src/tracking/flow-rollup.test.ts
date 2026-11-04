import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";
import { FlowGrain, FlowMeasure, TRACKING_SERVICE_NAME } from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import {
  addHistogramValue,
  addUsage,
  type FlowUsageSum,
  type RollupPlace,
} from "./flow-rollup.ts";
import { DAY_MS } from "./writable-period.ts";

const NOW = Date.UTC(2026, 9, 31, 10, 30);
const HOUR_MS = 3600000;
const PROJECT_ID = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const WORKER_NAME = "worker";
const MODEL = "model";
const ONE_TURN: FlowUsageSum = {
  turn_count: 1,
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 0,
  cost_usd: 0.5,
  unpriced_tokens: 0,
};
const ONE_TURN_COUNT = 1;
const TWO_TURNS = 2;

function memoryStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function placeOf(grain: FlowGrain, ageDays: number): RollupPlace {
  const time = NOW - ageDays * DAY_MS;
  const bucket = grain === FlowGrain.Hour ? HOUR_MS : DAY_MS;
  return { grain, bucket_start: time - (time % bucket), now: NOW };
}

function turnCountOf(store: Store, place: RollupPlace): number | undefined {
  const row = store.database
    .prepare(
      "SELECT turn_count FROM tracking_usage_rollup WHERE grain = ? AND bucket_start = ?",
    )
    .get(place.grain, place.bucket_start);
  return row === undefined ? undefined : Number(row.turn_count);
}

test("a record of a 20-day-old execution updates its hour bucket", (t) => {
  const store = memoryStore(t);
  const place = placeOf(FlowGrain.Hour, 20);
  store.transaction((tx) => {
    addUsage(tx, place, PROJECT_ID, WORKER_NAME, MODEL, ONE_TURN);
    addHistogramValue(
      tx,
      place,
      PROJECT_ID,
      WORKER_NAME,
      FlowMeasure.GateRunTime,
      1000,
    );
  });
  assert.equal(turnCountOf(store, place), ONE_TURN_COUNT);
  const histogram = store.database
    .prepare(
      "SELECT COUNT(*) AS count FROM tracking_flow_histogram WHERE grain = ? AND bucket_start = ?",
    )
    .get(place.grain, place.bucket_start);
  assert.equal(Number(histogram?.count), ONE_TURN_COUNT);
});

test("an old bucket of each grain stays and adds a later record", (t) => {
  const store = memoryStore(t);
  const places = [placeOf(FlowGrain.Hour, 90), placeOf(FlowGrain.Day, 90)];
  for (const place of places)
    for (let turn = 0; turn < TWO_TURNS; turn++)
      store.transaction((tx) =>
        addUsage(tx, place, PROJECT_ID, WORKER_NAME, MODEL, ONE_TURN),
      );
  for (const place of places)
    assert.equal(turnCountOf(store, place), TWO_TURNS);
});
