import type { Handler } from "../app.ts";
import { providerRenameRequest } from "../../contract/credential.ts";
import { httpError } from "../../contract/errors.ts";
import type { ProviderView } from "../../../domain/provider-view.ts";
import type { RenameProviderInput } from "../../../commands/provider/rename-provider.ts";
import { toHttpError } from "./refusals.ts";

export type RenameProviderHandlerDependencies = Readonly<{
  renameProvider: (input: RenameProviderInput) => ProviderView;
  actor: string;
}>;

export function renameProviderHandler(
  dependencies: RenameProviderHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    const parsed = providerRenameRequest.safeParse(context.body);
    if (!parsed.success) {
      throw httpError("invalid-request", "the provider rename body is invalid");
    }
    try {
      const view = dependencies.renameProvider({
        id,
        name: parsed.data.name,
        actor: dependencies.actor,
      });
      return { status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
