import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";

const EXPECTED_ROW_CHANGE = 1;

export interface ProposalRow {
  id: string;
  node_id: string;
  attempt: number;
  assessment_id: string;
  content: string;
  objective_node_id: string | null;
  approved_at: number | null;
  created_at: number;
}

export function insertProposal(tx: Transaction, row: ProposalRow): void {
  assert.ok(tx.database.isTransaction);
  assert.equal(row.objective_node_id, null);
  assert.equal(row.approved_at, null);
  tx.database
    .prepare(
      "INSERT INTO mission_proposal (id, node_id, attempt, assessment_id, content, objective_node_id, approved_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      row.node_id,
      row.attempt,
      row.assessment_id,
      row.content,
      row.objective_node_id,
      row.approved_at,
      row.created_at,
    );
}

export function readProposal(tx: Transaction, id: string): ProposalRow | null {
  return (
    (tx.database
      .prepare("SELECT * FROM mission_proposal WHERE id = ?")
      .get(id) as unknown as ProposalRow | undefined) ?? null
  );
}

export function listProposals(
  tx: Transaction,
  nodeId: string,
  attempt: number | null,
  after: string | null,
  count: number,
): ProposalRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_proposal WHERE node_id = ? AND (? IS NULL OR attempt = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(
      nodeId,
      attempt,
      attempt,
      after,
      after,
      count,
    ) as unknown as ProposalRow[];
}

export function markProposalApproved(
  tx: Transaction,
  id: string,
  objectiveNodeId: string,
  approvedAt: number,
): void {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      "UPDATE mission_proposal SET objective_node_id = ?, approved_at = ? WHERE id = ? AND approved_at IS NULL",
    )
    .run(objectiveNodeId, approvedAt, id);
  assert.equal(result.changes, EXPECTED_ROW_CHANGE);
}
