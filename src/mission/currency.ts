import assert from "node:assert/strict";
import { z } from "zod";
import type { Transaction } from "../kernel/store.ts";
import { Work, type Currency } from "./contract.ts";
import {
  readAttempt,
  readEvidence,
  readOutcome,
  readCurrentOutcome,
  readAssessmentsOfAttempt,
  type AssessmentRow,
} from "./record-store.ts";
import { directDependenciesOf } from "./graph.ts";
import {
  readDependencies,
  readNode,
  readRevision,
  type NodeRow,
} from "./store.ts";

export const CurrencyReason = {
  Context: "The assessment no longer matches its pinned context.",
  Authority: "A later human assessment supersedes authority in this attempt.",
  Order: "The assessment is not the latest admitted execution assessment.",
} as const;
const stringSet = z.array(z.string());

function dependenciesMatch(
  tx: Transaction,
  row: AssessmentRow,
  node: NodeRow,
): boolean {
  const revision = readRevision(tx, row.node_id, row.node_revision);
  assert.ok(revision, "An assessment pins a stored revision.");
  if (revision.work !== Work.Examine) return true;
  const direct = directDependenciesOf(
    node.id,
    readDependencies(tx, node.mission_id),
  );
  const outcomes = stringSet
    .parse(JSON.parse(row.dependency_outcome_ids))
    .map((id) => readOutcome(tx, id));
  const named = new Set(outcomes.map((outcome) => outcome?.node_id));
  return (
    named.size === direct.length &&
    direct.every((id) => named.has(id)) &&
    outcomes.every(
      (outcome) =>
        outcome !== null &&
        readCurrentOutcome(tx, outcome.node_id)?.id === outcome.id,
    )
  );
}

function contextMatches(tx: Transaction, row: AssessmentRow): boolean {
  const node = readNode(tx, row.node_id);
  assert.ok(node);
  const pin = readAttempt(tx, row.node_id, row.attempt);
  assert.ok(pin);
  return (
    row.node_revision === pin.node_revision &&
    stringSet
      .parse(JSON.parse(row.evidence_ids))
      .every((id) => readEvidence(tx, id)?.node_id === row.node_id) &&
    dependenciesMatch(tx, row, node)
  );
}

function checks(tx: Transaction, rows: AssessmentRow[]) {
  const humans = rows.filter((row) => row.actor !== null);
  return rows
    .filter((row) => row.execution_id !== null)
    .map((row) => ({
      row,
      contextMatches: contextMatches(tx, row),
      authorityAdmits: !humans.some((human) => human.sequence > row.sequence),
    }));
}

export function currencyOf(tx: Transaction, row: AssessmentRow): Currency {
  assert.ok(row.execution_id && row.actor === null);
  const candidates = checks(
    tx,
    readAssessmentsOfAttempt(tx, row.node_id, row.attempt),
  );
  const own = candidates.find((candidate) => candidate.row.id === row.id);
  assert.ok(own);
  const selected = candidates
    .filter(
      (candidate) => candidate.contextMatches && candidate.authorityAdmits,
    )
    .at(-1);
  const orderSelected = selected?.row.id === row.id;
  const reasons: string[] = [];
  if (!own.contextMatches) reasons.push(CurrencyReason.Context);
  if (!own.authorityAdmits) reasons.push(CurrencyReason.Authority);
  if (!orderSelected) reasons.push(CurrencyReason.Order);
  return {
    current: own.contextMatches && own.authorityAdmits && orderSelected,
    context_matches: own.contextMatches,
    authority_admits: own.authorityAdmits,
    order_selected: orderSelected,
    reasons,
  };
}

export function currentAssessmentOf(
  tx: Transaction,
  nodeId: string,
  attempt: number,
): AssessmentRow | null {
  return (
    checks(tx, readAssessmentsOfAttempt(tx, nodeId, attempt))
      .filter(
        (candidate) => candidate.contextMatches && candidate.authorityAdmits,
      )
      .at(-1)?.row ?? null
  );
}
