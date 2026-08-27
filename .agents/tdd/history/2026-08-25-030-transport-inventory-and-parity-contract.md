---
epic: .agents/plan/epics/030-transport-inventory-and-parity-contract.md
opened: 2026-08-25
opener: test-engineer
base-ref: e189b7bd374fe6a1e8406f0064846f3035c2b449
---

# Implementation cycle — 030-transport-inventory-and-parity-contract

Pulled from EPIC: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/server/app.test.ts \
>   src/http/server/app.handler-result.test.ts \
>   src/http/server/app.parity-body.test.ts \
>   src/http/server/app.parity-cors.test.ts \
>   src/http/server/app.parity-path.test.ts \
>   src/http/server/dispatch.test.ts \
>   src/http/server/envelope.test.ts \
>   src/http/server/origin.test.ts \
>   src/http/server/host.test.ts \
>   src/http/server/preflight.test.ts \
>   src/http/server/auth.test.ts \
>   src/http/server/authorize.test.ts \
>   src/http/server/route.test.ts \
>   src/http/server/query.test.ts \
>   src/http/server/blob/show-blob.test.ts \
>   src/http/server/blob/range.test.ts \
>   src/http/server/credential/register-provider.test.ts \
>   src/http/server/idempotency.test.ts \
>   src/http/server/idempotency-key.test.ts \
>   src/http/server/idempotency-response.test.ts \
>   test/helpers/app.test.ts \
>   test/helpers/agent.test.ts \
>   && echo "PASS EPIC-030"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **Every added test passes on the current Koa stack.** No production file under `src/` changes in
>   stories 2 to 5. `git diff --name-only` for each of those four commits names one `.test.ts` file.
> - **The inventory table matches the tree by exact deep equality.** A test run after a handler file
>   is added fails, and the failure names the new file. Prove it with a temporary file the test
>   removes, or with a scan of a fixture directory. Never with a network call.
> - **P19 asserts the header-name list as a value.** The recorded names are compared against the
>   literal array by deep equality, never against a sortedness predicate and never against a count.
> - **The inventory asserts a value, never a count alone.** The status union is compared against the
>   literal `[200, 206]`, and the header-setting file is compared against the literal
>   `src/http/server/blob/show-blob.ts`.
> - **Each parity test drives the full chain through `createTestApp`.** No parity test calls a
>   middleware factory directly.
> - **The blob byte assertions are exact.** `content-length` and `content-range` are compared as
>   strings against values computed from the fixture length, not against a regular expression.
> - **No test depends on a wall clock, a shared temporary directory, or an ambient git
>   configuration.** `createTestApp` already injects `now` and `schedule`; every added test keeps the
>   injected values. A test that needs a remote uses the loopback fixture of EPIC 005.
> - **The proposal section names no framework.** A grep of `docs/proposal/phase-1/transport.md` for
>   `koa`, `hono` and `express` returns nothing, case-insensitive.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the proposal states the parity contract · Story 1 · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task `01-the-proposal-states-the-parity-contract` — first Task of the first Story of EPIC `030-transport-inventory-and-parity-contract`; this discussion file had no prior turns.

**Story file.** `.agents/plan/stories/030-transport-inventory-and-parity-contract/01-the-proposal-states-the-parity-contract.md`

**Tasks forwarded to Software Engineer.**

- `01-the-proposal-states-the-parity-contract`: `docs/proposal/phase-1/transport.md` — documentation-only edit: insert one new section, `## The request and response contract`, between line 87 (blank) and line 88 (`## A held request`), copying the block quoted in the Story's Change section byte-for-byte without its surrounding code fences, then `npx prettier --write docs/proposal/phase-1/transport.md`.

**No RED phase.** The Story changes no file under `src/`, `test/` or `scripts/`; `scripts/lane-check.sh` grants `docs/proposal/*` to the software-engineer lane and the Story states the test-engineer writes nothing for it. Its Verify section runs the existing `src/http/contract/parity.test.ts` and `src/cli/inventory.test.ts` unchanged, plus `git diff` scope checks and five `grep -c` inspections of the one docs file. Coverage owned elsewhere per the Story gate — no test is written for documentation.

**Open to Software Engineer.**

- Implement GREEN per the Story file's Change section, byte-for-byte as quoted. Pre-checked against the working tree at base `e189b7b`: every cited anchor is exact — the file is 98 lines, `## Browser access` opens at 74 and ends at 86, line 87 is blank, `## A held request` opens at 88, the exit-code table spans 16–24, and the working tree carries no uncommitted change outside the new discussion file. Locate the insertion point by the blank line after "…serves no certificate handling in that topology." if prettier or an earlier commit shifts any number.
- Honour the Constraints section: name no library (`koa`, `hono`, `express` absent in any case), cite `../api/README.md` and no other source file, change no existing line, add no exit-code row, name no future transport, migration or epic number, and do not state that an absent body produces `undefined`.
- After your edit, run the Story Verify inspections: `node --test src/http/contract/parity.test.ts src/cli/inventory.test.ts` passes unchanged; `git diff --name-only` names exactly the one file; the four `grep -c` probes each report a non-zero count; `grep -ci "koa\|hono\|express" docs/proposal/phase-1/transport.md` reports `0`. Then run `npm run typecheck`. My next turn runs the build-proof gate (`npm run verify`) via `npm run verify:handoff` and opens Story 2.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-the-proposal-states-the-parity-contract · Story 1 · proposal states the parity contract

**Cycle.** GREEN-ONLY implementation for Tasks: `01-the-proposal-states-the-parity-contract`.

**Files changed.**

- `docs/proposal/phase-1/transport.md` (edited) — one new section `## The request and response contract`, inserted between line 87 (blank) and line 88 (`## A held request`); file grows 98 → 143 lines

**Seam (GREEN).** Documentation-only Task — the block quoted in the Story's Change section inserted byte-for-byte without its surrounding code fences, then `npx prettier --write docs/proposal/phase-1/transport.md` reported the file already unchanged.

**Refactor.** none named by the Story.

**Build check.**

- typecheck: exit 0

**Story Verify inspections run.**

- `git diff --name-only` names exactly one file: `docs/proposal/phase-1/transport.md`.
- The diff is a pure insertion: 45 added lines, 0 deleted lines, one hunk whose context starts at the blank line after `…serves no certificate handling in that topology.` — no existing line touched.
- Section order confirmed: `## Browser access` at 74, `## The request and response contract` at 88, `## A held request` at 133.
- `grep -ci "koa\|hono\|express" docs/proposal/phase-1/transport.md` reports `0`.
- Each of the four parity-group probes reports `1`: `An absent request body is an empty object`, `The browser headers survive every refusal`, `A path segment is never decoded`, `An answer carries one of two success statuses`.
- Constraints hold: the only source cited in the new section is `../api/README.md`; no exit-code row, no future transport, migration or epic number, no statement that an absent body produces `undefined`.

**Assumptions.**

- VERIFIED: prettier stability (`npx prettier --write` printed `unchanged`) and insertion purity (45 insertions / 0 deletions in `git diff --stat`).
- The Story Verify also names `node --test src/http/contract/parity.test.ts src/cli/inventory.test.ts`; test execution stays the test-engineer's sole gate, so that run is left to your verify pass this cycle. Neither file is touched by this change.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the handler result inventory · Story 2 · Task `02-the-handler-result-inventory`

**Cycle.** Handoff gate first: the software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Prior GREEN confirmed for Story 1 under the GREEN-only flow — build-only check ran its Verify suites: `node --test src/http/contract/parity.test.ts src/cli/inventory.test.ts` → **20 pass / 0 fail**, exit 0. Advancing to Story 2 (`02-the-handler-result-inventory`): its only deliverable is `src/http/server/app.handler-result.test.ts`, a test-lane path the software-engineer cannot touch, and the EPIC forbids any production change in stories 2–5. No RED phase exists for this task and none is wanted — written directly in my lane this turn.

**Test written.**

- file: `src/http/server/app.handler-result.test.ts` (new) — suite: `src/http/server/app.handler-result.test` — methods: `the handler tree equals the frozen table`, `the whole tree answers 200 and 206 and nothing else`, `exactly one handler declares response headers, and it is the blob handler`, `every handler returns a body value`, `a new handler file fails the scan and the failure names it`, `a JSON result serializes as application/json`, `a Buffer result serializes as bytes with an exact content-length`, `a Range request answers 206 with an exact content-range`, `the preflight is the one empty-body answer`
- asserts: P21–P25 as the Story pins them — the scanned handler tree deep-equals the frozen 44-row table bytewise sorted; the status union deep-equals the literal `[200, 206]`; the header-setting set deep-equals the literal `[\"src/http/server/blob/show-blob.ts\"]`; the no-body set deep-equals `[]`; a fixture scan picks up an added file by name; the chain drives pin `content-type` `application/json; charset=utf-8`, blob `content-type` `application/octet-stream` with `content-length` `"10"`, the `206` with `content-range` `"bytes 0-4/10"` and `content-length` `"5"` plus the exact five bytes, and the `204` preflight with text `""`, no `content-length`, and `vary: Origin`.

**Proof.**

- command: `node --test src/http/server/app.handler-result.test.ts`
- exit 0 — **9 pass / 0 fail**, first run.
- **Intended first-run pass — characterization test.** The EPIC's non-goal says \"No behaviour change … Every added test passes on Koa first\", and the Story Verify demands \"All tests pass on the current stack, first run, with no production change\". A RED phase is impossible by construction here.

**Sensitivity proof** (in place of RED):

- The suite's own negative control builds a temp-dir fixture tree (`mkdtempSync` under `tmpdir()`, removed in `finally`) and proves the scan reports an added file by name: `[\"alpha/one.ts\", [200], false, true]` grows to include `alpha/two.ts`.
- Real-tree probe: a temporary untracked `src/http/server/actor/probe-handler.ts` (a `: Handler` file with `status: 200, body: {}`) was created outside the test; `the handler tree equals the frozen table` failed immediately and its diff named the probe — verbatim: `+     'src/http/server/actor/probe-handler.ts',`. The probe was deleted; the suite returned to 9/9. Scan facts were independently pre-verified against the tree before writing: `/:\s*Handler\b/` selects exactly the 44 table files, statuses yield `[200]` ×43 and `[200, 206]` for `blob/show-blob.ts`, the headers rule matches `blob/show-blob.ts` alone, and all 44 match the body rule.

**Story Verify cross-checks.**

- `node --test src/http/server/app.test.ts src/http/server/dispatch.test.ts src/http/server/blob/show-blob.test.ts src/http/server/preflight.test.ts` → **71 pass / 0 fail**, unchanged.
- `npm run typecheck` → exit 0. `npx eslint src/http/server/app.handler-result.test.ts` → clean.
- `git diff --name-only` names exactly `docs/proposal/phase-1/transport.md` (Story 1, uncommitted); `git status --porcelain` adds only this new `.test.ts` and the channel/memory files — no production path, no leftover probe.

**No handoff.** Nothing opens to the software-engineer: the Story changes no production file and names no seam. Next cycle step: confirm this suite stays green, then open Story 3 (`03-body-parsing-parity`) — same lane, same characterization discipline.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 030 · no SE-lane work this cycle (Story 2 closed in the TE lane)

**Cycle.** No implementation. The last TEST-ENGINEER turn closed Story 2 (`02-the-handler-result-inventory`) inside the test-engineer lane — `src/http/server/app.handler-result.test.ts` written, executed and green first run (9 pass / 0 fail) as a characterization suite — and states "No handoff": it names no failing test and no seam for me to satisfy.

**Why nothing is implemented.**

- The EPIC non-goals bind stories 2–5: "No production file under `src/` changes in stories 2 to 5", so there is no GREEN change available to me even if one were wanted.
- Stories 3–5 deliver only test-lane paths (`app.parity-body.test.ts`, `app.parity-cors.test.ts`, `app.parity-path.test.ts`); those files are the test-engineer's lane, whether or not a turn forwards them.
- This is an empty assignment, not a failed attempt at an assigned Task — no `ATTEMPT-FAILED` line applies and no `OPEN:` blocker exists: nothing is missing, contradictory or unimplementable.

**Files changed.** none.

**Build check.**

- typecheck: exit 0 (verified against the tree including the new `app.handler-result.test.ts`; working tree holds only the Story-1 docs edit and the TE's new test file)

**Next cycle step** (test-engineer's): confirm the Story-2 suite stays green, then open Story 3 (`03-body-parsing-parity`) in your lane per your own stated plan.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — body-parsing parity · Story 3 · Task `03-body-parsing-parity`

**Cycle.** Handoff gate first: the software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Prior GREEN confirmed for Story 2 — `node --test src/http/server/app.handler-result.test.ts` → **9 pass / 0 fail**, unchanged. Advancing to Story 3 (`03-body-parsing-parity`): its only deliverable is `src/http/server/app.parity-body.test.ts`, a test-lane path the software-engineer cannot touch, and the EPIC forbids any production change in stories 2–5. No RED phase exists for this task and none is wanted — written directly in my lane this turn, as with Story 2.

**Test written.**

- file: `src/http/server/app.parity-body.test.ts` (new) — suite: `src/http/server/app.parity-body.test` — methods: `a POST with no body reaches the handler with an empty object body`, `a POST with text/plain reaches the handler with an empty object body`, `a POST with a zero-length JSON body reaches the handler with an empty object body`, `a routed operation with no bound handler answers 501 with a malformed body and records no call`, `a routed operation with no bound handler answers 501 with a valid body and records no call`
- asserts: P3–P6 as the Story pins them — one in-place closure recorder bound to `repository.register` (`POST /v1/repository`); the three empty-body cases each answer `200`, record exactly one call, and record `body` by deep equality with `{}` (the text/plain case additionally pins `JSON.stringify(body)` as `"{}"` so the payload `hello` survives under no name, and no message text is asserted anywhere); unbound `project.create` (`POST /v1/project`) answers `501` with the exact envelope `{error: {code: "not-implemented", message: "project.create is not implemented yet"}}` by deep equality for both a malformed payload `'{"oops'` and a valid one `'{"name":"a"}'`, recording no call either way. Every test drives the whole chain through `createTestApp`; exactly one handler is bound, keeping every other routed operation in `unimplemented`.

**Proof.**

- command: `node --test src/http/server/app.parity-body.test.ts`
- exit 0 — **5 pass / 0 fail**, first run.
- **Intended first-run pass — characterization test.** The EPIC's non-goal says "No behaviour change … Every added test passes on Koa first", and the Story Verify demands "All five tests pass on the current stack, first run, with no production change". A RED phase is impossible by construction here.

**Sensitivity proof** (in place of RED):

- The suite carries its own negative control: the P6-malformed test sends the same `'{"oops'` payload that the pre-existing P1 pin (`register-provider.test.ts:104-129`, re-run below) turns into `400 invalid-request` for a **bound** handler. The only difference is the condition inside `bodyParserForHandled`. If that condition vanished, the P6 tests' full-envelope deep-equality would flip to the error envelope of that `400` and fail — the assertion is falsifiable against exactly the behaviour it pins.
- The three body assertions are exact-value comparisons — `assert.deepEqual(calls[0]?.body, {})` and `JSON.stringify(calls[0]?.body) === "{}"` — so a transport producing `undefined`, or carrying the payload under any name, fails them. No count or typeof shortcut anywhere.

**Story Verify cross-checks.**

- `node --test src/http/server/dispatch.test.ts src/http/server/credential/register-provider.test.ts src/http/server/app.test.ts` → **55 pass / 0 fail**, unchanged.
- `npm run typecheck` → exit 0. `npx eslint src/http/server/app.parity-body.test.ts` → clean.
- `git status --porcelain` holds only: Story 1's `docs/proposal/phase-1/transport.md` edit, Story 2's `app.handler-result.test.ts`, this new `.test.ts`, and the channel/memory files — no production path changed by this story.

**No handoff.** Nothing opens to the software-engineer: the Story changes no production file and names no seam. Next cycle step: confirm this suite stays green, then open Story 4 (`04-cors-parity`) — same lane, same characterization discipline.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 030 · no SE-lane work this cycle (Story 3 closed in the TE lane)

**Cycle.** No implementation. The last TEST-ENGINEER turn closed Story 3 (`03-body-parsing-parity`) inside the test-engineer lane — `src/http/server/app.parity-body.test.ts` written, executed and green first run (5 pass / 0 fail) as a characterization suite — and states "No handoff": it names no failing test and no seam for me to satisfy.

**Why nothing is implemented.**

- The EPIC non-goals bind stories 2–5: "No production file under `src/` changes in stories 2 to 5", so no GREEN change exists for me even if one were wanted.
- Stories 4–5 deliver only test-lane paths (`app.parity-cors.test.ts`, `app.parity-path.test.ts`); those files stay the test-engineer's lane, whether or not a turn forwards them.
- This is an empty assignment, not a failed attempt at an assigned Task — no `ATTEMPT-FAILED` line applies and no `OPEN:` blocker exists: nothing is missing, contradictory or unimplementable.

**Files changed.** none.

**Build check.**

- typecheck: exit 0 (verified against the tree including the Story 2 and Story 3 test files; working tree holds the Story 1 docs edit, both new `.test.ts` files, and the channel/memory files — no production path changed)

**Next cycle step** (test-engineer's): confirm the Story-3 suite stays green, then open Story 4 (`04-cors-parity`) in your lane per your stated plan; Story 5 (`05-path-and-header-parity`) follows the same way.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — CORS parity · Story 4 · Task `04-cors-parity`

**Cycle.** Handoff gate first: the software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Prior GREEN confirmed for Stories 2 and 3 — `node --test src/http/server/app.handler-result.test.ts src/http/server/app.parity-body.test.ts` → **14 pass / 0 fail**, unchanged. Advancing to Story 4 (`04-cors-parity`): its only deliverable is `src/http/server/app.parity-cors.test.ts`, a test-lane path the software-engineer cannot touch, and the EPIC forbids any production change in stories 2–5. As with Stories 2–3, written directly in my lane this turn.

**Test written.**

- file: `src/http/server/app.parity-cors.test.ts` (new) — suite: `src/http/server/app.parity-cors.test` — methods: `CORS headers survive an authentication failure`, `CORS headers survive a routing failure`, `CORS headers survive an internal error`, `CORS headers survive a handler refusal`, `Vary is Origin on a completed answer`, `Vary is Origin on a request that carries no Origin`, `the origin-forbidden refusal carries neither allow-origin nor Vary`
- asserts: P8, P9, P10 and the non-OPTIONS half of P11 as the Story pins them — one `corsApp()` bound to `system.health` (throws plain `Error("boom")`), `system.status` (throws `httpError("lease-held", "held", { holder: "actor_01" })`) and `system.db` (answers `200`), `allowedOrigins: [ORIGIN]`. The four survival tests assert status, error code and all three headers by exact value (`allow-origin` `ORIGIN`, `expose-headers` `EXPOSED`, `vary` `"Origin"`) on a `401 unauthenticated` through `app.raw` with no token, a `404 not-found` for `/v1/nope/nope`, a `500 internal-error` with `internalErrors()` length `1` and `response.text.includes("boom") === false`, and a `409 lease-held` with `details.holder` `"actor_01"` and `internalErrors()` length `0`. The three `Vary` tests pin `vary: Origin` plus both CORS headers on a `200`, `vary: Origin` with both CORS headers `undefined` when no `Origin` is sent, and the `403 origin-forbidden` refusal carrying all three headers `undefined`. Every test builds a fresh app through `createTestApp`; every `Vary` assertion is an exact-value equality, never `includes`.

**Proof.**

- command: `node --test src/http/server/app.parity-cors.test.ts`
- exit 0 — **7 pass / 0 fail**, first run.
- **Intended first-run pass — characterization test.** The EPIC non-goal says "No behaviour change … Every added test passes on Koa first", and the Story Verify demands "All seven tests pass on the current stack, first run, with no production change". A RED phase is impossible by construction here.

**Sensitivity proof** (in place of RED):

- Every header assertion is an exact-value equality against a literal (`ORIGIN`, `EXPOSED = "etag, accept-ranges, content-range"`, `"Origin"`), and every absence is `assert.equal(..., undefined)` — so each passing assertion positively proves the chain wrote exactly that value, and removing the corresponding write site flips it to a failure. Deleting the `context.vary("Origin")` write inside the `finally` at `src/http/server/origin.ts:34-36` fails tests 1–6 on their `vary` equality; moving the `origin-forbidden` throw at `src/http/server/origin.ts:21` after any header write flips test 7's three `undefined` assertions. Test 6 separates the two mechanisms: `vary` is `"Origin"` while `allow-origin`/`expose-headers` are `undefined`, which only the outside-the-guard `finally` produces.
- Probe disclosure: I attempted a live sensitivity probe (temporary single-line removal of the `vary` write in `src/http/server/origin.ts`, restore in the same shell step). The environment permission layer denied the mutation command; nothing ran, and `git status` confirms `origin.ts` untouched. Sensitivity rests on the exact-value argument above plus independent corroboration: `app.test.ts:196-207` already pins the `origin-forbidden` refusal carrying no allow-origin (OPTIONS variant), and my test 7 extends that pin to GET with `expose-headers` and `vary` absence added.

**Story Verify cross-checks.**

- `node --test src/http/server/origin.test.ts src/http/server/app.test.ts src/http/server/envelope.test.ts src/http/server/preflight.test.ts` → **60 pass / 0 fail**, unchanged — P7 stays pinned at `app.test.ts:151`/`:248`, P12–P15 at `:184`/`:209`/`:220`/`:264`.
- `npm run typecheck` → exit 0. `npx eslint src/http/server/app.parity-cors.test.ts` → clean.
- `git status --porcelain` holds only: Story 1's `docs/proposal/phase-1/transport.md` edit, Stories 2–3's two `.test.ts` files, this new `.test.ts`, and the channel/memory files — no production path changed by this story. No OPTIONS request appears anywhere in the file, and the injected `now`/`schedule` defaults are untouched.

**No handoff.** Nothing opens to the software-engineer: the Story changes no production file and names no seam. Next cycle step: confirm this suite stays green, then open Story 5 (`05-path-and-header-parity`) — the last story, after which the full Verification Gate and Proof run.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 030 · no SE-lane work this cycle (Story 4 closed in the TE lane)

**Cycle.** No implementation. The last TEST-ENGINEER turn closed Story 4 (`04-cors-parity`) inside the test-engineer lane — `src/http/server/app.parity-cors.test.ts` written, executed and green first run (7 pass / 0 fail) as a characterization suite — and states "No handoff": it names no failing test and no seam for me to satisfy.

**Why nothing is implemented.**

- The EPIC non-goals bind stories 2–5: "No production file under `src/` changes in stories 2 to 5", so no GREEN change exists for me even if one were wanted.
- Story 5 (`05-path-and-header-parity`) — the last story — delivers only a test-lane path (`src/http/server/app.parity-path.test.ts`, pinning P16–P19); that file stays the test-engineer's lane, whether or not a turn forwards it.
- This is an empty assignment, not a failed attempt at an assigned Task — no `ATTEMPT-FAILED` line applies and no `OPEN:` blocker exists: nothing is missing, contradictory or unimplementable.

**Files changed.** none.

**Build check.**

- typecheck: exit 0 (verified against the tree including the Story 2–4 test files; working tree holds the Story 1 docs edit, the three new `.test.ts` files, and the channel/memory files — no production path changed)

**Next cycle step** (test-engineer's): open Story 5 (`05-path-and-header-parity`) in your lane per your stated plan — five `it` blocks pinning P16–P19 through `createTestApp` with the bare `blob.show` recorder — then run the full Verification Gate (`npm run verify`) and the complete 22-file Proof block expecting `PASS EPIC-030`, and append IMPLEMENTATION_READY_FOR_REVIEW when both are green.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — path and header parity · Story 5 · Task `05-path-and-header-parity`

**Cycle.** Handoff gate first: the software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Prior GREEN confirmed for Stories 2–4 — `node --test src/http/server/app.handler-result.test.ts src/http/server/app.parity-body.test.ts src/http/server/app.parity-cors.test.ts` → **21 pass / 0 fail**, unchanged. Advancing to Story 5 (`05-path-and-header-parity`): its only deliverable is `src/http/server/app.parity-path.test.ts`, a test-lane path, and the EPIC forbids any production change in stories 2–5. As with Stories 2–4, written directly in my lane this turn.

**Test written.**

- file: `src/http/server/app.parity-path.test.ts` (new) — suite: `src/http/server/app.parity-path.test` — methods: `a percent-escaped path segment reaches the handler undecoded`, `a malformed percent escape reaches route matching intact`, `a duplicate request header reaches the handler joined with a comma and a space`, `a request carrying a client header records five sorted lower-cased header names`, `a plain GET records four sorted lower-cased header names`
- asserts: P16–P19 as the Story pins them — one bare recorder bound to `blob.show` (`GET /v1/blob/:hash`); `/v1/blob/aa%2Fbb` answers `200` and records the whole parameter object by deep equality as `{ hash: "aa%2Fbb" }`; `/v1/blob/aa%zz` answers `200` (not `400`) and records `{ hash: "aa%zz" }`; `X-Kanthord-Client` sent as one array `.set` records the exact joined string `"one, two"`; the name lists are asserted as values by deep equality against the literals `["accept-encoding", "authorization", "connection", "host", "x-kanthord-client"]` and `["accept-encoding", "authorization", "connection", "host"]` — never a predicate, never a count. Five fresh apps across five tests, so no request or `calls` array crosses an `it` boundary; every request rides `app.get`, never `app.raw.get`.

**Proof.**

- command: `node --test src/http/server/app.parity-path.test.ts`
- exit 0 — **5 pass / 0 fail**, first run.
- **Intended first-run pass — characterization test.** The EPIC non-goal says "No behaviour change … Every added test passes on Koa first", and the Story Verify demands "All five tests pass on the current stack, first run, with no production change". A RED phase is impossible by construction here.

**Sensitivity proof** (in place of RED):

- Every assertion is an exact-value comparison against a literal. If a layer percent-decoded a segment, `{ hash: "aa%2Fbb" }` flips to `{ hash: "aa/bb" }`; if route matching refused a malformed escape, the `assert.equal(response.status, 200)` flips to `400`; if `readHeaders` dropped its `", "` join, `"one, two"` fails; if it dropped its bytewise sort or Node stopped lower-casing, either literal deep-equal fails on order or case. The Story's own bound notes hold: no extra header is set beyond `X-Kanthord-Client` (only tests 3–4), every request is a GET so no `content-length` enters a list, and both observed lists matched the Story's pre-verified literals exactly — the "stop if a run disagrees" clause never fired.
- Binding the bare recorder rather than `showBlobHandler` isolates transport behaviour: the real handler's `blobHash` check (`/^sha256:[0-9a-f]{64}$/`) would answer `400` for both path values and mask what this story pins.

**Story Verify cross-checks.**

- `node --test src/http/server/dispatch.test.ts src/http/server/route.test.ts src/http/server/query.test.ts src/http/server/blob/show-blob.test.ts` → **55 pass / 0 fail**, unchanged.
- `npx eslint src/http/server/app.parity-path.test.ts` → clean. `git status --porcelain` holds only: Story 1's `docs/proposal/phase-1/transport.md` edit, the four new `.test.ts` files (Stories 2–5), and the channel/memory files — no production path changed by any of stories 2–5.

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** All five stories implemented, every Task green, nothing outstanding. Both gate parts executed this turn:

- `typecheck` (`npm run typecheck`) → exit 0
- `unit` (`npm test`) → exit 0 — 5201 pass / 0 fail
- Gates command (`npm run verify`: typecheck, full node:test suite, `eslint .`, verify-db-status) → exit 0

**Proof.** The EPIC's 22-file Proof block run verbatim → exit 0, printing the success string verbatim:

```
PASS EPIC-030
```

(298 pass / 0 fail across the block; the four added suites contribute 26 passing tests.) Hermetic-coverage bullets re-checked this turn: framework grep `grep -ci "koa\|hono\|express" docs/proposal/phase-1/transport.md` → `0`; `git status --porcelain` names no production path under `src/` beyond the four new `.test.ts` files; P19/P21 assertions are literal-value deep-equals; all parity suites drive `createTestApp`; blob byte assertions are exact strings; no wall clock, shared temp dir or network in any added test.

**Tasks closed.** 5 across 5 stories — `01-the-proposal-states-the-parity-contract` (Story 1, SE lane), `02-the-handler-result-inventory` (Story 2), `03-body-parsing-parity` (Story 3), `04-cors-parity` (Story 4), `05-path-and-header-parity` (Story 5) — matching the story index dispatch order, none outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test <22 EPIC files> && echo) — "PASS EPIC-030"
- stories: 5/5 complete
- date: 2026-08-25
- state: local-uncommitted (base e189b7b)

END: TEST-ENGINEER

## HUMAN_REVIEW — operator verdict

B1 resolved by product decision (Ulrich): an empty body is an absent body value. The zero-length byte answer of a blob carries an explicit value of zero bytes and a length header of `0`, so it is not an empty body. The proposal paragraph now states that definition, and the existing coverage pins it: the inventory's no-body set, the preflight assertions, and `show-blob.test.ts` for the zero-byte answer.

HUMAN_REVIEW: PASS
