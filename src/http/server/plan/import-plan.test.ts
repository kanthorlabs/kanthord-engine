import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import { createMigratedStorage } from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import { fixtureIds } from "../../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanStore,
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../../test/helpers/plan.ts";
import { createPlanReader } from "../../../../test/helpers/plan.ts";
import { createPlanGraph } from "../../../../test/helpers/plan.ts";
import { importPlanHandler } from "./import-plan.ts";
import { importPlan } from "../../../commands/plan/import-plan.ts";
import type { ImportPlanInput } from "../../../commands/plan/import-plan.ts";
import { exportPlan } from "../../../queries/plan/export-plan.ts";
import { validatePlan } from "../../../queries/plan/validate-plan.ts";
import { canonicalDocumentsJson } from "../../../domain/plan-hash.ts";
import { planImportResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import type { PlanStore } from "../../../services/plan/index.ts";
import type { BlobStore } from "../../../services/blob/index.ts";
import type { EventLog, RecordedEvent } from "../../../services/event/index.ts";
import type { AppendEventInput } from "../../../services/event/index.ts";

const encoder = new TextEncoder();
const U_REV = "01JQZ3NDEKTSV4RRFFQ69G5FAV";

const recordingEvents: EventLog = {
  append(): RecordedEvent {
    return {
      id: "event_1",
      subjectKind: "",
      subjectId: "",
      type: "",
      actorKind: "human",
      actorId: "",
      payload: {},
      occurredAt: 0,
    };
  },
  list(): readonly RecordedEvent[] {
    return [];
  },
};

function seedTaskTwoWithEdge(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
): void {
  storage.transact((transaction) => {
    plan.upsertNode(transaction, {
      id: planFixtureIdentities.taskTwo,
      projectId: fixtureIds.project,
      kind: "task",
      parentId: planFixtureIdentities.objective,
      title: "Harden the verify CLI",
      instructionBlob: blobs.put(
        transaction,
        encoder.encode("Do the second task work.\n"),
      ),
      acceptanceBlob: blobs.put(
        transaction,
        encoder.encode("## Acceptance criteria\n- it works\n"),
      ),
      worker: null,
      repositoryId: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
    });
    plan.insertEdge(transaction, {
      id: "edge_01ZZZ3NDEKTSV4RRFFQ69G5FAV",
      fromNode: planFixtureIdentities.taskTwo,
      toNode: planFixtureIdentities.task,
    });
  });
}

function seedTaskTwo(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
): void {
  storage.transact((transaction) => {
    plan.upsertNode(transaction, {
      id: planFixtureIdentities.taskTwo,
      projectId: fixtureIds.project,
      kind: "task",
      parentId: planFixtureIdentities.objective,
      title: "Harden the verify CLI",
      instructionBlob: blobs.put(
        transaction,
        encoder.encode("Do the second task work.\n"),
      ),
      acceptanceBlob: blobs.put(
        transaction,
        encoder.encode("## Acceptance criteria\n- it works\n"),
      ),
      worker: null,
      repositoryId: null,
      revision: fixtureIds.planRevision,
      updatedAt: 1,
    });
  });
}

function snapshot(storage: Storage): Record<string, readonly unknown[]> {
  return storage.transact((transaction) => {
    const rows = (table: string, order: string): readonly unknown[] =>
      transaction.all(`SELECT * FROM ${table} ORDER BY ${order}`);
    return {
      project: rows("project", "id"),
      node: rows("node", "id"),
      edge: rows("edge", "id"),
      plan_revision: rows("plan_revision", "id"),
      blob: rows("blob", "hash"),
      event: rows("event", "id"),
    };
  });
}

type HandlerFixture = Readonly<{
  temporary: { dispose(): void };
  app: TestApp;
  storage: Storage;
  blobs: BlobStore;
  exported: ReturnType<typeof exportPlan>["documents"];
}>;

async function buildHandler(
  seed: (
    storage: Storage,
    plan: PlanStore,
    blobs: BlobStore,
  ) => void = () => {},
): Promise<HandlerFixture> {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const plan = createPlanStore();
  const blobs = createBlobStore(
    storage,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  seedPlanFixture(storage, plan, blobs);
  seed(storage, plan, blobs);
  const exported = exportPlan(
    { storage, plan, blobs },
    { projectId: fixtureIds.project },
  );
  const app = await createTestApp({
    handlers: {
      "plan.import": importPlanHandler({
        importPlan: (input: ImportPlanInput) =>
          importPlan(
            {
              storage,
              plan,
              blobs,
              reader: createPlanReader(),
              graph: createPlanGraph(),
              ids: createMockIdGenerator({ ulids: [U_REV] }),
              clock: createMockClock({ start: 1700000000000, step: 1000 }),
              events: recordingEvents,
            },
            input,
          ),
        actor: "ulrich",
      }),
    },
  });
  return {
    temporary,
    app,
    storage,
    blobs,
    exported: exported.documents,
  };
}

function validBody(fixture: HandlerFixture): Record<string, unknown> {
  return {
    fromRevision: fixtureIds.planRevision,
    importId: "imp_handler",
    documents: fixture.exported,
    choices: [
      { id: planFixtureIdentities.initiative, take: "database" },
      { id: planFixtureIdentities.objective, take: "database" },
      { id: planFixtureIdentities.task, take: "database" },
    ],
    validatedRevision: fixtureIds.planRevision,
    documentsHash: fixture.blobs.hash(
      encoder.encode(canonicalDocumentsJson(fixture.exported)),
    ),
  };
}

async function post(fixture: HandlerFixture, body: Record<string, unknown>) {
  const before = snapshot(fixture.storage);
  const response = await fixture.app
    .post(`/v1/project/${fixtureIds.project}/plan/import`)
    .send(body);
  const after = snapshot(fixture.storage);
  return { response, before, after };
}

describe("src/http/server/plan/import-plan.test", () => {
  it("POST /v1/project/:id/plan/import with a valid body answers 200 and planImportResponse parses it", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const { response } = await post(fixture, validBody(fixture));

    assert.equal(response.status, 200);
    assert.equal(planImportResponse.safeParse(response.body).success, true);
    assert.equal(response.body.revision, `revision_${U_REV}`);
    assert.equal(response.body.documents.length, 3);
    assert.equal(response.body.absent.length, 0);
    assert.equal("retried" in response.body, false);
  });

  it("on an unknown project answers 404 not-found", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const before = snapshot(fixture.storage);
    const response = await fixture.app
      .post("/v1/project/project_nope/plan/import")
      .send(validBody(fixture));
    const after = snapshot(fixture.storage);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.deepEqual(after, before);
  });

  it("plan-invalid answers 422 with the findings", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const documents = fixture.exported.map((document) =>
      document.content.includes("Do the task work.")
        ? {
            ...document,
            content: document.content.slice(
              0,
              document.content.indexOf("## Acceptance criteria"),
            ),
          }
        : document,
    );
    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      documents,
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "plan-invalid");
    assert.deepEqual(after, before);
  });

  it("choices-invalid answers 422 with the cycle finding", async (t) => {
    const fixture = await buildHandler((storage, plan, blobs) =>
      seedTaskTwoWithEdge(storage, plan, blobs),
    );
    t.after(() => fixture.temporary.dispose());

    const edited = fixture.exported
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
    const hash = validatePlan(
      {
        storage: fixture.storage,
        plan: createPlanStore(),
        blobs: fixture.blobs,
        reader: createPlanReader(),
        graph: createPlanGraph(),
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        documents: edited,
      },
    ).documentsHash;
    const { response, before, after } = await post(fixture, {
      fromRevision: fixtureIds.planRevision,
      importId: "imp_cycle",
      documents: edited,
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "submitted" },
        { id: planFixtureIdentities.taskTwo, take: "database" },
      ],
      validatedRevision: fixtureIds.planRevision,
      documentsHash: hash,
    });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "choices-invalid");
    assert.deepEqual(after, before);
  });

  it("choices-stale answers 409 with the fresh conflict set", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      validatedRevision: "revision_zz",
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "choices-stale");
    assert.deepEqual(after, before);
  });

  it("choices-changed answers 409 naming the illegal selection", async (t) => {
    const fixture = await buildHandler((storage, plan, blobs) => {
      seedTaskTwo(storage, plan, blobs);
      storage.transact((transaction) => {
        transaction.run("UPDATE node SET state = 'running' WHERE id = ?", [
          planFixtureIdentities.task,
        ]);
      });
    });
    t.after(() => fixture.temporary.dispose());

    const documents = fixture.exported.map((document) =>
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
    const hash = validatePlan(
      {
        storage: fixture.storage,
        plan: createPlanStore(),
        blobs: fixture.blobs,
        reader: createPlanReader(),
        graph: createPlanGraph(),
        ids: createMockIdGenerator({ ulids: [] }),
      },
      {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        documents,
      },
    ).documentsHash;
    const { response, before, after } = await post(fixture, {
      fromRevision: fixtureIds.planRevision,
      importId: "imp_changed",
      documents,
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "submitted" },
        { id: planFixtureIdentities.taskTwo, take: "database" },
      ],
      validatedRevision: fixtureIds.planRevision,
      documentsHash: hash,
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "choices-changed");
    assert.deepEqual(after, before);
  });

  it("stale-revision answers 409 with the current revision", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      fromRevision: "revision_zz",
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "stale-revision");
    assert.equal(response.body.error.details.current, fixtureIds.planRevision);
    assert.deepEqual(after, before);
  });

  it("idempotency-mismatch answers 409 with the differed field", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const first = await post(fixture, validBody(fixture));
    assert.equal(first.response.status, 200);
    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "submitted" },
      ],
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "idempotency-mismatch");
    assert.deepEqual(after, before);
  });

  it("choice-duplicate answers 400 invalid-request with details.refusal", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "database" },
        { id: planFixtureIdentities.task, take: "submitted" },
      ],
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "choice-duplicate");
    assert.deepEqual(after, before);
  });

  it("choice-missing answers 400 invalid-request with details.refusal", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
      ],
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "choice-missing");
    assert.deepEqual(after, before);
  });

  it("choice-extra answers 400 invalid-request with details.refusal", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      choices: [
        { id: planFixtureIdentities.initiative, take: "database" },
        { id: planFixtureIdentities.objective, take: "database" },
        { id: planFixtureIdentities.task, take: "database" },
        { id: "task_01ZZZ3NDEKTSV4RRFFQ69G5FAV", take: "database" },
      ],
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "choice-extra");
    assert.deepEqual(after, before);
  });

  it("documents-hash-mismatch answers 400 invalid-request with details.refusal", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const correct = fixture.blobs.hash(
      encoder.encode(canonicalDocumentsJson(fixture.exported)),
    );
    const wrong = `${correct.slice(0, -1)}${correct.endsWith("0") ? "1" : "0"}`;
    const { response, before, after } = await post(fixture, {
      ...validBody(fixture),
      documentsHash: wrong,
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(
      response.body.error.details.refusal,
      "documents-hash-mismatch",
    );
    assert.deepEqual(after, before);
  });

  it("a retry answers 200, not 201 and not 409", async (t) => {
    const fixture = await buildHandler();
    t.after(() => fixture.temporary.dispose());

    const first = await post(fixture, validBody(fixture));
    assert.equal(first.response.status, 200);
    const second = await post(fixture, validBody(fixture));

    assert.equal(second.response.status, 200);
    assert.equal(second.response.body.revision, first.response.body.revision);
  });

  it("never fabricates the actor 'human' when the handler is built without one", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const storage = temporary.storage;
    const plan = createPlanStore();
    const blobs = createBlobStore(
      storage,
      createMockClock({ start: 1700000000000, step: 1000 }),
    );
    seedPlanFixture(storage, plan, blobs);
    const exported = exportPlan(
      { storage, plan, blobs },
      { projectId: fixtureIds.project },
    ).documents;
    const recorded: Readonly<{ actorId: string | undefined }>[] = [];
    const events: EventLog = {
      append(_transaction: unknown, input: AppendEventInput): RecordedEvent {
        recorded.push({ actorId: input.actorId });
        return {
          id: "event_1",
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          type: input.type,
          actorKind: input.actorKind,
          actorId: input.actorId,
          payload: input.payload,
          occurredAt: 0,
        };
      },
      list(): readonly RecordedEvent[] {
        return [];
      },
    };
    const app = await createTestApp({
      handlers: {
        "plan.import": importPlanHandler({
          importPlan: (input: ImportPlanInput) =>
            importPlan(
              {
                storage,
                plan,
                blobs,
                reader: createPlanReader(),
                graph: createPlanGraph(),
                ids: createMockIdGenerator({ ulids: [U_REV] }),
                clock: createMockClock({
                  start: 1700000000000,
                  step: 1000,
                }),
                events,
              },
              input,
            ),
          actor: undefined as unknown as string,
        }),
      },
    });

    const response = await app
      .post(`/v1/project/${fixtureIds.project}/plan/import`)
      .send({
        fromRevision: fixtureIds.planRevision,
        importId: "imp_actor",
        documents: exported,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: blobs.hash(
          encoder.encode(canonicalDocumentsJson(exported)),
        ),
      });

    assert.equal(response.status, 200);
    assert.ok(recorded.length > 0, "the import appended events");
    for (const event of recorded) {
      assert.notEqual(event.actorId, "human");
    }
  });
});
