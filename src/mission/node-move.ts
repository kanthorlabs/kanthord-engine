import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { validateText } from "./content.ts";
import {
  EdgeKind,
  MissionErrorCode,
  NodeKind,
  type HumanActor,
  type Move,
  type NodeChange,
  type Revision,
  type WorkQueue,
  type MissionBindings,
} from "./contract.ts";
import { requireNode } from "./node-read.ts";
import { revisionFromRow } from "./revision.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  incrementMissionVersion,
  readCurrentRevision,
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
  if (
    node.kind === NodeKind.Initiative ||
    parent.kind !== NodeKind.Initiative ||
    parent.mission_id !== node.mission_id
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.CreateRefused,
      "Parent cannot contain this node.",
      { parent_id: parent.id, parent_kind: parent.kind },
    );
  assert.notEqual(node.id, parent.id, "Node cannot contain itself.");
  assert.equal(
    parent.mission_id,
    node.mission_id,
    "Move stays in one mission.",
  );
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
    body.expected_mission_version,
  );
  const oldParentId = node.parent_id;
  if (node.kind !== NodeKind.Initiative)
    assert.ok(oldParentId, "Movable node has a parent.");
  const oldParent = oldParentId === null ? null : requireNode(tx, oldParentId);
  requireNonterminal(node);
  const newParent = requireNode(tx, body.new_parent_id);
  requireActive(newParent);
  checkParent(node, newParent);
  currentRevision(tx, node.id, body.expected_revision);
  const oldRevision =
    oldParent === null
      ? null
      : currentRevision(tx, oldParent.id, body.expected_old_parent_revision);
  currentRevision(tx, newParent.id, body.expected_new_parent_revision);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  const empty: NodeChange = {
    mission_version: mission.version,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
  };
  if (body.new_parent_id === oldParentId) return empty;
  assert.ok(oldParentId, "A moved node must have an old parent.");
  assert.ok(oldRevision, "Old parent must have a revision.");
  const before = claimableMap(tx, mission.id, bindings);
  const result = tx.database
    .prepare("UPDATE mission_node SET parent_id = ? WHERE id = ?")
    .run(newParent.id, node.id);
  assert.equal(
    result.changes,
    UPDATED_NODE_COUNT,
    "Move updates exactly one node.",
  );
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
    mission.version + REVISION_INCREMENT,
    "Move increments mission once.",
  );
  assert.equal(
    newParent.id,
    body.new_parent_id,
    "New parent identity is stable.",
  );
  return {
    ...empty,
    mission_version: missionVersion,
    added_edges: [
      {
        kind: EdgeKind.Containment,
        parent_id: newParent.id,
        child_id: node.id,
      },
    ],
    removed_edges: [
      { kind: EdgeKind.Containment, parent_id: oldParentId, child_id: node.id },
    ],
  };
}
