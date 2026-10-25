import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { admitRecords, admitServerSpan, type Admission } from "./admission.ts";
import {
  Disposition,
  RecordKind,
  SpanOrigin,
  SpanStatus,
  type SpanContribution,
  TRACKING_SERVICE_NAME,
  TraceState,
  traceSummarySchema,
  type ExecutionTrace,
  type TelemetryRecord,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { insertTrace, readTrace } from "./trace-store.ts";

const TRACE: ExecutionTrace = {
  trace_id: "a".repeat(32),
  root_span_id: "1".repeat(16),
  execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
  project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
  node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
  attempt: 2,
};
const FIRST = "2".repeat(16);
const SECOND = "3".repeat(16);
const THIRD = "4".repeat(16);
const PRODUCER = "worker_registration_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const OTHER_PRODUCER = "worker_registration_01JZ8R2B3C4D5E6F7G8H9J0K1N";
const SCHEDULER = "scheduler";
const STARTED = 1000;
const ENDED = 4500;
const DURATION = 3500;
const STOP_REASON = "provider_failed";
const AGENT = "coder";
const NO_COUNT = 0;
const ONE_SPAN = 1;
const TWO_SPANS = 2;
const THREE_SPANS = 3;
const FOUR_SPANS = 4;
const SUMMARY_TOTALS = 10;
const NAME_LIMIT = 128;
const FIRST_SEQUENCE = 1;
const FIRST_INPUT = 100;
const SECOND_INPUT = 50;
const FIRST_OUTPUT = 10;
const SECOND_OUTPUT = 5;
const CACHE_READ = 7;
const CACHE_CREATION = 3;
const FIRST_COST = 0.25;
const SECOND_COST = 0.5;
const FIRST_WORKER = "worker-one";
const SECOND_WORKER = "worker-two";
const FIRST_AGENT = "agent-0";

function trackingStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  store.transaction((tx) => insertTrace(tx, TRACE, STARTED));
  return store;
}

function admission(producer: string): Admission {
  return {
    trace: TRACE,
    producer,
    origin: SpanOrigin.Observed,
    now: STARTED,
  };
}

function summary(store: Store) {
  const answer = store.transaction((tx) => readTrace(tx, TRACE.trace_id));
  assert.ok(answer);
  return answer;
}

function admitRoot(store: Store, contribution: Partial<SpanContribution>) {
  return store.transaction((tx) =>
    admitServerSpan(tx, admission(SCHEDULER), {
      record_id: `${TRACE.root_span_id}:${contribution.start_time ?? "end"}`,
      span_id: TRACE.root_span_id,
      parent_span_id: null,
      operation: "scheduler.execution",
      ...contribution,
    }),
  );
}

function spanRecord(
  record_id: string,
  span_id: string,
  overrides: Record<string, unknown> = {},
): TelemetryRecord {
  return Object.fromEntries(
    Object.entries({
      record_id,
      trace_id: TRACE.trace_id,
      kind: RecordKind.Span,
      span_id,
      operation: "agent.turn",
      parent_span_id: TRACE.root_span_id,
      start_time: STARTED,
      ...overrides,
    }).filter(([, value]) => value !== undefined),
  ) as TelemetryRecord;
}

function admit(store: Store, records: TelemetryRecord[], producer = PRODUCER) {
  return store.transaction((tx) =>
    admitRecords(tx, admission(producer), records),
  );
}

test("a new trace answers an open summary with no totals", (t) => {
  const store = trackingStore(t);
  const answer = summary(store);
  assert.doesNotThrow(() => traceSummarySchema.parse(answer));
  assert.equal(answer.state, TraceState.Open);
  assert.equal(answer.node_id, TRACE.node_id);
  assert.equal(answer.attempt, TRACE.attempt);
  assert.equal(answer.duration_ms, null);
  assert.deepEqual(
    [answer.agent_names, answer.models, answer.error_types],
    [[], [], []],
  );
  assert.deepEqual(
    [
      answer.input_tokens,
      answer.output_tokens,
      answer.cache_read_tokens,
      answer.cache_creation_tokens,
      answer.total_tokens,
      answer.cost_usd,
      answer.span_count,
      answer.turn_count,
      answer.tool_count,
      answer.error_count,
    ],
    new Array(SUMMARY_TOTALS).fill(NO_COUNT),
  );
});

test("the root span start and end set the state, the times and the stop reason", (t) => {
  const store = trackingStore(t);
  admitRoot(store, { start_time: STARTED });
  const opened = summary(store);
  assert.equal(opened.started_at, STARTED);
  assert.equal(opened.state, TraceState.Open);
  assert.equal(opened.duration_ms, null);
  admitRoot(store, {
    end_time: ENDED,
    status: SpanStatus.Error,
    attributes: { "kanthord.stop.reason": STOP_REASON },
  });
  const ended = summary(store);
  assert.equal(ended.ended_at, ENDED);
  assert.equal(ended.state, TraceState.Error);
  assert.equal(ended.stop_reason, STOP_REASON);
  assert.equal(ended.duration_ms, DURATION);
  assert.equal(ended.span_count, ONE_SPAN);
  assert.equal(ended.error_count, ONE_SPAN);
  assert.equal(ended.first_error_span_id, null);
});

test("a root span end with a status other than Error ends the trace as ok", (t) => {
  const store = trackingStore(t);
  admitRoot(store, { start_time: STARTED });
  admitRoot(store, { end_time: ENDED, status: SpanStatus.Ok });
  assert.equal(summary(store).state, TraceState.Ok);
  assert.equal(summary(store).stop_reason, null);
});

test("the turn spans add their usage to the totals", (t) => {
  const store = trackingStore(t);
  admit(store, [
    spanRecord("2222222222222222:start", FIRST, {
      attributes: {
        "gen_ai.usage.input_tokens": FIRST_INPUT,
        "gen_ai.usage.output_tokens": FIRST_OUTPUT,
        "gen_ai.usage.cache_read.input_tokens": CACHE_READ,
        "gen_ai.usage.cache_creation.input_tokens": CACHE_CREATION,
        "kanthord.usage.cost_usd": FIRST_COST,
      },
    }),
    spanRecord("3333333333333333:start", SECOND, {
      attributes: {
        "gen_ai.usage.input_tokens": SECOND_INPUT,
        "gen_ai.usage.output_tokens": SECOND_OUTPUT,
        "kanthord.usage.cost_usd": SECOND_COST,
      },
    }),
  ]);
  const answer = summary(store);
  assert.equal(answer.input_tokens, FIRST_INPUT + SECOND_INPUT);
  assert.equal(answer.output_tokens, FIRST_OUTPUT + SECOND_OUTPUT);
  assert.equal(
    answer.total_tokens,
    FIRST_INPUT + SECOND_INPUT + FIRST_OUTPUT + SECOND_OUTPUT,
  );
  assert.equal(answer.cache_read_tokens, CACHE_READ);
  assert.equal(answer.cache_creation_tokens, CACHE_CREATION);
  assert.equal(answer.cost_usd, FIRST_COST + SECOND_COST);
  assert.equal(answer.turn_count, TWO_SPANS);
  assert.equal(answer.tool_count, NO_COUNT);
});

test("a start record and an end record of one span count it once", (t) => {
  const store = trackingStore(t);
  admit(store, [
    spanRecord("2222222222222222:start", FIRST, {
      operation: "agent.tool",
    }),
    spanRecord("2222222222222222:end", FIRST, {
      operation: "agent.tool",
      start_time: undefined,
      end_time: ENDED,
      status: SpanStatus.Ok,
    }),
  ]);
  const answer = summary(store);
  assert.equal(answer.span_count, ONE_SPAN);
  assert.equal(answer.tool_count, ONE_SPAN);
});

test("a usage value of a span counts once when a later record repeats the name", (t) => {
  const store = trackingStore(t);
  const usage = { "gen_ai.usage.input_tokens": FIRST_INPUT };
  admit(store, [
    spanRecord("2222222222222222:start", FIRST, { attributes: usage }),
    spanRecord("2222222222222222:end", FIRST, {
      start_time: undefined,
      end_time: ENDED,
      attributes: usage,
    }),
  ]);
  assert.equal(summary(store).input_tokens, FIRST_INPUT);
});

test("two spans with one agent name add one name", (t) => {
  const store = trackingStore(t);
  const attributes = {
    "kanthord.agent.name": AGENT,
    "gen_ai.request.model": "model-a",
    "gen_ai.response.model": "model-b",
    "kanthord.worker.name": FIRST_WORKER,
    "error.type": "rate_limited",
  };
  admit(store, [
    spanRecord("2222222222222222:start", FIRST, { attributes }),
    spanRecord("3333333333333333:start", SECOND, {
      attributes: { ...attributes, "kanthord.worker.name": SECOND_WORKER },
    }),
  ]);
  const answer = summary(store);
  assert.deepEqual(answer.agent_names, [AGENT]);
  assert.deepEqual(answer.models, ["model-a", "model-b"]);
  assert.deepEqual(answer.error_types, ["rate_limited"]);
  assert.equal(answer.worker_name, FIRST_WORKER);
});

test("a name array holds at most 128 values", (t) => {
  const store = trackingStore(t);
  const limit = NAME_LIMIT;
  admit(
    store,
    Array.from({ length: limit + TWO_SPANS }, (_, index) =>
      spanRecord(
        `${(index + 16).toString(16).padStart(16, "0")}:start`,
        (index + 16).toString(16).padStart(16, "0"),
        { attributes: { "kanthord.agent.name": `agent-${index}` } },
      ),
    ),
  );
  const answer = summary(store);
  assert.equal(answer.agent_names.length, limit);
  assert.equal(answer.agent_names[0], FIRST_AGENT);
});

test("the first error below the root sets first_error_span_id and a second one leaves it", (t) => {
  const store = trackingStore(t);
  admitRoot(store, { start_time: STARTED });
  admit(store, [
    spanRecord("2222222222222222:start", FIRST),
    spanRecord("2222222222222222:end", FIRST, {
      start_time: undefined,
      end_time: ENDED,
      status: SpanStatus.Error,
    }),
    spanRecord("3333333333333333:start", SECOND, {
      status: SpanStatus.Error,
    }),
    spanRecord("4444444444444444:start", THIRD),
  ]);
  const answer = summary(store);
  assert.equal(answer.first_error_span_id, FIRST);
  assert.equal(answer.error_count, TWO_SPANS);
  assert.equal(answer.span_count, FOUR_SPANS);
});

test("a recovered tool error and a stopped span never set first_error_span_id", (t) => {
  const store = trackingStore(t);
  admitRoot(store, { start_time: STARTED });
  admit(store, [
    spanRecord("2222222222222222:start", FIRST, {
      operation: "agent.tool",
      status: SpanStatus.Error,
      attributes: { "error.type": "tool_error" },
    }),
    spanRecord("3333333333333333:start", SECOND, {
      status: SpanStatus.Error,
      attributes: { "error.type": "stopped" },
    }),
  ]);
  const answer = summary(store);
  assert.equal(answer.first_error_span_id, null);
  assert.equal(answer.error_count, TWO_SPANS);
});

test("the first error skips a tool error and keeps a span with another or no error type", (t) => {
  const store = trackingStore(t);
  admitRoot(store, { start_time: STARTED });
  admit(store, [
    spanRecord("2222222222222222:start", FIRST, {
      operation: "agent.tool",
      status: SpanStatus.Error,
      attributes: { "error.type": "tool_error" },
    }),
    spanRecord("3333333333333333:start", SECOND, {
      operation: "worker.git",
      status: SpanStatus.Error,
    }),
    spanRecord("4444444444444444:start", THIRD, {
      status: SpanStatus.Error,
      attributes: { "error.type": "stopped" },
    }),
  ]);
  const answer = summary(store);
  assert.equal(answer.first_error_span_id, SECOND);
  assert.equal(answer.error_count, THREE_SPANS);
  assert.deepEqual(answer.error_types, ["tool_error", "stopped"]);
});

test("a refused record and a repeated record change nothing", (t) => {
  const store = trackingStore(t);
  const record = spanRecord("2222222222222222:start", FIRST, {
    attributes: { "gen_ai.usage.input_tokens": FIRST_INPUT },
  });
  admit(store, [record]);
  const before = summary(store);
  const repeated = admit(store, [record]);
  assert.equal(repeated.dispositions[0]?.disposition, Disposition.Stored);
  assert.deepEqual(summary(store), before);
  const refused = admit(
    store,
    [
      spanRecord("2222222222222222:other", FIRST, {
        start_time: undefined,
        end_time: ENDED,
        attributes: { "gen_ai.usage.input_tokens": FIRST_INPUT * TWO_SPANS },
      }),
    ],
    OTHER_PRODUCER,
  );
  assert.equal(refused.dispositions[0]?.disposition, Disposition.Refused);
  assert.deepEqual(summary(store), before);
});

test("a text record and a session entry record change nothing", (t) => {
  const store = trackingStore(t);
  const before = summary(store);
  admit(store, [
    {
      record_id: "2222222222222222:input",
      trace_id: TRACE.trace_id,
      kind: RecordKind.Text,
      text_id: "2222222222222222:input",
      text: "npm test",
    },
    {
      record_id: `${FIRST}:entry.e1`,
      trace_id: TRACE.trace_id,
      kind: RecordKind.SessionEntry,
      session_id: FIRST,
      entry_id: "e1",
      parent_entry_id: null,
      sequence: FIRST_SEQUENCE,
      entry_type: "message",
      entry_time: STARTED,
      tool_call_id: null,
      truncated: false,
      entry: {},
    },
  ]);
  assert.deepEqual(summary(store), before);
});
