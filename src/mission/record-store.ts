import assert from "node:assert/strict";
import { z } from "zod";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  ActorKind,
  ActorService,
  type Actor,
  type AssetKind,
  type AssessmentResult,
  type EndState,
  StartPoint,
} from "./contract.ts";
import { readNode } from "./store.ts";

const ATTEMPT_INCREMENT = 1;
const FIRST_ATTEMPT = 1;
const EXPECTED_ROW_CHANGE = 1;
const SEQUENCE_LOWER_BOUND = 0;
const stringSetSchema = z.array(z.string());

export interface AttemptRow {
  node_id: string;
  attempt: number;
  node_revision: number;
  start_point: StartPoint;
  opened_by: string;
  opened_at: number;
  closed_at: number | null;
}
export interface EvidenceRow {
  id: string;
  node_id: string;
  attempt: number;
  subject: string;
  requirement_key: string | null;
  end_state: EndState | null;
  verification: string | null;
  provenance: string;
  created_at: number;
}
export interface AssetRow {
  id: string;
  evidence_id: string;
  kind: AssetKind;
  content: string;
  published_at: number | null;
  expired_at: number | null;
}
export interface AssessmentRow {
  id: string;
  node_id: string;
  sequence: number;
  attempt: number;
  result: AssessmentResult;
  rationale: string;
  evidence_ids: string;
  dependency_outcome_ids: string;
  tested_input: string | null;
  execution_id: string | null;
  actor: string | null;
  node_revision: number;
  created_at: number;
}
export interface OutcomeRow {
  id: string;
  node_id: string;
  sequence: number;
  result: AssessmentResult;
  assessment_id: string;
  evidence_ids: string;
  created_at: number;
}

function canonicalSet(value: string): string {
  const entries = stringSetSchema.parse(JSON.parse(value));
  assert.equal(new Set(entries).size, entries.length);
  return canonicalJSON(entries.sort());
}

export function openAttempt(
  tx: Transaction,
  nodeId: string,
  nodeRevision: number,
  openedBy: Actor,
  now: number,
  startPoint: StartPoint = StartPoint.NodeBranch,
): AttemptRow {
  const node = readNode(tx, nodeId);
  assert.ok(node);
  assert.ok(
    tx.database.isTransaction &&
      Number.isSafeInteger(node.attempt + ATTEMPT_INCREMENT),
  );
  const attempt = node.attempt + ATTEMPT_INCREMENT;
  const row: AttemptRow = {
    node_id: nodeId,
    attempt,
    node_revision: nodeRevision,
    start_point: attempt === FIRST_ATTEMPT ? StartPoint.BaseBranch : startPoint,
    opened_by: canonicalJSON(openedBy),
    opened_at: now,
    closed_at: null,
  };
  tx.database
    .prepare(
      "INSERT INTO mission_attempt (node_id, attempt, node_revision, start_point, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      nodeId,
      row.attempt,
      nodeRevision,
      row.start_point,
      row.opened_by,
      now,
    );
  const result = tx.database
    .prepare("UPDATE mission_node SET attempt = ? WHERE id = ?")
    .run(row.attempt, nodeId);
  assert.equal(result.changes, EXPECTED_ROW_CHANGE);
  return row;
}

export function closeAttempt(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  now: number,
): void {
  assert.ok(tx.database.isTransaction);
  const result = tx.database
    .prepare(
      "UPDATE mission_attempt SET closed_at = ? WHERE node_id = ? AND attempt = ? AND closed_at IS NULL",
    )
    .run(now, nodeId, attempt);
  assert.equal(result.changes, EXPECTED_ROW_CHANGE);
}

export function readAttempt(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): AttemptRow | null {
  return (
    (tx.database
      .prepare(
        "SELECT * FROM mission_attempt WHERE node_id = ? AND attempt = ?",
      )
      .get(nodeId, attempt) as unknown as AttemptRow | undefined) ?? null
  );
}
export function readOpenAttempt(
  tx: Transaction,
  nodeId: string,
): AttemptRow | null {
  return (
    (tx.database
      .prepare(
        "SELECT * FROM mission_attempt WHERE node_id = ? AND closed_at IS NULL",
      )
      .get(nodeId) as unknown as AttemptRow | undefined) ?? null
  );
}
export function listAttempts(
  tx: Transaction,
  nodeId: string,
  after: number | null,
  count: number,
): AttemptRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_attempt WHERE node_id = ? AND (? IS NULL OR attempt < ?) ORDER BY attempt DESC LIMIT ?",
    )
    .all(nodeId, after, after, count) as unknown as AttemptRow[];
}
export function readBranchStartPoints(
  tx: Transaction,
  nodeIds: readonly string[],
): Map<string, number[]> {
  const rows = tx.database
    .prepare(
      "SELECT node_id, attempt FROM mission_attempt WHERE node_id IN (SELECT value FROM json_each(?)) AND start_point = ? ORDER BY node_id, attempt",
    )
    .all(canonicalJSON([...new Set(nodeIds)]), StartPoint.BaseBranch) as {
    node_id: string;
    attempt: number;
  }[];
  const starts = new Map<string, number[]>();
  for (const row of rows) {
    assert.ok(row.attempt >= FIRST_ATTEMPT);
    starts.set(row.node_id, [...(starts.get(row.node_id) ?? []), row.attempt]);
  }
  return starts;
}
export function readAttemptPins(
  tx: Transaction,
  nodeId: string,
): { attempt: number; node_revision: number }[] {
  return tx.database
    .prepare(
      "SELECT attempt, node_revision FROM mission_attempt WHERE node_id = ? ORDER BY attempt",
    )
    .all(nodeId) as unknown as { attempt: number; node_revision: number }[];
}

export function insertEvidence(
  tx: Transaction,
  row: EvidenceRow,
  assets: readonly AssetRow[],
): void {
  assert.ok(tx.database.isTransaction);
  assert.ok(assets.every((asset) => asset.evidence_id === row.id));
  tx.database
    .prepare(
      "INSERT INTO mission_evidence (id, node_id, attempt, subject, requirement_key, end_state, verification, provenance, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      row.id,
      row.node_id,
      row.attempt,
      row.subject,
      row.requirement_key,
      row.end_state,
      row.verification,
      row.provenance,
      row.created_at,
    );
  const statement = tx.database.prepare(
    "INSERT INTO mission_evidence_asset (id, evidence_id, kind, content, published_at, expired_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const asset of assets)
    statement.run(
      asset.id,
      asset.evidence_id,
      asset.kind,
      canonicalJSON(JSON.parse(asset.content)),
      asset.published_at,
      asset.expired_at,
    );
}
export function failedBindingsOf(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): string[] {
  assert.ok(tx.database.isTransaction);
  return (
    tx.database
      .prepare(
        "SELECT json_extract(a.content, '$.storage_binding_id') AS storage_binding_id FROM mission_evidence e JOIN mission_evidence_asset a ON a.evidence_id = e.id WHERE e.node_id = ? AND e.attempt = ? AND a.failed_at IS NOT NULL GROUP BY storage_binding_id ORDER BY MIN(a.failed_at), storage_binding_id",
      )
      .all(nodeId, attempt) as { storage_binding_id: string }[]
  ).map((row) => row.storage_binding_id);
}
export function readEvidence(tx: Transaction, id: string): EvidenceRow | null {
  return (
    (tx.database
      .prepare("SELECT * FROM mission_evidence WHERE id = ?")
      .get(id) as unknown as EvidenceRow | undefined) ?? null
  );
}
export function listEvidence(
  tx: Transaction,
  nodeId: string,
  attempt: number | null,
  after: string | null,
  count: number,
): EvidenceRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_evidence WHERE node_id = ? AND (? IS NULL OR attempt = ?) AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(
      nodeId,
      attempt,
      attempt,
      after,
      after,
      count,
    ) as unknown as EvidenceRow[];
}
export function readAssets(tx: Transaction, evidenceId: string): AssetRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_evidence_asset WHERE evidence_id = ? ORDER BY id",
    )
    .all(evidenceId) as unknown as AssetRow[];
}
export function deleteAsset(tx: Transaction, assetId: string): void {
  assert.ok(tx.database.isTransaction);
  const write = tx.database
    .prepare("DELETE FROM mission_evidence_asset WHERE id = ?")
    .run(assetId);
  assert.equal(write.changes, EXPECTED_ROW_CHANGE);
}
export function deleteEvidence(tx: Transaction, evidenceId: string): void {
  assert.ok(tx.database.isTransaction);
  const evidence = readEvidence(tx, evidenceId);
  assert.ok(evidence);
  for (const table of ["mission_assessment", "mission_outcome"] as const) {
    const rows = tx.database
      .prepare(`SELECT id, evidence_ids FROM ${table} WHERE node_id = ?`)
      .all(evidence.node_id) as { id: string; evidence_ids: string }[];
    for (const row of rows) {
      const ids = stringSetSchema.parse(JSON.parse(row.evidence_ids));
      if (ids.includes(evidenceId))
        tx.database
          .prepare(`UPDATE ${table} SET evidence_ids = ? WHERE id = ?`)
          .run(
            canonicalJSON(ids.filter((id) => id !== evidenceId).sort()),
            row.id,
          );
    }
  }
  tx.database
    .prepare("DELETE FROM mission_evidence_asset WHERE evidence_id = ?")
    .run(evidenceId);
  const write = tx.database
    .prepare("DELETE FROM mission_evidence WHERE id = ?")
    .run(evidenceId);
  assert.equal(write.changes, EXPECTED_ROW_CHANGE);
}
export function readRequests(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): EvidenceRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_evidence WHERE node_id = ? AND attempt = ? AND requirement_key IS NOT NULL ORDER BY requirement_key",
    )
    .all(nodeId, attempt) as unknown as EvidenceRow[];
}
export function readLandedCommitEvidence(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): EvidenceRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_evidence WHERE node_id = ? AND attempt = ? AND json_extract(provenance, '$.kind') = ? AND json_extract(provenance, '$.service') = ? ORDER BY id",
    )
    .all(
      nodeId,
      attempt,
      ActorKind.Service,
      ActorService.Mission,
    ) as unknown as EvidenceRow[];
}
export function readReleaseEvidence(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  executionId: string,
): EvidenceRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_evidence WHERE node_id = ? AND attempt = ? AND json_extract(provenance, '$.kind') = ? AND json_extract(provenance, '$.execution_id') = ? ORDER BY id",
    )
    .all(
      nodeId,
      attempt,
      ActorKind.Execution,
      executionId,
    ) as unknown as EvidenceRow[];
}

export function insertAssessment(
  tx: Transaction,
  row: Omit<AssessmentRow, "sequence">,
): AssessmentRow {
  assert.ok(tx.database.isTransaction);
  assert.notEqual(row.actor === null, row.execution_id === null);
  const sequence = (
    tx.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM mission_assessment WHERE node_id = ?",
      )
      .get(row.node_id) as { value: number }
  ).value;
  assert.ok(Number.isSafeInteger(sequence) && sequence > SEQUENCE_LOWER_BOUND);
  const stored = {
    ...row,
    sequence,
    evidence_ids: canonicalSet(row.evidence_ids),
    dependency_outcome_ids: canonicalSet(row.dependency_outcome_ids),
  };
  tx.database
    .prepare(
      "INSERT INTO mission_assessment (id, node_id, sequence, attempt, result, rationale, evidence_ids, dependency_outcome_ids, tested_input, execution_id, actor, node_revision, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      stored.id,
      stored.node_id,
      sequence,
      stored.attempt,
      stored.result,
      stored.rationale,
      stored.evidence_ids,
      stored.dependency_outcome_ids,
      stored.tested_input,
      stored.execution_id,
      stored.actor,
      stored.node_revision,
      stored.created_at,
    );
  return stored;
}
export function readAssessment(
  tx: Transaction,
  id: string,
): AssessmentRow | null {
  return (
    (tx.database
      .prepare("SELECT * FROM mission_assessment WHERE id = ?")
      .get(id) as unknown as AssessmentRow | undefined) ?? null
  );
}
export function listAssessments(
  tx: Transaction,
  nodeId: string,
  attempt: number | null,
  after: number | null,
  count: number,
): AssessmentRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_assessment WHERE node_id = ? AND (? IS NULL OR attempt = ?) AND (? IS NULL OR sequence < ?) ORDER BY sequence DESC LIMIT ?",
    )
    .all(
      nodeId,
      attempt,
      attempt,
      after,
      after,
      count,
    ) as unknown as AssessmentRow[];
}
export function readAssessmentsOfAttempt(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): AssessmentRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_assessment WHERE node_id = ? AND attempt = ? ORDER BY sequence",
    )
    .all(nodeId, attempt) as unknown as AssessmentRow[];
}

export function readExecutionAssessmentsOfAttempt(
  tx: Transaction,
  nodeId: string,
  attempt: number,
  result: AssessmentResult,
): AssessmentRow[] {
  return tx.database
    .prepare(
      "SELECT * FROM mission_assessment WHERE node_id = ? AND attempt = ? AND result = ? AND execution_id IS NOT NULL ORDER BY sequence",
    )
    .all(nodeId, attempt, result) as unknown as AssessmentRow[];
}

export function insertOutcome(
  tx: Transaction,
  row: Omit<OutcomeRow, "sequence">,
): OutcomeRow {
  assert.ok(tx.database.isTransaction);
  const basis = readAssessment(tx, row.assessment_id);
  assert.equal(basis?.node_id, row.node_id);
  const sequence = (
    tx.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS value FROM mission_outcome WHERE node_id = ?",
      )
      .get(row.node_id) as { value: number }
  ).value;
  assert.ok(Number.isSafeInteger(sequence) && sequence > SEQUENCE_LOWER_BOUND);
  const stored = {
    ...row,
    sequence,
    evidence_ids: canonicalSet(row.evidence_ids),
  };
  tx.database
    .prepare(
      "INSERT INTO mission_outcome (id, node_id, sequence, result, assessment_id, evidence_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      stored.id,
      stored.node_id,
      sequence,
      stored.result,
      stored.assessment_id,
      stored.evidence_ids,
      stored.created_at,
    );
  return stored;
}
export function readOutcome(tx: Transaction, id: string): OutcomeRow | null {
  return (
    (tx.database
      .prepare("SELECT * FROM mission_outcome WHERE id = ?")
      .get(id) as unknown as OutcomeRow | undefined) ?? null
  );
}
export function listOutcomes(
  tx: Transaction,
  nodeId: string,
  attempt: number | null,
  after: number | null,
  count: number,
): OutcomeRow[] {
  return tx.database
    .prepare(
      "SELECT o.* FROM mission_outcome o JOIN mission_assessment a ON a.id = o.assessment_id WHERE o.node_id = ? AND (? IS NULL OR a.attempt = ?) AND (? IS NULL OR o.sequence < ?) ORDER BY o.sequence DESC LIMIT ?",
    )
    .all(
      nodeId,
      attempt,
      attempt,
      after,
      after,
      count,
    ) as unknown as OutcomeRow[];
}
export function readCurrentOutcome(
  tx: Transaction,
  nodeId: string,
): OutcomeRow | null {
  return (
    (tx.database
      .prepare(
        "SELECT * FROM mission_outcome WHERE node_id = ? ORDER BY sequence DESC LIMIT 1",
      )
      .get(nodeId) as unknown as OutcomeRow | undefined) ?? null
  );
}
export function readOutcomesOfAttempt(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): OutcomeRow[] {
  return tx.database
    .prepare(
      "SELECT o.* FROM mission_outcome o JOIN mission_assessment a ON a.id = o.assessment_id WHERE o.node_id = ? AND a.attempt = ? ORDER BY o.sequence",
    )
    .all(nodeId, attempt) as unknown as OutcomeRow[];
}
