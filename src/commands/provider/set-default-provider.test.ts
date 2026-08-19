import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { registerProvider } from "./register-provider.ts";
import type { RegisterProviderDependencies } from "./register-provider.ts";
import {
  SetDefaultProviderError,
  setDefaultProvider,
} from "./set-default-provider.ts";
import type { SetDefaultProviderDependencies } from "./set-default-provider.ts";
import { createFakeModelCatalog } from "../../../test/helpers/model-catalog.ts";

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

const llmInput = {
  provider: "anthropic",
  apiKey: "sk-ant-x",
  defaultModel: "claude-opus-5",
  baseUrl: null,
} as const;

const gitHttpBasicInput = {
  transport: "http-basic",
  forge: "github",
  username: "kanthord-bot",
  token: "ghp_x",
} as const;

const FIRST_PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const SECOND_PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T9V0W20";
const firstProviderId = `provider_${FIRST_PROVIDER_ULID}`;
const secondProviderId = `provider_${SECOND_PROVIDER_ULID}`;

const llmProjection = {
  provider: "anthropic",
  defaultModel: "claude-opus-5",
  baseUrl: null,
};

describe("src/commands/provider/set-default-provider.test", () => {
  const crypto: Crypto = new AesGcmCrypto({
    key: Buffer.alloc(32, 7),
    keyVersion: 1,
  });

  function registerDependencies(
    storage: Storage,
    ids: IdGenerator,
    clock: Clock,
  ): RegisterProviderDependencies {
    return {
      storage,
      crypto,
      ids,
      clock,
      events: new SqliteEventLog({ storage, ids }),
      catalog: createFakeModelCatalog(),
    };
  }

  function setDefaultDependencies(
    storage: Storage,
    clock: Clock,
    events: EventLog,
  ): SetDefaultProviderDependencies {
    return { storage, crypto, clock, events };
  }

  function countRows(storage: Storage, table: "provider" | "event"): number {
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

  function countingClock(): { clock: Clock; calls: () => number } {
    let calls = 0;
    return {
      clock: {
        now(): number {
          calls++;
          return 1700000000000;
        },
      },
      calls: () => calls,
    };
  }

  it("an unknown id refuses with not-found and writes no row and no event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const deps = setDefaultDependencies(
      temporary.storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
      new SqliteEventLog({
        storage: temporary.storage,
        ids: createMockIdGenerator({ ulids: [] }),
      }),
    );

    assert.throws(
      () =>
        setDefaultProvider(deps, {
          id: "provider_01HZY8QF3M4N5P6R7S8T9V0W0X",
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof SetDefaultProviderError &&
        error.refusal === "not-found" &&
        error.message === "no provider provider_01HZY8QF3M4N5P6R7S8T9V0W0X" &&
        Object.keys(error).sort().join(",") === "name,refusal",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 0);
  });

  it("a git registration refuses with kind-not-chainable before a clock call and keeps its stamp null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [FIRST_PROVIDER_ULID, "01HZY8QF3M4N5P6R7S8T9V0W1Y"],
    });
    registerProvider(
      registerDependencies(
        temporary.storage,
        ids,
        createMockClock({ start: 1700000000000, step: 1000 }),
      ),
      {
        name: "github-bot",
        kind: "git",
        payload: gitHttpBasicInput,
        actor: "ulrich",
      },
    );
    const probe = countingClock();
    const deps = setDefaultDependencies(
      temporary.storage,
      probe.clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () => setDefaultProvider(deps, { id: firstProviderId, actor: "ulrich" }),
      (error: unknown) =>
        error instanceof SetDefaultProviderError &&
        error.refusal === "kind-not-chainable" &&
        error.message ===
          `provider ${firstProviderId} of kind git cannot join the default chain` &&
        Object.keys(error).sort().join(",") === "name,refusal",
    );
    assert.equal(probe.calls(), 0);
    assert.equal(
      readProvider(temporary.storage, firstProviderId).set_default_at,
      null,
    );
    assert.equal(countRows(temporary.storage, "event"), 1);
  });

  it("a second llm registration while another holds the stamp refuses with default-already-set naming the holder and leaves both rows unchanged", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        FIRST_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        SECOND_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W21",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "second-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    const setDefaultDeps = setDefaultDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () =>
        setDefaultProvider(setDefaultDeps, {
          id: secondProviderId,
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof SetDefaultProviderError &&
        error.refusal === "default-already-set" &&
        error.message ===
          `provider ${firstProviderId} already holds the default` &&
        Object.keys(error).sort().join(",") === "ids,name,refusal" &&
        (error.ids === undefined
          ? false
          : error.ids.join(",") === firstProviderId),
    );
    assert.equal(
      readProvider(temporary.storage, firstProviderId).set_default_at,
      1700000000000,
    );
    assert.equal(
      readProvider(temporary.storage, secondProviderId).set_default_at,
      null,
    );
    assert.equal(countRows(temporary.storage, "event"), 3);
  });

  it("setDefault on the row that already holds the stamp returns the unchanged view with no clock call and no event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        FIRST_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
      ],
    });
    registerProvider(
      registerDependencies(
        temporary.storage,
        ids,
        createMockClock({ start: 1700000000000, step: 1000 }),
      ),
      {
        name: "anthropic-bot",
        kind: "llm",
        payload: llmInput,
        actor: "ulrich",
      },
    );
    const probe = countingClock();
    const deps = setDefaultDependencies(
      temporary.storage,
      probe.clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = setDefaultProvider(deps, {
      id: firstProviderId,
      actor: "ulrich",
    });
    assert.deepEqual(view, {
      id: firstProviderId,
      name: "anthropic-bot",
      kind: "llm",
      projection: llmProjection,
      setDefaultAt: 1700000000000,
      updatedAt: 1700000000000,
    });
    assert.equal(probe.calls(), 0);
    const row = readProvider(temporary.storage, firstProviderId);
    assert.equal(row.set_default_at, 1700000000000);
    assert.equal(row.updated_at, 1700000000000);
    assert.equal(countRows(temporary.storage, "event"), 2);
  });

  it("a successful stamp writes one timestamp to set_default_at, updated_at and the event payload", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        FIRST_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        SECOND_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W21",
        "01HZY8QF3M4N5P6R7S8T9V0W22",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "second-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    temporary.storage.transact((transaction) => {
      transaction.run(
        "UPDATE provider SET set_default_at = NULL WHERE id = ?",
        [firstProviderId],
      );
    });
    const setDefaultDeps = setDefaultDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = setDefaultProvider(setDefaultDeps, {
      id: secondProviderId,
      actor: "ulrich",
    });
    assert.equal(view.setDefaultAt, 1700000002000);
    assert.equal(view.updatedAt, 1700000002000);
    assert.deepEqual(view.projection, llmProjection);
    const row = readProvider(temporary.storage, secondProviderId);
    assert.equal(row.set_default_at, 1700000002000);
    assert.equal(row.updated_at, 1700000002000);

    const stamped = readEvents(temporary.storage).filter(
      (event) =>
        event.subject_id === secondProviderId &&
        event.type === "provider.defaultSet",
    );
    assert.equal(stamped.length, 1);
    const event = stamped[0]!;
    assert.equal(event.subject_kind, "provider");
    assert.equal(event.subject_id, secondProviderId);
    assert.equal(event.type, "provider.defaultSet");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, "ulrich");
    assert.equal(
      event.payload_json,
      '{"name":"second-bot","kind":"llm","setDefaultAt":1700000002000}',
    );
  });

  it("a corrupted payload tag still stamps and appends the event but returns projection null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        FIRST_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        SECOND_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W21",
        "01HZY8QF3M4N5P6R7S8T9V0W22",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "second-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    temporary.storage.transact((transaction) => {
      transaction.run(
        "UPDATE provider SET payload_tag = ?, set_default_at = ? WHERE id = ?",
        [Buffer.alloc(16, 0), null, secondProviderId],
      );
      transaction.run(
        "UPDATE provider SET set_default_at = NULL WHERE id = ?",
        [firstProviderId],
      );
    });
    const setDefaultDeps = setDefaultDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = setDefaultProvider(setDefaultDeps, {
      id: secondProviderId,
      actor: "ulrich",
    });
    assert.equal(view.projection, null);
    assert.equal(view.setDefaultAt, 1700000002000);
    assert.equal(view.updatedAt, 1700000002000);
    const row = readProvider(temporary.storage, secondProviderId);
    assert.equal(row.set_default_at, 1700000002000);
    assert.equal(row.updated_at, 1700000002000);
    assert.equal(countRows(temporary.storage, "event"), 4);
  });

  it("a throwing event append rolls the stamp and the updated_at back", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        FIRST_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W1Y",
        "01HZY8QF3M4N5P6R7S8T9V0W1Z",
        SECOND_PROVIDER_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W21",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "anthropic-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "second-bot",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    temporary.storage.transact((transaction) => {
      transaction.run(
        "UPDATE provider SET set_default_at = NULL WHERE id = ?",
        [firstProviderId],
      );
    });
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    let appends = 0;
    const events: EventLog = {
      append(transaction, input) {
        appends++;
        if (appends === 1) {
          throw new Error("provider.defaultSet append fails");
        }
        return inner.append(transaction, input);
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };
    const setDefaultDeps = setDefaultDependencies(
      temporary.storage,
      clock,
      events,
    );

    assert.throws(
      () =>
        setDefaultProvider(setDefaultDeps, {
          id: secondProviderId,
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "provider.defaultSet append fails",
    );
    const row = readProvider(temporary.storage, secondProviderId);
    assert.equal(row.set_default_at, null);
    assert.equal(row.updated_at, 1700000001000);
    assert.equal(countRows(temporary.storage, "event"), 3);
  });
});
