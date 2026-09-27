import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { isTerminal } from "./admission.ts";
import { validateText } from "./content.ts";
import {
  EdgeKind,
  MissionErrorCode,
  NodeKind,
  type Edge,
  type GraphEdit,
  type Mission,
  type NodeChange,
  type WorkQueue,
} from "./contract.ts";
import { closureEdges, detectCycle } from "./graph.ts";
import { requireNode } from "./node-read.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  deleteDependency,
  hasDependency,
  incrementMissionVersion,
  insertDependency,
  readDependencies,
  readMissionNodes,
  type NodeRow,
} from "./store.ts";
import { requireMission } from "./write.ts";

const REASON_FIELD = "reason";
const VERSION_INCREMENT = 1;
const EndpointReason = {
  Task: "task_endpoint",
  CrossMission: "cross_mission",
} as const;
type DependencyEdge = Extract<Edge, { kind: typeof EdgeKind.Dependency }>;

function requireActive(node: NodeRow): void {
  if (node.retired_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Retired,
      "Node is retired.",
      { nodeId: node.id },
    );
}

function requireNonterminal(node: NodeRow): void {
  if (isTerminal(node.state))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Terminal,
      "Dependent node is terminal.",
      { nodeId: node.id },
    );
}

function validateEndpoints(node: NodeRow, target: NodeRow): void {
  const reason =
    node.kind === NodeKind.Task || target.kind === NodeKind.Task
      ? EndpointReason.Task
      : node.mission_id !== target.mission_id
        ? EndpointReason.CrossMission
        : undefined;
  if (reason !== undefined)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.EndpointInvalid,
      "Dependency endpoints are invalid.",
      { reason, nodeId: node.id, dependsOnId: target.id },
    );
}

function validateCycle(
  tx: Transaction,
  missionId: string,
  edge: DependencyEdge,
): void {
  const nodes = readMissionNodes(tx, missionId).filter(
    (node) => node.retired_at === null && node.kind !== NodeKind.Task,
  );
  const parents = new Map<string, string>();
  for (const node of nodes) {
    if (node.parent_id !== null) parents.set(node.id, node.parent_id);
  }
  const edges = [
    ...readDependencies(tx, missionId),
    { dependent: edge.dependentId, dependsOn: edge.dependsOnId },
  ];
  if (
    detectCycle(
      closureEdges(
        nodes.map((node) => node.id),
        edges,
        parents,
      ),
    )
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Cycle,
      "Dependency creates a cycle.",
    );
}

function emptyChange(missionVersion: number): NodeChange {
  return {
    missionVersion,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  };
}

function applyDependency(
  tx: Transaction,
  mission: Mission,
  edge: DependencyEdge,
  workQueue: WorkQueue,
  adding: boolean,
): NodeChange {
  const before = claimableMap(tx, mission.id);
  if (adding)
    insertDependency(tx, mission.id, edge.dependentId, edge.dependsOnId);
  else deleteDependency(tx, edge.dependentId, edge.dependsOnId);
  routeMission(tx, mission.id);
  reconcileMission(tx, workQueue, mission.id, mission.projectId, before);
  const missionVersion = incrementMissionVersion(tx, mission.id);
  assert.equal(
    missionVersion,
    mission.version + VERSION_INCREMENT,
    "A dependency edit increments the mission once.",
  );
  assert.equal(
    hasDependency(tx, edge.dependentId, edge.dependsOnId),
    adding,
    "The dependency edit is visible in the write transaction.",
  );
  return {
    ...emptyChange(missionVersion),
    addedEdges: adding ? [edge] : [],
    removedEdges: adding ? [] : [edge],
  };
}

export function addDependency(
  tx: Transaction,
  nodeId: string,
  dependsOnId: string,
  body: GraphEdit,
  workQueue: WorkQueue,
  textMaxBytes: number,
): NodeChange {
  const node = requireNode(tx, nodeId);
  const target = requireNode(tx, dependsOnId);
  requireActive(node);
  requireActive(target);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expectedMissionVersion,
  );
  validateEndpoints(node, target);
  requireNonterminal(node);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  if (hasDependency(tx, nodeId, dependsOnId))
    return emptyChange(mission.version);
  const edge = { kind: EdgeKind.Dependency, dependentId: nodeId, dependsOnId };
  validateCycle(tx, mission.id, edge);
  return applyDependency(tx, mission, edge, workQueue, true);
}

export function removeDependency(
  tx: Transaction,
  nodeId: string,
  dependsOnId: string,
  body: GraphEdit,
  workQueue: WorkQueue,
  textMaxBytes: number,
): NodeChange {
  const node = requireNode(tx, nodeId);
  requireActive(node);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expectedMissionVersion,
  );
  requireNonterminal(node);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  if (!hasDependency(tx, nodeId, dependsOnId))
    return emptyChange(mission.version);
  const edge = { kind: EdgeKind.Dependency, dependentId: nodeId, dependsOnId };
  return applyDependency(tx, mission, edge, workQueue, false);
}
