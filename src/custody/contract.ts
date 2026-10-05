import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { MachineIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import {
  ResourceStatus,
  type ResourceCheck,
  type ResourceEntry,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import type { Transaction } from "../kernel/store.ts";

export const SecretShape = {
  ApiKey: "api_key",
  OAuth: "oauth",
  S3AccessKey: "s3_access_key",
} as const;
export type SecretShape = (typeof SecretShape)[keyof typeof SecretShape];
export const LoginSessionMode = {
  Browser: "browser",
  Device: "device",
} as const;
export type LoginSessionMode =
  (typeof LoginSessionMode)[keyof typeof LoginSessionMode];
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const EXECUTION_CREDENTIAL_MAX_BYTES = 48915;
export const piCredentialSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal(SecretShape.ApiKey),
      key: z
        .string()
        .min(1)
        .refine((key) => Boolean(key.trim())),
    }),
    z.strictObject({
      type: z.literal(SecretShape.OAuth),
      refresh: z.string().min(1),
      access: z.string().min(1),
      expires: z.number().int(),
    }),
  ])
  .refine((credential) => {
    const wellFormed =
      credential.type === SecretShape.ApiKey
        ? credential.key.isWellFormed()
        : credential.refresh.isWellFormed() && credential.access.isWellFormed();
    if (!wellFormed) return false;
    return (
      Buffer.byteLength(canonicalJSON(credential), "utf8") <=
      EXECUTION_CREDENTIAL_MAX_BYTES
    );
  }, "The normalized credential must contain well-formed Unicode and fit the serialized byte budget.");
export const handoverPayloadSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      credentialId: identitySchema("credential"),
      providerId: z.string().min(1),
      credential: piCredentialSchema,
    }),
  ),
});
export const refreshReportSchema = z.strictObject({
  credentialId: identitySchema("credential"),
  digest: z.string().regex(SHA256_HEX_PATTERN),
  credential: piCredentialSchema,
});
export type HandoverPayload = z.infer<typeof handoverPayloadSchema>;
export type RefreshReport = z.infer<typeof refreshReportSchema>;

export type CustodyExecution = {
  executionId: string;
  projectId: string;
  workerBindingId: string;
  resourceIdentity: string;
  runtimeIdentity: string;
  credentials: string[];
};
export interface CustodyExecutions {
  requireRunning(
    tx: Transaction,
    executionId: string,
    runtimeIdentity: string,
    now: number,
  ): CustodyExecution;
  pinCredential(
    tx: Transaction,
    executionId: string,
    credentialId: string,
  ): void;
  liveExecutionsPinning(tx: Transaction, credentialId: string): string[];
}
export type ModelInferenceAuthorization = {
  credential: string;
  platform: string;
  providerId: string;
  agentProvider: string;
};
export interface CustodyAuthorization {
  /** Supplied by Worker, which owns inference authorization through the claim's worker binding. */
  authorizeModelInference(
    tx: Transaction,
    identity: MachineIdentity,
    execution: {
      executionId: string;
      projectId: string;
      workerBindingId: string;
      resourceIdentity: string;
    },
  ): ModelInferenceAuthorization;
}

export type Grant = Readonly<{
  credential: string;
  platform: string;
  execution: Readonly<
    Omit<CustodyExecution, "credentials"> & { credentials: readonly string[] }
  >;
}>;
export type Material = {
  readonly credentialId: string;
  readonly platform: string;
  value(): unknown;
  drop(): void;
};

export const CUSTODY_SERVICE_NAME = "custody";
export const CREDENTIAL_TIMEOUT_MS = 30000;
export const CREDENTIAL_CHECK_TIMEOUT_MS = 10000;
export const CREATE_MAX_BODY_BYTES = 64 * 1024;
export const METADATA_MAX_BODY_BYTES = 16 * 1024;
export const REVOKE_MAX_BODY_BYTES = 0;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;

export type CredentialMetadata = {
  id: string;
  name: string;
  platform: string;
  metadata: Record<string, unknown> | null;
};
export type CustodySuitabilityFn = (
  tx: Transaction,
  req: { credential: string; platform: string },
) => void;
export type CredentialMetadataFn = (
  tx: Transaction,
  credentialName: string,
) => CredentialMetadata | null;

export type AgentProviderDependent = {
  agentName: string;
  providerName: string;
};
export type BindingRevision = {
  bindingId: string;
  projectId: string;
};
export type BindingNaming = BindingRevision & {
  projectName: string;
  name: string;
};
export type InboundDependent = {
  inboundId: string;
};
export type AgentProvidersDependentOnFn = (
  tx: Transaction,
  credentialName: string,
) => AgentProviderDependent[];
export type BindingsNamingFn = (
  tx: Transaction,
  credentialName: string,
) => BindingNaming[];
export type InboundsNamingFn = (
  tx: Transaction,
  credentialName: string,
) => InboundDependent[];

const EMPTY_STRING_LENGTH = 0;
const STRING_FIELD_TYPE = "string";

export function isNonblank(s: string): boolean {
  return s.trim().length > EMPTY_STRING_LENGTH;
}

export const apiKeySecretSchema = z
  .strictObject({
    key: z.string().min(1).refine(isNonblank),
  })
  .refine(
    (secret) =>
      piCredentialSchema.safeParse({ type: SecretShape.ApiKey, ...secret })
        .success,
  );
export const oauthSecretSchema = z
  .strictObject({
    refresh: z.string().min(1),
    access: z.string().min(1),
    expires: z.number().int(),
  })
  .refine(
    (secret) =>
      piCredentialSchema.safeParse({ type: SecretShape.OAuth, ...secret })
        .success,
  );
export const s3AccessKeySecretSchema = z.strictObject({
  accessKeyId: z.string().min(1).refine(isNonblank),
  secretAccessKey: z.string().min(1).refine(isNonblank),
});
export const secretSchemas: Readonly<Record<SecretShape, z.ZodType>> = {
  [SecretShape.ApiKey]: apiKeySecretSchema,
  [SecretShape.OAuth]: oauthSecretSchema,
  [SecretShape.S3AccessKey]: s3AccessKeySecretSchema,
};

export type PlatformProbe = (
  secret: unknown,
  metadata: unknown,
  context: Context,
  observe?: ResourceObserver,
) => Promise<ResourceStatusValue>;
export type CredentialPlatform = {
  secretShape: SecretShape;
  loginModes: readonly LoginSessionMode[];
  metadataSchema: z.ZodObject | null;
  capability: string;
  probe: PlatformProbe | null;
};
export type CredentialPlatforms = Readonly<Record<string, CredentialPlatform>>;
export type CheckMaterial = {
  platform: string;
  metadata: unknown;
  secret: () => unknown;
};
export const RevisionChange = {
  Create: "create",
  Rotate: "rotate",
  Metadata: "metadata",
} as const;
export type RevisionChange =
  (typeof RevisionChange)[keyof typeof RevisionChange];
export type MetadataRevision = {
  name: string;
  platform: string;
  change: RevisionChange;
  current: Record<string, unknown> | null;
  next: Record<string, unknown> | null;
};
export type CredentialPlatformSet = {
  platforms: CredentialPlatforms;
  checkMetadata?: (tx: Transaction, revision: MetadataRevision) => void;
};

export const credentialParamsSchema = z.strictObject({
  credentialName: z.string().min(1),
});
export const credentialRevisionParamsSchema = z.strictObject({
  credentialName: z.string().min(1),
  revision: z.coerce.number().int().positive(),
});
export const credentialCreateSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  metadata: z.unknown(),
  secret: z.unknown(),
});
export const credentialCheckBodySchema = credentialCreateSchema.omit({
  name: true,
});
export const credentialRotateBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  secret: z.unknown(),
  metadata: z.unknown().optional(),
});
export const credentialUpdateMetadataBodySchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  metadata: z.unknown(),
});
export const credentialListQuerySchema = z.strictObject({
  platform: z.string().optional(),
  includeArchived: z.enum(["true", "false"]).default("false").optional(),
  limit: z.coerce.number().int().positive().max(LIST_LIMIT_MAX).optional(),
  cursor: z.string().min(1).optional(),
});
export type CredentialCreate = z.infer<typeof credentialCreateSchema>;
export type CredentialCheckBody = z.infer<typeof credentialCheckBodySchema>;
export type CredentialRotateBody = z.infer<typeof credentialRotateBodySchema>;
export type CredentialUpdateMetadataBody = z.infer<
  typeof credentialUpdateMetadataBodySchema
>;
export type CredentialListQuery = z.infer<typeof credentialListQuerySchema>;

export const credentialRevisionAnswerSchema = z.strictObject({
  id: z.string(),
  revision: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.number().int(),
  endedAt: z.number().int().nullable(),
});
export const credentialAnswerSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  revisions: z.array(credentialRevisionAnswerSchema),
});
export const credentialListAnswerSchema = z.strictObject({
  items: z.array(credentialAnswerSchema),
  nextCursor: z.string().nullable(),
});
export const credentialCheckAnswerSchema = z.strictObject({
  status: z.enum([
    ResourceStatus.Healthy,
    ResourceStatus.Unhealthy,
    ResourceStatus.Unknown,
  ]),
  capability: z.string().min(1),
});
export type CredentialCheckAnswer = z.infer<typeof credentialCheckAnswerSchema>;
export const credentialPlatformListAnswerSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      platform: z.string(),
      secretShape: z.enum(SecretShape),
      loginModes: z.array(z.enum(LoginSessionMode)),
      metadataFields: z.array(z.string()),
      verifiable: z.boolean(),
    }),
  ),
});
export type CredentialRevisionAnswer = z.infer<
  typeof credentialRevisionAnswerSchema
>;
export type CredentialAnswer = z.infer<typeof credentialAnswerSchema>;
export type CredentialListAnswer = z.infer<typeof credentialListAnswerSchema>;
export type CredentialPlatformListAnswer = z.infer<
  typeof credentialPlatformListAnswerSchema
>;

export function credentialPlatformList(
  platforms: CredentialPlatforms,
): CredentialPlatformListAnswer {
  return {
    items: Object.entries(platforms).map(([platform, entry]) => ({
      platform,
      secretShape: entry.secretShape,
      loginModes: [...entry.loginModes],
      metadataFields:
        entry.metadataSchema === null
          ? []
          : Object.entries(entry.metadataSchema.shape)
              .filter(([, field]) => field._zod.def.type === STRING_FIELD_TYPE)
              .map(([name]) => name),
      verifiable: entry.probe !== null,
    })),
  };
}

export interface CredentialRecords {
  create(
    tx: Transaction,
    set: CredentialPlatformSet,
    body: CredentialCreate,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  list(
    tx: Transaction,
    set: CredentialPlatformSet,
    query: CredentialListQuery,
  ): CredentialListAnswer;
  get(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CredentialAnswer;
  rotate(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialRotateBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  updateMetadata(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialUpdateMetadataBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  revoke(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    revision: number,
  ): CredentialAnswer;
  archive(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CredentialAnswer;
  requireAvailableName(tx: Transaction, name: string): void;
  createLoginRevision(
    tx: Transaction,
    set: CredentialPlatformSet,
    name: string,
    platform: string,
    secret: unknown,
    now: number,
  ): string;
  resourceInventory(
    tx: Transaction,
    set: CredentialPlatformSet,
  ): ResourceEntry[];
  resourceCheck(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): ResourceCheck;
  checkMaterial(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CheckMaterial | null;
  check(
    set: CredentialPlatformSet,
    body: CredentialCheckBody,
    context: Context,
  ): Promise<CredentialCheckAnswer>;
  credentialMetadata(
    tx: Transaction,
    credentialName: string,
  ): CredentialMetadata | null;
}
