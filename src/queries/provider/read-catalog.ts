import type {
  CatalogProvider,
  ModelCatalog,
} from "../../services/model-catalog/index.ts";

export type ReadCatalogDependencies = Readonly<{
  catalog: ModelCatalog;
}>;

export type ReadCatalogResult = Readonly<{
  providers: readonly CatalogProvider[];
}>;

export function readCatalog(
  dependencies: ReadCatalogDependencies,
): ReadCatalogResult {
  return { providers: dependencies.catalog.providers() };
}
