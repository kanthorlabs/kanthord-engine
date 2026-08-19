import type { Handler } from "../app.ts";
import type { ReadCatalogResult } from "../../../queries/provider/read-catalog.ts";

export type ReadCatalogHandlerDependencies = Readonly<{
  readCatalog: () => ReadCatalogResult;
}>;

export function readCatalogHandler(
  dependencies: ReadCatalogHandlerDependencies,
): Handler {
  return () => ({ status: 200, body: dependencies.readCatalog() });
}
