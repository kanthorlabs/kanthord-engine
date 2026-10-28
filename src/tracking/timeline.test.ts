import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  type Span,
  SpanOrigin,
  SpanStatus,
  TimelineDepth,
  TRACKING_SERVICE_NAME,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import {
  listTimeline,
  type TimelineCursor,
  type TimelineItem,
  type TimelinePage,
  type TimelineQuery,
} from "./timeline.ts";
import { insertSpan } from "./trace-store.ts";

interface TraceFixture {
  n: number;
  node: string | null;
  project: string;
  execution: string | null;
  started: number | null;
  ended: number | null;
  created: number;
  worker: string | null;
  root: boolean;
}

interface SpanFixture {
  trace: number;
  n: number;
  parent: number | null;
  start: number | null;
  end: number | null;
}

const PROJECT_A = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const PROJECT_B = "project_01JZ8PZ0A1B2C3D4E5F6G7H8JA";
const NODE_A = "node_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const NODE_B = "node_01JZ8PZ0A1B2C3D4E5F6G7H8JA";
const ULID_HEAD = "01JZ8R2B3C4D5E6F7G8H9J0K1";
const TRACE_END_TIME = Number.MAX_SAFE_INTEGER;
const WIDE_LIMIT = 1000;
const NO_ITEMS = 0;
const FIVE_TRACES = 5;
const FIVE_ITEMS = 5;
const SIX_ITEMS = 6;
const CHILD_DURATION = 200;
const ROOT_STRIDE = 1000;
const TRACE_COUNT = 12;
const NO_ROOT_TRACE = 5;
const PAGE_SIZES = [1, 2, 3] as const;
const DEPTHS = [TimelineDepth.Root, TimelineDepth.Child] as const;

function traceIdOf(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function spanIdOf(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function rootOf(trace: number): number {
  return trace * ROOT_STRIDE;
}

function insertTraceRow(store: Store, overrides: Partial<TraceFixture>): void {
  const fixture: TraceFixture = {
    n: 1,
    node: NODE_A,
    project: PROJECT_A,
    execution: `execution_${ULID_HEAD}${overrides.n ?? 1}`,
    started: 1000,
    ended: 2000,
    created: 900,
    worker: null,
    root: true,
    ...overrides,
  };
  store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO tracking_trace (trace_id, project_id, execution_id, root_span_id, created_at, node_id, attempt, started_at, ended_at, worker_name) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
      )
      .run(
        traceIdOf(fixture.n),
        fixture.project,
        fixture.execution,
        spanIdOf(rootOf(fixture.n)),
        fixture.created,
        fixture.node,
        fixture.started,
        fixture.ended,
        fixture.worker,
      );
  });
  if (fixture.root)
    insertSpanRow(store, {
      trace: fixture.n,
      n: rootOf(fixture.n),
      parent: null,
      start: fixture.started ?? fixture.created,
      end: fixture.ended,
    });
}

function insertSpanRow(store: Store, fixture: SpanFixture): void {
  const span: Span = {
    trace_id: traceIdOf(fixture.trace),
    span_id: spanIdOf(fixture.n),
    parent_span_id: fixture.parent === null ? null : spanIdOf(fixture.parent),
    producer: "scheduler",
    origin: SpanOrigin.Observed,
    operation: "scheduler.execution",
    start_time: fixture.start,
    end_time: fixture.end,
    status: SpanStatus.Ok,
    attributes: { key: "value" },
    events: [],
    links: [],
    text_ids: [],
    created_at: 1,
  };
  store.transaction((tx) => insertSpan(tx, span));
}

function child(
  store: Store,
  trace: number,
  k: number,
  start: number | null,
  end: number | null,
): void {
  insertSpanRow(store, {
    trace,
    n: rootOf(trace) + k,
    parent: rootOf(trace),
    start,
    end,
  });
}

function emptyStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function read(
  store: Store,
  query: Partial<TimelineQuery>,
  after: TimelineCursor | null = null,
): TimelinePage {
  return store.transaction((tx) =>
    listTimeline(tx, { node_id: NODE_A, ...query }, after),
  );
}

function walk(
  store: Store,
  query: Partial<TimelineQuery>,
  limit: number,
): TimelineItem[] {
  const items: TimelineItem[] = [];
  let after: TimelineCursor | null = null;
  const bound = (TRACE_COUNT + 1) * (TRACE_COUNT + 2);
  for (let page = 0; page < bound; page += 1) {
    const result: TimelinePage = read(store, { ...query, limit }, after);
    items.push(...result.items);
    if (result.next_cursor === null) return items;
    after = result.next_cursor;
  }
  throw new Error("walk did not end");
}

function pairsOf(page: TimelinePage): [string, string][] {
  return page.items.map((item) => [item.trace_id, item.span_id]);
}

function spans(trace: number, ...children: number[]): [string, string][] {
  return [
    [traceIdOf(trace), spanIdOf(rootOf(trace))],
    ...children.map((k): [string, string] => [
      traceIdOf(trace),
      spanIdOf(rootOf(trace) + k),
    ]),
  ];
}

function threeTraces(t: TestContext): Store {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 3000, ended: 4000 });
  insertTraceRow(store, { n: 2, started: 1000, ended: 1500 });
  insertTraceRow(store, { n: 3, started: 2000, ended: 2500, execution: null });
  insertTraceRow(store, { n: 4, node: NODE_B, started: 500, ended: 600 });
  child(store, 1, 1, 3100, 3200);
  child(store, 2, 1, 1100, 1200);
  child(store, 3, 1, 2100, 2200);
  insertSpanRow(store, {
    trace: 1,
    n: rootOf(1) + 50,
    parent: rootOf(1) + 1,
    start: 3150,
    end: 3160,
  });
  return store;
}

test("a node scope answers the traces of the node in ascending order of the trace start", (t) => {
  const store = threeTraces(t);
  const page = read(store, { depth: 1 });
  assert.deepEqual(pairsOf(page), [...spans(2), ...spans(3), ...spans(1)]);
  assert.equal(page.next_cursor, null);
});

test("depth 1 answers the roots and depth 2 adds the children and no grandchild", (t) => {
  const store = threeTraces(t);
  assert.deepEqual(
    read(store, { depth: 1 }).items.map((item) => item.depth),
    [1, 1, 1],
  );
  const page = read(store, { depth: 2 });
  assert.deepEqual(pairsOf(page), [
    ...spans(2, 1),
    ...spans(3, 1),
    ...spans(1, 1),
  ]);
  assert.deepEqual(
    page.items.map((item) => item.depth),
    [1, 2, 1, 2, 1, 2],
  );
  assert.equal(read(store, {}).items.length, page.items.length);
});

test("a child whose root row is absent still appears with depth 2", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, root: false });
  child(store, 1, 1, 1100, 1200);
  const page = read(store, { depth: 2 });
  assert.deepEqual(pairsOf(page), [[traceIdOf(1), spanIdOf(rootOf(1) + 1)]]);
  assert.equal(page.items[0]?.depth, TimelineDepth.Child);
  assert.equal(
    read(store, { depth: TimelineDepth.Root }).items.length,
    NO_ITEMS,
  );
});

test("an execution scope answers one trace and a project scope answers every trace of the project", (t) => {
  const store = threeTraces(t);
  insertTraceRow(store, { n: 5, project: PROJECT_B, node: NODE_B, started: 1 });
  const execution = read(store, {
    node_id: undefined,
    execution_id: `execution_${ULID_HEAD}2`,
    depth: 1,
  });
  assert.deepEqual(pairsOf(execution), spans(2));
  const project = read(store, {
    node_id: undefined,
    project_id: PROJECT_A,
    depth: 1,
  });
  assert.deepEqual(pairsOf(project), [
    ...spans(4),
    ...spans(2),
    ...spans(3),
    ...spans(1),
  ]);
});

test("the order follows the timeline time, then span_id, and the trace start, then trace_id", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 2, started: 1000, ended: 9000 });
  insertTraceRow(store, { n: 1, started: 1000, ended: 9000 });
  child(store, 1, 3, 1500, 1600);
  child(store, 1, 2, 1500, 1600);
  child(store, 1, 1, null, 1400);
  child(store, 1, 4, 1700, null);
  const page = read(store, { depth: 2 });
  assert.deepEqual(pairsOf(page), [...spans(1, 1, 2, 3, 4), ...spans(2)]);
});

test("the window selects by the start and the end of a trace", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 5000, ended: 6000 });
  insertTraceRow(store, { n: 2, started: 100, ended: 200 });
  insertTraceRow(store, { n: 3, started: 100, ended: null });
  insertTraceRow(store, { n: 4, started: 1500, ended: 2500 });
  insertTraceRow(store, { n: 5, started: null, ended: null, created: 1200 });
  const page = read(store, { from: 1000, to: 4000, depth: 1 });
  assert.deepEqual(pairsOf(page), [...spans(3), ...spans(5), ...spans(4)]);
  assert.equal(
    read(store, { depth: TimelineDepth.Root }).items.length,
    FIVE_TRACES,
  );
  assert.deepEqual(pairsOf(read(store, { to: 99, depth: 1 })), []);
  assert.deepEqual(pairsOf(read(store, { from: 6000, depth: 1 })), [
    ...spans(3),
    ...spans(5),
    ...spans(1),
  ]);
});

test("a full page answers the cursor of its last item and the next page continues after it", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 1000, ended: 2000 });
  insertTraceRow(store, { n: 2, started: 1000, ended: 2000 });
  child(store, 1, 1, 1500, 1600);
  child(store, 1, 2, 1500, 1600);
  child(store, 2, 1, 1500, 1600);
  const first = read(store, { depth: 2, limit: 2 });
  assert.deepEqual(pairsOf(first), [...spans(1, 1)]);
  assert.deepEqual(first.next_cursor, {
    trace_time: 1000,
    trace_id: traceIdOf(1),
    item_time: 1500,
    span_id: spanIdOf(rootOf(1) + 1),
  });
  const second = read(store, { depth: 2, limit: 2 }, first.next_cursor);
  assert.deepEqual(pairsOf(second), [
    [traceIdOf(1), spanIdOf(rootOf(1) + 2)],
    [traceIdOf(2), spanIdOf(rootOf(2))],
  ]);
  const third = read(store, { depth: 2, limit: 2 }, second.next_cursor);
  assert.deepEqual(pairsOf(third), [[traceIdOf(2), spanIdOf(rootOf(2) + 1)]]);
  assert.equal(third.next_cursor, null);
});

test("depth 1 over a middle trace with no root row leaves no gap", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 1000, ended: 2000 });
  insertTraceRow(store, { n: 2, started: 2000, ended: 3000, root: false });
  insertTraceRow(store, { n: 3, started: 3000, ended: 4000 });
  const first = read(store, { depth: 1, limit: 1 });
  assert.deepEqual(pairsOf(first), spans(1));
  assert.deepEqual(first.next_cursor, {
    trace_time: 2000,
    trace_id: traceIdOf(2),
    item_time: TRACE_END_TIME,
    span_id: "",
  });
  const second = read(store, { depth: 1, limit: 1 }, first.next_cursor);
  assert.deepEqual(pairsOf(second), spans(3));
  assert.equal(second.next_cursor, null);
  const wide = read(store, { depth: 1, limit: 2 });
  assert.deepEqual(pairsOf(wide), [...spans(1), ...spans(3)]);
  assert.deepEqual(wide.next_cursor, {
    trace_time: 3000,
    trace_id: traceIdOf(3),
    item_time: TRACE_END_TIME,
    span_id: "",
  });
  assert.equal(
    read(store, { depth: 1, limit: 2 }, wide.next_cursor).next_cursor,
    null,
  );
});

test("a page that ends on the last item of a trace holds a cursor and the next page starts with the next trace", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 1000, ended: 2000 });
  insertTraceRow(store, { n: 2, started: 2000, ended: 3000 });
  child(store, 1, 1, 1500, 1600);
  const first = read(store, { depth: 2, limit: 2 });
  assert.deepEqual(pairsOf(first), spans(1, 1));
  assert.ok(first.next_cursor);
  const second = read(store, { depth: 2, limit: 2 }, first.next_cursor);
  assert.deepEqual(pairsOf(second), spans(2));
  assert.equal(second.next_cursor, null);
});

test("a page of kept traces with no item answers the cursor of a trace end", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 1000, ended: 2000, root: false });
  insertTraceRow(store, { n: 2, started: 2000, ended: 3000, root: false });
  insertTraceRow(store, { n: 3, started: 3000, ended: 4000 });
  const first = read(store, { depth: 1, limit: 1 });
  assert.deepEqual(first.items, []);
  assert.deepEqual(first.next_cursor, {
    trace_time: 2000,
    trace_id: traceIdOf(2),
    item_time: TRACE_END_TIME,
    span_id: "",
  });
  const second = read(store, { depth: 1, limit: 1 }, first.next_cursor);
  assert.deepEqual(pairsOf(second), spans(3));
  assert.equal(second.next_cursor, null);
});

test("the last page holds no cursor", (t) => {
  const store = threeTraces(t);
  const page = read(store, { depth: 2, limit: 6 });
  assert.equal(page.items.length, SIX_ITEMS);
  assert.equal(page.next_cursor, null);
  assert.equal(read(store, { limit: FIVE_ITEMS }).items.length, FIVE_ITEMS);
  assert.ok(read(store, { limit: FIVE_ITEMS }).next_cursor);
});

test("a walk at any page size answers the items of one wide read", (t) => {
  const store = emptyStore(t);
  for (let n = 1; n <= TRACE_COUNT; n += 1)
    insertTraceRow(store, {
      n,
      started: 1000 + (n % 4) * 100,
      ended: 5000,
      root: n !== NO_ROOT_TRACE,
    });
  for (const n of [1, 2, 5, 7, 8, 12]) child(store, n, 1, 2000 + n, 2100);
  for (const n of [2, 5, 8]) child(store, n, 2, 2000 + n, 2100);
  child(store, 8, 3, null, 2050);
  insertSpanRow(store, {
    trace: 2,
    n: rootOf(2) + 9,
    parent: rootOf(2) + 1,
    start: 2500,
    end: 2600,
  });
  for (const depth of DEPTHS) {
    const wide = walk(store, { depth }, WIDE_LIMIT);
    assert.ok(wide.length > NO_ITEMS);
    for (const limit of PAGE_SIZES)
      assert.deepEqual(walk(store, { depth }, limit), wide);
  }
  assert.equal(
    walk(store, { depth: 2 }, WIDE_LIMIT).length,
    TRACE_COUNT - 1 + 6 + 3 + 1,
  );
});

test("an item holds the span fields, the trace fields and the duration", (t) => {
  const store = emptyStore(t);
  insertTraceRow(store, { n: 1, started: 1000, ended: 2000, worker: "w1" });
  child(store, 1, 1, 1100, 1300);
  child(store, 1, 2, null, 1400);
  const [root, first, second] = read(store, { depth: 2 }).items;
  assert.deepEqual(root, {
    trace_id: traceIdOf(1),
    span_id: spanIdOf(rootOf(1)),
    parent_span_id: null,
    producer: "scheduler",
    origin: SpanOrigin.Observed,
    operation: "scheduler.execution",
    start_time: 1000,
    end_time: 2000,
    status: SpanStatus.Ok,
    attributes: { key: "value" },
    events: [],
    links: [],
    text_ids: [],
    created_at: 1,
    depth: 1,
    duration_ms: 1000,
    project_id: PROJECT_A,
    node_id: NODE_A,
    execution_id: `execution_${ULID_HEAD}1`,
    attempt: 1,
    worker_name: "w1",
  });
  assert.equal(first?.depth, TimelineDepth.Child);
  assert.equal(first?.duration_ms, CHILD_DURATION);
  assert.equal(first?.worker_name, null);
  assert.equal(first?.parent_span_id, spanIdOf(rootOf(1)));
  assert.equal(first?.node_id, NODE_A);
  assert.equal(second?.duration_ms, null);
});

interface Captured {
  sql: string;
  params: unknown[];
}

function captureStatement(store: Store, query: TimelineQuery): Captured {
  let captured: Captured | null = null;
  store.transaction((tx) => {
    const database = {
      prepare(sql: string) {
        const statement = tx.database.prepare(sql);
        return {
          all(...params: unknown[]) {
            captured = { sql, params };
            return statement.all(...(params as [])) as unknown[];
          },
        };
      },
    } as unknown as DatabaseSync;
    listTimeline({ database }, query, null);
  });
  assert.ok(captured);
  return captured;
}

function planOf(database: DatabaseSync, captured: Captured): string[] {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${captured.sql}`)
    .all(...(captured.params as []))
    .map((row) => String(row.detail));
}

test("the plan of each scope reads tracking_span only through its primary key", (t) => {
  const store = threeTraces(t);
  const scopes: [Partial<TimelineQuery>, string | null][] = [
    [{ node_id: NODE_A }, null],
    [{ project_id: PROJECT_A }, null],
    [{ execution_id: `execution_${ULID_HEAD}1` }, "tracking_trace_execution"],
  ];
  for (const [scope, index] of scopes)
    for (const depth of DEPTHS) {
      const captured = captureStatement(store, {
        ...scope,
        depth,
        limit: 2,
      });
      const plan = planOf(store.database, captured);
      const searches = plan.filter((line) => line.startsWith("SEARCH s "));
      assert.ok(searches.length > NO_ITEMS, plan.join("\n"));
      for (const line of plan.filter((entry) =>
        /tracking_span|^SCAN s\b/.test(entry),
      ))
        assert.match(
          line,
          /^SEARCH s USING INDEX sqlite_autoindex_tracking_span_1/,
        );
      if (index === null)
        assert.ok(
          plan.some((line) => line.startsWith("SCAN tracking_trace")),
          plan.join("\n"),
        );
      else
        assert.ok(
          plan.some((line) => line.includes(index)),
          plan.join("\n"),
        );
    }
});
