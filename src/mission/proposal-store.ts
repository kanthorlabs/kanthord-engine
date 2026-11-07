import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { NodeState } from "./contract.ts";

const EXPECTED_ROW_CHANGE = 1;

export interface ProposalRow {
  id: string;
  node_id: string;
  attempt: number;
  assessment_id: string | null;
  content: string;
  created_node_id: string | null;
  approved_at: number | null;
  rejected_at: number | null;
  created_at: number;
}

export function insertProposal(tx: Transaction, row: ProposalRow): void {
  assert.ok(tx.database.isTransaction);
  assert.equal(row.created_node_id, null);
  assert.equal(row.approved_at, null);
  assert.equal(row.rejected_at, null);
  tx.database
    .prepare(
      "INSERT INTO mission_proposal (id, node_id, attempt, assessment_id, content, created_node_id, approved_at, rejected_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      row.node_id,
      row.attempt,
      row.assessment_id,
      row.content,
      row.created_node_id,
      row.approved_at,
      row.rejected_at,
      row.created_at,
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

export function listProposalsOfAssessment(
  tx: Transaction,
  assessmentId: string,
): ProposalRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_proposal WHERE assessment_id = ? ORDER BY id",
    )
    .all(assessmentId) as unknown as ProposalRow[];
}

export function markProposalsRejected(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  rejectedAt: number,
): string[] {
  assert.ok(tx.database.isTransaction);
  const rows = tx.database
    .prepare(
      "UPDATE mission_proposal SET rejected_at = ? WHERE node_id = ? AND attempt = ? AND approved_at IS NULL AND rejected_at IS NULL RETURNING id",
    )
    .all(rejectedAt, nodeId, attempt) as unknown as { id: string }[];
  return rows.map((row) => row.id).sort();
}

export function markProposalApproved(
  tx: Transaction,
  id: string,
  createdNodeId: string,
  approvedAt: number,
): void {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      "UPDATE mission_proposal SET created_node_id = ?, approved_at = ? WHERE id = ? AND approved_at IS NULL AND rejected_at IS NULL",
    )
    .run(createdNodeId, approvedAt, id);
  assert.equal(result.changes, EXPECTED_ROW_CHANGE);
}

export function listTerminalNodesLinking(
  tx: Transaction,
  missionId: string,
  externalLink: string,
): { id: string; attempt: number }[] {
  return tx.database
    .prepare(
      `SELECT n.id, n.attempt FROM mission_node n
       JOIN mission_node_revision r ON r.node_id = n.id
         AND r.revision = (
           SELECT MAX(latest.revision) FROM mission_node_revision latest
           WHERE latest.node_id = n.id
         )
       WHERE n.mission_id = ? AND n.retired_at IS NULL AND n.state IN (?, ?)
         AND EXISTS (
           SELECT 1 FROM json_each(r.external_links) link WHERE link.value = ?
         )
       ORDER BY n.id`,
    )
    .all(
      missionId,
      NodeState.Completed,
      NodeState.Discarded,
      externalLink,
    ) as unknown as { id: string; attempt: number }[];
}

export function holdsFollowupLink(tx: Transaction, nodeId: string): boolean {
  const row = tx.database
    .prepare(
      `SELECT 1 FROM mission_proposal p
       WHERE p.node_id = ? AND p.assessment_id IS NULL AND (
         (p.approved_at IS NULL AND p.rejected_at IS NULL)
         OR EXISTS (
           SELECT 1 FROM mission_node created
           WHERE created.id = p.created_node_id AND created.retired_at IS NULL
         ))`,
    )
    .get(nodeId);
  return row !== undefined;
}
