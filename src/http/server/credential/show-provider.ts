import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type {
  ProviderListItem,
  ShowProviderInput,
} from "../../../queries/provider/show-provider.ts";

export type ShowProviderHandlerDependencies = Readonly<{
  showProvider: (input: ShowProviderInput) => ProviderListItem | null;
}>;

export function showProviderHandler(
  dependencies: ShowProviderHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    const item = dependencies.showProvider({ id });
    if (item === null) {
      throw httpError("not-found", `no provider ${id}`);
    }
    return { kind: "json", status: 200, body: item };
  };
}
