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

// pi-ai also carries thinkingLevelMap, samplingParams, headers and compat on a
// model. They are open-ended records, and http/contract forbids an object node
// that permits an unknown key, so none of the four reaches the wire. Nothing
// displays them today, and the agent runner reads them from its own in-process
// pi-ai catalog. Carrying them means amending that contract rule first.
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
