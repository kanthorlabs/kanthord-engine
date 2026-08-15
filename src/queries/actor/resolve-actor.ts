import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { Secret } from "../../services/secret/index.ts";
import {
  actorRow,
  bootstrapActorId,
  parseActorToken,
  type ActorRow,
  type RegisteredActorKind,
} from "../../domain/actor.ts";

export type ResolveActorDependencies = Readonly<{
  storage: Storage;
  secret: Secret;
  configuredToken: string;
}>;

export type ResolveActorInput = Readonly<{ presented: string }>;

const actorColumns =
  "id, kind, name, token_sha256, registered_by, created_at, revoked_at, revoked_by";

const dummyDigest = new Uint8Array(32);

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

export function resolveActor(
  dependencies: ResolveActorDependencies,
  input: ResolveActorInput,
): ActorRow | null {
  return dependencies.storage.transact((transaction) => {
    if (dependencies.configuredToken === "") {
      return loadActor(transaction, bootstrapActorId) ?? null;
    }

    const configuredMatch = dependencies.secret.matches(
      dependencies.secret.digest(dependencies.configuredToken),
      dependencies.secret.digest(input.presented),
    );
    if (configuredMatch) {
      return loadActor(transaction, bootstrapActorId) ?? null;
    }

    const parsed = parseActorToken(input.presented);
    if (parsed === null) {
      return null;
    }

    const row = loadActor(transaction, parsed.actorId);
    if (row === undefined) {
      const dummyMatched = dependencies.secret.matches(
        dummyDigest,
        dependencies.secret.digest(parsed.secret),
      );
      if (dummyMatched) {
        return null;
      }
      return null;
    }

    if (row.revokedAt !== null) {
      if (row.tokenSha256 !== null) {
        dependencies.secret.matches(
          row.tokenSha256,
          dependencies.secret.digest(parsed.secret),
        );
      }
      return null;
    }

    if (row.tokenSha256 === null) {
      return null;
    }

    const tokenMatch = dependencies.secret.matches(
      row.tokenSha256,
      dependencies.secret.digest(parsed.secret),
    );
    if (tokenMatch) {
      return row;
    }
    return null;
  });
}
