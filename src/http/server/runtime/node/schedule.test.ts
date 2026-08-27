import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { systemSchedule } from "./schedule.ts";

describe("src/http/server/runtime/node/schedule.test", () => {
  it("runs its callback at the delay and not before", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;

    systemSchedule(1000, () => {
      calls += 1;
    });

    t.mock.timers.tick(999);
    assert.equal(calls, 0);
    t.mock.timers.tick(1);
    assert.equal(calls, 1);
  });

  it("the returned canceller stops the callback", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let calls = 0;

    const cancel = systemSchedule(1000, () => {
      calls += 1;
    });
    cancel();

    t.mock.timers.tick(5000);
    assert.equal(calls, 0);
  });

  it("unrefs the timer", (t) => {
    const stub = { unref: t.mock.fn() };
    t.mock.method(
      globalThis,
      "setTimeout",
      () => stub as unknown as ReturnType<typeof setTimeout>,
    );

    systemSchedule(1000, () => {});

    assert.equal(stub.unref.mock.callCount(), 1);
  });
});
