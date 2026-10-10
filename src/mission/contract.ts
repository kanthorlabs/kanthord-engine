import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import { timestamp } from "../kernel/json.ts";
import { isString } from "../kernel/values.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Context } from "../kernel/context.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { errorSchema } from "../kernel/errors.ts";

export const MISSION_SERVICE_NAME = "mission";
export const MISSION_IDENTITY_PREFIX = "mission";
export const NODE_IDENTITY_PREFIX = "node";
export const PROPOSAL_IDENTITY_PREFIX = "proposal";
export const MISSION_INITIAL_VERSION = 1;
export const MISSION_OPERATION_TIMEOUT_MS = 30000;

export interface HumanActor {
  kind: "human";
  account: string;
  name: string;
}

export interface MissionBindings {
  storageBindingOf(tx: Transaction, bindingId: string): StorageBinding | null;
  repositoryPolicyOf(
    tx: Transaction,
    bindingId: string,
  ): {
    binding_id: string;
    project_id: string;
    name: string;
    address: string;
    platform: string;
    ssh_credential: string;
    credential: string | null;
    base_branch: string;
    action: "pull_request" | "merge_push" | null;
    landing: "human" | "kanthord";
    project_prompt: string | null;
  } | null;
  resolveBinding(
    tx: Transaction,
    projectId: string,
    bindingName: string,
  ): { binding_id: string; resource_identity: string } | null;
  resolveBindingIdentity(
    tx: Transaction,
    projectId: string,
    bindingId: string,
  ): { binding_id: string; resource_identity: string } | null;
  getBindingRevision(
    tx: Transaction,
    bindingId: string,
  ): {
    project_id: string;
    binding_id: string;
    name: string;
    resource_identity: string;
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

export interface SchedulerClaims {
  revoke(tx: Transaction, nodeId: string, now: number): string | null;
  settle(tx: Transaction, nodeId: string, now: number): void;
  liveExecutionOf(
    tx: Transaction,
    nodeId: string,
    now: number,
  ): {
    execution_id: string;
    runtime_identity: string;
    attempt: number;
    pinned_revision: number;
  } | null;
}

export interface IntakeCall {
  context: Context;
  identity: CallerIdentity;
}

export interface StorageBinding {
  binding_id: string;
  project_id: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  credential: string;
  available: boolean;
}

export type IntakeExecutionCall = IntakeCall & { executionId: string };

export interface IntakeStorage {
  put(
    call: IntakeExecutionCall,
    input: {
      nodeId: string;
      assetId: string;
      storageBindingId: string;
      size: number;
      sha256: string | null;
    },
  ): Promise<{
    put_url: string;
    headers: Record<string, string>;
    expires_at: number;
  }>;
  check(
    call: IntakeExecutionCall,
    assetId: string,
  ): Promise<{ location: string; version: string | null }>;
  get(
    call: IntakeCall,
    assetId: string,
  ): Promise<{ get_url: string; expires_at: number }>;
  executionGet(
    call: IntakeExecutionCall,
    assetId: string,
  ): Promise<{ get_url: string; expires_at: number }>;
  delete(call: IntakeCall, assetId: string): Promise<void>;
}

export const CheckEndState = {
  Expected: "expected",
  Other: "other",
  None: "none",
  Conflict: "conflict",
} as const;
export const checkEndStateSchema = z.enum(CheckEndState);

export interface IntakeCheck {
  check(
    context: Context,
    evidenceId: string,
  ): Promise<{
    end_state: z.infer<typeof checkEndStateSchema>;
    landed_commits: string[];
  }>;
}

export interface EventDecoder {
  decode(input: {
    platform: string;
    resource: string;
    event: Uint8Array;
    metadata: unknown;
  }): PlatformAddress | null;
}

export interface SchedulerWakeup {
  wake(projectId: string): void;
}

export interface ExecutionAttribution {
  of(
    tx: Transaction,
    executionId: string,
  ): {
    client_id: string | null;
    name: string | null;
    worker_name: string;
  } | null;
}

export type ExecutionActor = Extract<Actor, { kind: "execution" }>;
export type ClaimAdmission = {
  kind: ClaimKind;
  project_id: string;
  attempt: number;
  node_revision: number;
};

export interface MissionTransitions {
  claim(
    tx: Transaction,
    nodeId: string,
    declaredStates: readonly NodeState[],
    opener: ExecutionActor,
    now: number,
  ): ClaimAdmission | null;
  release(
    tx: Transaction,
    execution: { execution_id: string; node_id: string; attempt: number },
    furtherWork: boolean,
    stalledReleases: number,
    now: number,
  ): void;
  failure(
    tx: Transaction,
    nodeId: string,
    consecutiveFailures: number,
    now: number,
  ): void;
}

export const MissionErrorCode = {
  AuthorizationRefused: "mission.authorization.refused",
  EvidenceBindingMismatch: "mission.evidence.binding_mismatch",
  EvidenceTooLarge: "mission.evidence.too_large",
  EvidenceUploadExpired: "mission.evidence.upload_expired",
  EvidenceContentRepository: "mission.evidence.content_repository",
  EvidenceRemoveNodeLive: "mission.evidence.remove_node_live",
  EvidenceRequestForceRequired: "mission.evidence.request_force_required",
  EvidenceRequestAssetRefused: "mission.evidence.request_asset_refused",
  AssessmentEvidenceUnpublished: "mission.assessment.evidence_unpublished",
  AssessmentVerificationFailed: "mission.assessment.verification_failed",
  ProposalAlreadyApproved: "mission.proposal.already_approved",
  NoUnresolvedRequest: "mission.node.no_unresolved_request",
  RecordNotFound: "mission.record.not_found",
  ExecutionContextMismatch: "mission.execution.context_mismatch",
  EvidenceStorageBindingAbsent: "mission.evidence.storage_binding_absent",
  EvidenceStorageUnavailable: "mission.evidence.storage_unavailable",
  EvidenceContentPlatform: "mission.evidence.content_platform",
  ExecutionClaimNotEvaluation: "mission.execution.claim_not_evaluation",
  RequestRequirementUnknown: "mission.request.requirement_unknown",
  RequestAlreadyRequested: "mission.request.already_requested",
  RequestAddressMismatch: "mission.request.address_mismatch",
  ExecutionRevisionAbovePin: "mission.execution.revision_above_pin",
  ClaimLive: "mission.node.claim_live",
  DeliveryMatchChanged: "mission.delivery.match_changed",
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
  EndpointInvalid: "mission.dependency.endpoint_invalid",
  RetireRefused: "mission.node.retire_refused",
  RetireHasDependents: "mission.node.retire_has_dependents",
  RetireMismatch: "mission.node.retire_mismatch",
  PriorityTask: "mission.node.priority_task",
  PlanInvalid: "mission.import.plan_invalid",
  MissionMismatch: "mission.import.mission_mismatch",
  ReferenceKindInvalid: "mission.import.reference_kind_invalid",
  KindChanged: "mission.import.kind_changed",
  UnresolvedReference: "mission.import.unresolved_reference",
  VerificationUncovered: "mission.import.verification_uncovered",
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
  BindingMismatch: "mission.binding.mismatch",
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
  NodeRebind: "node.rebind",
  CriterionSet: "criterion.set",
  Unblock: "unblock",
} as const;
export const RebindSkipCondition = {
  Terminal: "terminal",
  Retired: "retired",
} as const;
export const rebindSkipConditionSchema = z.enum(RebindSkipCondition);
export type RebindSkipCondition = z.infer<typeof rebindSkipConditionSchema>;
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

export const ClaimKind = { Steps: "steps", Evaluation: "evaluation" } as const;
export const claimKindSchema = z.enum(ClaimKind);
export type ClaimKind = z.infer<typeof claimKindSchema>;
export const AssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const assessmentResultSchema = z.enum(AssessmentResult);
export type AssessmentResult = z.infer<typeof assessmentResultSchema>;
export const AssetKind = {
  Repository: "repository",
  Produced: "produced",
  Object: "object",
  Platform: "platform",
} as const;
export const assetKindSchema = z.enum(AssetKind);
export type AssetKind = z.infer<typeof assetKindSchema>;
export const EndState = { Expected: "expected", Other: "other" } as const;
export const endStateSchema = z.enum(EndState);
export type EndState = z.infer<typeof endStateSchema>;
export const Resolution = {
  Unrequested: "unrequested",
  Unresolved: "unresolved",
  ExpectedEnd: "expected-end",
  OtherEnd: "other-end",
} as const;
export const resolutionSchema = z.enum(Resolution);
export type Resolution = z.infer<typeof resolutionSchema>;
export const ClosingEvent = {
  SuccessOverride: "success-override",
  HumanDiscard: "human-discard",
  HumanBlock: "human-block",
  AssessmentNotPassed: "assessment-not-passed",
  ExternalFailed: "external-failed",
  AssessmentPassed: "assessment-passed",
  ExternalSuccess: "external-success",
} as const;
export const closingEventSchema = z.enum(ClosingEvent);
export type ClosingEvent = z.infer<typeof closingEventSchema>;
export const RepositoryAction = {
  PullRequest: "pull_request",
  MergePush: "merge_push",
} as const;
export const repositoryActionSchema = z.enum(RepositoryAction);
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;
export const RepositoryLanding = {
  Human: "human",
  KanthorD: "kanthord",
} as const;
export const ExpectedEndState = {
  PullRequestMerged: "pull_request_merged",
  BaseBranchPushed: "base_branch_pushed",
} as const;
export const expectedEndStateSchema = z.enum(ExpectedEndState);
export type ExpectedEndState = z.infer<typeof expectedEndStateSchema>;
export const PlatformAddressKind = {
  PullRequest: "pull_request",
  BranchPush: "branch_push",
} as const;
export const platformAddressKindSchema = z.enum(PlatformAddressKind);
export type PlatformAddressKind = z.infer<typeof platformAddressKindSchema>;
export const ResumeTarget = {
  Available: NodeState.Available,
  Waiting: NodeState.Waiting,
} as const;
export const resumeTargetSchema = z.enum(ResumeTarget);
export type ResumeTarget = z.infer<typeof resumeTargetSchema>;
export const ReleaseObligation = {
  Evidence: "evidence",
  Assessment: "assessment",
  Request: "request",
} as const;
export const releaseObligationSchema = z.enum(ReleaseObligation);
export type ReleaseObligation = z.infer<typeof releaseObligationSchema>;
export const ActorService = {
  Scheduler: "scheduler",
  Mission: "mission",
} as const;
export const actorServiceSchema = z.enum(ActorService);
export type ActorService = z.infer<typeof actorServiceSchema>;

export const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const actionKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}\.(pull_request|merge_push)$/);
export const textSchema = z.string().min(1);

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
  expected_mission_version: z.number().int().positive(),
  parent_id: identitySchema("node").optional(),
  expected_parent_revision: z.number().int().positive().optional(),
});
export type NodeCreate = z.infer<typeof nodeCreateSchema>;
export const nodeUpdateSchema = z.strictObject({
  filename: planFileNameSchema,
  content: contentSchema,
  reason: z.string().min(1),
  expected_revision: z.number().int().positive(),
  expected_mission_version: z.number().int().positive(),
});
export type NodeUpdate = z.infer<typeof nodeUpdateSchema>;
export const moveSchema = z.strictObject({
  new_parent_id: identitySchema("node"),
  reason: z.string().min(1),
  expected_mission_version: z.number().int().positive(),
  expected_revision: z.number().int().positive(),
  expected_old_parent_revision: z.number().int().positive(),
  expected_new_parent_revision: z.number().int().positive(),
});
export type Move = z.infer<typeof moveSchema>;
export const graphEditSchema = z.strictObject({
  reason: z.string().min(1),
  expected_mission_version: z.number().int().positive(),
});
export type GraphEdit = z.infer<typeof graphEditSchema>;
export const criterionSetSchema = z.strictObject({
  criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1),
  reason: z.string().min(1),
  expected_revision: z.number().int().positive(),
  expected_mission_version: z.number().int().positive(),
});
export type CriterionSet = z.infer<typeof criterionSetSchema>;
export const prioritySetSchema = z.strictObject({
  value: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  expected_mission_version: z.number().int().positive(),
});
export type PrioritySet = z.infer<typeof prioritySetSchema>;
export const rebindSchema = z.strictObject({
  binding_id: identitySchema("binding"),
  reason: z.string().min(1),
  expected_mission_version: z.number().int().positive(),
  node_id: identitySchema("node").optional(),
});
export type Rebind = z.infer<typeof rebindSchema>;
export const retireSchema = z.strictObject({
  reason: z.string().min(1),
  expected_mission_version: z.number().int().positive(),
  preview_digest: z.string().regex(/^[0-9a-f]{64}$/),
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
  previous_revision: z.number().int().positive().nullable(),
  changed_fields: z.array(z.string()),
  tasks: z
    .array(
      z.strictObject({
        id: identitySchema("node"),
        change: taskChangeSchema,
        changed_fields: z.array(z.string()),
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
    execution_id: identitySchema("execution"),
    client_id: identitySchema("client_identity").nullable(),
    name: z.string().nullable(),
  }),
  z.strictObject({
    kind: z.literal(ActorKind.Service),
    service: actorServiceSchema,
    inbound_event_id: identitySchema("inbound_event").optional(),
  }),
]);
export type Actor = z.infer<typeof actorSchema>;
export const revisionSchema = z.strictObject({
  node_id: identitySchema("node"),
  filename: planFileNameSchema,
  revision: z.number().int().positive(),
  reason: z.string(),
  actor: actorSchema,
  created_at: timestamp,
  content: contentSchema,
  tasks: z.array(taskContentSchema).optional(),
  change: revisionChangeSchema,
  pinned_by_attempts: z.array(z.number().int().positive()),
});
export type Revision = z.infer<typeof revisionSchema>;
export const edgeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(EdgeKind.Containment),
    parent_id: identitySchema("node"),
    child_id: identitySchema("node"),
  }),
  z.strictObject({
    kind: z.literal(EdgeKind.Dependency),
    dependent_id: identitySchema("node"),
    depends_on_id: identitySchema("node"),
  }),
]);
export type Edge = z.infer<typeof edgeSchema>;
export const nodeChangeSchema = z.strictObject({
  mission_version: z.number().int().positive(),
  revisions: z.array(revisionSchema),
  retired_node_ids: z.array(identitySchema("node")),
  added_edges: z.array(edgeSchema),
  removed_edges: z.array(edgeSchema),
  open_attempts_unchanged: z.array(
    z.strictObject({
      node_id: identitySchema("node"),
      attempt: z.number().int().nonnegative(),
    }),
  ),
});
export type NodeChange = z.infer<typeof nodeChangeSchema>;
export const retirePreviewSchema = z.strictObject({
  node_id: identitySchema("node"),
  force: z.boolean(),
  mission_version: z.number().int().positive(),
  retired_node_ids: z.array(identitySchema("node")),
  removed_edges: z.array(edgeSchema),
  preview_digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type RetirePreview = z.infer<typeof retirePreviewSchema>;
export const importEntrySchema = z.strictObject({
  filename: z.string().min(1),
  kind: nodeKindSchema,
  name: z.string().min(1),
  requirement: z.string().min(1),
  criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1),
  bindings: z.array(z.string()),
  id: identitySchema("node").optional(),
  parent: z.string().min(1).optional(),
  depends_on: z.array(z.string().min(1)).optional(),
});
export type ImportEntry = z.infer<typeof importEntrySchema>;
export const exportEntrySchema = z.strictObject({
  filename: planFileNameSchema,
  id: identitySchema(NODE_IDENTITY_PREFIX),
  kind: nodeKindSchema,
  name: z.string().min(1),
  requirement: z.string().min(1),
  criterion: z.string().min(1),
  verifications: z.array(z.string().min(1)).min(1),
  bindings: z.array(z.string()),
  parent: planFileNameSchema.optional(),
  depends_on: z.array(planFileNameSchema).optional(),
});
export type ExportEntry = z.infer<typeof exportEntrySchema>;
export const planFileEntrySchema = z.strictObject({
  filename: z.string().min(1),
  content: z.string(),
});
export type PlanFileEntry = z.infer<typeof planFileEntrySchema>;
export const exportAnswerSchema = z.union([
  z.strictObject({
    mission_id: identitySchema(MISSION_IDENTITY_PREFIX),
    mission_version: z.number().int().positive(),
    entries: z.array(exportEntrySchema),
  }),
  z.strictObject({
    mission_id: identitySchema(MISSION_IDENTITY_PREFIX),
    mission_version: z.number().int().positive(),
    files: z.array(planFileEntrySchema),
  }),
]);
export type ExportAnswer = z.infer<typeof exportAnswerSchema>;

const importBase = {
  mission_id: identitySchema("mission"),
  mission_version: z.number().int().positive(),
  reason: z.string().min(1),
};
const importApplyFields = {
  preview_digest: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed_retirements: z.array(identitySchema("node")),
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
  node_id: identitySchema("node").nullable(),
  details: z.unknown().nullable(),
});
export type Violation = z.infer<typeof violationSchema>;
export const importPreviewSchema = z.strictObject({
  mission_id: identitySchema("mission"),
  expected_mission_version: z.number().int().positive(),
  preview_digest: z.string().regex(/^[0-9a-f]{64}$/),
  creates: z.array(planFileNameSchema),
  updates: z.array(identitySchema("node")),
  retirements: z.array(identitySchema("node")),
  removed_edges: z.array(edgeSchema),
  no_ops: z.array(identitySchema("node")),
  violations: z.array(violationSchema),
});
export type ImportPreview = z.infer<typeof importPreviewSchema>;
export const importResultSchema = z.strictObject({
  mission_id: identitySchema("mission"),
  mission_version: z.number().int().positive(),
  assigned_ids: z.array(
    z.strictObject({
      filename: planFileNameSchema,
      node_id: identitySchema("node"),
    }),
  ),
  changes: nodeChangeSchema,
  actor: actorSchema,
  accepted_at: timestamp,
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const repositoryAddressSchema = z.strictObject({
  kind: z.literal(AssetKind.Repository),
  binding_id: identitySchema("binding"),
  commit: commitSchema,
});
export type RepositoryAddress = z.infer<typeof repositoryAddressSchema>;
export const producedAddressSchema = z.strictObject({
  kind: z.literal(AssetKind.Produced),
  sha256: sha256Schema,
});
export const objectAddressSchema = z.strictObject({
  kind: z.literal(AssetKind.Object),
  location: z.string().startsWith("s3://"),
  version: textSchema.optional(),
  sha256: sha256Schema.optional(),
});
export const platformAddressSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(PlatformAddressKind.PullRequest),
    resource_identity: textSchema,
    number: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal(PlatformAddressKind.BranchPush),
    resource_identity: textSchema,
    branch: textSchema,
    commit: commitSchema,
  }),
]);
export type PlatformAddress = z.infer<typeof platformAddressSchema>;
export const addressSchema = z.discriminatedUnion("kind", [
  repositoryAddressSchema,
  producedAddressSchema,
  objectAddressSchema,
]);
export type Address = z.infer<typeof addressSchema>;
export const testedInputSchema = z.union([
  addressSchema,
  z.array(repositoryAddressSchema).min(1),
]);
export type TestedInput = z.infer<typeof testedInputSchema>;
export const verificationSchema = z.strictObject({
  tested_input: testedInputSchema,
  results: z.array(
    z.strictObject({
      command: textSchema,
      exit_code: z.number().int().nullable(),
      signal: textSchema.nullable(),
      timed_out: z.boolean(),
    }),
  ),
});
export type Verification = z.infer<typeof verificationSchema>;
export const frozenActionSchema = z.strictObject({
  key: actionKeySchema,
  binding_id: identitySchema("binding"),
  action: repositoryActionSchema,
  expected_end_state: expectedEndStateSchema,
  follows: actionKeySchema.nullable(),
  configuration: z.strictObject({
    base_branch: textSchema,
    landing: z.enum(RepositoryLanding).default(RepositoryLanding.Human),
  }),
});
export type FrozenAction = z.infer<typeof frozenActionSchema>;
export type PullRequestAddress = Extract<
  PlatformAddress,
  { kind: typeof PlatformAddressKind.PullRequest }
>;
export type RepositoryFacts = {
  binding_id: string;
  address: string;
  resource_identity: string;
  base_branch: string;
};
export type ActionFacts = {
  frozen_action: FrozenAction;
  repository: RepositoryFacts;
  snapshot_commit: string;
  reused_address: PullRequestAddress | null;
};
export type RequestFacts = {
  frozen_action: FrozenAction;
  address: PlatformAddress;
  repository: RepositoryFacts;
};
export type Authorized<F> = {
  credential: string | null;
  platform: string;
  project_id: string;
  facts: F;
};
export type ActionContext = {
  state: NodeState;
  current_assessment: {
    result: AssessmentResult;
    tested_input: TestedInput;
  } | null;
  actions: {
    action: FrozenAction;
    resource_identity: string;
    resolution: Resolution;
    request_evidence_id: string | null;
    eligible: boolean;
    reuse_candidates: {
      evidence_id: string;
      attempt: number;
      address: PlatformAddress;
    }[];
  }[];
};
export const ACTION_CONTEXT_INVARIANT =
  "Caller claim proof, evaluation claim, current passing assessment and eligibility share one database snapshot; the snapshot guarantees no liveness through a later external operation.";
export interface MissionActions {
  actionContextOf(
    tx: Transaction,
    nodeId: string,
    attempt: number,
  ): ActionContext;
}
export const attemptSchema = z.strictObject({
  node_id: identitySchema("node"),
  attempt: z.number().int().positive(),
  node_revision: z.number().int().positive(),
  required_external_actions: z.array(frozenActionSchema),
  opened_at: timestamp,
  closed_at: timestamp.nullable(),
  outcome_ids: z.array(identitySchema("outcome")),
  opened_by: actorSchema,
});
export type Attempt = z.infer<typeof attemptSchema>;
const assetBase = {
  id: identitySchema("evidence_asset"),
  published_at: timestamp.nullable(),
  expired_at: timestamp.nullable(),
};
export const evidenceAssetSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...assetBase,
    kind: z.literal(AssetKind.Repository),
    address: repositoryAddressSchema,
  }),
  z.strictObject({
    ...assetBase,
    kind: z.literal(AssetKind.Produced),
    address: producedAddressSchema,
  }),
  z.strictObject({
    ...assetBase,
    kind: z.literal(AssetKind.Object),
    address: objectAddressSchema,
    storage_binding_id: identitySchema("binding"),
    size: z.number().int().nonnegative(),
    media_type: textSchema,
  }),
  z.strictObject({
    ...assetBase,
    kind: z.literal(AssetKind.Platform),
    address: platformAddressSchema,
  }),
]);
export type EvidenceAsset = z.infer<typeof evidenceAssetSchema>;
export const evidenceSchema = z.strictObject({
  id: identitySchema("evidence"),
  node_id: identitySchema("node"),
  attempt: z.number().int().nonnegative(),
  subject: textSchema,
  assets: z.array(evidenceAssetSchema),
  provenance: actorSchema,
  created_at: timestamp,
  requirement_key: actionKeySchema.optional(),
  end_state: endStateSchema.optional(),
  verification: verificationSchema.optional(),
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const currencySchema = z.strictObject({
  current: z.boolean(),
  context_matches: z.boolean(),
  authority_admits: z.boolean(),
  order_selected: z.boolean(),
  reasons: z.array(textSchema),
});
export type Currency = z.infer<typeof currencySchema>;
export const assessmentSchema = z.strictObject({
  id: identitySchema("assessment"),
  node_id: identitySchema("node"),
  execution_id: identitySchema("execution").nullable(),
  attempt: z.number().int().nonnegative(),
  node_revision: z.number().int().positive(),
  evidence_ids: z.array(identitySchema("evidence")),
  child_outcome_ids: z.array(identitySchema("outcome")),
  result: assessmentResultSchema,
  rationale: textSchema,
  tested_input: testedInputSchema.nullable(),
  actor: actorSchema,
  created_at: timestamp,
  currency: currencySchema.nullable(),
  child_node_ids: z.array(identitySchema("node")),
  worker_version: textSchema.nullable(),
});
export type Assessment = z.infer<typeof assessmentSchema>;
export const outcomeSchema = z.strictObject({
  id: identitySchema("outcome"),
  node_id: identitySchema("node"),
  attempt: z.number().int().nonnegative(),
  node_revision: z.number().int().positive(),
  closing_event: closingEventSchema,
  result: assessmentResultSchema,
  assessment_id: identitySchema("assessment"),
  evidence_ids: z.array(identitySchema("evidence")),
  created_at: timestamp,
});
export type Outcome = z.infer<typeof outcomeSchema>;
export const externalActionSchema = z.strictObject({
  node_id: identitySchema("node"),
  attempt: z.number().int().nonnegative(),
  action: frozenActionSchema,
  requested: z.boolean(),
  request_evidence_id: identitySchema("evidence").nullable(),
  resolution: resolutionSchema,
});
export type ExternalAction = z.infer<typeof externalActionSchema>;
export const blockedContextSchema = z.strictObject({
  outcome: outcomeSchema,
  requests: z.array(evidenceSchema),
});
export type BlockedContext = z.infer<typeof blockedContextSchema>;
export const humanActSchema = z.strictObject({
  reason: textSchema,
  expected_mission_version: z.number().int().positive(),
  expected_state: nodeStateSchema,
  expected_attempt: z.number().int().nonnegative(),
});
export type HumanAct = z.infer<typeof humanActSchema>;
export const resumeSchema = humanActSchema.extend({
  target: resumeTargetSchema,
});
export type Resume = z.infer<typeof resumeSchema>;
export const overrideSchema = humanActSchema.extend({
  result: z.enum([AssessmentResult.Success]),
  landed_commit: repositoryAddressSchema.optional(),
});
export type Override = z.infer<typeof overrideSchema>;
export const unblockChangeSchema = z.strictObject({
  content: contentSchema,
  tasks: z.array(taskContentSchema).optional(),
  reason: textSchema,
});
export type UnblockChange = z.infer<typeof unblockChangeSchema>;
export const unblockSchema = z.strictObject({
  blocked_attempt: z.number().int().nonnegative(),
  expected_revision: z.number().int().positive(),
  expected_mission_version: z.number().int().positive(),
  change: unblockChangeSchema.optional(),
  reason: textSchema.optional(),
});
export type Unblock = z.infer<typeof unblockSchema>;

const nodeBase = {
  id: identitySchema("node"),
  filename: planFileNameSchema,
  mission_id: identitySchema("mission"),
  parent_id: identitySchema("node").nullable(),
  visible_revision: z.number().int().positive(),
  content: contentSchema,
  retired_at: timestamp.nullable(),
  pinned_by_attempts: z.array(z.number().int().positive()),
};
const runnableNodeFields = {
  blocked_context: blockedContextSchema.optional(),
  state: nodeStateSchema,
  attempt: z.number().int().nonnegative(),
  priority: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
  depends_on: z.array(identitySchema("node")),
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
export const controlResultSchema = z.strictObject({
  node: nodeSchema,
  attempt: attemptSchema.nullable(),
  outcome: outcomeSchema.nullable(),
  actor: actorSchema,
  accepted_at: timestamp,
});
export type ControlResult = z.infer<typeof controlResultSchema>;
export const OBJECT_SIZE_MAX = 5 * 1024 ** 3;
export const INLINE_BYTES_MAX = 5 * 1024 ** 2;
export const UPLOAD_LIFETIME_MS = 3600000;
export const CONTENT_ENCODING = "base64";
const MEDIA_TYPE_MAX = 255;
const MEDIA_TYPE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$(?![\s\S])/;
export const mediaTypeSchema = z
  .string()
  .max(MEDIA_TYPE_MAX)
  .regex(MEDIA_TYPE_PATTERN);
export const contentBytesSchema = z.strictObject({
  media_type: mediaTypeSchema,
  encoding: z.literal(CONTENT_ENCODING),
  data: z.string(),
});
export const executionContextSchema = z.strictObject({
  execution_id: identitySchema("execution"),
  attempt: z.number().int().positive(),
  node_revision: z.number().int().positive(),
});
export type ExecutionContext = z.infer<typeof executionContextSchema>;
export const assetSubmitSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(AssetKind.Repository),
    address: repositoryAddressSchema,
  }),
  z.strictObject({
    kind: z.literal(AssetKind.Produced),
    content: contentBytesSchema,
  }),
  z.strictObject({
    kind: z.literal(AssetKind.Object),
    size: z.number().int().nonnegative().max(OBJECT_SIZE_MAX),
    media_type: mediaTypeSchema,
    sha256: sha256Schema.optional(),
  }),
]);
export const evidenceSubmitSchema = executionContextSchema.extend({
  subject: textSchema,
  assets: z.array(assetSubmitSchema).min(1),
  verification: verificationSchema.optional(),
});
export type EvidenceSubmit = z.infer<typeof evidenceSubmitSchema>;
export const PROPOSAL_MAX = 10;
export const proposalTaskSchema = contentSchema.omit({ bindings: true });
export type ProposalTask = z.infer<typeof proposalTaskSchema>;
export const proposalContentSchema = z.strictObject({
  objective_id: identitySchema(NODE_IDENTITY_PREFIX),
  ...contentSchema.pick({ name: true, requirement: true, criterion: true })
    .shape,
  task: proposalTaskSchema,
});
export type ProposalContent = z.infer<typeof proposalContentSchema>;
export const proposalSchema = z.strictObject({
  id: identitySchema(PROPOSAL_IDENTITY_PREFIX),
  node_id: identitySchema(NODE_IDENTITY_PREFIX),
  attempt: z.number().int().nonnegative(),
  assessment_id: identitySchema("assessment"),
  content: proposalContentSchema,
  objective_node_id: identitySchema(NODE_IDENTITY_PREFIX).nullable(),
  approved_at: timestamp.nullable(),
  created_at: timestamp,
});
export type Proposal = z.infer<typeof proposalSchema>;
export const proposalApproveSchema = z.strictObject({
  expected_mission_version: z.number().int().positive(),
  reason: textSchema.optional(),
});
export type ProposalApprove = z.infer<typeof proposalApproveSchema>;
export const proposalApproveResultSchema = z.strictObject({
  objective: nodeChangeSchema,
  initiative: controlResultSchema,
});
export const assessmentSubmitSchema = executionContextSchema.extend({
  evidence_ids: z
    .array(identitySchema("evidence"))
    .refine((items) => new Set(items).size === items.length)
    .meta({ uniqueItems: true }),
  child_outcome_ids: z
    .array(identitySchema("outcome"))
    .refine((items) => new Set(items).size === items.length)
    .meta({ uniqueItems: true }),
  result: assessmentResultSchema,
  rationale: textSchema,
  tested_input: testedInputSchema,
  proposals: z.array(proposalContentSchema).max(PROPOSAL_MAX).default([]),
});
export type AssessmentSubmit = z.infer<typeof assessmentSubmitSchema>;
export const evidenceRequestSchema = executionContextSchema.extend({
  requirement_key: actionKeySchema,
  subject: textSchema,
  address: platformAddressSchema,
});
export type EvidenceRequest = z.infer<typeof evidenceRequestSchema>;
export const evidenceDeleteSchema = z
  .strictObject({
    expected_mission_version: z.number().int().positive(),
    force: z.boolean(),
    reason: textSchema.optional(),
  })
  .superRefine((body, context) => {
    if (body.force && body.reason === undefined)
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "A forced delete requires a reason.",
      });
  })
  .meta({
    if: { properties: { force: { const: true } }, required: ["force"] },
    then: { required: ["reason"] },
  });
export const nodeCheckSchema = z.strictObject({
  expected_mission_version: z.number().int().positive(),
});
export const evidenceSubmitResultSchema = z.strictObject({
  evidence: evidenceSchema,
  uploads: z.array(
    z.strictObject({
      asset_id: identitySchema("evidence_asset"),
      put_url: z.string(),
      headers: z.record(z.string(), z.string()),
      expires_at: timestamp,
    }),
  ),
});
export const assetUploadResultSchema = z.strictObject({
  asset_id: identitySchema("evidence_asset"),
  evidence_id: identitySchema("evidence"),
  uri: z.string().startsWith("s3://"),
});
export const assessmentSubmitResultSchema = z.strictObject({
  assessment: assessmentSchema,
  node: nodeSchema,
  outcome: outcomeSchema.nullable(),
});
export const storedContentSchema = z.union([
  contentBytesSchema.extend({
    asset_id: identitySchema("evidence_asset"),
    address: producedAddressSchema,
  }),
  z.strictObject({
    asset_id: identitySchema("evidence_asset"),
    address: objectAddressSchema,
    media_type: mediaTypeSchema,
    size: z.number().int().nonnegative(),
    get_url: z.string(),
    expires_at: timestamp,
  }),
]);
export const nodeCheckResultSchema = z.strictObject({
  results: z.array(
    z.strictObject({
      evidence_id: identitySchema("evidence"),
      requirement_key: actionKeySchema,
      resolution: z.enum([
        Resolution.Unresolved,
        Resolution.ExpectedEnd,
        Resolution.OtherEnd,
      ]),
    }),
  ),
  failures: z.array(
    z.strictObject({
      evidence_id: identitySchema("evidence"),
      error: errorSchema,
    }),
  ),
});
export const Disposition = {
  AcceptedObservation: "accepted_observation",
  Refused: "refused",
  Duplicate: "duplicate",
} as const;
export const dispositionSchema = z.enum(Disposition);
export type Disposition = z.infer<typeof dispositionSchema>;
export const AdmissionRefusal = {
  Ambiguous: "ambiguous",
  Unmatched: "unmatched",
  Undecodable: "undecodable",
} as const;
export const admissionRefusalSchema = z.enum(AdmissionRefusal);
export type AdmissionRefusal = z.infer<typeof admissionRefusalSchema>;
export const canonicalBase64Schema = z
  .string()
  .refine(
    (value) =>
      Buffer.from(value, CONTENT_ENCODING).toString(CONTENT_ENCODING) === value,
  );
export const deliveryAdmitSchema = z.strictObject({
  inbound_event_id: identitySchema("inbound_event"),
  project_id: identitySchema("project"),
  platform: z.string().min(1),
  resource: z.string().min(1),
  event: canonicalBase64Schema,
  metadata: z.record(z.string(), z.unknown()),
});
export const admissionAnswerSchema = z.union([
  z.strictObject({
    disposition: z.literal(Disposition.Refused),
    reason: admissionRefusalSchema,
  }),
  z.strictObject({
    disposition: z.enum([
      Disposition.AcceptedObservation,
      Disposition.Duplicate,
    ]),
    reason: z.null(),
  }),
]);
export type AdmissionAnswer = z.infer<typeof admissionAnswerSchema>;
export type ExecutionObjective = z.infer<typeof executionObjectiveSchema>;
export const executionObjectiveSchema = z.union([
  nodeSchema.options[1],
  z.strictObject({ id: identitySchema("node"), state: nodeStateSchema }),
]);
export const rebindResultSchema = z.strictObject({
  node_change: nodeChangeSchema,
  skipped: z.array(
    z.strictObject({ node: nodeSchema, condition: rebindSkipConditionSchema }),
  ),
});
export type RebindResult = z.infer<typeof rebindResultSchema>;
export const missionSchema = z.strictObject({
  id: identitySchema("mission"),
  project_id: identitySchema("project"),
  version: z.number().int().positive(),
});
export type Mission = z.infer<typeof missionSchema>;

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), next_cursor: z.string().nullable() });
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

export const NODE_LIST_LIMIT_DEFAULT = 100;
export const NODE_LIST_LIMIT_MIN = 1;
export const NODE_LIST_LIMIT_MAX = 1000;
const pageQuery = {
  limit: z.coerce
    .number()
    .int()
    .min(NODE_LIST_LIMIT_MIN)
    .max(NODE_LIST_LIMIT_MAX)
    .default(NODE_LIST_LIMIT_DEFAULT)
    .optional(),
  cursor: z.string().optional(),
};
const attemptSelector = (minimum: number) =>
  z.preprocess(
    (value) =>
      isString(value) && /^(0|[1-9][0-9]*)$/.test(value)
        ? Number(value)
        : value,
    z.number().int().min(minimum).max(Number.MAX_SAFE_INTEGER),
  );

const dependencyInput = z.strictObject({
  params: z.strictObject({
    node_id: identitySchema(NODE_IDENTITY_PREFIX),
    depends_on_id: identitySchema(NODE_IDENTITY_PREFIX),
  }),
  query: z.strictObject({}),
  body: graphEditSchema,
});

export const missionOperations = {
  "execution.objective.list": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.objective.list",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/objective",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(executionObjectiveSchema),
    description: "List current objectives at their outcome revisions.",
  },
  "execution.objective.outcome.list": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.objective.outcome.list",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/objective/outcome",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(outcomeSchema),
    description: "List current outcomes of current objectives.",
  },
  "execution.objective.evidence.list": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.objective.evidence.list",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/objective/evidence",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(evidenceSchema),
    description: "List evidence named by current objective outcomes.",
  },
  "execution.evidence.list": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.evidence.list",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/evidence",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(evidenceSchema),
    description: "List evidence of the claimed attempt.",
  },
  "execution.clearedOutcome.get": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.clearedOutcome.get",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/cleared-outcome",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject({}),
    ),
    output: outcomeSchema,
    description: "Read the previous attempt outcome cleared by an unblock.",
  },
  "execution.cleared_assessment.get": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.cleared_assessment.get",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/cleared-assessment",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject({}),
    ),
    output: assessmentSchema,
    description:
      "Read the assessment of the outcome that an unblock cleared before the claimed attempt.",
  },
  "execution.rework_assessment.get": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.rework_assessment.get",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/rework-assessment",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject({}),
    ),
    output: assessmentSchema,
    description:
      "Read the assessment that caused the latest rework of the claimed attempt.",
  },
  "execution.pinnedRevision.get": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.pinnedRevision.get",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/pinned-revision",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject({}),
    ),
    output: revisionSchema,
    description: "Read the execution's pinned revision.",
  },
  "execution.revision.list": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.revision.list",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/revision",
    input: readInput(
      z.strictObject({ execution_id: identitySchema("execution") }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(revisionSchema),
    description: "List revisions no newer than the execution pin.",
  },
  "execution.revision.get": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.revision.get",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/revision/:revision",
    input: readInput(
      z.strictObject({
        execution_id: identitySchema("execution"),
        revision: z.coerce.number().int().positive(),
      }),
      z.strictObject({}),
    ),
    output: revisionSchema,
    description: "Read a revision within the execution pin.",
  },
  "evidence.delete": {
    ...writeOperation,
    id: "mission.evidence.delete",
    method: HttpMethod.Delete,
    status: HttpStatus.NoContent,
    path: "/api/mission/evidence/:evidence_id",
    input: z.strictObject({
      params: z.strictObject({ evidence_id: identitySchema("evidence") }),
      query: z.strictObject({}),
      body: evidenceDeleteSchema,
    }),
    output: z.null(),
    description:
      "Delete evidence and remove its references after deleting stored content.",
  },
  "evidence.asset.delete": {
    ...writeOperation,
    id: "mission.evidence.asset.delete",
    method: HttpMethod.Delete,
    status: HttpStatus.NoContent,
    path: "/api/mission/evidence/asset/:asset_id",
    input: z.strictObject({
      params: z.strictObject({ asset_id: identitySchema("evidence_asset") }),
      query: z.strictObject({}),
      body: evidenceDeleteSchema,
    }),
    output: z.null(),
    description: "Delete an evidence asset after deleting its stored object.",
  },
  "node.check": {
    ...writeOperation,
    id: "mission.node.check",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/check",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema("node") }),
      query: z.strictObject({}),
      body: nodeCheckSchema,
    }),
    output: nodeCheckResultSchema,
    description: "Check unresolved external requests on demand.",
  },
  "delivery.admit": {
    ...writeOperation,
    access: AccessPolicy.Service,
    id: "mission.delivery.admit",
    method: HttpMethod.Post,
    path: "/api/mission/delivery/admit",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: deliveryAdmitSchema,
    }),
    output: admissionAnswerSchema,
    description:
      "Admit an inbound platform event as the end state of one request evidence for the Intake Service.",
  },
  "assessment.submit": {
    ...writeOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.assessment.submit",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/assessment",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema("node") }),
      query: z.strictObject({}),
      body: assessmentSubmitSchema,
    }),
    output: assessmentSubmitResultSchema,
    description: "Submit an evaluation assessment and close eligible attempts.",
  },
  "evidence.asset.content.get": {
    ...readOperation,
    id: "mission.evidence.asset.content.get",
    method: HttpMethod.Get,
    path: "/api/mission/evidence/asset/:asset_id/content",
    input: readInput(
      z.strictObject({ asset_id: identitySchema("evidence_asset") }),
      z.strictObject({}),
    ),
    output: storedContentSchema,
    description: "Read stored evidence content.",
  },
  "execution.evidence.asset.content.get": {
    ...readOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.execution.evidence.asset.content.get",
    method: HttpMethod.Get,
    path: "/api/mission/execution/:execution_id/evidence/asset/:asset_id/content",
    input: readInput(
      z.strictObject({
        execution_id: identitySchema("execution"),
        asset_id: identitySchema("evidence_asset"),
      }),
      z.strictObject({}),
    ),
    output: storedContentSchema,
    description: "Read evidence content within a live execution bound.",
  },
  "evidence.list": {
    ...readOperation,
    id: "mission.evidence.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/evidence",
    input: readInput(
      z.strictObject({ node_id: identitySchema("node") }),
      z.strictObject({ ...pageQuery, attempt: attemptSelector(0).optional() }),
    ),
    output: pageOf(evidenceSchema),
    description: "List evidence of a runnable node.",
  },
  "evidence.get": {
    ...readOperation,
    id: "mission.evidence.get",
    method: HttpMethod.Get,
    path: "/api/mission/evidence/:evidence_id",
    input: readInput(
      z.strictObject({ evidence_id: identitySchema("evidence") }),
      z.strictObject({}),
    ),
    output: evidenceSchema,
    description: "Read an evidence record.",
  },
  "evidence.submit": {
    ...writeOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.evidence.submit",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/evidence",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema("node") }),
      query: z.strictObject({}),
      body: evidenceSubmitSchema,
    }),
    output: evidenceSubmitResultSchema,
    description: "Submit execution evidence and prepare object uploads.",
  },
  "evidence.request": {
    ...writeOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.evidence.request",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/evidence/request",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema("node") }),
      query: z.strictObject({}),
      body: evidenceRequestSchema,
    }),
    output: evidenceSchema,
    description: "Record an external action request under an evaluation claim.",
  },
  "evidence.asset.complete": {
    ...writeOperation,
    access: AccessPolicy.Client,
    requiresExecution: true,
    id: "mission.evidence.asset.complete",
    method: HttpMethod.Post,
    path: "/api/mission/evidence/asset/:asset_id/complete",
    input: z.strictObject({
      params: z.strictObject({ asset_id: identitySchema("evidence_asset") }),
      query: z.strictObject({}),
      body: executionContextSchema,
    }),
    output: assetUploadResultSchema,
    description: "Complete a verified object evidence upload.",
  },
  "assessment.list": {
    ...readOperation,
    id: "mission.assessment.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/assessment",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject({
        ...pageQuery,
        attempt: attemptSelector(0).optional(),
      }),
    ),
    output: pageOf(assessmentSchema),
    description: "List assessments with read-time currency.",
  },
  "assessment.get": {
    ...readOperation,
    id: "mission.assessment.get",
    method: HttpMethod.Get,
    path: "/api/mission/assessment/:assessment_id",
    input: readInput(
      z.strictObject({ assessment_id: identitySchema("assessment") }),
      z.strictObject({}),
    ),
    output: assessmentSchema,
    description: "Get an assessment with read-time currency.",
  },
  "outcome.list": {
    ...readOperation,
    id: "mission.outcome.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/outcome",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject({
        ...pageQuery,
        attempt: attemptSelector(0).optional(),
      }),
    ),
    output: pageOf(outcomeSchema),
    description: "List a node's outcomes.",
  },
  "outcome.get": {
    ...readOperation,
    id: "mission.outcome.get",
    method: HttpMethod.Get,
    path: "/api/mission/outcome/:outcome_id",
    input: readInput(
      z.strictObject({ outcome_id: identitySchema("outcome") }),
      z.strictObject({}),
    ),
    output: outcomeSchema,
    description: "Get an outcome with its evidence union.",
  },
  "attempt.list": {
    ...readOperation,
    id: "mission.attempt.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/attempt",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(attemptSchema),
    description: "List node attempts in descending attempt order.",
  },
  "attempt.get": {
    ...readOperation,
    id: "mission.attempt.get",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/attempt/:attempt",
    input: readInput(
      z.strictObject({
        node_id: identitySchema(NODE_IDENTITY_PREFIX),
        attempt: attemptSelector(1),
      }),
      z.strictObject({}),
    ),
    output: attemptSchema,
    description: "Get a node attempt.",
  },
  "externalAction.list": {
    ...readOperation,
    id: "mission.externalAction.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/external-action",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject({
        ...pageQuery,
        attempt: attemptSelector(0).optional(),
      }),
    ),
    output: pageOf(externalActionSchema),
    description: "List frozen external actions across attempts.",
  },
  "externalAction.get": {
    ...readOperation,
    id: "mission.externalAction.get",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/attempt/:attempt/external-action/:action_key",
    input: readInput(
      z.strictObject({
        node_id: identitySchema(NODE_IDENTITY_PREFIX),
        attempt: attemptSelector(1),
        action_key: actionKeySchema,
      }),
      z.strictObject({}),
    ),
    output: externalActionSchema,
    description: "Get a required external action of an attempt.",
  },
  "proposal.list": {
    ...readOperation,
    id: "mission.proposal.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/proposal",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject({ ...pageQuery, attempt: attemptSelector(0).optional() }),
    ),
    output: pageOf(proposalSchema),
    description: "List fix-objective proposals of an initiative.",
  },
  "proposal.approve": {
    ...writeOperation,
    id: "mission.proposal.approve",
    method: HttpMethod.Post,
    path: "/api/mission/proposal/:proposal_id/approve",
    input: z.strictObject({
      params: z.strictObject({
        proposal_id: identitySchema(PROPOSAL_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: proposalApproveSchema,
    }),
    output: proposalApproveResultSchema,
    description:
      "Approve a fix-objective proposal, create its objective and unblock the initiative.",
  },
  "node.unblock": {
    ...writeOperation,
    id: "mission.node.unblock",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/unblock",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: unblockSchema,
    }),
    output: controlResultSchema,
    description: "Unblock a node and pin its next attempt atomically.",
  },
  "node.override": {
    ...writeOperation,
    id: "mission.node.override",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/override",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: overrideSchema,
    }),
    output: controlResultSchema,
    description: "Override a nonterminal node with human-assessed success.",
  },
  "node.block": {
    ...writeOperation,
    id: "mission.node.block",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/block",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: humanActSchema,
    }),
    output: controlResultSchema,
    description: "Block a paused node and close its attempt.",
  },
  "node.discard": {
    ...writeOperation,
    id: "mission.node.discard",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/discard",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: humanActSchema,
    }),
    output: controlResultSchema,
    description: "Discard a node and close its attempt.",
  },
  "node.ready": {
    ...writeOperation,
    id: "mission.node.ready",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/ready",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: humanActSchema,
    }),
    output: controlResultSchema,
    description: "Declare an available node ready for evaluation.",
  },
  "node.resume": {
    ...writeOperation,
    id: "mission.node.resume",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/resume",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: resumeSchema,
    }),
    output: controlResultSchema,
    description: "Resume a paused node with external-action precedence.",
  },
  "node.pause": {
    ...writeOperation,
    id: "mission.node.pause",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/pause",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: humanActSchema,
    }),
    output: controlResultSchema,
    description: "Pause a node and revoke its live claim.",
  },
  export: {
    ...readOperation,
    id: "mission.export",
    method: HttpMethod.Get,
    path: "/api/mission/:mission_id/export",
    input: readInput(
      z.strictObject({ mission_id: identitySchema(MISSION_IDENTITY_PREFIX) }),
      z.strictObject({ format: importFormatSchema }),
    ),
    output: exportAnswerSchema,
    description: "Export the current mission plan.",
  },
  "import.apply": {
    ...writeOperation,
    id: "mission.import.apply",
    method: HttpMethod.Post,
    path: "/api/mission/:mission_id/import",
    input: z.strictObject({
      params: z.strictObject({
        mission_id: identitySchema(MISSION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: importApplySchema,
    }),
    output: importResultSchema,
    description: "Apply a whole-mission import atomically.",
  },
  "import.preview": {
    ...readOperation,
    body: true,
    id: "mission.import.preview",
    method: HttpMethod.Post,
    path: "/api/mission/:mission_id/import/preview",
    input: z.strictObject({
      params: z.strictObject({
        mission_id: identitySchema(MISSION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: importSnapshotSchema,
    }),
    output: importPreviewSchema,
    description: "Preview a whole-mission import without writing changes.",
  },
  "edge.list": {
    ...readOperation,
    id: "mission.edge.list",
    method: HttpMethod.Get,
    path: "/api/mission/:mission_id/edge",
    input: readInput(
      z.strictObject({ mission_id: identitySchema(MISSION_IDENTITY_PREFIX) }),
      z.strictObject({
        ...pageQuery,
        kind: edgeKindSchema.optional(),
        node_id: identitySchema(NODE_IDENTITY_PREFIX).optional(),
      }),
    ),
    output: pageOf(edgeSchema),
    description: "List current mission edges.",
  },
  "dependency.add": {
    ...writeOperation,
    id: "mission.dependency.add",
    method: HttpMethod.Put,
    path: "/api/mission/node/:node_id/dependency/:depends_on_id",
    input: dependencyInput,
    output: nodeChangeSchema,
    description: "Add a mission dependency.",
  },
  "dependency.remove": {
    ...writeOperation,
    id: "mission.dependency.remove",
    method: HttpMethod.Delete,
    path: "/api/mission/node/:node_id/dependency/:depends_on_id",
    input: dependencyInput,
    output: nodeChangeSchema,
    description: "Remove a mission dependency.",
  },
  "node.list": {
    ...readOperation,
    id: "mission.node.list",
    method: HttpMethod.Get,
    path: "/api/mission/:mission_id/node",
    input: readInput(
      z.strictObject({ mission_id: identitySchema(MISSION_IDENTITY_PREFIX) }),
      z
        .strictObject({
          ...pageQuery,
          kind: nodeKindSchema.optional(),
          state: nodeStateSchema.optional(),
          parent_id: identitySchema(NODE_IDENTITY_PREFIX).optional(),
          include_retired: z
            .enum(["true", "false"])
            .default("false")
            .optional(),
        })
        .refine(
          (query) => query.kind !== NodeKind.Task || query.state === undefined,
        ),
    ),
    output: pageOf(nodeSchema),
    description: "List mission nodes.",
  },
  "node.get": {
    ...readOperation,
    id: "mission.node.get",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject({}),
    ),
    output: nodeSchema,
    description: "Get a mission node.",
  },
  "node.revision.list": {
    ...readOperation,
    id: "mission.node.revision.list",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/revision",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject(pageQuery),
    ),
    output: pageOf(revisionSchema),
    description: "List node content revisions.",
  },
  "node.revision.get": {
    ...readOperation,
    id: "mission.node.revision.get",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/revision/:revision",
    input: readInput(
      z.strictObject({
        node_id: identitySchema(NODE_IDENTITY_PREFIX),
        revision: z.coerce.number().int().positive().safe(),
      }),
      z.strictObject({}),
    ),
    output: revisionSchema,
    description: "Get a node content revision.",
  },
  "node.retire.preview": {
    ...readOperation,
    id: "mission.node.retire.preview",
    method: HttpMethod.Get,
    path: "/api/mission/node/:node_id/retire/preview",
    input: readInput(
      z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      z.strictObject({
        force: z.enum(["true", "false"]).default("false"),
      }),
    ),
    output: retirePreviewSchema,
    description: "Preview retirement of a mission node and its descendants.",
  },
  "node.rebind": {
    ...writeOperation,
    id: "mission.node.rebind",
    method: HttpMethod.Post,
    path: "/api/mission/:mission_id/rebind",
    input: z.strictObject({
      params: z.strictObject({
        mission_id: identitySchema(MISSION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: rebindSchema,
    }),
    output: rebindResultSchema,
    description: "Rebind mission nodes to a newer binding revision.",
  },
  "node.retire": {
    ...writeOperation,
    id: "mission.node.retire",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/retire",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: retireSchema,
    }),
    output: nodeChangeSchema,
    description: "Retire a mission node and its descendants.",
  },
  "node.priority.set": {
    ...writeOperation,
    id: "mission.node.priority.set",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/priority",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: prioritySetSchema,
    }),
    output: nodeSchema,
    description: "Set the priority of a mission initiative or objective.",
  },
  "node.move": {
    ...writeOperation,
    id: "mission.node.move",
    method: HttpMethod.Post,
    path: "/api/mission/node/:node_id/move",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: moveSchema,
    }),
    output: nodeChangeSchema,
    description: "Move a mission node to a new parent.",
  },
  "criterion.set": {
    ...writeOperation,
    id: "mission.criterion.set",
    method: HttpMethod.Put,
    path: "/api/mission/node/:node_id/criterion",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: criterionSetSchema,
    }),
    output: nodeChangeSchema,
    description: "Set mission node criterion and verifications.",
  },
  "node.update": {
    ...writeOperation,
    id: "mission.node.update",
    method: HttpMethod.Put,
    path: "/api/mission/node/:node_id",
    input: z.strictObject({
      params: z.strictObject({ node_id: identitySchema(NODE_IDENTITY_PREFIX) }),
      query: z.strictObject({}),
      body: nodeUpdateSchema,
    }),
    output: nodeChangeSchema,
    description: "Update mission node content.",
  },
  "node.create": {
    ...writeOperation,
    id: "mission.node.create",
    method: HttpMethod.Post,
    path: "/api/mission/:mission_id/node",
    input: z.strictObject({
      params: z.strictObject({
        mission_id: identitySchema(MISSION_IDENTITY_PREFIX),
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
    path: "/api/mission/project/:project_id",
    input: readInput(
      z.strictObject({ project_id: identitySchema("project") }),
      z.strictObject({}),
    ),
    output: missionSchema,
    description: "Get the mission of a project.",
  },
} as const satisfies Record<string, Operation>;
