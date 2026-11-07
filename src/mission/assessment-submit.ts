import assert from "node:assert/strict";
import { CauseCategory } from "../kernel/cause.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  type AssessmentSubmit,
  type ExecutionEnds,
  FINDING_IDENTITY_PREFIX,
  FindingAction,
  FindingRoute,
  type FindingSubmit,
  type GateFiles,
  Intent,
  NodeState,
  PROPOSAL_IDENTITY_PREFIX,
  RevokeCause,
  TransitionRule,
} from "./contract.ts";
import { admitAssessment } from "./assessment-admit.ts";
import {
  endLiveClaim,
  nodeTransition,
  requireNoUnresolvedAction,
  transition,
} from "./control.ts";
import { currencyOf } from "./currency.ts";
import { admitExecution, requireEvaluationClaim } from "./execution.ts";
import { requiredActionsOf } from "./frozen-action.ts";
import { nodeRecord, requireNode } from "./node-read.ts";
import { kindOfLabel } from "./finding-admit.ts";
import {
  insertFinding,
  markEarlierReportFindingsFixed,
  markFindingsFixed,
  routeOpenFixFindings,
} from "./finding-store.ts";
import { insertProposal } from "./proposal-store.ts";
import { assessmentRecord, outcomeRecord } from "./record-read.ts";
import {
  closeAttempt,
  insertAssessment,
  insertOutcome,
  type OutcomeRow,
  readAssessmentRound,
  readLandedCommitEvidence,
  readRequests,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import { requireMission } from "./write.ts";

const NO_REQUIRED_ACTIONS = 0;
const NO_REQUESTS = 0;
const NO_GATE_FILE_ENTRIES = 0;
const NO_ACTION_ITEMS = 0;
const FIRST_ROUND = 1;

function routeOf(
  finding: FindingSubmit,
  current: boolean,
  reworkDue: boolean,
  intent: Intent,
): FindingRoute {
  if (finding.action === FindingAction.No || !current)
    return FindingRoute.Record;
  if (!reworkDue) return FindingRoute.Report;
  return intent === Intent.Implement ? FindingRoute.Fix : FindingRoute.Record;
}

export function submitAssessment(
  tx: Transaction,
  dependencies: Dependencies,
  claim: ExecutionClaim,
  nodeId: string,
  body: AssessmentSubmit,
  gateFiles: GateFiles,
  now: number,
  ends: ExecutionEnds,
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
  const open = admitAssessment(tx, dependencies, node, attempt, revision, body);
  const assessment = insertAssessment(tx, {
    id: createIdentity("assessment"),
    node_id: node.id,
    attempt: attempt.attempt,
    result: body.result,
    rationale: body.rationale,
    evidence_ids: canonicalJSON(body.evidence_ids),
    dependency_outcome_ids: canonicalJSON(body.dependency_outcome_ids),
    tested_input: canonicalJSON(body.tested_input),
    gate_files:
      gateFiles.length === NO_GATE_FILE_ENTRIES
        ? null
        : canonicalJSON(gateFiles),
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
  const round = readAssessmentRound(tx, assessment);
  assert.ok(round !== null);
  const reworks = round - FIRST_ROUND;
  const requested =
    readRequests(tx, node.id, attempt.attempt).length > NO_REQUESTS;
  const reworkLimit = dependencies.config.rework_limit;
  const planDefect = current && body.cause?.category === CauseCategory.Plan;
  const intent = revision.content.intent;
  const listed = new Set(body.fixed_finding_ids);
  const actionItems =
    body.findings.filter((finding) => finding.action === FindingAction.Yes)
      .length + open.filter((row) => !listed.has(row.id)).length;
  const reworkDue =
    current &&
    !requested &&
    !planDefect &&
    reworks < reworkLimit &&
    (body.result === AssessmentResult.CriterionNotMet ||
      (body.result === AssessmentResult.Success &&
        intent === Intent.Implement &&
        actionItems > NO_ACTION_ITEMS));
  const limited = planDefect
    ? { rule: TransitionRule.PlanDefect, count: null, limit: null }
    : body.result === AssessmentResult.CriterionNotMet && !requested
      ? {
          rule: TransitionRule.ReworkLimit,
          count: reworks,
          limit: reworkLimit,
        }
      : null;
  for (const finding of body.findings)
    insertFinding(tx, {
      id: createIdentity(FINDING_IDENTITY_PREFIX),
      node_id: node.id,
      assessment_id: assessment.id,
      label: finding.label,
      kind: kindOfLabel(finding.label),
      action: finding.action,
      task_id: finding.task_id,
      ground: finding.ground,
      name: finding.name,
      description: finding.description,
      fix: finding.fix,
      why: finding.why,
      route: routeOf(finding, current, reworkDue, intent),
      fixed_assessment_id: null,
      cause_owner: null,
      created_by: null,
      decision: null,
      decision_reason: null,
      decided_by: null,
      decided_at: null,
    });
  if (current) markFindingsFixed(tx, body.fixed_finding_ids, assessment.id);
  if (
    current &&
    body.result === AssessmentResult.Success &&
    intent === Intent.Implement
  )
    markEarlierReportFindingsFixed(tx, node.id, attempt.attempt, assessment.id);
  if (current && !reworkDue)
    routeOpenFixFindings(tx, node.id, attempt.attempt, FindingRoute.Report);
  if (reworkDue) {
    const revoked = endLiveClaim(
      tx,
      dependencies,
      node,
      now,
      RevokeCause.Assessment,
      body.cause ?? null,
      ends,
      null,
    );
    transition(
      tx,
      dependencies,
      requireMission(tx, node.mission_id),
      node,
      NodeState.Available,
      now,
    );
    if (revoked !== null)
      revoked.transition = nodeTransition(
        tx,
        dependencies.workQueue,
        node.id,
        node.state,
        null,
      );
  } else if (
    current &&
    (body.result !== AssessmentResult.Success ||
      actions.length === NO_REQUIRED_ACTIONS)
  ) {
    if (body.result === AssessmentResult.Success)
      requireNoUnresolvedAction(tx, node);
    const revoked = endLiveClaim(
      tx,
      dependencies,
      node,
      now,
      RevokeCause.Assessment,
      body.cause ?? null,
      ends,
      null,
    );
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
    for (const proposal of body.proposals)
      insertProposal(tx, {
        id: createIdentity(PROPOSAL_IDENTITY_PREFIX),
        node_id: node.id,
        attempt: attempt.attempt,
        assessment_id: assessment.id,
        content: canonicalJSON(proposal),
        created_node_id: null,
        approved_at: null,
        rejected_at: null,
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
    if (revoked !== null)
      revoked.transition = nodeTransition(
        tx,
        dependencies.workQueue,
        node.id,
        node.state,
        limited,
      );
  }
  assert.equal(assessment.node_id, node.id);
  assert.equal(assessment.execution_id, claim.executionId);
  return {
    assessment: assessmentRecord(tx, dependencies, assessment),
    node: nodeRecord(
      tx,
      requireNode(tx, node.id),
      dependencies.bindings,
      dependencies,
    ),
    outcome:
      outcome === null
        ? null
        : outcomeRecord(tx, dependencies.bindings, outcome),
  };
}
