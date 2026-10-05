import assert from "node:assert/strict";
import {
  createProvider,
  envApiKeyAuth,
  getSupportedThinkingLevels,
  type Api,
  type CredentialStore,
  type Model,
  type ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { Diagnostic } from "../kernel/errors.ts";
import {
  compatibleMetadataSchema,
  platformMetadataSchema,
  reasoningEffortSchema,
  type AgentProviderKind as ProviderKind,
  SetupRefusal,
  WorkerErrorCode,
  type ExecutionSetup,
} from "./contract.ts";
import { SecretShape } from "../custody/contract.ts";
import { AgentProviderKind } from "./enablements.ts";
import { loadPi } from "./pi.ts";

export const METADATA_ENV: Readonly<
  Partial<Record<ProviderKind, Readonly<Record<string, string>>>>
> = {
  "amazon-bedrock": { region: "AWS_REGION" },
  "google-vertex": {
    project: "GOOGLE_CLOUD_PROJECT",
    location: "GOOGLE_CLOUD_LOCATION",
  },
  "azure-openai-responses": { resource_name: "AZURE_OPENAI_RESOURCE_NAME" },
  "cloudflare-workers-ai": { account_id: "CLOUDFLARE_ACCOUNT_ID" },
  "cloudflare-ai-gateway": {
    account_id: "CLOUDFLARE_ACCOUNT_ID",
    gateway_id: "CLOUDFLARE_GATEWAY_ID",
  },
};
const OFF = "off";
const NO_ENV = 0;
export interface ModelRuntimeInput {
  credentials: CredentialStore;
  handoverItem: { credentialId: string; providerId: string };
  setup: ExecutionSetup;
  signal: AbortSignal;
}
export type ModelRuntimeFactory = (
  input: ModelRuntimeInput,
) => Promise<{ runtime: ModelRuntime; model: Model<Api> }>;

function refuse(
  reason: (typeof SetupRefusal)[keyof typeof SetupRefusal],
): never {
  assert.ok(Object.values(SetupRefusal).includes(reason));
  assert.ok(WorkerErrorCode.RuntimeSetupRefused);
  throw Object.assign(
    new Diagnostic(
      WorkerErrorCode.RuntimeSetupRefused,
      `Native runtime setup refused: ${reason}.`,
    ),
    { details: { reason } },
  );
}

function compatibleProvider(setup: ExecutionSetup) {
  const { effectiveConfiguration } = setup;
  const metadata = compatibleMetadataSchema.parse(setup.metadata);
  assert.equal(
    effectiveConfiguration.provider,
    AgentProviderKind.OpenaiCompatible,
  );
  const models: Model<Api>[] = metadata.models.map((item) => {
    const levels = item.reasoningLevels ?? [OFF];
    const thinkingLevelMap: ThinkingLevelMap = Object.fromEntries(
      reasoningEffortSchema.options.map((level) => [
        level,
        levels.includes(level) ? level : null,
      ]),
    );
    return {
      id: item.id,
      name: item.id,
      api: "openai-responses",
      provider: AgentProviderKind.OpenaiCompatible,
      baseUrl: metadata.baseUrl,
      reasoning: levels.some((level) => level !== OFF),
      thinkingLevelMap,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: item.contextWindow ?? 128000,
      maxTokens: item.maxTokens ?? 16384,
    };
  });
  return createProvider({
    id: AgentProviderKind.OpenaiCompatible,
    name: effectiveConfiguration.agentProvider,
    baseUrl: metadata.baseUrl,
    auth: {
      apiKey: envApiKeyAuth(
        `${effectiveConfiguration.agentProvider} API key`,
        [],
      ),
    },
    models,
    api: openAIResponsesApi(),
  });
}

export function metadataEnv(setup: ExecutionSetup): Record<string, string> {
  const names = METADATA_ENV[setup.effectiveConfiguration.provider];
  if (!names) return {};
  const metadata = platformMetadataSchema.parse(setup.metadata);
  return Object.fromEntries(
    Object.entries(names).map(([field, name]) => {
      const value = metadata[field];
      assert.ok(value, `Credential metadata lacks ${field}.`);
      return [name, value];
    }),
  );
}

function withMetadataEnv(
  store: CredentialStore,
  env: Record<string, string>,
): CredentialStore {
  if (Object.keys(env).length === NO_ENV) return store;
  return {
    read: async (providerId, options) => {
      const credential = await store.read(providerId, options);
      if (credential?.type !== SecretShape.ApiKey) return credential;
      return { ...credential, env: { ...credential.env, ...env } };
    },
    list: (options) => store.list(options),
    modify: (providerId, fn, options) => store.modify(providerId, fn, options),
    delete: (providerId, options) => store.delete(providerId, options),
  };
}

export async function createModelRuntime(
  input: ModelRuntimeInput,
): Promise<ModelRuntime> {
  const { credentials, handoverItem, setup, signal } = input;
  assert.ok(credentials);
  assert.ok(signal);
  if (handoverItem.providerId !== setup.effectiveConfiguration.provider)
    refuse(SetupRefusal.CredentialAbsent);
  if (handoverItem.credentialId !== setup.credentialId)
    refuse(SetupRefusal.CredentialRevisionMismatch);
  const runtime = await (
    await loadPi()
  ).ModelRuntime.create({
    credentials: withMetadataEnv(credentials, metadataEnv(setup)),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  });
  if (
    setup.effectiveConfiguration.provider === AgentProviderKind.OpenaiCompatible
  )
    runtime.registerNativeProvider(compatibleProvider(setup));
  return runtime;
}

export function resolveModel(
  runtime: ModelRuntime,
  setup: ExecutionSetup,
): Model<Api> {
  assert.ok(runtime);
  assert.ok(setup.credentialId);
  const config = setup.effectiveConfiguration;
  const model = runtime.getModel(config.provider, config.modelIdentifier);
  if (!model) refuse(SetupRefusal.ModelUnknown);
  if (!getSupportedThinkingLevels(model).includes(config.reasoningEffort))
    refuse(SetupRefusal.ReasoningEffortUnsupported);
  return model;
}

export const defaultModelRuntimeFactory: ModelRuntimeFactory = async (
  input,
) => {
  assert.ok(input.setup);
  assert.ok(input.credentials);
  const runtime = await createModelRuntime(input);
  return { runtime, model: resolveModel(runtime, input.setup) };
};
