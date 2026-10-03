import assert from "node:assert/strict";
import {
  createFauxCore,
  createProvider,
  envApiKeyAuth,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type StreamFunction,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";
import type { ExecutionSetup } from "./contract.ts";
import {
  createModelRuntime,
  resolveModel,
  type ModelRuntimeFactory,
} from "./model-runtime.ts";
export {
  fauxAssistantMessage,
  fauxToolCall,
  fauxText,
} from "@earendil-works/pi-ai";

export function scriptedProvider(
  script: FauxResponseStep[],
  options = { providerId: "anthropic", modelIdentifier: "claude-sonnet-4-5" },
) {
  assert.ok(options.providerId);
  assert.ok(options.modelIdentifier);
  const calls: {
    systemPrompt: ModelContext["systemPrompt"];
    messages: ModelContext["messages"];
    apiKey: string | undefined;
  }[] = [];
  const core = createFauxCore({
    provider: options.providerId,
    models: [{ id: options.modelIdentifier, reasoning: false }],
  });
  const record =
    (
      stream: StreamFunction<string, SimpleStreamOptions>,
    ): StreamFunction<string, SimpleStreamOptions> =>
    (model, context, streamOptions) => {
      const systemRole = "system";
      const leading = context.messages[0];
      const systemPrompt =
        leading?.role === systemRole
          ? Array.isArray(leading.content)
            ? leading.content.map(({ text }) => text).join("\n")
            : leading.content
          : undefined;
      calls.push({
        systemPrompt,
        messages: structuredClone(context.messages),
        apiKey: streamOptions?.apiKey,
      });
      return stream(model, context, streamOptions);
    };
  const provider = createProvider({
    id: options.providerId,
    auth: { apiKey: envApiKeyAuth("scripted API key", []) },
    models: core.models,
    api: {
      stream: record(core.stream),
      streamSimple: record(core.streamSimple),
    },
  });
  core.setResponses(script);
  return { provider, calls };
}
export type ScriptedProvider = ReturnType<typeof scriptedProvider>;

export function scriptedModelRuntime(
  provider: ScriptedProvider,
): ModelRuntimeFactory {
  assert.ok(provider.provider);
  assert.ok(provider.calls);
  return async (input) => {
    const runtime = await createModelRuntime(input);
    runtime.registerNativeProvider(provider.provider);
    return { runtime, model: resolveModel(runtime, input.setup) };
  };
}

export function anthropicSetup(
  overrides: Partial<ExecutionSetup> = {},
): ExecutionSetup {
  const setup: ExecutionSetup = {
    executionId: "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    workerName: "general@1",
    agentName: "swe@1",
    credentialId: "credential_01ARZ3NDEKTSV4RRFFQ69G5FAA",
    effectiveConfiguration: {
      agentProvider: "default",
      provider: "anthropic",
      credential: "anthro-1",
      modelIdentifier: "claude-sonnet-4-5",
      reasoningEffort: "off",
    },
    metadata: null,
    resourceBudget: { turns: 200, wallTimeMs: 7200000 },
    repositories: [],
    globalPrompt: { state: "absent" },
    ...overrides,
  };
  assert.ok(setup.credentialId);
  assert.ok(setup.executionId);
  return setup;
}
