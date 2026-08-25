import type { Handler } from "../app.ts";
import { httpError } from "../../contract/errors.ts";
import type { ActorView } from "../../../domain/actor-view.ts";
import type { ShowActorInput } from "../../../queries/actor/show-actor.ts";

export type ShowActorHandlerDependencies = Readonly<{
  showActor: (input: ShowActorInput) => ActorView | null;
}>;

export function showActorHandler(
  dependencies: ShowActorHandlerDependencies,
): Handler {
  return (context) => {
    const id = context.parameters["id"];
    if (id === undefined) {
      throw httpError("not-found", "no actor id in the request path");
    }
    const view = dependencies.showActor({ id });
    if (view === null) {
      throw httpError("not-found", `no actor ${id}`);
    }
    return { kind: "json", status: 200, body: view };
  };
}
