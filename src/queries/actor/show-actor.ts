import type { Storage } from "../../services/storage/index.ts";
import { actorRow, type RegisteredActorKind } from "../../domain/actor.ts";
import type { ActorView } from "../../domain/actor-view.ts";

export type ShowActorDependencies = Readonly<{
  storage: Storage;
}>;

export type ShowActorInput = Readonly<{
  id: string;
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

export function showActor(
  dependencies: ShowActorDependencies,
  input: ShowActorInput,
): ActorView | null {
  return dependencies.storage.transact((transaction) => {
    const row = transaction.get(
      `SELECT ${actorColumns} FROM actor WHERE id = ?`,
      [input.id],
    );
    if (row === undefined) {
      return null;
    }
    const value = row as ActorDbRow;
    const parsed = actorRow.parse({
      id: value.id,
      kind: value.kind,
      name: value.name,
      tokenSha256: value.token_sha256,
      registeredBy: value.registered_by,
      createdAt: value.created_at,
      revokedAt: value.revoked_at,
      revokedBy: value.revoked_by,
    });
    return {
      id: parsed.id,
      kind: parsed.kind,
      name: parsed.name,
      registeredBy: parsed.registeredBy,
      createdAt: parsed.createdAt,
      revokedAt: parsed.revokedAt,
      revokedBy: parsed.revokedBy,
    };
  });
}
