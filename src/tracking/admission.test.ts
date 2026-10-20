import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { admitRecords, type Admission } from "./admission.ts";
import {
  Disposition,
  RecordKind,
  RefusalReason,
  SpanOrigin,
  SpanStatus,
  TRACKING_SERVICE_NAME,
  type TelemetryRecord,
} from "./contract.ts";
import { trackingMigrations } from "./migrations.ts";
import { insertTrace, readSpan, readText } from "./trace-store.ts";

const TRACE = "a".repeat(32);
const OTHER_TRACE = "b".repeat(32);
const ROOT = "1".repeat(16);
const SPAN = "2".repeat(16);
const PRODUCER = "worker_registration_01JZ8R2B3C4D5E6F7G8H9J0K1M";
const OTHER_PRODUCER = "worker_registration_01JZ8R2B3C4D5E6F7G8H9J0K1N";
const STARTED = 1000;
const ENDED = 2000;
const BOTH_RECORDS = 2;
const NO_RECORD = 0;
const ONE_RECORD = 1;
const TEXT_CONTENT = "Tests: 1 passed";

function trackingStore(t: TestContext): Store {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  store.transaction((tx) =>
    insertTrace(
      tx,
      {
        trace_id: TRACE,
        root_span_id: ROOT,
        execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
        project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
        node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
        attempt: 1,
      },
      STARTED,
    ),
  );
  return store;
}

function admission(producer = PRODUCER): Admission {
  return {
    trace: {
      trace_id: TRACE,
      root_span_id: ROOT,
      execution_id: "execution_01JZ8R2B3C4D5E6F7G8H9J0K1M",
      project_id: "project_01JZ8PZ0A1B2C3D4E5F6G7H8J9",
      node_id: "node_01JZ8Q0K4M6N8P0R2S4T6V8W0X",
      attempt: 1,
    },
    producer,
    origin: SpanOrigin.Observed,
    now: STARTED,
  };
}

function start(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    record_id: `${SPAN}:start`,
    trace_id: TRACE,
    kind: RecordKind.Span,
    span_id: SPAN,
    operation: "agent.tool",
    parent_span_id: ROOT,
    start_time: STARTED,
    attributes: { "gen_ai.tool.name": "bash" },
    ...overrides,
  } as TelemetryRecord;
}

function end(overrides: Partial<TelemetryRecord> = {}): TelemetryRecord {
  return {
    record_id: `${SPAN}:end`,
    trace_id: TRACE,
    kind: RecordKind.Span,
    span_id: SPAN,
    operation: "agent.tool",
    parent_span_id: ROOT,
    end_time: ENDED,
    status: SpanStatus.Ok,
    attributes: { "kanthord.tool.outcome": "ok" },
    text_ids: [`${SPAN}:output`],
    ...overrides,
  } as TelemetryRecord;
}

function admit(store: Store, records: TelemetryRecord[], producer = PRODUCER) {
  return store.transaction((tx) =>
    admitRecords(tx, admission(producer), records),
  );
}

test("a start and an end make one finished span", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [start(), end()]);
  assert.equal(answer.stored, BOTH_RECORDS);
  assert.equal(answer.refused, NO_RECORD);
  const span = store.transaction((tx) => readSpan(tx, TRACE, SPAN));
  assert.equal(span?.start_time, STARTED);
  assert.equal(span?.end_time, ENDED);
  assert.equal(span?.status, SpanStatus.Ok);
  assert.equal(span?.producer, PRODUCER);
  assert.deepEqual(span?.attributes, {
    "gen_ai.tool.name": "bash",
    "kanthord.tool.outcome": "ok",
  });
  assert.deepEqual(span?.text_ids, [`${SPAN}:output`]);
});

test("a start alone is a readable unfinished span", (t) => {
  const store = trackingStore(t);
  admit(store, [start()]);
  const span = store.transaction((tx) => readSpan(tx, TRACE, SPAN));
  assert.equal(span?.end_time, null);
  assert.equal(span?.status, SpanStatus.Unset);
});

test("an end before its start creates the span with no start time", (t) => {
  const store = trackingStore(t);
  admit(store, [end()]);
  const span = store.transaction((tx) => readSpan(tx, TRACE, SPAN));
  assert.equal(span?.start_time, null);
  admit(store, [start()]);
  const merged = store.transaction((tx) => readSpan(tx, TRACE, SPAN));
  assert.equal(merged?.start_time, STARTED);
});

test("a repeated record is Stored and changes nothing", (t) => {
  const store = trackingStore(t);
  admit(store, [start()]);
  const answer = admit(store, [start({ start_time: ENDED })]);
  assert.equal(answer.dispositions[0]?.disposition, Disposition.Stored);
  const span = store.transaction((tx) => readSpan(tx, TRACE, SPAN));
  assert.equal(span?.start_time, STARTED);
});

test("a second end with another record identity is refused", (t) => {
  const store = trackingStore(t);
  admit(store, [end()]);
  const answer = admit(store, [end({ record_id: `${SPAN}:end.again` })]);
  assert.equal(answer.dispositions[0]?.disposition, Disposition.Refused);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.ValueReplaced);
});

test("a record cannot replace an attribute value", (t) => {
  const store = trackingStore(t);
  admit(store, [start()]);
  const answer = admit(store, [
    end({ attributes: { "gen_ai.tool.name": "read" } }),
  ]);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.ValueReplaced);
});

test("a span names a parent other than itself", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [start({ parent_span_id: SPAN })]);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.SelfParent);
  assert.equal(
    store.transaction((tx) => readSpan(tx, TRACE, SPAN)),
    null,
  );
});

test("another producer cannot write a span that it did not create", (t) => {
  const store = trackingStore(t);
  admit(store, [start()]);
  const answer = admit(store, [end()], OTHER_PRODUCER);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.ForeignProducer);
});

test("a record of another trace is refused", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [start({ trace_id: OTHER_TRACE })]);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.TraceMismatch);
});

test("a text belongs to its trace and keeps its first content", (t) => {
  const store = trackingStore(t);
  const text: TelemetryRecord = {
    record_id: `${SPAN}:output`,
    trace_id: TRACE,
    kind: RecordKind.Text,
    text_id: `${SPAN}:output`,
    text: TEXT_CONTENT,
  };
  assert.equal(admit(store, [text]).stored, ONE_RECORD);
  const again = admit(store, [
    { ...text, record_id: `${SPAN}:output.again`, text: "changed" },
  ]);
  assert.equal(again.dispositions[0]?.reason, RefusalReason.TextExists);
  const row = store.transaction((tx) => readText(tx, TRACE, `${SPAN}:output`));
  assert.equal(row?.content, TEXT_CONTENT);
});

test("a record larger than the record bound is refused", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [
    {
      record_id: `${SPAN}:output`,
      trace_id: TRACE,
      kind: RecordKind.Text,
      text_id: `${SPAN}:output`,
      text: "x".repeat(70000),
    },
  ]);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.RecordTooLarge);
});
