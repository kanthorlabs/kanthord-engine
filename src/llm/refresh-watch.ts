import {
  InMemoryCredentialStore,
  type Credential,
  type CredentialStore,
} from "@earendil-works/pi-ai";
import { SecretShape } from "../custody/contract.ts";

export const PI_OAUTH_REFRESH_WINDOW_MS = 300000;

export type RefreshWatch = { store: CredentialStore; refreshFailed(): boolean };

export function insideRefreshWindow(expires: number): boolean {
  return expires <= Date.now() + PI_OAUTH_REFRESH_WINDOW_MS;
}

export function refreshWatch(store: CredentialStore): RefreshWatch {
  let failed = false;
  return {
    store: {
      read: (providerId, options) => store.read(providerId, options),
      list: (options) => store.list(options),
      delete: (providerId, options) => store.delete(providerId, options),
      modify: (providerId, fn, options) =>
        store.modify(
          providerId,
          async (current) => {
            try {
              return await fn(current);
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          options,
        ),
    },
    refreshFailed: () => failed,
  };
}

export async function seededStore(
  providerId: string,
  credential: Credential,
): Promise<CredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.modify(providerId, async () => credential);
  return store;
}

export async function storedSecrets(
  store: CredentialStore,
  providerId: string,
): Promise<string[]> {
  const stored = await store.read(providerId);
  return stored?.type === SecretShape.OAuth
    ? [stored.refresh, stored.access]
    : [];
}
