import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type {
  RotateActorTokenInput,
  RotateActorTokenResult,
} from "../../../commands/actor/rotate-actor-token.ts";
import { toHttpError } from "./refusals.ts";

export type RotateActorTokenHandlerDependencies = Readonly<{
  rotateActorToken: (input: RotateActorTokenInput) => RotateActorTokenResult;
}>;

export function rotateActorTokenHandler(
  dependencies: RotateActorTokenHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no actor id in the request path");
    }
    try {
      const result = dependencies.rotateActorToken({
        id,
        actor: context.actor,
      });
      return { status: 200, body: { ...result.view, token: result.token } };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
