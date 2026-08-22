import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { POLL_INTERVAL_MS, createWaitRegistry } from "./wait.ts";
import { createFakeSchedule } from "../../../../test/helpers/virtual-clock.ts";
import type { FakeSchedule } from "../../../../test/helpers/virtual-clock.ts";

type CountedRead = {
  read: () => readonly string[];
  callCount: () => number;
};

function countedRead(results: readonly (readonly string[])[]): CountedRead {
  let calls = 0;
  return {
    read: (): readonly string[] => {
      const result = results[calls];
      calls += 1;
      return result ?? [];
    },
    callCount: (): number => calls,
  };
}

function emptyRead(): CountedRead {
  return countedRead([]);
}

const SETTLE_TURNS = 4;

async function observeSettled(
  promise: Promise<readonly unknown[]>,
): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await Promise.resolve();
  }
  return settled;
}

async function assertPending(
  promise: Promise<readonly unknown[]>,
): Promise<void> {
  assert.equal(await observeSettled(promise), false);
}

async function assertSettled(
  promise: Promise<readonly unknown[]>,
): Promise<void> {
  assert.equal(await observeSettled(promise), true);
}

function createHarness(): {
  clock: FakeSchedule;
  registry: ReturnType<typeof createWaitRegistry>;
} {
  const clock = createFakeSchedule();
  const registry = createWaitRegistry({ schedule: clock.schedule });
  return { clock, registry };
}

function advanceTicks(clock: FakeSchedule, times: number): void {
  for (let index = 0; index < times; index += 1) {
    clock.advanceBy(POLL_INTERVAL_MS);
  }
}

describe("src/http/server/event/wait.test", () => {
  it("POLL_INTERVAL_MS is 250", () => {
    assert.equal(POLL_INTERVAL_MS, 250);
  });

  it("a zero second wait performs the start read, resolves empty and schedules nothing", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    const pending = registry.wait({ read: reader.read, waitSeconds: 0 });
    assert.deepEqual(await pending, []);
    assert.equal(clock.armed.length, 0);
    assert.equal(reader.callCount(), 1);
  });

  it("the start read runs at once and no tick runs before the interval", () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    void registry.wait({ read: reader.read, waitSeconds: 5 });
    assert.equal(reader.callCount(), 1);
    assert.equal(clock.armed.length, 1);
  });

  it("the first tick is due at the interval, not before it", () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    void registry.wait({ read: reader.read, waitSeconds: 5 });
    assert.equal(clock.armed[0]!.dueAt, 250);
    clock.advanceBy(249);
    assert.equal(reader.callCount(), 1);
    clock.advanceBy(1);
    assert.equal(reader.callCount(), 2);
  });

  it("a first read that returns rows resolves at once and arms no timer", async () => {
    const { clock, registry } = createHarness();
    const reader = countedRead([["a"]]);
    const pending = registry.wait({ read: reader.read, waitSeconds: 5 });
    await assertSettled(pending);
    assert.deepEqual(await pending, ["a"]);
    assert.equal(clock.armed.length, 0);
    assert.equal(reader.callCount(), 1);
  });

  it("a match on the first poll tick resolves with those rows and arms nothing further", async () => {
    const { clock, registry } = createHarness();
    const reader = countedRead([[], ["a"]]);
    const pending = registry.wait({ read: reader.read, waitSeconds: 5 });
    clock.advanceBy(POLL_INTERVAL_MS);
    await assertSettled(pending);
    assert.deepEqual(await pending, ["a"]);
    assert.equal(clock.armed.length, 1);
    for (const entry of clock.armed) {
      assert.ok(entry.fired || entry.cancelCalls === 1);
    }
  });

  it("a match cancels its outstanding timer exactly once", async () => {
    const { clock, registry } = createHarness();
    const reader = countedRead([[], ["a"]]);
    const pending = registry.wait({ read: reader.read, waitSeconds: 5 });
    clock.advanceBy(POLL_INTERVAL_MS);
    await assertSettled(pending);
    await pending;
    assert.equal(clock.armed[0]!.cancelCalls, 1);
  });

  it("a match on the third tick resolves with those rows after the start read and three polls", async () => {
    const { clock, registry } = createHarness();
    const reader = countedRead([[], [], [], ["a", "b"]]);
    const pending = registry.wait({ read: reader.read, waitSeconds: 5 });
    advanceTicks(clock, 3);
    await assertSettled(pending);
    assert.deepEqual(await pending, ["a", "b"]);
    assert.equal(reader.callCount(), 4);
    assert.equal(clock.armed.length, 3);
  });

  it("a five second wait with no events elapses empty after the start read and exactly twenty polls", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    const pending = registry.wait({ read: reader.read, waitSeconds: 5 });
    advanceTicks(clock, 19);
    await assertPending(pending);
    clock.advanceBy(POLL_INTERVAL_MS);
    assert.deepEqual(await pending, []);
    assert.equal(reader.callCount(), 21);
    assert.equal(clock.armed.length, 20);
  });

  it("no poll runs after the terminal one", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    const pending = registry.wait({ read: reader.read, waitSeconds: 5 });
    advanceTicks(clock, 20);
    assert.deepEqual(await pending, []);
    advanceTicks(clock, 2);
    assert.equal(reader.callCount(), 21);
    assert.equal(clock.armed.length, 20);
  });

  it("a one second wait is four polls after the start read", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    const pending = registry.wait({ read: reader.read, waitSeconds: 1 });
    advanceTicks(clock, 3);
    await assertPending(pending);
    clock.advanceBy(POLL_INTERVAL_MS);
    assert.deepEqual(await pending, []);
    assert.equal(reader.callCount(), 5);
    assert.equal(clock.armed.length, 4);
  });

  it("cancelAll resolves a pending wait empty and cancels its outstanding timer", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    const pending = registry.wait({ read: reader.read, waitSeconds: 30 });
    advanceTicks(clock, 2);
    registry.cancelAll();
    assert.deepEqual(await pending, []);
    const unFired = clock.armed.filter((entry) => !entry.fired);
    assert.equal(unFired.length, 1);
    assert.equal(unFired[0]!.cancelCalls, 1);
    for (const entry of clock.armed) {
      assert.ok(entry.fired || entry.cancelCalls >= 1);
    }
  });

  it("cancelAll resolves several waits in insertion order", async () => {
    const { registry } = createHarness();
    const order: string[] = [];
    const first = registry
      .wait({ read: emptyRead().read, waitSeconds: 30 })
      .then(() => {
        order.push("first");
      });
    const second = registry
      .wait({ read: emptyRead().read, waitSeconds: 30 })
      .then(() => {
        order.push("second");
      });
    const third = registry
      .wait({ read: emptyRead().read, waitSeconds: 30 })
      .then(() => {
        order.push("third");
      });
    registry.cancelAll();
    await Promise.all([first, second, third]);
    assert.deepEqual(order, ["first", "second", "third"]);
  });

  it("cancelAll with nothing pending does not throw", () => {
    const { clock, registry } = createHarness();
    registry.cancelAll();
    assert.equal(clock.armed.length, 0);
  });

  it("cancelAll after an elapse does not resolve twice", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    let resolutions = 0;
    const pending = registry
      .wait({ read: reader.read, waitSeconds: 5 })
      .then((rows) => {
        resolutions += 1;
        return rows;
      });
    advanceTicks(clock, 20);
    await pending;
    registry.cancelAll();
    assert.equal(resolutions, 1);
    assert.equal(clock.armed[19]!.fired, true);
    assert.equal(clock.armed[19]!.cancelCalls, 1);
  });

  it("a second cancelAll is a no-op and never moves a cancel past one", async () => {
    const { clock, registry } = createHarness();
    const reader = emptyRead();
    const pending = registry.wait({ read: reader.read, waitSeconds: 30 });
    advanceTicks(clock, 2);
    registry.cancelAll();
    registry.cancelAll();
    await pending;
    for (const entry of clock.armed) {
      assert.ok(entry.fired || entry.cancelCalls === 1);
      assert.ok(entry.cancelCalls <= 1);
    }
  });

  it("an elapsed wait plus a cancelled wait leaves no leak", async () => {
    const { clock, registry } = createHarness();
    const elapsedReader = emptyRead();
    const cancelledReader = emptyRead();
    const elapsed = registry.wait({
      read: elapsedReader.read,
      waitSeconds: 1,
    });
    const cancelled = registry.wait({
      read: cancelledReader.read,
      waitSeconds: 30,
    });
    advanceTicks(clock, 4);
    await elapsed;
    registry.cancelAll();
    await Promise.all([elapsed, cancelled]);
    for (const entry of clock.armed) {
      assert.ok(entry.fired || entry.cancelCalls === 1);
    }
  });

  it("a throwing start read rejects that one wait's promise, arms nothing and leaves the registry usable", async () => {
    const { clock, registry } = createHarness();
    const failingRead = (): readonly string[] => {
      throw new Error("start read failed");
    };
    const pending = registry.wait({ read: failingRead, waitSeconds: 5 });
    await assertSettled(pending);
    await assert.rejects(pending, { message: "start read failed" });
    assert.equal(clock.armed.length, 0);
    const nextReader = countedRead([["x"]]);
    const next = registry.wait({ read: nextReader.read, waitSeconds: 5 });
    assert.deepEqual(await next, ["x"]);
  });

  it("a throwing poll read rejects that one wait and cleans up its timer", async () => {
    const { clock, registry } = createHarness();
    let calls = 0;
    const read = (): readonly string[] => {
      calls += 1;
      if (calls >= 2) throw new Error("read failed");
      return [];
    };
    const pending = registry.wait({ read, waitSeconds: 5 });
    clock.advanceBy(POLL_INTERVAL_MS);
    await assertSettled(pending);
    await assert.rejects(pending, { message: "read failed" });
    assert.equal(clock.armed[0]!.cancelCalls, 1);
    const nextReader = countedRead([["x"]]);
    const next = registry.wait({ read: nextReader.read, waitSeconds: 5 });
    assert.deepEqual(await next, ["x"]);
  });

  it("two waits advance together and stay independent", async () => {
    const { clock, registry } = createHarness();
    const matchingReader = countedRead([[], ["a"]]);
    const quietReader = emptyRead();
    const matching = registry.wait({
      read: matchingReader.read,
      waitSeconds: 30,
    });
    const quiet = registry.wait({ read: quietReader.read, waitSeconds: 30 });
    clock.advanceBy(POLL_INTERVAL_MS);
    await assertSettled(matching);
    assert.deepEqual(await matching, ["a"]);
    await assertPending(quiet);
    assert.equal(quietReader.callCount(), 2);
    registry.cancelAll();
    assert.deepEqual(await quiet, []);
  });

  it("the waiter source names no wall-clock function", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./wait.ts"),
      "utf8",
    );
    for (const banned of [
      "setTimeout",
      "setInterval",
      "Date.now",
      "performance.now",
    ]) {
      assert.equal(
        source.includes(banned),
        false,
        `the waiter must not name ${banned}`,
      );
    }
  });
});
