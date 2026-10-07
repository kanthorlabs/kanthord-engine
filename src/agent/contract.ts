import { z } from "zod";
import type { KnownProvider } from "@earendil-works/pi-ai";
import { getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import type { ResourceCheck } from "../kernel/health.ts";
import {
  AccessPolicy,
  OperationLifetime,
  StoreName,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { WorkingLayer } from "../project/contract.ts";

export const AGENT_COMPONENT_NAME = "agent";
export const ENABLEMENT_MAX_BODY_BYTES = 64 * 1024;
export const ENABLEMENT_TIMEOUT_MS = 30000;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;
export const AGENT_PROVIDER_TARGET_KIND = "agent-provider";

export const PROMPT_MAX_BODY_BYTES = 64 * 1024;
export const PROMPT_TEXT_MAX_BYTES = 32768;

export const PromptScope = {
  System: "system",
  Agent: "agent",
  Workbench: "workbench",
} as const;
export type PromptScope = (typeof PromptScope)[keyof typeof PromptScope];

export const SystemPromptSource = {
  HostFile: "host_file",
  Base: "base",
  Custom: "custom",
} as const;
export const AgentPromptSource = {
  AgentFile: "agent_file",
  Shipped: "shipped",
  Custom: "custom",
} as const;
export const WorkbenchPromptSource = {
  AgentsMd: "agents_md",
  AgentsLocalMd: "agents_local_md",
  ClaudeMd: "claude_md",
  ClaudeLocalMd: "claude_local_md",
  Shipped: "shipped",
  Custom: "custom",
} as const;

export const PromptLayerKind = {
  System: "system",
  Agent: "agent",
  Working: "working",
} as const;
export type PromptLayerKind =
  (typeof PromptLayerKind)[keyof typeof PromptLayerKind];

export const PromptOrigin = {
  Binary: "binary",
  File: "file",
  Database: "database",
} as const;
export type PromptOrigin = (typeof PromptOrigin)[keyof typeof PromptOrigin];

export const PromptSourceState = {
  Present: "present",
  Absent: "absent",
  Invalid: "invalid",
  Off: "off",
  Deferred: "deferred",
} as const;
export type PromptSourceState =
  (typeof PromptSourceState)[keyof typeof PromptSourceState];

export const PromptView = { Final: "final" } as const;
export type PromptView = (typeof PromptView)[keyof typeof PromptView];

export const SYSTEM_LAYER_SWITCH = "layer";

export const SystemLayerOverride = {
  Inherit: "inherit",
  On: "on",
  Off: "off",
} as const;
export type SystemLayerOverride =
  (typeof SystemLayerOverride)[keyof typeof SystemLayerOverride];

export const PROMPT_SWITCHES: Record<PromptScope, readonly string[]> = {
  [PromptScope.System]: [
    ...Object.values(SystemPromptSource),
    SYSTEM_LAYER_SWITCH,
  ],
  [PromptScope.Agent]: Object.values(AgentPromptSource),
  [PromptScope.Workbench]: Object.values(WorkbenchPromptSource),
};

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
  ModelUnknown: "agent.configuration.model_unknown",
  ReasoningUnsupported: "agent.configuration.reasoning_effort_unsupported",
  CredentialUnsuitable: "agent.configuration.credential_unsuitable",
  PromptRevisionConflict: "agent.prompt.revision_conflict",
  PromptTooLarge: "agent.prompt.too_large",
  PromptAgentLayerEmpty: "agent.prompt.agent_layer_empty",
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
};

export type AgentEnablement = {
  agent_name: string;
  state: string;
  agent_providers: AgentProviderItem[];
  default_configuration: DefaultConfiguration;
  revision: number;
};

export type AgentProviderDependent = {
  agent_name: string;
  provider_name: string;
};

export type AgentDependentBinding = {
  binding_id: string;
  worker_name: string;
  entry: AgentEntry | null;
};

export type AgentView = {
  defaults: DefaultConfiguration | null;
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

export type RepositoryWorkingOf = (
  tx: Transaction,
  bindingId: string,
) => {
  projectId: string;
  name: string;
  projectPrompt: string | null;
  workingLayer: WorkingLayer;
} | null;

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
  KnownProvider | typeof OPENAI_COMPATIBLE_PROVIDER;
export const agentProviderKindSchema = z.enum([
  OPENAI_COMPATIBLE_PROVIDER,
  ...getBuiltinProviders(),
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

export const agentEnablementSchema = z.strictObject({
  agent_name: z.string(),
  state: z.enum(["enabled", "disabled"]),
  agent_providers: z.array(agentProviderItemSchema),
  default_configuration: defaultConfigurationSchema,
  revision: z.number().int().positive(),
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

export const promptSourceSchema = z.strictObject({
  source: z.string().min(1),
  origin: z.enum(PromptOrigin),
  path: z.string().nullable(),
  enabled: z.boolean(),
  state: z.enum(PromptSourceState),
  digest: z.string().nullable(),
  text: z.string().nullable(),
});
export type PromptSource = z.infer<typeof promptSourceSchema>;

export const promptLayerSchema = z.strictObject({
  layer: z.enum(PromptLayerKind),
  enabled: z.boolean(),
  sources: z.array(promptSourceSchema),
});
export type PromptLayerAnswer = z.infer<typeof promptLayerSchema>;

export const promptAnswerSchema = z.strictObject({
  layers: z.array(promptLayerSchema).optional(),
  final: z.string(),
});

export const agentDeclarationSchema = z.strictObject({
  agent_name: z.string().min(1),
  configuration_schema: z.record(z.string(), z.unknown()),
  overridable_fields: z.array(z.string()),
  prompt: promptAnswerSchema,
  tools: z.array(toolDeclarationSchema),
  enablement: agentEnablementSchema.nullable(),
});

export const promptSettingsSchema = z.strictObject({
  scope: z.enum(PromptScope),
  agent_name: z.string(),
  switches: z.record(z.string(), z.boolean()),
  custom_text: z.string(),
  system_layer: z.enum(SystemLayerOverride).nullable(),
  revision: z.number().int().nonnegative(),
});
export type PromptSettings = z.infer<typeof promptSettingsSchema>;

const promptSwitchNames = [
  ...new Set(Object.values(PROMPT_SWITCHES).flat()),
] as [string, ...string[]];
const promptTarget = {
  scope: z.enum(PromptScope),
  agent_name: z.string().min(1).optional(),
  expected_revision: z.number().int().positive().optional(),
};

function checkPromptSwitch(
  body: {
    scope: PromptScope;
    switch?: string;
    enabled?: boolean;
    system_layer?: SystemLayerOverride;
  },
  context: z.core.$RefinementCtx,
): void {
  const partial = body.switch !== undefined || body.enabled !== undefined;
  const source = body.switch !== undefined && body.enabled !== undefined;
  const override = body.system_layer !== undefined;
  if (!(source && !override) && !(override && !partial))
    context.addIssue({
      code: "custom",
      path: ["switch"],
      message: "The body takes either switch with enabled, or system_layer.",
    });
  if (override && body.scope !== PromptScope.Agent)
    context.addIssue({
      code: "custom",
      path: ["system_layer"],
      message: "The system layer override belongs to the agent scope.",
    });
}

function checkPromptTarget(
  body: { scope: PromptScope; agent_name?: string; switch?: string },
  context: z.core.$RefinementCtx,
): void {
  const system = body.scope === PromptScope.System;
  if (system === (body.agent_name !== undefined))
    context.addIssue({
      code: "custom",
      path: ["agent_name"],
      message: system
        ? "The system scope takes no agent name."
        : "The scope requires an agent name.",
    });
  if (
    body.switch !== undefined &&
    !PROMPT_SWITCHES[body.scope].includes(body.switch)
  )
    context.addIssue({
      code: "custom",
      path: ["switch"],
      message: "The switch is not a source of the scope.",
    });
}

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
    description: "Get an agent declaration and its current enablement.",
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
  "prompt.put": {
    ...enablementMutation,
    id: "agent.prompt.put",
    method: HttpMethod.Put,
    path: "/api/agent/prompt",
    maxBodyBytes: PROMPT_MAX_BODY_BYTES,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: z
        .strictObject({ ...promptTarget, custom_text: z.string() })
        .superRefine(checkPromptTarget),
    }),
    output: promptSettingsSchema,
    description:
      "Replace the custom text of one prompt scope at its expected revision.",
  },
  "prompt.switch": {
    ...enablementMutation,
    id: "agent.prompt.switch",
    method: HttpMethod.Post,
    path: "/api/agent/prompt/switch",
    maxBodyBytes: PROMPT_MAX_BODY_BYTES,
    input: z.strictObject({
      params: emptyFields,
      query: emptyFields,
      body: z
        .strictObject({
          ...promptTarget,
          switch: z.enum(promptSwitchNames).optional(),
          enabled: z.boolean().optional(),
          system_layer: z.enum(SystemLayerOverride).optional(),
        })
        .superRefine(checkPromptTarget)
        .superRefine(checkPromptSwitch),
    }),
    output: promptSettingsSchema,
    description:
      "Set one switch of one prompt scope, or the system layer override of one agent scope, at its expected revision.",
  },
  "prompt.get": {
    ...enablementOperation,
    id: "agent.prompt.get",
    method: HttpMethod.Get,
    path: "/api/agent/prompt",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: emptyFields,
      query: z
        .strictObject({
          scope: z.enum(PromptScope),
          agent_name: z.string().min(1).optional(),
        })
        .superRefine(checkPromptTarget),
      body: z.null(),
    }),
    output: promptSettingsSchema,
    description:
      "Read the switches, the custom text and the system layer override of one prompt scope.",
  },
} as const satisfies Record<string, Operation>;
