import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import {
  type FindingAction,
  type FindingCauseOwner,
  type FindingDecision,
  type FindingGround,
  FindingKind,
  FindingRoute,
} from "./contract.ts";

const EXPECTED_ROW_CHANGE = 1;
const NO_LIMIT = -1;
const HUMAN_ROUND_KEY = Number.MAX_SAFE_INTEGER;

export interface FindingRow {
  id: string;
  node_id: string;
  assessment_id: string;
  label: string;
  kind: FindingKind;
  action: FindingAction;
  task_id: string | null;
  ground: FindingGround | null;
  name: string;
  description: string;
  fix: string;
  why: string;
  route: FindingRoute;
  fixed_assessment_id: string | null;
  cause_owner: FindingCauseOwner | null;
  created_by: string | null;
  decision: FindingDecision | null;
  decision_reason: string | null;
  decided_by: string | null;
  decided_at: number | null;
}

export interface PlacedFindingRow extends FindingRow {
  attempt: number;
  round: number | null;
}

export interface FindingFilter {
  attempt: number | null;
  round: number | null;
  route: FindingRoute | null;
  open: boolean;
  after: string | null;
  count: number | null;
}

export type FindingReport = Pick<
  FindingRow,
  "kind" | "task_id" | "name" | "description" | "fix" | "why" | "cause_owner"
>;

const FINDING_COLUMNS =
  "id, node_id, assessment_id, label, kind, action, task_id, ground, name, description, fix, why, route, fixed_assessment_id, cause_owner, created_by, decision, decision_reason, decided_by, decided_at";

export function insertFinding(tx: Transaction, row: FindingRow): void {
  assert.ok(tx.database.isTransaction);
  assert.equal(row.fixed_assessment_id, null);
  assert.equal(row.decision, null);
  tx.database
    .prepare(
      `INSERT INTO mission_finding (${FINDING_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.node_id,
      row.assessment_id,
      row.label,
      row.kind,
      row.action,
      row.task_id,
      row.ground,
      row.name,
      row.description,
      row.fix,
      row.why,
      row.route,
      row.fixed_assessment_id,
      row.cause_owner,
      row.created_by,
      row.decision,
      row.decision_reason,
      row.decided_by,
      row.decided_at,
    );
}

export function readFinding(tx: Transaction, id: string): FindingRow | null {
  return (
    (tx.database
      .prepare("SELECT * FROM mission_finding WHERE id = ?")
      .get(id) as unknown as FindingRow | undefined) ?? null
  );
}

export function listFindings(
  tx: Transaction,
  nodeId: string,
  filter: FindingFilter,
): PlacedFindingRow[] {
  return tx.database
    .prepare(
      `WITH rounds AS (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY node_id, attempt ORDER BY sequence) AS round
         FROM mission_assessment WHERE node_id = ? AND execution_id IS NOT NULL
       ), keyed AS (
         SELECT f.*, a.attempt AS attempt, r.round AS round,
           COALESCE(r.round, ?) AS round_key,
           CASE WHEN f.kind = ? THEN 0 ELSE 1 END AS kind_key,
           CAST(substr(f.label, 2) AS INTEGER) AS label_key
         FROM mission_finding f
         JOIN mission_assessment a ON a.id = f.assessment_id
         LEFT JOIN rounds r ON r.id = f.assessment_id AND f.created_by IS NULL
         WHERE f.node_id = ?
       )
       SELECT ${FINDING_COLUMNS}, attempt, round FROM keyed
       WHERE (? IS NULL OR attempt = ?)
         AND (? IS NULL OR round = ?)
         AND (? IS NULL OR route = ?)
         AND (? = 0 OR fixed_assessment_id IS NULL)
         AND (? IS NULL OR (round_key, kind_key, label_key, id) > (SELECT round_key, kind_key, label_key, id FROM keyed WHERE id = ?))
       ORDER BY round_key, kind_key, label_key, id
       LIMIT ?`,
    )
    .all(
      nodeId,
      HUMAN_ROUND_KEY,
      FindingKind.Blocker,
      nodeId,
      filter.attempt,
      filter.attempt,
      filter.round,
      filter.round,
      filter.route,
      filter.route,
      filter.open ? 1 : 0,
      filter.after,
      filter.after,
      filter.count ?? NO_LIMIT,
    ) as unknown as PlacedFindingRow[];
}

export function readOpenFixFindings(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): PlacedFindingRow[] {
  return listFindings(tx, nodeId, {
    attempt,
    round: null,
    route: FindingRoute.Fix,
    open: true,
    after: null,
    count: null,
  });
}

export function listUndecidedFindings(
  tx: Transaction,
  missionId: string,
  after: string | null,
  count: number,
): FindingRow[] {
  return tx.database
    .prepare(
      "SELECT f.* FROM mission_finding f JOIN mission_node n ON n.id = f.node_id WHERE n.mission_id = ? AND f.route = ? AND f.decision IS NULL AND (? IS NULL OR f.id < ?) ORDER BY f.id DESC LIMIT ?",
    )
    .all(
      missionId,
      FindingRoute.Report,
      after,
      after,
      count,
    ) as unknown as FindingRow[];
}

export function countHumanFindings(tx: Transaction, nodeId: string): number {
  return (
    tx.database
      .prepare(
        "SELECT COUNT(*) AS value FROM mission_finding WHERE node_id = ? AND created_by IS NOT NULL",
      )
      .get(nodeId) as { value: number }
  ).value;
}

export function markFindingsFixed(
  tx: Transaction,
  ids: readonly string[],
  assessmentId: string,
): void {
  assert.ok(tx.database.isTransaction);
  const statement = tx.database.prepare(
    "UPDATE mission_finding SET fixed_assessment_id = ? WHERE id = ? AND route = ? AND fixed_assessment_id IS NULL",
  );
  for (const id of ids)
    assert.equal(
      statement.run(assessmentId, id, FindingRoute.Fix).changes,
      EXPECTED_ROW_CHANGE,
    );
}

export function routeOpenFixFindings(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  route: FindingRoute,
): string[] {
  assert.ok(tx.database.isTransaction);
  assert.notEqual(route, FindingRoute.Fix);
  const rows = tx.database
    .prepare(
      "UPDATE mission_finding SET route = ? WHERE node_id = ? AND route = ? AND fixed_assessment_id IS NULL AND assessment_id IN (SELECT id FROM mission_assessment WHERE node_id = ? AND attempt = ?) RETURNING id",
    )
    .all(route, nodeId, FindingRoute.Fix, nodeId, attempt) as unknown as {
    id: string;
  }[];
  return rows.map((row) => row.id).sort();
}

export function updateFindingReport(
  tx: Transaction,
  id: string,
  report: FindingReport,
): void {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      "UPDATE mission_finding SET kind = ?, task_id = ?, name = ?, description = ?, fix = ?, why = ?, cause_owner = ? WHERE id = ? AND created_by IS NOT NULL AND decision IS NULL",
    )
    .run(
      report.kind,
      report.task_id,
      report.name,
      report.description,
      report.fix,
      report.why,
      report.cause_owner,
      id,
    );
  assert.equal(result.changes, EXPECTED_ROW_CHANGE);
}

export function writeFindingDecision(
  tx: Transaction,
  id: string,
  decision: FindingDecision,
  reason: string,
  decidedBy: string,
  decidedAt: number,
): void {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      "UPDATE mission_finding SET decision = ?, decision_reason = ?, decided_by = ?, decided_at = ? WHERE id = ? AND route = ? AND decision IS NULL",
    )
    .run(decision, reason, decidedBy, decidedAt, id, FindingRoute.Report);
  assert.equal(result.changes, EXPECTED_ROW_CHANGE);
}
