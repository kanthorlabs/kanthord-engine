import { z } from "zod";

import { identity, parseIdentity } from "./identity.ts";
import { bytes, epochMillis } from "./column.ts";

export const registeredActorKinds = ["human", "harness"] as const;
export type RegisteredActorKind = (typeof registeredActorKinds)[number];

export const bootstrapActorId = "actor_00000000000000000000000000";

export const actorNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const actorSecretPattern = /^[A-Za-z0-9_-]{43}$/;

export const actorRow = z.object({
  id: identity("actor"),
  kind: z.enum(registeredActorKinds),
  name: z.string(),
  tokenSha256: bytes
    .refine((value) => value.length === 32, {
      message: "length(token_sha256) = 32",
    })
    .nullable(),
  registeredBy: identity("actor").nullable(),
  createdAt: epochMillis,
  revokedAt: epochMillis.nullable(),
  revokedBy: identity("actor").nullable(),
});
export type ActorRow = z.infer<typeof actorRow>;

export function parseActorToken(
  value: string,
): Readonly<{ actorId: string; secret: string }> | null {
  const separatorIndex = value.indexOf(".");
  if (separatorIndex === -1) return null;

  const actorId = value.slice(0, separatorIndex);
  const parsed = parseIdentity(actorId);
  if (parsed === null || parsed.kind !== "actor") return null;

  const secret = value.slice(separatorIndex + 1);
  if (!actorSecretPattern.test(secret)) return null;

  return { actorId, secret };
}

export function renderActorToken(
  input: Readonly<{ actorId: string; secret: string }>,
): string {
  return `${input.actorId}.${input.secret}`;
}
