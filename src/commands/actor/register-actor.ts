import type { Storage } from "../../services/storage/index.ts";
import type { Secret } from "../../services/secret/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { renderActorToken } from "../../domain/actor.ts";
import type { ActorRow } from "../../domain/actor.ts";
import type { ActorView } from "../../domain/actor-view.ts";
import { ActorCommandError } from "../../domain/actor-command-error.ts";

export type RegisterActorDependencies = Readonly<{
  storage: Storage;
  secret: Secret;
  ids: IdGenerator;
  events: EventLog;
  clock: Clock;
}>;

export type RegisterActorInput = Readonly<{
  name: string;
  actor: ActorRow;
  configuredToken: string;
}>;

export type RegisterActorResult = Readonly<{
  view: ActorView;
  token: string;
}>;

export function registerActor(
  dependencies: RegisterActorDependencies,
  input: RegisterActorInput,
): RegisterActorResult {
  const outcome = dependencies.storage.transact((transaction) => {
    if (input.configuredToken === "") {
      throw new ActorCommandError(
        "no-configured-token",
        "a local process must not mint a credential that outlives that mode",
      );
    }
    const existing = transaction.get("SELECT id FROM actor WHERE name = ?", [
      input.name,
    ]);
    if (existing !== undefined) {
      throw new ActorCommandError(
        "name-taken",
        `a harness named ${input.name} is already registered`,
      );
    }
    const id = dependencies.ids.mint("actor");
    const value = dependencies.secret.generate();
    const createdAt = dependencies.clock.now();
    transaction.run(
      "INSERT INTO actor (id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by) VALUES (?, 'harness', ?, ?, ?, ?, NULL, NULL)",
      [
        id,
        input.name,
        dependencies.secret.digest(value),
        input.actor.id,
        createdAt,
      ],
    );
    dependencies.events.append(transaction, {
      subjectKind: "actor",
      subjectId: id,
      type: "actor.registered",
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      payload: {
        actorId: id,
        kind: "harness",
        name: input.name,
        registeredBy: input.actor.id,
      },
    });
    return { id, value, createdAt };
  });
  return {
    view: {
      id: outcome.id,
      kind: "harness",
      name: input.name,
      registeredBy: input.actor.id,
      createdAt: outcome.createdAt,
      revokedAt: null,
      revokedBy: null,
    },
    token: renderActorToken({ actorId: outcome.id, secret: outcome.value }),
  };
}
