import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AssessmentResult,
  NodeKind,
  NodeState,
  type Actor,
  type HumanActor,
  type HumanAct,
  type Mission,
  type ControlResult,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import { currentAssessmentOf } from "./currency.ts";
import { requireNode, nodeRecord } from "./node-read.ts";
import { attemptRecord, outcomeRecord } from "./record-read.ts";
import {
  closeAttempt,
  readAttempt,
  readOpenAttempt,
  readRequests,
  readLandedCommitEvidence,
  insertAssessment,
  insertOutcome,
  type OutcomeRow,
} from "./record-store.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import { readCurrentRevision, setNodeState, type NodeRow } from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";
import { validateText } from "./content.ts";

const NO_ATTEMPT = 0;
const NO_REQUIREMENT_KEYS = 0;
export const ControlError = {
  Task: "mission.node.control_task",
  Refused: "mission.node.control_refused",
  Unresolved: "mission.node.action_unresolved",
  StateConflict: "mission.node.state_conflict",
} as const;

export function requireRunnable(node: NodeRow): void {
  if (node.kind === NodeKind.Task)
    throw new OperationError(
      HttpStatus.BadRequest,
      ControlError.Task,
      "Task nodes have no controls or execution records.",
      { nodeId: node.id },
    );
  assert.ok(node.state);
  assert.ok(node.attempt !== null);
}

export function stateConflict(node: NodeRow): never {
  throw new OperationError(
    HttpStatus.Conflict,
    ControlError.StateConflict,
    "Node state or attempt changed.",
    { state: node.state, attempt: node.attempt },
  );
}

export function requireControlState(
  node: NodeRow,
  admitted: readonly NodeState[],
): void {
  assert.ok(node.state);
  assert.ok(node.attempt !== null);
  if (!admitted.includes(node.state))
    throw new OperationError(
      HttpStatus.Conflict,
      ControlError.Refused,
      "Control is not admitted in this state.",
      { state: node.state },
    );
}

export function admitControl(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: HumanAct,
  admitted: readonly NodeState[],
  now: number,
) {
  const initial = requireNode(tx, nodeId);
  requireActive(initial);
  requireRunnable(initial);
  const mission = requireMission(
    tx,
    initial.mission_id,
    body.expectedMissionVersion,
  );
  dependencies.schedulerClaims.settle(tx, nodeId, now);
  const node = requireNode(tx, nodeId);
  requireNonterminal(node);
  if (
    node.state !== body.expectedState ||
    node.attempt !== body.expectedAttempt
  )
    stateConflict(node);
  requireControlState(node, admitted);
  validateText("reason", body.reason, dependencies.config.textMaxBytes);
  return { node, mission };
}

export function requireNoUnresolvedAction(
  tx: Transaction,
  node: NodeRow,
): void {
  assert.ok(node.attempt !== null);
  assert.notEqual(node.kind, NodeKind.Task);
  const open =
    node.attempt === NO_ATTEMPT ? null : readOpenAttempt(tx, node.id);
  if (open === null) return;
  const requirementKeys = readRequests(tx, node.id, open.attempt)
    .filter((row) => row.end_state === null)
    .map((row) => row.requirement_key!);
  if (requirementKeys.length > NO_REQUIREMENT_KEYS)
    throw new OperationError(
      HttpStatus.Conflict,
      ControlError.Unresolved,
      "The attempt has unresolved external actions.",
      { requirementKeys },
    );
}

export function actRevision(tx: Transaction, node: NodeRow): number {
  assert.ok(node.attempt !== null);
  const revision =
    node.attempt === NO_ATTEMPT
      ? readCurrentRevision(tx, node.id)?.revision
      : readAttempt(tx, node.id, node.attempt)?.node_revision;
  assert.ok(revision);
  return revision;
}

export function writeHumanRecords(
  tx: Transaction,
  node: NodeRow,
  result: AssessmentResult,
  rationale: string,
  actor: HumanActor,
  outcomeEvidenceIds: string[],
  now: number,
): OutcomeRow {
  assert.ok(node.attempt !== null);
  assert.notEqual(node.kind, NodeKind.Task);
  const assessment = insertAssessment(tx, {
    id: createIdentity("assessment"),
    node_id: node.id,
    attempt: node.attempt,
    result,
    rationale,
    evidence_ids: "[]",
    child_outcome_ids: "[]",
    tested_input: null,
    execution_id: null,
    actor: canonicalJSON(actor),
    node_revision: actRevision(tx, node),
    created_at: now,
  });
  return insertOutcome(tx, {
    id: createIdentity("outcome"),
    node_id: node.id,
    result,
    assessment_id: assessment.id,
    evidence_ids: canonicalJSON(outcomeEvidenceIds),
    created_at: now,
  });
}

export function endLiveClaim(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  now: number,
): void {
  assert.notEqual(node.kind, NodeKind.Task);
  assert.ok(tx.database.isTransaction);
  if (node.state === NodeState.Executing || node.state === NodeState.Evaluating)
    dependencies.schedulerClaims.revoke(tx, node.id, now);
}

export function transition(
  tx: Transaction,
  dependencies: Dependencies,
  mission: Mission,
  node: NodeRow,
  state: NodeState,
  now: number,
): void {
  assert.equal(node.mission_id, mission.id);
  assert.ok(Number.isSafeInteger(now));
  const before = claimableMap(tx, mission.id, dependencies.bindings);
  if (before.get(node.id)) dependencies.workQueue.delete(tx, node.id);
  before.set(node.id, false);
  setNodeState(tx, node.id, state);
  routeMission(tx, mission.id);
  reconcileMission(
    tx,
    dependencies.workQueue,
    mission.id,
    mission.projectId,
    before,
    dependencies.bindings,
  );
}

export function controlResult(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  outcome: OutcomeRow | null,
  actor: Actor,
  now: number,
): ControlResult {
  const node = requireNode(tx, nodeId);
  assert.ok(node.attempt !== null);
  const attempt =
    node.attempt === NO_ATTEMPT ? null : readAttempt(tx, nodeId, node.attempt);
  assert.ok(attempt !== null || node.attempt === NO_ATTEMPT);
  return {
    node: nodeRecord(tx, node, dependencies.bindings),
    attempt:
      attempt === null
        ? null
        : attemptRecord(tx, dependencies.bindings, attempt),
    outcome:
      outcome === null
        ? null
        : outcomeRecord(tx, dependencies.bindings, outcome),
    actor,
    acceptedAt: now,
  };
}

export function closeExternalAttempt(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  now: number,
): OutcomeRow | null {
  if (
    node.state !== NodeState.ExternalSuccess &&
    node.state !== NodeState.ExternalFailed
  )
    return null;
  assert.ok(node.attempt !== null && node.attempt > NO_ATTEMPT);
  const assessment = currentAssessmentOf(tx, node.id, node.attempt);
  if (assessment?.result !== AssessmentResult.Success) return null;
  assert.ok(readOpenAttempt(tx, node.id));
  closeAttempt(tx, node.id, node.attempt, now);
  const result =
    node.state === NodeState.ExternalSuccess
      ? AssessmentResult.Success
      : AssessmentResult.Undetermined;
  const outcome = insertOutcome(tx, {
    id: createIdentity("outcome"),
    node_id: node.id,
    result,
    assessment_id: assessment.id,
    evidence_ids: canonicalJSON(
      readLandedCommitEvidence(tx, node.id, node.attempt).map((row) => row.id),
    ),
    created_at: now,
  });
  transition(
    tx,
    dependencies,
    requireMission(tx, node.mission_id),
    node,
    result === AssessmentResult.Success
      ? NodeState.Completed
      : NodeState.Blocked,
    now,
  );
  return outcome;
}
