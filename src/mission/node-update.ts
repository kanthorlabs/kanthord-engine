import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { CONTENT_FIELDS, TASKS_FIELD, ContentField } from "./content.ts";
import {
  MissionErrorCode,
  NodeKind,
  RevisionWrite,
  TaskChange,
  type Content,
  type HumanActor,
  type MissionBindings,
  type NodeChange,
  type NodeUpdate,
  type Revision,
} from "./contract.ts";
import { resolveContent } from "./node-create.ts";
import { requireNode } from "./node-read.ts";
import { revisionFromRow } from "./revision.ts";
import {
  filenameConflict,
  filenameTaken,
  incrementMissionVersion,
  insertRevision,
  readCurrentRevision,
  readRevision,
  updateNodeFilename,
  type NodeRow,
} from "./store.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";

const REVISION_INCREMENT = 1;
const NO_CHANGED_FIELDS = 0;

function contentOwner(tx: Transaction, node: NodeRow): NodeRow {
  if (node.kind !== NodeKind.Task) {
    requireNonterminal(node);
    return node;
  }
  assert.ok(node.parent_id, "Task must have an objective parent.");
  const owner = requireNode(tx, node.parent_id);
  assert.equal(
    owner.kind,
    NodeKind.Objective,
    "Task owner must be an objective.",
  );
  requireActive(owner);
  requireNonterminal(owner);
  return owner;
}

function changedFields(
  filename: string,
  content: Content,
  previousFilename: string,
  previousContent: Content,
): string[] {
  const changed = new Set<string>();
  if (filename !== previousFilename) changed.add(ContentField.Filename);
  for (const field of CONTENT_FIELDS) {
    if (field === ContentField.Filename) continue;
    const key = field as keyof Content;
    if (JSON.stringify(content[key]) !== JSON.stringify(previousContent[key]))
      changed.add(field);
  }
  return CONTENT_FIELDS.filter((field) => changed.has(field));
}

function updatedRevision(
  previous: Revision,
  node: NodeRow,
  body: NodeUpdate,
  content: Content,
  fields: string[],
  actor: HumanActor,
): Revision {
  const common = {
    ...previous,
    revision: previous.revision + REVISION_INCREMENT,
    reason: body.reason,
    actor,
    createdAt: Date.now(),
    pinnedByAttempts: [],
  };
  if (node.kind !== NodeKind.Task)
    return {
      ...common,
      filename: body.filename,
      content,
      change: {
        write: RevisionWrite.NodeUpdate,
        previousRevision: previous.revision,
        changedFields: fields,
        ...(node.kind === NodeKind.Objective ? { tasks: [] } : {}),
      },
    };
  assert.ok(previous.tasks, "Objective revision must contain tasks.");
  assert.ok(
    previous.tasks.some((task) => task.id === node.id),
    "Task must be in objective revision.",
  );
  return {
    ...common,
    tasks: previous.tasks.map((task) =>
      task.id === node.id
        ? { id: task.id, filename: body.filename, content }
        : task,
    ),
    change: {
      write: RevisionWrite.NodeUpdate,
      previousRevision: previous.revision,
      changedFields: [TASKS_FIELD],
      tasks: [
        { id: node.id, change: TaskChange.Updated, changedFields: fields },
      ],
    },
  };
}

export function updateNode(
  tx: Transaction,
  nodeId: string,
  body: NodeUpdate,
  actor: HumanActor,
  bindings: MissionBindings,
  textMaxBytes: number,
): NodeChange {
  const node = requireNode(tx, nodeId);
  requireActive(node);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expectedMissionVersion,
  );
  const owner = contentOwner(tx, node);
  const current = readCurrentRevision(tx, owner.id);
  assert.ok(current, "Content owner must have a revision.");
  assert.equal(
    current.node_id,
    owner.id,
    "Revision must belong to content owner.",
  );
  if (current.revision !== body.expectedRevision)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RevisionConflict,
      "Node revision changed.",
      { current: current.revision },
    );
  const previous = revisionFromRow(current);
  const content = resolveContent(
    tx,
    bindings,
    mission.projectId,
    {
      ...body,
      kind: node.kind,
    },
    textMaxBytes,
  );
  const task =
    node.kind === NodeKind.Task
      ? previous.tasks?.find((item) => item.id === node.id)
      : undefined;
  if (node.kind === NodeKind.Task)
    assert.ok(task, "Task must exist in objective revision.");
  const fields = changedFields(
    body.filename,
    content,
    task?.filename ?? previous.filename,
    task?.content ?? previous.content,
  );
  const empty = {
    missionVersion: mission.version,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  };
  if (fields.length === NO_CHANGED_FIELDS) return empty;
  if (
    body.filename !== node.filename &&
    filenameTaken(tx, mission.id, body.filename)
  )
    throw filenameConflict(body.filename);
  const revision = updatedRevision(
    previous,
    node,
    body,
    content,
    fields,
    actor,
  );
  if (body.filename !== node.filename)
    updateNodeFilename(tx, node.id, body.filename);
  insertRevision(tx, revision);
  const missionVersion = incrementMissionVersion(tx, mission.id);
  const stored = readRevision(tx, owner.id, revision.revision);
  assert.ok(stored, "Updated revision must be readable.");
  assert.equal(
    missionVersion,
    mission.version + REVISION_INCREMENT,
    "Update increments mission once.",
  );
  return { ...empty, missionVersion, revisions: [revisionFromRow(stored)] };
}
