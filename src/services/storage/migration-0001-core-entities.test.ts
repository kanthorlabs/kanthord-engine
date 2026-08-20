import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test/helpers/database.ts";
import { proposalStatements } from "../../../test/helpers/proposal.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migration0004EventIndexes } from "./migration-0004-event-indexes.ts";
import { migration0005Actor } from "./migration-0005-actor.ts";
import { migration0006RevisionOrigin } from "./migration-0006-revision-origin.ts";
import { migration0007ExternalExecution } from "./migration-0007-external-execution.ts";
import { migration0008GraphIndexes } from "./migration-0008-graph-indexes.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const oid = "a".repeat(40);

const repositoryColumns =
  "id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at";

type RepositoryValues = Readonly<{
  id: string;
  name: string;
  state: string;
  landing: string | null;
  upstream: string | null;
  credentialId?: string;
}>;

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildMigrated = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations: [coreEntities],
  });
  storage.migrate();
  storage.transact((t) => seedRegistry(t));
  return { storage, temporary };
};

const countRows = (storage: SqliteStorage, table: string): number => {
  const row = storage.transact((t) =>
    t.get(`SELECT COUNT(*) AS c FROM ${table}`),
  ) as { c: number };
  return row.c;
};

const assertRefused = (
  storage: SqliteStorage,
  fn: () => void,
  table: string,
  options: { message?: string } = {},
): void => {
  const before = countRows(storage, table);
  let thrown: unknown;
  try {
    fn();
    assert.fail("expected a throw");
  } catch (error) {
    thrown = error;
  }
  assert.equal((thrown as { errcode: number }).errcode & 0xff, 19);
  assert.equal(countRows(storage, table), before);
  if (options.message !== undefined) {
    assert.ok(
      (thrown as { message: string }).message.includes(options.message),
    );
  }
};

const insertRepository = (
  storage: SqliteStorage,
  values: RepositoryValues,
): void => {
  storage.transact((t) => {
    t.run(
      `INSERT INTO repository (${repositoryColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        values.id,
        values.name,
        "https://example.invalid/t.git",
        values.credentialId ?? fixtureIds.provider,
        "repos/t.git",
        "main",
        "main",
        "refs/heads/main",
        1,
        values.state,
        values.landing,
        values.upstream,
        null,
        1,
      ],
    );
  });
};

const insertProvider = (
  storage: SqliteStorage,
  id: string,
  name: string,
  kind: string,
  iv: Uint8Array,
  tag: Uint8Array,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO provider (id, name, kind, set_default_at, payload_ciphertext, payload_iv, payload_tag, key_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name, kind, null, new Uint8Array([1]), iv, tag, 1, 1],
    );
  });
};

const insertProfile = (
  storage: SqliteStorage,
  id: string,
  repositoryId: string,
  contentBlob: string,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO profile (id, repository_id, content_blob, updated_at) VALUES (?, ?, ?, ?)",
      [id, repositoryId, contentBlob, 1],
    );
  });
};

const insertBinding = (
  storage: SqliteStorage,
  projectId: string,
  kind: string,
  targetId: string,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
      [projectId, kind, targetId, 1],
    );
  });
};

describe("src/services/storage/migration-0001-core-entities.test", () => {
  it("parity: the six statements reproduce the six proposal tables verbatim, in order", () => {
    const normalize = (sql: string): readonly string[] =>
      sql
        .split(";")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter((part) => part.length > 0);

    assert.deepEqual(
      coreEntities.statements.flatMap(normalize),
      [
        "blob",
        "provider",
        "project",
        "project_binding",
        "repository",
        "profile",
      ].flatMap(proposalStatements),
    );
  });

  it("coreEntities carries version 1 and the name migration.md declares", () => {
    assert.equal(coreEntities.version, 1);
    assert.equal(coreEntities.name, "0001-core-entities");

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const migrationDoc = fs.readFileSync(
      join(repositoryRoot, "docs", "proposal", "database", "migration.md"),
      "utf8",
    );
    assert.ok(migrationDoc.includes("0001-core-entities"));
  });

  it("migrations holds exactly coreEntities, graphAndPlan, executionAndJournal, migration0004EventIndexes, migration0005Actor, migration0006RevisionOrigin, migration0007ExternalExecution and migration0008GraphIndexes", () => {
    assert.deepEqual(migrations, [
      coreEntities,
      graphAndPlan,
      executionAndJournal,
      migration0004EventIndexes,
      migration0005Actor,
      migration0006RevisionOrigin,
      migration0007ExternalExecution,
      migration0008GraphIndexes,
    ]);
  });

  it("the table inventory is the six product tables plus migration", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(
      rows.map((row) => row.name),
      [
        "blob",
        "migration",
        "profile",
        "project",
        "project_binding",
        "provider",
        "repository",
      ],
    );
  });

  it("no index, trigger or view exists", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all(
        "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(rows, []);
  });

  it("every one of the six tables is STRICT", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    for (const table of [
      "blob",
      "provider",
      "project",
      "project_binding",
      "repository",
      "profile",
    ]) {
      const row = storage.transact((t) =>
        t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
      ) as { sql: string };
      assert.ok(String(row.sql).trimEnd().endsWith("STRICT"), table);
    }
  });

  it("PRAGMA table_info(profile) matches the relational contract", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all("PRAGMA table_info(profile)"),
    ) as readonly Record<string, unknown>[];
    const info = rows.map((row) => ({ ...row }));

    assert.deepEqual(
      info.map((row) => row.name),
      ["id", "repository_id", "content_blob", "updated_at"],
    );
    assert.deepEqual(
      info.map((row) => row.type),
      ["TEXT", "TEXT", "TEXT", "INTEGER"],
    );
    assert.deepEqual(
      info.map((row) => row.pk),
      [1, 0, 0, 0],
    );
    for (const row of info) {
      assert.equal(row.notnull, 1);
      assert.equal(row.dflt_value, null);
    }
  });

  it("profile accepts the seeded one-per-repository row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertProfile(
      storage,
      fixtureIds.profile,
      fixtureIds.repository,
      fixtureIds.profileBlob,
    );
    assert.equal(countRows(storage, "profile"), 1);
  });

  it("profile refuses a second row for the same repository_id", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertProfile(
      storage,
      fixtureIds.profile,
      fixtureIds.repository,
      fixtureIds.profileBlob,
    );
    assertRefused(
      storage,
      () =>
        insertProfile(
          storage,
          "profile_b",
          fixtureIds.repository,
          fixtureIds.profileBlob,
        ),
      "profile",
      { message: "UNIQUE constraint failed: profile.repository_id" },
    );
  });

  it("profile refuses a repository_id with no repository row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertProfile(
          storage,
          "profile_b",
          "repo_missing",
          fixtureIds.profileBlob,
        ),
      "profile",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("profile refuses a content_blob with no blob row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertRepository(storage, {
      id: "repo_b",
      name: "kanthord-verify-b",
      state: "ready",
      landing: null,
      upstream: null,
    });
    assertRefused(
      storage,
      () =>
        insertProfile(
          storage,
          "profile_b",
          "repo_b",
          `sha256:${"9".repeat(64)}`,
        ),
      "profile",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("provider refuses a payload_iv that is not 12 bytes and accepts 12", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertProvider(
          storage,
          "provider_iv11",
          "iv11",
          "llm",
          new Uint8Array(11),
          new Uint8Array(16),
        ),
      "provider",
    );
    assertRefused(
      storage,
      () =>
        insertProvider(
          storage,
          "provider_iv13",
          "iv13",
          "llm",
          new Uint8Array(13),
          new Uint8Array(16),
        ),
      "provider",
    );
    insertProvider(
      storage,
      "provider_iv12",
      "iv12",
      "llm",
      new Uint8Array(12),
      new Uint8Array(16),
    );
    assert.equal(countRows(storage, "provider"), 2);
  });

  it("provider refuses a payload_tag that is not 16 bytes and accepts 16", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertProvider(
          storage,
          "provider_tag15",
          "tag15",
          "llm",
          new Uint8Array(12),
          new Uint8Array(15),
        ),
      "provider",
    );
    assertRefused(
      storage,
      () =>
        insertProvider(
          storage,
          "provider_tag17",
          "tag17",
          "llm",
          new Uint8Array(12),
          new Uint8Array(17),
        ),
      "provider",
    );
    insertProvider(
      storage,
      "provider_tag16",
      "tag16",
      "llm",
      new Uint8Array(12),
      new Uint8Array(16),
    );
    assert.equal(countRows(storage, "provider"), 2);
  });

  it("provider accepts only the llm and git kinds", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertProvider(
          storage,
          "provider_slack",
          "slack",
          "slack",
          new Uint8Array(12),
          new Uint8Array(16),
        ),
      "provider",
    );
    insertProvider(
      storage,
      "provider_llm2",
      "llm2",
      "llm",
      new Uint8Array(12),
      new Uint8Array(16),
    );
    insertProvider(
      storage,
      "provider_git",
      "git1",
      "git",
      new Uint8Array(12),
      new Uint8Array(16),
    );
    assert.equal(countRows(storage, "provider"), 3);
  });

  it("provider refuses a duplicate name", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertProvider(
          storage,
          "provider_dup",
          "work-anthropic",
          "llm",
          new Uint8Array(12),
          new Uint8Array(16),
        ),
      "provider",
      { message: "UNIQUE constraint failed: provider.name" },
    );
  });

  it("repository accepts ready with both oids null and needs-reconcile with both set", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const before = countRows(storage, "repository");
    insertRepository(storage, {
      id: "repo_t1",
      name: "t1",
      state: "ready",
      landing: null,
      upstream: null,
    });
    insertRepository(storage, {
      id: "repo_t2",
      name: "t2",
      state: "needs-reconcile",
      landing: oid,
      upstream: oid,
    });
    assert.equal(countRows(storage, "repository"), before + 2);
  });

  it("repository refuses needs-reconcile with both oids null and ready with both set", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertRepository(storage, {
          id: "repo_t3",
          name: "t3",
          state: "needs-reconcile",
          landing: null,
          upstream: null,
        }),
      "repository",
    );
    assertRefused(
      storage,
      () =>
        insertRepository(storage, {
          id: "repo_t4",
          name: "t4",
          state: "ready",
          landing: oid,
          upstream: oid,
        }),
      "repository",
    );
  });

  it("repository refuses needs-reconcile with exactly one diverged oid set", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertRepository(storage, {
          id: "repo_t5",
          name: "t5",
          state: "needs-reconcile",
          landing: oid,
          upstream: null,
        }),
      "repository",
    );
    assertRefused(
      storage,
      () =>
        insertRepository(storage, {
          id: "repo_t6",
          name: "t6",
          state: "needs-reconcile",
          landing: null,
          upstream: oid,
        }),
      "repository",
    );
  });

  it("repository accepts ready with exactly one diverged oid set", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const before = countRows(storage, "repository");
    insertRepository(storage, {
      id: "repo_t7",
      name: "t7",
      state: "ready",
      landing: oid,
      upstream: null,
    });
    insertRepository(storage, {
      id: "repo_t8",
      name: "t8",
      state: "ready",
      landing: null,
      upstream: oid,
    });
    assert.equal(countRows(storage, "repository"), before + 2);
  });

  it("repository refuses an unknown state", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertRepository(storage, {
          id: "repo_t9",
          name: "t9",
          state: "broken",
          landing: null,
          upstream: null,
        }),
      "repository",
    );
  });

  it("repository refuses a credential_id with no provider row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertRepository(storage, {
          id: "repo_t10",
          name: "t10",
          state: "ready",
          landing: null,
          upstream: null,
          credentialId: "provider_missing",
        }),
      "repository",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("publish_on_approval defaults to 1 when the column is omitted", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    storage.transact((t) => {
      t.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "repo_d",
          "kanthord-verify-d",
          "https://example.invalid/t.git",
          fixtureIds.provider,
          "repos/t.git",
          "main",
          "main",
          "refs/heads/main",
          "ready",
          null,
          null,
          null,
          1,
        ],
      );
    });
    const row = storage.transact((t) =>
      t.get("SELECT publish_on_approval FROM repository WHERE id = ?", [
        "repo_d",
      ]),
    ) as { publish_on_approval: number };
    assert.equal(row.publish_on_approval, 1);
  });

  it("project_binding refuses a kind outside git and provider", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertBinding(storage, fixtureIds.project, "agent", "target_x"),
      "project_binding",
    );
  });

  it("project_binding refuses a duplicate triple", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertBinding(
          storage,
          fixtureIds.project,
          "git",
          fixtureIds.repository,
        ),
      "project_binding",
      { message: "UNIQUE constraint failed" },
    );
  });

  it("project_binding accepts a second target_id for the same project", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const before = countRows(storage, "project_binding");
    insertBinding(storage, fixtureIds.project, "git", "target_b");
    assert.equal(countRows(storage, "project_binding"), before + 1);
  });

  it("project_binding refuses a project_id with no project row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertBinding(storage, "project_missing", "git", "target_x"),
      "project_binding",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("blob reads back a content BLOB as a Uint8Array with its bytes", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const hash = `sha256:${"a".repeat(64)}`;
    storage.transact((t) => {
      t.run(
        "INSERT INTO blob (hash, size, content, created_at) VALUES (?, ?, ?, ?)",
        [hash, 3, new Uint8Array([1, 2, 3]), 1],
      );
    });
    const row = storage.transact((t) =>
      t.get("SELECT content FROM blob WHERE hash = ?", [hash]),
    ) as { content: Uint8Array };
    assert.equal(Object.getPrototypeOf(row.content), Uint8Array.prototype);
    assert.deepEqual([...row.content], [1, 2, 3]);
  });
});
