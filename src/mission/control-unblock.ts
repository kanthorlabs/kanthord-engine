import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MissionErrorCode,
  NodeKind,
  NodeState,
  RevisionWrite,
  TaskChange,
  type Content,
  type HumanActor,
  type Revision,
  type TaskContent,
  type Unblock,
  type UnblockChange,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import { ContentField, TASKS_FIELD, validateText } from "./content.ts";
import { requireNode } from "./node-read.ts";
import { resolveContent } from "./node-create.ts";
import {
  requireRunnable,
  requireControlState,
  stateConflict,
  transition,
  controlResult,
} from "./control.ts";
import { openAttempt } from "./record-store.ts";
import { revisionFromRow } from "./revision.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";
import {
  readCurrentRevision,
  readMissionNodes,
  insertRevision,
  incrementMissionVersion,
  updateNodeFilename,
  filenameConflict,
  type NodeRow,
} from "./store.ts";

const ZERO = 0;
const ONE = 1;
const REASON = "reason";
const TEMPORARY_FILENAME_PREFIX = "unblock:";

function renameTasks(
  tx: Transaction,
  node: NodeRow,
  tasks: TaskContent[],
): void {
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  assert.ok(tx.database.isTransaction);
  const replacing = new Set(tasks.map((task) => task.id));
  const names = new Set(
    readMissionNodes(tx, node.mission_id)
      .filter((item) => item.retired_at === null && !replacing.has(item.id))
      .map((item) => item.filename),
  );
  for (const task of tasks) {
    if (names.has(task.filename)) throw filenameConflict(task.filename);
    names.add(task.filename);
  }
  const changed = tasks.filter(
    (task) => requireNode(tx, task.id).filename !== task.filename,
  );
  for (const task of changed)
    updateNodeFilename(tx, task.id, `${TEMPORARY_FILENAME_PREFIX}${task.id}`);
  for (const task of changed) updateNodeFilename(tx, task.id, task.filename);
}
const CONTENT_KEYS = [
  ContentField.Name,
  ContentField.Requirement,
  ContentField.Criterion,
  ContentField.Verifications,
  ContentField.Bindings,
] as const;

function invalidTasks(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.ContentInvalid,
    "Unblock tasks must match the current task set.",
    { field: TASKS_FIELD },
  );
}

function contentChanges(current: Content, previous: Content): string[] {
  return CONTENT_KEYS.filter(
    (key) => canonicalJSON(current[key]) !== canonicalJSON(previous[key]),
  );
}

function tasksOfChange(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  projectId: string,
  change: UnblockChange,
): TaskContent[] | undefined {
  if (node.kind === NodeKind.Initiative) {
    if (change.tasks !== undefined) invalidTasks();
    return undefined;
  }
  const current = readMissionNodes(tx, node.mission_id).filter(
    (child) =>
      child.kind === NodeKind.Task &&
      child.parent_id === node.id &&
      child.retired_at === null,
  );
  const tasks = change.tasks;
  if (
    tasks === undefined ||
    tasks.length !== current.length ||
    new Set(tasks.map((task) => task.id)).size !== tasks.length ||
    tasks.some(
      (task) =>
        !current.some((child) => child.id === task.id) ||
        task.content.bindings.length > ZERO,
    )
  )
    invalidTasks();
  return [...tasks]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((task) => ({
      ...task,
      content: resolveContent(
        tx,
        dependencies.bindings,
        projectId,
        { ...task, kind: NodeKind.Task, reason: change.reason },
        dependencies.config.textMaxBytes,
      ),
    }));
}

function changeRevision(
  tx: Transaction,
  dependencies: Dependencies,
  node: NodeRow,
  projectId: string,
  previous: Revision,
  change: UnblockChange,
  actor: HumanActor,
  now: number,
): number {
  validateText(REASON, change.reason, dependencies.config.textMaxBytes);
  const content = resolveContent(
    tx,
    dependencies.bindings,
    projectId,
    {
      filename: node.filename,
      kind: node.kind,
      content: change.content,
      reason: change.reason,
    },
    dependencies.config.textMaxBytes,
  );
  const tasks = tasksOfChange(tx, dependencies, node, projectId, change);
  const changedFields = contentChanges(content, previous.content);
  const taskChanges = (tasks ?? []).flatMap((task) => {
    const old = previous.tasks?.find((item) => item.id === task.id);
    assert.ok(old);
    const fields = contentChanges(task.content, old.content);
    if (task.filename !== old.filename) fields.unshift(ContentField.Filename);
    return fields.length === ZERO
      ? []
      : [{ id: task.id, change: TaskChange.Updated, changedFields: fields }];
  });
  if (taskChanges.length > ZERO) changedFields.push(TASKS_FIELD);
  if (changedFields.length === ZERO) return previous.revision;
  renameTasks(tx, node, tasks ?? []);
  const revision = previous.revision + ONE;
  assert.ok(Number.isSafeInteger(revision));
  insertRevision(tx, {
    ...previous,
    revision,
    content,
    ...(tasks === undefined ? {} : { tasks }),
    reason: change.reason,
    actor,
    createdAt: now,
    pinnedByAttempts: [],
    change: {
      write: RevisionWrite.Unblock,
      previousRevision: previous.revision,
      changedFields,
      ...(tasks === undefined ? {} : { tasks: taskChanges }),
    },
  });
  incrementMissionVersion(tx, node.mission_id);
  return revision;
}

export function unblockNode(
  tx: Transaction,
  dependencies: Dependencies,
  nodeId: string,
  body: Unblock,
  actor: HumanActor,
  now: number,
) {
  const initial = requireNode(tx, nodeId);
  requireActive(initial);
  requireRunnable(initial);
  const mission = requireMission(
    tx,
    initial.mission_id,
    body.expectedMissionVersion,
  );
  dependencies.schedulerClaims.settle(tx, nodeId, now);
  const node = requireNode(tx, nodeId);
  requireNonterminal(node);
  requireControlState(node, [NodeState.Blocked]);
  if (node.attempt !== body.blockedAttempt) stateConflict(node);
  const row = readCurrentRevision(tx, nodeId);
  assert.ok(row && node.attempt !== null);
  if (row.revision !== body.expectedRevision)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RevisionConflict,
      "Node revision changed.",
      { current: row.revision },
    );
  const revision =
    body.change === undefined
      ? row.revision
      : changeRevision(
          tx,
          dependencies,
          node,
          mission.projectId,
          revisionFromRow(tx, row),
          body.change,
          actor,
          now,
        );
  if (node.attempt > ZERO) openAttempt(tx, nodeId, revision, actor, now);
  transition(tx, dependencies, mission, node, NodeState.Available, now);
  return controlResult(tx, dependencies, nodeId, null, actor, now);
}
