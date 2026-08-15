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
import { fixtureIds, seedRegistry } from "../../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRevision,
} from "../../../../test/helpers/plan.ts";
import { createNodeHandler } from "./create-node.ts";
import { createNode } from "../../../commands/node/create-node.ts";
import type { CreateNodeInput } from "../../../commands/node/create-node.ts";
import { nodeCreateResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../../services/event/index.ts";
import type { ActorRow } from "../../../domain/actor.ts";

const CLOCK_START = 1700000000000;
const U_NODE = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const U_REV = "01BQZ3NDEKTSV4RRFFQ69G5FC2";
const U_NODE_B = "01DRZ3NDEKTSV4RRFFQ69G5FC3";
const U_REV_B = "01ERZ3NDEKTSV4RRFFQ69G5FC4";

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

type CreateHandlerFixture = Readonly<{
  temporary: { dispose(): void };
  app: TestApp;
  storage: Storage;
}>;

async function buildHandler(
  ulids: readonly string[],
  resolveActor?: () => ActorRow,
): Promise<CreateHandlerFixture> {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const events: EventLog = discardingEvents;
  const plan = createPlanStore(createReadiness(events, "daemon_test"));
  const blobs = createBlobStore(
    storage,
    createMockClock({ start: CLOCK_START, step: 1000 }),
  );
  storage.transact((transaction) => seedRegistry(transaction));
  const app = await createTestApp({
    resolveActor,
    handlers: {
      "node.create": createNodeHandler({
        createNode: (input: CreateNodeInput) =>
          createNode(
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

const initiativeBody = {
  fromRevision: null,
  node: {
    kind: "initiative",
    title: "Ship the release",
    instruction: "Do the work.\n",
    worker: null,
    dependsOn: [],
  },
};

function objectiveBody(fromRevision: string | null): Record<string, unknown> {
  return {
    fromRevision,
    node: {
      kind: "objective",
      title: "Ship the release",
      parentId: `initiative_${U_NODE}`,
      repo: "kanthord-verify",
      instruction: "Do the work.\n",
      worker: null,
      dependsOn: [],
    },
  };
}

describe("src/http/server/node/create-node.test", () => {
  it("POST /v1/project/:id/node with a valid body answers 200 and nodeCreateResponse parses it", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send(initiativeBody);

    assert.equal(response.status, 200);
    assert.equal(nodeCreateResponse.safeParse(response.body).success, true);
    assert.equal(response.body.id, `initiative_${U_NODE}`);
    assert.equal(typeof response.body.revision, "string");
    assert.equal(response.body.revision.length > 0, true);
  });

  it("an omitted editable field answers 400 invalid-request from the schema", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send({
        fromRevision: null,
        node: {
          kind: "initiative",
          instruction: "Do the work.\n",
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a repo on a task answers 400 invalid-request from the schema", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send({
        fromRevision: null,
        node: {
          kind: "task",
          title: "t",
          parentId: "objective_a",
          repo: "kanthord-verify",
          instruction: "Do the work.\n",
          acceptance: "## Acceptance criteria\n- it works\n",
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a missing repo on an objective answers 400 invalid-request from the schema", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send({
        fromRevision: null,
        node: {
          kind: "objective",
          title: "o",
          parentId: "initiative_a",
          instruction: "Do the work.\n",
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("on an unknown project answers 404 not-found and writes nothing", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post("/v1/project/project_nope/node")
      .send(initiativeBody);

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a stale project revision answers 409 stale-revision with the guard details", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send({ ...initiativeBody, fromRevision: "revision_zz" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "stale-revision");
    assert.deepEqual(response.body.error.details, {
      guard: "project",
      expected: null,
      actual: "revision_zz",
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a structural finding answers 422 plan-invalid with the findings", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send({
        fromRevision: null,
        node: {
          kind: "task",
          title: "t",
          parentId: `initiative_${U_NODE}`,
          instruction: "Do the work.\n",
          acceptance: "## Acceptance criteria\n- it works\n",
          worker: null,
          dependsOn: [],
        },
      });

    assert.equal(response.status, 422);
    assert.equal(response.body.error.code, "plan-invalid");
    assert.ok(
      response.body.error.details.findings.some(
        (finding: { code: string }) => finding.code === "parent-missing",
      ),
    );
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a repeated Idempotency-Key replays the captured 200 and mints no second revision", async (t) => {
    const fixture = await buildHandler([U_NODE, U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage).plan_revision;
    const first = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .set("Idempotency-Key", "k-create")
      .send(initiativeBody);
    assert.equal(first.status, 200);

    const second = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .set("Idempotency-Key", "k-create")
      .send(initiativeBody);
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(tableCounts(fixture.storage).plan_revision, before + 1);
  });

  it("node.create answers 200 to a harness token and provider.list with the same token stays 403", async (t) => {
    const fixture = await buildHandler(
      [U_NODE_B, U_REV_B],
      () => HARNESS_ACTOR_FIXTURE,
    );
    t.after(() => fixture.temporary.dispose());

    const created = await fixture.app
      .post(`/v1/project/${fixtureIds.project}/node`)
      .send(initiativeBody);
    assert.equal(created.status, 200);

    const refused = await fixture.app.get("/v1/provider");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "actor-forbidden");
  });
});
