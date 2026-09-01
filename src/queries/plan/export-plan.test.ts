import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { importPlan } from "../../commands/plan/import-plan.ts";
import { exportPlan } from "./export-plan.ts";
import { validatePlan } from "./validate-plan.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds } from "../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanReader,
  createPlanStore,
  createRevision,
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import type { EventLog, RecordedEvent } from "../../services/event/index.ts";

const lower = (identity: string): string =>
  identity.slice(identity.indexOf("_") + 1).toLowerCase();

const expectedPaths = {
  task: `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/harden-the-verify-cli--${lower(planFixtureIdentities.objective)}/01-harden-the-verify-cli--${lower(planFixtureIdentities.task)}.md`,
  objective: `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/harden-the-verify-cli--${lower(planFixtureIdentities.objective)}/objective.md`,
  initiative: `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/initiative.md`,
};

const expectedDocuments = [
  {
    path: expectedPaths.task,
    content: `---
id: "${planFixtureIdentities.task}"
kind: "task"
title: "Harden the verify CLI"
---
Do the task work.
## Acceptance criteria
- it works
`,
  },
  {
    path: expectedPaths.objective,
    content: `---
id: "${planFixtureIdentities.objective}"
kind: "objective"
title: "Harden the verify CLI"
repo: "kanthord-verify"
---
Do the objective work.
`,
  },
  {
    path: expectedPaths.initiative,
    content: `---
id: "${planFixtureIdentities.initiative}"
kind: "initiative"
title: "Harden the verify CLI"
---
Do the initiative work.
`,
  },
];

const encoder = new TextEncoder();

function createEventLog(): EventLog {
  return {
    append(_transaction, input): RecordedEvent {
      return { id: "event_test", ...input, occurredAt: 0 };
    },
    list(): readonly RecordedEvent[] {
      return [];
    },
  };
}

function importSubmittedTask(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
  document: Readonly<{ path: string; content: string }>,
  importId: string,
  revisionUlid: string,
): void {
  const documentsHash = validatePlan(
    {
      storage,
      plan,
      blobs,
      reader: createPlanReader(),
      graph: createPlanGraph(),
      ids: createMockIdGenerator({ ulids: [] }),
    },
    {
      projectId: fixtureIds.project,
      fromRevision: fixtureIds.planRevision,
      documents: [document],
    },
  ).documentsHash;

  importPlan(
    {
      storage,
      plan,
      blobs,
      reader: createPlanReader(),
      graph: createPlanGraph(),
      ids: createMockIdGenerator({ ulids: [revisionUlid] }),
      clock: createMockClock({ start: 1700000000000, step: 1000 }),
      events: createEventLog(),
    },
    {
      projectId: fixtureIds.project,
      fromRevision: fixtureIds.planRevision,
      importId,
      documents: [document],
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "submitted" },
      ],
      validatedRevision: fixtureIds.planRevision,
      documentsHash,
      actor: "human_1",
    },
  );
}

describe("src/queries/plan/export-plan.test", () => {
  function build(): {
    storage: Storage;
    plan: PlanStore;
    blobs: BlobStore;
    revision: Revision;
    path: string;
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
      path: temporary.path,
      dispose: temporary.dispose,
    };
  }

  it("exports three documents at canonical paths with the newest revision", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );

    assert.equal(result.revision, fixtureIds.planRevision);
    assert.deepEqual(result.documents, expectedDocuments);
  });

  it("a new-shape plan exports byte-identical to the submitted document", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const submitted = {
      path: expectedPaths.task,
      content: expectedDocuments[0]!.content.replace(
        'title: "Harden the verify CLI"\n',
        'title: "Harden the verify CLI"\ndeliverable: "implementation"\nverify:\n  paths:\n    - "/src/bar.ts"\n  commands:\n    - "node --test src/bar.test.ts"\n',
      ),
    };
    importSubmittedTask(
      storage,
      plan,
      blobs,
      submitted,
      "imp_new_shape_export",
      "01MRZ3NDEKTSV4RRFFQ69G5FAV",
    );

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    const exported = result.documents.find(
      (document) => document.path === submitted.path,
    );
    assert.ok(exported);
    assert.equal(exported.content, submitted.content);
  });

  it("a legacy plan still exports byte-identically after dual-read", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const submitted = {
      path: expectedPaths.task,
      content: expectedDocuments[0]!.content.replace(
        'title: "Harden the verify CLI"\n',
        'title: "Harden the verify CLI"\nworker: "claude.swe@1"\n',
      ),
    };
    importSubmittedTask(
      storage,
      plan,
      blobs,
      submitted,
      "imp_legacy_export",
      "01MRZ3NDEKTSV4RRFFQ69G5FAW",
    );

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    const exported = result.documents.find(
      (document) => document.path === submitted.path,
    );
    assert.ok(exported);
    assert.equal(exported.content, submitted.content);
  });

  it("preserves worker claude.swe@1 in the exported task document byte-identically", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    storage.transact((transaction) =>
      transaction.run("UPDATE node SET worker = ? WHERE id = ?", [
        "claude.swe@1",
        planFixtureIdentities.task,
      ]),
    );

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );

    assert.deepEqual(result.documents[0], {
      path: expectedPaths.task,
      content: `---\nid: ${JSON.stringify(planFixtureIdentities.task)}\nkind: "task"\ntitle: "Harden the verify CLI"\nworker: "claude.swe@1"\n---\nDo the task work.\n## Acceptance criteria\n- it works\n`,
    });
  });

  it("keeps the acceptance heading on the task and off the objective and the initiative", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );

    const byPath = new Map(result.documents.map((d) => [d.path, d.content]));
    assert.equal(
      byPath.get(expectedPaths.task)?.includes("## Acceptance criteria"),
      true,
    );
    assert.equal(
      byPath.get(expectedPaths.objective)?.includes("## Acceptance criteria"),
      false,
    );
    assert.equal(
      byPath.get(expectedPaths.initiative)?.includes("## Acceptance criteria"),
      false,
    );
  });

  it("renders repo on the objective and not on the task or the initiative", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );

    const byPath = new Map(result.documents.map((d) => [d.path, d.content]));
    assert.equal(
      byPath.get(expectedPaths.objective)?.includes('repo: "kanthord-verify"'),
      true,
    );
    assert.equal(byPath.get(expectedPaths.task)?.includes("repo:"), false);
    assert.equal(
      byPath.get(expectedPaths.initiative)?.includes("repo:"),
      false,
    );
  });

  it("carries no status, block reason or discard reason, and a state change does not move the bytes", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const before = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    for (const document of before.documents) {
      for (const token of [
        "state",
        "block_reason",
        "blockReason",
        "discard_reason",
        "discardReason",
      ]) {
        assert.equal(
          document.content.includes(token),
          false,
          `${token} in ${document.path}`,
        );
      }
    }

    storage.transact((transaction) =>
      transaction.run(
        "UPDATE node SET state = 'blocked', block_reason = 'attempt-limit', discard_reason = 'left behind' WHERE id = ?",
        [planFixtureIdentities.task],
      ),
    );

    const after = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    assert.deepEqual(after.documents, before.documents);
  });

  it("is deterministic across two calls", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const first = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    const second = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    assert.deepEqual(second, first);
  });

  it("reports the newest revision when a second revision row exists", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    storage.transact((transaction) =>
      plan.insertRevision(transaction, {
        id: "revision_b",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        origin: "import",
        importId: "imp_b",
        submittedBlob: fixtureIds.instructionBlob,
        choicesBlob: fixtureIds.instructionBlob,
        acceptedBlob: fixtureIds.instructionBlob,
      }),
    );

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    assert.equal(result.revision, "revision_b");
  });

  it("exports revision null and an empty document set for a project with no revision", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) =>
      transaction.run(
        "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
        ["project_b", "second-project", "general@1", null, 1],
      ),
    );

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: "project_b" },
    );
    assert.deepEqual(result, { revision: null, documents: [] });
  });

  it("throws naming the hash when a node cites a blob the store does not hold", (t) => {
    const { storage, plan, blobs, revision, path, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    const missing = `sha256:${"f".repeat(64)}`;
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw
      .prepare("UPDATE node SET instruction_blob = ? WHERE id = ?")
      .run(missing, planFixtureIdentities.task);
    raw.close();

    assert.throws(
      () =>
        exportPlan(
          { storage, plan, revision },
          { projectId: fixtureIds.project },
        ),
      (error: unknown) => String(error).includes(missing),
    );
  });

  it("exports trailing spaces on the last line byte for byte", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    storage.transact((transaction) => {
      const instruction = blobs.put(
        transaction,
        new TextEncoder().encode("alpha\nbeta  "),
      );
      const acceptance = blobs.put(transaction, new TextEncoder().encode("\n"));
      transaction.run(
        "UPDATE node SET instruction_blob = ?, acceptance_blob = ? WHERE id = ?",
        [instruction, acceptance, planFixtureIdentities.task],
      );
    });

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    const task = result.documents.find(
      (document) => document.path === expectedPaths.task,
    );
    assert.ok(task !== undefined);
    assert.equal(task.content.endsWith("beta  \n"), true);
  });

  it("exports a store-waived edge as a depends_on entry and re-orders the task ordinal", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    storage.transact((transaction) => {
      plan.mutateGraph(transaction, {
        projectId: fixtureIds.project,
        nodes: [
          {
            id: planFixtureIdentities.taskTwo,
            projectId: fixtureIds.project,
            kind: "task",
            parentId: planFixtureIdentities.objective,
            title: "Harden the verify CLI",
            instructionBlob: blobs.put(
              transaction,
              new TextEncoder().encode("Do the second task work.\n"),
            ),
            acceptanceBlob: blobs.put(
              transaction,
              new TextEncoder().encode("\n"),
            ),
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
      transaction.run("UPDATE edge SET waived_at = 5 WHERE id = ?", [
        "edge_01ZZZ3NDEKTSV4RRFFQ69G5FAV",
      ]);
    });

    const result = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    const byPath = new Map(result.documents.map((d) => [d.path, d.content]));
    const taskPath = `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/harden-the-verify-cli--${lower(planFixtureIdentities.objective)}/02-harden-the-verify-cli--${lower(planFixtureIdentities.task)}.md`;
    const taskTwoPath = `plan/harden-the-verify-cli--${lower(planFixtureIdentities.initiative)}/harden-the-verify-cli--${lower(planFixtureIdentities.objective)}/01-harden-the-verify-cli--${lower(planFixtureIdentities.taskTwo)}.md`;
    assert.equal(byPath.has(taskPath), true);
    assert.equal(byPath.has(taskTwoPath), true);
    assert.equal(
      byPath
        .get(taskPath)
        ?.includes(`depends_on:\n  - "${planFixtureIdentities.taskTwo}"`),
      true,
    );
  });

  it("throws project-not-found for an unknown project", (t) => {
    const { storage, plan, blobs, revision, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    assert.throws(
      () =>
        exportPlan({ storage, plan, revision }, { projectId: "project_nope" }),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { refusal?: string }).refusal === "project-not-found",
    );
  });

  it("throws repository-unknown naming the id when a node's repository_id names no repository row", (t) => {
    const { storage, plan, blobs, revision, path, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = OFF");
    raw
      .prepare("UPDATE node SET repository_id = ? WHERE id = ?")
      .run("repo_ghost", planFixtureIdentities.objective);
    raw.close();

    assert.throws(
      () =>
        exportPlan(
          { storage, plan, revision },
          { projectId: fixtureIds.project },
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { refusal?: string }).refusal === "repository-unknown" &&
        String(error).includes("repo_ghost"),
    );
  });
});
