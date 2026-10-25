import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { SecretShape } from "../custody/contract.ts";

export const PI_OAUTH_REFRESH_WINDOW_MS = 300000;

export type RefreshWatch = {
  wrap(store: CredentialStore): CredentialStore;
  refreshFailed(): boolean;
  secrets(): string[];
};

export function insideRefreshWindow(expires: number): boolean {
  return expires <= Date.now() + PI_OAUTH_REFRESH_WINDOW_MS;
}

export function refreshWatch(): RefreshWatch {
  let failed = false;
  const seen: string[] = [];
  const record = (credential: Credential | undefined) => {
    if (credential?.type === SecretShape.OAuth)
      seen.push(credential.refresh, credential.access);
  };
  return {
    wrap: (store) => ({
      read: (providerId, options) => store.read(providerId, options),
      list: (options) => store.list(options),
      delete: (providerId, options) => store.delete(providerId, options),
      modify: async (providerId, fn, options) => {
        const post = await store.modify(
          providerId,
          async (current) => {
            try {
              const next = await fn(current);
              record(next);
              return next;
            } catch (error) {
              failed = true;
              throw error;
            }
          },
          options,
        );
        record(post);
        return post;
      },
    }),
    refreshFailed: () => failed,
    secrets: () => [...seen],
  };
}

export function frozenStore(
  providerId: string,
  credential: Credential,
): CredentialStore {
  const read = async (id: string) =>
    id === providerId ? credential : undefined;
  return {
    read,
    list: async () => [{ providerId, type: credential.type }],
    delete: async () => {},
    modify: (id) => read(id),
  };
}
