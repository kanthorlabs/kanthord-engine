import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { fixtureIds, seedRegistry } from "../../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanReader,
  createPlanStore,
  createRevision,
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../../test/helpers/plan.ts";
import { createPlanGraph } from "../../../../test/helpers/plan.ts";
import { validatePlanHandler } from "./validate-plan.ts";
import { validatePlan } from "../../../queries/plan/validate-plan.ts";
import { exportPlan } from "../../../queries/plan/export-plan.ts";
import { planValidateResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";

const ULIDS = [
  "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  "01BQZ3NDEKTSV4RRFFQ69G5FAV",
  "01DRZ3NDEKTSV4RRFFQ69G5FAV",
  "01EZQZ3NDEKTSV4RRFFQ69G5FA",
  "01FQZ3NDEKTSV4RRFFQ69G5FAV",
  "01GQZ3NDEKTSV4RRFFQ69G5FAV",
];

const daemonHome = "/var/lib/kanthord";

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

const validBody = {
  fromRevision: null,
  documents: [initiativeDocument, objectiveDocument, taskDocument],
};

const threeFaultsTaskDocument = {
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
};

const threeFaultsBody = {
  fromRevision: null,
  documents: [initiativeDocument, objectiveDocument, threeFaultsTaskDocument],
};

function countTable(storage: Storage, table: string): number {
  return (
    storage.transact((transaction) =>
      transaction.get(`SELECT COUNT(*) AS c FROM ${table}`),
    ) as { c: number }
  ).c;
}

function editedFixtureSet(
  documents: readonly Readonly<{ path: string; content: string }>[],
): (
  | Readonly<{ path: string; content: string }>
  | {
      path: string;
      content: string;
    }
)[] {
  return [
    ...documents
      .filter(
        (document) => !document.content.includes("Do the objective work."),
      )
      .map((document) =>
        document.content.includes("Do the task work.")
          ? {
              ...document,
              content: document.content.replace(
                'title: "Harden the verify CLI"',
                'title: "Harden the verify CLI v2"',
              ),
            }
          : document,
      ),
    {
      path: "plan/new-initiative/initiative.md",
      content: `---
id: "initiative_01FQZ3NDEKTSV4RRFFQ69G5FAV"
kind: initiative
title: New initiative
---
New work.
`,
    },
  ];
}

describe("src/http/server/plan/validate-plan.test", () => {
  async function buildHandlerApp(
    options: Readonly<{ withPlanFixture?: boolean }> = {},
  ) {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    const blobs = createBlobStore(
      storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    const revision = createRevision(blobs, plan);
    const reader = createPlanReader();
    const graph = createPlanGraph();
    if (options.withPlanFixture === true) {
      seedPlanFixture(storage, plan, blobs);
    } else {
      storage.transact((transaction) => seedRegistry(transaction));
    }
    const app = await createTestApp({
      handlers: {
        "plan.validate": validatePlanHandler({
          validatePlan: (input) =>
            validatePlan(
              {
                storage,
                plan,
                blobs,
                reader,
                graph,
                ids: createMockIdGenerator({ ulids: ULIDS }),
              },
              input,
            ),
        }),
      },
    });
    return { temporary, app, storage, plan, blobs, revision };
  }

  it("POST /v1/project/:id/plan/validate with a valid body answers 200 and planValidateResponse parses it", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app
      .post(`/v1/project/${fixtureIds.project}/plan/validate`)
      .send(validBody);

    assert.equal(response.status, 200);
    assert.equal(planValidateResponse.safeParse(response.body).success, true);
    assert.deepEqual(response.body.findings, []);
    assert.equal(response.body.revision, null);
    assert.equal(response.body.choices.length, 3);
    assert.equal(
      JSON.stringify(response.body).includes(daemonHome),
      false,
      JSON.stringify(response.body),
    );
  });

  it("a body with an empty documents array answers 400", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app
      .post(`/v1/project/${fixtureIds.project}/plan/validate`)
      .send({ fromRevision: null, documents: [] });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a plan with three faults answers 200 with three findings", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app
      .post(`/v1/project/${fixtureIds.project}/plan/validate`)
      .send(threeFaultsBody);

    assert.equal(response.status, 200);
    assert.equal(planValidateResponse.safeParse(response.body).success, true);
    assert.equal(response.body.findings.length, 3);
  });

  it("on an unknown project answers 404", async (t) => {
    const { temporary, app } = await buildHandlerApp();
    t.after(() => temporary.dispose());

    const response = await app
      .post("/v1/project/project_nope/plan/validate")
      .send(validBody);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("a validate over an edited fixture set answers all three presences with values and joinable paths", async (t) => {
    const { temporary, app, storage, plan, blobs, revision } =
      await buildHandlerApp({ withPlanFixture: true });
    t.after(() => temporary.dispose());

    const exported = exportPlan(
      { storage, plan, revision },
      { projectId: fixtureIds.project },
    );
    const response = await app
      .post(`/v1/project/${fixtureIds.project}/plan/validate`)
      .send({
        fromRevision: null,
        documents: editedFixtureSet(exported.documents),
      });

    assert.equal(response.status, 200);
    assert.equal(planValidateResponse.safeParse(response.body).success, true);
    const body = planValidateResponse.parse(response.body);
    const counts = { both: 0, "document-only": 0, "database-only": 0 };
    for (const entry of body.choices) counts[entry.presence] += 1;
    assert.deepEqual(counts, {
      both: 2,
      "document-only": 1,
      "database-only": 1,
    });

    const taskEntry = body.choices.find(
      (entry) => entry.id === planFixtureIdentities.task,
    );
    assert.ok(taskEntry);
    assert.deepEqual(taskEntry.fields, ["title"]);
    assert.deepEqual(taskEntry.submitted.values, {
      title: "Harden the verify CLI v2",
    });
    assert.deepEqual(taskEntry.database.values, {
      title: "Harden the verify CLI",
    });

    const initiativeEntry = body.choices.find(
      (entry) => entry.id === planFixtureIdentities.initiative,
    );
    assert.ok(initiativeEntry);
    assert.deepEqual(initiativeEntry.fields, []);
    assert.deepEqual(initiativeEntry.submitted.values, {});
    assert.deepEqual(initiativeEntry.database.values, {});

    const documentOnly = body.choices.find(
      (entry) => entry.presence === "document-only",
    );
    assert.ok(documentOnly);
    assert.deepEqual(Object.keys(documentOnly.submitted.values), [
      "body",
      "depends_on",
      "parent",
      "repo",
      "title",
      "worker",
    ]);
    assert.deepEqual(documentOnly.database.values, {});

    const databaseOnly = body.choices.find(
      (entry) => entry.presence === "database-only",
    );
    assert.ok(databaseOnly);
    assert.deepEqual(databaseOnly.submitted.values, {});
    assert.deepEqual(Object.keys(databaseOnly.database.values), [
      "body",
      "depends_on",
      "parent",
      "repo",
      "title",
      "worker",
    ]);
    assert.equal(databaseOnly.path, null);

    const paths = new Set(body.documents.map((document) => document.path));
    let joined = 0;
    for (const entry of body.choices) {
      if (entry.path === null) continue;
      assert.equal(
        body.documents.filter((document) => document.path === entry.path)
          .length,
        1,
        `path ${entry.path} does not name exactly one document`,
      );
      joined += 1;
    }
    assert.equal(joined, paths.size);
    assert.ok(joined > 0);
  });

  it("leaves every row count unchanged for every request in the suite", async (t) => {
    const { temporary, app, storage } = await buildHandlerApp();
    t.after(() => temporary.dispose());
    const tables = [
      "project",
      "node",
      "edge",
      "plan_revision",
      "blob",
      "event",
    ];

    const requests: ReadonlyArray<() => Promise<unknown>> = [
      () =>
        app
          .post(`/v1/project/${fixtureIds.project}/plan/validate`)
          .send(validBody),
      () =>
        app
          .post(`/v1/project/${fixtureIds.project}/plan/validate`)
          .send({ fromRevision: null, documents: [] }),
      () =>
        app
          .post(`/v1/project/${fixtureIds.project}/plan/validate`)
          .send(threeFaultsBody),
      () => app.post("/v1/project/project_nope/plan/validate").send(validBody),
    ];
    for (const request of requests) {
      const before = new Map(
        tables.map((table) => [table, countTable(storage, table)]),
      );
      await request();
      for (const table of tables) {
        assert.equal(
          countTable(storage, table),
          before.get(table),
          `${table} changed`,
        );
      }
    }

    const fixture = await buildHandlerApp({ withPlanFixture: true });
    t.after(() => fixture.temporary.dispose());
    const exported = exportPlan(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        revision: fixture.revision,
      },
      { projectId: fixtureIds.project },
    );
    const before = new Map(
      tables.map((table) => [table, countTable(fixture.storage, table)]),
    );
    await fixture.app
      .post(`/v1/project/${fixtureIds.project}/plan/validate`)
      .send({
        fromRevision: null,
        documents: editedFixtureSet(exported.documents),
      });
    for (const table of tables) {
      assert.equal(
        countTable(fixture.storage, table),
        before.get(table),
        `${table} changed`,
      );
    }
  });
});
