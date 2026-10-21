import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import { sealedObjectSchema, type SealedObject } from "../kernel/hpke.ts";
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
  resourceFailureReasonSchema,
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
export { SERVER_HOLDER } from "../kernel/holder.ts";
export const CREDENTIAL_SEAL_INFO = "kanthord/credential/v1";
export const SEALED_PLAINTEXT_MAX_BYTES = 32768;
export const SEALED_CIPHERTEXT_MAX_BYTES = 32784;
export const credentialSealedToSchema = z
  .string()
  .regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
export type CredentialSealAad = {
  name: string;
  platform: string;
  holder: string;
  sealed_to: string;
};
export function credentialSealAad(value: CredentialSealAad): string {
  return canonicalJSON({
    name: value.name,
    platform: value.platform,
    holder: value.holder,
    sealed_to: value.sealed_to,
  });
}
const handoverItemSchema = z.strictObject({
  credential_id: identitySchema("credential"),
  provider_id: z.string().min(1),
  credential: piCredentialSchema,
});
export const sealedHandoverItemSchema = z.strictObject({
  credential_id: identitySchema("credential"),
  provider_id: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  sealed: sealedObjectSchema,
});
export type SealedHandoverItem = z.infer<typeof sealedHandoverItemSchema>;
export const handoverItemsSchema = z.strictObject({
  items: z.array(handoverItemSchema),
});
export const refreshReportSchema = z.strictObject({
  credential_id: identitySchema("credential"),
  digest: z.string().regex(SHA256_HEX_PATTERN),
  credential: piCredentialSchema,
});
export const sealedRefreshReportSchema = z.strictObject({
  credential_id: identitySchema("credential"),
  digest: z.string().regex(SHA256_HEX_PATTERN),
  sealed: sealedObjectSchema,
});
export const wireReportSchema = z.union([
  refreshReportSchema,
  sealedRefreshReportSchema,
]);
export type HandoverItems = z.infer<typeof handoverItemsSchema>;
export type RefreshReport = z.infer<typeof refreshReportSchema>;
export type SealedRefreshReport = z.infer<typeof sealedRefreshReportSchema>;
export type WireReport = z.infer<typeof wireReportSchema>;

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
  configuration: { base_branch: string; landing: "human" | "kanthord" };
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
  merge_address: PullRequestAddressFacts | null;
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
    input: {
      key: string;
      commit: string;
      reusedEvidenceId: string | null;
      mergeEvidenceId: string | null;
    },
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
  SshIdentity: "ssh_identity",
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
export const SshIdentitySubjectKind = {
  Binding: "binding",
  Draft: "draft",
  RequestEvidence: "request_evidence",
} as const;
export type SshIdentitySubject =
  | { kind: typeof SshIdentitySubjectKind.Binding; binding_id: string }
  | {
      kind: typeof SshIdentitySubjectKind.RequestEvidence;
      evidence_id: string;
    }
  | {
      kind: typeof SshIdentitySubjectKind.Draft;
      project_id: string;
      credential: string;
      address: string;
    };
export type SshIdentityFacts = {
  binding_id: string | null;
  address: string;
};
export type SshSignatureOf = (
  tx: Transaction,
  granted: GrantFacts<GrantOf<typeof GrantKind.SshIdentity>>,
  material: Material,
  data: Buffer,
) => Buffer;
export type SshAccessOf = (
  tx: Transaction,
  granted: GrantFacts<GrantOf<typeof GrantKind.SshIdentity>>,
  material: Material,
) => { private_key: string };
export interface SshIdentityAuthorization {
  sshIdentity(
    tx: Transaction,
    identity: CallerIdentity,
    subject: SshIdentitySubject,
    claim: ExecutionClaim | null,
  ): Authorized<SshIdentityFacts>;
}
export type GrantRequest =
  | {
      kind: typeof GrantKind.FrozenAction;
      identity: MachineIdentity;
      claim: ExecutionClaim;
      key: string;
      commit: string;
      reusedEvidenceId: string | null;
      mergeEvidenceId?: string | null;
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
    }
  | {
      kind: typeof GrantKind.SshIdentity;
      identity: CallerIdentity;
      subject: SshIdentitySubject;
      claim: ExecutionClaim | null;
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
  [GrantKind.SshIdentity]: SshIdentityFacts;
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
export type BindingsListingInstanceFn = (
  tx: Transaction,
  instanceName: string,
  credentialName: string,
) => BindingRevision[];
export type InboundsNamingFn = (
  tx: Transaction,
  credentialName: string,
) => InboundDependent[];

const EMPTY_STRING_LENGTH = 0;
const STRING_FIELD_TYPE = "string";
const ARMOR_LINES_MIN = 2;

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
const OPENSSH_ARMOR_LABEL = "OPENSSH PRIVATE KEY";
const OPENSSH_ARMOR_BEGIN = `-----BEGIN ${OPENSSH_ARMOR_LABEL}-----`;
const OPENSSH_ARMOR_END = `-----END ${OPENSSH_ARMOR_LABEL}-----`;
export const SSH_KEY_TEXT_BYTES_MAX = 4096;
export const sshKeySecretSchema = z.strictObject({
  private_key: z
    .string()
    .refine((text) => Buffer.byteLength(text, "utf8") <= SSH_KEY_TEXT_BYTES_MAX)
    .refine((text) => {
      const lines = text.trim().split("\n");
      return (
        lines.length > ARMOR_LINES_MIN &&
        lines[0] === OPENSSH_ARMOR_BEGIN &&
        lines.at(-1) === OPENSSH_ARMOR_END
      );
    }),
});
export const handoverPayloadSchema = z.strictObject({
  items: z.array(z.union([handoverItemSchema, sealedHandoverItemSchema])),
  ssh_identities: z.array(
    z.strictObject({
      binding_id: identitySchema("binding"),
      credential_id: identitySchema("credential"),
      private_key: sshKeySecretSchema.shape.private_key,
    }),
  ),
});
export type HandoverPayload = z.infer<typeof handoverPayloadSchema>;
export const plainHandoverPayloadSchema = handoverItemsSchema.extend({
  ssh_identities: handoverPayloadSchema.shape.ssh_identities,
});
export const HandoverPlacement = {
  Server: "server",
  Container: "container",
  Worker: "worker",
} as const;
export type HandoverPlacement =
  (typeof HandoverPlacement)[keyof typeof HandoverPlacement];
export const HolderRefusal = {
  ServerHeld: "server_held",
  HeldElsewhere: "held_elsewhere",
} as const;
export type HolderRefusal = (typeof HolderRefusal)[keyof typeof HolderRefusal];
export type HandoverSshIdentity = HandoverPayload["ssh_identities"][number];
export const SSH_SIGN_FLAGS_MAX = 0xffffffff;
export const SSH_SIGN_DATA_BYTES_MAX = 8192;
const base64Schema = z.base64().min(1);
export const sshSignRequestSchema = z.strictObject({
  binding_id: identitySchema("binding"),
  data: base64Schema.refine(
    (text) => Buffer.from(text, "base64").length <= SSH_SIGN_DATA_BYTES_MAX,
  ),
  flags: z.number().int().min(0).max(SSH_SIGN_FLAGS_MAX),
});
export type SshSignRequest = z.infer<typeof sshSignRequestSchema>;
export const sshSignAnswerSchema = z.strictObject({ signature: base64Schema });
export type SshSignAnswer = z.infer<typeof sshSignAnswerSchema>;
export const sshPublicKeyMetadataSchema = z.object({
  public_key: z.string().min(1),
});
export const secretSchemas: Readonly<Record<SecretShape, z.ZodType>> = {
  [SecretShape.ApiKey]: apiKeySecretSchema,
  [SecretShape.OAuth]: oauthSecretSchema,
  [SecretShape.S3AccessKey]: s3AccessKeySecretSchema,
  [SecretShape.SshKey]: sshKeySecretSchema,
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
  holder: string;
  change: RevisionChange;
  current: Record<string, unknown> | null;
  next: Record<string, unknown> | null;
};
export type CredentialPlatformSet = {
  platforms: CredentialPlatforms;
  instance_copies?: boolean;
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

export type GeneratedRevision = {
  secret: unknown;
  metadata: Record<string, unknown>;
};
export type GeneratedCreate = {
  name: string;
  platform: string;
  generate: (name: string) => GeneratedRevision;
};
export type GeneratedRotate = {
  expected_revision: number;
  generate: (name: string) => GeneratedRevision;
};

export type CredentialHold = { available_at: number; strikes: number };

export type CredentialHoldItem = CredentialHold & {
  credential: string;
  holder: string;
};

export interface CredentialHolds {
  holdOf(tx: Transaction, name: string, holder: string): CredentialHold | null;
  hold(
    tx: Transaction,
    name: string,
    holder: string,
    availableAt: number,
    strikes: number,
  ): void;
  release(tx: Transaction, name: string, holder: string): boolean;
  listHolds(tx: Transaction): CredentialHoldItem[];
}

export type InstanceKey = {
  name: string;
  public_key: string;
  fingerprint: string;
};
export interface InstanceKeys {
  keyOf(tx: Transaction, name: string): InstanceKey | null;
  nameOf(tx: Transaction, instanceId: string): string | null;
}
export type SealedCopy = {
  holder: string;
  sealed: SealedObject;
  sealed_to: string;
};
export type CredentialCopy = { holder: string; secret: unknown } | SealedCopy;
export type CredentialEntry = {
  name: string;
  platform: string;
  metadata: unknown;
  copies: CredentialCopy[];
};
export type SealedRotateBody = {
  expected_revision: number;
  sealed: SealedObject;
  sealed_to: string;
  metadata?: unknown;
};
export type HeldCopy = {
  name: string;
  revision: number;
  platform: string;
  sealed_current: boolean;
};
export const sealedCopyAnswerSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  revision: z.number().int().positive(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  sealed: sealedObjectSchema,
});
export type SealedCopyAnswer = z.infer<typeof sealedCopyAnswerSchema>;

export interface CredentialRecords {
  create(
    tx: Transaction,
    set: CredentialPlatformSet,
    body: CredentialCreate,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  createCopies(
    tx: Transaction,
    set: CredentialPlatformSet,
    entry: CredentialEntry,
    humanIdentity: string | undefined,
  ): CredentialAnswer[];
  sealCopies(
    set: CredentialPlatformSet,
    input: {
      name: string;
      platform: string;
      secret: unknown;
      keys: readonly InstanceKey[];
    },
  ): Promise<SealedCopy[]>;
  list(
    tx: Transaction,
    set: CredentialPlatformSet,
    query: CredentialListQuery & { holder?: string },
  ): CredentialListAnswer;
  copyPlatform(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
  ): string;
  get(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder?: string,
  ): CredentialAnswer;
  rotate(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialRotateBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  rotateSealed(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
    body: SealedRotateBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  updateMetadata(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialUpdateMetadataBody,
    humanIdentity: string | undefined,
    holder?: string,
  ): CredentialAnswer;
  revoke(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    revision: number,
    holder?: string,
  ): CredentialAnswer;
  archive(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder?: string,
  ): CredentialAnswer;
  requireAvailableName(tx: Transaction, name: string, holder?: string): void;
  requireLoginTarget(tx: Transaction, name: string, holder: string): void;
  createLoginRevision(
    tx: Transaction,
    set: CredentialPlatformSet,
    name: string,
    platform: string,
    copy: CredentialCopy,
    now: number,
  ): string;
  createGenerated(
    tx: Transaction,
    set: CredentialPlatformSet,
    body: GeneratedCreate,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
  rotateGenerated(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: GeneratedRotate,
    humanIdentity: string | undefined,
  ): CredentialAnswer;
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
    holder?: string,
  ): CredentialMetadata | null;
  copiesMetadata(tx: Transaction, credentialName: string): CredentialMetadata[];
  copyHeld(tx: Transaction, credentialName: string, holder: string): boolean;
  heldCopy(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
  ): HeldCopy | null;
  sealedCopy(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
  ): SealedCopyAnswer;
}
