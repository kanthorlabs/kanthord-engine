import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  AccessPolicy,
  type Operation,
  OperationLifetime,
  StoreName,
} from "../kernel/operation.ts";
import { reasoningEffortSchema } from "../agent/contract.ts";
import { COPY_REPORT_TEXT_MAX_LENGTH } from "../llm/contract.ts";

export const WORKBENCH_SERVICE_NAME = "workbench";
export const WORKBENCH_SESSION_PREFIX = "workbench_session";
export const WORKBENCH_DIRECTORY_NAME = "workbench";
export const WORKBENCH_CONFIGURATION_ENTRY = "kanthord.workbench.configuration";
export const WORKBENCH_RECORD_ENTRY = "kanthord.workbench.record";
export const WORKBENCH_ACTION_RESULT_ENTRY = "kanthord.workbench.action_result";
export const WORKBENCH_TIMEOUT_MS = 30000;
export const WORKBENCH_EVENTS_WAIT_MS = 25000;
export const WORKBENCH_MESSAGE_MAX_LENGTH = 1048576;
export const WORKBENCH_ERROR_CODE_MAX_LENGTH = 128;
export const WORKBENCH_QUEUE_LIMIT = 10;
export const WORKBENCH_QUEUED_MESSAGE_PREFIX = "workbench_queued_message";

export const MessageDelivery = { Queue: "queue", Replace: "replace" } as const;
export type MessageDelivery =
  (typeof MessageDelivery)[keyof typeof MessageDelivery];

export const ActionOutcome = { Done: "done", Failed: "failed" } as const;
export type ActionOutcome = (typeof ActionOutcome)[keyof typeof ActionOutcome];

export const WorkbenchErrorCode = {
  Stopped: "workbench.lifecycle.stopped",
  SessionNotFound: "workbench.session.not_found",
  ConfigurationInvalid: "workbench.session.configuration_invalid",
  RunActive: "workbench.session.run_active",
  SetupRefused: "workbench.session.setup_refused",
  AuthorizationRefused: "workbench.authorization.refused",
  ApprovalNotFound: "workbench.session.approval_not_found",
  QueueFull: "workbench.session.queue_full",
  QueuedMessageNotFound: "workbench.session.queued_message_not_found",
  ActionNotFound: "workbench.session.action_not_found",
  ActionSettled: "workbench.session.action_settled",
} as const;

export const workbenchConfigurationSchema = z.strictObject({
  agent_provider: z.string().min(1).max(COPY_REPORT_TEXT_MAX_LENGTH),
  model_identifier: z.string().min(1).max(COPY_REPORT_TEXT_MAX_LENGTH),
  reasoning_effort: reasoningEffortSchema,
});
export type WorkbenchConfiguration = z.infer<
  typeof workbenchConfigurationSchema
>;

export const WorkbenchRecordKind = { ActionOffer: "action_offer" } as const;
export type WorkbenchRecordKind =
  (typeof WorkbenchRecordKind)[keyof typeof WorkbenchRecordKind];

const actionSeenSchema = z.union([
  z.strictObject({
    state: z.string(),
    attempt: z.number().int().nonnegative(),
  }),
  z.strictObject({ paused: z.boolean() }),
]);

export const workbenchRecordSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(WorkbenchRecordKind.ActionOffer),
    tool_call_id: z.string(),
    operation_id: z.string(),
    target_id: z.string(),
    seen: actionSeenSchema,
  }),
]);
export type WorkbenchRecord = z.infer<typeof workbenchRecordSchema>;

const timestampSchema = z
  .number()
  .int()
  .describe("Unix epoch time in milliseconds.");

export const sessionEntrySchema = z.looseObject({
  type: z.string(),
  id: z.string(),
  parentId: z.string().nullable(),
  timestamp: z.string(),
});
export type SessionEntry = z.infer<typeof sessionEntrySchema>;

export const pendingApprovalSummarySchema = z.strictObject({
  tool_call_id: z.string(),
  operation_id: z.string(),
});

export const sessionListItemSchema = z.strictObject({
  id: z.string(),
  agent_name: z.string(),
  name: z.string().nullable(),
  created: timestampSchema,
  modified: timestampSchema,
  message_count: z.number().int().nonnegative(),
  first_message: z.string(),
  run_active: z.boolean(),
  pending_approval: pendingApprovalSummarySchema.nullable(),
});

export const workbenchSessionSchema = z.strictObject({
  id: identitySchema(WORKBENCH_SESSION_PREFIX),
  agent_name: z.string(),
  configuration: workbenchConfigurationSchema,
  entries: z.array(sessionEntrySchema),
  run_active: z.boolean(),
  resume_command: z.string(),
});
export type WorkbenchSession = z.infer<typeof workbenchSessionSchema>;

export const WORKBENCH_REJECTION_REASON = "The human rejected the call.";
export const WORKBENCH_EXPIRY_REASON =
  "The approval wait ended with no human decision. The call did not run. Do not call it again unless the human asks again.";

export const pendingApprovalSchema = pendingApprovalSummarySchema.extend({
  input: z.record(z.string(), z.unknown()),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export const queuedMessageSchema = z.strictObject({
  id: identitySchema(WORKBENCH_QUEUED_MESSAGE_PREFIX),
  text: z.string(),
});
export type QueuedMessage = z.infer<typeof queuedMessageSchema>;

export const runSnapshotSchema = z.strictObject({
  streaming_message: z.record(z.string(), z.unknown()).nullable(),
  pending_tool_calls: z.array(z.string()),
  pending_approval: pendingApprovalSchema.nullable(),
  run_active: z.boolean(),
  queue: z.array(queuedMessageSchema),
  error_message: z.string().nullable(),
});
export type RunSnapshot = z.infer<typeof runSnapshotSchema>;

export const sessionEventsSchema = z.strictObject({
  entries: z.array(sessionEntrySchema),
  snapshot: runSnapshotSchema,
  version: z.number().int().nonnegative(),
});
export type SessionEvents = z.infer<typeof sessionEventsSchema>;

const emptyFields = z.strictObject({});
const sessionParams = z.strictObject({
  session_id: identitySchema(WORKBENCH_SESSION_PREFIX),
});
const workbenchOperation = {
  service: WORKBENCH_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: WORKBENCH_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
const workbenchMutation = {
  ...workbenchOperation,
  mutation: true,
  body: true,
} as const;

export const workbenchOperations = {
  "session.list": {
    ...workbenchOperation,
    id: "workbench.session.list",
    method: HttpMethod.Get,
    path: "/api/workbench/session",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({ agent_name: z.string().min(1).optional() }),
      body: z.null(),
    }),
    output: z.strictObject({ items: z.array(sessionListItemSchema) }),
    description:
      "List the workbench sessions of every agent, or of one agent. Each item also answers `run_active` and `pending_approval` of the in-memory run.",
  },
  "session.create": {
    ...workbenchMutation,
    id: "workbench.session.create",
    method: HttpMethod.Post,
    path: "/api/workbench/session",
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: workbenchConfigurationSchema.extend({
        agent_name: z.string().min(1),
      }),
    }),
    output: workbenchSessionSchema,
    description: "Create a workbench session with one agent of the catalog.",
  },
  "session.get": {
    ...workbenchOperation,
    id: "workbench.session.get",
    method: HttpMethod.Get,
    path: "/api/workbench/session/:session_id",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: workbenchSessionSchema,
    description:
      "Get the configuration, the entries of the completed runs and the run state of a workbench session.",
  },
  "session.configure": {
    ...workbenchMutation,
    id: "workbench.session.configure",
    method: HttpMethod.Put,
    path: "/api/workbench/session/:session_id/configuration",
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: workbenchConfigurationSchema,
    }),
    output: workbenchConfigurationSchema,
    description: "Replace the configuration of a workbench session.",
  },
  "session.message": {
    ...workbenchMutation,
    id: "workbench.session.message",
    method: HttpMethod.Post,
    path: "/api/workbench/session/:session_id/message",
    status: HttpStatus.Accepted,
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: z.strictObject({
        text: z.string().min(1).max(WORKBENCH_MESSAGE_MAX_LENGTH),
        delivery: z
          .enum([MessageDelivery.Queue, MessageDelivery.Replace])
          .default(MessageDelivery.Queue),
      }),
    }),
    output: sessionParams.extend({
      run_active: z.literal(true),
      queued_message_id: identitySchema(
        WORKBENCH_QUEUED_MESSAGE_PREFIX,
      ).nullable(),
      cleared: z.array(queuedMessageSchema),
    }),
    description:
      "Start a run on one human message, or queue it behind the active run. `replace` clears the queue, stops the active run and queues the message.",
  },
  "session.abort": {
    ...workbenchOperation,
    id: "workbench.session.abort",
    method: HttpMethod.Post,
    path: "/api/workbench/session/:session_id/abort",
    mutation: true,
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: sessionParams.extend({
      run_active: z.literal(false),
      cleared: z.array(queuedMessageSchema),
    }),
    description: "Stop the active run and clear the queue.",
  },
  "session.queue.remove": {
    ...workbenchOperation,
    id: "workbench.session.queue.remove",
    method: HttpMethod.Delete,
    path: "/api/workbench/session/:session_id/queue/:queued_message_id",
    mutation: true,
    input: z.strictObject({
      params: sessionParams.extend({
        queued_message_id: identitySchema(WORKBENCH_QUEUED_MESSAGE_PREFIX),
      }),
      query: emptyFields,
      body: z.null(),
    }),
    output: sessionParams.extend({
      queued_message_id: identitySchema(WORKBENCH_QUEUED_MESSAGE_PREFIX),
    }),
    description: "Remove one queued message of a workbench session.",
  },
  "session.approve": {
    ...workbenchMutation,
    id: "workbench.session.approve",
    method: HttpMethod.Post,
    path: "/api/workbench/session/:session_id/approve",
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: z.strictObject({
        tool_call_id: z.string().min(1),
        approved: z.boolean(),
      }),
    }),
    output: sessionParams.extend({
      tool_call_id: z.string(),
      approved: z.boolean(),
    }),
    description:
      "Approve or reject the pending call of a mutation tool of the active run.",
  },
  "session.action.report": {
    ...workbenchMutation,
    id: "workbench.session.action.report",
    method: HttpMethod.Post,
    path: "/api/workbench/session/:session_id/action/:tool_call_id/report",
    input: z.strictObject({
      params: sessionParams.extend({ tool_call_id: z.string().min(1) }),
      query: emptyFields,
      body: z
        .strictObject({
          outcome: z.enum(ActionOutcome),
          error_code: z
            .string()
            .regex(/^[a-z0-9_]+(\.[a-z0-9_]+)+$/)
            .max(WORKBENCH_ERROR_CODE_MAX_LENGTH)
            .nullable(),
        })
        .refine(
          (body) =>
            body.outcome !== ActionOutcome.Done || body.error_code === null,
          {
            message: "A done outcome carries no error_code.",
            path: ["error_code"],
          },
        ),
    }),
    output: sessionParams.extend({
      tool_call_id: z.string(),
      outcome: z.enum(ActionOutcome),
    }),
    description:
      "Record the outcome of an action card that the owner ran. It runs no act.",
  },
  "session.events": {
    ...workbenchOperation,
    id: "workbench.session.events",
    method: HttpMethod.Get,
    path: "/api/workbench/session/:session_id/events",
    lifetime: OperationLifetime.Wait,
    mutation: false,
    body: false,
    input: z.strictObject({
      params: sessionParams,
      query: z.strictObject({
        after: z.string().min(1).optional(),
        version: z.coerce.number().int().nonnegative().optional(),
      }),
      body: z.null(),
    }),
    output: sessionEventsSchema,
    description:
      "Answer the session entries after `after` and the snapshot of the active run at once when `version` differs, else wait up to 25 seconds for a change.",
  },
} as const satisfies Record<string, Operation>;
