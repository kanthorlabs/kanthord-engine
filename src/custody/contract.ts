import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type {
  CallerIdentity,
  HumanIdentity,
  MachineIdentity,
  ServiceIdentity,
} from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
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
  None: "none",
} as const;
export type SecretShape = (typeof SecretShape)[keyof typeof SecretShape];
export const LoginSessionMode = {
  Browser: "browser",
  Device: "device",
} as const;
export type LoginSessionMode =
  (typeof LoginSessionMode)[keyof typeof LoginSessionMode];
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const EXECUTION_CREDENTIAL_MAX_BYTES = 48914;
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
      credential_id: identitySchema("credential"),
      provider_id: z.string().min(1),
      credential: piCredentialSchema,
    }),
  ),
});
export const refreshReportSchema = z.strictObject({
  credential_id: identitySchema("credential"),
  digest: z.string().regex(SHA256_HEX_PATTERN),
  credential: piCredentialSchema,
});
export type HandoverPayload = z.infer<typeof handoverPayloadSchema>;
export type RefreshReport = z.infer<typeof refreshReportSchema>;

export type CustodyExecution = {
  execution_id: string;
  project_id: string;
  worker_binding_id: string;
  resource_identity: string;
  runtime_identity: string;
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
  provider_id: string;
  agent_provider: string;
};
export interface CustodyAuthorization {
  /** Supplied by Worker, which owns inference authorization through the claim's worker binding. */
  authorizeModelInference(
    tx: Transaction,
    identity: MachineIdentity,
    execution: {
      execution_id: string;
      project_id: string;
      worker_binding_id: string;
      resource_identity: string;
    },
  ): ModelInferenceAuthorization[];
}

export type WorkbenchAuthorization = {
  credential: string;
  platform: string;
};
export type WorkbenchAuthorizeFn = (
  tx: Transaction,
  requester: HumanIdentity,
  sessionId: string,
) => WorkbenchAuthorization;
export type WorkbenchCredentialsInput = {
  session_id: string;
  platform: string;
  requester: () => HumanIdentity | undefined;
  authorize: WorkbenchAuthorizeFn;
};
export type WorkbenchCredentialsFn = (
  input: WorkbenchCredentialsInput,
) => CredentialStore;
export type WorkbenchGrant = Readonly<{
  credential: string;
  platform: string;
  session_id: string;
}>;

export type FrozenActionFacts = {
  key: string;
  binding_id: string;
  action: string;
  expected_end_state: string;
  follows: string | null;
  configuration: { base_branch: string };
};
export type PullRequestAddressFacts = {
  kind: "pull_request";
  resource_identity: string;
  number: number;
};
export type PlatformAddressFacts =
  | PullRequestAddressFacts
  | {
      kind: "branch_push";
      resource_identity: string;
      branch: string;
      commit: string;
    };
export type RepositoryFacts = {
  binding_id: string;
  address: string;
  resource_identity: string;
  base_branch: string;
};
export type ActionFacts = {
  frozen_action: FrozenActionFacts;
  repository: RepositoryFacts;
  snapshot_commit: string;
  reused_address: PullRequestAddressFacts | null;
};
export type RequestFacts = {
  frozen_action: FrozenActionFacts;
  address: PlatformAddressFacts;
  repository: RepositoryFacts;
};
export type AssetFacts = {
  storage: {
    binding_id: string;
    endpoint: string;
    bucket: string;
    region: string;
  };
  key: string;
  location: string;
  version: string | null;
  size: number;
  sha256: string | null;
};
export const AssetUse = {
  Check: "check",
  Get: "get",
  ExecutionGet: "execution_get",
  Delete: "delete",
} as const;
export type AssetUse = (typeof AssetUse)[keyof typeof AssetUse];
export type ObjectPutInput = {
  nodeId: string;
  assetId: string;
  storageBindingId: string;
  size: number;
  sha256: string | null;
};
export type Authorized<F> = {
  credential: string | null;
  platform: string;
  project_id: string;
  facts: F;
};
export interface MissionAuthorization {
  frozenAction(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    input: { key: string; commit: string; reusedEvidenceId: string | null },
  ): Authorized<ActionFacts>;
  requestEvidence(
    tx: Transaction,
    identity: CallerIdentity,
    evidenceId: string,
    claim: ExecutionClaim | null,
  ): Authorized<RequestFacts>;
  evidenceAsset(
    tx: Transaction,
    identity: CallerIdentity,
    assetId: string,
    claim: ExecutionClaim | null,
    use: AssetUse,
  ): Authorized<AssetFacts>;
  objectPut(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    input: ObjectPutInput,
  ): Authorized<AssetFacts>;
}

export const GrantKind = {
  ModelInference: "model_inference",
  FrozenAction: "frozen_action",
  RequestEvidence: "request_evidence",
  EvidenceAsset: "evidence_asset",
  ObjectPut: "object_put",
  Inbound: "inbound",
} as const;
export type GrantKind = (typeof GrantKind)[keyof typeof GrantKind];
export const InboundOperation = { Poll: "poll" } as const;
export type InboundOperation =
  (typeof InboundOperation)[keyof typeof InboundOperation];
export type InboundGrantInput = {
  inboundId: string;
  projectId: string;
  credential: string;
  platform: string;
  resource: string;
};
export type InboundFacts = {
  inbound_id: string;
  resource: string;
};
export type GrantRequest =
  | {
      kind: typeof GrantKind.FrozenAction;
      identity: MachineIdentity;
      claim: ExecutionClaim;
      key: string;
      commit: string;
      reusedEvidenceId: string | null;
    }
  | {
      kind: typeof GrantKind.RequestEvidence;
      identity: CallerIdentity;
      evidenceId: string;
      claim: ExecutionClaim | null;
    }
  | {
      kind: typeof GrantKind.EvidenceAsset;
      identity: CallerIdentity;
      assetId: string;
      claim: ExecutionClaim | null;
      use: AssetUse;
    }
  | ({
      kind: typeof GrantKind.ObjectPut;
      identity: MachineIdentity;
      claim: ExecutionClaim;
    } & ObjectPutInput)
  | {
      kind: typeof GrantKind.Inbound;
      identity: ServiceIdentity;
      inbound: InboundGrantInput;
      operation: InboundOperation;
    };
export type ModelInferenceFacts = {
  provider_id: string;
  agent_provider: string;
};
type GrantFactsOfKind = {
  [GrantKind.ModelInference]: ModelInferenceFacts;
  [GrantKind.FrozenAction]: ActionFacts;
  [GrantKind.RequestEvidence]: RequestFacts;
  [GrantKind.EvidenceAsset]: AssetFacts;
  [GrantKind.ObjectPut]: AssetFacts;
  [GrantKind.Inbound]: InboundFacts;
};
export type GrantExecution = Readonly<
  Omit<CustodyExecution, "credentials"> & { credentials: readonly string[] }
>;
export type GrantOf<K extends GrantKind> = Readonly<{
  kind: K;
  credential: string | null;
  platform: string;
  project_id: string;
  execution: GrantExecution | null;
  facts: Readonly<GrantFactsOfKind[K]>;
}>;
export type Grant = { [K in GrantKind]: GrantOf<K> }[GrantKind];
export type GrantFacts<G extends Grant = Grant> = Readonly<{
  project_id: string;
  credential: string | null;
  facts: G["facts"];
}>;
export type Material = {
  readonly credential_id: string;
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
  agent_name: string;
  provider_name: string;
};
export type BindingRevision = {
  binding_id: string;
  project_id: string;
};
export type BindingNaming = BindingRevision & {
  project_name: string;
  name: string;
};
export type InboundDependent = {
  inbound_id: string;
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
  access_key_id: z.string().min(1).refine(isNonblank),
  secret_access_key: z.string().min(1).refine(isNonblank),
});
export const noneSecretSchema = z.strictObject({});
export const secretSchemas: Readonly<Record<SecretShape, z.ZodType>> = {
  [SecretShape.ApiKey]: apiKeySecretSchema,
  [SecretShape.OAuth]: oauthSecretSchema,
  [SecretShape.S3AccessKey]: s3AccessKeySecretSchema,
  [SecretShape.None]: noneSecretSchema,
};

export type PlatformProbe = (
  secret: unknown,
  metadata: unknown,
  context: Context,
  observe?: ResourceObserver,
) => Promise<ResourceStatusValue>;
export type CredentialPlatform = {
  secret_shape: SecretShape;
  login_modes: readonly LoginSessionMode[];
  metadata_schema: z.ZodObject | null;
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
  check_metadata?: (tx: Transaction, revision: MetadataRevision) => void;
};

export const credentialParamsSchema = z.strictObject({
  credential_name: z.string().min(1),
});
export const credentialRevisionParamsSchema = z.strictObject({
  credential_name: z.string().min(1),
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
  expected_revision: z.number().int().positive(),
  secret: z.unknown(),
  metadata: z.unknown().optional(),
});
export const credentialUpdateMetadataBodySchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  metadata: z.unknown(),
});
export const credentialListQuerySchema = z.strictObject({
  platform: z.string().optional(),
  include_archived: z.enum(["true", "false"]).default("false").optional(),
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
  created_at: z.number().int(),
  ended_at: z.number().int().nullable(),
});
export const credentialAnswerSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
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
});
export type CredentialCheckAnswer = z.infer<typeof credentialCheckAnswerSchema>;
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
      secret_shape: entry.secret_shape,
      login_modes: [...entry.login_modes],
      metadata_fields:
        entry.metadata_schema === null
          ? []
          : Object.entries(entry.metadata_schema.shape)
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
  verify(
    set: CredentialPlatformSet,
    credentialName: string,
    context: Context,
  ): Promise<CredentialCheckAnswer>;
  credentialMetadata(
    tx: Transaction,
    credentialName: string,
  ): CredentialMetadata | null;
}
