import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  AnalyticsBucket,
  CostGroupBy,
  SpanOrigin,
  SpanStatus,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { type CostItem, type CostQuery, readCost } from "./analytics-cost.ts";
import { insertSpan } from "./trace-store.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

interface Turn {
  trace?: number;
  start: number;
  operation?: string;
  attributes?: Record<string, string | number>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONDAY = Date.UTC(2024, 0, 1);
const RANGE_END = MONDAY + 14 * DAY;
const LIMIT = 1000;
const ONE_ITEM = 1;
const TURNS_IN_RANGE = 2;
const COUNTED_TURNS = 2;
const COUNTED_INPUT = 4;
const COUNTED_TOTAL = 5;
const COUNTED_COST = 1;
const PROJECT_A = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const PROJECT_B = "project_01JZ8PZ0A1B2C3D4E5F6G7H8JA";
const NODE_A = "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X";
const NODE_B = "node_01JZ8Q0K4M6N8P0R2S4T6V8W0Y";
const RESPONSE_MODEL = "gen_ai.response.model";
const REQUEST_MODEL = "gen_ai.request.model";
const INPUT = "gen_ai.usage.input_tokens";
const OUTPUT = "gen_ai.usage.output_tokens";
const CACHE_READ = "gen_ai.usage.cache_read.input_tokens";
const CACHE_CREATION = "gen_ai.usage.cache_creation.input_tokens";
const COST = "kanthord.usage.cost_usd";
const AGENT = "kanthord.agent.name";
const PROVIDER = "gen_ai.provider.name";

function traceIdOf(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function spanIdOf(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function seededStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  const traces = [
    [1, PROJECT_A, NODE_A, "worker_a"],
    [2, PROJECT_B, NODE_B, "worker_b"],
  ] as const;
  store.transaction((tx) => {
    for (const [n, project, node, worker] of traces)
      tx.database
        .prepare(
          "INSERT INTO tracking_trace (trace_id, project_id, root_span_id, created_at, node_id, started_at, worker_name) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(traceIdOf(n), project, spanIdOf(n), MONDAY, node, MONDAY, worker);
  });
  return store;
}

function addTurns(store: Store, turns: readonly Turn[]): void {
  store.transaction((tx) => {
    turns.forEach((turn, index) =>
      insertSpan(tx, {
        trace_id: traceIdOf(turn.trace ?? 1),
        span_id: spanIdOf(100 + index),
        parent_span_id: null,
        producer: "worker",
        origin: SpanOrigin.Observed,
        operation: turn.operation ?? "agent.turn",
        start_time: turn.start,
        end_time: null,
        status: SpanStatus.Unset,
        attributes: turn.attributes ?? {},
        events: [],
        links: [],
        text_ids: [],
        created_at: turn.start,
      }),
    );
  });
}

function usage(
  model: string,
  tokens: [number, number, number, number],
  cost: number,
): Record<string, string | number> {
  return {
    [RESPONSE_MODEL]: model,
    [INPUT]: tokens[0],
    [OUTPUT]: tokens[1],
    [CACHE_READ]: tokens[2],
    [CACHE_CREATION]: tokens[3],
    [COST]: cost,
  };
}

function read(
  store: Store,
  overrides: Partial<CostQuery> = {},
  limit = LIMIT,
): ReturnType<typeof readCost> {
  return readCost(
    store,
    {
      from: MONDAY,
      to: RANGE_END,
      group_by: CostGroupBy.Model,
      bucket: AnalyticsBucket.Day,
      ...overrides,
    },
    limit,
    new AbortController().signal,
  );
}

function keysOf(items: readonly CostItem[]): (string | null)[] {
  return items.map((item) => item.key);
}

test("each model and day answers one item with the sums of its turns", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    { start: MONDAY + HOUR, attributes: usage("gpt", [10, 5, 2, 1], 0.5) },
    {
      start: MONDAY + 2 * HOUR,
      attributes: usage("gpt", [20, 15, 3, 4], 0.25),
    },
    { start: MONDAY + 3 * HOUR, attributes: usage("claude", [1, 2, 3, 4], 2) },
    { start: MONDAY + DAY, attributes: usage("gpt", [7, 3, 0, 0], 1) },
  ]);
  const { items, truncated } = await read(store);
  assert.equal(truncated, false);
  assert.deepEqual(items, [
    {
      key: "claude",
      bucket_start: MONDAY,
      turn_count: 1,
      input_tokens: 1,
      output_tokens: 2,
      cache_read_tokens: 3,
      cache_creation_tokens: 4,
      total_tokens: 3,
      cost_usd: 2,
    },
    {
      key: "gpt",
      bucket_start: MONDAY,
      turn_count: 2,
      input_tokens: 30,
      output_tokens: 20,
      cache_read_tokens: 5,
      cache_creation_tokens: 5,
      total_tokens: 50,
      cost_usd: 0.75,
    },
    {
      key: "gpt",
      bucket_start: MONDAY + DAY,
      turn_count: 1,
      input_tokens: 7,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 10,
      cost_usd: 1,
    },
  ]);
});

test("the model is the response model, else the request model, else null", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    {
      start: MONDAY,
      attributes: {
        [RESPONSE_MODEL]: "response_a",
        [REQUEST_MODEL]: "ignored",
      },
    },
    { start: MONDAY, attributes: { [REQUEST_MODEL]: "request_b" } },
    { start: MONDAY, attributes: {} },
    { start: MONDAY, attributes: { [RESPONSE_MODEL]: 5, [REQUEST_MODEL]: 6 } },
    {
      start: MONDAY,
      attributes: { [RESPONSE_MODEL]: 5, [REQUEST_MODEL]: "request_c" },
    },
  ]);
  const { items } = await read(store, { bucket: AnalyticsBucket.None });
  assert.deepEqual(keysOf(items), [
    "request_b",
    "request_c",
    "response_a",
    null,
  ]);
  assert.deepEqual(
    items.map((item) => item.turn_count),
    [1, 1, 1, 2],
  );
});

test("each other group_by value groups by its field", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    {
      trace: 1,
      start: MONDAY,
      attributes: { [AGENT]: "coder", [PROVIDER]: "p1", [COST]: 1 },
    },
    {
      trace: 2,
      start: MONDAY,
      attributes: { [AGENT]: "coder", [PROVIDER]: "p2", [COST]: 2 },
    },
    { trace: 2, start: MONDAY, attributes: { [AGENT]: 7, [COST]: 4 } },
  ]);
  const keys = async (group_by: CostGroupBy) =>
    keysOf(
      (await read(store, { group_by, bucket: AnalyticsBucket.None })).items,
    );
  assert.deepEqual(await keys(CostGroupBy.AgentName), [null, "coder"]);
  assert.deepEqual(await keys(CostGroupBy.ProviderName), [null, "p2", "p1"]);
  assert.deepEqual(await keys(CostGroupBy.WorkerName), [
    "worker_b",
    "worker_a",
  ]);
  assert.deepEqual(await keys(CostGroupBy.NodeId), [NODE_B, NODE_A]);
  assert.deepEqual(await keys(CostGroupBy.ProjectId), [PROJECT_B, PROJECT_A]);
});

test("group_by none with bucket none answers the totals, also when a grouped read is truncated", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    { start: MONDAY, attributes: usage("a", [1, 1, 0, 0], 1) },
    { start: MONDAY + DAY, attributes: usage("b", [2, 2, 0, 0], 2) },
    { start: MONDAY + 2 * DAY, attributes: usage("c", [3, 3, 0, 0], 3) },
  ]);
  const grouped = await read(store, {}, 1);
  assert.equal(grouped.truncated, true);
  const totals = await read(
    store,
    { group_by: CostGroupBy.None, bucket: AnalyticsBucket.None },
    1,
  );
  assert.equal(totals.truncated, false);
  assert.deepEqual(totals.items, [
    {
      key: null,
      bucket_start: null,
      turn_count: 3,
      input_tokens: 6,
      output_tokens: 6,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      total_tokens: 12,
      cost_usd: 6,
    },
  ]);
});

test("a bucket starts on its UTC boundary and a week starts on Monday", async (t) => {
  const store = seededStore(t);
  const wednesday = MONDAY + 2 * DAY + 10 * HOUR + 30 * 60_000;
  addTurns(store, [
    { start: wednesday },
    { start: MONDAY + WEEK - 1 },
    { start: MONDAY + WEEK },
  ]);
  const starts = async (bucket: AnalyticsBucket) =>
    (await read(store, { bucket })).items.map((item) => item.bucket_start);
  assert.deepEqual(await starts(AnalyticsBucket.Hour), [
    MONDAY + 2 * DAY + 10 * HOUR,
    MONDAY + WEEK - HOUR,
    MONDAY + WEEK,
  ]);
  assert.deepEqual(await starts(AnalyticsBucket.Day), [
    MONDAY + 2 * DAY,
    MONDAY + WEEK - DAY,
    MONDAY + WEEK,
  ]);
  assert.deepEqual(await starts(AnalyticsBucket.Week), [MONDAY, MONDAY + WEEK]);
  assert.deepEqual(await starts(AnalyticsBucket.None), [null]);
});

test("from and to bound the start time of a span inclusively", async (t) => {
  const store = seededStore(t);
  const from = MONDAY + DAY;
  const to = MONDAY + 2 * DAY;
  addTurns(store, [
    { start: from - 1 },
    { start: from },
    { start: to },
    { start: to + 1 },
  ]);
  const { items } = await read(store, {
    from,
    to,
    group_by: CostGroupBy.None,
    bucket: AnalyticsBucket.None,
  });
  assert.equal(items[0]!.turn_count, TURNS_IN_RANGE);
});

test("another operation adds nothing and a string token adds 0", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    { start: MONDAY, attributes: usage("a", [4, 1, 0, 0], 1) },
    {
      start: MONDAY,
      operation: "agent.tool",
      attributes: usage("a", [100, 100, 100, 100], 100),
    },
    {
      start: MONDAY,
      attributes: {
        ...usage("a", [0, 0, 0, 0], 0),
        [INPUT]: "50",
        [COST]: "9",
      },
    },
  ]);
  const { items } = await read(store, { bucket: AnalyticsBucket.None });
  assert.equal(items.length, ONE_ITEM);
  assert.equal(items[0]!.turn_count, COUNTED_TURNS);
  assert.equal(items[0]!.input_tokens, COUNTED_INPUT);
  assert.equal(items[0]!.total_tokens, COUNTED_TOTAL);
  assert.equal(items[0]!.cost_usd, COUNTED_COST);
});

test("items order by bucket, cost descending and key with null last", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    { start: MONDAY + DAY, attributes: usage("late", [0, 0, 0, 0], 9) },
    { start: MONDAY, attributes: usage("m_b", [0, 0, 0, 0], 3) },
    { start: MONDAY, attributes: usage("m_a", [0, 0, 0, 0], 3) },
    { start: MONDAY, attributes: { [COST]: 3 } },
    { start: MONDAY, attributes: usage("m_c", [0, 0, 0, 0], 5) },
  ]);
  const all = await read(store);
  assert.deepEqual(keysOf(all.items), ["m_c", "m_a", "m_b", null, "late"]);
  assert.equal(all.truncated, false);
  const limited = await read(store, { bucket: AnalyticsBucket.None }, 2);
  assert.deepEqual(keysOf(limited.items), ["late", "m_c"]);
  assert.equal(limited.truncated, true);
});

test("a limit of 2 on three groups answers 2 items and truncated", async (t) => {
  const store = seededStore(t);
  addTurns(store, [
    { start: MONDAY, attributes: usage("a", [0, 0, 0, 0], 1) },
    { start: MONDAY, attributes: usage("b", [0, 0, 0, 0], 2) },
    { start: MONDAY, attributes: usage("c", [0, 0, 0, 0], 3) },
  ]);
  const { items, truncated } = await read(store, {}, 2);
  assert.deepEqual(keysOf(items), ["c", "b"]);
  assert.equal(truncated, true);
});
