import assert from "node:assert/strict";
import { identityTime } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { FlowGrain, type Span } from "./contract.ts";
import { flowFactsOf, type FlowHistogramValue } from "./flow-facts.ts";
import {
  bucketsOf,
  contributionOf,
  FLOW_VECTOR_COLUMNS,
  type FlowContribution,
  type FlowVector,
  LATE_RECORD_MS,
} from "./flow-model.ts";
import {
  addFlowVector,
  addHistogramValue,
  addUsage,
  deleteEmptyFlowRow,
  type FlowUsageSum,
  type RollupPlace,
} from "./flow-rollup.ts";
import {
  applyFlowFacts,
  changedFlowColumns,
  type FlowColumns,
  flowColumnsOf,
  readFlowTrace,
  writeFlowColumns,
} from "./flow-trace.ts";

const NO_VALUE = "";
const NO_COUNT = 0;
const ONE_COUNT = 1;

export interface FlowState {
  traceId: string;
  rootSpanId: string;
  anchor: number;
  isHostedWorker: (workerName: string) => boolean;
  initial: FlowColumns;
  current: FlowColumns;
  previous: FlowContribution | null;
  endedAt: number | null;
  endsTraceAt: number | null;
  histogram: FlowHistogramValue[];
  usage: Map<string, FlowUsageSum>;
  late: boolean;
}

export function openFlow(
  tx: Transaction,
  traceId: string,
  inserted: boolean,
  isHostedWorker: (workerName: string) => boolean,
): FlowState | null {
  const row = readFlowTrace(tx, traceId);
  assert.ok(row, "openFlow: trace is absent");
  if (row.kind === null) return null;
  assert.ok(row.execution_id, "openFlow: a flow trace has an execution");
  const columns = flowColumnsOf(row);
  return {
    traceId,
    rootSpanId: row.root_span_id,
    anchor: identityTime(row.execution_id),
    isHostedWorker,
    initial: columns,
    current: columns,
    previous: inserted ? null : contributionOf(row, isHostedWorker),
    endedAt: row.ended_at,
    endsTraceAt: null,
    histogram: [],
    usage: new Map(),
    late: false,
  };
}

function addedUsage(
  state: FlowState,
  usage: NonNullable<ReturnType<typeof flowFactsOf>["usage"]>,
): void {
  const held = state.usage.get(usage.model);
  const priced = usage.cost_usd > NO_COUNT;
  const unpriced =
    !priced && (usage.input_tokens > NO_COUNT || usage.output_tokens > NO_COUNT)
      ? usage.input_tokens + usage.output_tokens
      : NO_COUNT;
  state.usage.set(usage.model, {
    turn_count: (held?.turn_count ?? NO_COUNT) + ONE_COUNT,
    input_tokens: (held?.input_tokens ?? NO_COUNT) + usage.input_tokens,
    output_tokens: (held?.output_tokens ?? NO_COUNT) + usage.output_tokens,
    cache_read_tokens:
      (held?.cache_read_tokens ?? NO_COUNT) + usage.cache_read_tokens,
    cost_usd: (held?.cost_usd ?? NO_COUNT) + usage.cost_usd,
    unpriced_tokens: (held?.unpriced_tokens ?? NO_COUNT) + unpriced,
  });
}

export function observe(
  state: FlowState,
  before: Span | null,
  after: Span,
): void {
  const facts = flowFactsOf(state.rootSpanId, before, after);
  state.current = applyFlowFacts(state.current, facts);
  state.histogram.push(...facts.histogram);
  if (facts.usage !== null) addedUsage(state, facts.usage);
  const endsTrace =
    after.span_id === state.rootSpanId &&
    (before?.end_time ?? null) === null &&
    after.end_time !== null;
  if (endsTrace) state.endsTraceAt = after.end_time;
}

export function late(state: FlowState, now: number): void {
  const endedAt = state.endedAt;
  state.endedAt = state.endsTraceAt ?? endedAt;
  state.endsTraceAt = null;
  if (endedAt === null || now - endedAt <= LATE_RECORD_MS) return;
  state.current = {
    ...state.current,
    late_records: state.current.late_records + ONE_COUNT,
  };
  state.late = true;
}

function sameVector(left: FlowVector, right: FlowVector): boolean {
  return FLOW_VECTOR_COLUMNS.every((column) => left[column] === right[column]);
}

function sameKey(left: FlowContribution, right: FlowContribution): boolean {
  return (
    JSON.stringify(Object.entries(left.key)) ===
    JSON.stringify(Object.entries(right.key))
  );
}

function delta(
  next: FlowVector | null,
  previous: FlowVector | null,
): FlowVector {
  return Object.fromEntries(
    FLOW_VECTOR_COLUMNS.map((column) => [
      column,
      (next?.[column] ?? NO_COUNT) - (previous?.[column] ?? NO_COUNT),
    ]),
  ) as FlowVector;
}

function placesOf(state: FlowState, now: number): RollupPlace[] {
  const buckets = bucketsOf(state.anchor);
  return [
    { grain: FlowGrain.Hour, bucket_start: buckets.hour, now },
    { grain: FlowGrain.Day, bucket_start: buckets.day, now },
  ];
}

function moveContribution(
  tx: Transaction,
  state: FlowState,
  next: FlowContribution,
  now: number,
): void {
  const previous = state.previous;
  for (const place of placesOf(state, now)) {
    if (previous === null) {
      addFlowVector(tx, place, next.key, next.vector, state.late);
      continue;
    }
    if (!sameKey(previous, next)) {
      addFlowVector(
        tx,
        place,
        previous.key,
        delta(null, previous.vector),
        state.late,
      );
      deleteEmptyFlowRow(tx, place, previous.key);
      addFlowVector(tx, place, next.key, next.vector, state.late);
      continue;
    }
    if (sameVector(previous.vector, next.vector)) continue;
    addFlowVector(
      tx,
      place,
      next.key,
      delta(next.vector, previous.vector),
      state.late,
    );
  }
}

export function close(tx: Transaction, state: FlowState, now: number): void {
  const row = readFlowTrace(tx, state.traceId);
  assert.ok(row, "close: trace is absent");
  writeFlowColumns(
    tx,
    state.traceId,
    changedFlowColumns(state.initial, state.current),
  );
  const trace = { ...row, ...state.current };
  moveContribution(tx, state, contributionOf(trace, state.isHostedWorker), now);
  const projectId = trace.project_id ?? NO_VALUE;
  const workerName = trace.worker_name ?? NO_VALUE;
  for (const place of placesOf(state, now)) {
    for (const { measure, value } of state.histogram)
      addHistogramValue(tx, place, projectId, workerName, measure, value);
    for (const [model, sum] of state.usage)
      addUsage(tx, place, projectId, workerName, model, sum);
  }
}
