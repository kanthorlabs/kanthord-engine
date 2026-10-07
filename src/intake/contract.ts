import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import { timestamp } from "../kernel/json.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
} from "../kernel/operation.ts";

export const INTAKE_SERVICE_NAME = "intake";
export const INBOUND_ID_PREFIX = "inbound";
export const INBOUND_EVENT_ID_PREFIX = "inbound_event";
export const OUTBOUND_REQUEST_ID_PREFIX = "outbound_request";

export const INTAKE_OPERATION_TIMEOUT_MS = 30000;
export const OUTBOUND_LIST_LIMIT_DEFAULT = 100;
export const OUTBOUND_LIST_LIMIT_MIN = 1;
export const OUTBOUND_LIST_LIMIT_MAX = 1000;
export const POLL_INTERVAL_MS = 60000;
export const PRESIGN_LIFETIME_S = 3600;
export const PENDING_EVENT_LIMIT = 10000;
export const ERROR_ARRAY_MAX_BYTES = 16384;
export const ERROR_MESSAGE_MAX_BYTES = 1024;
export const RESULT_MAX_BYTES = 65536;
export const DELETE_IDS_MAX = 1000;
export const PLATFORM_CALL_DEADLINE_MS = 30000;
export const GIT_WRITE_DEADLINE_MS = 540000;
export const ACTION_PERFORM_TIMEOUT_MS = 600000;
export const ADMISSION_CONCURRENCY = 1;

export const IntakeErrorCode = {
  CursorInvalid: "system.pagination.cursor_invalid",
  OutboundRequestNotFound: "intake.outbound.request.not_found",
  OutboundRequestInFlight: "intake.outbound.request.in_flight",
  OutboundRequestStateConflict: "intake.outbound.request.state_conflict",
  OutboundRequestForceRequired: "intake.outbound.request.force_required",
  OutboundRequestFilterInvalid: "intake.outbound.request.filter_invalid",
} as const;

export const InboundKind = { Webhook: "webhook", Poll: "poll" } as const;
export const InboundPlatform = { GitHub: "github" } as const;
export const Consumer = {
  MissionDeliveryAdmit: "mission.delivery.admit",
} as const;
export const InboundEventState = {
  Pending: "pending",
  Succeeded: "succeeded",
  Failed: "failed",
  Discarded: "discarded",
} as const;
export const OutboundRequestState = {
  Pending: "pending",
  Succeeded: "succeeded",
  Failed: "failed",
  Discarded: "discarded",
} as const;
export const OutboundOperation = {
  GitHubPullRequest: "github.pull_request",
  GitMergePush: "git.merge_push",
  S3DeleteObject: "s3.delete_object",
} as const;
export const ResultClass = {
  ConfirmedFailure: "confirmed_failure",
  RetryableRefusal: "retryable_refusal",
  FinalRefusal: "final_refusal",
  UnknownOutcome: "unknown_outcome",
} as const;

export const inboundKindSchema = z.enum(InboundKind);
export const inboundPlatformSchema = z.enum(InboundPlatform);
export const consumerSchema = z.enum(Consumer);
export const inboundEventStateSchema = z.enum(InboundEventState);
export const outboundRequestStateSchema = z.enum(OutboundRequestState);
export const outboundOperationSchema = z.enum(OutboundOperation);
export const resultClassSchema = z.enum(ResultClass);

export const outboundRequestSchema = z.strictObject({
  id: identitySchema(OUTBOUND_REQUEST_ID_PREFIX),
  project_id: identitySchema("project"),
  operation: outboundOperationSchema,
  request_key: z.string().min(1),
  state: outboundRequestStateSchema,
  result: z.unknown().nullable(),
  error: z
    .array(
      z.strictObject({
        code: z.string(),
        message: z.string(),
        created_at: timestamp,
      }),
    )
    .nullable(),
  created_at: timestamp,
});

export const outboundDeleteSchema = z.strictObject({
  force: z.boolean().optional(),
  state: outboundRequestStateSchema.optional(),
  from: identitySchema(OUTBOUND_REQUEST_ID_PREFIX).optional(),
  to: identitySchema(OUTBOUND_REQUEST_ID_PREFIX).optional(),
  ids: z
    .array(identitySchema(OUTBOUND_REQUEST_ID_PREFIX))
    .min(1)
    .max(DELETE_IDS_MAX)
    .optional(),
});

export type InboundKindValue = z.infer<typeof inboundKindSchema>;
export type InboundPlatformValue = z.infer<typeof inboundPlatformSchema>;
export type ConsumerValue = z.infer<typeof consumerSchema>;
export type InboundEventStateValue = z.infer<typeof inboundEventStateSchema>;
export type OutboundRequestStateValue = z.infer<
  typeof outboundRequestStateSchema
>;
export type OutboundOperationValue = z.infer<typeof outboundOperationSchema>;
export type ResultClassValue = z.infer<typeof resultClassSchema>;
export type OutboundRequest = z.infer<typeof outboundRequestSchema>;
export type OutboundDelete = z.infer<typeof outboundDeleteSchema>;

const baseOperation = {
  service: INTAKE_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: INTAKE_OPERATION_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
const readOperation = {
  ...baseOperation,
  mutation: false,
  body: false,
} as const;
const mutationOperation = {
  ...baseOperation,
  method: HttpMethod.Post,
  mutation: true,
} as const;
const readInput = <P extends z.ZodType, Q extends z.ZodType>(
  params: P,
  query: Q,
) => z.strictObject({ params, query, body: z.null() });

export const intakeOperations = {
  "outbound.request.list": {
    ...readOperation,
    id: "intake.outbound.request.list",
    method: HttpMethod.Get,
    path: "/api/intake/outbound",
    input: readInput(
      z.strictObject({}),
      z.strictObject({
        project_id: identitySchema("project").optional(),
        state: outboundRequestStateSchema.optional(),
        operation: outboundOperationSchema.optional(),
        limit: z.coerce
          .number()
          .int()
          .min(OUTBOUND_LIST_LIMIT_MIN)
          .max(OUTBOUND_LIST_LIMIT_MAX)
          .default(OUTBOUND_LIST_LIMIT_DEFAULT)
          .optional(),
        cursor: z.string().optional(),
      }),
    ),
    output: z.strictObject({
      items: z.array(outboundRequestSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "List outbound requests, newest first.",
  },
  "outbound.request.get": {
    ...readOperation,
    id: "intake.outbound.request.get",
    method: HttpMethod.Get,
    path: "/api/intake/outbound/:outbound_request_id",
    input: readInput(
      z.strictObject({
        outbound_request_id: identitySchema(OUTBOUND_REQUEST_ID_PREFIX),
      }),
      z.strictObject({}),
    ),
    output: outboundRequestSchema,
    description: "Get one outbound request.",
  },
  "outbound.request.discard": {
    ...mutationOperation,
    id: "intake.outbound.request.discard",
    path: "/api/intake/outbound/:outbound_request_id/discard",
    body: false,
    input: z.strictObject({
      params: z.strictObject({
        outbound_request_id: identitySchema(OUTBOUND_REQUEST_ID_PREFIX),
      }),
      query: z.strictObject({}),
      body: z.null(),
    }),
    output: outboundRequestSchema,
    description: "Discard a pending outbound request whose call does not run.",
  },
  "outbound.request.delete": {
    ...mutationOperation,
    id: "intake.outbound.request.delete",
    path: "/api/intake/outbound/delete",
    body: true,
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: outboundDeleteSchema,
    }),
    output: z.strictObject({ count: z.number().int().nonnegative() }),
    description:
      "Delete settled outbound requests by a state with an identity range or by a list of identities.",
  },
} as const;
