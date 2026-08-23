import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test/helpers/database.ts";
import { proposalStatements } from "../../../test/helpers/proposal.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
  seedSecondRevisionWithTask,
} from "../../../test/helpers/rows.ts";
import { StorageError } from "./index.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migration0004EventIndexes } from "./migration-0004-event-indexes.ts";
import { migration0005Actor } from "./migration-0005-actor.ts";
import { migration0006RevisionOrigin } from "./migration-0006-revision-origin.ts";
import type { Migration } from "./migration.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const VERSION_FIVE: readonly Migration[] = [
  coreEntities,
  graphAndPlan,
  executionAndJournal,
  migration0004EventIndexes,
  migration0005Actor,
];

const ALTER_RENAME = "ALTER TABLE plan_revision RENAME TO plan_revision_old";

const CREATE_PLAN_REVISION = `CREATE TABLE plan_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id),
  parent_id TEXT REFERENCES plan_revision(id),
  origin TEXT NOT NULL CHECK (origin IN ('import', 'node-write')),
  import_id TEXT,
  submitted_blob TEXT REFERENCES blob(hash),
  choices_blob TEXT REFERENCES blob(hash),
  accepted_blob TEXT NOT NULL REFERENCES blob(hash),
  UNIQUE (project_id, import_id),
  CHECK ((origin = 'import') = (import_id IS NOT NULL)),
  CHECK ((origin = 'import') = (submitted_blob IS NOT NULL)),
  CHECK ((origin = 'import') = (choices_blob IS NOT NULL))
) STRICT`;

const COPY_ROWS =
  "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) SELECT id, project_id, parent_id, 'import', import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision_old";

const DROP_OLD = "DROP TABLE plan_revision_old";

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildVersionFive = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations: VERSION_FIVE,
  });
  storage.migrate();
  storage.transact((t) => {
    seedRegistry(t);
    seedGraph(t);
  });
  return { storage, temporary };
};

const countRows = (storage: SqliteStorage, table: string): number => {
  const row = storage.transact((t) =>
    t.get(`SELECT COUNT(*) AS c FROM ${table}`),
  ) as { c: number };
  return row.c;
};

const tableSql = (storage: SqliteStorage, table: string): string => {
  const row = storage.transact((t) =>
    t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
  ) as { sql: string } | undefined;
  return row === undefined ? "" : row.sql;
};

const insertRevision = (
  storage: SqliteStorage,
  values: Readonly<{
    id: string;
    origin: string;
    importId?: string | null;
    submittedBlob?: string | null;
    choicesBlob?: string | null;
    acceptedBlob?: string | null;
  }>,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO plan_revision (id, project_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        fixtureIds.project,
        values.origin,
        values.importId ?? null,
        values.submittedBlob ?? null,
        values.choicesBlob ?? null,
        values.acceptedBlob === undefined
          ? fixtureIds.instructionBlob
          : values.acceptedBlob,
      ],
    );
  });
};

const assertRefused = (
  storage: SqliteStorage,
  fn: () => void,
  table: string,
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
};

const readCopyColumns = (
  row: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> => ({
  id: row.id,
  project_id: row.project_id,
  parent_id: row.parent_id,
  import_id: row.import_id,
  submitted_blob: row.submitted_blob,
  choices_blob: row.choices_blob,
  accepted_blob: row.accepted_blob,
});

describe("src/services/storage/migration-0006-revision-origin.test", () => {
  it("migration0006RevisionOrigin carries version 6, its name and rebuild", () => {
    assert.equal(migration0006RevisionOrigin.version, 6);
    assert.equal(migration0006RevisionOrigin.name, "0006-revision-origin");
    assert.equal(migration0006RevisionOrigin.rebuild, true);
  });

  it("statements hold the rename, create, copy and drop in order, and no pragma", () => {
    const statements = migration0006RevisionOrigin.statements;
    assert.equal(statements.length, 4);
    assert.deepEqual(statements.flatMap(normalize), [
      ...normalize(ALTER_RENAME),
      ...normalize(CREATE_PLAN_REVISION),
      ...normalize(COPY_ROWS),
      ...normalize(DROP_OLD),
    ]);
    for (const statement of statements) {
      assert.ok(!statement.trimStart().startsWith("PRAGMA"), statement);
    }
  });

  it("migrations holds nine entries, versions 1 to 9 with the nine names in order", () => {
    assert.equal(migrations.length, 9);
    assert.deepEqual(
      migrations.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.deepEqual(
      migrations.map((migration) => migration.name),
      [
        "0001-core-entities",
        "0002-graph-and-plan",
        "0003-execution-and-journal",
        "0004-event-indexes",
        "0005-actor",
        "0006-revision-origin",
        "0007-external-execution",
        "0008-graph-indexes",
        "0009-one-branch",
      ],
    );
  });

  it("the rebuild applies on a version-5 database and copies every row", () => {
    const { storage, temporary } = buildVersionFive();
    after(() => storage.close());
    after(() => temporary.dispose());

    storage.transact((t) => {
      seedSecondRevisionWithTask(t);
    });

    const before = storage.transact((t) =>
      t.all(
        "SELECT id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision ORDER BY id",
      ),
    ) as readonly Readonly<Record<string, unknown>>[];
    const countBefore = countRows(storage, "plan_revision");
    const nodeSqlBefore = tableSql(storage, "node");

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations,
    });
    after(() => second.close());
    second.migrate();

    assert.equal(countRows(second, "plan_revision"), countBefore);
    const afterRows = second.transact((t) =>
      t.all(
        "SELECT id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision ORDER BY id",
      ),
    ) as readonly Readonly<Record<string, unknown>>[];
    assert.equal(afterRows.length, before.length);
    for (const row of afterRows) {
      assert.equal(row.origin, "import");
    }
    assert.deepEqual(
      afterRows.map(readCopyColumns),
      before.map(readCopyColumns),
    );

    const danglingNodes = second.transact((t) =>
      t.all(
        "SELECT n.id FROM node n LEFT JOIN plan_revision r ON r.id = n.revision WHERE r.id IS NULL",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(danglingNodes, []);

    const danglingParents = second.transact((t) =>
      t.all(
        "SELECT pr.id FROM plan_revision pr LEFT JOIN plan_revision p ON p.id = pr.parent_id WHERE pr.parent_id IS NOT NULL AND p.id IS NULL",
      ),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(danglingParents, []);

    const violations = second.transact((t) =>
      t.all("PRAGMA foreign_key_check"),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(violations, []);

    assert.equal(tableSql(second, "node"), nodeSqlBefore);

    const oldTable = second.transact((t) =>
      t.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_revision_old'",
      ),
    );
    assert.equal(oldTable, undefined);

    const legacy = second.transact((t) =>
      t.get("PRAGMA legacy_alter_table"),
    ) as { legacy_alter_table: number };
    assert.equal(legacy.legacy_alter_table, 0);
    const foreignKeys = second.transact((t) =>
      t.get("PRAGMA foreign_keys"),
    ) as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);
  });

  it("a failed rebuild leaves the database at version 5 with the original table and both pragmas restored", () => {
    const temporary = createTemporaryDatabase();
    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: VERSION_FIVE,
    });
    after(() => first.close());
    after(() => temporary.dispose());
    first.migrate();
    first.transact((t) => {
      seedRegistry(t);
      seedGraph(t);
    });

    const nodeCountBefore = countRows(first, "node");
    const revisionSqlBefore = tableSql(first, "plan_revision");

    const failing: Migration = {
      version: 6,
      name: "0006-revision-origin",
      rebuild: true,
      statements: [
        ALTER_RENAME,
        CREATE_PLAN_REVISION,
        COPY_ROWS,
        "INSERT INTO no_such_table VALUES (1)",
        DROP_OLD,
      ],
    };

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [...VERSION_FIVE, failing],
    });
    after(() => second.close());

    let thrown: unknown;
    try {
      second.migrate();
      assert.fail("expected the injected migration to fail");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof StorageError);
    assert.equal((thrown as StorageError).code, "storage-migration-failed");

    const status = second.status();
    assert.deepEqual(
      status.applied.map((migration) => migration.version),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      status.pending.map((migration) => migration.version),
      [6],
    );

    assert.equal(tableSql(second, "plan_revision"), revisionSqlBefore);
    assert.equal(countRows(second, "node"), nodeCountBefore);

    const oldTable = second.transact((t) =>
      t.get(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_revision_old'",
      ),
    );
    assert.equal(oldTable, undefined);

    const legacy = second.transact((t) =>
      t.get("PRAGMA legacy_alter_table"),
    ) as { legacy_alter_table: number };
    assert.equal(legacy.legacy_alter_table, 0);
    const foreignKeys = second.transact((t) =>
      t.get("PRAGMA foreign_keys"),
    ) as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);
  });

  it("a node-write row carrying any import-only column is refused", () => {
    const temporary = createTemporaryDatabase();
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations,
    });
    after(() => storage.close());
    after(() => temporary.dispose());
    storage.migrate();

    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_x1",
          origin: "node-write",
          importId: "imp_x",
        }),
      "plan_revision",
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_x2",
          origin: "node-write",
          submittedBlob: fixtureIds.instructionBlob,
        }),
      "plan_revision",
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_x3",
          origin: "node-write",
          choicesBlob: fixtureIds.instructionBlob,
        }),
      "plan_revision",
    );
  });

  it("an import row omitting any import-only column is refused", () => {
    const temporary = createTemporaryDatabase();
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations,
    });
    after(() => storage.close());
    after(() => temporary.dispose());
    storage.migrate();

    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_y1",
          origin: "import",
          importId: null,
        }),
      "plan_revision",
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_y2",
          origin: "import",
          importId: "imp_y",
          submittedBlob: null,
        }),
      "plan_revision",
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_y3",
          origin: "import",
          importId: "imp_y2",
          choicesBlob: null,
        }),
      "plan_revision",
    );
  });

  it("an origin outside the two values is refused", () => {
    const temporary = createTemporaryDatabase();
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations,
    });
    after(() => storage.close());
    after(() => temporary.dispose());
    storage.migrate();

    assertRefused(
      storage,
      () => insertRevision(storage, { id: "revision_z", origin: "imported" }),
      "plan_revision",
    );
  });

  it("an accepted_blob of NULL is refused under both origins", () => {
    const temporary = createTemporaryDatabase();
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations,
    });
    after(() => storage.close());
    after(() => temporary.dispose());
    storage.migrate();

    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_a1",
          origin: "import",
          importId: "imp_a1",
          acceptedBlob: null,
        }),
      "plan_revision",
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_a2",
          origin: "node-write",
          acceptedBlob: null,
        }),
      "plan_revision",
    );
  });

  it("two node-write rows under one project both insert", () => {
    const temporary = createTemporaryDatabase();
    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations,
    });
    after(() => storage.close());
    after(() => temporary.dispose());
    storage.migrate();
    storage.transact((t) => {
      seedRegistry(t);
    });

    const before = countRows(storage, "plan_revision");
    insertRevision(storage, { id: "revision_w1", origin: "node-write" });
    insertRevision(storage, { id: "revision_w2", origin: "node-write" });
    assert.equal(countRows(storage, "plan_revision"), before + 2);
  });

  it("the CREATE TABLE statement equals the plan_revision proposal fence", () => {
    const created = migration0006RevisionOrigin.statements.filter((statement) =>
      statement.trimStart().startsWith("CREATE TABLE"),
    );
    assert.equal(created.length, 1);
    assert.deepEqual(
      normalize(created[0]!),
      proposalStatements("plan_revision"),
    );
  });
});
