import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import {
  type Span,
  spanSchema,
  TIMELINE_LIMIT_DEFAULT,
  TIMELINE_LIMIT_MAX,
  TIMELINE_LIMIT_MIN,
  TimelineDepth,
  TimelineScope,
} from "./contract.ts";

export const TRACE_END_TIME = Number.MAX_SAFE_INTEGER;
export const TRACE_END_SPAN_ID = "";

export interface TimelineQuery {
  execution_id?: string;
  node_id?: string;
  project_id?: string;
  from?: number;
  to?: number;
  depth?: TimelineDepth;
  limit?: number;
}
export type TimelineItem = Span & {
  depth: TimelineDepth;
  duration_ms: number | null;
  project_id: string | null;
  node_id: string | null;
  execution_id: string | null;
  attempt: number | null;
  worker_name: string | null;
};
export interface TimelineCursor {
  trace_time: number;
  trace_id: string;
  item_time: number;
  span_id: string;
}
export interface TimelinePage {
  items: TimelineItem[];
  next_cursor: TimelineCursor | null;
}

const NO_CURSOR: TimelineCursor = {
  trace_time: -1,
  trace_id: "",
  item_time: -1,
  span_id: "",
};
const ONE_SCOPE = 1;
const TRACE_END_DEPTH = 0;
const ROWS_PER_ITEM_AND_END = 2;
const END_ROWS_EXTRA = 2;
const SCOPE_COLUMNS: Record<TimelineScope, string> = {
  [TimelineScope.ExecutionId]: "execution_id",
  [TimelineScope.NodeId]: "node_id",
  [TimelineScope.ProjectId]: "project_id",
};
const SPAN_DETAIL_COLUMNS = [
  "parent_span_id",
  "producer",
  "origin",
  "operation",
  "start_time",
  "end_time",
  "status",
  "attributes",
  "events",
  "links",
  "text_ids",
  "created_at",
] as const;
const SPAN_DETAIL_SELECT = SPAN_DETAIL_COLUMNS.map(
  (column) => `s.${column}`,
).join(", ");
const SPAN_DETAIL_EMPTY = SPAN_DETAIL_COLUMNS.map(() => "NULL").join(", ");
const TRACE_DETAIL_SELECT =
  "kept.project_id, kept.node_id, kept.execution_id, kept.attempt";

function statementOf(scopeColumn: string): string {
  const afterRow = (time: string, spanId: string) =>
    `(kept.trace_time, kept.trace_id, ${time}, ${spanId}) > (:after_trace_time, :after_trace_id, :after_time, :after_span_id)`;
  return `WITH kept AS MATERIALIZED (
  SELECT trace_id, root_span_id, project_id, node_id, execution_id, attempt, worker_name,
         COALESCE(started_at, created_at) AS trace_time
  FROM tracking_trace
  WHERE ${scopeColumn} = :scope AND COALESCE(started_at, created_at) <= :to AND (ended_at IS NULL OR ended_at >= :from)
    AND (COALESCE(started_at, created_at), trace_id, ${TRACE_END_TIME}, '') > (:after_trace_time, :after_trace_id, :after_time, :after_span_id)
  ORDER BY trace_time, trace_id
  LIMIT :trace_limit
)
SELECT kept.trace_time, kept.trace_id, ${TimelineDepth.Root} AS depth, COALESCE(s.start_time, s.end_time) AS item_time, s.span_id, kept.worker_name, ${SPAN_DETAIL_SELECT}, ${TRACE_DETAIL_SELECT}
FROM kept CROSS JOIN tracking_span AS s ON s.trace_id = kept.trace_id AND s.span_id = kept.root_span_id
WHERE ${afterRow("COALESCE(s.start_time, s.end_time)", "s.span_id")}
UNION ALL
SELECT kept.trace_time, kept.trace_id, ${TimelineDepth.Child}, COALESCE(s.start_time, s.end_time), s.span_id, NULL, ${SPAN_DETAIL_SELECT}, ${TRACE_DETAIL_SELECT}
FROM kept CROSS JOIN tracking_span AS s ON s.trace_id = kept.trace_id AND s.parent_span_id = kept.root_span_id
WHERE :max_depth >= ${TimelineDepth.Child} AND ${afterRow("COALESCE(s.start_time, s.end_time)", "s.span_id")}
UNION ALL
SELECT kept.trace_time, kept.trace_id, ${TRACE_END_DEPTH}, ${TRACE_END_TIME}, '', NULL, ${SPAN_DETAIL_EMPTY}, ${TRACE_DETAIL_SELECT}
FROM kept
WHERE ${afterRow(String(TRACE_END_TIME), "''")}
ORDER BY 1, 2, 4, 5
LIMIT :row_limit`;
}

function scopeOf(query: TimelineQuery): [string, string] {
  const scopes = Object.values(TimelineScope).filter(
    (scope) => query[scope] !== undefined,
  );
  assert.equal(
    scopes.length,
    ONE_SCOPE,
    "a timeline query holds exactly one scope",
  );
  const scope = scopes[0]!;
  return [SCOPE_COLUMNS[scope], query[scope]!];
}

function numberOrNull(value: unknown): number | null {
  return value === null ? null : Number(value);
}

function textOrNull(value: unknown): string | null {
  return value === null ? null : String(value);
}

function itemOf(row: Record<string, unknown>): TimelineItem {
  const span = spanSchema.parse({
    trace_id: row.trace_id,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    producer: row.producer,
    origin: row.origin,
    operation: row.operation,
    start_time: numberOrNull(row.start_time),
    end_time: numberOrNull(row.end_time),
    status: row.status,
    attributes: JSON.parse(String(row.attributes)),
    events: JSON.parse(String(row.events)),
    links: JSON.parse(String(row.links)),
    text_ids: JSON.parse(String(row.text_ids)),
    created_at: Number(row.created_at),
  });
  const depth = Number(row.depth);
  assert.ok(depth === TimelineDepth.Root || depth === TimelineDepth.Child);
  return {
    ...span,
    depth,
    duration_ms:
      span.start_time === null || span.end_time === null
        ? null
        : span.end_time - span.start_time,
    project_id: textOrNull(row.project_id),
    node_id: textOrNull(row.node_id),
    execution_id: textOrNull(row.execution_id),
    attempt: numberOrNull(row.attempt),
    worker_name: textOrNull(row.worker_name),
  };
}

function cursorOf(row: Record<string, unknown>): TimelineCursor {
  return {
    trace_time: Number(row.trace_time),
    trace_id: String(row.trace_id),
    item_time: Number(row.item_time),
    span_id: String(row.span_id),
  };
}

export function listTimeline(
  tx: Transaction,
  query: TimelineQuery,
  after: TimelineCursor | null,
): TimelinePage {
  const limit = query.limit ?? TIMELINE_LIMIT_DEFAULT;
  assert.ok(
    Number.isSafeInteger(limit) &&
      limit >= TIMELINE_LIMIT_MIN &&
      limit <= TIMELINE_LIMIT_MAX,
  );
  const depth = query.depth ?? TimelineDepth.Child;
  assert.ok(depth === TimelineDepth.Root || depth === TimelineDepth.Child);
  const [column, scope] = scopeOf(query);
  const cursor = after ?? NO_CURSOR;
  const rows = tx.database.prepare(statementOf(column)).all({
    scope,
    from: query.from ?? Number.MIN_SAFE_INTEGER,
    to: query.to ?? Number.MAX_SAFE_INTEGER,
    after_trace_time: cursor.trace_time,
    after_trace_id: cursor.trace_id,
    after_time: cursor.item_time,
    after_span_id: cursor.span_id,
    max_depth: depth,
    trace_limit: limit + 1,
    row_limit: ROWS_PER_ITEM_AND_END * limit + END_ROWS_EXTRA,
  });
  const items: Record<string, unknown>[] = [];
  const ends: Record<string, unknown>[] = [];
  for (const row of rows) {
    if (Number(row.depth) === TRACE_END_DEPTH) {
      ends.push(row);
      continue;
    }
    items.push(row);
    if (items.length > limit) break;
  }
  if (items.length > limit) {
    const page = items.slice(0, limit);
    return { items: page.map(itemOf), next_cursor: cursorOf(page[limit - 1]!) };
  }
  const lastEnd = ends.at(-1);
  return {
    items: items.map(itemOf),
    next_cursor:
      ends.length > limit && lastEnd !== undefined ? cursorOf(lastEnd) : null,
  };
}
