import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  CONTENT_FIELDS,
  ContentField,
  TASKS_FIELD,
  TASK_CONTENT_FIELDS,
  resolveNodeBindings,
  validateFilename,
  validateNodeContent,
  validatePlanContent,
  validateTaskCount,
  validateText,
} from "./content.ts";
import {
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  RevisionWrite,
  TASK_IDENTITY_PREFIX,
  TaskChange,
  type Content,
  type HumanActor,
  type MissionBindings,
  type NodeChange,
  type NodeCreate,
  type Revision,
  type RevisionChange,
  type TaskContent,
  type TaskWrite,
  type Work,
  type WorkQueue,
} from "./contract.ts";
import { revisionFromRow } from "./revision.ts";
import { openAttemptsOf } from "./store.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  filenameConflict,
  filenameTaken,
  incrementMissionVersion,
  insertNode,
  insertRevision,
  readRevision,
  usedFilenames,
} from "./store.ts";
import { requireMission } from "./write.ts";

const FIRST_REVISION = 1;
const REVISION_INCREMENT = 1;
const NO_TASKS = 0;
const TASK_CONTENT_KEYS = [
  ContentField.Name,
  ContentField.Requirement,
  ContentField.Criterion,
  ContentField.Verifications,
  ContentField.Bindings,
] as const;
type TaskChangeEntry = NonNullable<RevisionChange["tasks"]>[number];
const REASON_FIELD = "reason";

function invalidTasks(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.ContentInvalid,
    "Invalid node tasks.",
    { field: TASKS_FIELD },
  );
}

export function resolveContent(
  tx: Transaction,
  bindings: MissionBindings,
  projectId: string,
  body: Pick<NodeCreate, "filename" | "content" | "reason">,
  textMaxBytes: number,
): Content {
  validateFilename(body.filename);
  const work = validateNodeContent(body.content, textMaxBytes);
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  const resolved = resolveNodeBindings(
    tx,
    (inner, project, bindingId) =>
      bindings.resolveBindingIdentity(inner, project, bindingId),
    projectId,
    work,
    body.content.bindings,
  );
  return {
    ...body.content,
    work,
    requires: (body.content.requires ?? []) as Content["requires"],
    bindings: resolved.map((binding) => binding.binding_id),
  };
}

export function resolveTasks(
  tx: Transaction,
  owner: { id: string | null; mission_id: string; work: Work },
  filename: string,
  writes: TaskWrite[],
  current: TaskContent[],
  textMaxBytes: number,
): { tasks: TaskContent[]; changes: TaskChangeEntry[] } {
  validateTaskCount(owner.work, writes.length);
  const named = writes.flatMap((write) =>
    write.id === undefined ? [] : [write.id],
  );
  if (
    new Set(named).size !== named.length ||
    named.some((id) => !current.some((task) => task.id === id))
  )
    invalidTasks();
  const used = usedFilenames(tx, owner.mission_id, owner.id);
  if (used.has(filename)) throw filenameConflict(filename);
  const names = new Set([filename]);
  const tasks = writes.map((write) => {
    validateFilename(write.filename);
    validatePlanContent(write.content, textMaxBytes);
    if (write.content.bindings.length > NO_TASKS)
      throw new OperationError(
        HttpStatus.BadRequest,
        MissionErrorCode.BindingsInvalid,
        "A task names no binding.",
        { filename: write.filename },
      );
    if (names.has(write.filename) || used.has(write.filename))
      throw filenameConflict(write.filename);
    names.add(write.filename);
    return {
      id: write.id ?? createIdentity(TASK_IDENTITY_PREFIX),
      filename: write.filename,
      content: write.content,
    };
  });
  const changes = tasks.flatMap<TaskChangeEntry>((task) => {
    const old = current.find((item) => item.id === task.id);
    if (old === undefined)
      return [
        {
          id: task.id,
          change: TaskChange.Created,
          changed_fields: [...TASK_CONTENT_FIELDS],
        },
      ];
    const fields = TASK_CONTENT_KEYS.filter(
      (key) =>
        canonicalJSON(task.content[key]) !== canonicalJSON(old.content[key]),
    ) as string[];
    if (task.filename !== old.filename) fields.unshift(ContentField.Filename);
    return fields.length === NO_TASKS
      ? []
      : [{ id: task.id, change: TaskChange.Updated, changed_fields: fields }];
  });
  const retired = current
    .filter((task) => !tasks.some((item) => item.id === task.id))
    .map<TaskChangeEntry>((task) => ({
      id: task.id,
      change: TaskChange.Retired,
      changed_fields: [],
    }));
  return { tasks, changes: [...changes, ...retired] };
}

function createdRevision(
  nodeId: string,
  body: NodeCreate,
  content: Content,
  tasks: TaskContent[],
  changes: TaskChangeEntry[],
  actor: HumanActor,
  createdAt: number,
): Revision {
  return {
    reason: body.reason,
    actor,
    created_at: createdAt,
    pinned_by_attempts: [],
    node_id: nodeId,
    filename: body.filename,
    revision: FIRST_REVISION,
    content,
    tasks,
    change: {
      write: RevisionWrite.NodeCreate,
      previous_revision: null,
      changed_fields: [...CONTENT_FIELDS, TASKS_FIELD],
      tasks: changes,
    },
  };
}

export function createNode(
  tx: Transaction,
  missionId: string,
  body: NodeCreate,
  actor: HumanActor,
  bindings: MissionBindings,
  workQueue: WorkQueue,
  textMaxBytes: number,
): NodeChange {
  const mission = requireMission(tx, missionId, body.expected_mission_version);
  const content = resolveContent(
    tx,
    bindings,
    mission.project_id,
    body,
    textMaxBytes,
  );
  if (filenameTaken(tx, missionId, body.filename))
    throw filenameConflict(body.filename);
  const { tasks, changes } = resolveTasks(
    tx,
    { id: null, mission_id: missionId, work: content.work },
    body.filename,
    body.tasks,
    [],
    textMaxBytes,
  );
  const before = claimableMap(tx, missionId, bindings);
  const nodeId = createIdentity(NODE_IDENTITY_PREFIX);
  const createdAt = Date.now();
  insertNode(tx, {
    id: nodeId,
    mission_id: missionId,
    filename: body.filename,
    created_at: createdAt,
  });
  const revision = createdRevision(
    nodeId,
    body,
    content,
    tasks,
    changes,
    actor,
    createdAt,
  );
  insertRevision(tx, revision);
  routeMission(tx, missionId);
  reconcileMission(
    tx,
    workQueue,
    missionId,
    mission.project_id,
    before,
    bindings,
  );
  const missionVersion = incrementMissionVersion(tx, missionId);
  const stored = readRevision(tx, revision.node_id, revision.revision);
  assert.ok(
    stored,
    "The inserted revision must be readable in the write transaction.",
  );
  assert.equal(
    missionVersion,
    mission.version + REVISION_INCREMENT,
    "A create increments the mission once.",
  );
  return {
    mission_version: missionVersion,
    revisions: [revisionFromRow(tx, stored)],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: openAttemptsOf(tx, [stored.node_id]),
  };
}
