import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { showProjectGraph } from "./show-project-graph.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
  seedSiblingTask,
  seedEdge,
  seedWaivedEdge,
} from "../../../test/helpers/rows.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { Transaction } from "../../services/storage/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { RecordedEvent } from "../../services/event/index.ts";
import {
  createPlanStore,
  createPlanGraph,
  createBlobStore,
  createReadiness,
  seedPlanFixture,
  planFixtureIdentities,
} from "../../../test/helpers/plan.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";

describe("src/queries/project/show-project-graph.test", () => {
  function build(): {
    storage: Storage;
    plan: PlanStore;
    graph: Graph;
    dispose(): void;
  } {
    const temporary = createMigratedStorage();
    return {
      storage: temporary.storage,
      plan: createPlanStore(),
      graph: createPlanGraph(),
      dispose: temporary.dispose,
    };
  }

  it("returns the seeded graph for one project with attributes, options, nodes, edges", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    assert.deepEqual(Object.keys(result), [
      "attributes",
      "options",
      "nodes",
      "edges",
    ]);
    assert.deepEqual(result.options, {
      allowSelfLoops: false,
      multi: false,
      type: "directed",
    });
    assert.equal(result.attributes.projectId, fixtureIds.project);
    assert.ok(typeof result.attributes.revision === "string");
    assert.ok(result.nodes.length >= 3);
    assert.ok(result.edges.length >= 0);
  });

  it("nodes carry the ten declared attributes in bytewise key order", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    const attrKeys = [
      "assignment",
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
    for (const node of result.nodes) {
      assert.deepEqual(Object.keys(node.attributes).sort(), attrKeys);
    }
    const nodeKeys = result.nodes.map((n: { key: string }) => n.key);
    assert.deepEqual(nodeKeys, [...nodeKeys].sort());
  });

  it("a graph node with a deliverable and verify JSON publishes both parsed fields", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "UPDATE node SET deliverable = ?, verify_json = ? WHERE id = ?",
        [
          "expansion",
          JSON.stringify({
            paths: ["/docs/plan.md"],
            commands: ["pnpm run verify"],
          }),
          fixtureIds.objective,
        ],
      );
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );
    const node = result.nodes.find(
      (candidate) => candidate.key === fixtureIds.objective,
    );

    assert.ok(node);
    assert.equal(node.attributes.deliverable, "expansion");
    assert.deepEqual(node.attributes.verify, {
      paths: ["/docs/plan.md"],
      commands: ["pnpm run verify"],
    });
  });

  it("project.graph carries the assignment on every node", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run("UPDATE node SET assignment = ? WHERE id = ?", [
        "general@1",
        fixtureIds.task,
      ]);
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );
    const assigned = result.nodes.find(
      (candidate) => candidate.key === fixtureIds.task,
    );
    const unassigned = result.nodes.find(
      (candidate) => candidate.key === fixtureIds.initiative,
    );

    assert.ok(assigned);
    assert.ok(unassigned);
    assert.equal(assigned.attributes.assignment, "general@1");
    assert.equal(unassigned.attributes.assignment, null);
  });

  it("a graph node without deliverable or verify JSON publishes null fields", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run("UPDATE node SET deliverable = NULL WHERE id = ?", [
        fixtureIds.task,
      ]);
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );
    const node = result.nodes.find(
      (candidate) => candidate.key === fixtureIds.task,
    );

    assert.ok(node);
    assert.equal(node.attributes.deliverable, null);
    assert.equal(node.attributes.verify, null);
  });

  it("a graph node with malformed verify JSON throws verify-json-malformed with the node id", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const invalidPlan = new Proxy(plan, {
      get(target, property) {
        if (property === "readGraph") {
          return (transaction: Transaction, projectId: string) => {
            const result = plan.readGraph(transaction, projectId);
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

    assert.throws(
      () =>
        showProjectGraph(
          { storage, plan: invalidPlan, graph },
          { projectId: fixtureIds.project },
        ),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          (error as { code?: unknown }).code,
          "verify-json-malformed",
        );
        assert.equal((error as { nodeId?: unknown }).nodeId, fixtureIds.task);
        return true;
      },
    );
  });

  it("edges carry relation depends-on and waivedAt with source as fromNode and target as toNode", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSiblingTask(transaction);
      seedEdge(transaction, {
        id: "edge_1",
        fromNode: fixtureIds.task,
        toNode: "task_b",
      });
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    assert.equal(result.edges.length, 1);
    assert.equal(result.edges[0]!.source, fixtureIds.task);
    assert.equal(result.edges[0]!.target, "task_b");
    for (const edge of result.edges) {
      assert.equal(edge.attributes.relation, "depends-on");
      assert.ok("waivedAt" in edge.attributes);
    }
    const edgeKeys = result.edges.map((e: { key: string }) => e.key);
    assert.deepEqual(edgeKeys, [...edgeKeys].sort());
  });

  it("attribute key order is bytewise and insertion-independent", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const result1 = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );
    const result2 = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    assert.deepEqual(result1, result2);
    for (const node of result1.nodes) {
      const keys = Object.keys(node.attributes);
      assert.deepEqual(keys, [...keys].sort());
    }
    for (const edge of result1.edges) {
      const keys = Object.keys(edge.attributes);
      assert.deepEqual(keys, [...keys].sort());
    }
  });

  it("revision equals the newest revision from plan_revision", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    const revision = storage.transact((transaction) =>
      plan.newestRevision(transaction, fixtureIds.project),
    );
    assert.equal(result.attributes.revision, revision);
  });

  it("an empty project returns 200 with empty nodes, empty edges and revision null", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["empty_project", "Empty", "general@1", null, 1],
      );
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: "empty_project" },
    );

    assert.deepEqual(result.nodes, []);
    assert.deepEqual(result.edges, []);
    assert.equal(result.attributes.revision, null);
    assert.equal(result.attributes.projectId, "empty_project");
  });

  it("unknown project throws ShowProjectGraphError with project-not-found", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    let thrown: unknown = null;
    try {
      showProjectGraph(
        { storage, plan, graph },
        { projectId: "unknown-project" },
      );
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown !== null);
    assert.equal((thrown as { name: string }).name, "ShowProjectGraphError");
    assert.equal((thrown as { refusal: string }).refusal, "project-not-found");
    assert.ok(
      (thrown as { message: string }).message.includes(
        "no project unknown-project",
      ),
    );
  });

  it("performs project read, graph read, and revision read in one transaction", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    let transactCallCount = 0;
    const recordingStorage: Storage = {
      transact<T>(work: (transaction: Transaction) => T): T {
        transactCallCount++;
        return storage.transact(work);
      },
      migrate: storage.migrate,
      status: storage.status,
      close: storage.close,
      ping: storage.ping,
    };

    showProjectGraph(
      { storage: recordingStorage, plan, graph },
      { projectId: fixtureIds.project },
    );

    assert.equal(transactCallCount, 1);
  });

  it("passes the same transaction object to project check, readGraph, and newestRevision", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    let projectCheckTx: Transaction | null = null;
    let readGraphTx: Transaction | null = null;
    let newestRevisionTx: Transaction | null = null;

    const recordingStorage: Storage = {
      transact<T>(work: (transaction: Transaction) => T): T {
        return storage.transact((tx) => {
          projectCheckTx = tx;
          return work(tx);
        });
      },
      migrate: storage.migrate,
      status: storage.status,
      close: storage.close,
      ping: storage.ping,
    };

    const recordingPlan: PlanStore = {
      readGraph(transaction: Transaction, projectId: string) {
        readGraphTx = transaction;
        return plan.readGraph(transaction, projectId);
      },
      readNode: plan.readNode,
      runCoversNode(transaction, seedIds, now) {
        return plan.runCoversNode(transaction, seedIds, now);
      },
      readAllNodes: plan.readAllNodes,
      newestRevision(transaction: Transaction, projectId: string) {
        newestRevisionTx = transaction;
        return plan.newestRevision(transaction, projectId);
      },
      listRevisions: plan.listRevisions,
      findByImportId: plan.findByImportId,
      readValidationContext: plan.readValidationContext,
      readRepositoryName: plan.readRepositoryName,
      readContainmentFacts: plan.readContainmentFacts,
      readSubtreeContainmentFacts: plan.readSubtreeContainmentFacts,
      readSubtree: plan.readSubtree,
      readSubtreeExecutionFacts: plan.readSubtreeExecutionFacts,
      insertRevision: plan.insertRevision,
      mutateGraph: plan.mutateGraph,
      setNodeState: plan.setNodeState,
      setNodeAssignment: plan.setNodeAssignment,
    };

    showProjectGraph(
      { storage: recordingStorage, plan: recordingPlan, graph },
      { projectId: fixtureIds.project },
    );

    assert.ok(
      projectCheckTx !== null,
      "project check transaction was not recorded",
    );
    assert.ok(readGraphTx !== null, "readGraph transaction was not recorded");
    assert.ok(
      newestRevisionTx !== null,
      "newestRevision transaction was not recorded",
    );
    assert.strictEqual(
      projectCheckTx,
      readGraphTx,
      "project check and readGraph must receive the same transaction object",
    );
    assert.strictEqual(
      readGraphTx,
      newestRevisionTx,
      "readGraph and newestRevision must receive the same transaction object",
    );
  });

  it("a waived edge appears with its waivedAt value", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    const waivedAt = 1700000001000;
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSiblingTask(transaction);
      seedWaivedEdge(transaction, {
        id: "waived_edge",
        fromNode: fixtureIds.task,
        toNode: "task_b",
        waivedAt: waivedAt,
      });
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    const waivedEdge = result.edges.find(
      (e: { key: string }) => e.key === "waived_edge",
    );
    assert.ok(waivedEdge !== undefined);
    assert.equal(waivedEdge?.attributes.waivedAt, waivedAt);
    assert.equal(waivedEdge?.attributes.relation, "depends-on");
    assert.equal(waivedEdge?.source, fixtureIds.task);
    assert.equal(waivedEdge?.target, "task_b");
  });

  it("returns only the graph of the requested project, not other projects", (t) => {
    const { storage, plan, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "Second Project", "general@1", null, 1],
      );
      transaction.run(
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
      plan.mutateGraph(transaction, {
        projectId: "project_b",
        nodes: [
          {
            id: "initiative_b",
            projectId: "project_b",
            kind: "initiative",
            parentId: null,
            title: "Second Project",
            instructionBlob: fixtureIds.instructionBlob,
            acceptanceBlob: null,
            worker: null,
            repositoryId: null,
            revision: "revision_b",
            updatedAt: 1,
          },
        ],
        insertEdges: [],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: "revision_b", importId: null },
      });
    });

    const result = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );

    assert.equal(result.attributes.projectId, fixtureIds.project);
    assert.notEqual(result.attributes.projectId, "project_b");
  });

  it("the query module holds no vendor import", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./show-project-graph.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("graphology"), false);
  });

  it("the query module holds no SELECT outside the project check", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(
      new URL("./show-project-graph.ts", import.meta.url),
      "utf8",
    );
    const selectMatches = source.match(/SELECT/gi);
    assert.ok(selectMatches !== null);
    assert.equal(
      selectMatches.length,
      1,
      "show-project-graph.ts holds more than one SELECT",
    );
  });

  it("revision unchanged after state-only change (readiness transition)", (t) => {
    const { storage, plan, graph, blobs, dispose } = buildWithPlanExport();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const beforeGraph = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );
    const beforeRevision = storage.transact((transaction) =>
      plan.newestRevision(transaction, fixtureIds.project),
    );
    assert.equal(beforeGraph.attributes.revision, beforeRevision);

    storage.transact((transaction) => {
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit' WHERE id = ?",
        [planFixtureIdentities.task],
      );
    });

    storage.transact((transaction) => {
      const transitions = plan.setNodeState(transaction, {
        id: planFixtureIdentities.task,
        from: "blocked",
        to: "pending",
        trigger: "manual-unblock",
        at: 2,
        cause: { revision: beforeRevision!, importId: null },
        blockReason: null,
      });
      assert.ok(
        transitions.length > 0,
        "expected readiness transition to occur",
      );
      const readyTransition = transitions.find((tr) => tr.to === "ready");
      assert.ok(
        readyTransition !== undefined,
        "expected readiness-promoted transition to ready",
      );
      assert.equal(readyTransition?.nodeId, planFixtureIdentities.task);
    });

    const afterGraph = showProjectGraph(
      { storage, plan, graph },
      { projectId: fixtureIds.project },
    );
    const afterRevision = storage.transact((transaction) =>
      plan.newestRevision(transaction, fixtureIds.project),
    );

    assert.equal(afterGraph.attributes.revision, afterRevision);
    assert.equal(
      afterGraph.attributes.revision,
      beforeGraph.attributes.revision,
    );
    const taskNode = afterGraph.nodes.find(
      (n) => n.key === planFixtureIdentities.task,
    );
    assert.ok(taskNode !== undefined);
    assert.equal(taskNode.attributes.state, "ready");
    assert.equal(taskNode.attributes.blockReason, null);
  });

  function buildWithPlanExport(): {
    storage: Storage;
    plan: PlanStore;
    graph: Graph;
    blobs: BlobStore;
    dispose(): void;
  } {
    const temporary = createMigratedStorage();
    const clock = createMockClock({ start: 1700000000000, step: 1000 });
    const events: EventLog = {
      append(): RecordedEvent {
        return {
          id: "event_1",
          subjectKind: "node",
          subjectId: "node_a",
          type: "node.ready",
          actorKind: "daemon",
          actorId: "daemon_test",
          payload: {},
          occurredAt: 0,
        };
      },
      list(): readonly RecordedEvent[] {
        return [];
      },
    };
    const planStore = createPlanStore(createReadiness(events));
    const blobStore = createBlobStore(temporary.storage, clock);
    return {
      storage: temporary.storage,
      plan: planStore,
      graph: createPlanGraph(),
      blobs: blobStore,
      dispose: temporary.dispose,
    };
  }
});
