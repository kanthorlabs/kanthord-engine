import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import { reasoningEffortSchema } from "../agent/contract.ts";

export const WORKBENCH_SERVICE_NAME = "workbench";
export const WORKBENCH_SESSION_PREFIX = "workbench_session";
export const WORKBENCH_DIRECTORY_NAME = "workbench";
export const WORKBENCH_CONFIGURATION_ENTRY = "kanthord.workbench.configuration";
export const WORKBENCH_TIMEOUT_MS = 30000;
export const WORKBENCH_EVENTS_WAIT_MS = 25000;
export const WORKBENCH_MAX_BODY_BYTES = 64 * 1024;
export const WORKBENCH_MESSAGE_MAX_BODY_BYTES = 1024 * 1024;

export const WorkbenchErrorCode = {
  Stopped: "workbench.lifecycle.stopped",
  SessionNotFound: "workbench.session.not_found",
  ConfigurationInvalid: "workbench.session.configuration_invalid",
  RunActive: "workbench.session.run_active",
  SetupRefused: "workbench.session.setup_refused",
  AuthorizationRefused: "workbench.authorization.refused",
  ApprovalNotFound: "workbench.session.approval_not_found",
} as const;

export const workbenchConfigurationSchema = z.strictObject({
  agent_provider: z.string().min(1),
  model_identifier: z.string().min(1),
  reasoning_effort: reasoningEffortSchema,
});
export type WorkbenchConfiguration = z.infer<
  typeof workbenchConfigurationSchema
>;

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

export const sessionListItemSchema = z.strictObject({
  id: z.string(),
  agent_name: z.string(),
  name: z.string().nullable(),
  created: timestampSchema,
  modified: timestampSchema,
  message_count: z.number().int().nonnegative(),
  first_message: z.string(),
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

export const pendingApprovalSchema = z.strictObject({
  tool_call_id: z.string(),
  operation_id: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

export const runSnapshotSchema = z.strictObject({
  streaming_message: z.record(z.string(), z.unknown()).nullable(),
  pending_tool_calls: z.array(z.string()),
  pending_approval: pendingApprovalSchema.nullable(),
  run_active: z.boolean(),
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
  maxBodyBytes: WORKBENCH_MAX_BODY_BYTES,
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
    description: "List the workbench sessions of every agent, or of one agent.",
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
    maxBodyBytes: WORKBENCH_MESSAGE_MAX_BODY_BYTES,
    input: z.strictObject({
      params: sessionParams,
      query: emptyFields,
      body: z.strictObject({ text: z.string().min(1) }),
    }),
    output: sessionParams.extend({ run_active: z.literal(true) }),
    description:
      "Start a run of the agent on one human message. A session holds one run at a time.",
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
    output: sessionParams.extend({ run_active: z.literal(false) }),
    description: "Stop the active run of a workbench session.",
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
