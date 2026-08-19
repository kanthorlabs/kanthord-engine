import {
  getBuiltinModels,
  getBuiltinProviders,
  builtinProviders,
} from "@earendil-works/pi-ai/providers/all";

import { openAiCompatibleProvider } from "../../domain/provider-payload.ts";
import {
  ModelCatalogError,
  type CatalogModel,
  type CatalogProvider,
  type InspectModelsInput,
  type ModelCatalog,
} from "./index.ts";

function toCatalogModel(model: CatalogModel): CatalogModel {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function staticProviders(): readonly CatalogProvider[] {
  const named = new Map(
    builtinProviders().map((provider) => [provider.id, provider]),
  );
  const providers = getBuiltinProviders().map((id) => {
    const provider = named.get(id);
    return {
      id,
      name: provider?.name ?? id,
      baseUrl: provider?.baseUrl ?? null,
      requiresBaseUrl: false,
      models: getBuiltinModels(id).map((model) =>
        toCatalogModel(model as unknown as CatalogModel),
      ),
    } satisfies CatalogProvider;
  });
  return [
    ...providers,
    {
      id: openAiCompatibleProvider,
      name: "OpenAI Compatible API",
      baseUrl: null,
      requiresBaseUrl: true,
      models: [],
    },
  ].sort((left, right) =>
    Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")),
  );
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/models`;
}

function probedModel(id: string, baseUrl: string): CatalogModel {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: openAiCompatibleProvider,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 0,
    maxTokens: 0,
  };
}

function readModelIds(body: unknown): readonly string[] {
  if (typeof body !== "object" || body === null) {
    throw new ModelCatalogError(
      "malformed",
      "the endpoint did not answer a model list",
    );
  }
  const data = (body as Readonly<Record<string, unknown>>).data;
  if (!Array.isArray(data)) {
    throw new ModelCatalogError(
      "malformed",
      "the model list carries no data array",
    );
  }
  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) continue;
    const id = (entry as Readonly<Record<string, unknown>>).id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids.sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  );
}

export class PiAiModelCatalog implements ModelCatalog {
  readonly #providers: readonly CatalogProvider[];
  readonly #fetch: typeof fetch;

  constructor(fetchImplementation: typeof fetch = fetch) {
    this.#providers = staticProviders();
    this.#fetch = fetchImplementation;
  }

  providers(): readonly CatalogProvider[] {
    return this.#providers;
  }

  has(providerId: string): boolean {
    return this.#providers.some((provider) => provider.id === providerId);
  }

  async inspect(input: InspectModelsInput): Promise<readonly CatalogModel[]> {
    const url = modelsUrl(input.baseUrl);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          accept: "application/json",
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      throw new ModelCatalogError(
        "unreachable",
        `${url} could not be reached`,
        error instanceof Error ? error.message : "",
      );
    }
    if (!response.ok) {
      throw new ModelCatalogError(
        "rejected",
        `${url} answered ${String(response.status)}`,
        String(response.status),
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ModelCatalogError("malformed", `${url} did not answer JSON`);
    }
    return readModelIds(body).map((id) => probedModel(id, input.baseUrl));
  }
}
