import assert from "node:assert/strict";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { digest } from "../kernel/json.ts";
import { ExecutionStoreError } from "./execution-store.ts";
import { normalizeCredential } from "./payload.ts";

export type HeldCredential = { credential: Credential; pinned: boolean };

export interface WorkbenchCredentialSource {
  providerId: string;
  type: Credential["type"];
  release(): HeldCredential;
  replace(current: Credential, next: Credential): void;
  serialize<T>(operation: () => Promise<T>): Promise<T>;
}

export function workbenchCredentialStore(
  source: WorkbenchCredentialSource,
): CredentialStore {
  assert.ok(source.providerId);
  assert.ok(source.type);
  let chain: Promise<void> = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = chain.then(operation, operation);
    chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  return {
    read: async (providerId) => {
      if (providerId !== source.providerId) return undefined;
      return normalizeCredential(source.release().credential);
    },
    list: async () => [{ providerId: source.providerId, type: source.type }],
    modify: (providerId, fn) =>
      enqueue(() =>
        source.serialize(async () => {
          if (providerId !== source.providerId)
            throw new ExecutionStoreError(
              "The provider is outside the workbench credential store.",
            );
          const held = source.release();
          const current = normalizeCredential(held.credential);
          if (held.pinned) return current;
          const answer = await fn(normalizeCredential(current));
          if (answer === undefined) return current;
          const next = normalizeCredential(answer);
          if (next.type !== current.type)
            throw new ExecutionStoreError(
              "The workbench credential type cannot change.",
            );
          if (digest(next) !== digest(current)) source.replace(current, next);
          return next;
        }),
      ),
    delete: async () => {
      throw new ExecutionStoreError(
        "The workbench credential store refuses deletion.",
      );
    },
  };
}
