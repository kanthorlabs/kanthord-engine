import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { showNode } from "./show-node.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import { nodeShowResponse } from "../../http/contract/graph.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import {
  createBlobStore,
  createPlanStore,
} from "../../../test/helpers/plan.ts";

const blobHashPattern = /^sha256:[0-9a-f]{64}$/;

const eighteenMemberNames = [
  "acceptance",
  "acceptanceBlob",
  "blockReason",
  "dependencies",
  "discardReason",
  "id",
  "instruction",
  "instructionBlob",
  "kind",
  "parentId",
  "projectId",
  "repo",
  "repositoryId",
  "revision",
  "state",
  "title",
  "updatedAt",
  "worker",
];

describe("src/queries/node/show-node.test", () => {
  function build(): {
    storage: Storage;
    plan: PlanStore;
    blobs: BlobStore;
    dispose(): void;
  } {
    const temporary = createMigratedStorage();
    const plan = createPlanStore();
    const blobs = createBlobStore(
      temporary.storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    return {
      storage: temporary.storage,
      plan,
      blobs,
      dispose: temporary.dispose,
    };
  }

  it("the seeded task returns all eighteen members field by field", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode({ storage, plan, blobs }, { id: fixtureIds.task });

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
    });
  });

  it("the objective and the initiative return acceptanceBlob null and the objective returns its repository", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const objective = showNode(
      { storage, plan, blobs },
      { id: fixtureIds.objective },
    );
    const initiative = showNode(
      { storage, plan, blobs },
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
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode({ storage, plan, blobs }, { id: fixtureIds.task });

    assert.equal(view?.revision, fixtureIds.planRevision);
    assert.equal(view?.updatedAt, 1);
  });

  it("an unknown but well-formed id returns null", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    assert.equal(showNode({ storage, plan, blobs }, { id: "task_nope" }), null);
  });

  it("the blob members match the sha256 pattern and the content members carry the stored bytes", (t) => {
    const { storage, plan, blobs, dispose } = build();
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

    const view = showNode({ storage, plan, blobs }, { id: fixtureIds.task });

    assert.ok(view);
    assert.match(view.instructionBlob, blobHashPattern);
    assert.match(view.acceptanceBlob ?? "", blobHashPattern);
    assert.equal(view.instruction, marker);
    assert.equal(view.acceptance, "\u0000");
  });

  it("dependencies are populated from the edge table when the node has a real edge", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, ?)",
        ["edge_show", fixtureIds.task, fixtureIds.objective, null],
      );
    });

    const view = showNode({ storage, plan, blobs }, { id: fixtureIds.task });

    assert.ok(view);
    assert.deepEqual(view.dependencies, [fixtureIds.objective]);
  });

  it("Object.keys of the view bytewise sorted deep-equals the eighteen member names", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode({ storage, plan, blobs }, { id: fixtureIds.task });
    assert.ok(view);
    assert.deepEqual([...Object.keys(view)].sort(), eighteenMemberNames);
  });

  it("nodeShowResponse.safeParse succeeds", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const view = showNode({ storage, plan, blobs }, { id: fixtureIds.task });
    assert.ok(view);
    assert.equal(nodeShowResponse.safeParse(view).success, true);
  });
});
