import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createMockClock } from "./clock.ts";

describe("test/helpers/clock.test", () => {
  it("three calls with no step return start every time", () => {
    const clock = createMockClock({ start: 1000 });
    assert.equal(clock.now(), 1000);
    assert.equal(clock.now(), 1000);
    assert.equal(clock.now(), 1000);
  });

  it("three calls with step 5 return start, start+5, start+10", () => {
    const clock = createMockClock({ start: 1000, step: 5 });
    assert.equal(clock.now(), 1000);
    assert.equal(clock.now(), 1005);
    assert.equal(clock.now(), 1010);
  });
});
