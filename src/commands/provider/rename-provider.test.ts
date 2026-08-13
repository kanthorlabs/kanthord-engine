import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AesGcmCrypto } from "../../services/crypto/aes-gcm.ts";
import type { Crypto } from "../../services/crypto/index.ts";
import { SqliteEventLog } from "../../services/event/sqlite.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import { RenameProviderError, renameProvider } from "./rename-provider.ts";
import type { RenameProviderDependencies } from "./rename-provider.ts";
import { registerProvider } from "./register-provider.ts";
import type { RegisterProviderDependencies } from "./register-provider.ts";
import type { ProviderView } from "../../domain/provider-view.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";

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

const gitHttpBasicInput = {
  transport: "http-basic",
  forge: "github",
  username: "kanthord-bot",
  token: "ghp_x",
} as const;

const PROVIDER_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const REGISTERED_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Y";
const RENAMED_ULID = "01HZY8QF3M4N5P6R7S8T9V0W1Z";
const providerId = `provider_${PROVIDER_ULID}`;

const gitProjection = {
  transport: "http-basic",
  forge: "github",
  username: "kanthord-bot",
};

describe("src/commands/provider/rename-provider.test", () => {
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
    };
  }

  function renameDependencies(
    storage: Storage,
    clock: Clock,
    events: EventLog,
  ): RenameProviderDependencies {
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
    const deps = renameDependencies(
      temporary.storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
      new SqliteEventLog({
        storage: temporary.storage,
        ids: createMockIdGenerator({ ulids: [] }),
      }),
    );

    assert.throws(
      () =>
        renameProvider(deps, {
          id: providerId,
          name: "github-release",
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof RenameProviderError &&
        error.refusal === "not-found" &&
        error.message === `no provider ${providerId}` &&
        Object.keys(error).sort().join(",") === "name,refusal",
    );
    assert.equal(countRows(temporary.storage, "provider"), 0);
    assert.equal(countRows(temporary.storage, "event"), 0);
  });

  it("a rename to a name another row holds refuses with name-taken and leaves both names unchanged", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [
        PROVIDER_ULID,
        REGISTERED_ULID,
        "01HZY8QF3M4N5P6R7S8T9V0W20",
        "01HZY8QF3M4N5P6R7S8T9V0W21",
      ],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    registerProvider(deps, {
      name: "second-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    const secondId = `provider_01HZY8QF3M4N5P6R7S8T9V0W20`;
    const renameDeps = renameDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    assert.throws(
      () =>
        renameProvider(renameDeps, {
          id: secondId,
          name: "github-bot",
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof RenameProviderError &&
        error.refusal === "name-taken" &&
        error.message === "a provider named github-bot is already registered" &&
        Object.keys(error).sort().join(",") === "name,refusal",
    );
    assert.equal(
      readProvider(temporary.storage, providerId).name,
      "github-bot",
    );
    assert.equal(readProvider(temporary.storage, secondId).name, "second-bot");
    assert.equal(countRows(temporary.storage, "event"), 2);
  });

  it("a rename to the current name returns the unchanged view with no clock call and no event", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID],
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
    const deps = renameDependencies(
      temporary.storage,
      probe.clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = renameProvider(deps, {
      id: providerId,
      name: "github-bot",
      actor: "ulrich",
    });
    assert.deepEqual(view, {
      id: providerId,
      name: "github-bot",
      kind: "git",
      projection: gitProjection,
      setDefaultAt: null,
      updatedAt: 1700000000000,
    });
    assert.equal(probe.calls(), 0);
    const row = readProvider(temporary.storage, providerId);
    assert.equal(row.name, "github-bot");
    assert.equal(row.updated_at, 1700000000000);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });

  it("a successful rename updates only name and updated_at, keeps the encrypted columns byte-identical and appends provider.renamed", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID, RENAMED_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    const before = readProvider(temporary.storage, providerId);
    const renameDeps = renameDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = renameProvider(renameDeps, {
      id: providerId,
      name: "github-release",
      actor: "ulrich",
    });
    assert.deepEqual(view, {
      id: providerId,
      name: "github-release",
      kind: "git",
      projection: gitProjection,
      setDefaultAt: null,
      updatedAt: 1700000001000,
    });
    const after = readProvider(temporary.storage, providerId);
    assert.equal(after.name, "github-release");
    assert.equal(after.kind, "git");
    assert.equal(after.set_default_at, null);
    assert.equal(after.updated_at, 1700000001000);
    assert.equal(
      Buffer.compare(
        Buffer.from(before.payload_ciphertext),
        Buffer.from(after.payload_ciphertext),
      ),
      0,
    );
    assert.equal(
      Buffer.compare(
        Buffer.from(before.payload_iv),
        Buffer.from(after.payload_iv),
      ),
      0,
    );
    assert.equal(
      Buffer.compare(
        Buffer.from(before.payload_tag),
        Buffer.from(after.payload_tag),
      ),
      0,
    );
    assert.equal(after.key_version, before.key_version);

    const renamed = readEvents(temporary.storage).filter(
      (event) =>
        event.subject_id === providerId && event.type === "provider.renamed",
    );
    assert.equal(renamed.length, 1);
    const event = renamed[0]!;
    assert.equal(event.subject_kind, "provider");
    assert.equal(event.subject_id, providerId);
    assert.equal(event.type, "provider.renamed");
    assert.equal(event.actor_kind, "human");
    assert.equal(event.actor_id, "ulrich");
    assert.equal(
      event.payload_json,
      '{"from":"github-bot","to":"github-release"}',
    );
    assert.equal(countRows(temporary.storage, "event"), 2);
  });

  it("a corrupted payload tag still renames and appends the event but returns projection null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID, RENAMED_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    temporary.storage.transact((transaction) => {
      transaction.run("UPDATE provider SET payload_tag = ? WHERE id = ?", [
        Buffer.alloc(16, 0),
        providerId,
      ]);
    });
    const renameDeps = renameDependencies(
      temporary.storage,
      clock,
      new SqliteEventLog({ storage: temporary.storage, ids }),
    );

    const view = renameProvider(renameDeps, {
      id: providerId,
      name: "github-release",
      actor: "ulrich",
    });
    assert.equal(view.projection, null);
    assert.equal(view.name, "github-release");
    assert.equal(view.updatedAt, 1700000001000);
    const row = readProvider(temporary.storage, providerId);
    assert.equal(row.name, "github-release");
    assert.equal(row.updated_at, 1700000001000);
    assert.equal(countRows(temporary.storage, "event"), 2);
  });

  it("a throwing event append restores the old name and the old update time", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const ids = createMockIdGenerator({
      ulids: [PROVIDER_ULID, REGISTERED_ULID],
    });
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const deps = registerDependencies(temporary.storage, ids, clock);
    registerProvider(deps, {
      name: "github-bot",
      kind: "git",
      payload: gitHttpBasicInput,
      actor: "ulrich",
    });
    const inner = new SqliteEventLog({ storage: temporary.storage, ids });
    let appends = 0;
    const events: EventLog = {
      append(transaction, input) {
        appends++;
        if (appends === 1) {
          throw new Error("provider.renamed append fails");
        }
        return inner.append(transaction, input);
      },
      list(filter, transaction) {
        return inner.list(filter, transaction);
      },
    };
    const renameDeps = renameDependencies(temporary.storage, clock, events);

    assert.throws(
      () =>
        renameProvider(renameDeps, {
          id: providerId,
          name: "github-release",
          actor: "ulrich",
        }),
      (error: unknown) =>
        error instanceof Error &&
        error.message === "provider.renamed append fails",
    );
    const row = readProvider(temporary.storage, providerId);
    assert.equal(row.name, "github-bot");
    assert.equal(row.updated_at, 1700000000000);
    assert.equal(countRows(temporary.storage, "event"), 1);
  });
});
