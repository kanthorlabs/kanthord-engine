import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import { timestamp } from "../kernel/json.ts";

export const INTAKE_SERVICE_NAME = "intake";
export const INBOUND_ID_PREFIX = "inbound";
export const INBOUND_EVENT_ID_PREFIX = "inbound_event";
export const OUTBOUND_REQUEST_ID_PREFIX = "outbound_request";

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
