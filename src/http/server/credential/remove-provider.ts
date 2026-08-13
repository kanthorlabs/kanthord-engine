import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { RemoveProviderInput } from "../../../commands/provider/remove-provider.ts";
import { toHttpError } from "./refusals.ts";

export type RemoveProviderHandlerDependencies = Readonly<{
  removeProvider: (input: RemoveProviderInput) => Readonly<{ id: string }>;
  actor: string;
}>;

export function removeProviderHandler(
  dependencies: RemoveProviderHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    try {
      const removed = dependencies.removeProvider({
        id,
        actor: dependencies.actor,
      });
      return { status: 200, body: removed };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
