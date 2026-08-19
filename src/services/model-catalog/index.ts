export type CatalogModelCostRates = Readonly<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}>;

export type CatalogModelCostTier = CatalogModelCostRates &
  Readonly<{ inputTokensAbove: number }>;

export type CatalogModelCost = CatalogModelCostRates &
  Readonly<{ tiers?: readonly CatalogModelCostTier[] }>;

export type CatalogModel = Readonly<{
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: readonly string[];
  cost: CatalogModelCost;
  contextWindow: number;
  maxTokens: number;
}>;

export type CatalogProvider = Readonly<{
  id: string;
  name: string;
  baseUrl: string | null;
  requiresBaseUrl: boolean;
  models: readonly CatalogModel[];
}>;

export type InspectModelsInput = Readonly<{
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}>;

export type CatalogFailure = "unreachable" | "rejected" | "malformed";

export class ModelCatalogError extends Error {
  readonly failure: CatalogFailure;
  readonly detail: string;

  constructor(failure: CatalogFailure, message: string, detail = "") {
    super(message);
    this.name = "ModelCatalogError";
    this.failure = failure;
    this.detail = detail;
  }
}

export interface ModelCatalog {
  providers(): readonly CatalogProvider[];
  has(providerId: string): boolean;
  inspect(input: InspectModelsInput): Promise<readonly CatalogModel[]>;
}
