import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import type { Transaction } from "../kernel/store.ts";
import { isNumber, isString } from "../kernel/values.ts";
import {
  COLLECTION_MAX,
  type Span,
  SpanStatus,
  TraceState,
  type TraceState as TraceStateValue,
} from "./contract.ts";

const TURN_OPERATION = "agent.turn";
const TOOL_OPERATION = "agent.tool";
const INPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.input_tokens";
const OUTPUT_TOKENS_ATTRIBUTE = "gen_ai.usage.output_tokens";
const CACHE_READ_TOKENS_ATTRIBUTE = "gen_ai.usage.cache_read.input_tokens";
const CACHE_CREATION_TOKENS_ATTRIBUTE =
  "gen_ai.usage.cache_creation.input_tokens";
const COST_ATTRIBUTE = "kanthord.usage.cost_usd";
const AGENT_NAME_ATTRIBUTE = "kanthord.agent.name";
const REQUEST_MODEL_ATTRIBUTE = "gen_ai.request.model";
const RESPONSE_MODEL_ATTRIBUTE = "gen_ai.response.model";
const ERROR_TYPE_ATTRIBUTE = "error.type";
const WORKER_NAME_ATTRIBUTE = "kanthord.worker.name";
const STOP_REASON_ATTRIBUTE = "kanthord.stop.reason";
const ONE_ROW = 1;
const RECOVERED_ERROR_TYPES: ReadonlySet<string> = new Set([
  "tool_error",
  "stopped",
]);

function numberAdded(before: Span | null, after: Span, name: string): number {
  if (before && Object.hasOwn(before.attributes, name)) return 0;
  const value = after.attributes[name];
  return isNumber(value) && Number.isFinite(value) ? value : 0;
}

function stringOf(span: Span, name: string): string | null {
  const value = span.attributes[name];
  return isString(value) ? value : null;
}

function countsAsFirstError(span: Span, isRoot: boolean): boolean {
  if (span.status !== SpanStatus.Error || isRoot) return false;
  const errorType = stringOf(span, ERROR_TYPE_ATTRIBUTE);
  return errorType === null || !RECOVERED_ERROR_TYPES.has(errorType);
}

function stringsOf(span: Span, names: readonly string[]): string[] {
  return names.flatMap((name) => stringOf(span, name) ?? []);
}

function extended(stored: unknown, added: readonly string[]): string {
  const values: unknown = JSON.parse(String(stored));
  assert.ok(Array.isArray(values));
  const merged = [...values];
  for (const value of added) {
    if (merged.length >= COLLECTION_MAX) break;
    if (!merged.includes(value)) merged.push(value);
  }
  return JSON.stringify(merged);
}

function rootState(span: Span): TraceStateValue {
  if (span.end_time === null) return TraceState.Open;
  return span.status === SpanStatus.Error ? TraceState.Error : TraceState.Ok;
}

type StoredCollections = Readonly<Record<string, unknown>>;

function oneIf(condition: boolean): number {
  return condition ? 1 : 0;
}

interface CountOptions {
  isRoot: boolean;
}

function countParams(
  before: Span | null,
  after: Span,
  options: CountOptions,
): SQLInputValue[] {
  const isNew = before === null;
  const newError =
    after.status === SpanStatus.Error && before?.status !== SpanStatus.Error;
  return [
    oneIf(isNew),
    oneIf(isNew && after.operation === TURN_OPERATION),
    oneIf(isNew && after.operation === TOOL_OPERATION),
    oneIf(newError),
    countsAsFirstError(after, options.isRoot) ? after.span_id : null,
  ];
}

function tokenParams(before: Span | null, after: Span): SQLInputValue[] {
  return [
    INPUT_TOKENS_ATTRIBUTE,
    OUTPUT_TOKENS_ATTRIBUTE,
    CACHE_READ_TOKENS_ATTRIBUTE,
    CACHE_CREATION_TOKENS_ATTRIBUTE,
    COST_ATTRIBUTE,
  ].map((name) => numberAdded(before, after, name));
}

function collectionParams(
  row: StoredCollections,
  after: Span,
): SQLInputValue[] {
  return [
    extended(row.agent_names, stringsOf(after, [AGENT_NAME_ATTRIBUTE])),
    extended(
      row.models,
      stringsOf(after, [REQUEST_MODEL_ATTRIBUTE, RESPONSE_MODEL_ATTRIBUTE]),
    ),
    extended(row.error_types, stringsOf(after, [ERROR_TYPE_ATTRIBUTE])),
    stringOf(after, WORKER_NAME_ATTRIBUTE),
  ];
}

function rootParams(after: Span, isRoot: boolean): SQLInputValue[] {
  const flag = oneIf(isRoot);
  return [
    flag,
    after.start_time,
    flag,
    after.end_time,
    flag,
    rootState(after),
    flag,
    stringOf(after, STOP_REASON_ATTRIBUTE),
  ];
}

export function updateTraceSummary(
  tx: Transaction,
  rootSpanId: string,
  before: Span | null,
  after: Span,
): void {
  assert.ok(rootSpanId);
  assert.ok(after.trace_id);
  const row = tx.database
    .prepare(
      "SELECT agent_names, models, error_types FROM tracking_trace WHERE trace_id = ?",
    )
    .get(after.trace_id);
  assert.ok(row, "updateTraceSummary: trace is absent");
  const isRoot = after.span_id === rootSpanId;
  const result = tx.database
    .prepare(
      `UPDATE tracking_trace SET
        span_count = span_count + ?,
        turn_count = turn_count + ?,
        tool_count = tool_count + ?,
        error_count = error_count + ?,
        first_error_span_id = COALESCE(first_error_span_id, ?),
        input_tokens = input_tokens + ?,
        output_tokens = output_tokens + ?,
        cache_read_tokens = cache_read_tokens + ?,
        cache_creation_tokens = cache_creation_tokens + ?,
        cost_usd = cost_usd + ?,
        agent_names = ?,
        models = ?,
        error_types = ?,
        worker_name = COALESCE(worker_name, ?),
        started_at = CASE WHEN ? THEN ? ELSE started_at END,
        ended_at = CASE WHEN ? THEN ? ELSE ended_at END,
        state = CASE WHEN ? THEN ? ELSE state END,
        stop_reason = CASE WHEN ? THEN ? ELSE stop_reason END
      WHERE trace_id = ?`,
    )
    .run(
      ...countParams(before, after, { isRoot }),
      ...tokenParams(before, after),
      ...collectionParams(row, after),
      ...rootParams(after, isRoot),
      after.trace_id,
    );
  assert.equal(Number(result.changes), ONE_ROW);
}
