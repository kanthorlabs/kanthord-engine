import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../../test/helpers/rows.ts";
import { showNodeHandler } from "./show-node.ts";
import { showNode } from "../../../queries/node/show-node.ts";
import { nodeShowResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import {
  createBlobStore,
  createPlanStore,
} from "../../../../test/helpers/plan.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createBackedExecutionFake } from "../../../../test/helpers/execution.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";

const daemonHome = "/var/lib/kanthord";

function count(table: string): (storage: Storage) => number {
  return (storage: Storage): number =>
    (
      storage.transact((transaction) =>
        transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
      ) as { c: number }
    ).c;
}

describe("src/http/server/node/show-node.test", () => {
  async function buildHandlerApp() {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    const blobs = createBlobStore(
      storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    const execution = createBackedExecutionFake({
      ids: createMockIdGenerator({ ulids: [] }),
    }).execution;
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    const app = await createTestApp({
      handlers: {
        "node.show": showNodeHandler({
          showNode: (input) =>
            showNode({ storage, plan, blobs, execution }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/node/:id answers 200 for the seeded task and nodeShowResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/node/${fixtureIds.task}`);

    assert.equal(response.status, 200);
    assert.equal(nodeShowResponse.safeParse(response.body).success, true);
    assert.equal(response.body.id, fixtureIds.task);
    assert.equal(response.body.kind, "task");
    assert.equal(response.body.acceptanceBlob, fixtureIds.acceptanceBlob);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/node/:id with an unknown id answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/node/task_nope");

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("GET /v1/node/:id leaves every row count unchanged", async (t) => {
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

    const response = await app.get(`/v1/node/${fixtureIds.task}`);

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
