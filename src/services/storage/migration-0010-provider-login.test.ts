import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createStorageAtVersion,
  type TemporaryStorage,
} from "../../../test/helpers/database.ts";
import { proposalStatements } from "../../../test/helpers/proposal.ts";
import type { Storage } from "./index.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migration0004EventIndexes } from "./migration-0004-event-indexes.ts";
import { migration0005Actor } from "./migration-0005-actor.ts";
import { migration0006RevisionOrigin } from "./migration-0006-revision-origin.ts";
import { migration0007ExternalExecution } from "./migration-0007-external-execution.ts";
import { migration0008GraphIndexes } from "./migration-0008-graph-indexes.ts";
import { migration0009OneBranch } from "./migration-0009-one-branch.ts";
import { migration0010ProviderLogin } from "./migration-0010-provider-login.ts";
import { migration0011Deliverable } from "./migration-0011-deliverable.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const NOW = 1700000000000;
const INSTANCE_ID = "daemon_a";

type ProviderLoginValues = readonly [
  string,
  string,
  string,
  string,
  string,
  Uint8Array | null,
  Uint8Array | null,
  Uint8Array | null,
  number | null,
  number,
  number,
];

const pendingValues = (
  id: string,
  provider: string,
  method = "manual-code",
  state = "pending",
  payloadCiphertext: Uint8Array | null = null,
  payloadIv: Uint8Array | null = null,
  payloadTag: Uint8Array | null = null,
  keyVersion: number | null = null,
): ProviderLoginValues => [
  id,
  provider,
  method,
  state,
  INSTANCE_ID,
  payloadCiphertext,
  payloadIv,
  payloadTag,
  keyVersion,
  NOW,
  NOW + 600000,
];

const completedValues = (
  id: string,
  provider: string,
  payloadCiphertext: Uint8Array | null,
): ProviderLoginValues => [
  id,
  provider,
  "manual-code",
  "completed",
  INSTANCE_ID,
  payloadCiphertext,
  new Uint8Array(12),
  new Uint8Array(16),
  1,
  NOW,
  NOW + 600000,
];

const insertProviderLogin = (
  storage: Storage,
  values: ProviderLoginValues,
): void => {
  storage.transact((transaction) =>
    transaction.run(
      `INSERT INTO provider_login (
  id, provider, method, state, instance_id,
  payload_ciphertext, payload_iv, payload_tag, key_version,
  created_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      values,
    ),
  );
};

const rowCount = (storage: Storage): number => {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT COUNT(*) AS count FROM provider_login"),
  ) as { count: number };
  return row.count;
};

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

const objectSql = (storage: Storage, name: string): string => {
  const row = storage.transact((transaction) =>
    transaction.get("SELECT sql FROM sqlite_master WHERE name = ?", [name]),
  ) as { sql: string } | undefined;
  return row === undefined ? "" : row.sql;
};

const upgradeFromNine = (): Readonly<{
  storage: SqliteStorage;
  base: TemporaryStorage;
}> => {
  const base = createStorageAtVersion(9);
  base.storage.close();
  const storage = new SqliteStorage({
    path: base.path,
    clock: createMockClock({ start: NOW, step: 1000 }),
    migrations,
  });
  return { storage, base };
};

const closeUpgrade = (
  upgrade: Readonly<{
    storage: SqliteStorage;
    base: TemporaryStorage;
  }>,
): void => {
  upgrade.storage.close();
  upgrade.base.dispose();
};

const migratedVersions = (storage: SqliteStorage): readonly number[] =>
  storage.status().applied.map((migration) => migration.version);

describe("src/services/storage/migration-0010-provider-login.test", () => {
  it("migration0010ProviderLogin carries version 10, its name, and no rebuild", () => {
    assert.equal(migration0010ProviderLogin.version, 10);
    assert.equal(migration0010ProviderLogin.name, "0010-provider-login");
    assert.equal(migration0010ProviderLogin.rebuild, undefined);
  });

  it("migrations holds exactly eleven migrations with migration0011Deliverable last", () => {
    assert.deepEqual(migrations, [
      coreEntities,
      graphAndPlan,
      executionAndJournal,
      migration0004EventIndexes,
      migration0005Actor,
      migration0006RevisionOrigin,
      migration0007ExternalExecution,
      migration0008GraphIndexes,
      migration0009OneBranch,
      migration0010ProviderLogin,
      migration0011Deliverable,
    ]);
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
  });

  it("a database at version 9 migrates to 10 and gains provider_login", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();

      assert.deepEqual(
        migratedVersions(upgrade.storage),
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
      );
      assert.deepEqual(upgrade.storage.status().pending, []);

      const columns = upgrade.storage.transact((transaction) =>
        transaction.all("PRAGMA table_info(provider_login)"),
      ) as readonly Record<string, unknown>[];
      assert.deepEqual(
        columns.map((column) => column.name),
        [
          "id",
          "provider",
          "method",
          "state",
          "instance_id",
          "payload_ciphertext",
          "payload_iv",
          "payload_tag",
          "key_version",
          "created_at",
          "expires_at",
        ],
      );
    } finally {
      closeUpgrade(upgrade);
    }
  });

  it("the migrated provider_login table and index equal the proposal fence", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();

      const actual = [
        ...normalize(objectSql(upgrade.storage, "provider_login")),
        ...normalize(objectSql(upgrade.storage, "provider_login_one_pending")),
      ];
      assert.deepEqual(actual, proposalStatements("provider_login"));
    } finally {
      closeUpgrade(upgrade);
    }
  });

  it("refuses a second pending row for the same vendor", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();

      insertProviderLogin(
        upgrade.storage,
        pendingValues("login_pending_1", "openai-codex"),
      );
      assert.throws(() =>
        insertProviderLogin(
          upgrade.storage,
          pendingValues("login_pending_2", "openai-codex"),
        ),
      );
      insertProviderLogin(
        upgrade.storage,
        pendingValues("login_pending_3", "anthropic"),
      );
      insertProviderLogin(
        upgrade.storage,
        completedValues(
          "login_completed_1",
          "openai-codex",
          new Uint8Array([1, 2, 3]),
        ),
      );
      assert.equal(rowCount(upgrade.storage), 3);
    } finally {
      closeUpgrade(upgrade);
    }
  });

  it("refuses a pending row carrying ciphertext", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();
      assert.equal(rowCount(upgrade.storage), 0);

      assert.throws(() =>
        insertProviderLogin(
          upgrade.storage,
          pendingValues(
            "login_pending_ciphertext",
            "openai-codex",
            "manual-code",
            "pending",
            new Uint8Array([1]),
          ),
        ),
      );
    } finally {
      closeUpgrade(upgrade);
    }
  });

  it("refuses a completed row with no ciphertext", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();
      assert.equal(rowCount(upgrade.storage), 0);

      assert.throws(() =>
        insertProviderLogin(
          upgrade.storage,
          completedValues("login_completed_ciphertext", "openai-codex", null),
        ),
      );
    } finally {
      closeUpgrade(upgrade);
    }
  });

  it("refuses a method or state outside its closed set", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();
      assert.equal(rowCount(upgrade.storage), 0);

      assert.throws(() =>
        insertProviderLogin(
          upgrade.storage,
          pendingValues("login_invalid_method", "openai-codex", "browser"),
        ),
      );
      assert.throws(() =>
        insertProviderLogin(
          upgrade.storage,
          pendingValues(
            "login_invalid_state",
            "openai-codex",
            "manual-code",
            "failed",
          ),
        ),
      );
    } finally {
      closeUpgrade(upgrade);
    }
  });

  it("re-applying the full chain to an already-migrated database is a no-op", () => {
    const upgrade = upgradeFromNine();
    try {
      upgrade.storage.migrate();
      upgrade.storage.close();

      const second = new SqliteStorage({
        path: upgrade.base.path,
        clock: createMockClock({ start: NOW, step: 1000 }),
        migrations,
      });
      try {
        second.migrate();
        assert.deepEqual(second.status().pending, []);
        assert.deepEqual(
          migratedVersions(second),
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        );
      } finally {
        second.close();
      }
    } finally {
      closeUpgrade(upgrade);
    }
  });
});
