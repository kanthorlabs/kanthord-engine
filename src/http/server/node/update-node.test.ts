import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createTestApp,
  HARNESS_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";
import type { TestApp } from "../../../../test/helpers/app.ts";
import {
  createMigratedStorage,
  tableCounts,
} from "../../../../test/helpers/database.ts";
import { createMockClock } from "../../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../../test/helpers/ids.ts";
import {
  fixtureIds,
  seedNodeState,
  seedWorkspaceOnNode,
} from "../../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRevision,
  nodeBaselineRevision,
  planFixtureBodies,
  planFixtureIdentities,
  reseedBaselineRevision,
  seedPlanFixture,
} from "../../../../test/helpers/plan.ts";
import { updateNodeHandler } from "./update-node.ts";
import { updateNode } from "../../../commands/node/update-node.ts";
import type { UpdateNodeInput } from "../../../commands/node/update-node.ts";
import { nodeUpdateResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import type { Transaction } from "../../../services/storage/index.ts";
import type { PlanStore } from "../../../services/plan/index.ts";
import type { BlobStore } from "../../../services/blob/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../../services/event/index.ts";
import type { ActorRow } from "../../../domain/actor.ts";

const CLOCK_START = 1700000000000;
const U_REV = "01BQZ3NDEKTSV4RRFFQ69G5FC2";
const U_REV_B = "01ERZ3NDEKTSV4RRFFQ69G5FC4";
const U_REV_PREAMBLE = "01PRZ3NDEKTSV4RRFFQ69G5FCB";

const discardingEvents: EventLog = {
  append(_transaction: unknown, input: AppendEventInput): RecordedEvent {
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

type UpdateHandlerFixture = Readonly<{
  temporary: { dispose(): void };
  app: TestApp;
  storage: Storage;
}>;

async function buildHandler(
  ulids: readonly string[],
  seed?: (transaction: Transaction, plan: PlanStore, blobs: BlobStore) => void,
  resolveActor?: () => ActorRow,
): Promise<UpdateHandlerFixture> {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const events: EventLog = discardingEvents;
  const plan = createPlanStore(createReadiness(events, "daemon_test"));
  const blobs = createBlobStore(
    storage,
    createMockClock({ start: CLOCK_START, step: 1000 }),
  );
  seedPlanFixture(storage, plan, blobs);
  reseedBaselineRevision(storage);
  if (seed !== undefined) {
    storage.transact((transaction) => seed(transaction, plan, blobs));
  }
  const app = await createTestApp({
    resolveActor,
    handlers: {
      "node.update": updateNodeHandler({
        updateNode: (input: UpdateNodeInput) =>
          updateNode(
            {
              storage,
              plan,
              blobs,
              graph: createPlanGraph(),
              ids: createMockIdGenerator({ ulids }),
              clock: createMockClock({ start: CLOCK_START, step: 1000 }),
              events,
              revision: createRevision(blobs, plan),
            },
            input,
          ),
      }),
    },
  });
  return { temporary, app, storage };
}

function seedTaskTwo(
  transaction: Transaction,
  plan: PlanStore,
  blobs: BlobStore,
): void {
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
          new TextEncoder().encode(planFixtureBodies.taskInstruction),
        ),
        acceptanceBlob: blobs.put(
          transaction,
          new TextEncoder().encode(planFixtureBodies.taskAcceptance),
        ),
        worker: null,
        repositoryId: null,
        revision: nodeBaselineRevision,
        updatedAt: 1,
      },
    ],
    insertEdges: [],
    deleteEdgeIds: [],
    nodeDeletes: [],
    at: 1,
    cause: { revision: nodeBaselineRevision, importId: null },
  });
}

function taskBody(
  fromRevision: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    fromRevision,
    node: {
      kind: "task",
      title: "Harden the verify CLI",
      parentId: planFixtureIdentities.objective,
      instruction: planFixtureBodies.taskInstruction,
      acceptance: planFixtureBodies.taskAcceptance,
      worker: null,
      dependsOn: [],
      ...overrides,
    },
  };
}

describe("src/http/server/node/update-node.test", () => {
  it("POST /v1/node/:id/update with a valid body answers 200 and nodeUpdateResponse parses it", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(taskBody(nodeBaselineRevision, { title: "Renamed" }));

    assert.equal(response.status, 200);
    assert.equal(nodeUpdateResponse.safeParse(response.body).success, true);
    assert.equal(typeof response.body.revision, "string");
    assert.equal(response.body.revision.length > 0, true);
  });

  it("an omitted editable field answers 400 invalid-request from the schema", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send({
        fromRevision: nodeBaselineRevision,
        node: {
          kind: "task",
          title: "Renamed",
          parentId: planFixtureIdentities.objective,
          instruction: planFixtureBodies.taskInstruction,
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a repo on a task answers 400 invalid-request from the schema", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(taskBody(nodeBaselineRevision, { repo: "kanthord-verify" }));

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a missing repo on an objective answers 400 invalid-request from the schema", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.objective}/update`)
      .send({
        fromRevision: nodeBaselineRevision,
        node: {
          kind: "objective",
          title: "Renamed",
          parentId: planFixtureIdentities.initiative,
          instruction: planFixtureBodies.objective,
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("on an unknown node answers 404 not-found", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post("/v1/node/task_nope/update")
      .send(taskBody(nodeBaselineRevision, { title: "Renamed" }));

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("a kind change answers 400 invalid-request with the expected and actual kinds", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send({
        fromRevision: nodeBaselineRevision,
        node: {
          kind: "objective",
          title: "Renamed",
          parentId: planFixtureIdentities.initiative,
          repo: "kanthord-verify",
          instruction: planFixtureBodies.objective,
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.deepEqual(response.body.error.details, {
      expected: "task",
      actual: "objective",
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a field-only update at a stale node revision answers 409 with the node guard", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(taskBody("revision_zz", { title: "Renamed" }));

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "stale-revision");
    assert.deepEqual(response.body.error.details, {
      guard: "node",
      expected: nodeBaselineRevision,
      actual: "revision_zz",
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a depends_on change at the node revision answers 409 with the project guard", async (t) => {
    const fixture = await buildHandler(
      [U_REV_PREAMBLE, U_REV],
      (transaction, plan, blobs) => {
        seedTaskTwo(transaction, plan, blobs);
      },
    );
    t.after(() => fixture.temporary.dispose());

    const preamble = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.taskTwo}/update`)
      .send(taskBody(nodeBaselineRevision, { title: "Second task" }));
    assert.equal(preamble.status, 200);
    const preambleRevision = preamble.body.revision as string;

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(
        taskBody(nodeBaselineRevision, {
          dependsOn: [planFixtureIdentities.taskTwo],
        }),
      );

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "stale-revision");
    assert.deepEqual(response.body.error.details, {
      guard: "project",
      expected: preambleRevision,
      actual: nodeBaselineRevision,
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a structural edit of a running task answers 409 illegal-transition with the node and state", async (t) => {
    const fixture = await buildHandler([U_REV], (storage) => {
      seedNodeState(storage, planFixtureIdentities.task, "running");
    });
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(
        taskBody(nodeBaselineRevision, {
          parentId: planFixtureIdentities.initiative,
        }),
      );

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "illegal-transition");
    assert.deepEqual(response.body.error.details, {
      nodes: [{ id: planFixtureIdentities.task, state: "running" }],
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a parent move of a task holding a workspace answers 409 binding-in-use with the blocker", async (t) => {
    const fixture = await buildHandler([U_REV], (storage) => {
      seedWorkspaceOnNode(storage, {
        id: "workspace_01JQZ3NDEKTSV4RRFFQ69G5FAV",
        nodeId: planFixtureIdentities.task,
      });
    });
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(
        taskBody(nodeBaselineRevision, {
          parentId: planFixtureIdentities.initiative,
        }),
      );

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "binding-in-use");
    assert.deepEqual(response.body.error.details, {
      blockers: [{ nodeId: planFixtureIdentities.task, blocker: "workspace" }],
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a dependency on itself answers 422 plan-invalid with the finding", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(
        taskBody(nodeBaselineRevision, {
          dependsOn: [planFixtureIdentities.task],
        }),
      );

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "plan-invalid");
    assert.ok(
      response.body.error.details.findings.some(
        (finding: { code: string }) => finding.code === "dependency-self",
      ),
    );
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a repeated Idempotency-Key replays the captured 200 and mints no second revision", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage).plan_revision;
    const first = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .set("Idempotency-Key", "k-update")
      .send(taskBody(nodeBaselineRevision, { title: "Renamed" }));
    assert.equal(first.status, 200);

    const second = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .set("Idempotency-Key", "k-update")
      .send(taskBody(nodeBaselineRevision, { title: "Renamed" }));
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(tableCounts(fixture.storage).plan_revision, before + 1);
  });

  it("node.update answers 200 to a harness token and provider.list with the same token stays 403", async (t) => {
    const fixture = await buildHandler(
      [U_REV_B],
      undefined,
      () => HARNESS_ACTOR_FIXTURE,
    );
    t.after(() => fixture.temporary.dispose());

    const updated = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/update`)
      .send(taskBody(nodeBaselineRevision, { title: "Renamed" }));
    assert.equal(updated.status, 200);

    const refused = await fixture.app.get("/v1/provider");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "actor-forbidden");
  });
});
