import { z } from "zod";
import {
  AccessPolicy,
  StoreName,
  OperationLifetime,
  emptyInput,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
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
export const workerOperations = {
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
