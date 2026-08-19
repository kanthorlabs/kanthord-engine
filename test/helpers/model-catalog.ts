import type {
  CatalogModel,
  CatalogProvider,
  InspectModelsInput,
  ModelCatalog,
} from "../../src/services/model-catalog/index.ts";

export type FakeCatalogInput = Readonly<{
  providers?: readonly CatalogProvider[];
  inspect?: (input: InspectModelsInput) => Promise<readonly CatalogModel[]>;
}>;

export function catalogModel(
  id: string,
  overrides: Partial<CatalogModel> = {},
): CatalogModel {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32000,
    ...overrides,
  };
}

export const defaultCatalogProviders: readonly CatalogProvider[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    requiresBaseUrl: false,
    models: [
      catalogModel("claude-opus-5", {
        api: "anthropic-messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
      }),
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    requiresBaseUrl: false,
    models: [catalogModel("gpt-4o")],
  },
  {
    id: "openai-compatible",
    name: "OpenAI Compatible API",
    baseUrl: null,
    requiresBaseUrl: true,
    models: [],
  },
];

export function createFakeModelCatalog(
  input: FakeCatalogInput = {},
): ModelCatalog {
  const providers = input.providers ?? defaultCatalogProviders;
  return {
    providers: () => providers,
    has: (providerId) => providers.some((entry) => entry.id === providerId),
    inspect: async (probe) =>
      input.inspect === undefined ? [] : input.inspect(probe),
  };
}
