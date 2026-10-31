import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { identityTime } from "../kernel/identity.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { FlowKind, type Span } from "./contract.ts";
import { close, type FlowState, observe } from "./flow-admission.ts";
import { LATE_RECORD_MS } from "./flow-model.ts";
import { flowColumnsOf, readFlowTrace } from "./flow-trace.ts";
import { listSpans } from "./trace-store.ts";

export const BACKFILL_SCAN_PAGE_ROWS = 500;
export const BACKFILL_FILL_TRACES = 20;
const SPAN_PAGE_ROWS = 500;
const FIRST_SPAN = 0;
const NO_COUNT = 0;

export interface FlowBackfillOptions {
  isHostedWorker: (workerName: string) => boolean;
  now: () => number;
}

interface PendingTrace {
  traceId: string;
  anchor: number;
}

function scanPage(store: Store, cursor: string): PendingTrace[] {
  return store.transaction((tx) =>
    tx.database
      .prepare(
        "SELECT trace_id, execution_id FROM tracking_trace WHERE trace_id > ? AND execution_id IS NOT NULL AND kind IS NULL ORDER BY trace_id LIMIT ?",
      )
      .all(cursor, BACKFILL_SCAN_PAGE_ROWS)
      .map((row) => ({
        traceId: String(row.trace_id),
        anchor: identityTime(String(row.execution_id)),
      })),
  );
}

async function scan(store: Store, signal: AbortSignal) {
  const pending: PendingTrace[] = [];
  let cursor = "";
  while (!signal.aborted) {
    const page = scanPage(store, cursor);
    pending.push(...page);
    const last = page.at(-1);
    if (last === undefined || page.length < BACKFILL_SCAN_PAGE_ROWS) break;
    cursor = last.traceId;
    await setImmediate();
  }
  return pending.sort(
    (left, right) =>
      right.anchor - left.anchor || right.traceId.localeCompare(left.traceId),
  );
}

function spansOf(tx: Transaction, traceId: string): Span[] {
  const spans: Span[] = [];
  let after = FIRST_SPAN;
  for (;;) {
    const page = listSpans(tx, traceId, after, SPAN_PAGE_ROWS);
    spans.push(...page.items);
    if (page.last === null) return spans;
    after = page.last;
  }
}

function lateRecordsOf(
  tx: Transaction,
  traceId: string,
  endedAt: number | null,
): number {
  if (endedAt === null) return NO_COUNT;
  const row = tx.database
    .prepare(
      "SELECT COUNT(*) AS count FROM tracking_record WHERE trace_id = ? AND created_at > ?",
    )
    .get(traceId, endedAt + LATE_RECORD_MS);
  assert.ok(row);
  return Number(row.count);
}

function fillTrace(
  tx: Transaction,
  traceId: string,
  options: FlowBackfillOptions,
): void {
  const row = readFlowTrace(tx, traceId);
  if (row === null || row.kind !== null) return;
  assert.ok(row.execution_id, "fillTrace: a flow trace has an execution");
  const columns = flowColumnsOf(row);
  const state: FlowState = {
    traceId,
    rootSpanId: row.root_span_id,
    anchor: identityTime(row.execution_id),
    isHostedWorker: options.isHostedWorker,
    initial: columns,
    current: columns,
    previous: null,
    endedAt: row.ended_at,
    endsTraceAt: null,
    histogram: [],
    usage: new Map(),
    late: false,
  };
  for (const span of spansOf(tx, traceId)) observe(state, null, span);
  state.current = {
    ...state.current,
    kind: state.current.kind ?? FlowKind.None,
    late_records:
      state.current.late_records + lateRecordsOf(tx, traceId, row.ended_at),
  };
  close(tx, state, options.now());
}

export async function runFlowBackfill(
  store: Store,
  options: FlowBackfillOptions,
  signal: AbortSignal,
  progress: (pendingUntil: number | null) => void,
): Promise<void> {
  progress(options.now());
  try {
    await setImmediate();
    const pending = await scan(store, signal);
    for (
      let start = 0;
      start < pending.length && !signal.aborted;
      start += BACKFILL_FILL_TRACES
    ) {
      const chunk = pending.slice(start, start + BACKFILL_FILL_TRACES);
      store.transaction((tx) => {
        for (const { traceId } of chunk) fillTrace(tx, traceId, options);
      });
      const oldest = chunk.at(-1);
      assert.ok(oldest);
      progress(oldest.anchor);
      await setImmediate();
    }
  } finally {
    progress(null);
  }
}
