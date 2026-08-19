import {
  ModelCatalogError,
  type CatalogModel,
  type ModelCatalog,
} from "../../services/model-catalog/index.ts";

export type InspectProviderDependencies = Readonly<{
  catalog: ModelCatalog;
}>;

export type InspectProviderInput = Readonly<{
  provider: string;
  baseUrl: string | null;
  apiKey: string;
}>;

export type InspectProviderResult = Readonly<{
  models: readonly CatalogModel[];
}>;

export type InspectProviderRefusal =
  | "provider-unknown"
  | "provider-not-inspectable"
  | "base-url-required"
  | "endpoint-unreachable"
  | "endpoint-rejected"
  | "endpoint-malformed";

export class InspectProviderError extends Error {
  readonly refusal: InspectProviderRefusal;
  readonly detail: string;

  constructor(refusal: InspectProviderRefusal, message: string, detail = "") {
    super(message);
    this.name = "InspectProviderError";
    this.refusal = refusal;
    this.detail = detail;
  }
}

const endpointRefusals = {
  unreachable: "endpoint-unreachable",
  rejected: "endpoint-rejected",
  malformed: "endpoint-malformed",
} as const;

export async function inspectProvider(
  dependencies: InspectProviderDependencies,
  input: InspectProviderInput,
): Promise<InspectProviderResult> {
  const entry = dependencies.catalog
    .providers()
    .find((provider) => provider.id === input.provider);
  if (entry === undefined) {
    throw new InspectProviderError(
      "provider-unknown",
      `${input.provider} is not a known llm provider`,
    );
  }
  if (!entry.requiresBaseUrl) {
    throw new InspectProviderError(
      "provider-not-inspectable",
      `the models of ${input.provider} are static; read them from provider.catalog`,
    );
  }
  if (input.baseUrl === null) {
    throw new InspectProviderError(
      "base-url-required",
      `${input.provider} needs a baseUrl to list its models`,
    );
  }
  try {
    const models = await dependencies.catalog.inspect({
      baseUrl: input.baseUrl,
      apiKey: input.apiKey,
    });
    return { models };
  } catch (error) {
    if (error instanceof ModelCatalogError) {
      throw new InspectProviderError(
        endpointRefusals[error.failure],
        error.message,
        error.detail,
      );
    }
    throw error;
  }
}
