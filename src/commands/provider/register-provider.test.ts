import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import {
  PayloadError,
  llmOauthRegisterPayload,
  parsePayload,
  serializePayload,
} from "../../domain/provider-payload.ts";
import {
  RegisterProviderError,
  registerProvider,
} from "./register-provider.ts";
import type {
  RegisterProviderDependencies,
  RegisterProviderInput,
  RegisterProviderRefusal,
} from "./register-provider.ts";
import type { ProviderView } from "../../domain/provider-view.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { tableBytes } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { resolveTools } from "../../../test/helpers/remote/tools.ts";
import {
  catalogModel,
  createFakeModelCatalog,
} from "../../../test/helpers/model-catalog.ts";
import type { ModelCatalog } from "../../services/model-catalog/index.ts";

type ProviderRowReadback = Readonly<{
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

type EventRowReadback = Readonly<{
  id: string;
  subject_kind: string;
  subject_id: string;
  type: string;
  actor_kind: string;
  actor_id: string;
  payload_json: string;
}>;

type ProviderLoginRowReadback = Readonly<{
  id: string;
  provider: string;
  method: string;
  state: string;
  instance_id: string;
  payload_ciphertext: Uint8Array | null;
  payload_iv: Uint8Array | null;
  payload_tag: Uint8Array | null;
  key_version: number | null;
  created_at: number;
  expires_at: number;
}>;

const gitHttpBasicInput = {
  transport: "http-basic",
  forge: "github",
  username: "kanthord-bot",
  token: "ghp_x",
} as const;

const llmInput = {
  provider: "anthropic",
  apiKey: "sk-ant-x",
  defaultModel: "claude-opus-5",
  baseUrl: null,
} as const;

const PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const SECOND_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const SECOND_PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T0W20";
const THIRD_PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T0W21";
const THIRD_EVENT_ULID = "01HZY8QF3M4N5P6R7S8T0W22";
const providerId = `provider_${PROVIDER_ULID}`;
const LOGIN_ULID = "01HZY8QF3M4N5P6R7S8T0W23AB";
const LOGIN_ID = `login_${LOGIN_ULID}`;
const NOW = 1_700_000_000_000;
const LOGIN_EXPIRES_AT = NOW + 600_000;
const OAUTH_CREDENTIAL: Readonly<Record<string, unknown>> = {
  type: "oauth",
  access: "oauth-access-token",
  refresh: "oauth-refresh-token",
  expires: LOGIN_EXPIRES_AT,
};
const OAUTH_DEFAULT_MODEL = "gpt-5-codex";
const OAUTH_INPUT = {
  transport: "oauth",
  loginId: LOGIN_ID,
  defaultModel: OAUTH_DEFAULT_MODEL,
} as const;

function generateKey(file: string, passphrase: string): string {
  execFileSync(
    resolveTools().paths.sshKeygen,
    ["-t", "ed25519", "-N", passphrase, "-f", file],
    { env: {}, encoding: "utf8" },
  );
  return readFileSync(file, "utf8");
}

describe("src/commands/provider/register-provider.test", () => {
  const crypto: Crypto = new AesGcmCrypto({
    key: Buffer.alloc(32, 7),
    keyVersion: 1,
  });

  let encryptedKey = "";
  let plainKey = "";
  const keyDirectory = mkdtempSync(
    join(tmpdir(), "kanthord-register-provider-"),
  );

  before(() => {
    encryptedKey = generateKey(
      join(keyDirectory, "encrypted"),
      "kanthord-passphrase",
    );
    plainKey = generateKey(join(keyDirectory, "plain"), "");
  });

  after(() => {
    rmSync(keyDirectory, { recursive: true, force: true });
  });

  function dependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
    catalog: ModelCatalog = createFakeModelCatalog(),
  ): RegisterProviderDependencies {
    return {
      storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
      catalog,
    };
  }

  function countRows(
    storage: Storage,
    table: "provider" | "provider_login" | "event",
  ): number {
    const row = storage.transact((transaction) =>
      transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
    ) as { c: number };
    return row.c;
  }

  function readProvider(storage: Storage, id: string): ProviderRowReadback {
    return storage.transact((transaction) =>
      transaction.get(
        "SELECT id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at FROM provider WHERE id = ?",
        [id],
      ),
    ) as ProviderRowReadback;
  }

  function readEvents(storage: Storage): readonly EventRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event",
      ),
    ) as readonly EventRowReadback[];
  }

  function readLogin(
    storage: Storage,
    id = LOGIN_ID,
  ): ProviderLoginRowReadback | undefined {
    return storage.transact((transaction) =>
      transaction.get(
        "SELECT id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at FROM provider_login WHERE id = ?",
        [id],
      ),
    ) as ProviderLoginRowReadback | undefined;
  }

  function insertPendingLogin(
    storage: Storage,
    input: Readonly<{
      id?: string;
      provider?: string;
      method?: "manual-code" | "device-code";
      instanceId?: string;
      createdAt?: number;
      expiresAt?: number;
    }> = {},
  ): void {
    storage.transact((transaction) =>
      transaction.run(
        "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, 'pending', ?, NULL, NULL, NULL, NULL, ?, ?)",
        [
          input.id ?? LOGIN_ID,
          input.provider ?? "openai-codex",
          input.method ?? "device-code",
          input.instanceId ?? "daemon_current",
          input.createdAt ?? NOW,
          input.expiresAt ?? LOGIN_EXPIRES_AT,
        ],
      ),
    );
  }

  function insertCompletedLogin(
    storage: Storage,
    input: Readonly<{
      id?: string;
      provider?: string;
      method?: "manual-code" | "device-code";
      instanceId?: string;
      createdAt?: number;
      expiresAt?: number;
      credential?: Readonly<Record<string, unknown>>;
      models?: readonly string[];
    }> = {},
  ): void {
    const credential = input.credential ?? OAUTH_CREDENTIAL;
    const models = input.models ?? [OAUTH_DEFAULT_MODEL];
    const sealed = crypto.seal(JSON.stringify({ credential, models }));
    storage.transact((transaction) =>
      transaction.run(
        "INSERT INTO provider_login (id, provider, method, state, instance_id, payload_ciphertext, payload_iv, payload_tag, key_version, created_at, expires_at) VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)",
        [
          input.id ?? LOGIN_ID,
          input.provider ?? "openai-codex",
          input.method ?? "device-code",
          input.instanceId ?? "daemon_current",
          sealed.ciphertext,
          sealed.iv,
          sealed.tag,
          sealed.keyVersion,
          input.createdAt ?? NOW,
          input.expiresAt ?? LOGIN_EXPIRES_AT,
        ],
      ),
    );
  }

  function insertExistingProvider(
    storage: Storage,
    name = "seed-provider",
    id = "provider_seed",
  ): void {
    const sealed = crypto.seal("{}");
    storage.transact((transaction) =>
      transaction.run(
        "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, 'llm', NULL, ?, ?, ?, ?, ?)",
        [
          id,
          name,
          sealed.ciphertext,
          sealed.iv,
          sealed.tag,
          sealed.keyVersion,
          NOW,
        ],
      ),
    );
  }

  function oauthCatalog(
    modelIds: readonly string[] = [OAUTH_DEFAULT_MODEL],
  ): ModelCatalog {
    return createFakeModelCatalog({
      providers: [
        {
          id: "openai-codex",
          name: "OpenAI Codex",
          baseUrl: null,
          requiresBaseUrl: false,
          oauth: { label: "OpenAI (ChatGPT Plus/Pro)" },
          models: modelIds.map((id) =>
            catalogModel(id, {
              provider: "openai-codex",
              baseUrl: "https://api.openai.com/v1",
            }),
          ),
        },
      ],
    });
  }

  function assertRegisterRefusal(
    operation: () => unknown,
    refusal: RegisterProviderRefusal,
  ): void {
    assert.throws(
      operation,
      (error: unknown) =>
        error instanceof RegisterProviderError && error.refusal === refusal,
    );
  }

  it("a git http-basic registration inserts one row with the canonical ciphertext", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = dependencies(temporary.storage, ids, clock);

    const view = registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });

    assert.deepEqual(view, {
      id: providerId,
      name: "github-bot",
      kind: "git",
      projection: {
        transport: "http-basic",
        forge: "github",
        username: "kanthord-bot",
      },
      setDefaultAt: null,
      updatedAt: 1700000000000,
    });

    const row = readProvider(temporary.storage, providerId);
    assert.equal(row.id, providerId);
    assert.equal(row.name, "github-bot");
    assert.equal(row.kind, "git");
    assert.equal(row.set_default_at, null);
    assert.equal(row.key_version, 1);
    assert.equal(row.updated_at, 1700000000000);
    assert.equal(row.payload_iv.length, 12);
    assert.equal(row.payload_tag.length, 16);

    const opened = crypto.open({
      ciphertext: row.payload_ciphertext,
      iv: row.payload_iv,
      tag: row.payload_tag,
      keyVersion: row.key_version,
    });
    const parsed = parsePayload("git", gitHttpBasicInput);
    assert.equal(opened, serializePayload("git", parsed));
  });

  it("the token is nowhere in plaintext", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    const view = registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    const row = readProvider(temporary.storage, providerId);
    const ciphertext = Buffer.from(row.payload_ciphertext);
    assert.equal(ciphertext.toString("latin1").includes("ghp_x"), false);

    const events = readEvents(temporary.storage);
    assert.equal(events[0]?.payload_json.includes("ghp_x"), false);
    assert.equal(JSON.stringify(view).includes("ghp_x"), false);
  });

  it("a first llm registration stamps set_default_at with its own updated_at", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, "01HZY8QF3M4N5P6R7S8T9V0W1Z"],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    const view = registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    assert.equal(view.kind, "llm");
    assert.deepEqual(view.projection, {
      transport: "api-key",
      provider: "anthropic",
      defaultModel: "claude-opus-5",
      baseUrl: null,
    });
    assert.equal(view.setDefaultAt, 1700000000000);
    const row = readProvider(temporary.storage, providerId);
    assert.equal(row.kind, "llm");
    assert.equal(row.set_default_at, 1700000000000);
    assert.equal(row.updated_at, 1700000000000);
  });

  it("a first llm registration appends provider.registered then provider.defaultSet in id order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
      ],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });

    const events = [...readEvents(temporary.storage)].sort((a, b) =>
      Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((event) => event.type),
      ["provider.registered", "provider.defaultSet"],
    );
    for (const event of events) {
      assert.equal(event.subject_kind, "provider");
      assert.equal(event.subject_id, providerId);
      assert.equal(event.actor_kind, "human");
      assert.equal(event.actor_id, "ulrich");
    }
    assert.equal(
      events[0]!.payload_json,
      '{"name":"anthropic-bot","kind":"llm"}',
    );
    assert.equal(
      events[1]!.payload_json,
      '{"name":"anthropic-bot","kind":"llm","setDefaultAt":1700000000000}',
    );
  });

  it("a second llm registration stores a null set_default_at and appends only provider.registered", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        "01HZY8QF3M4N5P6R7S8T9V0W20",
        "01HZY8QF3M4N5P6R7S8T9V0W21",
      ],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    assert.equal(
      readProvider(temporary.storage, providerId).set_default_at,
      1700000000000,
    );

    const secondProviderId = "provider_01HZY8QF3M4N5P6R7S8T9V0W20";
    const view = registerProvider(deps, {
      name: "second-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    assert.equal(view.setDefaultAt, null);
    assert.equal(
      readProvider(temporary.storage, secondProviderId).set_default_at,
      null,
    );
    const secondEvents = readEvents(temporary.storage).filter(
      (event) => event.subject_id === secondProviderId,
    );
    assert.deepEqual(
      secondEvents.map((event) => event.type),
      ["provider.registered"],
    );
  });

  it("an llm registration while an unstamped llm row exists stores a null set_default_at and appends only provider.registered", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    temporary.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "provider_unstamped",
          "legacy-bot",
          "llm",
          null,
          Buffer.alloc(16, 1),
          Buffer.alloc(12, 2),
          Buffer.alloc(16, 3),
          1,
          1700000000000,
        ],
      );
    });

    const view = registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    assert.equal(view.setDefaultAt, null);
    assert.equal(
      readProvider(temporary.storage, providerId).set_default_at,
      null,
    );
    const events = readEvents(temporary.storage);
    assert.deepEqual(
      events.map((event) => event.type),
      ["provider.registered"],
    );
  });

  it("a git registration stores a null set_default_at and appends only provider.registered even when a git row exists", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        EVENT_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        "01HZY8QF3M4N5P6R7S8T9V0W20",
      ],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    assert.equal(
      readProvider(temporary.storage, providerId).set_default_at,
      null,
    );

    const secondProviderId = "provider_01HZY8QF3M4N5P6R7S8T9V0W1Z";
    const view = registerProvider(deps, {
      name: "gitlab-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    assert.equal(view.setDefaultAt, null);
    assert.equal(
      readProvider(temporary.storage, secondProviderId).set_default_at,
      null,
    );
    const secondEvents = readEvents(temporary.storage).filter(
      (event) => event.subject_id === secondProviderId,
    );
    assert.deepEqual(
      secondEvents.map((event) => event.type),
      ["provider.registered"],
    );
  });

  it("an event append that throws inside the transaction leaves provider and event counts at zero", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, "01HZY8QF3M4N5P6R7S8T9V0W1Z"],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    let appends = 0;
    const events: EventLog = {
      append(transaction, input) {
        appends++;
        if (appends === 2) {
          throw new Error("second event append fails");
        }
        return inner.append(transaction, input);
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };

    assert.throws(
      () =>
        registerProvider(
          {
            storage: temporary.storage,
            crypto,
            ids,
            clock,
            events,
            catalog: createFakeModelCatalog(),
          },
          {
            name: "anthropic-bot",
            kind: "llm",
            payload: llmInput,
            actor: "ulrich",
          },
        ),
      (error: unknown) =>
        error instanceof Error && error.message === "second event append fails",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 0);
  });

  it("writes exactly one provider.registered event naming name and kind and nothing else", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });

    const events = readEvents(temporary.storage);
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.subject_kind, "provider");
    assert.equal(event.subject_id, providerId);
    assert.equal(event.type, "provider.registered");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, "ulrich");
    assert.equal(event.payload_json, '{"name":"github-bot","kind":"git"}');
  });

  it("a duplicate name refuses with name-taken and rolls the write back", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        EVENT_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        "01HZY8QF3M4N5P6R7S8T9V0W20",
      ],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });

    assert.throws(
      () =>
        registerProvider(deps, {
          name: "github-bot",
          kind: "git",
          payload: gitHttpBasicInput,
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof RegisterProviderError &&
        error.refusal === "name-taken",
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });

  it("an invalid payload refuses before it reaches storage or the id generator", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    assert.throws(
      () =>
        registerProvider(deps, {
          name: "github-bot",
          kind: "git",
          payload: {
            transport: "http-basic",
            forge: "codeberg",
            username: "kanthord-bot",
            token: "ghp_x",
          },
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof PayloadError && error.refusal === "payload-invalid",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 0);
  });

  it("an encrypted ssh key refuses at registration and writes no row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    assert.throws(
      () =>
        registerProvider(deps, {
          name: "ssh-bot",
          kind: "git",
          payload: { transport: "ssh", privateKey: encryptedKey },
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof PayloadError &&
        error.refusal === "private-key-encrypted",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 0);
  });

  it("accepts an unencrypted ssh private key through the same path", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );

    const view = registerProvider(deps, {
      name: "ssh-bot",
      kind: "git",
      payload: { transport: "ssh", privateKey: plainKey },
      actor: "ulrich",
    });
    assert.deepEqual(view.projection, {
      transport: "ssh",
      forge: null,
      username: null,
    });
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });
  describe("the llm provider catalog", () => {
    it("refuses an unknown provider with provider-unknown and writes nothing", (t) => {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
      const clock = createMockClock({ start: 1_700_000_000_000 });

      assert.throws(
        () =>
          registerProvider(dependencies(temporary.storage, ids, clock), {
            name: "nonesuch-llm",
            kind: "llm",
            payload: { ...llmInput, provider: "nonesuch" },
            actor: "ulrich",
          }),
        (error: unknown) =>
          error instanceof RegisterProviderError &&
          error.refusal === "provider-unknown",
      );
      assert.equal(countRows(temporary.storage, "provider"), 0);
    });

    it("refuses a baseUrl on a built-in provider with base-url-not-allowed", (t) => {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
      const clock = createMockClock({ start: 1_700_000_000_000 });

      assert.throws(
        () =>
          registerProvider(dependencies(temporary.storage, ids, clock), {
            name: "anthropic-bot",
            kind: "llm",
            payload: { ...llmInput, baseUrl: "http://localhost:11434/v1" },
            actor: "ulrich",
          }),
        (error: unknown) =>
          error instanceof RegisterProviderError &&
          error.refusal === "base-url-not-allowed",
      );
      assert.equal(countRows(temporary.storage, "provider"), 0);
    });

    it("refuses a null baseUrl on openai-compatible with base-url-required", (t) => {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
      const clock = createMockClock({ start: 1_700_000_000_000 });

      assert.throws(
        () =>
          registerProvider(dependencies(temporary.storage, ids, clock), {
            name: "ollama",
            kind: "llm",
            payload: { ...llmInput, provider: "openai-compatible" },
            actor: "ulrich",
          }),
        (error: unknown) =>
          error instanceof RegisterProviderError &&
          error.refusal === "base-url-required",
      );
      assert.equal(countRows(temporary.storage, "provider"), 0);
    });

    it("accepts openai-compatible with a baseUrl and projects it", (t) => {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      const ids = createMockIdGenerator({
        ulids: [PROVIDER_ULID, EVENT_ULID, "01HZY8QF3M4N5P6R7S8T9V0W1Z"],
      });
      const clock = createMockClock({ start: 1_700_000_000_000 });

      const view = registerProvider(
        dependencies(temporary.storage, ids, clock),
        {
          name: "ollama",
          kind: "llm",
          payload: {
            ...llmInput,
            provider: "openai-compatible",
            baseUrl: "http://localhost:11434/v1",
          },
          actor: "ulrich",
        },
      );

      assert.deepEqual(view.projection, {
        transport: "api-key",
        provider: "openai-compatible",
        defaultModel: "claude-opus-5",
        baseUrl: "http://localhost:11434/v1",
      });
      assert.equal(countRows(temporary.storage, "provider"), 1);
    });

    it("applies no catalog rule to a git registration", (t) => {
      const temporary = createMigratedStorage();
      t.after(() => temporary.dispose());
      const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID, EVENT_ULID] });
      const clock = createMockClock({ start: 1_700_000_000_000 });

      const view = registerProvider(
        dependencies(temporary.storage, ids, clock),
        {
          name: "github",
          kind: "git",
          payload: gitHttpBasicInput,
          actor: "ulrich",
        },
      );

      assert.equal(view.kind, "git");
      assert.equal(countRows(temporary.storage, "provider"), 1);
    });
  });

  it("registers from a completed login and consumes the row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompletedLogin(temporary.storage);
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, SECOND_EVENT_ULID],
    });
    const clock = createMockClock({ start: NOW, step: 1000 });

    const view = registerProvider(
      dependencies(temporary.storage, ids, clock, oauthCatalog()),
      {
        name: "codex-bot",
        kind: "llm",
        payload: OAUTH_INPUT,
        actor: "ulrich",
      },
    );

    assert.equal(llmOauthRegisterPayload.safeParse(OAUTH_INPUT).success, true);
    assert.deepEqual(view, {
      id: providerId,
      name: "codex-bot",
      kind: "llm",
      projection: {
        transport: "oauth",
        provider: "openai-codex",
        defaultModel: OAUTH_DEFAULT_MODEL,
      },
      setDefaultAt: NOW,
      updatedAt: NOW,
    });
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "provider_login"), 0);
  });

  it("stores the credential encrypted and nowhere in plaintext", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const credential = {
      ...OAUTH_CREDENTIAL,
      access: "access-fixture-token",
      refresh: "refresh-fixture-token",
    };
    insertCompletedLogin(temporary.storage, { credential });
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, SECOND_EVENT_ULID],
    });

    const view = registerProvider(
      dependencies(
        temporary.storage,
        ids,
        createMockClock({ start: NOW }),
        oauthCatalog(),
      ),
      {
        name: "codex-bot",
        kind: "llm",
        payload: OAUTH_INPUT,
        actor: "ulrich",
      },
    );
    const row = readProvider(temporary.storage, providerId);
    const ciphertext = Buffer.from(row.payload_ciphertext).toString("latin1");
    assert.equal(ciphertext.includes("access-fixture-token"), false);
    assert.equal(ciphertext.includes("refresh-fixture-token"), false);
    assert.equal(JSON.stringify(view).includes("access-fixture-token"), false);
    assert.equal(JSON.stringify(view).includes("refresh-fixture-token"), false);
    assert.deepEqual(
      JSON.parse(
        crypto.open({
          ciphertext: row.payload_ciphertext,
          iv: row.payload_iv,
          tag: row.payload_tag,
          keyVersion: row.key_version,
        }),
      ),
      {
        transport: "oauth",
        provider: "openai-codex",
        credential,
        defaultModel: OAUTH_DEFAULT_MODEL,
      },
    );
  });

  it("refuses login-not-found for an unknown loginId and writes nothing", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID] });

    assertRegisterRefusal(
      () =>
        registerProvider(
          dependencies(
            temporary.storage,
            ids,
            createMockClock({ start: NOW }),
            oauthCatalog(),
          ),
          {
            name: "codex-bot",
            kind: "llm",
            payload: OAUTH_INPUT,
            actor: "ulrich",
          },
        ),
      "login-not-found",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
  });

  it("refuses login-not-completed for a pending login and leaves the login row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertPendingLogin(temporary.storage);
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID] });

    assertRegisterRefusal(
      () =>
        registerProvider(
          dependencies(
            temporary.storage,
            ids,
            createMockClock({ start: NOW }),
            oauthCatalog(),
          ),
          {
            name: "codex-bot",
            kind: "llm",
            payload: OAUTH_INPUT,
            actor: "ulrich",
          },
        ),
      "login-not-completed",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(readLogin(temporary.storage)?.state, "pending");
  });

  it("refuses default-model-unknown when the model is not in the stored list", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompletedLogin(temporary.storage, { models: ["other-model"] });
    const before = tableBytes(temporary.storage, "provider_login");
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID] });

    assertRegisterRefusal(
      () =>
        registerProvider(
          dependencies(
            temporary.storage,
            ids,
            createMockClock({ start: NOW }),
            oauthCatalog(),
          ),
          {
            name: "codex-bot",
            kind: "llm",
            payload: OAUTH_INPUT,
            actor: "ulrich",
          },
        ),
      "default-model-unknown",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(
      tableBytes(temporary.storage, "provider_login").equals(before),
      true,
    );
  });

  it("rolls the delete back when the insert fails", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertExistingProvider(temporary.storage, "codex-bot");
    insertCompletedLogin(temporary.storage);
    const ids = createMockIdGenerator({ ulids: [PROVIDER_ULID] });

    assertRegisterRefusal(
      () =>
        registerProvider(
          dependencies(
            temporary.storage,
            ids,
            createMockClock({ start: NOW }),
            oauthCatalog(),
          ),
          {
            name: "codex-bot",
            kind: "llm",
            payload: OAUTH_INPUT,
            actor: "ulrich",
          },
        ),
      "name-taken",
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "provider_login"), 1);
    assert.equal(readLogin(temporary.storage)?.state, "completed");
  });

  it("registers on a completed login whose stored instance is not the running one", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompletedLogin(temporary.storage, { instanceId: "daemon_previous" });
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, SECOND_EVENT_ULID],
    });

    const view = registerProvider(
      dependencies(
        temporary.storage,
        ids,
        createMockClock({ start: NOW }),
        oauthCatalog(),
      ),
      {
        name: "codex-bot",
        kind: "llm",
        payload: OAUTH_INPUT,
        actor: "ulrich",
      },
    );

    assert.deepEqual(view.projection, {
      transport: "oauth",
      provider: "openai-codex",
      defaultModel: OAUTH_DEFAULT_MODEL,
    });
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "provider_login"), 0);
  });

  it("replaying a consumed loginId refuses login-not-found and writes no second row", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompletedLogin(temporary.storage);
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        EVENT_ULID,
        SECOND_EVENT_ULID,
        SECOND_PROVIDER_ULID,
      ],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: NOW }),
      oauthCatalog(),
    );

    registerProvider(deps, {
      name: "codex-bot",
      kind: "llm",
      payload: OAUTH_INPUT,
      actor: "ulrich",
    });
    assertRegisterRefusal(
      () =>
        registerProvider(deps, {
          name: "second-codex-bot",
          kind: "llm",
          payload: OAUTH_INPUT,
          actor: "ulrich",
        }),
      "login-not-found",
    );
    assert.equal(countRows(temporary.storage, "provider"), 1);
    assert.equal(countRows(temporary.storage, "provider_login"), 0);
  });

  it("stamps the first llm registration by the oauth arm as the default", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompletedLogin(temporary.storage);
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, SECOND_EVENT_ULID],
    });

    registerProvider(
      dependencies(
        temporary.storage,
        ids,
        createMockClock({ start: NOW }),
        oauthCatalog(),
      ),
      {
        name: "codex-bot",
        kind: "llm",
        payload: OAUTH_INPUT,
        actor: "ulrich",
      },
    );

    assert.equal(
      readProvider(temporary.storage, providerId).set_default_at,
      NOW,
    );
    const events = [...readEvents(temporary.storage)].sort((a, b) =>
      Buffer.compare(Buffer.from(a.id), Buffer.from(b.id)),
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["provider.registered", "provider.defaultSet"],
    );
    assert.deepEqual(
      events.map((event) => event.subject_id),
      [providerId, providerId],
    );
  });

  it("appends no new event type", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertCompletedLogin(temporary.storage);
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, EVENT_ULID, SECOND_EVENT_ULID],
    });

    registerProvider(
      dependencies(
        temporary.storage,
        ids,
        createMockClock({ start: NOW }),
        oauthCatalog(),
      ),
      {
        name: "codex-bot",
        kind: "llm",
        payload: OAUTH_INPUT,
        actor: "ulrich",
      },
    );

    assert.deepEqual(
      readEvents(temporary.storage).map((event) => event.type),
      ["provider.registered", "provider.defaultSet"],
    );
  });

  it("an absent transport and an explicit api-key transport produce deep-equal results", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    insertExistingProvider(temporary.storage);
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        EVENT_ULID,
        SECOND_PROVIDER_ULID,
        SECOND_EVENT_ULID,
      ],
    });
    const deps = dependencies(
      temporary.storage,
      ids,
      createMockClock({ start: NOW, step: 1000 }),
    );

    const absent = registerProvider(deps, {
      name: "absent-transport",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    const explicit = registerProvider(deps, {
      name: "explicit-transport",
      kind: "llm",
      payload: { ...llmInput, transport: "api-key" },
      actor: "ulrich",
    });

    const comparable = (view: ProviderView): ProviderView => ({
      ...view,
      id: "provider_same",
      name: "same-name",
      updatedAt: NOW,
    });
    assert.deepEqual(comparable(absent), comparable(explicit));

    const absentRow = readProvider(temporary.storage, absent.id);
    const explicitRow = readProvider(temporary.storage, explicit.id);
    const expected =
      '{"provider":"anthropic","apiKey":"sk-ant-x","defaultModel":"claude-opus-5","baseUrl":null}';
    const absentPlaintext = crypto.open({
      ciphertext: absentRow.payload_ciphertext,
      iv: absentRow.payload_iv,
      tag: absentRow.payload_tag,
      keyVersion: absentRow.key_version,
    });
    const explicitPlaintext = crypto.open({
      ciphertext: explicitRow.payload_ciphertext,
      iv: explicitRow.payload_iv,
      tag: explicitRow.payload_tag,
      keyVersion: explicitRow.key_version,
    });
    assert.equal(absentPlaintext, expected);
    assert.equal(explicitPlaintext, expected);
    assert.equal(absentPlaintext, explicitPlaintext);
  });
});
