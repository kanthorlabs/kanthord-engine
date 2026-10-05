import { z } from "zod";
import {
  CREATE_MAX_BODY_BYTES,
  CREDENTIAL_TIMEOUT_MS,
  credentialAnswerSchema,
  credentialCheckAnswerSchema,
  credentialCheckBodySchema,
  credentialCreateSchema,
  credentialListAnswerSchema,
  credentialListQuerySchema,
  credentialParamsSchema,
  credentialPlatformListAnswerSchema,
  credentialRevisionParamsSchema,
  credentialRotateBodySchema,
  credentialUpdateMetadataBodySchema,
  METADATA_MAX_BODY_BYTES,
} from "../custody/contract.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";

export const LLM_COMPONENT_NAME = "llm";

export const LlmErrorCode = {
  Stopped: "llm.lifecycle.stopped",
  BaseUrlFixed: "llm.metadata.base_url_fixed",
  ModelInUse: "llm.metadata.model_in_use",
  ProviderInvalidInput: "llm.provider.invalid_input",
  ProviderCheckUnsupported: "llm.provider.check_unsupported",
  ProviderCredentialNotFound: "llm.provider.credential_not_found",
} as const;

export const PROVIDER_CHECK_TIMEOUT_MS = 10000;

export type AgentEnablement = { agentName: string };
export type EnablementsDependentOnModelFn = (
  tx: Transaction,
  credentialName: string,
  modelId: string,
) => AgentEnablement[];

const emptyParams = z.strictObject({});
const emptyQuery = z.strictObject({});
const sessionParams = z.strictObject({ sessionId: z.string().min(1) });

export const llmCredentialAnswerSchema = credentialAnswerSchema.extend({
  agentProviders: z.array(
    z.strictObject({ agent: z.string(), name: z.string() }),
  ),
});
export type LlmCredentialAnswer = z.infer<typeof llmCredentialAnswerSchema>;
const loginAnswerSchema = z.strictObject({
  sessionId: z.string(),
  address: z.string(),
  code: z.string().nullable(),
  expiresAt: z.number().int(),
});
export const providerCheckBodySchema = z.strictObject({
  credential: z.string().min(1),
});
export const Connection = {
  Ok: "ok",
  Unauthorized: "unauthorized",
  Unreachable: "unreachable",
  InvalidResponse: "invalid_response",
} as const;
export type Connection = (typeof Connection)[keyof typeof Connection];
export const providerCheckAnswerSchema = z.strictObject({
  connection: z.enum(Connection),
  models: z
    .array(
      z.strictObject({
        id: z.string(),
        ownedBy: z.string().nullable(),
        created: z.number().int().nullable(),
      }),
    )
    .nullable(),
});
export type ProviderCheckAnswer = z.infer<typeof providerCheckAnswerSchema>;
const loginCodeAnswerSchema = z.strictObject({ sessionId: z.string() });
const loginStatusAnswerSchema = z.strictObject({
  sessionId: z.string(),
  state: z.string(),
  lastMessage: z.string().nullable(),
  failureReason: z.string().nullable(),
});

export const llmOperations = {
  platform_list: {
    id: "llm.credential.platform_list",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/llm/credential/platform",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: z.null(),
    }),
    output: credentialPlatformListAnswerSchema,
    description: "List the LLM credential platforms.",
  },
  create: {
    id: "llm.credential.create",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential",
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
    description: "Create an LLM credential with its first revision.",
  },
  list: {
    id: "llm.credential.list",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/llm/credential",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: credentialListQuerySchema,
      body: z.null(),
    }),
    output: credentialListAnswerSchema,
    description:
      "List LLM credentials with optional platform filtering and pagination.",
  },
  get: {
    id: "llm.credential.get",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/llm/credential/:credentialName",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyQuery,
      body: z.null(),
    }),
    output: llmCredentialAnswerSchema,
    description:
      "Get an LLM credential, all its revisions and the agent providers that name it.",
  },
  rotate: {
    id: "llm.credential.rotate",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credentialName/revision",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: CREATE_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyQuery,
      body: credentialRotateBodySchema,
    }),
    output: credentialAnswerSchema,
    description: "Rotate an LLM credential secret into a new revision.",
  },
  update_metadata: {
    id: "llm.credential.update_metadata",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Put,
    path: "/api/llm/credential/:credentialName/metadata",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyQuery,
      body: credentialUpdateMetadataBodySchema,
    }),
    output: credentialAnswerSchema,
    description: "Update LLM credential metadata in a new revision.",
  },
  revoke: {
    id: "llm.credential.revoke",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credentialName/revision/:revision/revoke",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialRevisionParamsSchema,
      query: emptyQuery,
      body: z.null(),
    }),
    output: credentialAnswerSchema,
    description: "End an older LLM credential revision.",
  },
  archive: {
    id: "llm.credential.archive",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credentialName/archive",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyQuery,
      body: z.null(),
    }),
    output: credentialAnswerSchema,
    description: "Archive an LLM credential that no dependent names.",
  },
  check: {
    id: "llm.credential.check",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/check",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: true,
    maxBodyBytes: CREATE_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: credentialCheckBodySchema,
    }),
    output: credentialCheckAnswerSchema,
    description: "Check a typed LLM credential secret before it is saved.",
  },
  verify: {
    id: "llm.credential.verify",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credentialName/verify",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyQuery,
      body: z.null(),
    }),
    output: credentialCheckAnswerSchema,
    description: "Verify one stored llm credential record.",
  },
  login: {
    id: "llm.credential.login",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/login",
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
    id: "llm.credential.login_code",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/login/:sessionId/code",
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
    id: "llm.credential.login_status",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/llm/credential/login/:sessionId",
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
  provider_check: {
    id: "llm.provider.check",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/provider/check",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: true,
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: z.unknown(),
    }),
    output: providerCheckAnswerSchema,
    description:
      "Check the connection of an LLM credential through its LLM provider and read its model list when the check reads one.",
  },
} as const satisfies Record<string, Operation>;
