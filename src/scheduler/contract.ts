import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
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
