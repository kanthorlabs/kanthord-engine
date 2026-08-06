import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { SqlitePlanStore } from "./sqlite.ts";
import { workerKinds } from "../../domain/worker.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedRegistry,
  seedGraph,
  seedExecution,
} from "../../../test/helpers/rows.ts";
import type { Storage, Transaction } from "../storage/index.ts";

function build(): {
  storage: Storage;
  store: SqlitePlanStore;
  dispose(): void;
} {
  const temporary = createMigratedStorage();
  return {
    storage: temporary.storage,
    store: new SqlitePlanStore(),
    dispose: temporary.dispose,
  };
}

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
    "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
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
      repositoryId: fixtureIds.repository,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
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
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
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
      repositoryId: null,
      state: "pending",
      blockReason: null,
      discardReason: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      dependencies: [],
    });

    const missing = storage.transact((transaction) =>
      store.readNode(transaction, "task_missing"),
    );
    assert.equal(missing, null);
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
        "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
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
        "INSERT INTO plan_revision (id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?)",
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

  it("upsertNode inserts a fresh node as pending", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.upsertNode(transaction, {
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
      }),
    );

    const node = storage.transact((transaction) =>
      store.readNode(transaction, "task_new"),
    );
    assert.equal(node?.state, "pending");
    assert.equal(node?.blockReason, null);
    assert.equal(node?.discardReason, null);
    assert.equal(node?.title, "A fresh task");
  });

  it("upsertNode never rewrites state, block_reason or discard_reason", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit', discard_reason = 'kept' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    storage.transact((transaction) =>
      store.upsertNode(transaction, {
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
        updatedAt: 3,
      }),
    );

    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(node?.state, "blocked");
    assert.equal(node?.blockReason, "attempt-limit");
    assert.equal(node?.discardReason, "kept");
    assert.equal(node?.title, "A new title");
  });

  it("upsertNode never clears discard_reason on a discarded node", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "UPDATE node SET state = 'discarded', block_reason = NULL, discard_reason = 'prose edit' WHERE id = ?",
        [fixtureIds.task],
      );
    });

    storage.transact((transaction) =>
      store.upsertNode(transaction, {
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
        updatedAt: 4,
      }),
    );

    const node = storage.transact((transaction) =>
      store.readNode(transaction, fixtureIds.task),
    );
    assert.equal(node?.state, "discarded");
    assert.equal(node?.discardReason, "prose edit");
    assert.equal(node?.title, "Edited prose");
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

  it("insertEdge and deleteEdge write and remove one row", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedAll);

    storage.transact((transaction) =>
      store.insertEdge(transaction, {
        id: "edge_new",
        fromNode: "task_a",
        toNode: "objective_a",
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
      store.deleteEdge(transaction, "edge_new"),
    );
    const afterDelete = storage.transact((transaction) =>
      store.readGraph(transaction, fixtureIds.project),
    );
    assert.deepEqual(afterDelete.edges, []);

    storage.transact((transaction) =>
      store.deleteEdge(transaction, "edge_missing"),
    );
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
          importId: "imp_c",
          submittedBlob: fixtureIds.instructionBlob,
          choicesBlob: fixtureIds.instructionBlob,
          acceptedBlob: fixtureIds.instructionBlob,
        }),
      ),
    );
  });

  it("readValidationContext returns the worker kinds and both repository lists ascending", (t) => {
    const { storage, store, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedAll(transaction);
      transaction.run(
        "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          "repo_b",
          "second",
          "https://example.invalid/r2.git",
          fixtureIds.provider,
          "repos/r2.git",
          "main",
          "main",
          "refs/heads/main",
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
      boundRepositories: [fixtureIds.repository],
      knownRepositories: [fixtureIds.repository, "repo_b"],
    });
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
        "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('repository', ?, 'daemon-1', 1, 1, 1, 1)",
        [fixtureIds.task],
      );
    });

    const repositoryKind = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(repositoryKind.lease, false);

    storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, 'daemon-1', 1, 1, 1, 1)",
        [fixtureIds.task],
      );
    });

    const held = storage.transact((transaction) =>
      store.readContainmentFacts(transaction, fixtureIds.task),
    );
    assert.equal(held.lease, true);

    storage.transact((transaction) => {
      transaction.run(
        "UPDATE lease SET owner = NULL WHERE subject_kind = 'node' AND subject_id = ?",
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
        "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', ?, 'daemon-1', 1, 1, 1, 1)",
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
        "INSERT INTO lease (subject_kind, subject_id, owner, fence, acquired_at, renewed_at, expires_at) VALUES ('node', 'initiative_b', 'daemon-1', 1, 1, 1, 1)",
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

  it("the module interpolates no value into SQL and selects no star", () => {
    const source = readFileSync(
      new URL("./sqlite.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("SELECT *"), false);
    assert.equal(source.includes("select *"), false);
    assert.equal(source.includes("${"), false);
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
});
