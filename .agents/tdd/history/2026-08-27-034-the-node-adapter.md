---
epic: .agents/plan/epics/034-the-node-adapter.md
opened: 2026-08-27
opener: test-engineer
base-ref: f69c190758ae0bc8eb31acec3fbfce6e50c5c64f
---

# Implementation cycle — 034-the-node-adapter

Pulled from EPIC: `.agents/plan/epics/034-the-node-adapter.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/server/start.test.ts \
>   src/http/server/shutdown.test.ts \
>   src/http/server/app.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/event/wait.test.ts \
>   src/main.test.ts \
>   src/main.event-wait.test.ts \
>   src/main.authorization.test.ts \
>   src/main.capability.test.ts \
>   && echo "PASS EPIC-034"
> ```

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — start.ts serves through the node adapter · Story 1

**Cycle.** RED for Task `034/story-1` (`src/domain/host-authority.test.ts` and `src/http/server/start.test.ts`).
**Test written.**

- file: `src/domain/host-authority.test.ts` (edited) — suite: `src/domain/host-authority.test` — methods: `brackets an IPv6 bind and leaves every other bind alone`
- file: `src/http/server/start.test.ts` (edited) — suite: `src/http/server/start.test` — methods: existing four listener cases, retargeted to the Hono application
- asserts: IPv4 binds stay unchanged, IPv6 binds gain brackets, and the existing listener contract accepts the Hono application.
  **RED proof.**
- command: `npm test`
- exit: 1 — failure: `SyntaxError: The requested module './host-authority.ts' does not provide an export named 'bindAuthority'`; the retargeted listener cases also fail with `TypeError: app.listen is not a function`
  **Open to Software Engineer.**
- `src/domain/host-authority.ts`: export `bindAuthority(bind: string): string`; return `[${bind}]` when `bind` contains `:`, otherwise return `bind`.
- `src/http/server/start.ts`: export `listen<E extends Env>(app: Hono<E>, input: ListenInput): Promise<ListeningServer>` with the existing `ListeningServer` contract and listener behavior.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — start.ts serves through the node adapter · Story 1

**Cycle.** GREEN+REFACTOR for `src/domain/host-authority.test.ts` and `src/http/server/start.test.ts`.
**Files changed.**

- `src/domain/host-authority.ts` (edited) — exports `bindAuthority` and reuses it for allowed-host derivation
- `src/http/server/start.ts` (edited) — serves generic `Hono<E>` applications through `@hono/node-server`
- `src/main.ts` (edited) — passes the `hono` application to `listen`
  **Seam (GREEN).** `listen` creates a node server from `app.fetch`, preserves the existing listening contract, and uses the bind authority fallback.
  **Refactor.** Extracted the IPv6 authority rule into `bindAuthority` and reused it in `deriveAllowedHosts`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `@hono/node-server` 2.1.1 exports `getRequestListener` with the required options; `node_modules/@hono/node-server/dist/index.d.mts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the adapter owns the wire behaviour the bridge proved · Story 2

**Handoff verification gate.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Story 1 confirmation: the focused suites report `ℹ tests 43`, `ℹ pass 43`, `ℹ fail 0`.

**Cycle.** RED for Task `034/story-2` (`src/http/server/start.test.ts`).
**Test written.**

- file: `src/http/server/start.test.ts` (edited) — suite: `src/http/server/start.test` — methods: `a %2F path and a %zz path each reach the route intact`, `a Uint8Array answer carries the exact content-length and the exact bytes`, `a 204 answer carries neither content-length nor content-type`, `a POST body reaches the route with its whitespace intact`, `listen leaves the global Request and Response untouched`, `a request with no Host header answers 403 host-forbidden`, `an in-flight request drains before close resolves`
- asserts: The adapter preserves encoded paths, exact bytes and headers, body whitespace, global identities, no-Host refusal, and drain ordering.
  **RED proof.**
- command: `npm test`
- exit: 0 — `ℹ tests 5316`, `ℹ pass 5316`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`
- characterization note: Story 2 adds coverage for behavior already shipped by Story 1; the first-run pass is intentional.
- sensitivity probe: `node --test src/http/server/start.test.ts` with one temporary wrong expected message — exit 1 — failure: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`; the expected message was restored.
- typecheck: `npm run typecheck` — exit 0; no `TS2307` seam required a stub probe.
  **Open to Software Engineer.**
- `src/http/server/start.ts`: exported `listen<E extends Env>(app: Hono<E>, input: ListenInput): Promise<ListeningServer>` is the exercised seam.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the adapter drains and leaves globals alone · Story 2

**Cycle.** GREEN+REFACTOR for `src/http/server/start.test.ts`.
**Files changed.**

- None — the Story 1 adapter already satisfies the seven characterization cases.
  **Seam (GREEN).** `listen` already uses `getRequestListener` with `overrideGlobalObjects: false`, preserves wire behavior, and drains requests through `node:http`.
  **Refactor.** No named refactor in Story 2; retained the existing adapter implementation.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the level-2 socket harness runs against the adapter · Story 3

**Cycle.** Blocked before Task `034/story-3`; the locked Story 3 and Story 4 scopes contradict the current test tree.

**Handoff verification gate.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

**Blocker.**

- B1 - status:OPEN - app-test-scope - `src/http/server/app.test.ts` calls `loopbackServer(created.app)` and asserts `created.app.proxy === false`; Story 3 excludes this file, while Story 4 drops `App.app` and forbids all test edits - fix: Amend the locked plan so Story 3 owns this test migration and defines the fate of the Koa-only proxy assertion - why: Story 4's production `App` shape makes both accesses invalid, so its required `npm run typecheck` cannot pass under the current scopes.

**Action required.** Human amendment is required before Aelita edits the level-2 harness. No path opens to the software-engineer because the missing change belongs to the test-engineer lane.

ATTEMPT-FAILED: 034/story-3 — locked Story 3 and Story 4 scopes omit required `app.test.ts` changes

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the level-2 socket harness runs against the adapter · Story 3

**Cycle.** Blocked for Task `034/story-3`.
**Files changed.**

- None — the locked Story 3 scope omits a required test migration, and test files are outside this lane.
  **Open.**
- B1 - status:OPEN - action:YES - app-test-scope - `src/http/server/app.test.ts` calls `loopbackServer(created.app)` and asserts `created.app.proxy === false`, but Story 3 excludes this file while Story 4 removes `App.app` and forbids test edits - fix: Amend Story 3 to own the `app.test.ts` migration and define the fate of the Koa-only proxy assertion - why: The planned production `App` shape makes both accesses invalid, so the planned typecheck cannot pass under the current scopes.
  **Build check.**
- typecheck: exit 0

OPEN: Human amendment is required before the level-2 harness can move to the node adapter.
ATTEMPT-FAILED: 034/story-3 — locked Story 3 and Story 4 scopes omit required `app.test.ts` changes

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the level-2 socket harness runs against the adapter · Story 3

**Cycle.** Blocked for Task `034/story-3`; no human plan amendment is present.
**Handoff verification gate.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
  **Blocker.**
- B1 - status:OPEN - action:YES - app-test-scope - `src/http/server/app.test.ts` still calls `loopbackServer(created.app)` and asserts `created.app.proxy === false`; Story 3 excludes this test, while Story 4 removes `App.app` and forbids test edits - fix: Amend Story 3 to own the required `app.test.ts` migration and define the fate of the Koa-only proxy assertion - why: The planned production `App` shape makes both accesses invalid, so the planned typecheck cannot pass after Story 4.
  **Action required.** Human amendment is required before Aelita edits the level-2 harness. No path opens to the software-engineer because the missing change belongs to the test-engineer lane.

ATTEMPT-FAILED: 034/story-3 — locked Story 3 and Story 4 scopes omit required `app.test.ts` changes

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the level-2 socket harness runs against the adapter · Story 3

**Cycle.** No-op handoff for Task `034/story-3`; the amended plan resolves the previous scope blocker.
**Files changed.**

- None — Story 3 permits only test and test-helper edits, which remain outside this lane.
  **Handoff.**
- The test-engineer must apply the amended Story 3 migration before Story 4 production work.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 3 now includes `src/http/server/app.test.ts`; it lists no production source.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the level-2 socket harness runs against the adapter · Story 3

**Cycle.** Confirm GREEN for Task `034/story-3` after the amended scope repair.
**Test written.**

- files: `test/helpers/agent.ts`, `test/helpers/agent.test.ts`, `test/helpers/app.ts`, `src/http/server/app.test.ts`, `src/http/server/host.test.ts`, `src/http/server/idempotency.test.ts`, `src/http/server/shutdown-socket.test.ts` (edited)
- file: `src/http/server/koa-bridge.test.ts` (deleted) — removed its six restated cases
- asserts: Level-2 socket callers use the Hono application directly, preserve every existing assertion, and retain the helper exports and cache behavior.
  **GREEN proof.**
- command: `npm test`
- exit: 0 — `ℹ tests 5310`, `ℹ pass 5310`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`
- build-only check: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
  **Open to Software Engineer.**
- `src/http/server/koa-bridge.ts`: production bridge module for Story 4 removal.
- `src/http/server/app.ts`: exported `App` and `createApp` production seam for the remaining Hono application contract.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Delete the koa bridge and drop the app half · Story 4

**Cycle.** GREEN+REFACTOR for Task `034/story-4`.
**Files changed.**

- `src/http/server/app.ts` (edited) — removes the Koa field, import, bridge import, and returned bridge.
- `src/http/server/koa-bridge.ts` (deleted) — removes the obsolete transport bridge.
  **Seam (GREEN).** `createApp` now returns only the Hono application and the wait-cancellation handle.
  **Refactor.** Deleted the obsolete bridge module as specified.
  **Build check.**
- typecheck: exit 1 — `src/http/server/app.test.ts(612,13): error TS2339: Property 'app' does not exist on type 'Readonly<{ hono: Hono<AppEnv, BlankSchema, "/">; cancelWaits: () => void; }>'.`

OPEN: `src/http/server/app.test.ts` still destructures the removed `created.app`; the test-engineer must apply the Story 4 test migration before typecheck can pass.
ATTEMPT-FAILED: 034/story-4 — the lane-owned Story 4 test migration is not applied.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — delete the koa bridge and drop the app half · Story 4

**Cycle.** Confirm GREEN for Task `034/story-4` after the lane-owned test migration.
**Test written.**

- file: `src/http/server/app.test.ts` (edited) — suite: `src/http/server/app.test` — removed the obsolete proxy case, updated the returned-key assertion, and removed the bridge-only scan
- asserts: `createApp` exposes only the Hono application and cancel handle while production sources keep the existing header-write constraints.
  **GREEN proof.**
- handoff: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- command: `npm test`
- exit: 0 — `ℹ tests 5309`, `ℹ pass 5309`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`
  **Blocker.**
- B1 - status:OPEN - action:YES - story-4-koa-grep - `grep -rni koa src test scripts` still finds two stale `koa-body` references in `src/http/server/bytewise.test.ts`, but Story 4 forbids edits to every test file except `src/http/server/app.test.ts` - fix: Amend Story 4 to allow this stale test-reference migration or narrow its zero-match verification scope - why: The locked scope cannot satisfy its own no-koa verification gate.

**Action required.** Human amendment is required before the Story 4 verification gate can pass. No path opens to the software engineer.

ATTEMPT-FAILED: 034/story-4 — Story 4 verification grep finds stale koa-body references in a test file outside its locked edit scope

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — Delete the koa bridge and drop the app half · Story 4

**Cycle.** Blocked for Task `034/story-4`.
**Files changed.**

- None — the remaining change is test-engineer-owned.
  **Open.**
- B1 - status:OPEN - action:YES - bytewise-test-scope - `src/http/server/bytewise.test.ts` still names `koa-body` and excludes it from the production scan; the Story explicitly assigns this test migration to Story 4, but the last test-engineer turn treats it as outside scope - fix: rename the case and remove the `koa-body` filter as specified by Story 4 - why: production code cannot remove stale names from a test, and the no-koa verification gate cannot pass until the test-engineer applies its assigned edit.
  **Build check.**
- typecheck: exit 0

OPEN: `src/http/server/bytewise.test.ts` needs the Story 4 test migration; it is outside the software-engineer lane.
ATTEMPT-FAILED: 034/story-4 — the remaining no-koa test migration is test-engineer-owned

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Story 4 test migration is complete; all four Stories are green.

- handoff: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0 — `ℹ tests 5309`, `ℹ pass 5309`, `ℹ fail 0`
- Gates (`npm run verify`) → exit 0
  **Story confirmation.**
- file: `src/http/server/bytewise.test.ts` (edited) — removed the obsolete `koa-body` exclusion.
- asserts: The production server scan rejects every `node:buffer` import.
  **Proof.** The EPIC Proof command → exit 0.
- output: `ℹ tests 151`, `ℹ suites 11`, `ℹ pass 151`, `ℹ fail 0`, `PASS EPIC-034`
  **Tasks closed.** 4 across 4 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/server/start.test.ts src/http/server/shutdown.test.ts src/http/server/app.test.ts src/http/server/dispatch.test.ts src/http/server/route.test.ts src/http/server/event/wait.test.ts src/main.test.ts src/main.event-wait.test.ts src/main.authorization.test.ts src/main.capability.test.ts && echo "PASS EPIC-034") — "PASS EPIC-034"
- stories: 4/4 complete
- date: 2026-08-27
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
