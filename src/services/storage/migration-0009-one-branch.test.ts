import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test/helpers/database.ts";
import { seedNode } from "../../../test/helpers/rows.ts";
import { proposalStatements } from "../../../test/helpers/proposal.ts";
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
import { StorageError } from "./index.ts";

const REPOSITORY_ID = "repo_a";
const PROVIDER_ID = "provider_a";
const PROJECT_ID = "project_a";
const INITIATIVE_ID = "initiative_a";
const OBJECTIVE_ID = "objective_a";
const BLOB_HASH = `sha256:${"0".repeat(64)}`;
const REVISION_ID = "revision_a";

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const clock = () => createMockClock({ start: 1700000000000 });

const buildMigratedThroughEight = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: clock(),
    migrations: [
      coreEntities,
      graphAndPlan,
      executionAndJournal,
      migration0004EventIndexes,
      migration0005Actor,
      migration0006RevisionOrigin,
      migration0007ExternalExecution,
      migration0008GraphIndexes,
    ],
  });
  storage.migrate();
  storage.transact((t) => {
    t.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        PROVIDER_ID,
        "work-anthropic",
        "git",
        null,
        new Uint8Array([1]),
        new Uint8Array(12),
        new Uint8Array(16),
        1,
        1,
      ],
    );
  });
  return { storage, temporary };
};

const repositoryColumns =
  "id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at";

const originalColumnNames = [
  "id",
  "name",
  "remote_url",
  "credential_id",
  "home_path",
  "upstream_branch",
  "landing_branch",
  "publish_ref",
  "publish_on_approval",
  "state",
  "diverged_landing_oid",
  "diverged_upstream_oid",
  "fetched_upstream_oid",
  "updated_at",
];

const migratedColumnNames = [
  "id",
  "name",
  "remote_url",
  "credential_id",
  "home_path",
  "branch",
  "publish_on_approval",
  "state",
  "diverged_landing_oid",
  "diverged_upstream_oid",
  "fetched_upstream_oid",
  "updated_at",
];

type RepositorySeed = Readonly<{
  id: string;
  name: string;
  upstream: string;
  landing: string;
  publish: string;
}>;

const insertRepository = (
  storage: SqliteStorage,
  values: RepositorySeed,
): void => {
  storage.transact((t) => {
    t.run(
      `INSERT INTO repository (${repositoryColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.name,
        "https://example.invalid/t.git",
        PROVIDER_ID,
        "repos/t.git",
        values.upstream,
        values.landing,
        values.publish,
        1,
        "ready",
        null,
        null,
        null,
        1,
      ],
    );
  });
};

const seedProjectDependents = (
  storage: SqliteStorage,
  repositoryId: string,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?)",
      [BLOB_HASH, 1, new Uint8Array([0]), 1],
    );
    t.run(
      "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      [PROJECT_ID, "kanthord-verify", "general@1", null, 1],
    );
    t.run(
      "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, "git", repositoryId, 1],
    );
    t.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
      [REVISION_ID, PROJECT_ID, null, "imp_a", BLOB_HASH, BLOB_HASH, BLOB_HASH],
    );
    seedNode(t, {
      id: INITIATIVE_ID,
      kind: "initiative",
      parentId: null,
      title: "Harden the verify CLI",
      state: "pending",
    });
    seedNode(t, {
      id: OBJECTIVE_ID,
      kind: "objective",
      parentId: INITIATIVE_ID,
      title: "Ship the verify CLI",
      repositoryId,
      state: "pending",
    });
  });
};

const columnNames = (storage: SqliteStorage): readonly unknown[] => {
  const rows = storage.transact((t) =>
    t.all("PRAGMA table_info(repository)"),
  ) as readonly Record<string, unknown>[];
  return rows.map((row) => row.name);
};

const tableSql = (storage: SqliteStorage, table: string): string => {
  const row = storage.transact((t) =>
    t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
  ) as { sql: string } | undefined;
  return row === undefined ? "" : row.sql;
};

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

const appliedVersions = (storage: SqliteStorage): readonly number[] =>
  storage.status().applied.map((migration) => migration.version);

describe("src/services/storage/migration-0009-one-branch.test", () => {
  it("migration0009OneBranch carries version 9, its name, and no rebuild", () => {
    assert.equal(migration0009OneBranch.version, 9);
    assert.equal(migration0009OneBranch.name, "0009-one-branch");
    assert.equal(migration0009OneBranch.rebuild, undefined);
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

  it("a fresh database migrates 0001 through 0010 and repository carries branch and neither dropped column", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => storage.close());

    storage.migrate();

    assert.deepEqual(
      appliedVersions(storage),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    assert.deepEqual(storage.status().pending, []);
    assert.deepEqual(columnNames(storage), migratedColumnNames);
  });

  it("the migrated repository table equals the repository proposal fence", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => storage.close());

    storage.migrate();

    assert.deepEqual(
      normalize(tableSql(storage, "repository")),
      proposalStatements("repository"),
    );
  });

  it("a divergent landing_branch is refused, names the repository ORDER BY name picks, and changes nothing", () => {
    const { storage, temporary } = buildMigratedThroughEight();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertRepository(storage, {
      id: "repo_zulu",
      name: "zulu",
      upstream: "main",
      landing: "release",
      publish: "refs/heads/main",
    });
    insertRepository(storage, {
      id: "repo_alpha",
      name: "alpha",
      upstream: "main",
      landing: "next",
      publish: "refs/heads/main",
    });

    const full = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => full.close());

    assert.throws(
      () => full.migrate(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed" &&
        error.message.includes("migration 9 0009-one-branch failed:") &&
        error.message.includes(
          "the repository alpha cannot be migrated to one branch field",
        ),
    );

    assert.deepEqual(appliedVersions(full), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(columnNames(full), originalColumnNames);

    const leftovers = full.transact((t) =>
      t.get(
        "SELECT COUNT(*) AS c FROM temp.sqlite_master WHERE name LIKE 'migration_0009%'",
      ),
    ) as { c: number };
    assert.equal(leftovers.c, 0);
  });

  it("a divergent publish_ref is refused by name too", () => {
    const { storage, temporary } = buildMigratedThroughEight();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertRepository(storage, {
      id: "repo_solo",
      name: "solo",
      upstream: "main",
      landing: "main",
      publish: "refs/heads/release",
    });

    const full = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => full.close());

    assert.throws(
      () => full.migrate(),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "storage-migration-failed" &&
        error.message.includes(
          "the repository solo cannot be migrated to one branch field",
        ),
    );

    assert.deepEqual(appliedVersions(full), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(columnNames(full), originalColumnNames);

    const leftovers = full.transact((t) =>
      t.get(
        "SELECT COUNT(*) AS c FROM temp.sqlite_master WHERE name LIKE 'migration_0009%'",
      ),
    ) as { c: number };
    assert.equal(leftovers.c, 0);
  });

  it("a clean row migrates and its node and project binding survive", () => {
    const { storage, temporary } = buildMigratedThroughEight();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertRepository(storage, {
      id: REPOSITORY_ID,
      name: "kanthord-verify",
      upstream: "main",
      landing: "main",
      publish: "refs/heads/main",
    });
    seedProjectDependents(storage, REPOSITORY_ID);

    const full = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => full.close());

    full.migrate();

    assert.deepEqual(
      appliedVersions(full),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
    const row = full.transact((t) =>
      t.get("SELECT branch FROM repository WHERE id = ?", [REPOSITORY_ID]),
    ) as { branch: string };
    assert.equal(row.branch, "main");
    const node = full.transact((t) =>
      t.get("SELECT repository_id FROM node WHERE id = ?", [OBJECTIVE_ID]),
    ) as { repository_id: string };
    assert.equal(node.repository_id, REPOSITORY_ID);
    const binding = full.transact((t) =>
      t.get(
        "SELECT target_id FROM project_binding WHERE kind = 'git' AND project_id = ?",
        [PROJECT_ID],
      ),
    ) as { target_id: string };
    assert.equal(binding.target_id, REPOSITORY_ID);
  });

  it("re-applying the full chain to an already-migrated database is a no-op", () => {
    const { storage, temporary } = buildMigratedThroughEight();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertRepository(storage, {
      id: REPOSITORY_ID,
      name: "kanthord-verify",
      upstream: "main",
      landing: "main",
      publish: "refs/heads/main",
    });
    seedProjectDependents(storage, REPOSITORY_ID);

    const full = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => full.close());
    full.migrate();

    const second = new SqliteStorage({
      path: temporary.path,
      clock: clock(),
      migrations,
    });
    after(() => second.close());
    second.migrate();

    assert.deepEqual(second.status().pending, []);
    assert.deepEqual(
      appliedVersions(second),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    );
  });
});
