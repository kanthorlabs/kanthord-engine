import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { ProviderView } from "../../../domain/provider-view.ts";
import type { SetDefaultProviderInput } from "../../../commands/provider/set-default-provider.ts";
import { toHttpError } from "./refusals.ts";

export type SetDefaultProviderHandlerDependencies = Readonly<{
  setDefaultProvider: (input: SetDefaultProviderInput) => ProviderView;
  actor: string;
}>;

export function setDefaultProviderHandler(
  dependencies: SetDefaultProviderHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    try {
      const view = dependencies.setDefaultProvider({
        id,
        actor: dependencies.actor,
      });
      return { status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
