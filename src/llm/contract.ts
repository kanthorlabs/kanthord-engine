import { z } from "zod";
import {
  CREATE_MAX_BODY_BYTES,
  CREDENTIAL_TIMEOUT_MS,
  credentialAnswerSchema,
  credentialCheckAnswerSchema,
  credentialCheckBodySchema,
  credentialListAnswerSchema,
  credentialListQuerySchema,
  credentialParamsSchema,
  credentialPlatformListAnswerSchema,
  credentialRevisionParamsSchema,
  credentialUpdateMetadataBodySchema,
  LoginSessionMode,
  METADATA_MAX_BODY_BYTES,
} from "../custody/contract.ts";
import { sealedObjectSchema } from "../kernel/hpke.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { ProviderFailure } from "../scheduler/contract.ts";

export const LLM_COMPONENT_NAME = "llm";

export const LlmErrorCode = {
  Stopped: "llm.lifecycle.stopped",
  BaseUrlFixed: "llm.metadata.base_url_fixed",
  ModelInUse: "llm.metadata.model_in_use",
  ProviderInvalidInput: "llm.provider.invalid_input",
  ProviderCheckUnsupported: "llm.provider.check_unsupported",
  ProviderCredentialNotFound: "llm.provider.credential_not_found",
  ModelCredentialNotFound: "llm.model.credential_not_found",
  ModelUnknown: "llm.model.model_unknown",
  ModelReasoningUnsupported: "llm.model.reasoning_unsupported",
  InstanceUnknown: "llm.credential.instance_unknown",
  InstanceForbidden: "llm.credential.instance_forbidden",
} as const;

export const PROVIDER_CHECK_TIMEOUT_MS = 10000;
export const MODEL_CHECK_OPERATION_TIMEOUT_MS = 60000;
export const MODEL_CHECK_TIMEOUT_MS = 50000;

export type AgentEnablement = { agent_name: string };
export type EnablementsDependentOnModelFn = (
  tx: Transaction,
  credentialName: string,
  modelId: string,
) => AgentEnablement[];

const emptyParams = z.strictObject({});
const emptyQuery = z.strictObject({});
const sessionParams = z.strictObject({ session_id: z.string().min(1) });
const holderSchema = z.string().min(1);
const holderQuery = z.strictObject({ holder: holderSchema.optional() });
export const llmCredentialCreateSchema = z.strictObject({
  name: z.string(),
  platform: z.string(),
  metadata: z.unknown(),
  secret: z.unknown().optional(),
  holders: z.array(holderSchema).min(1).optional(),
  holder: holderSchema.optional(),
  sealed: z.unknown().optional(),
  sealed_to: z.string().optional(),
});
export const llmCredentialRotateSchema = z.strictObject({
  expected_revision: z.number().int().positive(),
  secret: z.unknown().optional(),
  metadata: z.unknown().optional(),
  holder: holderSchema.optional(),
  sealed: z.unknown().optional(),
  sealed_to: z.string().optional(),
});
export const InstanceLoginState = {
  Pending: "pending",
  Completed: "completed",
  Failed: "failed",
} as const;
export type InstanceLoginState =
  (typeof InstanceLoginState)[keyof typeof InstanceLoginState];
export const INSTANCE_LOGIN_MODES = [
  LoginSessionMode.CopyCode,
  LoginSessionMode.Device,
] as const;
export const loginSessionEntrySchema = z.strictObject({
  session_id: z.string().min(1),
  name: z.string().min(1),
  platform: z.string().min(1),
  mode: z.enum(INSTANCE_LOGIN_MODES),
  code: z.string().nullable(),
});
export type LoginSessionEntry = z.infer<typeof loginSessionEntrySchema>;
export const loginReportBodySchema = z.strictObject({
  state: z.enum(InstanceLoginState),
  address: z.string().nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
  failure_reason: z.string().nullable(),
  sealed: sealedObjectSchema.optional(),
  sealed_to: z.string().optional(),
});
export type LoginReportBody = z.infer<typeof loginReportBodySchema>;
export type LlmCredentialCreate = z.infer<typeof llmCredentialCreateSchema>;
export type LlmCredentialRotate = z.infer<typeof llmCredentialRotateSchema>;

export const llmCredentialAnswerSchema = credentialAnswerSchema.extend({
  agent_providers: z.array(
    z.strictObject({ agent: z.string(), name: z.string() }),
  ),
});
export type LlmCredentialAnswer = z.infer<typeof llmCredentialAnswerSchema>;
const loginAnswerSchema = z.strictObject({
  session_id: z.string(),
  address: z.string(),
  code: z.string().nullable(),
  expires_at: z.number().int(),
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
        owned_by: z.string().nullable(),
        created: z.number().int().nullable(),
      }),
    )
    .nullable(),
});
export type ProviderCheckAnswer = z.infer<typeof providerCheckAnswerSchema>;
export const modelCheckBodySchema = z.strictObject({
  credential: z.string().min(1),
  model_identifier: z.string().min(1),
  reasoning_effort: z.string().min(1),
});
export const ModelCheckResult = {
  Ok: "ok",
  ...ProviderFailure,
} as const;
export type ModelCheckResult =
  (typeof ModelCheckResult)[keyof typeof ModelCheckResult];
export const modelCheckAnswerSchema = z.strictObject({
  result: z.enum(ModelCheckResult),
  message: z.string().nullable(),
});
export type ModelCheckAnswer = z.infer<typeof modelCheckAnswerSchema>;
const loginCodeAnswerSchema = z.strictObject({ session_id: z.string() });
const loginStatusAnswerSchema = z.strictObject({
  session_id: z.string(),
  state: z.string(),
  last_message: z.string().nullable(),
  failure_reason: z.string().nullable(),
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
    access: AccessPolicy.HumanOrWorker,
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
      body: llmCredentialCreateSchema,
    }),
    output: credentialAnswerSchema,
    description:
      "Create an LLM credential with the first revision of each copy. A human sends the secret and the holders, and the server seals each instance copy to the current key of its instance. A worker instance sends one copy sealed to its own key.",
  },
  list: {
    id: "llm.credential.list",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/llm/credential",
    access: AccessPolicy.HumanOrWorker,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: credentialListQuerySchema.extend({
        holder: holderSchema.optional(),
      }),
      body: z.null(),
    }),
    output: credentialListAnswerSchema,
    description:
      "List the copies of LLM credentials with optional platform and holder filtering and pagination. A worker instance lists only its own copies.",
  },
  get: {
    id: "llm.credential.get",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/llm/credential/:credential_name",
    access: AccessPolicy.HumanOrWorker,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: holderQuery,
      body: z.null(),
    }),
    output: llmCredentialAnswerSchema,
    description:
      "Get one copy of an LLM credential, all its revisions and the agent providers that name it. The holder defaults to server for a human and to the instance of a worker token.",
  },
  rotate: {
    id: "llm.credential.rotate",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credential_name/revision",
    access: AccessPolicy.HumanOrWorker,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: CREATE_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: holderQuery,
      body: llmCredentialRotateSchema,
    }),
    output: credentialAnswerSchema,
    description:
      "Rotate one copy of an LLM credential into a new revision. A human sends the secret and names the holder in the query, which defaults to server. A worker instance sends its own copy sealed to its own key.",
  },
  update_metadata: {
    id: "llm.credential.update_metadata",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Put,
    path: "/api/llm/credential/:credential_name/metadata",
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
      query: holderQuery,
      body: credentialUpdateMetadataBodySchema,
    }),
    output: credentialAnswerSchema,
    description:
      "Update the metadata of one copy of an LLM credential in a new revision. The holder defaults to server.",
  },
  revoke: {
    id: "llm.credential.revoke",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credential_name/revision/:revision/revoke",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialRevisionParamsSchema,
      query: holderQuery,
      body: z.null(),
    }),
    output: credentialAnswerSchema,
    description:
      "End an older revision of one copy of an LLM credential. The holder defaults to server.",
  },
  archive: {
    id: "llm.credential.archive",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/:credential_name/archive",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: holderQuery,
      body: z.null(),
    }),
    output: credentialAnswerSchema,
    description:
      "Archive one copy of an LLM credential that no dependent names. The holder defaults to server.",
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
    path: "/api/llm/credential/:credential_name/verify",
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
        holder: holderSchema.optional(),
      }),
    }),
    output: loginAnswerSchema,
    description:
      "Start an OAuth credential login session. The holder defaults to server. A login of a worker instance runs on that instance in copy_code or device mode.",
  },
  login_code: {
    id: "llm.credential.login_code",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/login/:session_id/code",
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
    path: "/api/llm/credential/login/:session_id",
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
  login_report: {
    id: "llm.credential.login_report",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/credential/login/:session_id/report",
    access: AccessPolicy.Worker,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: CREATE_MAX_BODY_BYTES,
    status: HttpStatus.NoContent,
    input: z.strictObject({
      params: sessionParams,
      query: emptyQuery,
      body: loginReportBodySchema,
    }),
    output: z.null(),
    description:
      "Report the state of an OAuth login session that runs on the worker instance of the token. The completed report carries the credential sealed to the instance key, and the server stores revision 1 of the copy of that instance.",
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
  model_check: {
    id: "llm.model.check",
    service: LLM_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/llm/model/check",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: MODEL_CHECK_OPERATION_TIMEOUT_MS,
    mutation: false,
    body: true,
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: modelCheckBodySchema,
    }),
    output: modelCheckAnswerSchema,
    description:
      "Check one tool round trip of a model and a reasoning effort through an LLM credential.",
  },
} as const satisfies Record<string, Operation>;
