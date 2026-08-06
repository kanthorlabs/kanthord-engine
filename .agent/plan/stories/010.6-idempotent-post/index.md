# EPIC 010.6 — Idempotent POST — stories

Epic: `.agent/plan/epics/010.6-idempotent-post.md`
Prereq: EPIC 010.5 (sequence order), and through it EPIC 010.

A client retries a `POST` under an `Idempotency-Key` and the daemon suppresses the duplicate for
the retention window, in this process — replaying the first answer, status, body and response
headers, rather than acting twice.

## Dispatch order

1. `00-the-service-unavailable-code.md`
2. `01-the-policy-in-the-registry.md`
3. `02-the-cacheable-outcome.md`
4. `03-the-key-and-its-fingerprint.md`
5. `06-the-response-capture.md`
6. `04-the-reservation-and-the-join.md`
7. `05-the-retention-and-the-bounds.md`
8. `07-plan-import-under-the-durable-policy.md`
9. `08-the-configuration.md`

The file numbers follow the EPIC's Story bullet order. The dispatch order differs in one place:
**Story 6 lands before Story 4**, because Story 4's middleware calls `materializeError` and
`captureAnswer`, which Story 6 creates.

Stories 0, 1, 2, 3 and 6 are independent of each other and may run in any order among themselves.
Stories 4, 5 and 7 all edit `src/http/server/idempotency.ts` and must run in that sequence:

- Story 4 creates the store and the middleware, with no expiry and no bound.
- Story 5 adds the sweep, the bound, the eviction and the zero-TTL bypass to the same two files.
- Story 7 replaces Story 4's placeholder `durable` branch.

Story 8 is last: it sources the numbers Stories 4 and 5 already default.

## New files this epic creates

| file                                      | story   | contents                                                |
| ----------------------------------------- | ------- | ------------------------------------------------------- |
| `src/http/server/idempotency-record.ts`   | 2       | `classifyOutcome`, `OutcomeState`                       |
| _(no new file)_                           | 0       | `service-unavailable` in `errors.ts` and `exit-code.ts` |
| `src/http/server/idempotency-key.ts`      | 3       | header read, `fingerprint`, `recordKey`                 |
| `src/http/server/idempotency-response.ts` | 6       | `StoredAnswer`, `captureAnswer`, `applyAnswer`          |
| `src/http/server/idempotency-store.ts`    | 4, 5    | `IdempotencyStore`, `IdempotencySettings`               |
| `src/http/server/idempotency.ts`          | 4, 5, 7 | `createIdempotency` — the middleware                    |

Each carries a co-located `.test.ts`. `src/http/server/idempotency.test.ts` is the file the EPIC
Proof names.

## Facts (needed for implementation)

### Nothing of this exists yet

`find` for `*idempotenc*` outside `node_modules` returns zero source files. What exists is the error
code `"idempotency-mismatch": 409` (`src/http/contract/errors.ts:15`), its CLI exit code `156`
(`src/cli/exit-code.ts:20`), and `plan_revision.import_id` with `UNIQUE (project_id, import_id)`
(`src/services/storage/migration-0002-graph-and-plan.ts:11,15`).

`invalid-request` (400) and `idempotency-mismatch` (409) already exist. **One code is added:**
`service-unavailable` (503), by Story 0. It is already in `docs/proposal/api/README.md`'s error
table — the source of truth was updated when the EPIC took the decision, so Story 0 brings the code
into line with the doc rather than the other way round. Every pinned count moves 21 → 22:
`src/http/contract/errors.test.ts:25-49,51-85,84` and `src/cli/exit-code.test.ts:14-35,47-59`.

### `Operation` members must be optional

`src/http/contract/operation.ts:19-28` is `Readonly<{ operationId, method, path, introducedIn,
status, successStatus?, request?, response? }>`. Ten tests in `src/http/contract/registry.test.ts`
build synthetic `Operation` literals with exactly five members (`:207-228`, `:230-250`, `:252-270`,
`:272-294`, `:296-311`, `:313-328`, `:330-345`, `:347-362`, `:364-392`, `:394-407`). A **required**
`idempotency` or `replayable` breaks all ten at typecheck, and `npm run verify` fails before an
assertion runs. Both new members are optional, and `idempotencyOf(entry)` resolves the default.

Two of those tests constrain the fault rules directly:

- `:207-228` asserts the exact array `["duplicate operationId"]`. Its two entries are `GET` with no
  `idempotency`, so none of the four new faults fires.
- `:394-407` asserts `registryFaults([...]) === []` for a **`POST`** literal that declares no
  `idempotency`. That is why there is no "a `POST` must declare a policy" fault. Story 1 pins the
  19 declarations with a parity test instead.

### The registry method census

`GET 29, PUT 4, POST 19, DELETE 1`, total 53. The 19 `POST`s are listed in Story 1. `plan.import`
is the only `durable`; the other 18 are `memory` with `replayable: [200]`.

`docs/proposal/api/README.md:88`: "Every route answers `200` on success, a creating `POST`
included. No route declares `201`." `src/http/contract/openapi.test.ts:200-203` asserts no entry
sets `successStatus`. That is why `[200]` is the whole replayable set everywhere.

### Counts this epic must not move

`registry.test.ts:15,20` (53), `:29-38` (routed 23, stubbed 30), `:40-57` (phase splits),
`openapi.test.ts:78` (47 paths), `:115` (53 ids), `:205-232` (21 schema keys),
`parity.test.ts:16,25` (53 / 57), `app.test.ts:92` (55 requests), `:165` (21 unimplemented),
`dispatch.test.ts:185` (21), `:309` (30). This epic adds no registry entry, so every one stays as
written.

The **error-code** counts are the exception, and Story 0 owns every one of them:
`errors.test.ts:25-49` (the ordered list), `:51-85` (the status groups), `:84` (`sum === 21`), and
`exit-code.test.ts:14-35,47-59`. All move 21 → 22. No other story touches them.

### `http/server/` may not import a service

The AGENTS.md import matrix gives `http/server/` exactly `domain/`, `commands/`, `queries/`,
`http/contract/` and `http/server/`. `eslint-plugin-boundaries` enforces it and `npm run lint`
fails on a violation. Two consequences that shape every story here:

- **Time enters through two plain functions.** `src/services/clock/index.ts` is `interface Clock {
now(): number }`, and the middleware cannot import it. `AppDependencies` takes
  `now?: () => number` for expiry and `schedule?: (ms, fn) => () => void` for the bounded join.
  `src/main.ts` passes `() => clock.now()` from the single `SystemClock` at `src/main.ts:138`, and
  leaves `schedule` to `createApp`'s default.
- **That default `setTimeout` must `unref()`.** Otherwise a pending join timer keeps the process
  alive and every app-building suite hangs on exit — the reason `test/helpers/agent.ts:15` unrefs
  its server. `test/helpers/app.ts` defaults `schedule` to an inert `() => () => {}` so no suite
  outside this epic arms anything, and the two idempotency suites inject a **manual** scheduler they
  fire by hand. No `setTimeout` and no sleep appears in any test of this epic.
- **The settings type is duplicated.** `IdempotencySettings` lives in
  `src/http/server/idempotency-store.ts` with `ttlSeconds` and `joinTimeoutSeconds`;
  `HttpIdempotencySettings` lives in `src/services/config/index.ts` with `ttl` and `joinTimeout`.
  `src/main.ts:277` maps one to the other. This mirrors `TransportSettings`, which already
  re-declares two of `HttpSettings`' four members.

### `503 service-unavailable` is the one new code, and it has exactly two callers

Idempotency saturation (Story 5) and a timed-out join (Story 4). Both are answered **before** the
duplicate's own command runs, so the same request is always safe to send again unchanged. That is
why neither may be `internal-error`: a `500` may follow a command that already committed, and a
client that could not tell the two apart would have to treat every `500` as retryable or every `503`
as fatal. Neither raises `onInternalError`; the daemon declined work, it did not fault.

### The middleware chain, before and after

Today, `src/http/server/app.ts:51-59`: envelope → origin → host → auth → route → bodyparser →
dispatch. This epic inserts one middleware between the body parser and dispatch, so the chain
becomes eight long. It fingerprints the raw body, so it must follow the parser; it reserves before
the command runs, so it must precede dispatch.

`bodyParserForHandled` (`app.ts:63-88`) calls `parse(context, next)`, and the vendor parser calls
`next()` itself — so the idempotency middleware runs as the parser's continuation. When the
operation is `stubbed` or unbound the parser is skipped and `next()` is called directly; in that
case `context.request.rawBody` is `undefined` and every reader coalesces with `?? ""`.

`src/http/server/route.ts:21` writes `context.state.match`, read back as
`(context.state as RoutedState).match`. That is the only carrier of the matched `Operation` and the
parsed path parameters.

### The raw body is vendor-guaranteed, not configurable

`@koa/bodyparser@6.1.0` hard-codes `returnRawBody: true` inside `parseBody` and then assigns
`ctx.request.rawBody = response.raw`. There is **no option** that turns it on or off, so the EPIC
line "raw-byte preservation is configured on the body parser explicitly" cannot be honoured
literally. Story 3 asserts the behaviour instead, with a probe app that reads back
`{ "a" : 1 }` byte for byte. That assertion is what fails on a vendor bump that drops the flag.

`rawBody` is a **`utf-8` string**, not a `Buffer`. `fingerprint` hashes it through a byte-length
prefix, so the bytes are what is compared.

### A handler cannot set a response header

`HandlerResult` (`src/http/server/app.ts:27`) is `{ status, body }`, and
`src/http/server/dispatch.ts:34-35` copies only those two. Nothing in `src/http/server/` calls
`context.set` today, so every header this epic captures is one koa itself set (`content-type`) or
one a middleware set.

**This is a fact about today, not a limit on the replay contract.** `captureAnswer` reads
`context.response.headers` after `next()`, so it captures whatever the response carries — including
the `ETag` of a future `blob.show`-shaped answer, and including a header set by a middleware EPIC
010.5 adds. It records a header that is **new or changed** since the pre-`next()` snapshot, so a
header the origin middleware set for the duplicate's own origin never leaks into a replay, while a
header the handler overwrote or merged still does.

### A joiner always receives the original's answer

`joined` yields `Promise<StoredAnswer>`, never `null`. An **uncacheable** outcome deletes the record
so that a request arriving _after_ completion runs the command again — but it still hands every
already-joined duplicate the original's answer. Releasing joiners to run the command themselves
would turn one retry burst of N duplicates into N concurrent executions, which is the exact opposite
of duplicate suppression. `src/http/server/idempotency-store.test.ts` and
`src/http/server/idempotency.test.ts` each carry a regression guard for it.

`settle` therefore has a normative step order: identity guard, **resolve every waiter**, then
retention accounting. Resolving first is what makes "a joiner always settles" independent of
`JSON.stringify` throwing on a cyclic body and independent of the byte bound dropping the record.

The `settle` closure compares the record **object**, not the key. A key-only guard lets a stale
closure settle a _later_ reservation of the same key after the earlier one was deleted.

### `maxBytes` is a hard bound, and it is an accounting bound

`settle` evicts completed records to make room, and **declines to retain** an answer that still does
not fit. `bytes()` is at or under `maxBytes` after every operation, and every test asserts it. The
unit is serialized answer bytes plus record-key and fingerprint bytes — not retained JavaScript heap
size, which is not measurable deterministically.

The stored body is held **by reference**. A handler that mutates a body it already returned would
change every replay; Story 6 pins that as a constraint rather than deep-copying, because a copy
would double the retained bytes and would not survive a non-JSON body.

### The join wait is bounded twice over

**Structurally**, a joiner never outlives its original: `settle` runs on both the resolve and the
reject path of `next()`, resolves its waiters first, and cannot throw before it does.

**Finitely**, a joiner never outlives `joinTimeoutSeconds` either, even when the original hangs
forever. `reserve` arms the injected `schedule` when it hands out a `joined` outcome, and the
outcome is a discriminated `{ kind: "answer" } | { kind: "timeout" }`. A timeout removes only its own
waiter — the reservation stands, the original keeps running, and a third duplicate still joins it —
and the middleware answers `503 service-unavailable`. A `joinTimeoutSeconds` of `0` arms nothing and
gives the join the lifetime of the original.

The timer is injected rather than called in place so the suite proves the bound by firing a manual
scheduler, with no wall-clock delay and no flake. `createApp` supplies the production default, and
it unrefs.

Expiry works the other way and needs no timer at all: there is no background sweeper. `reserve`
sweeps first, so a record expires the next time the store is touched.

### Determinism rules pinned across the stories

- **Fault emission order** — Story 1's two faults, then Story 2's two, all inside one
  `for (const entry of entries)` appended after `registry.ts:231`. Tests assert exact arrays.
- **Classification order** — `internal` beats `replayable`. A non-`HttpError` throw is always
  `indeterminate` (`src/http/server/idempotency-record.ts`).
- **Key grammar order** — repeated header, then grammar. A 256-character key sent twice reports
  "more than once".
- **Middleware step order** — validate, absent, policy, `durable`, zero TTL, reserve. A malformed
  key is `400` on a `GET`, on `plan.import`, and with `ttl: 0`.
- **Fingerprint join** — every part is byte-length-prefixed, so the concatenation cannot be
  repartitioned.
- **Record-key parameter order** — bytewise sort by name, so `{id,hash}` and `{hash,id}` render the
  identical string.
- **Captured header set** — a header is captured when it is **new or changed** since the pre-`next()`
  snapshot. The snapshot carries values, not names: a name-only comparison loses a downstream
  overwrite or a `context.vary` merge of a header an upstream middleware already set.
- **Captured header order** — bytewise sort by lowercased name, so a replay is byte-identical.
- **"Byte-identical"** means the status, the body bytes and every retained answer header. It does
  not mean the literal HTTP response octets: `Date` and `Content-Length` are in `VOLATILE_HEADERS`
  because the daemon does not own them.
- **`applyAnswer` write order** — headers, then body, then status. Status last, because koa's body
  setter assigns `200` when no status was set and `204` when the body is `null`.
- **Eviction order** — ascending `expiresAt`, tie-broken by ascending `seq`. `seq` is unique per
  store, so no two records ever tie.
- **The expiry comparison** — `expiresAt <= now` sweeps. `expiresAt === null` never sweeps and never
  evicts.
- **`settle` step order** — identity guard, resolve waiters, then retain or drop.

### Test conventions this epic follows

- Suite name is the module path: `describe("src/http/server/idempotency.test", …)`.
- A probe app is built the way `src/http/server/origin.test.ts:10-18` builds one: a bare `new Koa()`
  with `envelopeMiddleware({ onInternalError: () => {} })`, the middleware under test, and a
  terminal probe. It is reached with `loopbackAgent` from `test/helpers/agent.ts`, which unrefs one
  memoized server per app on `127.0.0.1:0`.
- **The clock in a test is a local `let now = 1_000; const clock = () => now;`.** Do **not** use
  `createMockClock` from `test/helpers/clock.ts`: it advances on _every_ call, and these tests need
  the clock to move only when the test moves it.
- **Concurrency is expressed with a gate, never a sleep.** The handler resolves an `arrived`
  deferred on entry and awaits a `gate` deferred. A `setTimeout` would not be hermetic. Two shapes,
  and both are needed:
  - the EPIC's literal "dispatched with no `await` between them" — send both, then `await arrived`,
    resolve `gate`, await both. Deterministic for every interleaving, because the gate is still shut
    when both reach `reserve`, so whichever reserves first, the other must join.
  - the sequenced shape, which proves _where_ the duplicate was — send 1, `await arrived`, send 2,
    poll `store.waiters(key) === 1` with `await new Promise(setImmediate)`, then act. This is what
    makes the disconnect test prove that the duplicate **joined** before it aborted, rather than
    proving that aborting an unstarted request is harmless.

  `store.waiters(recordKey)` exists for exactly that observation.

- `test/helpers/app.ts` defaults `now` to `() => 0` — frozen — so every suite outside this epic
  stays hermetic. No such suite sends an `Idempotency-Key`.

### Concurrent work in this tree

`src/domain/plan-*.ts`, `src/commands/plan/`, `src/services/plan/`, `src/http/server/plan/` and
`src/queries/plan/` are being written by EPIC 008 right now. **No story in this epic touches any of
them.** Story 7 asserts only that the middleware steps aside for `plan.import`; the durable retry
semantics belong to `.agent/plan/stories/008-project-and-plan/11-import-transaction.md:198-212`.

**Story 0 and Story 7 do touch EPIC 008's plan.** Story 0 adds `service-unavailable` to
`src/http/contract/errors.ts`, which EPIC 008's story 11 also reads (its refusal map at
`11-import-transaction.md:158-159`); the two edits are in different entries of the same object.
And `.agent/plan/stories/008-project-and-plan/11-import-transaction.md` was edited by **this**
epic's B3 decision, to constrain `importId` to printable ASCII. Neither is implemented yet —
`src/commands/plan/` and `planImportRequest` do not exist on disk — so both are spec edits ahead of
the implementing agent, not rework behind it.

EPIC 010.5 also edits `src/http/server/app.ts` and `test/helpers/app.ts`. This epic adds three
**optional** members to `AppDependencies`, one module-level constant and one `app.use` line, and
010.5 adds a required member to `TransportSettings` and two `app.use` lines. The two edits do not
overlap in a line, but they do overlap in a file: land 010.5 first, as the sequence order already
requires.

## Resolved decisions

The EPIC did not settle these. **Ulrich took all four blocking decisions**, and the EPIC, the
proposal and the stories now carry them. They are recorded here so a reviewer can see what changed
and why, not as open items.

- **B1 — backpressure and join timeout are `503 service-unavailable`, a new code.** The earlier pin
  was `500 internal-error`, and it had a real defect: a saturation `500` and an indeterminate `500`
  would be wire-identical while carrying opposite advice — the saturated key is safe to send again,
  the indeterminate one must never be re-run. `docs/proposal/api/README.md` now holds the `503` row
  and the rationale, and Story 0 brings `src/http/contract/errors.ts` (21 → 22 codes) and
  `src/cli/exit-code.ts` into line with it.
- **B2 — the join wait is bounded by an injected timer.** `IdempotencySettings` gains
  `joinTimeoutSeconds`, `IdempotencyStore` gains a `schedule` dependency, and `joined` yields a
  discriminated `{ kind: "answer" } | { kind: "timeout" }`. A timeout answers `503`, removes only
  its own waiter, and leaves the reservation and the original untouched. `0` restores the
  lifetime-of-the-original behaviour. The scheduler is injected so the bound is proved by firing a
  manual timer, with no wall-clock delay in any test.
- **B3 — `importId` is constrained to printable ASCII at its source.**
  `.agent/plan/stories/008-project-and-plan/11-import-transaction.md` now declares
  `importId: z.string().min(1).max(100).regex(/^[\x21-\x7E](?:[\x20-\x7E]{0,98}[\x21-\x7E])?$/)`,
  matching the header grammar of Story 3. EPIC 008 has not implemented that story yet —
  `src/commands/plan/` and `planImportRequest` do not exist on disk — so the change is a spec edit,
  not a rework. Its Verify section gains an accept/refuse table.
- **B4 — the misplaced Proof line moved.** EPIC 010.6 no longer claims to prove that a reordered
  `plan.import` retry returns the original revision; it proves that the raw-byte fingerprint never
  runs on the durable path, and points at EPIC 008, whose gate already carries "a reordered document
  array is still a retry".

Two choices remain free. Neither blocks dispatch.

- S1 - action:NO - **the bound defaults** - Story 8 pins `ttl 300`, `joinTimeout 30`,
  `maxEntries 256`, `maxBytes 8388608` (8 MiB) — roughly 32 KiB of retained answer per record, which
  fits an inline response but not a plan document, and a plan document travels as a blob. Change the
  literals in Story 8 and `defaultIdempotencySettings` in Story 4 together.
- S2 - action:NO - **"configured on the body parser explicitly"** - `@koa/bodyparser@6.1.0`
  hard-codes `returnRawBody: true` and exposes no option, so Story 3 asserts the behaviour with a
  vendor probe. The EPIC wording now says "asserted" rather than "configured".
