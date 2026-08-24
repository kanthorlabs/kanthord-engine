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
import type { NodeListFilter } from "../../../queries/node/list-node.ts";
import { nodeListResponse } from "../../contract/graph.ts";
import type { Storage, Transaction } from "../../../services/storage/index.ts";
import { createPlanStore } from "../../../../test/helpers/plan.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { seedListFilterFixture } from "../../../../test/helpers/rows.ts";

const daemonHome = "/var/lib/kanthord";

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

function boundListNodes(
  storage: Storage,
  plan: ReturnType<typeof createPlanStore>,
) {
  return (input: NodeListFilter) =>
    listNodes(
      {
        storage,
        plan,
        clock: createMockClock({ start: NOW }),
        instanceId: INSTANCE,
        sweepExpiredExternalLeases: (_transaction: Transaction) => {},
      },
      input,
    );
}

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
          listNodes: boundListNodes(storage, plan),
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

  async function buildFilterApp() {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    storage.transact((transaction) => seedListFilterFixture(transaction));
    const app = await createTestApp({
      handlers: {
        "node.list": listNodeHandler({
          listNodes: boundListNodes(storage, plan),
        }),
      },
    });
    return { temporary, app };
  }

  it("a repeated filter key is 400 invalid-request", async (t) => {
    const { temporary, app } = await buildFilterApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/node?state=ready&state=running");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("an unknown key is 400 invalid-request", async (t) => {
    const { temporary, app } = await buildFilterApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/node?owner=me");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a filter value outside its enum is 400 invalid-request", async (t) => {
    const { temporary, app } = await buildFilterApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/node?kind=epic");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("state=ready&kind=task returns only the ready tasks, ordered by identity", async (t) => {
    const { temporary, app } = await buildFilterApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/node?state=ready&kind=task");

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.nodes.map((node: { id: string }) => node.id),
      ["task_pb1", "task_pb2"],
    );
  });

  it("the handler passes the parsed filter to the query exactly once", async (t) => {
    let calls = 0;
    let received: unknown;
    const app = await createTestApp({
      handlers: {
        "node.list": listNodeHandler({
          listNodes: (input) => {
            calls += 1;
            received = input;
            return [];
          },
        }),
      },
    });

    const response = await app.get(
      "/v1/node?project=project_01JQ8Z7G3HZZZZZZZZZZZZZZZW&state=ready",
    );

    assert.equal(response.status, 200);
    assert.equal(calls, 1);
    assert.deepEqual(received, {
      project: "project_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
      state: "ready",
    });
  });
});
