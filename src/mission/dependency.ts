import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { validateText } from "./content.ts";
import {
  MissionErrorCode,
  NodeState,
  type Edge,
  type GraphEdit,
  type Mission,
  type NodeChange,
  type WorkQueue,
  type MissionBindings,
  type SchedulerClaims,
} from "./contract.ts";
import { stateConflict } from "./control.ts";
import { requireNode } from "./node-read.ts";
import { readOpenAttempt, readRequests } from "./record-store.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  dependencyReaches,
  deleteDependency,
  hasDependency,
  incrementMissionVersion,
  insertDependency,
  type NodeRow,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const REASON_FIELD = "reason";
const VERSION_INCREMENT = 1;
const NO_REQUESTS = 0;
const EndpointReason = {
  CrossMission: "cross_mission",
} as const;
const DEPENDENCY_GUARDED_STATES: ReadonlySet<string | null> = new Set([
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.ExternalRequested,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
]);

export function dependencyEditGuarded(
  tx: Transaction,
  node: NodeRow,
  adding: boolean,
): boolean {
  if (DEPENDENCY_GUARDED_STATES.has(node.state)) return true;
  if (!adding || node.state !== NodeState.Paused) return false;
  const open = readOpenAttempt(tx, node.id);
  return (
    open !== null &&
    readRequests(tx, node.id, open.attempt).length > NO_REQUESTS
  );
}

function validateEndpoints(node: NodeRow, target: NodeRow): void {
  const reason =
    node.mission_id !== target.mission_id
      ? EndpointReason.CrossMission
      : undefined;
  if (reason !== undefined)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.EndpointInvalid,
      "Dependency endpoints are invalid.",
      { reason, node_id: node.id, depends_on_id: target.id },
    );
}

function validateCycle(tx: Transaction, missionId: string, edge: Edge): void {
  if (dependencyReaches(tx, missionId, edge.depends_on_id, edge.dependent_id))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Cycle,
      "Dependency creates a cycle.",
    );
}

function emptyChange(missionVersion: number): NodeChange {
  return {
    mission_version: missionVersion,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
  };
}

function applyDependency(
  tx: Transaction,
  mission: Mission,
  edge: Edge,
  workQueue: WorkQueue,
  adding: boolean,
  bindings: MissionBindings,
): NodeChange {
  const before = claimableMap(tx, mission.id, bindings);
  if (adding)
    insertDependency(tx, mission.id, edge.dependent_id, edge.depends_on_id);
  else deleteDependency(tx, edge.dependent_id, edge.depends_on_id);
  routeMission(tx, mission.id);
  reconcileMission(
    tx,
    workQueue,
    mission.id,
    mission.project_id,
    before,
    bindings,
  );
  const missionVersion = incrementMissionVersion(tx, mission.id);
  assert.equal(
    missionVersion,
    mission.version + VERSION_INCREMENT,
    "A dependency edit increments the mission once.",
  );
  assert.equal(
    hasDependency(tx, edge.dependent_id, edge.depends_on_id),
    adding,
    "The dependency edit is visible in the write transaction.",
  );
  return {
    ...emptyChange(missionVersion),
    added_edges: adding ? [edge] : [],
    removed_edges: adding ? [] : [edge],
  };
}

export function addDependency(
  tx: Transaction,
  nodeId: string,
  dependsOnId: string,
  body: GraphEdit,
  workQueue: WorkQueue,
  textMaxBytes: number,
  bindings: MissionBindings,
  schedulerClaims: SchedulerClaims,
): NodeChange {
  const node = requireNode(tx, nodeId);
  const target = requireNode(tx, dependsOnId);
  requireActive(node);
  requireActive(target);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expected_mission_version,
  );
  validateEndpoints(node, target);
  requireNonterminal(node);
  if (dependencyEditGuarded(tx, node, true)) stateConflict(node);
  requireNoLiveClaim(tx, nodeId, schedulerClaims, Date.now());
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  if (hasDependency(tx, nodeId, dependsOnId))
    return emptyChange(mission.version);
  const edge = { dependent_id: nodeId, depends_on_id: dependsOnId };
  validateCycle(tx, mission.id, edge);
  return applyDependency(tx, mission, edge, workQueue, true, bindings);
}

export function requireNoLiveClaim(
  tx: Transaction,
  nodeId: string,
  claims: SchedulerClaims,
  now: number,
): void {
  claims.settle(tx, nodeId, now);
  const live = claims.liveExecutionOf(tx, nodeId, now);
  if (live !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.ClaimLive,
      "The dependent has a live claim.",
      { node_id: nodeId, execution_id: live.execution_id },
    );
}

export function removeDependency(
  tx: Transaction,
  nodeId: string,
  dependsOnId: string,
  body: GraphEdit,
  workQueue: WorkQueue,
  textMaxBytes: number,
  bindings: MissionBindings,
): NodeChange {
  const node = requireNode(tx, nodeId);
  requireActive(node);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expected_mission_version,
  );
  requireNonterminal(node);
  if (dependencyEditGuarded(tx, node, false)) stateConflict(node);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  if (!hasDependency(tx, nodeId, dependsOnId))
    return emptyChange(mission.version);
  const edge = { dependent_id: nodeId, depends_on_id: dependsOnId };
  return applyDependency(tx, mission, edge, workQueue, false, bindings);
}
