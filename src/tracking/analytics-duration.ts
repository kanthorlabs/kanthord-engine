import assert from "node:assert/strict";
import type { Store } from "../kernel/store.ts";
import { isNumber, isString } from "../kernel/values.ts";
import { bucketStart } from "./analytics-bucket.ts";
import {
  selectTraces,
  walkSpanGroups,
  walkSpans,
  type AnalyticsSpan,
  type SelectedTrace,
  type TraceFilter,
} from "./analytics-walk.ts";
import {
  AnalyticsMeasure,
  DurationGroupBy,
  type AnalyticsBucket,
} from "./contract.ts";

export interface DurationQuery extends TraceFilter {
  from: number;
  to: number;
  measure: AnalyticsMeasure;
  operation?: string;
  group_by: DurationGroupBy;
  bucket: AnalyticsBucket;
}
export interface DurationItem {
  key: string | null;
  bucket_start: number | null;
  count: number;
  p50: number;
  p90: number;
  p99: number;
  mean: number;
  max: number;
}
export interface DurationRead {
  items: DurationItem[];
  truncated: boolean;
}

interface Group {
  key: string | null;
  bucket_start: number | null;
  values: number[];
}

type KeyOf = (span: AnalyticsSpan, trace: SelectedTrace) => string | null;
type AddValue = (
  span: AnalyticsSpan,
  trace: SelectedTrace,
  value: number,
) => void;
type Collect = (
  store: Store,
  traces: readonly SelectedTrace[],
  query: DurationQuery,
  signal: AbortSignal,
  add: AddValue,
) => Promise<void>;

const TOOL_OPERATION = "agent.tool";
const VERIFICATION_OPERATION = "worker.verification";
const EXECUTION_OPERATION = "scheduler.execution";
const TRANSITION_OPERATION = "scheduler.transition";
const STEPS_KIND = "steps";
const EVALUATION_KIND = "evaluation";
const EXECUTION_KIND_ATTRIBUTE = "kanthord.execution.kind";
const QUEUE_WAIT_ATTRIBUTE = "kanthord.queue.wait_ms";
const STATE_FROM_ATTRIBUTE = "kanthord.node.state.from";
const STATE_TO_ATTRIBUTE = "kanthord.node.state.to";
const EVALUATING_STATE = "Evaluating";
const AVAILABLE_STATE = "Available";
const AGENT_NAME_ATTRIBUTE = "kanthord.agent.name";
const TOOL_NAME_ATTRIBUTE = "gen_ai.tool.name";
const REQUEST_MODEL_ATTRIBUTE = "gen_ai.request.model";
const RESPONSE_MODEL_ATTRIBUTE = "gen_ai.response.model";
const MEDIAN = 0.5;
const P90 = 0.9;
const P99 = 0.99;
const AFTER = 1;
const NO_LIMIT = 0;

function stringOf(span: AnalyticsSpan, name: string): string | null {
  const value = span.attributes[name];
  return isString(value) ? value : null;
}

const KEY_OF: Record<DurationGroupBy, KeyOf> = {
  [DurationGroupBy.None]: () => null,
  [DurationGroupBy.Operation]: (span) => span.operation,
  [DurationGroupBy.ToolName]: (span) => stringOf(span, TOOL_NAME_ATTRIBUTE),
  [DurationGroupBy.AgentName]: (span) => stringOf(span, AGENT_NAME_ATTRIBUTE),
  [DurationGroupBy.Model]: (span) =>
    stringOf(span, RESPONSE_MODEL_ATTRIBUTE) ??
    stringOf(span, REQUEST_MODEL_ATTRIBUTE),
  [DurationGroupBy.WorkerName]: (_span, trace) => trace.worker_name,
  [DurationGroupBy.NodeId]: (_span, trace) => trace.node_id,
  [DurationGroupBy.ProjectId]: (_span, trace) => trace.project_id,
};

export function percentile(sorted: readonly number[], p: number): number {
  assert.ok(sorted.length > NO_LIMIT);
  const last = sorted.length - 1;
  const h = last * p;
  const k = Math.floor(h);
  if (k >= last) return sorted[last]!;
  return sorted[k]! + (h - k) * (sorted[k + 1]! - sorted[k]!);
}

function itemOf(group: Group): DurationItem {
  const sorted = [...group.values].sort((left, right) => left - right);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    key: group.key,
    bucket_start: group.bucket_start,
    count: sorted.length,
    p50: percentile(sorted, MEDIAN),
    p90: percentile(sorted, P90),
    p99: percentile(sorted, P99),
    mean: sum / sorted.length,
    max: sorted[sorted.length - 1]!,
  };
}

function compareKeys(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return AFTER;
  if (right === null) return -AFTER;
  return left < right ? -AFTER : AFTER;
}

function compareItems(left: DurationItem, right: DurationItem): number {
  return (
    (left.bucket_start ?? 0) - (right.bucket_start ?? 0) ||
    right.count - left.count ||
    compareKeys(left.key, right.key)
  );
}

function collectDurations(
  operationOf: (query: DurationQuery) => string | undefined,
): Collect {
  return (store, traces, query, signal, add) =>
    walkSpans(
      store,
      traces,
      { operation: operationOf(query), from: query.from, to: query.to },
      signal,
      (span, trace) => {
        if (span.start_time === null || span.end_time === null) return;
        add(span, trace, span.end_time - span.start_time);
      },
    );
}

function collectWaits(kind: string): Collect {
  return (store, traces, query, signal, add) =>
    walkSpans(
      store,
      traces,
      { roots: true, from: query.from, to: query.to },
      signal,
      (span, trace) => {
        const wait = span.attributes[QUEUE_WAIT_ATTRIBUTE];
        if (span.attributes[EXECUTION_KIND_ATTRIBUTE] !== kind) return;
        if (!isNumber(wait) || !Number.isFinite(wait)) return;
        add(span, trace, wait);
      },
    );
}

interface Attempt {
  turns: number;
  first: { span: AnalyticsSpan; trace: SelectedTrace } | null;
}

function isRevisionTurn(span: AnalyticsSpan): boolean {
  return (
    span.attributes[STATE_FROM_ATTRIBUTE] === EVALUATING_STATE &&
    span.attributes[STATE_TO_ATTRIBUTE] === AVAILABLE_STATE
  );
}

const collectRevisionTurns: Collect = async (
  store,
  traces,
  query,
  signal,
  add,
) => {
  const attempts = new Map<string, Attempt>();
  await walkSpanGroups(
    store,
    traces,
    [
      {
        operation: EXECUTION_OPERATION,
        roots: true,
        from: query.from,
        to: query.to,
      },
      { operation: TRANSITION_OPERATION, from: query.from, to: query.to },
    ],
    signal,
    (span, trace) => {
      if (trace.node_id === null || trace.attempt === null) return;
      const identity = JSON.stringify([trace.node_id, trace.attempt]);
      const attempt = attempts.get(identity) ?? { turns: 0, first: null };
      attempts.set(identity, attempt);
      if (span.operation === TRANSITION_OPERATION) {
        if (isRevisionTurn(span)) attempt.turns += 1;
        return;
      }
      assert.ok(span.start_time !== null);
      const firstStart = attempt.first?.span.start_time ?? Infinity;
      if (span.start_time < firstStart) attempt.first = { span, trace };
    },
  );
  for (const { turns, first } of attempts.values())
    if (first !== null) add(first.span, first.trace, turns);
};

const COLLECT: Record<AnalyticsMeasure, Collect> = {
  [AnalyticsMeasure.SpanDuration]: collectDurations((query) => query.operation),
  [AnalyticsMeasure.ToolLatency]: collectDurations(() => TOOL_OPERATION),
  [AnalyticsMeasure.VerificationTime]: collectDurations(
    () => VERIFICATION_OPERATION,
  ),
  [AnalyticsMeasure.QueueWait]: collectWaits(STEPS_KIND),
  [AnalyticsMeasure.ReviewWait]: collectWaits(EVALUATION_KIND),
  [AnalyticsMeasure.RevisionTurns]: collectRevisionTurns,
};

export async function readDuration(
  store: Store,
  query: DurationQuery,
  limit: number,
  signal: AbortSignal,
): Promise<DurationRead> {
  assert.ok(Number.isSafeInteger(limit) && limit > NO_LIMIT);
  const keyOf = KEY_OF[query.group_by];
  const traces = store.transaction((tx) =>
    selectTraces(tx, query, {
      project_id: query.project_id,
      node_id: query.node_id,
    }),
  );
  const groups = new Map<string, Group>();
  await COLLECT[query.measure](
    store,
    traces,
    query,
    signal,
    (span, trace, value) => {
      assert.ok(span.start_time !== null);
      const key = keyOf(span, trace);
      const start = bucketStart(span.start_time, query.bucket);
      const identity = JSON.stringify([start, key]);
      const group = groups.get(identity) ?? {
        key,
        bucket_start: start,
        values: [],
      };
      groups.set(identity, group);
      group.values.push(value);
    },
  );
  const items = [...groups.values()].map(itemOf).sort(compareItems);
  return { items: items.slice(0, limit), truncated: items.length > limit };
}
