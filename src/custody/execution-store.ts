import assert from "node:assert/strict";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { digest } from "../kernel/json.ts";
import {
  handoverPayloadSchema,
  piCredentialSchema,
  type HandoverPayload,
  type RefreshReport,
} from "./contract.ts";
import { normalizeCredential } from "./payload.ts";

const EXECUTION_CREDENTIAL_COUNT = 1;

export class ExecutionStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionStoreError";
  }
}

export type ExecutionCredentials = {
  store: CredentialStore;
  release(): Promise<void>;
  discard(): void;
};

class ExecutionCredentialView implements ExecutionCredentials {
  #current: Credential | undefined;
  #reported: Credential | undefined;
  #chain: Promise<unknown> = Promise.resolve();
  readonly #credentialId: string;
  readonly #providerId: string;
  readonly #report: (report: RefreshReport) => Promise<void>;

  constructor(
    payload: HandoverPayload,
    report: (report: RefreshReport) => Promise<void>,
  ) {
    const parsed = handoverPayloadSchema.parse(payload);
    assert.equal(parsed.items.length, EXECUTION_CREDENTIAL_COUNT);
    const item = parsed.items[0];
    assert(item);
    this.#credentialId = item.credentialId;
    this.#providerId = item.providerId;
    this.#current = normalizeCredential(item.credential);
    this.#reported = normalizeCredential(item.credential);
    this.#report = report;
  }

  #live(): Credential {
    if (!this.#current || !this.#reported)
      throw new ExecutionStoreError(
        "The execution credential store is discarded.",
      );
    return this.#current;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#chain.then(operation, operation);
    this.#chain = result;
    return result;
  }

  async #send(): Promise<void> {
    const credential = piCredentialSchema.parse(this.#live());
    assert(this.#reported);
    await this.#report({
      credentialId: this.#credentialId,
      digest: digest(this.#reported),
      credential,
    });
    this.#live();
    this.#reported = normalizeCredential(credential);
  }

  readonly store: CredentialStore = {
    read: async (providerId) => {
      if (providerId !== this.#providerId || !this.#current) return undefined;
      return normalizeCredential(this.#current);
    },
    list: async () =>
      this.#current
        ? [{ providerId: this.#providerId, type: this.#current.type }]
        : [],
    modify: (providerId, fn) =>
      this.#enqueue(async () => {
        const current = this.#live();
        if (providerId !== this.#providerId)
          throw new ExecutionStoreError(
            "The provider is outside the execution credential store.",
          );
        const answer = await fn(normalizeCredential(current));
        this.#live();
        if (answer === undefined) return normalizeCredential(current);
        const next = normalizeCredential(answer);
        if (next.type !== current.type)
          throw new ExecutionStoreError(
            "The execution credential type cannot change.",
          );
        this.#current = next;
        if (digest(next) !== digest(this.#reported)) await this.#send();
        return normalizeCredential(this.#live());
      }),
    delete: async () => {
      throw new ExecutionStoreError(
        "The execution credential store refuses deletion.",
      );
    },
  };

  release(): Promise<void> {
    return this.#enqueue(() => this.#send());
  }

  discard(): void {
    this.#current = undefined;
    this.#reported = undefined;
  }
}

export function executionCredentialStore(
  payload: HandoverPayload,
  report: (report: RefreshReport) => Promise<void>,
): ExecutionCredentials {
  return new ExecutionCredentialView(payload, report);
}
