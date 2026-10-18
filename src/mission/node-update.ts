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
  RevisionWrite,
  type Content,
  type CriterionSet,
  type HumanActor,
  type Mission,
  type MissionBindings,
  type NodeChange,
  type NodeUpdate,
  type Revision,
  type RevisionChange,
  type TaskContent,
  type Intent,
} from "./contract.ts";
import { resolveContent, resolveTasks } from "./node-create.ts";
import { requireNode } from "./node-read.ts";
import { revisionFromRow } from "./revision.ts";
import { openAttemptsOf } from "./store.ts";
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
const NO_ATTEMPT = 0;
const REASON_FIELD = "reason";
const CRITERION_FIELDS = [ContentField.Criterion, ContentField.Verifications];

type EditBody = Pick<
  NodeUpdate,
  "reason" | "expected_mission_version" | "expected_revision"
>;
type EditContext = {
  node: NodeRow;
  mission: Mission;
  previous: Revision;
};
type TaskEdit = {
  tasks: TaskContent[];
  changes: NonNullable<RevisionChange["tasks"]>;
};

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
    body.expected_mission_version,
  );
  requireNonterminal(node);
  const current = readCurrentRevision(tx, node.id);
  assert.ok(current, "Node must have a revision.");
  assert.equal(current.node_id, node.id, "Revision must belong to the node.");
  if (current.revision !== body.expected_revision)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RevisionConflict,
      "Node revision changed.",
      { current: current.revision },
    );
  return { node, mission, previous: revisionFromRow(tx, current) };
}

export function requireIntentUnlocked(
  node: NodeRow,
  previous: Intent,
  next: Intent,
): void {
  if (previous !== next && node.attempt > NO_ATTEMPT)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.IntentLocked,
      "Node intent cannot change after the first claim.",
      { node_id: node.id, attempt: node.attempt },
    );
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
  tasks: TaskEdit,
  fields: string[],
  write: RevisionWrite,
  actor: HumanActor,
): Revision {
  const { previous } = context;
  return {
    ...previous,
    revision: previous.revision + REVISION_INCREMENT,
    reason: body.reason,
    actor,
    created_at: Date.now(),
    pinned_by_attempts: [],
    filename,
    content,
    tasks: tasks.tasks,
    change: {
      write,
      previous_revision: previous.revision,
      changed_fields: fields,
      tasks: tasks.changes,
    },
  };
}

function finishEdit(
  tx: Transaction,
  context: EditContext,
  body: EditBody,
  filename: string,
  content: Content,
  tasks: TaskEdit,
  candidates: readonly string[],
  write: RevisionWrite,
  actor: HumanActor,
): NodeChange {
  const { node, mission, previous } = context;
  const fields = changedFields(filename, content, previous, candidates);
  if (tasks.changes.length > NO_CHANGED_FIELDS) fields.push(TASKS_FIELD);
  const empty = {
    mission_version: mission.version,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
  };
  if (fields.length === NO_CHANGED_FIELDS) return empty;
  if (filename !== node.filename && filenameTaken(tx, mission.id, filename))
    throw filenameConflict(filename);
  const revision = updatedRevision(
    context,
    body,
    filename,
    content,
    tasks,
    fields,
    write,
    actor,
  );
  if (filename !== node.filename) updateNodeFilename(tx, node.id, filename);
  insertRevision(tx, revision);
  const missionVersion = incrementMissionVersion(tx, mission.id);
  const stored = readRevision(tx, node.id, revision.revision);
  assert.ok(stored, "Updated revision must be readable.");
  assert.equal(
    missionVersion,
    mission.version + REVISION_INCREMENT,
    "Update increments mission once.",
  );
  return {
    ...empty,
    mission_version: missionVersion,
    revisions: [revisionFromRow(tx, stored)],
    open_attempts_unchanged: openAttemptsOf(tx, [node.id]),
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
  const context = editContext(tx, nodeId, body);
  const content = resolveContent(
    tx,
    bindings,
    context.mission.project_id,
    body,
    textMaxBytes,
  );
  requireIntentUnlocked(
    context.node,
    context.previous.content.intent,
    content.intent,
  );
  const tasks = resolveTasks(
    tx,
    { ...context.node, intent: content.intent },
    body.filename,
    body.tasks,
    context.previous.tasks,
    textMaxBytes,
  );
  return finishEdit(
    tx,
    context,
    body,
    body.filename,
    content,
    tasks,
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
  const prior = context.previous;
  const content = {
    ...prior.content,
    criterion: body.criterion,
    verifications: body.verifications,
  };
  validateNodeContent(content, textMaxBytes);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  return finishEdit(
    tx,
    context,
    body,
    prior.filename,
    content,
    { tasks: prior.tasks, changes: [] },
    CRITERION_FIELDS,
    RevisionWrite.CriterionSet,
    actor,
  );
}
