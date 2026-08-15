import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { fixtureIds } from "../../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanStore,
  createRevision,
  seedPlanFixture,
} from "../../../../test/helpers/plan.ts";
import { exportPlanHandler } from "./export-plan.ts";
import { exportPlan } from "../../../queries/plan/export-plan.ts";
import { planExportResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";

const daemonHome = "/var/lib/kanthord";

function count(table: string): (storage: Storage) => number {
  return (storage: Storage): number =>
    (
      storage.transact((transaction) =>
        transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
      ) as { c: number }
    ).c;
}

describe("src/http/server/plan/export-plan.test", () => {
  async function buildHandlerApp() {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    const blobs = createBlobStore(
      storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    seedPlanFixture(storage, plan, blobs);
    const revision = createRevision(blobs, plan);
    const app = await createTestApp({
      handlers: {
        "plan.export": exportPlanHandler({
          exportPlan: (input) => exportPlan({ storage, plan, revision }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/project/:id/plan/export answers 200 and planExportResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(
      `/v1/project/${fixtureIds.project}/plan/export`,
    );

    assert.equal(response.status, 200);
    assert.equal(planExportResponse.safeParse(response.body).success, true);
    assert.equal(response.body.revision, fixtureIds.planRevision);
    assert.equal(response.body.documents.length, 3);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/project/:id/plan/export on an unknown project answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/project/project_nope/plan/export");

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("GET /v1/project/:id/plan/export leaves every row count unchanged", async (t) => {
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
      `/v1/project/${fixtureIds.project}/plan/export`,
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
