# Story 4 — The reservation and the join

Epic: `.agent/plan/epics/010.6-idempotent-post.md`
Depends on: Story 1, Story 2, Story 3, Story 6.

This story creates the store, creates the middleware, and mounts it. Story 5 adds the sweep, the
bounds and the eviction to the same store. Story 7 adds the `durable` branch to the same
middleware.

## Change

### 1. New file `src/http/server/idempotency-store.ts`

Imports `./idempotency-record.ts` (Story 2) and `./idempotency-response.ts` (Story 6). No koa
import, no `node:` import, no service import. `src/http/server/` may not import a service, so the
clock arrives as a plain function.

```ts
import type { OutcomeState } from "./idempotency-record.ts";
import type { StoredAnswer } from "./idempotency-response.ts";

export type IdempotencySettings = Readonly<{
  ttlSeconds: number;
  joinTimeoutSeconds: number;
  maxEntries: number;
  maxBytes: number;
}>;

export const defaultIdempotencySettings: IdempotencySettings = {
  ttlSeconds: 300,
  joinTimeoutSeconds: 30,
  maxEntries: 256,
  maxBytes: 8388608,
};

export type Schedule = (
  milliseconds: number,
  callback: () => void,
) => () => void;

export type JoinOutcome =
  | Readonly<{ kind: "answer"; answer: StoredAnswer }>
  | Readonly<{ kind: "timeout" }>;

export type ReserveResult =
  | Readonly<{
      kind: "reserved";
      settle: (answer: StoredAnswer, state: OutcomeState) => void;
    }>
  | Readonly<{ kind: "joined"; outcome: Promise<JoinOutcome> }>
  | Readonly<{ kind: "replay"; answer: StoredAnswer }>
  | Readonly<{ kind: "mismatch" }>;

export type StoreInput = Readonly<{
  settings: IdempotencySettings;
  now: () => number;
  schedule: Schedule;
}>;

export class IdempotencyStore {
  constructor(input: StoreInput);
  reserve(recordKey: string, fingerprint: string): ReserveResult;
  size(): number;
  bytes(): number;
  waiters(recordKey: string): number;
}
```

`joined` yields a **discriminated** outcome, never `null` and never a bare answer. A request that
**already joined** and whose original settled always receives that original's answer, whatever the
answer was. Retention is a separate decision: an uncacheable outcome deletes the record so a request
arriving **after** completion runs the command again, but it never releases a joiner to run a second
copy of the command concurrently. Releasing joiners to re-run would amplify one retry burst of N
duplicates into N concurrent executions and would break the only guarantee this epic makes.

`schedule` is the injected timer. It takes a delay and a callback and returns a canceller. It is a
plain function for the same reason `now` is: `src/http/server/` may not import a service. A test
injects a manual scheduler and fires it by hand, so the suite carries no wall-clock delay.

Internal record shape, held in one `Map<string, Record>`:

```ts
type Record = {
  fingerprint: string;
  seq: number;
  expiresAt: number | null; // null while in flight
  answer: StoredAnswer | null; // null while in flight
  waiters: ((answer: StoredAnswer) => void)[];
  bytes: number;
};
```

`seq` is a monotonic counter on the store, starting at `0` and incremented on every insert. Story 5
uses it as the eviction tie-break.

**`reserve` is fully synchronous.** It contains no `await`, no `Promise` construction other than
the joiner promise, and no callback deferral. Two concurrent duplicates therefore cannot both miss.

Steps, in this exact order:

1. Look up `recordKey`.
2. Record present and `expiresAt === null` (in flight):
   - `record.fingerprint !== fingerprint` → `{ kind: "mismatch" }`.
   - otherwise → `{ kind: "joined", outcome: this.join(record) }`.

   `join(record)` is module-private and synchronous:

   ```ts
   private join(record: Record): Promise<JoinOutcome> {
     return new Promise((resolve) => {
       const waiter = (answer: StoredAnswer): void => {
         cancel?.();
         resolve({ kind: "answer", answer });
       };
       record.waiters.push(waiter);
       let cancel: (() => void) | undefined;
       if (this.settings.joinTimeoutSeconds > 0) {
         cancel = this.schedule(this.settings.joinTimeoutSeconds * 1000, () => {
           const at = record.waiters.indexOf(waiter);
           if (at >= 0) record.waiters.splice(at, 1);
           resolve({ kind: "timeout" });
         });
       }
     });
   }
   ```

   A `joinTimeoutSeconds` of `0` schedules nothing, and the join has the lifetime of the original.
   A waiter that times out is **removed from the list**, so `waiters(recordKey)` stays truthful and
   a later `settle` does not resolve an already-settled promise. A waiter that receives its answer
   cancels its own timer, so the scheduler holds no reference after the answer lands.

   A timeout never touches the record beyond its own waiter: the original keeps running, the
   reservation stands, and a third duplicate still joins it.

3. Record present and `expiresAt !== null` (completed):
   - `record.fingerprint !== fingerprint` → `{ kind: "mismatch" }`.
   - otherwise → `{ kind: "replay", answer: record.answer }`.
4. Record absent: build
   `const record = { fingerprint, seq: this.nextSeq++, expiresAt: null, answer: null, waiters: [],
bytes: Buffer.byteLength(recordKey, "utf8") + Buffer.byteLength(fingerprint, "utf8") }`,
   insert it, and return `{ kind: "reserved", settle }`, where `settle` closes over **both**
   `recordKey` and the `record` object itself.

**`settle(answer, state)`** — synchronous, and it must not throw. Its step order is normative:

1. **Identity guard.** `if (this.records.get(recordKey) !== record) return;` — compare the record
   **object**, not the key. Comparing `record === undefined || record.expiresAt !== null` is a
   defect: after this reservation settled uncacheable and was deleted, a second request can reserve
   the same key, and a stale `settle` closure would then settle _that_ record. This guard also makes
   a second call on the same reservation a no-op, because a settled record either was deleted or is
   no longer the in-flight one under that key.
2. **Resolve every waiter with `answer`, first, before any other work.** Then set
   `record.waiters.length = 0`. Resolving first is what makes "a joiner always settles" true no
   matter what the accounting below does.
3. `state === "uncacheable"` → delete the record and subtract `record.bytes` from
   `this.totalBytes`. Return.
4. Otherwise (`"replayable"` or `"indeterminate"`) → compute `answerBytes(answer)` (Story 5 adds
   the byte bound here), set `record.answer = answer`,
   `record.expiresAt = this.now() + this.settings.ttlSeconds * 1000`, and add the answer bytes to
   `record.bytes` and `this.totalBytes`.

`answerBytes` is module-private and exact:

```ts
function answerBytes(answer: StoredAnswer): number {
  let body: string;
  try {
    body = JSON.stringify(answer.body ?? null) ?? "null";
  } catch {
    body = "";
  }
  return (
    Buffer.byteLength(body, "utf8") +
    Buffer.byteLength(JSON.stringify(answer.headers), "utf8")
  );
}
```

The `try` is load-bearing: `JSON.stringify` throws on a cyclic body and on a `BigInt`, and
`JSON.stringify(undefined)` returns `undefined` rather than a string. A body that cannot be
measured is measured as `0` here; koa will fail to serialize it on the wire, which is the same
outcome the first request gets, so the replay stays faithful.

`size()` returns `this.records.size`. `bytes()` returns `this.totalBytes`, maintained incrementally
rather than recomputed. `waiters(recordKey)` returns `this.records.get(recordKey)?.waiters.length ??
0`; it exists so a test can observe that a duplicate joined before it disconnected.

**`maxBytes` is an accounting bound over serialized answer bytes, not a heap bound.** It counts, per
record, `Buffer.byteLength(recordKey)` + `Buffer.byteLength(fingerprint)` + `answerBytes(answer)`.
It does not model retained JavaScript object size, which is not measurable deterministically. Say so
in the story, not in a code comment.

An `indeterminate` record is stored and replayed exactly like a `replayable` one. The distinction
is what `classifyOutcome` decides, not what the store does with the result.

`Buffer` is a Node global and needs no import. `src/http/contract/registry.ts:26` already uses it.

### 2. New file `src/http/server/idempotency.ts` — the middleware

```ts
import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";
import { idempotencyOf } from "../contract/operation.ts";
import type { RoutedState } from "./route.ts";
import { materializeError } from "./envelope.ts";
import { classifyOutcome } from "./idempotency-record.ts";
import {
  captureAnswer,
  headerSnapshot,
  applyAnswer,
} from "./idempotency-response.ts";
import {
  fingerprint,
  readIdempotencyKey,
  recordKey,
} from "./idempotency-key.ts";
import { IdempotencyStore } from "./idempotency-store.ts";
import type { IdempotencySettings } from "./idempotency-store.ts";

export type IdempotencyDependencies = Readonly<{
  settings: IdempotencySettings;
  now: () => number;
}>;

export type Idempotency = Readonly<{
  middleware: (context: Context, next: Next) => Promise<void>;
  store: IdempotencyStore;
}>;

export function createIdempotency(
  dependencies: IdempotencyDependencies,
): Idempotency;
```

`createIdempotency` constructs one `IdempotencyStore` and returns it beside the middleware. The
store is returned so a test can assert record count without a back door on `createApp`.

The middleware body, in this exact order. **Every step up to and including the `reserve` call is
synchronous.** No `await` may appear between step 1 and step 8.

1. `const match = (context.state as RoutedState).match;`
2. `const read = readIdempotencyKey(context.req);`
3. `read.kind === "invalid"` → `throw httpError("invalid-request", read.message);`
4. `read.kind === "absent"` → `await next(); return;`
5. `const policy = idempotencyOf(match.operation);`
6. `policy === "none"` → `await next(); return;` — a key on a `GET`, a `PUT` or a `DELETE` is
   accepted and ignored. It is still validated by step 3, so a malformed key is `400` on every
   method.
7. `policy === "durable"` → Story 7 replaces this line. Until Story 7 lands, write
   `await next(); return;`.
8. Compute and reserve:

```ts
const print = fingerprint({
  method: context.method,
  path: context.path,
  query: context.querystring,
  rawBody: context.request.rawBody ?? "",
});
const key = recordKey({
  operationId: match.operation.operationId,
  parameters: match.parameters,
  key: read.key,
});
const outcome = store.reserve(key, print);
```

9. Branch on `outcome.kind`:

- `"mismatch"` → `throw httpError("idempotency-mismatch", "the Idempotency-Key was reused with a
different request", { operationId: match.operation.operationId, key: read.key });`
  The `details` argument is mandatory for a `409` code (`src/http/contract/errors.ts:59-63`).
- `"replay"` → `applyAnswer(context, outcome.answer); return;`
- `"joined"` →

  ```ts
  const joined = await outcome.outcome;
  if (joined.kind === "timeout") {
    throw httpError(
      "service-unavailable",
      "the original request under this Idempotency-Key is still running",
    );
  }
  applyAnswer(context, joined.answer);
  return;
  ```

  A joiner that receives an answer gets the original's answer, including a `409` the store chose not
  to retain. It never falls through to `next()`. A request that arrives after the original completed
  and was not retained finds no record at all, and reserves for itself — that is where "the second
  request runs the command again" happens, and it is sequential rather than concurrent.

  A joiner that times out answers `503 service-unavailable`. Its own command never ran, so the same
  request may be sent again unchanged; if the original has landed by then, the retry replays it.
  This is why the code is not `internal-error`: a `500` may follow a command that committed, and the
  two carry opposite advice. `docs/proposal/api/README.md` states that distinction.

- `"reserved"` → step 10.

10. Run under the reservation:

```ts
const before = headerSnapshot(context);
try {
  await next();
  const answer = captureAnswer(context, before, context.status, context.body);
  outcome.settle(
    answer,
    classifyOutcome({
      replayable: match.operation.replayable,
      status: context.status,
      internal: false,
    }),
  );
} catch (error: unknown) {
  const materialized = materializeError(error);
  const answer = captureAnswer(
    context,
    before,
    materialized.status,
    materialized.body,
  );
  outcome.settle(
    answer,
    classifyOutcome({
      replayable: match.operation.replayable,
      status: materialized.status,
      internal: materialized.internal,
    }),
  );
  throw error;
}
```

The `throw error` is normative. The middleware records the answer and then lets the error continue
to `envelopeMiddleware`, which produces the identical status and body from the identical
`materializeError` call and performs the single `onInternalError` report. Swallowing the error here
would move the report and would let the two paths drift.

A client that disconnects never cancels the original: nothing in this middleware listens for
`aborted` or `close`, and the joiner holds only a `resolve` callback. A joiner whose socket dies
simply never has its answer written.

**The wait is bounded twice over.** `settle` runs on both the resolve and the reject path of
`next()`, resolves every waiter first, and cannot throw before it does — so a joiner never outlives
its original. And `join` arms an injected timer, so a joiner never outlives `joinTimeoutSeconds`
either, even when the original hangs forever. The timer is injected rather than `setTimeout`-in-place
precisely so the suite proves the bound without a wall-clock delay.

### 3. `src/http/server/app.ts` — the two optional dependencies and the mount

`AppDependencies` (`app.ts:33-38`) gains three optional members, after `unimplemented`:

```ts
  idempotency?: IdempotencySettings;
  now?: () => number;
  schedule?: Schedule;
```

All three are optional so the nine `createApp` call sites in `src/http/server/app.test.ts:151`,
`src/http/server/start.test.ts:33,101` and `src/http/server/dispatch.test.ts:110,126,142,157,171,187`
need no edit.

Declare the production default scheduler as a module-level constant in `app.ts`:

```ts
const systemSchedule: Schedule = (milliseconds, callback) => {
  const timer = setTimeout(callback, milliseconds);
  timer.unref();
  return () => clearTimeout(timer);
};
```

`timer.unref()` is required. Without it a pending join timer keeps the process alive and every suite
that builds an app would hang on exit — the same reason `test/helpers/agent.ts:15` unrefs its server.

In `createApp`, between the `bodyParserForHandled` mount (`app.ts:58`) and the
`dispatchMiddleware` mount (`app.ts:59`):

```ts
app.use(
  createIdempotency({
    settings: dependencies.idempotency ?? defaultIdempotencySettings,
    now: dependencies.now ?? (() => Date.now()),
    schedule: dependencies.schedule ?? systemSchedule,
  }).middleware,
);
```

The final order is envelope → origin → host → auth → route → bodyparser → **idempotency** →
dispatch. It sits after the body parser because it fingerprints the raw body, and before dispatch
because it must reserve before the command runs.

### 4. `test/helpers/app.ts` — a frozen clock by default

`TestAppOverrides` (`test/helpers/app.ts:9-14`) gains three optional members:

```ts
  idempotency?: IdempotencySettings;
  now?: () => number;
  schedule?: Schedule;
```

`createTestApp` passes them into `createApp` (`test/helpers/app.ts:46`), defaulting `now` to
`() => 0`, `idempotency` to `defaultIdempotencySettings`, and `schedule` to a no-op that arms
nothing: `() => () => {}`. The frozen clock and the inert scheduler keep every existing suite
hermetic — no test outside this epic sends an `Idempotency-Key`, a frozen clock never expires a
record, and an inert scheduler never leaves a timer behind.

## Constraints

- No `await` between reading `context.state.match` and `store.reserve(...)`. This is the whole
  guarantee. A reviewer reads the middleware top to bottom and checks it.
- No `setTimeout`, `setInterval` or `Date.now()` inside `src/http/server/idempotency-store.ts` or
  `src/http/server/idempotency.ts`. Time enters through `now` and `schedule` only. The one
  `setTimeout` in this epic is `systemSchedule` in `app.ts`, and it unrefs.
- Do not change `TransportSettings`. The two new members are on `AppDependencies`, which no other
  epic's story touches.
- Do not change the mount position of any existing middleware, and do not change
  `bodyParserForHandled`.
- The middleware imports no service and no command. `src/http/server/` may import `domain/`,
  `commands/`, `queries/`, `http/contract/` and `http/server/` only.
- `src/http/server/app.test.ts:92` (`requests.length === 55`) and `:165`
  (`unimplementedFor(bound).length === 21`) must stay unchanged. This story adds no registry entry.

## Verify

`node --test src/http/server/idempotency-store.test.ts` — new file. Suite name
`src/http/server/idempotency-store.test`. No koa, no supertest.

Declare one manual scheduler at the top of the file. It is the only timer in the suite:

```ts
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
```

Construct with
`new IdempotencyStore({ settings: defaultIdempotencySettings, now: () => 1_000, schedule })`, and
reset `armed.length = 0` per test.

- **A first reserve is `reserved`, and `size()` becomes `1`.**
- **A second reserve of the same key while in flight is `joined`**, and `size()` stays `1`.
- **A second reserve with a different fingerprint while in flight is `mismatch`**, and `size()`
  stays `1`.
- **After a `replayable` settle, a same-fingerprint reserve is `replay`** and returns the identical
  `StoredAnswer` object by `assert.deepEqual`.
- **After an `indeterminate` settle, a same-fingerprint reserve is `replay`** with the settled
  answer.
- **After an `uncacheable` settle, `size()` is `0`** and a new reserve of that key is `reserved`.
- **A joiner receives the settled answer.** Reserve, join, settle `replayable`, then
  `assert.deepEqual(await joined.outcome, { kind: "answer", answer })`.
- **A joiner receives the answer even when it is uncacheable.** Reserve, join, settle
  `uncacheable` with a `409` answer, then
  `assert.deepEqual(await joined.outcome, { kind: "answer", answer })`, and `size() === 0`. This is
  the assertion that stops two joiners re-running the command concurrently.
- **Two joiners both receive the answer**, on both a `replayable` and an `uncacheable` settle.
- **`waiters` counts joiners.** After two joins, `waiters(key) === 2`; after settle,
  `waiters(key) === 0`.
- **A join arms one timer, and an answer cancels it.** After one join, `armed.length === 1`. Settle
  `replayable`; the armed entry is `cancelled`. Then `fireAll()` runs nothing, and the joined
  promise still resolves to `{ kind: "answer", … }`.
- **A timed-out join answers `timeout`.** Reserve, join, then `fireAll()` **without** settling:
  `assert.deepEqual(await joined.outcome, { kind: "timeout" })`. `waiters(key) === 0` — the waiter
  removed itself — while `size() === 1` and the reservation still stands.
- **A timeout does not disturb the original or a later joiner.** After the timeout above, join
  again, settle `replayable`, and the second joiner resolves to `{ kind: "answer", … }`. A `replay`
  after that returns the answer.
- **A settle after a timeout resolves nobody twice.** After the timeout, settle `replayable`: the
  timed-out promise is still `{ kind: "timeout" }`, and `settle` does not throw.
- **The timer is armed with the configured delay.** With `joinTimeoutSeconds: 30`, the single armed
  entry has `at === 30_000`.
- **A zero join timeout arms nothing.** `joinTimeoutSeconds: 0`: after a join, `armed.length === 0`.
  Settle `replayable` and the joiner still resolves to `{ kind: "answer", … }`.
- **A stale `settle` closure cannot settle a later record.** Reserve `k1` and keep its `settle`.
  Settle it `uncacheable`. Reserve `k1` again — a fresh in-flight record. Call the **first**
  `settle` again with a different answer. Then join `k1` and settle it through the **second**
  reservation: the joiner receives the second answer, and the record's replay carries the second
  answer. The stale closure changed nothing.
- **`settle` survives an unmeasurable body.** Build a cyclic body (`const b: any = {}; b.self = b;`)
  and settle `replayable`. The waiter still resolves with that answer, and `settle` does not throw.
- **After a completed settle with a different fingerprint, the reserve is `mismatch`.**
- **Two different record keys are two records.** `size()` becomes `2`.
- **A second `settle` on the same reservation changes nothing.** Settle `replayable`, settle again
  with a different answer, then reserve: the replay carries the **first** answer.
- **`expiresAt` uses the injected clock.** With `now: () => 1_000` and `ttlSeconds: 300`, settle,
  then reserve again: still `replay`. (Story 5 asserts the expiry itself.)
- **`bytes()` grows on settle.** Record `bytes()` after reserve and after a `replayable` settle;
  assert it is strictly larger, and assert the exact delta equals
  `Buffer.byteLength(JSON.stringify(answer.body), "utf8") +
Buffer.byteLength(JSON.stringify(answer.headers), "utf8")`.

`node --test src/http/server/idempotency.test.ts` — new file, and the file named by the EPIC Proof.
Suite name `src/http/server/idempotency.test`.

Build one local helper in the file, mirroring the probe-app idiom of
`src/http/server/origin.test.ts:10-18`:

```ts
function buildApp(input: {
  handler: (context: Context) => Promise<void> | void;
  settings?: IdempotencySettings;
  now?: () => number;
}): {
  agent;
  store: IdempotencyStore;
  calls: () => number;
  fireTimers: () => void;
};
```

`buildApp` owns the manual scheduler described in the store suite above and exposes `fireTimers`.
No test in this file calls `setTimeout`.

It mounts, in order: `envelopeMiddleware({ onInternalError: () => {} })`, `routeMiddleware()`,
`bodyParser({ enableTypes: ["json"] })` from `@koa/bodyparser`, the `createIdempotency(...)`
middleware, then a terminal middleware that increments a call counter and delegates to
`input.handler`. It reaches the app through `loopbackAgent` (`test/helpers/agent.ts`) and sets no
`Host` and no `Authorization`, because neither `hostMiddleware` nor `authMiddleware` is mounted.

Routes used, all real registry entries so `routeMiddleware` matches them:

| route                         | operation            | policy   |
| ----------------------------- | -------------------- | -------- |
| `POST /v1/project`            | `project.create`     | `memory` |
| `POST /v1/repository/inspect` | `repository.inspect` | `memory` |
| `GET /v1/health`              | `system.health`      | `none`   |

Assertions for this story:

- **Two identical keyed `POST`s run the command once, and the two answers are byte-identical
  including the response headers.** The handler sets `ETag: "abc"` and `X-Multi: ["a","b"]` before
  writing its body, so the assertion covers a header a handler owns and not only `content-type`.
  Two `POST /v1/project` with `Idempotency-Key: k1` and the identical JSON body. Then:
  - `calls() === 1`;
  - `assert.equal(first.status, second.status)`;
  - `assert.equal(first.text, second.text)` — the raw payload bytes;
  - build `const strip = (h) => Object.fromEntries(Object.entries(h).filter(([n]) =>
!["date", "content-length", "connection", "keep-alive", "transfer-encoding"].includes(n)))`
    and `assert.deepEqual(strip(first.headers), strip(second.headers))`. This is the complete
    header comparison, not a spot check on `content-type`.

  "Byte-identical" in this epic means the status, the body bytes, and every retained answer header.
  It does not mean the literal HTTP response octets: `Date` and `Content-Length` are excluded by
  `VOLATILE_HEADERS` and by the strip above, because the daemon does not own them.

- **The same key with a different body is `409 idempotency-mismatch`, and the command never runs
  again.** After the first request, a second with body `{"name":"other"}` answers `409`,
  `body.error.code === "idempotency-mismatch"`, and `calls()` is still `1`.
- **The same key with a different query string is `409 idempotency-mismatch`.**
  `POST /v1/project?a=1` then `POST /v1/project?a=2`, same key, same body. `calls()` stays `1`.
- **One key sent to two different operations records two entries and runs both commands.**
  `POST /v1/project` and `POST /v1/repository/inspect`, both with `Idempotency-Key: k1`.
  `calls() === 2` and `store.size() === 2`.
- **Two duplicates dispatched with no `await` between them run the command once.** The handler
  awaits a `gate` deferred the test resolves, and resolves an `arrived` deferred on entry. Send
  both requests back to back with **no `await` between the two sends**, then `await arrived`,
  resolve `gate`, then `await Promise.all([first, second])`. `calls() === 1`, both bodies
  deep-equal, both statuses equal, and neither response is a `409`. The result is deterministic for
  every interleaving: the gate is still shut when both reach `reserve`, so whichever reserves first,
  the other must join. This is the EPIC's literal "dispatched with no `await` between them".
- **A duplicate that arrives while the first is in flight joins rather than erroring.** The
  sequenced variant, which proves _where_ the second request was when it was suppressed: send the
  first request, `await arrived`, send the second, `await` until `store.waiters(key) === 1` by
  polling the store with `await new Promise(setImmediate)` — no timer — then resolve `gate` and
  await both. `calls() === 1` and both answers deep-equal.
- **A duplicate that disconnects does not cancel the original.** Same shape as the sequenced
  variant. Wait until `store.waiters(key) === 1`, so the duplicate is provably joined and not
  merely dispatched, then call `.abort()` on it. Then resolve `gate` and assert the first request
  completes with its normal answer, `calls() === 1`, and `store.waiters(key) === 0`.
- **A `409` outcome is not cached, and a _later_ request runs the command again.** The handler
  throws `httpError("lease-held", "held", {})`. Two **sequential** identical keyed requests: both
  answer `409` with `body.error.code === "lease-held"`, `calls() === 2`, and `store.size() === 0`.
- **A join that outlives its timeout is `503 service-unavailable`.** `joinTimeoutSeconds: 30`. Gate
  the handler. Send the first request, `await arrived`, send the second, wait until
  `store.waiters(key) === 1`, then call `fireTimers()`. The second request answers `503` with body
  deep-equal to `{ error: { code: "service-unavailable", message: "the original request under this
Idempotency-Key is still running" } }`. Then resolve `gate`: the first request completes with its
  normal answer, and `calls() === 1` — the duplicate's command never ran.
- **A timed-out duplicate may retry and replay.** Continuing from the state above, send the identical
  request a third time after the first completed: it answers the first request's answer and
  `calls()` is still `1`.
- **A zero join timeout waits for the original.** `joinTimeoutSeconds: 0`. Gate the handler, send
  the first, `await arrived`, send the second, wait for `store.waiters(key) === 1`, call
  `fireTimers()` (which fires nothing), resolve `gate`: both answers deep-equal and `calls() === 1`.
- **A joiner of a `409` receives the `409` and does not run the command.** The gated handler
  increments the counter and throws `httpError("lease-held", "held", {})`. Send the first request,
  `await arrived`, send the second, wait for `store.waiters(key) === 1`, resolve `gate`, await
  both: both answer `409`, `calls() === 1`, and `store.size() === 0`. This is the regression guard
  against releasing joiners to re-run.
- **A handler that commits and then throws marks the key indeterminate.** The handler increments a
  `committed` counter — standing in for the transaction that landed — and _then_ throws
  `new Error("boom")` while formatting its response. Two identical keyed requests: both answer
  `500` with body `{ error: { code: "internal-error", message: "internal error" } }` by
  `assert.deepEqual`, `calls() === 1`, `committed === 1`, and `store.size() === 1`. The
  `committed` counter is what makes this the post-commit case rather than a bare throw.
- **A key that arrives twice is `400 invalid-request` and the command never runs.** Set the header
  twice with two `.set(...)` calls on the same supertest request — supertest replaces rather than
  appends, so use `.set("Idempotency-Key", ["a", "b"])` if the client supports it, otherwise reach
  the loopback server with `node:http` directly and write both header lines. Assert `400`,
  `body.error.code === "invalid-request"`,
  `body.error.message === "Idempotency-Key was supplied more than once"`, and `calls() === 0`.
- **A key of 256 characters is `400 invalid-request` and the command never runs.**
  `body.error.message === "Idempotency-Key must be 1 to 255 printable ASCII characters with no leading or trailing space"`,
  `calls() === 0`.
- **A key carrying a tab is `400 invalid-request` and the command never runs.** Same message,
  `calls() === 0`.
- **A key with an interior space is accepted.** `Idempotency-Key: release candidate` on two
  identical `POST /v1/project`: `calls() === 1`. The grammar admits a free-form `importId` shape.
- **A `POST` with no key runs every time.** Two identical `POST /v1/project` with no header:
  `calls() === 2` and `store.size() === 0`.
- **A `GET` carrying a key is ignored, not cached.** Two `GET /v1/health` with
  `Idempotency-Key: k1`: `calls() === 2` and `store.size() === 0`.
- **A `GET` carrying a malformed key is still `400`.** `GET /v1/health` with a 256-character key
  answers `400` and `calls() === 0`.

`node --test src/http/server/app.test.ts src/http/server/dispatch.test.ts
src/http/server/start.test.ts src/http/server/envelope.test.ts` — all pass **unchanged**. The new
middleware is transparent to a request with no `Idempotency-Key`, which is every request those
suites make.

`node --test test/helpers/app.test.ts` — if the file exists, it passes unchanged.

`npm run verify` exits 0.

Proof: delivers `node --test src/http/server/idempotency.test.ts`, and with Stories 0, 1 and 5
completes `PASS EPIC-010.6`.
