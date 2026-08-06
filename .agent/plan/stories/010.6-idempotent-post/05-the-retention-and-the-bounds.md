# Story 5 — The retention and the bounds

Epic: `.agent/plan/epics/010.6-idempotent-post.md`
Depends on: Story 4.

Story 4 built the store with no expiry and no bound. This story adds both to the same file.

## Change

### 1. `src/http/server/idempotency-store.ts` — the sweep

Add a private method and call it as the **first** statement of `reserve`, before the lookup:

```ts
  private sweep(): void {
    const now = this.now();
    for (const [key, record] of this.records) {
      if (record.expiresAt !== null && record.expiresAt <= now) {
        this.records.delete(key);
        this.totalBytes -= record.bytes;
      }
    }
  }
```

The guard `record.expiresAt !== null` is the whole guarantee of this story. An in-flight record has
`expiresAt === null` and is never swept, however far the clock has moved. Expiring a reservation
would let a duplicate miss and both commands run.

The comparison is `<=`, so a record whose `expiresAt` equals the current instant is gone.

### 2. `src/http/server/idempotency-store.ts` — the bound and the eviction

Add `{ kind: "saturated" }` to the `ReserveResult` union, after `"mismatch"`:

```ts
  | Readonly<{ kind: "saturated" }>;
```

Add a private method:

```ts
  private makeRoom(incoming: number): boolean {
    for (;;) {
      const overEntries = this.records.size + 1 > this.settings.maxEntries;
      const overBytes = this.totalBytes + incoming > this.settings.maxBytes;
      if (!overEntries && !overBytes) {
        return true;
      }
      const victim = this.oldestCompleted();
      if (victim === null) {
        return false;
      }
      const record = this.records.get(victim);
      this.records.delete(victim);
      this.totalBytes -= record.bytes;
    }
  }

  private oldestCompleted(): string | null {
    let bestKey: string | null = null;
    let bestExpiresAt = 0;
    let bestSeq = 0;
    for (const [key, record] of this.records) {
      if (record.expiresAt === null) continue;
      if (
        bestKey === null ||
        record.expiresAt < bestExpiresAt ||
        (record.expiresAt === bestExpiresAt && record.seq < bestSeq)
      ) {
        bestKey = key;
        bestExpiresAt = record.expiresAt;
        bestSeq = record.seq;
      }
    }
    return bestKey;
  }
```

The eviction order is normative and total: ascending `expiresAt`, then ascending `seq`. `seq` is
unique per store, so no two records ever tie. The same sequence of operations therefore evicts the
same records in the same order on every run.

`oldestCompleted` skips every in-flight record, so a reservation is never evicted. When every
record is in flight and the bound is reached, `makeRoom` returns `false`.

Call it in `reserve` step 4 — the insert path — before the insert:

```ts
const incoming = Buffer.byteLength(recordKey, "utf8");
if (!this.makeRoom(incoming)) {
  return { kind: "saturated" };
}
```

The bound is checked against the record that is about to exist, which is why `makeRoom` takes the
incoming size and compares `this.records.size + 1 > maxEntries`.

### 2b. `settle` enforces the byte bound by declining to retain

`maxBytes` must be a bound, not a hint. Story 4 fixed `settle`'s step order so that **every waiter
is resolved before any accounting happens**, which is what makes the following safe: a settle may
drop the record without ever stranding a joiner.

Replace Story 4's step 4 of `settle` with:

```ts
const incoming = answerBytes(answer);
if (this.totalBytes + incoming > this.settings.maxBytes) {
  this.evictCompletedUntil(incoming);
}
if (this.totalBytes + incoming > this.settings.maxBytes) {
  this.records.delete(recordKey);
  this.totalBytes -= record.bytes;
  return;
}
record.answer = answer;
record.expiresAt = this.now() + this.settings.ttlSeconds * 1000;
record.bytes += incoming;
this.totalBytes += incoming;
```

`evictCompletedUntil(incoming)` is the same loop as `makeRoom`, minus the entry check and skipping
the record being settled: it evicts `oldestCompleted()` while
`this.totalBytes + incoming > this.settings.maxBytes`, and stops when no completed record other
than this one remains.

An answer too large to retain even in an empty store is **not retained**. The waiters already have
it, the requesting client gets it, and a later duplicate runs the command again. `bytes()` never
exceeds `maxBytes` after any operation, and that is asserted.

The record being settled is never its own eviction victim: it is still in flight (`expiresAt ===
null`) while `evictCompletedUntil` runs, and `oldestCompleted` skips every in-flight record.

### 3. `src/http/server/idempotency.ts` — the zero TTL and the saturated branch

Insert one step between step 7 (`policy === "durable"`) and step 8 (compute and reserve):

```ts
if (dependencies.settings.ttlSeconds === 0) {
  await next();
  return;
}
```

A zero TTL disables the memory policy entirely: no fingerprint, no record, no replay. The key is
still validated by step 3, so a client sending a malformed key learns it regardless of the
configuration.

Add one branch to step 9:

```ts
if (outcome.kind === "saturated") {
  throw httpError(
    "service-unavailable",
    "the idempotency cache is full of in-flight requests",
  );
}
```

`service-unavailable` is `503`, added by Story 0. It must **not** be `internal-error`: a `500` may
follow a command that already committed, so re-running it is unsafe, while this `503` is answered
before any command runs and the same request may be sent again unchanged. A client that could not
tell them apart would have to treat every `500` as retryable or every `503` as fatal, and both are
wrong. `docs/proposal/api/README.md` states that distinction.

`httpError` builds an `HttpError`, so `envelopeMiddleware` materializes it with `internal: false`
and calls `onInternalError` **zero** times — the daemon refused work, it did not fault.

## Constraints

- Never sweep and never evict a record with `expiresAt === null`. All three loops carry the guard.
- `settle` resolves every waiter **before** it measures, evicts or drops anything. Story 4 fixes
  that order; this story must not disturb it.
- `bytes()` must be at or under `maxBytes` after every operation. Assert it after each one.
- The clock arrives only through `this.now`. Do not call `Date.now()` anywhere in
  `src/http/server/idempotency-store.ts` or `src/http/server/idempotency.ts`.
- Do not add a timer here. Expiry has no sweeper: it happens on the next `reserve`, which keeps
  every test hermetic and keeps the daemon free of a background task. The epic's only timer is the
  injected `schedule` of Story 4, and it serves the bounded join, never expiry.
- Do not add an error code. `saturated` answers `service-unavailable`, which Story 0 already added.

## Verify

`node --test src/http/server/idempotency-store.test.ts` — extend, on top of Story 4. Use a mutable
clock in the test file, not `createMockClock` — the shared helper advances on **every** call, and
these assertions need the clock to move only when the test moves it:

```ts
let now = 1_000;
const store = new IdempotencyStore({ settings, now: () => now, schedule });
```

- **The TTL starts at completion.** `settings.ttlSeconds = 300`. Reserve at `now = 1_000`, move
  `now` to `500_000`, settle `replayable`. Move `now` to `800_000` (299 seconds later) and reserve
  the same key with the same fingerprint: `replay`. Move `now` to `800_001` and reserve again:
  `reserved`. The record expired 300 seconds after the settle, not 300 seconds after the reserve.
- **The expiry boundary is `<=`.** Settle at `now = 1_000` with `ttlSeconds = 300`, so
  `expiresAt = 301_000`. At `now = 300_999` the reserve is `replay`; at `now = 301_000` it is
  `reserved`.
- **An in-flight record survives a sweep.** Reserve at `now = 1_000`, move `now` to
  `1_000_000_000`, reserve the same key with the same fingerprint: `joined`, and `size() === 1`.
- **An in-flight record survives an eviction pass.** `settings.maxEntries = 1`. Reserve `k1`.
  Reserve `k2`: `saturated`. `size() === 1`, and reserving `k1` again is still `joined`.
- **A completed record is evicted for a new one.** `settings.maxEntries = 1`. Reserve `k1`, settle
  `replayable`. Reserve `k2`: `reserved`, and `size() === 1`. Reserving `k1` again is `reserved`,
  not `replay` — it was evicted.
- **Eviction order is ascending `expiresAt`.** `settings.maxEntries = 3`. Settle `k1` at
  `now = 1_000`, `k2` at `now = 3_000`, `k3` at `now = 2_000`. Reserve `k4`. Then `k1` is gone
  (`reserved` on a re-reserve) and `k2` and `k3` are still `replay`.
- **The tie-break is ascending `seq`.** `settings.maxEntries = 2`. Reserve `k1`, reserve `k2`,
  settle both at the same `now`. Reserve `k3`: `k1` is evicted and `k2` survives.
- **The byte bound evicts too.** `settings.maxBytes` set just above one settled record's cost and
  `maxEntries = 100`. Settle `k1`, then reserve `k2` and settle it: `size() === 1`, `k1` is gone,
  and `bytes() <= maxBytes`.
- **An answer too large to retain is not retained, and its waiter still receives it.**
  `settings.maxBytes = 64`. Reserve `k1`, join it, settle `replayable` with a body of a few
  kilobytes. `assert.deepEqual(await joined.outcome, { kind: "answer", answer })`, `size() === 0`,
  and `bytes() === 0`.
- **`bytes()` never exceeds `maxBytes`.** After every operation of every test above, assert
  `store.bytes() <= settings.maxBytes`. Ten settles of a large answer under a small `maxBytes`
  leave `bytes() <= maxBytes` and `size() <= 1`.
- **A saturated store keeps every reservation.** `settings.maxEntries = 2`. Reserve `k1` and `k2`,
  settle neither. Reserve `k3`: `saturated`. `size() === 2`, and `k1` and `k2` both still `joined`.
- **Sweeping frees capacity.** `settings.maxEntries = 1`, `ttlSeconds = 300`. Settle `k1` at
  `now = 1_000`. Move `now` to `301_000`. Reserve `k2`: `reserved` and `size() === 1`.

`node --test src/http/server/idempotency.test.ts` — extend, on top of Story 4. `buildApp` already
accepts `settings` and `now`; the test file's clock is the same mutable `let now` pattern.

- **An in-flight reservation survives a TTL sweep at the app level.** `ttlSeconds = 300`. Gate the
  handler. Send the first `POST /v1/project` with `Idempotency-Key: k1`, `await arrived`, move
  `now` past `ttlSeconds * 1000`, send the identical second request, resolve `gate`, await both.
  `calls() === 1` and both bodies deep-equal. This is the Proof line "an in-flight reservation
  survives a TTL sweep".
- **The TTL starts at completion at the app level.** `ttlSeconds = 1`. Gate the handler, send the
  first request, `await arrived`, move `now` forward by `5_000`, resolve `gate`, await the answer.
  Then, with `now` unchanged, send the identical second request: `calls() === 1` and the answer
  replays. The command ran longer than the TTL and still replays afterwards.
- **A completed record expires.** `ttlSeconds = 300`. Send a keyed request, move `now` forward by
  `300_000`, send the identical request: `calls() === 2`.
- **Backpressure at the entry bound is `503`.** `maxEntries = 1`. Gate the handler. Send
  `POST /v1/project` with `Idempotency-Key: k1`, `await arrived`. Send
  `POST /v1/repository/inspect` with `Idempotency-Key: k2`: it answers `503` with body deep-equal to
  `{ error: { code: "service-unavailable", message: "the idempotency cache is full of in-flight
requests" } }`, and its handler never ran. Resolve `gate`: the first request completes with its
  normal answer, and `calls() === 1`. No reservation was dropped.
- **A saturated request may retry once capacity frees.** Continuing from above, after the first
  request completed, send the `k2` request again: it reaches its handler and answers normally. This
  is the property `503` promises and `500` would not.
- **Saturation is not an internal fault.** Build the app with an `onInternalError` that pushes into
  an array, drive the saturation case, and assert the array is empty.
- **A zero TTL disables the memory policy.** `ttlSeconds = 0`. Two identical keyed
  `POST /v1/project`: `calls() === 2` and `store.size() === 0`.
- **A zero TTL still validates the key.** `ttlSeconds = 0` with a 256-character key answers `400`
  and `calls() === 0`.

`npm run verify` exits 0.

Proof: delivers `src/http/server/idempotency-store.test.ts` in the EPIC Proof command, and the retention half of `src/http/server/idempotency.test.ts` — the Proof
lines "an in-flight reservation survives a TTL sweep and survives a capacity eviction pass", "with
every record in flight at the entry bound, a new keyed request is `503 service-unavailable` and no
reservation is dropped", "the retained byte total never exceeds `maxBytes`", and "the TTL starts at
completion".
