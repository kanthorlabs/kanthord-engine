import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../../test/helpers/rows.ts";
import { listProjectNodeHandler } from "./list-project-node.ts";
import { listProjectNodes } from "../../../queries/node/list-project-node.ts";
import { nodeListResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import { createPlanStore } from "../../../../test/helpers/plan.ts";
import { tableRows, dataVersion } from "../../../../test/helpers/database.ts";

const daemonHome = "/var/lib/kanthord";

function count(table: string): (storage: Storage) => number {
  return (storage: Storage): number =>
    (
      storage.transact((transaction) =>
        transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
      ) as { c: number }
    ).c;
}

function snapshotRelevantTables(storage: Storage): Buffer {
  const tables = ["node", "edge", "plan_revision", "event"] as const;
  const parts: Buffer[] = [];
  for (const table of tables) {
    const rows_ = tableRows(storage, table);
    parts.push(
      Buffer.from(
        JSON.stringify(rows_, (key, value) =>
          value instanceof Uint8Array
            ? { bytes: Buffer.from(value).toString("base64") }
            : value,
        ),
        "utf8",
      ),
    );
  }
  const dv = dataVersion(storage);
  parts.push(Buffer.from(String(dv), "utf8"));
  return Buffer.concat(parts);
}

describe("src/http/server/node/list-project-node.test", () => {
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
        "project.nodes": listProjectNodeHandler({
          listProjectNodes: (input: Readonly<{ projectId: string }>) =>
            listProjectNodes({ storage, plan }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/project/:id/node answers 200 with { nodes } and nodeListResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/project/${fixtureIds.project}/node`);

    assert.equal(response.status, 200);
    assert.equal(nodeListResponse.safeParse(response.body).success, true);
    assert.equal(response.body.nodes.length, 3);
    assert.equal(response.body.nodes[0].id, fixtureIds.initiative);
    assert.equal(response.body.nodes[1].id, fixtureIds.objective);
    assert.equal(response.body.nodes[2].id, fixtureIds.task);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/project/:id/node on an unknown project answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/project/project_nope/node");

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("GET /v1/project/:id/node leaves every row count unchanged", async (t) => {
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

    const response = await app.get(`/v1/project/${fixtureIds.project}/node`);

    assert.equal(response.status, 200);
    for (const table of tables) {
      assert.equal(
        count(table)(storage),
        before.get(table),
        `${table} changed`,
      );
    }
  });

  it("GET /v1/project/:id/node writes nothing — full state of node, edge, plan_revision, event and PRAGMA data_version is byte-identical before and after", async (t) => {
    const { temporary, app, storage } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const before = snapshotRelevantTables(storage);

    const response = await app.get(`/v1/project/${fixtureIds.project}/node`);

    assert.equal(response.status, 200);

    const after = snapshotRelevantTables(storage);
    assert.equal(
      Buffer.compare(before, after),
      0,
      "node, edge, plan_revision, event tables or data_version changed after project.nodes call",
    );
  });
});
