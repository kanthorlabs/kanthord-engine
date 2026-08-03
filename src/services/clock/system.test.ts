import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { SystemClock } from "./system.ts";

describe("src/services/clock/system.test", () => {
  it("now() returns an integer", () => {
    const clock = new SystemClock();
    assert.ok(Number.isInteger(clock.now()));
  });
});
