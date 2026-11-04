import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { CleanupRefusal, type OwnerDeleteAnswer } from "../kernel/cleanup.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  type CandidatePage,
  type CandidateQuery,
  CleanupRule,
  DAY_MS,
  DEFAULT_AGE_DAYS,
  emptyMeasure,
  failedMeasure,
  FOOTPRINT_SCAN_BUDGET_MS,
  FootprintKind,
  type FootprintMeasure,
  type FootprintOwner,
  type FootprintTable,
  olderThanCutoff,
} from "../footprint/contract.ts";
import { TraceState } from "./contract.ts";

const WAL_SUFFIX = "-wal";
const FILE_NOT_FOUND = "ENOENT";
const ROLLUP_ROW = "rollup";
const ROLLUP_TABLES = [
  "tracking_flow_rollup",
  "tracking_flow_histogram",
  "tracking_usage_rollup",
];
const TRACE_TABLE = "tracking_trace";
const NO_CHANGES = 0;
const TRACE_DELETE_OPERATION = "tracking.trace.delete";
const TRACE_UNMEASURED = "tracking.footprint.unmeasured";

interface TraceTotals {
  count: number;
  oldest: number | null;
  newest: number | null;
  recent: number;
}

interface TraceRow {
  trace_id: string;
  created_at: number;
  state: string;
  project_id: string | null;
  node_id: string | null;
  execution_id: string | null;
}

export interface TrackingFootprintDependencies {
  readonly store: Store;
  readonly path: string;
  readonly now?: () => number;
}

async function walBytes(path: string): Promise<number> {
  try {
    return (await stat(`${path}${WAL_SUFFIX}`)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === FILE_NOT_FOUND) return 0;
    throw error;
  }
}

export function deleteTraces(
  tx: Transaction,
  traceIds: readonly string[],
): OwnerDeleteAnswer {
  const answer: OwnerDeleteAnswer = { removed: 0, absent: 0, refused: [] };
  const remove = tx.database.prepare(
    "DELETE FROM tracking_trace WHERE trace_id = ? AND state != ?",
  );
  const exists = tx.database.prepare(
    "SELECT 1 AS found FROM tracking_trace WHERE trace_id = ?",
  );
  for (const traceId of traceIds) {
    if (Number(remove.run(traceId, TraceState.Open).changes) > NO_CHANGES)
      answer.removed += 1;
    else if (exists.get(traceId) === undefined) answer.absent += 1;
    else answer.refused.push({ key: traceId, reason: CleanupRefusal.Live });
  }
  return answer;
}

export class TrackingFootprint implements FootprintOwner {
  readonly kinds: readonly FootprintKind[] = [FootprintKind.Trace];
  private readonly dependencies: TrackingFootprintDependencies;
  private readonly now: () => number;

  constructor(dependencies: TrackingFootprintDependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
  }

  async measure(): Promise<FootprintMeasure[]> {
    const { store, path } = this.dependencies;
    try {
      const pages = store.pages();
      const since = this.now() - DEFAULT_AGE_DAYS * DAY_MS;
      const totals = store.transaction(
        (tx) =>
          tx.database
            .prepare(
              "SELECT COUNT(*) AS count, MIN(created_at) AS oldest, MAX(created_at) AS newest, COALESCE(SUM(created_at >= ?), 0) AS recent FROM tracking_trace",
            )
            .get(since) as unknown as TraceTotals,
      );
      return [
        emptyMeasure(FootprintKind.Trace, {
          device: String((await stat(dirname(path), { bigint: true })).dev),
          count: Number(totals.count),
          bytes: (pages.page_count - pages.freelist_count) * pages.page_size,
          free_bytes: pages.freelist_count * pages.page_size,
          wal_bytes: await walBytes(path),
          oldest_at: totals.oldest,
          newest_at: totals.newest,
          recent_count: Number(totals.recent),
        }),
      ];
    } catch (error) {
      return [
        failedMeasure(
          FootprintKind.Trace,
          TRACE_UNMEASURED,
          error instanceof Error ? error.message : String(error),
        ),
      ];
    }
  }

  candidates(query: CandidateQuery): Promise<CandidatePage> {
    const cutoff = olderThanCutoff(query.rule, query.now);
    if (query.rule !== null && query.rule.name !== CleanupRule.OlderThan)
      return Promise.resolve({ items: [], total_count: 0, total_bytes: null });
    const all = query.rule === null;
    return Promise.resolve(
      this.dependencies.store.transaction((tx) => {
        const filter = all ? "" : "WHERE created_at < ? AND state != ?";
        const parameters = all ? [] : [cutoff!, TraceState.Open];
        const total = tx.database
          .prepare(`SELECT COUNT(*) AS count FROM tracking_trace ${filter}`)
          .get(...parameters) as { count: number };
        const rows = tx.database
          .prepare(
            `SELECT trace_id, created_at, state, project_id, node_id, execution_id FROM tracking_trace ${filter} ORDER BY created_at, trace_id LIMIT ? OFFSET ?`,
          )
          .all(
            ...parameters,
            query.limit,
            query.offset,
          ) as unknown as TraceRow[];
        return {
          items: rows.map((row) => ({
            key: row.trace_id,
            at: row.created_at,
            bytes: null,
            project_id: row.project_id,
            node_id: row.node_id,
            execution_id: row.execution_id,
            refusal: row.state === TraceState.Open ? CleanupRefusal.Live : null,
            kept: false,
          })),
          total_count: Number(total.count),
          total_bytes: null,
        };
      }),
    );
  }

  async tables(
    kind: FootprintKind,
    signal: AbortSignal,
  ): Promise<FootprintTable[] | null> {
    if (kind !== FootprintKind.Trace) return null;
    const { store } = this.dependencies;
    const started = performance.now();
    const inBudget = () =>
      performance.now() - started < FOOTPRINT_SCAN_BUDGET_MS;
    const tables: FootprintTable[] = [];
    let rollupBytes: number | null = 0;
    for (const name of store.tableNames()) {
      signal.throwIfAborted();
      const bytes = inBudget() ? store.treeBytes(name) : null;
      if (ROLLUP_TABLES.includes(name))
        rollupBytes =
          rollupBytes === null || bytes === null ? null : rollupBytes + bytes;
      else
        tables.push({
          name,
          bytes,
          oldest_at: null,
          delete_operation:
            name === TRACE_TABLE ? TRACE_DELETE_OPERATION : null,
        });
      await yieldTurn();
    }
    const oldest = store.transaction((tx) => {
      const row = tx.database
        .prepare(
          `SELECT MIN(bucket) AS oldest FROM (${ROLLUP_TABLES.map((table) => `SELECT MIN(bucket_start) AS bucket FROM ${table}`).join(" UNION ALL ")})`,
        )
        .get() as { oldest: number | null };
      return row.oldest;
    });
    tables.push({
      name: ROLLUP_ROW,
      bytes: rollupBytes,
      oldest_at: oldest,
      delete_operation: null,
    });
    return tables;
  }
}
