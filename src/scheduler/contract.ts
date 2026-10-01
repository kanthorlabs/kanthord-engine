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

export const SCHEDULER_SERVICE_NAME = "scheduler";
export const JOB_IDENTITY_PREFIX = "job";
export const SCHEDULER_TIMEOUT_MS = 30000;
export const EXECUTION_IDENTITY_PREFIX = "execution";
export const WORKER_INSTANCE_IDENTITY_PREFIX = "worker_instance";
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
export const NodeFormatField = {
  Name: "name",
  Requirement: "requirement",
  Criterion: "criterion",
  Verifications: "verifications",
  Bindings: "bindings",
} as const;
export const nodeFormatFieldSchema = z.enum(NodeFormatField);
export type NodeFormatField = z.infer<typeof nodeFormatFieldSchema>;
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
export const claimantSchema = z.strictObject({
  workerBindingId: identitySchema("binding"),
  resourceIdentity: z.string().min(1),
  runtimeIdentity: identitySchema(WORKER_INSTANCE_IDENTITY_PREFIX),
  clientId: identitySchema("client_identity").optional(),
  name: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => value.trim().length > EMPTY_TEXT_LENGTH)
    .optional(),
});
export const executionRecordSchema = z.strictObject({
  executionId: identitySchema(EXECUTION_IDENTITY_PREFIX),
  projectId: identitySchema("project"),
  nodeId: identitySchema("node"),
  claimant: claimantSchema,
  attempt: positiveInteger,
  pinnedRevision: positiveInteger,
  credentials: z.array(identitySchema("credential")),
  claimState: claimStateSchema,
  expiredAt: timestamp,
  createdAt: timestamp,
  endedAt: timestamp.nullable(),
  traceId: traceIdSchema,
  rootSpanId: spanIdSchema,
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;
export const workPullSchema = z.strictObject({
  resourceIdentity: z.string().min(1),
  runtimeIdentity: identitySchema(WORKER_INSTANCE_IDENTITY_PREFIX),
});
export type WorkPull = z.infer<typeof workPullSchema>;
export const workPullResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(WorkPullKind.Claimed),
    execution: executionRecordSchema,
  }),
  z.strictObject({ kind: z.literal(WorkPullKind.NoWork) }),
]);
export const executionReleaseSchema = z.strictObject({
  furtherWork: z.boolean(),
});
export const releaseResultSchema = z.strictObject({
  executionId: identitySchema(EXECUTION_IDENTITY_PREFIX),
  endedAt: timestamp,
});

export interface ExecutionRow {
  executionId: string;
  projectId: string;
  nodeId: string;
  workerBindingId: string;
  resourceIdentity: string;
  runtimeIdentity: string;
  attempt: number;
  pinnedRevision: number;
  credentials: string[];
  expiredAt: number;
  traceId: string;
  rootSpanId: string;
  createdAt: number;
  endedAt: number | null;
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
    clientId: string | null;
    name: string | null;
    workerName: string;
  } | null;
}
export interface MissionTransitions {
  claim(
    tx: Transaction,
    nodeId: string,
    declaredStates: readonly string[],
    opener: {
      kind: "execution";
      executionId: string;
      clientId: string | null;
      name: string | null;
    },
    now: number,
  ): {
    kind: string;
    projectId: string;
    attempt: number;
    nodeRevision: number;
  } | null;
  release(
    tx: Transaction,
    execution: { executionId: string; nodeId: string; attempt: number },
    furtherWork: boolean,
    now: number,
  ): void;
  loss(
    tx: Transaction,
    nodeId: string,
    consecutiveLosses: number,
    now: number,
  ): void;
}
export interface InstanceRegistrations {
  clientAttributionOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): { clientId: string; name: string } | null;
  instanceHealthcheck(tx: Transaction, runtimeIdentity: string): boolean;
}
export interface WorkerDeclarations {
  declarationOf(workerName: string): {
    declaredNodeStates: readonly string[];
    requiredNodeFormat: readonly string[];
    resourceBudget: { wallTimeMs: number };
  } | null;
}
export interface WorkerBindings {
  workerBindingOf(
    tx: Transaction,
    projectId: string,
    resourceIdentity: string,
  ): {
    bindingId: string;
    workerName: string;
    instanceCount: number;
    resourceBudget?: { wallTimeMs: number } | null;
    tombstone: boolean;
  } | null;
}
export interface TraceIdentity {
  mint(): { traceId: string; rootSpanId: string };
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
  jobId: identitySchema(JOB_IDENTITY_PREFIX),
  projectId: identitySchema("project"),
  nodeId: identitySchema("node"),
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
    path: "/api/scheduler/project/:projectId/execution",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description: "List live and ended executions, newest identity first.",
    input: z.strictObject({
      params: z.strictObject({ projectId: identitySchema("project") }),
      query: z
        .strictObject({
          limit: z.coerce
            .number()
            .int()
            .min(QUEUE_LIST_LIMIT_MIN)
            .max(QUEUE_LIST_LIMIT_MAX)
            .default(QUEUE_LIST_LIMIT_DEFAULT),
          cursor: z.string().optional(),
          nodeId: identitySchema("node").optional(),
          attempt: z.coerce
            .number()
            .int()
            .positive()
            .max(Number.MAX_SAFE_INTEGER)
            .optional()
            .describe("Requires nodeId when supplied."),
        })
        .refine(
          (query) => query.attempt === undefined || query.nodeId !== undefined,
        )
        .meta({ dependentRequired: { attempt: ["nodeId"] } }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(executionRecordSchema),
      nextCursor: z.string().nullable(),
    }),
  },
  executionGet: {
    id: "scheduler.execution.get",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/execution/:executionId",
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
        executionId: identitySchema(EXECUTION_IDENTITY_PREFIX),
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
    path: "/api/scheduler/claim/:executionId",
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
        executionId: identitySchema(EXECUTION_IDENTITY_PREFIX),
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
    path: "/api/scheduler/execution/:executionId/release",
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
        executionId: identitySchema(EXECUTION_IDENTITY_PREFIX),
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
    path: "/api/scheduler/project/:projectId/queue",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: SCHEDULER_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    description:
      "List current jobs in the project's work queue, ordered by job identity descending.",
    input: z.strictObject({
      params: z.strictObject({ projectId: identitySchema("project") }),
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
      nextCursor: z.string().nullable(),
    }),
  },
  queuePeek: {
    id: "scheduler.queue.peek",
    service: SCHEDULER_SERVICE_NAME,
    method: HttpMethod.Get,
    path: "/api/scheduler/project/:projectId/queue/peek",
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
      params: z.strictObject({ projectId: identitySchema("project") }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: z.strictObject({ job: jobSchema.nullable() }),
  },
} as const satisfies Record<string, Operation>;
