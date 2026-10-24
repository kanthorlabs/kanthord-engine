import { z } from "zod";
import {
  CREATE_MAX_BODY_BYTES,
  CREDENTIAL_TIMEOUT_MS,
  LIST_LIMIT_MAX,
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
import type { Context } from "../kernel/context.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";

export const REPOSITORY_COMPONENT_NAME = "repository";
export const HOST_KEY_SCAN_FAILED_STATUS = 422;
export const SSH_AGENT_CLEANUP_TIMEOUT_MS = 5000;
export const HOST_KEY_FINGERPRINT_PATTERN = /^SHA256:[A-Za-z0-9+/]{43}$/;

export const HostKeySource = {
  GitHubMeta: "github_meta",
  Keyscan: "keyscan",
} as const;
export type HostKeySource = (typeof HostKeySource)[keyof typeof HostKeySource];

export const RepositoryErrorCode = {
  SshKeyLegacy: "repository.credential.ssh_key_legacy",
} as const;

export const SSH_SIGN_USER = "git";
export const SshSignErrorCode = {
  Refused: "worker.ssh.sign_refused",
} as const;
export const SshSignRefusal = {
  NotUserAuthentication: "not_user_authentication",
  KeyMismatch: "key_mismatch",
  HostKeyMismatch: "host_key_mismatch",
} as const;
export type SshSignRefusal =
  (typeof SshSignRefusal)[keyof typeof SshSignRefusal];

export const HostKeyErrorCode = {
  HostUnsupported: "repository.host_key.host_unsupported",
  ScanFailed: "repository.host_key.scan_failed",
  Changed: "repository.host_key.changed",
  Unpinned: "repository.host_key.unpinned",
} as const;

export interface SshKeyAccess {
  private_key: string;
  public_key: string;
  known_hosts: string;
  port: number;
}

export type SshSigner = (
  data: Buffer,
  flags: number,
  context: Context,
) => Promise<Buffer>;

export interface SshRelayAccess {
  relay: SshSigner;
  public_key: string;
  known_hosts: string;
  port: number;
}

export type SshAccess = SshKeyAccess | SshRelayAccess;

export const RepositoryFileState = {
  Present: "present",
  Absent: "absent",
  NotRegularFile: "not_regular_file",
  OutsideRoot: "outside_root",
  Unreadable: "unreadable",
  TooLarge: "too_large",
  NotUtf8: "not_utf8",
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

export const hostKeyScanAnswerSchema = z.strictObject({
  host: z.string(),
  public_key: z.string(),
  fingerprint: z.string(),
  source: z.enum(HostKeySource),
});
export type HostKeyScanAnswer = z.infer<typeof hostKeyScanAnswerSchema>;
export const hostKeyItemSchema = hostKeyScanAnswerSchema.extend({
  created_at: z.number().int(),
});
export type HostKeyItem = z.infer<typeof hostKeyItemSchema>;
export const hostKeyListQuerySchema = z.strictObject({
  limit: z.coerce.number().int().positive().max(LIST_LIMIT_MAX).optional(),
  cursor: z.string().min(1).optional(),
});
export type HostKeyListQuery = z.infer<typeof hostKeyListQuerySchema>;
export const hostKeyListAnswerSchema = z.strictObject({
  items: z.array(hostKeyItemSchema),
  next_cursor: z.string().nullable(),
});
export type HostKeyListAnswer = z.infer<typeof hostKeyListAnswerSchema>;
const hostKeyParamsSchema = z.strictObject({ host: z.string().min(1) });
const hostKeyScanBodySchema = z.strictObject({ host: z.string().min(1) });
const hostKeyPinBodySchema = z.strictObject({
  fingerprint: z.string().regex(HOST_KEY_FINGERPRINT_PATTERN),
});
const HOST_KEY_MAX_BODY_BYTES = 1024;
const SSH_KEY_MAX_BODY_BYTES = 1024;
const sshKeyCreateBodySchema = z.strictObject({ name: z.string() });
const sshKeyRotateBodySchema = z.strictObject({
  expected_revision: z.number().int().positive(),
});

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
  ssh_key_create: {
    id: "repository.credential.ssh_key_create",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/ssh/key",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: SSH_KEY_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: sshKeyCreateBodySchema,
    }),
    output: credentialAnswerSchema,
    description:
      "Generate an ed25519 SSH key on the server and store it as a new ssh credential.",
  },
  ssh_key_rotate: {
    id: "repository.credential.ssh_key_rotate",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/credential/:credential_name/ssh/key",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: SSH_KEY_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyQuery,
      body: sshKeyRotateBodySchema,
    }),
    output: credentialAnswerSchema,
    description:
      "Generate a new SSH key on the server and store it as the next revision of an ssh credential.",
  },
  host_key_list: {
    id: "repository.host_key.list",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Get,
    path: "/api/repository/host-key",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: false,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: emptyParams,
      query: hostKeyListQuerySchema,
      body: z.null(),
    }),
    output: hostKeyListAnswerSchema,
    description: "List the pinned SSH host keys by host.",
  },
  host_key_scan: {
    id: "repository.host_key.scan",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Post,
    path: "/api/repository/host-key/scan",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: false,
    body: true,
    maxBodyBytes: HOST_KEY_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    errors: [HOST_KEY_SCAN_FAILED_STATUS],
    input: z.strictObject({
      params: emptyParams,
      query: emptyQuery,
      body: hostKeyScanBodySchema,
    }),
    output: hostKeyScanAnswerSchema,
    description: "Read the ed25519 host key of an SSH host without a write.",
  },
  host_key_pin: {
    id: "repository.host_key.pin",
    service: REPOSITORY_COMPONENT_NAME,
    method: HttpMethod.Put,
    path: "/api/repository/host-key/:host",
    access: AccessPolicy.Human,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    timeoutMs: CREDENTIAL_TIMEOUT_MS,
    mutation: true,
    body: true,
    maxBodyBytes: HOST_KEY_MAX_BODY_BYTES,
    status: HttpStatus.OK,
    errors: [HOST_KEY_SCAN_FAILED_STATUS],
    input: z.strictObject({
      params: hostKeyParamsSchema,
      query: emptyQuery,
      body: hostKeyPinBodySchema,
    }),
    output: hostKeyItemSchema,
    description:
      "Pin the host key of an SSH host when a second read confirms the fingerprint.",
  },
} as const satisfies Record<string, Operation>;
