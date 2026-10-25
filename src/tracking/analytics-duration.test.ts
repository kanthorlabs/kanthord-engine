import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  AnalyticsBucket,
  AnalyticsMeasure,
  DurationGroupBy,
  SpanOrigin,
  SpanStatus,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import {
  readDuration,
  type DurationItem,
  type DurationQuery,
} from "./analytics-duration.ts";
import { insertSpan } from "./trace-store.ts";

interface Seed {
  trace?: number;
  root?: boolean;
  start: number;
  end?: number | null;
  operation?: string;
  attributes?: Record<string, string | number>;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONDAY = Date.UTC(2024, 0, 1);
const RANGE_END = MONDAY + 14 * DAY;
const LIMIT = 1000;
const TOLERANCE = 0.000001;
const SPAN_COUNT = 100;
const ONE_ITEM = 1;
const ALL_DURATIONS = 3;
const TURN_DURATIONS = 2;
const TURN_MAX = 30;
const VERIFICATIONS = 2;
const VERIFICATION_MAX = 300;
const QUEUE_WAITS = 2;
const QUEUE_WAIT_MAX = 300;
const REVIEW_WAIT = 50;
const ALL_ATTEMPTS = 4;
const MEAN_OF_ATTEMPTS = 0.5;
const P90_OF_ATTEMPTS = 1.4;
const MAX_TURNS = 2;
const PROJECT_A = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const PROJECT_B = "project_01JZ8PZ0A1B2C3D4E5F6G7H8JA";
const NODE_A = "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X";
const NODE_B = "node_01JZ8Q0K4M6N8P0R2S4T6V8W0Y";
const ROOT_OPERATION = "scheduler.execution";
const TRANSITION_OPERATION = "scheduler.transition";
const RESPONSE_MODEL = "gen_ai.response.model";
const REQUEST_MODEL = "gen_ai.request.model";
const AGENT = "kanthord.agent.name";
const TOOL = "gen_ai.tool.name";
const KIND = "kanthord.execution.kind";
const WAIT = "kanthord.queue.wait_ms";
const STATE_FROM = "kanthord.node.state.from";
const STATE_TO = "kanthord.node.state.to";

function traceIdOf(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function spanIdOf(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function seededStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  const traces = [
    [1, PROJECT_A, NODE_A, 1, "worker_a"],
    [2, PROJECT_B, NODE_B, 1, "worker_b"],
    [3, PROJECT_A, NODE_A, 1, "worker_a"],
    [4, PROJECT_A, NODE_A, 2, "worker_a"],
    [5, PROJECT_A, NODE_A, 3, "worker_a"],
  ] as const;
  store.transaction((tx) => {
    for (const [n, project, node, attempt, worker] of traces)
      tx.database
        .prepare(
          "INSERT INTO tracking_trace (trace_id, project_id, root_span_id, created_at, node_id, attempt, started_at, worker_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          traceIdOf(n),
          project,
          spanIdOf(n),
          MONDAY,
          node,
          attempt,
          MONDAY,
          worker,
        );
  });
  return store;
}

function addSpans(store: Store, seeds: readonly Seed[]): void {
  store.transaction((tx) => {
    seeds.forEach((seed, index) => {
      const trace = seed.trace ?? 1;
      insertSpan(tx, {
        trace_id: traceIdOf(trace),
        span_id: seed.root ? spanIdOf(trace) : spanIdOf(100 + index),
        parent_span_id: null,
        producer: "worker",
        origin: SpanOrigin.Observed,
        operation: seed.operation ?? "agent.turn",
        start_time: seed.start,
        end_time: seed.end === undefined ? seed.start + 10 : seed.end,
        status: SpanStatus.Unset,
        attributes: seed.attributes ?? {},
        events: [],
        links: [],
        text_ids: [],
        created_at: seed.start,
      });
    });
  });
}

function read(
  store: Store,
  measure: AnalyticsMeasure,
  overrides: Partial<DurationQuery> = {},
  limit = LIMIT,
): ReturnType<typeof readDuration> {
  return readDuration(
    store,
    {
      from: MONDAY,
      to: RANGE_END,
      measure,
      group_by: DurationGroupBy.None,
      bucket: AnalyticsBucket.None,
      ...overrides,
    },
    limit,
    new AbortController().signal,
  );
}

function keysOf(items: readonly DurationItem[]): (string | null)[] {
  return items.map((item) => item.key);
}

function assertClose(actual: number, expected: number): void {
  assert.ok(
    Math.abs(actual - expected) < TOLERANCE,
    `${actual} differs from ${expected}`,
  );
}

function durations(values: readonly number[]): Seed[] {
  return values.map((value, index): Seed => ({
    start: MONDAY + index,
    end: MONDAY + index + value,
  }));
}

function transition(from: string, to: string, start: number, trace = 3): Seed {
  return {
    trace,
    start,
    operation: TRANSITION_OPERATION,
    attributes: { [STATE_FROM]: from, [STATE_TO]: to },
  };
}

function root(trace: number, start: number, kind: string, wait?: number): Seed {
  return {
    trace,
    root: true,
    start,
    operation: ROOT_OPERATION,
    attributes:
      wait === undefined ? { [KIND]: kind } : { [KIND]: kind, [WAIT]: wait },
  };
}

test("span_duration answers the percentiles of 100 durations", async (t) => {
  const store = seededStore(t);
  const values = Array.from({ length: SPAN_COUNT }, (_, index) => index + 1);
  addSpans(store, [...durations(values), { start: MONDAY + 5, end: null }]);
  const { items, truncated } = await read(store, AnalyticsMeasure.SpanDuration);
  assert.equal(truncated, false);
  assert.equal(items.length, ONE_ITEM);
  const item = items[0]!;
  assert.equal(item.key, null);
  assert.equal(item.bucket_start, null);
  assert.equal(item.count, SPAN_COUNT);
  assertClose(item.p50, 50.5);
  assertClose(item.p90, 90.1);
  assertClose(item.p99, 99.01);
  assertClose(item.mean, 50.5);
  assertClose(item.max, 100);
});

test("one value answers that value for every percentile", async (t) => {
  const store = seededStore(t);
  addSpans(store, durations([42]));
  const { items } = await read(store, AnalyticsMeasure.SpanDuration);
  assert.deepEqual(items, [
    {
      key: null,
      bucket_start: null,
      count: 1,
      p50: 42,
      p90: 42,
      p99: 42,
      mean: 42,
      max: 42,
    },
  ]);
});

test("span_duration skips a span with no end and the operation filters", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    { start: MONDAY, end: MONDAY + 10, operation: "agent.turn" },
    { start: MONDAY, end: MONDAY + 30, operation: "agent.turn" },
    { start: MONDAY, end: null, operation: "agent.turn" },
    { start: MONDAY, end: MONDAY + 500, operation: "agent.tool" },
  ]);
  const all = await read(store, AnalyticsMeasure.SpanDuration);
  assert.equal(all.items[0]!.count, ALL_DURATIONS);
  const turns = await read(store, AnalyticsMeasure.SpanDuration, {
    operation: "agent.turn",
  });
  assert.equal(turns.items[0]!.count, TURN_DURATIONS);
  assert.equal(turns.items[0]!.max, TURN_MAX);
  assertClose(turns.items[0]!.mean, 20);
  const none = await read(store, AnalyticsMeasure.SpanDuration, {
    operation: "agent.none",
  });
  assert.deepEqual(none.items, []);
});

test("tool_latency reads only agent.tool spans and groups by the tool", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    {
      start: MONDAY,
      end: MONDAY + 10,
      operation: "agent.tool",
      attributes: { [TOOL]: "bash" },
    },
    {
      start: MONDAY,
      end: MONDAY + 30,
      operation: "agent.tool",
      attributes: { [TOOL]: "bash" },
    },
    {
      start: MONDAY,
      end: MONDAY + 7,
      operation: "agent.tool",
      attributes: { [TOOL]: "read" },
    },
    {
      start: MONDAY,
      end: MONDAY + 900,
      operation: "agent.turn",
      attributes: { [TOOL]: "bash" },
    },
  ]);
  const { items } = await read(store, AnalyticsMeasure.ToolLatency, {
    group_by: DurationGroupBy.ToolName,
  });
  assert.deepEqual(
    items.map((item) => [item.key, item.count, item.max]),
    [
      ["bash", 2, 30],
      ["read", 1, 7],
    ],
  );
});

test("verification_time reads only worker.verification spans", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    { start: MONDAY, end: MONDAY + 100, operation: "worker.verification" },
    { start: MONDAY, end: MONDAY + 300, operation: "worker.verification" },
    { start: MONDAY, end: MONDAY + 9000, operation: "agent.tool" },
  ]);
  const { items } = await read(store, AnalyticsMeasure.VerificationTime);
  assert.equal(items.length, ONE_ITEM);
  assert.equal(items[0]!.count, VERIFICATIONS);
  assertClose(items[0]!.p50, 200);
  assert.equal(items[0]!.max, VERIFICATION_MAX);
});

test("queue_wait and review_wait read the wait of the root spans of their kind", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    root(1, MONDAY, "steps", 100),
    root(2, MONDAY, "steps", 300),
    root(3, MONDAY, "evaluation", 50),
    root(4, MONDAY, "act", 999),
    root(5, MONDAY, "steps"),
    {
      trace: 1,
      start: MONDAY,
      attributes: { [KIND]: "steps", [WAIT]: 7000 },
    },
  ]);
  const queue = await read(store, AnalyticsMeasure.QueueWait);
  assert.equal(queue.items.length, ONE_ITEM);
  assert.equal(queue.items[0]!.count, QUEUE_WAITS);
  assertClose(queue.items[0]!.mean, 200);
  assert.equal(queue.items[0]!.max, QUEUE_WAIT_MAX);
  const review = await read(store, AnalyticsMeasure.ReviewWait);
  assert.equal(review.items.length, ONE_ITEM);
  assert.equal(review.items[0]!.count, ONE_ITEM);
  assert.equal(review.items[0]!.p50, REVIEW_WAIT);
});

test("revision_turns counts the evaluating to available transitions of each attempt in the range", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    root(1, MONDAY + HOUR, "steps"),
    root(3, MONDAY + DAY + HOUR, "evaluation"),
    transition("Evaluating", "Available", MONDAY + HOUR + 1),
    transition("Evaluating", "Available", MONDAY + DAY + 2 * HOUR),
    transition("Evaluating", "Available", MONDAY + DAY + 3 * HOUR),
    transition("Evaluating", "Waiting", MONDAY + DAY + 4 * HOUR),
    root(4, MONDAY + DAY + HOUR, "steps"),
    transition("Executing", "Available", MONDAY + DAY + 2 * HOUR, 4),
    transition("Executing", "Waiting", MONDAY + DAY + 3 * HOUR, 4),
    transition("Evaluating", "Waiting", MONDAY + DAY + 4 * HOUR, 4),
    root(5, MONDAY + DAY + HOUR, "steps"),
    root(2, MONDAY + DAY + HOUR, "steps"),
  ]);
  const cut = await read(store, AnalyticsMeasure.RevisionTurns, {
    from: MONDAY + DAY,
  });
  assert.equal(cut.items.length, ONE_ITEM);
  assert.equal(cut.items[0]!.count, ALL_ATTEMPTS);
  assert.equal(cut.items[0]!.max, MAX_TURNS);
  assertClose(cut.items[0]!.mean, MEAN_OF_ATTEMPTS);
  assertClose(cut.items[0]!.p50, 0);
  assertClose(cut.items[0]!.p90, P90_OF_ATTEMPTS);
  const buckets = await read(store, AnalyticsMeasure.RevisionTurns, {
    bucket: AnalyticsBucket.Day,
  });
  assert.deepEqual(
    buckets.items.map((item) => [item.bucket_start, item.count, item.max]),
    [
      [MONDAY, 1, 3],
      [MONDAY + DAY, 3, 0],
    ],
  );
});

test("revision_turns groups an attempt by the trace row of its first root span", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    root(1, MONDAY + HOUR, "steps"),
    root(2, MONDAY + HOUR, "steps"),
    root(4, MONDAY + HOUR, "steps"),
    root(3, MONDAY + 2 * HOUR, "evaluation"),
    transition("Evaluating", "Available", MONDAY + 3 * HOUR),
  ]);
  const { items } = await read(store, AnalyticsMeasure.RevisionTurns, {
    group_by: DurationGroupBy.NodeId,
  });
  assert.deepEqual(
    items.map((item) => [item.key, item.count, item.max]),
    [
      [NODE_A, 2, 1],
      [NODE_B, 1, 0],
    ],
  );
});

test("each group_by value groups by its field", async (t) => {
  const store = seededStore(t);
  addSpans(store, [
    {
      trace: 1,
      operation: "agent.turn",
      start: MONDAY,
      attributes: {
        [AGENT]: "coder",
        [RESPONSE_MODEL]: "m_resp",
        [REQUEST_MODEL]: "ignored",
      },
    },
    {
      trace: 2,
      operation: "agent.tool",
      start: MONDAY,
      attributes: { [TOOL]: "bash", [REQUEST_MODEL]: "m_req", [AGENT]: 7 },
    },
    {
      trace: 2,
      operation: "agent.tool",
      start: MONDAY,
      attributes: { [TOOL]: "bash" },
    },
    {
      trace: 1,
      operation: "agent.turn",
      start: MONDAY,
      attributes: { [RESPONSE_MODEL]: 5, [REQUEST_MODEL]: "m_req" },
    },
  ]);
  const keys = async (group_by: DurationGroupBy) =>
    keysOf(
      (await read(store, AnalyticsMeasure.SpanDuration, { group_by })).items,
    );
  assert.deepEqual(await keys(DurationGroupBy.Operation), [
    "agent.tool",
    "agent.turn",
  ]);
  assert.deepEqual(await keys(DurationGroupBy.ToolName), ["bash", null]);
  assert.deepEqual(await keys(DurationGroupBy.AgentName), [null, "coder"]);
  assert.deepEqual(await keys(DurationGroupBy.Model), [
    "m_req",
    "m_resp",
    null,
  ]);
  assert.deepEqual(await keys(DurationGroupBy.WorkerName), [
    "worker_a",
    "worker_b",
  ]);
  assert.deepEqual(await keys(DurationGroupBy.NodeId), [NODE_A, NODE_B]);
  assert.deepEqual(await keys(DurationGroupBy.ProjectId), [
    PROJECT_A,
    PROJECT_B,
  ]);
});

test("items order by bucket, count descending and key with null last, and truncated follows the limit", async (t) => {
  const store = seededStore(t);
  const tool = (name: string | null, start: number): Seed => ({
    start,
    attributes: name === null ? {} : { [TOOL]: name },
  });
  addSpans(store, [
    tool("x", MONDAY),
    tool("a", MONDAY),
    tool("a", MONDAY),
    tool(null, MONDAY),
    tool("b", MONDAY),
    tool("z", MONDAY + DAY),
    tool("z", MONDAY + DAY),
    tool("z", MONDAY + DAY),
  ]);
  const query = {
    group_by: DurationGroupBy.ToolName,
    bucket: AnalyticsBucket.Day,
  };
  const all = await read(store, AnalyticsMeasure.SpanDuration, query);
  assert.deepEqual(keysOf(all.items), ["a", "b", "x", null, "z"]);
  assert.equal(all.truncated, false);
  const exact = await read(store, AnalyticsMeasure.SpanDuration, query, 5);
  assert.equal(exact.truncated, false);
  const limited = await read(
    store,
    AnalyticsMeasure.SpanDuration,
    { ...query, bucket: AnalyticsBucket.None },
    2,
  );
  assert.deepEqual(keysOf(limited.items), ["z", "a"]);
  assert.equal(limited.truncated, true);
});
