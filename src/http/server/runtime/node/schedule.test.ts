import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { systemSchedule } from "./schedule.ts";

describe("src/http/server/runtime/node/schedule.test", () => {
  it("systemSchedule runs its callback at the delay and not before", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    systemSchedule(1000, () => {
      calls += 1;
    });
    await t.mock.timers.tick(999);
    assert.equal(calls, 0);
    await t.mock.timers.tick(1);
    assert.equal(calls, 1);
  });

  it("the returned canceller stops the callback", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;
    const cancel = systemSchedule(1000, () => {
      calls += 1;
    });
    cancel();
    await t.mock.timers.tick(5000);
    assert.equal(calls, 0);
  });

  it("systemSchedule unrefs the timer", async (t) => {
    const stub = { unref: t.mock.fn() };
    const mocked = t.mock.method(
      globalThis,
      "setTimeout",
      () => stub as unknown as NodeJS.Timeout,
    );
    systemSchedule(1000, () => {});
    assert.equal(stub.unref.mock.callCount(), 1);
    mocked.mock.restore();
  });
});
