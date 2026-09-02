import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { attemptRow } from "../../domain/attempt.ts";
import { leaseOwnerKinds, leaseRow } from "../../domain/lease.ts";
import { runDrivers, runRow } from "../../domain/run.ts";
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
} from "../../../test/helpers/rows.ts";
import { assertClauseAgrees, tableDdl } from "../../../test/helpers/schema.ts";
import { StorageError } from "./index.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migration0004EventIndexes } from "./migration-0004-event-indexes.ts";
import { migration0005Actor } from "./migration-0005-actor.ts";
import { migration0006RevisionOrigin } from "./migration-0006-revision-origin.ts";
import { migration0007ExternalExecution } from "./migration-0007-external-execution.ts";
import type { Migration } from "./migration.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const VERSION_SIX: readonly Migration[] = [
  coreEntities,
  graphAndPlan,
  executionAndJournal,
  migration0004EventIndexes,
  migration0005Actor,
  migration0006RevisionOrigin,
];

const VERSION_EIGHT: Migration = {
  version: 8,
  name: "0008-trivial-probe",
  statements: ["CREATE TABLE parity_probe (id TEXT PRIMARY KEY) STRICT"],
};

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildVersionSix = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations: VERSION_SIX,
  });
  storage.migrate();
  return { storage, temporary };
};

const seedFixture = (storage: SqliteStorage): void => {
  storage.transact((t) => {
    seedRegistry(t);
    seedGraph(t);
    t.run(
      "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        fixtureIds.workspace,
        fixtureIds.objective,
        fixtureIds.repository,
        "workspaces/objective_a",
        "a".repeat(40),
        "a".repeat(40),
        fixtureIds.profileBlob,
        "coding/v1",
        null,
        "ready",
        1,
      ],
    );
    t.run(
      "INSERT INTO run (id, kind, node_id, parent_run_id, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        fixtureIds.objectiveRun,
        "objective",
        fixtureIds.objective,
        null,
        fixtureIds.workspace,
        "general@1",
        1,
        3,
        "a".repeat(40),
        null,
        "active",
        null,
        null,
      ],
    );
    t.run(
      "INSERT INTO run (id, kind, node_id, parent_run_id, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        fixtureIds.taskRun,
        "task",
        fixtureIds.task,
        fixtureIds.objectiveRun,
        fixtureIds.workspace,
        "general@1",
        1,
        3,
        "a".repeat(40),
        null,
        "active",
        null,
        null,
      ],
    );
    t.run(
      "INSERT INTO attempt (id, run_id, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        fixtureIds.attempt,
        fixtureIds.taskRun,
        1,
        fixtureIds.provider,
        "claude-opus-5",
        60000,
        "a".repeat(40),
        null,
        null,
        null,
      ],
    );
    t.run(
      "INSERT INTO agent_invocation (id, attempt_id, agent, adapter_version, prompt_blob, sources_json, tool_definitions_blob, tool_trace_blob, diff_blob, verdict, reason_blob, usage_json, error_blob, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "invocation_a",
        fixtureIds.attempt,
        "general@1",
        "pi-coding-agent/1",
        fixtureIds.instructionBlob,
        "{}",
        fixtureIds.instructionBlob,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    );
    t.run(
      "INSERT INTO candidate (id, node_id, run_id, workspace_id, revision, candidate_oid, landing_base_oid, merge_oid, projected_outcome, evidence_blob, profile_blob, convention_version, state, acknowledged_partial, publish_requested, approved_actor, approved_at, invalidated_at, invalidated_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "candidate_a",
        fixtureIds.objective,
        fixtureIds.objectiveRun,
        fixtureIds.workspace,
        "cand-1",
        "c".repeat(40),
        "a".repeat(40),
        null,
        "done",
        fixtureIds.instructionBlob,
        fixtureIds.profileBlob,
        "coding/v1",
        "open",
        null,
        null,
        null,
        null,
        null,
        null,
        1,
      ],
    );
    t.run(
      "INSERT INTO check_result (id, subject_kind, subject_id, node_id, run_id, commit_oid, manifest_blob, check_name, command_json, cwd, env_identity, toolchain_version, timeout_ms, authoritative, result, exit_code, output_blob, profile_blob, convention_version, invalidated_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "check_a",
        "task-diagnostic",
        null,
        fixtureIds.task,
        fixtureIds.taskRun,
        "d".repeat(40),
        null,
        "unit",
        "[]",
        "/tmp",
        "env",
        "node/24",
        60000,
        1,
        "running",
        null,
        null,
        null,
        "coding/v1",
        null,
        null,
      ],
    );
    t.run(
      "INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "gitop_a",
        fixtureIds.repository,
        "merge",
        fixtureIds.task,
        fixtureIds.taskRun,
        null,
        1,
        "refs/heads/main",
        "a".repeat(40),
        "b".repeat(40),
        null,
        null,
        "open",
        null,
        null,
        null,
        null,
      ],
    );
    t.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, 1, 1, 1, 2)",
      [fixtureIds.task, "daemon_test"],
    );
    t.run(
      "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, NULL, 1, 1, 1, 2)",
      [fixtureIds.objective],
    );
  });
};

const buildMigratedThroughSeven = (): Context => {
  const { storage, temporary } = buildVersionSix();
  seedFixture(storage);
  const second = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations: migrations.slice(0, 7),
  });
  second.migrate();
  return { storage: second, temporary };
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

const endTaskRun = (storage: SqliteStorage): void => {
  storage.transact((t) => {
    t.run("UPDATE run SET state = 'ended' WHERE id = ?", [fixtureIds.taskRun]);
  });
};

type RunInsert = Readonly<{
  id: string;
  kind?: string;
  nodeId?: string;
  parentRunId?: string | null;
  driver: string;
  workspaceId?: string | null;
  worker?: string | null;
  baseOid?: string | null;
  state?: string;
}>;

const insertRunRow = (storage: SqliteStorage, values: RunInsert): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO run (id, kind, node_id, parent_run_id, driver, workspace_id, worker, lease_fence, attempt_limit, base_oid, head_oid, state, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.kind ?? "task",
        values.nodeId ?? fixtureIds.task,
        values.parentRunId === undefined
          ? fixtureIds.objectiveRun
          : values.parentRunId,
        values.driver,
        values.workspaceId === undefined ? null : values.workspaceId,
        values.worker === undefined ? null : values.worker,
        1,
        3,
        values.baseOid === undefined ? null : values.baseOid,
        null,
        values.state ?? "active",
        null,
        null,
      ],
    );
  });
};

type AttemptInsert = Readonly<{
  id: string;
  runId: string;
  driver: string;
  attemptNo?: number;
  providerId?: string | null;
  providerModel?: string | null;
  timeoutMs?: number | null;
  baseOid?: string | null;
}>;

const insertAttemptRow = (
  storage: SqliteStorage,
  values: AttemptInsert,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.runId,
        values.driver,
        values.attemptNo ?? 1,
        values.providerId === undefined ? null : values.providerId,
        values.providerModel === undefined ? null : values.providerModel,
        values.timeoutMs === undefined ? null : values.timeoutMs,
        values.baseOid === undefined ? null : values.baseOid,
        null,
        null,
        null,
      ],
    );
  });
};

const validRunRow = {
  id: "run_01HZY8QF3M4N5P6R7S8T9V0W30",
  kind: "task",
  driver: "internal",
  nodeId: "task_01HZY8QF3M4N5P6R7S8T9V0W30",
  parentRunId: "run_01HZY8QF3M4N5P6R7S8T9V0W30",
  workspaceId: "workspace_01HZY8QF3M4N5P6R7S8T9V0W30",
  worker: "general@1",
  leaseFence: 1,
  attemptLimit: 3,
  baseOid: "a".repeat(40),
  headOid: null,
  state: "active",
  outcome: null,
  endedAt: null,
};

const validAttemptRow = {
  id: "attempt_01HZY8QF3M4N5P6R7S8T9V0W30",
  runId: "run_01HZY8QF3M4N5P6R7S8T9V0W30",
  attemptNo: 1,
  driver: "internal",
  providerId: "provider_01HZY8QF3M4N5P6R7S8T9V0W30",
  providerModel: "claude-opus-5",
  timeoutMs: 60000,
  baseOid: "a".repeat(40),
  headOid: null,
  outcome: null,
  endedAt: null,
};

describe("src/services/storage/migration-0007-external-execution.test", () => {
  it("migration0007ExternalExecution carries version 7, its name and rebuild true", () => {
    assert.equal(migration0007ExternalExecution.version, 7);
    assert.equal(
      migration0007ExternalExecution.name,
      "0007-external-execution",
    );
    assert.equal(migration0007ExternalExecution.rebuild, true);
  });

  it("the statements hold no pragma at all", () => {
    for (const statement of migration0007ExternalExecution.statements) {
      assert.ok(!statement.includes("PRAGMA"), statement);
    }
  });

  it("the statements hold fourteen members in the declared order", () => {
    const statements = migration0007ExternalExecution.statements;
    assert.equal(statements.length, 14);
    const leading = statements.map((statement) => {
      const words = statement.trimStart().split(/\s+/);
      return words
        .slice(0, words[0] === "CREATE" && words[1] === "UNIQUE" ? 3 : 2)
        .join(" ");
    });
    assert.deepEqual(leading, [
      "ALTER TABLE",
      "ALTER TABLE",
      "ALTER TABLE",
      "DROP INDEX",
      "CREATE TABLE",
      "CREATE UNIQUE INDEX",
      "CREATE TABLE",
      "CREATE TABLE",
      "INSERT INTO",
      "INSERT INTO",
      "INSERT INTO",
      "DROP TABLE",
      "DROP TABLE",
      "DROP TABLE",
    ]);
  });

  it("the index name is freed before it is recreated", () => {
    const statements = migration0007ExternalExecution.statements;
    const dropIndex = statements.findIndex((statement) =>
      statement.trimStart().startsWith("DROP INDEX"),
    );
    const createIndex = statements.findIndex((statement) =>
      statement.trimStart().startsWith("CREATE UNIQUE INDEX"),
    );
    assert.ok(dropIndex !== -1);
    assert.ok(createIndex !== -1);
    assert.ok(dropIndex < createIndex);

    const withoutDrop = statements.filter(
      (statement) => !statement.trimStart().startsWith("DROP INDEX"),
    );
    const temporary = createTemporaryDatabase();
    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: VERSION_SIX,
    });
    after(() => first.close());
    after(() => temporary.dispose());
    first.migrate();

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [
        ...VERSION_SIX,
        {
          version: 7,
          name: "0007-external-execution",
          rebuild: true,
          statements: withoutDrop,
        },
      ],
    });
    after(() => second.close());
    let thrown: unknown;
    try {
      second.migrate();
      assert.fail("expected the index recreation to fail");
    } catch (error) {
      thrown = error;
    }
    assert.ok(
      String((thrown as Error).message).includes("already exists"),
      String((thrown as Error).message),
    );
  });

  it("a rebuild migration restores both pragmas on the success path", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const foreignKeys = storage.transact((t) =>
      t.get("PRAGMA foreign_keys"),
    ) as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);
    const legacy = storage.transact((t) =>
      t.get("PRAGMA legacy_alter_table"),
    ) as { legacy_alter_table: number };
    assert.equal(legacy.legacy_alter_table, 0);
  });

  it("every row of every referencing table survives the rebuild", () => {
    const { storage, temporary } = buildVersionSix();
    after(() => storage.close());
    after(() => temporary.dispose());
    seedFixture(storage);

    const tables = [
      "workspace",
      "run",
      "attempt",
      "agent_invocation",
      "candidate",
      "check_result",
      "git_operation",
      "lease",
    ];
    const before = new Map(
      tables.map((table) => [table, countRows(storage, table)]),
    );

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: migrations.slice(0, 7),
    });
    after(() => second.close());
    second.migrate();

    for (const table of tables) {
      assert.equal(countRows(second, table), before.get(table), table);
    }
  });

  it("every copied run and attempt row carries driver internal", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const runRows = storage.transact((t) =>
      t.all("SELECT driver FROM run"),
    ) as readonly Record<string, unknown>[];
    assert.ok(runRows.length > 0);
    for (const row of runRows) {
      assert.equal(row.driver, "internal");
    }
    const attemptRows = storage.transact((t) =>
      t.all("SELECT driver FROM attempt"),
    ) as readonly Record<string, unknown>[];
    assert.ok(attemptRows.length > 0);
    for (const row of attemptRows) {
      assert.equal(row.driver, "internal");
    }
  });

  it("every non-null-owner lease row carries owner_kind daemon", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const rows = storage.transact((t) =>
      t.all("SELECT owner, owner_kind FROM lease ORDER BY subject_id"),
    ) as readonly Record<string, unknown>[];
    const expected = [
      { owner: null, owner_kind: null },
      { owner: "daemon_test", owner_kind: "daemon" },
    ].map((row) => Object.assign(Object.create(null), row));
    assert.deepEqual(rows, expected);
  });

  it("PRAGMA foreign_key_check returns no row after the migration commits", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const violations = storage.transact((t) =>
      t.all("PRAGMA foreign_key_check"),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(violations, []);
  });

  it("no child table REFERENCES clause moved", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    for (const table of [
      "attempt",
      "agent_invocation",
      "candidate",
      "check_result",
      "git_operation",
    ]) {
      const ddl = tableSql(storage, table);
      assert.ok(!ddl.includes("_old"), table);
      assert.ok(
        ddl.includes("REFERENCES run(") || ddl.includes("REFERENCES attempt("),
        table,
      );
    }
  });

  it("an injected failure immediately after the copy leaves the database at version 6", () => {
    const statements = migration0007ExternalExecution.statements;
    const temporary = createTemporaryDatabase();
    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: VERSION_SIX,
    });
    after(() => first.close());
    after(() => temporary.dispose());
    first.migrate();
    seedFixture(first);

    const runSqlBefore = tableSql(first, "run");
    const attemptSqlBefore = tableSql(first, "attempt");
    const leaseSqlBefore = tableSql(first, "lease");
    const tables = [
      "workspace",
      "run",
      "attempt",
      "agent_invocation",
      "candidate",
      "check_result",
      "git_operation",
      "lease",
    ];
    const before = new Map(
      tables.map((table) => [table, countRows(first, table)]),
    );

    const failing: Migration = {
      version: 7,
      name: "0007-external-execution",
      rebuild: true,
      statements: [
        ...statements.slice(0, 11),
        "INSERT INTO no_such_table VALUES (1)",
        ...statements.slice(11),
      ],
    };
    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [...VERSION_SIX, failing],
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
      [1, 2, 3, 4, 5, 6],
    );
    assert.deepEqual(
      status.pending.map((migration) => migration.version),
      [7],
    );

    assert.equal(tableSql(second, "run"), runSqlBefore);
    assert.equal(tableSql(second, "attempt"), attemptSqlBefore);
    assert.equal(tableSql(second, "lease"), leaseSqlBefore);

    const oldNames = second.transact((t) =>
      t.all(
        "SELECT count(*) AS c FROM sqlite_master WHERE name LIKE '%\\_old' ESCAPE '\\'",
      ),
    ) as readonly Record<string, unknown>[];
    assert.equal((oldNames[0] as { c: number }).c, 0);

    const indexRow = second.transact((t) =>
      t.get(
        "SELECT name, tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'run_one_active'",
      ),
    ) as { name: string; tbl_name: string } | undefined;
    assert.ok(indexRow !== undefined);
    assert.equal(indexRow.tbl_name, "run");

    for (const table of tables) {
      assert.equal(countRows(second, table), before.get(table), table);
    }

    const foreignKeys = second.transact((t) =>
      t.get("PRAGMA foreign_keys"),
    ) as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);
    const legacy = second.transact((t) =>
      t.get("PRAGMA legacy_alter_table"),
    ) as { legacy_alter_table: number };
    assert.equal(legacy.legacy_alter_table, 0);
  });

  it("a failed rebuild leaves the next migration unaffected", () => {
    const statements = migration0007ExternalExecution.statements;
    const temporary = createTemporaryDatabase();
    const first = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: VERSION_SIX,
    });
    after(() => first.close());
    after(() => temporary.dispose());
    first.migrate();

    const failing: Migration = {
      version: 7,
      name: "0007-external-execution",
      rebuild: true,
      statements: [
        ...statements.slice(0, 11),
        "INSERT INTO no_such_table VALUES (1)",
        ...statements.slice(11),
      ],
    };
    const failed = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [...VERSION_SIX, failing],
    });
    after(() => failed.close());
    let thrown: unknown;
    try {
      failed.migrate();
      assert.fail("expected the injected migration to fail");
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof StorageError);

    const next = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [...VERSION_SIX, VERSION_EIGHT],
    });
    after(() => next.close());
    next.migrate();

    const status = next.status();
    assert.deepEqual(
      status.applied.map((migration) => migration.version),
      [1, 2, 3, 4, 5, 6, 8],
    );
    const created = next.transact((t) =>
      t.get(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'parity_probe'",
      ),
    ) as { sql: string };
    assert.deepEqual(
      normalize(created.sql),
      normalize(VERSION_EIGHT.statements[0] ?? ""),
    );
    const foreignKeys = next.transact((t) => t.get("PRAGMA foreign_keys")) as {
      foreign_keys: number;
    };
    assert.equal(foreignKeys.foreign_keys, 1);
    const legacy = next.transact((t) => t.get("PRAGMA legacy_alter_table")) as {
      legacy_alter_table: number;
    };
    assert.equal(legacy.legacy_alter_table, 0);
  });

  it("the rebuilt run refuses an external row that carries a workspace_id, a worker or a base_oid", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());
    endTaskRun(storage);

    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_ext_ws",
          driver: "external",
          workspaceId: fixtureIds.workspace,
        }),
      "run",
    );
    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_ext_worker",
          driver: "external",
          worker: "general@1",
        }),
      "run",
    );
    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_ext_base",
          driver: "external",
          baseOid: "a".repeat(40),
        }),
      "run",
    );
  });

  it("the rebuilt run refuses an internal row that omits a workspace_id, a worker or a base_oid", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());
    endTaskRun(storage);

    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_int_ws",
          driver: "internal",
          worker: "general@1",
          baseOid: "a".repeat(40),
        }),
      "run",
    );
    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_int_worker",
          driver: "internal",
          workspaceId: fixtureIds.workspace,
          baseOid: "a".repeat(40),
        }),
      "run",
    );
    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_int_base",
          driver: "internal",
          workspaceId: fixtureIds.workspace,
          worker: "general@1",
        }),
      "run",
    );
  });

  it("the rebuilt attempt refuses an external row that carries a provider_id, a provider_model, a timeout_ms or a base_oid", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());
    endTaskRun(storage);
    insertRunRow(storage, { id: "run_ext", driver: "external" });

    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_ext_provider",
          runId: "run_ext",
          driver: "external",
          providerId: fixtureIds.provider,
        }),
      "attempt",
    );
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_ext_model",
          runId: "run_ext",
          driver: "external",
          providerModel: "claude-opus-5",
        }),
      "attempt",
    );
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_ext_timeout",
          runId: "run_ext",
          driver: "external",
          timeoutMs: 60000,
        }),
      "attempt",
    );
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_ext_base",
          runId: "run_ext",
          driver: "external",
          baseOid: "a".repeat(40),
        }),
      "attempt",
    );
  });

  it("the rebuilt attempt refuses an internal row that omits a provider_id, a provider_model, a timeout_ms or a base_oid", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_int_provider",
          runId: fixtureIds.taskRun,
          driver: "internal",
          attemptNo: 2,
          providerModel: "claude-opus-5",
          timeoutMs: 60000,
          baseOid: "a".repeat(40),
        }),
      "attempt",
    );
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_int_model",
          runId: fixtureIds.taskRun,
          driver: "internal",
          attemptNo: 2,
          providerId: fixtureIds.provider,
          timeoutMs: 60000,
          baseOid: "a".repeat(40),
        }),
      "attempt",
    );
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_int_timeout",
          runId: fixtureIds.taskRun,
          driver: "internal",
          attemptNo: 2,
          providerId: fixtureIds.provider,
          providerModel: "claude-opus-5",
          baseOid: "a".repeat(40),
        }),
      "attempt",
    );
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_int_base",
          runId: fixtureIds.taskRun,
          driver: "internal",
          attemptNo: 2,
          providerId: fixtureIds.provider,
          providerModel: "claude-opus-5",
          timeoutMs: 60000,
        }),
      "attempt",
    );
  });

  it("an external attempt under an internal run is refused by the composite foreign key", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const foreignKeys = storage.transact((t) =>
      t.get("PRAGMA foreign_keys"),
    ) as { foreign_keys: number };
    assert.equal(foreignKeys.foreign_keys, 1);

    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_ext_under_int",
          runId: fixtureIds.taskRun,
          driver: "external",
          attemptNo: 2,
        }),
      "attempt",
    );

    endTaskRun(storage);
    insertRunRow(storage, { id: "run_ext", driver: "external" });
    assertRefused(
      storage,
      () =>
        insertAttemptRow(storage, {
          id: "attempt_int_under_ext",
          runId: "run_ext",
          driver: "internal",
          providerId: fixtureIds.provider,
          providerModel: "claude-opus-5",
          timeoutMs: 60000,
          baseOid: "a".repeat(40),
        }),
      "attempt",
    );
  });

  it("UNIQUE (id, driver) broke no single-column reference", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    storage.transact((t) => {
      t.run(
        "INSERT INTO candidate (id, node_id, run_id, workspace_id, revision, candidate_oid, landing_base_oid, merge_oid, projected_outcome, evidence_blob, profile_blob, convention_version, state, acknowledged_partial, publish_requested, approved_actor, approved_at, invalidated_at, invalidated_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "candidate_uniq",
          fixtureIds.objective,
          fixtureIds.taskRun,
          fixtureIds.workspace,
          "cand-uniq",
          "c".repeat(40),
          "a".repeat(40),
          null,
          "done",
          fixtureIds.instructionBlob,
          fixtureIds.profileBlob,
          "coding/v1",
          "open",
          null,
          null,
          null,
          null,
          null,
          null,
          1,
        ],
      );
    });
    assert.equal(countRows(storage, "candidate"), 2);

    const columns = storage.transact((t) =>
      t.all("PRAGMA table_info(run)"),
    ) as readonly Record<string, unknown>[];
    const primaryKeys = columns.filter((column) => column.pk === 1);
    assert.deepEqual(
      primaryKeys.map((column) => column.name),
      ["id"],
    );
  });

  it("the rebuilt lease refuses a broken owner pair", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const insertLease = (
      subjectId: string,
      owner: string | null,
      ownerKind: string | null,
    ): void => {
      storage.transact((t) => {
        t.run(
          "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, ?, ?, 1, 1, 1, 2)",
          [subjectId, owner, ownerKind],
        );
      });
    };

    const valid = {
      subjectKind: "node",
      subjectId: "task_01HZY8QF3M4N5P6R7S8T9V0W30",
      owner: "daemon_test",
      ownerKind: "daemon",
      fence: 1,
      acquiredAt: 1,
      renewedAt: 1,
      expiresAt: 2,
    };
    assert.throws(() => leaseRow.parse({ ...valid, ownerKind: null }));
    assert.throws(() => leaseRow.parse({ ...valid, owner: null }));

    assertRefused(
      storage,
      () => insertLease("lease_a", "daemon_a", null),
      "lease",
    );
    assertRefused(
      storage,
      () => insertLease("lease_b", null, "daemon"),
      "lease",
    );
    assertRefused(
      storage,
      () => insertLease("lease_c", "daemon_a", "actor"),
      "lease",
    );
    insertLease("lease_d", "actor_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E", "actor");
    assert.equal(countRows(storage, "lease"), 3);
  });

  it("run_one_active exists after the rebuild and still refuses a second active run", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const indexRow = storage.transact((t) =>
      t.get(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'run_one_active'",
      ),
    ) as { sql: string };
    const declared = migration0007ExternalExecution.statements.find(
      (statement) => statement.trimStart().startsWith("CREATE UNIQUE INDEX"),
    );
    assert.ok(declared !== undefined);
    assert.deepEqual(normalize(indexRow.sql), normalize(declared));

    assertRefused(
      storage,
      () =>
        insertRunRow(storage, {
          id: "run_dup_active",
          driver: "internal",
          workspaceId: fixtureIds.workspace,
          worker: "general@1",
          baseOid: "a".repeat(40),
        }),
      "run",
    );
  });

  it("the rebuilt tables equal the three proposal fences", () => {
    const statements = migration0007ExternalExecution.statements;
    const runTable = statements.filter((statement) =>
      statement.trimStart().startsWith("CREATE TABLE run ("),
    );
    const index = statements.filter((statement) =>
      statement.trimStart().startsWith("CREATE UNIQUE INDEX run_one_active"),
    );
    const attemptTable = statements.filter((statement) =>
      statement.trimStart().startsWith("CREATE TABLE attempt ("),
    );
    const leaseTable = statements.filter((statement) =>
      statement.trimStart().startsWith("CREATE TABLE lease ("),
    );
    assert.equal(runTable.length, 1);
    assert.equal(index.length, 1);
    assert.equal(attemptTable.length, 1);
    assert.equal(leaseTable.length, 1);

    assert.deepEqual(
      [...normalize(runTable[0] ?? ""), ...normalize(index[0] ?? "")],
      proposalStatements("run"),
    );
    assert.deepEqual(
      normalize(attemptTable[0] ?? ""),
      proposalStatements("attempt"),
    );
    assert.deepEqual(
      normalize(leaseTable[0] ?? ""),
      proposalStatements("lease"),
    );
  });

  it("run.driver CHECK agrees with the domain runDrivers", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "run", "driver", runDrivers);
  });

  it("attempt.driver CHECK agrees with the domain runDrivers", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "attempt", "driver", runDrivers);
  });

  it("lease.owner_kind CHECK agrees with the domain leaseOwnerKinds", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertClauseAgrees(storage, "lease", "owner_kind", leaseOwnerKinds);
  });

  it("each driver-conditional column carries its SQL CHECK", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const runDdl = normalize(tableDdl(storage, "run"))[0] ?? "";
    for (const clause of [
      "(driver = 'internal') = (workspace_id IS NOT NULL)",
      "(driver = 'internal') = (worker IS NOT NULL)",
      "(driver = 'internal') = (base_oid IS NOT NULL)",
    ]) {
      assert.ok(runDdl.includes(clause), clause);
    }
    assert.ok(
      !runDdl.includes("(driver = 'internal') = (head_oid IS NOT NULL)"),
    );

    const attemptDdl = normalize(tableDdl(storage, "attempt"))[0] ?? "";
    for (const clause of [
      "(driver = 'internal') = (provider_id IS NOT NULL)",
      "(driver = 'internal') = (provider_model IS NOT NULL)",
      "(driver = 'internal') = (timeout_ms IS NOT NULL)",
      "(driver = 'internal') = (base_oid IS NOT NULL)",
    ]) {
      assert.ok(attemptDdl.includes(clause), clause);
    }
  });

  it("the domain refinement and the SQL CHECK refuse the same run row", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());
    endTaskRun(storage);

    for (const column of ["workspaceId", "worker", "baseOid"] as const) {
      assert.throws(() => runRow.parse({ ...validRunRow, [column]: null }));
      assertRefused(
        storage,
        () =>
          insertRunRow(storage, {
            id: `run_refused_${column}`,
            driver: "internal",
            workspaceId: column === "workspaceId" ? null : fixtureIds.workspace,
            worker: column === "worker" ? null : "general@1",
            baseOid: column === "baseOid" ? null : "a".repeat(40),
          }),
        "run",
      );
    }
  });

  it("the domain refinement and the SQL CHECK refuse the same attempt row", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    for (const column of [
      "providerId",
      "providerModel",
      "timeoutMs",
      "baseOid",
    ] as const) {
      assert.throws(() =>
        attemptRow.parse({ ...validAttemptRow, [column]: null }),
      );
      assertRefused(
        storage,
        () =>
          insertAttemptRow(storage, {
            id: `attempt_refused_${column}`,
            runId: fixtureIds.taskRun,
            driver: "internal",
            attemptNo: 2,
            providerId: column === "providerId" ? null : fixtureIds.provider,
            providerModel: column === "providerModel" ? null : "claude-opus-5",
            timeoutMs: column === "timeoutMs" ? null : 60000,
            baseOid: column === "baseOid" ? null : "a".repeat(40),
          }),
        "attempt",
      );
    }
  });
});
