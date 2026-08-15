import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { validatePlan } from "./validate-plan.ts";
import { exportPlan } from "./export-plan.ts";
import {
  buildCandidate,
  validateCandidate,
} from "../../domain/plan-candidate.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import { validateDocuments } from "../../domain/plan-validate.ts";
import {
  createBlobStore,
  createPlanReader,
  createPlanStore,
} from "../../../test/helpers/plan.ts";
import { createPlanGraph } from "../../../test/helpers/plan.ts";
import {
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { DocumentReader } from "../../services/document/index.ts";
import type { Graph } from "../../services/graph/index.ts";

const U_INITIATIVE = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const U_TASK = "01BQZ3NDEKTSV4RRFFQ69G5FAV";
const U_OBJECTIVE = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const U_NEW = "01EZQZ3NDEKTSV4RRFFQ69G5FA";

const low = (ulid: string): string => ulid.toLowerCase();

const initiativePath = `plan/ship-kanthord--${low(U_INITIATIVE)}/initiative.md`;
const objectivePath = `plan/ship-kanthord--${low(U_INITIATIVE)}/harden-the-verify-cli--${low(U_OBJECTIVE)}/objective.md`;
const taskPath = `plan/ship-kanthord--${low(U_INITIATIVE)}/harden-the-verify-cli--${low(U_OBJECTIVE)}/01-render-the-manifest--${low(U_TASK)}.md`;

const initiativeDocument = {
  path: "plan/i--01/initiative.md",
  content: `---
kind: initiative
title: Ship kanthord
---
Bootstrap the daemon.
`,
};

const objectiveDocument = {
  path: "plan/i--01/o--01/objective.md",
  content: `---
kind: objective
title: Harden the verify CLI
repo: kanthord-verify
---
Make it verifiable.
`,
};

const taskDocument = {
  path: "plan/i--01/o--01/01-t.md",
  content: `---
kind: task
title: Render the manifest
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
};

const validSubmission = [initiativeDocument, objectiveDocument, taskDocument];

const threeFaultsSubmission = [
  initiativeDocument,
  objectiveDocument,
  {
    path: "plan/i--01/o--01/01-t.md",
    content: `---
kind: task
title: A task
repo: kanthord-verify
depends_on:
  - 01-t.md
---
No acceptance here.
`,
  },
];

const expectedDocuments = [
  {
    path: taskPath,
    content: `---
id: "task_${U_TASK}"
kind: "task"
title: "Render the manifest"
worker: "tdd@1"
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: objectivePath,
    content: `---
id: "objective_${U_OBJECTIVE}"
kind: "objective"
title: "Harden the verify CLI"
repo: "kanthord-verify"
---
Make it verifiable.
`,
  },
  {
    path: initiativePath,
    content: `---
id: "initiative_${U_INITIATIVE}"
kind: "initiative"
title: "Ship kanthord"
---
Bootstrap the daemon.
`,
  },
];

const expectedChoices = [
  {
    id: `initiative_${U_INITIATIVE}`,
    kind: "initiative",
    presence: "document-only",
    state: null,
    suggested: "submitted",
    fields: [],
    submitted: { legal: true, reason: null },
    database: { legal: true, reason: "do not create it" },
  },
  {
    id: `objective_${U_OBJECTIVE}`,
    kind: "objective",
    presence: "document-only",
    state: null,
    suggested: "submitted",
    fields: [],
    submitted: { legal: true, reason: null },
    database: { legal: true, reason: "do not create it" },
  },
  {
    id: `task_${U_TASK}`,
    kind: "task",
    presence: "document-only",
    state: null,
    suggested: "submitted",
    fields: [],
    submitted: { legal: true, reason: null },
    database: { legal: true, reason: "do not create it" },
  },
];

function build(): {
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  reader: DocumentReader;
  graph: Graph;
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
    reader: createPlanReader(),
    graph: createPlanGraph(),
    path: temporary.path,
    dispose: temporary.dispose,
  };
}

function countTable(storage: Storage, table: string): number {
  return (
    storage.transact((transaction) =>
      transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
    ) as { c: number }
  ).c;
}

describe("src/queries/plan/validate-plan.test", () => {
  it("a first validation of a valid plan on an empty project suggests submitted for every document", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));

    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({
          ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
        }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: null,
        documents: validSubmission,
      },
    );

    assert.deepEqual(result.findings, []);
    assert.equal(result.revision, null);
    assert.deepEqual(result.documents, expectedDocuments);
    assert.deepEqual(result.choices, expectedChoices);
    assert.equal(
      result.documentsHash,
      `sha256:${createHash("sha256")
        .update(JSON.stringify(expectedDocuments))
        .digest("hex")}`,
    );
  });

  it("the choice set is bytewise ascending and its size equals the union size", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));

    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({
          ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
        }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: null,
        documents: validSubmission,
      },
    );

    const ids = result.choices.map((entry) => entry.id);
    const sorted = [...ids].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    );
    assert.deepEqual(ids, sorted);
    assert.equal(new Set(ids).size, result.choices.length);
  });

  it("nothing is written for a valid plan and for an invalid one", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));
    const tables = [
      "project",
      "node",
      "edge",
      "plan_revision",
      "blob",
      "event",
    ];
    const before = new Map(
      tables.map((table) => [table, countTable(storage, table)]),
    );

    const dependencies = {
      storage,
      plan,
      blobs,
      reader,
      graph,
      ids: createMockIdGenerator({
        ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
      }),
    };
    validatePlan(dependencies, {
      projectId: fixtureIds.project,
      fromRevision: null,
      documents: validSubmission,
    });
    validatePlan(
      {
        ...dependencies,
        ids: createMockIdGenerator({
          ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
        }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: null,
        documents: threeFaultsSubmission,
      },
    );

    for (const table of tables) {
      assert.equal(
        countTable(storage, table),
        before.get(table),
        `${table} changed`,
      );
    }
  });

  it("a re-import of the exported documents suggests database everywhere", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: exported.revision,
        documents: exported.documents,
      },
    );

    assert.deepEqual(result.findings, []);
    assert.equal(result.revision, fixtureIds.planRevision);
    assert.equal(result.choices.length, 3);
    for (const entry of result.choices) {
      assert.deepEqual(entry.fields, [], entry.id);
      assert.equal(entry.suggested, "database", entry.id);
    }
  });

  it("a prose edit to the pending task suggests submitted with fields body", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const edited = exported.documents.map((document) =>
      document.content.includes("Do the task work.")
        ? {
            ...document,
            content: document.content.replace(
              "Do the task work.",
              "Do the task work now.",
            ),
          }
        : document,
    );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      { projectId: fixtureIds.project, fromRevision: null, documents: edited },
    );

    const taskEntry = result.choices.find(
      (entry) => entry.id === planFixtureIdentities.task,
    );
    assert.ok(taskEntry);
    assert.equal(taskEntry.presence, "both");
    assert.deepEqual(taskEntry.fields, ["body"]);
    assert.equal(taskEntry.suggested, "submitted");
    assert.equal(taskEntry.submitted.legal, true);
    for (const entry of result.choices) {
      if (entry.id !== planFixtureIdentities.task) {
        assert.deepEqual(entry.fields, [], entry.id);
        assert.equal(entry.suggested, "database", entry.id);
      }
    }
  });

  it("a structural edit to a node moved to running suggests database as illegal", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    storage.transact((transaction) =>
      transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
        planFixtureIdentities.task,
      ]),
    );

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const edited = exported.documents.map((document) =>
      document.content.includes("Do the task work.")
        ? {
            ...document,
            content: document.content.replace(
              'title: "Harden the verify CLI"',
              'title: "Harden the verify CLI"\nworker: "tdd@1"',
            ),
          }
        : document,
    );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      { projectId: fixtureIds.project, fromRevision: null, documents: edited },
    );

    const taskEntry = result.choices.find(
      (entry) => entry.id === planFixtureIdentities.task,
    );
    assert.ok(taskEntry);
    assert.deepEqual(taskEntry.fields, ["worker"]);
    assert.equal(taskEntry.state, "running");
    assert.equal(taskEntry.suggested, "database");
    assert.equal(taskEntry.submitted.legal, false);
  });

  it("a database-only node appears in the choice set", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const withoutTask = exported.documents.filter(
      (document) => !document.content.includes("Do the task work."),
    );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: null,
        documents: withoutTask,
      },
    );

    const taskEntry = result.choices.find(
      (entry) => entry.id === planFixtureIdentities.task,
    );
    assert.ok(taskEntry);
    assert.equal(taskEntry.presence, "database-only");
    assert.equal(taskEntry.suggested, "database");
    assert.equal(taskEntry.submitted.legal, false);
    assert.deepEqual(taskEntry.fields, []);
  });

  it("a kind change is an addition and a retention", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const newObjective = {
      path: `plan/harden-the-verify-cli--${low(planFixtureIdentities.initiative)}/new-objective--${low(U_NEW)}/objective.md`,
      content: `---
kind: objective
title: New objective
repo: kanthord-verify
---
New objective work.
`,
    };
    const documents = [...exported.documents, newObjective].filter(
      (document) => !document.content.includes("Do the task work."),
    );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [U_NEW] }),
      },
      { projectId: fixtureIds.project, fromRevision: null, documents },
    );

    assert.equal(result.choices.length, 4);
    const added = result.choices.find(
      (entry) => entry.id === `objective_${U_NEW}`,
    );
    assert.ok(added);
    assert.equal(added.presence, "document-only");
    assert.equal(added.kind, "objective");
    // Story 09 repair: the new objective has no task child, so the candidate
    // fails objective-without-task and the whole component resets to database.
    assert.equal(added.suggested, "database");
    const retained = result.choices.find(
      (entry) => entry.id === planFixtureIdentities.task,
    );
    assert.ok(retained);
    assert.equal(retained.presence, "database-only");
    assert.equal(retained.suggested, "database");
    assert.equal(retained.submitted.legal, false);
  });

  it("revision is the greatest plan_revision id when two revisions exist", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    seedPlanFixture(storage, plan, blobs);
    storage.transact((transaction) =>
      plan.insertRevision(transaction, {
        id: "revision_b",
        projectId: fixtureIds.project,
        parentId: fixtureIds.planRevision,
        importId: "imp_b",
        submittedBlob: fixtureIds.instructionBlob,
        choicesBlob: fixtureIds.instructionBlob,
        acceptedBlob: fixtureIds.instructionBlob,
      }),
    );

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: exported.revision,
        documents: exported.documents,
      },
    );

    assert.equal(result.revision, "revision_b");
  });

  it("an unknown project throws project-not-found", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));

    assert.throws(
      () =>
        validatePlan(
          {
            storage,
            plan,
            blobs,
            reader,
            graph,
            ids: createMockIdGenerator({ ulids: [] }),
          },
          {
            projectId: "project_nope",
            fromRevision: null,
            documents: validSubmission,
          },
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { refusal?: string }).refusal === "project-not-found",
    );
  });

  it("throws repository-unknown naming the id when a node's repository_id names no repository row", (t) => {
    const { storage, plan, blobs, reader, graph, path, dispose } = build();
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
        validatePlan(
          {
            storage,
            plan,
            blobs,
            reader,
            graph,
            ids: createMockIdGenerator({ ulids: [] }),
          },
          { projectId: fixtureIds.project, fromRevision: null, documents: [] },
        ),
      (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        (error as { refusal?: string }).refusal === "repository-unknown" &&
        String(error).includes("repo_ghost"),
    );
  });

  it("the whole query is deterministic across two runs with a fresh mock", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));

    const dependencies = { storage, plan, blobs, reader, graph };
    const input = {
      projectId: fixtureIds.project,
      fromRevision: null,
      documents: validSubmission,
    };
    const first = validatePlan(
      {
        ...dependencies,
        ids: createMockIdGenerator({
          ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
        }),
      },
      input,
    );
    const second = validatePlan(
      {
        ...dependencies,
        ids: createMockIdGenerator({
          ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
        }),
      },
      input,
    );

    assert.deepEqual(second, first);
  });

  it("documentsHash is the sha256 of the canonical documents json", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
    t.after(() => dispose());
    storage.transact((transaction) => seedRegistry(transaction));

    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({
          ulids: [U_INITIATIVE, U_TASK, U_OBJECTIVE],
        }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: null,
        documents: validSubmission,
      },
    );

    assert.equal(
      result.documentsHash,
      blobs.hash(
        new TextEncoder().encode(canonicalDocumentsJson(result.documents)),
      ),
    );
  });

  it("the normative cycle through the route returns a repaired set, not the local combination", (t) => {
    const { storage, plan, blobs, reader, graph, dispose } = build();
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
              new TextEncoder().encode("## Acceptance criteria\n- it works\n"),
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
            fromNode: planFixtureIdentities.taskTwo,
            toNode: planFixtureIdentities.task,
          },
        ],
        deleteEdgeIds: [],
        at: 1,
        cause: { revision: fixtureIds.planRevision, importId: null },
      });
    });

    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    );
    const edited = exported.documents
      .filter(
        (document) => !document.content.includes("Do the second task work."),
      )
      .map((document) =>
        document.content.includes("Do the task work.")
          ? {
              ...document,
              content: document.content.replace(
                "---\n",
                `---\ndepends_on:\n  - "${planFixtureIdentities.taskTwo}"\n`,
              ),
            }
          : document,
      );
    const result = validatePlan(
      {
        storage,
        plan,
        blobs,
        reader,
        graph,
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: exported.revision,
        documents: edited,
      },
    );

    assert.deepEqual(result.findings, []);
    const taskEntry = result.choices.find(
      (entry) => entry.id === planFixtureIdentities.task,
    );
    const taskTwoEntry = result.choices.find(
      (entry) => entry.id === planFixtureIdentities.taskTwo,
    );
    assert.ok(taskEntry);
    assert.ok(taskTwoEntry);
    assert.notDeepEqual(
      [taskEntry.suggested, taskTwoEntry.suggested],
      ["submitted", "database"],
    );
    for (const entry of result.choices) {
      assert.equal(entry.suggested, "database", entry.id);
    }

    const context = storage.transact((transaction) =>
      plan.readValidationContext(transaction, fixtureIds.project),
    );
    const repositoryNamesById = new Map(
      (
        storage.transact((transaction) =>
          transaction.all("SELECT id, name FROM repository"),
        ) as readonly { id: string; name: string }[]
      ).map((row) => [row.id, row.name]),
    );
    const stored = storage
      .transact((transaction) =>
        plan.readGraph(transaction, fixtureIds.project),
      )
      .nodes.map((node) =>
        node.repositoryId === null
          ? node
          : {
              ...node,
              repositoryId:
                repositoryNamesById.get(node.repositoryId) ?? node.repositoryId,
            },
      );
    const validation = validateDocuments(
      {
        readFrontmatter: (text) => reader.read(text),
        findCycles: (graphInput) => graph.cycles(graphInput),
        mint: () => {
          throw new Error("no mint expected");
        },
      },
      {
        submitted: edited,
        context,
        databaseIdentities: stored.map((node) => node.id),
        databasePaths: new Map<string, string>(),
      },
    );
    assert.deepEqual(validation.findings, []);
    const encoder = new TextEncoder();
    const blobHashes = new Map(
      validation.documents.map((document) => [
        document.identity,
        {
          instruction: blobs.hash(encoder.encode(document.instruction)),
          acceptance:
            document.acceptance === null
              ? null
              : blobs.hash(encoder.encode(document.acceptance)),
        },
      ]),
    );
    const choices = result.choices.map((entry) => ({
      id: entry.id,
      take: entry.suggested,
    }));
    const candidate = buildCandidate({
      submitted: validation.documents,
      stored,
      choices,
      blobHashes,
    });
    assert.deepEqual(
      validateCandidate(
        { findCycles: (graphInput) => graph.cycles(graphInput) },
        { candidate, context },
      ),
      [],
    );
  });
});
