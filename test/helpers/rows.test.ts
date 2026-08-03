import { describe, it, after } from "node:test";
import assert from "node:assert/strict";

import { coreEntities } from "../../src/services/storage/migration-0001-core-entities.ts";
import { graphAndPlan } from "../../src/services/storage/migration-0002-graph-and-plan.ts";
import { executionAndJournal } from "../../src/services/storage/migration-0003-execution-and-journal.ts";
import { SqliteStorage } from "../../src/services/storage/sqlite.ts";
import { createMockClock } from "./clock.ts";
import { createTemporaryDatabase } from "./database.ts";
import { fixtureIds, seedExecution, seedGraph, seedRegistry } from "./rows.ts";

describe("test/helpers/rows.test", () => {
  it("fixtureIds spread into a plain object deep-equals the fifteen literal values", () => {
    assert.deepEqual(
      { ...fixtureIds },
      {
        provider: "provider_a",
        repository: "repo_a",
        project: "project_a",
        profile: "profile_a",
        instructionBlob: `sha256:${"0".repeat(64)}`,
        acceptanceBlob: `sha256:${"1".repeat(64)}`,
        profileBlob: `sha256:${"2".repeat(64)}`,
        planRevision: "revision_a",
        initiative: "initiative_a",
        objective: "objective_a",
        task: "task_a",
        workspace: "workspace_a",
        objectiveRun: "run_a",
        taskRun: "run_b",
        attempt: "attempt_a",
      },
    );
  });

  it("seedRegistry inserts the five registry tables with their expected counts", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [coreEntities],
    });
    after(() => storage.close());
    storage.migrate();
    storage.transact((t) => seedRegistry(t));

    const count = (sql: string): number =>
      (storage.transact((t) => t.get(sql)) as { c: number }).c;
    assert.equal(count("SELECT COUNT(*) AS c FROM blob"), 3);
    assert.equal(count("SELECT COUNT(*) AS c FROM provider"), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM project"), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM repository"), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM project_binding"), 1);
  });

  it("seedRegistry twice throws and changes no row count", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [coreEntities],
    });
    after(() => storage.close());
    storage.migrate();
    storage.transact((t) => seedRegistry(t));

    let thrown: unknown;
    try {
      storage.transact((t) => seedRegistry(t));
      assert.fail("expected a throw");
    } catch (error) {
      thrown = error;
    }
    assert.equal((thrown as { errcode: number }).errcode & 0xff, 19);

    const count = (sql: string): number =>
      (storage.transact((t) => t.get(sql)) as { c: number }).c;
    assert.equal(count("SELECT COUNT(*) AS c FROM blob"), 3);
  });

  it("seedGraph after seedRegistry inserts one plan_revision and three nodes", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [coreEntities, graphAndPlan],
    });
    after(() => storage.close());
    storage.migrate();
    storage.transact((t) => {
      seedRegistry(t);
      seedGraph(t);
    });

    const count = (sql: string): number =>
      (storage.transact((t) => t.get(sql)) as { c: number }).c;
    assert.equal(count("SELECT COUNT(*) AS c FROM node"), 3);
    assert.equal(count("SELECT COUNT(*) AS c FROM plan_revision"), 1);
  });

  it("seedExecution after seedRegistry and seedGraph inserts one workspace, two runs and one attempt", () => {
    const temporary = createTemporaryDatabase();
    after(() => temporary.dispose());

    const storage = new SqliteStorage({
      path: temporary.path,
      clock: createMockClock({ start: 1700000000000 }),
      migrations: [coreEntities, graphAndPlan, executionAndJournal],
    });
    after(() => storage.close());
    storage.migrate();
    storage.transact((t) => {
      seedRegistry(t);
      seedGraph(t);
      seedExecution(t);
    });

    const count = (sql: string): number =>
      (storage.transact((t) => t.get(sql)) as { c: number }).c;
    assert.equal(count("SELECT COUNT(*) AS c FROM workspace"), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM run"), 2);
    assert.equal(count("SELECT COUNT(*) AS c FROM attempt"), 1);
  });
});
