import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  Disposition,
  EXECUTION_RECORD_LIMIT,
  RecordKind,
  RefusalReason,
  SpanStatus,
  TELEMETRY_RECORD_MAX_BYTES,
  TELEMETRY_WRITE_RECORDS_MAX,
  type Acknowledgement,
  type Attributes,
  type ExecutionTrace,
  type RecordDisposition,
  type Span,
  type SpanEvent,
  type SpanLink,
  type SpanOrigin,
  type SpanStatus as SpanStatusValue,
  type TelemetryRecord,
  type TextRecord,
} from "./contract.ts";
import {
  countRecords,
  insertRecord,
  insertSpan,
  insertText,
  readSpan,
  readText,
  recordExists,
  updateSpan,
} from "./trace-store.ts";

export interface Admission {
  trace: ExecutionTrace;
  producer: string;
  origin: SpanOrigin;
  now: number;
}
export interface SpanContribution {
  record_id: string;
  span_id: string;
  parent_span_id: string | null;
  operation: string;
  start_time?: number;
  end_time?: number;
  status?: SpanStatusValue;
  attributes?: Attributes;
  events?: SpanEvent[];
  links?: SpanLink[];
  text_ids?: string[];
}
interface Outcome {
  disposition: Disposition;
  reason: RefusalReason | null;
  inserted: boolean;
}

const STORED: Outcome = {
  disposition: Disposition.Stored,
  reason: null,
  inserted: true,
};
const REPEATED: Outcome = {
  disposition: Disposition.Stored,
  reason: null,
  inserted: false,
};
function refused(reason: RefusalReason): Outcome {
  return { disposition: Disposition.Refused, reason, inserted: false };
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonicalJSON(left) === canonicalJSON(right);
}

function replacesAttribute(existing: Attributes, added: Attributes): boolean {
  assert.ok(existing);
  assert.ok(added);
  return Object.entries(added).some(
    ([name, value]) =>
      Object.hasOwn(existing, name) && !sameValue(existing[name], value),
  );
}

function replacesScalar(existing: Span, added: SpanContribution): boolean {
  assert.equal(existing.span_id, added.span_id);
  assert.ok(existing.operation);
  return (
    existing.operation !== added.operation ||
    existing.parent_span_id !== added.parent_span_id ||
    (existing.start_time !== null && added.start_time !== undefined) ||
    (existing.end_time !== null && added.end_time !== undefined) ||
    (existing.status !== SpanStatus.Unset &&
      added.status !== undefined &&
      existing.status !== added.status)
  );
}

export function mergeSpan(
  existing: Span,
  added: SpanContribution,
): Span | null {
  assert.equal(existing.span_id, added.span_id);
  assert.ok(added.record_id);
  if (replacesScalar(existing, added)) return null;
  if (replacesAttribute(existing.attributes, added.attributes ?? {}))
    return null;
  return {
    ...existing,
    start_time: existing.start_time ?? added.start_time ?? null,
    end_time: existing.end_time ?? added.end_time ?? null,
    status: added.status ?? existing.status,
    attributes: { ...existing.attributes, ...added.attributes },
    events: [...existing.events, ...(added.events ?? [])],
    links: [...existing.links, ...(added.links ?? [])],
    text_ids: [...new Set([...existing.text_ids, ...(added.text_ids ?? [])])],
  };
}

function newSpan(admission: Admission, added: SpanContribution): Span {
  assert.ok(added.start_time !== undefined || added.end_time !== undefined);
  assert.ok(admission.producer);
  return {
    trace_id: admission.trace.trace_id,
    span_id: added.span_id,
    parent_span_id: added.parent_span_id,
    producer: admission.producer,
    origin: admission.origin,
    operation: added.operation,
    start_time: added.start_time ?? null,
    end_time: added.end_time ?? null,
    status: added.status ?? SpanStatus.Unset,
    attributes: added.attributes ?? {},
    events: added.events ?? [],
    links: added.links ?? [],
    text_ids: [...new Set(added.text_ids ?? [])],
    created_at: admission.now,
  };
}

export function applySpan(
  tx: Transaction,
  admission: Admission,
  added: SpanContribution,
): RefusalReason | null {
  assert.ok(added.span_id);
  assert.ok(added.operation);
  if (added.span_id === added.parent_span_id) return RefusalReason.SelfParent;
  const existing = readSpan(tx, admission.trace.trace_id, added.span_id);
  if (!existing) {
    insertSpan(tx, newSpan(admission, added));
    return null;
  }
  if (existing.producer !== admission.producer)
    return RefusalReason.ForeignProducer;
  const merged = mergeSpan(existing, added);
  if (!merged) return RefusalReason.ValueReplaced;
  updateSpan(tx, merged);
  return null;
}

function applyText(
  tx: Transaction,
  admission: Admission,
  record: TextRecord,
): RefusalReason | null {
  assert.ok(record.text_id);
  assert.equal(record.trace_id, admission.trace.trace_id);
  if (readText(tx, admission.trace.trace_id, record.text_id))
    return RefusalReason.TextExists;
  insertText(
    tx,
    {
      trace_id: admission.trace.trace_id,
      text_id: record.text_id,
      content: record.text,
    },
    admission.now,
  );
  return null;
}

function targetOf(record: TelemetryRecord): string {
  return record.kind === RecordKind.Span ? record.span_id : record.text_id;
}

function apply(
  tx: Transaction,
  admission: Admission,
  record: TelemetryRecord,
): RefusalReason | null {
  if (record.kind === RecordKind.Text) return applyText(tx, admission, record);
  assert.equal(record.kind, RecordKind.Span);
  return applySpan(tx, admission, record);
}

function admitRecord(
  tx: Transaction,
  admission: Admission,
  record: TelemetryRecord,
  stored: number,
): Outcome {
  assert.ok(record.record_id);
  assert.ok(Number.isSafeInteger(stored));
  if (record.trace_id !== admission.trace.trace_id)
    return refused(RefusalReason.TraceMismatch);
  if (recordExists(tx, record.trace_id, record.record_id)) return REPEATED;
  if (stored >= EXECUTION_RECORD_LIMIT)
    return refused(RefusalReason.ExecutionBound);
  if (
    Buffer.byteLength(canonicalJSON(record), "utf8") >
    TELEMETRY_RECORD_MAX_BYTES
  )
    return refused(RefusalReason.RecordTooLarge);
  const reason = apply(tx, admission, record);
  if (reason) return refused(reason);
  insertRecord(
    tx,
    {
      trace_id: record.trace_id,
      record_id: record.record_id,
      kind: record.kind,
      target_id: targetOf(record),
    },
    admission.now,
  );
  return STORED;
}

export function admitRecords(
  tx: Transaction,
  admission: Admission,
  records: readonly TelemetryRecord[],
): Acknowledgement {
  assert.ok(records.length <= TELEMETRY_WRITE_RECORDS_MAX);
  assert.ok(admission.producer);
  let stored = countRecords(tx, admission.trace.trace_id);
  const dispositions: RecordDisposition[] = [];
  for (const record of records) {
    const outcome = admitRecord(tx, admission, record, stored);
    if (outcome.inserted) stored += 1;
    dispositions.push({
      record_id: record.record_id,
      disposition: outcome.disposition,
      reason: outcome.reason,
    });
  }
  const refusedCount = dispositions.filter(
    (entry) => entry.disposition === Disposition.Refused,
  ).length;
  return {
    dispositions,
    submitted: records.length,
    stored: records.length - refusedCount,
    refused: refusedCount,
  };
}

export function admitServerSpan(
  tx: Transaction,
  admission: Admission,
  added: SpanContribution,
): RefusalReason | null {
  assert.ok(added.record_id);
  assert.ok(admission.producer);
  if (recordExists(tx, admission.trace.trace_id, added.record_id)) return null;
  const reason = applySpan(tx, admission, added);
  if (reason) return reason;
  insertRecord(
    tx,
    {
      trace_id: admission.trace.trace_id,
      record_id: added.record_id,
      kind: RecordKind.Span,
      target_id: added.span_id,
    },
    admission.now,
  );
  return null;
}
