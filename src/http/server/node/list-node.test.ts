import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../../test/helpers/rows.ts";
import { listNodeHandler } from "./list-node.ts";
import { listNodes } from "../../../queries/node/list-node.ts";
import { nodeListResponse } from "../../contract/graph.ts";
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

describe("src/http/server/node/list-node.test", () => {
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
        "node.list": listNodeHandler({
          listNodes: (input) => listNodes({ storage, plan }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/node answers 200 with { nodes } and nodeListResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/node");

    assert.equal(response.status, 200);
    assert.equal(nodeListResponse.safeParse(response.body).success, true);
    assert.equal(response.body.nodes.length, 3);
    assert.equal(response.body.nodes[0].id, fixtureIds.initiative);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/node leaves every row count unchanged", async (t) => {
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

    const response = await app.get("/v1/node");

    assert.equal(response.status, 200);
    for (const table of tables) {
      assert.equal(
        count(table)(storage),
        before.get(table),
        `${table} changed`,
      );
    }
  });

  describe("the stubbed outcome routes write nothing", () => {
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ["unblock", "ships in phase-2", "node.unblock"],
      ["abandon", "ships in phase-2", "node.abandon"],
      ["discard", "ships in phase-3", "node.discard"],
      ["waive", "ships in phase-3", "node.waive"],
    ];

    for (const [actionName, suffix, operationId] of cases) {
      it(`POST /v1/node/:id/${actionName} answers 501 ${suffix} and writes nothing`, async (t) => {
        const { temporary, app, storage } = await buildHandlerApp();
        t.after(() => temporary.dispose());
        const countNodes = count("node");
        const countEvents = count("event");
        const nodesBefore = countNodes(storage);
        const eventsBefore = countEvents(storage);

        const response = await app.post(
          `/v1/node/${fixtureIds.task}/${actionName}`,
        );

        assert.equal(response.status, 501, operationId);
        assert.ok(
          String(response.body.error.message).endsWith(suffix),
          String(response.body.error.message),
        );
        assert.equal(countNodes(storage), nodesBefore);
        assert.equal(countEvents(storage), eventsBefore);
      });
    }
  });
});
