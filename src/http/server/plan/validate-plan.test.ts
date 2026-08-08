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
} from "../../../../test/helpers/plan.ts";
import { createPlanGraph } from "../../../../test/helpers/plan.ts";
import { validatePlanHandler } from "./validate-plan.ts";
import { validatePlan } from "../../../queries/plan/validate-plan.ts";
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

describe("src/http/server/plan/validate-plan.test", () => {
  async function buildHandlerApp() {
    const temporary = createMigratedStorage();
    const storage = temporary.storage;
    const plan = createPlanStore();
    const blobs = createBlobStore(
      storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    const reader = createPlanReader();
    const graph = createPlanGraph();
    storage.transact((transaction) => seedRegistry(transaction));
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
    return { temporary, app, storage };
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
  });
});
