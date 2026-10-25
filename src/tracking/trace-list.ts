import assert from "node:assert/strict";
import type { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import {
  FACET_VALUES_MAX,
  TraceSort,
  traceListItemSchema,
  trackingOperations,
  type TraceListItem,
} from "./contract.ts";
import { TRACE_COLUMNS, traceSummaryOf } from "./trace-store.ts";

export type TraceListQuery = z.infer<
  typeof trackingOperations.traceList.input
>["query"];
export type Facets = z.infer<typeof trackingOperations.facetGet.output>;
export interface TraceCursor {
  sort: TraceSort;
  value: number;
  position: number;
}
export interface TracePage {
  items: TraceListItem[];
  last: TraceCursor | null;
}

type Bound = string | number;

const EMPTY_PAGE = 0;
const STARTED_AT_VALUE = "COALESCE(started_at, created_at)";
const DURATION_VALUE = "(ended_at - started_at)";
const TOTAL_TOKENS_VALUE = "(input_tokens + output_tokens)";
const SORT_VALUES: Record<TraceSort, string> = {
  [TraceSort.StartedAt]: STARTED_AT_VALUE,
  [TraceSort.DurationMs]: `COALESCE(${DURATION_VALUE}, -1)`,
  [TraceSort.TotalTokens]: TOTAL_TOKENS_VALUE,
  [TraceSort.CostUsd]: "cost_usd",
};
const EXACT_FILTERS = [
  "project_id",
  "node_id",
  "execution_id",
  "worker_name",
  "state",
] as const;
const MEMBER_FILTERS = [
  ["agent_name", "agent_names"],
  ["model", "models"],
  ["error_type", "error_types"],
] as const;
const SEARCHED_COLUMNS = [
  "trace_id",
  "execution_id",
  "node_id",
  "worker_name",
  "stop_reason",
  "agent_names",
  "models",
  "error_types",
] as const;
const BOUND_FILTERS = [
  ["min_duration_ms", DURATION_VALUE, ">="],
  ["max_duration_ms", DURATION_VALUE, "<="],
  ["min_total_tokens", TOTAL_TOKENS_VALUE, ">="],
  ["max_total_tokens", TOTAL_TOKENS_VALUE, "<="],
  ["min_cost_usd", "cost_usd", ">="],
  ["max_cost_usd", "cost_usd", "<="],
] as const;

interface Condition {
  clauses: string[];
  params: Bound[];
}

function conditionOf(query: TraceListQuery): Condition {
  const condition: Condition = { clauses: [], params: [] };
  for (const column of EXACT_FILTERS) {
    const value = query[column];
    if (value === undefined) continue;
    condition.clauses.push(`${column} = ?`);
    condition.params.push(value);
  }
  for (const [name, column] of MEMBER_FILTERS) {
    const value = query[name];
    if (value === undefined) continue;
    condition.clauses.push(
      `EXISTS (SELECT 1 FROM json_each(${column}) WHERE value = ?)`,
    );
    condition.params.push(value);
  }
  const text = query.q;
  if (text !== undefined) {
    condition.clauses.push(
      `(${SEARCHED_COLUMNS.map((column) => `instr(lower(${column}), lower(?)) > 0`).join(" OR ")})`,
    );
    condition.params.push(...SEARCHED_COLUMNS.map(() => text));
  }
  if (query.to !== undefined) {
    condition.clauses.push(`${STARTED_AT_VALUE} <= ?`);
    condition.params.push(query.to);
  }
  if (query.from !== undefined) {
    condition.clauses.push("(ended_at IS NULL OR ended_at >= ?)");
    condition.params.push(query.from);
  }
  for (const [name, value, operator] of BOUND_FILTERS) {
    const bound = query[name];
    if (bound === undefined) continue;
    condition.clauses.push(`${value} ${operator} ?`);
    condition.params.push(bound);
  }
  return condition;
}

function traceListItemOf(row: Record<string, unknown>): TraceListItem {
  return {
    ...traceSummaryOf(row),
    root_operation:
      row.root_operation === null ? null : String(row.root_operation),
    root_attributes:
      row.root_attributes === null
        ? null
        : traceListItemSchema.shape.root_attributes.parse(
            JSON.parse(String(row.root_attributes)),
          ),
  };
}

function cursorOf(sort: TraceSort, row: Record<string, unknown>): TraceCursor {
  const value = Number(row.sort_value);
  const position = Number(row.position);
  assert.ok(Number.isFinite(value));
  assert.ok(Number.isSafeInteger(position));
  return { sort, value, position };
}

export function listTraces(
  tx: Transaction,
  query: TraceListQuery,
  after: TraceCursor | null,
): TracePage {
  assert.ok(Number.isSafeInteger(query.limit) && query.limit > EMPTY_PAGE);
  assert.ok(after === null || after.sort === query.sort);
  const value = SORT_VALUES[query.sort];
  const condition = conditionOf(query);
  if (after !== null) {
    condition.clauses.push(`(${value} < ? OR (${value} = ? AND rowid < ?))`);
    condition.params.push(after.value, after.value, after.position);
  }
  const where =
    condition.clauses.length === EMPTY_PAGE
      ? ""
      : ` WHERE ${condition.clauses.join(" AND ")}`;
  const rows = tx.database
    .prepare(
      `SELECT t.*, r.operation AS root_operation, r.attributes AS root_attributes FROM (SELECT rowid AS position, ${value} AS sort_value, ${TRACE_COLUMNS} FROM tracking_trace${where} ORDER BY ${value} DESC, rowid DESC LIMIT ?) t LEFT JOIN tracking_span r ON r.trace_id = t.trace_id AND r.span_id = t.root_span_id ORDER BY t.sort_value DESC, t.position DESC`,
    )
    .all(...condition.params, query.limit + 1);
  const page = rows.slice(0, query.limit);
  const lastRow = page.at(-1);
  return {
    items: page.map(traceListItemOf),
    last:
      rows.length > query.limit && lastRow !== undefined
        ? cursorOf(query.sort, lastRow)
        : null,
  };
}

function facetValues(
  tx: Transaction,
  sql: string,
  params: readonly string[],
): string[] {
  return tx.database
    .prepare(`${sql} ORDER BY value ASC LIMIT ?`)
    .all(...params, FACET_VALUES_MAX)
    .map((row) => String(row.value));
}

function jsonFacet(
  tx: Transaction,
  column: string,
  projectId: string | undefined,
): string[] {
  const filter = projectId === undefined ? "" : " WHERE project_id = ?";
  return facetValues(
    tx,
    `SELECT DISTINCT value FROM tracking_trace, json_each(${column})${filter}`,
    projectId === undefined ? [] : [projectId],
  );
}

export function readFacets(
  tx: Transaction,
  projectId: string | undefined,
): Facets {
  const filter = projectId === undefined ? "" : " AND project_id = ?";
  return {
    worker_names: facetValues(
      tx,
      `SELECT DISTINCT worker_name AS value FROM tracking_trace WHERE worker_name IS NOT NULL${filter}`,
      projectId === undefined ? [] : [projectId],
    ),
    agent_names: jsonFacet(tx, "agent_names", projectId),
    models: jsonFacet(tx, "models", projectId),
    error_types: jsonFacet(tx, "error_types", projectId),
  };
}
