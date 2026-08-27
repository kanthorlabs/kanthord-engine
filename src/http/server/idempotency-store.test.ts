import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  IdempotencyStore,
  defaultIdempotencySettings,
} from "./idempotency-store.ts";
import type {
  Schedule,
  JoinOutcome,
  ReserveResult,
} from "./idempotency-store.ts";
import type { StoredAnswer } from "./idempotency-response.ts";

type Fired = { at: number; run: () => void; cancelled: boolean };
const armed: Fired[] = [];
const schedule: Schedule = (at, run) => {
  const entry: Fired = { at, run, cancelled: false };
  armed.push(entry);
  return () => {
    entry.cancelled = true;
  };
};
const fireAll = (): void => {
  for (const entry of armed.splice(0)) {
    if (!entry.cancelled) entry.run();
  }
};

function makeAnswer(status: number, tag: string): StoredAnswer {
  return { status, body: JSON.stringify({ tag }), headers: [] };
}

function storedBodyBytes(body: StoredAnswer["body"]): number {
  if (typeof body === "string") return Buffer.byteLength(body, "utf8");
  if (body === null) return 0;
  return body.byteLength;
}

function serializedHeadersBytes(headers: StoredAnswer["headers"]): number {
  return Buffer.byteLength(JSON.stringify(headers), "utf8");
}

function newStore(overrides?: Partial<typeof defaultIdempotencySettings>) {
  return new IdempotencyStore({
    settings: { ...defaultIdempotencySettings, ...overrides },
    now: () => 1_000,
    schedule,
  });
}

function reservedSettle(
  result: ReserveResult,
): (
  answer: StoredAnswer,
  state: "replayable" | "indeterminate" | "uncacheable",
) => void {
  assert.equal(result.kind, "reserved");
  return (
    result as {
      kind: "reserved";
      settle: (
        a: StoredAnswer,
        s: "replayable" | "indeterminate" | "uncacheable",
      ) => void;
    }
  ).settle;
}

function joinedOutcome(result: ReserveResult): Promise<JoinOutcome> {
  assert.equal(result.kind, "joined");
  return (result as { kind: "joined"; outcome: Promise<JoinOutcome> }).outcome;
}

describe("src/http/server/idempotency-store.test", () => {
  beforeEach(() => {
    armed.length = 0;
  });

  it("a first reserve is reserved, and size() becomes 1", () => {
    const store = newStore();
    const result = store.reserve("k1", "f1");
    assert.equal(result.kind, "reserved");
    assert.equal(store.size(), 1);
  });

  it("a second reserve of the same key while in flight is joined, and size() stays 1", () => {
    const store = newStore();
    store.reserve("k1", "f1");
    const second = store.reserve("k1", "f1");
    assert.equal(second.kind, "joined");
    assert.equal(store.size(), 1);
  });

  it("a second reserve with a different fingerprint while in flight is mismatch, and size() stays 1", () => {
    const store = newStore();
    store.reserve("k1", "f1");
    const second = store.reserve("k1", "f2");
    assert.equal(second.kind, "mismatch");
    assert.equal(store.size(), 1);
  });

  it("after a replayable settle, a same-fingerprint reserve is replay with the identical answer", () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const answer = makeAnswer(200, "a");
    settle(answer, "replayable");
    const replay = store.reserve("k1", "f1");
    assert.equal(replay.kind, "replay");
    assert.deepEqual(
      (replay as { kind: "replay"; answer: StoredAnswer }).answer,
      answer,
    );
  });

  it("after an indeterminate settle, a same-fingerprint reserve is replay with the settled answer", () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const answer = makeAnswer(500, "b");
    settle(answer, "indeterminate");
    const replay = store.reserve("k1", "f1");
    assert.equal(replay.kind, "replay");
    assert.deepEqual(
      (replay as { kind: "replay"; answer: StoredAnswer }).answer,
      answer,
    );
  });

  it("after an uncacheable settle, size() is 0 and a new reserve of that key is reserved", () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    settle(makeAnswer(409, "c"), "uncacheable");
    assert.equal(store.size(), 0);
    const again = store.reserve("k1", "f1");
    assert.equal(again.kind, "reserved");
  });

  it("a joiner receives the settled answer", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const second = store.reserve("k1", "f1");
    const outcome = joinedOutcome(second);
    const answer = makeAnswer(200, "d");
    settle(answer, "replayable");
    assert.deepEqual(await outcome, { kind: "answer", answer });
  });

  it("a joiner receives the answer even when it is uncacheable", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const second = store.reserve("k1", "f1");
    const outcome = joinedOutcome(second);
    const answer = makeAnswer(409, "e");
    settle(answer, "uncacheable");
    assert.deepEqual(await outcome, { kind: "answer", answer });
    assert.equal(store.size(), 0);
  });

  it("two joiners both receive the answer, on a replayable settle", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const outcomeA = joinedOutcome(store.reserve("k1", "f1"));
    const outcomeB = joinedOutcome(store.reserve("k1", "f1"));
    const answer = makeAnswer(200, "f");
    settle(answer, "replayable");
    assert.deepEqual(await outcomeA, { kind: "answer", answer });
    assert.deepEqual(await outcomeB, { kind: "answer", answer });
  });

  it("two joiners both receive the answer, on an uncacheable settle", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const outcomeA = joinedOutcome(store.reserve("k1", "f1"));
    const outcomeB = joinedOutcome(store.reserve("k1", "f1"));
    const answer = makeAnswer(409, "g");
    settle(answer, "uncacheable");
    assert.deepEqual(await outcomeA, { kind: "answer", answer });
    assert.deepEqual(await outcomeB, { kind: "answer", answer });
  });

  it("waiters counts joiners, and settle drains them", () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    store.reserve("k1", "f1");
    store.reserve("k1", "f1");
    assert.equal(store.waiters("k1"), 2);
    settle(makeAnswer(200, "h"), "replayable");
    assert.equal(store.waiters("k1"), 0);
  });

  it("a join arms one timer, and an answer cancels it", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const outcome = joinedOutcome(store.reserve("k1", "f1"));
    assert.equal(armed.length, 1);
    const answer = makeAnswer(200, "i");
    settle(answer, "replayable");
    assert.equal(armed[0]?.cancelled, true);
    fireAll();
    assert.deepEqual(await outcome, { kind: "answer", answer });
  });

  it("a timed-out join answers timeout, and the reservation still stands", async () => {
    const store = newStore();
    store.reserve("k1", "f1");
    const outcome = joinedOutcome(store.reserve("k1", "f1"));
    fireAll();
    assert.deepEqual(await outcome, { kind: "timeout" });
    assert.equal(store.waiters("k1"), 0);
    assert.equal(store.size(), 1);
  });

  it("a timeout does not disturb the original or a later joiner", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const timedOut = joinedOutcome(store.reserve("k1", "f1"));
    fireAll();
    assert.deepEqual(await timedOut, { kind: "timeout" });

    const second = joinedOutcome(store.reserve("k1", "f1"));
    const answer = makeAnswer(200, "j");
    settle(answer, "replayable");
    assert.deepEqual(await second, { kind: "answer", answer });

    const replay = store.reserve("k1", "f1");
    assert.equal(replay.kind, "replay");
    assert.deepEqual(
      (replay as { kind: "replay"; answer: StoredAnswer }).answer,
      answer,
    );
  });

  it("a settle after a timeout resolves nobody twice and does not throw", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const timedOut = joinedOutcome(store.reserve("k1", "f1"));
    fireAll();
    assert.deepEqual(await timedOut, { kind: "timeout" });
    assert.doesNotThrow(() => settle(makeAnswer(200, "k"), "replayable"));
    assert.deepEqual(await timedOut, { kind: "timeout" });
  });

  it("the timer is armed with the configured delay", () => {
    const store = newStore({ joinTimeoutSeconds: 30 });
    store.reserve("k1", "f1");
    store.reserve("k1", "f1");
    assert.equal(armed.length, 1);
    assert.equal(armed[0]?.at, 30_000);
  });

  it("a zero join timeout arms nothing", async () => {
    const store = newStore({ joinTimeoutSeconds: 0 });
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const outcome = joinedOutcome(store.reserve("k1", "f1"));
    assert.equal(armed.length, 0);
    const answer = makeAnswer(200, "l");
    settle(answer, "replayable");
    assert.deepEqual(await outcome, { kind: "answer", answer });
  });

  it("a stale settle closure cannot settle a later record", async () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const staleSettle = reservedSettle(first);
    staleSettle(makeAnswer(409, "m"), "uncacheable");

    const fresh = store.reserve("k1", "f1");
    assert.equal(fresh.kind, "reserved");
    const freshSettle = reservedSettle(fresh);

    assert.doesNotThrow(() =>
      staleSettle(makeAnswer(200, "stale"), "replayable"),
    );

    const outcome = joinedOutcome(store.reserve("k1", "f1"));
    const answer = makeAnswer(200, "second");
    freshSettle(answer, "replayable");
    assert.deepEqual(await outcome, { kind: "answer", answer });

    const replay = store.reserve("k1", "f1");
    assert.equal(replay.kind, "replay");
    assert.deepEqual(
      (replay as { kind: "replay"; answer: StoredAnswer }).answer,
      answer,
    );
  });

  describe("settlement byte deltas", () => {
    const cases: ReadonlyArray<{
      readonly name: string;
      readonly body: StoredAnswer["body"];
      readonly expectDelta: number;
    }> = [
      {
        name: "settling a UTF-8 two-byte string body adds exactly 4 bytes",
        body: "é",
        expectDelta: 4,
      },
      {
        name: "settling a three-byte Uint8Array body adds exactly 5 bytes",
        body: Uint8Array.from([0x00, 0x80, 0xff]),
        expectDelta: 5,
      },
      {
        name: "settling a null body adds exactly 2 bytes",
        body: null,
        expectDelta: 2,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        const store = newStore();
        const settle = reservedSettle(store.reserve("k1", "f1"));
        const before = store.bytes();
        settle({ status: 200, body: testCase.body, headers: [] }, "replayable");
        assert.equal(store.bytes() - before, testCase.expectDelta);
      });
    }
  });

  it("after a completed settle with a different fingerprint, the reserve is mismatch", () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    settle(makeAnswer(200, "n"), "replayable");
    const result = store.reserve("k1", "f2");
    assert.equal(result.kind, "mismatch");
  });

  it("two different record keys are two records", () => {
    const store = newStore();
    store.reserve("k1", "f1");
    store.reserve("k2", "f1");
    assert.equal(store.size(), 2);
  });

  it("a second settle on the same reservation changes nothing", () => {
    const store = newStore();
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const answer = makeAnswer(200, "o");
    settle(answer, "replayable");
    settle(makeAnswer(200, "other"), "replayable");
    const replay = store.reserve("k1", "f1");
    assert.equal(replay.kind, "replay");
    assert.deepEqual(
      (replay as { kind: "replay"; answer: StoredAnswer }).answer,
      answer,
    );
  });

  it("expiresAt uses the injected clock", () => {
    const store = newStore({ ttlSeconds: 300 });
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    settle(makeAnswer(200, "p"), "replayable");
    const replay = store.reserve("k1", "f1");
    assert.equal(replay.kind, "replay");
  });

  it("bytes() grows on settle by exactly the serialized answer size", () => {
    const store = newStore();
    const before = store.bytes();
    const first = store.reserve("k1", "f1");
    const afterReserve = store.bytes();
    const settle = reservedSettle(first);
    const answer = makeAnswer(200, "q");
    settle(answer, "replayable");
    const afterSettle = store.bytes();
    const expectedDelta =
      storedBodyBytes(answer.body) + serializedHeadersBytes(answer.headers);
    assert.ok(afterSettle > afterReserve);
    assert.ok(afterReserve >= before);
    assert.equal(afterSettle - afterReserve, expectedDelta);
  });

  it("the TTL starts at completion, not at reserve", () => {
    let now = 1_000;
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, ttlSeconds: 300 },
      now: () => now,
      schedule,
    });
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    now = 500_000;
    settle(makeAnswer(200, "a"), "replayable");
    now = 799_999;
    assert.equal(store.reserve("k1", "f1").kind, "replay");
    now = 800_000;
    assert.equal(store.reserve("k1", "f1").kind, "reserved");
  });

  it("the expiry boundary is inclusive: expiresAt <= now means expired", () => {
    let now = 1_000;
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, ttlSeconds: 300 },
      now: () => now,
      schedule,
    });
    const first = store.reserve("k1", "f1");
    reservedSettle(first)(makeAnswer(200, "a"), "replayable");
    now = 300_999;
    assert.equal(store.reserve("k1", "f1").kind, "replay");
    now = 301_000;
    assert.equal(store.reserve("k1", "f1").kind, "reserved");
  });

  it("an in-flight record survives a sweep however far the clock moves", () => {
    let now = 1_000;
    const store = new IdempotencyStore({
      settings: defaultIdempotencySettings,
      now: () => now,
      schedule,
    });
    store.reserve("k1", "f1");
    now = 1_000_000_000;
    const second = store.reserve("k1", "f1");
    assert.equal(second.kind, "joined");
    assert.equal(store.size(), 1);
  });

  it("an in-flight record survives an eviction pass", () => {
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxEntries: 1 },
      now: () => 1_000,
      schedule,
    });
    store.reserve("k1", "f1");
    const second = store.reserve("k2", "f1");
    assert.equal(second.kind, "saturated");
    assert.equal(store.size(), 1);
    assert.equal(store.reserve("k1", "f1").kind, "joined");
  });

  it("a completed record is evicted to make room for a new one", () => {
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxEntries: 1 },
      now: () => 1_000,
      schedule,
    });
    const first = store.reserve("k1", "f1");
    reservedSettle(first)(makeAnswer(200, "a"), "replayable");
    const second = store.reserve("k2", "f1");
    assert.equal(second.kind, "reserved");
    assert.equal(store.size(), 1);
    reservedSettle(second)(makeAnswer(200, "b"), "replayable");
    assert.equal(store.reserve("k1", "f1").kind, "reserved");
  });

  it("eviction order is ascending expiresAt", () => {
    let now = 1_000;
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxEntries: 3 },
      now: () => now,
      schedule,
    });
    const r1 = store.reserve("k1", "f1");
    now = 1_000;
    reservedSettle(r1)(makeAnswer(200, "1"), "replayable");
    const r2 = store.reserve("k2", "f1");
    now = 3_000;
    reservedSettle(r2)(makeAnswer(200, "2"), "replayable");
    const r3 = store.reserve("k3", "f1");
    now = 2_000;
    reservedSettle(r3)(makeAnswer(200, "3"), "replayable");
    store.reserve("k4", "f1");
    assert.equal(store.reserve("k2", "f1").kind, "replay");
    assert.equal(store.reserve("k3", "f1").kind, "replay");
    assert.equal(store.reserve("k1", "f1").kind, "reserved");
  });

  it("the eviction tie-break is ascending seq", () => {
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxEntries: 2 },
      now: () => 1_000,
      schedule,
    });
    const r1 = store.reserve("k1", "f1");
    const r2 = store.reserve("k2", "f1");
    reservedSettle(r1)(makeAnswer(200, "1"), "replayable");
    reservedSettle(r2)(makeAnswer(200, "2"), "replayable");
    store.reserve("k3", "f1");
    assert.equal(store.reserve("k2", "f1").kind, "replay");
    assert.equal(store.reserve("k1", "f1").kind, "reserved");
  });

  it("the byte bound evicts a completed record too", () => {
    const answer = makeAnswer(200, "1");
    const answerCost =
      storedBodyBytes(answer.body) + serializedHeadersBytes(answer.headers);
    const recordOverhead =
      Buffer.byteLength("k1", "utf8") + Buffer.byteLength("f1", "utf8");
    const store = new IdempotencyStore({
      settings: {
        ...defaultIdempotencySettings,
        maxEntries: 100,
        maxBytes: recordOverhead + answerCost,
      },
      now: () => 1_000,
      schedule,
    });
    const first = store.reserve("k1", "f1");
    reservedSettle(first)(makeAnswer(200, "1"), "replayable");
    const second = store.reserve("k2", "f1");
    reservedSettle(second)(makeAnswer(200, "2"), "replayable");
    assert.equal(store.size(), 1);
    assert.equal(store.reserve("k1", "f1").kind, "reserved");
    assert.ok(store.bytes() <= answerCost);
  });

  it("bytes() never exceeds maxBytes right after a reserve, once the fingerprint is counted", () => {
    const fingerprint = "a".repeat(64);
    const maxBytes = 10; // room for the record key alone, not the fingerprint too
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxBytes },
      now: () => 1_000,
      schedule,
    });
    store.reserve("k1", fingerprint);
    assert.ok(
      store.bytes() <= maxBytes,
      `store.bytes() (${store.bytes()}) exceeded maxBytes (${maxBytes})`,
    );
  });

  it("an answer too large to retain is not retained, and its waiter still receives it", async () => {
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxBytes: 64 },
      now: () => 1_000,
      schedule,
    });
    const first = store.reserve("k1", "f1");
    const settle = reservedSettle(first);
    const outcome = joinedOutcome(store.reserve("k1", "f1"));
    const answer: StoredAnswer = {
      status: 200,
      body: "x".repeat(4096),
      headers: [],
    };
    settle(answer, "replayable");
    assert.deepEqual(await outcome, { kind: "answer", answer });
    assert.equal(store.size(), 0);
    assert.equal(store.bytes(), 0);
  });

  it("ten settles of a large answer under a small maxBytes stay within the bound", () => {
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxBytes: 1024 },
      now: () => 1_000,
      schedule,
    });
    for (let i = 0; i < 10; i += 1) {
      const result = store.reserve(`k${i}`, "f1");
      reservedSettle(result)(
        { status: 200, body: "x".repeat(2048), headers: [] },
        "replayable",
      );
      assert.ok(store.bytes() <= 1024);
      assert.ok(store.size() <= 1);
    }
  });

  it("a saturated store keeps every in-flight reservation", () => {
    const store = new IdempotencyStore({
      settings: { ...defaultIdempotencySettings, maxEntries: 2 },
      now: () => 1_000,
      schedule,
    });
    store.reserve("k1", "f1");
    store.reserve("k2", "f1");
    const third = store.reserve("k3", "f1");
    assert.equal(third.kind, "saturated");
    assert.equal(store.size(), 2);
    assert.equal(store.reserve("k1", "f1").kind, "joined");
    assert.equal(store.reserve("k2", "f1").kind, "joined");
  });

  it("sweeping frees capacity for a new reservation", () => {
    let now = 1_000;
    const store = new IdempotencyStore({
      settings: {
        ...defaultIdempotencySettings,
        maxEntries: 1,
        ttlSeconds: 300,
      },
      now: () => now,
      schedule,
    });
    const first = store.reserve("k1", "f1");
    reservedSettle(first)(makeAnswer(200, "a"), "replayable");
    now = 301_000;
    const second = store.reserve("k2", "f1");
    assert.equal(second.kind, "reserved");
    assert.equal(store.size(), 1);
  });
});
