import { z } from "zod";
import { identitySchema } from "../kernel/identity.ts";
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
export const WorkerHost = {
  Kanthord: "kanthord",
  ExternalHarness: "external-harness",
} as const;
export type WorkerHost = (typeof WorkerHost)[keyof typeof WorkerHost];
export const WorkerMethod = {
  Steps: "steps",
  Evaluation: "evaluation",
} as const;
export type WorkerMethod = (typeof WorkerMethod)[keyof typeof WorkerMethod];
export interface VerifiedClient {
  clientId: string;
  name: string;
  resourceIdentity: string;
  projectId: string;
}
export interface Registration extends VerifiedClient {
  runtimeIdentity: string;
  registeredAt: number;
}
export type WorkerBindingOf = (
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
) => {
  bindingId: string;
  revision: number;
  workerName: string;
  instanceCount: number;
  resourceBudget: { turns: number; wallTimeMs: number } | null;
  entries: Array<WorkerEntry & { agent: string }>;
  tombstone: boolean;
} | null;

export const InstanceActivity = {
  Idle: "idle",
  Pulling: "pulling",
  Executing: "executing",
} as const;
export type InstanceActivity =
  (typeof InstanceActivity)[keyof typeof InstanceActivity];
export const InstancePlacement = {
  Server: "server",
  Worker: "worker",
} as const;
export const workerResourceIdentitySchema = z
  .string()
  .regex(/^worker:kanthord:[a-z][a-z0-9-]{0,62}$/);
export const instanceRecordSchema = z.strictObject({
  runtimeIdentity: identitySchema("worker_instance"),
  projectId: identitySchema("project"),
  resourceIdentity: workerResourceIdentitySchema,
  workerName: z.string().min(1),
  host: z.enum(WorkerHost),
  placement: z.enum(InstancePlacement).optional(),
  clientId: identitySchema("client_identity").optional(),
  name: z.string().min(1).max(64).optional(),
  activity: z.enum(InstanceActivity),
  draining: z.boolean(),
  executionId: identitySchema("execution").optional(),
  registered: z.boolean(),
});

export interface SchedulerClaims {
  runningExecutionOfRuntime(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): { executionId: string } | null;
  activityOf(
    tx: Transaction,
    runtimeIdentity: string,
    now: number,
  ): { activity: InstanceActivity; executionId: string | null };
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
export const REGISTRATION_CAPABILITY = "liveness of a registration";

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
  deregister(tx: Transaction, runtimeIdentity: string, now: number): void;
  register(
    transaction: Transaction,
    client: VerifiedClient,
    now: number,
  ): Registration;
  findByClient(clientId: string): Registration | undefined;
  liveRegistrationOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): Registration | null;
  clientAttributionOf(
    tx: Transaction,
    runtimeIdentity: string,
  ): { clientId: string; name: string } | null;
  heartbeat(runtimeIdentity: string): void;
}

export const WORKER_SERVICE_NAME = "worker";
export const ENABLEMENT_MAX_BODY_BYTES = 64 * 1024;
export const ENABLEMENT_TIMEOUT_MS = 30000;
export const LIST_LIMIT_DEFAULT = 100;
export const LIST_LIMIT_MAX = 1000;

export const WorkerErrorCode = {
  InstanceNotFound: "worker.instance.not_found",
  NoLiveExecution: "worker.instance.no_live_execution",
  ClientLive: "worker.instance.client_live",
  BindingUnknown: "worker.instance.binding_unknown",
  SlotUnavailable: "worker.instance.slot_unavailable",
  CatalogNotFound: "worker.catalog.not_found",
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
export const catalogItemSchema = z.strictObject({
  name: z.string().min(1),
  host: z.enum(WorkerHost),
  declaredNodeStates: z.array(z.string()),
  requiredNodeFormat: z.array(z.string()),
});
const resourceBudgetSchema = z.strictObject({
  wallTimeMs: z.number().int().positive(),
  turns: z.number().int().positive().optional(),
});
export const catalogEntrySchema = z.discriminatedUnion("host", [
  catalogItemSchema.extend({
    host: z.literal(WorkerHost.Kanthord),
    method: z.enum(WorkerMethod),
    agentName: z.string().min(1),
    resourceBudget: resourceBudgetSchema,
  }),
  catalogItemSchema.extend({
    host: z.literal(WorkerHost.ExternalHarness),
    harness: z.string().min(1),
    resourceBudget: resourceBudgetSchema,
  }),
]);

const emptyFields = z.strictObject({});
const runtimeIdentityParams = z.strictObject({
  runtimeIdentity: identitySchema("worker_instance"),
});
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
  "instance.list": {
    ...enablementOperation,
    id: "worker.instance.list",
    method: HttpMethod.Get,
    path: "/api/worker/instance",
    mutation: false,
    input: z.strictObject({
      params: emptyFields,
      query: z
        .strictObject({
          projectId: identitySchema("project").optional(),
          resourceIdentity: workerResourceIdentitySchema.optional(),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(LIST_LIMIT_MAX)
            .default(LIST_LIMIT_DEFAULT),
          cursor: z.string().min(1).optional(),
        })
        .refine(
          (query) =>
            query.resourceIdentity === undefined ||
            query.projectId !== undefined,
          { message: "resourceIdentity requires projectId" },
        ),
      body: z.null(),
    }),
    output: z.strictObject({
      items: z.array(instanceRecordSchema),
      nextCursor: z.string().nullable(),
    }),
    description:
      "Page live registrations in descending runtime identity order without changing runtime state.",
  },
  "instance.get": {
    ...enablementOperation,
    id: "worker.instance.get",
    method: HttpMethod.Get,
    path: "/api/worker/instance/:runtimeIdentity",
    mutation: false,
    input: z.strictObject({
      params: runtimeIdentityParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: instanceRecordSchema,
    description:
      "Read a live instance record. Unknown and ended instances answer not found.",
  },
  "catalog.list": {
    ...enablementOperation,
    id: "worker.catalog.list",
    method: HttpMethod.Get,
    path: "/api/worker/catalog",
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
      items: z.array(catalogItemSchema),
      nextCursor: z.string().nullable(),
    }),
    description: "List supplied workers in ascending worker-name order.",
  },
  "catalog.get": {
    ...enablementOperation,
    id: "worker.catalog.get",
    method: HttpMethod.Get,
    path: "/api/worker/catalog/:workerName",
    mutation: false,
    body: false,
    input: z.strictObject({
      params: z.strictObject({ workerName: z.string().min(1) }),
      query: emptyFields,
      body: z.null(),
    }),
    output: catalogEntrySchema,
    description: "Get a supplied worker declaration.",
  },
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
  heartbeat: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.heartbeat",
    method: HttpMethod.Post,
    path: "/api/worker/heartbeat",
    access: AccessPolicy.Client,
    timeoutMs: 30000,
    mutation: false,
    status: HttpStatus.NoContent,
    input: emptyInput,
    output: z.null(),
    description:
      "Renew the live registration heartbeat with an authenticated empty request.",
  },
  "instance.deregister": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.instance.deregister",
    method: HttpMethod.Delete,
    path: "/api/worker/instance/:runtimeIdentity",
    access: AccessPolicy.Client,
    requiresRegistration: false,
    timeoutMs: 30000,
    mutation: true,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: runtimeIdentityParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: runtimeIdentityParams.extend({ registered: z.literal(false) }),
    description:
      "End the caller's named live registration and free its slot atomically. Same-key retries replay the recorded answer after the end.",
  },
  "instance.resume": {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.instance.resume",
    method: HttpMethod.Post,
    path: "/api/worker/instance/:runtimeIdentity/resume",
    access: AccessPolicy.Human,
    timeoutMs: 30000,
    mutation: true,
    status: HttpStatus.OK,
    input: z.strictObject({
      params: runtimeIdentityParams,
      query: emptyFields,
      body: z.null(),
    }),
    output: runtimeIdentityParams.extend({ registered: z.literal(true) }),
    description:
      "Resume an ended registration with a running execution and an available slot. A live registration is unchanged.",
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
      runtimeIdentity: identitySchema("worker_instance"),
    }),
    description:
      "Register a worker instance with a bearer machine JWT and an empty body. A client identity with a live registration receives that runtime identity with any key. A recorded replay after the registration ends answers 409 gateway.registration.stale. Admission and the binding instance count share one transaction.",
  },
} as const satisfies Record<string, Operation>;
