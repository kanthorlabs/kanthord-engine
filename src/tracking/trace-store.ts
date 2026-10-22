import assert from "node:assert/strict";
import { z } from "zod";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  spanSchema,
  traceStateSchema,
  type ExecutionTrace,
  type RecordKind,
  type SessionEntryRecord,
  type Span,
  type TraceSummary,
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
      "INSERT INTO tracking_trace (trace_id, project_id, execution_id, root_span_id, created_at, node_id, attempt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (trace_id) DO NOTHING",
    )
    .run(
      trace.trace_id,
      trace.project_id,
      trace.execution_id,
      trace.root_span_id,
      now,
      trace.node_id,
      trace.attempt,
    );
}

export const TRACE_COLUMNS =
  "trace_id, project_id, execution_id, node_id, attempt, root_span_id, created_at, state, started_at, ended_at, stop_reason, worker_name, agent_names, models, error_types, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, span_count, turn_count, tool_count, error_count, first_error_span_id";
const stringList = z.array(z.string());

function textOrNull(value: unknown): string | null {
  return value === null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value === null ? null : Number(value);
}

export function traceSummaryOf(row: Record<string, unknown>): TraceSummary {
  const startedAt = numberOrNull(row.started_at);
  const endedAt = numberOrNull(row.ended_at);
  return {
    trace_id: String(row.trace_id),
    project_id: textOrNull(row.project_id),
    execution_id: textOrNull(row.execution_id),
    node_id: textOrNull(row.node_id),
    attempt: numberOrNull(row.attempt),
    root_span_id: String(row.root_span_id),
    created_at: Number(row.created_at),
    state: traceStateSchema.parse(row.state),
    started_at: startedAt,
    ended_at: endedAt,
    duration_ms:
      startedAt === null || endedAt === null ? null : endedAt - startedAt,
    stop_reason: textOrNull(row.stop_reason),
    worker_name: textOrNull(row.worker_name),
    agent_names: stringList.parse(JSON.parse(String(row.agent_names))),
    models: stringList.parse(JSON.parse(String(row.models))),
    error_types: stringList.parse(JSON.parse(String(row.error_types))),
    input_tokens: Number(row.input_tokens),
    output_tokens: Number(row.output_tokens),
    cache_read_tokens: Number(row.cache_read_tokens),
    cache_creation_tokens: Number(row.cache_creation_tokens),
    total_tokens: Number(row.input_tokens) + Number(row.output_tokens),
    cost_usd: Number(row.cost_usd),
    span_count: Number(row.span_count),
    turn_count: Number(row.turn_count),
    tool_count: Number(row.tool_count),
    error_count: Number(row.error_count),
    first_error_span_id: textOrNull(row.first_error_span_id),
  };
}

export function readTrace(
  tx: Transaction,
  traceId: string,
): TraceSummary | null {
  assert.ok(traceId);
  const row = tx.database
    .prepare(`SELECT ${TRACE_COLUMNS} FROM tracking_trace WHERE trace_id = ?`)
    .get(traceId);
  if (!row) return null;
  assert.equal(row.trace_id, traceId);
  return traceSummaryOf(row);
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
