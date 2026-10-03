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
  type Operation,
  type ClientOptions,
  type OperationResult,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { ResourceCheck } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
export const SourceState = {
  Present: "present",
  Absent: "absent",
  Invalid: "invalid",
  Disabled: "disabled",
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
  clientId: string;
  name: string;
  resourceIdentity: string;
  projectId: string;
}
export const HANDOVER_TIMEOUT_MS = 30000;
export const ACTION_REQUEST_TOOL_NAME = "repository-action-request";
export const ACTION_REQUEST_TIMEOUT_MS = 900000;
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
    resourceIdentity: z.string().min(1),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    kind: z.literal(PlatformAddressKind.BranchPush),
    resourceIdentity: z.string().min(1),
    branch: z.string().min(1),
    commit: z.string().min(1),
  }),
]);
export type PlatformAddress = z.infer<typeof platformAddressSchema>;
export const actionRefSchema = z.strictObject({
  key: z.string().min(1),
  bindingId: identitySchema("binding"),
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
      evidenceId: identitySchema("evidence"),
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
  toolName: z.literal(ACTION_REQUEST_TOOL_NAME),
  items: z.array(actionResultItemSchema),
});
export type ActionRequestResult = z.infer<typeof actionRequestResultSchema>;
export const RepositoryAction = {
  PullRequest: "pull_request",
  MergePush: "merge_push",
} as const;
export type FrozenAction = {
  key: string;
  bindingId: string;
  action: (typeof RepositoryAction)[keyof typeof RepositoryAction];
  expectedEndState: "pull_request_merged" | "base_branch_pushed";
  follows: string | null;
  configuration: { baseBranch: string };
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
  bindingId: string;
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
  currentAssessment: {
    result: (typeof ActionAssessmentResult)[keyof typeof ActionAssessmentResult];
    testedInput: TestedInput;
  } | null;
  actions: {
    action: FrozenAction;
    resourceIdentity: string;
    resolution: (typeof ActionResolution)[keyof typeof ActionResolution];
    requestEvidenceId: string | null;
    eligible: boolean;
    reuseCandidates: {
      evidenceId: string;
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
};
export type ResultClassAnswer = {
  class: ResultClass;
  code: string;
  message: string;
};
export interface IntakeActions {
  perform(
    call: IntakeActionCall,
    action: FrozenAction,
    operands: ActionOperands,
    requestKey: string,
  ): Promise<PlatformAddress | ResultClassAnswer>;
  read(
    call: IntakeActionCall,
    method: ActionReadMethod,
    address: PlatformAddress,
  ): Promise<{ body: unknown } | ResultClassAnswer>;
}
export interface EvidenceRequests {
  request(
    input: {
      params: { nodeId: string };
      query: Record<string, never>;
      body: {
        executionId: string;
        attempt: number;
        nodeRevision: number;
        requirementKey: string;
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
    execution: { executionId: string; runtimeIdentity: string },
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
  runtimeIdentity: string;
  registeredAt: number;
}
export type WorkerBindingOf = (
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
) => {
  bindingId: string;
  revision: number;
  workerName: string;
  instanceCount: number;
  resourceBudget: { turns: number; wallTimeMs: number } | null;
  entries: Array<WorkerEntry & { agent: string }>;
  tombstone: boolean;
} | null;

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
  bindingId: string;
  projectId: string;
  resourceIdentity: string;
  tombstone: boolean;
  disabled: boolean;
  workerName: string;
  entries: Array<WorkerEntry & { agent: string }>;
  resourceBudget: { turns: number; wallTimeMs: number } | null;
} | null;

export type RepositoryPolicyOf = (
  tx: Transaction,
  bindingId: string,
) => {
  bindingId: string;
  name: string;
  address: string;
  baseBranch: string;
  projectPrompt: string | null;
} | null;

export type RepositoryBindingIdsOf = (
  tx: Transaction,
  nodeId: string,
  nodeRevision: number,
) => string[];

export const InstanceActivity = {
  Idle: "idle",
  Pulling: "pulling",
  Executing: "executing",
} as const;
export type InstanceActivity =
  (typeof InstanceActivity)[keyof typeof InstanceActivity];
export const InstancePlacement = {
  Server: "server",
  Worker: "worker",
} as const;
export const workerResourceIdentitySchema = z
  .string()
  .regex(/^worker:kanthord:[a-z][a-z0-9-]{0,62}$/);
export const instanceRecordSchema = z
  .strictObject({
    runtimeIdentity: identitySchema("worker_instance"),
    projectId: identitySchema("project"),
    resourceIdentity: workerResourceIdentitySchema,
    workerName: z.string().min(1),
    host: z.enum(WorkerHost),
    placement: z.enum(InstancePlacement).optional(),
    clientId: identitySchema("client_identity").optional(),
    name: z.string().min(1).max(64).optional(),
    activity: z.enum(InstanceActivity),
    draining: z.boolean(),
    executionId: identitySchema("execution").optional(),
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
        clientId: identitySchema("client_identity"),
        name: z.string().min(1).max(64),
      }),
      z.looseObject({
        registered: z.literal(false),
        clientId: z.never().optional(),
        name: z.never().optional(),
      }),
    ]),
  )
  .and(
    z.union([
      z.looseObject({
        activity: z.literal(InstanceActivity.Executing),
        executionId: identitySchema("execution"),
      }),
      z.looseObject({
        activity: z.enum([InstanceActivity.Idle, InstanceActivity.Pulling]),
        executionId: z.never().optional(),
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
    executionId: string;
    nodeId: string;
    attempt: number;
    pinnedRevision: number;
  };
  runningExecutionOfRuntime(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): { executionId: string } | null;
  activityOf(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): { activity: InstanceActivity; executionId: string | null };
}

export type AgentProviderItem = {
  name: string;
  provider: string;
  credential: string;
};

export type DefaultConfiguration = {
  agentProvider: string;
  modelIdentifier: string;
  reasoningEffort: string;
};

export type WorkerEntry = {
  agentProvider?: string;
  modelIdentifier?: string;
  reasoningEffort?: string;
};

export type AgentEnablement = {
  agentName: string;
  state: string;
  agentProviders: AgentProviderItem[];
  defaultConfiguration: DefaultConfiguration;
  revision: number;
};

export type AgentProviderDependent = {
  agentName: string;
  providerName: string;
};

export type AgentDependentBinding = {
  bindingId: string;
  workerName: string;
  entry: WorkerEntry | null;
};

export type CustodySuitability = (
  tx: Transaction,
  req: { credential: string; platform: string },
) => void;

export type CredentialMetadataRecord = {
  id: string;
  name: string;
  platform: string;
  metadata: Record<string, unknown> | null;
};

export type CredentialMetadataFn = (
  tx: Transaction,
  credentialName: string,
) => CredentialMetadataRecord | null;

export type PinnedCredentialMetadataFn = (
  tx: Transaction,
  execution: { executionId: string; runtimeIdentity: string },
  credentialName: string,
  now: number,
) => CredentialMetadataRecord | null;

export const AGENT_PROVIDER_CAPABILITY = "model-list read";
export const AGENT_PROVIDER_TARGET_KIND = "agent-provider";
export const REGISTRATION_CAPABILITY = "liveness of a registration";

export type ModelListCheckFn = (
  tx: Transaction,
  credentialName: string,
) => ResourceCheck;

export type EntriesOfAgent = (
  tx: Transaction,
  agentName: string,
) => AgentDependentBinding[];

export const agentProviderKindSchema = z.enum([
  "github-copilot",
  "anthropic",
  "openai-compatible",
]);

export const reasoningEffortSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const agentProviderItemSchema = z.strictObject({
  name: z.string().min(1),
  provider: agentProviderKindSchema,
  credential: z.string().min(1),
});

export const defaultConfigurationSchema = z.strictObject({
  agentProvider: z.string().min(1),
  modelIdentifier: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
});

export type WorkerAgentView = {
  defaults: {
    agentProvider: string;
    modelIdentifier: string;
    reasoningEffort: string;
  } | null;
  effective: {
    agentProvider: string;
    provider: string;
    credential: string;
    modelIdentifier: string;
    reasoningEffort: string;
  } | null;
  valid: boolean;
  issues: Array<{ path: string[]; code: string }>;
};

export type WorkerAgentsOfFn = (workerName: string) => string[];

export type WorkerAgentViewFn = (
  tx: Transaction,
  workerName: string,
  agentName: string,
  entry: WorkerEntry | null,
) => WorkerAgentView | null;

export interface WorkerRegistrations {
  deregister(tx: Transaction, runtimeIdentity: string, now: number): void;
  register(
    transaction: Transaction,
    client: VerifiedClient,
    now: number,
  ): Registration;
  findByClient(clientId: string): Registration | undefined;
  liveRegistrationOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): Registration | null;
  clientAttributionOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): { clientId: string; name: string } | null;
  heartbeat(runtimeIdentity: string): void;
}

export const WORKER_SERVICE_NAME = "worker";
export const ENABLEMENT_MAX_BODY_BYTES = 64 * 1024;
export const ENABLEMENT_TIMEOUT_MS = 30000;
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
  CatalogNotFound: "worker.catalog.not_found",
  AgentNotFound: "worker.agent.not_found",
  NotFound: "worker.agent.enablement.not_found",
  RevisionConflict: "worker.agent.enablement.revision_conflict",
  Unavailable: "worker.agent.enablement.unavailable",
  InvalidatesBindings: "worker.agent.enablement.invalidates_bindings",
  InUse: "worker.agent.enablement.in_use",
  ProviderNameConflict: "worker.agent.enablement.provider.name_conflict",
  ProviderNotFound: "worker.agent.enablement.provider.not_found",
  ProviderFixed: "worker.agent.enablement.provider.fixed",
  ProviderInUse: "worker.agent.enablement.provider.in_use",
  ProviderRequired: "worker.agent.enablement.provider.required",
  OverrideNotAllowed: "worker.agent.configuration.override_not_allowed",
  InvalidConfiguration: "worker.agent.configuration.invalid",
  ModelUnknown: "worker.agent.configuration.model_unknown",
  ReasoningUnsupported:
    "worker.agent.configuration.reasoning_effort_unsupported",
  CredentialUnsuitable: "worker.agent.configuration.credential_unsuitable",
} as const;

export const agentEnablementSchema = z.strictObject({
  agentName: z.string(),
  state: z.enum(["enabled", "disabled"]),
  agentProviders: z.array(agentProviderItemSchema),
  defaultConfiguration: defaultConfigurationSchema,
  revision: z.number().int().positive(),
});
const agentParams = z.strictObject({ agentName: z.string().min(1) });
export const ToolSource = {
  Builtin: "builtin",
  KanthordMcp: "kanthord-mcp",
} as const;
export type ToolSource = (typeof ToolSource)[keyof typeof ToolSource];
export const CONFIGURATION_DESCRIPTION =
  "The Worker Service validates the whole configuration. `modelIdentifier` belongs to `getBuiltinModels(provider)` of pi-ai 0.86.0 or to the `models` metadata of the `openai-compatible` credential. `reasoningEffort` belongs to the supported reasoning levels of that model. JSON Schema validates neither lookup.";
export const effectiveConfigurationSchema = z
  .strictObject({
    agentProvider: z.string().min(1),
    provider: agentProviderKindSchema,
    credential: z.string().min(1),
    modelIdentifier: z.string().min(1),
    reasoningEffort: reasoningEffortSchema,
  })
  .describe(CONFIGURATION_DESCRIPTION);
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
  ): Promise<void>;
  fetchAndCheckout(
    directory: string,
    branch: string,
    baseBranch: string,
    context: Context,
    deadlineMs: number,
  ): Promise<string>;
  pushNodeBranch(
    directory: string,
    branch: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void>;
  cloneSnapshot(
    address: string,
    revision: string,
    directory: string,
    context: Context,
    deadlineMs: number,
  ): Promise<string>;
}
export type ExecutionSetup = z.infer<typeof executionSetupSchema>;
export const toolDeclarationSchema = z.strictObject({
  name: z.string().min(1),
  source: z.enum(ToolSource),
  inputSchema: z.record(z.string(), z.unknown()),
});
export const agentDeclarationSchema = z.strictObject({
  agentName: z.string().min(1),
  configurationSchema: z.record(z.string(), z.unknown()),
  overridableFields: z.array(z.string()),
  basePrompt: z.string().optional(),
  agentPrompt: z.string(),
  tools: z.array(toolDeclarationSchema),
  enablement: agentEnablementSchema.nullable(),
});
export const catalogItemSchema = z.strictObject({
  name: z.string().min(1),
  host: z.enum(WorkerHost),
  declaredNodeStates: z.array(z.string()),
  requiredNodeFormat: z.array(z.string()),
});
const resourceBudgetSchema = z.strictObject({
  wallTimeMs: z.number().int().positive(),
  turns: z.number().int().positive().optional(),
});
export const globalPromptSourceSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal(SourceState.Absent) }),
  z.strictObject({ state: z.literal(SourceState.Disabled) }),
  z.strictObject({
    state: z.literal(SourceState.Present),
    path: z.string(),
    text: z.string(),
  }),
  z.strictObject({
    state: z.literal(SourceState.Invalid),
    path: z.string(),
    reason: z.enum(InvalidReason),
  }),
]);
export const executionSetupSchema = z.strictObject({
  executionId: identitySchema("execution"),
  workerName: z.string().min(1),
  agentName: z.string().min(1),
  effectiveConfiguration: effectiveConfigurationSchema,
  credentialId: identitySchema("credential"),
  metadata: z
    .strictObject({
      baseUrl: z.string(),
      models: z.array(
        z.strictObject({
          id: z.string().min(1),
          contextWindow: z.number().int().positive().optional(),
          maxTokens: z.number().int().positive().optional(),
          reasoningLevels: z.array(reasoningEffortSchema).optional(),
        }),
      ),
    })
    .nullable(),
  resourceBudget: resourceBudgetSchema,
  repositories: z.array(
    z.strictObject({
      bindingId: identitySchema("binding"),
      name: z.string(),
      address: z.string(),
      strategy: z.strictObject({ baseBranch: z.string() }),
      projectPrompt: z.string().nullable(),
    }),
  ),
  globalPrompt: globalPromptSourceSchema,
});
export const catalogEntrySchema = z.discriminatedUnion("host", [
  catalogItemSchema.extend({
    host: z.literal(WorkerHost.Kanthord),
    method: z.enum(WorkerMethod),
    agentName: z.string().min(1),
    resourceBudget: resourceBudgetSchema,
  }),
  catalogItemSchema.extend({
    host: z.literal(WorkerHost.ExternalHarness),
    harness: z.string().min(1),
    resourceBudget: resourceBudgetSchema,
  }),
]);

const emptyFields = z.strictObject({});
const runtimeIdentityParams = z.strictObject({
  runtimeIdentity: identitySchema("worker_instance"),
});
const revisionBody = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
const enablementOperation = {
  service: WORKER_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: ENABLEMENT_TIMEOUT_MS,
  status: HttpStatus.OK,
  output: agentEnablementSchema,
} as const;
const enablementMutation = {
  ...enablementOperation,
  mutation: true,
  body: true,
  maxBodyBytes: ENABLEMENT_MAX_BODY_BYTES,
  input: z.strictObject({
    params: agentParams,
    query: emptyFields,
    body: revisionBody,
  }),
} as const;

export const workerOperations = {
  "execution.setup.get": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.execution.setup.get",
    method: HttpMethod.Get,
    path: "/api/worker/execution/:executionId/setup",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: HANDOVER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: z.strictObject({ executionId: identitySchema("execution") }),
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
    path: "/api/worker/execution/:executionId/action/request",
    access: AccessPolicy.Client,
    requiresExecution: true,
    timeoutMs: ACTION_REQUEST_TIMEOUT_MS,
    mutation: true,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: z.strictObject({ executionId: identitySchema("execution") }),
      query: emptyFields,
      body: z.null(),
    }),
    output: actionRequestResultSchema,
    description:
      "Call the internal action performer with the execution identity alone. Return submitted evidence, awaiting prerequisites, failed-before-effect refusals or uncertainty, with no release instruction.",
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
      body: z.strictObject({ executionId: identitySchema("execution") }),
    }),
    output: handoverEnvelopeSchema,
    description:
      "Seal the live execution's pinned provider credential. A repeated idempotency key returns a redacted conflict; recovery uses a new key.",
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
        executionId: identitySchema("execution"),
      }),
    }),
    output: z.null(),
    description:
      "Apply an authenticated refresh report to the live execution's pinned revision when the replaced credential digest still matches.",
  },
  "instance.list": {
    ...enablementOperation,
    id: "worker.instance.list",
    method: HttpMethod.Get,
    path: "/api/worker/instance",
    mutation: false,
    input: z.strictObject({
      params: emptyFields,
      query: z
        .strictObject({
          projectId: identitySchema("project").optional(),
          resourceIdentity: workerResourceIdentitySchema
            .optional()
            .describe("Requires projectId when supplied."),
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
            query.resourceIdentity === undefined ||
            query.projectId !== undefined,
          { message: "resourceIdentity requires projectId" },
        )
        .meta({ dependentRequired: { resourceIdentity: ["projectId"] } }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(instanceRecordSchema),
      nextCursor: z.string().nullable(),
    }),
    description:
      "Page live registrations in descending runtime identity order without changing runtime state.",
  },
  "instance.get": {
    ...enablementOperation,
    id: "worker.instance.get",
    method: HttpMethod.Get,
    path: "/api/worker/instance/:runtimeIdentity",
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
    ...enablementOperation,
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
      nextCursor: z.string().nullable(),
    }),
    description: "List supplied workers in ascending worker-name order.",
  },
  "catalog.get": {
    ...enablementOperation,
    id: "worker.catalog.get",
    method: HttpMethod.Get,
    path: "/api/worker/catalog/:workerName",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: z.strictObject({ workerName: z.string().min(1) }),
      query: emptyFields,
      body: z.null(),
    }),
    output: catalogEntrySchema,
    description: "Get a supplied worker declaration.",
  },
  "agent.enablement.list": {
    ...enablementOperation,
    id: "worker.agent.enablement.list",
    method: HttpMethod.Get,
    path: "/api/worker/agent/enablement",
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
      items: z.array(agentEnablementSchema),
      nextCursor: z.string().nullable(),
    }),
    description: "List agent enablements in ascending agent-name order.",
  },
  "agent.get": {
    ...enablementOperation,
    id: "worker.agent.get",
    method: HttpMethod.Get,
    path: "/api/worker/agent/:agentName",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: agentDeclarationSchema,
    description: "Get an agent declaration and its current enablement.",
  },
  "agent.enablement.get": {
    ...enablementOperation,
    id: "worker.agent.enablement.get",
    method: HttpMethod.Get,
    path: "/api/worker/agent/enablement/:agentName",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.null(),
    }),
    description: "Get a live agent enablement.",
  },
  "agent.enablement.put": {
    ...enablementMutation,
    id: "worker.agent.enablement.put",
    method: HttpMethod.Put,
    path: "/api/worker/agent/enablement/:agentName",
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.strictObject({
        expectedRevision: z.number().int().positive().optional(),
        agentProviders: z.array(agentProviderItemSchema).min(1),
        defaultConfiguration: defaultConfigurationSchema,
      }),
    }),
    description:
      "Create or replace an agent enablement at its expected revision.",
  },
  "agent.enablement.enable": {
    ...enablementMutation,
    id: "worker.agent.enablement.enable",
    method: HttpMethod.Post,
    path: "/api/worker/agent/enablement/:agentName/enable",
    description: "Validate and enable an existing agent enablement.",
  },
  "agent.enablement.disable": {
    ...enablementMutation,
    id: "worker.agent.enablement.disable",
    method: HttpMethod.Post,
    path: "/api/worker/agent/enablement/:agentName/disable",
    description:
      "Disable an agent enablement without validating dependent bindings.",
  },
  "agent.enablement.remove": {
    ...enablementMutation,
    id: "worker.agent.enablement.remove",
    method: HttpMethod.Delete,
    path: "/api/worker/agent/enablement/:agentName",
    output: z.strictObject({ agentName: z.string(), removed: z.literal(true) }),
    description: "Remove an agent enablement with no dependent bindings.",
  },
  "agent.enablement.provider.add": {
    ...enablementMutation,
    id: "worker.agent.enablement.provider.add",
    method: HttpMethod.Post,
    path: "/api/worker/agent/enablement/:agentName/provider",
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.strictObject({
        expectedRevision: z.number().int().positive(),
        name: z.string().min(1),
        provider: agentProviderKindSchema,
        credential: z.string().min(1),
      }),
    }),
    description: "Append a named provider to an agent enablement.",
  },
  "agent.enablement.provider.remove": {
    ...enablementMutation,
    id: "worker.agent.enablement.provider.remove",
    method: HttpMethod.Delete,
    path: "/api/worker/agent/enablement/:agentName/provider/:providerName",
    input: z.strictObject({
      params: z.strictObject({
        agentName: z.string().min(1),
        providerName: z.string().min(1),
      }),
      query: emptyFields,
      body: revisionBody,
    }),
    description:
      "Remove an unused named provider, retaining at least one provider.",
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
    path: "/api/worker/instance/:runtimeIdentity",
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
    path: "/api/worker/instance/:runtimeIdentity/resume",
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
      runtimeIdentity: identitySchema("worker_instance"),
    }),
    description:
      "Register a worker instance with a bearer machine JWT and an empty body. A client identity with a live registration receives that runtime identity with any key. A recorded replay after the registration ends answers 409 gateway.registration.stale. Admission and the binding instance count share one transaction.",
  },
} as const satisfies Record<string, Operation>;
