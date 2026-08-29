import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import { providerRemoveRequest } from "../../contract/credential.ts";
import { invalidRequest } from "../invalid-request.ts";
import { singleValued } from "../single.ts";
import type { RemoveProviderInput } from "../../../commands/provider/remove-provider.ts";
import { toHttpError } from "./refusals.ts";

export type RemoveProviderHandlerDependencies = Readonly<{
  removeProvider: (input: RemoveProviderInput) => Readonly<{ id: string }>;
}>;

export function removeProviderHandler(
  dependencies: RemoveProviderHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no provider id in the request path");
    }
    const queryParsed = providerRemoveRequest.safeParse(
      singleValued(context.query),
    );
    if (!queryParsed.success) {
      throw invalidRequest(
        "query-schema",
        "the force parameter is not valid",
        queryParsed.error,
      );
    }
    const force = queryParsed.data.force === "true";
    try {
      const removed = dependencies.removeProvider({
        id,
        actor: context.actor.id,
        force,
      });
      return { kind: "json", status: 200, body: removed };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
