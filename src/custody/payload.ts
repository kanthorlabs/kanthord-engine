import type { Credential } from "@earendil-works/pi-ai";
import type { z } from "zod";
import { isObject } from "../kernel/values.ts";
import { piCredentialSchema } from "./contract.ts";
import {
  apiKeySecretSchema,
  oauthSecretSchema,
  SecretShape,
} from "./platforms.ts";

export function normalizeCredential(credential: Credential): Credential {
  if (credential.type === SecretShape.ApiKey)
    return piCredentialSchema.parse({
      type: credential.type,
      key: credential.key,
    });
  return piCredentialSchema.parse({
    type: credential.type,
    refresh: credential.refresh,
    access: credential.access,
    expires: credential.expires,
  });
}

export function dropExtraOAuthFields(value: unknown): unknown {
  if (!isObject(value) || !("credential" in value)) return value;
  const { credential } = value;
  if (
    !isObject(credential) ||
    !("type" in credential) ||
    credential.type !== SecretShape.OAuth
  )
    return value;
  const { refresh, access, expires } = credential as Record<string, unknown>;
  return {
    ...value,
    credential: {
      type: credential.type,
      refresh,
      access,
      expires,
    },
  };
}

export function credentialOfSecret(
  shape: SecretShape,
  secret: unknown,
): z.infer<typeof piCredentialSchema> {
  if (shape === SecretShape.ApiKey)
    return { type: shape, ...apiKeySecretSchema.parse(secret) };
  if (shape === SecretShape.OAuth)
    return { type: shape, ...oauthSecretSchema.parse(secret) };
  throw new TypeError("The secret shape cannot enter a handover.");
}

export function secretOfCredential(credential: Credential): unknown {
  const value = normalizeCredential(credential);
  if (value.type === SecretShape.ApiKey) return { key: value.key };
  return {
    refresh: value.refresh,
    access: value.access,
    expires: value.expires,
  };
}
