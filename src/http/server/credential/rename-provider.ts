import type { Handler } from "../app.ts";
import { providerRenameRequest } from "../../contract/credential.ts";
import { httpError } from "../../contract/errors.ts";
import { invalidRequest } from "../invalid-request.ts";
import type { ProviderView } from "../../../domain/provider-view.ts";
import type { RenameProviderInput } from "../../../commands/provider/rename-provider.ts";
import { toHttpError } from "./refusals.ts";

export type RenameProviderHandlerDependencies = Readonly<{
  renameProvider: (input: RenameProviderInput) => ProviderView;
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
      throw invalidRequest(
        "body-schema",
        "the provider rename body is invalid",
        parsed.error,
      );
    }
    try {
      const view = dependencies.renameProvider({
        id,
        name: parsed.data.name,
        actor: context.actor.id,
      });
      return { kind: "json", status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
