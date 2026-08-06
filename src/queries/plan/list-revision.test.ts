import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listRevisions } from "./list-revision.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import {
  createBlobStore,
  createPlanStore,
} from "../../../test/helpers/plan.ts";

const blobHashPattern = /^sha256:[0-9a-f]{64}$/;

describe("src/queries/plan/list-revision.test", () => {
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

  it("returns two revisions newest first with the parent id chain", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      plan.insertRevision(transaction, {
        id: "revision_b",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        importId: "imp_b",
        submittedBlob: fixtureIds.instructionBlob,
        choicesBlob: fixtureIds.instructionBlob,
        acceptedBlob: fixtureIds.instructionBlob,
      });
    });

    const revisions = listRevisions(
      { storage, plan },
      { projectId: fixtureIds.project },
    );

    assert.equal(revisions.length, 2);
    assert.equal(revisions[0]?.id, "revision_b");
    assert.equal(revisions[0]?.parentId, fixtureIds.planRevision);
    assert.equal(revisions[1]?.id, fixtureIds.planRevision);
    assert.equal(revisions[1]?.parentId, null);
  });

  it("every hash member matches the sha256 blob pattern", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const revisions = listRevisions(
      { storage, plan },
      { projectId: fixtureIds.project },
    );
    assert.ok(revisions.length > 0);
    for (const revision of revisions) {
      for (const hash of [
        revision.submittedBlob,
        revision.choicesBlob,
        revision.acceptedBlob,
      ]) {
        assert.match(hash, blobHashPattern);
      }
    }
  });

  it("no member carries the blob content", (t) => {
    const { storage, plan, blobs, dispose } = build();
    t.after(() => dispose());
    const marker = "SENSITIVE-BLOB-BYTES";
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
      const hash = blobs.put(transaction, new TextEncoder().encode(marker));
      plan.insertRevision(transaction, {
        id: "revision_b",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        importId: "imp_b",
        submittedBlob: hash,
        choicesBlob: hash,
        acceptedBlob: hash,
      });
    });

    const json = JSON.stringify(
      listRevisions({ storage, plan }, { projectId: fixtureIds.project }),
    );
    assert.equal(json.includes(marker), false);
  });

  it("returns an empty list for a project with no revision", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) =>
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "second-project", "general@1", null, 1],
      ),
    );

    const revisions = listRevisions(
      { storage, plan },
      { projectId: "project_b" },
    );
    assert.deepEqual(revisions, []);
  });

  it("throws project-not-found for an unknown project", (t) => {
    const { storage, plan, dispose } = build();
    t.after(() => dispose());
    storage.transact(seedRegistry);

    assert.throws(
      () => listRevisions({ storage, plan }, { projectId: "project_nope" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { refusal?: string }).refusal === "project-not-found",
    );
  });
});
