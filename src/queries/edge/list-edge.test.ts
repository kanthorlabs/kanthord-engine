import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listEdges } from "./list-edge.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { edgeView } from "../../http/contract/graph.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import { createPlanStore } from "../../../test/helpers/plan.ts";

describe("src/queries/edge/list-edge.test", () => {
  function build(): { storage: Storage; plan: PlanStore; dispose(): void } {
    const temporary = createMigratedStorage();
    return {
      storage: temporary.storage,
      plan: createPlanStore(),
      dispose: temporary.dispose,
    };
  }

  it("returns two edges ascending by (from_node, to_node) with the insertion order reversed", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      plan.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [
          {
            id: "edge_b",
            fromNode: fixtureIds.task,
            toNode: fixtureIds.initiative,
          },
          {
            id: "edge_a",
            fromNode: fixtureIds.objective,
            toNode: fixtureIds.initiative,
          },
        ],
        deleteEdgeIds: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const edges = listEdges(
      { storage, plan },
      { projectId: fixtureIds.project },
    );

    assert.deepEqual(edges, [
      {
        id: "edge_a",
        fromNode: fixtureIds.objective,
        toNode: fixtureIds.initiative,
        waivedAt: null,
      },
      {
        id: "edge_b",
        fromNode: fixtureIds.task,
        toNode: fixtureIds.initiative,
        waivedAt: null,
      },
    ]);
  });

  it("a waived edge returns its waivedAt integer", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      plan.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [
          {
            id: "edge_w",
            fromNode: fixtureIds.task,
            toNode: fixtureIds.objective,
          },
        ],
        deleteEdgeIds: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
      transaction.run("UPDATE edge SET waived_at = ? WHERE id = ?", [
        1700000000000,
        "edge_w",
      ]);
    });

    const edges = listEdges(
      { storage, plan },
      { projectId: fixtureIds.project },
    );
    const waived = edges.find((edge) => edge.id === "edge_w");

    assert.equal(waived?.waivedAt, 1700000000000);
  });

  it("an edge of another project is not returned", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "second-project", "general@1", null, 1],
      );
      plan.mutateGraph(transaction, {
        projectId: "project_b",
        nodes: [
          {
            id: "b_node_init",
            projectId: "project_b",
            kind: "initiative",
            parentId: null,
            title: "Second project",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: null,
            worker: null,
            repositoryId: null,
            revision: fixtureIds.planRevision,
            updatedAt: 1,
          },
        ],
        insertEdges: [
          {
            id: "edge_x",
            fromNode: "b_node_init",
            toNode: fixtureIds.task,
          },
        ],
        deleteEdgeIds: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const edges = listEdges(
      { storage, plan },
      { projectId: fixtureIds.project },
    );

    assert.equal(
      edges.some((edge) => edge.id === "edge_x"),
      false,
    );
  });

  it("a project with no edge returns []", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "second-project", "general@1", null, 1],
      );
    });

    assert.deepEqual(
      listEdges({ storage, plan }, { projectId: "project_b" }),
      [],
    );
  });

  it("an unknown project throws project-not-found", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedRegistry);

    assert.throws(
      () => listEdges({ storage, plan }, { projectId: "project_nope" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { refusal?: string }).refusal === "project-not-found",
    );
  });

  it("every view passes edgeView.safeParse", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      plan.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [
          {
            id: "edge_a",
            fromNode: fixtureIds.task,
            toNode: fixtureIds.objective,
          },
        ],
        deleteEdgeIds: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    for (const edge of listEdges(
      { storage, plan },
      { projectId: fixtureIds.project },
    )) {
      assert.equal(edgeView.safeParse(edge).success, true);
    }
  });
});
