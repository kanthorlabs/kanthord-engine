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
  type NodeTransition,
  PROPOSAL_IDENTITY_PREFIX,
  type Revision,
  RevokeCause,
  type RevokedClaim,
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
  type PlacedFindingRow,
  routeOpenFixFindings,
} from "./finding-store.ts";
import { insertProposal } from "./proposal-store.ts";
import { assessmentRecord, outcomeRecord } from "./record-read.ts";
import {
  type AssessmentRow,
  type AttemptRow,
  closeAttempt,
  insertAssessment,
  insertOutcome,
  type OutcomeRow,
  readAssessmentRound,
  readLandedCommitEvidence,
  readRequests,
} from "./record-store.ts";
import type { Dependencies } from "./service.ts";
import type { NodeRow } from "./store.ts";
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
  proposed: ReadonlySet<string>,
): FindingRoute {
  if (
    finding.action === FindingAction.No ||
    !current ||
    proposed.has(finding.label)
  )
    return FindingRoute.Record;
  if (!reworkDue) return FindingRoute.Report;
  return intent === Intent.Implement ? FindingRoute.Fix : FindingRoute.Record;
}

type TransitionLimit = Pick<NodeTransition, "rule" | "count" | "limit"> | null;

interface SubmitScope {
  tx: Transaction;
  dependencies: Dependencies;
  claim: ExecutionClaim;
  node: NodeRow;
  attempt: AttemptRow;
  revision: Revision;
  body: AssessmentSubmit;
  gateFiles: GateFiles;
  now: number;
  ends: ExecutionEnds;
}

interface SubmitRound extends SubmitScope {
  assessment: AssessmentRow;
  current: boolean;
  reworkDue: boolean;
  limited: TransitionLimit;
  actions: readonly unknown[];
}

interface ReworkSource {
  assessment: AssessmentRow;
  open: readonly PlacedFindingRow[];
  current: boolean;
}

interface ReworkFacts {
  current: boolean;
  requested: boolean;
  planDefect: boolean;
  reworks: number;
  reworkLimit: number;
  actionItems: number;
  result: AssessmentResult;
  intent: Intent;
}

function insertSubmittedAssessment(scope: SubmitScope): AssessmentRow {
  const { claim, node, attempt, revision, body, gateFiles, now } = scope;
  return insertAssessment(scope.tx, {
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
}

function actionItemCount(
  body: AssessmentSubmit,
  open: readonly PlacedFindingRow[],
): number {
  const listed = new Set(body.fixed_finding_ids);
  return (
    body.findings.filter((finding) => finding.action === FindingAction.Yes)
      .length + open.filter((row) => !listed.has(row.id)).length
  );
}

function reworkFactsOf(scope: SubmitScope, source: ReworkSource): ReworkFacts {
  const { tx, node, attempt, body, dependencies } = scope;
  const { assessment, open, current } = source;
  const round = readAssessmentRound(tx, assessment);
  assert.ok(round !== null);
  return {
    current,
    reworks: round - FIRST_ROUND,
    requested: readRequests(tx, node.id, attempt.attempt).length > NO_REQUESTS,
    reworkLimit: dependencies.config.rework_limit,
    planDefect: current && body.cause?.category === CauseCategory.Plan,
    intent: scope.revision.content.intent,
    actionItems: actionItemCount(body, open),
    result: body.result,
  };
}

function reworkDueOf(facts: ReworkFacts): boolean {
  const implementsWithActions =
    facts.result === AssessmentResult.Success &&
    facts.intent === Intent.Implement &&
    facts.actionItems > NO_ACTION_ITEMS;
  return (
    facts.current &&
    !facts.requested &&
    !facts.planDefect &&
    facts.reworks < facts.reworkLimit &&
    (facts.result === AssessmentResult.CriterionNotMet || implementsWithActions)
  );
}

function limitedOf(facts: ReworkFacts): TransitionLimit {
  if (facts.planDefect)
    return { rule: TransitionRule.PlanDefect, count: null, limit: null };
  if (facts.result !== AssessmentResult.CriterionNotMet || facts.requested)
    return null;
  return {
    rule: TransitionRule.ReworkLimit,
    count: facts.reworks,
    limit: facts.reworkLimit,
  };
}

function insertFindings(round: SubmitRound): void {
  const { tx, node, assessment, body, current, reworkDue } = round;
  const intent = round.revision.content.intent;
  const proposed = new Set(
    body.proposals.flatMap((proposal) => proposal.finding_labels),
  );
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
      route: routeOf(finding, current, reworkDue, intent, proposed),
      fixed_assessment_id: null,
      cause_owner: null,
      created_by: null,
      decision: null,
      decision_reason: null,
      decided_by: null,
      decided_at: null,
    });
}

function settleFindings(round: SubmitRound): void {
  const { tx, node, attempt, assessment, body, current, reworkDue } = round;
  if (current) markFindingsFixed(tx, body.fixed_finding_ids, assessment.id);
  if (
    current &&
    body.result === AssessmentResult.Success &&
    round.revision.content.intent === Intent.Implement
  )
    markEarlierReportFindingsFixed(tx, node.id, attempt.attempt, assessment.id);
  if (current && !reworkDue)
    routeOpenFixFindings(tx, node.id, attempt.attempt, FindingRoute.Report);
}

function endAssessmentClaim(round: SubmitRound): RevokedClaim | null {
  const { tx, dependencies, node, now, body, ends } = round;
  return endLiveClaim(
    tx,
    dependencies,
    node,
    now,
    RevokeCause.Assessment,
    body.cause ?? null,
    ends,
    null,
  );
}

function reworkNode(round: SubmitRound): void {
  const { tx, dependencies, node, now } = round;
  const revoked = endAssessmentClaim(round);
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
}

function insertProposals(round: SubmitRound): void {
  const { tx, node, attempt, assessment, now } = round;
  for (const proposal of round.body.proposals)
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
}

function closeNode(round: SubmitRound): OutcomeRow {
  const { tx, dependencies, node, attempt, assessment, body, now } = round;
  if (body.result === AssessmentResult.Success)
    requireNoUnresolvedAction(tx, node);
  const revoked = endAssessmentClaim(round);
  closeAttempt(tx, node.id, attempt.attempt, now);
  const outcome = insertOutcome(tx, {
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
  insertProposals(round);
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
      round.limited,
    );
  return outcome;
}

function closesNode(round: SubmitRound): boolean {
  return (
    round.current &&
    (round.body.result !== AssessmentResult.Success ||
      round.actions.length === NO_REQUIRED_ACTIONS)
  );
}

function applyRound(round: SubmitRound): OutcomeRow | null {
  insertFindings(round);
  settleFindings(round);
  if (round.reworkDue) {
    reworkNode(round);
    return null;
  }
  return closesNode(round) ? closeNode(round) : null;
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
  const scope: SubmitScope = {
    tx,
    dependencies,
    claim,
    node,
    attempt,
    revision,
    body,
    gateFiles,
    now,
    ends,
  };
  const assessment = insertSubmittedAssessment(scope);
  const current = currencyOf(tx, assessment).current;
  const actions = requiredActionsOf(
    tx,
    dependencies.bindings,
    node.id,
    revision.revision,
  );
  const facts = reworkFactsOf(scope, { assessment, open, current });
  const outcome = applyRound({
    ...scope,
    assessment,
    current,
    actions,
    reworkDue: reworkDueOf(facts),
    limited: limitedOf(facts),
  });
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
