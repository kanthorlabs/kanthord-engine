import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
  seedSiblingTask,
  seedWaivedEdge,
} from "../../../../test/helpers/rows.ts";
import { showProjectGraphHandler } from "./show-project-graph.ts";
import { showProjectGraph } from "../../../queries/project/show-project-graph.ts";
import { projectGraphResponse } from "../../contract/graph.ts";
import type { Storage, Transaction } from "../../../services/storage/index.ts";
import type { PlanStore } from "../../../services/plan/index.ts";
import { createPlanStore } from "../../../../test/helpers/plan.ts";
import { createGraphService } from "../../../../test/helpers/graph.ts";
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

describe("src/http/server/project/show-project-graph.test", () => {
  async function buildHandlerApp(plan: PlanStore = createPlanStore()) {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const graph = createGraphService();
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSiblingTask(transaction);
      seedWaivedEdge(transaction, {
        id: "edge_a",
        fromNode: fixtureIds.task,
        toNode: "task_b",
        waivedAt: 1234567890,
      });
    });
    const app = await createTestApp({
      handlers: {
        "project.graph": showProjectGraphHandler({
          showProjectGraph: (input: Readonly<{ projectId: string }>) =>
            showProjectGraph({ storage, plan, graph }, input),
        }),
      },
    });
    return { temporary, app, storage };
  }

  it("GET /v1/project/:id/graph answers 200 with { attributes, options, nodes, edges } and projectGraphResponse parses the body", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/project/${fixtureIds.project}/graph`);

    assert.equal(response.status, 200);
    assert.equal(projectGraphResponse.safeParse(response.body).success, true);
    assert.deepEqual(Object.keys(response.body), [
      "attributes",
      "options",
      "nodes",
      "edges",
    ]);
    assert.deepEqual(response.body.options, {
      allowSelfLoops: false,
      multi: false,
      type: "directed",
    });
    assert.equal(response.body.attributes.projectId, fixtureIds.project);
    assert.equal(response.body.attributes.revision, fixtureIds.planRevision);
    assert.equal(response.body.nodes.length, 4);
    assert.equal(response.body.nodes[0].key, fixtureIds.initiative);
    assert.equal(response.body.nodes[1].key, fixtureIds.objective);
    assert.equal(response.body.nodes[2].key, fixtureIds.task);
    assert.equal(response.body.nodes[3].key, "task_b");
    const expectedBytewiseKeys = [
      "blockReason",
      "deliverable",
      "discardReason",
      "kind",
      "parentId",
      "repositoryId",
      "state",
      "title",
      "verify",
    ];
    for (const node of response.body.nodes) {
      assert.deepEqual(Object.keys(node.attributes), expectedBytewiseKeys);
    }
    assert.equal(response.body.edges.length, 1);
    assert.equal(response.body.edges[0].key, "edge_a");
    assert.equal(response.body.edges[0].source, fixtureIds.task);
    assert.equal(response.body.edges[0].target, "task_b");
    assert.deepEqual(response.body.edges[0].attributes, {
      relation: "depends-on",
      waivedAt: 1234567890,
    });
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("GET /v1/project/:id/graph on an unknown project answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get("/v1/project/project_nope/graph");

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("GET /v1/project/:id/graph with malformed verify JSON answers 500 naming the node id", async (t) => {
    const basePlan = createPlanStore();
    const invalidPlan = new Proxy(basePlan, {
      get(target, property) {
        if (property === "readGraph") {
          return (transaction: Transaction, projectId: string) => {
            const result = basePlan.readGraph(transaction, projectId);
            return {
              ...result,
              nodes: result.nodes.map((node) =>
                node.id === fixtureIds.task
                  ? { ...node, verifyJson: "{" }
                  : node,
              ),
            };
          };
        }
        return Reflect.get(target, property, target);
      },
    });
    const { temporary, app } = await buildHandlerApp(invalidPlan);
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/project/${fixtureIds.project}/graph`);

    assert.equal(response.status, 500);
    assert.deepEqual(response.body.error, {
      code: "internal-error",
      message: fixtureIds.task,
    });
  });

  it("GET /v1/project/:id/graph leaves every row count unchanged", async (t) => {
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

    const response = await app.get(`/v1/project/${fixtureIds.project}/graph`);

    assert.equal(response.status, 200);
    for (const table of tables) {
      assert.equal(
        count(table)(storage),
        before.get(table),
        `${table} changed`,
      );
    }
  });

  it("GET /v1/project/:id/graph writes nothing — full state of node, edge, plan_revision, event and PRAGMA data_version is byte-identical before and after", async (t) => {
    const { temporary, app, storage } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const before = snapshotRelevantTables(storage);

    const response = await app.get(`/v1/project/${fixtureIds.project}/graph`);

    assert.equal(response.status, 200);

    const after = snapshotRelevantTables(storage);
    assert.equal(
      Buffer.compare(before, after),
      0,
      "node, edge, plan_revision, event tables or data_version changed after project.graph call",
    );
  });

  it("project.graph objective node carries repositoryId, task node carries null repositoryId", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/project/${fixtureIds.project}/graph`);

    assert.equal(response.status, 200);
    const nodes = response.body.nodes;
    const initiativeNode = nodes.find(
      (n: { key: string }) => n.key === fixtureIds.initiative,
    );
    const objectiveNode = nodes.find(
      (n: { key: string }) => n.key === fixtureIds.objective,
    );
    const taskNode = nodes.find(
      (n: { key: string }) => n.key === fixtureIds.task,
    );

    assert.ok(initiativeNode, "initiative node present");
    assert.ok(objectiveNode, "objective node present");
    assert.ok(taskNode, "task node present");

    assert.equal(initiativeNode.attributes.repositoryId, null);
    assert.equal(objectiveNode.attributes.repositoryId, fixtureIds.repository);
    assert.equal(taskNode.attributes.repositoryId, null);

    const expectedBytewiseKeys = [
      "blockReason",
      "deliverable",
      "discardReason",
      "kind",
      "parentId",
      "repositoryId",
      "state",
      "title",
      "verify",
    ];
    for (const node of nodes) {
      assert.deepEqual(Object.keys(node.attributes), expectedBytewiseKeys);
    }
  });

  it("project.graph contains no parent containment edge", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app.get(`/v1/project/${fixtureIds.project}/graph`);

    assert.equal(response.status, 200);
    const nodes = response.body.nodes as readonly {
      key: string;
      attributes: { parentId: string | null };
    }[];
    const edges = response.body.edges as readonly {
      source: string;
      target: string;
      attributes: { relation: string };
    }[];

    assert.equal(edges.length, 1);
    assert.equal(edges[0]!.source, fixtureIds.task);
    assert.equal(edges[0]!.target, "task_b");
    assert.equal(edges[0]!.attributes.relation, "depends-on");

    const parentOf = new Map(
      nodes.map((node) => [node.key, node.attributes.parentId] as const),
    );
    assert.equal(parentOf.get(fixtureIds.task), fixtureIds.objective);
    assert.equal(parentOf.get("task_b"), fixtureIds.objective);

    for (const edge of edges) {
      assert.notEqual(
        parentOf.get(edge.source),
        edge.target,
        `edge ${edge.source} -> ${edge.target} joins a node to its parent`,
      );
      assert.notEqual(
        parentOf.get(edge.target),
        edge.source,
        `edge ${edge.source} -> ${edge.target} joins a parent to its child`,
      );
    }
  });
});
