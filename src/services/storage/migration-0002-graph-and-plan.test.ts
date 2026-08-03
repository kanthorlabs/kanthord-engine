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
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { coreEntities } from "./migration-0001-core-entities.ts";
import { graphAndPlan } from "./migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "./migration-0003-execution-and-journal.ts";
import { migrations } from "./migrations.ts";
import { SqliteStorage } from "./sqlite.ts";

const NODE_STATES = [
  "pending",
  "ready",
  "running",
  "blocked",
  "awaiting_approval",
  "done",
  "partial",
  "discarded",
] as const;

const BLOCK_REASONS = [
  "attempt-limit",
  "dependency-discarded",
  "stale-base",
  "dirty-recovery",
  "e2e-failed",
  "abandoned",
] as const;

type Context = Readonly<{
  storage: SqliteStorage;
  temporary: TemporaryDatabase;
}>;

const buildMigrated = (): Context => {
  const temporary = createTemporaryDatabase();
  const storage = new SqliteStorage({
    path: temporary.path,
    clock: createMockClock({ start: 1700000000000 }),
    migrations: [coreEntities, graphAndPlan],
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

type NodeValues = Readonly<{
  id: string;
  kind: string;
  parentId: string | null;
  state: string;
  blockReason: string | null;
  acceptanceBlob: string | null;
  repositoryId: string | null;
}>;

const insertNode = (storage: SqliteStorage, values: NodeValues): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        fixtureIds.project,
        values.kind,
        values.parentId,
        "Test node",
        fixtureIds.instructionBlob,
        values.acceptanceBlob,
        null,
        values.repositoryId,
        values.state,
        values.blockReason,
        null,
        fixtureIds.planRevision,
        1,
      ],
    );
  });
};

const taskShape = (
  id: string,
  state: string,
  blockReason: string | null = null,
): NodeValues => ({
  id,
  kind: "task",
  parentId: fixtureIds.objective,
  state,
  blockReason,
  acceptanceBlob: fixtureIds.acceptanceBlob,
  repositoryId: null,
});

const objectiveShape = (id: string, state: string): NodeValues => ({
  id,
  kind: "objective",
  parentId: fixtureIds.initiative,
  state,
  blockReason: null,
  acceptanceBlob: null,
  repositoryId: fixtureIds.repository,
});

const initiativeShape = (id: string, state: string): NodeValues => ({
  id,
  kind: "initiative",
  parentId: null,
  state,
  blockReason: null,
  acceptanceBlob: null,
  repositoryId: null,
});

const insertEdge = (
  storage: SqliteStorage,
  id: string,
  fromNode: string,
  toNode: string,
  waivedAt: number | null = null,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
      [id, fromNode, toNode, waivedAt],
    );
  });
};

const insertRevision = (
  storage: SqliteStorage,
  values: Readonly<{
    id: string;
    projectId?: string;
    parentId?: string | null;
    importId?: string;
    submittedBlob?: string;
    choicesBlob?: string;
    acceptedBlob?: string;
  }>,
): void => {
  storage.transact((t) => {
    t.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        values.id,
        values.projectId ?? fixtureIds.project,
        values.parentId ?? null,
        values.importId ?? "imp_b",
        values.submittedBlob ?? fixtureIds.instructionBlob,
        values.choicesBlob ?? fixtureIds.instructionBlob,
        values.acceptedBlob ?? fixtureIds.instructionBlob,
      ],
    );
  });
};

describe("src/services/storage/migration-0002-graph-and-plan.test", () => {
  it("parity: the three statements reproduce the three proposal tables verbatim, in order", () => {
    const normalize = (sql: string): readonly string[] =>
      sql
        .split(";")
        .map((part) => part.replace(/\s+/g, " ").trim())
        .filter((part) => part.length > 0);

    assert.deepEqual(
      graphAndPlan.statements.flatMap(normalize),
      ["plan_revision", "node", "edge"].flatMap(proposalStatements),
    );
  });

  it("graphAndPlan carries version 2 and the name migration.md declares", () => {
    assert.equal(graphAndPlan.version, 2);
    assert.equal(graphAndPlan.name, "0002-graph-and-plan");

    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const migrationDoc = fs.readFileSync(
      join(repositoryRoot, "docs", "proposal", "database", "migration.md"),
      "utf8",
    );
    assert.ok(migrationDoc.includes("0002-graph-and-plan"));
  });

  it("migrations holds exactly coreEntities, graphAndPlan and executionAndJournal", () => {
    assert.deepEqual(migrations, [
      coreEntities,
      graphAndPlan,
      executionAndJournal,
    ]);
  });

  it("the table inventory is the ten product tables plus migration", () => {
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
        "edge",
        "migration",
        "node",
        "plan_revision",
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

  it("all three new tables are STRICT", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    for (const table of ["plan_revision", "node", "edge"]) {
      const row = storage.transact((t) =>
        t.get("SELECT sql FROM sqlite_master WHERE name = ?", [table]),
      ) as { sql: string };
      assert.ok(String(row.sql).trimEnd().endsWith("STRICT"), table);
    }
  });

  it("every one of the frozen eight states is accepted on the kind the state machine allows", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const before = countRows(storage, "node");
    for (const state of NODE_STATES) {
      const values =
        state === "awaiting_approval" || state === "partial"
          ? objectiveShape(`node_state_${state}`, state)
          : state === "blocked"
            ? taskShape(`node_state_${state}`, state, "attempt-limit")
            : taskShape(`node_state_${state}`, state);
      insertNode(storage, values);
    }
    assert.equal(countRows(storage, "node"), before + NODE_STATES.length);
  });

  it("a node state outside the frozen eight is refused", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertNode(storage, taskShape("node_nonsense", "nonsense")),
      "node",
    );
  });

  it("a task refuses partial and awaiting_approval; an initiative accepts partial", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertNode(storage, taskShape("task_partial", "partial")),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, taskShape("task_awaiting", "awaiting_approval")),
      "node",
    );
    insertNode(storage, initiativeShape("initiative_partial", "partial"));
    assert.equal(countRows(storage, "node"), 4);
  });

  it("blocked requires a block_reason and a non-blocked row refuses one", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertNode(storage, taskShape("task_blocked_none", "blocked")),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(
          storage,
          taskShape("task_ready_reason", "ready", "attempt-limit"),
        ),
      "node",
    );
  });

  it("every one of the frozen six block reasons is accepted on a blocked row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const before = countRows(storage, "node");
    for (const reason of BLOCK_REASONS) {
      insertNode(
        storage,
        taskShape(`node_blocked_${reason}`, "blocked", reason),
      );
    }
    assert.equal(countRows(storage, "node"), before + BLOCK_REASONS.length);
  });

  it("a blocked row refuses a block_reason outside the six", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertNode(
          storage,
          taskShape("node_blocked_nonsense", "blocked", "nonsense"),
        ),
      "node",
    );
  });

  it("parent_id: only an initiative may be its own root", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...initiativeShape("init_parent", "pending"),
          parentId: fixtureIds.initiative,
        }),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...objectiveShape("objective_noparent", "pending"),
          parentId: null,
        }),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...taskShape("task_noparent", "pending"),
          parentId: null,
        }),
      "node",
    );
    const before = countRows(storage, "node");
    insertNode(storage, objectiveShape("objective_parent_ok", "pending"));
    insertNode(storage, taskShape("task_parent_ok", "pending"));
    assert.equal(countRows(storage, "node"), before + 2);
  });

  it("repository_id: only an objective carries one", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...objectiveShape("objective_norepo", "pending"),
          repositoryId: null,
        }),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...taskShape("task_repo", "pending"),
          repositoryId: fixtureIds.repository,
        }),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...initiativeShape("initiative_repo", "pending"),
          repositoryId: fixtureIds.repository,
        }),
      "node",
    );
    const before = countRows(storage, "node");
    insertNode(storage, initiativeShape("initiative_norepo_ok", "pending"));
    insertNode(storage, taskShape("task_norepo_ok", "pending"));
    assert.equal(countRows(storage, "node"), before + 2);
  });

  it("acceptance_blob: only a task carries one", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...taskShape("task_noaccept", "pending"),
          acceptanceBlob: null,
        }),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...objectiveShape("objective_accept", "pending"),
          acceptanceBlob: fixtureIds.acceptanceBlob,
        }),
      "node",
    );
    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...initiativeShape("initiative_accept", "pending"),
          acceptanceBlob: fixtureIds.acceptanceBlob,
        }),
      "node",
    );
    const before = countRows(storage, "node");
    insertNode(storage, initiativeShape("initiative_noaccept_ok", "pending"));
    insertNode(storage, objectiveShape("objective_noaccept_ok", "pending"));
    assert.equal(countRows(storage, "node"), before + 2);
  });

  it("a node kind outside initiative, objective and task is refused", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertNode(storage, {
          ...taskShape("node_epic", "pending"),
          kind: "epic",
        }),
      "node",
    );
  });

  it("edge refuses a row that depends on itself", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertEdge(storage, "edge_self", fixtureIds.task, fixtureIds.task),
      "edge",
    );
  });

  it("edge refuses a duplicate (from_node, to_node) pair", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertEdge(storage, "edge_ab", fixtureIds.task, fixtureIds.objective);
    assertRefused(
      storage,
      () =>
        insertEdge(storage, "edge_ab2", fixtureIds.task, fixtureIds.objective),
      "edge",
      { message: "UNIQUE constraint failed: edge.from_node, edge.to_node" },
    );
  });

  it("edge refuses a from_node with no node row", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertEdge(storage, "edge_missing", "task_missing", fixtureIds.task),
      "edge",
      { message: "FOREIGN KEY constraint failed" },
    );
  });

  it("edge waived_at accepts null and an integer", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    insertEdge(storage, "edge_w1", fixtureIds.task, fixtureIds.objective, null);
    insertEdge(storage, "edge_w2", fixtureIds.objective, fixtureIds.task, 1);
    assert.equal(countRows(storage, "edge"), 2);
  });

  it("plan_revision refuses a duplicate (project_id, import_id)", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () => insertRevision(storage, { id: "revision_b", importId: "imp_a" }),
      "plan_revision",
      {
        message:
          "UNIQUE constraint failed: plan_revision.project_id, plan_revision.import_id",
      },
    );
  });

  it("plan_revision accepts the same import_id under a second project", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    storage.transact((t) => {
      t.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "kanthord-verify-b", "general@1", null, 1],
      );
    });
    insertRevision(storage, {
      id: "revision_c",
      projectId: "project_b",
      importId: "imp_a",
    });
    assert.equal(countRows(storage, "plan_revision"), 2);
  });

  it("plan_revision parent_id must reference an existing revision", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    assertRefused(
      storage,
      () =>
        insertRevision(storage, {
          id: "revision_d",
          parentId: "revision_missing",
        }),
      "plan_revision",
      { message: "FOREIGN KEY constraint failed" },
    );
    insertRevision(storage, {
      id: "revision_e",
      parentId: fixtureIds.planRevision,
    });
    assert.equal(countRows(storage, "plan_revision"), 2);
  });

  it("plan_revision refuses a blob column pointing at an unstored hash", () => {
    const { storage, temporary } = buildMigrated();
    after(() => storage.close());
    after(() => temporary.dispose());

    const unstored = `sha256:${"f".repeat(64)}`;
    assertRefused(
      storage,
      () =>
        insertRevision(storage, { id: "revision_f", submittedBlob: unstored }),
      "plan_revision",
      { message: "FOREIGN KEY constraint failed" },
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, { id: "revision_g", choicesBlob: unstored }),
      "plan_revision",
      { message: "FOREIGN KEY constraint failed" },
    );
    assertRefused(
      storage,
      () =>
        insertRevision(storage, { id: "revision_h", acceptedBlob: unstored }),
      "plan_revision",
      { message: "FOREIGN KEY constraint failed" },
    );
  });
});
