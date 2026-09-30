import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { isTerminal } from "./admission.ts";
import { ContentField, validateText } from "./content.ts";
import {
  MissionErrorCode,
  NodeKind,
  RebindSkipCondition,
  RevisionWrite,
  type HumanActor,
  type Mission,
  type MissionBindings,
  type Rebind,
  type RebindResult,
  type Revision,
} from "./contract.ts";
import { nodeRecord, requireNode } from "./node-read.ts";
import { revisionFromRow } from "./revision.ts";
import {
  incrementMissionVersion,
  insertRevision,
  readCurrentRevision,
  readMissionNodes,
  type NodeRow,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const REVISION_INCREMENT = 1;
const NO_REVISIONS = 0;
const REASON_FIELD = "reason";
type BindingRevision = NonNullable<
  ReturnType<MissionBindings["getBindingRevision"]>
>;

function requireTarget(
  tx: Transaction,
  mission: Mission,
  bindingId: string,
  bindings: MissionBindings,
): BindingRevision {
  const target = bindings.getBindingRevision(tx, bindingId);
  if (target === null || target.projectId !== mission.projectId)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.BindingNotFound,
      "Binding revision not found.",
    );
  if (target.tombstone)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.BindingRemoved,
      "Binding is removed.",
    );
  if (target.disabled)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.BindingDisabled,
      "Binding is disabled.",
    );
  assert.equal(
    target.bindingId,
    bindingId,
    "Target must be the requested pin.",
  );
  assert.ok(
    Number.isSafeInteger(target.revision),
    "Binding revision must be safe.",
  );
  return target;
}

function mismatch(nodeId: string, bindingId: string): never {
  throw new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.BindingMismatch,
    "Node does not pin an earlier or equal revision of this binding.",
    { nodeId, bindingId },
  );
}

function candidates(
  tx: Transaction,
  missionId: string,
  body: Rebind,
): NodeRow[] {
  if (body.nodeId === undefined)
    return readMissionNodes(tx, missionId).filter(
      (node) => node.kind !== NodeKind.Task,
    );
  const node = requireNode(tx, body.nodeId);
  if (node.mission_id !== missionId)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.NodeNotFound,
      "Mission node not found.",
    );
  requireActive(node);
  requireNonterminal(node);
  if (node.kind === NodeKind.Task) mismatch(node.id, body.bindingId);
  assert.equal(node.id, body.nodeId, "Candidate must be the requested node.");
  assert.ok(node.state, "Candidate must be runnable.");
  return [node];
}

function replacement(
  tx: Transaction,
  node: NodeRow,
  body: Rebind,
  target: BindingRevision,
  bindings: MissionBindings,
): { previous: Revision; pins: string[]; changed: boolean } {
  const row = readCurrentRevision(tx, node.id);
  assert.ok(row, "Rebind candidate must have a revision.");
  assert.equal(row.node_id, node.id, "Revision must belong to candidate.");
  const previous = revisionFromRow(row);
  let matched = false;
  let changed = false;
  const pins = previous.content.bindings.map((id) => {
    const stored = bindings.getBindingRevision(tx, id);
    if (
      stored === null ||
      stored.projectId !== target.projectId ||
      stored.resourceIdentity !== target.resourceIdentity ||
      stored.revision > target.revision
    )
      return id;
    matched = true;
    if (stored.revision === target.revision) return id;
    changed = true;
    return body.bindingId;
  });
  if (body.nodeId !== undefined && !matched) mismatch(node.id, body.bindingId);
  return { previous, pins, changed };
}

function reboundRevision(
  node: NodeRow,
  previous: Revision,
  pins: string[],
  body: Rebind,
  actor: HumanActor,
): Revision {
  assert.notEqual(node.kind, NodeKind.Task, "Tasks own no binding pins.");
  assert.equal(previous.nodeId, node.id, "Revision must belong to candidate.");
  return {
    ...previous,
    revision: previous.revision + REVISION_INCREMENT,
    content: { ...previous.content, bindings: pins },
    reason: body.reason,
    actor,
    createdAt: Date.now(),
    pinnedByAttempts: [],
    change: {
      write: RevisionWrite.NodeRebind,
      previousRevision: previous.revision,
      changedFields: [ContentField.Bindings],
      ...(node.kind === NodeKind.Objective ? { tasks: [] } : {}),
    },
  };
}

export function rebindNodes(
  tx: Transaction,
  missionId: string,
  body: Rebind,
  actor: HumanActor,
  bindings: MissionBindings,
  textMaxBytes: number,
): RebindResult {
  const mission = requireMission(tx, missionId, body.expectedMissionVersion);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  const target = requireTarget(tx, mission, body.bindingId, bindings);
  const revisions: Revision[] = [];
  const skipped: RebindResult["skipped"] = [];
  const nodes = candidates(tx, missionId, body);
  for (const node of nodes) {
    const { previous, pins, changed } = replacement(
      tx,
      node,
      body,
      target,
      bindings,
    );
    if (!changed) continue;
    const condition =
      node.retired_at !== null
        ? RebindSkipCondition.Retired
        : isTerminal(node.state)
          ? RebindSkipCondition.Terminal
          : null;
    if (condition !== null) {
      skipped.push({ node: nodeRecord(tx, node, bindings), condition });
      continue;
    }
    const revision = reboundRevision(node, previous, pins, body, actor);
    insertRevision(tx, revision);
    revisions.push(revision);
  }
  const missionVersion =
    revisions.length === NO_REVISIONS
      ? mission.version
      : incrementMissionVersion(tx, missionId);
  assert.ok(
    revisions.length <= nodes.length,
    "Each node takes at most one revision.",
  );
  assert.equal(
    missionVersion,
    mission.version +
      (revisions.length === NO_REVISIONS ? NO_REVISIONS : REVISION_INCREMENT),
    "Rebind increments mission once only when content changes.",
  );
  return {
    nodeChange: {
      missionVersion,
      revisions,
      retiredNodeIds: [],
      addedEdges: [],
      removedEdges: [],
      openAttemptsUnchanged: [],
    },
    skipped,
  };
}
