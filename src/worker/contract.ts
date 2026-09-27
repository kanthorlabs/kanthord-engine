import { z } from "zod";
import {
  AccessPolicy,
  StoreName,
  OperationLifetime,
  emptyInput,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { ResourceCheck } from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
export const MAX_RUNTIME_IDENTITY_LENGTH = 128;
export interface VerifiedClient {
  clientId: string;
  name: string;
  workerBindingId: string;
  projectId: string;
}
export interface Registration extends VerifiedClient {
  runtimeIdentity: string;
}

export type AgentProviderItem = {
  name: string;
  provider: string;
  credential: string;
};

export type DefaultConfiguration = {
  agentProvider: string;
  modelIdentifier: string;
  reasoningEffort: string;
};

export type WorkerEntry = {
  agentProvider?: string;
  modelIdentifier?: string;
  reasoningEffort?: string;
};

export type AgentEnablement = {
  agentName: string;
  state: string;
  agentProviders: AgentProviderItem[];
  defaultConfiguration: DefaultConfiguration;
  revision: number;
};

export type AgentProviderDependent = {
  agentName: string;
  providerName: string;
};

export type AgentDependentBinding = {
  bindingId: string;
  workerName: string;
  entry: WorkerEntry | null;
};

export type CustodySuitability = (
  tx: Transaction,
  req: { credential: string; platform: string },
) => void;

export type CredentialMetadataRecord = {
  id: string;
  name: string;
  platform: string;
  metadata: Record<string, unknown> | null;
};

export type CredentialMetadataFn = (
  tx: Transaction,
  credentialName: string,
) => CredentialMetadataRecord | null;

export const AGENT_PROVIDER_CAPABILITY = "model-list read";
export const AGENT_PROVIDER_TARGET_KIND = "agent-provider";

export type ModelListCheckFn = (
  tx: Transaction,
  credentialName: string,
) => ResourceCheck;

export type EntriesOfAgent = (
  tx: Transaction,
  agentName: string,
) => AgentDependentBinding[];

export const agentProviderKindSchema = z.enum([
  "github-copilot",
  "anthropic",
  "openai-compatible",
]);

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
  agentProvider: z.string().min(1),
  modelIdentifier: z.string().min(1),
  reasoningEffort: reasoningEffortSchema,
});

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

export type WorkerAgentsOfFn = (workerName: string) => string[];

export type WorkerAgentViewFn = (
  tx: Transaction,
  workerName: string,
  agentName: string,
  entry: WorkerEntry | null,
) => WorkerAgentView | null;

export interface WorkerRegistrations {
  register(transaction: Transaction, client: VerifiedClient): Registration;
  findByClient(clientId: string): Registration | undefined;
  deregister(runtimeIdentity: string): void;
}

export const WORKER_SERVICE_NAME = "worker";
export const ENABLEMENT_MAX_BODY_BYTES = 64 * 1024;
export const ENABLEMENT_TIMEOUT_MS = 30000;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;

export const WorkerErrorCode = {
  AgentNotFound: "worker.agent.not_found",
  NotFound: "worker.agent.enablement.not_found",
  RevisionConflict: "worker.agent.enablement.revision_conflict",
  Unavailable: "worker.agent.enablement.unavailable",
  InvalidatesBindings: "worker.agent.enablement.invalidates_bindings",
  InUse: "worker.agent.enablement.in_use",
  ProviderNameConflict: "worker.agent.enablement.provider.name_conflict",
  ProviderNotFound: "worker.agent.enablement.provider.not_found",
  ProviderFixed: "worker.agent.enablement.provider.fixed",
  ProviderInUse: "worker.agent.enablement.provider.in_use",
  ProviderRequired: "worker.agent.enablement.provider.required",
  OverrideNotAllowed: "worker.agent.configuration.override_not_allowed",
  InvalidConfiguration: "worker.agent.configuration.invalid",
  ModelUnknown: "worker.agent.configuration.model_unknown",
  ReasoningUnsupported:
    "worker.agent.configuration.reasoning_effort_unsupported",
  CredentialUnsuitable: "worker.agent.configuration.credential_unsuitable",
} as const;

export const agentEnablementSchema = z.strictObject({
  agentName: z.string(),
  state: z.enum(["enabled", "disabled"]),
  agentProviders: z.array(agentProviderItemSchema),
  defaultConfiguration: defaultConfigurationSchema,
  revision: z.number().int().positive(),
});
const agentParams = z.strictObject({ agentName: z.string().min(1) });
const emptyFields = z.strictObject({});
const revisionBody = z.strictObject({
  expectedRevision: z.number().int().positive(),
});
const enablementOperation = {
  service: WORKER_SERVICE_NAME,
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

export const workerOperations = {
  "agent.enablement.list": {
    ...enablementOperation,
    id: "worker.agent.enablement.list",
    method: HttpMethod.Get,
    path: "/api/worker/agent/enablement",
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
      nextCursor: z.string().nullable(),
    }),
    description: "List agent enablements in ascending agent-name order.",
  },
  "agent.enablement.get": {
    ...enablementOperation,
    id: "worker.agent.enablement.get",
    method: HttpMethod.Get,
    path: "/api/worker/agent/enablement/:agentName",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.null(),
    }),
    description: "Get a live agent enablement.",
  },
  "agent.enablement.put": {
    ...enablementMutation,
    id: "worker.agent.enablement.put",
    method: HttpMethod.Put,
    path: "/api/worker/agent/enablement/:agentName",
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.strictObject({
        expectedRevision: z.number().int().positive().optional(),
        agentProviders: z.array(agentProviderItemSchema).min(1),
        defaultConfiguration: defaultConfigurationSchema,
      }),
    }),
    description:
      "Create or replace an agent enablement at its expected revision.",
  },
  "agent.enablement.enable": {
    ...enablementMutation,
    id: "worker.agent.enablement.enable",
    method: HttpMethod.Post,
    path: "/api/worker/agent/enablement/:agentName/enable",
    description: "Validate and enable an existing agent enablement.",
  },
  "agent.enablement.disable": {
    ...enablementMutation,
    id: "worker.agent.enablement.disable",
    method: HttpMethod.Post,
    path: "/api/worker/agent/enablement/:agentName/disable",
    description:
      "Disable an agent enablement without validating dependent bindings.",
  },
  "agent.enablement.remove": {
    ...enablementMutation,
    id: "worker.agent.enablement.remove",
    method: HttpMethod.Delete,
    path: "/api/worker/agent/enablement/:agentName",
    output: z.strictObject({ agentName: z.string(), removed: z.literal(true) }),
    description: "Remove an agent enablement with no dependent bindings.",
  },
  "agent.enablement.provider.add": {
    ...enablementMutation,
    id: "worker.agent.enablement.provider.add",
    method: HttpMethod.Post,
    path: "/api/worker/agent/enablement/:agentName/provider",
    input: z.strictObject({
      params: agentParams,
      query: emptyFields,
      body: z.strictObject({
        expectedRevision: z.number().int().positive(),
        name: z.string().min(1),
        provider: agentProviderKindSchema,
        credential: z.string().min(1),
      }),
    }),
    description: "Append a named provider to an agent enablement.",
  },
  "agent.enablement.provider.remove": {
    ...enablementMutation,
    id: "worker.agent.enablement.provider.remove",
    method: HttpMethod.Delete,
    path: "/api/worker/agent/enablement/:agentName/provider/:providerName",
    input: z.strictObject({
      params: z.strictObject({
        agentName: z.string().min(1),
        providerName: z.string().min(1),
      }),
      query: emptyFields,
      body: revisionBody,
    }),
    description:
      "Remove an unused named provider, retaining at least one provider.",
  },
  register: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.register",
    method: HttpMethod.Post,
    path: "/api/worker/register",
    access: AccessPolicy.Client,
    requiresRegistration: false,
    timeoutMs: 10000,
    mutation: true,
    maxBodyBytes: 40 * 1024,
    status: HttpStatus.OK,
    input: emptyInput,
    output: z.strictObject({
      runtimeIdentity: z
        .string()
        .min(1)
        .max(MAX_RUNTIME_IDENTITY_LENGTH)
        .refine((value) => !!value.trim()),
    }),
    description:
      "Register a worker instance with a bearer machine JWT and an empty body. Returns its runtime identity, not a token. A client identity holds at most one live registration. Repeating the key replays that identity while live; a replay after the registration ends answers 409. Cancellation does not deregister an accepted registration.",
  },
} as const satisfies Record<string, Operation>;
