import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { listEvents } from "./list-event.ts";
import type { EventView, ListEventInput } from "./list-event.ts";
import type { EventFilter, EventLog } from "../../services/event/index.ts";

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

function makeMock(result: readonly EventView[]): {
  events: EventLog;
  calls: { filter: EventFilter; transaction: unknown }[];
} {
  const calls: { filter: EventFilter; transaction: unknown }[] = [];
  const events: EventLog = {
    append: () => {
      throw new Error("append must not be called");
    },
    list: (filter, transaction) => {
      calls.push({ filter, transaction });
      return result;
    },
  };
  return { events, calls };
}

describe("src/queries/event/list-event.test", () => {
  it("forwards every field byte for byte", () => {
    const { events, calls } = makeMock([first, second]);
    const input: ListEventInput = {
      subjectKind: "node",
      subject: "node_01HZY8QF3M4N5P6R7S8T9V0W1B",
      type: "node.created",
      actorKind: "daemon",
      actor: "d1",
      after: "event_01HZY8QF3M4N5P6R7S8T9V0W1A",
      limit: 25,
    };

    listEvents({ events }, input);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.filter, input);
  });

  it("forwards only what a sparse input carries", () => {
    const { events, calls } = makeMock([]);
    listEvents({ events }, { limit: 100 });

    assert.deepEqual(calls[0]?.filter, { limit: 100 });
  });

  it("returns the result by identity", () => {
    const result = [first, second];
    const { events } = makeMock(result);

    assert.strictEqual(listEvents({ events }, { limit: 100 }), result);
  });

  it("returns an empty array, not null", () => {
    const { events } = makeMock([]);
    assert.deepEqual(listEvents({ events }, { limit: 100 }), []);
  });

  it("calls list with no transaction", () => {
    const { events, calls } = makeMock([]);
    listEvents({ events }, { limit: 100 });

    assert.equal(calls[0]?.transaction, undefined);
  });
});
