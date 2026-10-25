import { setImmediate } from "node:timers/promises";
import assert from "node:assert/strict";
import type { Store, Transaction } from "../kernel/store.ts";
import { attributesSchema, type Attributes } from "./contract.ts";

export interface AnalyticsRange {
  from: number;
  to: number;
}
export interface TraceFilter {
  project_id?: string;
  node_id?: string;
}
export interface SpanFilter {
  operation: string;
  from: number;
  to: number;
}
export interface SelectedTrace {
  trace_id: string;
  root_span_id: string;
  project_id: string | null;
  node_id: string | null;
  worker_name: string | null;
}
export interface AnalyticsSpan {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  operation: string;
  start_time: number | null;
  end_time: number | null;
  attributes: Attributes;
}

const STEP_TRACES_MAX = 100;
const FIRST_OFFSET = 0;
const TRACE_FILTERS = ["project_id", "node_id"] as const;

function textOrNull(value: unknown): string | null {
  return value === null ? null : String(value);
}

function numberOrNull(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function selectedTraceOf(row: Record<string, unknown>): SelectedTrace {
  return {
    trace_id: String(row.trace_id),
    root_span_id: String(row.root_span_id),
    project_id: textOrNull(row.project_id),
    node_id: textOrNull(row.node_id),
    worker_name: textOrNull(row.worker_name),
  };
}

function analyticsSpanOf(row: Record<string, unknown>): AnalyticsSpan {
  assert.ok(row.trace_id);
  assert.ok(row.span_id);
  return {
    trace_id: String(row.trace_id),
    span_id: String(row.span_id),
    parent_span_id: textOrNull(row.parent_span_id),
    operation: String(row.operation),
    start_time: numberOrNull(row.start_time),
    end_time: numberOrNull(row.end_time),
    attributes: attributesSchema.parse(JSON.parse(String(row.attributes))),
  };
}

export function selectTraces(
  tx: Transaction,
  range: AnalyticsRange,
  filter: TraceFilter,
): SelectedTrace[] {
  const clauses = [
    "COALESCE(started_at, created_at) <= ?",
    "(ended_at IS NULL OR ended_at >= ?)",
  ];
  const params: (string | number)[] = [range.to, range.from];
  for (const column of TRACE_FILTERS) {
    const value = filter[column];
    if (value === undefined) continue;
    clauses.push(`${column} = ?`);
    params.push(value);
  }
  return tx.database
    .prepare(
      `SELECT trace_id, root_span_id, project_id, node_id, worker_name FROM tracking_trace WHERE ${clauses.join(" AND ")} ORDER BY trace_id`,
    )
    .all(...params)
    .map(selectedTraceOf);
}

function stepSql(count: number): string {
  const marks = Array.from({ length: count }, () => "?").join(", ");
  return `SELECT trace_id, span_id, parent_span_id, operation, start_time, end_time, attributes FROM tracking_span WHERE trace_id IN (${marks}) AND operation = ? AND start_time BETWEEN ? AND ?`;
}

export async function walkSpans(
  store: Store,
  traces: readonly SelectedTrace[],
  filter: SpanFilter,
  signal: AbortSignal,
  visit: (span: AnalyticsSpan, trace: SelectedTrace) => void,
): Promise<void> {
  const byIdentity = new Map(traces.map((trace) => [trace.trace_id, trace]));
  for (let offset = 0; offset < traces.length; offset += STEP_TRACES_MAX) {
    if (offset !== FIRST_OFFSET) await setImmediate();
    signal.throwIfAborted();
    const identities = traces
      .slice(offset, offset + STEP_TRACES_MAX)
      .map((trace) => trace.trace_id);
    const rows = store.transaction((tx) =>
      tx.database
        .prepare(stepSql(identities.length))
        .all(...identities, filter.operation, filter.from, filter.to),
    );
    for (const row of rows) {
      const span = analyticsSpanOf(row);
      const trace = byIdentity.get(span.trace_id);
      assert.ok(trace);
      visit(span, trace);
    }
  }
}
