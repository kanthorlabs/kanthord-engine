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
  CursorInvalid: "system.pagination.cursor_invalid",
  NameConflict: "project.name.conflict",
  ProjectNotFound: "project.project.not_found",
  BindingNotFound: "project.binding.not_found",
  VersionConflict: "project.binding_set.version_conflict",
  DuplicateResource: "project.bindings.duplicate_resource",
  RepositoryAddressInvalid: "project.bindings.repository.address_invalid",
  RepositoryPromptTooLarge:
    "project.bindings.repository.project_prompt_too_large",
  RepositorySshUnreachable: "project.bindings.repository.ssh_unreachable",
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
export function isNonblank(s: string): boolean {
  return s.trim().length > EMPTY_LENGTH;
}

export const repositoryConfigSchema = z.strictObject({
  available: z.boolean(),
  platform: z.literal(REPOSITORY_PLATFORM),
  address: z.string().min(1).refine(isNonblank),
  strategy: z.strictObject({
    baseBranch: z.string().min(1).refine(isNonblank),
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
      })
      .optional(),
  }),
  credential: z.string().min(1),
  projectPrompt: z.string().optional(),
});
export const workerConfigSchema = z.strictObject({
  worker: z.string().min(1),
  instanceCount: z.number().int(),
  resourceBudget: z
    .strictObject({
      turns: z.number().int().positive(),
      wallTimeMs: z.number().int().positive(),
    })
    .optional(),
  entries: z
    .array(
      z.strictObject({
        agent: z.string().min(1),
        agentProvider: z.string().optional(),
        modelIdentifier: z.string().optional(),
        reasoningEffort: z.string().optional(),
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
  ResourceBudget: "resourceBudget",
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
  gitLsRemote(
    sshUrl: string,
    context: Context,
    deadlineMs: number,
  ): Promise<void>;
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
  agentProvider?: string;
  modelIdentifier?: string;
  reasoningEffort?: string;
};
export type AgentDependentBinding = {
  bindingId: string;
  workerName: string;
  entry: WorkerEntry | null;
};
export type BindingRevision = { bindingId: string; projectId: string };
export type BindingChange = {
  kind: (typeof ChangeKind)[keyof typeof ChangeKind];
  bindingId: string;
};
export type WorkerAgentView = {
  defaults: {
    agentProvider: string;
    modelIdentifier: string;
    reasoningEffort: string;
  } | null;
  effective: {
    agentProvider: string;
    provider: string;
    credential: string;
    modelIdentifier: string;
    reasoningEffort: string;
  } | null;
  valid: boolean;
  issues: Array<{ path: string[]; code: string }>;
};
export type BindingRevisionResult = {
  projectId: string;
  bindingId: string;
  name: string;
  resourceIdentity: string;
  revision: number;
  tombstone: boolean;
  disabled: boolean;
};
export type RepositoryPolicy = {
  bindingId: string;
  projectId: string;
  name: string;
  address: string;
  platform: string;
  credential: string;
  baseBranch: string;
  action: (typeof GitHubAction)[keyof typeof GitHubAction] | null;
  projectPrompt: string | null;
};

const emptyFields = z.strictObject({});
const projectParams = z.strictObject({ projectId: z.string().min(1) });
const bindingParams = z.strictObject({
  projectId: z.string().min(1),
  bindingId: z.string().min(1),
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
  bindingSetVersion: z.number().int().positive(),
  createdAt: z.number().int(),
});
const bindingRecord = z.strictObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  kind: z.enum(BindingKind),
  resourceIdentity: z.string(),
  revision: z.number().int().positive(),
  config: z.unknown(),
  createdAt: z.number().int(),
  removedAt: z.number().int().nullable(),
});
const agentConfigItem = z.strictObject({
  agent: z.string(),
  worker: z.string(),
  workerBindingId: z.string(),
  bindingSetVersion: z.number().int().positive(),
  defaults: z.unknown().nullable(),
  entry: z.unknown().nullable(),
  effective: z.unknown().nullable(),
  valid: z.boolean(),
  issues: z.array(
    z.strictObject({ path: z.array(z.string()), code: z.string() }),
  ),
});
const pageOf = <T extends z.ZodType>(item: T) =>
  z.strictObject({ items: z.array(item), nextCursor: z.string().nullable() });
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
    path: "/api/project/:projectId",
    input: readInput(projectParams, emptyFields),
    output: projectRecord,
    description: "Get a project.",
  },
  rename: {
    ...writeOperation,
    id: "project.rename",
    method: HttpMethod.Patch,
    path: "/api/project/:projectId",
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
    path: "/api/project/:projectId/binding",
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
    path: "/api/project/:projectId/binding/:bindingId",
    input: readInput(bindingParams, emptyFields),
    output: bindingRecord,
    description: "Get a binding revision.",
  },
  "bindingSet.get": {
    ...readOperation,
    id: "project.bindingSet.get",
    method: HttpMethod.Get,
    path: "/api/project/:projectId/binding-set",
    input: readInput(projectParams, emptyFields),
    output: bindingSetWriteInputSchema,
    description: "Export the complete current binding set.",
  },
  "bindingSet.write": {
    ...writeOperation,
    id: "project.bindingSet.write",
    method: HttpMethod.Put,
    path: "/api/project/:projectId/binding-set",
    input: z.strictObject({
      params: projectParams,
      query: emptyFields,
      body: bindingSetWriteInputSchema,
    }),
    output: z.strictObject({
      projectId: z.string(),
      bindingSetVersion: z.number().int().positive(),
      bindings: z.record(z.string(), bindingRecord),
      changes: z.array(
        z.strictObject({ kind: z.enum(ChangeKind), bindingId: z.string() }),
      ),
    }),
    description: "Replace the binding set at its expected version.",
  },
  "bindingRevision.list": {
    ...readOperation,
    id: "project.bindingRevision.list",
    method: HttpMethod.Get,
    path: "/api/project/:projectId/binding/:bindingId/revision",
    input: readInput(bindingParams, pageQuery),
    output: pageOf(bindingRecord),
    description: "List retained binding revisions.",
  },
  "agentConfiguration.list": {
    ...readOperation,
    id: "project.agentConfiguration.list",
    method: HttpMethod.Get,
    path: "/api/project/:projectId/binding/:bindingId/agent",
    input: readInput(bindingParams, pageQuery),
    output: pageOf(agentConfigItem),
    description: "List effective agent configuration views.",
  },
  "agentConfiguration.get": {
    ...readOperation,
    id: "project.agentConfiguration.get",
    method: HttpMethod.Get,
    path: "/api/project/:projectId/binding/:bindingId/agent/:agentName",
    input: readInput(
      z.strictObject({
        projectId: z.string().min(1),
        bindingId: z.string().min(1),
        agentName: z.string().min(1),
      }),
      emptyFields,
    ),
    output: agentConfigItem,
    description: "Get an effective agent configuration view.",
  },
} as const satisfies Record<string, Operation>;

export interface ProjectBindings {
  resolveWorkerGroup(
    projectId: string,
    resourceIdentity: string,
    issuedAt: number,
    context: Context,
  ): Promise<{ projectId: string; resourceIdentity: string } | null>;
  resolveWorkerBinding(
    bindingId: string,
    context: Context,
  ): Promise<{ workerBindingId: string; projectId: string } | null>;
}

export interface WorkerBindingRow {
  bindingId: string;
  revision: number;
  workerName: string;
  instanceCount: number;
  resourceBudget: { turns: number; wallTimeMs: number } | null;
  entries: NonNullable<z.infer<typeof workerConfigSchema>["entries"]>;
  tombstone: boolean;
}
