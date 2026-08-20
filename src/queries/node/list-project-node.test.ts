import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listProjectNodes } from "./list-project-node.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { nodeListItem } from "../../http/contract/graph.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import { createPlanStore } from "../../../test/helpers/plan.ts";

const memberNames = [
  "blockReason",
  "dependencies",
  "discardReason",
  "id",
  "kind",
  "parentId",
  "projectId",
  "state",
  "title",
];

describe("src/queries/node/list-project-node.test", () => {
  function build(): { storage: Storage; plan: PlanStore; dispose(): void } {
    const temporary = createMigratedStorage();
    return {
      storage: temporary.storage,
      plan: createPlanStore(),
      dispose: temporary.dispose,
    };
  }

  it("returns the seeded graph nodes for one project ascending by id with every member asserted field by field", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const items = listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    );

    assert.deepEqual(items, [
      {
        id: fixtureIds.initiative,
        projectId: fixtureIds.project,
        kind: "initiative",
        title: "Harden the verify CLI",
        state: "pending",
        blockReason: null,
        discardReason: null,
        parentId: null,
        dependencies: [],
      },
      {
        id: fixtureIds.objective,
        projectId: fixtureIds.project,
        kind: "objective",
        title: "Harden the verify CLI",
        state: "pending",
        blockReason: null,
        discardReason: null,
        parentId: fixtureIds.initiative,
        dependencies: [],
      },
      {
        id: fixtureIds.task,
        projectId: fixtureIds.project,
        kind: "task",
        title: "Harden the verify CLI",
        state: "pending",
        blockReason: null,
        discardReason: null,
        parentId: fixtureIds.objective,
        dependencies: [],
      },
    ]);
  });

  it("every item carries exactly the nine member names in bytewise order", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const items = listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    );
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.deepEqual([...Object.keys(item)].sort(), memberNames);
    }
  });

  it("carries no body prose", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const items = listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    );
    const json = JSON.stringify(items);
    assert.equal(json.includes("instruction"), false);
    assert.equal(json.includes("acceptance"), false);
    for (const item of items) {
      assert.equal(Object.hasOwn(item, "instructionBlob"), false);
    }
  });

  it("returns only the nodes of the requested project, not other projects", (t) => {
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
          {
            id: "j_node_obj",
            projectId: "project_b",
            kind: "objective",
            parentId: "b_node_init",
            title: "Second project objective",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: null,
            worker: null,
            repositoryId: fixtureIds.repository,
            revision: fixtureIds.planRevision,
            updatedAt: 1,
          },
          {
            id: "u_node_task",
            projectId: "project_b",
            kind: "task",
            parentId: "j_node_obj",
            title: "Second project task",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: fixtureIds.acceptanceBlob,
            worker: null,
            repositoryId: null,
            revision: fixtureIds.planRevision,
            updatedAt: 1,
          },
        ],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const items = listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    );

    assert.deepEqual(
      items.map((item) => [item.id, item.projectId]),
      [
        [fixtureIds.initiative, fixtureIds.project],
        [fixtureIds.objective, fixtureIds.project],
        [fixtureIds.task, fixtureIds.project],
      ],
    );
  });

  it("fills dependencies from edge bytewise ascending", (t) => {
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
            toNode: fixtureIds.objective,
          },
          {
            id: "edge_a",
            fromNode: fixtureIds.task,
            toNode: fixtureIds.initiative,
          },
        ],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const items = listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    );
    const task = items.find((item) => item.id === fixtureIds.task);

    assert.deepEqual(task?.dependencies, [
      fixtureIds.initiative,
      fixtureIds.objective,
    ]);
    assert.deepEqual(
      items.find((item) => item.id === fixtureIds.objective)?.dependencies,
      [],
    );
  });

  it("a blocked node reports its blockReason, a discarded node its discardReason, and a pending node both null", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'stale-base' WHERE id = ?",
        [fixtureIds.objective],
      );
      transaction.run(
        "UPDATE node SET state = 'discarded', discard_reason = 'wontfix' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    const items = listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    );
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(byId.get(fixtureIds.objective)?.state, "blocked");
    assert.equal(byId.get(fixtureIds.objective)?.blockReason, "stale-base");
    assert.equal(byId.get(fixtureIds.task)?.state, "discarded");
    assert.equal(byId.get(fixtureIds.task)?.discardReason, "wontfix");
    assert.equal(byId.get(fixtureIds.initiative)?.state, "pending");
    assert.equal(byId.get(fixtureIds.initiative)?.blockReason, null);
    assert.equal(byId.get(fixtureIds.initiative)?.discardReason, null);
  });

  it("an empty project returns []", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["empty_project", "Empty", "general@1", null, 1],
      );
    });

    assert.deepEqual(
      listProjectNodes({ storage, plan }, { projectId: "empty_project" }),
      [],
    );
  });

  it("every item passes nodeListItem.safeParse", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    for (const item of listProjectNodes(
      { storage, plan },
      { projectId: fixtureIds.project },
    )) {
      assert.equal(nodeListItem.safeParse(item).success, true);
    }
  });

  it("unknown project throws ListProjectNodeError with project-not-found", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());

    let thrown: unknown = null;
    try {
      listProjectNodes({ storage, plan }, { projectId: "unknown-project" });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown !== null);
    assert.equal((thrown as { name: string }).name, "ListProjectNodeError");
    assert.equal((thrown as { refusal: string }).refusal, "project-not-found");
    assert.ok(
      (thrown as { message: string }).message.includes(
        "no project unknown-project",
      ),
    );
  });

  it("the query module holds no SELECT outside the project check", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./list-project-node.ts", import.meta.url),
      "utf8",
    );
    const selectMatches = source.match(/SELECT/g);
    assert.equal(
      selectMatches?.length ?? 0,
      1,
      "list-project-node.ts must have exactly one SELECT (the project check)",
    );
  });
});
