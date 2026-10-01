import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
import type { MachineIdentity } from "../kernel/caller.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";

export const SecretShape = {
  ApiKey: "api_key",
  OAuth: "oauth",
  S3AccessKey: "s3_access_key",
} as const;
export type SecretShape = (typeof SecretShape)[keyof typeof SecretShape];
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const piCredentialSchema = z.discriminatedUnion("type", [
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
]);
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
export const CREDENTIAL_OPERATION_SERVICE = "credential";
export const CREDENTIAL_TIMEOUT_MS = 30000;
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
export type AgentEnablement = { agentName: string };
export type AgentProvidersDependentOnFn = (
  tx: Transaction,
  credentialName: string,
) => AgentProviderDependent[];
export type BindingsNamingFn = (
  tx: Transaction,
  credentialName: string,
) => BindingRevision[];
export type EnablementsDependentOnModelFn = (
  tx: Transaction,
  credentialName: string,
  modelId: string,
) => AgentEnablement[];

const emptyParams = z.strictObject({});
const emptyQuery = z.strictObject({});
const credentialParams = z.strictObject({ credentialName: z.string().min(1) });
const sessionParams = z.strictObject({ sessionId: z.string().min(1) });

export const credentialCreateSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  metadata: z.unknown(),
  secret: z.unknown(),
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
export type CredentialRevisionAnswer = z.infer<
  typeof credentialRevisionAnswerSchema
>;
export type CredentialAnswer = z.infer<typeof credentialAnswerSchema>;

const credentialListAnswerSchema = z.strictObject({
  items: z.array(credentialAnswerSchema),
  nextCursor: z.string().nullable(),
});
const loginAnswerSchema = z.strictObject({
  sessionId: z.string(),
  address: z.string(),
  code: z.string().nullable(),
  expiresAt: z.number().int(),
});
const loginCodeAnswerSchema = z.strictObject({ sessionId: z.string() });
const loginStatusAnswerSchema = z.strictObject({
  sessionId: z.string(),
  state: z.string(),
  lastMessage: z.string().nullable(),
  failureReason: z.string().nullable(),
});

export const custodyOperations = {
  create: {
    id: "credential.create",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Post,
    path: "/api/credential",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: CREATE_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: credentialCreateSchema,
    }),
    output: credentialAnswerSchema,
    description: "Create a credential with its first revision.",
  },
  list: {
    id: "credential.list",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Get,
    path: "/api/credential",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: z.strictObject({
        platform: z.string().optional(),
        limit: z.coerce
          .number()
          .int()
          .positive()
          .max(LIST_LIMIT_MAX)
          .optional(),
        cursor: z.string().min(1).optional(),
      }),
      body: z.null(),
    }),
    output: credentialListAnswerSchema,
    description:
      "List credentials with optional platform filtering and pagination.",
  },
  get: {
    id: "credential.get",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Get,
    path: "/api/credential/:credentialName",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParams,
      query: emptyQuery,
      body: z.null(),
    }),
    output: credentialAnswerSchema,
    description: "Get a credential and all its revisions.",
  },
  rotate: {
    id: "credential.rotate",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Post,
    path: "/api/credential/:credentialName/revision",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: CREATE_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParams,
      query: emptyQuery,
      body: credentialRotateBodySchema,
    }),
    output: credentialAnswerSchema,
    description: "Rotate a credential secret into a new revision.",
  },
  update_metadata: {
    id: "credential.update_metadata",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Put,
    path: "/api/credential/:credentialName/metadata",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParams,
      query: emptyQuery,
      body: credentialUpdateMetadataBodySchema,
    }),
    output: credentialAnswerSchema,
    description: "Update credential metadata in a new revision.",
  },
  revoke: {
    id: "credential.revoke",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Post,
    path: "/api/credential/:credentialName/revision/:revision/revoke",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: z.strictObject({
        credentialName: z.string().min(1),
        revision: z.coerce.number().int().positive(),
      }),
      query: emptyQuery,
      body: z.null(),
    }),
    output: credentialAnswerSchema,
    description: "End an older credential revision.",
  },
  login: {
    id: "credential.login",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Post,
    path: "/api/credential/login",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: z.strictObject({
        platform: z.string(),
        name: z.string(),
        mode: z.string().optional(),
      }),
    }),
    output: loginAnswerSchema,
    description: "Start an OAuth credential login session.",
  },
  login_code: {
    id: "credential.login_code",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Post,
    path: "/api/credential/login/:sessionId/code",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: sessionParams,
      query: emptyQuery,
      body: z.strictObject({ value: z.string().min(1) }),
    }),
    output: loginCodeAnswerSchema,
    description: "Supply a requested OAuth login code.",
  },
  login_status: {
    id: "credential.login_status",
    service: CREDENTIAL_OPERATION_SERVICE,
    method: HttpMethod.Get,
    path: "/api/credential/login/:sessionId",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: sessionParams,
      query: emptyQuery,
      body: z.null(),
    }),
    output: loginStatusAnswerSchema,
    description: "Read the state of an OAuth login session.",
  },
} as const satisfies Record<string, Operation>;
