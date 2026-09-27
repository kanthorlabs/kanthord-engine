import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";

export const MISSION_SERVICE_NAME = "mission";
export const MISSION_IDENTITY_PREFIX = "mission";
export const NODE_IDENTITY_PREFIX = "node";
export const MISSION_INITIAL_VERSION = 1;
export const MISSION_OPERATION_TIMEOUT_MS = 30000;
export const SCHEDULER_ACTOR_SERVICE = "scheduler";

export interface HumanActor {
  kind: "human";
  account: string;
  name: string;
}

export interface MissionBindings {
  resolveBinding(
    tx: Transaction,
    projectId: string,
    bindingName: string,
  ): { bindingId: string; resourceIdentity: string } | null;
  getBindingRevision(
    tx: Transaction,
    bindingId: string,
  ): {
    bindingId: string;
    name: string;
    resourceIdentity: string;
    revision: number;
    tombstone: boolean;
    disabled: boolean;
  } | null;
}

export interface WorkQueue {
  insert(
    tx: Transaction,
    nodeId: string,
    projectId: string,
    priority: number,
  ): void;
  delete(tx: Transaction, nodeId: string): void;
  priorityUpdate(tx: Transaction, nodeId: string, priority: number): void;
}

export interface MissionCollaborations {
  createMission(tx: Transaction, projectId: string, actor: HumanActor): void;
  liveNodesPinning(tx: Transaction, bindingId: string): string[];
}

export const MissionErrorCode = {
  MissionNotFound: "mission.mission.not_found",
  NodeNotFound: "mission.node.not_found",
  VersionConflict: "mission.version.conflict",
  RevisionConflict: "mission.revision.conflict",
  ContentInvalid: "mission.node.content_invalid",
  VerificationsMissing: "mission.node.verifications_missing",
  BindingsInvalid: "mission.node.bindings_invalid",
  FilenameConflict: "mission.node.filename_conflict",
  CreateRefused: "mission.node.create_refused",
  Retired: "mission.node.retired",
  Terminal: "mission.node.terminal",
  RetireRefused: "mission.node.retire_refused",
  RetireHasDependents: "mission.node.retire_has_dependents",
  RetireMismatch: "mission.node.retire_mismatch",
  PriorityTask: "mission.node.priority_task",
  PlanInvalid: "mission.import.plan_invalid",
  UnresolvedReference: "mission.import.unresolved_reference",
  DuplicateFile: "mission.import.duplicate_file",
  UnknownId: "mission.import.unknown_id",
  DuplicateId: "mission.import.duplicate_id",
  ForeignId: "mission.import.foreign_id",
  RetiredId: "mission.import.retired_id",
  Cycle: "mission.import.cycle",
  ConditionFailed: "mission.import.condition_failed",
  TerminalChange: "mission.import.terminal_change",
  RetirementMismatch: "mission.import.retirement_mismatch",
  ExportTooLarge: "mission.export.too_large",
  BindingNotFound: "mission.binding.not_found",
  BindingRemoved: "mission.binding.removed",
  BindingDisabled: "mission.binding.disabled",
  CursorInvalid: "system.pagination.cursor_invalid",
} as const;

export const MissionBindingKind = {
  Repository: "repository",
  Worker: "worker",
  Storage: "storage",
} as const;

export const NodeKind = {
  Initiative: "initiative",
  Objective: "objective",
  Task: "task",
} as const;
export const NodeState = {
  Pending: "Pending",
  Available: "Available",
  Executing: "Executing",
  Waiting: "Waiting",
  Evaluating: "Evaluating",
  Blocked: "Blocked",
  Paused: "Paused",
  Completed: "Completed",
  Discarded: "Discarded",
  ExternalRequested: "External.Requested",
  ExternalSuccess: "External.Success",
  ExternalFailed: "External.Failed",
} as const;
export const RevisionWrite = {
  Import: "import",
  NodeCreate: "node.create",
  NodeUpdate: "node.update",
  NodeMove: "node.move",
  NodeRetire: "node.retire",
  CriterionSet: "criterion.set",
  Unblock: "unblock",
} as const;
export const TaskChange = {
  Created: "created",
  Updated: "updated",
  MovedIn: "moved-in",
  MovedOut: "moved-out",
  Retired: "retired",
} as const;
export const EdgeKind = {
  Containment: "containment",
  Dependency: "dependency",
} as const;
export const ImportFormat = {
  Markdown: "markdown",
  Json: "json",
} as const;
export const ActorKind = {
  Human: "human",
  Execution: "execution",
  Service: "service",
} as const;

export const nodeKindSchema = z.enum(NodeKind);
export type NodeKind = z.infer<typeof nodeKindSchema>;
export const nodeStateSchema = z.enum(NodeState);
export type NodeState = z.infer<typeof nodeStateSchema>;
export const revisionWriteSchema = z.enum(RevisionWrite);
export type RevisionWrite = z.infer<typeof revisionWriteSchema>;
export const taskChangeSchema = z.enum(TaskChange);
export type TaskChange = z.infer<typeof taskChangeSchema>;
export const edgeKindSchema = z.enum(EdgeKind);
export type EdgeKind = z.infer<typeof edgeKindSchema>;
export const importFormatSchema = z.enum(ImportFormat);
export type ImportFormat = z.infer<typeof importFormatSchema>;
export const actorKindSchema = z.enum(ActorKind);
export type ActorKind = z.infer<typeof actorKindSchema>;

export const contentSchema = z.strictObject({
  name: z.string().min(1),
  requirement: z.string().min(1),
  criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1),
  bindings: z.array(z.string()),
});
export type Content = z.infer<typeof contentSchema>;
export const planFileNameSchema = z.string().regex(/^[a-z][a-z0-9_-]*\.md$/);
export type PlanFileName = z.infer<typeof planFileNameSchema>;

export const nodeCreateSchema = z.strictObject({
  filename: planFileNameSchema,
  kind: nodeKindSchema,
  content: contentSchema,
  reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
  parentId: identitySchema("node").optional(),
  expectedParentRevision: z.number().int().positive().optional(),
});
export type NodeCreate = z.infer<typeof nodeCreateSchema>;
export const nodeUpdateSchema = z.strictObject({
  filename: planFileNameSchema,
  content: contentSchema,
  reason: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  expectedMissionVersion: z.number().int().positive(),
});
export type NodeUpdate = z.infer<typeof nodeUpdateSchema>;
export const moveSchema = z.strictObject({
  newParentId: identitySchema("node"),
  reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
  expectedRevision: z.number().int().positive(),
  expectedOldParentRevision: z.number().int().positive(),
  expectedNewParentRevision: z.number().int().positive(),
});
export type Move = z.infer<typeof moveSchema>;
export const graphEditSchema = z.strictObject({
  reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
});
export type GraphEdit = z.infer<typeof graphEditSchema>;
export const criterionSetSchema = z.strictObject({
  criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  expectedMissionVersion: z.number().int().positive(),
});
export type CriterionSet = z.infer<typeof criterionSetSchema>;
export const prioritySetSchema = z.strictObject({
  value: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  expectedMissionVersion: z.number().int().positive(),
});
export type PrioritySet = z.infer<typeof prioritySetSchema>;
export const rebindSchema = z.strictObject({
  bindingId: identitySchema("binding"),
  reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
  nodeId: identitySchema("node").optional(),
});
export type Rebind = z.infer<typeof rebindSchema>;
export const retireSchema = z.strictObject({
  reason: z.string().min(1),
  expectedMissionVersion: z.number().int().positive(),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  force: z.boolean(),
});
export type Retire = z.infer<typeof retireSchema>;
export const taskContentSchema = z.strictObject({
  id: identitySchema("node"),
  filename: planFileNameSchema,
  content: contentSchema,
});
export type TaskContent = z.infer<typeof taskContentSchema>;
export const revisionChangeSchema = z.strictObject({
  write: revisionWriteSchema,
  previousRevision: z.number().int().positive().nullable(),
  changedFields: z.array(z.string()),
  tasks: z
    .array(
      z.strictObject({
        id: identitySchema("node"),
        change: taskChangeSchema,
        changedFields: z.array(z.string()),
      }),
    )
    .optional(),
});
export type RevisionChange = z.infer<typeof revisionChangeSchema>;
export const actorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(ActorKind.Human),
    account: z.string(),
    name: z.string(),
  }),
  z.strictObject({
    kind: z.literal(ActorKind.Execution),
    executionId: identitySchema("execution"),
    clientId: identitySchema("client_identity").nullable(),
    name: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal(ActorKind.Service),
    service: z.literal(SCHEDULER_ACTOR_SERVICE),
  }),
]);
export type Actor = z.infer<typeof actorSchema>;
export const revisionSchema = z.strictObject({
  nodeId: identitySchema("node"),
  filename: planFileNameSchema,
  revision: z.number().int().positive(),
  reason: z.string(),
  actor: actorSchema,
  createdAt: z.number().int(),
  content: contentSchema,
  tasks: z.array(taskContentSchema).optional(),
  change: revisionChangeSchema,
  pinnedByAttempts: z.array(z.number().int().positive()),
});
export type Revision = z.infer<typeof revisionSchema>;
export const edgeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(EdgeKind.Containment),
    parentId: identitySchema("node"),
    childId: identitySchema("node"),
  }),
  z.strictObject({
    kind: z.literal(EdgeKind.Dependency),
    dependentId: identitySchema("node"),
    dependsOnId: identitySchema("node"),
  }),
]);
export type Edge = z.infer<typeof edgeSchema>;
export const nodeChangeSchema = z.strictObject({
  missionVersion: z.number().int().positive(),
  revisions: z.array(revisionSchema),
  retiredNodeIds: z.array(identitySchema("node")),
  addedEdges: z.array(edgeSchema),
  removedEdges: z.array(edgeSchema),
  openAttemptsUnchanged: z.array(
    z.strictObject({
      nodeId: identitySchema("node"),
      attempt: z.number().int().nonnegative(),
    }),
  ),
});
export type NodeChange = z.infer<typeof nodeChangeSchema>;
export const retirePreviewSchema = z.strictObject({
  nodeId: identitySchema("node"),
  force: z.boolean(),
  missionVersion: z.number().int().positive(),
  retiredNodeIds: z.array(identitySchema("node")),
  removedEdges: z.array(edgeSchema),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RetirePreview = z.infer<typeof retirePreviewSchema>;
export const importEntrySchema = z.strictObject({
  filename: planFileNameSchema,
  kind: nodeKindSchema,
  name: z.string().min(1),
  requirement: z.string().min(1),
  criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1),
  bindings: z.array(z.string()),
  id: identitySchema("node").optional(),
  parent: planFileNameSchema.optional(),
  dependsOn: z.array(planFileNameSchema).optional(),
});
export type ImportEntry = z.infer<typeof importEntrySchema>;
export const planFileEntrySchema = z.strictObject({
  filename: planFileNameSchema,
  content: z.string(),
});
export type PlanFileEntry = z.infer<typeof planFileEntrySchema>;

const importBase = {
  missionId: identitySchema("mission"),
  missionVersion: z.number().int().positive(),
  reason: z.string().min(1),
};
const importApplyFields = {
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  confirmedRetirements: z.array(identitySchema("node")),
};
export const importSnapshotSchema = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal(ImportFormat.Markdown),
    ...importBase,
    files: z.array(planFileEntrySchema),
  }),
  z.strictObject({
    format: z.literal(ImportFormat.Json),
    ...importBase,
    entries: z.array(importEntrySchema),
  }),
]);
export type ImportSnapshot = z.infer<typeof importSnapshotSchema>;
export const importApplySchema = z.discriminatedUnion("format", [
  z.strictObject({
    format: z.literal(ImportFormat.Markdown),
    ...importBase,
    files: z.array(planFileEntrySchema),
    ...importApplyFields,
  }),
  z.strictObject({
    format: z.literal(ImportFormat.Json),
    ...importBase,
    entries: z.array(importEntrySchema),
    ...importApplyFields,
  }),
]);
export type ImportApply = z.infer<typeof importApplySchema>;
export const violationSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  filename: z.string().nullable(),
  nodeId: identitySchema("node").nullable(),
  details: z.unknown().nullable(),
});
export type Violation = z.infer<typeof violationSchema>;
export const importPreviewSchema = z.strictObject({
  missionId: identitySchema("mission"),
  expectedMissionVersion: z.number().int().positive(),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/),
  creates: z.array(planFileNameSchema),
  updates: z.array(identitySchema("node")),
  retirements: z.array(identitySchema("node")),
  removedEdges: z.array(edgeSchema),
  noOps: z.array(identitySchema("node")),
  violations: z.array(violationSchema),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export const importResultSchema = z.strictObject({
  missionId: identitySchema("mission"),
  missionVersion: z.number().int().positive(),
  assignedIds: z.array(
    z.strictObject({
      filename: planFileNameSchema,
      nodeId: identitySchema("node"),
    }),
  ),
  changes: nodeChangeSchema,
  actor: actorSchema,
  acceptedAt: z.number().int(),
});
export type ImportResult = z.infer<typeof importResultSchema>;

const nodeBase = {
  id: identitySchema("node"),
  filename: planFileNameSchema,
  missionId: identitySchema("mission"),
  parentId: identitySchema("node").nullable(),
  visibleRevision: z.number().int().positive(),
  content: contentSchema,
  retiredAt: z.number().int().nullable(),
  pinnedByAttempts: z.array(z.number().int().positive()),
};
const runnableNodeFields = {
  state: nodeStateSchema,
  attempt: z.number().int().nonnegative(),
  priority: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
};
export const nodeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...nodeBase,
    kind: z.literal(NodeKind.Initiative),
    ...runnableNodeFields,
  }),
  z.strictObject({
    ...nodeBase,
    kind: z.literal(NodeKind.Objective),
    ...runnableNodeFields,
  }),
  z.strictObject({
    ...nodeBase,
    kind: z.literal(NodeKind.Task),
  }),
]);
export type Node = z.infer<typeof nodeSchema>;
export const missionSchema = z.strictObject({
  id: identitySchema("mission"),
  projectId: identitySchema("project"),
  version: z.number().int().positive(),
});
export type Mission = z.infer<typeof missionSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
const baseOperation = {
  service: MISSION_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: MISSION_OPERATION_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
const readOperation = {
  ...baseOperation,
  mutation: false,
  body: false,
} as const;
export const writeOperation = {
  ...baseOperation,
  mutation: true,
  body: true,
} as const;
const readInput = <P extends z.ZodType, Q extends z.ZodType>(
  params: P,
  query: Q,
) => z.strictObject({ params, query, body: z.null() });

export const missionOperations = {
  "node.create": {
    ...writeOperation,
    id: "mission.node.create",
    method: HttpMethod.Post,
    path: "/api/mission/:missionId/node",
    input: z.strictObject({
      params: z.strictObject({
        missionId: identitySchema(MISSION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: nodeCreateSchema,
    }),
    output: nodeChangeSchema,
    description: "Create a mission node.",
  },
  get: {
    ...readOperation,
    id: "mission.get",
    method: HttpMethod.Get,
    path: "/api/mission/project/:projectId",
    input: readInput(
      z.strictObject({ projectId: identitySchema("project") }),
      z.strictObject({}),
    ),
    output: missionSchema,
    description: "Get the mission of a project.",
  },
} as const satisfies Record<string, Operation>;
