import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  CONTENT_FIELDS,
  TASKS_FIELD,
  ContentField,
  validateNodeContent,
  validateText,
} from "./content.ts";
import {
  MissionErrorCode,
  NodeKind,
  RevisionWrite,
  TaskChange,
  type Content,
  type CriterionSet,
  type HumanActor,
  type Mission,
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
const REASON_FIELD = "reason";
const CRITERION_FIELDS = [ContentField.Criterion, ContentField.Verifications];

type EditBody = Pick<
  NodeUpdate,
  "reason" | "expectedMissionVersion" | "expectedRevision"
>;
type EditContext = {
  node: NodeRow;
  owner: NodeRow;
  mission: Mission;
  previous: Revision;
};

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

function editContext(
  tx: Transaction,
  nodeId: string,
  body: EditBody,
): EditContext {
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
  return { node, owner, mission, previous: revisionFromRow(current) };
}

function currentContent(context: EditContext): {
  filename: string;
  content: Content;
} {
  const { node, previous } = context;
  if (node.kind !== NodeKind.Task)
    return { filename: previous.filename, content: previous.content };
  assert.ok(previous.tasks, "Objective revision must contain tasks.");
  const task = previous.tasks.find((item) => item.id === node.id);
  assert.ok(task, "Task must exist in objective revision.");
  return task;
}

function changedFields(
  filename: string,
  content: Content,
  prior: { filename: string; content: Content },
  candidates: readonly string[],
): string[] {
  const changed = new Set<string>();
  if (filename !== prior.filename) changed.add(ContentField.Filename);
  for (const field of candidates) {
    if (field === ContentField.Filename) continue;
    const key = field as keyof Content;
    if (JSON.stringify(content[key]) !== JSON.stringify(prior.content[key]))
      changed.add(field);
  }
  return candidates.filter((field) => changed.has(field));
}

function updatedRevision(
  context: EditContext,
  body: EditBody,
  filename: string,
  content: Content,
  fields: string[],
  write: RevisionWrite,
  actor: HumanActor,
): Revision {
  const { previous, node } = context;
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
      filename,
      content,
      change: {
        write,
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
      task.id === node.id ? { id: task.id, filename, content } : task,
    ),
    change: {
      write,
      previousRevision: previous.revision,
      changedFields: [TASKS_FIELD],
      tasks: [
        { id: node.id, change: TaskChange.Updated, changedFields: fields },
      ],
    },
  };
}

function finishEdit(
  tx: Transaction,
  context: EditContext,
  body: EditBody,
  filename: string,
  content: Content,
  candidates: readonly string[],
  write: RevisionWrite,
  actor: HumanActor,
): NodeChange {
  const { node, owner, mission } = context;
  const fields = changedFields(
    filename,
    content,
    currentContent(context),
    candidates,
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
  if (filename !== node.filename && filenameTaken(tx, mission.id, filename))
    throw filenameConflict(filename);
  const revision = updatedRevision(
    context,
    body,
    filename,
    content,
    fields,
    write,
    actor,
  );
  if (filename !== node.filename) updateNodeFilename(tx, node.id, filename);
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

export function updateNode(
  tx: Transaction,
  nodeId: string,
  body: NodeUpdate,
  actor: HumanActor,
  bindings: MissionBindings,
  textMaxBytes: number,
): NodeChange {
  const context = editContext(tx, nodeId, body);
  const content = resolveContent(
    tx,
    bindings,
    context.mission.projectId,
    { ...body, kind: context.node.kind },
    textMaxBytes,
  );
  return finishEdit(
    tx,
    context,
    body,
    body.filename,
    content,
    CONTENT_FIELDS,
    RevisionWrite.NodeUpdate,
    actor,
  );
}

export function setCriterion(
  tx: Transaction,
  nodeId: string,
  body: CriterionSet,
  actor: HumanActor,
  textMaxBytes: number,
): NodeChange {
  const context = editContext(tx, nodeId, body);
  const prior = currentContent(context);
  const content = {
    ...prior.content,
    criterion: body.criterion,
    verifications: body.verifications,
  };
  validateNodeContent(context.node.kind, content, textMaxBytes);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  return finishEdit(
    tx,
    context,
    body,
    prior.filename,
    content,
    CRITERION_FIELDS,
    RevisionWrite.CriterionSet,
    actor,
  );
}
