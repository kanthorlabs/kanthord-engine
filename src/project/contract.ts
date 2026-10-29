import assert from "node:assert/strict";
import { z } from "zod";
import type { ServiceIdentity } from "../kernel/caller.ts";
import type { Context } from "../kernel/context.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AccessPolicy,
  type Operation,
  OperationLifetime,
  StoreName,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { isString } from "../kernel/values.ts";
import {
  resourceFailureReasonSchema,
  ResourceStatus,
} from "../kernel/health.ts";
import { tagSchema } from "../kernel/tag.ts";
import { SERVER_HOLDER } from "../kernel/holder.ts";
import {
  AGENT_NAMES,
  type AgentName,
  fallbackConfigurationsSchema,
  type HolderScope,
} from "../agent/contract.ts";
import {
  type RepositoryFile,
  SSH_AGENT_CLEANUP_TIMEOUT_MS,
  type SshAccess,
} from "../repository/contract.ts";
import { timestamp } from "../kernel/json.ts";
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
import {
  type Environment,
  environmentSchema,
  EnvironmentSource,
} from "../kernel/devcontainer.ts";

export const BINDING_CHECK_TIMEOUT_MS = 10000;
export const BINDING_VERIFY_TIMEOUT_MS = 30000;
export const REPOSITORY_FILES_READ_TIMEOUT_MS = 30000;
const ROUTE_ANSWER_MARGIN_MS = 1000;
export const REPOSITORY_FILES_ROUTE_TIMEOUT_MS =
  REPOSITORY_FILES_READ_TIMEOUT_MS +
  SSH_AGENT_CLEANUP_TIMEOUT_MS +
  ROUTE_ANSWER_MARGIN_MS;
export const bindingVerifyAnswerEntrySchema = z.strictObject({
  status: z.enum([
    ResourceStatus.Healthy,
    ResourceStatus.Unhealthy,
    ResourceStatus.Unknown,
  ]),
  capability: z.string().min(1),
  failure_reason: resourceFailureReasonSchema,
});
export type BindingCheckEntry = z.infer<typeof bindingVerifyAnswerEntrySchema>;

export const PROJECT_SERVICE_NAME = "project";
export const PROJECT_ID_PREFIX = "project";
export const BINDING_ID_PREFIX = "binding";
export const BINDING_SET_INITIAL_VERSION = 1;
export const LS_REMOTE_TIMEOUT_MS = 30000;
export const INSTANCE_COUNT_MIN = 0;
export const INSTANCE_COUNT_MAX = 64;
export const STORAGE_PLATFORM = "s3";
export const REPOSITORY_PLATFORM = "github";
export const SSH_CREDENTIAL_PLATFORM = "ssh";
export const ENVIRONMENT_SECRET_PLATFORM = "environment_secret";
export const RepositoryPlatform = {
  GitHub: "github",
  GitLab: "gitlab",
  Bitbucket: "bitbucket",
} as const;
export type RepositoryPlatform =
  (typeof RepositoryPlatform)[keyof typeof RepositoryPlatform];
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
  EnvironmentRunActive: "project.environment.run_active",
  VersionConflict: "project.binding_set.version_conflict",
  DuplicateResource: "project.bindings.duplicate_resource",
  RepositoryAddressInvalid: "project.bindings.repository.address_invalid",
  RepositoryBaseBranchAbsent: "project.bindings.repository.base_branch_absent",
  RepositoryPromptInvalid: "project.bindings.repository.prompt_invalid",
  RepositorySshUnreachable: "project.bindings.repository.ssh_unreachable",
  RepositoryCredentialRequired:
    "project.bindings.repository.credential_required",
  RepositoryActionUnsupported: "project.bindings.repository.action_unsupported",
  EnvironmentSecretInvalid:
    "project.bindings.repository.environment_secret_invalid",
  WorkerAgentUnknown: "project.bindings.worker.agent_unknown",
  WorkerFieldForbidden: "project.bindings.worker.field_forbidden",
  WorkerEnvironmentRequired: "project.bindings.worker.environment_required",
  WorkerEnvironmentUnknown: "project.bindings.worker.environment_unknown",
  WorkerInstanceCountRange: "project.bindings.worker.instance_count_range",
  WorkerResourceChanged: "project.bindings.worker.resource_changed",
  WorkerTagsInvalid: "project.bindings.worker.tags_invalid",
  WorkerInstancesRequired: "project.bindings.worker.instances_required",
  WorkerInstancesInvalid: "project.bindings.worker.instances_invalid",
  WorkerInstanceUnknown: "project.bindings.worker.instance_unknown",
  WorkerInstanceWorkerMismatch:
    "project.bindings.worker.instance_worker_mismatch",
  WorkerInstanceShared: "project.bindings.worker.instance_shared",
  WorkerNodeUnmatched: "project.bindings.worker.node_unmatched",
  SuitePassNotProposed: "project.suite_pass.not_proposed",
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

export { EnvironmentSource };
export const ENVIRONMENT_FILE_MAX_BYTES = 65536;

export const bindingPromptsSchema = z.strictObject(
  Object.fromEntries(
    AGENT_NAMES.map((name) => [name, z.string().optional()]),
  ) as Record<AgentName, z.ZodOptional<z.ZodString>>,
);
export type BindingPrompts = z.infer<typeof bindingPromptsSchema>;

export const ENVIRONMENT_SECRET_VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
export const ENVIRONMENT_SECRETS_MAX = 16;

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
  prompts: bindingPromptsSchema.optional(),
  environment: environmentSchema.optional(),
  environment_secrets: z.record(z.string(), z.string().min(1)).optional(),
});
export const WorkerPlacement = {
  Server: "server",
  Container: "container",
  Worker: "worker",
} as const;
export type WorkerPlacement =
  (typeof WorkerPlacement)[keyof typeof WorkerPlacement];
export const workerTagsSchema = z
  .array(tagSchema)
  .refine((keys) => new Set(keys).size === keys.length);
const workerConfigFields = {
  worker: z.string().min(1),
  instance_count: z.number().int().optional(),
  environment: z.string().min(1).optional(),
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
        fallback_configurations: fallbackConfigurationsSchema.optional(),
      }),
    )
    .optional(),
};
export const workerConfigWriteSchema = z.strictObject({
  ...workerConfigFields,
  placement: z.unknown().optional(),
  worker_instances: z.unknown().optional(),
  tags: z.unknown().optional(),
});
export const workerInstancesSchema = z
  .array(z.string())
  .max(INSTANCE_COUNT_MAX)
  .refine((names) => new Set(names).size === names.length);
export const workerConfigSchema = z.strictObject({
  ...workerConfigFields,
  worker_instances: workerInstancesSchema.optional(),
  tags: workerTagsSchema.optional(),
});
export function bindingHolders(
  instances: ReadonlyArray<{ name: string; placement: WorkerPlacement }>,
): string[] {
  const workers = instances
    .filter(({ placement }) => placement === WorkerPlacement.Worker)
    .map(({ name }) => name);
  return workers.length < instances.length
    ? [...workers, SERVER_HOLDER]
    : workers;
}
export function bindingScope(
  instances: ReadonlyArray<{ name: string; placement: WorkerPlacement }>,
): HolderScope {
  const holders = bindingHolders(instances);
  return {
    holders,
    claimant: holders.some((holder) => holder !== SERVER_HOLDER)
      ? null
      : SERVER_HOLDER,
  };
}
export function effectiveInstanceCount(config: {
  instance_count?: number;
  worker_instances?: readonly string[];
}): number {
  return config.worker_instances === undefined
    ? (config.instance_count ?? INSTANCE_COUNT_MIN)
    : config.worker_instances.length;
}
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
    config: workerConfigWriteSchema,
  }),
  z.strictObject({
    kind: z.literal(BindingKind.Storage),
    config: storageConfigSchema,
  }),
]);
export const bindingSchema = z.discriminatedUnion("kind", [
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
  Placement: "placement",
  InstanceCount: "instance_count",
  WorkerInstances: "worker_instances",
  Environment: "environment",
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
  config: z.infer<typeof workerConfigWriteSchema>,
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
export const bindingSetSchema = z.strictObject({
  version: z.number().int().positive(),
  bindings: z.record(bindingNameSchema, bindingSchema),
});

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
  holders: readonly string[],
) => void;
export type CreateMission = (
  tx: Transaction,
  projectId: string,
  actor: HumanActor,
) => void;
export type LiveNodesPinning = (tx: Transaction, bindingId: string) => string[];
export type CurrentNodePins = (
  tx: Transaction,
  projectId: string,
  bindingIds: readonly string[],
) => { node_id: string; binding_id: string }[];
export type UnmatchedClaims = (
  tx: Transaction,
  projectId: string,
) => { node_id: string; revision: number; claim: string }[];
export type RepositoryConnector = {
  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<void>;
};
export type RepositoryFiles = {
  resolveBranchCommit(
    address: string,
    branch: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<string | null>;
  readFilesAtCommit(
    address: string,
    commit: string,
    paths: readonly string[],
    maxBytes: number,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<RepositoryFile[]>;
  listFilesAtCommit(
    address: string,
    commit: string,
    directory: string,
    limit: number,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<string[]>;
  readObjectIds(
    address: string,
    commit: string,
    paths: readonly string[],
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<Array<string | null>>;
  cloneSnapshot(
    address: string,
    revision: string,
    directory: string,
    context: Context,
    deadlineMs: number,
    ssh: SshAccess,
  ): Promise<string>;
};
export type RepositoryBindingIdsOf = (
  tx: Transaction,
  nodeId: string,
  nodeRevision: number,
) => string[];
export type RequestEvidenceBindingOf = (
  tx: Transaction,
  identity: ServiceIdentity,
  evidenceId: string,
) => string;
export type WorkerAgentsOfFn = (workerName: string) => string[];
export type WorkerAgentViewFn = (
  tx: Transaction,
  workerName: string,
  agentName: string,
  entry: WorkerEntry | null,
  scope: HolderScope,
) => WorkerAgentView | null;
export type HumanActor = { kind: "human"; account: string; name: string };
export type WorkerEntry = {
  agent_provider?: string;
  model_identifier?: string;
  reasoning_effort?: string;
  fallback_configurations?: Array<{
    agent_provider: string;
    model_identifier: string;
    reasoning_effort: string;
  }>;
};
export type AgentDependentBinding = {
  binding_id: string;
  worker_name: string;
  entry: WorkerEntry | null;
  holders: readonly string[];
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
  chain: Array<{
    position: number;
    level: string;
    agent_provider: string;
    provider: string;
    credential: string;
    model_identifier: string;
    reasoning_effort: string;
    cooldown: { strikes: number; available_at: number } | null;
  }>;
  active_position: number | null;
  cooling: { code: string; available_at: number } | null;
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
  resource_identity: string;
  project_id: string;
  name: string;
  address: string;
  platform: string;
  ssh_credential: string;
  credential: string | null;
  base_branch: string;
  action: (typeof GitHubAction)[keyof typeof GitHubAction] | null;
  landing: Landing;
  prompts: BindingPrompts;
  environment: Environment | null;
  repository_environment: boolean;
};
export type SlotEnvironment = {
  binding_id: string;
  resource_identity: string;
  source: typeof EnvironmentSource.Stored | typeof EnvironmentSource.Repository;
  commit: string;
  document: Environment;
  files: Array<{ path: string; state: string; text: string | null }>;
  trees: Array<{ path: string; object: string | null }>;
};

const emptyFields = z.strictObject({});
const projectParams = z.strictObject({ project_id: z.string().min(1) });
const bindingParams = z.strictObject({
  project_id: z.string().min(1),
  binding_id: z.string().min(1),
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
  paused_at: z.number().int().nullable(),
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
  chain: z.array(z.unknown()),
  active_position: z.number().int().nullable(),
  cooling: z.unknown().nullable(),
  valid: z.boolean(),
  issues: z.array(
    z.strictObject({ path: z.array(z.string()), code: z.string() }),
  ),
});
const stalePinSchema = z.strictObject({
  node_id: z.string(),
  binding_name: z.string(),
  pinned_revision: z.number().int().positive(),
  current_revision: z.number().int().positive(),
});
export type StalePin = z.infer<typeof stalePinSchema>;
const bindingSetWriteAnswerSchema = z.strictObject({
  project_id: z.string(),
  binding_set_version: z.number().int().positive(),
  bindings: z.record(z.string(), bindingRecord),
  changes: z.array(
    z.strictObject({ kind: z.enum(ChangeKind), binding_id: z.string() }),
  ),
  stale_pins: z.array(stalePinSchema),
});
export const EnvironmentStatus = {
  None: "none",
  Pending: "pending",
  Building: "building",
  Proving: "proving",
  Ready: "ready",
  Failed: "failed",
} as const;
export type EnvironmentStatus =
  (typeof EnvironmentStatus)[keyof typeof EnvironmentStatus];
export const environmentStatusSchema = z.enum(EnvironmentStatus);

export const EnvironmentTarget = {
  Image: "image",
  Host: "host",
  Remote: "remote",
} as const;
export type EnvironmentTarget =
  (typeof EnvironmentTarget)[keyof typeof EnvironmentTarget];
export const environmentTargetSchema = z.enum(EnvironmentTarget);

export const FailureOrigin = {
  Onboarding: "onboarding",
  Execution: "execution",
} as const;
export type FailureOrigin = (typeof FailureOrigin)[keyof typeof FailureOrigin];
export const failureOriginSchema = z.enum(FailureOrigin);

export const EnvironmentFailureClass = {
  BuildFailed: "build_failed",
  ImageInvalid: "image_invalid",
  SetupFailed: "setup_failed",
  CommandAbsent: "command_absent",
  AffectedInvalid: "affected_invalid",
  AffectedTimeout: "affected_timeout",
} as const;
export type EnvironmentFailureClass =
  (typeof EnvironmentFailureClass)[keyof typeof EnvironmentFailureClass];
export const environmentFailureClassSchema = z.enum(EnvironmentFailureClass);

export const MAX_CHECKS = 32;

export const checkResultSchema = z.strictObject({
  command: z.string(),
  exit_code: z.int().nullable(),
});
export type CheckResult = z.infer<typeof checkResultSchema>;

export const environmentFailureSchema = z.strictObject({
  class: environmentFailureClassSchema.nullable(),
  origin: failureOriginSchema,
  execution_id: z.string().nullable(),
  command: z.string().nullable(),
  exit_code: z.int().nullable(),
  tail: z.string(),
  reproduce: z.string().nullable(),
  ended_at: timestamp,
});

export const environmentStateSchema = z.strictObject({
  binding_id: z.string().min(1),
  binding_name: z.string().min(1),
  resource_identity: z.string().min(1),
  target: environmentTargetSchema,
  source: z.enum(EnvironmentSource).nullable(),
  status: environmentStatusSchema,
  digest: z.string().min(1).nullable(),
  tag: z.string().min(1).nullable(),
  run_started_at: timestamp.nullable(),
  step_started_at: timestamp.nullable(),
  reason: z.string().nullable(),
  reason_started_at: timestamp.nullable(),
  failure: environmentFailureSchema.nullable(),
  checks: z.array(checkResultSchema).max(MAX_CHECKS),
  repairs: z.int().min(0),
  repairing: z.boolean(),
});
export type EnvironmentState = z.infer<typeof environmentStateSchema>;

export const SuitePassState = {
  Present: "present",
  Absent: "absent",
} as const;
export type SuitePassState =
  (typeof SuitePassState)[keyof typeof SuitePassState];
const environmentAnswerSchema = z.strictObject({
  source: z.enum(EnvironmentSource),
  commit: z.string().min(1).nullable(),
  environment: environmentSchema.nullable(),
  reason: z.string().min(1).nullable(),
  suite_pass: z.enum(SuitePassState).nullable(),
});
const suitePassPlanSchema = z.strictObject({
  filename: z.string().min(1),
  content: z.strictObject({
    name: z.string().min(1),
    requirement: z.string().min(1),
    criterion: z.string().min(1),
    verifications: z.array(z.string().min(1)).min(1),
    bindings: z.array(z.string()),
    intent: z.unknown().optional(),
    tags: z.unknown().optional(),
    commit_type: z.unknown().optional(),
  }),
  tasks: z.array(z.never()),
  reason: z.string().min(1),
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
  pause: {
    ...baseOperation,
    mutation: true,
    body: false,
    id: "project.pause",
    method: HttpMethod.Post,
    path: "/api/project/:project_id/pause",
    input: readInput(projectParams, emptyFields),
    output: projectRecord,
    description: "Pause a project so that it admits no claim.",
  },
  resume: {
    ...baseOperation,
    mutation: true,
    body: false,
    id: "project.resume",
    method: HttpMethod.Post,
    path: "/api/project/:project_id/resume",
    input: readInput(projectParams, emptyFields),
    output: projectRecord,
    description: "Resume a paused project so that it admits claims.",
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
    output: bindingSetSchema,
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
    output: bindingSetWriteAnswerSchema,
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
  "environment.list": {
    ...readOperation,
    id: "project.environment.list",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/environment",
    input: readInput(projectParams, emptyFields),
    output: z.strictObject({ items: z.array(environmentStateSchema) }),
    description:
      "List the environment state of each current repository binding of a project.",
  },
  "binding.environment.get": {
    ...readOperation,
    id: "project.binding.environment.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id/environment",
    timeoutMs: REPOSITORY_FILES_ROUTE_TIMEOUT_MS,
    input: readInput(bindingParams, emptyFields),
    output: environmentAnswerSchema,
    description:
      "Read the environment of one repository binding with its source: stored, repository, detected, universal or none.",
  },
  "binding.suite_pass.plan.get": {
    ...readOperation,
    id: "project.binding.suite_pass.plan.get",
    method: HttpMethod.Get,
    path: "/api/project/:project_id/binding/:binding_id/suite-pass/plan",
    input: readInput(bindingParams, emptyFields),
    output: suitePassPlanSchema,
    description:
      "Read the body of the node create of the suite pass setup node of one repository binding.",
  },
  "binding.environment.set": {
    ...writeOperation,
    id: "project.binding.environment.set",
    method: HttpMethod.Put,
    path: "/api/project/:project_id/binding/:binding_id/environment",
    timeoutMs: BINDING_VERIFY_TIMEOUT_MS,
    input: z.strictObject({
      params: bindingParams,
      query: emptyFields,
      body: z.strictObject({ environment: z.unknown() }),
    }),
    output: bindingSetWriteAnswerSchema,
    description:
      "Store the environment of one repository binding as a new binding revision, or remove it with null.",
  },
  "binding.environment.rebuild": {
    ...writeOperation,
    body: false,
    id: "project.binding.environment.rebuild",
    method: HttpMethod.Post,
    path: "/api/project/:project_id/binding/:binding_id/environment/rebuild",
    timeoutMs: BINDING_VERIFY_TIMEOUT_MS,
    input: readInput(bindingParams, emptyFields),
    output: environmentStateSchema,
    description:
      "Discard the proof and the images of the environment group of one repository binding and build it again.",
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
  ): Promise<{
    project_id: string;
    resource_identity: string;
    worker_instances?: string[];
  } | null>;
  workerGroupEnded(
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    context: Context,
  ): Promise<boolean>;
}

export type InstanceOf = (
  tx: Transaction,
  instanceName: string,
) => { name: string; worker: string; placement: WorkerPlacement } | null;

export type BindingsChanged = (projectId: string) => void;

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
  worker_instances: string[];
  environment: string | null;
  generation: number;
  resource_budget: { turns: number; wall_time_ms: number } | null;
  entries: NonNullable<z.infer<typeof workerConfigSchema>["entries"]>;
  tags: string[];
  tombstone: boolean;
}

export type VerifyRepositoryCredential = (
  credentialName: string,
  context: Context,
) => Promise<BindingCheckEntry>;

export const environmentSecretCredentialAnswerSchema =
  credentialAnswerSchema.extend({
    bindings: z.array(
      z.strictObject({
        project_id: z.string(),
        project_name: z.string(),
        binding_id: z.string(),
        name: z.string(),
      }),
    ),
  });
export type EnvironmentSecretCredentialAnswer = z.infer<
  typeof environmentSecretCredentialAnswerSchema
>;

const credentialOperation = {
  ...baseOperation,
  timeoutMs: CREDENTIAL_TIMEOUT_MS,
} as const;
const credentialRead = {
  ...credentialOperation,
  mutation: false,
  body: false,
} as const;
const credentialWrite = {
  ...credentialOperation,
  mutation: true,
  body: true,
  maxBodyBytes: CREATE_MAX_BODY_BYTES,
} as const;
const credentialAction = {
  ...credentialOperation,
  mutation: true,
  body: false,
} as const;

export const environmentSecretOperations = {
  platform_list: {
    ...credentialRead,
    id: "project.credential.platform_list",
    method: HttpMethod.Get,
    path: "/api/project/credential/platform",
    input: readInput(emptyFields, emptyFields),
    output: credentialPlatformListAnswerSchema,
    description: "List the environment secret credential platforms.",
  },
  create: {
    ...credentialWrite,
    id: "project.credential.create",
    method: HttpMethod.Post,
    path: "/api/project/credential",
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: credentialCreateSchema,
    }),
    output: credentialAnswerSchema,
    description: "Create an environment secret with its first revision.",
  },
  list: {
    ...credentialRead,
    id: "project.credential.list",
    method: HttpMethod.Get,
    path: "/api/project/credential",
    input: readInput(emptyFields, credentialListQuerySchema),
    output: credentialListAnswerSchema,
    description:
      "List environment secrets with optional platform filtering and pagination.",
  },
  get: {
    ...credentialRead,
    id: "project.credential.get",
    method: HttpMethod.Get,
    path: "/api/project/credential/:credential_name",
    input: readInput(credentialParamsSchema, emptyFields),
    output: environmentSecretCredentialAnswerSchema,
    description:
      "Get an environment secret, all its revisions and the bindings that name it.",
  },
  rotate: {
    ...credentialWrite,
    id: "project.credential.rotate",
    method: HttpMethod.Post,
    path: "/api/project/credential/:credential_name/revision",
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyFields,
      body: credentialRotateBodySchema,
    }),
    output: credentialAnswerSchema,
    description: "Rotate an environment secret into a new revision.",
  },
  update_metadata: {
    ...credentialWrite,
    id: "project.credential.update_metadata",
    method: HttpMethod.Put,
    path: "/api/project/credential/:credential_name/metadata",
    maxBodyBytes: METADATA_MAX_BODY_BYTES,
    input: z.strictObject({
      params: credentialParamsSchema,
      query: emptyFields,
      body: credentialUpdateMetadataBodySchema,
    }),
    output: credentialAnswerSchema,
    description: "Update environment secret metadata in a new revision.",
  },
  revoke: {
    ...credentialAction,
    id: "project.credential.revoke",
    method: HttpMethod.Post,
    path: "/api/project/credential/:credential_name/revision/:revision/revoke",
    input: readInput(credentialRevisionParamsSchema, emptyFields),
    output: credentialAnswerSchema,
    description: "End an older environment secret revision.",
  },
  archive: {
    ...credentialAction,
    id: "project.credential.archive",
    method: HttpMethod.Post,
    path: "/api/project/credential/:credential_name/archive",
    input: readInput(credentialParamsSchema, emptyFields),
    output: credentialAnswerSchema,
    description: "Archive an environment secret that no dependent names.",
  },
  check: {
    ...credentialWrite,
    id: "project.credential.check",
    method: HttpMethod.Post,
    path: "/api/project/credential/check",
    mutation: false,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: credentialCheckBodySchema,
    }),
    output: credentialCheckAnswerSchema,
    description: "Check a typed environment secret before it is saved.",
  },
  verify: {
    ...credentialAction,
    id: "project.credential.verify",
    method: HttpMethod.Post,
    path: "/api/project/credential/:credential_name/verify",
    mutation: false,
    input: readInput(credentialParamsSchema, emptyFields),
    output: credentialCheckAnswerSchema,
    description: "Verify one stored environment secret record.",
  },
} as const satisfies Record<string, Operation>;
