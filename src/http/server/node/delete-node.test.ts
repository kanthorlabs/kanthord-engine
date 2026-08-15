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
  seedAttemptRow,
  seedNodeState,
  seedRunRow,
  seedWorkspaceOnNode,
} from "../../../../test/helpers/rows.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRevision,
  nodeBaselineRevision,
  planFixtureIdentities,
  reseedBaselineRevision,
  seedPlanFixture,
} from "../../../../test/helpers/plan.ts";
import { deleteNodeHandler } from "./delete-node.ts";
import { deleteNode } from "../../../commands/node/delete-node.ts";
import type { DeleteNodeInput } from "../../../commands/node/delete-node.ts";
import { nodeDeleteResponse } from "../../contract/graph.ts";
import type { Storage } from "../../../services/storage/index.ts";
import type { Transaction } from "../../../services/storage/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../../services/event/index.ts";
import type { ActorRow } from "../../../domain/actor.ts";

const CLOCK_START = 1700000000000;
const U_REV = "01BQZ3NDEKTSV4RRFFQ69G5FC2";
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

type DeleteHandlerFixture = Readonly<{
  temporary: { dispose(): void };
  app: TestApp;
  storage: Storage;
}>;

async function buildHandler(
  ulids: readonly string[],
  seed?: (transaction: Transaction) => void,
  resolveActor?: () => ActorRow,
): Promise<DeleteHandlerFixture> {
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
    storage.transact((transaction) => seed(transaction));
  }
  const app = await createTestApp({
    resolveActor,
    handlers: {
      "node.delete": deleteNodeHandler({
        deleteNode: (input: DeleteNodeInput) =>
          deleteNode(
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

function seedRunAndAttemptOnTask(transaction: Transaction): void {
  seedWorkspaceOnNode(transaction, {
    id: "workspace_1",
    nodeId: planFixtureIdentities.objective,
  });
  seedRunRow(transaction, {
    id: "run_1",
    kind: "objective",
    nodeId: planFixtureIdentities.objective,
    parentRunId: null,
    workspaceId: "workspace_1",
  });
  seedRunRow(transaction, {
    id: "run_2",
    kind: "task",
    nodeId: planFixtureIdentities.task,
    parentRunId: "run_1",
    workspaceId: "workspace_1",
  });
  seedAttemptRow(transaction, { id: "attempt_1", runId: "run_2" });
}

describe("src/http/server/node/delete-node.test", () => {
  it("POST /v1/node/:id/delete with a valid body answers 200 and nodeDeleteResponse parses it", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .send({ fromRevision: nodeBaselineRevision });

    assert.equal(response.status, 200);
    assert.equal(nodeDeleteResponse.safeParse(response.body).success, true);
    assert.equal(typeof response.body.revision, "string");
    assert.equal(response.body.revision.length > 0, true);
    assert.deepEqual(response.body.deleted, [planFixtureIdentities.task]);
  });

  it("on an unknown node answers 404 not-found", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const response = await fixture.app
      .post("/v1/node/task_nope/delete")
      .send({ fromRevision: nodeBaselineRevision });

    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
  });

  it("a stale project revision answers 409 stale-revision with the project guard", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .send({ fromRevision: "revision_zz" });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "stale-revision");
    assert.deepEqual(response.body.error.details, {
      guard: "project",
      expected: nodeBaselineRevision,
      actual: "revision_zz",
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a subtree node in a non-deletable state answers 409 illegal-transition with the node and state", async (t) => {
    const fixture = await buildHandler([U_REV], (storage) => {
      seedNodeState(storage, planFixtureIdentities.task, "done");
    });
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .send({ fromRevision: nodeBaselineRevision });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "illegal-transition");
    assert.deepEqual(response.body.error.details, {
      nodes: [{ id: planFixtureIdentities.task, state: "done" }],
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a subtree touched by a run and an attempt answers 409 binding-in-use with both blockers", async (t) => {
    const fixture = await buildHandler([U_REV], seedRunAndAttemptOnTask);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage);
    const response = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .send({ fromRevision: nodeBaselineRevision });

    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "binding-in-use");
    assert.deepEqual(response.body.error.details, {
      blockers: [
        { nodeId: planFixtureIdentities.task, blocker: "run" },
        { nodeId: planFixtureIdentities.task, blocker: "attempt" },
      ],
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
  });

  it("a repeated Idempotency-Key replays the captured 200 body and not a 404", async (t) => {
    const fixture = await buildHandler([U_REV]);
    t.after(() => fixture.temporary.dispose());

    const before = tableCounts(fixture.storage).plan_revision;
    const first = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .set("Idempotency-Key", "k-delete")
      .send({ fromRevision: nodeBaselineRevision });
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.deleted, [planFixtureIdentities.task]);

    const second = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .set("Idempotency-Key", "k-delete")
      .send({ fromRevision: nodeBaselineRevision });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(tableCounts(fixture.storage).plan_revision, before + 1);
  });

  it("node.delete answers 200 to a harness token and provider.list with the same token stays 403", async (t) => {
    const fixture = await buildHandler(
      [U_REV_B],
      undefined,
      () => HARNESS_ACTOR_FIXTURE,
    );
    t.after(() => fixture.temporary.dispose());

    const deleted = await fixture.app
      .post(`/v1/node/${planFixtureIdentities.task}/delete`)
      .send({ fromRevision: nodeBaselineRevision });
    assert.equal(deleted.status, 200);

    const refused = await fixture.app.get("/v1/provider");
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "actor-forbidden");
  });
});
