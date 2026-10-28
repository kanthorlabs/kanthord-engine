import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { SpanOrigin, SpanStatus, TRACKING_SERVICE_NAME } from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import {
  type AnalyticsSpan,
  type SelectedTrace,
  selectTraces,
  walkSpans,
} from "./analytics-walk.ts";
import { insertSpan } from "./trace-store.ts";

interface Fixture {
  n: number;
  project: string;
  node: string;
  started: number | null;
  ended: number | null;
  created: number;
}

const PROJECT_A = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const PROJECT_B = "project_01JZ8PZ0A1B2C3D4E5F6G7H8JA";
const NODE_A = "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X";
const NODE_B = "node_01JZ8Q0K4M6N8P0R2S4T6V8W0Y";
const TURN = "agent.turn";
const OTHER = "agent.tool";
const RANGE = { from: 1000, to: 2000 };
const MANY_TRACES = 250;
const FIRST_STEP_ONLY = 1;
const NO_STATEMENTS = 0;
const STEP_SIZES = [100, 100, 50];
const BASE: Fixture = {
  n: 0,
  project: PROJECT_A,
  node: NODE_A,
  started: 1500,
  ended: 1800,
  created: 1400,
};
const FIXTURES: Fixture[] = [
  { ...BASE, n: 1 },
  { ...BASE, n: 2, project: PROJECT_B, started: 500, ended: 1200 },
  { ...BASE, n: 3, node: NODE_B, started: 500, ended: null },
  { ...BASE, n: 4, started: 100, ended: 900 },
  { ...BASE, n: 5, started: 2500, ended: 3000 },
  { ...BASE, n: 6, started: 2000, ended: 2500 },
  { ...BASE, n: 7, started: 500, ended: 1000 },
  { ...BASE, n: 8, started: null, ended: null, created: 1500 },
  { ...BASE, n: 9, started: null, ended: null, created: 2500 },
];

function traceIdOf(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function spanIdOf(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function numberOf(trace: SelectedTrace): number {
  return Number.parseInt(trace.trace_id, 16);
}

function openStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  return store;
}

function insertFixture(store: Store, fixture: Fixture): void {
  store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO tracking_trace (trace_id, project_id, root_span_id, created_at, node_id, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        traceIdOf(fixture.n),
        fixture.project,
        spanIdOf(fixture.n),
        fixture.created,
        fixture.node,
        fixture.started,
        fixture.ended,
      );
  });
}

function insertTurn(
  store: Store,
  trace: number,
  span: number,
  operation: string,
  startTime: number,
): void {
  store.transaction((tx) =>
    insertSpan(tx, {
      trace_id: traceIdOf(trace),
      span_id: spanIdOf(span),
      parent_span_id: null,
      producer: "worker",
      origin: SpanOrigin.Observed,
      operation,
      start_time: startTime,
      end_time: null,
      status: SpanStatus.Unset,
      attributes: { "kanthord.agent.name": "coder" },
      events: [],
      links: [],
      text_ids: [],
      created_at: startTime,
    }),
  );
}

function seededMany(t: TestContext): {
  store: Store;
  traces: SelectedTrace[];
} {
  const store = openStore(t);
  for (let n = 1; n <= MANY_TRACES; n++) {
    insertFixture(store, { ...BASE, n });
    insertTurn(store, n, 1, TURN, RANGE.from);
    insertTurn(store, n, 2, OTHER, RANGE.from);
    insertTurn(store, n, 3, TURN, RANGE.to + 1);
  }
  const traces = store.transaction((tx) => selectTraces(tx, RANGE, {}));
  return { store, traces };
}

function turnFilter() {
  return { operation: TURN, from: RANGE.from, to: RANGE.to };
}

function numbersOf(store: Store, filter: object): number[] {
  return store
    .transaction((tx) => selectTraces(tx, RANGE, filter))
    .map(numberOf);
}

test("the selection keeps each overlapping trace and drops the others", (t) => {
  const store = openStore(t);
  for (const fixture of FIXTURES) insertFixture(store, fixture);
  assert.deepEqual(numbersOf(store, {}), [1, 2, 3, 6, 7, 8]);
  assert.deepEqual(numbersOf(store, { project_id: PROJECT_B }), [2]);
  assert.deepEqual(numbersOf(store, { node_id: NODE_B }), [3]);
  assert.deepEqual(
    numbersOf(store, { project_id: PROJECT_A, node_id: NODE_A }),
    [1, 6, 7, 8],
  );
});

test("the selection answers the identity fields of each trace", (t) => {
  const store = openStore(t);
  insertFixture(store, { ...BASE, n: 1 });
  assert.deepEqual(
    store.transaction((tx) => selectTraces(tx, RANGE, {})),
    [
      {
        trace_id: traceIdOf(1),
        root_span_id: spanIdOf(1),
        project_id: PROJECT_A,
        node_id: NODE_A,
        attempt: null,
        worker_name: null,
      },
    ],
  );
});

test("a walk over 250 traces runs 3 steps and visits each span once", async (t) => {
  const { store, traces } = seededMany(t);
  const original = store.transaction.bind(store);
  const steps: Set<string>[] = [];
  t.mock.method(
    store,
    "transaction",
    (work: Parameters<Store["transaction"]>[0]) => {
      steps.push(new Set());
      return original(work);
    },
  );
  const visited: AnalyticsSpan[] = [];
  await walkSpans(
    store,
    traces,
    turnFilter(),
    new AbortController().signal,
    (span, trace) => {
      assert.equal(span.trace_id, trace.trace_id);
      steps.at(-1)!.add(span.trace_id);
      visited.push(span);
    },
  );
  assert.deepEqual(
    steps.map((step) => step.size),
    STEP_SIZES,
  );
  assert.equal(visited.length, MANY_TRACES);
  assert.equal(new Set(visited.map((span) => span.trace_id)).size, MANY_TRACES);
  assert.ok(visited.every((span) => span.operation === TURN));
  assert.ok(visited.every((span) => span.start_time === RANGE.from));
  assert.deepEqual(visited[0]!.attributes, { "kanthord.agent.name": "coder" });
});

test("the walk yields to the event loop between two steps", async (t) => {
  const { store, traces } = seededMany(t);
  const original = store.transaction.bind(store);
  const events: string[] = [];
  t.mock.method(
    store,
    "transaction",
    (work: Parameters<Store["transaction"]>[0]) => {
      events.push("step");
      return original(work);
    },
  );
  setImmediate(() => events.push("immediate"));
  await walkSpans(
    store,
    traces,
    turnFilter(),
    new AbortController().signal,
    () => {},
  );
  assert.deepEqual(events, ["step", "immediate", "step", "step"]);
});

test("an abort after the first step stops the walk with its reason", async (t) => {
  const { store, traces } = seededMany(t);
  const original = store.transaction.bind(store);
  const controller = new AbortController();
  const reason = new Error("cancelled");
  let steps = 0;
  t.mock.method(
    store,
    "transaction",
    (work: Parameters<Store["transaction"]>[0]) => {
      steps += 1;
      return original(work);
    },
  );
  await assert.rejects(
    walkSpans(store, traces, turnFilter(), controller.signal, () =>
      controller.abort(reason),
    ),
    (error) => error === reason,
  );
  assert.equal(steps, FIRST_STEP_ONLY);
});

test("the step statement searches the primary key of the span table", async (t) => {
  const { store, traces } = seededMany(t);
  const prepare = t.mock.method(store.database, "prepare");
  await walkSpans(
    store,
    traces,
    turnFilter(),
    new AbortController().signal,
    () => {},
  );
  const statements = prepare.mock.calls
    .map((call) => String(call.arguments[0]))
    .filter((sql) => sql.includes("FROM tracking_span"));
  prepare.mock.restore();
  assert.notEqual(statements.length, NO_STATEMENTS);
  for (const sql of statements) {
    const details = store.database
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all()
      .map((row) => String(row.detail));
    assert.ok(
      details.some(
        (detail) =>
          detail.startsWith("SEARCH") &&
          detail.includes("sqlite_autoindex_tracking_span_1"),
      ),
    );
    assert.ok(
      !details.some(
        (detail) =>
          detail.startsWith("SCAN") && detail.includes("tracking_span"),
      ),
    );
  }
});
