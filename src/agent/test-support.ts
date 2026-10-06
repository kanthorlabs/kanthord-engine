import assert from "node:assert/strict";
import {
  createFauxCore,
  createProvider,
  envApiKeyAuth,
  getSystemMessageText,
  type FauxResponseStep,
  type SimpleStreamOptions,
  type StreamFunction,
  type Context as ModelContext,
} from "@earendil-works/pi-ai";

export function scriptedProvider(
  script: FauxResponseStep[],
  options: {
    providerId: string;
    modelIdentifier: string;
    models?: { id: string; reasoning: boolean }[];
  } = { providerId: "anthropic", modelIdentifier: "claude-sonnet-4-5" },
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
    models: options.models ?? [
      { id: options.modelIdentifier, reasoning: false },
    ],
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
          ? getSystemMessageText(leading)
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
