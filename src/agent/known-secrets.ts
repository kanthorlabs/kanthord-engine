import type { CredentialStore } from "@earendil-works/pi-ai";
import { SecretShape } from "../custody/contract.ts";

export type KnownSecrets = () => Promise<readonly string[]>;

export function credentialSecrets(
  store: CredentialStore,
  providerId: string,
): KnownSecrets {
  return async () => {
    const stored = await store.read(providerId);
    if (stored === undefined) return [];
    if (stored.type === SecretShape.OAuth)
      return [stored.access, stored.refresh];
    return stored.key === undefined ? [] : [stored.key];
  };
}

export function mergedSecrets(sources: readonly KnownSecrets[]): KnownSecrets {
  const seen = new Set<string>();
  return async () => {
    for (const secrets of await Promise.all(sources.map((source) => source())))
      for (const secret of secrets) seen.add(secret);
    return [...seen];
  };
}
