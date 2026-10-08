import { z } from "zod";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import { timestamp } from "../kernel/json.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";

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
export const READ_ANSWER_MARGIN_MS = 1000;
export const GIT_WRITE_DEADLINE_MS = 540000;
export const ACTION_PERFORM_TIMEOUT_MS = 600000;
export const ADMISSION_CONCURRENCY = 1;
export const ACTION_READ_LIMIT_MIN = 1;
export const ACTION_READ_LIMIT_MAX = 100;
export const OBJECT_MAX_BYTES = 5 * 1024 ** 3;
export const INBOUND_CREATED_STATUS = 201;
export const INBOUND_LIST_LIMIT_DEFAULT = 100;
export const INBOUND_LIST_LIMIT_MIN = 1;
export const INBOUND_LIST_LIMIT_MAX = 1000;
export const INBOUND_EVENT_LIST_LIMIT_DEFAULT = 100;
export const INBOUND_EVENT_LIST_LIMIT_MIN = 1;
export const INBOUND_EVENT_LIST_LIMIT_MAX = 1000;
export const WEBHOOK_ADDRESS_PREFIX = "/hooks/";

export const IntakeErrorCode = {
  CursorInvalid: "system.pagination.cursor_invalid",
  OutboundRequestNotFound: "intake.outbound.request.not_found",
  OutboundRequestInFlight: "intake.outbound.request.in_flight",
  OutboundRequestDiscarded: "intake.outbound.request.discarded",
  OutboundRequestStateConflict: "intake.outbound.request.state_conflict",
  OutboundRequestForceRequired: "intake.outbound.request.force_required",
  OutboundRequestFilterInvalid: "intake.outbound.request.filter_invalid",
  OutboundRequestActionUnmapped: "intake.outbound.request.action_unmapped",
  StorageObjectMismatch: "intake.storage.object_mismatch",
  InboundProjectNotFound: "intake.inbound.project_not_found",
  InboundCredentialInvalid: "intake.inbound.credential_invalid",
  InboundNotFound: "intake.inbound.not_found",
  InboundEventsPending: "intake.inbound.events_pending",
  InboundEventNotFound: "intake.inbound.event.not_found",
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
export const CheckEndState = {
  Expected: "expected",
  Other: "other",
  None: "none",
} as const;

export const ActionTableAction = {
  PullRequest: "pull_request",
  MergePush: "merge_push",
} as const;
export const ActionTablePlatform = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket",
} as const;
export const ACTION_TABLE = [
  {
    action: ActionTableAction.PullRequest,
    platform: ActionTablePlatform.GitHub,
    operation: OutboundOperation.GitHubPullRequest,
  },
  {
    action: ActionTableAction.MergePush,
    platform: ActionTablePlatform.GitHub,
    operation: OutboundOperation.GitMergePush,
  },
  {
    action: ActionTableAction.MergePush,
    platform: ActionTablePlatform.GitLab,
    operation: OutboundOperation.GitMergePush,
  },
  {
    action: ActionTableAction.MergePush,
    platform: ActionTablePlatform.Bitbucket,
    operation: OutboundOperation.GitMergePush,
  },
] as const;
export const ActionReadMethod = {
  PullRequestGet: "github-pull-request-get",
  ReviewCommentList: "github-pull-request-review-comment-list",
} as const;
export const AddressKind = {
  PullRequest: "pull_request",
  BranchPush: "branch_push",
} as const;

export const inboundKindSchema = z.enum(InboundKind);
export const inboundPlatformSchema = z.enum(InboundPlatform);
export const consumerSchema = z.enum(Consumer);
export const inboundEventStateSchema = z.enum(InboundEventState);
export const outboundRequestStateSchema = z.enum(OutboundRequestState);
export const outboundOperationSchema = z.enum(OutboundOperation);
export const resultClassSchema = z.enum(ResultClass);
export const checkEndStateSchema = z.enum(CheckEndState);
export const actionReadMethodSchema = z.enum(ActionReadMethod);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const actionKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}\.(pull_request|merge_push)$/);
export const platformAddressSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(AddressKind.PullRequest),
    resource_identity: z.string().min(1),
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    kind: z.literal(AddressKind.BranchPush),
    resource_identity: z.string().min(1),
    branch: z.string().min(1),
    commit: commitSchema,
  }),
]);
export const resultClassAnswerSchema = z.strictObject({
  class: resultClassSchema,
  code: z.string(),
  message: z.string(),
});

export const actionReadPageSchema = z.strictObject({
  body: z.unknown(),
  next_cursor: z.string().nullable(),
});

export const presignedPutSchema = z.strictObject({
  put_url: z.string(),
  headers: z.record(z.string(), z.string()),
  expires_at: timestamp,
});
export const presignedGetSchema = z.strictObject({
  get_url: z.string(),
  expires_at: timestamp,
});
export const objectCheckSchema = z.strictObject({
  location: z.string(),
  version: z.string().nullable(),
});

export const errorItemSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string(),
  created_at: timestamp,
});
export type ErrorItem = z.infer<typeof errorItemSchema>;

export const outboundRequestSchema = z.strictObject({
  id: identitySchema(OUTBOUND_REQUEST_ID_PREFIX),
  project_id: identitySchema("project"),
  operation: outboundOperationSchema,
  request_key: z.string().min(1),
  state: outboundRequestStateSchema,
  result: z.unknown().nullable(),
  error: errorItemSchema.array().nullable(),
  created_at: timestamp,
});

export const inboundEventSchema = z.strictObject({
  id: identitySchema(INBOUND_EVENT_ID_PREFIX),
  inbound_id: identitySchema(INBOUND_ID_PREFIX),
  event_id: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  state: inboundEventStateSchema,
  error: errorItemSchema.array().nullable(),
  created_at: timestamp,
});

export const inboundSchema = z.strictObject({
  id: identitySchema(INBOUND_ID_PREFIX),
  project_id: identitySchema("project"),
  kind: inboundKindSchema,
  platform: inboundPlatformSchema,
  consumer: consumerSchema,
  credential: z.string().min(1).nullable(),
  configuration: z.record(z.string(), z.unknown()),
  checkpoint: z.unknown().nullable(),
  created_at: timestamp,
});

export const webhookInboundSchema = inboundSchema.extend({
  address: z.string().min(1),
  secret: z.string().min(1),
});

export const inboundCreateSchema = z.strictObject({
  project_id: identitySchema("project"),
  kind: inboundKindSchema,
  platform: inboundPlatformSchema,
  consumer: consumerSchema,
  credential: z.string().min(1).optional(),
  configuration: z.record(z.string(), z.unknown()),
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
export type InboundEvent = z.infer<typeof inboundEventSchema>;
export type Inbound = z.infer<typeof inboundSchema>;
export type WebhookInbound = z.infer<typeof webhookInboundSchema>;
export type InboundCreate = z.infer<typeof inboundCreateSchema>;
export type OutboundDelete = z.infer<typeof outboundDeleteSchema>;
export type PlatformAddress = z.infer<typeof platformAddressSchema>;
export type ResultClassAnswer = z.infer<typeof resultClassAnswerSchema>;
export type ActionReadMethodValue = z.infer<typeof actionReadMethodSchema>;
export type ActionReadPage = z.infer<typeof actionReadPageSchema>;
export type PresignedPutAnswer = z.infer<typeof presignedPutSchema>;
export type PresignedGetAnswer = z.infer<typeof presignedGetSchema>;
export type ObjectCheck = z.infer<typeof objectCheckSchema>;

export interface IntakeCollaborations {
  inboundsNaming(
    tx: Transaction,
    credentialName: string,
  ): { inbound_id: string }[];
}

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
const serviceOperation = {
  ...baseOperation,
  access: AccessPolicy.Service,
  method: HttpMethod.Post,
  mutation: false,
  body: true,
} as const;
const performOperation = {
  ...baseOperation,
  access: AccessPolicy.Client,
  direct: true,
  requiresExecution: true,
  method: HttpMethod.Post,
  mutation: true,
  body: true,
  timeoutMs: ACTION_PERFORM_TIMEOUT_MS,
} as const;
const actionReadOperation = {
  ...readOperation,
  access: AccessPolicy.Client,
  direct: true,
  requiresExecution: true,
  method: HttpMethod.Get,
} as const;
const storageReadOperation = {
  ...readOperation,
  direct: true,
  method: HttpMethod.Get,
} as const;
const executionStorageReadOperation = {
  ...storageReadOperation,
  access: AccessPolicy.Client,
  requiresExecution: true,
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
  "inbound.create": {
    ...mutationOperation,
    id: "intake.inbound.create",
    path: "/api/intake/inbound",
    body: true,
    status: INBOUND_CREATED_STATUS,
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: inboundCreateSchema,
    }),
    output: inboundSchema,
    description:
      "Create an inbound of a project; a webhook inbound calls no platform.",
  },
  "inbound.list": {
    ...readOperation,
    id: "intake.inbound.list",
    method: HttpMethod.Get,
    path: "/api/intake/inbound",
    input: readInput(
      z.strictObject({}),
      z.strictObject({
        project_id: identitySchema("project").optional(),
        kind: inboundKindSchema.optional(),
        platform: inboundPlatformSchema.optional(),
        limit: z.coerce
          .number()
          .int()
          .min(INBOUND_LIST_LIMIT_MIN)
          .max(INBOUND_LIST_LIMIT_MAX)
          .default(INBOUND_LIST_LIMIT_DEFAULT)
          .optional(),
        cursor: z.string().optional(),
      }),
    ),
    output: z.strictObject({
      items: z.array(inboundSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "List inbounds, newest first.",
  },
  "inbound.get": {
    ...readOperation,
    id: "intake.inbound.get",
    method: HttpMethod.Get,
    path: "/api/intake/inbound/:inbound_id",
    input: readInput(
      z.strictObject({ inbound_id: identitySchema(INBOUND_ID_PREFIX) }),
      z.strictObject({}),
    ),
    output: z.union([webhookInboundSchema, inboundSchema]),
    description:
      "Get one inbound; a webhook inbound adds its address and its verification secret.",
  },
  "inbound.delete": {
    ...baseOperation,
    id: "intake.inbound.delete",
    method: HttpMethod.Delete,
    path: "/api/intake/inbound/:inbound_id",
    mutation: true,
    body: false,
    status: HttpStatus.NoContent,
    input: readInput(
      z.strictObject({ inbound_id: identitySchema(INBOUND_ID_PREFIX) }),
      z.strictObject({}),
    ),
    output: z.null(),
    description:
      "Delete an inbound and its events; a delete calls no platform and refuses while a pending event exists.",
  },
  "inbound.event.list": {
    ...readOperation,
    id: "intake.inbound.event.list",
    method: HttpMethod.Get,
    path: "/api/intake/event",
    input: readInput(
      z.strictObject({}),
      z.strictObject({
        inbound_id: identitySchema(INBOUND_ID_PREFIX).optional(),
        state: inboundEventStateSchema.optional(),
        limit: z.coerce
          .number()
          .int()
          .min(INBOUND_EVENT_LIST_LIMIT_MIN)
          .max(INBOUND_EVENT_LIST_LIMIT_MAX)
          .default(INBOUND_EVENT_LIST_LIMIT_DEFAULT)
          .optional(),
        cursor: z.string().optional(),
      }),
    ),
    output: z.strictObject({
      items: z.array(inboundEventSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "List inbound events, newest first.",
  },
  "inbound.event.get": {
    ...readOperation,
    id: "intake.inbound.event.get",
    method: HttpMethod.Get,
    path: "/api/intake/event/:inbound_event_id",
    input: readInput(
      z.strictObject({
        inbound_event_id: identitySchema(INBOUND_EVENT_ID_PREFIX),
      }),
      z.strictObject({}),
    ),
    output: inboundEventSchema,
    description: "Get one inbound event projection.",
  },
  "action.check": {
    ...serviceOperation,
    id: "intake.action.check",
    path: "/api/intake/action/check",
    input: z.strictObject({
      params: z.strictObject({}),
      query: z.strictObject({}),
      body: z.strictObject({ evidence_id: identitySchema("evidence") }),
    }),
    output: z.strictObject({
      end_state: checkEndStateSchema,
      landed_commits: z.array(commitSchema),
    }),
    description:
      "Check the platform end state of a request evidence for the Mission Service.",
  },
  "action.perform": {
    ...performOperation,
    id: "intake.action.perform",
    path: "/api/intake/execution/:execution_id/action/perform",
    input: z.strictObject({
      params: z.strictObject({ execution_id: identitySchema("execution") }),
      query: z.strictObject({}),
      body: z.strictObject({
        key: actionKeySchema,
        commit: commitSchema,
        reused_evidence_id: identitySchema("evidence").nullable(),
        request_key: z.string().min(1),
      }),
    }),
    output: z.union([platformAddressSchema, resultClassAnswerSchema]),
    description:
      "Perform a configured repository action of an execution and answer its platform address or its result class.",
  },
  "action.read": {
    ...actionReadOperation,
    id: "intake.action.read",
    path: "/api/intake/execution/:execution_id/request/:evidence_id",
    input: readInput(
      z.strictObject({
        execution_id: identitySchema("execution"),
        evidence_id: identitySchema("evidence"),
      }),
      z.strictObject({
        method: actionReadMethodSchema,
        limit: z.coerce
          .number()
          .int()
          .min(ACTION_READ_LIMIT_MIN)
          .max(ACTION_READ_LIMIT_MAX)
          .optional(),
        cursor: z.string().optional(),
      }),
    ),
    output: z.union([actionReadPageSchema, resultClassAnswerSchema]),
    description:
      "Read the platform body of a request evidence for an execution and answer it unchanged or its result class.",
  },
  "storage.put": {
    ...baseOperation,
    access: AccessPolicy.Client,
    direct: true,
    requiresExecution: true,
    method: HttpMethod.Post,
    mutation: false,
    body: true,
    id: "intake.storage.put",
    path: "/api/intake/execution/:execution_id/storage/put",
    input: z.strictObject({
      params: z.strictObject({ execution_id: identitySchema("execution") }),
      query: z.strictObject({}),
      body: z.strictObject({
        node_id: identitySchema("node"),
        asset_id: identitySchema("evidence_asset"),
        storage_binding_id: identitySchema("binding"),
        size: z.number().int().nonnegative().max(OBJECT_MAX_BYTES),
        sha256: sha256Schema.nullable(),
      }),
    }),
    output: presignedPutSchema,
    description:
      "Sign a presigned PUT of an evidence asset object for an execution.",
  },
  "storage.check": {
    ...executionStorageReadOperation,
    id: "intake.storage.check",
    path: "/api/intake/execution/:execution_id/storage/asset/:asset_id/check",
    input: readInput(
      z.strictObject({
        execution_id: identitySchema("execution"),
        asset_id: identitySchema("evidence_asset"),
      }),
      z.strictObject({}),
    ),
    output: objectCheckSchema,
    description:
      "Check the size and the SHA-256 of an uploaded evidence asset object for an execution.",
  },
  "execution.storage.get": {
    ...executionStorageReadOperation,
    id: "intake.execution.storage.get",
    path: "/api/intake/execution/:execution_id/storage/asset/:asset_id",
    input: readInput(
      z.strictObject({
        execution_id: identitySchema("execution"),
        asset_id: identitySchema("evidence_asset"),
      }),
      z.strictObject({}),
    ),
    output: presignedGetSchema,
    description:
      "Sign a presigned GET of an evidence asset object for an execution.",
  },
  "storage.get": {
    ...storageReadOperation,
    id: "intake.storage.get",
    path: "/api/intake/storage/asset/:asset_id",
    input: readInput(
      z.strictObject({ asset_id: identitySchema("evidence_asset") }),
      z.strictObject({}),
    ),
    output: presignedGetSchema,
    description:
      "Sign a presigned GET of an evidence asset object for a human.",
  },
  "storage.delete": {
    ...baseOperation,
    direct: true,
    method: HttpMethod.Delete,
    mutation: true,
    body: false,
    status: HttpStatus.NoContent,
    id: "intake.storage.delete",
    path: "/api/intake/storage/asset/:asset_id",
    input: readInput(
      z.strictObject({ asset_id: identitySchema("evidence_asset") }),
      z.strictObject({}),
    ),
    output: z.null(),
    description:
      "Delete the stored object of an evidence asset at its recorded version for a human.",
  },
} as const;
