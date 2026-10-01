import assert from "node:assert/strict";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  NodeState,
  type AssessmentSubmit,
} from "./contract.ts";
import { admitAssessment } from "./assessment-admit.ts";
import {
  endLiveClaim,
  requireNoUnresolvedAction,
  transition,
} from "./control.ts";
import { currencyOf } from "./currency.ts";
import { admitExecution, requireEvaluationClaim } from "./execution.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import { nodeRecord, requireNode } from "./node-read.ts";
import { assessmentRecord, outcomeRecord } from "./record-read.ts";
import {
  closeAttempt,
  insertAssessment,
  insertOutcome,
  readLandedCommitEvidence,
  type OutcomeRow,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";

const ZERO = 0;

export function submitAssessment(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  nodeId: string,
  body: AssessmentSubmit,
  now: number,
) {
  const { node, attempt, revision } = admitExecution(
    tx,
    dependencies,
    claim,
    nodeId,
    body,
    now,
  );
  requireEvaluationClaim(node);
  admitAssessment(tx, dependencies, node, attempt, revision, body);
  const assessment = insertAssessment(tx, {
    id: createIdentity("assessment"),
    node_id: node.id,
    attempt: attempt.attempt,
    result: body.result,
    rationale: body.rationale,
    evidence_ids: canonicalJSON(body.evidenceIds),
    child_outcome_ids: canonicalJSON(body.childOutcomeIds),
    tested_input: canonicalJSON(body.testedInput),
    execution_id: claim.executionId,
    actor: null,
    node_revision: revision.revision,
    created_at: now,
  });
  const current = currencyOf(tx, assessment).current;
  const actions = requiredActionsOf(
    tx,
    dependencies.bindings,
    node.id,
    revision.revision,
  );
  let outcome: OutcomeRow | null = null;
  if (
    current &&
    (body.result !== AssessmentResult.Success || actions.length === ZERO)
  ) {
    requireNoUnresolvedAction(tx, node);
    endLiveClaim(tx, dependencies, node, now);
    closeAttempt(tx, node.id, attempt.attempt, now);
    outcome = insertOutcome(tx, {
      id: createIdentity("outcome"),
      node_id: node.id,
      result: body.result,
      assessment_id: assessment.id,
      evidence_ids: canonicalJSON(
        readLandedCommitEvidence(tx, node.id, attempt.attempt).map(
          (row) => row.id,
        ),
      ),
      created_at: now,
    });
    transition(
      tx,
      dependencies,
      requireMission(tx, node.mission_id),
      node,
      body.result === AssessmentResult.Success
        ? NodeState.Completed
        : NodeState.Blocked,
      now,
    );
  }
  assert.equal(assessment.node_id, node.id);
  assert.equal(assessment.execution_id, claim.executionId);
  return {
    assessment: assessmentRecord(tx, dependencies, assessment),
    node: nodeRecord(tx, requireNode(tx, node.id), dependencies.bindings),
    outcome:
      outcome === null
        ? null
        : outcomeRecord(tx, dependencies.bindings, outcome),
  };
}
