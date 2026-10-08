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

export const REPOSITORY_COMPONENT_NAME = "repository";
export const SSH_RESOLVE_FAILED_STATUS = 422;
export const SSH_CONFIG_UNREADABLE_STATUS = 422;

export const RepositoryFileState = {
  Present: "present",
  Absent: "absent",
  NotRegularFile: "not_regular_file",
  OutsideRoot: "outside_root",
  Unreadable: "unreadable",
} as const;
export type RepositoryFileState =
  (typeof RepositoryFileState)[keyof typeof RepositoryFileState];
export type RepositoryFile = {
  path: string;
  state: RepositoryFileState;
  text: string | null;
};

const emptyParams = z.strictObject({});
const emptyQuery = z.strictObject({});

export const repositoryCredentialAnswerSchema = credentialAnswerSchema.extend({
  bindings: z.array(
    z.strictObject({
      project_id: z.string(),
      project_name: z.string(),
      binding_id: z.string(),
      name: z.string(),
    }),
  ),
});
export type RepositoryCredentialAnswer = z.infer<
  typeof repositoryCredentialAnswerSchema
>;

export const SshDiscoverState = {
  Ready: "ready",
  Refused: "refused",
  Present: "present",
} as const;
export type SshDiscoverState =
  (typeof SshDiscoverState)[keyof typeof SshDiscoverState];

export const sshDiscoverAnswerSchema = z.strictObject({
  items: z.array(
    z.strictObject({
      host: z.string(),
      hostname: z.string(),
      port: z.number().int(),
      identity_file: z.string().nullable(),
      state: z.enum(SshDiscoverState),
      reason: z.string().nullable(),
    }),
  ),
});
export type SshDiscoverAnswer = z.infer<typeof sshDiscoverAnswerSchema>;

export const repositoryOperations = {
  platform_list: {
    id: "repository.credential.platform_list",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/repository/credential/platform",
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
    description: "List the repository credential platforms.",
  },
  create: {
    id: "repository.credential.create",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential",
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
    errors: [SSH_RESOLVE_FAILED_STATUS],
    description: "Create a repository credential with its first revision.",
  },
  list: {
    id: "repository.credential.list",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/repository/credential",
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
      "List repository credentials with optional platform filtering and pagination.",
  },
  get: {
    id: "repository.credential.get",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/repository/credential/:credential_name",
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
    output: repositoryCredentialAnswerSchema,
    description:
      "Get a repository credential, all its revisions and the bindings that name it.",
  },
  rotate: {
    id: "repository.credential.rotate",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/:credential_name/revision",
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
    errors: [SSH_RESOLVE_FAILED_STATUS],
    description: "Rotate a repository credential secret into a new revision.",
  },
  update_metadata: {
    id: "repository.credential.update_metadata",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Put,
    path: "/api/repository/credential/:credential_name/metadata",
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
    errors: [SSH_RESOLVE_FAILED_STATUS],
    description: "Update repository credential metadata in a new revision.",
  },
  revoke: {
    id: "repository.credential.revoke",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/:credential_name/revision/:revision/revoke",
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
    description: "End an older repository credential revision.",
  },
  archive: {
    id: "repository.credential.archive",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/:credential_name/archive",
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
    description: "Archive a repository credential that no dependent names.",
  },
  check: {
    id: "repository.credential.check",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/check",
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
    description:
      "Check a typed repository credential secret before it is saved.",
  },
  verify: {
    id: "repository.credential.verify",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/:credential_name/verify",
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
    description: "Verify one stored repository credential record.",
  },
  ssh_discover: {
    id: "repository.credential.ssh_discover",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/repository/credential/ssh/discover",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    errors: [SSH_CONFIG_UNREADABLE_STATUS],
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: z.null(),
    }),
    output: sshDiscoverAnswerSchema,
    description:
      "List the SSH aliases of ~/.ssh/config that resolve to a git platform host.",
  },
} as const satisfies Record<string, Operation>;
