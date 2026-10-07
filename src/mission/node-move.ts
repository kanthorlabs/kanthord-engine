import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { CONTENT_FIELDS, TASKS_FIELD, validateText } from "./content.ts";
import {
  EdgeKind,
  MissionErrorCode,
  NodeKind,
  RevisionWrite,
  TaskChange,
  type HumanActor,
  type Move,
  type NodeChange,
  type Revision,
  type WorkQueue,
  type MissionBindings,
} from "./contract.ts";
import { hasDependencyCycle } from "./graph.ts";
import { requireNode } from "./node-read.ts";
import { revisionFromRow } from "./revision.ts";
import { openAttemptsOf } from "./store.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  incrementMissionVersion,
  insertRevision,
  readCurrentRevision,
  readDependencies,
  readMissionNodes,
  readRevision,
  type NodeRow,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const REVISION_INCREMENT = 1;
const UPDATED_NODE_COUNT = 1;
const REASON_FIELD = "reason";

function currentRevision(
  tx: Transaction,
  nodeId: string,
  expected: number,
): Revision {
  const row = readCurrentRevision(tx, nodeId);
  assert.ok(row, "Content owner must have a revision.");
  assert.equal(row.node_id, nodeId, "Revision belongs to its owner.");
  if (row.revision !== expected)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RevisionConflict,
      "Node revision changed.",
      { current: row.revision },
    );
  return revisionFromRow(tx, row);
}

function checkParent(node: NodeRow, parent: NodeRow): void {
  const kind =
    node.kind === NodeKind.Objective ? NodeKind.Initiative : NodeKind.Objective;
  if (
    node.kind === NodeKind.Initiative ||
    parent.kind !== kind ||
    parent.mission_id !== node.mission_id
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.CreateRefused,
      "Parent cannot contain this node.",
      { parentId: parent.id, parentKind: parent.kind },
    );
  assert.notEqual(node.id, parent.id, "Node cannot contain itself.");
  assert.equal(
    parent.mission_id,
    node.mission_id,
    "Move stays in one mission.",
  );
}

function checkCycle(tx: Transaction, missionId: string): void {
  const nodes = readMissionNodes(tx, missionId).filter(
    (node) => node.retired_at === null && node.kind !== NodeKind.Task,
  );
  const parents = new Map<string, string>();
  for (const node of nodes) {
    if (node.parent_id !== null) parents.set(node.id, node.parent_id);
  }
  if (
    hasDependencyCycle(
      nodes.map((node) => node.id),
      readDependencies(tx, missionId),
      parents,
    )
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Cycle,
      "Move creates a cycle.",
    );
}

function moveTaskRevisions(
  tx: Transaction,
  nodeId: string,
  oldRevision: Revision,
  newRevision: Revision,
  reason: string,
  actor: HumanActor,
): Revision[] {
  assert.ok(oldRevision.tasks, "Old objective must have tasks.");
  assert.ok(newRevision.tasks, "New objective must have tasks.");
  const task = oldRevision.tasks.find((item) => item.id === nodeId);
  assert.ok(task, "Moved task must be in the old objective revision.");
  assert.ok(
    !newRevision.tasks.some((item) => item.id === nodeId),
    "New objective cannot already contain task.",
  );
  const metadata = {
    reason,
    actor,
    createdAt: Date.now(),
    pinnedByAttempts: [],
  };
  const outgoing: Revision = {
    ...oldRevision,
    ...metadata,
    revision: oldRevision.revision + REVISION_INCREMENT,
    tasks: oldRevision.tasks.filter((item) => item.id !== nodeId),
    change: {
      write: RevisionWrite.NodeMove,
      previousRevision: oldRevision.revision,
      changedFields: [TASKS_FIELD],
      tasks: [{ id: nodeId, change: TaskChange.MovedOut, changedFields: [] }],
    },
  };
  const incoming: Revision = {
    ...newRevision,
    ...metadata,
    revision: newRevision.revision + REVISION_INCREMENT,
    tasks: [...newRevision.tasks, task],
    change: {
      write: RevisionWrite.NodeMove,
      previousRevision: newRevision.revision,
      changedFields: [TASKS_FIELD],
      tasks: [
        {
          id: nodeId,
          change: TaskChange.MovedIn,
          changedFields: [...CONTENT_FIELDS],
        },
      ],
    },
  };
  insertRevision(tx, outgoing);
  insertRevision(tx, incoming);
  return [outgoing, incoming].map((revision) => {
    const row = readRevision(tx, revision.nodeId, revision.revision);
    assert.ok(row, "Moved revision must be readable.");
    assert.equal(
      row.node_id,
      revision.nodeId,
      "Stored revision belongs to its owner.",
    );
    return revisionFromRow(tx, row);
  });
}

export function moveNode(
  tx: Transaction,
  nodeId: string,
  body: Move,
  actor: HumanActor,
  workQueue: WorkQueue,
  textMaxBytes: number,
  bindings: MissionBindings,
): NodeChange {
  const node = requireNode(tx, nodeId);
  requireActive(node);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expectedMissionVersion,
  );
  const oldParentId = node.parent_id;
  if (node.kind !== NodeKind.Initiative)
    assert.ok(oldParentId, "Movable node has a parent.");
  const oldParent = oldParentId === null ? null : requireNode(tx, oldParentId);
  requireNonterminal(node.kind === NodeKind.Task ? oldParent! : node);
  const newParent = requireNode(tx, body.newParentId);
  requireActive(newParent);
  checkParent(node, newParent);
  if (node.kind === NodeKind.Task) requireNonterminal(newParent);
  const ownerId = node.kind === NodeKind.Task ? oldParent!.id : node.id;
  currentRevision(tx, ownerId, body.expected_revision);
  const oldRevision =
    oldParent === null
      ? null
      : currentRevision(tx, oldParent.id, body.expectedOldParentRevision);
  const newRevision = currentRevision(
    tx,
    newParent.id,
    body.expectedNewParentRevision,
  );
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  const empty: NodeChange = {
    missionVersion: mission.version,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  };
  if (body.newParentId === oldParentId) return empty;
  assert.ok(oldParentId, "A moved node must have an old parent.");
  assert.ok(oldRevision, "Old parent must have a revision.");
  const before =
    node.kind === NodeKind.Objective
      ? claimableMap(tx, mission.id, bindings)
      : null;
  const result = tx.database
    .prepare("UPDATE mission_node SET parent_id = ? WHERE id = ?")
    .run(newParent.id, node.id);
  assert.equal(
    result.changes,
    UPDATED_NODE_COUNT,
    "Move updates exactly one node.",
  );
  const revisions =
    node.kind === NodeKind.Task
      ? moveTaskRevisions(
          tx,
          node.id,
          oldRevision,
          newRevision,
          body.reason,
          actor,
        )
      : [];
  if (before !== null) {
    checkCycle(tx, mission.id);
    routeMission(tx, mission.id);
    reconcileMission(
      tx,
      workQueue,
      mission.id,
      mission.projectId,
      before,
      bindings,
    );
  }
  const missionVersion = incrementMissionVersion(tx, mission.id);
  assert.equal(
    missionVersion,
    mission.version + REVISION_INCREMENT,
    "Move increments mission once.",
  );
  assert.equal(
    newParent.id,
    body.newParentId,
    "New parent identity is stable.",
  );
  return {
    ...empty,
    openAttemptsUnchanged: openAttemptsOf(
      tx,
      revisions.map((revision) => revision.nodeId),
    ),
    missionVersion,
    revisions,
    addedEdges: [
      { kind: EdgeKind.Containment, parentId: newParent.id, childId: node.id },
    ],
    removedEdges: [
      { kind: EdgeKind.Containment, parentId: oldParentId, childId: node.id },
    ],
  };
}
