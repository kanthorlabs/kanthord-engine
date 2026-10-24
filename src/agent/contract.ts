import { z } from "zod";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { ANTHROPIC_SUBSCRIPTION_PLATFORM } from "../kernel/pi-provider.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import type { ResourceCheck } from "../kernel/health.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { SERVER_HOLDER } from "../custody/contract.ts";
import {
  AdvancingProviderFailure,
  ChainLevelName,
  CooldownChangeKind as SchedulerCooldownChangeKind,
  agentSelectionSchema,
  isAdvancingProviderFailure,
  type AgentSelection as SchedulerAgentSelection,
  type CooldownChange as SchedulerCooldownChange,
} from "../scheduler/contract.ts";

export const AGENT_COMPONENT_NAME = "agent";
export const AGENT_NAMES = ["swe@1", "re@1", "env@1"] as const;
export type AgentName = (typeof AGENT_NAMES)[number];
export const ENABLEMENT_MAX_BODY_BYTES = 64 * 1024;
export const ENABLEMENT_TIMEOUT_MS = 30000;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;
export const AGENT_PROVIDER_TARGET_KIND = "agent-provider";
export const FALLBACK_CONFIGURATIONS_MAX = 7;

export const PromptOrigin = {
  Binary: "binary",
  File: "file",
  Database: "database",
} as const;
export type PromptOrigin = (typeof PromptOrigin)[keyof typeof PromptOrigin];

export const PromptPart = {
  Standard: "standard",
  Role: "role",
  Workbench: "workbench",
  Binding: "binding",
} as const;
export type PromptPart = (typeof PromptPart)[keyof typeof PromptPart];

export const PromptView = { Final: "final" } as const;
export type PromptView = (typeof PromptView)[keyof typeof PromptView];

export const PromptTemplate = {
  Work: "work",
  FramingWorker: "framing-worker",
  FramingWorkbench: "framing-workbench",
  TaskRevision: "task-revision",
  CriterionRevision: "criterion-revision",
  Evaluation: "evaluation",
  Examine: "examine",
  Repair: "repair",
  Conflict: "conflict",
} as const;
export type PromptTemplate =
  (typeof PromptTemplate)[keyof typeof PromptTemplate];
export type PromptTemplates = Readonly<Record<PromptTemplate, string>>;

export const promptTemplatesSchema = z.strictObject(
  Object.fromEntries(
    Object.values(PromptTemplate).map((name) => [name, z.string()]),
  ) as { [Name in PromptTemplate]: z.ZodString },
);

export const AgentErrorCode = {
  AgentNotFound: "agent.catalog.not_found",
  NotFound: "agent.enablement.not_found",
  RevisionConflict: "agent.enablement.revision_conflict",
  Unavailable: "agent.enablement.unavailable",
  InvalidatesBindings: "agent.enablement.invalidates_bindings",
  InUse: "agent.enablement.in_use",
  ProviderNameConflict: "agent.enablement.provider.name_conflict",
  ProviderCredentialConflict: "agent.enablement.provider.credential_conflict",
  ProviderNotFound: "agent.enablement.provider.not_found",
  ProviderFixed: "agent.enablement.provider.fixed",
  ProviderInUse: "agent.enablement.provider.in_use",
  ProviderRequired: "agent.enablement.provider.required",
  OverrideNotAllowed: "agent.configuration.override_not_allowed",
  InvalidConfiguration: "agent.configuration.invalid",
  FallbackDuplicate: "agent.configuration.fallback_duplicate",
  ChainCooling: "agent.configuration.chain_cooling",
  CooldownNotFound: "agent.cooldown.not_found",
  ModelUnknown: "agent.configuration.model_unknown",
  ReasoningUnsupported: "agent.configuration.reasoning_effort_unsupported",
  CredentialUnsuitable: "agent.configuration.credential_unsuitable",
  CredentialHolderMismatch: "agent.configuration.credential_holder_mismatch",
  PromptTemplateInvalid: "agent.prompt.template_invalid",
} as const;

export type AgentProviderItem = {
  name: string;
  provider: string;
  credential: string;
};

export type DefaultConfiguration = {
  agent_provider: string;
  model_identifier: string;
  reasoning_effort: string;
};

export type AgentEntry = {
  agent_provider?: string;
  model_identifier?: string;
  reasoning_effort?: string;
  fallback_configurations?: DefaultConfiguration[];
};

export type AgentEnablement = {
  agent_name: string;
  state: string;
  agent_providers: AgentProviderItem[];
  default_configuration: DefaultConfiguration;
  fallback_configurations: DefaultConfiguration[];
  revision: number;
};

export const ChainLevel = ChainLevelName;
export type ChainLevel = (typeof ChainLevel)[keyof typeof ChainLevel];

export const AdvancingFailure = AdvancingProviderFailure;
export type AdvancingFailure = AdvancingProviderFailure;
export const isAdvancingFailure = isAdvancingProviderFailure;

export type AgentSelection = SchedulerAgentSelection;

export const CooldownChangeKind = SchedulerCooldownChangeKind;
export type CooldownChange = SchedulerCooldownChange;

export type ChainEntry = z.infer<typeof chainEntrySchema>;

export type ChainCooling = z.infer<typeof chainCoolingSchema>;

export type AgentProviderDependent = {
  agent_name: string;
  provider_name: string;
};

export type AgentDependentBinding = {
  binding_id: string;
  worker_name: string;
  entry: AgentEntry | null;
  holders: readonly string[];
};

export type HolderScope = {
  holders: readonly string[];
  claimant: string | null;
};

export type CopyHeldFn = (
  tx: Transaction,
  credentialName: string,
  holder: string,
) => boolean;

export type AgentView = {
  defaults: DefaultConfiguration | null;
  effective: {
    agent_provider: string;
    provider: string;
    credential: string;
    model_identifier: string;
    reasoning_effort: string;
  } | null;
  chain: ChainEntry[];
  active_position: number | null;
  cooling: ChainCooling | null;
  valid: boolean;
  issues: Array<{ path: string[]; code: string }>;
};

export type CustodySuitability = (
  tx: Transaction,
  req: { credential: string; platform: string },
) => void;

export type ApprovedModel = {
  id: string;
  reasoning_levels: readonly string[];
};

export type ApprovedModelsFn = (
  tx: Transaction,
  credentialName: string,
) => readonly ApprovedModel[] | null;

export type ProviderHealthCheckFn = (
  tx: Transaction,
  credentialName: string,
) => ResourceCheck;

export type ProviderCapabilityFn = (
  tx: Transaction,
  credentialName: string,
) => string;

export type EntriesOfAgent = (
  tx: Transaction,
  agentName: string,
) => AgentDependentBinding[];

export const ToolSource = {
  Host: "host",
  Builtin: "builtin",
  KanthordMcp: "kanthord-mcp",
} as const;
export type ToolSource = (typeof ToolSource)[keyof typeof ToolSource];

export const toolDeclarationSchema = z.strictObject({
  name: z.string().min(1),
  source: z.enum(ToolSource),
  input_schema: z.record(z.string(), z.unknown()),
});
export type ToolDeclaration = z.infer<typeof toolDeclarationSchema>;

export type ToolDeclarationsFn = (
  agentName: string,
) => Promise<ToolDeclaration[]>;

export const OPENAI_COMPATIBLE_PROVIDER = "openai-compatible";
export type AgentProviderKind =
  | KnownProvider
  | typeof OPENAI_COMPATIBLE_PROVIDER
  | typeof ANTHROPIC_SUBSCRIPTION_PLATFORM;
const BUILTIN_PROVIDERS = [
  "amazon-bedrock",
  "ant-ling",
  "anthropic",
  ANTHROPIC_SUBSCRIPTION_PLATFORM,
  "azure",
  "baseten",
  "cerebras",
  "cloudflare-ai-gateway",
  "cloudflare-workers-ai",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "meta",
  "minimax",
  "minimax-cn",
  "mistral",
  "moonshotai",
  "moonshotai-cn",
  "nvidia",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "radius",
  "together",
  "typesafe",
  "vercel-ai-gateway",
  "xai",
  "xiaomi",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-sgp",
  "zai",
  "zai-coding-cn",
] as const satisfies readonly Exclude<
  AgentProviderKind,
  typeof OPENAI_COMPATIBLE_PROVIDER
>[];
export const agentProviderKindSchema = z.enum([
  OPENAI_COMPATIBLE_PROVIDER,
  ...BUILTIN_PROVIDERS,
] as [AgentProviderKind, ...AgentProviderKind[]]);

export const reasoningEffortSchema = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const agentProviderItemSchema = z.strictObject({
  name: z.string().min(1),
  provider: agentProviderKindSchema,
  credential: z.string().min(1),
});

export const defaultConfigurationSchema = z.strictObject({
  agent_provider: z.string().min(1),
  model_identifier: z.string().min(1),
  reasoning_effort: reasoningEffortSchema,
});

export const fallbackConfigurationsSchema = z
  .array(defaultConfigurationSchema)
  .max(FALLBACK_CONFIGURATIONS_MAX);

export const agentEnablementSchema = z.strictObject({
  agent_name: z.string(),
  state: z.enum(["enabled", "disabled"]),
  agent_providers: z.array(agentProviderItemSchema),
  default_configuration: defaultConfigurationSchema,
  fallback_configurations: fallbackConfigurationsSchema,
  revision: z.number().int().positive(),
});

export const agentCooldownSchema = z.strictObject({
  credential: z.string().min(1),
  holder: z.string().min(1),
  strikes: z.number().int().positive(),
  available_at: z.number().int().nonnegative(),
});

export const CONFIGURATION_DESCRIPTION =
  "The Agent component validates the whole configuration. `model_identifier` belongs to `getBuiltinModels(provider)` of pi-ai 0.86.0 or to the `models` metadata of the `openai-compatible` credential. `reasoning_effort` belongs to the supported reasoning levels of that model. JSON Schema validates neither lookup.";
export const effectiveConfigurationSchema = z
  .strictObject({
    agent_provider: z.string().min(1),
    provider: agentProviderKindSchema,
    credential: z.string().min(1),
    model_identifier: z.string().min(1),
    reasoning_effort: reasoningEffortSchema,
  })
  .describe(CONFIGURATION_DESCRIPTION);

export const agentModelSchema = z.strictObject({
  model_identifier: z.string().min(1),
  reasoning_efforts: z.array(reasoningEffortSchema),
});

export const promptPartSchema = z.strictObject({
  part: z.enum(PromptPart),
  name: z.string().min(1),
  origin: z.enum(PromptOrigin),
  path: z.string().nullable(),
  digest: z.string(),
  text: z.string(),
});
export type PromptPartAnswer = z.infer<typeof promptPartSchema>;

export const promptAnswerSchema = z.strictObject({
  parts: z.array(promptPartSchema).optional(),
  final: z.string(),
});

export const chainEntrySchema = agentSelectionSchema
  .omit({ agent_name: true })
  .extend({
    cooldown: agentCooldownSchema
      .pick({ strikes: true, available_at: true })
      .nullable(),
  });

export const chainCoolingSchema = z.strictObject({
  code: z.literal(AgentErrorCode.ChainCooling),
  available_at: z.number().int().nonnegative(),
});

export const agentDeclarationSchema = z.strictObject({
  agent_name: z.string().min(1),
  configuration_schema: z.record(z.string(), z.unknown()),
  overridable_fields: z.array(z.string()),
  prompt: promptAnswerSchema,
  tools: z.array(toolDeclarationSchema),
  enablement: agentEnablementSchema.nullable(),
  chain: z.array(chainEntrySchema),
  active_position: z.number().int().nonnegative().nullable(),
  cooling: chainCoolingSchema.nullable(),
});

const emptyFields = z.strictObject({});
const agentParams = z.strictObject({ agent_name: z.string().min(1) });
const revisionBody = z.strictObject({
  expected_revision: z.number().int().positive(),
});
const enablementOperation = {
  service: AGENT_COMPONENT_NAME,
  store: StoreName.Operational,
  lifetime: OperationLifetime.Unary,
  access: AccessPolicy.Human,
  timeoutMs: ENABLEMENT_TIMEOUT_MS,
  status: HttpStatus.OK,
  output: agentEnablementSchema,
} as const;
const enablementMutation = {
  ...enablementOperation,
  mutation: true,
  body: true,
  maxBodyBytes: ENABLEMENT_MAX_BODY_BYTES,
  input: z.strictObject({
    params: agentParams,
    query: emptyFields,
    body: revisionBody,
  }),
} as const;

export const agentOperations = {
  "enablement.list": {
    ...enablementOperation,
    id: "agent.enablement.list",
    method: HttpMethod.Get,
    path: "/api/agent/enablement",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(LIST_LIMIT_MAX)
          .default(LIST_LIMIT_DEFAULT),
        cursor: z.string().min(1).optional(),
      }),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(agentEnablementSchema),
      next_cursor: z.string().nullable(),
    }),
    description: "List agent enablements in ascending agent-name order.",
  },
  get: {
    ...enablementOperation,
    id: "agent.get",
    method: HttpMethod.Get,
    path: "/api/agent/:agent_name",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: agentParams,
      query: z
        .strictObject({
          view: z.enum(PromptView).optional(),
          project_id: z.string().min(1).optional(),
          binding_id: z.string().min(1).optional(),
        })
        .refine(
          ({ project_id, binding_id }) =>
            (project_id === undefined) === (binding_id === undefined),
          {
            path: ["binding_id"],
            message: "The queries project_id and binding_id go together.",
          },
        ),
      body: z.null(),
    }),
    output: agentDeclarationSchema,
    description:
      "Get an agent declaration, its current enablement and the chain view of that enablement.",
  },
  "enablement.get": {
    ...enablementOperation,
    id: "agent.enablement.get",
    method: HttpMethod.Get,
    path: "/api/agent/enablement/:agent_name",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.null(),
    }),
    description: "Get a live agent enablement.",
  },
  "enablement.put": {
    ...enablementMutation,
    id: "agent.enablement.put",
    method: HttpMethod.Put,
    path: "/api/agent/enablement/:agent_name",
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.strictObject({
        expected_revision: z.number().int().positive().optional(),
        agent_providers: z.array(agentProviderItemSchema).min(1),
        default_configuration: defaultConfigurationSchema,
        fallback_configurations: fallbackConfigurationsSchema,
      }),
    }),
    description:
      "Create or replace an agent enablement at its expected revision.",
  },
  "enablement.enable": {
    ...enablementMutation,
    id: "agent.enablement.enable",
    method: HttpMethod.Post,
    path: "/api/agent/enablement/:agent_name/enable",
    description: "Validate and enable an existing agent enablement.",
  },
  "enablement.disable": {
    ...enablementMutation,
    id: "agent.enablement.disable",
    method: HttpMethod.Post,
    path: "/api/agent/enablement/:agent_name/disable",
    description:
      "Disable an agent enablement without validating dependent bindings.",
  },
  "enablement.remove": {
    ...enablementMutation,
    id: "agent.enablement.remove",
    method: HttpMethod.Delete,
    path: "/api/agent/enablement/:agent_name",
    output: z.strictObject({
      agent_name: z.string(),
      removed: z.literal(true),
    }),
    description: "Remove an agent enablement with no dependent bindings.",
  },
  "enablement.provider.add": {
    ...enablementMutation,
    id: "agent.enablement.provider.add",
    method: HttpMethod.Post,
    path: "/api/agent/enablement/:agent_name/provider",
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.strictObject({
        expected_revision: z.number().int().positive(),
        name: z.string().min(1),
        provider: agentProviderKindSchema,
        credential: z.string().min(1),
      }),
    }),
    description: "Append a named provider to an agent enablement.",
  },
  "enablement.provider.remove": {
    ...enablementMutation,
    id: "agent.enablement.provider.remove",
    method: HttpMethod.Delete,
    path: "/api/agent/enablement/:agent_name/provider/:provider_name",
    input: z.strictObject({
      params: z.strictObject({
        agent_name: z.string().min(1),
        provider_name: z.string().min(1),
      }),
      query: emptyFields,
      body: revisionBody,
    }),
    description:
      "Remove an unused named provider, retaining at least one provider.",
  },
  "enablement.provider.model.list": {
    ...enablementOperation,
    id: "agent.enablement.provider.model.list",
    method: HttpMethod.Get,
    path: "/api/agent/enablement/:agent_name/provider/:provider_name/model",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: z.strictObject({
        agent_name: z.string().min(1),
        provider_name: z.string().min(1),
      }),
      query: emptyFields,
      body: z.null(),
    }),
    output: z.strictObject({ items: z.array(agentModelSchema) }),
    description:
      "List the models and reasoning efforts of one agent provider of an agent enablement.",
  },
  "model.list": {
    ...enablementOperation,
    id: "agent.model.list",
    method: HttpMethod.Get,
    path: "/api/agent/model",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: z.strictObject({
        provider: agentProviderKindSchema,
        credential: z.string().min(1),
      }),
      body: z.null(),
    }),
    output: z.strictObject({ items: z.array(agentModelSchema) }),
    description:
      "List the models and reasoning efforts of one credential for one agent provider kind, before an enablement names it.",
  },
  "cooldown.list": {
    ...enablementOperation,
    id: "agent.cooldown.list",
    method: HttpMethod.Get,
    path: "/api/agent/cooldown",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: z.null(),
    }),
    output: z.strictObject({ items: z.array(agentCooldownSchema) }),
    description:
      "List the credential copies that hold a cooldown, live and expired, ordered by credential name and holder.",
  },
  "cooldown.clear": {
    ...enablementOperation,
    id: "agent.cooldown.clear",
    method: HttpMethod.Delete,
    path: "/api/agent/cooldown/:credential",
    mutation: true,
    body: false,
    status: HttpStatus.NoContent,
    input: z.strictObject({
      params: z.strictObject({ credential: z.string().min(1) }),
      query: z.strictObject({
        holder: z.string().min(1).default(SERVER_HOLDER),
      }),
      body: z.null(),
    }),
    output: z.null(),
    description:
      "Clear the cooldown of one credential copy so that the next claim can select its chain entries again. The holder defaults to server.",
  },
} as const satisfies Record<string, Operation>;
