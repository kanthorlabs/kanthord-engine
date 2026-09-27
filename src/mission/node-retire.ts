import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { importAdmissible, isTerminal } from "./admission.ts";
import { TASKS_FIELD, validateText } from "./content.ts";
import {
  EdgeKind,
  MissionErrorCode,
  NodeKind,
  RevisionWrite,
  TaskChange,
  type Edge,
  type HumanActor,
  type NodeChange,
  type Retire,
  type RetirePreview,
  type Revision,
  type WorkQueue,
} from "./contract.ts";
import { requireNode } from "./node-read.ts";
import { revisionFromRow } from "./revision.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  deleteDependency,
  incrementMissionVersion,
  insertRevision,
  readCurrentRevision,
  readDependencies,
  readMissionNodes,
  type NodeRow,
} from "./store.ts";
import { requireActive, requireMission } from "./write.ts";

const COUNTER_INCREMENT = 1;
const UPDATED_NODE_COUNT = 1;
const FIRST_NODE = 0;
const REASON_FIELD = "reason";
type DependencyEdge = Extract<Edge, { kind: typeof EdgeKind.Dependency }>;

function retirementSet(tx: Transaction, node: NodeRow): NodeRow[] {
  const nodes = readMissionNodes(tx, node.mission_id).filter(
    (item) => item.retired_at === null,
  );
  const children = new Map<string, NodeRow[]>();
  for (const child of nodes) {
    if (child.parent_id === null) continue;
    const siblings = children.get(child.parent_id) ?? [];
    siblings.push(child);
    children.set(child.parent_id, siblings);
  }
  const pending = [node];
  const ids = new Set([node.id]);
  for (
    let index = FIRST_NODE;
    index < pending.length && index < nodes.length;
    index++
  ) {
    const parent = pending[index]!;
    const descendants = children.get(parent.id) ?? [];
    for (const child of descendants) {
      assert.ok(!ids.has(child.id), "Containment must be acyclic.");
      ids.add(child.id);
      pending.push(child);
    }
  }
  assert.ok(
    pending.length <= nodes.length,
    "Retirement stays within the current mission.",
  );
  return [
    node,
    ...nodes.filter((item) => item.id !== node.id && ids.has(item.id)),
  ];
}

function checkRetirement(tx: Transaction, node: NodeRow): void {
  assert.equal(node.retired_at, null, "Only current nodes enter retirement.");
  if (node.kind === NodeKind.Task)
    assert.ok(node.parent_id, "A task has an objective parent.");
  const checked =
    node.kind === NodeKind.Task ? requireNode(tx, node.parent_id!) : node;
  assert.notEqual(
    checked.kind,
    NodeKind.Task,
    "Retirement checks a runnable owner.",
  );
  if (!importAdmissible(checked.state, checked.attempt))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetireRefused,
      "Node cannot be retired.",
      { nodeId: checked.id, state: checked.state, attempt: checked.attempt },
    );
}

function removedDependencies(
  tx: Transaction,
  missionId: string,
  ids: Set<string>,
  force: boolean,
): DependencyEdge[] {
  const nodes = new Map(
    readMissionNodes(tx, missionId).map((node) => [node.id, node]),
  );
  const removed: DependencyEdge[] = [];
  for (const edge of readDependencies(tx, missionId)) {
    if (!ids.has(edge.dependsOn) || ids.has(edge.dependent)) continue;
    const dependent = nodes.get(edge.dependent);
    assert.ok(dependent, "Dependency source exists in its mission.");
    assert.equal(
      dependent.retired_at,
      null,
      "Inbound dependent must be current.",
    );
    if (isTerminal(dependent.state)) continue;
    removed.push({
      kind: EdgeKind.Dependency,
      dependentId: edge.dependent,
      dependsOnId: edge.dependsOn,
    });
  }
  if (!force && removed.length)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetireHasDependents,
      "Node has nonterminal dependents.",
      {
        dependents: [
          ...new Set(removed.map((edge) => edge.dependentId)),
        ].sort(),
      },
    );
  return removed;
}

export function planRetirement(
  tx: Transaction,
  node: NodeRow,
  force: boolean,
): RetirePreview {
  requireActive(node);
  const mission = requireMission(tx, node.mission_id);
  const nodes = retirementSet(tx, node);
  assert.equal(nodes[FIRST_NODE]?.id, node.id, "Named node is checked first.");
  for (const retiring of nodes) checkRetirement(tx, retiring);
  const retiredNodeIds = nodes.map((item) => item.id).sort();
  assert.ok(
    retiredNodeIds.includes(node.id),
    "Retirement includes the named node.",
  );
  const removedEdges = removedDependencies(
    tx,
    mission.id,
    new Set(retiredNodeIds),
    force,
  );
  const preview = {
    nodeId: node.id,
    force,
    missionVersion: mission.version,
    retiredNodeIds,
    removedEdges,
  };
  return { ...preview, previewDigest: digest(preview) };
}

function retireTasks(
  tx: Transaction,
  objectiveId: string,
  retiredIds: Set<string>,
  reason: string,
  actor: HumanActor,
  now: number,
): Revision {
  const row = readCurrentRevision(tx, objectiveId);
  assert.ok(row, "Surviving objective has a current revision.");
  const previous = revisionFromRow(row);
  assert.ok(previous.tasks, "Objective revision contains tasks.");
  const retired = previous.tasks.filter((task) => retiredIds.has(task.id));
  assert.ok(retired.length, "Affected objective loses at least one task.");
  const revision: Revision = {
    ...previous,
    revision: previous.revision + COUNTER_INCREMENT,
    reason,
    actor,
    createdAt: now,
    pinnedByAttempts: [],
    tasks: previous.tasks.filter((task) => !retiredIds.has(task.id)),
    change: {
      write: RevisionWrite.NodeRetire,
      previousRevision: previous.revision,
      changedFields: [TASKS_FIELD],
      tasks: retired.map((task) => ({
        id: task.id,
        change: TaskChange.Retired,
        changedFields: [],
      })),
    },
  };
  insertRevision(tx, revision);
  return revision;
}

function retireRows(
  tx: Transaction,
  ids: Set<string>,
  reason: string,
  actor: HumanActor,
): Revision[] {
  const now = Date.now();
  const objectives = new Set<string>();
  for (const id of ids) {
    const node = requireNode(tx, id);
    if (node.kind === NodeKind.Task) {
      assert.ok(node.parent_id, "Retired task has an objective parent.");
      if (!ids.has(node.parent_id)) objectives.add(node.parent_id);
    }
    const result = tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(now, id);
    assert.equal(
      result.changes,
      UPDATED_NODE_COUNT,
      "Retirement retains and marks one node.",
    );
  }
  return [...objectives]
    .sort()
    .map((id) => retireTasks(tx, id, ids, reason, actor, now));
}

export function retireNode(
  tx: Transaction,
  nodeId: string,
  body: Retire,
  actor: HumanActor,
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
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  const plan = planRetirement(tx, node, body.force);
  if (body.previewDigest !== plan.previewDigest)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetireMismatch,
      "Retirement preview changed.",
    );
  const before = claimableMap(tx, mission.id);
  for (const edge of plan.removedEdges) {
    assert.equal(
      edge.kind,
      EdgeKind.Dependency,
      "Retirement removes only dependency edges.",
    );
    if (edge.kind === EdgeKind.Dependency)
      deleteDependency(tx, edge.dependentId, edge.dependsOnId);
  }
  const revisions = retireRows(
    tx,
    new Set(plan.retiredNodeIds),
    body.reason,
    actor,
  );
  routeMission(tx, mission.id);
  reconcileMission(tx, workQueue, mission.id, mission.projectId, before);
  const missionVersion = incrementMissionVersion(tx, mission.id);
  assert.equal(
    missionVersion,
    mission.version + COUNTER_INCREMENT,
    "Retirement increments mission once.",
  );
  assert.equal(plan.nodeId, node.id, "Applied plan belongs to the named node.");
  return {
    missionVersion,
    revisions,
    retiredNodeIds: plan.retiredNodeIds,
    addedEdges: [],
    removedEdges: plan.removedEdges,
    openAttemptsUnchanged: [],
  };
}
