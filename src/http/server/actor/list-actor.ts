import type { Handler } from "../app.ts";
import type { ActorView } from "../../../domain/actor-view.ts";
import type { ListActorInput } from "../../../queries/actor/list-actor.ts";

export type ListActorHandlerDependencies = Readonly<{
  listActors: (input: ListActorInput) => readonly ActorView[];
}>;

export function listActorHandler(
  dependencies: ListActorHandlerDependencies,
): Handler {
  return () => ({
    status: 200,
    body: { actors: dependencies.listActors({}) },
  });
}
