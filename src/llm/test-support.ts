import {
  createFauxCore,
  createProvider,
  envApiKeyAuth,
  type FauxResponseStep,
  getCurrentTools,
  type Message,
  type OAuthAuth,
  type SimpleStreamOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import type { ModelRuntimeModule } from "./model-connector.ts";

export type ScriptedCall = {
  messages: Message[];
  tools: string[];
  options: SimpleStreamOptions | undefined;
};

export function scriptedModelRuntime(
  pi: ModelRuntimeModule,
  script: FauxResponseStep[],
  options: {
    providerId?: string;
    models?: { id: string; reasoning: boolean }[];
    oauth?: OAuthAuth;
  } = {},
) {
  const providerId = options.providerId ?? "anthropic";
  const core = createFauxCore({
    provider: providerId,
    models: options.models ?? [{ id: "scripted-model", reasoning: true }],
  });
  const calls: ScriptedCall[] = [];
  const record =
    (
      stream: StreamFunction<string, SimpleStreamOptions>,
    ): StreamFunction<string, SimpleStreamOptions> =>
    (model, context, streamOptions) => {
      calls.push({
        messages: structuredClone(context.messages),
        tools: getCurrentTools(context.messages).map(({ name }) => name),
        options: streamOptions,
      });
      return stream(model, context, streamOptions);
    };
  const provider = createProvider({
    id: providerId,
    auth: {
      apiKey: envApiKeyAuth("scripted API key", []),
      ...(options.oauth ? { oauth: options.oauth } : {}),
    },
    models: core.models,
    api: {
      stream: record(core.stream),
      streamSimple: record(core.streamSimple),
    },
  });
  core.setResponses(script);
  const module: ModelRuntimeModule = {
    ModelRuntime: {
      create: async (createOptions) => {
        const runtime = await pi.ModelRuntime.create(createOptions);
        runtime.registerNativeProvider(provider);
        return runtime;
      },
    },
  };
  return { module, calls };
}
