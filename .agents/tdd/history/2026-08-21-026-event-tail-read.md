---
epic: .agents/plan/epics/026-event-tail-read.md
opened: 2026-08-21
opener: test-engineer
base-ref: 1d7ca4edf1fd2afae7410ef545344a7fe9dea7f0
---

# Implementation cycle — 026-event-tail-read

Pulled from EPIC: `.agents/plan/epics/026-event-tail-read.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test src/http/contract/cursor.test.ts \
>   src/http/contract/event.test.ts \
>   src/http/contract/coverage.test.ts \
>   src/http/contract/example.test.ts \
>   src/http/contract/openapi.test.ts \
>   src/services/event/sqlite.test.ts \
>   src/queries/event/list-event.test.ts \
>   src/http/server/event/list-event.test.ts \
>   src/cli/event/list.test.ts && echo "PASS EPIC-026"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> **The event tail**
>
> - `event.list` with no `order` returns exactly the page it returns on the pre-epic tree, for a log of ten events and a `limit` of three: the three oldest, in ascending id order. This is the D2 compatibility claim and it is the assertion that must pass unchanged.
> - `order=desc` with `limit=3` over the same ten events returns the three **newest**, in descending id order. The first id equals the newest id in the log, which is what D3 relies on.
> - `before=<the fifth id>` with the default order returns the four oldest and not the fifth. Exclusive, asserted by the absence of the boundary row.
> - `after=<the third id>&before=<the seventh id>` returns exactly the fourth, fifth and sixth. Both bounds exclusive, in one assertion.
> - `after=<the seventh id>&before=<the third id>` returns `200` with an empty array, and so does `after` equal to `before`. No refusal, per D2.
> - `order=desc` combined with `subjectKind`, `subject`, `type`, `actorKind` and `actor` returns the newest matching rows only, so the direction composes with every filter rather than replacing them.
> - `order=sideways` is `400 invalid-request` through the real app, and the body carries no `details`.
> - `cursorRequest.parse({})` returns `{ order: "asc", limit: 100 }`, and the emitted `event.list.query` carries `order` with `required=false` and `enum=asc,desc`. The default is in the schema, not in the query layer.
> - `SqliteEventLog.list` with `order` absent emits `ORDER BY id ASC`, asserted through the returned order over a log whose insert order and id order differ.
> - `kanthord event list --order desc --before <id>` sends both as query members, asserted against the recorded request of the CLI's fake client, and `--order sideways` fails with the daemon's refusal and not with a client-side check.
> - A publish into a temporary directory carries `before` and `order` in `features/event.yaml`:
>
> ```bash
> node scripts/publish-contract.ts "$(mktemp -d)"
> ```

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** RED for Task `01-event-list-reads-the-tail` (`src/http/contract/cursor.test.ts`, `src/http/contract/event.test.ts`, `src/services/event/sqlite.test.ts`, `src/queries/event/list-event.test.ts`, `src/http/server/event/list-event.test.ts`, `src/http/contract/openapi.test.ts`).
**Test written.**

- file: `src/http/contract/cursor.test.ts` (edited) — suite: `src/http/contract/cursor.test` — methods: `defaults order to asc and limit to 100 on an empty request`, `parses desc order`, `throws on an unknown order`, `throws on an empty order`, `omits before when absent`, `keeps before when present`, `throws on an empty before`, `carries both exclusive bounds`
- file: `src/http/contract/event.test.ts` (edited) — suite: `src/http/contract/event.test` — methods: `carries limit and order on an empty request`, `carries every filter when every filter is sent`, `defaults order to asc`, `parses desc order`, `rejects an unknown order`, `rejects an empty before`, `carries both cursor bounds`, `the query example names order`
- file: `src/services/event/sqlite.test.ts` (edited) — suite: `src/services/event/sqlite.test` — methods: `the default order returns the three oldest ids`, `desc order returns the three newest ids with the newest first`, `before excludes the fifth id`, `after and before select the open range`, `inverted and equal bounds return empty arrays`, `both directions return all ten ids in their selected order`, `desc order composes with every event filter`, `an absent order lists by id ascending when insert order differs`
- file: `src/queries/event/list-event.test.ts` (edited) — suite: `src/queries/event/list-event.test` — methods: `forwards every field byte for byte`, `forwards an explicit order without adding a default`
- file: `src/http/server/event/list-event.test.ts` (edited) — suite: `src/http/server/event/list-event.test` — methods: `no query calls listEvents with exactly the default limit`, `every filter reaches listEvents with limit as a number`, `forwards order, before, after and limit to listEvents`, `rejects sideways order with no error details`, `rejects an empty before`, `answers an inverted range with an empty events array`
- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi.test` — method: `renders event.list query parameters in bytewise name order with no request body`
- asserts: cursor defaults and validation, exclusive range forwarding, ascending compatibility, descending tail pages, all event filters, invalid requests, OpenAPI query parameters, and the published query example.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ defaults order to asc and limit to 100 on an empty request (0.923584ms)`
- typecheck: `npm run typecheck` reports 14 expected missing `before` and `order` properties; no `TS2307` seam requires a stub probe.
  **Open to Software Engineer.**
- `src/http/contract/cursor.ts`: exported `cursorRequest` parses optional `after` and `before`, defaults `order` to `"asc"`, accepts only `"asc"` or `"desc"`, and keeps `limit` behavior.
- `src/http/contract/event.ts`: exported `eventListRequest` carries the cursor fields, and `eventListExamples.query` carries `order: "asc"`.
- `src/services/event/index.ts`: exported `EventFilter` accepts optional `before` and `order` fields while `EventLog.list` remains callable through its existing signature.
- `src/services/event/sqlite.ts`: exported `SqliteEventLog.list` returns exclusive range pages in the requested direction, with ascending behavior when `order` is absent and all filters preserved.
- `src/queries/event/list-event.ts`: exported `ListEventInput` accepts optional `before` and `order`; exported `listEvents` forwards them without adding defaults.
- `src/http/contract/field-decisions.fixture.ts`: the generated event query field records include `before` and `order`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** GREEN+REFACTOR for `src/http/contract/cursor.test.ts` and the Task 01 RED suite.
**Files changed.**

- `src/http/contract/cursor.ts` (edited) — `cursorRequest` adds exclusive-bound and direction fields.
- `src/http/contract/event.ts` (edited) — `eventListExamples.query` names the default order.
- `src/services/event/index.ts` (edited) — `EventFilter` accepts tail bounds and direction.
- `src/services/event/sqlite.ts` (edited) — `SqliteEventLog.list` applies the upper bound and selected ordering.
- `src/queries/event/list-event.ts` (edited) — `ListEventInput` carries tail bounds and direction.
- `src/http/contract/field-decisions.fixture.ts` (edited) — generated contract rows include `before` and `order`.
  **Seam (GREEN).** The schema defaults `order` to `asc`, and the query passes both bounds and direction to SQLite unchanged.
  **Refactor.** No named refactor was specified; the implementation remains surgical.
  **Build check.**
- typecheck: exit 0
- field-decisions probe: `fixture in sync: 642 rows`
  **Assumptions.**
- VERIFIED: the generated fixture contains only the two requested event query rows; `node scripts/field-decisions-probe.mjs` confirms sync.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** Confirm GREEN for Task `01-event-list-reads-the-tail`; blocked.
**Handoff verification.**

- command: `npm run verify:handoff`
- output: `VERIFY: PASS — npm run typecheck is clean`
  **GREEN proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ every z.enum argument in src/http/contract/ traces to a domain/ import, and no restated literal or blob-hash pattern exists (2.875709ms)`
- detail: `AssertionError [ERR_ASSERTION]: cursor.ts declares an inline z.enum([...]) literal instead of importing a domain/ array`
  **Open.**
- `OPEN: Task 01 — Story 1 requires the inline enum in src/http/contract/cursor.ts, while the existing contract coverage assertion rejects inline enums; human decision required.`
- No Story 2 task opened. Test ownership remains with the Test Engineer.

ATTEMPT-FAILED: 01-event-list-reads-the-tail — still red after GREEN: cursor.ts declares an inline z.enum([...]) literal instead of importing a domain/ array

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** Blocked GREEN for Task `01-event-list-reads-the-tail` after TEST-ENGINEER confirmation.
**Files changed.**

- None.
  **Seam (GREEN).** No production edit can satisfy both the exact Story 1 schema and the existing coverage assertion.
  **Refactor.** Deferred: human decision required on the contradictory enum requirements.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- OPEN: Story 1 requires inline `z.enum(["asc", "desc"])` in `cursor.ts`, while `coverage.test.ts` rejects every inline `z.enum([...])`; importing a domain array changes the mandated seam or exceeds the listed production inputs.

ATTEMPT-FAILED: 01-event-list-reads-the-tail — Story 1 and contract coverage require contradictory enum declarations

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — event.list reads the tail · Task 01 remains blocked

**Cycle.** Blocked — no next Task can open after Task `01-event-list-reads-the-tail`.
**Handoff verification.**

- command: `npm run verify:handoff`
- output: `VERIFY: PASS — npm run typecheck is clean`
  **Open.**
- `OPEN: Task 01 — Story 1 requires the exact inline z.enum(["asc", "desc"]) in src/http/contract/cursor.ts, while the existing contract coverage assertion rejects every inline z.enum([...]) declaration.`
  **Action required.**
- Human decision: choose whether the Story's exact schema or the existing contract coverage invariant controls; no production or test change is authorized until that conflict is resolved.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** Blocked GREEN for `01-event-list-reads-the-tail` after TEST-ENGINEER confirmation.
**Files changed.**

- None.
  **Seam (GREEN).** No production edit can satisfy both the exact Story 1 schema and the existing coverage assertion.
  **Refactor.** Deferred: human decision required on the contradictory enum requirements.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- OPEN: Story 1 mandates exact inline `z.enum(["asc", "desc"])`, while `coverage.test.ts` rejects every inline `z.enum([...])`; human decision is required.

ATTEMPT-FAILED: 01-event-list-reads-the-tail — Story 1 and contract coverage require contradictory enum declarations

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** RED for Task `01-event-list-reads-the-tail` (`src/http/contract/coverage.test.ts`).
**Test written.**

- file: `src/http/contract/coverage.test.ts` (retained) — suite: `src/http/contract/coverage.test` — method: `every z.enum argument in src/http/contract/ traces to a domain/ import, and no restated literal or blob-hash pattern exists`
- asserts: Contract enum values trace to domain-owned arrays while `cursorRequest` keeps the observable `order` schema and default.
  **RED proof.**
- handoff: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`
- command: `npm test`
- exit: non-zero — failure: `✖ every z.enum argument in src/http/contract/ traces to a domain/ import, and no restated literal or blob-hash pattern exists (2.223292ms)`
  **Open to Software Engineer.**
- `src/http/contract/cursor.ts`: exported `cursorRequest` preserves `{ order: "asc", limit: 100 }`, accepts `"desc"`, rejects other order values, and makes its order enum trace to a domain-owned array so the existing contract invariant passes.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event.list reads the tail · 01-event-list-reads-the-tail

**Cycle.** GREEN+REFACTOR for `src/http/contract/coverage.test.ts` and Task 01 RED suite.
**Files changed.**

- `src/domain/cursor.ts` (new) — `cursorOrders`.
- `src/http/contract/cursor.ts` (edited) — `cursorRequest` uses domain-owned order values.
  **Seam (GREEN).** `cursorRequest` preserves `{ order: "asc", limit: 100 }` and enum values while tracing `order` to domain-owned `cursorOrders`.
  **Refactor.** Applied the resolved enum extraction; no additional named refactor was specified.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `cursorOrders` is pure domain data, and `cursor.ts` imports it with the explicit `.ts` extension.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — The CLI reaches the tail · 02-the-cli-reaches-the-tail

**Cycle.** RED for Task `02-the-cli-reaches-the-tail` (`src/cli/event/list.test.ts`).
**Test written.**

- file: `src/cli/event/list.test.ts` (edited) — suite: `src/cli/event/list.test` — methods: `sends every supplied option on the query`, `sends tail options without a body or path parameters`, `leaves call options undefined when neither tail flag is supplied`, `passes an unvalidated order value to the daemon`, `reports the daemon refusal for an invalid order`
- asserts: `event list` forwards `before` and `order`, preserves absent call fields, passes arbitrary order values to the daemon, and reports its refusal.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ sends every supplied option on the query (2.649708ms)`
- detail: `Error [CommanderError]: error: unknown option '--before'`
- typecheck: `npm run typecheck` — exit 0; no `TS2307` seam requires a stub probe.
  **Open to Software Engineer.**
- `src/cli/event/list.ts`: exported `registerEventList(input: RegisterEventListCliInput): void` accepts the two event-list flags and forwards their values through the existing `DaemonClient.call` seam without client-side validation.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — The CLI reaches the tail · 02-the-cli-reaches-the-tail

**Cycle.** GREEN+REFACTOR for `src/cli/event/list.test.ts` and Task `02-the-cli-reaches-the-tail`.
**Files changed.**

- `src/cli/event/list.ts` (edited) — `EventListOptions`, Commander flags and query forwarding.
  **Seam (GREEN).** The CLI forwards `before` and unvalidated `order` values through the existing daemon client query seam.
  **Refactor.** No named refactor was specified; the implementation remains surgical.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `order` remains a string so the daemon validates it, as required by Story 2.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — The proposal records the tail · GREEN-only Task

**Cycle.** Confirmed GREEN for Task `02-the-cli-reaches-the-tail`; GREEN-ONLY pass-through for Task `03-the-proposal-records-the-tail`.
**Confirm GREEN (Task 02).**

- handoff: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- command: `npm test` → exit 0 — `ℹ tests 4986`, `ℹ pass 4986`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`
  **Story file.** `.agents/plan/stories/026-event-tail-read/03-the-proposal-records-the-tail.md`
  **Task status.**
- `03-the-proposal-records-the-tail`: GREEN-only documentation task; human lane required.
  **No RED phase.** Coverage is owned by the Story Verify section.
  **Tasks forwarded to Software Engineer.**
- None — the Story names only documentation paths outside the software-engineer lane.
  **Open to Software Engineer.**
- None. No allowed software-engineer-lane path exists for this Task.
  **Open to Human.**
- `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md`: apply the Story's exact proposal text and formatting.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — The proposal records the tail · 03-the-proposal-records-the-tail

**Cycle.** GREEN-ONLY implementation for Task `03-the-proposal-records-the-tail`.
**Files changed.**

- None — the Story permits only documentation paths outside the software-engineer lane.
  **Seam (GREEN).** No production seam exists because this Task changes only proposal documentation.
  **Refactor.** Not applicable.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- OPEN: `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md` require the human lane; no allowed production or script input exists.

ATTEMPT-FAILED: 03-the-proposal-records-the-tail — documentation-only inputs are outside the software-engineer lane

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — The proposal records the tail · 03-the-proposal-records-the-tail

**Cycle.** Blocked — GREEN-only Task `03-the-proposal-records-the-tail` remains unimplemented after the software-engineer turn.
**Handoff verification.**

- command: `npm run verify:handoff`
- output: `VERIFY: PASS — npm run typecheck is clean`
  **Build-only check.**
- command: `npm run typecheck`
- exit: 0
  **Task status.**
- Task `03-the-proposal-records-the-tail` remains unimplemented; its inputs are documentation-only paths outside both agent lanes.
  **Open to Software Engineer.**
- None. The Story permits no `src/**/*.ts` or `scripts/**` change.
  **Open to Human.**
- `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md`: apply the Story's exact proposal text and formatting.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — The proposal records the tail · 03-the-proposal-records-the-tail

**Cycle.** GREEN-ONLY implementation for Task `03-the-proposal-records-the-tail`.
**Files changed.**

- None — the Story permits only documentation paths outside the software-engineer lane.
  **Seam (GREEN).** No production seam exists because this Task changes only proposal documentation.
  **Refactor.** Not applicable.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- OPEN: `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md` require the human lane; no allowed production or script input exists.

ATTEMPT-FAILED: 03-the-proposal-records-the-tail — documentation-only inputs remain outside the software-engineer lane

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — The proposal records the tail · 03-the-proposal-records-the-tail

**Cycle.** Blocked — GREEN-only Task `03-the-proposal-records-the-tail` remains unimplemented.
**Handoff verification.**

- command: `npm run verify:handoff`
- output: `VERIFY: PASS — npm run typecheck is clean`
  **Build-only check.**
- command: `npm run typecheck`
- exit: 0
  **Task status.**
- Task `03-the-proposal-records-the-tail` remains unimplemented; it changes only locked proposal documents.
  **Open to Software Engineer.**
- None. The Story permits no `src/**/*.ts` or `scripts/**` change.
  **Open to Human.**
- `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md`: apply the Story's exact proposal text and formatting.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — The proposal records the tail · 03-the-proposal-records-the-tail

**Cycle.** GREEN-ONLY implementation for Task `03-the-proposal-records-the-tail`.
**Files changed.**

- None — the Story permits only proposal documentation paths outside the software-engineer lane.
  **Seam (GREEN).** No production seam exists because this Task changes only proposal documentation.
  **Refactor.** Not applicable.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Task 01 keeps the observable `order` schema and traces its enum to domain-owned data.
- OPEN: `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md` require the human lane.

ATTEMPT-FAILED: 03-the-proposal-records-the-tail — documentation-only inputs remain outside the software-engineer lane

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- `npm run verify` (Gates) → exit 0.
- `typecheck` (`npm run typecheck`) → exit 0.
- `unit` (`npm test`) → exit 0; `ℹ tests 4986`, `ℹ pass 4986`, `ℹ fail 0`.
- Story 3 verification (`node --test src/http/contract/parity.test.ts` plus its documentation assertions) → exit 0.

**Proof.**

- `node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/services/event/sqlite.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/cli/event/list.test.ts && echo "PASS EPIC-026"` → exit 0.
- Exact success string: `PASS EPIC-026`.

**Tasks closed.** 3 across 3 Stories — all Tasks are green.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/services/event/sqlite.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/cli/event/list.test.ts && echo "PASS EPIC-026") — "PASS EPIC-026"
- stories: 3/3 complete
- date: 2026-08-21
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 — Published feature contract lacks the required focused assertion for `features/event.yaml` parameter names, required state, enum, and default.
BLOCKER: B2 — New domain module `src/domain/cursor.ts` lacks the required co-located `src/domain/cursor.test.ts` coverage for `cursorOrders`.

## TEST-ENGINEER — event-tail-read · routed review blockers B1 and B2

**Cycle.** RED regression coverage for routed blockers `B1` and `B2`.
**Test written.**

- file: `scripts/publish-contract.test.ts` (edited) — suite: `scripts/publish-contract` — method: `the published event feature carries the cursor parameters`
- file: `src/domain/cursor.test.ts` (new) — suite: `src/domain/cursor.test` — method: `cursorOrders deep-equals asc and desc in order`
- asserts: The published event feature has the exact nine parameter names, every parameter is optional, and `order` has enum `asc,desc` with default `asc`; the domain cursor vocabulary has exactly `asc` then `desc`.
  **RED proof.**
- command: `npm test`
- exit: 0 — `ℹ tests 4988`, `ℹ pass 4988`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`
- characterization note: Both routed findings cover absent assertions, and the current implementation already satisfies them. The exact assertions are sensitive to publication or vocabulary drift, so no failing assertion line exists without a production defect.
- typecheck: `npm run typecheck` — exit 0; no `TS2307` seam required a stub probe.
  **Open to Software Engineer.**
- `scripts/publish-contract.ts`: exported `publishContract(input: PublishInput): readonly string[]` is the publication seam exercised by the artifact assertion.
- `src/domain/cursor.ts`: exported `cursorOrders` is the domain seam exercised by the co-located vocabulary assertion.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event-tail-read · routed review blockers B1 and B2

**Cycle.** Review-fix verification for routed blockers `B1` and `B2`.
**Files changed.**

- None — focused characterization tests cover both routed findings.
  **Seam (GREEN).** `publishContract` emits the required event parameters, and `cursorOrders` remains domain-owned.
  **Refactor.** None; no speculative production change is required.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the latest TEST-ENGINEER turn reports both focused regression assertions passing.
- VERIFIED: `src/http/contract/cursor.ts` uses `cursorOrders` and has no inline enum.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — event-tail-read · final verification

**Cycle.** Final verification for all three Tasks after the routed blocker fixes.
**Handoff verification.**

- `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
  **Story verification.**
- Story 1 focused suite → exit 0 — `ℹ tests 131`, `ℹ pass 131`, `ℹ fail 0`.
- `node scripts/field-decisions-probe.mjs` → exit 0 — `fixture in sync: 642 rows`.
- Story 1 publish check → exit 2 — `dirty-tree`; the release CLI refused the local-uncommitted tree before writing output.
- Story 2 CLI suite → exit 0 — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.
- Story 3 parity suite → exit 0 — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.
- Story 3 wait-line diff and documentation substring checks passed.
- Story 3 status scope check did not match its clean-documentation expectation because the intended epic changes remain local-uncommitted.
  **Tasks.**
- Task `01-event-list-reads-the-tail`: green, including the focused publication and domain vocabulary assertions.
- Task `02-the-cli-reaches-the-tail`: green.
- Task `03-the-proposal-records-the-tail`: green, with the required documentation changes present.
  **EPIC verification gate.**
- `npm run verify` → exit 0 — `ℹ tests 4988`, `ℹ pass 4988`, `ℹ fail 0`; lint and database status passed.
  **Proof.**
- `node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/services/event/sqlite.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/cli/event/list.test.ts && echo "PASS EPIC-026"` → exit 0.
- Exact success string: `PASS EPIC-026`.
  **Result.** The EPIC gate and Proof pass, but the Story verification set is not fully green. No ready marker is emitted.
  **Open to Human.**
- Re-run the Story 1 publication check and Story 3 status scope check from the required clean release state, then repeat final verification.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — event-tail-read · final verification

**Cycle.** Review-fix verification for the remaining B1 and B2 blockers.
**Files changed.**

- None — no production or test changes.
  **Seam (GREEN).** Isolated clean-tree checks resolve both verification blockers while preserving the current implementation.
  **Refactor.** None; preserved domain-owned `cursorOrders` and no inline contract enum.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: B1 passed in an isolated clean verification tree containing the current implementation; `node scripts/publish-contract.ts <temp-output>` succeeded, and `features/event.yaml` asserted nine parameter names, optional parameters, `order` enum `asc,desc`, and default `asc`.
- VERIFIED: B2 passed in an isolated clean documentation verification tree containing only the two Story 3 edits; unscoped `git status --porcelain` listed only `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md`, and the unchanged-`wait` diff passed.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.
- `typecheck` (`npm run typecheck`) → exit 0 through `npm run verify`.
- `unit` (`npm test`) → exit 0 through `npm run verify` — `ℹ tests 4988`, `ℹ pass 4988`, `ℹ fail 0`.
- `npm run verify` → exit 0 — lint passed and `kanthord: verify db status ok`.

**Independent verification.**

- Story 1 focused suite plus B1/B2 regressions → exit 0 — `ℹ tests 149`, `ℹ pass 149`, `ℹ fail 0`.
- `node scripts/field-decisions-probe.mjs` → exit 0 — `fixture in sync: 642 rows`.
- Isolated clean-tree publication assertion → exit 0 — `PASS features/event.yaml`; nine names, optional parameters, `asc,desc`, and default `asc` matched.
- Story 2 CLI suite → exit 0 — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.
- Story 3 parity → exit 0 — `ℹ tests 11`, `ℹ pass 11`, `ℹ fail 0`.
- Story 3 unchanged-`wait` and content checks → `PASS`.
- Isolated Story 3 status scope → `PASS`; only the two proposal paths were modified.

**Proof.**

- `node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/services/event/sqlite.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/cli/event/list.test.ts && echo "PASS EPIC-026"` → exit 0.
- Exact success string: `PASS EPIC-026`.

**Tasks closed.** 3 across 3 Stories — all Tasks are green.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/http/contract/cursor.test.ts src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/services/event/sqlite.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts src/cli/event/list.test.ts && echo "PASS EPIC-026") — "PASS EPIC-026"
- stories: 3/3 complete
- date: 2026-08-21
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
