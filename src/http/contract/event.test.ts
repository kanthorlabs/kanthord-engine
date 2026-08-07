import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventListRequest, eventListResponse, eventView } from "./event.ts";

describe("src/http/contract/event.test", () => {
  it("defaults limit to 100 and after to null on an empty request", () => {
    const parsed = eventListRequest.parse({});
    assert.equal(parsed.limit, 100);
    assert.equal(parsed.after, null);
  });

  it("rejects limit 501", () => {
    assert.throws(() => eventListRequest.parse({ limit: 501 }));
  });

  it("rejects wait", () => {
    assert.throws(() => eventListRequest.parse({ wait: 5 }));
  });

  it("rejects an unknown actorKind", () => {
    assert.throws(() => eventListRequest.parse({ actorKind: "robot" }));
  });

  it("accepts actorKind human", () => {
    assert.equal(
      eventListRequest.parse({ actorKind: "human" }).actorKind,
      "human",
    );
  });

  it("rejects a repeated-parameter limit array", () => {
    assert.throws(() => eventListRequest.parse({ limit: ["1", "2"] }));
  });

  it("rejects an empty after", () => {
    assert.throws(() => eventListRequest.parse({ after: "" }));
  });

  it("has exactly the expected keys", () => {
    const parsed = eventListRequest.parse({});
    assert.deepEqual(Object.keys(parsed).sort(), [
      "actor",
      "actorKind",
      "after",
      "limit",
      "subject",
      "subjectKind",
      "type",
    ]);
  });

  it("eventListResponse parses an empty events list", () => {
    assert.equal(eventListResponse.safeParse({ events: [] }).success, true);
  });

  it("eventListResponse rejects a nextAfter field", () => {
    assert.equal(
      eventListResponse.safeParse({ events: [], nextAfter: "x" }).success,
      false,
    );
  });

  it("eventView rejects an unknown key", () => {
    const validEvent = {
      id: "event_01",
      type: "transition",
      subjectKind: "node",
      subjectId: "node_01",
      actorKind: "human" as const,
      actorId: "user-1",
      payload: {},
      createdAt: 1,
    };
    assert.equal(
      eventView.safeParse({ ...validEvent, extra: 1 }).success,
      false,
    );
  });

  it("eventView requires createdAt and rejects a non-integer", () => {
    const validEvent = {
      id: "event_01",
      type: "transition",
      subjectKind: "node",
      subjectId: "node_01",
      actorKind: "human" as const,
      actorId: "user-1",
      payload: {},
      createdAt: 1,
    };
    const withoutCreatedAt = { ...validEvent } as Record<string, unknown>;
    delete withoutCreatedAt.createdAt;
    assert.equal(eventView.safeParse(withoutCreatedAt).success, false);
    assert.equal(
      eventView.safeParse({ ...validEvent, createdAt: 1.5 }).success,
      false,
    );
  });

  it("eventListResponse has exactly one key, events", () => {
    assert.deepEqual(Object.keys(eventListResponse.shape), ["events"]);
  });
});
