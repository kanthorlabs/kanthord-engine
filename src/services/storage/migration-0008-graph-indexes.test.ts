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
  seedSecondProjectGraph,
  seedEdge,
} from "../../../test/helpers/rows.ts";
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
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const normalize = (sql: string): readonly string[] =>
  sql
    .split(";")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => part.length > 0);

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildMigratedThroughSeven = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations: [
      coreEntities,
      graphAndPlan,
      executionAndJournal,
      migration0004EventIndexes,
      migration0005Actor,
      migration0006RevisionOrigin,
      migration0007ExternalExecution,
    ],
  });
  storage.migrate();
  storage.transact((t) => {
    seedRegistry(t);
    seedGraph(t);
    seedSecondProjectGraph(t);
    seedEdge(t, {
      id: "edge_task_objective",
      fromNode: fixtureIds.task,
      toNode: fixtureIds.objective,
    });
    seedEdge(t, {
      id: "edge_objective_initiative",
      fromNode: fixtureIds.objective,
      toNode: fixtureIds.initiative,
    });
    seedEdge(t, {
      id: "edge_task_pb_objective_pb",
      fromNode: "task_pb",
      toNode: "objective_pb",
    });
    seedEdge(t, {
      id: "edge_objective_pb_initiative_pb",
      fromNode: "objective_pb",
      toNode: "initiative_pb",
    });
  });
  return { storage, temporary };
};

const buildMigratedThroughEight = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
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
    seedRegistry(t);
    seedGraph(t);
    seedEdge(t, {
      id: "edge_task_objective",
      fromNode: fixtureIds.task,
      toNode: fixtureIds.objective,
    });
    seedEdge(t, {
      id: "edge_objective_initiative",
      fromNode: fixtureIds.objective,
      toNode: fixtureIds.initiative,
    });
  });
  return { storage, temporary };
};

const countRows = (storage: SqliteStorage, table: string): number => {
  const row = storage.transact((t) =>
    t.get(`SELECT COUNT(*) AS c FROM ${table}`),
  ) as { c: number };
  return row.c;
};

describe("src/services/storage/migration-0008-graph-indexes.test", () => {
  it("migration0008GraphIndexes carries version 8, its name, no rebuild, and two statements", () => {
    assert.equal(migration0008GraphIndexes.version, 8);
    assert.equal(migration0008GraphIndexes.name, "0008-graph-indexes");
    assert.equal(migration0008GraphIndexes.rebuild, undefined);
    assert.equal(migration0008GraphIndexes.statements.length, 2);
  });

  it("the two statements are the declared index statements in order", () => {
    assert.equal(
      migration0008GraphIndexes.statements[0],
      "CREATE INDEX node_project ON node (project_id, id)",
    );
    assert.equal(
      migration0008GraphIndexes.statements[1],
      "CREATE INDEX edge_from_node ON edge (from_node, to_node)",
    );
  });

  it("parity: the two statements equal the index lines of the node and edge proposal fences", () => {
    const nodeProposal = proposalStatements("node");
    const edgeProposal = proposalStatements("edge");

    const nodeIndexLines = nodeProposal.filter((stmt) =>
      stmt.startsWith("CREATE INDEX"),
    );
    const edgeIndexLines = edgeProposal.filter((stmt) =>
      stmt.startsWith("CREATE INDEX"),
    );

    assert.ok(nodeIndexLines.length > 0, "node proposal missing CREATE INDEX");
    assert.ok(edgeIndexLines.length > 0, "edge proposal missing CREATE INDEX");

    const nodeIndexLine = nodeIndexLines[0] as string;
    const edgeIndexLine = edgeIndexLines[0] as string;
    const migrationNodeStatement = migration0008GraphIndexes
      .statements[0] as string;
    const migrationEdgeStatement = migration0008GraphIndexes
      .statements[1] as string;

    assert.deepEqual(
      normalize(migrationNodeStatement),
      normalize(nodeIndexLine),
    );
    assert.deepEqual(
      normalize(migrationEdgeStatement),
      normalize(edgeIndexLine),
    );
  });

  it("migrations holds the ten declared migrations in order", () => {
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
    ]);
  });

  it("migration 0008 applies on a database migrated to version 7 that holds nodes and edges in two projects", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
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
    after(() => second.close());

    second.migrate();

    const nodeRows = countRows(second, "node");
    const edgeRows = countRows(second, "edge");
    assert.ok(nodeRows > 0);
    assert.ok(edgeRows > 0);
  });

  it("every row survives migration 0008", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const nodeBefore = countRows(storage, "node");
    const edgeBefore = countRows(storage, "edge");

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
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
    after(() => second.close());

    second.migrate();

    assert.equal(countRows(second, "node"), nodeBefore);
    assert.equal(countRows(second, "edge"), edgeBefore);
  });

  it("PRAGMA foreign_key_check returns no row after migration 0008 commits", () => {
    const { storage, temporary } = buildMigratedThroughSeven();
    after(() => storage.close());
    after(() => temporary.dispose());

    const second = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
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
    after(() => second.close());

    second.migrate();

    const violations = second.transact((t) =>
      t.all("PRAGMA foreign_key_check"),
    ) as readonly Record<string, unknown>[];
    assert.deepEqual(violations, []);
  });

  it("PRAGMA index_list on node and edge names the new index once each", () => {
    const { storage, temporary } = buildMigratedThroughEight();
    after(() => storage.close());
    after(() => temporary.dispose());

    const nodeIndexes = storage.transact((t) =>
      t.all("PRAGMA index_list(node)"),
    ) as readonly Record<string, unknown>[];
    const edgeIndexes = storage.transact((t) =>
      t.all("PRAGMA index_list(edge)"),
    ) as readonly Record<string, unknown>[];

    const nodeIndexNames = nodeIndexes.map((row) => row.name);
    const edgeIndexNames = edgeIndexes.map((row) => row.name);

    assert.ok(
      nodeIndexNames.includes("node_project"),
      "node_project index missing on node",
    );
    assert.ok(
      edgeIndexNames.includes("edge_from_node"),
      "edge_from_node index missing on edge",
    );
    assert.equal(
      nodeIndexNames.filter((n) => n === "node_project").length,
      1,
      "node_project appears more than once",
    );
    assert.equal(
      edgeIndexNames.filter((n) => n === "edge_from_node").length,
      1,
      "edge_from_node appears more than once",
    );
  });

  it("migration 0008 is re-applied on an already-migrated database and the runner skips it", () => {
    const { storage, temporary } = buildMigratedThroughEight();
    after(() => storage.close());
    after(() => temporary.dispose());

    const third = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
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
    after(() => third.close());

    third.migrate();

    const status = third.status();
    const appliedVersions = status.applied.map((m) => m.version);
    assert.deepEqual(appliedVersions, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(
      status.pending.map((m) => m.version),
      [],
    );
  });
});
