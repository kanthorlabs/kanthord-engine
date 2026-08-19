import type {
  CatalogProvider,
  ModelCatalog,
} from "../../services/model-catalog/index.ts";

export type ReadCatalogDependencies = Readonly<{
  catalog: ModelCatalog;
}>;

export type ReadCatalogInput = Readonly<{
  provider?: string;
}>;

export type ReadCatalogResult = Readonly<{
  providers: readonly CatalogProvider[];
}>;

export function readCatalog(
  dependencies: ReadCatalogDependencies,
  input: ReadCatalogInput = {},
): ReadCatalogResult {
  const providers = dependencies.catalog.providers();
  if (input.provider === undefined) {
    return { providers };
  }
  return {
    providers: providers.filter((entry) => entry.id === input.provider),
  };
}
