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
  reasoningEffortSchema,
  SetupRefusal,
  WorkerErrorCode,
  type ExecutionSetup,
} from "./contract.ts";
import { AgentProviderKind } from "./enablements.ts";
import { loadPi } from "./pi.ts";

export const ADAPTER_ID: Record<AgentProviderKind, string> = {
  [AgentProviderKind.Anthropic]: "anthropic",
  [AgentProviderKind.GithubCopilot]: "github-copilot",
  [AgentProviderKind.OpenaiCodex]: "openai-codex",
  [AgentProviderKind.OpenaiCompatible]: "openai-compatible",
  [AgentProviderKind.Openrouter]: "openrouter",
};
const OFF = "off";
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
  const { metadata, effectiveConfiguration } = setup;
  assert.ok(metadata);
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
      provider: ADAPTER_ID[AgentProviderKind.OpenaiCompatible],
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
    id: ADAPTER_ID[AgentProviderKind.OpenaiCompatible],
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

export async function createModelRuntime(
  input: ModelRuntimeInput,
): Promise<ModelRuntime> {
  const { credentials, handoverItem, setup, signal } = input;
  assert.ok(credentials);
  assert.ok(signal);
  if (
    handoverItem.providerId !==
    ADAPTER_ID[setup.effectiveConfiguration.provider]
  )
    refuse(SetupRefusal.CredentialAbsent);
  if (handoverItem.credentialId !== setup.credentialId)
    refuse(SetupRefusal.CredentialRevisionMismatch);
  const runtime = await (
    await loadPi()
  ).ModelRuntime.create({
    credentials,
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
  const model = runtime.getModel(
    ADAPTER_ID[config.provider],
    config.modelIdentifier,
  );
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
