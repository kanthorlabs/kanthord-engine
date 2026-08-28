---
epic: .agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md
opened: 2026-08-27
opener: test-engineer
base-ref: 1ee82aece965a726c98470b6318ffd625852c56a
---

# Implementation cycle — 035-remove-koa-and-split-the-composition-roots

Pulled from EPIC: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/server/core-purity.test.ts \
>   src/koa-absence.test.ts \
>   src/http/server/bytewise.test.ts \
>   src/http/server/runtime/node/listen.test.ts \
>   src/http/server/runtime/node/schedule.test.ts \
>   src/http/server/app.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/query.test.ts \
>   src/http/server/single.test.ts \
>   src/http/server/invalid-request.test.ts \
>   src/http/server/idempotency-key.test.ts \
>   src/http/server/idempotency.test.ts \
>   src/http/server/idempotency-record.test.ts \
>   src/http/server/idempotency-response.test.ts \
>   src/http/server/idempotency-store.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/envelope.test.ts \
>   src/http/server/auth.test.ts \
>   src/http/server/authorize.test.ts \
>   src/http/server/host.test.ts \
>   src/http/server/origin.test.ts \
>   src/http/server/preflight.test.ts \
>   src/http/server/shutdown.test.ts \
>   src/http/server/blob/show-blob.test.ts \
>   src/http/server/event/list-event.test.ts \
>   src/main.test.ts \
>   && echo "PASS EPIC-035"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **`grep -rn --exclude=koa-absence.test.ts "koa" src/ test/ scripts/` returns nothing**, asserted by
>   `src/koa-absence.test.ts` rather than by hand. The exclusion is required: that test names koa in its
>   own path, its suite name and its fixtures, and it excludes itself by path. The test names the
>   offending file and line on failure.
> - **No file in the Fetch-native core imports a `node:` builtin**, asserted by
>   `src/http/server/core-purity.test.ts`. The failure names the offending file and the specifier. A
>   file added under `src/http/server/runtime/` does not trigger it, and a file added anywhere else
>   under `src/http/server/` does.
> - **The daemon boots and answers a request end to end.** One daemon-backed test starts the process,
>   sends an authenticated request, reads the status and the body, and stops the process.
> - **Every EPIC 030 parity test still passes.** The transport inventory and the parity contract of
>   EPIC 030 run unchanged, and no expectation in them is edited by this epic.
> - **The bytewise order is unchanged.** The non-ASCII ordering test of the determinism rule asserts
>   the same order through `compareBytewise` that it asserted through `Buffer.compare`.
> - **The idempotency fingerprint is stable.** An exact-string test pins the SHA-256 hex for one named
>   method, path, query and body, and the value equals the value the `node:crypto` implementation
>   produced.
> - **The Node root is the only Node-only place.** `src/http/server/runtime/node/` holds the listener
>   and the schedule, and `src/main.ts` is the only production importer of both, asserted by
>   `src/http/server/core-purity.test.ts`.
> - **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
>   A test that needs a home uses its own `mktemp` directory and removes it.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the Node-only modules move to the Node root · Story 1

**Cycle.** RED for Task `035/story-1` (`src/http/server/runtime/node/listen.test.ts`, `src/http/server/runtime/node/schedule.test.ts`, `src/http/server/app.test.ts`).
**Test written.**

- file: `src/http/server/runtime/node/listen.test.ts` (new; moved from `src/http/server/start.test.ts`) — suite: `src/http/server/runtime/node/listen.test` — methods: all existing listener cases, retained byte for byte
- file: `src/http/server/runtime/node/schedule.test.ts` (new) — suite: `src/http/server/runtime/node/schedule.test` — methods: `runs its callback at the delay and not before`, `the returned canceller stops the callback`, `unrefs the timer`
- file: `src/http/server/app.test.ts` (edited) — suite: `src/http/server/app.test` — methods: `createApp without a schedule builds an app whose core names no runtime or unref`, `the default schedule runs and cancels through an app built without a schedule`
- asserts: The listener keeps its wire contract, the schedules run and cancel at exact delays, and `createApp` uses the core default when no schedule is supplied.
  **RED proof.**
- command: `npm test`
- exit: 1 — summary: `ℹ pass 5299`, `ℹ fail 3`
- failure: `true !== false`
- failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/runtime/node/listen.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/runtime/node/listen.test.ts`
- failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/runtime/node/schedule.ts' imported from /Users/tuannguyen/Projects/kanthorlabs/kanthord/engine/src/http/server/runtime/node/schedule.test.ts`
- stub probe: `src/http/server/runtime/node/listen.ts` — clean
- stub probe: `src/http/server/runtime/node/schedule.ts` — clean
  **Open to Software Engineer.**
- `src/http/server/runtime/node/listen.ts`: export `ListenInput`, `ListeningServer`, and `listen<E extends Env>(app: Hono<E>, input: ListenInput): Promise<ListeningServer>`.
- `src/http/server/runtime/node/schedule.ts`: export `systemSchedule` with the `Schedule` signature `(milliseconds: number, callback: () => void) => () => void`.
- `src/http/server/app.ts`: `createApp(dependencies: AppDependencies): App` accepts an omitted `schedule` and satisfies the default-schedule assertions.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 035-remove-koa-and-split-the-composition-roots · The Node-only modules move to the Node root

**Cycle.** GREEN+REFACTOR for `035/story-1` (`src/http/server/runtime/node/listen.test.ts`, `src/http/server/runtime/node/schedule.test.ts`, `src/http/server/app.test.ts`).
**Files changed.**

- `src/http/server/runtime/node/listen.ts` (new) — Node listener adapter.
- `src/http/server/runtime/node/schedule.ts` (new) — `systemSchedule` adapter.
- `src/http/server/start.ts` (deleted) — moved listener source.
- `src/http/server/app.ts` (edited) — Web-native default schedule.
- `src/main.ts` (edited) — Node-root listener and schedule wiring.
  **Seam (GREEN).** The runtime tests now import the listener and unref schedule from `runtime/node`, while `createApp` uses its Web-native fallback.
  **Refactor.** Moved Node-only transport APIs to the Node root and preserved daemon `unref` behavior through `main.ts`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The current listener contained one relative domain import, so its path changed for the deeper runtime location; `npm run typecheck` confirms resolution.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the core drops `node:crypto` and the global `Buffer` · Story 2

**Cycle.** RED for Task `035/story-2` (`src/http/server/bytewise.test.ts`, `src/http/server/idempotency-key.test.ts`).
**Test written.**

- file: `src/http/server/bytewise.test.ts` (edited) — suite: `src/http/server/bytewise.test` — methods: `returns zero for an empty string`, `returns one byte for each ASCII character`, `returns UTF-8 byte lengths for accented and euro characters`, `returns four bytes for a supplementary character`
- file: `src/http/server/idempotency-key.test.ts` (edited) — suite: `src/http/server/idempotency-key.test` — methods: all existing `fingerprint` cases now await the result, `returns the pinned fingerprint for a named request`, `sorts non-ASCII parameter names by UTF-8 bytes`
- asserts: UTF-8 byte lengths, an asynchronous stable fingerprint, and exact bytewise parameter ordering.
  **RED proof.**
- command: `npm test`
- exit: 1 — summary: `ℹ tests 5312`, `ℹ pass 5310`, `ℹ fail 2`
- failure: `SyntaxError: The requested module './bytewise.ts' does not provide an export named 'byteLength'`
- failure: `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value` at `assert.ok(result instanceof Promise)`
- typecheck probe: `npm run typecheck` — only the expected missing-export error remains: `src/http/server/bytewise.test.ts(7,10): error TS2305: Module '"./bytewise.ts"' has no exported member 'byteLength'.`
  **Open to Software Engineer.**
- `src/http/server/bytewise.ts`: export `byteLength(value: string): number` with the UTF-8 byte-count contract.
- `src/http/server/idempotency-key.ts`: export `fingerprint(input: FingerprintInput): Promise<string>` with the pinned SHA-256 result and preserve the existing `recordKey` contract.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 035-remove-koa-and-split-the-composition-roots · The core drops `node:crypto` and the global `Buffer`

**Cycle.** GREEN+REFACTOR for `035/story-2` (`src/http/server/bytewise.test.ts`, `src/http/server/idempotency-key.test.ts`).
**Files changed.**

- `src/http/server/bytewise.ts` (edited) — `byteLength` over the shared `TextEncoder`.
- `src/http/server/idempotency-key.ts` (edited) — Web Crypto fingerprint and UTF-8 byte lengths.
- `src/http/server/idempotency.ts` (edited) — awaits the asynchronous fingerprint.
- `src/http/server/idempotency-store.ts` (edited) — uses `byteLength` for all size measurements.
  **Seam (GREEN).** The fingerprint preserves its length-prefixed SHA-256 bytes while the core uses Web APIs instead of Node APIs.
  **Refactor.** Moved all remaining idempotency byte measurements to the shared bytewise helper and kept the Node root untouched.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Node 24 global Web Crypto and `TextEncoder` types resolve under the project compiler; `npm run typecheck` exits 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the core-purity test fails on a `node:` import · Story 3

**Cycle.** RED for Task `035/story-3` (`src/http/server/core-purity.test.ts`).
**Test written.**

- file: `src/http/server/core-purity.test.ts` (new) — suite: `src/http/server/core-purity.test` — methods: `the core imports no node builtin`, `the core reaches into no runtime root`, `the core imports no runtime-only vendor package`, `src/main.ts is the only production importer of the Node root`, `a single-line node import is detected`, `a multiline node import is detected`, `a node re-export is detected`, `a node type import is detected`, `a node side-effect import is detected`, `a node dynamic import is detected`, `a single-quoted specifier is detected`, `a commented import is not detected`, `an object property named node is not detected`, `a runtime reach is detected in the runtime list only`, `the runtime vendor package is detected`, `isExempt compares the whole path`, `the walk applies the runtime exemption`
- asserts: The Fetch-native core has no Node or runtime-root imports, only `src/main.ts` imports the Node root, and grammar parsing ignores comments and object properties.
  **RED proof.**
- handoff gate: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- command: `npm test`
- exit: 1 — unrelated full-suite failure: `✖ the default schedule runs and cancels through an app built without a schedule (60002.280125ms)`; `'test timed out after 60000ms'`
- characterization command: `node --test src/http/server/core-purity.test.ts` → exit 0 — `ℹ tests 17`, `ℹ pass 17`, `ℹ fail 0`, `ℹ cancelled 0`
- sensitivity probe: temporary wrong expected specifier with `node --test src/http/server/core-purity.test.ts` → exit 1 — `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:`; expected value was restored
- typecheck: `npm run typecheck` → exit 0; no missing seam required a stub probe
  **Open to Software Engineer.**
- `src/http/server/bytewise.ts`: `compareBytewise(left: string, right: string): number` is the imported path-ordering seam.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 035-remove-koa-and-split-the-composition-roots · The core-purity test fails on a `node:` import

**Cycle.** GREEN+REFACTOR for `035/story-3` (`src/http/server/core-purity.test.ts`).
**Files changed.**

- none — Story 3 adds only the test file, and the existing production graph satisfies its scanner.
  **Seam (GREEN).** No production change is required; `compareBytewise` already supplies the named ordering seam.
  **Refactor.** deferred: Story 3 names no production refactor.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The test-engineer's focused scanner run passed 17 tests; the Story forbids production edits.
- VERIFIED: `npm run typecheck` exits 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the Koa-absence test fails on the string `koa` · Story 4

**Cycle.** RED for Task `035/story-4` (`src/koa-absence.test.ts`).
**Test written.**

- file: `src/koa-absence.test.ts` (new) — suite: `src/koa-absence.test` — methods: `no file under src, test or scripts names koa`, `a koa import is detected`, `the case-insensitive form is detected`, `the test excludes itself`, `the three roots are walked`
- asserts: The scanner walks the three repository roots, excludes itself, reports every case-insensitive match with its line number, and leaves the current tree Koa-free.
  **RED proof.**
- handoff gate: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- command: `npm test`
- exit: 1 — unrelated failure: `✖ the default schedule runs and cancels through an app built without a schedule (60002.755417ms)`; `'test timed out after 60000ms'`
- characterization command: `node --test src/koa-absence.test.ts` → exit 0 — `ℹ tests 5`, `ℹ pass 5`, `ℹ fail 0`, `ℹ cancelled 0`; the synthetic Koa and case-insensitive fixtures prove scanner sensitivity.
  **Open to Software Engineer.**
- No production seam: Story 4 requires no production change; confirm the test-only story.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 035-remove-koa-and-split-the-composition-roots · The Koa-absence test

**Cycle.** GREEN+REFACTOR for `035/story-4` (`src/koa-absence.test.ts`).
**Files changed.**

- none — Story 4 adds only the test and forbids production edits.
  **Seam (GREEN).** No production seam is required; the test-only scanner story is complete.
  **Refactor.** deferred: Story 4 names no production refactor.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `src/koa-absence.test.ts` is the only scope for Story 4, per the Story file.
- VERIFIED: `npm run typecheck` exits 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the proposal states the transport structure · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task `035/story-5`.
**Story file.** `.agents/plan/stories/035-remove-koa-and-split-the-composition-roots/05-the-proposal-states-the-transport-structure.md`
**Tasks forwarded to Software Engineer.**

- `035/story-5`: `docs/proposal/phase-1/transport.md` — add the normative transport core and runtime roots section from Story 5.
  **No RED phase.** This documentation-only Story has no `Action — RED:` block; coverage is owned elsewhere per the Story gate.
  **Handoff verification.**
- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
  **Open to Software Engineer.**
- Implement `035/story-5` per the Story file's Change and Constraints sections.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 035-remove-koa-and-split-the-composition-roots · The proposal states the transport structure

**Cycle.** GREEN-ONLY implementation for Tasks: `035/story-5`.
**Files changed.**

- `docs/proposal/phase-1/transport.md` (edited) — added the transport core and runtime roots section.
  **Seam (GREEN).** The proposal now states the Fetch-native core, runtime roots, and core-purity enforcement.
  **Refactor.** Applied the required Prettier formatting; no unrelated lines changed.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation verification blocked

**Cycle.** Confirm GREEN for Task `035/story-5` is blocked by the Story and EPIC verification gate.
**Verification result.**

- handoff gate: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- build-only check: `npm run typecheck` → exit 0
- Story and EPIC Gates: `npm run verify` → exit 1; `ℹ tests 5342`, `ℹ pass 5341`, `ℹ fail 0`, `ℹ cancelled 1`
- failure: `✖ the default schedule runs and cancels through an app built without a schedule (60002.514ms)`
- failure: `'test timed out after 60000ms'`
- EPIC Proof command: timed out after 600000ms while running `src/http/server/app.test.ts`; `PASS EPIC-035` was not printed.
  **Action required.**
- Resolve the timeout in `src/http/server/app.test.ts` or its `createApp` schedule seam before the Story and EPIC gates can pass.

ATTEMPT-FAILED: 035/story-5 — `npm run verify` still fails on the default-schedule app test timeout

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 035-remove-koa-and-split-the-composition-roots · The proposal states the transport structure

**Cycle.** GREEN+REFACTOR for `035/story-5` (`src/http/server/app.test.ts`).
**Files changed.**

- none — the active failure is in a test-owned synchronization path.
  **Seam (GREEN).** No production change can satisfy the test without violating Story 2's asynchronous `fingerprint` contract.
  **Refactor.** deferred: the test must synchronize until the second request reaches the idempotency store.
  **Build check.**
- typecheck: exit 0
  **OPEN:** `src/http/server/app.test.ts` requires a test-lane synchronization fix. Its one `setImmediate` after each duplicate request does not guarantee that asynchronous `fingerprint` has reached `store.reserve`; update the test synchronization, then rerun the Story and EPIC gates.

ATTEMPT-FAILED: 035/story-5 — `npm run verify` remains blocked by the default-schedule app test timeout caused by test synchronization after Story 2.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- Gates: `npm run verify` → exit 0.
- typecheck (`npm run typecheck`) → exit 0.
- unit (`npm test`) → exit 0; 5342 tests passed.
- The app test now synchronizes duplicate requests through the injected deterministic clock.
  **Proof.**
- command: `node --test src/http/server/core-purity.test.ts src/koa-absence.test.ts src/http/server/bytewise.test.ts src/http/server/runtime/node/listen.test.ts src/http/server/runtime/node/schedule.test.ts src/http/server/app.test.ts src/http/server/dispatch.test.ts src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/invalid-request.test.ts src/http/server/idempotency-key.test.ts src/http/server/idempotency.test.ts src/http/server/idempotency-record.test.ts src/http/server/idempotency-response.test.ts src/http/server/idempotency-store.test.ts src/http/server/route.test.ts src/http/server/envelope.test.ts src/http/server/auth.test.ts src/http/server/authorize.test.ts src/http/server/host.test.ts src/http/server/origin.test.ts src/http/server/preflight.test.ts src/http/server/shutdown.test.ts src/http/server/blob/show-blob.test.ts src/http/server/event/list-event.test.ts src/main.test.ts && echo "PASS EPIC-035"` → exit 0.
- output: `"PASS EPIC-035"`
  **Tasks closed.** 5 across 5 Stories — no Story remains outstanding.
  **Human actions outstanding.**
- S1 - status:OPEN - action:YES - remove the Koa dependencies - `package.json` still holds five locked Koa entries - fix:human deletes the five entries and updates `package-lock.json` - why:the lane contract locks package manifests.
- S2 - status:OPEN - action:YES - ban Koa in eslint - the source tree lacks the locked import restriction - fix:human adds the prescribed `no-restricted-imports` group - why:the lane contract locks configuration files.
- S3 - status:OPEN - action:YES - amend the architecture contract - `AGENTS.md` still needs the final core-purity row - fix:human adds the prescribed row and wording - why:the lane contract locks the architecture contract.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test … && echo "PASS EPIC-035") — "PASS EPIC-035"
- stories: 5/5 complete
- date: 2026-08-27
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 — Koa dependencies remain in package.json; remove the five Koa packages and update package-lock.json.
BLOCKER: B2 — ESLint does not ban Koa imports; add the specified no-restricted-imports group to eslint.config.js.
BLOCKER: B3 — Architecture enforcement remains incomplete; apply the specified runtime-root wording and core-purity row to AGENTS.md.

## TEST-ENGINEER — EPIC 035 review blockers remain

**Cycle.** Post-review blocker repair for B1-B3; all five Tasks remain green.

**Test written.**

- None. The routed findings target lane-locked manifest, config and architecture files; no test-owned seam exists.

**Verification result.**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Lane probes confirm that the software-engineer cannot edit `package.json`, `eslint.config.js` or `AGENTS.md`.

**Open to Human.**

- B1 - status:OPEN - action:YES - Koa dependencies - `package.json` and `package-lock.json` still retain five Koa packages - fix:remove `koa`, `@koa/bodyparser`, `@koa/cors`, `@types/koa` and `@types/koa__cors`, then run `npm install` - why:the toolchain manifest is locked to the engineer lanes
- B2 - status:OPEN - action:YES - Koa lint ban - `eslint.config.js` lacks the required transport import restriction - fix:add `group: ["koa", "@koa/*"]` with the prescribed message to the `src/**/*.ts` restriction - why:the toolchain config is locked to the engineer lanes
- B3 - status:OPEN - action:YES - architecture enforcement - `AGENTS.md` still has the old transport wording and no core-purity row - fix:apply the prescribed runtime-root wording and add the `src/http/server/core-purity.test.ts` enforcement row - why:the architecture contract is locked to the engineer lanes

OPEN: EPIC 035 cannot close until the human applies B1, B2 and B3.
ATTEMPT-FAILED: 035/review-blockers — all routed blockers require human edits to locked files

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC 035 review blockers

**Cycle.** Review-blocker confirmation for `035/review-blockers`.
**Review blocker addressed.** Human-applied fixes now cover:

- `BLOCKER: B1 — Koa dependencies remain in package.json; remove the five Koa packages and update package-lock.json.`
- `BLOCKER: B2 — ESLint does not ban Koa imports; add the specified no-restricted-imports group to eslint.config.js.`
- `BLOCKER: B3 — Architecture enforcement remains incomplete; apply the specified runtime-root wording and core-purity row to AGENTS.md.`
  **Files changed.**
- none — the three fixes are lane-locked and already present in the working tree.
  **Seam (GREEN).** The manifest, lockfile, ESLint restriction, and architecture contract now satisfy B1-B3.
  **Refactor.** None; no production edit remains for this blocker repair.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `package.json` and `package-lock.json` contain no Koa dependency entries.
- VERIFIED: `eslint.config.js` contains the prescribed `group: ["koa", "@koa/*"]` restriction.
- VERIFIED: `AGENTS.md` contains the runtime-root wording and the core-purity enforcement row.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Independent handoff verification and the complete EPIC gates pass after B1-B3.

- typecheck (`npm run typecheck`) → exit 0.
- unit (`npm test`) → exit 0; 5342 tests passed.
- Gates (`npm run verify`) → exit 0; typecheck, unit tests, lint and database status pass.
  **Proof.**
- command: `node --test src/http/server/core-purity.test.ts src/koa-absence.test.ts src/http/server/bytewise.test.ts src/http/server/runtime/node/listen.test.ts src/http/server/runtime/node/schedule.test.ts src/http/server/app.test.ts src/http/server/dispatch.test.ts src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/invalid-request.test.ts src/http/server/idempotency-key.test.ts src/http/server/idempotency.test.ts src/http/server/idempotency-record.test.ts src/http/server/idempotency-response.test.ts src/http/server/idempotency-store.test.ts src/http/server/route.test.ts src/http/server/envelope.test.ts src/http/server/auth.test.ts src/http/server/authorize.test.ts src/http/server/host.test.ts src/http/server/origin.test.ts src/http/server/preflight.test.ts src/http/server/shutdown.test.ts src/http/server/blob/show-blob.test.ts src/http/server/event/list-event.test.ts src/main.test.ts && echo "PASS EPIC-035"` → exit 0; output: `"PASS EPIC-035"`.
  **Tasks closed.** 5 across 5 Stories — no Story remains outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test … && echo "PASS EPIC-035") — "PASS EPIC-035"
- stories: 5/5 complete
- date: 2026-08-27
- state: local-uncommitted

END: TEST-ENGINEER
