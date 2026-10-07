import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
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
  type MissionBindings,
  type SchedulerClaims,
} from "./contract.ts";
import { hasDependencyCycle } from "./graph.ts";
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
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const REASON_FIELD = "reason";
const VERSION_INCREMENT = 1;
const EndpointReason = {
  Task: "task_endpoint",
  CrossMission: "cross_mission",
} as const;
type DependencyEdge = Extract<Edge, { kind: typeof EdgeKind.Dependency }>;

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
      { reason, node_id: node.id, depends_on_id: target.id },
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
    { dependent: edge.dependent_id, depends_on: edge.depends_on_id },
  ];
  if (
    hasDependencyCycle(
      nodes.map((node) => node.id),
      edges,
      parents,
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
  edge: DependencyEdge,
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
  requireNoLiveSubtree(tx, node, schedulerClaims, Date.now());
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  if (hasDependency(tx, nodeId, dependsOnId))
    return emptyChange(mission.version);
  const edge = {
    kind: EdgeKind.Dependency,
    dependent_id: nodeId,
    depends_on_id: dependsOnId,
  };
  validateCycle(tx, mission.id, edge);
  return applyDependency(tx, mission, edge, workQueue, true, bindings);
}

export function requireNoLiveSubtree(
  tx: Transaction,
  node: NodeRow,
  claims: SchedulerClaims,
  now: number,
): void {
  const current = readMissionNodes(tx, node.mission_id).filter(
    (row) => row.retired_at === null,
  );
  const descendants = new Set([node.id]);
  for (let pass = 0; pass < current.length; pass++) {
    const before = descendants.size;
    for (const row of current)
      if (row.parent_id !== null && descendants.has(row.parent_id))
        descendants.add(row.id);
    if (before === descendants.size) break;
  }
  for (const id of descendants) {
    claims.settle(tx, id, now);
    const live = claims.liveExecutionOf(tx, id, now);
    if (live !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        MissionErrorCode.ClaimLive,
        "A node in the dependency subtree has a live claim.",
        { node_id: id, execution_id: live.execution_id },
      );
  }
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
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  if (!hasDependency(tx, nodeId, dependsOnId))
    return emptyChange(mission.version);
  const edge = {
    kind: EdgeKind.Dependency,
    dependent_id: nodeId,
    depends_on_id: dependsOnId,
  };
  return applyDependency(tx, mission, edge, workQueue, false, bindings);
}
