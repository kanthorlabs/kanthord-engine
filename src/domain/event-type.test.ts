import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventTypes, retiredEventTypes } from "./event-type.ts";

describe("src/domain/event-type.test", () => {
  it("eventTypes is sorted bytewise", () => {
    for (let i = 1; i < eventTypes.length; i++) {
      const previous = eventTypes[i - 1] as string;
      const current = eventTypes[i] as string;
      const result = Buffer.compare(
        Buffer.from(previous, "utf8"),
        Buffer.from(current, "utf8"),
      );
      assert.equal(result, -1, `${previous} should sort before ${current}`);
    }
  });

  it("eventTypes holds no duplicate", () => {
    assert.equal(new Set(eventTypes).size, eventTypes.length);
  });

  it("every member is a non-empty dotted name", () => {
    const shape = /^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/;
    for (const type of eventTypes) {
      assert.match(type, shape);
    }
  });

  it("retiredEventTypes is a subset of eventTypes", () => {
    assert.equal(new Set(retiredEventTypes).size, retiredEventTypes.length);
    for (const type of retiredEventTypes) {
      assert.ok(
        (eventTypes as readonly string[]).includes(type),
        `${type} is not a member of eventTypes`,
      );
    }
  });

  it("the six types of this epic are present", () => {
    for (const type of [
      "outcome.reported",
      "node.awaitingApproval",
      "node.done",
      "node.partial",
      "node.discarded",
      "node.unblocked",
    ]) {
      assert.ok(
        (eventTypes as readonly string[]).includes(type),
        `${type} is missing from eventTypes`,
      );
    }
  });

  it("lease.renewed is absent from eventTypes and run.renewed is present", () => {
    assert.equal(
      (eventTypes as readonly string[]).includes("lease.renewed"),
      false,
    );
    assert.equal(
      (eventTypes as readonly string[]).includes("run.renewed"),
      true,
    );
    assert.equal(eventTypes.length, 39);
    for (let i = 1; i < eventTypes.length; i++) {
      const previous = eventTypes[i - 1] as string;
      const current = eventTypes[i] as string;
      assert.equal(
        Buffer.compare(
          Buffer.from(previous, "utf8"),
          Buffer.from(current, "utf8"),
        ),
        -1,
        `${previous} should sort before ${current}`,
      );
    }
  });

  it("lease.released is absent from eventTypes and run.ended is present", () => {
    assert.equal(
      (eventTypes as readonly string[]).includes("lease.released"),
      false,
    );
    assert.equal((eventTypes as readonly string[]).includes("run.ended"), true);
    assert.equal(eventTypes.length, 39);
    assert.deepEqual(retiredEventTypes, []);
    assert.deepEqual(
      eventTypes,
      [...eventTypes].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right)),
      ),
    );
  });
});
