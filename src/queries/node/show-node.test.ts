import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { showNode } from "./show-node.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  fixtureIds,
  seedGraph,
  seedNodeState,
  seedRegistry,
  seedSiblingObjective,
  seedSiblingTask,
} from "../../../test/helpers/rows.ts";
import { nodeShowResponse } from "../../http/contract/graph.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Execution } from "../../services/execution/index.ts";
import {
  createBlobStore,
  createPlanStore,
} from "../../../test/helpers/plan.ts";
import { createBackedExecutionFake } from "../../../test/helpers/execution.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import type { IdGenerator } from "../../services/ids/index.ts";

const blobHashPattern = /^sha256:[0-9a-f]{64}$/;

const OBJECT_ID = "a".repeat(40);
const NEWEST_RUN_ULID = "01HZY000000000000000000001";

const twentyMemberNames = [
  "acceptance",
  "acceptanceBlob",
  "attestedObjectId",
  "blockReason",
  "dependencies",
  "discardReason",
  "id",
  "instruction",
  "instructionBlob",
  "kind",
  "parentId",
  "projectId",
  "projection",
  "repo",
  "repositoryId",
  "revision",
  "state",
  "title",
  "updatedAt",
  "worker",
];

describe("src/queries/node/show-node.test", () => {
  function build(ulids: readonly string[] = []): {
    storage: Storage;
    plan: PlanStore;
    blobs: BlobStore;
    execution: Execution;
    ids: IdGenerator;
    dispose(): void;
  } {
    const temporary = createMigratedStorage();
    const plan = createPlanStore();
    const blobs = createBlobStore(
      temporary.storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    const ids = createMockIdGenerator({ ulids });
    const execution = createBackedExecutionFake({ ids }).execution;
    return {
      storage: temporary.storage,
      plan,
      blobs,
      execution,
      ids,
      dispose: temporary.dispose,
    };
  }

  it("the seeded task returns all twenty members field by field", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );

    assert.deepEqual(view, {
      id: fixtureIds.task,
      projectId: fixtureIds.project,
      kind: "task",
      title: "Harden the verify CLI",
      state: "pending",
      blockReason: null,
      discardReason: null,
      parentId: fixtureIds.objective,
      dependencies: [],
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: fixtureIds.acceptanceBlob,
      instruction: "\u0000",
      acceptance: "\u0000",
      worker: null,
      repositoryId: null,
      repo: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      attestedObjectId: null,
      projection: null,
    });
  });

  it("the objective and the initiative return acceptanceBlob null and the objective returns its repository", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const objective = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );
    const initiative = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.initiative },
    );

    assert.equal(objective?.acceptanceBlob, null);
    assert.equal(objective?.acceptance, null);
    assert.equal(objective?.repositoryId, fixtureIds.repository);
    assert.equal(objective?.repo, "kanthord-verify");
    assert.equal(objective?.kind, "objective");
    assert.equal(initiative?.acceptanceBlob, null);
    assert.equal(initiative?.acceptance, null);
    assert.equal(initiative?.repositoryId, null);
    assert.equal(initiative?.repo, null);
  });

  it("revision is the seeded revision and updatedAt is the seeded value, not a clock reading", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );

    assert.equal(view?.revision, fixtureIds.planRevision);
    assert.equal(view?.updatedAt, 1);
  });

  it("an unknown but well-formed id returns null", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    assert.equal(
      showNode({ storage, plan, blobs, execution }, { id: "task_nope" }),
      null,
    );
  });

  it("the blob members match the sha256 pattern and the content members carry the stored bytes", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    const marker = "SENSITIVE-BLOB-BYTES";
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      const hash = blobs.put(transaction, new TextEncoder().encode(marker));
      transaction.run("UPDATE node SET instruction_blob = ? WHERE id = ?", [
        hash,
        fixtureIds.task,
      ]);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );

    assert.ok(view);
    assert.match(view.instructionBlob, blobHashPattern);
    assert.match(view.acceptanceBlob ?? "", blobHashPattern);
    assert.equal(view.instruction, marker);
    assert.equal(view.acceptance, "\u0000");
  });

  it("dependencies are populated from the edge table when the node has a real edge", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_show", fixtureIds.task, fixtureIds.objective, null],
      );
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );

    assert.ok(view);
    assert.deepEqual(view.dependencies, [fixtureIds.objective]);
  });

  it("Object.keys of the view bytewise sorted deep-equals the twenty member names", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );
    assert.ok(view);
    assert.deepEqual([...Object.keys(view)].sort(), twentyMemberNames);
  });

  it("nodeShowResponse.safeParse succeeds", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );
    assert.ok(view);
    assert.equal(nodeShowResponse.safeParse(view).success, true);
  });

  it("a task returns a null attestedObjectId and a null projection", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.task },
    );

    assert.ok(view);
    assert.equal(view.attestedObjectId, null);
    assert.equal(view.projection, null);
  });

  it("an initiative returns a null attestedObjectId and a null projection", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.initiative },
    );

    assert.ok(view);
    assert.equal(view.attestedObjectId, null);
    assert.equal(view.projection, null);
  });

  it("an objective with one non-terminal task returns a null projection", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );

    assert.ok(view);
    assert.equal(view.projection, null);
  });

  it("an objective whose tasks are all done returns projection done", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedNodeState(transaction, fixtureIds.task, "done");
    });

    const doneView = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );
    assert.equal(doneView?.projection, "done");

    storage.transact((transaction) => {
      seedSiblingTask(transaction);
      seedNodeState(transaction, "task_b", "discarded");
    });
    const partialView = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );
    assert.equal(partialView?.projection, "partial");

    storage.transact((transaction) => {
      seedNodeState(transaction, fixtureIds.task, "discarded");
    });
    const discardedView = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );
    assert.equal(discardedView?.projection, "discarded");
  });

  it("an objective with no task returns a null projection", (t) => {
    const { storage, plan, blobs, execution, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      seedSiblingObjective(transaction);
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: "objective_sibling" },
    );

    assert.ok(view);
    assert.equal(view.projection, null);
    assert.equal(view.attestedObjectId, null);
  });

  it("an objective returns the attested object id of its active run", (t) => {
    const { storage, plan, blobs, execution, dispose } = build([
      "01HZY000000000000000000000",
    ]);
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    storage.transact((transaction) => {
      const opened = execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "objective",
        parentRunId: null,
        leaseFence: 1,
        attemptLimit: 3,
      });
      execution.stampRunHead(transaction, {
        runId: opened.id,
        headOid: OBJECT_ID,
      });
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );

    assert.ok(view);
    assert.equal(view.attestedObjectId, OBJECT_ID);
  });

  it("a closed objective still returns the attested object id", (t) => {
    const { storage, plan, blobs, execution, dispose } = build([
      "01HZY000000000000000000000",
    ]);
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    storage.transact((transaction) => {
      const opened = execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "objective",
        parentRunId: null,
        leaseFence: 1,
        attemptLimit: 3,
      });
      execution.stampRunHead(transaction, {
        runId: opened.id,
        headOid: OBJECT_ID,
      });
      execution.endRun(transaction, {
        runId: opened.id,
        outcome: "done",
        at: 2,
      });
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );

    assert.ok(view);
    assert.equal(view.attestedObjectId, OBJECT_ID);
  });

  it("an objective with two runs returns the head_oid of the newest run", (t) => {
    const { storage, plan, blobs, execution, dispose } = build([
      "01HZY000000000000000000000",
      NEWEST_RUN_ULID,
    ]);
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    storage.transact((transaction) => {
      const first = execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "objective",
        parentRunId: null,
        leaseFence: 1,
        attemptLimit: 3,
      });
      execution.stampRunHead(transaction, {
        runId: first.id,
        headOid: "b".repeat(40),
      });
      execution.endRun(transaction, {
        runId: first.id,
        outcome: "done",
        at: 2,
      });
      const second = execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "objective",
        parentRunId: null,
        leaseFence: 2,
        attemptLimit: 3,
      });
      execution.stampRunHead(transaction, {
        runId: second.id,
        headOid: OBJECT_ID,
      });
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );

    assert.ok(view);
    assert.equal(view.attestedObjectId, OBJECT_ID);
  });

  it("every other field keeps its value", (t) => {
    const { storage, plan, blobs, execution, dispose } = build([
      "01HZY000000000000000000000",
    ]);
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });
    storage.transact((transaction) => {
      const opened = execution.openRun(transaction, {
        nodeId: fixtureIds.objective,
        kind: "objective",
        parentRunId: null,
        leaseFence: 1,
        attemptLimit: 3,
      });
      execution.stampRunHead(transaction, {
        runId: opened.id,
        headOid: OBJECT_ID,
      });
    });

    const view = showNode(
      { storage, plan, blobs, execution },
      { id: fixtureIds.objective },
    );

    assert.deepEqual(view, {
      id: fixtureIds.objective,
      projectId: fixtureIds.project,
      kind: "objective",
      title: "Harden the verify CLI",
      state: "pending",
      blockReason: null,
      discardReason: null,
      parentId: fixtureIds.initiative,
      dependencies: [],
      instructionBlob: fixtureIds.instructionBlob,
      acceptanceBlob: null,
      instruction: "\u0000",
      acceptance: null,
      worker: null,
      repositoryId: fixtureIds.repository,
      repo: "kanthord-verify",
      revision: fixtureIds.planRevision,
      updatedAt: 1,
      attestedObjectId: OBJECT_ID,
      projection: null,
    });
  });
});
