---
epic: .agents/plan/epics/028-event-long-poll.md
opened: 2026-08-22
opener: test-engineer
base-ref: 4bf2a3b48b1aed9e2f300b2c16465082dbfebd27
---

# Implementation cycle — 028-event-long-poll

Pulled from EPIC: `.agents/plan/epics/028-event-long-poll.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/http/contract/event.test.ts \
>   src/http/contract/example.test.ts \
>   src/http/contract/capability.test.ts \
>   src/http/server/event/list-event.test.ts \
>   src/http/server/event/wait.test.ts \
>   src/http/server/shutdown.test.ts \
>   src/services/config/convict.test.ts \
>   src/main.event-wait.test.ts \
>   && echo "PASS EPIC-028"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - **No test waits on a wall clock.** Every wait assertion drives a fake `Schedule` and advances it
>   explicitly. A test that sleeps is a defect this gate rejects.
> - **The behaviour matrix, against a fake schedule.** `wait` absent answers immediately. `wait=0`
>   answers immediately. `wait=5` with events already present answers immediately and never schedules a
>   timer, asserted by the fake recording zero scheduled callbacks. `wait=5` with no events schedules,
>   and after the full elapse answers `200` with `{ events: [] }`. `wait=5` with an event appended
>   after two poll ticks answers `200` with that event and cancels its timer, asserted through the
>   cancel function the fake returns.
> - **The elapsed wait is not an error.** The status is `200`, the body parses against
>   `eventListResponse`, and the response carries no error envelope. Asserted by value, because this is
>   the property the client's reachability logic rests on.
> - **The cursor is honoured under a wait.** With `after` set to the last known id, a wait that returns
>   carries only events after that id, and a second call with the returned last id returns empty. No
>   event is delivered twice and none is skipped.
> - **The maximum is a refusal, not a clamp.** `wait=61` is `400 invalid-request` at the schema.
>   `wait=45` with `http.event.maxWait` at 30 is `400 invalid-request`, and the assertion checks the
>   code and not the message text.
> - **A repeated key is refused.** `?wait=1&wait=2` is `400 invalid-request` through
>   `singleValued`, matching the existing behaviour for the other query keys.
> - **Shutdown does not wait for a waiter.** A daemon-backed test opens a request with `wait=30`,
>   confirms it is pending, sends `SIGTERM`, and asserts two things: the pending request answers `200`
>   with an empty array, and the process exits without the wait elapsing. The elapsed time is asserted
>   as a bound — under one second — rather than as a value, because a bound is the only honest
>   assertion about a process exit.
> - **Shutdown order.** `cancelWaits` is called before `listener.close()`, asserted through a recording
>   fake that captures the call order, not through timing.
> - **`GET /v1/event` still writes nothing.** The full contents of `event` plus `PRAGMA data_version`
>   are compared before and after a waited call that elapses, and after one that returns an event.
> - **Concurrency.** Two waiting requests with different filters both return when one matching event
>   arrives for one of them: the matching request returns the event, the other elapses empty. This
>   proves the waiter filters per request and holds no shared cursor.
> - **The capability appears.** `declaredCapabilities()` includes `event-wait` after this epic and the
>   exact expected list is asserted, per EPIC 023's mechanism.
> - **The route-level acceptance test.** `src/main.event-wait.test.ts` drives the real composition root
>   through `launchDaemon`, with no injected handler map.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the contract declares the wait · Story 2 RED

**Cycle.** RED for Story 2 (`src/http/contract/event.test.ts`, `src/http/contract/openapi.test.ts`, `src/http/server/event/list-event.test.ts` — first Story in the dispatch order of `.agents/plan/stories/028-event-long-poll/index.md`).

**Test written.**

- file: `src/http/contract/event.test.ts` (edited) — suite: `src/http/contract/event.test` — methods: `accepts wait as a number and as a string`, `accepts wait zero as a number and as a string`, `accepts wait at the schema ceiling of 60`, `rejects wait above the schema ceiling as a number and as a string`, `rejects a negative wait`, `rejects a fractional wait`, `rejects a non-numeric wait string and an empty one`, `rejects a repeated-parameter wait array`, `an absent wait stays absent from the parse result`, `a sent wait joins limit and order in the parse result keys`, `the query example names wait` (replaces `rejects wait`)
- file: `src/http/contract/openapi.test.ts` (edited) — suite: existing — methods: `renders event.list query parameters in bytewise name order with no request body` (expected name list gains `"wait"` as its last entry)
- file: `src/http/server/event/list-event.test.ts` (edited) — suite: `src/http/server/event/list-event.test` — methods: `wait parses and the handler still answers at once`, `wait 61 answers 400 at the schema` (replaces `wait answers 400 because the schema is strict`)
- asserts: `eventListRequest` accepts `wait` as a coerced integer in `[0, 60]`, keeps it absent from the parse result when unsent, the query example names `wait: 5`, the OpenAPI document renders a `wait` query parameter, and `GET /v1/event?wait=5` answers `200` while `wait=61` still answers `400 invalid-request`.

**RED proof.**

- command: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts`
- exit: non-zero — 179 tests, 172 pass, 7 fail:
  - `✖ accepts wait as a number and as a string` — parse throws: `wait` is an unknown key under `strictObject`
  - `✖ accepts wait zero as a number and as a string` — same
  - `✖ accepts wait at the schema ceiling of 60` — same
  - `✖ a sent wait joins limit and order in the parse result keys` — same
  - `✖ the query example names wait` — `undefined !== 5`
  - `✖ renders event.list query parameters in bytewise name order with no request body` — expected `[..., 'type', 'wait']`, actual `[..., 'type']`
  - `✖ wait parses and the handler still answers at once` — `400 !== 200` at `src/http/server/event/list-event.test.ts:187`
- `wait 61 answers 400 at the schema` passes before the seam exists (the strict schema refuses the unknown key) and after (the declared schema refuses `61`) — a characterization the Story file directs, inverted from the old test in place; the sensitivity for this Story sits in the seven failures above.
- `npm run typecheck` reports 5 errors, all `TS2339: Property 'wait' does not exist` in `src/http/contract/event.test.ts` — the expected missing-member RED, resolved by the seam below. No TS2307 masking is possible (the module exists, so tsc checked every file body); no stub probe required.

**Open to Software Engineer.**

- `src/http/contract/event.ts` — `eventListRequest` gains one member as its last, exactly `wait: z.coerce.number().int().min(0).max(60).optional()` (no `.default()`), and `eventListExamples.query` gains `wait: 5` as its last entry. Nothing else in the file changes.
- `src/http/contract/field-decisions.fixture.ts` — regenerate with `node scripts/field-decisions-probe.mjs --write`; the diff must be exactly the one `event.list.query#/properties/wait required=false nullable=false enum=-` line between the `type` row and the `response` row.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02-the-contract-declares-the-wait · `eventListRequest` gains `wait`

**Cycle.** GREEN for `src/http/contract/event.test.ts` + `src/http/contract/openapi.test.ts` + `src/http/server/event/list-event.test.ts` (Story 2 RED, seven failing tests).

**Files changed.**

- `src/http/contract/event.ts` (edited) — `eventListRequest` gains one last member `wait: z.coerce.number().int().min(0).max(60).optional()`; `eventListExamples.query` gains one last entry `wait: 5` (number, not string).
- `src/http/contract/field-decisions.fixture.ts` (regenerated) — `node scripts/field-decisions-probe.mjs --write`; diff is exactly one added line `"event.list.query#/properties/wait required=false nullable=false enum=-"` between the `type` row and the first `response` row, per the Story.

**Seam (GREEN).** The strict schema now declares `wait` as a coerced optional integer in `[0, 60]`, so the parse tests accept `5`/`"5"`/`0`/`60` and refuse `61`/`"61"`/`-1`/`1.5`/`"abc"`/`""`/arrays, an absent `wait` stays out of the parse result (no `.default()`), the OpenAPI parameter list ends with `wait`, and the handler test at `?wait=5` parses through to `200`.

**Refactor.** None named by Story 2; nothing deferred.

**Build check.**

- typecheck: exit 0 (`tsc --noEmit`, resolves the five `TS2339: Property 'wait' does not exist` RED errors)

**Assumptions.**

- VERIFIED: fixture diff carries exactly the one expected line — output of `node scripts/field-decisions-probe.mjs --write`: `missing from fixture (1): event.list.query#/properties/wait required=false nullable=false enum=-`, then `git diff` inspected.
- VERIFIED: production diff touches only the two members the Story names in `event.ts` — `git diff src/http/contract/event.ts` shows two added lines, nothing removed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the contract declares the wait · Story 2 confirm-GREEN — OPEN

**Cycle.** Confirm GREEN for Story 2 (`02-the-contract-declares-the-wait`) — blocked; one test still red, root cause is a story self-contradiction.

**Handoff verification gate.**

- SE claim: typecheck clean. Independently re-verified: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Diff footprint audited against the SE's files-changed list: exactly `src/http/contract/event.ts` (+2 lines), `src/http/contract/field-decisions.fixture.ts` (+1 line), plus this epic's three test files. Matches the claim.

**GREEN proof (partial — 178 of 179 pass).**

- command: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts`
- exit: non-zero — 179 tests, 178 pass, 1 fail:
  - `✖ rejects a non-numeric wait string and an empty one`
  - `AssertionError [ERR_ASSERTION]: Missing expected exception.` at `src/http/contract/event.test.ts:51:12`
- Line 50 (`parse({ wait: "abc" })` throws) passes; only the `""` half at line 51 fails. Every other new `wait` behaviour of Story 2 is green.

**OPEN: Story 2 cannot be satisfied as written — its Change section and its Verify list contradict each other.**

- The Change section mandates exactly `wait: z.coerce.number().int().min(0).max(60).optional()` and says "Change nothing else in the file". That line is verbatim decision D1 of the EPIC.
- The Verify list demands `assert.throws(() => eventListRequest.parse({ wait: "" }))`.
- Probe (zod 4.4.3): `z.coerce.number().int().min(0).max(60).optional().safeParse("")` → `{"success":true,"data":0}` — `Number("") === 0`, and `.min(0)` admits it by design ("`.min(0)` admits `wait=0`"). No schema that carries the mandated line can make that parse throw. Two binding clauses, zero satisfying implementations.
- Precedent inside the same contract: `?limit=` also coerces to `0` but is refused today, because `limit` carries `.min(1)`. `wait` carries `.min(0)` deliberately, so the mandated schema answers `?wait=` with an immediate `200`. Whether an empty `wait=` answers or refuses is a contract decision, not a test detail — the test asserts whichever the plan names, and right now the plan names both.

Human decision needed; one turn then closes Story 2:

- **Option A (my recommendation)** — amend the Story's Verify bullet to pin `parse({ wait: "" }).wait === 0`: empty `wait=` behaves as `wait=0`, an immediate answer. Honours D1, which is quoted twice and locked as a Decision; no production change; I edit the test in my next turn and Story 2 goes green.
- **Option B** — keep the refusal: `?wait=` answers `400 invalid-request`. Requires amending D1 and the Story's Change section to a schema expression that refuses the empty string; the software-engineer implements whatever the amended plan names.

Stories 3–6 stay unopened until this resolves: every later story builds on Story 2's gate being green.

ATTEMPT-FAILED: 02-the-contract-declares-the-wait — still red after GREEN: parse({ wait: "" }) does not throw under the D1-mandated schema; Story Change section and Verify bullet are mutually unsatisfiable

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02-the-contract-declares-the-wait · blocked — plan contradiction stands

**Cycle.** No GREEN attempted. The active Task is the one the last TEST-ENGINEER turn escalated to the human, and no decision has landed; this turn verifies the blocker independently and re-raises it.

**State verified this turn.**

- The discussion file ends at `END: TEST-ENGINEER` (the OPEN turn); no human decision has been appended since.
- `.agents/plan/stories/028-event-long-poll/02-the-contract-declares-the-wait.md` still carries both clauses: line 84 demands `assert.throws(() => eventListRequest.parse({ wait: "" }))`, while lines 11-15 mandate verbatim `wait: z.coerce.number().int().min(0).max(60).optional()` with "Change nothing else in the file".
- Independent probe on zod 4.4.3 (the pinned dependency): `z.coerce.number().int().min(0).max(60).optional().safeParse("")` → `{"success":true,"data":0}` — `Number("") === 0` and `.min(0)` admits it. No schema carrying the mandated line can make that parse throw.
- `git status`/`git diff HEAD --stat`: working tree unchanged since my last GREEN turn (only that turn's five files modified); no epic or story file amended.

**Why I do not act.**

- Implementing the refusal (Option B) unilaterally would invent a schema expression the plan does not name and override EPIC decision D1 — a contract-semantics call that belongs to the human.
- Implementing the acceptance (Option A) from my side would require editing a test file, which is outside my lane by hard rule.

**OPEN: Story 2 is unimplementable as written; awaiting the human choice between the two options framed in the last TEST-ENGINEER turn** — A: amend the Story's Verify bullet to pin `parse({ wait: "" }).wait === 0` (empty `wait=` behaves as `wait=0`, honours D1, no production change); B: keep the refusal and amend D1 plus the Change section to name a schema expression that refuses the empty string.

**Build check.**

- typecheck: exit 0

ATTEMPT-FAILED: 02-the-contract-declares-the-wait — plan still self-contradictory after TE escalation: the mandated D1 schema parses "" as 0 (verified on zod 4.4.3), the Verify bullet demands a throw; human decision pending

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the contract declares the wait · Story 2 confirm-GREEN — OPEN (attempt 3)

**Cycle.** Confirm GREEN for Story 2 (`02-the-contract-declares-the-wait`) — blocked again; the plan contradiction stands and no human decision has landed.

**Handoff verification gate.**

- SE claim: typecheck clean, no GREEN attempted. Independently re-verified: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Diff footprint audited against the SE's files-changed list: exactly `src/http/contract/event.ts` (+2), `src/http/contract/field-decisions.fixture.ts` (+1), plus this epic's three test files. Matches.

**Fresh evidence this turn — not carried over from the prior turns.**

- Plan not amended: `git diff HEAD -- .agents/plan/` is empty, and every file under `.agents/plan/stories/028-event-long-poll/` carries its pre-cycle mtime of Aug 21 20:28. The story still mandates both clauses: line 12 verbatim `wait: z.coerce.number().int().min(0).max(60).optional()` with "Change nothing else in the file" (line 27), and line 84 `assert.throws(() => eventListRequest.parse({ wait: "" }))`.
- Probe re-run by me on the pinned zod 4.4.3, not cited from either prior turn: `z.coerce.number().int().min(0).max(60).optional().safeParse("")` → `{"success":true,"data":0}`. `Number("") === 0` and `.min(0)` admits it. A schema that carries the mandated line cannot throw on `""`; parse is a pure function of the schema, so no implementation satisfies both clauses.
- Live RED state: 179 tests, 178 pass, 1 fail — `✖ rejects a non-numeric wait string and an empty one` / `AssertionError [ERR_ASSERTION]: Missing expected exception.` Only the `""` half fails; `"abc"` throws and passes. Every other `wait` behaviour of Story 2 is green.

**OPEN: Story 2 remains unimplementable as written.** The human choice framed two turns ago is unchanged:

- **Option A (my recommendation)** — amend the Verify bullet to pin `eventListRequest.parse({ wait: "" }).wait === 0`: empty `wait=` behaves as `wait=0`, an immediate answer. Honours D1, which is locked as an EPIC Decision and quoted twice. No production change; I edit the test in my next turn and Story 2 goes green.
- **Option B** — keep the refusal (`400 invalid-request`). Requires amending D1 and the story's Change section to name a schema expression that refuses the empty string; the software-engineer implements whatever the amended plan names.

No third option exists inside the locked plan: normalizing `""` before parse or refining the mandated expression are production changes the Change section forbids ("Change nothing else in the file").

Stories 3–6 stay unopened until this resolves; each builds on Story 2's gate being green.

ATTEMPT-FAILED: 02-the-contract-declares-the-wait — plan still self-contradictory after two escalations: mandated D1 schema parses "" as 0 (re-probed on zod 4.4.3 this turn), Verify bullet line 84 demands a throw; human decision pending

END: TEST-ENGINEER

## ORCHESTRATOR — human-directed unblock via /debate · Story 02 resolution routed

**Context.** Three ATTEMPT-FAILED lines stand on 02-the-contract-declares-the-wait. The operator directed the debate engine (`/debate`, engine pi, read-only) to arbitrate Option A vs Option B and resume the loop. Debate ran to protocol: my position (Option A) took 7 catches, all merged. Merged verdict: **Option B — keep the refusal.** Decisive catches: the Verify taxonomy ("0"/"5" valid; "61"/"abc"/"" invalid) is explicit plan intent, and ""→0 acceptance appears nowhere in the plan; D1's compatibility clause protects absent-wait clients only, and the field is new, so no client depends on either empty-string behaviour; accepting "" masks a hot-polling client bug — the exact hazard this feature prevents; edit cost is process convenience, not contract reasoning.

**Probe evidence (zod 4.4.3, this run).** Replacement expression `z.preprocess((value) => typeof value === "string" && value.trim() === "" ? Number.NaN : value, z.coerce.number().int().min(0).max(60).optional())`: full Story taxonomy holds (5/"5"/0/"0"/60 accept with pinned values; ""/61/"61"/-1/1.5/"abc"/["1","2"] refuse; absent stays absent), and `z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" })` renders `properties.wait` as `{"type":"integer","minimum":0,"maximum":60}` — byte-identical to the current coerce line's render. `field-decisions.fixture.ts` stays valid unchanged.

HUMAN_REVIEW: FAIL — operator escalated the Story 02 contradiction to /debate; the merged verdict and probe below bind this cycle.

BLOCKER: amend-the-mandated-wait-expression — replace decision D1's schema member and Story 02 Change-section line 12 (both currently `wait: z.coerce.number().int().min(0).max(60).optional()`) with `wait: z.preprocess((value) => typeof value === "string" && value.trim() === "" ? Number.NaN : value, z.coerce.number().int().min(0).max(60).optional()),` — probed as above. Why: makes Verify line 84 satisfiable without touching any test file; keeps every other clause of D1 intact.

INFO: whitespace-guard-judgement - status:OPEN - action:NO - trim-vs-exact-empty - the guard refuses whitespace-only strings too; the Verify bullet names only "". fix:narrow to `value === ""` at review if unwanted; renders identically. why:minimal superset, deterministic either way.
INFO: residual-coercion-surface - status:OPEN - action:NO - numeric-string forms still coerce - "1e1" -> 10 and "0x10" -> 16 remain accepted under the amendment. fix:none this epic. why:consistent with the taxonomy; a strict-numeral grammar is a separate contract decision.
INFO: plan-files-stay-locked - status:FIXED - action:NO - EPIC/Story files untouched by this cycle - the BLOCKER above supersedes D1 and Change-section line 12 until the operator commits a matching plan amendment. fix:operator amends both clauses verbatim when committing. why:keeps planning tree authoritative outside the loop.

Stories 3-6 stay unopened until Story 2 closes green. Loop resumes at test-engineer per post-failure override.

## TEST-ENGINEER — the contract declares the wait · Story 2 Task 02 re-open under the /debate resolution

**Cycle.** RED re-open for Task `02-the-contract-declares-the-wait` (`node --test src/http/contract/event.test.ts …`) — the human-directed `/debate` verdict (Option B, keep the refusal) binds this cycle; the test already stands, the seam is now unblocked.

**Handoff verification gate.**

- No SE GREEN turn since the escalation; the last SE build claim (typecheck clean) re-verified independently this turn: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Working tree unchanged since that claim: `git status` shows only this epic's five files modified.

**Test written.**

- None new. `src/http/contract/event.test.ts` already carries every Verify bullet of Story 2, including `assert.throws(() => eventListRequest.parse({ wait: "" }))` at line 51. The routed resolution names a production-only change and no test edit; the lane boundary holds.

**RED proof (fresh this turn).**

- command: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts`
- exit: non-zero — 179 tests, 178 pass, 1 fail:
  - `✖ rejects a non-numeric wait string and an empty one` — `AssertionError [ERR_ASSERTION]: Missing expected exception.` at `src/http/contract/event.test.ts:51:12`
- Probe re-run by me on the installed zod, this run: the current member parses `{ wait: "" }` → `{ success: true, data: 0 }`; the amended expression below refuses `""` and `"  "` while accepting `5`/`"5"`/`0`/`"0"`/`60`, refusing `61`/`"61"`/`-1`/`1.5`/`"abc"`/`["1","2"]`, and leaving an absent key absent — the Story taxonomy holds in full.
- No TS2307 masking is possible: the module exists, so tsc checked every file body; no stub probe required.

**Open to Software Engineer.**

- `src/http/contract/event.ts` — replace exactly one line, the last member of `eventListRequest` (line 17), with the debate-resolved expression:
  `wait: z.preprocess((value) => typeof value === "string" && value.trim() === "" ? Number.NaN : value, z.coerce.number().int().min(0).max(60).optional()),`
  This supersedes decision D1's schema line and Story 02 Change-section line 12 per the orchestrator routing block of 2026-08-22. Nothing else in the file changes; `eventListExamples.query` keeps `wait: 5`.
- `src/http/contract/field-decisions.fixture.ts` — no change: the routing block probed `z.toJSONSchema(..., { target: "openapi-3.0", io: "input" })` rendering `properties.wait` as byte-identical output to the current coerce line, so the fixture stays valid.
- No test-file edit is needed for this fix.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02-the-contract-declares-the-wait · `wait` guard lands under the /debate resolution

**Cycle.** GREEN for Task `02-the-contract-declares-the-wait` (`src/http/contract/event.test.ts` + `src/http/contract/openapi.test.ts` + `src/http/server/event/list-event.test.ts`; the one failing assertion: `parse({ wait: "" })` must throw).

**Recovered prior state.** A prior SOFTWARE-ENGINEER dispatch applied this production edit but errored before appending its turn. Verified per dispatch note 2 with `git diff src/http/contract/event.ts`: the tree carried a semantically identical `z.preprocess(...)` member, but not the routed expression exactly — it wrapped the arrow body in extra parentheses, held a 96-character line against the repo's printWidth 80, and left `npx prettier --check src/http/contract/event.ts` warning while HEAD is prettier-clean. Applied the smallest correct change: wrote the verbatim routed one-liner and let the repo formatter (prettier 3.9.5) render it; the result is byte-identical to prettier's canonical output of the routing block's string.

**Files changed.**

- `src/http/contract/event.ts` (edited) — the last member of `eventListRequest` is now exactly `wait: z.preprocess((value) => typeof value === "string" && value.trim() === "" ? Number.NaN : value, z.coerce.number().int().min(0).max(60).optional()),` in its canonical five-line rendering. This supersedes decision D1's schema line and Story 02 Change-section line 12 per the orchestrator routing block of 2026-08-22. `eventListExamples.query` keeps `wait: 5`. No other line of the file changes.

**Seam (GREEN).** The preprocess guard maps an empty or whitespace-only string to `NaN` before coercion, so `Number("") === 0` can no longer slip past `.min(0)`; `parse({ wait: "" })` now throws at `src/http/contract/event.test.ts:51` and every other value of the Story taxonomy keeps its pinned parse result.

**Refactor.** None named by the Task; formatting normalized to the repo's canonical rendering of the mandated expression (no semantic delta, file restored to prettier-clean).

**Build check.**

- typecheck: exit 0
- `npx prettier --check src/http/contract/event.ts`: clean
- `node scripts/field-decisions-probe.mjs` (read-only): `fixture in sync: 662 rows`, exit 0 — fixture untouched, as the TEST-ENGINEER turn directed

**Assumptions.**

- VERIFIED: taxonomy re-probed this turn on the installed zod against the live module — `""`/`"  "` refuse; `5`/`"5"` accept as 5, `0`/`"0"` accept as 0, `60` accepts as 60; `61`/`"61"`/`-1`/`1.5`/`"abc"`/`["1","2"]` refuse; an absent key stays absent (parse-result keys are exactly `["order","limit"]`).
- VERIFIED: `z.toJSONSchema(eventListRequest, { target: "openapi-3.0", io: "input" }).properties.wait` renders `{"type":"integer","minimum":0,"maximum":60}` — byte-identical to the routing block's probe of both the old coerce line and the amendment, so `field-decisions.fixture.ts` needs no change.
- VERIFIED: working-tree footprint vs HEAD is exactly the five files this cycle owns (`event.ts` +6, fixture +1, three TE test files); no test file touched by this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the configuration bounds the wait · Story 3 RED

**Cycle.** RED for Story 3 (`03-the-configuration-bounds-the-wait`, verify path `src/services/config/convict.test.ts`), opened after Story 2 confirmed GREEN.

**Handoff verification gate.**

- SE claim (last turn): typecheck clean, fixture in sync. Independently re-verified: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

**Story 2 confirm-GREEN.**

- command: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts`
- exit 0 — 179 tests, 179 pass, 0 fail. The `""` refusal lands under the routed `z.preprocess` guard; Story 2 is closed.

**Test written.**

- file: `src/services/config/convict.test.ts` (edited) — suite: `src/services/config/convict.test` — new `describe("http.event")` after `http.idempotency`, mirroring its helpers and templates; methods: `a config file that omits http.event yields the default maxWait of 30`, `a config file naming event: { maxWait: 10 } yields 10`, `event: { maxWait: -1 } throws config-invalid`, `event: { maxWait: 1.5 } throws config-invalid`, `an unknown key http.event.sweepInterval throws config-invalid, proving strict mode`, `KANTHORD_HTTP_EVENT_MAX_WAIT=45 yields the number 45`, `KANTHORD_HTTP_EVENT_MAX_WAIT=0 yields maxWait 0`, `KANTHORD_HTTP_EVENT_MAX_WAIT=abc throws`, `an env value overrides a config-file value: file maxWait 10 plus env 45 yields 45`
- asserts: all nine Verify bullets of Story 3 — the default `{ maxWait: 30 }`, file and env acceptance, `-1`/`1.5`/env-`abc` refusals, strict-mode refusal of an unknown `http.event` key, and env-over-file precedence. The top-level key-order test stays byte-identical, per the Story.
- The two value refusals mirror the `http.idempotency` refusals loop (one `it` per case, throw + `config-invalid` code, no message text); the env-`abc` refusal asserts the throw only, as the Story directs.

**RED proof.**

- command: `node --test src/services/config/convict.test.ts`
- exit: non-zero — 127 tests, 121 pass, 6 fail:
  - `✖ a config file that omits http.event yields the default maxWait of 30` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + actual - expected + undefined` (the settings projection carries no `event`)
  - `✖ a config file naming event: { maxWait: 10 } yields 10` — `Error [ConfigError]: configuration param 'http.event.maxWait' not declared in the schema`
  - `✖ KANTHORD_HTTP_EVENT_MAX_WAIT=45 yields the number 45` — `TypeError: Cannot read properties of undefined (reading 'maxWait')`
  - `✖ KANTHORD_HTTP_EVENT_MAX_WAIT=0 yields maxWait 0` — same TypeError
  - `✖ KANTHORD_HTTP_EVENT_MAX_WAIT=abc throws` — `AssertionError [ERR_ASSERTION]: Missing expected exception.` (the env var is not wired, so it is ignored)
  - `✖ an env value overrides a config-file value: file maxWait 10 plus env 45 yields 45` — `Error [ConfigError]: configuration param 'http.event.maxWait' not declared in the schema`
- Three tests pass before the seam exists — `event: { maxWait: -1 }`, `event: { maxWait: 1.5 }` and the `sweepInterval` strict-mode test — because convict's strict validation refuses the entire undeclared `http.event` block. They are the characterization pair the Story directs (mirroring lines 1775-1811 and 1813); their value sensitivity is carried by the acceptance sibling `a config file naming event: { maxWait: 10 } yields 10`, which is RED above and turns the refusals into value checks once the block is declared.
- `npm run typecheck`: 5 errors, all `TS2339: Property 'event' does not exist` in `src/services/config/convict.test.ts` — the expected missing-member RED. No TS2307 masking is possible (the module exists, so tsc checked every file body); no stub probe required. No other file in the tree builds an `HttpSettings` literal, so the Story's fixture clause does not fire.

**Open to Software Engineer.**

- `src/services/config/index.ts` — add `HttpEventSettings` (`Readonly<{ maxWait: number }>`) and one last member `event: HttpEventSettings` on `HttpSettings`, per the Story's Change section.
- `src/services/config/convict.ts` — add the `event` schema block after `idempotency` (`maxWait`: `nonNegativeInteger`, default `30`, env `KANTHORD_HTTP_EVENT_MAX_WAIT`), add `["KANTHORD_HTTP_EVENT_MAX_WAIT", "http.event.maxWait"]` as the last entry of the env-integer list, and add the `event` member to the settings projection, all exactly as the Story's Change section quotes. No upper bound in convict; no configuration-file sample; no existing key renamed or reordered.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 03-the-configuration-bounds-the-wait · `http.event.maxWait` lands

**Cycle.** GREEN for `src/services/config/convict.test.ts` (Story 3 RED: six failing tests + five expected TS2339 errors).

**Files changed.**

- `src/services/config/index.ts` (edited) — new `HttpEventSettings` (`Readonly<{ maxWait: number }>`) immediately after `HttpIdempotencySettings`; one last member `event: HttpEventSettings` on `HttpSettings`.
- `src/services/config/convict.ts` (edited) — `event` schema block after `idempotency` (`maxWait`: format `nonNegativeInteger`, default `30`, env `KANTHORD_HTTP_EVENT_MAX_WAIT`); `["KANTHORD_HTTP_EVENT_MAX_WAIT", "http.event.maxWait"]` as the last entry of the env-integer list; `event: { maxWait: config.get("http.event.maxWait") as number }` added to the settings projection after `idempotency`.

**Seam (GREEN).** The schema declares `http.event.maxWait`, so a config file naming it loads, an omitted one yields the `{ maxWait: 30 }` default through the projection, `-1`/`1.5`/unknown-key refusals now fire against the declared block via strict validation, and the env entry converts `KANTHORD_HTTP_EVENT_MAX_WAIT` through `parseEnvInteger` (`"45"`→45, `"0"`→0, `"abc"`→NaN→`config-invalid`) with env winning over file because the loop's `config.set` runs after `config.load`.

**Refactor.** None named by Story 3; nothing deferred.

**Build check.**

- typecheck: exit 0 (resolves the five `TS2339: Property 'event' does not exist` RED errors)
- `npx prettier --check src/services/config/index.ts src/services/config/convict.ts`: clean
- diff footprint: exactly 16 added lines across the two files, nothing removed; no existing key renamed or reordered; top-level key-order list untouched (`event` nests under `http`)

**Assumptions.**

- VERIFIED: `src/services/config/convict.ts` is the only production construction site of the `Settings` literal, and no other file builds an `HttpSettings` literal — grep over `src/**`, so the Story's test-fixture clause does not fire.
- VERIFIED: `src/cli/config/generate.ts` carries no `idempotency` block and needs no edit, per the Story's Verify section.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the waiter polls · Story 4 RED

**Cycle.** RED for Story 4 (`04-the-waiter-polls`, verify path `src/http/server/event/wait.test.ts`), opened after Story 3 confirmed GREEN.

**Handoff verification gate.**

- SE claim (last turn): typecheck clean, prettier clean, fixture in sync. Independently re-verified: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

**Story 3 confirm-GREEN.**

- command: `node --test src/services/config/convict.test.ts`
- exit 0 — 127 tests, 127 pass, 0 fail. Story 3 (`03-the-configuration-bounds-the-wait`) is closed.

**Test written.**

- file: `src/http/server/event/wait.test.ts` (new) — suite: `src/http/server/event/wait.test` — methods: `POLL_INTERVAL_MS is 250`, `a zero second wait resolves empty and schedules nothing`, `the promise is returned before any tick runs`, `the first tick is due at the interval, not before it`, `a match on the first tick resolves with the rows and arms no further timer`, `a match cancels its outstanding timer exactly once`, `a match on the third tick resolves with those rows after three reads`, `a five second wait with no events elapses empty after exactly twenty ticks`, `no tick runs after the terminal one`, `a one second wait is four ticks`, `cancelAll resolves a pending wait empty and cancels its outstanding timer`, `cancelAll resolves several waits in insertion order`, `cancelAll with nothing pending does not throw`, `cancelAll after an elapse does not resolve twice`, `a second cancelAll is a no-op and never moves a cancel past one`, `an elapsed wait plus a cancelled wait leaves no leak`, `a throwing read rejects that one wait and cleans up its timer`, `two waits advance together and stay independent`, `the waiter source names no wall-clock function`
- asserts: every Verify bullet of Story 4 — the virtual-clock fake (separate `fired` / `cancelCalls`, copy-iterating `advanceBy`) drives the full behaviour matrix: zero-wait schedules nothing, the promise precedes any tick, ticks land at exactly 250 ms boundaries, matches resolve on the first/third tick and cancel their entry exactly once, five seconds elapses empty after exactly twenty ticks with nothing armed afterwards, one second is four ticks, `cancelAll` resolves pending waits empty in insertion order, is idempotent and a no-op when idle or post-elapse, no wait leaks (every armed entry ends `fired || cancelCalls === 1`), a throwing `read` rejects one wait and cleans up, two concurrent waits advance independently under one clock; pending-ness asserted only via `Promise.race` against a resolved sentinel.

**RED proof.**

- command: `node --test src/http/server/event/wait.test.ts`
- exit: non-zero — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/http/server/event/wait.ts' imported from .../src/http/server/event/wait.test.ts` (1 test, 1 fail)
- stub probe: `src/http/server/event/wait.ts` — typecheck clean with the Story-declared signatures in place, so no error in my file was masked; against the stub the suite runs 19 tests, 17 fail with `Error: stub` and 2 pass. Stub deleted before this turn.
- The two stub-passes are directed characterizations, not vacuity: `POLL_INTERVAL_MS is 250` pins the constant the Story's contract fixes at 250, and `the waiter source names no wall-clock function` is by-construction source text per the Story. Sensitivity for all behaviour sits in the 17 stub-failing tests.

**Open to Software Engineer.**

- `src/http/server/event/wait.ts` (new) — the seam the test imports: `createWaitRegistry(dependencies: WaitRegistryDependencies): WaitRegistry`, `wait<T>(input: WaitInput<T>): Promise<readonly T[]>`, `cancelAll(): void`, exported constant `POLL_INTERVAL_MS = 250`, over the injected `Schedule` typed from `../idempotency-store.ts`. The exact public contract is quoted verbatim in Story 4's Change section, and the loop bullets beneath it are binding. Nothing else in the tree changes.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 04-the-waiter-polls · the poll-loop registry lands

**Cycle.** GREEN for `src/http/server/event/wait.test.ts` (Story 4 RED: `ERR_MODULE_NOT_FOUND` for `./wait.ts`, 17 of 19 tests failing against the deleted stub).

**Files changed.**

- `src/http/server/event/wait.ts` (new) — exports `POLL_INTERVAL_MS = 250`, `WaitInput<T>`, `WaitRegistry`, `WaitRegistryDependencies`, `createWaitRegistry(dependencies): WaitRegistry`; `Schedule` imported as a type from `../idempotency-store.ts`.

**Seam (GREEN).** `wait` computes `Math.floor((waitSeconds * 1000) / POLL_INTERVAL_MS)` ticks; a zero count returns `Promise.resolve([])` with no timer and no read; otherwise it registers an entry, schedules the first tick, and on each tick calls `read()` once — a non-empty result resolves and cancels the current timer exactly once, an empty result with ticks left re-arms at `POLL_INTERVAL_MS` (the fired cancel is dropped, never re-called), and the terminal empty tick resolves `[]`; a throw from `read()` rejects that one wait through the same settle path; `cancelAll()` walks a snapshot of the insertion-ordered pending list, resolving each empty and cancelling its outstanding timer once, so a second call is a no-op and an elapsed entry cannot resolve twice. Every delay goes through the injected `Schedule`; no `setTimeout`, `setInterval`, `Date.now` or `performance.now` appears in the source, and the module imports nothing outside `http/server/`.

**Refactor.** None named by Story 4; nothing deferred.

**Build check.**

- typecheck: exit 0
- `npx prettier --check src/http/server/event/wait.ts`: clean
- `npx eslint src/http/server/event/wait.ts`: exit 0

**Assumptions.**

- VERIFIED: the public contract matches the Story's quoted block member for member — `wait<T>`, `cancelAll`, `POLL_INTERVAL_MS`, the three exported types, and the `Schedule` type import line.
- VERIFIED: working-tree footprint of this turn is exactly the one new file `src/http/server/event/wait.ts`; no test file and no other production file touched (`git status`).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the handler and the lifecycle · Story 5 RED

**Cycle.** RED for Story 5 (`05-the-handler-and-the-lifecycle`, verify path: the Story Commands block's eight files), opened after Story 4 confirmed GREEN.

**Handoff verification gate.**

- SE claim (last turn): typecheck exit 0, prettier clean on the new waiter. Independently re-verified: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

**Story 4 confirm-GREEN.**

- command: `node --test src/http/server/event/wait.test.ts`
- exit 0 — 19 tests, 19 pass, 0 fail. Story 4 (`04-the-waiter-polls`) is closed.

**Test written.**

- `test/helpers/virtual-clock.ts` (new) — `createFakeSchedule()` moved verbatim out of Story 4's suite so Story 5's suites share the one virtual clock (`armed` entries with separate `fired` / `cancelCalls`, copy-iterating `advanceBy`).
- `src/http/server/event/wait.test.ts` (edited) — mechanical extraction only: deletes the local copy, imports the helper; rerun stays 19/19.
- `src/http/server/event/list-event.test.ts` (edited) — suite unchanged; `handlerApp` gains the Story-mandated options form (same registry object to `createTestApp` and `listEventHandler`, default `maxWaitSeconds: 30`); replaces `wait parses and the handler still answers at once` with 17 tests: `an absent wait answers immediately and schedules nothing`, `wait=0 answers immediately with an empty array and schedules nothing`, `wait=5 with events already present answers at once, reads once and schedules nothing`, `wait=5 with no events elapses to an empty 200 after twenty polls`, `an elapsed wait answers 200, parses against the shipped schema and carries no error envelope`, `wait=5 with an event appended after two poll ticks answers with that event and cancels its timer`, `the cursor reaches the query unchanged on every poll`, `a waited cursor delivers each event once and skips none`, `order=desc under a wait answers at once in query order when rows exist`, `order=desc under a wait elapses empty and keeps desc on every poll input`, `wait above the configured maximum answers 400 before any read`, `wait equal to the configured maximum is accepted and arms a timer`, `wait=1 against a zero maximum answers 400`, `wait=0 against a zero maximum answers 200 at once`, `wait=-1 and wait=abc answer 400 at the schema`, `a repeated wait parameter answers 400 naming wait`, `two waiting requests resolve independently by their own filters`, `a cancelled wait answers an empty 200 without its timer firing`. `wait 61 answers 400 at the schema` and every other existing test stay byte-identical.
- `src/http/server/shutdown.test.ts` (edited) — adds `a cancel step declared first runs before the listener step` and `a throwing cancel step does not stop the listener step` over synthetic steps named `waits`/`listener`/`storage`/`home-lock`.
- `src/main.test.ts` (edited) — adds `the shutdown steps are declared in the order waits, listener, storage, home-lock`: `indexOf` of each `name: "<step>"` in `./main.ts` must exist and be strictly increasing.
- `src/http/server/app.test.ts` (edited) — adds `createApp returns an app and a cancel handle, and the handle reaches the registry` (result keys exactly `["app", "cancelWaits"]`; `cancelWaits()` reaches a flag-setting fake registry); converts the `app.proxy stays false` call site to the adaptive form.
- `src/http/server/start.test.ts`, `src/http/server/dispatch.test.ts` (edited) — the seven remaining TE-owned `createApp` call sites gain the required `waits` member and destructure adaptively; zero assertion changes.
- `src/main.event-wait.test.ts` (new) — route-level acceptance through `launchDaemon` with no injected map, mirroring `main.capability.test.ts`: own daemon at `http.event.maxWait: 2` (`wait=61` refused; `wait=30` above the configured maximum refused; `?wait=0` immediate answer parsing against `eventListResponse`; `GET /v1/event` writes nothing — full `event` contents plus `PRAGMA data_version` around a `?wait=0` call and around a cursor read that returns the seeded event), plus a second describe with its own daemon at `maxWait: 30`: waiting request sent over `node:http` with a `"finish"` handshake, barrier `?wait=0` round trip proves registration, then `SIGTERM`; asserts pending answers `200 { events: [] }`, `exited().code === 0`, signal-to-exit under one second, stderr ends `kanthord: stopped\n` with no `kanthord: shutdown: ` line.
- asserts: the full behaviour matrix of the EPIC's hermetic bullets at handler level — immediate answers never arm a timer, elapse is twenty polls plus the first read (21 reads), a match cancels its outstanding timer exactly once, cursors and `order` reach every poll unchanged, the configured maximum refuses before the first read without clamping, repeats are refused by `singleValued`, per-request filters hold under concurrency, `cancelWaits` resolves a registered wait empty with no tick fired — plus the production step order and the real-root wiring.
- Interpretation noted: the Story bullet "every fired `armed` entry has `cancelCalls` equal to `1`" is asserted as the leak invariant `fired || cancelCalls === 1` with the matched-tick entry pinned to exactly `1` — the two naturally-fired earlier timers have `cancelCalls === 0` by construction (Story 4's landed semantics); taken literally the bullet contradicts the registry that Story 4 delivered.

**RED proof.**

- command: `node --test src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/app.test.ts src/http/server/start.test.ts src/http/server/dispatch.test.ts src/http/server/shutdown.test.ts src/main.test.ts src/main.event-wait.test.ts`
- exit: non-zero — 137 tests, 125 pass, 12 fail:
  - `✖ wait=5 with no events elapses to an empty 200 after twenty polls` — 1 query call, expected 21
  - `✖ wait=5 with an event appended after two poll ticks answers with that event and cancels its timer` — `{ events: [] } !== [first]`
  - `✖ the cursor reaches the query unchanged on every poll` — 1 recording, expected 21
  - `✖ a waited cursor delivers each event once and skips none` — `'answered' !== 'registered'` (handler never enters the registry)
  - `✖ wait above the configured maximum answers 400 before any read` — `200 !== 400`, query already read
  - `✖ wait equal to the configured maximum is accepted and arms a timer` — armed `0 !== 1`
  - `✖ wait=1 against a zero maximum answers 400` — `200 !== 400`
  - `✖ two waiting requests resolve independently by their own filters` — armed `0 !== 2`
  - `✖ a cancelled wait answers an empty 200 without its timer firing` — `'answered' !== 'registered'`
  - `✖ createApp returns an app and a cancel handle, and the handle reaches the registry` — Koa key set vs `["app", "cancelWaits"]`
  - `✖ a wait above the configured maximum is refused through the real composition root` — `200 !== 400`
  - `✖ the shutdown steps are declared in the order waits, listener, storage, home-lock` — `name: "waits"` not found in `main.ts` (`-1`)
- Every pre-existing test still passes, including the Story 5-directed characterizations that are green before the seam (immediate-answer rows, schema refusals `-1`/`abc`/`61`, repeated-key refusal, both `shutdown.test.ts` additions, the daemon file's `wait=61`/`?wait=0`/writes-nothing/shutdown rows): their sensitivity activates with the seam; the twelve failures above carry it.
- `npm run typecheck`: 21 errors, all inside TE-owned files — 12× TS2353 `waits` not yet on `AppDependencies`/`ListEventHandlerDependencies` literals, 6× TS2345 + 2× TS18046 from the adaptive `Koa | App` extraction typing as `unknown` until the return type changes, 1× TS2339 `cancelWaits` on bare Koa. No error outside those five files; no `TS2307` anywhere, so tsc checked every file body — no stub probe required. All ten touched files prettier-clean.

**Open to Software Engineer.**

- `src/http/server/event/list-event.ts` — `ListEventHandlerDependencies` becomes exactly `Readonly<{ listEvents: (input: ListEventInput) => readonly EventView[]; waits: WaitRegistry; maxWaitSeconds: number }>` and the returned handler becomes async with the ordered steps of the Story's Change section (parse → split `wait` from filters → refuse `wait > maxWaitSeconds` before the first read → answer the first read when non-empty or wait absent/zero → otherwise `await dependencies.waits.wait(...)`).
- `src/http/server/app.ts` — export `systemSchedule`; add required last member `waits: WaitRegistry` to `AppDependencies`; add exported `type App = Readonly<{ app: Koa; cancelWaits: () => void }>`; `createApp` returns it with `cancelWaits` delegating to `dependencies.waits.cancelAll()`.
- `src/main.ts` — construct `createWaitRegistry({ schedule: systemSchedule })` before the handlers map; pass `waits` and `maxWaitSeconds: settings.http.event.maxWait` into the `event.list` binding; destructure `const { app, cancelWaits } = createApp({...})`; prepend the `name: "waits"` step to the shutdown array (final order `waits`, `listener`, `storage`, `home-lock`).
- The test-side consumers of those shapes are already updated this turn (`test/helpers/app.ts`, `app`/`start`/`dispatch` test call sites); once the three production files land, typecheck names nothing further.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 05-the-handler-and-the-lifecycle · handler + lifecycle land; two lane-blockers raised

**Cycle.** GREEN for Story 5's production files (`src/http/server/event/list-event.ts`, `src/http/server/app.ts`, `src/main.ts`) against the twelve failing assertions of the last TEST-ENGINEER turn. Two reds remain, both in files I may not touch; each is raised as an OPEN below with evidence and a precise fix.

**Files changed.**

- `src/http/server/event/list-event.ts` (edited) — `ListEventHandlerDependencies` becomes exactly `Readonly<{ listEvents: (input: ListEventInput) => readonly EventView[]; waits: WaitRegistry; maxWaitSeconds: number }>`; the returned handler becomes `async` with the Story's binding step order: parse → split `const { wait, ...filters } = parsed.data` → refuse `wait > dependencies.maxWaitSeconds` with `httpError("invalid-request", "the event filters are not valid")` before the first read → answer the first read when it is non-empty or `wait` is absent or `0` → otherwise `await dependencies.waits.wait({ read: () => dependencies.listEvents(filters), waitSeconds: wait })`. The eight-field map (only rename `createdAt: event.occurredAt`) is extracted once into a local `formatEvents` shared by both returns; both return `{ status: 200, body: { events } }`.
- `src/http/server/app.ts` (edited) — `systemSchedule` gains `export`; `waits: WaitRegistry` added as the last member of `AppDependencies`, required; exported `type App = Readonly<{ app: Koa; cancelWaits: () => void }>` immediately before `createApp`; signature returns `App`; final return is `{ app, cancelWaits: () => { dependencies.waits.cancelAll(); } }`. Middleware chain and its order, `bodyParserForHandled`, `bindingOffenders` and `BindingError` untouched.
- `src/main.ts` (edited) — `systemSchedule` now imported from `./http/server/app.ts`; the git runner's same-named import renamed to `gitSchedule` (line 29, single use site line 221) — forced by the identifier collision, see Assumptions; `const waits = createWaitRegistry({ schedule: systemSchedule });` immediately after the services block ending at `NodeWriteRevision` (line 256), before the handlers map; the `event.list` binding gains `waits,` and `maxWaitSeconds: settings.http.event.maxWait,`; the `createApp` call destructures `const { app, cancelWaits } = createApp({...})` with `waits,` added to the dependency literal; the shutdown `steps` array prepends `{ name: "waits", run: () => { cancelWaits(); } }` — final production order `waits`, `listener`, `storage`, `home-lock`. No signal handler added.

**Seam (GREEN).** The handler now enters the registry only when `wait` is present, non-zero, within the configured maximum, and the first read returned nothing — so immediate answers arm no timer, elapses poll through the injected Schedule until the registry resolves them empty, matches resolve with their rows, and the app-level `cancelWaits()` reaches that same registry because `main.ts` constructs one registry and hands the identical object to both `listEventHandler` and `createApp`.

**Refactor.** None named by Story 5 beyond the mandated `formatEvents` extraction (applied). Prettier normalized the two extended import statements in `main.ts` to canonical multi-line form — formatting only, verified in the diff.

**Build check.**

- typecheck: exit 2 — exactly ONE error, in a file I may not touch: `src/http/server/actor/registration.test.ts(202): error TS2741: Property 'waits' is missing ... but required in type 'AppDependencies'` (OPEN-1). tsc checked every file body (no TS2307 anywhere), so all three production files typecheck clean against every other consumer, including last turn's updated test files.
- `npx prettier --check src/main.ts src/http/server/app.ts src/http/server/event/list-event.ts`: clean
- `npx eslint src/main.ts src/http/server/app.ts src/http/server/event/list-event.ts`: exit 0

**OPEN: two blockers, both outside my lane.**

- OPEN-1 - status:OPEN - action:YES - missing `waits` at one TE-owned `createApp` call site - the RED turn updated seven call sites but `src/http/server/actor/registration.test.ts:202` still builds an `AppDependencies` literal without the now-required `waits` member, so `npm run typecheck` (and therefore the TE's `npm run verify:handoff` preflight) fails. - fix:test-engineer adds `waits: createWaitRegistry({ schedule: () => () => {} })` to that literal, importing `createWaitRegistry` from `../../event/wait.ts` (depth adjusted for that file's location), mirroring `start.test.ts:36`; zero assertion changes. - why:the required member is what names every remaining call site; this one was missed, and test files are outside my lane by hard rule.

- OPEN-2 - status:OPEN - action:YES - the new step-order test cannot pass against any faithful `main.ts` - `src/main.test.ts:552-577` takes `source.indexOf('name: "storage"')` over the whole file, and `src/main.ts:332` already carries that exact literal — the health reporter inside `reporters` — about 318 lines before the shutdown step (line 652). `indexOf` returns the earliest match, so `listener(650) < storage(332)` fails forever; simulated against the edited tree: positions waits 26336, listener 26445, storage 15166, home-lock 26644. - fix:test-engineer anchors the search inside the shutdown region — `const stepsSource = source.slice(source.indexOf("steps: ["));` (unique in main.ts, line 650) and take each of the four `indexOf` calls within `stepsSource` — preserving the test's intent verbatim otherwise. Do NOT anchor on `indexOf("createShutdown")`: the import at line 180 precedes everything. - why:the reporter's name is the `/v1/health` dependency name pinned throughout `read-health.test.ts` (lines 55-192), so renaming it is a contract change; the steps array cannot be declared earlier because it closes over `listening` and `cancelWaits`, which depend on `createApp` → handlers → `healthDependencies` → `reporters`; relocating `reporters` below `createShutdown` would satisfy the grep only by separating data from its sole consumer — a dodge, not a fix.

**Assumptions.**

- VERIFIED: the Story's literal "extend the `createApp` import to carry `systemSchedule`" collides with `main.ts:27`'s pre-existing `import { createGitRunner, systemSchedule } from "./services/git/run.ts"`, and the two bindings have different types (git's `Schedule` is `(callback, delayMs) => ScheduledTimer`; app's is `(milliseconds, callback) => () => void`). The minimal faithful resolution renames the git binding to `gitSchedule` at its single use site, so every Story-mandated line lands verbatim — including `createWaitRegistry({ schedule: systemSchedule })` at line 256.
- VERIFIED: the pre-existing `main.test.ts` region test (lines 464-483) slices on `source.indexOf("const app = createApp")`, which my destructured form sends to `-1` (`slice(x, -1)` then runs to length−1, growing the region). Simulated the test's exact logic on the edited file: region `actor: settings.actor` count 0, whole-source counts 1 and 4, `ulid()` count 1 — every pre-existing assertion still holds; the sentinel decay is latent, not failing, and the string stays TE-owned.
- VERIFIED: handler behaviour traced against the full matrix — absent/zero/immediate-row answers never enter the registry (`armed.length === 0`); the empty five-second elapse reads exactly 21 times; the two-ticks match resolves on the 4th read with `armed.length === 3`, `armed[2].cancelCalls === 1` and every entry satisfying `fired || cancelCalls === 1`; `wait=30` against maximum 30 arms before any advance; `wait=0` against maximum 0 answers `200` because `0 > 0` is false; `filters` never carries `wait`; both returns share one formatting function.
- UNVERIFIED: no tests executed this turn (test execution is the TE's gate); the two OPENs above are the expected remaining reds, everything else is claimed green on typecheck/lint/format plus the traces above.

ATTEMPT-FAILED: 05-the-handler-and-the-lifecycle — production GREEN complete, but typecheck still fails on the TE-owned registration.test.ts missing the required `waits` member, and the TE's new step-order source test cannot pass against any faithful main.ts (the health reporter's `name: "storage"` precedes the steps under whole-file indexOf)

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the handler and the lifecycle · confirm-GREEN + the capability names the wait · Story 6 RED

**Cycle.** Confirm GREEN for Story 5 (`05-the-handler-and-the-lifecycle`), then RED for Story 6 (`06-the-capability-names-the-wait`, verify path `src/http/contract/capability.test.ts` + `src/main.capability.test.ts`), opened in the same turn.

**Handoff verification gate.**

- SE claim: production files landed; typecheck exit 2 with exactly ONE error, `src/http/server/actor/registration.test.ts(202): TS2741: Property 'waits' is missing`, plus two OPENs both located in TE-owned files. Independently re-verified at turn open: `npm run verify:handoff` → `VERIFY: FAIL — npm run typecheck exited 2`, naming exactly that error and no other. The failure is the TE-lane blocker itself; both repairs below are mine.
- After the repairs: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

**Test written (lane repairs to my own files — the SE's OPENs).**

- file: `src/http/server/actor/registration.test.ts` (edited) — OPEN-1: adds the `createWaitRegistry` import from `../event/wait.ts` and `waits: createWaitRegistry({ schedule: () => () => {} })` to the one `AppDependencies` literal at :202, mirroring `start.test.ts:36`; zero assertion changes.
- file: `src/main.test.ts` (edited) — OPEN-2: the step-order test now anchors inside the shutdown region (`source.slice(source.indexOf("steps: ["))`; the marker is unique in `main.ts`) before taking each `name: "<step>"` `indexOf`; whole-file search matched the health reporter's pre-existing `name: "storage"` at line 339, ~318 lines before the steps array. Assertions byte-identical otherwise.

**Story 5 confirm-GREEN — after repairing three defects in MY Story 5 tests**, all exposed the moment the seam made handlers actually wait:

- **Clock advanced before registration.** The elapse/match/cursor/desc suites called `advanceTicks` synchronously right after issuing the request; supertest had not dispatched yet, so the timer armed after every advance and `await pending` never settled — the observed hang. Fix per the Story's own "a wait is never observed by guessing" idiom: a `signalledRegistry` wrapper resolves a promise per fake-schedule call, and each waiting test races registration against answering (`assertRegisteredBeforeAnswered`) before advancing. The literal Story wording "issue without awaiting, advance, await" deadlocks against any faithful seam; the signal form is what the Story prescribes for the cancellation case and is now uniform across the matrix.
- **Concurrency fake answered on the first read.** My matching filter returned `[first]` for `type=node.created` on read 1, so that request correctly never waited ("a first read that returns events never waits"). The match is now gated on `clock.now() >= POLL_INTERVAL_MS`: empty while unregistered and on the first read, `[first]` on poll reads. Deterministic, no wall clock.
- **Supertest dispatches lazily.** Merely calling `app.get(...)` does not send; the second concurrent request was never subscribed, so arm 2 never happened. Both pending promises are now subscribed before the registration race.
- **Daemon shutdown stalled ~4 s on a client keep-alive socket.** The barrier rode `globalThis.fetch` (undici pool, ~4 s idle timeout), holding `listener.close()` open past the EPIC's under-one-second bound even though the wait was cancelled first. Pending request and barrier now both use `node:http` with `agent: false` — fresh socket closed per response, matching the Story's barrier wording "on a second connection". No sleeps anywhere.
- Story 5 command suite: `node --test src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/app.test.ts src/http/server/start.test.ts src/http/server/dispatch.test.ts src/http/server/shutdown.test.ts src/main.test.ts src/main.event-wait.test.ts`
- exit 0 — 137 tests, 137 pass, 0 fail. Story 5 (`05-the-handler-and-the-lifecycle`) is closed. Spot re-run of the repaired neighbours: `registration.test.ts` + `wait.test.ts` — 28/28.

**Test written (Story 6).**

- file: `src/http/contract/capability.test.ts` (edited) — suite: `src/http/contract/capability.test` — methods: `the real registry declares the exact expected list` (amended to `["event-wait", "external-drive", "per-node-write", "project-graph"]`), `event-wait maps to exactly one operation` (deep-equals `["event.list"]`), `event-wait is the first key of the capability map`, `a stubbed event.list suppresses the event-wait name` (mirrors the stubbed-`node.report` test), `an absent event.list suppresses the event-wait name` (mirrors the absent-`project.graph` test). Every other test byte-identical.
- file: `src/main.capability.test.ts` (edited) — suite unchanged; `the capability list is the expected list` expects the same four names in the same order. Nothing else changes.
- asserts: `capabilityOperations` carries `event-wait` as its first key mapping to exactly `["event.list"]`, the real and served capability lists name it first, and a stubbed or absent `event.list` suppresses it.

**RED proof.**

- command: `node --test src/http/contract/capability.test.ts src/main.capability.test.ts`
- exit: non-zero — 19 tests, 15 pass, 4 fail:
  - `✖ the real registry declares the exact expected list` — deep-equal: actual lacks `'event-wait'` at the head
  - `✖ event-wait maps to exactly one operation` — `+ undefined - ['event.list']` at `src/http/contract/capability.test.ts:52`
  - `✖ event-wait is the first key of the capability map` — `+ 'external-drive' - 'event-wait'` at `:56`
  - `✖ the capability list is the expected list` — deep-equal through the real daemon: actual lacks `'event-wait'` at `src/main.capability.test.ts:124`
- The two suppression tests are directed characterizations that pass before the seam (with no `event-wait` entry nothing can suppress it); their value activates once the entry exists, mirroring how the Story directs them.
- `npm run typecheck`: 1 error — `TS7053` at `src/http/contract/capability.test.ts(52)` (`'"event-wait"' can't be used to index...Property 'event-wait' does not exist`), the expected missing-member RED. No TS2307 anywhere, so tsc checked every file body; no stub probe required. All five touched files prettier-clean and eslint-clean.

**Open to Software Engineer.**

- `src/http/contract/capability.ts` — add one entry as the FIRST key of `capabilityOperations`, before `"external-drive"`:
  `"event-wait": ["event.list"],`
  The position is load-bearing (the map-keys-equal-enum-options test also asserts bytewise sortedness). Nothing else in the file changes; `declaredCapabilities` needs no edit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 06-the-capability-names-the-wait · `event-wait` joins the capability map

**Cycle.** GREEN for Task `06-the-capability-names-the-wait` (`src/http/contract/capability.test.ts` + `src/main.capability.test.ts`; four failing assertions plus one TS7053 RED error).

**Files changed.**

- `src/http/contract/capability.ts` (edited) — one line added as the first key of `capabilityOperations`, before `"external-drive"`: `"event-wait": ["event.list"],`. Nothing else in the file changes; `declaredCapabilities`, `capabilityName` and the three existing entries stay byte-identical.

**Seam (GREEN).** The map now names `event-wait` → exactly `["event.list"]` as its first key; because `event.list` is `routed` in the registry, `declaredCapabilities` declares it and its bytewise sort already places it before `external-drive`, so the exact-list tests, the first-key test, the single-operation mapping test and the served-list acceptance all see the entry — while a stubbed or absent `event.list` still suppresses it through the unchanged filter, exactly as the two characterization tests pin.

**Refactor.** None named by Story 6; nothing deferred.

**Build check.**

- typecheck: exit 0 (resolves the TS7053 missing-member RED at `src/http/contract/capability.test.ts(52)`)
- `npx prettier --check src/http/contract/capability.ts`: clean
- `npx eslint src/http/contract/capability.ts`: exit 0

**Assumptions.**

- VERIFIED: this turn's working-tree delta is exactly the one added line in `src/http/contract/capability.ts` (+1, −0 per `git diff`); every other modified file in `git status` belongs to earlier turns of this cycle.
- VERIFIED: the load-bearing position holds — `"eve"` < `"ext"` at the third byte (`0x76` vs `0x78`), so map keys remain bytewise sorted and the map-keys-equal-enum-options test stays satisfied.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the capability names the wait · Story 6 confirm-GREEN + the proposal records the wait · Story 1 GREEN-only pass-through

**Cycle.** Confirm GREEN for Story 6 (`06-the-capability-names-the-wait`) — closed after a lane repair to two of my own stale tests — then GREEN-ONLY pass-through for Story 1 (`01-the-proposal-records-the-wait`), the last Story in the dispatch order of `.agents/plan/stories/028-event-long-poll/index.md`.

**Handoff verification gate.**

- SE claim (last turn): typecheck exit 0, prettier clean, eslint clean, working-tree delta exactly one added line in `src/http/contract/capability.ts`. Independently re-verified at turn open: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Diff footprint audited: `src/http/contract/capability.ts` carries exactly the one added first-key line `"event-wait": ["event.list"],`; no other production file changed this turn.

**Lane repair (my files — the confirm run surfaced two stale TE-owned literals, not an SE defect).**

- `src/http/contract/capability.test.ts` (edited) — the pre-existing `a stubbed operation suppresses its name` and `an absent operation suppresses its name` pin the remainder after suppressing exactly one operation (`node.report`, `project.graph`), so their expected arrays encoded the pre-epic three-name universe; the new fourth capability joins every remainder whose `event.list` stays routed, by construction. Story 6's "need no edit and must keep passing" enumeration does not list either test. Repair: `"event-wait"` prepended to both remainders (bytewise position); assertions otherwise byte-identical. The assertion intent — exactly one name suppressed relative to the full declared list — is preserved.
- Before repair: 19 tests, 17 pass, 2 fail —
  - `✖ a stubbed operation suppresses its name` — deep-equal: actual `['event-wait', 'per-node-write', 'project-graph']`, expected `['per-node-write', 'project-graph']`
  - `✖ an absent operation suppresses its name` — deep-equal: actual `['event-wait', 'external-drive', 'per-node-write']`, expected `['external-drive', 'per-node-write']`
- The SE's implementation is correct in both cases: `node.report` is an operation of `external-drive` and `project.graph` of `project-graph` (`src/http/contract/capability.ts:5-15`), so exactly the one intended name is suppressed and `event-wait` remains, as `event.list` stays `routed`.

**Story 6 confirm-GREEN.**

- command: `node --test src/http/contract/capability.test.ts src/main.capability.test.ts` (the Story's Verify command, verbatim)
- exit 0 — 19 tests, 19 pass, 0 fail. Story 6 (`06-the-capability-names-the-wait`) is closed.
- Post-repair re-check: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

---

## TEST-ENGINEER — the proposal records the wait · Story 1 · GREEN-only Tasks

**Story file.** `.agents/plan/stories/028-event-long-poll/01-the-proposal-records-the-wait.md`

**Tasks forwarded to Software Engineer.**

- `01-the-proposal-records-the-wait`: `docs/proposal/api/event.md` + `docs/proposal/phase-1/transport.md` — documentation-only edit: the four verbatim replacements in `event.md` (lines 24, 40, 42, 44) and the new `## A held request` section before `## Every request carries its own payload` in `transport.md`, then `npx prettier --write` over both files.

**No RED phase.** The Story changes no file under `src/`, `test/` or `scripts/`; its Verify section runs the existing `src/http/contract/parity.test.ts` (the row-count assertion at line 25 must stay `74`) plus `git diff`/`grep` inspection of the two docs. Coverage owned elsewhere per the Story gate — no test is written for documentation.

**Open to Software Engineer.**

- Implement GREEN per the Story file's Change section, verbatim: the four paragraph replacements in `docs/proposal/api/event.md`, the one new section in `docs/proposal/phase-1/transport.md`, nothing else in either file, no other proposal file touched. `docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh` lines 99-102). Honour the Constraints section: route matrix unchanged, `phase-2` gone from `event.md` (expect `grep -c` = `0`), the two numbers 60 and 30 stay distinct, no notification/stream/harness wording. After the edit, my next turn runs the build-proof gate (`npm run verify`) and then the full EPIC Verification Gate — `Gates:` plus the `Proof:` command ending `PASS EPIC-028` — before the IMPLEMENTATION_READY_FOR_REVIEW turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-the-proposal-records-the-wait · the proposal records the wait

**Cycle.** GREEN-ONLY implementation for Tasks: `01-the-proposal-records-the-wait` (Story file `.agents/plan/stories/028-event-long-poll/01-the-proposal-records-the-wait.md`, forwarded by the last TEST-ENGINEER pass-through).

**Files changed.**

- `docs/proposal/api/event.md` (edited) — Edit 1: line 24 replaced in full with the four paragraphs (wait in seconds + held-until rule; elapsed wait is a normal `200` empty array; absent/zero wait and first-read-with-rows never wait; bounds refused never clamped, schema ceiling 60 vs daemon default 30, proxy idle-timeout warning). Edits 2-4: lines 40, 42, 44 each replaced in full with the Story's verbatim replacement sentences. No other line touched.
- `docs/proposal/phase-1/transport.md` (edited) — one new section `## A held request` inserted immediately before `## Every request carries its own payload`: the held-route statement, the shutdown-cancels-waits-first rule with the cancelled-wait-answers-empty-200 consequence, and the reverse-proxy read-timeout requirement over `http.event.maxWait`. No other line touched.

**Implementation notes.** Both replacements landed byte-for-byte as the Story quotes them; the two numbers stay distinct (60 schema ceiling, 30 configured default); no notification/post-commit-hook/stream wording and no harness wording appears; `event.stream` stays `post-mvp`/`deferred` in the untouched route table. Formatting ran per the Story: `npx prettier --write` over both files reported both already canonical ("unchanged"), so committed bytes are stable.

**Story Verify inspections run this turn (non-test).**

- `git diff --stat docs/` names exactly two files: `docs/proposal/api/event.md` (+10/−4) and `docs/proposal/phase-1/transport.md` (+8).
- `grep -c "phase-2" docs/proposal/api/event.md` → `0`.
- Full diff read back: no hunk touches the route table (lines 9-13) or the cursor/order/range paragraphs (lines 18, 20, 22), so the parity row count of 74 holds by construction.

**Build check.**

- typecheck (`npm run typecheck`): exit 0
- prettier on both files: clean

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** All six Stories of EPIC `028-event-long-poll` implemented and confirmed green; both parts of the EPIC Verification Gate executed this turn after the final GREEN-only Story 1 landed.

**Handoff verification gate.**

- SE claim (Story 1 GREEN-only turn): typecheck exit 0, prettier clean on both docs files, docs diff naming exactly two files. Independently re-verified at turn open: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; `git diff --stat docs/` names exactly `docs/proposal/api/event.md` (+10/−4) and `docs/proposal/phase-1/transport.md` (+8); `grep -c "phase-2" docs/proposal/api/event.md` → `0`.

**Lane repairs this turn — three stale expected literals in TE-owned test files**, all the same mechanical conformer class already repaired twice this cycle (the new fourth capability / new config path joining lists pinned to the pre-epic universe); zero assertion-intent changes, confirmed against `scripts/lane-check.sh` (both files denied to the software-engineer):

- `src/services/home-lock/startup.test.ts` (edited) — line 127 pins the served `/v1/health` payload through the real daemon; `"event-wait"` prepended to the expected capabilities array (the plan's index.md enumerated two expected lists; this third one surfaced only under the full `Gates:` run).
- `src/http/contract/event-payload.test.ts` (edited) — `nonEventLiterals` gains `"http.event.maxWait"` in its bytewise position (Story 3's config path literal is scanned by the producer scanner).
- `scripts/publish-contract.test.ts` (edited) — the published event-feature parameter list gains `"wait"` after `"type"` (Story 2 renders it; publish emits the same document).

**EPIC verification gate.**

- Story 1 Verify: `node --test src/http/contract/parity.test.ts` → 11/11, row-count assertion intact; docs-diff and phase-2 inspections above; covered by `npm run verify`.
- Story 2 Verify: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts` → exit 0, 179/179.
- Story 3 Verify: `node --test src/services/config/convict.test.ts` → exit 0, 127/127.
- Story 4 Verify: `node --test src/http/server/event/wait.test.ts` → exit 0, 19/19.
- Story 5 Verify: `node --test src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/app.test.ts src/http/server/start.test.ts src/http/server/dispatch.test.ts src/http/server/shutdown.test.ts src/main.test.ts src/main.event-wait.test.ts` → exit 0, 137/137.
- Story 6 Verify: `node --test src/http/contract/capability.test.ts src/main.capability.test.ts` → exit 0, 19/19.
- `typecheck` (via `npm run verify:handoff`) → exit 0, `VERIFY: PASS — npm run typecheck is clean` (re-run after the lane repairs).
- `Gates:` — `npm run verify` → exit 0; 5100 tests, 5100 pass, 0 fail (first run failed on the three stale literals above; re-run after repair is the recorded result).

**Proof.**

- command: `node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts && echo "PASS EPIC-028"`
- exit 0 — 244 tests, 244 pass, 0 fail; success string printed verbatim: `"PASS EPIC-028"`

**Tasks closed.** 6 across 6 Stories — `01-the-proposal-records-the-wait` (GREEN-only, docs), `02-the-contract-declares-the-wait` (closed under the human-routed `/debate` amendment of D1), `03-the-configuration-bounds-the-wait`, `04-the-waiter-polls`, `05-the-handler-and-the-lifecycle`, `06-the-capability-names-the-wait`. No Story outstanding, every Story file expanded and implemented.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts) — "PASS EPIC-028"
- stories: 6/6 complete
- date: 2026-08-22
- state: local-uncommitted

END: TEST-ENGINEER

## ORCHESTRATOR — reviewer gate routed

Reviewer-engineer verdict: FAIL — 13 source and 17 test files reviewed against base 4bf2a3b; `npm run verify` 5100/5100 and Proof `PASS EPIC-028` re-confirmed during review. Findings split by action tag below.

AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 2 action:NO finding(s) recorded for the human.
BLOCKER: test-import-boundary-violations — changed tests import the sibling production module `src/http/server/event/wait.ts` (`registration.test.ts:28`, `app.test.ts:6`, `dispatch.test.ts:13`, `list-event.test.ts:8-9`, `start.test.ts:6`), violating the test import rule of AGENTS.md; replace with structural no-op fakes and shared waiter setup through `test/helpers/`, preserving every assertion.
BLOCKER: write-nothing-test-uses-immediate-requests — `main.event-wait.test.ts:143-150` snapshots database state across `wait=0` calls that never hold, so EPIC lines 198-199 ("GET still writes nothing" after an elapsed waited call and one returning an event) are unproven; add both held-call assertions with the injected schedule and direct SQLite snapshots.
BLOCKER: redundant-return-shape-compatibility — `test/helpers/app.ts:138-139`, `app.test.ts:367`, `start.test.ts:38,118` keep adaptive branches for the former Koa return; Story 05 defines the new return shape unconditionally — destructure `app` and `cancelWaits` directly from `createApp`.
INFO: formal-plan-amendment - status:OPEN - action:NO - NEEDS-HUMAN - implemented schema supersedes EPIC D1 (lines 43-49) and Story 02 Change lines 9-15 via the debate-routed `z.preprocess(...)` expression; planning clauses unchanged. fix:Ulrich amends both clauses verbatim before commit. why:plan authority is reserved to the operator.
INFO: handler-calls-query-repeatedly - status:OPEN - action:NO - NEEDS-HUMAN - `listEventHandler` calls `listEvents` directly (line 40) and again through the waiter (line 45); AGENTS.md requires a handler to invoke exactly one command or query. fix:choose the orchestration seam or amend the architecture contract. why:an architecture decision about transport polling ownership.

## TEST-ENGINEER — review blockers repaired · implementation ready for re-review

**Cycle.** The three `BLOCKER:` findings routed from the reviewer gate are all test-lane defects or proof gaps; all three are repaired this turn. The two `INFO:` lines (`formal-plan-amendment`, `handler-calls-query-repeatedly`) are `action:NO` and reserved for the human — not acted on.

**Handoff verification gate.**

- No SE turn since the orchestrator routing; the last SE build claim (Story 1 docs turn, typecheck clean) re-verified independently at turn open: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`. Re-run again after the repairs: PASS.

**BLOCKER: test-import-boundary-violations — repaired.**

- `test/helpers/wait-registry.ts` (new) — the one file that names `src/http/server/event/wait.ts`: re-exports `createWaitRegistry`, `POLL_INTERVAL_MS` and the three types, adds `createTestWaits()` (real registry over the shared virtual clock) and `noopWaits()` (structural no-op fake returning `Promise.resolve([])`, `cancelAll` a no-op).
- `test/helpers/app.ts` (edited) — default `waits` now built through the helper; the helper no longer imports the sibling production module.
- `src/http/server/actor/registration.test.ts:28,213`, `src/http/server/dispatch.test.ts:13 + 6 sites`, `src/http/server/start.test.ts:6 + 2 sites` (edited) — dependency-satisfaction sites now use `noopWaits()`; stronger than before, because an unexpected wait now hangs instead of silently arming nothing.
- `src/http/server/app.test.ts:6,365` (edited) — literal site uses `noopWaits()`; the cancelWaits-reach test keeps its inline recording fake.
- `src/http/server/event/list-event.test.ts:8-9` (edited) — waiter semantics suite imports through the helper re-exports; every assertion byte-identical.
- Grep sweep confirms no remaining `event/wait` import in any test except `wait.test.ts` itself (module under test).

**BLOCKER: write-nothing-test-uses-immediate-requests — repaired with two held-call tests.**

- `src/main.event-wait.test.ts` (edited) — describe config `http.event.maxWait` 2 → 1 (shortest configurable elapse); `snapshot()` split into `eventRows()` + `dataVersion()` on one long-lived `DatabaseSync`; new `heldRequest()` helper (`node:http`, `agent: false`). The old `wait=0` test is replaced by:
  - `a waited call that elapses writes nothing` — held `?wait=1`, pending-proof via barrier ordering (`order === []` after a full concurrent `?wait=0` round trip), then `200 {events:[]}`, then strict equality of rows and `PRAGMA data_version`.
  - `a waited call that returns an event writes nothing beyond the delivered event` — held `?wait=1&after=<cursor>`, pending-proven, seeded via `POST /v1/actor` in-window, delivered on a poll tick; asserts row count +delivered, prefix rows deep-equal untouched, and tail ids exactly the delivered ids.
- **These pass immediately — intended characterization per the review-blocker exception**, so sensitivity is proven another way: the old form could not fail on any write bug because `wait=0` never holds; the new form fails if waiting regresses to immediate answering (held would resolve before the barrier completes and the order assertion trips), and its comparator runs positively in-window against the seed commit — any row the GET itself wrote would break Test A's strict equality or Test B's prefix/tail accounting. Observed durations confirm genuine holds: elapsed 1017 ms/1014 ms, deliver-on-tick 266–271 ms. `data_version` is asserted only in A (no in-window writer exists there); in B it necessarily moves with the seeded append and carries no signal about the GET. Wall-clock involvement is inherent to the un-injectable composition root; it is bounded by the minimum legal `maxWait` and asserted by ordering, never by measured duration — unit-level waits stay fake-schedule-driven.

**BLOCKER: redundant-return-shape-compatibility — repaired.**

- All four adaptive forms removed: `test/helpers/app.ts:138-139` → `const { app, cancelWaits } = created;`; `app.test.ts:367` and `start.test.ts:38,118` → direct destructuring of `app`.

**Suite results (this turn).**

- Affected suites: `node --test src/http/server/event/wait.test.ts src/http/server/event/list-event.test.ts src/http/server/app.test.ts src/http/server/start.test.ts src/http/server/dispatch.test.ts src/http/server/actor/registration.test.ts` → exit 0, 116/116.
- Route-level acceptance: `node --test src/main.event-wait.test.ts` → exit 0, 6/6.
- typecheck exit 0; prettier clean on all eight touched files; eslint exit 0.

**EPIC verification gate.**

- Story Verify commands unchanged from the prior ready-for-review turn; all six Stories remain green under the Gate below.
- `typecheck` (via `npm run verify:handoff`) → exit 0, `VERIFY: PASS — npm run typecheck is clean`.
- `Gates:` — `npm run verify` → exit 0; 5102 tests, 5102 pass, 0 fail (5100 prior + the two held-call tests).

**Proof.**

- command: `node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts && echo "PASS EPIC-028"`
- exit 0 — 245 tests, 245 pass, 0 fail; success string printed verbatim: `"PASS EPIC-028"`

**Tasks closed.** 6 across 6 Stories — `01-the-proposal-records-the-wait` (GREEN-only, docs), `02-the-contract-declares-the-wait` (closed under the human-routed `/debate` amendment of D1), `03-the-configuration-bounds-the-wait`, `04-the-waiter-polls`, `05-the-handler-and-the-lifecycle`, `06-the-capability-names-the-wait`. No Story outstanding; this turn edited TE-lane files only.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts) — "PASS EPIC-028"
- stories: 6/6 complete
- date: 2026-08-22
- state: local-uncommitted

END: TEST-ENGINEER

## ORCHESTRATOR — human review round 1

Operator verdict received in session: fix B2; AGENTS.md's "a handler parses a request, calls exactly one command or one query, and formats the response" is binding. B1 (formal plan amendment) stays reserved to the operator and is NOT routed.

HUMAN_REVIEW: FAIL — operator directs the handler-calls-query-repeatedly blocker fixed; the one-query rule of AGENTS.md governs the redesign.
BLOCKER: handler-invokes-exactly-one-query — `src/http/server/event/list-event.ts` calls `listEvents` directly (line 40) and again through the waiter (line 45); restructure so the whole request lifecycle (immediate answer, held elapse, held delivery) flows through exactly one query invocation, pinned by a failing regression test that counts query invocations across all three paths before the SE touches production code. The seam choice (first read moved into the waiter, or the query gaining the waiter through a service interface per the import matrix) belongs to the loop; no vendor packages in queries/.

## TEST-ENGINEER — review blocker handler-invokes-exactly-one-query · regression RED

**Cycle.** RED regression for the routed review blocker `handler-invokes-exactly-one-query` (AGENTS.md: "a handler parses a request, calls exactly one command or one query, and formats the response"; the current handler reads the query directly at `src/http/server/event/list-event.ts:40` and again through the waiter at `:44-47`). Repair path under the review-blocker exception — one focused test, no planned coverage changed.

**Handoff verification gate.**

- Last SE turn claim (Story 1 docs): typecheck exit 0, prettier clean. Independently re-verified at turn open: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.

**Test written.**

- file: `src/http/server/event/list-event.test.ts` (edited) — suite: `src/http/server/event/list-event.test` — method: `each request invokes the query once, and every held read belongs to that delegation`
- asserts: across one lifecycle of each request path — immediate answer (`wait=5`, rows present on the first read), held elapse (`wait=5`, empty log, twenty fake-clock ticks), held delivery (the event appears after three reads) — the request touches the query through exactly one invocation: either the whole lifecycle consumes a single read, or every read of that lifecycle runs inside the request's wait delegation. A recording wrapper marks `waits.wait()` entry; any query read issued before that entry counts as a handler-level read. Purely additive; every existing assertion stays byte-identical.

**RED proof.**

- command: `node --test src/http/server/event/list-event.test.ts`
- exit: non-zero — 35 tests, 34 pass, 1 fail:
  - `✖ each request invokes the query once, and every held read belongs to that delegation` — `AssertionError [ERR_ASSERTION]: the elapsed wait: 1 of 21 query reads ran outside the request's wait delegation` (`1 !== 0`)
- The failing leg is the held elapse: today the handler's direct first read lands outside the delegation and the twenty delegated polls follow it. The held-delivery leg fails identically (1 of 4 reads outside) behind it in document order — same root cause, the same direct call at `list-event.ts:40`; both legs activate with the seam. The immediate-answer leg passes before the fix by construction: one solitary read is legitimate under the rule.
- No TS2307 is possible (no new module); `npm run typecheck` exit 0, prettier clean, eslint exit 0.

**Open to Software Engineer.**

- The seam choice is yours per the routing block; the test pins only the invocation rule — per request lifecycle, exactly one query invocation, or every read inside that request's `waits.wait(...)` delegation — and admits both named options:
  - First read moved into the waiter (`src/http/server/event/wait.ts` + `src/http/server/event/list-event.ts`): the handler hands the query to the registry once and never calls it directly; the waiter performs the initial read itself and answers at once when rows exist or `wait` is absent or zero, without arming a timer. I traced this seam against the whole fake-clock matrix before writing the test: read counts (21 / 4), arm counts and cancel assertions all survive unchanged. One behavioural obligation to note if the immediate path also delegates: a zero-tick wait must still perform the actual first read rather than returning `[]` unread, or the immediate rows case breaks.
  - The query gains the waiter through a service interface per the import matrix (`queries/` may import service interfaces; no vendor packages). Under it the handler invokes the query once per lifecycle and the invariant holds trivially — but the EPIC's binding Proof and hermetic bullets pin the held-path behaviour matrix to this handler suite with fake-schedule ticks, so any coverage relocation is a TE-lane edit: name it in your turn instead of moving tests.
- Test files and `test/helpers/**` stay out of your reach. If your chosen seam strands an existing TE-owned assertion, say so; I repair it next turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker handler-invokes-exactly-one-query · the first read moves inside the delegation

**Review blocker addressed.** BLOCKER: handler-invokes-exactly-one-query — `src/http/server/event/list-event.ts` calls `listEvents` directly (line 40) and again through the waiter (line 45); restructure so the whole request lifecycle (immediate answer, held elapse, held delivery) flows through exactly one query invocation, pinned by a failing regression test that counts query invocations across all three paths before the SE touches production code.

**Cycle.** GREEN for `src/http/server/event/list-event.test.ts` (RED: `the elapsed wait: 1 of 21 query reads ran outside the request's wait delegation`; the delivered leg fails identically behind it).

**Files changed.**

- `src/http/server/event/wait.ts` (edited) — `WaitInput<T>` gains one optional last member `readAtStart?: boolean`; `wait()` gains one guarded block before the existing `totalTicks <= 0` early return: when the flag is set it performs `input.read()` once immediately — rows resolve the promise at once with nothing registered and no timer, a throw rejects it, an empty result falls through to the unchanged registration/poll path.
- `src/http/server/event/list-event.ts` (edited) — the direct `listEvents(filters)` pre-read and its three-way branch are deleted; every request path is now exactly one statement: `await dependencies.waits.wait({ read: () => dependencies.listEvents(filters), waitSeconds: wait ?? 0, readAtStart: true })`, formatted by the shared `formatEvents`.

**Seam (GREEN).** The handler touches the query through exactly one invocation chain per lifecycle — the delegation entered before any read can run, because the registry itself performs the start read when `readAtStart` is set: absent/zero waits resolve from that single start read (`waitSeconds: 0` arms nothing), a non-empty start read answers immediately with no timer, and a held request consumes its start read plus twenty polls inside the same delegation (21 reads elapsed, 4 delivered), so the recording wrapper sees `readsOutsideDelegation === 0` on every leg.

**Refactor.** None named by the routing block; nothing deferred.

**Build check.**

- typecheck: exit 0
- prettier: clean on both files
- eslint: exit 0 on both files

**Assumptions.**

- VERIFIED: `list-event.ts:44` was the only production caller of `waits.wait` (grep over `src/**`), so the optional member changes no other consumer; the TE-owned pass-through wrapper forwards `input` verbatim and stays type-correct with zero test-file edits.
- VERIFIED: the default path is byte-equivalent — the new block is skipped entirely without the flag, so Story 4's locked contract ("the promise is returned before any tick runs", zero-wait performs no read, first read lands on the first tick) keeps all 19 waiter assertions green untouched. An unconditional initial read would have stranded ~9 of them and rewritten a closed story's delivered seam; the query-gains-the-waiter service-interface option would relocate Proof-pinned coverage into TE-lane files. The flag is the smallest correct seam between the two named options.
- VERIFIED (traced against the fake-clock matrix): immediate rows answer with `calls === 1` and `armed.length === 0`; elapse reads exactly 21 with registration signalled before answering; delivery on the third poll keeps `calls === 4`, `armed.length === 3`, `armed[2].cancelCalls === 1`; cursor/order reach every poll input unchanged including the start read; the maxWait refusal still precedes the first read (`calls === 0`); `wait=1` against maximum 0 refuses while `wait=0` answers; concurrency holds two independent registrations; `cancelWaits` resolves empty with `clock.now() === 0`.
- UNVERIFIED: no tests executed this turn (test execution is the TE's gate); green is claimed on typecheck/lint/format plus the traces above.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirm GREEN for the routed review blocker `handler-invokes-exactly-one-query` — closed by the SE's `readAtStart` start-read inside the wait delegation — then both parts of the EPIC Verification Gate re-executed this turn after the fix landed. All six Stories remain green and ready for re-review.

**Handoff verification gate.**

- SE claim (last turn): typecheck exit 0, prettier clean, eslint exit 0 on `src/http/server/event/wait.ts` + `src/http/server/event/list-event.ts`; no tests executed (the TE's gate). Independently re-verified at turn open: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- Working-tree footprint audited against the SE's files-changed list: exactly those two production files changed since the prior ready-for-review snapshot; no test file touched this cycle since my regression RED.

**Blocker confirm-GREEN.**

- command: `node --test src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts`
- exit 0 — 54 tests, 54 pass, 0 fail. The regression test `each request invokes the query once, and every held read belongs to that delegation` passes on all three lifecycle legs: every read of a request now runs inside its one `waits.wait(...)` delegation (`readsOutsideDelegation === 0`), because the registry itself performs the start read under `readAtStart`. Story 4's locked waiter contract keeps all 19 of its assertions green untouched — the flag defaults off, so the zero-tick/no-read semantics are byte-equivalent.
- The handler branch the blocker named is gone from `list-event.ts`; the AGENTS.md rule "a handler parses a request, calls exactly one command or one query, and formats the response" holds for the whole held-request lifecycle. Blocker closed; the two `action:NO` INFO findings remain reserved for the human, untouched.

**EPIC verification gate** — every command executed fresh this turn, exit 0 each:

- Story 2 Verify: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts` → 197/197.
- Story 3 Verify: `node --test src/services/config/convict.test.ts` → 127/127.
- Story 4 Verify: `node --test src/http/server/event/wait.test.ts` → 19/19.
- Story 5 Verify: `node --test src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/app.test.ts src/http/server/start.test.ts src/http/server/dispatch.test.ts src/http/server/shutdown.test.ts src/main.test.ts src/main.event-wait.test.ts` → 139/139.
- Story 6 Verify: `node --test src/http/contract/capability.test.ts src/main.capability.test.ts` → 19/19.
- Story 1 Verify: documentation-only; its checks (`src/http/contract/parity.test.ts`, docs diff, `grep -c phase-2` = 0) are covered by the Gates run below and were inspected in its GREEN turn.
- `typecheck` (via `npm run verify:handoff`) → exit 0, `VERIFY: PASS — npm run typecheck is clean`.
- `Gates:` — `npm run verify` → exit 0; **5103 tests, 5103 pass, 0 fail** (5102 prior + the one review-blocker regression test).

**Proof.**

- command: `node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts && echo "PASS EPIC-028"`
- exit 0 — 246 tests, 246 pass, 0 fail; success string printed verbatim: `"PASS EPIC-028"`

**Tasks closed.** 6 across 6 Stories — `01-the-proposal-records-the-wait` (GREEN-only, docs), `02-the-contract-declares-the-wait` (closed under the human-routed `/debate` amendment of D1), `03-the-configuration-bounds-the-wait`, `04-the-waiter-polls`, `05-the-handler-and-the-lifecycle`, `06-the-capability-names-the-wait` — plus the routed review blocker `handler-invokes-exactly-one-query` repaired and confirmed green. No Story outstanding; this turn edited no file at all — confirmation and gates only.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts) — "PASS EPIC-028"
- stories: 6/6 complete
- date: 2026-08-22
- state: local-uncommitted

END: TEST-ENGINEER

## ORCHESTRATOR — human review round 2

Operator verdict received in session: five findings routed for fix. B1 (formal plan amendment of D1/Story 02) stays reserved to the operator and is NOT re-routed. As the operator directs fix of S1, whose contract block sits in locked Story 4, the supersession below plays the same role as the debate-routed D1 amendment: engineers implement to it; the operator commits matching plan text later.

HUMAN_REVIEW: FAIL — operator directs all five findings fixed.
BLOCKER: s1-vestigial-readAtStart-flag - status:OPEN - action:YES - `src/http/server/event/wait.ts:8,43-53` carries `readAtStart?: boolean`; its only production caller (`list-event.ts:43`) always passes true, so the absent-flag branch is unreachable in production, and Story 4 line 41's rationale ("never calls read() before the first tick, because the caller already did the first read") was made false by the routed one-query fix. Supersession (operator-directed): the start read becomes UNCONDITIONAL, the `readAtStart` member is DELETED from the public contract, and Story 4's "Exact public contract" block plus its ~5 affected assertions are superseded accordingly. fix:test-engineer rewrites the waiter suite to the post-flag signature expecting start reads, software-engineer collapses the seam.
BLOCKER: s2-delivering-case-misses-data-version - status:OPEN - action:YES - `src/main.event-wait.test.ts:241-248` asserts row prefix/tail accounting only; `dataVersion()` is never read in the delivering case, so a stray write to any other table goes undetected, while EPIC lines 198-199 require contents plus `PRAGMA data_version` after "one that returns an event" (Test A at :186-187 already does both). fix:snapshot `dataVersion(database)` immediately after the seed POST returns (:229) and compare after the held answer (:232).
BLOCKER: s3-start-read-rejection-untested - status:OPEN - action:YES - the start-read catch-to-rejection path has zero coverage: `wait.test.ts` never names `readAtStart`, `list-event.test.ts` never makes the query throw; Story 4 line 52 pins "A throw from read() becomes a rejection of that one wait's promise" for the tick path only. fix:against the post-S1 signature, pin that a throwing start read rejects that one wait's promise, arms nothing, and leaves the registry usable.
BLOCKER: s4-delivered-case-flake-budget - status:OPEN - action:YES - `src/main.event-wait.test.ts:213-239` must land the seed POST inside a 1000 ms daemon budget (`maxWait: 1` = 4 ticks; observed 269 ms, ~730 ms slack); a loaded runner stalls it past the fourth tick and fails `assert.ok(delivered.length > 0)` with no diagnostic. fix:raise that describe's `event: { maxWait: 5 }`; Test A keeps 1 for the elapse — the assertion is ordering and content, not duration.
BLOCKER: s5-waits-step-cancel-not-asserted - status:OPEN - action:YES - EPIC lines 205-206 require "cancelWaits is called before listener.close(), asserted through a recording fake that captures the call order"; what ships proves only synthetic array iteration plus a source-text indexOf order, and nothing asserts the production waits step's run invokes `cancelWaits` (only the excluded timing bound at `main.event-wait.test.ts:351`). fix:extract the step array into an exported factory that `main.ts` and the test both call, and assert the recording fake captures the real `cancelWaits` invocation before listener close.

## TEST-ENGINEER — review blockers s1–s5 · test-lane RED

**Cycle.** RED for all five routed blockers of human review round 2 — s1 (waiter suite rewritten to the post-flag signature), s2 (data_version in the delivering case), s3 (start-read rejection mirror), s4 (delivered-case flake budget), s5 (the production waits step asserted through a recording fake over the real step array).

**Handoff verification gate.**

- Last SE turn claim (Story 1 docs turn): typecheck exit 0, prettier clean. Independently re-verified this turn: `npm run verify:handoff` → `VERIFY: FAIL — npm run typecheck exited 2`, naming exactly one error — the intentional RED below (`TS2724 createShutdownSteps` at `src/http/server/shutdown.test.ts:4`, a TE-owned file) — and no error in any production file, so the SE-side claim stands; the failure is my own lane's blocker by design.

**Test written.**

- file: `src/http/server/event/wait.test.ts` (edited — rewritten to the post-flag signature) — suite: `src/http/server/event/wait.test` — 21 methods, every `wait(...)` call omits `readAtStart` while expecting start-read behaviour: `POLL_INTERVAL_MS is 250`, `a zero second wait performs the start read, resolves empty and schedules nothing`, `the start read runs at once and no tick runs before the interval`, `the first tick is due at the interval, not before it`, `a first read that returns rows resolves at once and arms no timer`, `a match on the first poll tick resolves with those rows and arms nothing further`, `a match cancels its outstanding timer exactly once`, `a match on the third tick resolves with those rows after the start read and three polls`, `a five second wait with no events elapses empty after the start read and exactly twenty polls`, `no poll runs after the terminal one`, `a one second wait is four polls after the start read`, the five unchanged `cancelAll`/leak tests, `a throwing start read rejects that one wait's promise, arms nothing and leaves the registry usable` (s3), `a throwing poll read rejects that one wait and cleans up its timer` (replaces the old tick-throw test; the read now throws on the first poll, not the start), `two waits advance together and stay independent`, `the waiter source names no wall-clock function`. A new `assertSettled` helper races settle-vs-sentinel so a start-read resolution or rejection is observed without ever awaiting a promise that cannot settle under today's flag-off production — every RED fails fast instead of hanging.
- file: `src/main.event-wait.test.ts` (edited) — s2: `const versionAfterSeed = dataVersion(database)` snapshotted immediately after the seed POST returns and `assert.equal(dataVersion(database), versionAfterSeed)` after the held answer, beside the existing row-prefix/tail accounting; s4: that describe's config raises `event: { maxWait: 1 }` → `{ maxWait: 5 }`; Test A keeps `wait=1` for its elapse.
- file: `src/http/server/shutdown.test.ts` (edited) — s5: new method `the production steps run cancelWaits before listener close through the shared factory` — recording fakes (`cancelWaits`, `listening.close`, `storage.close`, `held.release`) are passed to the imported factory, the returned array's step names are deep-equalled to `["waits", "listener", "storage", "home-lock"]`, and the array runs through the real `createShutdown`: the recorded order must be exactly `cancelWaits`, `listener.close`, `storage.close`, `held.release`, settling 0 with only the stopped line.
- file: `src/main.test.ts` (edited) — s5 wiring pin: replaces `the shutdown steps are declared in the order waits, listener, storage, home-lock` (whose whole premise — inline `name:` literals in main.ts — the routed factory extraction deletes) with `main builds the shutdown steps through the shared factory, not inline`: main.ts must name `createShutdownSteps(` and must no longer carry an inline `name: "waits"`. The order coverage it held moves to the behavioural recording-fake test above.

**RED proof.**

- command: `node --test src/http/server/event/wait.test.ts`
- exit: non-zero — 21 tests, 8 pass, 13 fail, all for the missing unconditional start read:
  - `✖ a zero second wait performs the start read, resolves empty and schedules nothing` — `0 !== 1` (`callCount`, wait.test.ts:79)
  - `✖ the start read runs at once and no tick runs before the interval` — `0 !== 1`
  - `✖ the first tick is due at the interval, not before it` — `0 !== 1` after `advanceBy(249)`
  - `✖ a first read that returns rows resolves at once and arms no timer` — `'sentinel: still pending' !== 'settled'`
  - `✖ a match on the first poll tick resolves with those rows and arms nothing further` — same
  - `✖ a match cancels its outstanding timer exactly once` — same
  - `✖ a match on the third tick resolves with those rows after the start read and three polls` — same
  - `✖ a five second wait with no events elapses empty after the start read and exactly twenty polls` — `20 !== 21` (wait.test.ts:153)
  - `✖ no poll runs after the terminal one` — `20 !== 21`
  - `✖ a one second wait is four polls after the start read` — `4 !== 5`
  - `✖ a throwing start read rejects that one wait's promise, arms nothing and leaves the registry usable` — `'sentinel: still pending' !== 'settled'`
  - `✖ a throwing poll read rejects that one wait and cleans up its timer` — same
  - `✖ two waits advance together and stay independent` — same
- The 13 failures are exactly the start-read expectations; the 8 passes (`POLL_INTERVAL_MS`, the five `cancelAll`/leak structure tests, the source-text ban) are characterizations whose semantics the supersession does not change — their value sits in the failing siblings.
- command: `node --test src/main.event-wait.test.ts`
- exit 0 — 6/6. Intended characterization per the review-blocker exception (s2/s4 close a proof gap; they name no new behaviour): sensitivity by construction — s2's comparator now fails on a write by the GET path to ANY table (`PRAGMA data_version` moves on any committed write), where the old form saw only the `event` table; s4 widens the window to 5 s against the observed 267 ms delivery (was a 1000 ms budget), while `wait=30` above the raised maximum still refuses. Observed durations this run: elapsed 1015 ms, deliver-on-tick 267 ms, shutdown exit 21 ms after SIGTERM.
- command: `node --test src/http/server/shutdown.test.ts`
- exit: non-zero — `SyntaxError: The requested module './shutdown.ts' does not provide an export named 'createShutdownSteps'` (1 test, 1 fail — the file fails to load).
- command: `node --test src/main.test.ts`
- exit: non-zero — 16 tests, 15 pass, 1 fail: `✖ main builds the shutdown steps through the shared factory, not inline` — `AssertionError [ERR_ASSERTION]: main.ts must build the shutdown steps with the shared factory`.
- stub probe: `src/http/server/shutdown.ts` — temporary export appended with exactly the Open-section signature, typecheck re-run exit 0 (so no error in my files was masked), stub deleted before this turn (`git diff` on the file is empty). The probe exposed one latent implicit-any visible only while the import is unresolved (`TS7006` on the `steps.map` parameter), fixed by annotating the parameter with the module's exported `ShutdownStep` type. After removal, typecheck reports exactly the one TS2724 above.

**Open to Software Engineer.**

- s1 — `src/http/server/event/wait.ts`: delete the `readAtStart?: boolean` member from `WaitInput<T>` and drop the flag guard so the start read is unconditional — the read, its resolve-with-rows return and its reject-on-throw keep their current position before the `totalTicks <= 0` early return; the tick formula stays `Math.floor((waitSeconds * 1000) / POLL_INTERVAL_MS)` over the polls after the start read. `src/http/server/event/list-event.ts`: remove the `readAtStart: true` member from the one `waits.wait({...})` call. Nothing else changes.
- s5 — `src/http/server/shutdown.ts`: export exactly
  `createShutdownSteps(dependencies: Readonly<{ cancelWaits: () => void; listening: { close(): Promise<void> }; storage: { close(): void }; held: { release(): void } }>): readonly ShutdownStep[]`,
  returning the four steps named `waits`, `listener`, `storage`, `home-lock` whose runs delegate to the injected members. `src/main.ts`: build the `steps` dependency through that factory instead of the inline array. Both the recording-fake test and the wiring pin fail until both land.
- The s1 collapse strands no TE-owned assertion: the handler suite stays green untouched (`node --test src/http/server/event/list-event.test.ts` → 35/35 this turn), and no helper names the deleted member.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blockers s1+s3+s5 · the start read collapses to unconditional; the shutdown steps move behind a shared factory

**Review blocker addressed.** BLOCKER: s1-vestigial-readAtStart-flag - status:OPEN - action:YES - `src/http/server/event/wait.ts:8,43-53` carries `readAtStart?: boolean`; its only production caller (`list-event.ts:43`) always passes true, so the absent-flag branch is unreachable in production, and Story 4 line 41's rationale ("never calls read() before the first tick, because the caller already did the first read") was made false by the routed one-query fix. Supersession (operator-directed): the start read becomes UNCONDITIONAL, the `readAtStart` member is DELETED from the public contract, and Story 4's "Exact public contract" block plus its ~5 affected assertions are superseded accordingly. fix:test-engineer rewrites the waiter suite to the post-flag signature expecting start reads, software-engineer collapses the seam.

**Review blocker addressed.** BLOCKER: s3-start-read-rejection-untested - status:OPEN - action:YES - the start-read catch-to-rejection path has zero coverage: `wait.test.ts` never names `readAtStart`, `list-event.test.ts` never makes the query throw; Story 4 line 52 pins "A throw from read() becomes a rejection of that one wait's promise" for the tick path only. fix:against the post-S1 signature, pin that a throwing start read rejects that one wait's promise, arms nothing, and leaves the registry usable.

**Review blocker addressed.** BLOCKER: s5-waits-step-cancel-not-asserted - status:OPEN - action:YES - EPIC lines 205-206 require "cancelWaits is called before listener.close(), asserted through a recording fake that captures the call order"; what ships proves only synthetic array iteration plus a source-text indexOf order, and nothing asserts the production waits step's run invokes `cancelWaits` (only the excluded timing bound at `main.event-wait.test.ts:351`). fix:extract the step array into an exported factory that `main.ts` and the test both call, and assert the recording fake captures the real `cancelWaits` invocation before listener close.

(s2 and s4 are TE-lane proof strengthenings with no production surface — no SE work exists for them.)

**Cycle.** GREEN for the production side of the five routed blockers: `src/http/server/event/wait.test.ts` (13 failing start-read assertions), `src/http/server/shutdown.test.ts` (SyntaxError on the missing `createShutdownSteps` export), `src/main.test.ts` (`main builds the shutdown steps through the shared factory, not inline`).

**Files changed.**

- `src/http/server/event/wait.ts` (edited) — `readAtStart?: boolean` deleted from `WaitInput<T>`; the guarded block collapsed so the start read is unconditional in its former position: `input.read()` once → throw rejects via `Promise.reject` → rows resolve at once → an empty result falls through to registration/poll. Still before the `totalTicks <= 0` early return; the tick formula stays `Math.floor((waitSeconds * 1000) / POLL_INTERVAL_MS)` over the polls after the start read.
- `src/http/server/event/list-event.ts` (edited) — the `readAtStart: true` member removed from the one `waits.wait({ read, waitSeconds })` delegation; nothing else in the file changes.
- `src/http/server/shutdown.ts` (edited) — new export `createShutdownSteps(dependencies: Readonly<{ cancelWaits: () => void; listening: { close(): Promise<void> }; storage: { close(): void }; held: { release(): void } }>): readonly ShutdownStep[]`, returning the four steps named `waits`, `listener`, `storage`, `home-lock` whose runs delegate to the injected members; the existing `ShutdownStep`/`ShutdownDependencies` types and `createShutdown` stay byte-identical.
- `src/main.ts` (edited) — the `./http/server/shutdown.ts` import gains `createShutdownSteps`; the inline four-object `steps` array becomes `steps: createShutdownSteps({ cancelWaits, listening, storage, held })` — identical closure targets, identical order, `write`/`onSettled` untouched. `name: "waits"` no longer appears anywhere in the file.

**Seam (GREEN).** Every `wait()` call performs the start read itself before anything is registered or armed — so the zero-tick case answers from that one real read with nothing scheduled, rows on the start read resolve immediately with no timer, a throwing start read rejects that one promise leaving the registry usable, and every later poll runs inside the same delegation — while `createShutdownSteps` makes the production `waits` step's run literally `dependencies.cancelWaits()`, so the recording-fake test observes the real invocation order over the real step array instead of an inline copy.

**Refactor.** The extraction named by s5 is itself the refactor; applied together with GREEN in one coherent seam collapse per the supersession. Nothing deferred.

**Build check.**

- typecheck: exit 0 (resolves the TE's intentional RED `TS2724 createShutdownSteps`)
- prettier: clean on all four files (canonicalised the factory's parameter-type rendering)
- eslint: exit 0 on all four files

**Assumptions.**

- VERIFIED: the dispatch paraphrase placed the factory "in `src/main.ts`"; the authority chain overrides it — the TEST-ENGINEER Open section exports it from `src/http/server/shutdown.ts` and the RED SyntaxError names that module (`does not provide an export named 'createShutdownSteps'`), while the wiring pin requires only that `main.ts` consume the factory and drop the inline `name: "waits"`. Implemented exactly per the discussion file.
- VERIFIED (traced against the rewritten suite, no tests executed — the TE's gate): all 13 RED assertions flip — zero-tick start read gives `callCount 1`/`armed 0`; unregistered start read gives `callCount 1`/`armed 1` with `dueAt 250`; start-read rows settle at once with `armed 0`; third-tick match keeps `calls 4`/`armed 3`; five-second elapse keeps 21 reads over 20 armed timers; one second keeps 5 reads over 4 timers; the throwing start read rejects with `armed 0` and a following wait still resolves `["x"]`; the two-waits independence holds (matching settles on tick 1, quiet re-arms, `callCount 2`). The eight passing characterizations keep their semantics (no wall-clock names added; `cancelAll` paths untouched).
- VERIFIED: handler-suite behaviour is byte-equivalent — the flag-on production path this replaces produced the identical read sequence (start read + polls inside one delegation), so the 35 list-event assertions including the one-query regression hold without test edits; `noopWaits()` and the pass-through wrapper name no deleted member.
- VERIFIED: `list-event.ts` remains the only production caller of `waits.wait` (grep over `src/**`), so the public-contract change strands no other consumer.
- VERIFIED: this turn's working-tree delta is exactly the four files above; the modified `.agents/plan/` entries in `git status` are the operator's own amendment commit-in-progress, untouched by this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blockers s1+s3+s5 · confirm-GREEN after a lane repair · implementation ready for re-review

**Cycle.** Confirm GREEN for the routed blockers s1 (unconditional start read), s3 (start-read rejection) and s5 (`createShutdownSteps` factory) — the first confirm run found 7 reds; root cause was a defect in my own observation helper, repaired in my lane this turn; then both parts of the EPIC Verification Gate re-executed. All six Stories plus all five round-2 blockers are green and ready for re-review.

**Handoff verification gate.**

- SE claim (last turn): typecheck exit 0 on the four production files, prettier/eslint clean, no tests executed (the TE's gate). Independently re-verified at turn open: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; re-run again after my repair below: PASS.
- Working-tree footprint audited: the SE's delta is exactly `src/http/server/event/wait.ts`, `src/http/server/event/list-event.ts`, `src/http/server/shutdown.ts`, `src/main.ts`; the `.agents/plan/` modifications are the operator's own amendment work, untouched by either role.

**Confirm-GREEN first run — 7 reds, all mine.**

- command: `node --test src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/main.test.ts`
- exit: non-zero — 47 tests, 40 pass, 7 fail. shutdown.test.ts and main.test.ts pass in full (the factory export and the wiring pin are green); every failure is in wait.test.ts at my `assertSettled` helper: `'sentinel: still pending' !== 'settled'` — including tests where the awaited value right after proves the promise settled.

**Lane repair (my file — a defective helper, not a seam defect).**

- Diagnosis probed standalone on the current runtime before editing: `Promise.race([settledPromise.then(...), Promise.resolve(PENDING)])` returns the sentinel even when the observed promise is already fulfilled or rejected — the sentinel's reaction job resolves the race before the probe's fulfilment propagates through job order. So the race-based `assertSettled` could never report settled for any promise that settles inside the drain window, and the same-shaped `assertPending` could never fail: the former produced all 7 false reds, the latter was vacuous. The production seam needed no edit.
- file: `src/http/server/event/wait.test.ts` (edited) — helpers replaced: one `observeSettled` observer (a `.then` flag setter followed by a bounded 4-turn microtask drain), `assertSettled` asserting `true`, `assertPending` asserting `false` — now genuinely falsifiable in both directions; the unused `PENDING` sentinel constant removed; zero test-method changes.
- Sensitivity re-probed on the current runtime with the shipped form: already-resolved → true, already-rejected → true, settles-mid-drain → true, never-settles → false (so a regressed waiter still fails fast instead of hanging).
- Post-repair: `node --test src/http/server/event/wait.test.ts` → 21/21; prettier clean; eslint clean (also under `npm run verify`'s repo-wide `eslint .`). All seven formerly-failing assertions pass against the SE's unchanged production files — the unconditional start read, its reject-on-throw and the shared factory behave exactly as the SE traced.
- Neighbours re-run together: `node --test src/http/server/event/list-event.test.ts src/main.event-wait.test.ts` → 41/41 (the one-query regression and both s2/s4 held-call proofs included).

**EPIC verification gate** — every command executed fresh this turn, exit 0 each:

- Story 2 Verify: `node --test src/http/contract/event.test.ts src/http/contract/cursor.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/coverage.test.ts src/http/contract/registry.test.ts src/http/server/event/list-event.test.ts` → 197/197.
- Story 3 Verify: `node --test src/services/config/convict.test.ts` → 127/127.
- Story 4 Verify: `node --test src/http/server/event/wait.test.ts` → 21/21.
- Story 5 Verify: `node --test src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/app.test.ts src/http/server/start.test.ts src/http/server/dispatch.test.ts src/http/server/shutdown.test.ts src/main.test.ts src/main.event-wait.test.ts` → 142/142.
- Story 6 Verify: `node --test src/http/contract/capability.test.ts src/main.capability.test.ts` → 19/19.
- Story 1 Verify: documentation-only; its checks (`src/http/contract/parity.test.ts`, docs diff, `grep -c phase-2` = 0) are covered by the Gates run below and were inspected in its GREEN turn.
- `typecheck` (via `npm run verify:handoff`) → exit 0, `VERIFY: PASS — npm run typecheck is clean`.
- `Gates:` — `npm run verify` → exit 0; **5106 tests, 5106 pass, 0 fail**.

**Proof.**

- command: `node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts && echo "PASS EPIC-028"`
- exit 0 — 249 tests, 249 pass, 0 fail; success string printed verbatim: `"PASS EPIC-028"`

**Tasks closed.** 6 across 6 Stories — `01-the-proposal-records-the-wait` (GREEN-only, docs), `02-the-contract-declares-the-wait` (closed under the human-routed `/debate` amendment of D1), `03-the-configuration-bounds-the-wait`, `04-the-waiter-polls`, `05-the-handler-and-the-lifecycle`, `06-the-capability-names-the-wait` — plus all five round-2 review blockers (s1–s5) implemented and confirmed green. No Story outstanding; this turn edited exactly one TE-owned file (`src/http/server/event/wait.test.ts`, helpers only).

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/event.test.ts src/http/contract/example.test.ts src/http/contract/capability.test.ts src/http/server/event/list-event.test.ts src/http/server/event/wait.test.ts src/http/server/shutdown.test.ts src/services/config/convict.test.ts src/main.event-wait.test.ts) — "PASS EPIC-028"
- stories: 6/6 complete
- date: 2026-08-22
- state: local-uncommitted

END: TEST-ENGINEER

## ORCHESTRATOR — human review round 3

Operator verdict received in session: accept. Cycle-3 review held zero blockers and zero suggestions; all five round-2 findings verified fixed.

HUMAN_REVIEW: PASS
