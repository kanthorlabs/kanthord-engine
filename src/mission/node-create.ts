import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import { parentCreateAdmissible } from "./admission.ts";
import {
  CONTENT_FIELDS,
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
  TaskChange,
  type Content,
  type HumanActor,
  type MissionBindings,
  type NodeChange,
  type NodeCreate,
  type Revision,
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
} from "./store.ts";
import { requireMission } from "./write.ts";

const FIRST_REVISION = 1;
const REVISION_INCREMENT = 1;
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

function requireParent(
  tx: Transaction,
  missionId: string,
  body: NodeCreate,
): Revision | null {
  if (body.kind === NodeKind.Initiative) {
    if (
      body.parent_id !== undefined ||
      body.expected_parent_revision !== undefined
    )
      invalidField(Field.ParentId);
    return null;
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
  const expectedKind =
    body.kind === NodeKind.Objective ? NodeKind.Initiative : NodeKind.Objective;
  if (parent.mission_id !== missionId || parent.kind !== expectedKind)
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
  return revisionFromRow(tx, current);
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

function createdRevision(
  nodeId: string,
  body: NodeCreate,
  content: Content,
  parent: Revision | null,
  actor: HumanActor,
  createdAt: number,
): Revision {
  const metadata = {
    reason: body.reason,
    actor,
    created_at: createdAt,
    pinned_by_attempts: [],
  };
  if (body.kind === NodeKind.Task) {
    assert.ok(parent, "Task creation requires an objective revision.");
    assert.ok(parent.tasks, "An objective revision must include tasks.");
    return {
      ...parent,
      ...metadata,
      revision: parent.revision + REVISION_INCREMENT,
      tasks: [
        ...parent.tasks,
        { id: nodeId, filename: body.filename, content },
      ],
      change: {
        write: RevisionWrite.NodeCreate,
        previous_revision: parent.revision,
        changed_fields: [TASKS_FIELD],
        tasks: [
          {
            id: nodeId,
            change: TaskChange.Created,
            changed_fields: [...CONTENT_FIELDS],
          },
        ],
      },
    };
  }
  const objective = body.kind === NodeKind.Objective;
  return {
    ...metadata,
    node_id: nodeId,
    filename: body.filename,
    revision: FIRST_REVISION,
    content,
    ...(objective ? { tasks: [] } : {}),
    change: {
      write: RevisionWrite.NodeCreate,
      previous_revision: null,
      changed_fields: objective
        ? [...CONTENT_FIELDS, TASKS_FIELD]
        : [...CONTENT_FIELDS],
      ...(objective ? { tasks: [] } : {}),
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
  const parent = requireParent(tx, missionId, body);
  const content = resolveContent(
    tx,
    bindings,
    mission.project_id,
    body,
    textMaxBytes,
  );
  if (filenameTaken(tx, missionId, body.filename))
    throw filenameConflict(body.filename);
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
    parent,
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
