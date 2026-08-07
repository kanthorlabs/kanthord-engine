import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { listEventHandler } from "./list-event.ts";
import type {
  EventView,
  ListEventInput,
} from "../../../queries/event/list-event.ts";
import { eventListResponse } from "../../contract/event.ts";

const first: EventView = {
  id: "event_01HZY8QF3M4N5P6R7S8T9V0W1A",
  subjectKind: "node",
  subjectId: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
  type: "node.created",
  actorKind: "daemon",
  actorId: "d1",
  payload: { a: 1, b: ["x"] },
  occurredAt: 1700000000000,
};

const second: EventView = {
  id: "event_01HZY8QF3M4N5P6R7S8T9V0W1C",
  subjectKind: "node",
  subjectId: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
  type: "node.blocked",
  actorKind: "daemon",
  actorId: "d1",
  payload: { a: 1, b: ["x"] },
  occurredAt: 1700000001000,
};

async function handlerApp(
  listEvents: (input: ListEventInput) => readonly EventView[],
) {
  return createTestApp({
    handlers: { "event.list": listEventHandler({ listEvents }) },
  });
}

describe("src/http/server/event/list-event.test", () => {
  it("GET /v1/event answers 200 and renames the timestamp", async () => {
    const app = await handlerApp(() => [first, second]);
    const response = await app.get("/v1/event");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      events: [
        {
          id: "event_01HZY8QF3M4N5P6R7S8T9V0W1A",
          type: "node.created",
          subjectKind: "node",
          subjectId: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
          actorKind: "daemon",
          actorId: "d1",
          payload: { a: 1, b: ["x"] },
          createdAt: 1700000000000,
        },
        {
          id: "event_01HZY8QF3M4N5P6R7S8T9V0W1C",
          type: "node.blocked",
          subjectKind: "node",
          subjectId: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
          actorKind: "daemon",
          actorId: "d1",
          payload: { a: 1, b: ["x"] },
          createdAt: 1700000001000,
        },
      ],
    });
    assert.equal(JSON.stringify(response.body).includes("occurredAt"), false);
  });

  it("the body satisfies the shipped schema", async () => {
    const app = await handlerApp(() => [first, second]);
    const response = await app.get("/v1/event");

    assert.equal(eventListResponse.safeParse(response.body).success, true);
  });

  it("no query calls listEvents with exactly the default limit", async () => {
    let recorded: ListEventInput | undefined;
    const app = await handlerApp((input) => {
      recorded = input;
      return [];
    });
    await app.get("/v1/event");

    assert.deepEqual(recorded, { limit: 100 });
    assert.equal("after" in (recorded as object), false);
  });

  it("every filter reaches listEvents with limit as a number", async () => {
    let recorded: ListEventInput | undefined;
    const app = await handlerApp((input) => {
      recorded = input;
      return [];
    });
    await app.get(
      "/v1/event?subjectKind=node&subject=node_01HZY8QF3M4N5P6R7S8T9V0W1A&type=node.created&actorKind=daemon&actor=d1&after=event_01HZY8QF3M4N5P6R7S8T9V0W1A&limit=25",
    );

    assert.deepEqual(recorded, {
      subjectKind: "node",
      subject: "node_01HZY8QF3M4N5P6R7S8T9V0W1A",
      type: "node.created",
      actorKind: "daemon",
      actor: "d1",
      after: "event_01HZY8QF3M4N5P6R7S8T9V0W1A",
      limit: 25,
    });
  });

  it("limit 501, 0 and abc each answer 400", async () => {
    const app = await handlerApp(() => []);

    const tooLarge = await app.get("/v1/event?limit=501");
    assert.equal(tooLarge.status, 400);
    assert.equal(tooLarge.body.error.code, "invalid-request");

    const zero = await app.get("/v1/event?limit=0");
    assert.equal(zero.status, 400);

    const nonsense = await app.get("/v1/event?limit=abc");
    assert.equal(nonsense.status, 400);
  });

  it("an empty after answers 400", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?after=");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("wait answers 400 because the schema is strict", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?wait=5");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("a repeated type parameter answers 400 naming type", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?type=a&type=b");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.ok(String(response.body.error.message).includes("type"));
  });

  it("an after that matches no row still answers 200", async () => {
    let recorded: ListEventInput | undefined;
    const app = await handlerApp((input) => {
      recorded = input;
      return [];
    });
    const response = await app.get(
      "/v1/event?after=repo_01HZY8QF3M4N5P6R7S8T9V0W1A",
    );

    assert.equal(response.status, 200);
    assert.equal(recorded?.after, "repo_01HZY8QF3M4N5P6R7S8T9V0W1A");
  });

  it("an empty result answers 200 with an empty events array, never 404", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
  });

  it("no token answers 401 and an Origin header answers 403", async () => {
    const app = await handlerApp(() => []);

    const noToken = await app.raw.get("/v1/event").set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);

    const origin = await app.raw
      .get("/v1/event")
      .set("Host", "kanthord.test")
      .set("Authorization", "Bearer test-token")
      .set("Origin", "https://evil.example");
    assert.equal(origin.status, 403);
  });

  it("the handler reads neither context.body nor context.parameters", async () => {
    const app = await handlerApp(() => [first]);
    const response = await app.get("/v1/event").send({ ignored: true });

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.events.map((event: { id: string }) => event.id),
      [first.id],
    );
  });
});
