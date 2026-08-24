import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { listNodes as listNodesQuery } from "./list-node.ts";
import type { NodeListFilter } from "./list-node.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedListFilterFixture,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { nodeListItem } from "../../http/contract/graph.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import { createPlanStore } from "../../../test/helpers/plan.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";

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

const NOW = 1700000000000;
const INSTANCE = "daemon_instance_a";

type SweepRecord = Readonly<{
  transaction: Transaction;
  actor: string;
  now: number;
}>;

type ListFixture = Readonly<{
  storage: Storage;
  plan: PlanStore;
  sweeps?: SweepRecord[];
}>;

function listNodes(dependencies: ListFixture, input: NodeListFilter) {
  const sweeps: SweepRecord[] = dependencies.sweeps ?? [];
  return listNodesQuery(
    {
      storage: dependencies.storage,
      plan: dependencies.plan,
      clock: createMockClock({ start: NOW }),
      instanceId: INSTANCE,
      sweepExpiredExternalLeases: (transaction, sweepInput) => {
        sweeps.push({ transaction, ...sweepInput });
      },
    },
    input,
  );
}

describe("src/queries/node/list-node.test", () => {
  function build(): ListFixture & { dispose(): void } {
    const temporary = createMigratedStorage();
    return {
      storage: temporary.storage,
      plan: createPlanStore(),
      dispose: temporary.dispose,
    };
  }

  it("returns the seeded graph ascending by id with every member asserted field by field", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const items = listNodes({ storage, plan }, {});

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

    const items = listNodes({ storage, plan }, {});
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

    const items = listNodes({ storage, plan }, {});
    const json = JSON.stringify(items);
    assert.equal(json.includes("instruction"), false);
    assert.equal(json.includes("acceptance"), false);
    for (const item of items) {
      assert.equal(Object.hasOwn(item, "instructionBlob"), false);
    }
  });

  it("returns nodes of two projects ascending by id across the two", (t) => {
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

    const items = listNodes({ storage, plan }, {});

    assert.deepEqual(
      items.map((item) => [item.id, item.projectId]),
      [
        ["b_node_init", "project_b"],
        [fixtureIds.initiative, fixtureIds.project],
        ["j_node_obj", "project_b"],
        [fixtureIds.objective, fixtureIds.project],
        [fixtureIds.task, fixtureIds.project],
        ["u_node_task", "project_b"],
      ],
    );
  });

  it("fills dependencies from edge bytewise ascending and includes a waived edge", (t) => {
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
      transaction.run("UPDATE edge SET waived_at = 1 WHERE id = ?", ["edge_a"]);
    });

    const items = listNodes({ storage, plan }, {});
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

    const items = listNodes({ storage, plan }, {});
    const byId = new Map(items.map((item) => [item.id, item]));

    assert.equal(byId.get(fixtureIds.objective)?.state, "blocked");
    assert.equal(byId.get(fixtureIds.objective)?.blockReason, "stale-base");
    assert.equal(byId.get(fixtureIds.task)?.state, "discarded");
    assert.equal(byId.get(fixtureIds.task)?.discardReason, "wontfix");
    assert.equal(byId.get(fixtureIds.initiative)?.state, "pending");
    assert.equal(byId.get(fixtureIds.initiative)?.blockReason, null);
    assert.equal(byId.get(fixtureIds.initiative)?.discardReason, null);
  });

  it("an empty table returns []", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());

    assert.deepEqual(listNodes({ storage, plan }, {}), []);
  });

  it("a listing sweeps the expired external leases under the instance actor at the read instant", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    const sweeps: SweepRecord[] = [];

    listNodes({ storage, plan, sweeps }, {});

    assert.equal(sweeps.length, 1);
    assert.equal(sweeps[0]!.actor, INSTANCE);
    assert.equal(sweeps[0]!.now, NOW);
    assert.ok(sweeps[0]!.transaction !== undefined);
  });

  it("every item passes nodeListItem.safeParse", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    for (const item of listNodes({ storage, plan }, {})) {
      assert.equal(nodeListItem.safeParse(item).success, true);
    }
  });

  it("the three query modules hold no SELECT outside list-edge's project check", () => {
    for (const path of ["./list-node.ts", "./show-node.ts"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      assert.equal(source.includes("SELECT"), false, `${path} holds a SELECT`);
    }
    const listEdgeSource = readFileSync(
      new URL("../edge/list-edge.ts", import.meta.url),
      "utf8",
    );
    const occurrences = listEdgeSource.split("SELECT").length - 1;
    assert.equal(
      occurrences,
      1,
      "list-edge.ts holds exactly the project check",
    );
  });

  it("the project filter alone selects the rows of one project", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    assert.deepEqual(
      listNodes({ storage, plan }, { project: fixtureIds.project }).map(
        (item) => item.id,
      ),
      [fixtureIds.initiative, fixtureIds.objective, fixtureIds.task, "task_a2"],
    );
    assert.deepEqual(
      listNodes({ storage, plan }, { project: "project_b" }).map(
        (item) => item.id,
      ),
      ["initiative_pb", "objective_pb", "task_pb1", "task_pb2"],
    );
  });

  it("the kind filter alone selects the rows of one kind", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    assert.deepEqual(
      listNodes({ storage, plan }, { kind: "task" }).map((item) => item.id),
      ["task_a", "task_a2", "task_pb1", "task_pb2"],
    );
    assert.deepEqual(
      listNodes({ storage, plan }, { kind: "objective" }).map(
        (item) => item.id,
      ),
      [fixtureIds.objective, "objective_pb"],
    );
  });

  it("the state filter alone selects the rows of one state", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    assert.deepEqual(
      listNodes({ storage, plan }, { state: "ready" }).map((item) => item.id),
      [fixtureIds.objective, "objective_pb", "task_pb1", "task_pb2"],
    );
    assert.deepEqual(
      listNodes({ storage, plan }, { state: "blocked" }).map((item) => item.id),
      ["task_a2"],
    );
    assert.deepEqual(
      listNodes({ storage, plan }, { state: "running" }).map((item) => item.id),
      [fixtureIds.task],
    );
  });

  it("the blockReason filter alone selects the rows of one block reason", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    assert.deepEqual(
      listNodes({ storage, plan }, { blockReason: "dirty-recovery" }).map(
        (item) => item.id,
      ),
      ["task_a2"],
    );
  });

  it("the repository filter alone selects the rows of one repository", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    assert.deepEqual(
      listNodes({ storage, plan }, { repository: fixtureIds.repository }).map(
        (item) => item.id,
      ),
      [fixtureIds.objective, fixtureIds.task, "task_a2"],
    );
    assert.deepEqual(
      listNodes({ storage, plan }, { repository: "repo_b" }).map(
        (item) => item.id,
      ),
      ["objective_pb", "task_pb1", "task_pb2"],
    );
  });

  it("two filters combine with AND", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    const combined = listNodes(
      { storage, plan },
      {
        state: "ready",
        kind: "task",
      },
    ).map((item) => item.id);
    const byState = new Set(
      listNodes({ storage, plan }, { state: "ready" }).map((item) => item.id),
    );
    const byKind = new Set(
      listNodes({ storage, plan }, { kind: "task" }).map((item) => item.id),
    );

    assert.deepEqual(combined, ["task_pb1", "task_pb2"]);
    assert.ok(combined.every((id) => byState.has(id) && byKind.has(id)));
    assert.ok(combined.length < byState.size);
    assert.ok(combined.length < byKind.size);
  });

  it("repository matches an objective and its tasks, and never an initiative", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    const items = listNodes(
      { storage, plan },
      { repository: fixtureIds.repository },
    );

    assert.deepEqual(
      items.map((item) => item.id),
      [fixtureIds.objective, fixtureIds.task, "task_a2"],
    );
    assert.equal(
      items.some((item) => item.kind === "initiative"),
      false,
    );
    assert.equal(
      items.some((item) => item.id === "objective_pb"),
      false,
    );
    assert.equal(
      items.some((item) => item.id === "task_pb1"),
      false,
    );
  });

  it("a filter that matches nothing returns an empty list", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    assert.deepEqual(listNodes({ storage, plan }, { state: "done" }), []);
    assert.deepEqual(
      listNodes({ storage, plan }, { repository: "repo_z" }),
      [],
    );
    assert.deepEqual(
      listNodes({ storage, plan }, { kind: "objective", state: "blocked" }),
      [],
    );
  });

  it("the order does not depend on the filter", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedListFilterFixture(transaction));

    const unfiltered = listNodes({ storage, plan }, {});
    const filtered = listNodes({ storage, plan }, { state: "ready" });

    assert.ok(filtered.length > 0);
    assert.ok(filtered.length < unfiltered.length);
    const readyIds = new Set(filtered.map((item) => item.id));
    assert.deepEqual(
      filtered.map((item) => item.id),
      unfiltered.filter((item) => readyIds.has(item.id)).map((item) => item.id),
    );
  });
});
