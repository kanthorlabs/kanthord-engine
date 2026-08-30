import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  deserializePayload,
  serializePayload,
  type LlmApiKeyPayload,
  type LlmOauthPayload,
} from "../../domain/provider-payload.ts";
import { AesGcmCrypto } from "../crypto/aes-gcm.ts";
import type { Crypto } from "../crypto/index.ts";
import type { EventLog } from "../event/index.ts";
import { SqliteEventLog } from "../event/sqlite.ts";
import type { Clock } from "../clock/index.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import type { Storage } from "../storage/index.ts";
import {
  SqliteCredentialWriter,
  type SqliteCredentialWriterDependencies,
} from "./credential-writer.ts";

const PROVIDER_ID = "provider_01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const PROVIDER_NAME = "work-codex";
const INITIAL_UPDATED_AT = 1_700_000_000_000;
const REFRESHED_AT = 1_700_000_001_000;

const crypto: Crypto = new AesGcmCrypto({
  key: Buffer.alloc(32, 7),
  keyVersion: 1,
});

const oauthPayload: LlmOauthPayload = {
  transport: "oauth",
  provider: "openai-codex",
  credential: {
    type: "oauth",
    access: "access-before",
    refresh: "refresh-before",
    expires: INITIAL_UPDATED_AT + 600_000,
    availableModelIds: ["gpt-5-codex"],
    enterpriseUrl: "https://enterprise.example.test",
  },
  defaultModel: "gpt-5-codex",
};

const rotatedCredential = {
  type: "oauth",
  access: "access-after",
  refresh: "refresh-after",
  expires: INITIAL_UPDATED_AT + 900_000,
  availableModelIds: ["gpt-5-codex", "gpt-5"],
  enterpriseUrl: "https://enterprise.example.test",
} satisfies LlmOauthPayload["credential"];

type ProviderReadback = Readonly<{
  id: string;
  name: string;
  kind: string;
  set_default_at: number | null;
  payload_ciphertext: Uint8Array;
  payload_iv: Uint8Array;
  payload_tag: Uint8Array;
  key_version: number;
  updated_at: number;
}>;

type EventReadback = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

function seedProvider(
  storage: Storage,
  payload: LlmOauthPayload | LlmApiKeyPayload = oauthPayload,
): void {
  const sealed = crypto.seal(serializePayload("llm", payload));
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        PROVIDER_ID,
        PROVIDER_NAME,
        "llm",
        INITIAL_UPDATED_AT,
        sealed.ciphertext,
        sealed.iv,
        sealed.tag,
        sealed.keyVersion,
        INITIAL_UPDATED_AT,
      ],
    );
  });
}

function readProvider(
  storage: Storage,
  id = PROVIDER_ID,
): ProviderReadback | undefined {
  return storage.transact((transaction) =>
    transaction.get(
      "SELECT id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at FROM provider WHERE id = ?",
      [id],
    ),
  ) as ProviderReadback | undefined;
}

function readEvents(storage: Storage): readonly EventReadback[] {
  const rows = storage.transact((transaction) =>
    transaction.all(
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event ORDER BY id",
    ),
  ) as readonly EventReadback[];
  return rows.map((row) => ({ ...row }));
}

function createWriter(
  storage: Storage,
  events?: EventLog,
  clock: Clock = createMockClock({ start: REFRESHED_AT }),
): SqliteCredentialWriter {
  const dependencies: SqliteCredentialWriterDependencies = {
    storage,
    crypto,
    events:
      events ??
      new SqliteEventLog({
        storage,
        ids: createMockIdGenerator({ ulids: [EVENT_ID] }),
      }),
    clock,
  };
  return new SqliteCredentialWriter(dependencies);
}

function payloadColumnBytes(row: ProviderReadback): Buffer {
  return Buffer.concat([
    Buffer.from(row.payload_ciphertext),
    Buffer.from(row.payload_iv),
    Buffer.from(row.payload_tag),
  ]);
}

describe("src/services/provider-auth/credential-writer", () => {
  it("re-encrypts the row and appends exactly one provider.credentialRefreshed event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage);

    createWriter(temporary.storage).write(PROVIDER_ID, rotatedCredential);

    const row = readProvider(temporary.storage);
    assert.ok(row !== undefined);
    const opened = crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    });
    assert.deepEqual(deserializePayload("llm", opened), {
      ...oauthPayload,
      credential: rotatedCredential,
    });
    assert.equal(row.updated_at, REFRESHED_AT);
    assert.deepEqual(readEvents(temporary.storage), [
      {
        id: `event_${EVENT_ID}`,
        subject_kind: "provider",
        subject_id: PROVIDER_ID,
        type: "provider.credentialRefreshed",
        actor_kind: "daemon",
        actor_id: "daemon",
        payload_json: JSON.stringify({
          name: PROVIDER_NAME,
          kind: "llm",
          refreshedAt: REFRESHED_AT,
        }),
      },
    ]);
  });

  it("changes no other column", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage);
    const before = readProvider(temporary.storage);
    assert.ok(before !== undefined);

    createWriter(temporary.storage).write(PROVIDER_ID, rotatedCredential);

    const after = readProvider(temporary.storage);
    assert.ok(after !== undefined);
    assert.equal(after.id, before.id);
    assert.equal(after.name, before.name);
    assert.equal(after.kind, before.kind);
    assert.equal(after.set_default_at, before.set_default_at);
  });

  it("writes new ciphertext bytes", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage);
    const before = readProvider(temporary.storage);
    assert.ok(before !== undefined);

    createWriter(temporary.storage).write(PROVIDER_ID, rotatedCredential);

    const after = readProvider(temporary.storage);
    assert.ok(after !== undefined);
    assert.notEqual(
      Buffer.compare(
        Buffer.from(before.payload_ciphertext),
        Buffer.from(after.payload_ciphertext),
      ),
      0,
    );
    const raw = payloadColumnBytes(after);
    for (const token of ["access-after", "refresh-after"]) {
      assert.equal(raw.includes(Buffer.from(token, "utf8")), false);
    }
  });

  it("a failing write leaves the ciphertext byte-identical and appends no event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage);
    const before = readProvider(temporary.storage);
    assert.ok(before !== undefined);
    const inner = new SqliteEventLog({
      storage: temporary.storage,
      ids: createMockIdGenerator({ ulids: [EVENT_ID] }),
    });
    const events: EventLog = {
      append() {
        throw new Error("event append failed");
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };

    assert.throws(
      () =>
        createWriter(temporary.storage, events).write(
          PROVIDER_ID,
          rotatedCredential,
        ),
      (error: unknown) =>
        error instanceof Error && error.message === "event append failed",
    );

    const after = readProvider(temporary.storage);
    assert.deepEqual(after, before);
    assert.deepEqual(readEvents(temporary.storage), []);
  });

  it("is a no-op for a provider row that no longer exists", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    assert.doesNotThrow(() =>
      createWriter(temporary.storage).write(PROVIDER_ID, rotatedCredential),
    );
    assert.equal(readProvider(temporary.storage), undefined);
    assert.deepEqual(readEvents(temporary.storage), []);
  });

  it("is a no-op for an api-key payload", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    seedProvider(temporary.storage, {
      provider: "openai",
      apiKey: "api-key-before",
      defaultModel: "gpt-4o",
      baseUrl: null,
    });
    const before = readProvider(temporary.storage);
    assert.ok(before !== undefined);

    createWriter(temporary.storage).write(PROVIDER_ID, rotatedCredential);

    assert.deepEqual(readProvider(temporary.storage), before);
    assert.deepEqual(readEvents(temporary.storage), []);
  });
});
