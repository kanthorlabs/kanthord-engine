import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import { providerCatalogRequest } from "../../contract/credential.ts";
import type {
  ReadCatalogInput,
  ReadCatalogResult,
} from "../../../queries/provider/read-catalog.ts";
import { singleValued } from "../single.ts";

export type ReadCatalogHandlerDependencies = Readonly<{
  readCatalog: (input: ReadCatalogInput) => ReadCatalogResult;
}>;

export function readCatalogHandler(
  dependencies: ReadCatalogHandlerDependencies,
): Handler {
  return (context) => {
    const parsed = providerCatalogRequest.safeParse(
      singleValued(context.query),
    );
    if (!parsed.success) {
      throw invalidRequest(
        "query-schema",
        "the provider filter is not valid",
        parsed.error,
      );
    }
    return { status: 200, body: dependencies.readCatalog(parsed.data) };
  };
}
