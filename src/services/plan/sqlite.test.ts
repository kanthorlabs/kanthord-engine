import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SqlitePlanStore } from "./sqlite.ts";
import type { MutateGraphInput, SetNodeStateInput } from "./index.ts";
import {
  internalTriggerIds,
  triggerTransition,
  type NodeTriggerId,
} from "../../domain/node-trigger.ts";
import { externalTriggerIds } from "../../domain/external-transition.ts";
import {
  nodeKinds,
  nodeStates,
  type NodeKind,
  type NodeState,
} from "../../domain/state.ts";
import { canTransition } from "../../domain/transition.ts";
import { workerKinds } from "../../domain/worker.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import { executionBlockers } from "../../domain/plan-graph.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createReadiness } from "../../../test/helpers/plan.ts";
import {
  fixtureIds,
  seedRegistry,
  seedGraph,
  seedExecution,
  seedSecondRevisionWithTask,
  seedLeaseOnNode,
  seedWorkspaceOnNode,
  seedRunRow,
  seedCandidateRow,
  seedCheckResultRow,
  seedGitOperationRow,
} from "../../../test/helpers/rows.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../event/index.ts";
import type { Storage, Transaction } from "../storage/index.ts";

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

function build(): {
  storage: Storage;
  store: SqlitePlanStore;
  recorded: readonly RecordedAppend[];
  dispose(): void;
} {
  const temporary = createMigratedStorage();
  const recorded: RecordedAppend[] = [];
  const events: EventLog = {
    append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
      recorded.push({ transaction, input });
      return {
        id: "event_1",
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        type: input.type,
        actorKind: input.actorKind,
        actorId: input.actorId,
        payload: input.payload,
        occurredAt: 0,
      };
    },
    list(): readonly RecordedEvent[] {
      return [];
    },
  };
  return {
    storage: temporary.storage,
    store: new SqlitePlanStore({ readiness: createReadiness(events) }),
    recorded,
    dispose: temporary.dispose,
  };
}

const graphInputWithTrigger: MutateGraphInput = {
  projectId: "project_a",
  nodes: [],
  insertEdges: [],
  deleteEdgeIds: [],
  nodeDeletes: [],
  at: 1,
  cause: { revision: "revision_a", importId: null },
  // @ts-expect-error MutateGraphInput declares no trigger member
  trigger: "readiness-promoted",
};
assert.ok(graphInputWithTrigger);

// @ts-expect-error trigger is required on SetNodeStateInput
const stateInputWithoutTrigger: SetNodeStateInput = {
  id: "task_a",
  from: "pending",
  to: "ready",
  blockReason: null,
  at: 1,
  cause: { revision: "revision_a", importId: null },
};
assert.ok(stateInputWithoutTrigger);

function seedAll(t: Transaction): void {
  seedRegistry(t);
  seedGraph(t);
  seedExecution(t);
}

function seedSecondProject(t: Transaction): void {
  t.run(
    "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["project_b", "second-project", "general@1", null, 1],
  );
  t.run(
    "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
    [
      "revision_b",
      "project_b",
      null,
      "imp_b",
      fixtureIds.instructionBlob,
      fixtureIds.instructionBlob,
      fixtureIds.instructionBlob,
    ],
  );
  t.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      "initiative_b",
      "project_b",
      "initiative",
      null,
      "Second project",
      fixtureIds.instructionBlob,
      null,
      null,
      null,
      "pending",
      null,
      null,
      "revision_b",
      1,
    ],
  );
}

function seedTriggerNode(
  transaction: Transaction,
  input: Readonly<{
    id: string;
    kind: NodeKind;
    parentId: string | null;
    state: NodeState;
  }>,
): void {
  transaction.run(
    "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      input.id,
      fixtureIds.project,
      input.kind,
      input.parentId,
      "fixture node",
      fixtureIds.instructionBlob,
      input.kind === "task" ? fixtureIds.acceptanceBlob : null,
      null,
      input.kind === "objective" ? fixtureIds.repository : null,
      input.state,
      input.state === "blocked" ? "attempt-limit" : null,
      input.state === "discarded" ? "wontfix" : null,
      fixtureIds.planRevision,
      1,
    ],
  );
}

function seedSubjectChain(
  storage: Storage,
  caseId: string,
  kind: NodeKind,
  state: NodeState,
): string {
  const subjectId = `${caseId}_subject`;
  storage.transact((transaction) => {
    if (kind === "initiative") {
      seedTriggerNode(transaction, {
        id: subjectId,
        kind: "initiative",
        parentId: null,
        state,
      });
    } else if (kind === "objective") {
      seedTriggerNode(transaction, {
        id: `${caseId}_parent`,
        kind: "initiative",
        parentId: null,
        state: "done",
      });
      seedTriggerNode(transaction, {
        id: subjectId,
        kind: "objective",
        parentId: `${caseId}_parent`,
        state,
      });
    } else {
      seedTriggerNode(transaction, {
        id: `${caseId}_parent`,
        kind: "initiative",
        parentId: null,
        state: "done",
      });
      seedTriggerNode(transaction, {
        id: `${caseId}_parent2`,
        kind: "objective",
        parentId: `${caseId}_parent`,
        state: "done",
      });
      seedTriggerNode(transaction, {
        id: subjectId,
        kind: "task",
        parentId: `${caseId}_parent2`,
        state,
      });
    }
  });
  return subjectId;
}

function seedDependency(
  storage: Storage,
  caseId: string,
  subjectKind: NodeKind,
  subjectId: string,
): void {
  storage.transact((transaction) => {
    const dependencyId = `${caseId}_dependency`;
    if (subjectKind === "initiative") {
      seedTriggerNode(transaction, {
        id: dependencyId,
        kind: "initiative",
        parentId: null,
        state: "pending",
      });
    } else if (subjectKind === "objective") {
      seedTriggerNode(transaction, {
        id: dependencyId,
        kind: "objective",
        parentId: `${caseId}_parent`,
        state: "pending",
      });
    } else {
      seedTriggerNode(transaction, {
        id: dependencyId,
        kind: "task",
        parentId: `${caseId}_parent2`,
        state: "pending",
      });
    }
    transaction.run(
      "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
      [`${caseId}_edge`, subjectId, dependencyId],
    );
  });
}

describe("src/services/plan/sqlite.test", () => {
  it("readGraph returns the three seeded nodes ascending by id with no edges", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    assert.deepEqual(
      graph.nodes.map((node) => node.id),
      ["initiative_a", "objective_a", "task_a"],
    );
    assert.deepEqual(graph.edges, []);
  });

  it("readGraph returns every member of the seeded initiative", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    const initiative: StoredNode = graph.nodes[0] as StoredNode;
    assert.deepEqual(initiative, {
      id: "initiative_a",
      projectId: fixtureIds.project,
      kind: "initiative",
      parentId: null,
      title: "Harden the verify CLI",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: null,
      worker: null,
      assignment: null,
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    });
  });

  it("readGraph returns every member of the seeded objective and task", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    const objective: StoredNode = graph.nodes[1] as StoredNode;
    assert.deepEqual(objective, {
      id: "objective_a",
      projectId: fixtureIds.project,
      kind: "objective",
      parentId: "initiative_a",
      title: "Harden the verify CLI",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: null,
      worker: null,
      assignment: null,
      repositoryId: fixtureIds.repository,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    });

    const task: StoredNode = graph.nodes[2] as StoredNode;
    assert.deepEqual(task, {
      id: "task_a",
      projectId: fixtureIds.project,
      kind: "task",
      parentId: "objective_a",
      title: "Harden the verify CLI",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      worker: null,
      assignment: null,
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    });
  });

  it("readGraph returns edges ascending by (from_node, to_node) despite reverse insertion", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_1", "task_a", "objective_a", null],
      );
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_2", "task_a", "initiative_a", null],
      );
    });

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    assert.deepEqual(graph.edges, [
      {
        id: "edge_2",
        fromNode: "task_a",
        toNode: "initiative_a",
        waivedAt: null,
      },
      {
        id: "edge_1",
        fromNode: "task_a",
        toNode: "objective_a",
        waivedAt: null,
      },
    ]);
  });

  it("readGraph does not return an edge whose from_node belongs to another project", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedSecondProject(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_cross", "initiative_b", "task_a", null],
      );
    });

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    assert.deepEqual(graph.edges, []);
  });

  it("readGraph keeps a waived edge with its waivedAt in the dependent's dependencies", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_w", "task_a", "objective_a", 42],
      );
    });

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    assert.deepEqual(graph.edges, [
      { id: "edge_w", fromNode: "task_a", toNode: "objective_a", waivedAt: 42 },
    ]);
    const task = graph.nodes.find((node) => node.id === "task_a");
    assert.deepEqual(task?.dependencies, ["objective_a"]);
  });

  it("readGraph lists dependencies bytewise ascending and de-duplicated", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_1", "task_a", "objective_a", null],
      );
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_2", "task_a", "initiative_a", null],
      );
    });

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );

    const task = graph.nodes.find((node) => node.id === "task_a");
    assert.deepEqual(task?.dependencies, ["initiative_a", "objective_a"]);
  });

  it("readGraph on an empty project returns empty arrays", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_empty", "empty", "general@1", null, 1],
      );
    });

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, "project_empty"),
    );

    assert.deepEqual(graph, { nodes: [], edges: [] });
  });

  it("readNode returns the seeded task with every member and null for an unknown id", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const task = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );

    assert.deepEqual(task, {
      id: "task_a",
      projectId: fixtureIds.project,
      kind: "task",
      parentId: "objective_a",
      title: "Harden the verify CLI",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      worker: null,
      assignment: null,
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      deliverable: null,
      verifyJson: null,
      dependencies: [],
    });

    const missing = storage.transact((transaction) =>
      store.readNode(transaction, "task_missing"),
    );
    assert.equal(missing, null);
  });

  it("readNode returns the assignment stored on the node row", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET assignment = ? WHERE id = ?", [
        "general@1",
        fixtureIds.task,
      ]);
    });

    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.ok(node);
    assert.equal(node.assignment, "general@1");
  });

  it("readAllNodes returns a null assignment for an unassigned node", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const nodes = storage.transact((transaction) =>
      store.readAllNodes(transaction),
    );
    const node = nodes.find((candidate) => candidate.id === fixtureIds.task);
    assert.ok(node);
    assert.equal(node.assignment, null);
  });

  it("mutateGraph reads back a node deliverable and verify JSON through readNode and readGraph", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const verifyJson = '{"paths":["/a/b.ts"],"commands":["npm test"]}';
    const node = {
      id: "task_with_verify",
      projectId: fixtureIds.project,
      kind: "task",
      parentId: fixtureIds.objective,
      title: "Task with verification",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      worker: null,
      repositoryId: null,
      revision: fixtureIds.planRevision,
      updatedAt: 2,
      deliverable: "test",
      verifyJson,
    } as const;

    storage.transact((transaction) => {
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [node],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const readNode = storage.transact((transaction) =>
      store.readNode(transaction, node.id),
    );
    assert.ok(readNode);
    assert.equal(readNode.deliverable, "test");
    assert.equal(readNode.verifyJson, verifyJson);

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    const graphNode = graph.nodes.find((candidate) => candidate.id === node.id);
    assert.ok(graphNode);
    assert.equal(graphNode.deliverable, "test");
    assert.equal(graphNode.verifyJson, verifyJson);
  });

  it("mutateGraph reads back null deliverable and verify JSON", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const node = {
      id: "task_without_verify",
      projectId: fixtureIds.project,
      kind: "task",
      parentId: fixtureIds.objective,
      title: "Task without verification",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      worker: null,
      repositoryId: null,
      revision: fixtureIds.planRevision,
      updatedAt: 2,
      deliverable: null,
      verifyJson: null,
    } as const;

    storage.transact((transaction) => {
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [node],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const readNode = storage.transact((transaction) =>
      store.readNode(transaction, node.id),
    );
    assert.ok(readNode);
    assert.equal(readNode.deliverable, null);
    assert.equal(readNode.verifyJson, null);
  });

  it("an import writes a null assignment and a re-import leaves an existing one untouched", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const importedNode = {
      id: "task_assignment_null",
      projectId: fixtureIds.project,
      kind: "task",
      parentId: fixtureIds.objective,
      title: "Imported task",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      worker: null,
      repositoryId: null,
      revision: fixtureIds.planRevision,
      updatedAt: 2,
      deliverable: null,
      verifyJson: null,
    } as const;

    storage.transact((transaction) => {
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [importedNode],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });

      const inserted = transaction.get(
        "SELECT assignment FROM node WHERE id = ?",
        [importedNode.id],
      ) as Readonly<{ assignment: string | null }> | undefined;
      assert.ok(inserted);
      assert.equal(inserted.assignment, null);

      transaction.run("UPDATE node SET assignment = ? WHERE id = ?", [
        "general@1",
        importedNode.id,
      ]);
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [importedNode],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });

      const reimported = transaction.get(
        "SELECT assignment FROM node WHERE id = ?",
        [importedNode.id],
      ) as Readonly<{ assignment: string | null }> | undefined;
      assert.ok(reimported);
      assert.equal(reimported.assignment, "general@1");
    });
  });

  it("mutateGraph preserves deliverable and verify JSON when an upsert omits them", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const verifyJson = '{"paths":["/src/feature.ts"],"commands":["pnpm test"]}';
    const existingNode = {
      id: fixtureIds.task,
      projectId: fixtureIds.project,
      kind: "task",
      parentId: fixtureIds.objective,
      title: "Updated task",
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      worker: null,
      repositoryId: null,
      revision: fixtureIds.planRevision,
      updatedAt: 2,
    } as const;

    storage.transact((transaction) => {
      transaction.run(
        "UPDATE node SET deliverable = ?, verify_json = ? WHERE id = ?",
        ["test", verifyJson, fixtureIds.task],
      );

      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [existingNode],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });

      const row = transaction.get(
        "SELECT deliverable, verify_json FROM node WHERE id = ?",
        [fixtureIds.task],
      ) as
        | Readonly<{ deliverable: string | null; verify_json: string | null }>
        | undefined;
      assert.ok(row);
      assert.equal(row.deliverable, "test");
      assert.equal(row.verify_json, verifyJson);
    });
  });

  it("readAllNodes returns the nodes of two projects ascending by id across both", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedSecondProject(transaction);
    });

    const nodes = storage.transact((transaction) =>
      store.readAllNodes(transaction),
    );

    assert.deepEqual(
      nodes.map((node) => node.id),
      ["initiative_a", "initiative_b", "objective_a", "task_a"],
    );
  });

  it("newestRevision returns the greatest revision id and null for an empty project", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
        [
          "revision_b",
          fixtureIds.project,
          null,
          "imp_b",
          fixtureIds.instructionBlob,
          fixtureIds.instructionBlob,
          fixtureIds.instructionBlob,
        ],
      );
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_empty", "empty", "general@1", null, 1],
      );
    });

    const newest = storage.transact((transaction) =>
      store.newestRevision(transaction, fixtureIds.project),
    );
    assert.equal(newest, "revision_b");

    const empty = storage.transact((transaction) =>
      store.newestRevision(transaction, "project_empty"),
    );
    assert.equal(empty, null);
  });

  it("listRevisions returns newest first with the second row's parentId naming the first id", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
        [
          "revision_b",
          fixtureIds.project,
          fixtureIds.planRevision,
          "imp_b",
          fixtureIds.instructionBlob,
          fixtureIds.instructionBlob,
          fixtureIds.instructionBlob,
        ],
      );
    });

    const revisions = storage.transact((transaction) =>
      store.listRevisions(transaction, fixtureIds.project),
    );

    assert.equal(revisions.length, 2);
    assert.deepEqual(revisions[0], {
      id: "revision_b",
      parentId: fixtureIds.planRevision,
      origin: "import",
      importId: "imp_b",
      submittedBlob: fixtureIds.instructionBlob,
      choicesBlob: fixtureIds.instructionBlob,
      acceptedBlob: fixtureIds.instructionBlob,
    });
    assert.equal(revisions[0]?.parentId, revisions[1]?.id);
  });

  it("findByImportId returns the row for a known import id and null otherwise", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedSecondProject(transaction);
    });

    const found = storage.transact((transaction) =>
      store.findByImportId(transaction, fixtureIds.project, "imp_a"),
    );
    assert.deepEqual(found, {
      id: fixtureIds.planRevision,
      parentId: null,
      origin: "import",
      importId: "imp_a",
      submittedBlob: fixtureIds.instructionBlob,
      choicesBlob: fixtureIds.instructionBlob,
      acceptedBlob: fixtureIds.instructionBlob,
    });

    const unknown = storage.transact((transaction) =>
      store.findByImportId(transaction, fixtureIds.project, "imp_unknown"),
    );
    assert.equal(unknown, null);

    const secondProject = storage.transact((transaction) =>
      store.findByImportId(transaction, "project_b", "imp_a"),
    );
    assert.equal(secondProject, null);
  });

  it("mutateGraph inserts a fresh node as pending, then promotes it to ready", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'done' WHERE id IN (?, ?, ?)", [
        fixtureIds.initiative,
        fixtureIds.objective,
        fixtureIds.task,
      ]);
    });

    const transitions = storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: "task_new",
            projectId: fixtureIds.project,
            kind: "task",
            parentId: "objective_a",
            title: "A fresh task",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: fixtureIds.acceptanceBlob,
            worker: null,
            repositoryId: null,
            revision: fixtureIds.planRevision,
            updatedAt: 2,
          },
        ],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(transitions, [
      {
        nodeId: "task_new",
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const node = storage.transact((transaction) =>
      store.readNode(transaction, "task_new"),
    );
    assert.equal(node?.state, "ready");
    assert.equal(node?.blockReason, null);
    assert.equal(node?.discardReason, null);
    assert.equal(node?.title, "A fresh task");
  });

  it("mutateGraph never rewrites state, block_reason or discard_reason through the upsert", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit', discard_reason = 'kept' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    const before = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: fixtureIds.task,
            projectId: fixtureIds.project,
            kind: "task",
            parentId: "objective_a",
            title: "A new title",
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
      }),
    );

    const after = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.ok(before);
    assert.ok(after);
    assert.deepEqual(after, { ...before, title: "A new title" });
  });

  it("mutateGraph never clears discard_reason on a discarded node", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'discarded', block_reason = NULL, discard_reason = 'prose edit' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    const before = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: fixtureIds.task,
            projectId: fixtureIds.project,
            kind: "task",
            parentId: "objective_a",
            title: "Edited prose",
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
      }),
    );

    const after = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.ok(before);
    assert.ok(after);
    assert.deepEqual(after, { ...before, title: "Edited prose" });
  });

  it("mutateGraph inserts every node before any edge", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: "task_new",
            projectId: fixtureIds.project,
            kind: "task",
            parentId: "objective_a",
            title: "A fresh task",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: fixtureIds.acceptanceBlob,
            worker: null,
            repositoryId: null,
            revision: fixtureIds.planRevision,
            updatedAt: 2,
          },
        ],
        insertEdges: [
          { id: "edge_new", fromNode: "task_new", toNode: "task_a" },
        ],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    assert.deepEqual(graph.edges, [
      {
        id: "edge_new",
        fromNode: "task_new",
        toNode: "task_a",
        waivedAt: null,
      },
    ]);
  });

  it("mutateGraph writes and removes an edge", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [
          { id: "edge_new", fromNode: "task_a", toNode: "objective_a" },
        ],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const withEdge = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    assert.deepEqual(withEdge.edges, [
      {
        id: "edge_new",
        fromNode: "task_a",
        toNode: "objective_a",
        waivedAt: null,
      },
    ]);

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [],
        deleteEdgeIds: ["edge_new"],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );
    const afterDelete = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    assert.deepEqual(afterDelete.edges, []);

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [],
        deleteEdgeIds: ["edge_missing"],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );
  });

  it("mutateGraph returns both readiness directions from one call", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'done' WHERE id = ?", [
        fixtureIds.objective,
      ]);
      transaction.run("UPDATE node SET state = 'ready' WHERE id = ?", [
        fixtureIds.initiative,
      ]);
    });

    const transitions = storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [
          {
            id: "edge_a",
            fromNode: fixtureIds.task,
            toNode: fixtureIds.objective,
          },
          {
            id: "edge_b",
            fromNode: fixtureIds.initiative,
            toNode: fixtureIds.task,
          },
        ],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(transitions, [
      {
        nodeId: fixtureIds.initiative,
        from: "ready",
        to: "pending",
        trigger: "readiness-demoted",
      },
      {
        nodeId: fixtureIds.task,
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const initiative = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.initiative),
    );
    const task = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(initiative?.state, "pending");
    assert.equal(task?.state, "ready");
  });

  it("MutateGraphInput declares no trigger member", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const start = source.indexOf("export type MutateGraphInput");
    assert.ok(start !== -1, "MutateGraphInput is missing");
    const end = source.indexOf("}>;", start);
    assert.ok(end !== -1, "MutateGraphInput has no closing }>;");
    const slice = source.slice(start, end);
    assert.equal(slice.includes("trigger"), false);
    assert.equal(slice.includes("nodeDeletes"), true);
    assert.equal(graphInputWithTrigger.projectId, "project_a");
  });

  it("setNodeState writes the pair and returns the readiness transitions", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'done' WHERE id IN (?, ?)", [
        fixtureIds.initiative,
        fixtureIds.objective,
      ]);
      transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
        fixtureIds.task,
      ]);
    });

    const transitions = storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "running",
        to: "ready",
        trigger: "recovery-requeued",
        blockReason: null,
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(transitions, []);
    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(node?.state, "ready");
  });

  it("setNodeState writes a block reason when one is given", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
        fixtureIds.task,
      ]);
    });

    storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "running",
        to: "blocked",
        trigger: "recovery-blocked",
        blockReason: "dirty-recovery",
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(node?.state, "blocked");
    assert.equal(node?.blockReason, "dirty-recovery");
  });

  it("setNodeState clears a block reason when blockReason is null", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "blocked",
        to: "pending",
        trigger: "manual-unblock",
        blockReason: null,
        at: 3,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(node?.blockReason, null);
  });

  it("a readiness transition leaves block_reason null", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    const transitions = storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "blocked",
        to: "pending",
        trigger: "manual-unblock",
        blockReason: null,
        at: 3,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(
      transitions.map((transition) => [transition.nodeId, transition.to]),
      [[fixtureIds.task, "ready"]],
    );
    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(node?.state, "ready");
    assert.equal(node?.blockReason, null);
  });

  it("setNodeState applies readiness after the write", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
        fixtureIds.task,
      ]);
    });
    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: "task_b",
            projectId: fixtureIds.project,
            kind: "task",
            parentId: "objective_a",
            title: "A dependent task",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: fixtureIds.acceptanceBlob,
            worker: null,
            repositoryId: null,
            revision: fixtureIds.planRevision,
            updatedAt: 1,
          },
        ],
        insertEdges: [
          { id: "edge_b", fromNode: "task_b", toNode: fixtureIds.task },
        ],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const transitions = storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "running",
        to: "done",
        trigger: "worker-task-accepted",
        blockReason: null,
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(transitions, [
      {
        nodeId: "task_b",
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const dependent = storage.transact((transaction) =>
      store.readNode(transaction, "task_b"),
    );
    assert.equal(dependent?.state, "ready");
  });

  it("a waived edge satisfies its dependency through the store", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_w", fixtureIds.task, fixtureIds.objective, 42],
      );
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
        ["edge_o", fixtureIds.objective, fixtureIds.initiative],
      );
    });

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const task = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    const objective = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.objective),
    );
    assert.equal(task?.state, "ready");
    assert.equal(objective?.state, "pending");
  });

  it("setNodeState refuses pending to running through the matrix", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const before = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.throws(
      () =>
        storage.transact((transaction) =>
          store.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "pending",
            to: "running",
            trigger: "readiness-promoted",
            blockReason: null,
            at: 1,
            cause: { revision: fixtureIds.planRevision, importId: null },
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "task pending -> running is not in the transition matrix",
    );
    const after = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.deepEqual(after, before);
  });

  it("setNodeState throws when the declared from disagrees", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    assert.throws(
      () =>
        storage.transact((transaction) =>
          store.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "blocked",
            to: "pending",
            trigger: "readiness-promoted",
            blockReason: null,
            at: 1,
            cause: { revision: fixtureIds.planRevision, importId: null },
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "trigger readiness-promoted declares pending -> ready, the write names blocked -> pending",
    );
  });

  it("setNodeState throws when the declared to disagrees", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    assert.throws(
      () =>
        storage.transact((transaction) =>
          store.setNodeState(transaction, {
            id: fixtureIds.task,
            from: "pending",
            to: "blocked",
            trigger: "readiness-promoted",
            blockReason: "attempt-limit",
            at: 1,
            cause: { revision: fixtureIds.planRevision, importId: null },
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "trigger readiness-promoted declares pending -> ready, the write names pending -> blocked",
    );
  });

  it("setNodeState throws when the node kind is outside the declared levels", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'ready' WHERE id = ?", [
        fixtureIds.initiative,
      ]);
    });

    assert.throws(
      () =>
        storage.transact((transaction) =>
          store.setNodeState(transaction, {
            id: fixtureIds.initiative,
            from: "ready",
            to: "running",
            trigger: "claim-taken",
            blockReason: null,
            at: 1,
            cause: { revision: fixtureIds.planRevision, importId: null },
          }),
        ),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "trigger claim-taken declares levels objective,task, the node is a initiative",
    );
  });

  it("every trigger id writes only its declared pair, at only its declared levels", (t) => {
    const ids: readonly NodeTriggerId[] = [
      ...internalTriggerIds,
      ...externalTriggerIds,
    ];
    for (const id of ids) {
      const { storage, store, dispose } = build();
      t.after(() => dispose());
      storage.transact((transaction) => {
        seedRegistry(transaction);
        transaction.run(
          "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
          [
            fixtureIds.planRevision,
            fixtureIds.project,
            null,
            "imp_a",
            fixtureIds.instructionBlob,
            fixtureIds.instructionBlob,
            fixtureIds.instructionBlob,
          ],
        );
      });
      const declared = triggerTransition(id);
      const firstLevel = declared.levels[0] as NodeKind;

      for (const level of declared.levels) {
        const subjectId = seedSubjectChain(
          storage,
          `pos_${id}_${level}`,
          level,
          declared.from,
        );
        if (declared.to === "pending") {
          seedDependency(storage, `pos_${id}_${level}`, level, subjectId);
        }
        storage.transact((transaction) =>
          store.setNodeState(transaction, {
            id: subjectId,
            from: declared.from,
            to: declared.to,
            trigger: id,
            blockReason: declared.to === "blocked" ? "attempt-limit" : null,
            at: 1,
            cause: { revision: fixtureIds.planRevision, importId: null },
          }),
        );
        const stored = storage.transact((transaction) =>
          store.readNode(transaction, subjectId),
        );
        assert.equal(stored?.state, declared.to, `${id} at ${level}`);
      }

      const fromMismatch = nodeStates.find(
        (state) =>
          state !== declared.from &&
          canTransition(firstLevel, state, declared.to),
      );
      if (fromMismatch !== undefined) {
        const subjectId = seedSubjectChain(
          storage,
          `from_${id}`,
          firstLevel,
          fromMismatch,
        );
        assert.throws(
          () =>
            storage.transact((transaction) =>
              store.setNodeState(transaction, {
                id: subjectId,
                from: fromMismatch,
                to: declared.to,
                trigger: id,
                blockReason: declared.to === "blocked" ? "attempt-limit" : null,
                at: 1,
                cause: { revision: fixtureIds.planRevision, importId: null },
              }),
            ),
          (error: unknown) =>
            error instanceof Error &&
            error.message ===
              `trigger ${id} declares ${declared.from} -> ${declared.to}, the write names ${fromMismatch} -> ${declared.to}`,
          `${id} from mismatch`,
        );
      }

      const toMismatch = nodeStates.find(
        (state) =>
          state !== declared.to &&
          state !== declared.from &&
          canTransition(firstLevel, declared.from, state),
      );
      if (toMismatch !== undefined) {
        const subjectId = seedSubjectChain(
          storage,
          `to_${id}`,
          firstLevel,
          declared.from,
        );
        assert.throws(
          () =>
            storage.transact((transaction) =>
              store.setNodeState(transaction, {
                id: subjectId,
                from: declared.from,
                to: toMismatch,
                trigger: id,
                blockReason: toMismatch === "blocked" ? "attempt-limit" : null,
                at: 1,
                cause: { revision: fixtureIds.planRevision, importId: null },
              }),
            ),
          (error: unknown) =>
            error instanceof Error &&
            error.message ===
              `trigger ${id} declares ${declared.from} -> ${declared.to}, the write names ${declared.from} -> ${toMismatch}`,
          `${id} to mismatch`,
        );
      }

      for (const kind of nodeKinds) {
        if (declared.levels.includes(kind)) {
          continue;
        }
        if (declared.from === "awaiting_approval" && kind !== "objective") {
          continue;
        }
        const subjectId = seedSubjectChain(
          storage,
          `lvl_${id}_${kind}`,
          kind,
          declared.from,
        );
        const matrixRefuses = !canTransition(kind, declared.from, declared.to);
        const expected = matrixRefuses
          ? `${kind} ${declared.from} -> ${declared.to} is not in the transition matrix`
          : `trigger ${id} declares levels ${declared.levels.join(",")}, the node is a ${kind}`;
        assert.throws(
          () =>
            storage.transact((transaction) =>
              store.setNodeState(transaction, {
                id: subjectId,
                from: declared.from,
                to: declared.to,
                trigger: id,
                blockReason: declared.to === "blocked" ? "attempt-limit" : null,
                at: 1,
                cause: { revision: fixtureIds.planRevision, importId: null },
              }),
            ),
          (error: unknown) =>
            error instanceof Error && error.message === expected,
          `${id} at kind ${kind}`,
        );
      }
    }
  });

  it("setNodeState writes no row and appends no event when the from state does not match the stored state", (t) => {
    const { storage, store, recorded, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
        fixtureIds.task,
      ]);
    });

    const before = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    const transitions = storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: fixtureIds.task,
        from: "ready",
        to: "pending",
        trigger: "readiness-demoted",
        blockReason: null,
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );
    const after = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );

    assert.deepEqual(transitions, []);
    assert.deepEqual(after, before);
    assert.equal(recorded.length, 0);
  });

  it("setNodeState returns an empty list for an unknown node id", (t) => {
    const { storage, store, recorded, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const transitions = storage.transact((transaction) =>
      store.setNodeState(transaction, {
        id: "task_missing",
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
        blockReason: null,
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(transitions, []);
    assert.equal(recorded.length, 0);
  });

  it("a setNodeState input without a trigger member does not typecheck", () => {
    assert.equal(stateInputWithoutTrigger.id, "task_a");
  });

  it("the upsert statement's ON CONFLICT update list names none of state, block_reason, discard_reason", () => {
    const source = readFileSync(
      new URL("./sqlite.ts", import.meta.url),
      "utf8",
    );
    const conflictIndex = source.indexOf("ON CONFLICT");
    assert.ok(conflictIndex !== -1, "no ON CONFLICT statement in the module");
    const rest = source.slice(conflictIndex);
    const closers = ["`", '"', "'"]
      .map((quote) => rest.indexOf(quote))
      .filter((index) => index !== -1);
    assert.ok(closers.length > 0, "the ON CONFLICT statement is not delimited");
    const end = Math.min(...closers);
    const updateList = rest.slice(0, end);
    assert.equal(updateList.includes("state"), false);
    assert.equal(updateList.includes("block_reason"), false);
    assert.equal(updateList.includes("discard_reason"), false);
  });

  it("insertRevision writes every column and a duplicate import id throws", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.insertRevision(transaction, {
        id: "revision_c",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        origin: "import",
        importId: "imp_c",
        submittedBlob: fixtureIds.acceptanceBlob,
        choicesBlob: fixtureIds.acceptanceBlob,
        acceptedBlob: fixtureIds.acceptanceBlob,
      }),
    );

    const written = storage.transact((transaction) =>
      store.findByImportId(transaction, fixtureIds.project, "imp_c"),
    );
    assert.deepEqual(written, {
      id: "revision_c",
      parentId: fixtureIds.planRevision,
      origin: "import",
      importId: "imp_c",
      submittedBlob: fixtureIds.acceptanceBlob,
      choicesBlob: fixtureIds.acceptanceBlob,
      acceptedBlob: fixtureIds.acceptanceBlob,
    });

    assert.throws(() =>
      storage.transact((transaction) =>
        store.insertRevision(transaction, {
          id: "revision_d",
          projectId: fixtureIds.project,
          parentId: null,
          origin: "import",
          importId: "imp_c",
          submittedBlob: fixtureIds.instructionBlob,
          choicesBlob: fixtureIds.instructionBlob,
          acceptedBlob: fixtureIds.instructionBlob,
        }),
      ),
    );
  });

  it("insertRevision writes an import revision with every provenance column", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.insertRevision(transaction, {
        id: "revision_i",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        origin: "import",
        importId: "imp_i",
        submittedBlob: fixtureIds.acceptanceBlob,
        choicesBlob: fixtureIds.acceptanceBlob,
        acceptedBlob: fixtureIds.acceptanceBlob,
      }),
    );

    const revisions = storage.transact((transaction) =>
      store.listRevisions(transaction, fixtureIds.project),
    );
    assert.deepEqual(revisions[0], {
      id: "revision_i",
      parentId: fixtureIds.planRevision,
      origin: "import",
      importId: "imp_i",
      submittedBlob: fixtureIds.acceptanceBlob,
      choicesBlob: fixtureIds.acceptanceBlob,
      acceptedBlob: fixtureIds.acceptanceBlob,
    });
  });

  it("insertRevision writes a node-write revision with three null provenance columns", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.insertRevision(transaction, {
        id: "revision_w",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        origin: "node-write",
        importId: null,
        submittedBlob: null,
        choicesBlob: null,
        acceptedBlob: fixtureIds.instructionBlob,
      }),
    );

    const revisions = storage.transact((transaction) =>
      store.listRevisions(transaction, fixtureIds.project),
    );
    assert.deepEqual(revisions[0], {
      id: "revision_w",
      parentId: fixtureIds.planRevision,
      origin: "node-write",
      importId: null,
      submittedBlob: null,
      choicesBlob: null,
      acceptedBlob: fixtureIds.instructionBlob,
    });
  });

  it("findByImportId never returns a node-write revision", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      store.insertRevision(transaction, {
        id: "revision_nw",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        origin: "node-write",
        importId: null,
        submittedBlob: null,
        choicesBlob: null,
        acceptedBlob: fixtureIds.instructionBlob,
      });
    });

    const found = storage.transact((transaction) =>
      store.findByImportId(transaction, fixtureIds.project, "imp_a"),
    );
    assert.equal(found?.id, fixtureIds.planRevision);
    assert.equal(found?.origin, "import");

    const unknown = storage.transact((transaction) =>
      store.findByImportId(transaction, fixtureIds.project, "imp_unknown"),
    );
    assert.equal(unknown, null);
  });

  it("newestRevision returns a node-write revision minted after an import revision", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      store.insertRevision(transaction, {
        id: "revision_import_b",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        origin: "import",
        importId: "imp_b",
        submittedBlob: fixtureIds.instructionBlob,
        choicesBlob: fixtureIds.instructionBlob,
        acceptedBlob: fixtureIds.instructionBlob,
      });
      store.insertRevision(transaction, {
        id: "revision_write_c",
        projectId: fixtureIds.project,
        parentId: "revision_import_b",
        origin: "node-write",
        importId: null,
        submittedBlob: null,
        choicesBlob: null,
        acceptedBlob: fixtureIds.instructionBlob,
      });
    });

    const newest = storage.transact((transaction) =>
      store.newestRevision(transaction, fixtureIds.project),
    );
    assert.equal(newest, "revision_write_c");
  });

  it("mutateGraph deletes a node", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedTriggerNode(transaction, {
        id: "del_objective",
        kind: "objective",
        parentId: fixtureIds.initiative,
        state: "pending",
      });
      seedTriggerNode(transaction, {
        id: "del_task",
        kind: "task",
        parentId: "del_objective",
        state: "pending",
      });
    });

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: ["del_task"],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "del_objective"),
      true,
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "del_task"),
      false,
    );
  });

  it("mutateGraph deletes edges before it deletes nodes", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedTriggerNode(transaction, {
        id: "ord_a",
        kind: "task",
        parentId: fixtureIds.objective,
        state: "pending",
      });
      seedTriggerNode(transaction, {
        id: "ord_b",
        kind: "task",
        parentId: fixtureIds.objective,
        state: "pending",
      });
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
        ["ord_edge", "ord_a", "ord_b"],
      );
    });

    storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [],
        deleteEdgeIds: ["ord_edge"],
        nodeDeletes: ["ord_b"],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    const graph = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "ord_a"),
      true,
    );
    assert.equal(
      graph.nodes.some((node) => node.id === "ord_b"),
      false,
    );
    assert.deepEqual(graph.edges, []);
  });

  it("mutateGraph applies nodeDeletes in the given order", (t) => {
    const buildFixture = (): {
      storage: Storage;
      store: SqlitePlanStore;
      dispose(): void;
    } => {
      const { storage, store, dispose } = build();
      storage.transact((transaction) => {
        seedAll(transaction);
        seedTriggerNode(transaction, {
          id: "ord_objective",
          kind: "objective",
          parentId: fixtureIds.initiative,
          state: "pending",
        });
        seedTriggerNode(transaction, {
          id: "ord_task",
          kind: "task",
          parentId: "ord_objective",
          state: "pending",
        });
      });
      return { storage, store, dispose };
    };

    {
      const { storage, store, dispose } = buildFixture();
      t.after(() => dispose());
      storage.transact((transaction) =>
        store.mutateGraph(transaction, {
          projectId: fixtureIds.project,
          nodes: [],
          insertEdges: [],
          deleteEdgeIds: [],
          nodeDeletes: ["ord_task", "ord_objective"],
          at: 2,
          cause: { revision: fixtureIds.planRevision, importId: null },
        }),
      );
      const graph = storage.transact((transaction) =>
        store.readGraph(transaction, fixtureIds.project),
      );
      assert.equal(
        graph.nodes.some((node) => node.id === "ord_objective"),
        false,
      );
      assert.equal(
        graph.nodes.some((node) => node.id === "ord_task"),
        false,
      );
    }

    {
      const { storage, store, dispose } = buildFixture();
      t.after(() => dispose());
      assert.throws(
        () =>
          storage.transact((transaction) =>
            store.mutateGraph(transaction, {
              projectId: fixtureIds.project,
              nodes: [],
              insertEdges: [],
              deleteEdgeIds: [],
              nodeDeletes: ["ord_objective", "ord_task"],
              at: 2,
              cause: { revision: fixtureIds.planRevision, importId: null },
            }),
          ),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          String((error as { message?: string }).message).includes(
            "FOREIGN KEY",
          ),
      );
    }
  });

  it("mutateGraph applies readiness after the deletes", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run("UPDATE node SET state = 'done' WHERE id IN (?, ?, ?)", [
        fixtureIds.initiative,
        fixtureIds.objective,
        fixtureIds.task,
      ]);
      seedTriggerNode(transaction, {
        id: "read_dep",
        kind: "task",
        parentId: fixtureIds.objective,
        state: "pending",
      });
      seedTriggerNode(transaction, {
        id: "read_subject",
        kind: "task",
        parentId: fixtureIds.objective,
        state: "pending",
      });
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
        ["read_edge", "read_subject", "read_dep"],
      );
    });

    const transitions = storage.transact((transaction) =>
      store.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [],
        insertEdges: [],
        deleteEdgeIds: ["read_edge"],
        nodeDeletes: ["read_dep"],
        at: 2,
        cause: { revision: fixtureIds.planRevision, importId: null },
      }),
    );

    assert.deepEqual(transitions, [
      {
        nodeId: "read_subject",
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const node = storage.transact((transaction) =>
      store.readNode(transaction, "read_subject"),
    );
    assert.equal(node?.state, "ready");
  });

  it("readValidationContext returns the worker kinds and both repository lists ascending", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "repo_b",
          "second",
          "https://example.invalid/r2.git",
          fixtureIds.provider,
          "repos/r2.git",
          "main",
          1,
          "ready",
          null,
          null,
          null,
          1,
        ],
      );
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'provider', ?, ?)",
        [fixtureIds.project, fixtureIds.provider, 2],
      );
    });

    const context = storage.transact((transaction) =>
      store.readValidationContext(transaction, fixtureIds.project),
    );

    assert.deepEqual(context, {
      workerKinds: [...workerKinds],
      boundRepositories: ["kanthord-verify"],
      knownRepositories: ["kanthord-verify", "second"],
    });
  });

  it("readValidationContext.workerKinds deep-equals the seven-element fixed-order array", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const context = storage.transact((transaction) =>
      store.readValidationContext(transaction, fixtureIds.project),
    );

    assert.deepEqual(context.workerKinds, [
      "general@1",
      "tdd@1",
      "git@1",
      "claude.swe@1",
      "claude.te@1",
      "opencode.swe@1",
      "opencode.te@1",
    ]);
  });

  it("readContainmentFacts reports all false for a node with nothing attached", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const facts = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, "initiative_a"),
    );
    assert.deepEqual(facts, {
      lease: false,
      workspace: false,
      attemptCommit: false,
      retainedCommit: false,
    });
  });

  it("readContainmentFacts reports a held lease and not a released or repository-kind one", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('repository', ?, 'daemon-1', 'daemon', 1, 1, 1, 1)",
        [fixtureIds.task],
      );
    });

    const repositoryKind = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(repositoryKind.lease, false);

    storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, 'daemon-1', 'daemon', 1, 1, 1, 1)",
        [fixtureIds.task],
      );
    });

    const held = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(held.lease, true);

    storage.transact((transaction) => {
      transaction.run(
        "UPDATE lease SET owner = NULL, owner_kind = NULL WHERE subject_kind = 'node' AND subject_id = ?",
        [fixtureIds.task],
      );
    });

    const released = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(released.lease, false);
  });

  it("readContainmentFacts reports the workspace on the objective and not the task", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const objective = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, "objective_a"),
    );
    assert.equal(objective.workspace, true);

    const task = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(task.workspace, false);
  });

  it("readContainmentFacts reports an attempt commit only for the node's own run with an oid", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const before = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(before.attemptCommit, false);

    const objective = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, "objective_a"),
    );
    assert.equal(objective.attemptCommit, false);

    storage.transact((transaction) => {
      transaction.run("UPDATE attempt SET head_oid = ? WHERE id = ?", [
        "a".repeat(40),
        fixtureIds.attempt,
      ]);
    });

    const after = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(after.attemptCommit, true);
  });

  it("readContainmentFacts reports a retained commit for a candidate row", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO candidate (id, node_id, run_id, workspace_id, revision, candidate_oid, landing_base_oid, projected_outcome, evidence_blob, profile_blob, convention_version, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, 'coding/v1', 'open', ?)",
        [
          "candidate_a",
          fixtureIds.task,
          fixtureIds.taskRun,
          fixtureIds.workspace,
          fixtureIds.planRevision,
          "b".repeat(40),
          "a".repeat(40),
          fixtureIds.instructionBlob,
          fixtureIds.profileBlob,
          1,
        ],
      );
    });

    const facts = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(facts.retainedCommit, true);
  });

  it("readSubtreeContainmentFacts finds the workspace of a descendant that the node itself lacks", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const own = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, "initiative_a"),
    );
    assert.equal(own.workspace, false);

    const subtree = storage.transact((transaction) =>
      store.readSubtreeContainmentFacts(transaction, "initiative_a"),
    );
    assert.equal(subtree.workspace, true);
  });

  it("readSubtreeContainmentFacts finds a blocking row on the deepest task from the initiative", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, 'daemon-1', 'daemon', 1, 1, 1, 1)",
        [fixtureIds.task],
      );
    });

    const subtree = storage.transact((transaction) =>
      store.readSubtreeContainmentFacts(transaction, "initiative_a"),
    );
    assert.equal(subtree.lease, true);
  });

  it("a leaf task's subtree facts equal its own facts", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const own = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    const subtree = storage.transact((transaction) =>
      store.readSubtreeContainmentFacts(transaction, fixtureIds.task),
    );
    assert.deepEqual(subtree, own);
  });

  it("the descendant walk does not follow an edge row", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedSecondProject(transaction);
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, owner_kind, fence, acquired_at, renewed_at, expires_at) VALUES ('node', 'initiative_b', 'daemon-1', 'daemon', 1, 1, 1, 1)",
      );
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_outside", "initiative_b", "task_a", null],
      );
    });

    const subtree = storage.transact((transaction) =>
      store.readSubtreeContainmentFacts(transaction, "initiative_a"),
    );
    assert.deepEqual(subtree, {
      lease: false,
      workspace: true,
      attemptCommit: false,
      retainedCommit: false,
    });
  });

  it("readSubtree orders by depth descending then id ascending", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedSecondRevisionWithTask(transaction);
    });

    const subtree = storage.transact((transaction) =>
      store.readSubtree(transaction, "initiative_a"),
    );
    assert.deepEqual(subtree, [
      "task_a",
      "task_b",
      "objective_a",
      "initiative_a",
    ]);
  });

  it("readSubtreeExecutionFacts returns nothing on a clean subtree", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const facts = storage.transact((transaction) =>
      store.readSubtreeExecutionFacts(transaction, "initiative_a"),
    );
    assert.deepEqual(facts, []);
  });

  it("readSubtreeExecutionFacts reports one fact per blocker", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      seedLeaseOnNode(transaction, fixtureIds.task);
      seedCandidateRow(transaction, {
        id: "candidate_1",
        nodeId: fixtureIds.task,
        runId: fixtureIds.taskRun,
        workspaceId: fixtureIds.workspace,
      });
      seedCheckResultRow(transaction, {
        id: "check_1",
        nodeId: fixtureIds.task,
      });
      seedGitOperationRow(transaction, {
        id: "gitop_1",
        nodeId: fixtureIds.task,
      });
    });

    const facts = storage.transact((transaction) =>
      store.readSubtreeExecutionFacts(transaction, "initiative_a"),
    );
    const blockers = new Set(facts.map((fact) => fact.blocker));
    for (const blocker of executionBlockers) {
      assert.ok(blockers.has(blocker), `missing ${blocker}`);
    }
  });

  it("readSubtreeExecutionFacts deduplicates a repeated pair", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedWorkspaceOnNode(transaction, {
        id: "workspace_1",
        nodeId: fixtureIds.objective,
      });
      seedRunRow(transaction, {
        id: "run_0",
        kind: "objective",
        nodeId: fixtureIds.objective,
        parentRunId: null,
        workspaceId: "workspace_1",
      });
      seedRunRow(transaction, {
        id: "run_1",
        kind: "task",
        nodeId: fixtureIds.task,
        parentRunId: "run_0",
        workspaceId: "workspace_1",
      });
      seedRunRow(transaction, {
        id: "run_2",
        kind: "task",
        nodeId: fixtureIds.task,
        parentRunId: "run_0",
        workspaceId: "workspace_1",
        state: "ended",
      });
    });

    const facts = storage.transact((transaction) =>
      store.readSubtreeExecutionFacts(transaction, fixtureIds.task),
    );
    assert.deepEqual(facts, [{ nodeId: fixtureIds.task, blocker: "run" }]);
  });

  it("readSubtreeExecutionFacts sorts by node id bytewise then blocker order", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedLeaseOnNode(transaction, fixtureIds.task);
      seedLeaseOnNode(transaction, fixtureIds.objective);
      seedWorkspaceOnNode(transaction, {
        id: "workspace_1",
        nodeId: fixtureIds.task,
      });
      seedWorkspaceOnNode(transaction, {
        id: "workspace_2",
        nodeId: fixtureIds.objective,
      });
    });

    const facts = storage.transact((transaction) =>
      store.readSubtreeExecutionFacts(transaction, "initiative_a"),
    );
    assert.deepEqual(facts, [
      { nodeId: fixtureIds.objective, blocker: "lease" },
      { nodeId: fixtureIds.objective, blocker: "workspace" },
      { nodeId: fixtureIds.task, blocker: "lease" },
      { nodeId: fixtureIds.task, blocker: "workspace" },
    ]);
  });

  it("the module interpolates no value into SQL and selects no star", () => {
    const source = readFileSync(
      new URL("./sqlite.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("SELECT *"), false);
    assert.equal(source.includes("select *"), false);
    const sqlStrings = source.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    for (const sql of sqlStrings) {
      assert.equal(sql.includes("${"), false, sql);
    }
  });

  it("every read is deterministic across two calls", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    const reads = (): unknown =>
      storage.transact((transaction) => ({
        graph: store.readGraph(transaction, fixtureIds.project),
        node: store.readNode(transaction, fixtureIds.task),
        allNodes: store.readAllNodes(transaction),
        newest: store.newestRevision(transaction, fixtureIds.project),
        revisions: store.listRevisions(transaction, fixtureIds.project),
        byImport: store.findByImportId(
          transaction,
          fixtureIds.project,
          "imp_a",
        ),
        context: store.readValidationContext(transaction, fixtureIds.project),
        facts: store.readContainmentFacts(transaction, fixtureIds.task),
        subtree: store.readSubtreeContainmentFacts(transaction, "initiative_a"),
      }));

    assert.deepEqual(reads(), reads());
  });
  it("readGraph issues a node statement the node_project index serves by SEARCH", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const issued = storage.transact((transaction) => {
      const recorder = recordingTransaction(transaction);
      const result = store.readGraph(recorder.transaction, fixtureIds.project);
      assert.ok(result.nodes.length >= 3);
      return recorder.statements;
    });

    const nodeStatement = issued.find((statement) =>
      /FROM node\b/.test(statement.sql),
    );
    assert.ok(
      nodeStatement,
      `readGraph issued no node statement: ${JSON.stringify(issued)}`,
    );

    const detail = storage.transact((transaction) =>
      queryPlan(transaction, nodeStatement.sql, nodeStatement.parameters),
    );
    assert.match(detail, /SEARCH/);
    assert.match(detail, /node_project/);
    assert.doesNotMatch(detail, /SCAN/);
  });

  it("readGraph issues an edge statement the edge_from_node index serves by SEARCH", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const issued = storage.transact((transaction) => {
      const recorder = recordingTransaction(transaction);
      store.readGraph(recorder.transaction, fixtureIds.project);
      return recorder.statements;
    });

    const edgeStatement = issued.find((statement) =>
      /FROM edge\b/.test(statement.sql),
    );
    assert.ok(
      edgeStatement,
      `readGraph issued no edge statement: ${JSON.stringify(issued)}`,
    );

    const detail = storage.transact((transaction) =>
      queryPlan(transaction, edgeStatement.sql, edgeStatement.parameters),
    );
    assert.match(detail, /SEARCH/);
    assert.match(detail, /edge_from_node/);
    assert.doesNotMatch(detail, /SCAN TABLE edge/);
  });

  it("readAllNodes issues a node statement that stays a SCAN because it carries no predicate", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const issued = storage.transact((transaction) => {
      const recorder = recordingTransaction(transaction);
      const result = store.readAllNodes(recorder.transaction);
      assert.ok(result.length >= 3);
      return recorder.statements;
    });

    const nodeStatement = issued.find((statement) =>
      /FROM node\b/.test(statement.sql),
    );
    assert.ok(
      nodeStatement,
      `readAllNodes issued no node statement: ${JSON.stringify(issued)}`,
    );

    const detail = storage.transact((transaction) =>
      queryPlan(transaction, nodeStatement.sql, nodeStatement.parameters),
    );
    assert.match(detail, /SCAN/);
    assert.doesNotMatch(detail, /node_project/);
  });
});

type IssuedStatement = Readonly<{
  sql: string;
  parameters: readonly unknown[];
}>;

function recordingTransaction(inner: Transaction): {
  transaction: Transaction;
  statements: readonly IssuedStatement[];
} {
  const statements: IssuedStatement[] = [];
  const record = (sql: string, parameters?: readonly unknown[]): void => {
    statements.push({ sql, parameters: parameters ?? [] });
  };
  return {
    transaction: {
      run(sql: string, parameters?: readonly unknown[]): void {
        record(sql, parameters);
        inner.run(sql, parameters);
      },
      get(sql: string, parameters?: readonly unknown[]): unknown {
        record(sql, parameters);
        return inner.get(sql, parameters);
      },
      all(sql: string, parameters?: readonly unknown[]): readonly unknown[] {
        record(sql, parameters);
        return inner.all(sql, parameters);
      },
    },
    statements,
  };
}

function queryPlan(
  transaction: Transaction,
  sql: string,
  parameters: readonly unknown[],
): string {
  const rows = transaction.all(
    `EXPLAIN QUERY PLAN ${sql}`,
    parameters,
  ) as readonly Record<string, unknown>[];
  return rows.map((row) => row["detail"]).join(" ");
}
