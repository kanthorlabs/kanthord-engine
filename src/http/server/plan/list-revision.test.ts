import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../../test/helpers/rows.ts";
import { listRevisionHandler } from "./list-revision.ts";
import { listRevisions } from "../../../queries/plan/list-revision.ts";
import { planRevisionsResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import { createPlanStore } from "../../../../test/helpers/plan.ts";

const daemonHome = "/var/lib/kanthord";

function count(table: string): (storage: Storage) => number {
  return (storage: Storage): number =>
    (
      storage.transact((transaction) =>
        transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
      ) as { c: number }
    ).c;
}

describe("src/http/server/plan/list-revision.test", () => {
  async function buildHandlerApp() {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    const app = await createTestApp({
      handlers: {
        "plan.revisions": listRevisionHandler({
          listRevisions: (input) => listRevisions({ storage, plan }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/project/:id/plan/revision answers 200 and planRevisionsResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(
      `/v1/project/${fixtureIds.project}/plan/revision`,
    );

    assert.equal(response.status, 200);
    assert.equal(planRevisionsResponse.safeParse(response.body).success, true);
    assert.equal(response.body.revisions.length, 1);
    assert.equal(response.body.revisions[0].id, fixtureIds.planRevision);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/project/:id/plan/revision on an unknown project answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/project/project_nope/plan/revision");

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("GET /v1/project/:id/plan/revision leaves every row count unchanged", async (t) => {
    const { temporary, app, storage } = await buildHandlerApp();
    t.after(() => temporary.dispose());
    const tables = [
      "project",
      "node",
      "edge",
      "plan_revision",
      "blob",
      "event",
    ];
    const before = new Map(
      tables.map((table) => [table, count(table)(storage)]),
    );

    const response = await app.get(
      `/v1/project/${fixtureIds.project}/plan/revision`,
    );

    assert.equal(response.status, 200);
    for (const table of tables) {
      assert.equal(
        count(table)(storage),
        before.get(table),
        `${table} changed`,
      );
    }
  });
});
