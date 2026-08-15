import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RevisionError } from "./index.ts";
import type { Revision } from "./index.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import {
  fixtureIds,
  seedGraph,
  seedRegistry,
} from "../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanStore,
  createRevision,
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";

const lower = (identity: string): string =>
  identity.slice(identity.indexOf("_") + 1).toLowerCase();

const expectedPaths = {
  task: `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/harden-the-verify-cli--${lower(planFixtureIdentities.objective)}/01-harden-the-verify-cli--${lower(planFixtureIdentities.task)}.md`,
  objective: `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/harden-the-verify-cli--${lower(planFixtureIdentities.objective)}/objective.md`,
  initiative: `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/initiative.md`,
};

const encoder = new TextEncoder();

const G1_GOLDEN = String.raw`[{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/01-harden-the-verify-cli--01drz3ndektsv4rrffq69g5fav.md","content":"---\nid: \"task_01DRZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"task\"\ntitle: \"Harden the verify CLI\"\n---\nDo the task work.\n## Acceptance criteria\n- it works\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/objective.md","content":"---\nid: \"objective_01BQZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"objective\"\ntitle: \"Harden the verify CLI\"\nrepo: \"kanthord-verify\"\n---\nDo the objective work.\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/initiative.md","content":"---\nid: \"initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"initiative\"\ntitle: \"Harden the verify CLI\"\n---\nDo the initiative work.\n"}]`;

const G2_GOLDEN = String.raw`[{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/01-harden-the-verify-cli--01drz3ndektsv4rrffq69g5fav.md","content":"---\nid: \"task_01DRZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"task\"\ntitle: \"Harden the verify CLI\"\nworker: \"tdd@1\"\n---\nDo the task work.\n## Acceptance criteria\n- it works\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/objective.md","content":"---\nid: \"objective_01BQZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"objective\"\ntitle: \"Harden the verify CLI\"\nrepo: \"kanthord-verify\"\n---\nDo the objective work.\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/initiative.md","content":"---\nid: \"initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"initiative\"\ntitle: \"Harden the verify CLI\"\n---\nDo the initiative work.\n"}]`;

const G3_GOLDEN = String.raw`[{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/01-harden-the-verify-cli--01erz3ndektsv4rrffq69g5fav.md","content":"---\nid: \"task_01ERZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"task\"\ntitle: \"Harden the verify CLI\"\n---\nDo the second task work.\n\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/02-harden-the-verify-cli--01drz3ndektsv4rrffq69g5fav.md","content":"---\nid: \"task_01DRZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"task\"\ntitle: \"Harden the verify CLI\"\ndepends_on:\n  - \"task_01ERZ3NDEKTSV4RRFFQ69G5FAV\"\n---\nDo the task work.\n## Acceptance criteria\n- it works\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/harden-the-verify-cli--01bqz3ndektsv4rrffq69g5fav/objective.md","content":"---\nid: \"objective_01BQZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"objective\"\ntitle: \"Harden the verify CLI\"\nrepo: \"kanthord-verify\"\n---\nDo the objective work.\n"},{"path":"plan/harden-the-verify-cli--01arz3ndektsv4rrffq69g5fav/initiative.md","content":"---\nid: \"initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV\"\nkind: \"initiative\"\ntitle: \"Harden the verify CLI\"\n---\nDo the initiative work.\n"}]`;

describe("src/services/revision/node-write.test", () => {
  function build(): {
    storage: Storage;
    plan: PlanStore;
    blobs: BlobStore;
    revision: Revision;
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
      revision: createRevision(blobs, plan),
      dispose: temporary.dispose,
    };
  }

  it("render translates a repository id to its name", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const { nodes } = storage.transact((transaction) =>
      plan.readGraph(transaction, fixtureIds.project),
    );
    const documents = storage.transact((transaction) =>
      revision.render(transaction, { nodes }),
    );

    const objective = documents.find((document) =>
      document.path.endsWith("/objective.md"),
    );
    assert.ok(objective !== undefined);
    assert.equal(objective.content.includes('repo: "kanthord-verify"'), true);
    assert.equal(objective.content.includes("repo_a"), false);
  });

  it("render throws repository-unknown for an unregistered repository", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const { nodes } = storage.transact((transaction) =>
      plan.readGraph(transaction, fixtureIds.project),
    );
    const edited: typeof nodes = nodes.map((node) =>
      node.id === planFixtureIdentities.objective
        ? { ...node, repositoryId: "repo_ghost" }
        : node,
    );

    assert.throws(
      () =>
        storage.transact((transaction) =>
          revision.render(transaction, { nodes: edited }),
        ),
      (error: unknown) =>
        error instanceof RevisionError &&
        error.refusal === "repository-unknown" &&
        error.message === "repository repo_ghost is not registered",
    );
  });

  it("render throws on a missing instruction blob", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const missing = `sha256:${"f".repeat(64)}`;
    const { nodes } = storage.transact((transaction) =>
      plan.readGraph(transaction, fixtureIds.project),
    );
    const edited: typeof nodes = nodes.map((node) =>
      node.id === planFixtureIdentities.task
        ? { ...node, instructionBlob: missing }
        : node,
    );

    assert.throws(
      () =>
        storage.transact((transaction) =>
          revision.render(transaction, { nodes: edited }),
        ),
      (error: unknown) =>
        error instanceof Error && String(error).includes(missing),
    );
  });

  it("render returns documents sorted by canonical path", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const { nodes } = storage.transact((transaction) =>
      plan.readGraph(transaction, fixtureIds.project),
    );
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const reversed = [
      byId.get(planFixtureIdentities.initiative),
      byId.get(planFixtureIdentities.objective),
      byId.get(planFixtureIdentities.task),
    ];
    assert.ok(
      reversed.every((node) => node !== undefined),
      "fixture node missing",
    );

    const documents = storage.transact((transaction) =>
      revision.render(transaction, {
        nodes: reversed as NonNullable<(typeof reversed)[number]>[],
      }),
    );

    assert.deepEqual(
      documents.map((document) => document.path),
      [expectedPaths.task, expectedPaths.objective, expectedPaths.initiative],
    );
  });

  it("render reproduces the pre-extraction export bytes", (t) => {
    const first = build();
    t.after(() => first.dispose());
    seedPlanFixture(first.storage, first.plan, first.blobs);
    const graphOne = first.storage.transact((transaction) =>
      first.plan.readGraph(transaction, fixtureIds.project),
    );
    const documentsOne = first.storage.transact((transaction) =>
      first.revision.render(transaction, { nodes: graphOne.nodes }),
    );
    assert.equal(
      Buffer.compare(
        Buffer.from(canonicalDocumentsJson(documentsOne)),
        Buffer.from(G1_GOLDEN),
      ),
      0,
      "base fixture diverges from the pre-extraction bytes",
    );

    const second = build();
    t.after(() => second.dispose());
    seedPlanFixture(second.storage, second.plan, second.blobs);
    second.storage.transact((transaction) => {
      second.plan.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: planFixtureIdentities.task,
            projectId: fixtureIds.project,
            kind: "task",
            parentId: planFixtureIdentities.objective,
            title: "Harden the verify CLI",
            instructionBlob: second.blobs.put(
              transaction,
              encoder.encode("Do the task work.\n"),
            ),
            acceptanceBlob: second.blobs.put(
              transaction,
              encoder.encode("## Acceptance criteria\n- it works\n"),
            ),
            worker: "tdd@1",
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
    const graphTwo = second.storage.transact((transaction) =>
      second.plan.readGraph(transaction, fixtureIds.project),
    );
    const documentsTwo = second.storage.transact((transaction) =>
      second.revision.render(transaction, { nodes: graphTwo.nodes }),
    );
    assert.equal(
      Buffer.compare(
        Buffer.from(canonicalDocumentsJson(documentsTwo)),
        Buffer.from(G2_GOLDEN),
      ),
      0,
      "worker fixture diverges from the pre-extraction bytes",
    );

    const third = build();
    t.after(() => third.dispose());
    seedPlanFixture(third.storage, third.plan, third.blobs);
    third.storage.transact((transaction) => {
      third.plan.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: planFixtureIdentities.taskTwo,
            projectId: fixtureIds.project,
            kind: "task",
            parentId: planFixtureIdentities.objective,
            title: "Harden the verify CLI",
            instructionBlob: third.blobs.put(
              transaction,
              encoder.encode("Do the second task work.\n"),
            ),
            acceptanceBlob: third.blobs.put(transaction, encoder.encode("\n")),
            worker: null,
            repositoryId: null,
            revision: fixtureIds.planRevision,
            updatedAt: 1,
          },
        ],
        insertEdges: [
          {
            id: "edge_01ZZZ3NDEKTSV4RRFFQ69G5FAV",
            fromNode: planFixtureIdentities.task,
            toNode: planFixtureIdentities.taskTwo,
          },
        ],
        deleteEdgeIds: [],
        nodeDeletes: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });
    const graphThree = third.storage.transact((transaction) =>
      third.plan.readGraph(transaction, fixtureIds.project),
    );
    const documentsThree = third.storage.transact((transaction) =>
      third.revision.render(transaction, { nodes: graphThree.nodes }),
    );
    assert.equal(
      Buffer.compare(
        Buffer.from(canonicalDocumentsJson(documentsThree)),
        Buffer.from(G3_GOLDEN),
      ),
      0,
      "dependencies fixture diverges from the pre-extraction bytes",
    );
  });

  it("record writes one node-write revision and one blob", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));

    const documents: readonly RenderedDocument[] = [
      { path: "plan/demo.md", content: "hello\n" },
    ];
    const revisionId = "revision_w1";
    storage.transact((transaction) =>
      revision.record(transaction, {
        projectId: fixtureIds.project,
        revisionId,
        parentRevision: null,
        documents,
      }),
    );

    const row = storage.transact((transaction) =>
      plan
        .listRevisions(transaction, fixtureIds.project)
        .find((entry) => entry.id === revisionId),
    );
    assert.ok(row !== undefined);
    assert.equal(row.origin, "node-write");
    assert.equal(row.importId, null);
    assert.equal(row.submittedBlob, null);
    assert.equal(row.choicesBlob, null);
    assert.ok(row.acceptedBlob.length > 0);
    const blob = storage.transact((transaction) =>
      blobs.get(row.acceptedBlob, transaction),
    );
    assert.ok(blob !== null);
    assert.equal(
      Buffer.compare(
        Buffer.from(new TextDecoder().decode(blob.content)),
        Buffer.from(canonicalDocumentsJson(documents)),
      ),
      0,
    );
  });

  it("record writes the given parent", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => {
      seedRegistry(transaction);
      seedGraph(transaction);
    });

    const nullParentId = "revision_w2";
    const namedParentId = "revision_w3";
    storage.transact((transaction) =>
      revision.record(transaction, {
        projectId: fixtureIds.project,
        revisionId: nullParentId,
        parentRevision: null,
        documents: [],
      }),
    );
    storage.transact((transaction) =>
      revision.record(transaction, {
        projectId: fixtureIds.project,
        revisionId: namedParentId,
        parentRevision: fixtureIds.planRevision,
        documents: [],
      }),
    );

    const rows = storage.transact((transaction) =>
      plan.listRevisions(transaction, fixtureIds.project),
    );
    assert.equal(
      rows.find((entry) => entry.id === nullParentId)?.parentId,
      null,
    );
    assert.equal(
      rows.find((entry) => entry.id === namedParentId)?.parentId,
      fixtureIds.planRevision,
    );
  });

  it("record reads no graph", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const documents: readonly RenderedDocument[] = [
      { path: "plan/ghost.md", content: "no stored node names this path\n" },
    ];
    const revisionId = "revision_w4";
    storage.transact((transaction) =>
      revision.record(transaction, {
        projectId: fixtureIds.project,
        revisionId,
        parentRevision: null,
        documents,
      }),
    );

    const row = storage.transact((transaction) =>
      plan
        .listRevisions(transaction, fixtureIds.project)
        .find((entry) => entry.id === revisionId),
    );
    assert.ok(row !== undefined);
    const blob = storage.transact((transaction) =>
      blobs.get(row.acceptedBlob, transaction),
    );
    assert.ok(blob !== null);
    assert.equal(
      Buffer.compare(
        Buffer.from(new TextDecoder().decode(blob.content)),
        Buffer.from(canonicalDocumentsJson(documents)),
      ),
      0,
      "the stored blob holds the input documents, not a render of the graph",
    );
  });

  it("src/services/revision/index.ts contains no occurrence of implements ", () => {
    const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
    const content = readFileSync(indexPath, "utf8");
    assert.equal(content.includes("implements "), false);
  });
});
