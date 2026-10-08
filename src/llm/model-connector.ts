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
import { z } from "zod";
import { SecretShape } from "../custody/contract.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { SetupRefusal, WorkerErrorCode } from "../worker/contract.ts";
import {
  MODEL_DEFAULT_CONTEXT_WINDOW,
  MODEL_DEFAULT_MAX_TOKENS,
  MODEL_DEFAULT_REASONING_LEVELS,
  openaiCompatibleMetadataSchema,
  Platform,
  ReasoningLevel,
} from "./platforms.ts";

export const METADATA_ENV: Readonly<
  Partial<Record<Platform, Readonly<Record<string, string>>>>
> = {
  [Platform.AmazonBedrock]: { region: "AWS_REGION" },
  [Platform.GoogleVertex]: {
    project: "GOOGLE_CLOUD_PROJECT",
    location: "GOOGLE_CLOUD_LOCATION",
  },
  [Platform.Azure]: {
    resource_name: "AZURE_OPENAI_RESOURCE_NAME",
  },
  [Platform.CloudflareWorkersAI]: { account_id: "CLOUDFLARE_ACCOUNT_ID" },
  [Platform.CloudflareAIGateway]: {
    account_id: "CLOUDFLARE_ACCOUNT_ID",
    gateway_id: "CLOUDFLARE_GATEWAY_ID",
  },
};
const platformMetadataSchema = z.record(z.string(), z.string());
const NO_ENV = 0;

export type ModelConfiguration = {
  agent_provider: string;
  provider: string;
  model_identifier: string;
  reasoning_effort: ReasoningLevel;
};
export interface ModelConnectorInput {
  credentials: CredentialStore;
  handoverItem: { credential_id: string; provider_id: string };
  credentialId: string;
  configuration: ModelConfiguration;
  metadata: unknown;
  signal: AbortSignal;
}
export type ModelRuntimeModule = {
  ModelRuntime: Pick<typeof ModelRuntime, "create">;
};

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

function compatibleProvider(input: ModelConnectorInput) {
  const { configuration } = input;
  const metadata = openaiCompatibleMetadataSchema.parse(input.metadata);
  assert.equal(configuration.provider, Platform.OpenAICompatible);
  const models: Model<Api>[] = metadata.models.map((item) => {
    const levels = item.reasoning_levels ?? MODEL_DEFAULT_REASONING_LEVELS;
    const thinkingLevelMap: ThinkingLevelMap = Object.fromEntries(
      Object.values(ReasoningLevel).map((level) => [
        level,
        levels.includes(level) ? level : null,
      ]),
    );
    return {
      id: item.id,
      name: item.id,
      api: "openai-responses",
      provider: Platform.OpenAICompatible,
      baseUrl: metadata.base_url,
      reasoning: levels.some((level) => level !== ReasoningLevel.Off),
      thinkingLevelMap,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: item.context_window ?? MODEL_DEFAULT_CONTEXT_WINDOW,
      maxTokens: item.max_tokens ?? MODEL_DEFAULT_MAX_TOKENS,
    };
  });
  return createProvider({
    id: Platform.OpenAICompatible,
    name: configuration.agent_provider,
    baseUrl: metadata.base_url,
    auth: {
      apiKey: envApiKeyAuth(`${configuration.agent_provider} API key`, []),
    },
    models,
    api: openAIResponsesApi(),
  });
}

export function metadataEnv(
  provider: string,
  metadata: unknown,
): Record<string, string> {
  const names = METADATA_ENV[provider as Platform];
  if (!names) return {};
  const values = platformMetadataSchema.parse(metadata);
  return Object.fromEntries(
    Object.entries(names).map(([field, name]) => {
      const value = values[field];
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
  pi: ModelRuntimeModule,
  input: ModelConnectorInput,
): Promise<ModelRuntime> {
  const { credentials, handoverItem, configuration, signal } = input;
  assert.ok(credentials);
  assert.ok(signal);
  if (handoverItem.provider_id !== configuration.provider)
    refuse(SetupRefusal.CredentialAbsent);
  if (handoverItem.credential_id !== input.credentialId)
    refuse(SetupRefusal.CredentialRevisionMismatch);
  const runtime = await pi.ModelRuntime.create({
    credentials: withMetadataEnv(
      credentials,
      metadataEnv(configuration.provider, input.metadata),
    ),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
  });
  if (configuration.provider === Platform.OpenAICompatible)
    runtime.registerNativeProvider(compatibleProvider(input));
  return runtime;
}

export function resolveModel(
  runtime: ModelRuntime,
  configuration: ModelConfiguration,
): Model<Api> {
  assert.ok(runtime);
  assert.ok(configuration.model_identifier);
  const model = runtime.getModel(
    configuration.provider,
    configuration.model_identifier,
  );
  if (!model) refuse(SetupRefusal.ModelUnknown);
  if (
    !getSupportedThinkingLevels(model).includes(configuration.reasoning_effort)
  )
    refuse(SetupRefusal.ReasoningEffortUnsupported);
  return model;
}

export async function connectModel(
  pi: ModelRuntimeModule,
  input: ModelConnectorInput,
): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  assert.ok(input.configuration);
  assert.ok(input.credentials);
  const runtime = await createModelRuntime(pi, input);
  return { runtime, model: resolveModel(runtime, input.configuration) };
}
