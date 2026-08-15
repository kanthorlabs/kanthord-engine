import type { Storage } from "../../services/storage/index.ts";
import { actorRow, type RegisteredActorKind } from "../../domain/actor.ts";
import type { ActorView } from "../../domain/actor-view.ts";

export type ListActorDependencies = Readonly<{
  storage: Storage;
}>;

export type ListActorInput = Readonly<Record<string, never>>;

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

export function listActors(
  dependencies: ListActorDependencies,
  _input: ListActorInput,
): readonly ActorView[] {
  const rows = dependencies.storage.transact((transaction) =>
    transaction.all(`SELECT ${actorColumns} FROM actor ORDER BY id ASC`),
  );
  return rows.map((row) => {
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
