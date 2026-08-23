import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../../test/helpers/app.ts";
import { createFakeSchedule } from "../../../../test/helpers/virtual-clock.ts";
import type { FakeSchedule } from "../../../../test/helpers/virtual-clock.ts";
import { listEventHandler } from "./list-event.ts";
import {
  POLL_INTERVAL_MS,
  createWaitRegistry,
} from "../../../../test/helpers/wait-registry.ts";
import type {
  WaitInput,
  WaitRegistry,
  WaitRegistryDependencies,
} from "../../../../test/helpers/wait-registry.ts";
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

function eventBody(event: EventView) {
  return {
    id: event.id,
    type: event.type,
    subjectKind: event.subjectKind,
    subjectId: event.subjectId,
    actorKind: event.actorKind,
    actorId: event.actorId,
    payload: event.payload,
    createdAt: event.occurredAt,
  };
}

async function handlerApp(
  listEvents: (input: ListEventInput) => readonly EventView[],
  options?: Readonly<{ waits?: WaitRegistry; maxWaitSeconds?: number }>,
) {
  const waits =
    options?.waits ?? createWaitRegistry({ schedule: () => () => {} });
  return createTestApp({
    waits,
    handlers: {
      "event.list": listEventHandler({
        listEvents,
        waits,
        maxWaitSeconds: options?.maxWaitSeconds ?? 30,
      }),
    },
  });
}

function clockRegistry(clock: FakeSchedule): WaitRegistry {
  return createWaitRegistry({ schedule: clock.schedule });
}

function signalledRegistry(clock: FakeSchedule): {
  registry: WaitRegistry;
  armedUpTo(count: number): Promise<void>;
} {
  let arms = 0;
  const resolvers = new Map<number, () => void>();
  const armedUpTo = (count: number): Promise<void> =>
    new Promise<void>((resolve) => {
      resolvers.set(count, resolve);
    });
  const schedule: WaitRegistryDependencies["schedule"] = (
    milliseconds,
    callback,
  ) => {
    arms += 1;
    resolvers.get(arms)?.();
    return clock.schedule(milliseconds, callback);
  };
  return { registry: createWaitRegistry({ schedule }), armedUpTo };
}

async function assertRegisteredBeforeAnswered(
  pending: Promise<unknown>,
  armed: Promise<void>,
): Promise<void> {
  const outcome = await Promise.race([
    armed.then(() => "registered" as const),
    pending.then(() => "answered" as const),
  ]);
  assert.equal(outcome, "registered");
}

const STILL_PENDING = "sentinel: still pending";

async function assertStillPending(pending: Promise<unknown>): Promise<void> {
  const outcome = await Promise.race([pending, Promise.resolve(STILL_PENDING)]);
  assert.equal(outcome, STILL_PENDING);
}

function advanceTicks(clock: FakeSchedule, times: number): void {
  for (let index = 0; index < times; index += 1) {
    clock.advanceBy(POLL_INTERVAL_MS);
  }
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

    assert.deepEqual(recorded, { limit: 100, order: "asc" });
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
      order: "asc",
      limit: 25,
    });
  });

  it("forwards order, before, after and limit to listEvents", async () => {
    let recorded: ListEventInput | undefined;
    const app = await handlerApp((input) => {
      recorded = input;
      return [];
    });
    await app.get(
      "/v1/event?order=desc&before=event_01HZY8QF3M4N5P6R7S8T9V0WB0&after=event_01HZY8QF3M4N5P6R7S8T9V0WA1&limit=25",
    );

    assert.deepEqual(recorded, {
      after: "event_01HZY8QF3M4N5P6R7S8T9V0WA1",
      before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0",
      order: "desc",
      limit: 25,
    });
  });

  it("rejects sideways order naming the order parameter", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?order=sideways");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(response.body.error.details.refusal, "query-schema");
    assert.deepEqual(
      response.body.error.details.issues.map(
        (issue: Readonly<{ path: string }>) => issue.path,
      ),
      ["order"],
    );
  });

  it("rejects an empty before", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?before=");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("answers an inverted range with an empty events array", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get(
      "/v1/event?after=event_01HZY8QF3M4N5P6R7S8T9V0WA7&before=event_01HZY8QF3M4N5P6R7S8T9V0WA3",
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
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

  it("an absent wait answers immediately and schedules nothing", async () => {
    const clock = createFakeSchedule();
    const app = await handlerApp(() => [first], {
      waits: clockRegistry(clock),
    });
    const response = await app.get("/v1/event");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [eventBody(first)] });
    assert.equal(clock.armed.length, 0);
  });

  it("wait=0 answers immediately with an empty array and schedules nothing", async () => {
    const clock = createFakeSchedule();
    const app = await handlerApp(() => [], { waits: clockRegistry(clock) });
    const response = await app.get("/v1/event?wait=0");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
    assert.equal(clock.armed.length, 0);
  });

  it("wait=5 with events already present answers at once, reads once and schedules nothing", async () => {
    const clock = createFakeSchedule();
    let calls = 0;
    const app = await handlerApp(
      () => {
        calls += 1;
        return [first, second];
      },
      { waits: clockRegistry(clock) },
    );
    const response = await app.get("/v1/event?wait=5");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      events: [eventBody(first), eventBody(second)],
    });
    assert.equal(clock.armed.length, 0);
    assert.equal(calls, 1);
  });

  it("wait=5 with no events elapses to an empty 200 after twenty polls", async () => {
    const clock = createFakeSchedule();
    let calls = 0;
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(
      () => {
        calls += 1;
        return [];
      },
      { waits: registry },
    );
    const pending = app.get("/v1/event?wait=5");
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));
    advanceTicks(clock, 20);
    const response = await pending;

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
    assert.equal(calls, 21);
  });

  it("an elapsed wait answers 200, parses against the shipped schema and carries no error envelope", async () => {
    const clock = createFakeSchedule();
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(() => [], { waits: registry });
    const pending = app.get("/v1/event?wait=5");
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));
    advanceTicks(clock, 20);
    const response = await pending;

    assert.equal(response.status, 200);
    assert.equal(eventListResponse.safeParse(response.body).success, true);
    assert.equal(Object.hasOwn(response.body, "error"), false);
    assert.equal(JSON.stringify(response.body), '{"events":[]}');
  });

  it("wait=5 with an event appended after two poll ticks answers with that event and cancels its timer", async () => {
    const clock = createFakeSchedule();
    let calls = 0;
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(
      () => {
        calls += 1;
        return calls <= 3 ? [] : [first];
      },
      { waits: registry },
    );
    const pending = app.get("/v1/event?wait=5");
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));
    advanceTicks(clock, 3);
    const response = await pending;

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [eventBody(first)] });
    assert.equal(calls, 4);
    assert.equal(clock.armed.length, 3);
    assert.equal(clock.armed[2]!.cancelCalls, 1);
    for (const entry of clock.armed) {
      assert.ok(entry.fired || entry.cancelCalls === 1);
    }
  });

  it("the cursor reaches the query unchanged on every poll", async () => {
    const clock = createFakeSchedule();
    const recorded: ListEventInput[] = [];
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(
      (input) => {
        recorded.push(input);
        return [];
      },
      { waits: registry },
    );
    const pending = app.get(`/v1/event?wait=5&after=${second.id}`);
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));
    advanceTicks(clock, 20);
    const response = await pending;

    assert.equal(response.status, 200);
    assert.equal(recorded.length, 21);
    for (const input of recorded) {
      assert.deepEqual(input, { after: second.id, limit: 100, order: "asc" });
      assert.equal("wait" in (input as object), false);
    }
  });

  it("a waited cursor delivers each event once and skips none", async () => {
    const clock = createFakeSchedule();
    const { registry, armedUpTo } = signalledRegistry(clock);
    const log: EventView[] = [first];
    const app = await handlerApp(
      (input) =>
        log.filter(
          (event) => input.after === undefined || event.id > input.after,
        ),
      { waits: registry },
    );
    const pending = app.get(`/v1/event?wait=5&after=${first.id}`);
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));
    log.push(second);
    clock.advanceBy(POLL_INTERVAL_MS);
    const matched = await pending;

    assert.equal(matched.status, 200);
    assert.deepEqual(matched.body, { events: [eventBody(second)] });

    const secondPending = app.get(`/v1/event?wait=5&after=${second.id}`);
    await assertRegisteredBeforeAnswered(secondPending, armedUpTo(2));
    advanceTicks(clock, 20);
    const elapsed = await secondPending;

    assert.equal(elapsed.status, 200);
    assert.deepEqual(elapsed.body, { events: [] });
  });

  it("order=desc under a wait answers at once in query order when rows exist", async () => {
    const clock = createFakeSchedule();
    const app = await handlerApp(() => [second, first], {
      waits: clockRegistry(clock),
    });
    const response = await app.get("/v1/event?wait=5&order=desc");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      events: [eventBody(second), eventBody(first)],
    });
    assert.equal(clock.armed.length, 0);
  });

  it("order=desc under a wait elapses empty and keeps desc on every poll input", async () => {
    const clock = createFakeSchedule();
    const recorded: ListEventInput[] = [];
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(
      (input) => {
        recorded.push(input);
        return [];
      },
      { waits: registry },
    );
    const pending = app.get("/v1/event?wait=5&order=desc");
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));
    advanceTicks(clock, 20);
    const response = await pending;

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
    assert.ok(recorded.length > 0);
    for (const input of recorded) {
      assert.equal(input.order, "desc");
    }
  });

  it("wait above the configured maximum answers 400 before any read", async () => {
    const clock = createFakeSchedule();
    let calls = 0;
    const app = await handlerApp(
      () => {
        calls += 1;
        return [];
      },
      { waits: clockRegistry(clock), maxWaitSeconds: 30 },
    );
    const response = await app.get("/v1/event?wait=45");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.equal(clock.armed.length, 0);
    assert.equal(calls, 0);
  });

  it("wait equal to the configured maximum is accepted and arms a timer", async () => {
    const clock = createFakeSchedule();
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(() => [], { waits: registry });
    const pending = app.get("/v1/event?wait=30");
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));

    assert.equal(clock.armed.length, 1);

    app.cancelWaits();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
  });

  it("wait=1 against a zero maximum answers 400", async () => {
    const app = await handlerApp(() => [], { maxWaitSeconds: 0 });
    const response = await app.get("/v1/event?wait=1");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
  });

  it("wait=0 against a zero maximum answers 200 at once", async () => {
    const app = await handlerApp(() => [], { maxWaitSeconds: 0 });
    const response = await app.get("/v1/event?wait=0");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
  });

  it("wait=-1 and wait=abc answer 400 at the schema", async () => {
    const app = await handlerApp(() => []);

    const negative = await app.get("/v1/event?wait=-1");
    assert.equal(negative.status, 400);
    assert.equal(negative.body.error.code, "invalid-request");

    const nonsense = await app.get("/v1/event?wait=abc");
    assert.equal(nonsense.status, 400);
    assert.equal(nonsense.body.error.code, "invalid-request");
  });

  it("a repeated wait parameter answers 400 naming wait", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?wait=1&wait=2");

    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "invalid-request");
    assert.ok(String(response.body.error.message).includes("wait"));
  });

  it("two waiting requests resolve independently by their own filters", async () => {
    const clock = createFakeSchedule();
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(
      (input) => {
        if (input.type !== "node.created") {
          return [];
        }
        return clock.now() >= POLL_INTERVAL_MS ? [first] : [];
      },
      { waits: registry },
    );
    const createdPending = app.get("/v1/event?wait=5&type=node.created");
    const blockedPending = app.get("/v1/event?wait=5&type=node.blocked");
    const createdSettled = createdPending.then(() => "answered" as const);
    const blockedSettled = blockedPending.then(() => "answered" as const);
    await assertRegisteredBeforeAnswered(
      Promise.race([createdSettled, blockedSettled]),
      armedUpTo(2),
    );

    assert.equal(clock.armed.length, 2);

    clock.advanceBy(POLL_INTERVAL_MS);
    const createdResponse = await createdPending;
    assert.equal(createdResponse.status, 200);
    assert.deepEqual(createdResponse.body, { events: [eventBody(first)] });

    await assertStillPending(blockedPending);
    for (let index = 0; index < 19; index += 1) {
      clock.advanceBy(POLL_INTERVAL_MS);
    }
    const blockedResponse = await blockedPending;
    assert.equal(blockedResponse.status, 200);
    assert.deepEqual(blockedResponse.body, { events: [] });
  });

  it("a cancelled wait answers an empty 200 without its timer firing", async () => {
    const clock = createFakeSchedule();
    const { registry, armedUpTo } = signalledRegistry(clock);
    const app = await handlerApp(() => [], { waits: registry });
    const pending = app.get("/v1/event?wait=30");
    await assertRegisteredBeforeAnswered(pending, armedUpTo(1));

    app.cancelWaits();
    const response = await pending;

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { events: [] });
    assert.equal(clock.now(), 0);
    assert.equal(clock.armed[0]!.cancelCalls, 1);
  });

  it("each request invokes the query once, and every held read belongs to that delegation", async () => {
    const clock = createFakeSchedule();
    let delegationActive = false;
    let reads = 0;
    let readsOutsideDelegation = 0;
    let deliverFromRead = Number.POSITIVE_INFINITY;

    const openScenario = async () => {
      const { registry, armedUpTo } = signalledRegistry(clock);
      const app = await handlerApp(
        () => {
          reads += 1;
          if (!delegationActive) readsOutsideDelegation += 1;
          return reads >= deliverFromRead ? [first] : [];
        },
        {
          waits: {
            wait: <T>(input: WaitInput<T>) => {
              delegationActive = true;
              return registry.wait(input);
            },
            cancelAll: () => registry.cancelAll(),
          },
        },
      );
      return { app, armedUpTo };
    };
    const assertOneQueryFlow = (path: string): void => {
      try {
        if (reads !== 1) {
          assert.equal(
            readsOutsideDelegation,
            0,
            `${path}: ${readsOutsideDelegation} of ${reads} query reads ran outside the request's wait delegation`,
          );
        }
      } finally {
        reads = 0;
        readsOutsideDelegation = 0;
        delegationActive = false;
      }
    };

    deliverFromRead = 1;
    const immediateScenario = await openScenario();
    const immediate = await immediateScenario.app.get("/v1/event?wait=5");
    assert.equal(immediate.status, 200);
    assert.deepEqual(immediate.body, { events: [eventBody(first)] });
    assertOneQueryFlow("the immediate answer");

    deliverFromRead = Number.POSITIVE_INFINITY;
    const elapsingScenario = await openScenario();
    const elapsing = elapsingScenario.app.get("/v1/event?wait=5");
    await assertRegisteredBeforeAnswered(
      elapsing,
      elapsingScenario.armedUpTo(1),
    );
    advanceTicks(clock, 20);
    const elapsed = await elapsing;
    assert.equal(elapsed.status, 200);
    assert.deepEqual(elapsed.body, { events: [] });
    assertOneQueryFlow("the elapsed wait");

    deliverFromRead = 4;
    const matchingScenario = await openScenario();
    const matching = matchingScenario.app.get("/v1/event?wait=5");
    await assertRegisteredBeforeAnswered(
      matching,
      matchingScenario.armedUpTo(1),
    );
    advanceTicks(clock, 3);
    const matched = await matching;
    assert.equal(matched.status, 200);
    assert.deepEqual(matched.body, { events: [eventBody(first)] });
    assertOneQueryFlow("the delivered wait");
  });

  it("wait 61 answers 400 at the schema", async () => {
    const app = await handlerApp(() => []);
    const response = await app.get("/v1/event?wait=61");

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
