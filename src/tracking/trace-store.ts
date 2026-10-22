import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  spanSchema,
  type ExecutionTrace,
  type RecordKind,
  type SessionEntryRecord,
  type Span,
  type TraceRecord,
} from "./contract.ts";

const ONE_ROW = 1;
const EMPTY_PAGE = 0;

export interface TextRow {
  trace_id: string;
  text_id: string;
  content: string;
  created_at: number;
}
export interface SpanPage {
  items: Span[];
  last: number | null;
}

export function insertTrace(
  tx: Transaction,
  trace: ExecutionTrace,
  now: number,
): void {
  assert.ok(trace.trace_id);
  assert.ok(trace.root_span_id);
  tx.database
    .prepare(
      "INSERT INTO tracking_trace (trace_id, project_id, execution_id, root_span_id, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (trace_id) DO NOTHING",
    )
    .run(
      trace.trace_id,
      trace.project_id,
      trace.execution_id,
      trace.root_span_id,
      now,
    );
}

export function readTrace(
  tx: Transaction,
  traceId: string,
): TraceRecord | null {
  assert.ok(traceId);
  const row = tx.database
    .prepare(
      "SELECT trace_id, project_id, execution_id, root_span_id, created_at FROM tracking_trace WHERE trace_id = ?",
    )
    .get(traceId);
  if (!row) return null;
  assert.equal(row.trace_id, traceId);
  return {
    trace_id: String(row.trace_id),
    project_id: row.project_id === null ? null : String(row.project_id),
    execution_id: row.execution_id === null ? null : String(row.execution_id),
    root_span_id: String(row.root_span_id),
    created_at: Number(row.created_at),
  };
}

export function countRecords(tx: Transaction, traceId: string): number {
  assert.ok(traceId);
  const row = tx.database
    .prepare("SELECT COUNT(*) AS count FROM tracking_record WHERE trace_id = ?")
    .get(traceId);
  assert.ok(row);
  return Number(row.count);
}

export function recordExists(
  tx: Transaction,
  traceId: string,
  recordId: string,
): boolean {
  assert.ok(traceId);
  assert.ok(recordId);
  return (
    tx.database
      .prepare(
        "SELECT 1 FROM tracking_record WHERE trace_id = ? AND record_id = ?",
      )
      .get(traceId, recordId) !== undefined
  );
}

export function insertRecord(
  tx: Transaction,
  record: {
    trace_id: string;
    record_id: string;
    kind: RecordKind;
    target_id: string;
  },
  now: number,
): void {
  assert.ok(record.record_id);
  assert.ok(record.target_id);
  tx.database
    .prepare(
      "INSERT INTO tracking_record (trace_id, record_id, kind, target_id, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(record.trace_id, record.record_id, record.kind, record.target_id, now);
}

function spanOf(row: Record<string, unknown>): Span {
  assert.ok(row.trace_id);
  assert.ok(row.span_id);
  return spanSchema.parse({
    trace_id: row.trace_id,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    producer: row.producer,
    origin: row.origin,
    operation: row.operation,
    start_time: row.start_time === null ? null : Number(row.start_time),
    end_time: row.end_time === null ? null : Number(row.end_time),
    status: row.status,
    attributes: JSON.parse(String(row.attributes)),
    events: JSON.parse(String(row.events)),
    links: JSON.parse(String(row.links)),
    text_ids: JSON.parse(String(row.text_ids)),
    created_at: Number(row.created_at),
  });
}

const SPAN_COLUMNS =
  "trace_id, span_id, parent_span_id, producer, origin, operation, start_time, end_time, status, attributes, events, links, text_ids, created_at";

export function readSpan(
  tx: Transaction,
  traceId: string,
  spanId: string,
): Span | null {
  assert.ok(traceId);
  assert.ok(spanId);
  const row = tx.database
    .prepare(
      `SELECT ${SPAN_COLUMNS} FROM tracking_span WHERE trace_id = ? AND span_id = ?`,
    )
    .get(traceId, spanId);
  return row ? spanOf(row) : null;
}

export function insertSpan(tx: Transaction, span: Span): void {
  assert.ok(span.producer);
  assert.ok(span.start_time !== null || span.end_time !== null);
  tx.database
    .prepare(
      `INSERT INTO tracking_span (${SPAN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      span.trace_id,
      span.span_id,
      span.parent_span_id,
      span.producer,
      span.origin,
      span.operation,
      span.start_time,
      span.end_time,
      span.status,
      JSON.stringify(span.attributes),
      JSON.stringify(span.events),
      JSON.stringify(span.links),
      JSON.stringify(span.text_ids),
      span.created_at,
    );
}

export function updateSpan(tx: Transaction, span: Span): void {
  assert.ok(span.producer);
  assert.ok(span.start_time !== null || span.end_time !== null);
  const result = tx.database
    .prepare(
      "UPDATE tracking_span SET start_time = ?, end_time = ?, status = ?, attributes = ?, events = ?, links = ?, text_ids = ? WHERE trace_id = ? AND span_id = ?",
    )
    .run(
      span.start_time,
      span.end_time,
      span.status,
      JSON.stringify(span.attributes),
      JSON.stringify(span.events),
      JSON.stringify(span.links),
      JSON.stringify(span.text_ids),
      span.trace_id,
      span.span_id,
    );
  assert.equal(Number(result.changes), ONE_ROW, "updateSpan: span is absent");
}

export function listSpans(
  tx: Transaction,
  traceId: string,
  after: number,
  limit: number,
): SpanPage {
  assert.ok(traceId);
  assert.ok(Number.isSafeInteger(limit) && limit > EMPTY_PAGE);
  const rows = tx.database
    .prepare(
      `SELECT rowid AS position, ${SPAN_COLUMNS} FROM tracking_span WHERE trace_id = ? AND rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .all(traceId, after, limit + 1);
  const page = rows.slice(0, limit);
  const lastRow = page.at(-1);
  return {
    items: page.map(spanOf),
    last:
      rows.length > limit && lastRow !== undefined
        ? Number(lastRow.position)
        : null,
  };
}

export function readText(
  tx: Transaction,
  traceId: string,
  textId: string,
): TextRow | null {
  assert.ok(traceId);
  assert.ok(textId);
  const row = tx.database
    .prepare(
      "SELECT trace_id, text_id, content, created_at FROM tracking_telemetry_text WHERE trace_id = ? AND text_id = ?",
    )
    .get(traceId, textId);
  if (!row) return null;
  return {
    trace_id: String(row.trace_id),
    text_id: String(row.text_id),
    content: String(row.content),
    created_at: Number(row.created_at),
  };
}

export function insertText(
  tx: Transaction,
  text: { trace_id: string; text_id: string; content: string },
  now: number,
): void {
  assert.ok(text.trace_id);
  assert.ok(text.text_id);
  tx.database
    .prepare(
      "INSERT INTO tracking_telemetry_text (trace_id, text_id, content, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(text.trace_id, text.text_id, text.content, now);
}

export function sessionSequenceTaken(
  tx: Transaction,
  traceId: string,
  sessionId: string,
  sequence: number,
): boolean {
  assert.ok(traceId);
  assert.ok(sessionId);
  return (
    tx.database
      .prepare(
        "SELECT 1 FROM tracking_session_entry WHERE trace_id = ? AND session_id = ? AND sequence = ?",
      )
      .get(traceId, sessionId, sequence) !== undefined
  );
}

export function insertSessionEntry(
  tx: Transaction,
  entry: SessionEntryRecord,
  now: number,
): void {
  assert.ok(entry.session_id);
  assert.ok(entry.entry_id);
  tx.database
    .prepare(
      "INSERT INTO tracking_session_entry (trace_id, session_id, entry_id, parent_entry_id, sequence, entry_type, entry_time, tool_call_id, truncated, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      entry.trace_id,
      entry.session_id,
      entry.entry_id,
      entry.parent_entry_id,
      entry.sequence,
      entry.entry_type,
      entry.entry_time,
      entry.tool_call_id,
      entry.truncated ? 1 : 0,
      canonicalJSON(entry.entry),
      now,
    );
}
