import { z } from "zod";
import { resourceFailureReasonSchema, ResourceStatus } from "./health.ts";
import { sealedObjectSchema } from "./sealed-object.ts";

export const SecretShape = {
  ApiKey: "api_key",
  OAuth: "oauth",
  S3AccessKey: "s3_access_key",
  SshKey: "ssh_key",
} as const;
export type SecretShape = (typeof SecretShape)[keyof typeof SecretShape];
export const LoginSessionMode = {
  Browser: "browser",
  Device: "device",
  CopyCode: "copy_code",
} as const;
export type LoginSessionMode =
  (typeof LoginSessionMode)[keyof typeof LoginSessionMode];

export const CREDENTIAL_NAME_MAX_LENGTH = 63;
export const CREDENTIAL_TIMEOUT_MS = 30000;
export const LIST_LIMIT_MAX = 1000;

export const credentialParamsSchema = z.strictObject({
  credential_name: z.string().min(1),
});
export const credentialRevisionParamsSchema = z.strictObject({
  credential_name: z.string().min(1),
  revision: z.coerce.number().int().positive(),
});
export const CREDENTIAL_METADATA_MAX_BYTES = 16384;
function fitsMetadataBound(metadata: unknown): boolean {
  return (
    metadata === undefined ||
    Buffer.byteLength(JSON.stringify(metadata), "utf8") <=
      CREDENTIAL_METADATA_MAX_BYTES
  );
}
export const credentialMetadataSchema = z.unknown().refine(fitsMetadataBound);
export const credentialCreateSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  metadata: credentialMetadataSchema,
  secret: z.unknown(),
});
export const credentialCheckBodySchema = credentialCreateSchema.omit({
  name: true,
});
export const credentialRotateBodySchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  secret: z.unknown(),
  metadata: credentialMetadataSchema.optional(),
});
export const credentialUpdateMetadataBodySchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  metadata: credentialMetadataSchema,
});
export const credentialListQuerySchema = z.strictObject({
  platform: z.string().optional(),
  include_archived: z.enum(["true", "false"]).default("false").optional(),
  limit: z.coerce.number().int().positive().max(LIST_LIMIT_MAX).optional(),
  cursor: z.string().min(1).optional(),
});

export const credentialRevisionAnswerSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  created_at: z.number().int(),
  ended_at: z.number().int().nullable(),
});
export const credentialAnswerSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  holder: z.string(),
  sealed_to: z.string().nullable(),
  sealed_current: z.boolean(),
  revisions: z.array(credentialRevisionAnswerSchema),
});
export const credentialListAnswerSchema = z.strictObject({
  items: z.array(credentialAnswerSchema),
  next_cursor: z.string().nullable(),
});
export const credentialCheckAnswerSchema = z.strictObject({
  status: z.enum([
    ResourceStatus.Healthy,
    ResourceStatus.Unhealthy,
    ResourceStatus.Unknown,
  ]),
  capability: z.string().min(1),
  failure_reason: resourceFailureReasonSchema,
});
export const credentialPlatformListAnswerSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      platform: z.string(),
      secret_shape: z.enum(SecretShape),
      login_modes: z.array(z.enum(LoginSessionMode)),
      metadata_fields: z.array(z.string()),
      verifiable: z.boolean(),
    }),
  ),
});

export const sealedCopyAnswerSchema = z.strictObject({
  name: z.string(),
  holder: z.string().min(1),
  platform: z.string(),
  revision: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  sealed: sealedObjectSchema,
});
