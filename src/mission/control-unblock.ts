import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  type Content,
  type ExecutionEnds,
  type HumanActor,
  MissionErrorCode,
  NodeState,
  type Revision,
  RevisionWrite,
  StartPoint,
  type Unblock,
  type UnblockChange,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import { ContentField, TASKS_FIELD, validateText } from "./content.ts";
import { guardEnvironmentMix } from "./environment-mix.ts";
import { requireNode } from "./node-read.ts";
import { resolveContent, resolveTasks } from "./node-create.ts";
import { requireIntentUnlocked } from "./node-update.ts";
import {
  actedOn,
  controlResult,
  requireControlState,
  requireRunnable,
  settleClaim,
  stateConflict,
  transition,
} from "./control.ts";
import { openAttempt } from "./record-store.ts";
import { revisionFromRow } from "./revision.ts";
import { requireActive, requireMission, requireNonterminal } from "./write.ts";
import {
  incrementMissionVersion,
  insertRevision,
  type NodeRow,
  readCurrentRevision,
} from "./store.ts";

const NO_CHANGED_FIELDS = 0;
const NO_ATTEMPT = 0;
const REVISION_INCREMENT = 1;
const REASON = "reason";

const CONTENT_KEYS = [
  ContentField.Name,
  ContentField.Requirement,
  ContentField.Criterion,
  ContentField.Verifications,
  ContentField.Bindings,
  ContentField.Intent,
  ContentField.Tags,
  ContentField.CommitType,
] as const;

function contentChanges(current: Content, previous: Content): string[] {
  return CONTENT_KEYS.filter(
    (key) =>
      canonicalJSON(current[key] ?? null) !==
      canonicalJSON(previous[key] ?? null),
  );
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
  validateText(REASON, change.reason, dependencies.config.text_max_bytes);
  const content = resolveContent(
    tx,
    dependencies.bindings,
    projectId,
    {
      filename: node.filename,
      content: change.content,
      reason: change.reason,
    },
    dependencies.config.text_max_bytes,
  );
  requireIntentUnlocked(node, previous.content.intent, content.intent);
  const tasks = resolveTasks(
    tx,
    { ...node, intent: content.intent },
    node.filename,
    change.tasks,
    previous.tasks,
    dependencies.config.text_max_bytes,
  );
  const changedFields = contentChanges(content, previous.content);
  if (tasks.changes.length > NO_CHANGED_FIELDS) changedFields.push(TASKS_FIELD);
  if (changedFields.length === NO_CHANGED_FIELDS) return previous.revision;
  guardEnvironmentMix(tx, dependencies, projectId, content.bindings);
  const revision = previous.revision + REVISION_INCREMENT;
  assert.ok(Number.isSafeInteger(revision));
  insertRevision(tx, {
    ...previous,
    revision,
    content,
    tasks: tasks.tasks,
    reason: change.reason,
    actor,
    created_at: now,
    pinned_by_attempts: [],
    change: {
      write: RevisionWrite.Unblock,
      previous_revision: previous.revision,
      changed_fields: changedFields,
      tasks: tasks.changes,
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
  ends: ExecutionEnds,
) {
  const initial = requireNode(tx, nodeId);
  requireActive(initial);
  requireRunnable(initial);
  const mission = requireMission(
    tx,
    initial.mission_id,
    body.expected_mission_version,
  );
  settleClaim(tx, dependencies.schedulerClaims, nodeId, now, ends);
  const node = requireNode(tx, nodeId);
  requireNonterminal(node);
  if (node.attempt !== body.blocked_attempt) stateConflict(node);
  requireControlState(node, [NodeState.Blocked]);
  if (body.reason !== undefined)
    validateText(REASON, body.reason, dependencies.config.text_max_bytes);
  const row = readCurrentRevision(tx, nodeId);
  assert.ok(row && node.attempt !== null);
  if (row.revision !== body.expected_revision)
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
          mission.project_id,
          revisionFromRow(tx, row),
          body.change,
          actor,
          now,
        );
  if (node.attempt > NO_ATTEMPT)
    openAttempt(
      tx,
      nodeId,
      revision,
      actor,
      now,
      body.start_point ?? StartPoint.NodeBranch,
    );
  transition(tx, dependencies, mission, node, NodeState.Available, now);
  return actedOn(
    tx,
    mission,
    node,
    body.reason ?? null,
    now,
    controlResult(tx, dependencies, nodeId, null, actor, now),
    null,
  );
}
