import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import { timestamp } from "../kernel/json.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { REASON_MAX_LENGTH } from "../kernel/probe.ts";

export const SCHEDULER_SERVICE_NAME = "scheduler";
export const JOB_IDENTITY_PREFIX = "job";
export const SCHEDULER_TIMEOUT_MS = 30000;
export const EXECUTION_IDENTITY_PREFIX = "execution";
export const WORKER_REGISTRATION_IDENTITY_PREFIX = "worker_registration";
export const WORK_PULL_TIMEOUT_MS = 120000;
export const WORK_PULL_WAIT_MS = 90000;
export const LOSS_SWEEP_INTERVAL_MS = 30000;
const EMPTY_TEXT_LENGTH = 0;

export const ClaimState = {
  Running: "running",
  Lost: "lost",
  Finished: "finished",
} as const;
export const claimStateSchema = z.enum(ClaimState);
export type ClaimState = z.infer<typeof claimStateSchema>;
export const WorkPullKind = { Claimed: "claimed", NoWork: "no-work" } as const;
export const workPullKindSchema = z.enum(WorkPullKind);
export type WorkPullKind = z.infer<typeof workPullKindSchema>;
export const ClaimNodeState = {
  Available: "Available",
  Waiting: "Waiting",
  ExternalRequested: "External.Requested",
} as const;
export const claimNodeStateSchema = z.enum(ClaimNodeState);
export type ClaimNodeState = z.infer<typeof claimNodeStateSchema>;
export const ClaimIntent = {
  Implement: "implement",
  Examine: "examine",
} as const;
export type ClaimIntent = (typeof ClaimIntent)[keyof typeof ClaimIntent];
export const ExecutionStopReason = {
  OperationFailed: "operation_failed",
  JudgementInvalid: "judgement_invalid",
  ReportAbsent: "report_absent",
  ActionUnsettled: "action_unsettled",
  AssessmentAbsent: "assessment_absent",
  BudgetEnd: "budget_end",
  ProviderFailed: "provider_failed",
  NoProgress: "no_progress",
} as const;
export const BudgetLimit = {
  Turns: "turns",
  WallTime: "wall_time",
} as const;
export type BudgetLimit = (typeof BudgetLimit)[keyof typeof BudgetLimit];
export const ProviderFailure = {
  RateLimited: "rate_limited",
  QuotaExhausted: "quota_exhausted",
  Unauthorized: "unauthorized",
  BadRequest: "bad_request",
  Unavailable: "unavailable",
} as const;
export type ProviderFailure =
  (typeof ProviderFailure)[keyof typeof ProviderFailure];
export const AdvancingProviderFailure = {
  RateLimited: ProviderFailure.RateLimited,
  QuotaExhausted: ProviderFailure.QuotaExhausted,
  Unavailable: ProviderFailure.Unavailable,
} as const;
export type AdvancingProviderFailure =
  (typeof AdvancingProviderFailure)[keyof typeof AdvancingProviderFailure];
export function isAdvancingProviderFailure(
  code: string | null,
): code is AdvancingProviderFailure {
  return Object.values(AdvancingProviderFailure).some(
    (failure) => failure === code,
  );
}
export function isAdvancingStop(stop: ReleaseStop | null): boolean {
  return (
    stop?.reason === ExecutionStopReason.ProviderFailed &&
    isAdvancingProviderFailure(stop.code)
  );
}
export const executionStopReasonSchema = z.enum(ExecutionStopReason);
export type ExecutionStopReason = z.infer<typeof executionStopReasonSchema>;

function stopCodeFits(stop: {
  reason: ExecutionStopReason;
  code: string | null;
}): boolean {
  const budgetCode = Object.values(BudgetLimit).some(
    (limit) => limit === stop.code,
  );
  const providerCode = Object.values(ProviderFailure).some(
    (failure) => failure === stop.code,
  );
  if (stop.reason === ExecutionStopReason.BudgetEnd) return budgetCode;
  if (stop.reason === ExecutionStopReason.ProviderFailed) return providerCode;
  if (stop.reason === ExecutionStopReason.NoProgress) return stop.code === null;
  return !budgetCode && !providerCode;
}

export const releaseStopSchema = z
  .strictObject({
    reason: executionStopReasonSchema,
    code: z.string().min(1).nullable(),
    detail: z.string().min(1).max(REASON_MAX_LENGTH).optional(),
  })
  .refine(stopCodeFits, { path: ["code"] });
export type ReleaseStop = z.infer<typeof releaseStopSchema>;
export const traceIdSchema = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .refine((value) => !/^0+$/.test(value));
export const spanIdSchema = z
  .string()
  .regex(/^[0-9a-f]{16}$/)
  .refine((value) => !/^0+$/.test(value));
const positiveInteger = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
export const ChainLevelName = {
  Enablement: "enablement",
  Binding: "binding",
} as const;
export const agentSelectionSchema = z.strictObject({
  agent_name: z.string().min(1),
  position: z.number().int().min(0),
  level: z.enum(ChainLevelName),
  agent_provider: z.string().min(1),
  provider: z.string().min(1),
  credential: z.string().min(1),
  model_identifier: z.string().min(1),
  reasoning_effort: z.string().min(1),
});
export type AgentSelection = z.infer<typeof agentSelectionSchema>;
export const agentPinSchema = z.strictObject({
  agent_name: z.string().min(1),
  enablement_id: identitySchema("agent_enablement"),
  position: z.number().int().min(0),
});
export type AgentPin = z.infer<typeof agentPinSchema>;
export const claimantSchema = z.strictObject({
  worker_binding_id: identitySchema("binding"),
  resource_identity: z.string().min(1),
  runtime_identity: identitySchema(WORKER_REGISTRATION_IDENTITY_PREFIX),
  client_id: identitySchema("client_identity").optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > EMPTY_TEXT_LENGTH)
    .optional(),
});
export const executionRecordSchema = z.strictObject({
  execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX),
  project_id: identitySchema("project"),
  node_id: identitySchema("node"),
  claimant: claimantSchema,
  attempt: positiveInteger,
  pinned_revision: positiveInteger,
  node_branch: z.string().min(1),
  credentials: z.array(identitySchema("credential")),
  agent_selections: z.array(agentSelectionSchema),
  claim_state: claimStateSchema,
  expired_at: timestamp,
  created_at: timestamp,
  ended_at: timestamp.nullable(),
  stop: releaseStopSchema.nullable(),
  trace_id: traceIdSchema,
  root_span_id: spanIdSchema,
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
export const workPullSchema = z.strictObject({
  resource_identity: z.string().min(1),
  runtime_identity: identitySchema(WORKER_REGISTRATION_IDENTITY_PREFIX),
});
export type WorkPull = z.infer<typeof workPullSchema>;
export const workPullResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(WorkPullKind.Claimed),
    execution: executionRecordSchema,
  }),
  z.strictObject({ kind: z.literal(WorkPullKind.NoWork) }),
]);
export const executionReleaseSchema = z
  .strictObject({
    further_work: z.boolean(),
    stop: releaseStopSchema.nullable().default(null),
  })
  .refine((release) => release.stop === null || release.further_work, {
    path: ["stop"],
  });
export type ExecutionRelease = z.infer<typeof executionReleaseSchema>;
export const releaseResultSchema = z.strictObject({
  execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX),
  ended_at: timestamp,
});

export interface ExecutionRow {
  execution_id: string;
  project_id: string;
  node_id: string;
  worker_binding_id: string;
  resource_identity: string;
  runtime_identity: string;
  attempt: number;
  pinned_revision: number;
  credentials: string[];
  agent_pins: AgentPin[];
  expired_at: number;
  trace_id: string;
  root_span_id: string;
  created_at: number;
  ended_at: number | null;
  stop: ReleaseStop | null;
}
export interface SchedulerClaims {
  revoke(tx: Transaction, nodeId: string, now: number): string | null;
  settle(tx: Transaction, nodeId: string, now: number): void;
  liveExecutionOf(
    tx: Transaction,
    nodeId: string,
    now: number,
  ): ExecutionRow | null;
  runningExecutionOfRuntime(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): ExecutionRow | null;
  requireRunning(
    tx: Transaction,
    executionId: string,
    runtimeIdentity: string,
    now: number,
  ): ExecutionRow;
  pinCredential(
    tx: Transaction,
    executionId: string,
    credentialId: string,
  ): void;
  liveExecutionsPinning(tx: Transaction, credentialId: string): string[];
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
export interface MissionTransitions {
  claim(
    tx: Transaction,
    nodeId: string,
    declaredStates: readonly string[],
    opener: {
      kind: "execution";
      execution_id: string;
      client_id: string | null;
      name: string | null;
    },
    now: number,
  ): {
    kind: string;
    project_id: string;
    attempt: number;
    node_revision: number;
  } | null;
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
export interface NodeAttemptKey {
  node_id: string;
  attempt: number;
}
export interface MissionBranches {
  nodeBranchesOf(tx: Transaction, keys: readonly NodeAttemptKey[]): string[];
}
export interface Registrations {
  clientAttributionOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): { client_id: string; name: string } | null;
  registrationHealthcheck(tx: Transaction, runtimeIdentity: string): boolean;
  registrationsOfInstance(tx: Transaction, runtimeIdentity: string): string[];
}
export interface ProjectPauses {
  projectPaused(tx: Transaction, projectId: string): boolean;
}
export interface WorkerDeclarations {
  declarationOf(workerName: string): {
    declared_node_states: readonly string[];
    declared_intents: readonly ClaimIntent[];
    resource_budget: { wall_time_ms: number };
  } | null;
}
export interface WorkerBindings {
  workerBindingOf(
    tx: Transaction,
    projectId: string,
    resourceIdentity: string,
  ): {
    binding_id: string;
    worker_name: string;
    instance_count: number;
    resource_budget?: { wall_time_ms: number } | null;
    tags: readonly string[];
    tombstone: boolean;
  } | null;
  workerBindingsOf(
    tx: Transaction,
    projectId: string,
  ): { binding_id: string; worker_name: string; tags: readonly string[] }[];
}
export interface ClaimFacts {
  intent: ClaimIntent;
  tags: readonly string[];
}
export interface MissionClaimFacts {
  claimFacts(tx: Transaction, nodeId: string): ClaimFacts | null;
  claimFactsOf(
    tx: Transaction,
    projectId: string,
  ): (ClaimFacts & {
    node_id: string;
    revision: number;
    claims: readonly ClaimNodeState[];
  })[];
}
export interface Claimant {
  declared_node_states: readonly string[];
  declared_intents: readonly ClaimIntent[];
  tags: readonly string[];
}
export interface UnmatchedClaim {
  node_id: string;
  revision: number;
  claim: ClaimNodeState;
}
export const AgentChoiceKind = {
  Selected: "selected",
  Cooling: "cooling",
} as const;
export type AgentChoice =
  | {
      kind: typeof AgentChoiceKind.Selected;
      selections: AgentSelection[];
      pins: AgentPin[];
    }
  | { kind: typeof AgentChoiceKind.Cooling; available_at: number };
export const CooldownChangeKind = {
  Started: "started",
  Cleared: "cleared",
} as const;
export type CooldownChange =
  | {
      kind: typeof CooldownChangeKind.Started;
      execution_id: string;
      credential: string;
      holder: string;
      code: AdvancingProviderFailure;
      strikes: number;
      available_at: number;
    }
  | {
      kind: typeof CooldownChangeKind.Cleared;
      execution_id: string;
      credential: string;
      holder: string;
    };
export type ChainClaimant = {
  worker_binding_id: string;
  runtime_identity: string;
};
export interface AgentChains {
  select(
    tx: Transaction,
    workerBindingId: string,
    runtimeIdentity: string,
  ): AgentChoice;
  resolve(
    tx: Transaction,
    workerBindingId: string,
    pins: readonly AgentPin[],
  ): AgentSelection[];
  providerFailure(
    tx: Transaction,
    claimant: ChainClaimant,
    selections: readonly AgentSelection[],
    code: AdvancingProviderFailure,
    executionId: string,
    now: number,
  ): CooldownChange[];
  success(
    tx: Transaction,
    claimant: ChainClaimant,
    selections: readonly AgentSelection[],
    executionId: string,
  ): CooldownChange[];
  selected(selections: readonly AgentSelection[], executionId: string): void;
  cooldownsChanged(changes: readonly CooldownChange[]): void;
}
export interface TraceIdentity {
  mint(): { trace_id: string; root_span_id: string };
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

export const jobSchema = z.strictObject({
  job_id: identitySchema(JOB_IDENTITY_PREFIX),
  project_id: identitySchema("project"),
  node_id: identitySchema("node"),
  priority: z
    .number()
    .int()
    .min(Number.MIN_SAFE_INTEGER)
    .max(Number.MAX_SAFE_INTEGER),
});
export type Job = z.infer<typeof jobSchema>;

export const QUEUE_LIST_LIMIT_DEFAULT = 100;
export const QUEUE_LIST_LIMIT_MIN = 1;
export const QUEUE_LIST_LIMIT_MAX = 1000;

export const schedulerOperations = {
  executionList: {
    id: "scheduler.execution.list",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/project/:project_id/execution",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description: "List live and ended executions, newest identity first.",
    input: z.strictObject({
      params: z.strictObject({ project_id: identitySchema("project") }),
      query: z
        .strictObject({
          limit: z.coerce
            .number()
            .int()
            .min(QUEUE_LIST_LIMIT_MIN)
            .max(QUEUE_LIST_LIMIT_MAX)
            .default(QUEUE_LIST_LIMIT_DEFAULT),
          cursor: z.string().optional(),
          node_id: identitySchema("node").optional(),
          attempt: z.coerce
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .optional()
            .describe("Requires node_id when supplied."),
        })
        .refine(
          (query) => query.attempt === undefined || query.node_id !== undefined,
        )
        .meta({ dependentRequired: { attempt: ["node_id"] } }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(executionRecordSchema),
      next_cursor: z.string().nullable(),
    }),
  },
  executionGet: {
    id: "scheduler.execution.get",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/execution/:execution_id",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description: "Read a live or ended execution.",
    input: z.strictObject({
      params: z.strictObject({
        execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: executionRecordSchema,
  },
  claimGet: {
    id: "scheduler.claim.get",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/claim/:execution_id",
    access: AccessPolicy.Client,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description:
      "Read the execution of this registered claimant, including ended claims.",
    input: z.strictObject({
      params: z.strictObject({
        execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: executionRecordSchema,
  },
  executionRelease: {
    id: "scheduler.execution.release",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Post,
    path: "/api/scheduler/execution/:execution_id/release",
    access: AccessPolicy.Client,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: true,
    body: true,
    requiresExecution: true,
    status: HttpStatus.OK,
    description: "Release a running execution after Mission admission.",
    input: z.strictObject({
      params: z.strictObject({
        execution_id: identitySchema(EXECUTION_IDENTITY_PREFIX),
      }),
      query: z.strictObject({}),
      body: executionReleaseSchema,
    }),
    output: releaseResultSchema,
  },
  workPull: {
    id: "scheduler.work.pull",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Post,
    path: "/api/scheduler/work/pull",
    access: AccessPolicy.Client,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Wait,
    timeoutMs: WORK_PULL_TIMEOUT_MS,
    mutation: true,
    body: true,
    status: HttpStatus.OK,
    description:
      "Pull compatible work, waiting up to 90 seconds when none is available.",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: workPullSchema,
    }),
    output: workPullResultSchema,
  },
  queueList: {
    id: "scheduler.queue.list",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/project/:project_id/queue",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description:
      "List current jobs in the project's work queue, ordered by priority descending, then job identity ascending.",
    input: z.strictObject({
      params: z.strictObject({ project_id: identitySchema("project") }),
      query: z.strictObject({
        limit: z.coerce
          .number()
          .int()
          .min(QUEUE_LIST_LIMIT_MIN)
          .max(QUEUE_LIST_LIMIT_MAX)
          .default(QUEUE_LIST_LIMIT_DEFAULT)
          .optional(),
        cursor: z.string().optional(),
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(jobSchema),
      next_cursor: z.string().nullable(),
    }),
  },
  queuePeek: {
    id: "scheduler.queue.peek",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/project/:project_id/queue/peek",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description:
      "Read the first job of the project's work queue by selection order without removing it.",
    input: z.strictObject({
      params: z.strictObject({ project_id: identitySchema("project") }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: z.strictObject({ job: jobSchema.nullable() }),
  },
} as const satisfies Record<string, Operation>;
