import assert from "node:assert/strict";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { isString } from "../kernel/values.ts";
import { ResourceStatus } from "../kernel/health.ts";

export const BINDING_CHECK_TIMEOUT_MS = 10000;
export const BINDING_VERIFY_TIMEOUT_MS = 30000;
export const bindingVerifyAnswerEntrySchema = z.strictObject({
  status: z.enum([
    ResourceStatus.Healthy,
    ResourceStatus.Unhealthy,
    ResourceStatus.Unknown,
  ]),
  capability: z.string().min(1),
});
export type BindingCheckEntry = z.infer<typeof bindingVerifyAnswerEntrySchema>;

export const PROJECT_SERVICE_NAME = "project";
export const PROJECT_ID_PREFIX = "project";
export const BINDING_ID_PREFIX = "binding";
export const BINDING_SET_INITIAL_VERSION = 1;
export const LS_REMOTE_TIMEOUT_MS = 30000;
export const PROJECT_PROMPT_MAX_BYTES = 32768;
export const INSTANCE_COUNT_MIN = 0;
export const INSTANCE_COUNT_MAX = 64;
export const STORAGE_PLATFORM = "s3";
export const REPOSITORY_PLATFORM = "github";
export const SSH_CREDENTIAL_PLATFORM = "ssh";
export const RepositoryPlatform = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket",
} as const;
export type RepositoryPlatform =
  (typeof RepositoryPlatform)[keyof typeof RepositoryPlatform];
export type SshIdentity = {
  hostname: string;
  port: number;
  identityFiles: string[];
  identitiesOnly: boolean;
};
export const RESOURCE_CAPABILITY_NETWORK_GIT_READ = "network git read";
export const RESOURCE_TARGET_KIND_REPOSITORY = "repository";
export const WORKER_PLATFORM = "kanthord";
export const PROJECT_OPERATION_TIMEOUT_MS = 30000;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;
export const PROJECT_NAME_MAX_LENGTH = 63;
export const EMPTY_LENGTH = 0;
export const PROJECT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export const BindingKind = {
  Repository: "repository",
  Worker: "worker",
  Storage: "storage",
} as const;
export const GitHubAction = {
  PullRequest: "pull_request",
  MergePush: "merge_push",
} as const;
export const Landing = {
  Human: "human",
  KanthorD: "kanthord",
} as const;
export type Landing = (typeof Landing)[keyof typeof Landing];
export const FollowsType = {
  AssessmentPassed: "assessment_passed",
  ActionEndState: "action_end_state",
} as const;
export const ChangeKind = {
  Created: "created",
  Revised: "revised",
  Removed: "removed",
  Unchanged: "unchanged",
} as const;
export const BindingState = {
  Current: "current",
  Removed: "removed",
  All: "all",
} as const;

export const ProjectErrorCode = {
  AuthorizationRefused: "project.authorization.refused",
  CursorInvalid: "system.pagination.cursor_invalid",
  NameConflict: "project.name.conflict",
  ProjectNotFound: "project.project.not_found",
  BindingNotFound: "project.binding.not_found",
  VersionConflict: "project.binding_set.version_conflict",
  DuplicateResource: "project.bindings.duplicate_resource",
  RepositoryAddressInvalid: "project.bindings.repository.address_invalid",
  RepositoryBaseBranchAbsent: "project.bindings.repository.base_branch_absent",
  RepositoryPromptTooLarge:
    "project.bindings.repository.project_prompt_too_large",
  RepositorySshUnreachable: "project.bindings.repository.ssh_unreachable",
  RepositorySshHostMismatch: "project.bindings.repository.ssh_host_mismatch",
  RepositoryCredentialRequired:
    "project.bindings.repository.credential_required",
  RepositoryActionUnsupported: "project.bindings.repository.action_unsupported",
  WorkerAgentUnknown: "project.bindings.worker.agent_unknown",
  WorkerFieldForbidden: "project.bindings.worker.field_forbidden",
  WorkerInstanceCountRange: "project.bindings.worker.instance_count_range",
  WorkerResourceChanged: "project.bindings.worker.resource_changed",
} as const;

export const projectNameSchema = z
  .string()
  .min(1)
  .max(PROJECT_NAME_MAX_LENGTH)
  .regex(PROJECT_NAME_PATTERN);
export const bindingNameSchema = z
  .string()
  .min(1)
  .max(PROJECT_NAME_MAX_LENGTH)
  .regex(PROJECT_NAME_PATTERN);
export function workerResourceIdentity(bindingName: string): string {
  assert.ok(bindingNameSchema.safeParse(bindingName).success);
  const identity = `${BindingKind.Worker}:${WORKER_PLATFORM}:${bindingName}`;
  assert.ok(identity.endsWith(`:${bindingName}`));
  return identity;
}
export function isNonblank(s: string): boolean {
  return s.trim().length > EMPTY_LENGTH;
}

export const InstructionFileState = {
  Present: "present",
  Absent: "absent",
  Invalid: "invalid",
} as const;

export const WorkingLayerSwitch = {
  AgentsMd: "agents_md",
  AgentsLocalMd: "agents_local_md",
  ClaudeMd: "claude_md",
  ClaudeLocalMd: "claude_local_md",
  ProjectPrompt: "project_prompt",
} as const;
export const workingLayerSchema = z
  .strictObject(
    Object.fromEntries(
      Object.values(WorkingLayerSwitch).map((name) => [
        name,
        z.boolean().default(true),
      ]),
    ) as Record<
      (typeof WorkingLayerSwitch)[keyof typeof WorkingLayerSwitch],
      z.ZodDefault<z.ZodBoolean>
    >,
  )
  .prefault({});
export type WorkingLayer = z.output<typeof workingLayerSchema>;

export const repositoryConfigSchema = z.strictObject({
  available: z.boolean(),
  platform: z.enum(RepositoryPlatform),
  address: z.string().min(1).refine(isNonblank),
  strategy: z.strictObject({
    base_branch: z.string().min(1).refine(isNonblank),
    action: z
      .strictObject({
        name: z.enum(GitHubAction),
        follows: z.discriminatedUnion("type", [
          z.strictObject({ type: z.literal(FollowsType.AssessmentPassed) }),
          z.strictObject({
            type: z.literal(FollowsType.ActionEndState),
            binding: bindingNameSchema,
          }),
        ]),
        landing: z.enum(Landing).optional(),
      })
      .refine(
        (action) =>
          action.landing === undefined ||
          action.name === GitHubAction.PullRequest,
        {
          path: ["landing"],
          message: "Only a pull_request action holds a landing choice.",
        },
      )
      .optional(),
  }),
  ssh_credential: z.string().min(1),
  credential: z.string().min(1).optional(),
  project_prompt: z.string().optional(),
  working_layer: workingLayerSchema,
});
export const workerConfigSchema = z.strictObject({
  worker: z.string().min(1),
  instance_count: z.number().int(),
  resource_budget: z
    .strictObject({
      turns: z.number().int().positive(),
      wall_time_ms: z.number().int().positive(),
    })
    .optional(),
  entries: z
    .array(
      z.strictObject({
        agent: z.string().min(1),
        agent_provider: z.string().optional(),
        model_identifier: z.string().optional(),
        reasoning_effort: z.string().optional(),
      }),
    )
    .optional(),
});
export const storageConfigSchema = z.strictObject({
  available: z.boolean(),
  endpoint: z.url(),
  bucket: z.string().min(1).refine(isNonblank),
  region: z.string().min(1).refine(isNonblank),
  prefix: z.string(),
  credential: z.string().min(1),
});
export const bindingEditSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal(BindingKind.Repository),
    config: repositoryConfigSchema,
  }),
  z.strictObject({
    kind: z.literal(BindingKind.Worker),
    config: workerConfigSchema,
  }),
  z.strictObject({
    kind: z.literal(BindingKind.Storage),
    config: storageConfigSchema,
  }),
]);
export const WorkerField = {
  Entries: "entries",
  ResourceBudget: "resource_budget",
} as const;
const CUSTOM_ISSUE = "custom";
type BindingEdits = Record<string, z.infer<typeof bindingEditSchema>>;

function followsPath(name: string): string[] {
  return [
    "bindings",
    name,
    "config",
    "strategy",
    "action",
    "follows",
    "binding",
  ];
}

function refineAgentSelectors(
  name: string,
  config: z.infer<typeof workerConfigSchema>,
  ctx: z.RefinementCtx,
): void {
  const selectors = new Set<string>();
  for (const [index, entry] of (config.entries ?? []).entries()) {
    if (selectors.has(entry.agent))
      ctx.addIssue({
        code: CUSTOM_ISSUE,
        path: ["bindings", name, "config", WorkerField.Entries, index, "agent"],
        message: "Agent selectors must be unique within a worker binding.",
      });
    selectors.add(entry.agent);
  }
}

function refineFollowsCycles(
  edges: Map<string, string>,
  ctx: z.RefinementCtx,
): void {
  const checked = new Set<string>();
  for (const start of edges.keys()) {
    const path = new Set<string>();
    let name: string | undefined = start;
    for (let remaining = edges.size; remaining > EMPTY_LENGTH; remaining--) {
      if (name === undefined || checked.has(name)) break;
      path.add(name);
      const target = edges.get(name);
      if (target !== undefined && path.has(target)) {
        ctx.addIssue({
          code: CUSTOM_ISSUE,
          path: followsPath(name),
          message: "Action follows references must not form a cycle.",
        });
        break;
      }
      name = target;
    }
    for (const visited of path) checked.add(visited);
  }
}

function refineBindingRelations(
  bindings: BindingEdits,
  ctx: z.RefinementCtx,
): void {
  const edges = new Map<string, string>();
  for (const [name, binding] of Object.entries(bindings)) {
    if (binding.kind === BindingKind.Worker)
      refineAgentSelectors(name, binding.config, ctx);
    if (binding.kind !== BindingKind.Repository) continue;
    const follows = binding.config.strategy.action?.follows;
    if (follows?.type !== FollowsType.ActionEndState) continue;
    ctx.addIssue({
      code: CUSTOM_ISSUE,
      path: followsPath(name),
      message:
        "Action follows must name the passing assessment until a claim-source contract exists.",
    });
    const target = Object.hasOwn(bindings, follows.binding)
      ? bindings[follows.binding]
      : undefined;
    if (
      target?.kind !== BindingKind.Repository ||
      !target.config.strategy.action
    ) {
      ctx.addIssue({
        code: CUSTOM_ISSUE,
        path: followsPath(name),
        message:
          "Action follows must name a submitted repository with an action.",
      });
      continue;
    }
    edges.set(name, follows.binding);
  }
  refineFollowsCycles(edges, ctx);
}

export const bindingSetWriteInputSchema = z
  .strictObject({
    version: z.number().int().positive(),
    bindings: z.record(bindingNameSchema, bindingEditSchema),
  })
  .superRefine(({ bindings }, ctx) => refineBindingRelations(bindings, ctx));

export type CustodySuitability = (
  tx: Transaction,
  req: { credential: string; platform: string },
) => void;
export type CredentialMetadataOf = (
  tx: Transaction,
  credentialName: string,
) => { platform: string; metadata: Record<string, unknown> | null } | null;
export type ValidateEntry = (
  tx: Transaction,
  workerName: string,
  entry: WorkerEntry | null,
) => void;
export type CreateMission = (
  tx: Transaction,
  projectId: string,
  actor: HumanActor,
) => void;
export type LiveNodesPinning = (tx: Transaction, bindingId: string) => string[];
export type RepositoryConnector = {
  resolveSshIdentity(
    host: string,
    context: Context,
    deadlineMs: number,
  ): Promise<SshIdentity>;
  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void>;
};
export type RepositoryFiles = {
  resolveBranchCommit(
    address: string,
    branch: string,
    context: Context,
    deadlineMs: number,
  ): Promise<string | null>;
  readFilesAtCommit(
    address: string,
    commit: string,
    paths: readonly string[],
    maxBytes: number,
    context: Context,
    deadlineMs: number,
  ): Promise<Array<{ path: string; state: string; text: string | null }>>;
};
export type WorkerAgentsOfFn = (workerName: string) => string[];
export type WorkerAgentViewFn = (
  tx: Transaction,
  workerName: string,
  agentName: string,
  entry: WorkerEntry | null,
) => WorkerAgentView | null;
export type HumanActor = { kind: "human"; account: string; name: string };
export type WorkerEntry = {
  agent_provider?: string;
  model_identifier?: string;
  reasoning_effort?: string;
};
export type AgentDependentBinding = {
  binding_id: string;
  worker_name: string;
  entry: WorkerEntry | null;
};
export type BindingNaming = {
  binding_id: string;
  project_id: string;
  project_name: string;
  name: string;
};
export type BindingChange = {
  kind: (typeof ChangeKind)[keyof typeof ChangeKind];
  binding_id: string;
};
export type WorkerAgentView = {
  defaults: {
    agent_provider: string;
    model_identifier: string;
    reasoning_effort: string;
  } | null;
  effective: {
    agent_provider: string;
    provider: string;
    credential: string;
    model_identifier: string;
    reasoning_effort: string;
  } | null;
  valid: boolean;
  issues: Array<{ path: string[]; code: string }>;
};
export type BindingRevisionResult = {
  project_id: string;
  binding_id: string;
  name: string;
  resource_identity: string;
  revision: number;
  tombstone: boolean;
  disabled: boolean;
};
export type RepositoryPolicy = {
  binding_id: string;
  project_id: string;
  name: string;
  address: string;
  platform: string;
  ssh_credential: string;
  credential: string | null;
  base_branch: string;
  action: (typeof GitHubAction)[keyof typeof GitHubAction] | null;
  landing: Landing;
  project_prompt: string | null;
  working_layer: WorkingLayer;
};

const emptyFields = z.strictObject({});
const projectParams = z.strictObject({ project_id: z.string().min(1) });
const bindingParams = z.strictObject({
  project_id: z.string().min(1),
  binding_id: z.string().min(1),
});
const instructionFileEntry = z.strictObject({
  source: z.enum([
    WorkingLayerSwitch.AgentsMd,
    WorkingLayerSwitch.AgentsLocalMd,
    WorkingLayerSwitch.ClaudeMd,
    WorkingLayerSwitch.ClaudeLocalMd,
  ]),
  path: z.string().min(1),
  state: z.enum(InstructionFileState),
  reason: z.string().min(1).nullable(),
  text: z.string().nullable(),
});
const nameBody = z.strictObject({ name: projectNameSchema });
const pageQuery = z.strictObject({
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIST_LIMIT_MAX)
    .default(LIST_LIMIT_DEFAULT),
  cursor: z.string().min(1).optional(),
});
const projectRecord = z.strictObject({
  id: z.string(),
  name: z.string(),
  binding_set_version: z.number().int().positive(),
  created_at: z.number().int(),
  workspace_directory: z.string(),
});
const bindingRecord = z.strictObject({
  id: z.string(),
  project_id: z.string(),
  name: z.string(),
  kind: z.enum(BindingKind),
  resource_identity: z.string(),
  revision: z.number().int().positive(),
  config: z.unknown(),
  created_at: z.number().int(),
  removed_at: z.number().int().nullable(),
});
const agentConfigItem = z.strictObject({
  agent: z.string(),
  worker: z.string(),
  worker_binding_id: z.string(),
  binding_set_version: z.number().int().positive(),
  defaults: z.unknown().nullable(),
  entry: z.unknown().nullable(),
  effective: z.unknown().nullable(),
  valid: z.boolean(),
  issues: z.array(
    z.strictObject({ path: z.array(z.string()), code: z.string() }),
  ),
});
const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), next_cursor: z.string().nullable() });
const baseOperation = {
  service: PROJECT_SERVICE_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: PROJECT_OPERATION_TIMEOUT_MS,
  status: HttpStatus.OK,
} as const;
const readOperation = {
  ...baseOperation,
  mutation: false,
  body: false,
} as const;
const writeOperation = {
  ...baseOperation,
  mutation: true,
  body: true,
} as const;
const readInput = <P extends z.ZodType, Q extends z.ZodType>(
  params: P,
  query: Q,
) => z.strictObject({ params, query, body: z.null() });

export const projectOperations = {
  create: {
    ...writeOperation,
    id: "project.create",
    method: HttpMethod.Post,
    path: "/api/project",
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: nameBody,
    }),
    output: projectRecord,
    description: "Create a project with an empty binding set.",
  },
  list: {
    ...readOperation,
    id: "project.list",
    method: HttpMethod.Get,
    path: "/api/project",
    input: readInput(emptyFields, pageQuery),
    output: pageOf(projectRecord),
    description: "List projects in descending identity order.",
  },
  get: {
    ...readOperation,
    id: "project.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id",
    input: readInput(projectParams, emptyFields),
    output: projectRecord,
    description: "Get a project.",
  },
  rename: {
    ...writeOperation,
    id: "project.rename",
    method: HttpMethod.Patch,
    path: "/api/project/:project_id",
    input: z.strictObject({
      params: projectParams,
      query: emptyFields,
      body: nameBody,
    }),
    output: projectRecord,
    description: "Rename a project.",
  },
  "binding.list": {
    ...readOperation,
    id: "project.binding.list",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding",
    input: readInput(
      projectParams,
      z.strictObject({
        kind: z
          .preprocess(
            (value) => (isString(value) ? [value] : value),
            z.array(z.enum(BindingKind)),
          )
          .optional(),
        state: z.enum(BindingState).optional(),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(LIST_LIMIT_MAX)
          .default(LIST_LIMIT_DEFAULT),
        cursor: z.string().min(1).optional(),
      }),
    ),
    output: pageOf(bindingRecord),
    description: "List bindings with optional kind and state filters.",
  },
  "binding.get": {
    ...readOperation,
    id: "project.binding.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id",
    input: readInput(bindingParams, emptyFields),
    output: bindingRecord,
    description: "Get a binding revision.",
  },
  "bindingSet.get": {
    ...readOperation,
    id: "project.bindingSet.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding-set",
    input: readInput(projectParams, emptyFields),
    output: bindingSetWriteInputSchema,
    description: "Export the complete current binding set.",
  },
  "bindingSet.write": {
    ...writeOperation,
    id: "project.bindingSet.write",
    method: HttpMethod.Put,
    path: "/api/project/:project_id/binding-set",
    input: z.strictObject({
      params: projectParams,
      query: emptyFields,
      body: bindingSetWriteInputSchema,
    }),
    output: z.strictObject({
      project_id: z.string(),
      binding_set_version: z.number().int().positive(),
      bindings: z.record(z.string(), bindingRecord),
      changes: z.array(
        z.strictObject({ kind: z.enum(ChangeKind), binding_id: z.string() }),
      ),
    }),
    description: "Replace the binding set at its expected version.",
  },
  "bindingRevision.list": {
    ...readOperation,
    id: "project.bindingRevision.list",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id/revision",
    input: readInput(bindingParams, pageQuery),
    output: pageOf(bindingRecord),
    description: "List retained binding revisions.",
  },
  "agentConfiguration.list": {
    ...readOperation,
    id: "project.agentConfiguration.list",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id/agent",
    input: readInput(bindingParams, pageQuery),
    output: pageOf(agentConfigItem),
    description: "List effective agent configuration views.",
  },
  "agentConfiguration.get": {
    ...readOperation,
    id: "project.agentConfiguration.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id/agent/:agent_name",
    input: readInput(
      z.strictObject({
        project_id: z.string().min(1),
        binding_id: z.string().min(1),
        agent_name: z.string().min(1),
      }),
      emptyFields,
    ),
    output: agentConfigItem,
    description: "Get an effective agent configuration view.",
  },
  "binding.verify": {
    ...readOperation,
    id: "project.binding.verify",
    method: HttpMethod.Post,
    path: "/api/project/:project_id/binding/:binding_id/verify",
    timeoutMs: BINDING_VERIFY_TIMEOUT_MS,
    input: readInput(bindingParams, emptyFields),
    output: z.strictObject({
      address: bindingVerifyAnswerEntrySchema,
      ssh_credential: bindingVerifyAnswerEntrySchema,
      credential: bindingVerifyAnswerEntrySchema.nullable(),
    }),
    description: "Verify one repository binding address and credential.",
  },
  "binding.instruction_files.get": {
    ...readOperation,
    id: "project.binding.instruction_files.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id/instruction_files",
    input: readInput(bindingParams, emptyFields),
    output: z.strictObject({
      commit: z.string().min(1),
      read_at: z.number().int(),
      files: z.array(instructionFileEntry),
    }),
    description:
      "Read the instruction files of one repository binding at its base branch.",
  },
  "binding.check": {
    ...readOperation,
    id: "project.binding.check",
    method: HttpMethod.Post,
    path: "/api/project/:project_id/binding/check",
    timeoutMs: BINDING_VERIFY_TIMEOUT_MS,
    body: true,
    input: z.strictObject({
      params: projectParams,
      query: emptyFields,
      body: z.strictObject({
        kind: z.literal(BindingKind.Repository),
        config: repositoryConfigSchema,
      }),
    }),
    output: z.strictObject({
      address: bindingVerifyAnswerEntrySchema,
      ssh_credential: bindingVerifyAnswerEntrySchema,
      credential: bindingVerifyAnswerEntrySchema.nullable(),
    }),
    description:
      "Check an unsaved repository binding configuration without a write.",
  },
} as const satisfies Record<string, Operation>;

export interface SchedulerWakeup {
  wake(projectId: string): void;
}

export interface ProjectBindings {
  resolveWorkerGroup(
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    context: Context,
  ): Promise<{ project_id: string; resource_identity: string } | null>;
}

export type EndRegistrations = (
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
  now: number,
) => void;

export interface StorageBinding {
  binding_id: string;
  project_id: string;
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  credential: string;
  available: boolean;
}

export interface WorkerBindingRow {
  binding_id: string;
  name: string;
  project_name: string;
  revision: number;
  worker_name: string;
  instance_count: number;
  resource_budget: { turns: number; wall_time_ms: number } | null;
  entries: NonNullable<z.infer<typeof workerConfigSchema>["entries"]>;
  tombstone: boolean;
}

export type VerifyRepositoryCredential = (
  credentialName: string,
  context: Context,
) => Promise<BindingCheckEntry>;
