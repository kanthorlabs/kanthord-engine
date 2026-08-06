import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../../test/helpers/rows.ts";
import { listEdgeHandler } from "./list-edge.ts";
import { listEdges } from "../../../queries/edge/list-edge.ts";
import { edgeListResponse } from "../../contract/graph.ts";
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

describe("src/http/server/edge/list-edge.test", () => {
  async function buildHandlerApp() {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      plan.insertEdge(transaction, {
        id: "edge_a",
        fromNode: fixtureIds.task,
        toNode: fixtureIds.objective,
      });
    });
    const app = await createTestApp({
      handlers: {
        "edge.list": listEdgeHandler({
          listEdges: (input) => listEdges({ storage, plan }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/project/:id/edge answers 200 with { edges } and edgeListResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/project/${fixtureIds.project}/edge`);

    assert.equal(response.status, 200);
    assert.equal(edgeListResponse.safeParse(response.body).success, true);
    assert.equal(response.body.edges.length, 1);
    assert.equal(response.body.edges[0].id, "edge_a");
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/project/:id/edge on an unknown project answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/project/project_nope/edge");

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("GET /v1/project/:id/edge leaves every row count unchanged", async (t) => {
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

    const response = await app.get(`/v1/project/${fixtureIds.project}/edge`);

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
