import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import { StorageError } from "../../services/storage/index.ts";
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

const TRANSFER_ULIDS = [
  "01HZY8QF3M4N5P6R7S8T9V0001",
  "01HZY8QF3M4N5P6R7S8T9V0002",
  "01HZY8QF3M4N5P6R7S8T9V0003",
  "01HZY8QF3M4N5P6R7S8T9V0004",
  "01HZY8QF3M4N5P6R7S8T9V0005",
  "01HZY8QF3M4N5P6R7S8T9V0006",
  "01HZY8QF3M4N5P6R7S8T9V0007",
  "01HZY8QF3M4N5P6R7S8T9V0008",
  "01HZY8QF3M4N5P6R7S8T9V0009",
  "01HZY8QF3M4N5P6R7S8T9V0010",
  "01HZY8QF3M4N5P6R7S8T9V0011",
  "01HZY8QF3M4N5P6R7S8T9V0012",
  "01HZY8QF3M4N5P6R7S8T9V0013",
  "01HZY8QF3M4N5P6R7S8T9V0014",
  "01HZY8QF3M4N5P6R7S8T9V0015",
  "01HZY8QF3M4N5P6R7S8T9V0016",
] as const;

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

  function readProviderId(storage: Storage, name: string): string {
    const row = storage.transact((transaction) =>
      transaction.get("SELECT id FROM provider WHERE name = ?", [name]),
    ) as { id: string };
    return row.id;
  }

  function countHolders(storage: Storage): number {
    const row = storage.transact((transaction) =>
      transaction.get(
        "SELECT COUNT(*) AS c FROM provider WHERE kind = 'llm' AND set_default_at IS NOT NULL",
      ),
    ) as { c: number };
    return row.c;
  }

  function bytewise(values: readonly string[]): readonly string[] {
    return [...values].sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
    );
  }

  function readEvents(storage: Storage): readonly EventRowReadback[] {
    return storage.transact((transaction) =>
      transaction.all(
        "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event ORDER BY id ASC",
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

  it("a second llm registration while another holds the stamp takes the default, clears the holder, names it in displaced and appends provider.defaultUnset", (t) => {
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
        "01HZY8QF3M4N5P6R7S8T9V0W23",
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

    const view = setDefaultProvider(setDefaultDeps, {
      id: secondProviderId,
      actor: "ulrich",
    });
    assert.equal(view.setDefaultAt, 1700000002000);
    const released = readProvider(temporary.storage, firstProviderId);
    assert.equal(released.set_default_at, null);
    assert.equal(released.updated_at, 1700000002000);
    const taken = readProvider(temporary.storage, secondProviderId);
    assert.equal(taken.set_default_at, 1700000002000);
    assert.equal(taken.updated_at, 1700000002000);

    assert.deepEqual(view.displaced, [
      { id: firstProviderId, name: "anthropic-bot" },
    ]);

    const events = readEvents(temporary.storage);
    const unset = events.filter(
      (event) => event.type === "provider.defaultUnset",
    );
    assert.equal(unset.length, 1);
    assert.equal(unset[0]!.subject_id, firstProviderId);
    assert.equal(unset[0]!.actor_kind, "human");
    assert.equal(unset[0]!.actor_id, "ulrich");
    assert.equal(
      unset[0]!.payload_json,
      '{"name":"anthropic-bot","kind":"llm","unsetAt":1700000002000}',
    );
    const unsetIndex = events.findIndex(
      (event) => event.type === "provider.defaultUnset",
    );
    const setIndex = events.findIndex(
      (event) =>
        event.type === "provider.defaultSet" &&
        event.subject_id === secondProviderId,
    );
    assert.ok(unsetIndex < setIndex);
    const stamped = events.filter(
      (event) =>
        event.subject_id === secondProviderId &&
        event.type === "provider.defaultSet",
    );
    assert.equal(stamped.length, 1);
    assert.equal(stamped[0]!.actor_kind, "human");
    assert.equal(stamped[0]!.actor_id, "ulrich");
    assert.equal(
      stamped[0]!.payload_json,
      '{"name":"second-bot","kind":"llm","setDefaultAt":1700000002000}',
    );
  });

  it("a transfer clears every other holder in id order and names each one in displaced", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [...TRANSFER_ULIDS] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    for (const name of ["holder-a", "holder-b", "holder-c", "target"]) {
      registerProvider(deps, {
        name,
        kind: "llm",
        payload: llmInput,
        actor: "ulrich",
      });
    }
    const holders = ["holder-a", "holder-b", "holder-c"].map((name) =>
      readProviderId(temporary.storage, name),
    );
    const target = readProviderId(temporary.storage, "target");
    temporary.storage.transact((transaction) => {
      for (const holder of holders) {
        transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
          1699999999000,
          holder,
        ]);
      }
      transaction.run(
        "UPDATE provider SET set_default_at = NULL WHERE id = ?",
        [target],
      );
    });
    const before = countRows(temporary.storage, "event");
    const setDefaultDeps = setDefaultDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = setDefaultProvider(setDefaultDeps, {
      id: target,
      actor: "ulrich",
    });

    assert.equal(countRows(temporary.storage, "event"), before + 4);
    const appended = readEvents(temporary.storage).slice(before);
    assert.deepEqual(
      appended.map((event) => event.type),
      [
        "provider.defaultUnset",
        "provider.defaultUnset",
        "provider.defaultUnset",
        "provider.defaultSet",
      ],
    );
    const cleared = appended.slice(0, 3).map((event) => event.subject_id);
    assert.deepEqual(cleared, bytewise(holders));
    assert.equal(appended[3]!.subject_id, target);
    assert.equal(view.displaced.length, 3);
    assert.deepEqual(
      view.displaced.map((entry) => entry.id),
      cleared,
    );
    assert.equal(countHolders(temporary.storage), 1);
    assert.equal(
      readProvider(temporary.storage, target).set_default_at,
      1700000004000,
    );
  });

  it("a duplicate-holder database is not repaired", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [...TRANSFER_ULIDS] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "holder-a",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "holder-b",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    const first = readProviderId(temporary.storage, "holder-a");
    const second = readProviderId(temporary.storage, "holder-b");
    temporary.storage.transact((transaction) => {
      transaction.run("UPDATE provider SET set_default_at = ? WHERE id = ?", [
        1699999999000,
        second,
      ]);
    });
    const beforeFirst = readProvider(temporary.storage, first);
    const beforeSecond = readProvider(temporary.storage, second);
    const beforeEvents = countRows(temporary.storage, "event");
    const setDefaultDeps = setDefaultDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = setDefaultProvider(setDefaultDeps, {
      id: first,
      actor: "ulrich",
    });

    assert.deepEqual(view.displaced, []);
    const afterFirst = readProvider(temporary.storage, first);
    const afterSecond = readProvider(temporary.storage, second);
    assert.equal(afterFirst.set_default_at, beforeFirst.set_default_at);
    assert.equal(afterFirst.updated_at, beforeFirst.updated_at);
    assert.equal(afterSecond.set_default_at, beforeSecond.set_default_at);
    assert.equal(afterSecond.updated_at, beforeSecond.updated_at);
    assert.equal(countRows(temporary.storage, "event"), beforeEvents);
    assert.equal(countHolders(temporary.storage), 2);
  });

  it("a reentrant transaction refuses and leaves one holder", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({ ulids: [...TRANSFER_ULIDS] });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "holder-a",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "holder-b",
      kind: "llm",
      payload: llmInput,
      actor: "ulrich",
    });
    const target = readProviderId(temporary.storage, "holder-b");
    const beforeEvents = countRows(temporary.storage, "event");
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    const events: EventLog = {
      append(transaction, input) {
        temporary.storage.transact(() => undefined);
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
      () => setDefaultProvider(setDefaultDeps, { id: target, actor: "ulrich" }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-transaction-failed" &&
        error.message === "a transaction is already open",
    );
    assert.equal(countHolders(temporary.storage), 1);
    assert.equal(countRows(temporary.storage, "event"), beforeEvents);
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
      displaced: [],
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
    assert.deepEqual(view.displaced, []);
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
        "01HZY8QF3M4N5P6R7S8T9V0W23",
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
    assert.deepEqual(view.displaced, [
      { id: firstProviderId, name: "anthropic-bot" },
    ]);
    const row = readProvider(temporary.storage, secondProviderId);
    assert.equal(row.set_default_at, 1700000002000);
    assert.equal(row.updated_at, 1700000002000);
    const released = readProvider(temporary.storage, firstProviderId);
    assert.equal(released.set_default_at, null);
    assert.equal(released.updated_at, 1700000002000);
    assert.deepEqual(
      readEvents(temporary.storage)
        .slice(3)
        .map((event) => event.type),
      ["provider.defaultUnset", "provider.defaultSet"],
    );
    assert.equal(countRows(temporary.storage, "event"), 5);
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
