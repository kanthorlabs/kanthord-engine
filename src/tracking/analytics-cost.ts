import assert from "node:assert/strict";
import { z } from "zod";
import type { Store } from "../kernel/store.ts";
import { isNumber, isString } from "../kernel/values.ts";
import { bucketStart, type AnalyticsBucket } from "./analytics-bucket.ts";
import {
  selectTraces,
  walkSpans,
  type AnalyticsSpan,
  type SelectedTrace,
  type TraceFilter,
} from "./analytics-walk.ts";

export const CostGroupBy = {
  None: "none",
  Model: "model",
  AgentName: "agent_name",
  ProviderName: "provider_name",
  WorkerName: "worker_name",
  NodeId: "node_id",
  ProjectId: "project_id",
} as const;
export const costGroupBySchema = z.enum(CostGroupBy);
export type CostGroupBy = z.infer<typeof costGroupBySchema>;

export interface CostQuery extends TraceFilter {
  from: number;
  to: number;
  group_by: CostGroupBy;
  bucket: AnalyticsBucket;
}
export interface CostItem {
  key: string | null;
  bucket_start: number | null;
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_tokens: number;
  cost_usd: number;
}
export interface CostRead {
  items: CostItem[];
  truncated: boolean;
}

type KeyOf = (span: AnalyticsSpan, trace: SelectedTrace) => string | null;

const TURN_OPERATION = "agent.turn";
const INPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.output_tokens";
const CACHE_READ_TOKENS_ATTRIBUTE = "gen_ai.usage.cache_read.input_tokens";
const CACHE_CREATION_TOKENS_ATTRIBUTE =
  "gen_ai.usage.cache_creation.input_tokens";
const COST_ATTRIBUTE = "kanthord.usage.cost_usd";
const AGENT_NAME_ATTRIBUTE = "kanthord.agent.name";
const PROVIDER_NAME_ATTRIBUTE = "gen_ai.provider.name";
const REQUEST_MODEL_ATTRIBUTE = "gen_ai.request.model";
const RESPONSE_MODEL_ATTRIBUTE = "gen_ai.response.model";
const AFTER = 1;
const NO_LIMIT = 0;

function stringOf(span: AnalyticsSpan, name: string): string | null {
  const value = span.attributes[name];
  return isString(value) ? value : null;
}

function numberOf(span: AnalyticsSpan, name: string): number {
  const value = span.attributes[name];
  return isNumber(value) && Number.isFinite(value) ? value : 0;
}

const KEY_OF: Record<CostGroupBy, KeyOf> = {
  [CostGroupBy.None]: () => null,
  [CostGroupBy.Model]: (span) =>
    stringOf(span, RESPONSE_MODEL_ATTRIBUTE) ??
    stringOf(span, REQUEST_MODEL_ATTRIBUTE),
  [CostGroupBy.AgentName]: (span) => stringOf(span, AGENT_NAME_ATTRIBUTE),
  [CostGroupBy.ProviderName]: (span) => stringOf(span, PROVIDER_NAME_ATTRIBUTE),
  [CostGroupBy.WorkerName]: (_span, trace) => trace.worker_name,
  [CostGroupBy.NodeId]: (_span, trace) => trace.node_id,
  [CostGroupBy.ProjectId]: (_span, trace) => trace.project_id,
};

function emptyItem(key: string | null, start: number | null): CostItem {
  return {
    key,
    bucket_start: start,
    turn_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
}

function addTurn(item: CostItem, span: AnalyticsSpan): void {
  const input = numberOf(span, INPUT_TOKENS_ATTRIBUTE);
  const output = numberOf(span, OUTPUT_TOKENS_ATTRIBUTE);
  item.turn_count += 1;
  item.input_tokens += input;
  item.output_tokens += output;
  item.cache_read_tokens += numberOf(span, CACHE_READ_TOKENS_ATTRIBUTE);
  item.cache_creation_tokens += numberOf(span, CACHE_CREATION_TOKENS_ATTRIBUTE);
  item.total_tokens += input + output;
  item.cost_usd += numberOf(span, COST_ATTRIBUTE);
}

function compareKeys(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return AFTER;
  if (right === null) return -AFTER;
  return left < right ? -AFTER : AFTER;
}

function compareItems(left: CostItem, right: CostItem): number {
  return (
    (left.bucket_start ?? 0) - (right.bucket_start ?? 0) ||
    right.cost_usd - left.cost_usd ||
    compareKeys(left.key, right.key)
  );
}

export async function readCost(
  store: Store,
  query: CostQuery,
  limit: number,
  signal: AbortSignal,
): Promise<CostRead> {
  assert.ok(Number.isSafeInteger(limit) && limit > NO_LIMIT);
  const keyOf = KEY_OF[query.group_by];
  const traces = store.transaction((tx) =>
    selectTraces(tx, query, {
      project_id: query.project_id,
      node_id: query.node_id,
    }),
  );
  const groups = new Map<string, CostItem>();
  await walkSpans(
    store,
    traces,
    { operation: TURN_OPERATION, from: query.from, to: query.to },
    signal,
    (span, trace) => {
      assert.ok(span.start_time !== null);
      const key = keyOf(span, trace);
      const start = bucketStart(span.start_time, query.bucket);
      const identity = JSON.stringify([start, key]);
      const item = groups.get(identity) ?? emptyItem(key, start);
      groups.set(identity, item);
      addTurn(item, span);
    },
  );
  const items = [...groups.values()].sort(compareItems);
  return { items: items.slice(0, limit), truncated: items.length > limit };
}
