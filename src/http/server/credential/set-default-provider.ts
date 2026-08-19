import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type {
  ProviderDefaultTransfer,
  SetDefaultProviderInput,
} from "../../../commands/provider/set-default-provider.ts";
import { toHttpError } from "./refusals.ts";

export type SetDefaultProviderHandlerDependencies = Readonly<{
  setDefaultProvider: (
    input: SetDefaultProviderInput,
  ) => ProviderDefaultTransfer;
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
        actor: context.actor.id,
      });
      return { status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
