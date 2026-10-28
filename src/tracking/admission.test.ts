import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { IN_MEMORY_DATABASE, Store } from "../kernel/store.ts";
import { type Admission, admitRecords, admitServerSpan } from "./admission.ts";
import {
  Disposition,
  RecordKind,
  RefusalReason,
  type SessionEntryRecord,
  SpanOrigin,
  SpanStatus,
  type TelemetryRecord,
  telemetryRecordSchema,
  TRACKING_SERVICE_NAME,
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
const ENTRY = "e1";
const UUID_ENTRY = "0f8fad5b-d9cb-469f-a165-70867728950e";
const FIRST_SEQUENCE = 1;
const ENTRY_TIME = 1500;

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

function entryRecord(
  overrides: Partial<SessionEntryRecord> = {},
): SessionEntryRecord {
  return {
    record_id: `${SPAN}:entry.${ENTRY}`,
    trace_id: TRACE,
    kind: RecordKind.SessionEntry,
    session_id: SPAN,
    entry_id: ENTRY,
    parent_entry_id: null,
    sequence: FIRST_SEQUENCE,
    entry_type: "message",
    entry_time: ENTRY_TIME,
    tool_call_id: "call_1",
    truncated: true,
    entry: { role: "user", content: [{ text: "hello", type: "text" }] },
    ...overrides,
  };
}

function entryRows(store: Store) {
  return store.database
    .prepare("SELECT * FROM tracking_session_entry ORDER BY sequence")
    .all();
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

test("a session entry is stored with every field", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [entryRecord()]);
  assert.equal(answer.dispositions[0]?.disposition, Disposition.Stored);
  assert.deepEqual(
    entryRows(store).map((row) => ({ ...row })),
    [
      {
        trace_id: TRACE,
        session_id: SPAN,
        entry_id: ENTRY,
        parent_entry_id: null,
        sequence: FIRST_SEQUENCE,
        entry_type: "message",
        entry_time: ENTRY_TIME,
        tool_call_id: "call_1",
        truncated: 1,
        content: '{"content":[{"text":"hello","type":"text"}],"role":"user"}',
        created_at: STARTED,
      },
    ],
  );
  const record = store.database
    .prepare("SELECT kind, target_id FROM tracking_record")
    .get();
  assert.equal(record?.kind, RecordKind.SessionEntry);
  assert.equal(record?.target_id, `${SPAN}:entry.${ENTRY}`);
});

test("a repeat of a session entry is stored and adds no row", (t) => {
  const store = trackingStore(t);
  admit(store, [entryRecord()]);
  const answer = admit(store, [entryRecord()]);
  assert.equal(answer.dispositions[0]?.disposition, Disposition.Stored);
  assert.equal(entryRows(store).length, ONE_RECORD);
});

test("a new session entry at a taken sequence is refused", (t) => {
  const store = trackingStore(t);
  admit(store, [entryRecord()]);
  const answer = admit(store, [
    entryRecord({ record_id: `${SPAN}:entry.e2`, entry_id: "e2" }),
  ]);
  assert.equal(answer.dispositions[0]?.disposition, Disposition.Refused);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.ValueReplaced);
  assert.equal(entryRows(store).length, ONE_RECORD);
});

test("a session entry is stored when its session span is absent", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [entryRecord()]);
  assert.equal(answer.stored, ONE_RECORD);
  assert.equal(
    store.transaction((tx) => readSpan(tx, TRACE, SPAN)),
    null,
  );
});

test("a session entry larger than the record bound is refused", (t) => {
  const store = trackingStore(t);
  const answer = admit(store, [
    entryRecord({ entry: { text: "x".repeat(70000) } }),
  ]);
  assert.equal(answer.dispositions[0]?.reason, RefusalReason.RecordTooLarge);
  assert.equal(entryRows(store).length, NO_RECORD);
});

test("the record schema refuses a session entry whose record identity differs", () => {
  const result = telemetryRecordSchema.safeParse(
    entryRecord({ record_id: `${SPAN}:entry.other` }),
  );
  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ["record_id"]);
});

test("the record schema admits a UUID entry identity", () => {
  const result = telemetryRecordSchema.safeParse(
    entryRecord({
      record_id: `${SPAN}:entry.${UUID_ENTRY}`,
      entry_id: UUID_ENTRY,
      parent_entry_id: UUID_ENTRY,
    }),
  );
  assert.equal(result.success, true);
});

test("a server contribution whose text identity exists is refused and stores neither its span nor its texts", (t) => {
  const store = trackingStore(t);
  admit(store, [
    {
      record_id: `${SPAN}:output`,
      trace_id: TRACE,
      kind: RecordKind.Text,
      text_id: `${SPAN}:output`,
      text: TEXT_CONTENT,
    },
  ]);
  let reason: RefusalReason | null = null;
  assert.throws(() =>
    store.transaction((tx) => {
      reason = admitServerSpan(tx, admission(), {
        record_id: `${SPAN}:start`,
        span_id: SPAN,
        parent_span_id: ROOT,
        operation: "agent.tool",
        start_time: STARTED,
        text_ids: [`${SPAN}:fresh`, `${SPAN}:output`],
        texts: [
          { text_id: `${SPAN}:fresh`, text: "fresh" },
          { text_id: `${SPAN}:output`, text: "changed" },
        ],
      });
      if (reason !== null) throw new Error(reason);
    }),
  );
  assert.equal(reason, RefusalReason.TextExists);
  assert.equal(
    store.transaction((tx) => readSpan(tx, TRACE, SPAN)),
    null,
  );
  assert.equal(
    store.transaction((tx) => readText(tx, TRACE, `${SPAN}:fresh`)),
    null,
  );
  assert.equal(
    store.transaction((tx) => readText(tx, TRACE, `${SPAN}:output`))?.content,
    TEXT_CONTENT,
  );
});
