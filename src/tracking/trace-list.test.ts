import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IdentityKind } from "../kernel/caller.ts";
import { background } from "../kernel/context.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import {
  FACET_VALUES_MAX,
  SpanOrigin,
  SpanStatus,
  TRACE_LIST_LIMIT_DEFAULT,
  TraceSort,
  TRACKING_SERVICE_NAME,
  trackingOperations,
} from "./contract.ts";
import {
  CAUSE_LABEL_OPERATION,
  causeLabelSpanId,
  TRACKING_PRODUCER,
  writeCauseLabel,
} from "./cause-label.ts";
import { trackingMigrations } from "./migrations.ts";
import { TrackingService } from "./service.ts";
import { insertSpan } from "./trace-store.ts";
import {
  listTraces,
  readFacets,
  type TraceCursor,
  type TraceListQuery,
} from "./trace-list.ts";
import { stopAfter } from "../kernel/test-support.ts";

interface Fixture {
  n: number;
  project: string;
  worker: string | null;
  state: string;
  started: number | null;
  ended: number | null;
  created: number;
  input: number;
  output: number;
  cost: number;
  agents: string[];
  models: string[];
  errors: string[];
  stop: string | null;
}

const PROJECT_A = "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9";
const PROJECT_B = "project_01JZ8PZ0A1B2C3D4E5F6G7H8JA";
const ULID_HEAD = "01JZ8R2B3C4D5E6F7G8H9J0K1";
const NO_ROWS = 0;
const PAGE_OF_TWO = 2;
const OPEN_DURATION_VALUE = -1;
const MANY_WORKERS = 250;
const BASE: Fixture = {
  n: 0,
  project: PROJECT_A,
  worker: null,
  state: "ok",
  started: null,
  ended: null,
  created: 0,
  input: 0,
  output: 0,
  cost: 0,
  agents: [],
  models: [],
  errors: [],
  stop: null,
};
const FIXTURES: Fixture[] = [
  {
    ...BASE,
    n: 1,
    worker: "w1",
    started: 1000,
    ended: 2000,
    created: 900,
    input: 10,
    output: 5,
    cost: 0.5,
    agents: ["coder"],
    models: ["gpt-4"],
    stop: "done",
  },
  {
    ...BASE,
    n: 2,
    worker: "w2",
    state: "error",
    started: 3000,
    ended: 3500,
    created: 2900,
    input: 100,
    output: 50,
    cost: 0.1,
    agents: ["coder", "review"],
    models: ["Claude-3"],
    errors: ["rate_limited"],
    stop: "provider_failed",
  },
  {
    ...BASE,
    n: 3,
    project: PROJECT_B,
    worker: "w1",
    started: 2000,
    ended: 6000,
    created: 1900,
    input: 20,
    cost: 2,
    agents: ["plan"],
    models: ["gpt-4"],
  },
  {
    ...BASE,
    n: 4,
    project: PROJECT_B,
    worker: "w3",
    state: "open",
    started: 5000,
    created: 4900,
  },
  { ...BASE, n: 5, state: "open", created: 4000 },
];

function traceIdOf(n: number): string {
  return n.toString(16).padStart(32, "0");
}

function rootSpanIdOf(n: number): string {
  return n.toString(16).padStart(16, "0");
}

function insert(store: Store, fixture: Fixture): void {
  store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO tracking_trace (trace_id, project_id, execution_id, root_span_id, created_at, node_id, attempt, state, started_at, ended_at, stop_reason, worker_name, agent_names, models, error_types, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        traceIdOf(fixture.n),
        fixture.project,
        `execution_${ULID_HEAD}${fixture.n}`,
        rootSpanIdOf(fixture.n),
        fixture.created,
        `node_${ULID_HEAD}${fixture.n}`,
        fixture.state,
        fixture.started,
        fixture.ended,
        fixture.stop,
        fixture.worker,
        JSON.stringify(fixture.agents),
        JSON.stringify(fixture.models),
        JSON.stringify(fixture.errors),
        fixture.input,
        fixture.output,
        fixture.cost,
      );
  });
}

function seeded(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  for (const fixture of FIXTURES) insert(store, fixture);
  return store;
}

function queryOf(overrides: Partial<TraceListQuery> = {}): TraceListQuery {
  return {
    sort: TraceSort.StartedAt,
    limit: TRACE_LIST_LIMIT_DEFAULT,
    ...overrides,
  };
}

function idsOf(
  store: Store,
  overrides: Partial<TraceListQuery> = {},
  after: TraceCursor | null = null,
): number[] {
  return store
    .transaction((tx) => listTraces(tx, queryOf(overrides), after))
    .items.map((item) => Number.parseInt(item.trace_id, 16));
}

test("the default order is started_at descending and pages cover each trace once", (t) => {
  const store = seeded(t);
  assert.deepEqual(idsOf(store), [4, 5, 2, 3, 1]);
  const query = queryOf({ limit: PAGE_OF_TWO });
  const first = store.transaction((tx) => listTraces(tx, query, null));
  assert.ok(first.last);
  const second = store.transaction((tx) => listTraces(tx, query, first.last));
  assert.ok(second.last);
  const third = store.transaction((tx) => listTraces(tx, query, second.last));
  assert.equal(third.last, null);
  const numbers = [first, second, third].flatMap((page) =>
    page.items.map((item) => Number.parseInt(item.trace_id, 16)),
  );
  assert.deepEqual(numbers, [4, 5, 2, 3, 1]);
});

test("each sort orders by its value and an open trace sorts last by duration", (t) => {
  const store = seeded(t);
  assert.deepEqual(
    idsOf(store, { sort: TraceSort.DurationMs }),
    [3, 1, 2, 5, 4],
  );
  assert.deepEqual(
    idsOf(store, { sort: TraceSort.TotalTokens }),
    [2, 3, 1, 5, 4],
  );
  assert.deepEqual(idsOf(store, { sort: TraceSort.CostUsd }), [3, 1, 2, 5, 4]);
});

test("a cursor continues through equal sort values by rowid", (t) => {
  const store = seeded(t);
  const query = queryOf({ sort: TraceSort.DurationMs, limit: PAGE_OF_TWO });
  const first = store.transaction((tx) => listTraces(tx, query, null));
  const second = store.transaction((tx) => listTraces(tx, query, first.last));
  assert.deepEqual(
    second.items.map((item) => Number.parseInt(item.trace_id, 16)),
    [2, 5],
  );
  assert.equal(second.last?.value, OPEN_DURATION_VALUE);
  const third = store.transaction((tx) => listTraces(tx, query, second.last));
  assert.deepEqual(
    third.items.map((item) => Number.parseInt(item.trace_id, 16)),
    [4],
  );
  assert.equal(third.last, null);
});

test("a cursor of another sort is refused by assertion", (t) => {
  const store = seeded(t);
  assert.throws(() =>
    idsOf(
      store,
      { sort: TraceSort.CostUsd },
      {
        sort: TraceSort.StartedAt,
        value: 1,
        position: 1,
      },
    ),
  );
});

const FILTER_CASES: readonly (readonly [
  string,
  Partial<TraceListQuery>,
  number[],
])[] = [
  ["project_id", { project_id: PROJECT_A }, [1, 2, 5]],
  ["node_id", { node_id: `node_${ULID_HEAD}3` }, [3]],
  ["execution_id", { execution_id: `execution_${ULID_HEAD}2` }, [2]],
  ["worker_name", { worker_name: "w1" }, [1, 3]],
  ["state", { state: "error" }, [2]],
  ["agent_name", { agent_name: "coder" }, [1, 2]],
  ["agent_name member", { agent_name: "review" }, [2]],
  ["model", { model: "gpt-4" }, [1, 3]],
  ["error_type", { error_type: "rate_limited" }, [2]],
  ["q model case-insensitive", { q: "cLAUDE-3" }, [2]],
  ["q stop_reason", { q: "provider" }, [2]],
  ["q node_id", { q: "K14" }, [4]],
  ["q worker_name", { q: "W3" }, [4]],
  ["q trace_id", { q: "0003" }, [3]],
  ["q error_types", { q: "RATE_" }, [2]],
  ["from keeps a trace that ends at it", { from: 2000 }, [1, 2, 3, 4, 5]],
  ["from keeps a trace that started before it", { from: 2500 }, [2, 3, 4, 5]],
  [
    "from keeps an open trace that started before it",
    { from: 4500 },
    [3, 4, 5],
  ],
  ["from drops a trace that ended before it", { from: 3501 }, [3, 4, 5]],
  ["to keeps a trace that starts at it", { to: 2000 }, [1, 3]],
  ["to drops a trace that starts after it", { to: 3500 }, [1, 2, 3]],
  ["from and to bound the window", { from: 2500, to: 3200 }, [2, 3]],
  ["min_duration_ms", { min_duration_ms: 1000 }, [1, 3]],
  ["max_duration_ms", { max_duration_ms: 1000 }, [1, 2]],
  ["min_total_tokens", { min_total_tokens: 20 }, [2, 3]],
  ["max_total_tokens", { max_total_tokens: 15 }, [1, 4, 5]],
  ["min_cost_usd", { min_cost_usd: 0.5 }, [1, 3]],
  ["max_cost_usd", { max_cost_usd: 0.1 }, [2, 4, 5]],
  ["combined", { project_id: PROJECT_A, state: "ok", model: "gpt-4" }, [1]],
];

for (const [name, overrides, expected] of FILTER_CASES)
  test(`the ${name} filter keeps exactly the matching traces`, (t) => {
    const store = seeded(t);
    assert.deepEqual(idsOf(store, overrides).sort(), expected);
  });

test("the input schema refuses started_from and started_to", () => {
  const { query } = trackingOperations.traceList.input.shape;
  assert.ok(query.safeParse({ from: "1", to: "2" }).success);
  assert.ok(!query.safeParse({ started_from: "1" }).success);
  assert.ok(!query.safeParse({ started_to: "1" }).success);
});

test("a duration bound excludes an open trace", (t) => {
  const store = seeded(t);
  assert.ok(!idsOf(store, { min_duration_ms: 0 }).includes(4));
  assert.ok(!idsOf(store, { max_duration_ms: 1e9 }).includes(4));
  assert.ok(!idsOf(store, { max_duration_ms: 1e9 }).includes(5));
});

test("a query value is data and never SQL", (t) => {
  const store = seeded(t);
  const hostile = "'; DROP TABLE tracking_trace; --";
  assert.equal(idsOf(store, { q: hostile }).length, NO_ROWS);
  assert.equal(idsOf(store, { worker_name: hostile }).length, NO_ROWS);
  assert.equal(idsOf(store, { model: hostile }).length, NO_ROWS);
  assert.equal(idsOf(store).length, FIXTURES.length);
});

test("facets answer sorted distinct values and the project filter limits them", (t) => {
  const store = seeded(t);
  assert.deepEqual(
    store.transaction((tx) => readFacets(tx, undefined)),
    {
      worker_names: ["w1", "w2", "w3"],
      agent_names: ["coder", "plan", "review"],
      models: ["Claude-3", "gpt-4"],
      error_types: ["rate_limited"],
      cause_categories: [],
    },
  );
  assert.deepEqual(
    store.transaction((tx) => readFacets(tx, PROJECT_B)),
    {
      worker_names: ["w1", "w3"],
      agent_names: ["plan"],
      models: ["gpt-4"],
      error_types: [],
      cause_categories: [],
    },
  );
});

test("a facet answers at most the facet value limit", (t) => {
  const store = seeded(t);
  for (let n = 10; n < 10 + MANY_WORKERS; n += 1)
    insert(store, { ...BASE, n, worker: `bulk-${String(n).padStart(4, "0")}` });
  const facets = store.transaction((tx) => readFacets(tx, undefined));
  assert.equal(facets.worker_names.length, FACET_VALUES_MAX);
  assert.deepEqual(facets.worker_names, [...facets.worker_names].sort());
});

const SERVER_TRACE_NUMBER = 6;
const SERVER_CREATED = 5000;

function insertServerTrace(store: Store): void {
  store.transaction((tx) => {
    tx.database
      .prepare(
        "INSERT INTO tracking_trace (trace_id, project_id, root_span_id, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        traceIdOf(SERVER_TRACE_NUMBER),
        PROJECT_A,
        SERVER_TRACE_NUMBER.toString(16).padStart(16, "0"),
        SERVER_CREATED,
      );
  });
}

test("a server trace lists with a null execution, node and attempt and a filter by execution excludes it", (t) => {
  const store = seeded(t);
  insertServerTrace(store);
  const page = store.transaction((tx) =>
    listTraces(tx, queryOf({ project_id: PROJECT_A }), null),
  );
  const item = page.items.find(
    (entry) => entry.trace_id === traceIdOf(SERVER_TRACE_NUMBER),
  );
  assert.ok(item);
  assert.equal(item.execution_id, null);
  assert.equal(item.node_id, null);
  assert.equal(item.attempt, null);
  assert.equal(item.project_id, PROJECT_A);
  assert.deepEqual(
    idsOf(store, {
      execution_id: `execution_${ULID_HEAD}1`,
    }),
    [1],
  );
  assert.equal(
    idsOf(store, { execution_id: `execution_${ULID_HEAD}2` }).includes(
      SERVER_TRACE_NUMBER,
    ),
    false,
  );
});

const ROOT_OPERATION = "kanthord.execution";
const ROOT_ATTRIBUTES = {
  "kanthord.execution.kind": "steps",
  "kanthord.attempt": 1,
};
const CHILD_SPAN_ID = "f".repeat(16);

function insertSpanOf(
  store: Store,
  n: number,
  spanId: string,
  parentSpanId: string | null,
  operation: string,
  attributes: Record<string, string | number>,
): void {
  store.transaction((tx) =>
    insertSpan(tx, {
      trace_id: traceIdOf(n),
      span_id: spanId,
      parent_span_id: parentSpanId,
      producer: "server",
      origin: SpanOrigin.Observed,
      operation,
      start_time: 1000,
      end_time: null,
      status: SpanStatus.Unset,
      attributes,
      events: [],
      links: [],
      text_ids: [],
      created_at: 1000,
    }),
  );
}

test("each item answers the operation and the attributes of its root span, or null before the root span is stored", (t) => {
  const store = seeded(t);
  insertSpanOf(
    store,
    1,
    rootSpanIdOf(1),
    null,
    ROOT_OPERATION,
    ROOT_ATTRIBUTES,
  );
  insertSpanOf(store, 2, CHILD_SPAN_ID, rootSpanIdOf(2), "agent.turn", {
    "gen_ai.request.model": "gpt-4",
  });
  const items = store.transaction((tx) =>
    listTraces(tx, queryOf(), null),
  ).items;
  const byNumber = new Map(
    items.map((item) => [Number.parseInt(item.trace_id, 16), item]),
  );
  assert.equal(byNumber.get(1)?.root_operation, ROOT_OPERATION);
  assert.deepEqual(byNumber.get(1)?.root_attributes, ROOT_ATTRIBUTES);
  assert.equal(byNumber.get(2)?.root_operation, null);
  assert.equal(byNumber.get(2)?.root_attributes, null);
  assert.deepEqual(idsOf(store), [4, 5, 2, 3, 1]);
  assert.doesNotThrow(() =>
    trackingOperations.traceList.output.parse({ items, next_cursor: null }),
  );
});

const MODEL_CAUSE = {
  "kanthord.cause.category": "model",
  "kanthord.cause.subcategory": "no_progress",
  "kanthord.cause.assigner": "rule",
};
const PLAN_CAUSE = {
  "kanthord.cause.category": "plan",
  "kanthord.cause.subcategory": "oversized",
  "kanthord.cause.assigner": "rule",
};
const LABEL_CAUSE = {
  "kanthord.cause.category": "prompt",
  "kanthord.cause.subcategory": "context_missing",
};

function insertCauses(store: Store): void {
  insertSpanOf(store, 1, rootSpanIdOf(1), null, ROOT_OPERATION, MODEL_CAUSE);
  insertSpanOf(store, 2, rootSpanIdOf(2), null, ROOT_OPERATION, PLAN_CAUSE);
  insertSpanOf(
    store,
    2,
    causeLabelSpanId(rootSpanIdOf(2)),
    rootSpanIdOf(2),
    CAUSE_LABEL_OPERATION,
    LABEL_CAUSE,
  );
  insertSpanOf(
    store,
    3,
    rootSpanIdOf(3),
    null,
    ROOT_OPERATION,
    ROOT_ATTRIBUTES,
  );
}

test("an item answers the root cause, the label cause with the assigner human, or null", (t) => {
  const store = seeded(t);
  insertCauses(store);
  const items = store.transaction((tx) =>
    listTraces(tx, queryOf(), null),
  ).items;
  const causeOf = (n: number) =>
    items.find((item) => Number.parseInt(item.trace_id, 16) === n)?.cause;
  assert.deepEqual(causeOf(1), {
    category: "model",
    subcategory: "no_progress",
    assigner: "rule",
  });
  assert.deepEqual(causeOf(2), {
    category: "prompt",
    subcategory: "context_missing",
    assigner: "human",
  });
  assert.equal(causeOf(3), null);
  assert.equal(causeOf(4), null);
  assert.doesNotThrow(() =>
    trackingOperations.traceList.output.parse({ items, next_cursor: null }),
  );
});

test("cause_category selects by the label over the root cause", (t) => {
  const store = seeded(t);
  insertCauses(store);
  assert.deepEqual(idsOf(store, { cause_category: "model" }), [1]);
  assert.deepEqual(idsOf(store, { cause_category: "prompt" }), [2]);
  assert.deepEqual(idsOf(store, { cause_category: "plan" }), []);
  assert.deepEqual(idsOf(store, { cause_category: "human" }), []);
});

test("the facets answer the categories of the effective causes, the label category included", (t) => {
  const store = seeded(t);
  insertCauses(store);
  assert.deepEqual(
    store.transaction((tx) => readFacets(tx, undefined)).cause_categories,
    ["model", "prompt"],
  );
  assert.deepEqual(
    store.transaction((tx) => readFacets(tx, PROJECT_B)).cause_categories,
    [],
  );
  assert.deepEqual(
    store.transaction((tx) => readFacets(tx, PROJECT_A)).cause_categories,
    ["model", "prompt"],
  );
});

const LABEL_USERNAME = "account_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const LABEL_TIME = 7000;
const SPAN_PAGE = 10;

test("after a label the list item answers the label cause and the span list answers the label span", (t) => {
  const store = seeded(t);
  insertSpanOf(store, 1, rootSpanIdOf(1), null, ROOT_OPERATION, MODEL_CAUSE);
  store.transaction((tx) =>
    writeCauseLabel(
      tx,
      traceIdOf(1),
      {
        category: "prompt",
        subcategory: "context_missing",
        reason: "The prompt lacked the build command.",
      },
      LABEL_USERNAME,
      LABEL_TIME,
    ),
  );
  const item = store
    .transaction((tx) => listTraces(tx, queryOf(), null))
    .items.find((candidate) => candidate.trace_id === traceIdOf(1));
  assert.deepEqual(item?.cause, {
    category: "prompt",
    subcategory: "context_missing",
    assigner: "human",
  });
  assert.deepEqual(idsOf(store, { cause_category: "prompt" }), [1]);
  assert.deepEqual(idsOf(store, { cause_category: "model" }), []);
  const service = new TrackingService({
    store,
    retentionDays: 30,
    executions: { traceOf: () => undefined },
  });
  const caller: CallerContext = {
    identity: {
      kind: IdentityKind.Human,
      accountId: LABEL_USERNAME,
      name: "Ulrich",
      jti: "jti",
    },
    context: background,
    requestId: "request",
    commit: (write) => store.transaction(write),
  };
  const spans = service.spanList(
    traceIdOf(1),
    { limit: SPAN_PAGE },
    caller,
  ).items;
  const label = spans.find(
    (span) => span.span_id === causeLabelSpanId(rootSpanIdOf(1)),
  );
  assert.equal(label?.operation, CAUSE_LABEL_OPERATION);
  assert.equal(label?.producer, TRACKING_PRODUCER);
});
