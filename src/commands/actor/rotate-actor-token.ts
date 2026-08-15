import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { Secret } from "../../services/secret/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  actorRow,
  bootstrapActorId,
  renderActorToken,
  type ActorRow,
  type RegisteredActorKind,
} from "../../domain/actor.ts";
import type { ActorView } from "../../domain/actor-view.ts";
import { ActorCommandError } from "../../domain/actor-command-error.ts";

export type RotateActorTokenDependencies = Readonly<{
  storage: Storage;
  secret: Secret;
  events: EventLog;
  clock: Clock;
}>;

export type RotateActorTokenInput = Readonly<{
  id: string;
  actor: ActorRow;
}>;

export type RotateActorTokenResult = Readonly<{
  view: ActorView;
  token: string;
}>;

const actorColumns =
  "id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by";

type ActorDbRow = Readonly<{
  id: string;
  kind: RegisteredActorKind;
  name: string;
  token_sha256: Uint8Array | null;
  registered_by: string | null;
  created_at: number;
  revoked_at: number | null;
  revoked_by: string | null;
}>;

function loadActor(transaction: Transaction, id: string): ActorRow | undefined {
  const row = transaction.get(
    `SELECT ${actorColumns} FROM actor WHERE id = ?`,
    [id],
  );
  if (row === undefined) {
    return undefined;
  }
  const value = row as ActorDbRow;
  return actorRow.parse({
    id: value.id,
    kind: value.kind,
    name: value.name,
    tokenSha256: value.token_sha256,
    registeredBy: value.registered_by,
    createdAt: value.created_at,
    revokedAt: value.revoked_at,
    revokedBy: value.revoked_by,
  });
}

export function rotateActorToken(
  dependencies: RotateActorTokenDependencies,
  input: RotateActorTokenInput,
): RotateActorTokenResult {
  const outcome = dependencies.storage.transact((transaction) => {
    const row = loadActor(transaction, input.id);
    if (row === undefined) {
      throw new ActorCommandError("not-found", `no actor ${input.id}`);
    }
    if (row.id === bootstrapActorId) {
      throw new ActorCommandError(
        "bootstrap-actor",
        "the bootstrap actor cannot rotate its token",
      );
    }
    if (row.revokedAt !== null) {
      throw new ActorCommandError(
        "actor-revoked",
        "a revoked actor cannot rotate its token",
      );
    }
    const value = dependencies.secret.generate();
    transaction.run("UPDATE actor SET token_sha256 = ? WHERE id = ?", [
      dependencies.secret.digest(value),
      input.id,
    ]);
    const rotatedAt = dependencies.clock.now();
    dependencies.events.append(transaction, {
      subjectKind: "actor",
      subjectId: input.id,
      type: "actor.tokenRotated",
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      payload: {
        actorId: input.id,
        kind: row.kind,
        name: row.name,
        rotatedBy: input.actor.id,
        rotatedAt,
      },
    });
    return { value, row };
  });
  return {
    view: {
      id: outcome.row.id,
      kind: outcome.row.kind,
      name: outcome.row.name,
      registeredBy: outcome.row.registeredBy,
      createdAt: outcome.row.createdAt,
      revokedAt: outcome.row.revokedAt,
      revokedBy: outcome.row.revokedBy,
    },
    token: renderActorToken({ actorId: input.id, secret: outcome.value }),
  };
}
