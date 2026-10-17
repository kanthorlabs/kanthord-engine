import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { parentCreateAdmissible } from "./admission.ts";
import {
  CONTENT_FIELDS,
  ContentField,
  TASKS_FIELD,
  checkBindingRuleTable,
  validateFilename,
  validateNodeContent,
  validateText,
} from "./content.ts";
import {
  EdgeKind,
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  NodeKind,
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
  readCurrentRevision,
  readNode,
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
const Field = {
  ParentId: "parent_id",
  ExpectedParentRevision: "expected_parent_revision",
  Reason: "reason",
} as const;

function invalidField(field: string): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.ContentInvalid,
    "Invalid parent field.",
    { field },
  );
}

function invalidTasks(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.ContentInvalid,
    "Invalid node tasks.",
    { field: TASKS_FIELD },
  );
}

function requireParent(
  tx: Transaction,
  missionId: string,
  body: NodeCreate,
): void {
  if (body.kind === NodeKind.Initiative) {
    if (
      body.parent_id !== undefined ||
      body.expected_parent_revision !== undefined
    )
      invalidField(Field.ParentId);
    return;
  }
  if (body.parent_id === undefined) invalidField(Field.ParentId);
  if (body.expected_parent_revision === undefined)
    invalidField(Field.ExpectedParentRevision);
  const parent = readNode(tx, body.parent_id);
  if (!parent)
    throw new OperationError(
      HttpStatus.NotFound,
      MissionErrorCode.NodeNotFound,
      "Parent node not found.",
    );
  if (parent.retired_at !== null)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.Retired,
      "Parent node is retired.",
      { node_id: parent.id },
    );
  if (parent.mission_id !== missionId || parent.kind !== NodeKind.Initiative)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.CreateRefused,
      "Parent cannot contain this node.",
      { parent_id: parent.id, parent_kind: parent.kind },
    );
  if (!parentCreateAdmissible(parent.state))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.CreateRefused,
      "Parent state refuses creation.",
      { state: parent.state },
    );
  const current = readCurrentRevision(tx, parent.id);
  assert.ok(current, "A content owner must have a revision.");
  assert.equal(
    current.node_id,
    parent.id,
    "Parent revision must belong to the parent.",
  );
  if (current.revision !== body.expected_parent_revision)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RevisionConflict,
      "Parent revision changed.",
      { current: current.revision },
    );
}

export function resolveContent(
  tx: Transaction,
  bindings: MissionBindings,
  projectId: string,
  body: Pick<NodeCreate, "filename" | "kind" | "content" | "reason">,
  textMaxBytes: number,
): Content {
  validateFilename(body.filename);
  validateNodeContent(body.kind, body.content, textMaxBytes);
  validateText(Field.Reason, body.reason, textMaxBytes);
  const resolved = body.content.bindings.map((bindingId) => {
    const binding = bindings.resolveBindingIdentity(tx, projectId, bindingId);
    if (!binding)
      throw new OperationError(
        HttpStatus.BadRequest,
        MissionErrorCode.BindingsInvalid,
        "Binding identity could not be resolved.",
        { binding: bindingId },
      );
    return binding;
  });
  checkBindingRuleTable(body.kind, resolved);
  return {
    ...body.content,
    bindings: resolved.map((binding) => binding.binding_id),
  };
}

export function resolveTasks(
  tx: Transaction,
  owner: { id: string | null; mission_id: string; kind: NodeKind },
  filename: string,
  writes: TaskWrite[],
  current: TaskContent[],
  textMaxBytes: number,
): { tasks: TaskContent[]; changes: TaskChangeEntry[] } {
  if (owner.kind === NodeKind.Initiative && writes.length > NO_TASKS)
    invalidTasks();
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
    validateNodeContent(owner.kind, write.content, textMaxBytes);
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
          changed_fields: [...CONTENT_FIELDS],
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
  const objective = body.kind === NodeKind.Objective;
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
      changed_fields: objective
        ? [...CONTENT_FIELDS, TASKS_FIELD]
        : [...CONTENT_FIELDS],
      ...(objective ? { tasks: changes } : {}),
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
  requireParent(tx, missionId, body);
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
    { id: null, mission_id: missionId, kind: body.kind },
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
    kind: body.kind,
    filename: body.filename,
    parent_id: body.parent_id ?? null,
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
    added_edges:
      body.parent_id === undefined
        ? []
        : [
            {
              kind: EdgeKind.Containment,
              parent_id: body.parent_id,
              child_id: nodeId,
            },
          ],
    removed_edges: [],
    open_attempts_unchanged: openAttemptsOf(tx, [stored.node_id]),
  };
}
