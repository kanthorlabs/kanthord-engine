import {
  deserializePayload,
  serializePayload,
  type LlmOauthPayload,
} from "../../domain/provider-payload.ts";
import type { Clock } from "../clock/index.ts";
import type { Crypto } from "../crypto/index.ts";
import type { EventLog } from "../event/index.ts";
import type { Storage } from "../storage/index.ts";
import type { CredentialWriter } from "./index.ts";

type ProviderRow = Readonly<{
  id: string;
  name: string;
  kind: string;
  payload_ciphertext: Uint8Array;
  payload_iv: Uint8Array;
  payload_tag: Uint8Array;
  key_version: number;
}>;

export type SqliteCredentialWriterDependencies = Readonly<{
  storage: Storage;
  crypto: Crypto;
  events: EventLog;
  clock: Clock;
}>;

export class SqliteCredentialWriter implements CredentialWriter {
  readonly #storage: Storage;
  readonly #crypto: Crypto;
  readonly #events: EventLog;
  readonly #clock: Clock;

  constructor(dependencies: SqliteCredentialWriterDependencies) {
    this.#storage = dependencies.storage;
    this.#crypto = dependencies.crypto;
    this.#events = dependencies.events;
    this.#clock = dependencies.clock;
  }

  write(
    providerId: string,
    credential: Readonly<Record<string, unknown>>,
  ): void {
    this.#storage.transact((transaction) => {
      const row = transaction.get(
        "SELECT id, name, kind, payload_ciphertext, payload_iv, payload_tag, key_version FROM provider WHERE id = ?",
        [providerId],
      ) as ProviderRow | undefined;
      if (row === undefined) return;

      const text = this.#crypto.open({
        ciphertext: row.payload_ciphertext,
        iv: row.payload_iv,
        tag: row.payload_tag,
        keyVersion: row.key_version,
      });
      const payload = deserializePayload("llm", text);
      if (payload.transport !== "oauth") return;

      const next: LlmOauthPayload = {
        ...payload,
        credential: credential as LlmOauthPayload["credential"],
      };
      const sealed = this.#crypto.seal(serializePayload("llm", next));
      const updatedAt = this.#clock.now();
      transaction.run(
        "UPDATE provider SET payload_ciphertext = ?, payload_iv = ?, payload_tag = ?, key_version = ?, updated_at = ? WHERE id = ?",
        [
          sealed.ciphertext,
          sealed.iv,
          sealed.tag,
          sealed.keyVersion,
          updatedAt,
          providerId,
        ],
      );
      this.#events.append(transaction, {
        subjectKind: "provider",
        subjectId: providerId,
        type: "provider.credentialRefreshed",
        actorKind: "daemon",
        actorId: "daemon",
        payload: { name: row.name, kind: "llm", refreshedAt: updatedAt },
      });
    });
  }
}
