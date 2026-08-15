import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { ActorView } from "../../../domain/actor-view.ts";
import type { RevokeActorInput } from "../../../commands/actor/revoke-actor.ts";
import { toHttpError } from "./refusals.ts";

export type RevokeActorHandlerDependencies = Readonly<{
  revokeActor: (input: RevokeActorInput) => ActorView;
}>;

export function revokeActorHandler(
  dependencies: RevokeActorHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no actor id in the request path");
    }
    try {
      const view = dependencies.revokeActor({ id, actor: context.actor });
      return { status: 200, body: view };
    } catch (error) {
      throw toHttpError(error);
    }
  };
}
