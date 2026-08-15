import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventRow, eventActorKinds } from "./event.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";

describe("src/domain/event.test", () => {
  const validRow = {
    id: "event_" + ULID_A,
    subjectKind: "node",
    subjectId: "objective_" + ULID_A,
    type: "transition",
    actorKind: "human" as const,
    actorId: "user-1",
    payloadJson: "{}",
  };

  it("accepts a valid row", () => {
    assert.equal(eventRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        eventRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      eventRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("accepts actorKind human", () => {
    assert.equal(
      eventRow.safeParse({ ...validRow, actorKind: "human" }).success,
      true,
    );
  });

  it("accepts actorKind daemon", () => {
    assert.equal(
      eventRow.safeParse({ ...validRow, actorKind: "daemon" }).success,
      true,
    );
  });

  it("eventActorKinds deep-equals human, daemon, harness in that order", () => {
    assert.deepEqual(eventActorKinds, ["human", "daemon", "harness"]);
  });

  it("accepts actorKind harness", () => {
    assert.equal(
      eventRow.safeParse({ ...validRow, actorKind: "harness" }).success,
      true,
    );
  });

  it("rejects invalid actorKind", () => {
    assert.equal(
      eventRow.safeParse({ ...validRow, actorKind: "invalid" }).success,
      false,
    );
  });
});
