import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  actorRow,
  bootstrapActorId,
  type ActorRow,
  type RegisteredActorKind,
} from "../../domain/actor.ts";
import type { ActorView } from "../../domain/actor-view.ts";
import { ActorCommandError } from "../../domain/actor-command-error.ts";

export type RevokeActorDependencies = Readonly<{
  storage: Storage;
  events: EventLog;
  clock: Clock;
}>;

export type RevokeActorInput = Readonly<{
  id: string;
  actor: ActorRow;
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

function toView(
  row: ActorRow,
  revokedAt: number | null,
  revokedBy: string | null,
): ActorView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    registeredBy: row.registeredBy,
    createdAt: row.createdAt,
    revokedAt,
    revokedBy,
  };
}

export function revokeActor(
  dependencies: RevokeActorDependencies,
  input: RevokeActorInput,
): ActorView {
  const outcome = dependencies.storage.transact((transaction) => {
    const row = loadActor(transaction, input.id);
    if (row === undefined) {
      throw new ActorCommandError("not-found", `no actor ${input.id}`);
    }
    if (row.id === bootstrapActorId) {
      throw new ActorCommandError(
        "bootstrap-actor",
        "the bootstrap actor cannot be revoked",
      );
    }
    if (row.revokedAt !== null) {
      return { row, revokedAt: row.revokedAt, revokedBy: row.revokedBy };
    }
    const revokedAt = dependencies.clock.now();
    transaction.run(
      "UPDATE actor SET revoked_at = ?, revoked_by = ? WHERE id = ?",
      [revokedAt, input.actor.id, input.id],
    );
    const leasesFenced = 0;
    dependencies.events.append(transaction, {
      subjectKind: "actor",
      subjectId: input.id,
      type: "actor.revoked",
      actorKind: input.actor.kind,
      actorId: input.actor.id,
      payload: {
        actorId: input.id,
        kind: row.kind,
        name: row.name,
        revokedBy: input.actor.id,
        revokedAt,
        leasesFenced,
      },
    });
    return { row, revokedAt, revokedBy: input.actor.id };
  });
  return toView(outcome.row, outcome.revokedAt, outcome.revokedBy);
}
