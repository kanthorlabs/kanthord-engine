import type { Storage } from "../../services/storage/index.ts";
import { bootstrapActorId } from "../../domain/actor.ts";

export type EnsureBootstrapActorDependencies = Readonly<{
  storage: Storage;
}>;

export type EnsureBootstrapActorInput = Readonly<{
  actor: string;
}>;

export type EnsureBootstrapActorResult = Readonly<{
  name: string;
  changed: boolean;
}>;

export class EnsureBootstrapActorError extends Error {
  readonly refusal: "actor-name-taken";

  constructor(refusal: "actor-name-taken", message: string) {
    super(message);
    this.name = "EnsureBootstrapActorError";
    this.refusal = refusal;
  }
}

export function ensureBootstrapActor(
  dependencies: EnsureBootstrapActorDependencies,
  input: EnsureBootstrapActorInput,
): EnsureBootstrapActorResult {
  return dependencies.storage.transact((transaction) => {
    const existing = transaction.get("SELECT id FROM actor WHERE name = ?", [
      input.actor,
    ]);
    if (existing === undefined) {
      transaction.run("UPDATE actor SET name = ? WHERE id = ?", [
        input.actor,
        bootstrapActorId,
      ]);
      return { name: input.actor, changed: true };
    }
    const existingId = (existing as Readonly<{ id: string }>).id;
    if (existingId === bootstrapActorId) {
      return { name: input.actor, changed: false };
    }
    throw new EnsureBootstrapActorError(
      "actor-name-taken",
      `an actor named ${input.actor} is already registered as ${existingId}`,
    );
  });
}
