import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import {
  handoverEnvelopeSchema,
  type HandoverEnvelope,
} from "../kernel/handover.ts";
import type { CallerIdentity, MachineIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import {
  AccessPolicy,
  StoreName,
  OperationLifetime,
  emptyInput,
  type ExecutionClaim,
  type Operation,
  type ClientOptions,
  type OperationResult,
} from "../kernel/operation.ts";
import type { SshAccess } from "../repository/contract.ts";
import type { Transaction } from "../kernel/store.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  ChainLevel,
  effectiveConfigurationSchema,
  promptTemplatesSchema,
  type AgentView,
  type AgentSelection,
  type ApprovedModelsFn,
  type DefaultConfiguration,
} from "../agent/contract.ts";
export const SourceState = {
  Present: "present",
  Absent: "absent",
  Invalid: "invalid",
} as const;
export const InvalidReason = {
  TooLarge: "too_large",
  NotUtf8: "not_utf8",
  ControlCharacter: "control_character",
  NotRegularFile: "not_regular_file",
  OutsideWorkspace: "outside_workspace",
  Deadline: "deadline",
  Unreadable: "unreadable",
} as const;
export type InvalidReason = (typeof InvalidReason)[keyof typeof InvalidReason];
export const WorkerHost = {
  Kanthord: "kanthord",
  ExternalHarness: "external-harness",
} as const;
export type WorkerHost = (typeof WorkerHost)[keyof typeof WorkerHost];
export const WorkerMethod = {
  Steps: "steps",
  Evaluation: "evaluation",
} as const;
export type WorkerMethod = (typeof WorkerMethod)[keyof typeof WorkerMethod];
export interface VerifiedClient {
  client_id: string;
  name: string;
  resource_identity: string;
  project_id: string;
}
export const HANDOVER_TIMEOUT_MS = 30000;
export const ACTION_REQUEST_TOOL_NAME = "repository-action-request";
export const ACTION_REQUEST_TIMEOUT_MS = 900000;
export const CHANGE_REQUEST_TIMEOUT_MS = 60000;
export const ActionResultKind = {
  Submitted: "submitted",
  AwaitingPrerequisite: "awaiting-prerequisite",
  FailedBeforeEffect: "failed-before-effect",
  Uncertain: "uncertain",
} as const;
export const actionResultKindSchema = z.enum(ActionResultKind);
export type ActionResultKind = z.infer<typeof actionResultKindSchema>;
export const RefusalClass = {
  ConfirmedFailure: "confirmed_failure",
  RetryableRefusal: "retryable_refusal",
  FinalRefusal: "final_refusal",
} as const;
export const refusalClassSchema = z.enum(RefusalClass);
export type RefusalClass = z.infer<typeof refusalClassSchema>;
export const ResultClass = {
  ...RefusalClass,
  UnknownOutcome: "unknown_outcome",
} as const;
export const resultClassSchema = z.enum(ResultClass);
export type ResultClass = z.infer<typeof resultClassSchema>;
export const Uncertainty = {
  Effect: "effect",
  Recording: "recording",
  Both: "both",
} as const;
export const uncertaintySchema = z.enum(Uncertainty);
export type Uncertainty = z.infer<typeof uncertaintySchema>;
export const ActionReadMethod = {
  PullRequestGet: "github-pull-request-get",
  ChangeRequestGet: "github-pull-request-change-request-get",
} as const;
export const actionReadMethodSchema = z.enum(ActionReadMethod);
export type ActionReadMethod = z.infer<typeof actionReadMethodSchema>;
export const PlatformAddressKind = {
  PullRequest: "pull_request",
  BranchPush: "branch_push",
} as const;
export const platformAddressSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(PlatformAddressKind.PullRequest),
    resource_identity: z.string().min(1),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    kind: z.literal(PlatformAddressKind.BranchPush),
    resource_identity: z.string().min(1),
    branch: z.string().min(1),
    commit: z.string().min(1),
  }),
]);
export type PlatformAddress = z.infer<typeof platformAddressSchema>;
export const changeRequestSchema = z.strictObject({
  review_id: z.number().int().positive(),
  reviewer: z.string(),
  body: z.string(),
  submitted_at: z.string().nullable(),
  commit_id: z.string().min(1),
  comments: z.array(
    z.strictObject({
      path: z.string(),
      line: z.number().int().nullable(),
      body: z.string(),
    }),
  ),
});
export type ChangeRequest = z.infer<typeof changeRequestSchema>;
export const changeRequestReadSchema = z.strictObject({
  head_commit: z.string().min(1),
  change_requests: z.array(changeRequestSchema),
});
export type ChangeRequestRead = z.infer<typeof changeRequestReadSchema>;
export const clearedChangeRequestsSchema = z.strictObject({
  items: z.array(
    changeRequestReadSchema.extend({
      evidence_id: identitySchema("evidence"),
      binding_id: identitySchema("binding"),
    }),
  ),
});
export type ClearedChangeRequests = z.infer<typeof clearedChangeRequestsSchema>;
export const actionRefSchema = z.strictObject({
  key: z.string().min(1),
  binding_id: identitySchema("binding"),
});
export type ActionRef = z.infer<typeof actionRefSchema>;
export const actionResultItemSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(ActionResultKind.Submitted),
    evidence: z
      .record(z.string(), z.unknown())
      .describe("Mission Evidence record"),
  }),
  z.strictObject({
    kind: z.literal(ActionResultKind.AwaitingPrerequisite),
    action: actionRefSchema,
    prerequisite: z.strictObject({
      key: z.string().min(1),
      evidence_id: identitySchema("evidence"),
    }),
  }),
  z.strictObject({
    kind: z.literal(ActionResultKind.FailedBeforeEffect),
    action: actionRefSchema,
    refusal: z.strictObject({
      class: refusalClassSchema,
      code: z.string().min(1),
      message: z.string(),
    }),
  }),
  z.strictObject({
    kind: z.literal(ActionResultKind.Uncertain),
    action: actionRefSchema,
    uncertainty: uncertaintySchema,
    address: platformAddressSchema.optional(),
  }),
]);
export type ActionResultItem = z.infer<typeof actionResultItemSchema>;
export const actionRequestResultSchema = z.strictObject({
  tool_name: z.literal(ACTION_REQUEST_TOOL_NAME),
  items: z.array(actionResultItemSchema),
});
export type ActionRequestResult = z.infer<typeof actionRequestResultSchema>;
export const RepositoryAction = {
  PullRequest: "pull_request",
  MergePush: "merge_push",
} as const;
export type FrozenAction = {
  key: string;
  binding_id: string;
  action: (typeof RepositoryAction)[keyof typeof RepositoryAction];
  expected_end_state: "pull_request_merged" | "base_branch_pushed";
  follows: string | null;
  configuration: { base_branch: string; landing: "human" | "kanthord" };
};
export const ActionNodeState = {
  Pending: "Pending",
  Available: "Available",
  Executing: "Executing",
  Waiting: "Waiting",
  Evaluating: "Evaluating",
  ExternalRequested: "External.Requested",
  ExternalSuccess: "External.Success",
  ExternalFailed: "External.Failed",
  Completed: "Completed",
  Blocked: "Blocked",
  Paused: "Paused",
  Discarded: "Discarded",
} as const;
export const ActionAssessmentResult = {
  Success: "success",
  CriterionNotMet: "criterion-not-met",
  Undetermined: "undetermined",
} as const;
export const ActionResolution = {
  Unrequested: "unrequested",
  Unresolved: "unresolved",
  ExpectedEnd: "expected-end",
  OtherEnd: "other-end",
} as const;
export const TestedInputKind = {
  Repository: "repository",
  Produced: "produced",
  Object: "object",
} as const;
export type RepositorySnapshot = {
  kind: typeof TestedInputKind.Repository;
  binding_id: string;
  commit: string;
};
export type TestedInput =
  | RepositorySnapshot
  | RepositorySnapshot[]
  | { kind: typeof TestedInputKind.Produced; sha256: string }
  | {
      kind: typeof TestedInputKind.Object;
      location: string;
      version?: string;
      sha256?: string;
    };
export type ActionContext = {
  state: (typeof ActionNodeState)[keyof typeof ActionNodeState];
  current_assessment: {
    result: (typeof ActionAssessmentResult)[keyof typeof ActionAssessmentResult];
    tested_input: TestedInput;
  } | null;
  actions: {
    action: FrozenAction;
    resource_identity: string;
    resolution: (typeof ActionResolution)[keyof typeof ActionResolution];
    request_evidence_id: string | null;
    eligible: boolean;
    reuse_candidates: {
      evidence_id: string;
      attempt: number;
      address: PlatformAddress;
    }[];
  }[];
};
export interface MissionActions {
  authorizeRequest(
    tx: Transaction,
    evidenceId: string,
    claim: import("../kernel/operation.ts").ExecutionClaim,
  ): FrozenAction;
  authorizeAction(
    tx: Transaction,
    claim: import("../kernel/operation.ts").ExecutionClaim,
    key: string,
  ): FrozenAction;
  actionContextOf(
    tx: Transaction,
    nodeId: string,
    attempt: number,
  ): ActionContext;
}
export type IntakeActionCall = {
  context: Context;
  identity: CallerIdentity;
  executionId: string;
};
export type ActionOperands = {
  nodeBranch: string;
  baseBranch: string;
  commit: string;
  reusedAddress: PlatformAddress | null;
  reusedEvidenceId: string | null;
};
export type ActionPerformInput = {
  key: string;
  commit: string;
  reusedEvidenceId: string | null;
  mergeEvidenceId?: string | null;
};
export type ActionReadPage = { limit?: number; cursor?: string };
export type ResultClassAnswer = {
  class: ResultClass;
  code: string;
  message: string;
};
export interface IntakeActions {
  perform(
    call: IntakeActionCall,
    action: ActionPerformInput,
    requestKey: string,
  ): Promise<PlatformAddress | ResultClassAnswer>;
  read(
    call: IntakeActionCall,
    method: ActionReadMethod,
    evidenceId: string,
    page: ActionReadPage,
  ): Promise<{ body: unknown; next_cursor: string | null } | ResultClassAnswer>;
}
export interface EvidenceRequests {
  request(
    input: {
      params: { node_id: string };
      query: Record<string, never>;
      body: {
        execution_id: string;
        attempt: number;
        node_revision: number;
        requirement_key: string;
        subject: string;
        address: PlatformAddress;
      };
    },
    options: ClientOptions,
  ): Promise<OperationResult<unknown>>;
}
export const HANDOVER_MAX_BODY_BYTES = 1024;
export const CREDENTIAL_REPORT_MAX_BODY_BYTES = 64 * 1024;
export interface CustodyHandover {
  handover(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    repositoryBindingIds: readonly string[],
    now: number,
  ): HandoverEnvelope;
  report(
    tx: Transaction,
    identity: MachineIdentity,
    execution: { executionId: string; runtimeIdentity: string },
    envelope: HandoverEnvelope,
    now: number,
  ): void;
}
export interface Registration extends VerifiedClient {
  runtime_identity: string;
  registered_at: number;
}
export type WorkerBindingOf = (
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
) => {
  binding_id: string;
  name: string;
  project_name: string;
  revision: number;
  worker_name: string;
  instance_count: number;
  placement: InstancePlacement | null;
  generation: number;
  resource_budget: { turns: number; wall_time_ms: number } | null;
  entries: Array<WorkerEntry & { agent: string }>;
  tombstone: boolean;
} | null;

export type WorkerBindingsOf = (
  tx: Transaction,
  projectId: string | null,
) => Array<
  NonNullable<ReturnType<WorkerBindingOf>> & {
    project_id: string;
    resource_identity: string;
  }
>;

export const AuthorizationRefusal = {
  BindingMismatch: "binding_mismatch",
  BindingRemoved: "binding_removed",
  BindingDisabled: "binding_disabled",
  NoNativeAgent: "no_native_agent",
} as const;
export type AuthorizationRefusal =
  (typeof AuthorizationRefusal)[keyof typeof AuthorizationRefusal];

export type WorkerBindingRowOf = (
  tx: Transaction,
  bindingId: string,
) => {
  binding_id: string;
  project_id: string;
  resource_identity: string;
  tombstone: boolean;
  disabled: boolean;
  worker_name: string;
  entries: Array<WorkerEntry & { agent: string }>;
  resource_budget: { turns: number; wall_time_ms: number } | null;
} | null;

export type RepositoryPolicyOf = (
  tx: Transaction,
  bindingId: string,
) => {
  binding_id: string;
  name: string;
  address: string;
  platform: string;
  ssh_credential: string;
  base_branch: string;
  project_prompt: string | null;
  working_layer: WorkingLayer;
} | null;

export type RepositoryBindingIdsOf = (
  tx: Transaction,
  nodeId: string,
  nodeRevision: number,
) => string[];

export const ExecutionIntent = {
  Implement: "implement",
  Examine: "examine",
} as const;
export type ExecutionIntent =
  (typeof ExecutionIntent)[keyof typeof ExecutionIntent];
export type IntentOf = (
  tx: Transaction,
  nodeId: string,
  nodeRevision: number,
) => ExecutionIntent;

export const InstanceActivity = {
  Idle: "idle",
  Pulling: "pulling",
  Executing: "executing",
} as const;
export type InstanceActivity =
  (typeof InstanceActivity)[keyof typeof InstanceActivity];
export const InstancePlacement = {
  Server: "server",
  Container: "container",
  Worker: "worker",
} as const;
export type InstancePlacement =
  (typeof InstancePlacement)[keyof typeof InstancePlacement];
export const PoolPlacement = {
  Server: InstancePlacement.Server,
  Container: InstancePlacement.Container,
} as const;
export type PoolPlacement = (typeof PoolPlacement)[keyof typeof PoolPlacement];
export const POOL_PLACEMENTS: readonly InstancePlacement[] =
  Object.values(PoolPlacement);
export function hostsPoolSlot(
  placement: InstancePlacement | null,
): placement is PoolPlacement {
  return placement !== null && POOL_PLACEMENTS.includes(placement);
}
export const PlacementIssue = {
  ServerInContainer: "server_in_container",
  RuntimeAbsent: "runtime_absent",
  RuntimeFailed: "runtime_failed",
  RuntimeRootful: "runtime_rootful",
} as const;
export type PlacementIssue =
  (typeof PlacementIssue)[keyof typeof PlacementIssue];
export const ContainerRuntime = { Podman: "podman", Docker: "docker" } as const;
export type ContainerRuntime =
  (typeof ContainerRuntime)[keyof typeof ContainerRuntime];
export interface PlacementStatus {
  placement: InstancePlacement;
  available: boolean;
  reason: PlacementIssue | null;
  detail: string | null;
  container_runtime: ContainerRuntime | null;
}
export const placementStatusSchema = z.strictObject({
  placement: z.enum(InstancePlacement),
  available: z.boolean(),
  reason: z.enum(PlacementIssue).nullable(),
  detail: z.string().nullable(),
  container_runtime: z.enum(ContainerRuntime).nullable(),
});
export function alwaysAvailable(placement: InstancePlacement): PlacementStatus {
  return {
    placement,
    available: true,
    reason: null,
    detail: null,
    container_runtime: null,
  };
}
export const workerResourceIdentitySchema = z
  .string()
  .regex(/^worker:kanthord:[a-z][a-z0-9-]{0,62}$/);
export const instanceRecordSchema = z
  .strictObject({
    runtime_identity: identitySchema("worker_instance"),
    project_id: identitySchema("project"),
    resource_identity: workerResourceIdentitySchema,
    worker_name: z.string().min(1),
    host: z.enum(WorkerHost),
    placement: z.enum(InstancePlacement).optional(),
    client_id: identitySchema("client_identity").optional(),
    name: z.string().min(1).max(64).optional(),
    activity: z.enum(InstanceActivity),
    draining: z.boolean(),
    execution_id: identitySchema("execution").optional(),
    registered: z.boolean(),
  })
  .and(
    z.union([
      z.looseObject({
        host: z.literal(WorkerHost.Kanthord),
        placement: z.enum(InstancePlacement),
      }),
      z.looseObject({
        host: z.literal(WorkerHost.ExternalHarness),
        placement: z.never().optional(),
      }),
    ]),
  )
  .and(
    z.union([
      z.looseObject({
        registered: z.literal(true),
        client_id: identitySchema("client_identity"),
        name: z.string().min(1).max(64),
      }),
      z.looseObject({
        registered: z.literal(false),
        client_id: z.never().optional(),
        name: z.never().optional(),
      }),
    ]),
  )
  .and(
    z.union([
      z.looseObject({
        activity: z.literal(InstanceActivity.Executing),
        execution_id: identitySchema("execution"),
      }),
      z.looseObject({
        activity: z.enum([InstanceActivity.Idle, InstanceActivity.Pulling]),
        execution_id: z.never().optional(),
      }),
    ]),
  );

export interface SchedulerClaims {
  requireRunning(
    tx: Transaction,
    executionId: string,
    runtimeIdentity: string,
    now: number,
  ): {
    execution_id: string;
    node_id: string;
    attempt: number;
    pinned_revision: number;
  };
  runningExecutionOfRuntime(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): { execution_id: string } | null;
  activityOf(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): { activity: InstanceActivity; execution_id: string | null };
  agentSelectionsOf(tx: Transaction, executionId: string): AgentSelection[];
}

export type WorkerEntry = {
  agent_provider?: string;
  model_identifier?: string;
  reasoning_effort?: string;
  fallback_configurations?: DefaultConfiguration[];
};

export type CredentialMetadataRecord = {
  id: string;
  name: string;
  platform: string;
  metadata: Record<string, unknown> | null;
};

export type PinnedCredentialMetadataFn = (
  tx: Transaction,
  execution: { executionId: string; runtimeIdentity: string },
  credentialName: string,
  now: number,
) => CredentialMetadataRecord | null;

export const REGISTRATION_CAPABILITY = "liveness of a registration";
export const REGISTRATION_TARGET_KIND = "registration";

export type WorkerAgentView = AgentView;

export interface AgentConfiguration {
  validateEntry(
    tx: Transaction,
    agentName: string,
    entry: WorkerEntry | null,
  ): void;
  agentView(
    tx: Transaction,
    agentName: string,
    entry: WorkerEntry | null,
    approvedModels?: ApprovedModelsFn,
  ): WorkerAgentView | null;
  selectAgent(
    tx: Transaction,
    agentName: string,
    entry: WorkerEntry | null,
  ):
    | { kind: "selected"; selection: AgentSelection; enablement_id: string }
    | { kind: "cooling"; available_at: number }
    | { kind: "invalid" };
  selectionAt(
    tx: Transaction,
    agentName: string,
    enablementId: string,
    entry: WorkerEntry | null,
    position: number,
  ): AgentSelection;
  selectionView(
    tx: Transaction,
    selection: AgentSelection,
    approvedModels?: ApprovedModelsFn,
  ): Pick<WorkerAgentView, "effective" | "valid" | "issues">;
}

export interface WorkerRegistrations {
  deregister(tx: Transaction, runtimeIdentity: string, now: number): void;
  register(
    transaction: Transaction,
    client: VerifiedClient,
    now: number,
  ): Registration & { worker_name: string };
  findByClient(clientId: string): Registration | undefined;
  liveRegistrationOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): Registration | null;
  clientAttributionOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): { client_id: string; name: string } | null;
  heartbeat(runtimeIdentity: string): void;
}

export const POOL_SLOT_COUNT = 64;
export interface PoolSlot {
  project_id: string;
  resource_identity: string;
  generation: number;
  placement: PoolPlacement;
  slot: number;
  client_id: string;
  draining: boolean;
}
export interface PoolHost {
  clientIdentity(
    projectId: string,
    resourceIdentity: string,
    generation: number,
    slot: number,
  ): string;
  prepare(): void;
  start(slot: PoolSlot): void;
  drain(slot: PoolSlot): void;
  stop(): Promise<void>;
  onEnded(listener: (clientId: string) => void): void;
  placementStatus(placement: PoolPlacement): Promise<PlacementStatus>;
}

export const WORKER_SERVICE_NAME = "worker";
export const HUMAN_TIMEOUT_MS = 30000;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;

export const WorkerErrorCode = {
  AuthorizationRefused: "worker.authorization.refused",
  ExecutionNoNativeAgent: "worker.execution.no_native_agent",
  ExecutionCredentialNotPinned: "worker.execution.credential_not_pinned",
  StartToolMissing: "worker.start.tool_missing",
  RuntimeSetupRefused: "worker.runtime.setup_refused",
  ClaimNotEvaluation: "worker.action_performer.claim_not_evaluation",
  AssessmentNotCurrent: "worker.action_performer.assessment_not_current",
  SnapshotAbsent: "worker.action_performer.snapshot_absent",
  InstanceNotFound: "worker.instance.not_found",
  NoLiveExecution: "worker.instance.no_live_execution",
  ClientLive: "worker.instance.client_live",
  BindingUnknown: "worker.instance.binding_unknown",
  SlotUnavailable: "worker.instance.slot_unavailable",
  PlacementMismatch: "worker.instance.placement_mismatch",
  CatalogNotFound: "worker.catalog.not_found",
} as const;

export const HostTool = { EvidenceUpload: "evidence-upload" } as const;
export type HostTool = (typeof HostTool)[keyof typeof HostTool];
export const uploadResultSchema = z.strictObject({
  evidence_id: identitySchema("evidence"),
  asset_id: identitySchema("evidence_asset"),
  uri: z.string().startsWith("s3://"),
});
export type UploadResult = z.infer<typeof uploadResultSchema>;
export interface HostTools {
  evidenceUpload(
    path: string,
    signal: AbortSignal | undefined,
  ): Promise<UploadResult>;
}
export const SetupRefusal = {
  ModelUnknown: "model_unknown",
  ReasoningEffortUnsupported: "reasoning_effort_unsupported",
  CredentialAbsent: "credential_absent",
  CredentialRevisionMismatch: "credential_revision_mismatch",
} as const;
export interface RepositoryTransport {
  clone(
    address: string,
    directory: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<void>;
  fetchAndCheckout(
    directory: string,
    branch: string,
    baseBranch: string,
    pushed: boolean,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<string>;
  fetchBase(
    directory: string,
    baseBranch: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<string>;
  pushNodeBranch(
    directory: string,
    branch: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<void>;
  cloneSnapshot(
    address: string,
    revision: string,
    directory: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<string>;
}
export type ExecutionSetup = z.infer<typeof executionSetupSchema>;
export const catalogItemSchema = z.strictObject({
  name: z.string().min(1),
  host: z.enum(WorkerHost),
  declared_node_states: z.array(z.string()),
  declared_intents: z.array(z.enum(ExecutionIntent)),
});
const resourceBudgetSchema = z.strictObject({
  wall_time_ms: z.number().int().positive(),
  turns: z.number().int().positive().optional(),
});
export const workingLayerSchema = z.strictObject({
  agents_md: z.boolean(),
  agents_local_md: z.boolean(),
  claude_md: z.boolean(),
  claude_local_md: z.boolean(),
  project_prompt: z.boolean(),
});
export type WorkingLayer = z.infer<typeof workingLayerSchema>;
export const sshHostKeySchema = z.strictObject({
  known_hosts: z.string().min(1),
});
export type SshHostKeysOf = (
  tx: Transaction,
  platform: string,
  address: string,
) => string;
export type CredentialMetadataOf = (
  tx: Transaction,
  credentialName: string,
) => { platform: string; metadata: Record<string, unknown> | null } | null;
export const agentSetupSchema = z.strictObject({
  agent_name: z.string().min(1),
  effective_configuration: effectiveConfigurationSchema,
  position: z.number().int().min(0),
  level: z.enum(ChainLevel),
  credential_id: identitySchema("credential"),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  prompt: z.strictObject({ final: z.string() }),
});
export type AgentSetup = z.infer<typeof agentSetupSchema>;
export const executionSetupSchema = z.strictObject({
  execution_id: identitySchema("execution"),
  worker_name: z.string().min(1),
  agents: z.array(agentSetupSchema).min(1),
  templates: promptTemplatesSchema,
  resource_budget: resourceBudgetSchema,
  intent: z.enum(ExecutionIntent),
  repositories: z.array(
    z.strictObject({
      binding_id: identitySchema("binding"),
      name: z.string(),
      address: z.string(),
      ssh_host_key: sshHostKeySchema,
      strategy: z.strictObject({ base_branch: z.string() }),
      project_prompt: z.string().nullable(),
      working_layer: workingLayerSchema,
    }),
  ),
});
export const catalogEntrySchema = z.discriminatedUnion("host", [
  catalogItemSchema.extend({
    host: z.literal(WorkerHost.Kanthord),
    method: z.enum(WorkerMethod),
    agent_names: z.array(z.string().min(1)).min(1),
    resource_budget: resourceBudgetSchema,
  }),
  catalogItemSchema.extend({
    host: z.literal(WorkerHost.ExternalHarness),
    harness: z.string().min(1),
    resource_budget: resourceBudgetSchema,
  }),
]);

const emptyFields = z.strictObject({});
const runtimeIdentityParams = z.strictObject({
  runtime_identity: identitySchema("worker_instance"),
});
const humanOperation = {
  service: WORKER_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: HUMAN_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
export const workerOperations = {
  "execution.setup.get": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.execution.setup.get",
    method: HttpMethod.Get,
    path: "/api/worker/execution/:execution_id/setup",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: HANDOVER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: z.strictObject({ execution_id: identitySchema("execution") }),
      query: emptyFields,
      body: z.null(),
    }),
    output: executionSetupSchema,
    description:
      "Read native execution setup from the proven claim and its pinned binding and credential revisions, without secret material or creating a pin.",
  },
  "action.request": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.action.request",
    method: HttpMethod.Post,
    path: "/api/worker/execution/:execution_id/action/request",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: ACTION_REQUEST_TIMEOUT_MS,
    mutation: true,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: z.strictObject({ execution_id: identitySchema("execution") }),
      query: emptyFields,
      body: z.null(),
    }),
    output: actionRequestResultSchema,
    description:
      "Call the internal action performer with the execution identity alone. Return submitted evidence, awaiting prerequisites, failed-before-effect refusals or uncertainty, with no release instruction.",
  },
  "execution.change_request.get": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.execution.change_request.get",
    method: HttpMethod.Get,
    path: "/api/worker/execution/:execution_id/change-request",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: CHANGE_REQUEST_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: z.strictObject({ execution_id: identitySchema("execution") }),
      query: emptyFields,
      body: z.null(),
    }),
    output: clearedChangeRequestsSchema,
    description:
      "Read the current change requests on each pull request that ended with other in the attempt that an unblock cleared before the claimed attempt.",
  },
  handover: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.handover",
    method: HttpMethod.Post,
    path: "/api/worker/handover",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: HANDOVER_TIMEOUT_MS,
    mutation: true,
    secret: true,
    body: true,
    maxBodyBytes: HANDOVER_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: z.strictObject({ execution_id: identitySchema("execution") }),
    }),
    output: handoverEnvelopeSchema,
    description:
      "Seal the live execution's pinned provider credential and the pinned SSH identity of each repository binding of its node. A repeated idempotency key returns a redacted conflict; recovery uses a new key.",
  },
  credential: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.credential",
    method: HttpMethod.Post,
    path: "/api/worker/credential",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: HANDOVER_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: CREDENTIAL_REPORT_MAX_BODY_BYTES,
    status: HttpStatus.NoContent,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: handoverEnvelopeSchema.extend({
        execution_id: identitySchema("execution"),
      }),
    }),
    output: z.null(),
    description:
      "Apply an authenticated refresh report to the live execution's pinned revision when the replaced credential digest still matches.",
  },
  "instance.list": {
    ...humanOperation,
    id: "worker.instance.list",
    method: HttpMethod.Get,
    path: "/api/worker/instance",
    mutation: false,
    input: z.strictObject({
      params: emptyFields,
      query: z
        .strictObject({
          project_id: identitySchema("project").optional(),
          resource_identity: workerResourceIdentitySchema
            .optional()
            .describe("Requires project_id when supplied."),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(LIST_LIMIT_MAX)
            .default(LIST_LIMIT_DEFAULT),
          cursor: z.string().min(1).optional(),
        })
        .refine(
          (query) =>
            query.resource_identity === undefined ||
            query.project_id !== undefined,
          { message: "resource_identity requires project_id" },
        )
        .meta({ dependentRequired: { resource_identity: ["project_id"] } }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(instanceRecordSchema),
      next_cursor: z.string().nullable(),
    }),
    description:
      "Page live registrations in descending runtime identity order without changing runtime state.",
  },
  "placement.list": {
    ...humanOperation,
    id: "worker.placement.list",
    method: HttpMethod.Get,
    path: "/api/worker/placement",
    mutation: false,
    input: emptyInput,
    output: z.strictObject({ items: z.array(placementStatusSchema) }),
    description:
      "List each worker placement with its availability on this server and the reason when it is unavailable, in the order server, container, worker.",
  },
  "instance.get": {
    ...humanOperation,
    id: "worker.instance.get",
    method: HttpMethod.Get,
    path: "/api/worker/instance/:runtime_identity",
    mutation: false,
    input: z.strictObject({
      params: runtimeIdentityParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: instanceRecordSchema,
    description:
      "Read a live instance record. Unknown and ended instances answer not found.",
  },
  "catalog.list": {
    ...humanOperation,
    id: "worker.catalog.list",
    method: HttpMethod.Get,
    path: "/api/worker/catalog",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(LIST_LIMIT_MAX)
          .default(LIST_LIMIT_DEFAULT),
        cursor: z.string().min(1).optional(),
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(catalogItemSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "List released workers in ascending worker-name order.",
  },
  "catalog.get": {
    ...humanOperation,
    id: "worker.catalog.get",
    method: HttpMethod.Get,
    path: "/api/worker/catalog/:worker_name",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: z.strictObject({ worker_name: z.string().min(1) }),
      query: emptyFields,
      body: z.null(),
    }),
    output: catalogEntrySchema,
    description: "Get a supplied worker declaration.",
  },
  heartbeat: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.heartbeat",
    method: HttpMethod.Post,
    path: "/api/worker/heartbeat",
    access: AccessPolicy.Client,
    timeoutMs: 30000,
    mutation: false,
    status: HttpStatus.NoContent,
    input: emptyInput,
    output: z.null(),
    description:
      "Renew the live registration heartbeat with an authenticated empty request.",
  },
  "instance.deregister": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.instance.deregister",
    method: HttpMethod.Delete,
    path: "/api/worker/instance/:runtime_identity",
    access: AccessPolicy.Client,
    requiresRegistration: false,
    timeoutMs: 30000,
    mutation: true,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: runtimeIdentityParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: runtimeIdentityParams.extend({ registered: z.literal(false) }),
    description:
      "End the caller's named live registration and free its slot atomically. Same-key retries replay the recorded answer after the end.",
  },
  "instance.resume": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.instance.resume",
    method: HttpMethod.Post,
    path: "/api/worker/instance/:runtime_identity/resume",
    access: AccessPolicy.Human,
    timeoutMs: 30000,
    mutation: true,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: runtimeIdentityParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: runtimeIdentityParams.extend({ registered: z.literal(true) }),
    description:
      "Resume an ended registration with a running execution and an available slot. A live registration is unchanged.",
  },
  register: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.register",
    method: HttpMethod.Post,
    path: "/api/worker/register",
    access: AccessPolicy.Client,
    requiresRegistration: false,
    timeoutMs: 10000,
    mutation: true,
    maxBodyBytes: 40 * 1024,
    status: HttpStatus.OK,
    input: emptyInput,
    output: z.strictObject({
      runtime_identity: identitySchema("worker_instance"),
      resource_identity: workerResourceIdentitySchema,
      worker_name: z.string().min(1),
    }),
    description:
      "Register a worker instance with a bearer machine JWT and an empty body. A client identity with a live registration receives that runtime identity with any key. A recorded replay after the registration ends answers 409 gateway.registration.stale. Admission and the binding instance count share one transaction.",
  },
} as const satisfies Record<string, Operation>;
