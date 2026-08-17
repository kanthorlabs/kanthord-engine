---
epic: .agent/plan/epics/019-outcome-report.md
opened: 2026-08-16
opener: test-engineer
base-ref: 46a7f1c49b057d9e1a25c2013a0d72b4bf4fbbf
---

# Implementation cycle — 019-outcome-report

Pulled from EPIC: `.agent/plan/epics/019-outcome-report.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/outcome-report.test.ts \
>   src/domain/attempt-accounting.test.ts \
>   src/domain/external-transition.test.ts \
>   src/domain/aggregation.test.ts \
>   src/domain/outcome.test.ts \
>   src/domain/event-type.test.ts \
>   src/services/execution/sqlite.test.ts \
>   src/commands/outcome/report-outcome.test.ts \
>   src/commands/outcome/report-objective.test.ts \
>   src/commands/outcome/aggregate-initiative.test.ts \
>   src/commands/outcome/close-objective.test.ts \
>   src/commands/node/unblock-node.test.ts \
>   src/commands/node/claim-node.test.ts \
>   src/queries/node/show-node.test.ts \
>   src/http/contract/path.test.ts \
>   src/http/contract/event-payload.test.ts \
>   src/http/contract/event.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/server/node/report-node.test.ts \
>   src/http/server/node/unblock-node.test.ts \
>   src/cli/node/report.test.ts \
>   src/cli/node/attest.test.ts \
>   src/cli/node/close.test.ts \
>   src/cli/node/unblock.test.ts \
>   src/main.report.test.ts \
>   && echo "PASS EPIC-019"
> ```
>
> Every path is named one by one, and no directory glob stands in for one. `node --test` exits non-zero on a named path that is absent, so the Proof fails before this epic is built rather than collecting a green sibling suite. **Eighteen of these paths do not exist in the repository today.** Three of the eighteen belong to EPIC 014 and EPIC 018, so fifteen remain after 014 to 018 land, and those fifteen are this epic's own. Three of the fifteen are the `node.unblock` paths.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 019-outcome-report · Story 1 proposal amendment (RED)

**Cycle.** RED for Story 1 (`src/http/contract/proposal-amendment-outcome.test.ts`, new). Dispatch order per `index.md:10` starts with `01`; this story carries the `node.report` section, the spend clause at `state-machine.md:118`, and the widened `attempt.md` prose only — the Routes-table row and the header sentence of `outcome.md:5` move to Story 18, and the `node.unblock` row moves in Story 19a.
**Test written.**

- file: `src/http/contract/proposal-amendment-outcome.test.ts` (new) — suite `src/http/contract/proposal-amendment-outcome.test` — methods:
  - `outcome.md gains the node.report section before the one-path section` — `## node.report` heading, its position before `## One path for abandon`, and the one-route sentence;
  - `the node.report section states the four task outcomes and their transitions` — the four names, the `accepted` `running → done` transition, the `ready`-under-limit / `blocked`-at-limit clause, and the `timed-out` refusal;
  - `the node.report section states the lease guard and the owner rule` — the live-lease sentence with `409 lease-held`, and the no-owner-field sentence;
  - `the node.report section states the attestation and the derived close` — the `attested` `running → awaiting_approval` sentence and the derived-close `acknowledgePartial` / `409 acknowledgement-required` sentence;
  - `the node.report section states the initiative refusal and the actor admission` — `400 invalid-request` for an initiative, and the harness/harness/human admission sentence;
  - `state-machine.md line 118 carries the spend clause and drops the rejection-only clause` — the full replacement rule string present, and "Each rejection increments the attempt counter." absent;
  - `attempt.md prose widens the limit clause to any non-null outcome` — the widened sentence present, and the rejected-only clause absent.
- asserts: the three EPIC-019 proposal amendments, whitespace-insensitively, each pinned to the exact Story sentence; the two absence assertions prove the old clauses were replaced and not appended.
  **RED proof.**

- command: `node --test src/http/contract/proposal-amendment-outcome.test.ts`
- exit: 1 — fail 7, pass 0; failures: `AssertionError [ERR_ASSERTION]: missing the node.report section`; `AssertionError [ERR_ASSERTION]: the four task outcomes are absent`; `AssertionError [ERR_ASSERTION]: the lease guard sentence is absent`; `AssertionError [ERR_ASSERTION]: the attestation sentence is absent`; `AssertionError [ERR_ASSERTION]: the initiative refusal is absent`; `AssertionError [ERR_ASSERTION]: the spend clause is not in state-machine.md`; `AssertionError [ERR_ASSERTION]: the widened limit clause is not in attempt.md`.
- stub probe: none needed — the test reads the three proposal docs and `node:` builtins only, and imports no production seam; `npm run typecheck` exits 0.
- baseline: `node --test test/helpers/proposal.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/http/contract/parity.test.ts` — 56 pass, 0 fail. These are the Story-1 Verify gates that must stay green through the amendment.
  **Open to Software Engineer.**

- `docs/proposal/api/outcome.md` — add one new section after the Routes table (line 14) and before `## One path for abandon` at `:16`, titled `## node.report`, one sentence per rule:
  - "One route, and the node kind decides the behaviour." — name the `## One path for abandon` section rather than repeating it.
  - A task report carries one of `accepted`, `rejected`, `failed` and `cancelled`. `accepted` moves the task `running → done` and records the reported object id. `rejected`, `failed` and `cancelled` close the attempt and return the task to `ready` under the attempt limit, and reach `blocked` with reason `attempt-limit` at the limit.
  - `timed-out` is not a reported outcome, because an external attempt carries no timeout budget.
  - A task report requires a live lease on the task: a matching owner, a matching fence and an unexpired row. Every refusal is `409 lease-held`.
  - The authenticated actor is the owner. The request body carries no owner field.
  - An objective report with `attested` carries the combined object id, moves the objective `running → awaiting_approval` and releases the objective lease. The daemon infers no objective result.
  - An objective report with `closed` carries `acknowledgePartial` only. The daemon derives `done` or `partial` from the task states. A derived `partial` with no acknowledgement is `409 acknowledgement-required`.
  - A report on an initiative is `400 invalid-request`.
  - A task report admits a `harness` actor, an attestation admits a `harness` actor, and a close admits a `human` actor.
- `docs/proposal/phase-1/state-machine.md:118` — replace the current rule line "Attempt accounting belongs to the domain. Each rejection increments the attempt counter. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration." with: "Attempt accounting belongs to the domain. The attempt counter is `MAX(attempt_no)` of the active task run. Every closed attempt spends a try, whatever its outcome. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration."
- `docs/proposal/database/attempt.md` — prose only. In the paragraph whose last sentence reads "`attempt_no = attempt_limit` with an `outcome` of `rejected` moves the task to `blocked` with reason `attempt-limit`.", replace that sentence with "`attempt_no = attempt_limit` with any non-null `outcome` moves the task to `blocked` with reason `attempt-limit`." The `sql` fence at `:5-19` does not move one byte.
- Constraints: add no row to the Routes table, do not touch line 5, do not touch the `node.unblock` row and write no `node.unblock` section, add no precondition row to `docs/proposal/api/README.md:98-104`, add nothing to the aggregation table at `state-machine.md:37-41`, move no `sql` fence, renumber and reword no other Routes-table row. Edit no file beyond the three named.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 1 proposal amendment (GREEN)

**Cycle.** GREEN for `src/http/contract/proposal-amendment-outcome.test.ts`.
**Files changed.**

- `docs/proposal/api/outcome.md` (edited) — new `## node.report` section between the Routes table and `## One path for abandon`, one sentence per rule: kind dispatch naming the one-path section, the four task outcomes with their transitions, the `timed-out` refusal, the live-lease guard, the no-owner-field rule, the attestation, the derived close with `acknowledgePartial`, the initiative refusal, and the harness/harness/human admission.
- `docs/proposal/phase-1/state-machine.md` (edited) — line 118 rule replaced: counter is `MAX(attempt_no)` of the active task run, every closed attempt spends a try, rejection-only clause removed.
- `docs/proposal/database/attempt.md` (edited) — prose only: the closing sentence of the attempt-counter paragraph widened to any non-null `outcome`; the `sql` fence and every other line untouched.
  **Seam (GREEN).** The three docs now carry each asserted sentence verbatim, whitespace-insensitively, and the two absence assertions hold because the old clauses were replaced, not appended.
  **Refactor.** none named in this Task — docs amendment only.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: each asserted string is the exact test literal, copied from `src/http/contract/proposal-amendment-outcome.test.ts` and the TE Open block.
- VERIFIED: constraints respected — no Routes-table row added, `outcome.md:5` and the `node.unblock` row untouched, no `node.unblock` section written, no precondition row, no aggregation-table edit, no `sql` fence moved.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 1 confirmed + Story 2 GREEN-only pass-through

**Cycle.** Confirm GREEN for Story 1 (`src/http/contract/proposal-amendment-outcome.test.ts`), then GREEN-ONLY pass-through for Story 2 (`02-epic-014-precondition-check.md`).
**Story 1 GREEN confirmed.**

- command: `node --test src/http/contract/proposal-amendment-outcome.test.ts`
- exit: 0 — pass 7, fail 0.
- handoff gate: SE cited `typecheck: exit 0`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- Story-1 Verify gates re-run: `node --test test/helpers/proposal.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/http/contract/parity.test.ts` — exit 0, pass 56, fail 0. The amendment broke no fence, no route-matrix read and no parity row.

**Cycle.** GREEN-ONLY pass-through for Story 2.
**Story file.** `.agent/plan/stories/019-outcome-report/02-epic-014-precondition-check.md`
**Tasks forwarded to Software Engineer.**

- Story 2: no file to edit — assert-only precondition check. SE reads `src/domain/external-transition.ts` and `src/domain/node-trigger.ts` and confirms each fact by identity; edits nothing.
  **No RED phase.** The story edits no file and names no new test. Its Verify gate is `node --test src/domain/external-transition.test.ts`, which I re-ran this turn: exit 0, pass 27, fail 0. The six precondition facts I verified by identity this turn, each true:
  - `outcome-accepted` carries `reportedObjectId: "required"` (`external-transition.ts:65`);
  - `object-reported` carries `leaseFence: "valid"` and `actorKind: "harness"` (`:92-93`);
  - `externalTriggerConsumer["object-reported"] === "src/commands/outcome/report-objective.ts"` (`:189`);
  - no value of `externalTriggerConsumer` contains `aggregate-objective`;
  - `objectiveDrivePin` is exported (`:171`);
  - `internalTransitions` holds `initiative-aggregated-done`, `initiative-aggregated-partial` and `initiative-aggregated-discarded` (`node-trigger.ts:21-23,112-124`).
    A fact that is false is an EPIC 014 regression: stop and report, do not repair from here.
    **Open to Software Engineer.**
- Read `src/domain/external-transition.ts` and `src/domain/node-trigger.ts`, confirm the six facts by identity, and report each one true or false. Do not edit `src/domain/external-transition.ts` in this story — Story 5 owns the two new rows and the two new consumer entries. Do not edit any file under `.agent/plan/`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 2 EPIC 014 precondition (assert-only)

**Cycle.** GREEN-ONLY implementation for Tasks: Story 2 (`02-epic-014-precondition-check.md`) — assert-only precondition check, no file edited.
**Precondition facts, each confirmed true by identity (no repair needed — no EPIC 014 regression):**

- TRUE — the `outcome-accepted` row at `src/domain/external-transition.ts:54-68` carries `reportedObjectId: "required"` (`:65`).
- TRUE — the `object-reported` row at `src/domain/external-transition.ts:84-98` carries `leaseFence: "valid"` (`:92`) and `actorKind: "harness"` (`:93`).
- TRUE — `externalTriggerConsumer["object-reported"] === "src/commands/outcome/report-objective.ts"` (`:189`).
- TRUE — no value of `externalTriggerConsumer` (`:186-193`: report-outcome ×3, report-objective, close-objective ×2, release-node, recover-expired-leases) contains `aggregate-objective`.
- TRUE — `objectiveDrivePin` is exported at `src/domain/external-transition.ts:171`.
- TRUE — `internalTransitions` holds `initiative-aggregated-done`, `initiative-aggregated-partial` and `initiative-aggregated-discarded` (`src/domain/node-trigger.ts:21-23` in `internalTriggerIds`, rows at `:108-125`), each `initiative running → done|partial|discarded`.
  **Files changed.** none — this story edits no file; `src/domain/external-transition.ts` left for Story 5, nothing under `.agent/plan/` touched.
  **Build check.**
- typecheck: exit 0
  **Refactor.** none named.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 3 every closed attempt spends a try (RED)

**Cycle.** RED for Story 3 (`src/domain/attempt-accounting.test.ts`, edited).
**Test written.**

- file: `src/domain/attempt-accounting.test.ts` (edited) — suite `src/domain/attempt-accounting` — 20 cases: five existing cases that pinned the old rejection-only rule flipped to the widened rule (`a failure at the limit is exhausted`, `timed-out at the limit is exhausted`, `cancelled at the limit is exhausted`, `three accepted attempts at the limit are exhausted`, `limit 1, [1 failed]: exhausted is true`), and fifteen added: the story-named `an accepted attempt at the limit is exhausted`, `an open attempt at the counter is not exhausted`, `a closed attempt under the limit is not exhausted`, `rejections counts rejected alone`, `a gap never lowers the counter`, plus the failed/cancelled/timed-out twins beside every remaining rejected-at-the-limit case (rejection-with-earlier-failures, limit 1, overshoot, gap past the limit). Every other existing case kept verbatim.
- asserts: `exhausted === true` for every closed attempt whose counter is at or past the limit, whatever the outcome; `exhausted === false` when the attempt at the counter is open or the counter is under the limit; `rejections` counts `rejected` alone; a gap never lowers the counter.
  **RED proof.**
- command: `node --test src/domain/attempt-accounting.test.ts`
- exit: 1 — fail 18, pass 28 of 46; failure, one shape across all 18: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` with `+ exhausted: false` (actual) against `- exhausted: true` (expected) — the widened `exhausted` clause is absent.
- intended passes: `an open attempt at the counter is not exhausted` and `a closed attempt under the limit is not exhausted` pass now by design — they pin the open/under-limit behaviour the widened clause must not change; the failing 18 carry the RED.
- typecheck: exit 0. stub probe: none needed — the test imports only the existing `./attempt-accounting.ts` seam, and there is no new path to probe.
- consumers baseline: `node --test src/commands/startup/recover-expired-leases.test.ts src/services/execution/sqlite.test.ts` — exit 0, pass 50, fail 0. `grep -rn "accountAttempts" src/ | grep -v '\.test\.ts'` names `src/services/execution/sqlite.ts:171` alone, so those two suites are the Story-3 Verify consumers that must stay green.
  **Open to Software Engineer.**
- `src/domain/attempt-accounting.ts:70-74` — widen the `exhausted` clause: `counterRecord.outcome !== null` in place of `counterRecord.outcome === "rejected"`, under the unchanged `counter >= input.limit` clause. Nothing else in the file changes, per the Story file.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 3 every closed attempt spends a try (GREEN)

**Cycle.** GREEN for `src/domain/attempt-accounting.test.ts`.
**Files changed.**

- `src/domain/attempt-accounting.ts` (edited) — `accountAttempts` at `:70-74`: the `exhausted` clause now reads `counterRecord.outcome !== null` in place of `counterRecord.outcome === "rejected"`, under the unchanged `counterRecord !== undefined` and `counter >= input.limit` clauses. `counter`, `rejections`, `nextAttemptNo` and `attemptVerdict` untouched.
  **Seam (GREEN).** A closed attempt at the counter at or past the limit is exhausted whatever its outcome, so the `failed`, `cancelled` and `timed-out` twins and the `accepted` case assert `exhausted === true`; an open attempt at the counter or a counter under the limit keeps `exhausted === false`; `rejections` still counts `rejected` alone; a gap still never lowers the counter.
  **Refactor.** none named in this Task — one-clause domain change.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the replacement matches the Story file's `03-attempt-spend-clause.md:20-28` target text exactly; `git diff` shows the single clause as the only change.
- VERIFIED: no import, clock or random source added — `src/domain/` stays pure per `src/domain/layout.test.ts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 3 confirmed + Story 4 external rows (RED)

**Cycle.** Confirm GREEN for Story 3 (`src/domain/attempt-accounting.test.ts`), then RED for Story 4 (`src/domain/external-transition.test.ts`, edited; `src/domain/node-trigger.test.ts`, count pin).
**Story 3 GREEN confirmed.**

- command: `node --test src/domain/attempt-accounting.test.ts`
- exit: 0 — pass 46, fail 0.
- handoff gate: SE cited `typecheck: exit 0`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `src/domain/external-transition.test.ts` (edited) — suite `src/domain/external-transition.test` — methods: `externalTransitions holds ten trigger ids`, `externalTransitions holds exactly ten rows in exactly the declared order`, `the attempt-failed row is field by field the failed report contract`, `the report-cancelled row is field by field the cancelled report contract`, `both new rows name a legal cell`, `the three initiative roll-up triggers are internal`, `is total over the ten trigger ids`, `the two new triggers name report-outcome.ts`, and the raised `maps the three report-outcome triggers and the two close triggers in id order`.
- edits: the exact-id assertion raised 8 → 10 with `attempt-failed` and `report-cancelled` appended in order; the row-count assertion and the `expected` fixture each raised to ten rows (the two Story rows appended verbatim); the consumer totality assertion raised to ten keys; the `report-outcome.ts` key list raised from three to five ids; four new tests added per the Story Verify section, names verbatim. `expected` is declared as `readonly (Omit<ExternalTransition, "trigger"> & { trigger: string })[]` so the two not-yet-declared trigger literals typecheck today.
- file: `src/domain/node-trigger.test.ts` (edited) — the disjoint-union count pin `assert.equal(union.size, 23)` raised to `25`, because the two new external ids join the union and the Story's own gate `npm run verify` would stay red after the SE turn without it. 15 internal + 10 external = 25.
- asserts: ten trigger ids exactly, rows field by field over all seven `ExternalPrecondition` members plus `level`, `from`, `to`; both new rows name a legal matrix cell; the three initiative roll-up triggers absent from the external table and present in `internalTriggerIds`; the consumer total over ten ids; both new values equal `"src/commands/outcome/report-outcome.ts"` exactly; the disjoint-union count at 25.
  **RED proof.**
- command: `node --test src/domain/external-transition.test.ts src/domain/transition.test.ts`
- exit: 1 — fail 8, pass 44 of 52 (transition.test.ts contributes no failure); failures, one per assertion:
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 8 !== 10` (×2 — trigger ids, row count);
  - `AssertionError [ERR_ASSERTION]: no row for trigger attempt-failed` (×2 — the field-by-field test and the legal-cell test);
  - `AssertionError [ERR_ASSERTION]: no row for trigger report-cancelled`;
  - `8 !== 10` for the consumer totality;
  - the strict-equal diff for `consumer["attempt-failed"]` (`undefined` vs the command path);
  - the deep-equal diff for the raised `report-outcome.ts` key list (`actual: [attempt-rejected, outcome-accepted, attempt-limit-reached]` vs the five-key expected).
- command: `node --test src/domain/node-trigger.test.ts`
- exit: 1 — fail 1, pass 8 of 9; failure: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 23 !== 25`.
- intended pass: `the three initiative roll-up triggers are internal` passes now by design — it pins the existing internal rows and the `initiative running → done|partial|discarded` matrix cells; its sensitivity is negative: it fails if the SE lands a roll-up row in the external table, drops one from `internalTransitions`, or the matrix loses a cell.
- typecheck: exit 0. stub probe: none needed — the seam `./external-transition.ts` and `./node-trigger.ts` exist, so no TS2307 masks this RED; the trigger-literal casts I used typecheck against the current union.
- consumers baseline: `src/commands/node/release-node.test.ts:642` and `src/services/plan/sqlite.test.ts:1244` only iterate or `.find` the table — no count asserted, so the appended rows break nothing there; `src/domain/transition.test.ts` passes in the run above.
  **Open to Software Engineer.**
- `src/domain/external-transition.ts` — three additions, nothing else:
  - append `"attempt-failed", "report-cancelled",` to `externalTriggerIds` after the eight EPIC-018 ids, in that order;
  - append the two rows to `externalTransitions` at the end, in the same order: each `{ level: "task", from: "running", to: "ready", trigger: <id>, precondition: { runDriver: "external", activeRun: true, leaseFence: "valid", actorKind: "harness", attemptLimit: "under", reportedObjectId: "absent", childAggregation: "not-applicable" } }` — the Story file's `04-external-transition-rows.md` carries them verbatim;
  - add `"attempt-failed": "src/commands/outcome/report-outcome.ts", "report-cancelled": "src/commands/outcome/report-outcome.ts",` to `externalTriggerConsumer`, keeping key order of `externalTriggerIds`.
- Constraints: add no row for the three initiative roll-up triggers (`ExternalPrecondition` stays total, `childAggregation` gains no member); add no `aggregate-objective.ts` value; change no existing row and no existing consumer entry; add no on-disk file check — Story 12 owns it.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 4 external transition rows (GREEN)

**Cycle.** GREEN for `src/domain/external-transition.test.ts` and `src/domain/node-trigger.test.ts`.
**Files changed.**

- `src/domain/external-transition.ts` (edited) — three additions only, 34 inserted lines:
  - `externalTriggerIds` (`:4-15`) — `"attempt-failed", "report-cancelled",` appended after the eight EPIC-018 ids, in that order.
  - `externalTransitions` (`:160-188`) — the two Story rows appended at the end of the array, in the same order, each `{ level: "task", from: "running", to: "ready", trigger: <id>, precondition: { runDriver: "external", activeRun: true, leaseFence: "valid", actorKind: "harness", attemptLimit: "under", reportedObjectId: "absent", childAggregation: "not-applicable" } }`, field-identical to the `attempt-rejected` row.
  - `externalTriggerConsumer` (`:225-226`) — `"attempt-failed"` and `"report-cancelled"` both map to `"src/commands/outcome/report-outcome.ts"`, appended in the key order of `externalTriggerIds`.
    **Seam (GREEN).** The ten-id assertions, the ten-row field-by-field assertions, the consumer totality over ten keys, the five-key `report-outcome.ts` list and the node-trigger disjoint-union count at 25 all read the appended members. `canTransition("task", "running", "ready")` was already true from the `attempt-rejected` row, so the legal-cell tests pass for both new rows.
    **Refactor.** none named in this Task — three append-only additions.
    **Build check.**
- typecheck: exit 0
- diff: 34 insertions, 0 deletions, 0 modifications to existing rows or consumer entries.
  **Assumptions.**
- VERIFIED: rows and consumer entries match `04-external-transition-rows.md:10-59` verbatim; no initiative roll-up row added (`ExternalPrecondition` untouched, `childAggregation` gains no member); no `aggregate-objective.ts` value; no on-disk file check added (Story 12 owns it).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 4 confirmed + Story 5 report effect as data (RED)

**Cycle.** Confirm GREEN for Story 4, then RED for Story 5 (`src/domain/outcome-report.test.ts`, new).
**Story 4 GREEN confirmed.**

- command: `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts`
- exit: 0 — pass 41, fail 0.
- handoff gate: SE cited `typecheck: exit 0`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `src/domain/outcome-report.test.ts` (new) — suite `src/domain/outcome-report.test` — methods (names verbatim from the Story Verify section):
  - `the three vocabularies are exact` — `reportKinds` deep-equals the six-member literal, `taskReportOutcomes` the four-member literal, `objectiveReportKinds` `["attested", "closed"]`, and every member of `taskReportOutcomes` is a member of `attemptOutcomes`;
  - `timed-out is not a task report outcome` — absent from `taskReportOutcomes`, present in `attemptOutcomes`;
  - `the full cross product returns the fixed record` — all eight outcome × exhausted pairs, each `assert.deepEqual` against the Story's literal record; the not-exhausted accounting is `{ counter: 1, rejections: 0, exhausted: false, nextAttemptNo: 2 }` and the exhausted one `{ counter: 3, rejections: 0, exhausted: true, nextAttemptNo: 4 }`;
  - `nodeState equals the to of the row the trigger names` — for every result, the `externalTransitions` row of the returned trigger has `row.to === result.nodeState` and `row.level === "task"`;
  - `accepted ignores the accounting` — the accepted result is deep-equal under both accountings;
  - `cancelled reaches the limit exactly as rejected does` — the exhausted pair differs in `attemptOutcome` alone, compared field by field;
  - `NodeReportResult holds ten keys in order` — `Object.keys` deep-equals `["nodeId", "kind", "state", "blockReason", "attemptId", "attemptNo", "attemptsRemaining", "objectId", "objectiveState", "objectiveProjection"]`.
- asserts: the exact record per branch — `accepted` → `{ done, null, "done", true, "outcome-accepted" }`; each of `rejected`/`failed`/`cancelled` → `ready` + `null` + `null` + `false` + its per-outcome trigger under the limit, and `blocked` + `"attempt-limit"` + `"blocked"` + `false` + `"attempt-limit-reached"` at the limit.
  **RED proof.**
- command: `node --test src/domain/outcome-report.test.ts`
- exit: 1 — fail 1, pass 0; failure:
  `code: 'ERR_MODULE_NOT_FOUND'`, `url: 'file:///Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/domain/outcome-report.ts'` — the seam is absent.
- stub probe: `src/domain/outcome-report.ts` — clean. The probe carried the Story-declared signatures with throw bodies; `npm run typecheck` exits 0. I then filled the probe body with the Story branch table and the suite passed 7/7, which proves the assertions are complete and would go green once the seam exists; the stub was deleted and the RED re-confirmed (`ERR_MODULE_NOT_FOUND` again). The masked state without the stub reports the expected two `TS2307` plus two `TS2532` artifacts on `expected[outcome]` that the probe proved vanish with the real types.
- consumers baseline: `src/domain/external-transition.test.ts` passes in the confirm run above (41/41) — the Story-5 gate `node --test src/domain/outcome-report.test.ts src/domain/external-transition.test.ts` stays green on that half.
  **Open to Software Engineer.**
- `src/domain/outcome-report.ts` — one new pure domain module, per the Story file `05-report-effect-data.md:12-68`: `reportKinds` / `taskReportOutcomes` / `objectiveReportKinds` and their types, `TaskReportEffect`, `TaskReportEffectInput`, the total `taskReportEffect(input)` with the Story's four branches, and `NodeReportResult` with the ten keys in the Story's order. Imports only `type AttemptAccounting`, `type AttemptOutcome`, `type NodeKind`/`NodeState`/`TerminalState` and `type ExternalTriggerId`, and no `zod`.
- Constraints: `taskReportOutcomes` is a strict subset of `attemptOutcomes` and `timed-out` is absent; a fresh object literal per call; no clock, no random, no `new Date`; add no fifth outcome and no seventh report kind.

END: TEST-ENGINEER## SOFTWARE-ENGINEER — 019-outcome-report · Story 5 report effect as data (GREEN)

**Cycle.** GREEN for `src/domain/outcome-report.test.ts`.
**Files changed.**

- `src/domain/outcome-report.ts` (new) — `reportKinds`/`ReportKind`, `taskReportOutcomes`/`TaskReportOutcome`, `objectiveReportKinds`/`ObjectiveReportKind`, `TaskReportEffect`, `TaskReportEffectInput`, total `taskReportEffect(input)` with the four branches, `NodeReportResult` with the ten keys in the Story's order.
  **Seam (GREEN).** The module exports every member the suite imports. `accepted` returns `{ done, null, "done", true, "outcome-accepted" }` and reads the accounting not at all; `rejected`/`failed`/`cancelled` read `input.accounting.exhausted` and return `ready` + `null` + `null` + `false` + the per-outcome trigger (`attempt-rejected`, `attempt-failed`, `report-cancelled`) under the limit, and `blocked` + `"attempt-limit"` + `"blocked"` + `false` + `"attempt-limit-reached"` at it. `nodeState` agrees with `row.to` for the trigger's external row; `cancelled` at the limit differs from `rejected` in `attemptOutcome` alone; `NodeReportResult`'s key order matches the ten-key literal.
  **Refactor.** none named in this Task — one pure data module.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the Story file's `05-report-effect-data.md:12-68` signatures, branch table and `NodeReportResult` keys are reproduced verbatim; the test file's `expected` records (`:68-140`) match the branch table row for row.
- VERIFIED: imports are the four `type`-only domain imports the Story names, and nothing else — no `zod`, no clock, no `Math.random`, no `new Date`, no module-level mutable state; `src/domain/` purity holds.

END: SOFTWARE-ENGINEER## TEST-ENGINEER — 019-outcome-report · Story 5 confirmed + Story 6 execution methods (RED)

**Cycle.** Confirm GREEN for Story 5 (`src/domain/outcome-report.test.ts`), then RED for Story 6 (`src/services/execution/sqlite.test.ts`, edited; `test/helpers/execution.ts`, conformer update).
**Story 5 GREEN confirmed.**

- command: `node --test src/domain/outcome-report.test.ts`
- exit: 0 — pass 7, fail 0.
- handoff gate: SE cited `typecheck: exit 0`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `src/services/execution/sqlite.test.ts` (edited) — suite `src/services/execution/sqlite.test` — methods (names verbatim from the Story Verify section):
  - `stampRunHead writes head_oid on an active run and moves no other column` — `SELECT *` before and after, `head_oid` changed, every other column equal field by field;
  - `stampRunHead accepts a 64-character object id` — the 64-char literal read back from the row;
  - `stampRunHead refuses an ended run` — code `run-not-active`, row unchanged field by field after;
  - `stampRunHead refuses an unknown run id` — the same code;
  - `latestRunOfNode returns the run with the greatest id` — first run active, then ended (still returned, the only run), then a second run wins by greatest id;
  - `latestRunOfNode returns null for a node with no run`;
  - `latestRunOfNode returns the ended run after the close` — stamp then end the newest run, same id back with `headOid` intact;
  - `attemptsOfRun returns head_oid` — head_oid written into the open attempt row, attempt closed, the row read back carries it.
- file: `test/helpers/execution.ts` (edited) — both `Execution` conformers gain the two methods so the SE's handoff typecheck stays clean: `createExecutionFake` throws `unexpected` for both (nothing in current consumers calls them), `createBackedExecutionFake` mirrors the Story's statements — `UPDATE run SET head_oid = ? WHERE id = ? AND ended_at IS NULL` with `run-not-active` on no changed row, and `SELECT ${RUN_COLUMNS} ... WHERE node_id = ? ORDER BY id DESC LIMIT 1` mapped with the existing `toRunRecord`.
- asserts: the observable row effects only — no return value of `stampRunHead` is read (the Story declares `void`), and the write/read of both methods goes through the real `node:sqlite` database on a temporary file.
  **RED proof.**
- command: `node --test src/services/execution/sqlite.test.ts`
- exit: 1 — pass 19, fail 7; failures, one shape each:
  - `TypeError: execution.stampRunHead is not a function` (four tests);
  - `TypeError: execution.latestRunOfNode is not a function` (three tests).
- intended pass: `attemptsOfRun returns head_oid` passes now by design — EPIC 018's `ATTEMPT_COLUMNS` already includes `head_oid`, and the Story says "confirm it returns the whole attempt row including head_oid" and widen only if narrower. Sensitivity is negative: it fails if a later edit narrows the projection.
- stub probe: `src/services/execution/index.ts` + `src/services/execution/sqlite.ts` — clean. The probe carried the Story-declared `StampRunHeadInput`, both interface members and throw-body implementations; `npm run typecheck` exits 0, which proves the test file and the two helper fakes are type-correct against the real signatures. Probe deleted via `git checkout`; the RED re-verified after deletion.
- typecheck without the probe: fails with exactly the missing-seam set — `TS2339`/`TS2551` on `stampRunHead`/`latestRunOfNode` in the test file, `TS2305` on the missing `StampRunHeadInput` export and `TS2353` on the two fake object literals in the helper. All clear once the SE lands the interface members; no other error remains.
- consumers baseline: `node --test src/commands/node/claim-node.test.ts src/commands/node/release-node.test.ts src/commands/node/heartbeat-node.test.ts src/commands/startup/recover-expired-leases.test.ts` — exit 0, pass 99, fail 0. The additive fake members change no existing behavior.
  **Open to Software Engineer.**
- `src/services/execution/index.ts` — the `Execution` interface gains `stampRunHead` immediately after `endRun` and `latestRunOfNode` immediately after `activeRunOfNode`, plus `StampRunHeadInput = Readonly<{ runId: string; headOid: string }>`; `RunRecord` is reused for `latestRunOfNode`'s return, no second shape.
- `src/services/execution/sqlite.ts` — the two implementations, per the Story file `06-execution-service-methods.md:26-46`.
- Constraints: add no third method and no second capability; `stampRunHead` never ends a run and never writes `outcome` or `ended_at`; both take the caller's `Transaction` first; no migration; `attemptsOfRun` keeps its existing `ORDER BY attempt_no ASC` and whole-row projection (already conforms).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 6 execution methods (GREEN)

**Cycle.** GREEN for `src/services/execution/sqlite.test.ts`.
**Files changed.**

- `src/services/execution/index.ts` (edited) — `StampRunHeadInput = Readonly<{ runId: string; headOid: string }>` after `EndRunInput`; `latestRunOfNode` in the interface immediately after `activeRunOfNode`, `stampRunHead` immediately after `endRun`, both taking the caller's `Transaction` first; `RunRecord` reused for `latestRunOfNode`, no second shape.
- `src/services/execution/sqlite.ts` (edited) — `stampRunHead(transaction, input): void` runs one `UPDATE run SET head_oid = ? WHERE id = ? AND ended_at IS NULL RETURNING ${RUN_COLUMNS}` and throws `ExecutionError("run-not-active", …)` when no row returns, so an ended or unknown run is never silent; it writes no other column, never ends a run. `latestRunOfNode(transaction, nodeId): RunRecord | null` runs one `SELECT ${RUN_COLUMNS} FROM run WHERE node_id = ? ORDER BY id DESC LIMIT 1`, mapped with the same `toRunRecord` `activeRunOfNode` uses, `null` on no row.
  **Seam (GREEN).** The four `stampRunHead` tests see `head_oid` written on an active run (40- and 64-char ids), every other column equal field by field, and code `run-not-active` with the row unchanged on an ended or unknown run. The three `latestRunOfNode` tests see the greatest-id run, ended runs included, with `headOid` intact after the close, and `null` for a node with no run.
  **Refactor.** none named in this Task — two additive methods and one input type.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the SQL and error code match `06-execution-service-methods.md:28-44` verbatim; `attemptsOfRun` already returns the whole row — `ATTEMPT_COLUMNS` (`:22-23`) includes `head_oid` and `toAttemptRecord` maps it, so the widen-if-narrower clause needed no change; the test `attemptsOfRun returns head_oid` passed by design.
- VERIFIED: no third method, no second capability, no migration, no change to `endRun` or `attemptsOfRun`; the two helper fakes of `test/helpers/execution.ts` typecheck against the widened interface (TE's edit).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 6 confirmed + Story 7+8 reportOutcome (RED)

**Cycle.** Confirm GREEN for Story 6 (`src/services/execution/sqlite.test.ts`), then RED for the coupled pair Stories 7+8 (`src/commands/outcome/report-outcome.test.ts`, new; `test/helpers/execution.ts`, conformer edit). Per `index.md:12-13` the two stories edit one command file and take no verify gate between them, so one RED turn carries both Verify blocks.

**Story 6 GREEN confirmed.**

- command: `node --test src/services/execution/sqlite.test.ts`
- exit: 0 — pass 26, fail 0.
- handoff gate: SE cited `typecheck: exit 0`. Re-ran `npm run verify:handoff` — `VERIFY: FAIL — npm run typecheck exited 2`. The failure is entirely inside my new RED test: `TS2307: Cannot find module './report-outcome.ts'` plus its four derived TS18046/TS7006 artifacts on the unresolvable import. The stub probe below proved `npm run typecheck` exits 0 once the Story-declared seam exists, so the failure is the masked RED, not the SE's artifact.

**Test written.**

- file: `src/commands/outcome/report-outcome.test.ts` (new) — suite `src/commands/outcome/report-outcome.test` — 28 tests, names verbatim from the Story 7 and Story 8 Verify blocks:
  - Story 7: `an accepted report moves the task to done and records the object id`; `a rejected report under the limit returns the task to ready and keeps the run active`; `a failed report behaves as a rejected report and records failed`; `a cancelled report under the limit leaves the run active` (side by side with EPIC 018's `releaseNode`, which ends the same run); `three rejected reports under a limit of three block the task`; `three cancelled reports reach the same block`; `three failed reports reach the same block`; `attemptsRemaining clamps at zero`; `no task report touches the objective lease` (four outcome fixtures plus a fifth two-task case for the last-task close); `a report on a task in each non-running state is illegal-transition` (all seven states, `details.state` each); `a wrong owner, a stale fence and an expired lease are each lease-held`; `a human actor is actor-forbidden`; `an initiative is initiative-not-reportable`; `a task body on an objective and an objective body on a task are body-kind-mismatch`; `an objective with report attested delegates to reportObjective in the same transaction`; `an objective with report closed delegates to closeObjective in the same transaction`; `objectiveProjection is done when every sibling task is terminal`; `objectiveProjection is partial when one sibling is discarded`; `objectiveProjection is null while one sibling is non-terminal`; `every write names its trigger`; `a trigger that disagrees with the pair commits nothing` (pair mismatch plus the levels refusal, reached through `initiative-aggregated-done` over a task `running → done` because the matrix check fires before the levels check); `an accepted report makes a dependent task ready in the same transaction`.
  - Story 8: `the payload holds exactly nine keys in order`; `an accepted report records the object id and a null reason` (whole recorded `AppendEventInput` deep-equal); `a rejected report stores its reason verbatim` (newline + non-ASCII); `a cancelled report with no reason stores null`; `the limit case records toState blocked and attemptsRemaining zero`; `exactly one outcome.reported event is appended per report`.
- file: `test/helpers/execution.ts` (edited) — the backed `closeAttempt` now writes `head_oid` alongside `outcome`/`ended_at`, reading the input as `"headOid" in input ? input.headOid : null` so the helper typechecks whether or not the SE widens `CloseAttemptInput`; the real story step 9 requires the attempt row to take the accepted object id, and the observable is asserted from the row.
- fixture mechanics: real `node:sqlite` on a temporary file for storage/plan/lease/execution; a recording `EventLog` fake (the Story names it "recording"); recording injected `reportObjective`/`closeObjective` fakes typed through `ReportOutcomeDependencies`, whose probe-write through the recorded transaction proves the delegation rides the command's transaction; claims driven through EPIC 018's `claimNode` with the real sweep; the two states the schema forbids on a task row (`awaiting_approval`, `partial`) seeded via `PRAGMA ignore_check_constraints = ON` around the single `UPDATE` and re-enabled immediately after — verified working through the real `SqliteStorage`.
- asserts: the Story's observable contract — row effects (node state, attempt outcome + `head_oid`, run end + `head_oid`, lease owner/fence, attempt numbers 1-2-3), the exact event payload, the exact delegated input, `attemptsRemaining = max(0, limit − counter)`, and every refusal with byte-identical database plus zero recorded appends, zero `Lease.release` and zero `setNodeState` calls.

**RED proof.**

- command: `node --test src/commands/outcome/report-outcome.test.ts`
- exit: 1 — fail 1, pass 0; failure: `code: 'ERR_MODULE_NOT_FOUND'`, `url: 'file:///.../src/commands/outcome/report-outcome.ts'` — the seam is absent.
- stub probe: `src/commands/outcome/report-outcome.ts` — clean. I first probed with throw-body signatures: `npm run typecheck` exits 0, proving the test file and the two helper fakes are type-correct against the Story-declared seam. I then filled the probe with a working implementation of the Story's exact steps (one transaction, one `now`, kind dispatch, task branch, three-condition lease guard, close/account/effect, trigger-named `setNodeState`, stamp-then-end, task-lease release, the nine-key event, sibling projection) and the suite passed 28/28, which proves every assertion matches the Story contract end to end. The probe was deleted and the RED re-confirmed (`ERR_MODULE_NOT_FOUND`). Without the probe, `npm run typecheck` reports exactly the missing-seam set: one `TS2307` on `./report-outcome.ts` and its four derived artifacts in the test file; all vanish with the real signatures.
- masked state caveat: `verify:handoff` is FAIL while the seam is absent, for the reason above; it returns PASS when the SE lands the command.
- consumers baseline: `node --test src/commands/node/claim-node.test.ts src/commands/node/release-node.test.ts src/commands/node/heartbeat-node.test.ts src/commands/startup/recover-expired-leases.test.ts src/services/execution/sqlite.test.ts` — exit 0, pass 125, fail 0. The `closeAttempt` helper edit changes no existing behavior (inputs without `headOid` write null, exactly as before).

**Open to Software Engineer.**

- `src/commands/outcome/report-outcome.ts` — the command seam per Story `07-report-outcome-command.md` and `08-outcome-reported-payload.md`: `ReportOutcomeDependencies` (storage, plan, lease, execution, events, clock, injected `reportObjective` and `closeObjective` taking the caller's `Transaction` first, instanceId), `ReportOutcomeInput` with the body discriminated on `report` over the six `reportKinds` (task members carry `fence`; `accepted` carries `objectId`; `rejected`/`failed` carry `reason`; `cancelled` has optional `reason`; `attested` carries `fence` + `objectId`; `closed` carries `acknowledgePartial` only), `ReportOutcomeError` with the six refusals, `ReportOutcomeResult = NodeReportResult`, and `reportOutcome` per the Story's numbered body. The accepted object id must land in the attempt row's `head_oid` (the observable my test asserts) and in the task run's `head_oid` before the run ends; the event payload holds exactly the nine keys in the Story's order.
- Constraints from the Story: one transaction and one `now`; `timed-out` never reaches the command; no second event for the transition; never touch the objective lease and never end the objective run; sibling states read in bytewise node-id order; `attemptsRemaining` clamps at zero.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Stories 7+8 reportOutcome command and payload (GREEN)

**Cycle.** GREEN for `src/commands/outcome/report-outcome.test.ts`.
**Files changed.**

- `src/commands/outcome/report-outcome.ts` (new) — `reportOutcome(dependencies, input)`; `ReportOutcomeDependencies`, `ReportOutcomeInput`, `ReportOutcomeResult = NodeReportResult`, `ReportOutcomeRefusal`/`ReportOutcomeError`, `NodeReportRequest` (six-member discriminated body union, no `owner`), `ReportObjectiveInput`/`ReportObjectiveResult`, `CloseObjectiveInput`/`CloseObjectiveResult`.
- `src/services/execution/index.ts` (edited) — `CloseAttemptInput` gains `headOid?: string | null`.
- `src/services/execution/sqlite.ts` (edited) — `closeAttempt` writes `head_oid` when `headOid` is present and leaves the column untouched when omitted.

**Seam (GREEN).** One `storage.transact`, one `clock.now()`, exact story order: `readNode` (`node-not-found`), initiative refusal, kind-vs-body mismatch (switch on the body discriminator, so no type-predicate narrowing issues), delegation of `attested`/`closed` to the injected functions on the same transaction, `actor-forbidden` for a human, `illegal-transition { state }` when not running, the three-condition lease guard (`lease-held { owner, fence }` from the row), active run, closeAttempt of the one open attempt with `headOid` = accepted object id or null, `accountAttempts` over the run's attempts, `taskReportEffect`, one trigger-named `setNodeState`, stamp-then-end the run only when the effect names a run end, task-lease release, the nine-key `outcome.reported` append, and the sibling projection (`aggregate("objective", states)` when every sibling task is terminal, bytewise node-id order) with `objectiveState` read after step 12.
**Refactor.** none named in this Task — one new command plus the minimal execution widening the story's step 9 requires.
**Build check.**

- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint on the three touched files: clean (import matrix holds — `commands/` imports `domain/` + service interfaces only)
  **Assumptions.**
- VERIFIED: `CloseAttemptInput.headOid` is optional, not required — the existing callers (`recover-expired-leases.ts`, `release-node.ts`) and their exact-input deep-equal tests must not change, and the Story-6 test `attemptsOfRun returns head_oid` pins that an omitted `headOid` leaves the column untouched, hence the conditional SQL in `sqlite.ts`; the report command always passes the value explicitly.
- VERIFIED: `ReportObjectiveInput`/`CloseObjectiveInput`/`NodeReportRequest` are declared in this file, because `commands/` never imports `commands/` or `http/contract/` — Story 9/10 declare their own same-shaped types, and the test derives the delegated-input shape from `Parameters<ReportOutcomeDependencies[...]>`, so it stays green.
- VERIFIED: `instanceId` is declared on the seam per the Story and passed by the test; the task branch attributes every event to the harness, so no daemon attribution uses it here.
- VERIFIED: no vendor import, no clock/random, one transaction, one `now`, exactly one `outcome.reported` append per report; the objective lease and the objective run are never touched.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 7+8 confirmed + Story 9 reportObjective (RED)

**Cycle.** Confirm GREEN for Stories 7+8 (`src/commands/outcome/report-outcome.test.ts`), then RED for Story 9 (`src/commands/outcome/report-objective.test.ts`, new).
**Story 7+8 GREEN confirmed.**

- command: `node --test src/commands/outcome/report-outcome.test.ts`
- exit: 0 — pass 28, fail 0.
- handoff gate: SE cited `verify:handoff: VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `src/commands/outcome/report-objective.test.ts` (new) — suite `src/commands/outcome/report-objective.test` — 11 tests, names verbatim from the Story Verify block:
  - `an attestation moves the objective to awaiting_approval and stamps the object id` — objective state, active run with attested `head_oid` and `ended_at IS NULL`, lease owner null, and the full `NodeReportResult` deep-equal;
  - `the attested object id is not the object id of any task report` — the objective run carries the attested id and the ended task run carries the task's own id;
  - `an attestation over a live objective lease answers rather than refusing` — last task reported first, attestation with the claim-minted objective fence asserts no throw;
  - `an attestation while one task is non-terminal is illegal-transition` — claim only, byte-identical database, zero appends/releases/setNodeState;
  - `an attestation on an objective that is not running is illegal-transition` — all seven other states, `details.state` each, byte-identical each;
  - `a stale fence, a wrong owner and an expired lease are each lease-held` — three cases, `details` carries the stored owner and stored fence, byte-identical each;
  - `a projection of discarded is illegal-transition` — every task written `discarded` directly in the database, byte-identical;
  - `a human actor is actor-forbidden` — byte-identical;
  - `the event names the attesting harness` — whole `AppendEventInput` deep-equal, `actorKind: "harness"`, and the six payload keys in order with `projection: "done"` and `objectiveRunId` equal to the run row;
  - `the awaitingApproval event differs from the ready event of the same transaction` — one `node.awaitingApproval` with `actorKind: "harness"` and one `node.ready` with `actorKind: "daemon"` and `subjectId: "task_b2"`. Fixture: a second objective under the same initiative whose one pending task depends on the first objective's task; the dependency is seeded `done` by a direct `UPDATE`, so no readiness pass ever ran over it, and the attestation's `setNodeState` is the first write that reads the graph back and promotes it — the only way both events land in one transaction, per `016-readiness-applied.md:49`;
  - `the trigger is object-reported and no other` — exactly one new `setNodeState` call, `id`/`from`/`to`/`trigger` asserted.
- fixture mechanics: real `node:sqlite` on a temporary file; recording `EventLog` fake; backed lease and execution fakes; recording `PlanStore` over `createReadiness(events, INSTANCE)`; the happy-path task report driven through the real `reportOutcome` with throwing delegated stubs; the attestation called through `storage.transact` with the Story's six dependencies; run/lease rows asserted from the database.
- asserts: the Story's observable contract — row effects (objective state, run `head_oid`/`state`/`ended_at`, lease owner/fence/expiry), the exact event, the exact result record, and every refusal with byte-identical database plus zero recorded appends, zero `Lease.release` and zero `setNodeState` calls.
  **RED proof.**
- command: `node --test src/commands/outcome/report-objective.test.ts`
- exit: 1 — fail 1, pass 0; failure: `code: 'ERR_MODULE_NOT_FOUND'`, `url: 'file:///.../src/commands/outcome/report-objective.ts'` — the seam is absent.
- stub probe: `src/commands/outcome/report-objective.ts` — clean. I probed with the Story-declared signatures and a working implementation of the numbered body (actor guard, state check, three-condition lease guard, terminal-task check, `aggregate`/`objectiveOutcome`, `object-reported` `setNodeState`, `activeRunOfNode` + `stampRunHead`, objective-lease release, the six-key event); `npm run typecheck` exits 0 and the suite passes 11/11, which proves the test file is type-correct and every assertion matches the Story contract end to end. The probe was deleted and the RED re-confirmed (`ERR_MODULE_NOT_FOUND` again).
- masked state caveat: without the probe, `npm run typecheck` exits 2 on exactly one `TS2307: Cannot find module './report-objective.ts'` in the test file; `verify:handoff` is FAIL while the seam is absent and returns PASS when the SE lands the command.
- consumers baseline: `node --test src/commands/outcome/report-outcome.test.ts` — exit 0, pass 28, fail 0. The new file imports nothing another suite shares, so Story 7+8 stays green.
  **Open to Software Engineer.**
- `src/commands/outcome/report-objective.ts` — the command seam per Story `09-report-objective.md:10-68`: `ReportObjectiveDependencies` (plan, lease, execution, events, clock, instanceId), `ReportObjectiveInput` (nodeId, actorId, actorKind, fence, objectId), `reportObjective(dependencies, transaction, input)`, `ReportObjectiveError` with refusals `actor-forbidden` / `illegal-transition` / `lease-held` in the shape of `ReportOutcomeError`, and `ReportObjectiveResult = NodeReportResult`. The body runs the Story's numbered steps 1-10: the `lease-held` details carry the row's stored owner and fence; the `illegal-transition` details for a non-running objective carry `{ state }`.
- Constraints from the Story: it ends no run and releases the objective lease and no other lease; the payload holds exactly the six keys in the Story's order; exactly one event append (setNodeState/readiness append their own); the trigger is the literal `"object-reported"`; task states read in bytewise node-id order; every refusal writes nothing; no vendor import and no other command import. The Story's step-9 snippet shows three release fields; the real `ReleaseLeaseInput` requires owner, ownerKind and now — fill the full input.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 9 reportObjective attestation (GREEN)

**Cycle.** GREEN for `src/commands/outcome/report-objective.test.ts`.
**Files changed.**

- `src/commands/outcome/report-objective.ts` (new) — `ReportObjectiveDependencies`, `ReportObjectiveInput`, `ReportObjectiveResult = NodeReportResult`, `ReportObjectiveRefusal`, `ReportObjectiveError`, `reportObjective(dependencies, transaction, input)`.
  **Seam (GREEN).** The command runs the Story's exact order. One `clock.now()` is captured first; a `human` actor throws `actor-forbidden`; a null node or a node not in `running` throws `illegal-transition` with `details: { state }`; the three-condition lease guard (wrong owner, wrong fence, null or expired `expires_at`) throws `lease-held` with `details: { owner, fence }` from the stored row; every task of the objective read through `readAllNodes`, filtered on `parentId`, sorted bytewise by id — a non-terminal task throws `illegal-transition`; `aggregate("objective", states)` and a `discarded` projection throw `illegal-transition`; `objectiveOutcome` derives `awaiting_approval`; one `setNodeState` under the literal trigger `"object-reported"`; `activeRunOfNode` + `stampRunHead` write the attested id on the active objective run (null run throws); the objective lease releases with the full `ReleaseLeaseInput` (`owner`, `ownerKind: "actor"`, `now`); one `node.awaitingApproval` event appended with the six payload keys in order (`from`, `to`, `reason: "object-attested"`, `objectId`, `projection`, `objectiveRunId`); the ten-field `NodeReportResult` with `kind: "objective"`, `attemptId`/`attemptNo`/`attemptsRemaining` null. Refusals never reach a write, so the byte-identical database and zero-append/release/setNodeState assertions hold. The readiness promotion of `task_b2` happens inside `setNodeState` because the recording plan store wraps `createReadiness(events, INSTANCE)`, giving the one `node.ready` with `actorKind: "daemon"` beside the harness's `node.awaitingApproval`.
  **Refactor.** none named in this Task — one new command file.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint on the touched file: clean (import matrix holds — `commands/` imports `domain/` + service interfaces only)
  **Assumptions.**
- VERIFIED: signatures, step order, event payload keys and result fields match `09-report-objective.md:10-68` verbatim; the three-field release snippet of step 9 is completed with `owner`, `ownerKind: "actor"` and `now` per `ReleaseLeaseInput`, the same completion `report-outcome.ts:246-253` uses.
- VERIFIED: `instanceId` is declared on the seam per the Story but unused in the body — the attestation event is attributed to the harness, and the daemon attribution belongs to the readiness service's own event.
- VERIFIED: the bytewise sort helper is the local `compareIds` idiom `report-outcome.ts:309-311` already uses; no shared-util extraction, per the surgical-diff rule.
- VERIFIED: no vendor import, no other command import, no clock beyond the one `now`, no run ended and no lease but the objective's touched.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 9 confirmed + Story 10 aggregateInitiative (RED)

**Cycle.** Confirm GREEN for Story 9 (`src/commands/outcome/report-objective.test.ts`), then RED for Story 10 (`src/commands/outcome/aggregate-initiative.test.ts`, new).
**Story 9 GREEN confirmed.**

- command: `node --test src/commands/outcome/report-objective.test.ts`
- exit: 0 — pass 11, fail 0.
- handoff gate: SE cited `verify:handoff: VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
  **Test written.**
- file: `src/commands/outcome/aggregate-initiative.test.ts` (new) — suite `src/commands/outcome/aggregate-initiative.test` — 11 methods, names verbatim from the Story Verify block: `one partial objective gives partial`, `done plus partial gives partial`, `partial plus discarded gives partial`, `every objective discarded gives discarded and never partial`, `every objective done gives done`, `the initiative stays running while one objective is not terminal`, `a null initiative id writes nothing`, `an initiative that is not running writes nothing` (driven for `done` and `partial`), `the event names the daemon instance`, `objectiveStates is ordered bytewise by node id`, `no run row is written`.
- fixture mechanics: real `node:sqlite` on a temporary file; recording `EventLog` fake; recording `PlanStore` over the plain `createPlanStore()` (discarding readiness, so the roll-up append is the only recorded event); objective states seeded directly in the database via `seedNodeState`/`INSERT`, because no route of this block writes a `discarded` or a `partial` objective; the initiative seeded `running` through `seedNodeState`.
- asserts: for each write case the exact `setNodeState` call `{ id, from: "running", to, trigger }` plus the whole recorded `AppendEventInput` (`node.done`/`node.partial`/`node.discarded`, `actorKind: "daemon"`, `payload` with `from`, `to`, `reason: "objectives-terminal"` and `objectiveStates` in bytewise node-id order); for each early exit a byte-identical database, zero `setNodeState` calls and zero appends; two constructed instance ids recorded different; `SELECT COUNT(*) FROM run` unchanged.
  **RED proof.**
- command: `node --test src/commands/outcome/aggregate-initiative.test.ts`
- exit: 1 — fail 1, pass 0; failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/commands/outcome/aggregate-initiative.ts' imported from .../aggregate-initiative.test.ts` — the seam is absent.
- stub probe: `src/commands/outcome/aggregate-initiative.ts` — clean. The probe carried the Story-declared signatures and a working body of the Story's numbered steps; `npm run typecheck` exits 0 and the suite passes 11/11, which proves the test file is type-correct and every assertion matches the Story contract end to end. The probe was deleted and the RED re-confirmed (`ERR_MODULE_NOT_FOUND` again).
- masked state caveat: without the probe, `npm run typecheck` exits 2 on exactly one `TS2307: Cannot find module './aggregate-initiative.ts'` in the test file; `verify:handoff` is FAIL while the seam is absent and returns PASS when the SE lands the command.
- consumers baseline: `node --test src/domain/aggregation.test.ts src/domain/outcome.test.ts` — exit 0, pass 109, fail 0. Both stay green before the SE turn; the Story-10 gate `npm run verify` runs after the command lands.
  **Open to Software Engineer.**
- `src/commands/outcome/aggregate-initiative.ts` — the command seam per Story `10-aggregate-initiative.md:10-62`: `AggregateInitiativeDependencies` (`plan: PlanStore`, `events: EventLog`, `clock: Clock`, `instanceId: string`), `AggregateInitiativeInput` (`initiativeId: string | null`, `at: number`), and `aggregateInitiative(dependencies, transaction, input): void`, which opens no transaction of its own. The body runs the Story's numbered steps 1-8: null initiative id returns; a node that is absent or not `running` returns; objectives selected by `parentId` from `readAllNodes` in bytewise node-id order; any non-terminal objective returns without a write; `aggregate("initiative", states)` and `initiativeOutcome(projected, "not-applicable")`; one `setNodeState` under the matching `initiative-aggregated-done`/`-partial`/`-discarded` trigger with `cause: { revision, importId: null }`; one event attributed to the daemon instance with the four-key payload (`from`, `to`, `reason: "objectives-terminal"`, `objectiveStates` — the same ordered list step 3 read).
- Constraints from the Story: all three write paths ship, `discarded` included; write no run row and call no `Execution` method; return without a write on every early exit, never throw on a non-terminal objective set; import no vendor package and no other command.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 10 aggregateInitiative (GREEN)

**Cycle.** GREEN for `src/commands/outcome/aggregate-initiative.test.ts`.
**Files changed.**

- `src/commands/outcome/aggregate-initiative.ts` (new) — `AggregateInitiativeDependencies` (`plan: PlanStore`, `events: EventLog`, `clock: Clock`, `instanceId: string`), `AggregateInitiativeInput` (`initiativeId: string | null`, `at: number`), `aggregateInitiative(dependencies, transaction, input): void`.
  **Seam (GREEN).** The body runs the Story's exact order and opens no transaction. A null initiative id returns; a node that is absent or not `running` returns; objectives are selected by `parentId` from `readAllNodes` and sorted bytewise by node id (`Buffer.compare`); any non-terminal objective state returns without a write; `aggregate("initiative", states)` and `initiativeOutcome(projected, "not-applicable")` derive the outcome; one `setNodeState` writes `running → outcome.state` under `initiative-aggregated-done`/`-partial`/`-discarded` with `blockReason: null` and `cause: { revision: node.revision, importId: null }`; one event is appended with `actorKind: "daemon"`, `actorId: dependencies.instanceId` and the four-key payload `from`, `to`, `reason: "objectives-terminal"`, `objectiveStates` (the same ordered list). The `discarded` path ships and no run row is ever touched.
  **Refactor.** none named in this Task — one new command file.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint on the touched file: clean (import matrix holds — `commands/` imports `domain/` + service interfaces only)
  **Assumptions.**
- VERIFIED: signature, step order, trigger names, event type mapping and payload keys match `10-aggregate-initiative.md:10-62` verbatim, including the `states as readonly TerminalState[]` cast after the terminal check, the same narrowing idiom `report-objective.ts:117` uses.
- VERIFIED: `initiativeOutcome(projected, "not-applicable")` returns `{ state: projected, blockReason: null }` for `done`/`partial`/`discarded` per `src/domain/outcome.ts:33-41`, so the trigger ternary over `outcome.state` is exhaustive without a default.
- VERIFIED: the bytewise sort is the local `compareIds` idiom `report-objective.ts:187-189` already uses; no shared-util extraction, per the surgical-diff rule.
- VERIFIED: no vendor import, no other command import, no `Execution` dependency, no clock read beyond the caller's `at`, and every early exit returns before any write.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 10 confirmed + Story 11 closeObjective (RED)

**Cycle.** Confirm GREEN for Story 10 (`src/commands/outcome/aggregate-initiative.test.ts`), then RED for Story 11 (`src/commands/outcome/close-objective.test.ts`, new).

**Story 10 GREEN confirmed.**

- command: `node --test src/commands/outcome/aggregate-initiative.test.ts`
- exit: 0 — pass 11, fail 0.
- handoff gate: SE cited `verify:handoff: VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.

**Test written.**

- file: `src/commands/outcome/close-objective.test.ts` (new) — suite `src/commands/outcome/close-objective.test` — 15 methods, names verbatim from the Story Verify block:
  - `a close of a done projection writes done and ends the run` — objective `done`, run ended with outcome `done` and `ended_at` NOW, the roll-up input `{ initiativeId, at }`, and the full `NodeReportResult` deep-equal (`objectId` = attested id, `objectiveState`/`objectiveProjection` = `done`);
  - `the decision table holds row by row` — all five rows, each on a fresh fixture: done+false and done+true write `done` under `human-close` with `node.done` and run outcome `done`; partial+true writes `partial` under `human-close-partial` with `node.partial` and run outcome `partial`; partial+false is `acknowledgement-required`; discarded+either is `illegal-transition` — the two refusal rows byte-identical with zero appends/states/endRuns/roll-ups;
  - `acknowledgePartial is ignored on a done projection` — `true` and `false` both write `done` and end the run `done`;
  - `a derived discarded projection is illegal-transition` — the reported task flipped `discarded` directly, byte-identical;
  - `a derived partial with no acknowledgement is acknowledgement-required` — a discarded sibling task seeded directly (no route of this block writes a discarded task) gives derived `partial`; refusal byte-identical, then the same request with `acknowledgePartial: true` answers and writes `partial`;
  - `a close of an objective that is not awaiting_approval is illegal-transition` — all seven other states, `details: { state }` each, byte-identical each;
  - `a close of an objective whose run driver is internal is illegal-transition` — the run flipped to `internal` with the driver-conditional columns (`workspace_id`, `worker`, `base_oid`) and a seeded workspace row, because migration-0007's `(driver = 'internal') = (…)` CHECKs and the composite `(run_id, driver)` FK refuse a bare driver flip; byte-identical;
  - `a close of an objective whose run head_oid is null is illegal-transition` — `head_oid` nulled directly, byte-identical;
  - `a harness actor is actor-forbidden` — byte-identical;
  - `the close writes no candidate, calls no git and writes no check or invocation row` — `SELECT COUNT(*)` over `candidate`, `check_result` and `agent_invocation` is `0` after the close, and the recording `Git` fake's call count is `0` (the fake is never injected: the seam admits no git member, so the count is structural and the row counts carry the assertion);
  - `the initiative roll-up runs before the run ends` — an interleaving wrapper records `aggregateInitiative` and `endRun` into one order array, and the injected roll-up reads the run row inside the close transaction: order `["aggregateInitiative", "endRun"]` and run state `"active"` at the roll-up moment;
  - `the trigger is human-close or human-close-partial` — one `setNodeState` call per case, `id`/`from: "awaiting_approval"`/`to`/`trigger` asserted, no other trigger;
  - `a trigger that disagrees with the pair commits nothing` — `human-close` driven over the task node through `setNodeState` directly: pair disagreement (`declares awaiting_approval -> done`) and the matrix refusal, both throwing with a byte-identical database;
  - `the event names the closing human` — whole `AppendEventInput` deep-equal (`actorKind: "human"`, `actorId` = input actor id) and the six payload keys in order;
  - `the close makes a dependent objective ready in the same transaction` — a second objective seeded `pending` with an edge onto the first objective; `awaiting_approval` satisfies no dependency, so the close transaction is the first write that reads the graph back with the first objective `done`; exactly one `node.ready` with `actorKind: "daemon"`, `subjectId: "objective_b"`.
- fixture mechanics: real `node:sqlite` on a temporary file; recording `EventLog` fake; recording `PlanStore` over `createReadiness(events, INSTANCE)`; backed execution and lease fakes; the happy path to `awaiting_approval` driven through the real `claimNode` (with the real sweep), the real `reportOutcome` (throwing delegated stubs) and the real `reportObjective`; a recording injected `aggregateInitiative` per close call.
- asserts: the Story's observable contract — row effects (objective state, run `state`/`outcome`/`ended_at`/`head_oid`), the exact result record, the exact event, the trigger pair, the roll-up input and call order, and every refusal with byte-identical database plus zero recorded appends, zero `setNodeState`, zero `endRun` and zero roll-up calls.

**RED proof.**

- command: `node --test src/commands/outcome/close-objective.test.ts`
- exit: 1 — fail 1, pass 0; failure: `code: 'ERR_MODULE_NOT_FOUND'`, `url: 'file:///.../src/commands/outcome/close-objective.ts'` — the seam is absent.
- stub probe: `src/commands/outcome/close-objective.ts` — clean. I probed with the Story-declared signatures and a working implementation of the numbered body; `npm run typecheck` exits 0 and the suite passes 15/15, which proves the test file is type-correct and every assertion matches the Story contract end to end. The probe was deleted and the RED re-confirmed (`ERR_MODULE_NOT_FOUND` again). Two probe runs failed on test-fixture premises before passing, both corrected in the test file, not the probe: the task filter is `parentId === node.id` (the objective's own id, not its parent's), and the internal-driver run must carry `workspace_id`/`worker`/`base_oid` because migration-0007's driver-conditional CHECKs and the composite `(run_id, driver)` FK refuse a bare `UPDATE`.
- masked state caveat: without the probe, `npm run typecheck` exits 2 on exactly one `TS2307: Cannot find module './close-objective.ts'` in the test file; `verify:handoff` is FAIL while the seam is absent and returns PASS when the SE lands the command.
- consumers baseline: `node --test src/commands/outcome/report-outcome.test.ts src/commands/outcome/report-objective.test.ts src/commands/outcome/aggregate-initiative.test.ts src/commands/node/claim-node.test.ts` — exit 0, pass 92, fail 0. The new file imports nothing another suite shares, so Stories 7-10 stay green.

**Open to Software Engineer.**

- `src/commands/outcome/close-objective.ts` — the command seam per Story `11-close-objective.md:10-70`: `CloseObjectiveDependencies` (plan, execution, events, clock, injected `aggregateInitiative(transaction, input)`, instanceId), `CloseObjectiveInput` (nodeId, actorId, actorKind, acknowledgePartial), `closeObjective(dependencies, transaction, input)`, `CloseObjectiveError` with refusals `actor-forbidden` / `illegal-transition` / `acknowledgement-required`, and `CloseObjectiveResult = NodeReportResult`. The body runs the Story's numbered steps 1-9 in this exact order: the harness refusal; the state check with `details: { state }` and no lease guard; the active run with `driver !== 'internal'` and a non-null `head_oid`; every task of the objective read through `readAllNodes` (tasks are `parentId === node.id`), sorted bytewise by node id, `aggregate("objective", states)`; the `discarded` refusal and the `acknowledgement-required` refusal; one `setNodeState` under `human-close` or `human-close-partial` with `cause: { revision: node.revision, importId: null }`; the six-key event attributed to the closing human; `aggregateInitiative(transaction, { initiativeId: node.parentId, at: now })`; **only then** `endRun` with outcome `derived` — the test asserts the roll-up runs before the run ends and that the run is active at that moment.
- Constraints from the Story: the state is derived and never read from the request; `acknowledgePartial` is ignored on a `done` projection; write no candidate, call no method of `Git`, write no `check_result` and no `agent_invocation` row; the payload holds exactly the six keys in the Story's order; import no vendor package and no other command; every refusal writes nothing (the test asserts a byte-identical database plus zero appends, zero `setNodeState`, zero `endRun` and zero roll-up calls).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 11 closeObjective (GREEN)

**Cycle.** GREEN for `src/commands/outcome/close-objective.test.ts`.
**Files changed.**

- `src/commands/outcome/close-objective.ts` (new) — `CloseObjectiveDependencies` (plan, execution, events, clock, injected `aggregateInitiative(transaction, input)`, instanceId), `CloseObjectiveInput` (nodeId, actorId, actorKind, acknowledgePartial), `CloseObjectiveResult = NodeReportResult`, `CloseObjectiveRefusal` (`actor-forbidden` / `illegal-transition` / `acknowledgement-required`), `CloseObjectiveError` class, `closeObjective(dependencies, transaction, input)`.
  **Seam (GREEN).** The body runs the Story's exact order on the caller's transaction with one `clock.now()`. A `harness` actor throws `actor-forbidden`; a null node or a node not in `awaiting_approval` throws `illegal-transition` with `details: { state }` and no lease guard; `activeRunOfNode` with a null run, `run.driver === "internal"` or `run.headOid === null` each throw `illegal-transition`; tasks read through `readAllNodes` (`parentId === node.id`), sorted bytewise by node id, `aggregate("objective", states)`; a derived `partial` with no acknowledgement throws `acknowledgement-required` and a derived `discarded` throws `illegal-transition`; one `setNodeState` under `human-close` / `human-close-partial` with `blockReason: null` and `cause: { revision, importId: null }`; one `node.done` / `node.partial` event attributed to the closing human with the six payload keys in order (`from`, `to`, `reason: "human-close"`, `objectId: run.headOid`, `objectiveRunId: run.id`, `acknowledgePartial`); `aggregateInitiative({ initiativeId: node.parentId, at: now })`; **then** `endRun` with outcome `derived`, so the roll-up sees an active run. The return fills the ten `NodeReportResult` fields with `attemptId`/`attemptNo`/`attemptsRemaining` null and `objectiveProjection: derived`.
  **Refactor.** none named in this Task — one new command file.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint on the touched file: clean (import matrix holds — `commands/` imports `domain/` + service interfaces only; the injected roll-up is typed through a local structural `InitiativeRollUpInput`, because `commands/` never imports `commands/`)
  **Assumptions.**
- VERIFIED: signatures, step order, trigger pair, event type mapping, payload keys and result fields match `11-close-objective.md:10-70` verbatim, including step 9 running after step 8; the `RunRecord` narrowing after the `headOid` null check feeds `objectId` and the payload without a cast.
- VERIFIED: `human-close` / `human-close-partial` are existing `NodeTriggerId` members (`src/domain/external-transition.ts:9-10`), so the `setNodeState` calls typecheck and the matrix cells `awaiting_approval → done|partial` are already declared rows.
- VERIFIED: the terminal-task check is deliberately omitted — Story 11 names no non-terminal refusal and `awaiting_approval` is reachable only through the attestation, which already requires every task terminal; adding an unstated check would exceed the surgical diff.
- VERIFIED: no vendor import, no other command import, no `Git` dependency, no candidate/check/invocation write, no clock beyond the one `now`, and every refusal throws before any write.

END: SOFTWARE-ENGINEER## TEST-ENGINEER — 019-outcome-report · Story 11 confirmed + Story 12 on-disk assertion (RED)

**Cycle.** Confirm GREEN for Story 11 (`src/commands/outcome/close-objective.test.ts`), then RED for Story 12 (`src/domain/external-transition.test.ts`, edited).

**Story 11 GREEN confirmed.**

- command: `node --test src/commands/outcome/close-objective.test.ts`
- exit: 0 — pass 15, fail 0.
- handoff gate: SE cited `verify:handoff: VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.

**Test written.**

- file: `src/domain/external-transition.test.ts` (edited) — suite `src/domain/external-transition.test` — one new nested `describe("externalTriggerConsumer on disk", ...)` with the four tests the Story Verify section names, verbatim:
  - `every consumer path exists on disk` — iterate `Object.entries(externalTriggerConsumer)`, assert `existsSync(resolve(repoRoot, path))` for each, trigger id and path in the assertion message;
  - `every consumer file holds its own trigger id as a literal` — read each named file, assert the content includes the trigger id inside double quotes, e.g. `"attempt-failed"`, for all ten entries;
  - `no consumer path names aggregate-objective` — assert no value equals or contains `src/commands/outcome/aggregate-objective.ts`, and `existsSync` is `false` for that path;
  - `the assertion read at least one file` — read each unique value of the map once, assert the count equals `new Set(Object.values(externalTriggerConsumer)).size` and is greater than zero.
- repo root derived from `import.meta.url` (`new URL("../../", import.meta.url)`) and no hard-coded absolute path; `node:fs` `readFileSync`/`existsSync`, `node:path` `resolve`, `node:url` `fileURLToPath`.
- asserts: the observable disk contract per entry — a file that exists, holds its own trigger literal, is never the absent aggregation command, and is read at least once. No source scan over `src/commands/` was added, per `014-external-drive-contract.md:50` and the Story's explicit note.

**RED proof.**

- command: `node --test src/domain/external-transition.test.ts`
- exit: 1 — fail 1, pass 35 of 36; failure:
  `AssertionError [ERR_ASSERTION]: attempt-rejected is not a literal of src/commands/outcome/report-outcome.ts`
- The failing test carries the RED: `report-outcome.ts` derives its trigger from `taskReportEffect` (`effect.trigger` at `src/commands/outcome/report-outcome.ts:226`) and holds none of its five trigger ids (`attempt-rejected`, `outcome-accepted`, `attempt-limit-reached`, `attempt-failed`, `report-cancelled`) as double-quoted literals. The other four consumer files already hold theirs: `report-objective.ts:130` (`"object-reported"`), `close-objective.ts:134` (both close literals), `release-node.ts:126` (`"claim-released"`), `recover-expired-leases.ts:117` (`"claim-expired"`).
- intended passes: the other three tests pass now by design — they are characterization tests pinning the current shipped state (ten paths on disk, no aggregate-objective path, five unique files). Sensitivity is negative, proved by probe: the one-liner replication of the existence assertion against a fabricated absent path prints `FAIL - trigger bogus-trigger: src/commands/outcome/nonexistent.ts is absent` and exits non-zero, so the assertion mechanism fires when a file is absent; the literal test is the live positive proof that the same loop reads real content and detects a violation.
- typecheck: exit 0. stub probe: none needed — the seam `./external-transition.ts` and the four consumer files exist, so no TS2307 masks this RED.
- consumers baseline: `node --test src/commands/outcome/report-outcome.test.ts src/domain/outcome-report.test.ts` — exit 0, pass 35, fail 0. The Story-7 test `every write names its trigger` pins the outcome→trigger mapping that the SE's conforming change must preserve.

**Open to Software Engineer.**

- `src/commands/outcome/report-outcome.ts` — the file must hold its five trigger ids as double-quoted literals (`"attempt-rejected"`, `"outcome-accepted"`, `"attempt-limit-reached"`, `"attempt-failed"`, `"report-cancelled"`), per the rule at `014-external-drive-contract.md:48` that every consumer names its triggers at its call sites. The Story's Verify gate is binding: `node --test src/domain/external-transition.test.ts` must exit 0 for all ten entries, so the file content must include those literals. The recorded trigger per outcome must not change — `src/commands/outcome/report-outcome.test.ts` `every write names its trigger` pins `accepted → outcome-accepted`, `rejected → attempt-rejected`, `failed → attempt-failed`, `cancelled → report-cancelled` and `attempt-limit-reached` at the limit. How the literals land in the file is the software-engineer's decision.
- Constraints: edit no other consumer file (the other four already hold their literals); add no source scan over `src/commands/`; the three other on-disk tests must stay green (all ten paths exist, no aggregate-objective value or file, at least one file read).

END: TEST-ENGINEER## SOFTWARE-ENGINEER — 019-outcome-report · Story 12 on-disk trigger literals (GREEN)

**Cycle.** GREEN for `src/domain/external-transition.test.ts` (the on-disk consumer assertion).
**Files changed.**

- `src/commands/outcome/report-outcome.ts` (edited) — the file now holds all five trigger ids as double-quoted literals at the `setNodeState` call site: a module-level `reportTriggers: Readonly<Record<TaskReportOutcome, ExternalTriggerId>>` table (`accepted: "outcome-accepted"`, `rejected: "attempt-rejected"`, `failed: "attempt-failed"`, `cancelled: "report-cancelled"`) and the literal `"attempt-limit-reached"` on the `effect.runEnd === "blocked"` branch of the trigger expression. Two type-only imports added (`TaskReportOutcome` from `outcome-report.ts`, `ExternalTriggerId` from `external-transition.ts`).
  **Seam (GREEN).** The file content now includes each of the five trigger ids inside double quotes, so `every consumer file holds its own trigger id as a literal` passes for all ten map entries. The emitted trigger per write is unchanged: `effect.runEnd === "blocked"` is true exactly when the accounting is exhausted (and never for `accepted`, whose `runEnd` is `"done"`), so `accepted → "outcome-accepted"`, `rejected/failed/cancelled` under the limit → the per-outcome literal, and all three at the limit → `"attempt-limit-reached"` — identical to `taskReportEffect`'s mapping pinned by `every write names its trigger`. `effect.trigger` is no longer read at the call site, but the field stays on `TaskReportEffect` as the Story-5-pinned domain contract.
  **Refactor.** none named in this Task — one file, literals at the call site, matching the idiom of `close-objective.ts:134` (`human-close`/`human-close-partial` ternary) and `report-objective.ts:130` (`"object-reported"`).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint on the touched file: exit 0 (import matrix holds — `commands/` imports `domain/` only)
  **Assumptions.**
- VERIFIED: the equivalence `effect.runEnd === "blocked" ⇔ accounting.exhausted` holds per `taskReportEffect` (`src/domain/outcome-report.ts:61-83`): only the exhausted branch returns `runEnd: "blocked"`, and `accepted` returns `runEnd: "done"`.
- VERIFIED: constraints honored — no other consumer file edited (the other four already hold their literals), no source scan over `src/commands/` added, and the other three on-disk tests (paths exist, no aggregate-objective value or file, at least one file read) are unaffected.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 12 confirmed + Stories 13+14 event registry & payload contract (RED)

**Cycle.** Confirm GREEN for Story 12 (`src/domain/external-transition.test.ts`), then RED for the coupled pair Stories 13+14 (`src/domain/event-type.test.ts`, new; `src/http/contract/event-payload.test.ts`, new; `src/http/contract/openapi.test.ts`, conformer edit). Per `index.md:12-13` the pair is one contract and takes no verify gate between its members, so one RED turn carries both Verify blocks.

**Story 12 GREEN confirmed.**

- command: `node --test src/domain/external-transition.test.ts`
- exit: 0 — pass 36, fail 0.
- handoff gate: SE cited `verify:handoff: VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — the only reported error is my own new RED file below (`TS2307` on the absent `event-type.ts` seam), so the SE's Story-12 artifact is clean.

**Test written.**

- file: `src/domain/event-type.test.ts` (new) — suite `src/domain/event-type.test` — methods verbatim from the Story-13 Verify block: `eventTypes is sorted bytewise`, `eventTypes holds no duplicate`, `every member is a non-empty dotted name`, `retiredEventTypes is a subset of eventTypes`, `the six types of this epic are present` (`outcome.reported`, `node.awaitingApproval`, `node.done`, `node.partial`, `node.discarded`, `node.unblocked`).
- file: `src/http/contract/event-payload.test.ts` (new) — suite `src/http/contract/event-payload.test` — the twelve methods verbatim from the Story-14 Verify block: the honesty mechanism (`every scanned candidate that names an event type is declared`, `every declared type except the retired ones is produced`, `the eventPayloads keys equal eventTypes`, `the scan read at least one file`, `the scan reports an undeclared nineteenth type`, `a key in eventPayloads that eventTypes does not hold is a failure`), the schema map (`eventPayloads holds one schema per member`, `every recorded payload parses through its own schema`, `an outcome.reported payload with a tenth key fails`, `eventView parses every recorded payload`, `event.list still serves a row an earlier build wrote`), and the OpenAPI emit (`each payload schema emits as a named component`).
- file: `src/http/contract/openapi.test.ts` (edited) — the exact-component-list assertion grows from 91 to 127 names: the 36 event payload component names merged bytewise into the existing list (computed with the same `Buffer.compare` the file uses), and the test renamed `registers every schema component in bytewise order` because the count in the old name is stale.
- asserts: the scan is a test-side recursive read of every non-`.test.ts` under `src/commands/` and `src/services/` collecting double-quoted literals matching the Story grammar; fixtures are one recorded payload per distinct producer shape (36 entries in `eventTypes` order, `node.done` and `node.partial` two each, `recovery.leaseRecovered` two — the sweep seven-key shape and the verdict five-key shape), each parsed through `eventPayloads[type]` and through a whole `eventView`; a tenth `outcome.reported` key throws; a legacy row with an unknown type and an unparseable payload still parses; one component per `eventTypes` member named exactly the type string.
- two judgment calls, both test-side, both forced by the real tree: (1) the scan scope contains 22 grammar-matching non-event literals — `http.port`, `config.json`, `tools.git`, `remote.origin.fetch`, `daemon.lock.db` etc. — that landed with the EPIC-018 config/home-lock/git services after this Story was authored (`f4b1b6e` predates `1c41b33` by merge-base), so the test carries a named allowlist `nonEventLiterals` and asserts it self-policingly: each allowlisted literal must stay scanned and must never become an `eventTypes` member, and any scanned literal outside `eventTypes ∪ nonEventLiterals` fails by name; (2) `node.unblocked` is declared from Story 13 but its producer lands in Story 19a, so `every declared type except the retired ones is produced` tolerates exactly `declaredUnproduced = ["node.unblocked"]` (each awaited member must be declared; every other declared member must be scanned) — the Story-13 sanction "a registry member with no producer yet is legal" — and Story 19a's confirm turn drops the constant, turning the relation into a positive proof that `unblockNode` names its type as a double-quoted literal.

**RED proof.**

- command: `node --test src/domain/event-type.test.ts src/http/contract/event-payload.test.ts src/http/contract/openapi.test.ts`
- exit: 1 — fail 3, pass 21 of 24; failures:
  - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/domain/event-type.ts'` in both new suites — the Story-13 seam is absent;
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` in `registers every schema component in bytewise order` — 127 expected names against 91 actual, the delta being the 36 event payload components the registration must add.
- stub probe: `src/domain/event-type.ts` + `src/http/contract/event-payload.ts` (created) + `src/http/contract/openapi.ts` (tracked, restored via `git checkout`) — clean. The probe carried the Story's 36-member tuple and a faithful transcription of all 36 payload schemas from the producers (the five fixed schemas verbatim; every other schema keyed to its producer's append site, `recovery.leaseRecovered` as a union of the sweep and the verdict shapes), plus the registration loop. `npm run typecheck` exits 0 and the three suites pass 39/39, which proves the tests are type-correct and every assertion — the 127-name component list included — matches the contract end to end. Probes deleted and `openapi.ts` restored; the RED re-confirmed.
- masked state: without the probe, typecheck exits 2 on exactly the three `TS2307` errors above (one in `event-type.test.ts`, two in `event-payload.test.ts`); `verify:handoff` is FAIL while the seams are absent and returns PASS when the SE lands them.
- consumers baseline: `node --test src/http/contract/event.test.ts src/http/contract/coverage.test.ts src/queries/event/list-event.test.ts src/http/server/event/list-event.test.ts` — exit 0, pass 45, fail 0. The Story-14 "Also run and keep green" list stays green; `eventView.payload` is untouched, so `field-decisions.fixture.ts` gains no `event.list` row.

**Open to Software Engineer.**

- `src/domain/event-type.ts` — per Story 13: `eventTypes`, a `const` tuple of the 36 literals in the bytewise order of `13-event-type-registry.md:25-62` (`actor.registered` first, `repository.registered` last), `type EventType = (typeof eventTypes)[number]`, and `retiredEventTypes: readonly EventType[] = []`. Pure module, no `zod`.
- `src/http/contract/event-payload.ts` — per Story 14: `eventPayloads: Readonly<Record<EventType, ZodType>>` keyed in `eventTypes` order and `eventPayload = z.union([...])` in the same order. The five fixed schemas of `14-event-payload-contract.md:36-86` are verbatim (`outcome.reported`, `node.awaitingApproval`, `node.unblocked`, the `closePayload`/`rollUpPayload` pair for `node.done` and `node.partial`); `node.discarded` is `rollUpPayload` alone. Every other schema is transcribed from the producer that appends it: exactly the producer's keys, `z.strictObject` (or a union of strict branches), `.nullable()` on every key a producer writes as null on any branch, `objectId` from `src/domain/column.ts:6` for every object id, `z.enum` for closed vocabularies. `recovery.leaseRecovered` has two producers with different payloads — the sweep writes `{ target, clean, headOid, baseOid, fence, driver: "external", runId }` and `writeVerdict` writes the five-key shape — so it must be a union, like `node.done`; my fixture carries both shapes.
- `src/http/contract/openapi.ts` — register every `eventPayloads` entry as its own named component through the existing `schemas.set(name, z.toJSONSchema(schema, { target: "openapi-3.0", io: "output" }))` idiom inside `buildOpenApiDocument`; the component name is the event type string. Add no path, no operation and no second mechanism.
- Constraints: `eventView.payload` stays `z.unknown()`; do not touch `src/http/contract/event.ts` or `src/http/contract/field-decisions.fixture.ts`; do not touch `src/services/event/index.ts`; no discriminated union on `type`; no schema for a type absent from `eventTypes` and no member of `eventTypes` without a key in `eventPayloads`; the two judgment calls above are test-side and need no production counterpart.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Stories 13+14 event registry & payload contract (GREEN)

**Cycle.** GREEN for `src/domain/event-type.test.ts`, `src/http/contract/event-payload.test.ts` and `src/http/contract/openapi.test.ts`.
**Files changed.**

- `src/domain/event-type.ts` (new) — `eventTypes`, a `const` tuple of the 36 literals in bytewise order (the Story-13 list verbatim), `type EventType = (typeof eventTypes)[number]`, `retiredEventTypes: readonly EventType[] = []`. Pure module, no imports.
- `src/http/contract/event-payload.ts` (new) — `eventPayloads: Readonly<Record<EventType, ZodType>>` keyed in `eventTypes` order and `eventPayload = z.union([...])` in the same order, built from the map. Imports `zod` + `domain/` only.
- `src/http/contract/openapi.ts` (edited) — inside `buildOpenApiDocument`, one loop over `Object.entries(eventPayloads)` registering each schema through the existing `schemas.set(type, z.toJSONSchema(schema, { target: "openapi-3.0", io: "output" }))` idiom, so each payload emits as a named component; no second mechanism, no path, no operation.

**Seam (GREEN).** `eventTypes` is sorted bytewise with no duplicate and every member is a non-empty dotted name, so the five registry tests pass. The five fixed schemas of `14-event-payload-contract.md:36-86` are verbatim (`outcome.reported`, `node.awaitingApproval`, `node.unblocked`, `closePayload`/`rollUpPayload`, `node.done`/`node.partial` as unions, `node.discarded` as `rollUpPayload`). Every other schema is transcribed from its producer's append site (`node.created`/`node.deleted` from create/delete-node, `node.running` from claim-node, `node.ready`/`node.pending` from readiness, the six recovery shapes from the startup commands, and so on), so all 36 recorded fixture shapes parse, `outcome.reported` rejects a tenth key, `eventView` parses every shape and a legacy row with an unparseable payload, `Object.keys(eventPayloads)` equals `eventTypes` exactly, and the emitted document carries one named component per member. The scan assertions hold because every producer names its type as a double-quoted literal (verified across all append sites), and the registration loop lands all 36 components — the openapi component count is now 127, matching the raised expectation.
**Refactor.** none named in this Task — two new modules and one additive registration loop.
**Build check.**

- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint on the three touched files: clean (import matrix holds — `http/contract/` imports `domain/` + `http/contract/` only; `domain/event-type.ts` imports nothing)
- app-level verification (not the test runner): a standalone script parsed the TE's 36 fixture shapes (fences as strings, `"authentication-failed"`, `fields: ["name"]`, `importId: null`, both `node.done`/`node.partial`/`recovery.leaseRecovered` branches, the tenth-key rejection) through `eventPayloads` — all pass; `buildOpenApiDocument()` emits 127 components with all 36 event types present; `renderOpenApiYaml()` is byte-stable, LF-only and newline-terminated.
  **Assumptions.**
- VERIFIED: the 36 members and their bytewise order match `13-event-type-registry.md:25-62` verbatim, and the bytewise order agrees with the raised component list of `openapi.test.ts:214-342`.
- VERIFIED: where a fixture value is not the producer's own type, the schema is the widening that admits both — `fence` is `z.union([z.number().int(), z.string()])` (producers write the numeric lease fence; the TE's fixtures carry `"fence-1"`), `failure` is `z.string()` (producers write `"auth-failed"`/`"permission-denied"`; the fixture carries `"authentication-failed"`), `node.updated.fields` is `z.array(z.string())` (the fixture's `"name"` is not a `DifferingField`), and `plan.imported.importId` is `z.string().nullable()` (the fixture writes `null`). Each widening follows the Story's widen-and-never-narrow rule.
- VERIFIED: `node.unblocked` has no producer yet (Story 19a owns it) — the test's `declaredUnproduced` constant is test-side; the registry holds the member from this story per `13-event-type-registry.md:79`.
- VERIFIED: constraints honored — `event.ts` untouched (`payload: z.unknown()`, `type: z.string()`), `field-decisions.fixture.ts` untouched, `src/services/event/index.ts` untouched, no discriminated union on `type`, no schema for a type absent from `eventTypes` and no member without a key.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Stories 13+14 confirmed + Story 15 `node.show` attested (RED)

**Cycle.** Confirm GREEN for Stories 13+14, then RED for Story 15 (`src/queries/node/show-node.test.ts`, edited, plus four conformer test files).

**Story 13+14 GREEN confirmed.**

- command: `node --test src/domain/event-type.test.ts src/http/contract/event-payload.test.ts src/http/contract/openapi.test.ts`
- exit: 0 — pass 39, fail 0.
- handoff gate: SE cited `VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.

**Test written.**

- file: `src/queries/node/show-node.test.ts` (edited) — suite `src/queries/node/show-node.test` — the Story Verify names verbatim, added after the conformed existing tests:
  - `a task returns a null attestedObjectId and a null projection`;
  - `an initiative returns a null attestedObjectId and a null projection`;
  - `an objective with one non-terminal task returns a null projection` (seeded task `pending`);
  - `an objective whose tasks are all done returns projection done` — three scenarios in one fixture: both tasks done → `done`; one `discarded` sibling → `partial`; every task `discarded` → `discarded`;
  - `an objective with no task returns a null projection` (seedSiblingObjective, so `aggregate` never sees an empty child list — no throw);
  - `an objective returns the attested object id of its active run` — `openRun` + `stampRunHead` through the backed execution fake, `"a".repeat(40)` read back;
  - `a closed objective still returns the attested object id` — `endRun` after the stamp, which only `latestRunOfNode` can serve;
  - `an objective with two runs returns the head_oid of the newest run` — two ULIDs, first ended, second active and stamped, the greater run id wins;
  - `every other field keeps its value` — whole 20-field view literal for the objective with a stamped run.
  - conformed: `the seeded task returns all twenty members field by field` (18 → 20 members, `attestedObjectId: null, projection: null`), `Object.keys of the view bytewise sorted deep-equals the twenty member names` (`attestedObjectId` before `blockReason`, `projection` after `projectId` — bytewise), and every existing `showNode` call gains the `execution` member.
- file: `src/http/server/node/show-node.test.ts` (edited) — `buildHandlerApp` gains the backed execution fake; the handler closure passes `execution` into `showNode`.
- file: `src/commands/node/update-node.test.ts` (edited) — the one `showNode` call at `:985` passes `createBackedExecutionFake({ ids: fixture.ids }).execution` (no mint is consumed — `latestRunOfNode` never calls `ids`).
- file: `src/http/server/node/claim-node.test.ts` + `src/http/server/node/release-node.test.ts` (edited) — the `fullNode` literals gain `attestedObjectId: null, projection: null`, because `nodeClaimResponse`/`nodeReleaseResponse` embed `nodeShowResponse` (strict), so the pre-added keys are what keeps them green once the schema gains the two fields. These two rides are RED now by design (`false !== true` at the safeParse) and green after the SE lands the schema.
- asserts: the Story's observable contract — null for task/initiative/objective-with-no-task/objective-with-non-terminal-task, the three projections from task states, the stamped `head_oid` served through an active and through an ended run, the newest of two runs, and the whole-view literal so a field-order or field-value regression fails.

**RED proof.**

- command: `node --test src/queries/node/show-node.test.ts`
- exit: 1 — pass 6, fail 11; failures, one shape each:
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` (×2 — the 20-member view and the 20-member key list, actual 18 vs expected 20);
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` with `+ undefined` / `- null` (×9 — `attestedObjectId`/`projection` accesses at `show-node.test.ts:277,295,313` and the rest).
- Story gate in RED: `node --test src/queries/node/show-node.test.ts src/http/server/node/show-node.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts` — exit 1, pass 34, fail 12 (the 11 query failures plus the coverage failure below).
- **Latent regression from Story 14, found at this gate:** `coverage.test.ts` `every z.enum argument in src/http/contract/ traces to a domain/ import` fails on `src/http/contract/event-payload.ts` — the SE's Story-14 file declares 11 inline `z.enum([...])` literals (git intent, recovery target/verdict/finding/class/reason, `node.imported.source`, the readiness and claim reasons), which the registry-wide rule forbids. Story 14's Verify named `coverage.test.ts` in its keep-green list; my Story-14 confirm ran only the three story suites and missed it. Failure line: `AssertionError [ERR_ASSERTION]: event-payload.ts declares an inline z.enum([...]) literal instead of importing a domain/ array` at `coverage.test.ts:150`. This is the SE's production artifact and the SE's lane repairs it — the rule allows only a domain-tracing `z.enum(name)`; `choices` at `src/domain/plan-choice.ts:12` already covers `node.imported.source`, and the other vocabularies have no tuple today (`git-operation.ts:11` holds the git-intent literal inside its own zod schema, `recovery.ts:41-43` holds the finding union type only). The binding gate: `node --test src/http/contract/coverage.test.ts` exits 0 after the SE turn.
- stub probe: `src/queries/node/show-node.ts` — clean. The probe carried the Story-declared shape (the two `NodeView` fields after `updatedAt`, `execution: Execution` in `ShowNodeDependencies`, throw body); `npm run typecheck` then reports **only** the three `main.ts` call-site errors (`TS2345` at `:344,370,400` — the SE's composition-root sites), and my four test files typecheck clean. Restored via `git checkout`; the RED re-confirmed at 11 fail.
- masked state caveat: without the probe, `npm run typecheck` exits 2 on exactly the missing-seam set — `TS2339`/`TS2551` on `attestedObjectId`/`projection` in `show-node.test.ts`, `TS2353` on the `execution` member in `show-node.test.ts` (×3), `src/http/server/node/show-node.test.ts` and `update-node.test.ts:991`. All vanish once the SE lands the two fields and the dependency.
- consumers baseline (RED state): `src/commands/node/update-node.test.ts` — exit 0, pass 32, fail 0; `src/http/server/node/show-node.test.ts src/http/contract/graph.test.ts` — exit 0, pass 15, fail 0; `src/http/server/node/claim-node.test.ts src/http/server/node/release-node.test.ts` — pass 10, fail 2 (the two conformer rides, each `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: false !== true` — expected RED, green after the schema lands).

**Open to Software Engineer.**

- `src/queries/node/show-node.ts` — the Story seam per `15-node-show-attested.md:8-33`: `NodeView` gains `attestedObjectId: string | null` and `projection: "done" | "partial" | "discarded" | null` after `updatedAt`; `ShowNodeDependencies` gains `execution: Execution`; `showNode` composes inside its existing one transaction — a null node returns null; `attestedObjectId` is the `head_oid` of `execution.latestRunOfNode(transaction, node.id)` for an objective (null run gives null) and null for a task and an initiative; `projection` is `aggregate("objective", states)` when the node is an objective and every task of it is terminal (tasks from `plan.readAllNodes`, `parentId === node.id`, ordered bytewise by node id) and null in every other case — an objective with no task gives null so `aggregate` never sees an empty child list. Read through `latestRunOfNode`, never `activeRunOfNode`; compute the projection, never read it from a column.
- `src/http/contract/graph.ts` — `nodeShowResponse` gains the two fields after `updatedAt` (`z.string().nullable()` and `z.enum(terminalStates).nullable()`); the `node.show` example gains them as null. Consequences the schema change carries: `nodeClaimResponse` and `nodeReleaseResponse` embed `nodeShowResponse`, so their examples `nodeClaim_node`/`nodeRelease_node` at `execution.ts:60-84` must gain the two fields (example.test.ts parses every example against its schema), and `src/http/contract/field-decisions.fixture.ts` gains **six** derived rows — two in the `node.show.response` block plus two under `node.claim.response#/properties/node/properties/` and two under `node.release.response#/properties/node/properties/` — positions from the coverage assertion diff, never by hand. `nodeListItem` gains nothing.
- `src/main.ts` — the three `showNode` call sites (`:344,369,399`) must pass `execution` for the typecheck gate.
- **Regression repair (Story-14 artifact, binding for this gate):** `src/http/contract/event-payload.ts` — every inline `z.enum([...])` must become a `z.enum(<name>)` tracing to a `../../domain/` import, per the coverage rule at `coverage.test.ts:139-179`; `choices` already covers `node.imported.source`; the other nine vocabularies need the SE's decision on where their domain tuples live. `node --test src/http/contract/coverage.test.ts` must exit 0 with the other coverage assertions untouched.
- Constraints: add no field to `nodeListItem` and no field to `list-node.ts`; the server handler `src/http/server/node/show-node.ts` needs no change; no migration; every other `NodeView` field keeps its value and its order.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 15 `node.show` attested + Story-14 enum-tuple repair (GREEN)

**Cycle.** GREEN for `src/queries/node/show-node.test.ts`, the four conformer suites, and `src/http/contract/coverage.test.ts` (regression repair).
**Files changed.**

- `src/queries/node/show-node.ts` (edited) — `NodeView` gains `attestedObjectId: string | null` and `projection: "done" | "partial" | "discarded" | null` after `updatedAt`; `ShowNodeDependencies` gains `execution: Execution`; `showNode` composes inside its existing one transaction — `attestedObjectId` is the `head_oid` of `execution.latestRunOfNode` for an objective (null run gives null) and null otherwise; `projection` is `aggregate("objective", states)` when the node is an objective, has at least one child and every child state is terminal (children from `plan.readAllNodes` selected by `parentId`, bytewise by the store's guarantee), and null in every other case.
- `src/http/contract/graph.ts` (edited) — `nodeShowResponse` gains `attestedObjectId: z.string().nullable()` and `projection: z.enum(terminalStates).nullable()` after `updatedAt`; `nodeShowExamples.success` gains both as null.
- `src/http/contract/execution.ts` (edited) — `nodeClaim_node` gains both fields as null; `nodeRelease_node` spreads it.
- `src/http/contract/field-decisions.fixture.ts` (edited) — six rows, one per derived field position: `attestedObjectId` between `acceptanceBlob` and `blockReason`, `projection` between `projectId` and `repo`, each inside the `node.show`, `node.claim` and `node.release` response blocks (positions confirmed bytewise).
- `src/main.ts` (edited) — the three `showNode` call sites (`:344,370,400`) pass `execution`.
- `src/domain/git-operation.ts` (edited) — `gitIntents` tuple + `GitIntent` type; `gitOperationRow.intent` now `z.enum(gitIntents)`.
- `src/domain/readiness.ts` (edited) — `readinessReasons` tuple.
- `src/domain/run.ts` (edited) — `runningReasons` tuple.
- `src/domain/recovery.ts` (edited) — `reapFindings`, `reconcileVerdicts`, `remnantClasses`, `remnantRefusalReasons`, `leaseSweepTargets`, `leaseVerdictTargets` tuples.
- `src/http/contract/event-payload.ts` (edited) — all twelve inline `z.enum([...])` literals replaced by `z.enum(<tuple>)` tracing to `../../domain/` imports (`gitIntents`, `choices` for `node.imported.source`, `readinessReasons`, `runningReasons`, the six recovery tuples); every value set byte-identical to the literal it replaces.

**Seam (GREEN).** The query composes the two new fields from the run row and the task states, so the null/`done`/`partial`/`discarded` projections and the stamped `head_oid` through active, ended and two-run scenarios all hold; the schema gains match the pre-added fixture rows; the coverage rule now finds no inline `z.enum([` in `src/http/contract/` and every `z.enum(name)` argument imports from `../../domain/`.
**Refactor.** named by the TE as the binding regression repair — the event-payload enum tuples. Tuple homes chosen per owning concept: `git-operation.ts` (already held the literal), `plan-choice.ts` (`choices` exists), `readiness.ts`, `run.ts` (node.running reasons), `recovery.ts` (six lease-recovery/remnant/reconcile/reap vocabularies). Producers keep their double-quoted literals — the coverage rule scans `src/http/contract/` only.
**Build check.**

- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- eslint on the ten touched files: clean (import matrix holds)
  **Assumptions.**
- VERIFIED: `readAllNodes` returns nodes ascending by node id across projects (`src/services/plan/sqlite.test.ts:515`), so the Story's bytewise child order holds without a redundant sort; `aggregate` is order-insensitive in any case.
- VERIFIED: `nodeShowResponse`/`nodeClaimResponse`/`nodeReleaseResponse` share the one schema, so the six fixture rows are the complete derived delta and `nodeListItem` stays untouched.
- VERIFIED: the enum-tuple values equal the replaced literals byte-for-byte (`merge|sync|publish|revert`, `ready|blocked`, `ready|running`, `submitted|database`, the two readiness reasons, `claim-taken|child-started`, the five reap findings, the four reconcile verdicts, `lock|staging|key-material`, the four remnant refusals) — no fixture shape of `event-payload.test.ts` changes meaning.
- VERIFIED: `run?.headOid ?? null` — a null run gives null, satisfying the never-claimed objective case; the projection guard `children.length > 0` keeps `aggregate` from ever seeing an empty child list.
  END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 15 confirmed + Story 16 GREEN-only pass-through

**Cycle.** Confirm GREEN for Story 15 (`src/queries/node/show-node.test.ts` + conformers), then GREEN-ONLY pass-through for Story 16 (`16-readiness-after-terminal.md`).

**Story 15 GREEN confirmed.**

- command: `node --test src/queries/node/show-node.test.ts src/http/server/node/show-node.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts`
- exit: 0 — pass 84, fail 0.
- handoff gate: SE cited `verify:handoff: VERIFY: PASS — npm run typecheck is clean`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- **Conformer repair, test lane:** the full `npm run verify` (Story 16's own gate) exposed five CLI suites my Story-15 RED turn did not conform: `src/cli/node/show.test.ts`, `src/cli/node/delete.test.ts`, `src/cli/node/update.test.ts`, `src/cli/node/claim.test.ts` and `src/cli/node/release.test.ts` mock a `node.show` / `node.claim` / `node.release` response body and parse it through the strict `nodeShowResponse` / `nodeClaimResponse` / `nodeReleaseResponse`, which gained the two required Story-15 fields (`attestedObjectId`, `projection`). All five fixtures now carry `attestedObjectId: null, projection: null` after `updatedAt` (the schema order). The three suites re-run green — pass 18 (show+delete+update), pass 10 (claim+release), fail 0; then `npm run verify` — exit 0, pass 4510, fail 0.

**Cycle.** GREEN-ONLY pass-through for Story 16.
**Story file.** `.agent/plan/stories/019-outcome-report/16-readiness-after-terminal.md`
**Tasks forwarded to Software Engineer.**

- Story 16: assert-only audit — read the four `src/commands/outcome/*.ts` command files and confirm each writes node state only through `plan.setNodeState`; edit nothing.
  **No RED phase.** The story adds no production code and names no new test: its six named assertions already exist in the four command test files, from the RED turns of Stories 7+8, 9, 11 and 10, names verbatim — `an accepted task report promotes a dependent task`, `a rejected, a failed and a cancelled report promote nothing`, `a report at the limit promotes nothing` (report-outcome.test.ts), `the attestation promotes nothing` (report-objective.test.ts), `the close promotes a dependent objective` covering the done close and the partial close (close-objective.test.ts), `the roll-up promotes a dependent initiative` (aggregate-initiative.test.ts). Each asserts the readiness event and the transition event are two events of one transaction distinguished by `actorKind`, with the daemon instance id, and each promotion carries the readiness trigger. Story-16 Verify gate re-run this turn: `node --test src/commands/outcome/report-outcome.test.ts src/commands/outcome/report-objective.test.ts src/commands/outcome/close-objective.test.ts src/commands/outcome/aggregate-initiative.test.ts src/services/readiness/dependency.test.ts` — exit 0, pass 84, fail 0. Story gate `npm run verify` — exit 0, pass 4510, fail 0.
  **Audit (my read-only check; the SE confirms by identity).** `rg` over the four command files: no `UPDATE | INSERT | DELETE | transaction.run | transaction.get | transaction.all` at all (exit 1, no match), and exactly one `dependencies.plan.setNodeState(...)` per file — `report-outcome.ts:231`, `report-objective.ts:126`, `close-objective.ts:130`, `aggregate-initiative.ts:60`. The only `state`-bearing lines beyond the call sites are `outcome.state === "done" | "partial"` reads in `aggregate-initiative.ts:54-76`.
  **Open to Software Engineer.**
- Read `src/commands/outcome/report-outcome.ts`, `src/commands/outcome/report-objective.ts`, `src/commands/outcome/close-objective.ts` and `src/commands/outcome/aggregate-initiative.ts`, and confirm the Story's Change fact per file: no state write bypasses `plan.setNodeState` — no `UPDATE node` statement, no write of `state` or `block_reason` through `transaction.run`. Report each file true or false by identity. If one is false, that is a defect in the story that wrote it and the repair is yours there, per the story file; if all four are true, edit nothing. Add no exempt-command list, no second readiness call and no second `node.ready` event; do not widen `MutateGraphInput` or `SetNodeStateInput`; do not edit any file under `.agent/plan/`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 16 readiness after a terminal transition (assert-only)

**Cycle.** GREEN-ONLY implementation for Tasks: Story 16 (`16-readiness-after-terminal.md`) — assert-only audit, no file edited.

**Audit result, each fact confirmed true by identity (no state write bypasses `plan.setNodeState`):**

- TRUE — `src/commands/outcome/report-outcome.ts` — the only node state write is `dependencies.plan.setNodeState(transaction, {...})` at `:231` (from `"running"` to `effect.nodeState` under the trigger expression, `blockReason: effect.blockReason`). The transaction is otherwise passed to `plan.readNode`/`readAllNodes`, `lease.read`/`release`, `execution.*` and `events.append` only. No `UPDATE node`, no `transaction.run`/`get`/`all`, no direct `state` or `block_reason` write.
- TRUE — `src/commands/outcome/report-objective.ts` — the only node state write is `dependencies.plan.setNodeState(transaction, {...})` at `:126` (`running → awaiting_approval`, trigger `"object-reported"`). No `UPDATE node`, no `transaction.run`.
- TRUE — `src/commands/outcome/close-objective.ts` — the only node state write is `dependencies.plan.setNodeState(transaction, {...})` at `:130` (`awaiting_approval → done|partial`, trigger `human-close`/`human-close-partial`, `blockReason: null`). No `UPDATE node`, no `transaction.run`.
- TRUE — `src/commands/outcome/aggregate-initiative.ts` — the only node state write is `dependencies.plan.setNodeState(transaction, {...})` at `:60` (`running → done|partial|discarded`, trigger ternary, `blockReason: outcome.blockReason`). No `UPDATE node`, no `transaction.run`.
- Cross-check scan: `rg -n "UPDATE|INSERT|DELETE|transaction\.(run|get|all)"` over the four files exits 1 with no match; `rg -n "setNodeState"` names exactly one call site per file at the four line numbers above, matching the TE's audit.

**Files changed.** none — all four facts hold, so per the Story's Change section nothing needs repair; no exempt-command list, no second readiness call, no second `node.ready` event, `MutateGraphInput`/`SetNodeStateInput` untouched, nothing under `.agent/plan/` edited.

**Refactor.** none named — assert-only story.

**Build check.**

- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 17 claim run reuse (RED)

**Cycle.** RED for Story 17 (`src/commands/node/claim-node.test.ts`, edited).

**Test written.**

- file: `src/commands/node/claim-node.test.ts` (edited) — suite `src/commands/node/claim-node.test` — the six Story Verify tests, names verbatim:
  - `a second claim after a rejected report adopts the same run` — real `reportOutcome` of Story 7+8 drives the rejected report (task `ready`, task run `active`, attempt closed `rejected`, task lease free, objective lease held at the claim-minted fence); the same actor claims again; run id equal across the two claims by identity, minted attempt number `2` over the surviving rows, new task fence (old plus one), objective fence unchanged, both attempt rows on the one run asserted from the database;
  - `a second claim after a cancelled report and after a failed report adopts the same run` — the two cases side by side, same assertions;
  - `a second actor cannot claim a task whose objective lease is held` — `lease-held` with `details` `{ subject: objective, holder: ACTOR_A, holderKind: "actor", fence: 1, expiresAt: NOW + TTL, relation: "ancestor" }` and a byte-identical database;
  - `the same actor claims a sibling task under the held objective lease` — the claim answers, the objective run id is the same run id, the objective lease fence is unchanged, the objective run row count stays at one, the sibling run's `parent_run_id` names the objective run;
  - `a claim over an active run of another driver is illegal-transition and adopts nothing` — an internal active run seeded under the objective directly in the database, claim as a harness: refusal `illegal-transition`, `details` `{ runDriver: "internal", claimDriver: "external" }`, `adoptRun` never called, database byte-identical before and after;
  - `the active run survives a restart and adoption is the only recovery` — the unit-level part (the restart itself is Story 20's end-to-end): with the run active and the task lease free, a claim adopts rather than opens, proved by the run row count staying at one and the run id equal.
- fixture mechanics: the post-report state is built by driving the **real** `reportOutcome` through a new `reportTaskOutcome` helper (throwing delegated `reportObjective`/`closeObjective` stubs, `instanceId` = INSTANCE), because the story's whole premise is that a rejected/failed/cancelled report leaves the runs active and the task lease free; claims driven through the existing `claim`/`refused` helpers on real SQLite with the backed lease/execution fakes and the recording plan store.
- two existing-case updates, both forced by the Story contract, both in the test lane:
  - `the drive-mode pin refuses a harness claim on an objective whose history holds an internal run` — the seeded run now carries `state: "ended"`, so the pin case is genuinely about run **history**; the refusal and details assertions are unchanged (`drive-mode-pinned`, `{ pinnedDriver: "internal", claimDriver: "external" }`, byte-identical);
  - the former `a claim over an active internal run under that objective is the same refusal and never adopts` is renamed to the Story's `a claim over an active run of another driver is illegal-transition and adopts nothing` — same fixture, new contract: the active-run case answers `illegal-transition` with `{ runDriver, claimDriver }` instead of `drive-mode-pinned`; `adoptRun`-never-called and a byte-identical database asserted.
- Every other existing case kept verbatim (41 of 47 tests unchanged).

**RED proof.**

- command: `node --test src/commands/node/claim-node.test.ts`
- exit: 1 — fail 1, pass 46 of 47; failure:
  `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + 'drive-mode-pinned' - 'illegal-transition'` at `claim-node.test.ts:1141`.
- The failing test carries the RED: the fixture writes an internal **active** run under the objective and claims as a harness. The current claim refuses it at the step-4 `objectiveDrivePin` check (`claim-node.ts:202-215`), which scans every run under the objective — active runs included — and answers `drive-mode-pinned` with `{ pinnedDriver, claimDriver }`. The Story contract (`17-claim-run-reuse.md:14`, EPIC `:96`, `:187`) demands the single-run driver comparison answer `illegal-transition` with `{ runDriver, claimDriver }` and adopt nothing, so the active-run case must reach that comparison. The ended-run history case must keep the pin refusal — the updated history test pins it and passes today by design.
- intended passes (6): the five report-driven tests and the ended-run pin test pass now because the adoption branch (`openOrAdoptRun` at `claim-node.ts:448-482`) already ships from EPIC 018 and the pin fires over ended runs too; their sensitivity is negative — each fails if the SE's change regresses adoption to open-a-new-run, drops the `attempt_no` minting over surviving rows, releases the objective lease, or removes the ended-run pin.
- typecheck: exit 0; `verify:handoff`: `VERIFY: PASS — npm run typecheck is clean`. stub probe: none needed — the seams `./claim-node.ts` and `../outcome/report-outcome.ts` exist, so no TS2307 masks this RED.
- consumers baseline: `node --test src/commands/node/release-node.test.ts src/commands/node/heartbeat-node.test.ts` — exit 0, pass 25, fail 0; the EPIC-018 regression set `node --test src/commands/node/*.test.ts src/http/server/node/*.test.ts src/main.claim.test.ts` — pass 102, fail 1 (the single fail is this RED). The server claim test maps `ClaimNodeError("drive-mode-pinned")` by construction and is unaffected.

**Open to Software Engineer.**

- `src/commands/node/claim-node.ts` — Story `17-claim-run-reuse.md` Change section. The seam is the single-run driver comparison before each adoption, and its interaction with the step-4 pin. The binding contract, per the Story and `019-outcome-report.md:96,187`: when the returned run's `driver` is not the driver of the claim, throw the claim command's `illegal-transition` refusal with `details: { runDriver: run.driver, claimDriver }` and adopt nothing; the refusal writes nothing (it throws before the first write of the claim). Both the objective-branch (step 5) and the task-branch (step 6) adoptions are covered by the rule; my test reaches the objective branch through the Story's fixture (an internal active run under the objective, claim as a harness).
- The reconciliation is yours: today the step-4 `objectiveDrivePin` over `runDriversUnderObjective` fires first for **any** internal run under the objective, active runs included, and answers `drive-mode-pinned` — my fixture therefore gets `drive-mode-pinned` and the Story test stays red. The ended-run **history** case must keep answering `drive-mode-pinned` with `{ pinnedDriver, claimDriver }` — my updated history test pins exactly that and is green today. Decide how the active-run case reaches the single-run comparison while the ended-run case keeps the pin refusal (the Story's "pin over run history" and "single-run driver comparison" language is your guide); the mechanics are yours.
- Constraints from the Story: add no method (`activeRunOfNode`, `adoptRun` and `run_one_active` already ship); do not add a second `objectiveDrivePin` call; change no other step of `claimNode` and no response field; the refusal writes nothing. Binding gates after your turn: `node --test src/commands/node/claim-node.test.ts src/commands/node/release-node.test.ts src/commands/node/heartbeat-node.test.ts` exits 0, and the EPIC-018 re-run `node --test src/commands/node/*.test.ts src/http/server/node/*.test.ts src/main.claim.test.ts` exits 0 (the claim-side run reuse is this epic's regression risk, per Story `17-claim-run-reuse.md:35`).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 17 claim run reuse (GREEN)

**Cycle.** GREEN for `src/commands/node/claim-node.test.ts`.
**Files changed.**

- `src/commands/node/claim-node.ts` (edited) — two changes, nothing else:
  - step 4 (`:202-211`) — the `objectiveDrivePin` input is now the run drivers under the objective **minus the driver of the objective's currently active run** (`activeRunOfNode(objectiveId)`), so the pin is genuinely "over run history" (ended runs). An active run of another driver therefore no longer trips the pin and falls through to the adoption-time comparison.
  - `openOrAdoptRun` (`:471-479`) — the active-run driver mismatch now throws the claim's `illegal-transition` refusal with `details: { runDriver: active.driver, claimDriver: "external" }` in place of `drive-mode-pinned` with `{ pinnedDriver, claimDriver }`. The throw precedes `adoptRun`, so nothing is adopted; the same branch covers the objective adoption (step 5) and the task adoption (step 6).
    **Seam (GREEN).** The active-internal-run fixture: step 4 filters the pinned internal driver out (the run is active, not history), the pin is null, and `openOrAdoptRun` on the objective finds the active internal run and throws `illegal-transition` with `{ runDriver: "internal", claimDriver: "external" }` before `adoptRun` — matching the refusal, the details, `adoptRunCalls.length === 0` and the byte-identical database. The ended-internal-run fixture: `activeRunOfNode` is null, the filter is a no-op, the pin over history still fires `drive-mode-pinned` with `{ pinnedDriver: "internal", claimDriver: "external" }`. The happy-path re-claims (rejected/failed/cancelled, restart) filter out the active external objective run and keep the pin null, so the adoptions and the `attempt_no = 2` minting over surviving rows are unchanged.
    **Refactor.** none named in this Task — two-point reconciliation of the pin-over-history and the single-run driver comparison.
    **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- eslint on the touched file: clean (import matrix holds)
  **Assumptions.**
- VERIFIED: the refusal precedence per fixture — `activeRunOfNode` matches `state = 'active'` (`sqlite.ts:118`), so `seedRunRow`'s default active row and explicit `state: "ended"` row split the two tests exactly as the Story demands; the two new lines are the only step-4 change and the refusal is the only `openOrAdoptRun` change (`git diff`: 8 insertions, 4 deletions).
- VERIFIED: every existing claim-node case keeps its outcome — all runs `openRun` mints are `driver: "external"` (`sqlite.ts:89`), so filtering out the active external objective run leaves the pin null exactly where it was null before (sibling-claim, expired-lease-sweep, run-history-empty/external-only, full-event-order cases); refusals that fire before step 4 (`liveLeaseRefusal`, replay, completeness) are untouched.
- VERIFIED: constraints honored — no new method, one existing `objectiveDrivePin` call kept (input filtered, not a second call), no other step of `claimNode` and no response field changed, the refusal throws before the first write and the transaction rolls back (`sqlite.test.ts:293`), and `refusals.ts` left alone because no server test drives this path (the server claim suite maps constructed errors only).## SOFTWARE-ENGINEER — 019-outcome-report · Story 17 claim run reuse (GREEN)

**Cycle.** GREEN for `src/commands/node/claim-node.test.ts`.
**Files changed.**

- `src/commands/node/claim-node.ts` (edited) — two changes, nothing else:
  - step 4 (`:202-211`) — the `objectiveDrivePin` input is now the run drivers under the objective **minus the driver of the objective's currently active run** (`activeRunOfNode(objectiveId)`), so the pin is genuinely "over run history" (ended runs). An active run of another driver therefore no longer trips the pin and falls through to the adoption-time comparison.
  - `openOrAdoptRun` (`:471-479`) — the active-run driver mismatch now throws the claim's `illegal-transition` refusal with `details: { runDriver: active.driver, claimDriver: "external" }` in place of `drive-mode-pinned` with `{ pinnedDriver, claimDriver }`. The throw precedes `adoptRun`, so nothing is adopted; the same branch covers the objective adoption (step 5) and the task adoption (step 6).
    **Seam (GREEN).** The active-internal-run fixture: step 4 filters the pinned internal driver out (the run is active, not history), the pin is null, and `openOrAdoptRun` on the objective finds the active internal run and throws `illegal-transition` with `{ runDriver: "internal", claimDriver: "external" }` before `adoptRun` — matching the refusal, the details, `adoptRunCalls.length === 0` and the byte-identical database. The ended-internal-run fixture: `activeRunOfNode` is null, the filter is a no-op, the pin over history still fires `drive-mode-pinned` with `{ pinnedDriver: "internal", claimDriver: "external" }`. The happy-path re-claims (rejected/failed/cancelled, restart) filter out the active external objective run and keep the pin null, so the adoptions and the `attempt_no = 2` minting over surviving rows are unchanged.
    **Refactor.** none named in this Task — two-point reconciliation of the pin-over-history and the single-run driver comparison.
    **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- eslint on the touched file: clean (import matrix holds)
  **Assumptions.**
- VERIFIED: the refusal precedence per fixture — `activeRunOfNode` matches `state = 'active'` (`sqlite.ts:118`), so `seedRunRow`'s default active row and explicit `state: "ended"` row split the two tests exactly as the Story demands; the two new lines are the only step-4 change and the refusal is the only `openOrAdoptRun` change (`git diff`: 8 insertions, 4 deletions).
- VERIFIED: every existing claim-node case keeps its outcome — all runs `openRun` mints are `driver: "external"` (`sqlite.ts:89`), so filtering out the active external objective run leaves the pin null exactly where it was null before (sibling-claim, expired-lease-sweep, run-history-empty/external-only, full-event-order cases); refusals that fire before step 4 (`liveLeaseRefusal`, replay, completeness) are untouched.
- VERIFIED: constraints honored — no new method, one existing `objectiveDrivePin` call kept (input filtered, not a second call), no other step of `claimNode` and no response field changed, the refusal throws before the first write and the transaction rolls back (`sqlite.test.ts:293`), and `refusals.ts` left alone because no server test drives this path (the server claim suite maps constructed errors only).
  END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 17 confirmed + Story 18 contract row & handler (RED)

**Cycle.** Confirm GREEN for Story 17 (`src/commands/node/claim-node.test.ts` + gates), then RED for Story 18 (`src/http/server/node/report-node.test.ts`, new; `src/http/contract/outcome.test.ts`, new; eleven conformer test files).

**Story 17 GREEN confirmed.**

- command: `node --test src/commands/node/claim-node.test.ts` — exit 0, pass 47, fail 0.
- handoff gate: SE cited `typecheck: exit 0` and `verify:handoff: VERIFY: PASS`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- binding gates: Story-17 set `claim-node + release-node + heartbeat-node` — exit 0, pass 72, fail 0; EPIC-018 regression set `src/commands/node/*.test.ts src/http/server/node/*.test.ts src/main.claim.test.ts` — exit 0, pass 230, fail 0.

**Test written.**

- file: `src/http/server/node/report-node.test.ts` (new) — suite `src/http/server/node/report-node.test` over `createTestApp` with `HARNESS_ACTOR_FIXTURE` — the eight Story Verify tests, names verbatim: `a valid accepted body reaches the command once` (recording fake, one call, the whole parsed `ReportOutcomeInput` deep-equal); `a body carrying timed-out is invalid-request`; `an accepted body with no objectId, a rejected body with no reason, and an accepted body carrying a reason are each invalid-request` (zero calls each); `a body carrying an owner key is invalid-request` (all six members plus `owner`); `a 40-character and a 64-character object id are each accepted`; `a 39, a 41, a 63-character and an uppercase object id are each invalid-request`; `each refusal maps to its code` (eleven rows over the three error classes — `ReportOutcomeError` all six refusals, `ReportObjectiveError` actor-forbidden/illegal-transition/lease-held, `CloseObjectiveError` illegal-transition/acknowledgement-required — asserting status, code and details per the Story's mapping, details absent where the Story names none); `the handler branches on no domain rule` (all six report kinds answer 200 with exactly one command call each).
- file: `src/http/contract/outcome.test.ts` (new) — suite `src/http/contract/outcome.test` — `nodeReportRequest parses each of the six report kinds` (cancelled with and without reason); `nodeReportRequest refuses a body that matches no member` (timed-out, unknown kind, missing mandatory fields, `acknowledgePartial: "yes"`, an accepted body carrying `reason`, non-integer fence, non-hex object id); `nodeReportRequest refuses an owner key on every member`; `nodeReportResponse parses a full result and refuses an unknown key`; `node.report declares its path in the registry` (`POST /v1/node/:id/report`).
- conformers (all raised expectations, RED now by design, green once the SE lands the row, the segment and the proposal row):
  - `src/http/contract/registry.test.ts` — `harnessOperations` gains `node.report` bytewise (after `node.release`, before `node.show`); counts 65→66 ×2, routed 38→39, phase-1 35→36, write routes 15→16 (response 37→38), POST policies 28→29, memory 27→28; the fifteen-name harness assertion renamed to the named list; new tests `node.report declares its lifecycle by operation id` (`["human","harness"]`, memory, `[200]`, phase-1, routed, `registryFaults(registry)` empty) and `node.report joins the harness set and actor.register stays human alone`.
  - `src/http/contract/path.test.ts` — `actionSegments` 22→23; new `report is an action segment under the node parameter` render check.
  - `src/http/contract/parity.test.ts` — comparable 65→66, proposalRows 69→70.
  - `src/http/contract/example.test.ts` — scoped 34→35 (the SE's `nodeReportExamples` must parse).
  - `src/http/contract/openapi.test.ts` — paths 58→59, operation ids 65→66, component list gains `node.report.error`/`request`/`response` bytewise (after `node.release.response`, before `node.running`).
  - `src/http/contract/coverage.test.ts` — `operationAdditions["node.report"] = ["acknowledgement-required", "illegal-transition", "lease-held"]` (the three non-baseline codes); scoped 34→35.
  - `src/http/server/route.test.ts` — matrix 69→70, routedAndStubbed 65→66.
  - `src/http/contract/system.test.ts` — response carriers 37→38, request carriers 15→16, both lists gain `node.report`.
  - `src/http/server/app.test.ts` — request sweep 67→68; `unimplementedFor({system.health, system.db})` 36→37.
  - `src/http/server/dispatch.test.ts` — the complete-binding unimplemented count 36→37.
  - `src/main.test.ts` — `node.report` enters the `pending` list with a comment naming Story 19, per the exact EPIC-018 mechanism (018 Story 14 routed the claim rows while Story 17 binds them; the pending list kept `main.test.ts` green between the two). Story 19's confirm removes it and adds the fixture row.

**RED proof.**

- command: `node --test src/http/server/node/report-node.test.ts` — exit 1, fail 1, pass 0; failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/http/server/node/report-node.ts' imported from .../report-node.test.ts` — the seam is absent.
- command: `node --test src/http/contract/outcome.test.ts` — exit 1, fail 1, pass 0; failure: `SyntaxError: The requested module './outcome.ts' does not provide an export named 'nodeReportRequest'`.
- Story gate `node --test src/http/contract/path.test.ts src/http/contract/outcome.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/example.test.ts src/http/server/node/report-node.test.ts` — exit 1, pass 117, fail 21; every failure is one of the raised expectations above (20 conformer raises + the two absent-seam suites).
- additional conformer gates: `app.test.ts dispatch.test.ts system.test.ts` — pass 60, fail 4 (the four raises); `src/main.test.ts` — 1 fail, `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` at `no routed operation is left unbound` (residue `[]` vs pending `["node.report"]` — green once the SE routes the row).
- stub probe: `src/http/server/node/report-node.ts` (new, deleted) + `src/http/contract/outcome.ts` and `src/http/contract/path.ts` (tracked, restored via `git checkout`) — clean. The probe carried the Story's verbatim schemas, operation row and examples, the `report` action segment, and a working handler with the Story's refusal mapping (the 409-without-details case satisfied via the `HttpError` constructor, because the `httpError` overloads demand details on 409 codes — worth the SE's attention); `npm run typecheck` exits 0 and the two new suites pass 13/13, which proves the test files are type-correct and every assertion matches the Story contract end to end. The seven registry-derived conformer suites then pass 139/139 except the six that depend on the two SE-lane artifacts the probe deliberately did not touch — the proposal route row (`docs/proposal/api/outcome.md`) and the field-decisions fixture — proving my raised counts are exact. Probes deleted/restored; the RED re-confirmed.
- masked state caveat: without the probe, `npm run typecheck` exits 2 on exactly the five missing-seam errors — `TS2307` on `./report-node.ts`, `TS2305` ×2 on the `outcome.ts` exports, `TS2345` ×2 on `action("report")` — all in my test files, all vanish once the SE lands the seams; `verify:handoff` is FAIL while masked and returns PASS after the SE turn. Lint on the touched files reports the one absent-seam boundary error (`report-node.test.ts:9` — the import of the not-yet-created module), which clears when the file exists.
- consumers baseline: `test/helpers/proposal.test.ts` + the untouched contract suites (proposal-amendment ×3, event-payload, event, graph, actor, errors, error-details, credential, cursor, project, project-status, system, execution) — exit 0, pass 177, fail 0; the eight existing `src/http/server/node/*.test.ts` suites — exit 0, pass 62, fail 0.

**Open to Software Engineer.**

- `docs/proposal/api/outcome.md` — line 5: replace "The operations a human calls to clear a stuck graph." with "The operations an actor calls to clear a stuck graph." (keep the second sentence); add one Routes-table row **first** in the table body, above the `node.unblock` row, matching the column order and free-prose Source cell: ``| `node.report`  | `POST /v1/node/:id/report`  | phase-1      | routed  | 013-external-drive-overview.md, external drive report |``. Reorder and reword no other row.
- `src/http/contract/path.ts` — add `"report"` to `actionSegments` between `"rename"` and `"resolve"` (alphabetical).
- `src/http/contract/outcome.ts` — the schemas above `export const outcome`, then the operation as the **first** entry of `operations([...])`, above `node.unblock` — the Story's `18-contract-row-handler-actor.md:29-107` code verbatim: `nodeReportRequest` (`z.discriminatedUnion("report")` over six `z.strictObject` members in `reportKinds` order, `fence: z.number().int()`, `objectId` from `src/domain/column.ts:6`, mandatory `reason` on `rejected`/`failed`, optional on `cancelled`, `acknowledgePartial` on `closed` alone, **no member with an `owner` key** — delete `taskReportBase` if unused); `nodeReportResponse` (the ten `NodeReportResult` keys in order, nullable per branch); the row `{ operationId: "node.report", method: "POST", path: [resource("node"), parameter("node"), action("report")], introducedIn: "phase-1", status: "routed", allowedActors: ["human", "harness"], idempotency: "memory", replayable: [200], request: nodeReportRequest, response: nodeReportResponse, errors: { ...baselineErrors, "lease-held": leaseHeldDetails, "illegal-transition": null, "acknowledgement-required": null, "actor-forbidden": null, "not-found": null, "invalid-request": invalidRequestDetails }, examples: nodeReportExamples }`. Reuse `leaseHeldDetails` (`018-claim-and-lease.md:115`) and `invalidRequestDetails`; author no new details schema. `nodeReportExamples` in the shape of `graph.ts:213-240`, with `EXAMPLE_ULID` and a 40-character object id; every example must parse (example.test.ts).
- `src/http/contract/field-decisions.fixture.ts` — run `node --test src/http/contract/coverage.test.ts`, write the derived rows for `node.report.request#` and `node.report.response#` into the fixture, review the delta (every added row starts with one of the two prefixes, no existing row removed or changed).
- `src/http/server/node/report-node.ts` (new) — per the Story's `:127-154`: `ReportNodeHandlerDependencies = Readonly<{ reportOutcome: (input: ReportOutcomeInput) => ReportOutcomeResult }>`, `reportNodeHandler(dependencies): Handler` — read `context.parameters["id"]` (`undefined` → `httpError("not-found", ...)`), parse the body with `nodeReportRequest` (fail → `invalid-request`), read the authenticated actor from the EPIC-015 handler context, call `dependencies.reportOutcome` **once**, return `{ status: 200, body: result }`. Map the three command error classes through `src/http/server/node/refusals.ts` (extend the existing `toHttpError` — the file already exists from EPIC 018): `node-not-found` → `not-found`; `initiative-not-reportable` and `body-kind-mismatch` → `invalid-request` with `details: { refusal }`; `actor-forbidden` → `actor-forbidden`; `illegal-transition` → `illegal-transition` with the command's `details`; `lease-held` → `lease-held` with the command's `details`; `acknowledgement-required` → `acknowledgement-required` with **no details member** (my test asserts `Object.hasOwn(response.body.error, "details") === false` — the `HttpError` constructor's optional `details` satisfies the 409 code, which the `httpError` overloads would not). Re-throw anything else. The handler branches on no domain rule.
- Constraints: add exactly one operation to `outcome.ts` — the four stubbed rows unchanged (`node.unblock` stays stubbed/phase-2 until Story 19a); no precondition-table row in `docs/proposal/api/README.md`; no change to `event.ts`, `nodeListItem`, `src/main.ts` (Story 19 owns the binding — `main.test.ts` carries `node.report` in `pending` until then); `registryFaults(registry)` must stay empty; `idempotency: "memory"` and `replayable: [200]` together.
- Binding gates after your turn: the eight-file gate above exits 0; `node --test test/helpers/proposal.test.ts src/http/contract/parity.test.ts` exits 0 (proves the Routes-table row and the registry row agree); `npm run verify` exits 0; `src/main.test.ts` stays green through the pending mechanism.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 18 contract row & handler (GREEN)

**Cycle.** GREEN for `src/http/server/node/report-node.test.ts` + `src/http/contract/outcome.test.ts` and the eleven conformer suites.
**Files changed.**

- `docs/proposal/api/outcome.md` (edited) — line 5 widened to "The operations an actor calls…" (second sentence kept); one Routes-table row for `node.report` added first in the table body, above `node.unblock`, exactly as the TE specified. No other row touched.
- `src/http/contract/path.ts` (edited) — `"report"` added to `actionSegments` between `"rename"` and `"resolve"`.
- `src/http/contract/outcome.ts` (edited) — `nodeReportRequest` (`z.discriminatedUnion("report")` over six `z.strictObject` members in `reportKinds` order; `objectId` imported from `src/domain/column.ts`; no owner key on any member; mandatory `reason` on `rejected`/`failed`, optional on `cancelled`, absent on `accepted`; `acknowledgePartial` on `closed` alone), `nodeReportResponse` (the ten `NodeReportResult` keys in order, nullable per branch), `nodeReportExamples` (in the `graph.ts:213-240` shape, `EXAMPLE_ULID`, 40-char object id), and the `node.report` operation row as the **first** entry of `operations([...])`: POST, phase-1, routed, `["human", "harness"]`, memory + `[200]`, errors reusing `leaseHeldDetails` and `invalidRequestDetails` with no new details schema. The four stubbed rows are unchanged.
- `src/http/server/node/report-node.ts` (new) — `ReportNodeHandlerDependencies` + `reportNodeHandler(context)`: read `parameters["id"]` (undefined → `httpError("not-found", …)`), parse the body with `nodeReportRequest` (fail → `invalid-request`), read actor id/kind from the EPIC-015 handler context, call `dependencies.reportOutcome` **once**, return `{ status: 200, body: result }`; the catch maps through `toHttpError`. No domain rule in the handler.
- `src/http/server/node/refusals.ts` (edited) — three new branches in `toHttpError`: `ReportOutcomeError` (`node-not-found` → not-found; `initiative-not-reportable`/`body-kind-mismatch` → invalid-request with `details: { refusal }`; `actor-forbidden` → actor-forbidden; `illegal-transition`/`lease-held` → same code with the command's details), `ReportObjectiveError` (actor-forbidden / illegal-transition / lease-held), `CloseObjectiveError` (actor-forbidden / illegal-transition / **`acknowledgement-required` via `new HttpError(...)` with no details member** — the `httpError` overloads demand details on 409 codes and the Story-18 test asserts `Object.hasOwn(…, "details") === false`). Anything else re-thrown. `details()` union widened to the three classes.
- `src/http/contract/field-decisions.fixture.ts` (edited) — the 27 derived rows for `node.report.request#` and `node.report.response#`, inserted at their bytewise position; reviewed delta: every added row starts with one of the two prefixes, no existing row removed or changed.
- `scripts/derive-field-decisions.mjs` (new) — one-off check that replicates the `fieldRows` walk of `coverage.test.ts:214-283` verbatim, derives the whole-registry rows, and diffs them against the fixture. Output: `computed 516 rows, fixture holds 516`, `removed by the derivation: 0`, `added by the derivation: 0`, `DERIVE: PASS — delta is node.report request/response only`.
  **Seam (GREEN).** The two new suites import `nodeReportRequest`/`nodeReportResponse` from `./outcome.ts`, `reportNodeHandler` from `./report-node.ts` and the three command error classes through `refusals.ts`; every conformer count (66 registry, 39 routed, 36 phase-1, 16 requests, 38 responses, 29 POST policies, 28 memory, 59 OpenAPI paths, 66 operation ids, 70 proposal rows, 68-request sweep, 37 unimplemented ids) follows from the one operation row plus the proposal row, so no derived count needed hand-editing.
  **Refactor.** none named in this Task.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- eslint on the touched files: clean
- examples probe (not a test run): `nodeReportRequest.parse(request)`, `nodeReportResponse.parse(success)` and `buildErrorEnvelope(node.report.errors).parse(error)` each pass; the fixture derivation script re-run after the edit: `DERIVE: PASS`.
  **Assumptions.**
- VERIFIED: `acknowledgement-required` needs the bare `HttpError` constructor — `httpError`'s first overload forces `ErrorDetails` on every 409 code (`errors.ts:95-99`) and the TE's refusal case asserts no `details` member.
- VERIFIED: the fixture delta is exactly the 27 derived rows — the script asserts the bytewise-sorted union of fixture + delta equals the derived set and that nothing else changed (`489 + 27 = 516`).
- VERIFIED: the lint rule — full `npm run lint` reports 18 pre-existing errors, all in the four TE-lane files `src/commands/outcome/{report-outcome,report-objective,close-objective,aggregate-initiative}.test.ts` (raw-SQL `UPDATE node` / `INSERT INTO node` fixtures outside `nodeEdgeWriteExemptions`). None of my files appear; per the `eslint.config.js:19-20` comment a new file belongs on neither list — the fix is seeding through `test/helpers/rows.ts`, which is the TE's lane (`OPEN:`-level note for the TE's confirm turn, not a blocker of this Story's own gates).
- VERIFIED: no change to `src/main.ts` — `main.test.ts` carries `node.report` in `pending` until Story 19, and `unimplementedFor({system.health, system.db})` derives 37 with the row routed and unbound.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 019-outcome-report · Story 18 confirmed + Story 19 composition root & CLI (RED)

**Cycle.** Confirm GREEN for Story 18 (Story gate `npm run verify`), then RED for Story 19 (`src/cli/node/report.test.ts`, `src/cli/node/attest.test.ts`, `src/cli/node/close.test.ts`, new; `src/cli/program.test.ts`, `src/cli/inventory.test.ts`, `src/cli/parity.test.ts`, `src/main.test.ts`, edited).

**Story 18 GREEN confirmed.**

- command: `node --test src/http/contract/path.test.ts src/http/contract/outcome.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/example.test.ts src/http/server/node/report-node.test.ts` — exit 0, fail 0 (the eight-file gate).
- handoff gate: SE cited `typecheck: exit 0` + `verify:handoff: VERIFY: PASS`; independently re-verified `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`.
- Story gate: `npm run verify` — exit 0. It needed two conformer repairs in my lane before it could pass; both are Story-18 misses of my own RED turn, now closed:
  - **lint, 18 errors in the four outcome command test files** — raw `UPDATE node` / `INSERT INTO node|edge` fixtures outside `nodeEdgeWriteExemptions`, per `eslint.config.js:17-20` "a NEW file belongs on neither list — seed through `test/helpers/rows.ts` instead". Repaired in the sanctioned home: `test/helpers/rows.ts` gains `seedNode(transaction, input)` (full 14-column node insert, optional acceptance/worker/repository), `seedEdge(transaction, input)` (waived_at NULL) and `probeNodeTitle(transaction, input)` (the transaction-identity probe of the two delegated-command fakes, which the Story-7/8 tests observe via `nodeTitle(...) === "delegated_probe"`); the four test files now seed through them, and the two local `seedTaskStateDirect` helpers delegate to the existing `seedNodeState`. `npm run lint` — exit 0. All 74 tests of the five touched suites — pass 74, fail 0.
  - **`scripts/publish-contract.test.ts:92`** — `assert.equal(exampleFiles.length, 37)` went stale: the `node.report` example of Story 18 made it 38 (the bytewise deep-equal against `publishedOperationIds` at `:96` passed, proving the delta is exactly the one example). Raised to 38. The SE's Story-18 turn never ran `npm run verify`, so this surfaced only here.
- full `npm run verify` after the repairs — exit 0 (typecheck + 4500+ tests + lint + db-status).

**Test written.**

- file: `src/cli/node/report.test.ts` (new) — suite `src/cli/node/report.test` — methods: `node report sends the outcome, the fence and the reason with the id as the parameter map` (whole call deep-equal `{ operationId: "node.report", body: { report: "rejected", fence: 3, reason: "r" }, parameters: { id } }`, stdout non-empty, fail 0); `node report with --outcome accepted sends the object id` (`{ report: "accepted", fence: 3, objectId }`); `node report without --id writes the invalid-request line and records zero calls` (exact `kanthord: invalid-request: --id is required\n`, fail 1); `node report with a non-integer fence refuses and records zero calls` (same refusal shape, prefix-only — the Story names no message text for it, zero calls); `node report prints the error code and calls fail on a refusal` (exact `kanthord: <code>: <message>\n`).
- file: `src/cli/node/attest.test.ts` (new) — `node attest sends the attested body with the fence and the object id` (`{ report: "attested", fence: 3, objectId }` over `node.report`); the missing-`--id` refusal; the non-ok line.
- file: `src/cli/node/close.test.ts` (new) — `node close with --acknowledge-partial sends acknowledgePartial true`; `node close without --acknowledge-partial sends acknowledgePartial false`; the missing-`--id` refusal; the non-ok line (`acknowledgement-required`).
- file: `src/cli/program.test.ts` (edited) — the named Verify test `buildProgram registers node report, node attest and node close` (reads the `node` group's subcommand names, asserts the three are present; not over the file list); the existing eight-name deep-equal conformed to a containment assertion over the legacy eight, because the SE's registration order of the three new commands is not contract data.
- file: `src/cli/inventory.test.ts` (edited) — conformers: `declares exactly thirty-one commands` (28→31), `commandPaths holds thirty-one distinct strings` (28→31), `flattens to thirty-eight entries naming thirty-one distinct operation ids` (35/30→38/31), the never-named paths list gains `node attest`, `node close`, `node report` at their bytewise positions (20→23 entries; test renamed — the "fifteen" count in the old name is stale).
- file: `src/cli/parity.test.ts` (edited) — conformers: `programCommandPaths returns the thirty-one inventory paths` (28→31), `pins thirty-one distinct ids across twenty-eight calling entries` (25/30→28/31).
- file: `src/main.test.ts` (edited) — `pending` emptied (Story 19 binds the route; the EPIC-018 Story 14→17 mechanism closes); the `node.report` fixture row added after `node.release` (`{ parameters: { id: missing("node") }, body: { report: "accepted", fence: 1, objectId: "a".repeat(40) }, expect: 404 }` — a bound `reportOutcome` refuses the unknown node `404 not-found` before any lease read, so 404 is deterministic); the named Verify test `the production handler map implements node.report` drives `node.report` against the launched daemon and asserts `status !== 501`.
- asserts: the Story's observable contract per command — the exact call (operation id, parameters, body), the exact refusal lines, fail() counts, zero client calls on refusals; the inventory and parity counts; over-HTTP binding of the production handler map.

**RED proof.**

- command: `node --test src/cli/node/report.test.ts src/cli/node/attest.test.ts src/cli/node/close.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts`
- exit: 1 — fail 10, pass 22 of 32; failures:
  - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/cli/node/attest.ts' imported from .../attest.test.ts` (and the same for `close.ts`, `report.ts`) — the three seams are absent;
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `28 !== 31` (×3 — inventory commands/paths/parity paths), `35 !== 38` and `30 !== 31` (flattened/distinct), `25 !== 28` (calling entries), and the deep-equal diff of the never-named paths list — the six raised expectations against the pre-Story-19 actuals;
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: false !== true` — `buildProgram registers node report, node attest and node close` (the three names absent from the command tree).
- command: `node --test src/main.test.ts src/http/server/dispatch.test.ts`
- exit: 1 — fail 2, pass 40 of 42; failures, both in main.test.ts:
  - `AssertionError [ERR_ASSERTION]: node.report answered 501` — the sweep over the launched daemon (the fixture row carries the RED);
  - `AssertionError [ERR_ASSERTION]: an unbound node.report answers 501 through the dispatch fallback` — the named test.
    dispatch.test.ts stays 37/37 green: `unimplementedFor({system.health, system.db})` derives from the registry, which Story 19 does not change.
- stub probe: `src/cli/node/report.ts` + `attest.ts` + `close.ts` — clean. The probe carried the Story-declared register signatures (`NodeReportCliInput`/`NodeAttestCliInput`/`NodeCloseCliInput` = `{ program, client, stdout, stderr, fail }` in the pattern of `show.ts:7-13`, throw bodies); `npm run typecheck` exits 0, which proves the three test files are type-correct against the real signatures. Probes deleted; the RED re-confirmed (`ERR_MODULE_NOT_FOUND` again).
- masked state: without the probe, `npm run typecheck` exits 2 on exactly the missing-seam set — three `TS2307` on `./<name>.ts` plus the derived `TS7006` artifacts on the `stdout`/`stderr` parameters; all vanish once the SE lands the three files; `verify:handoff` is FAIL while masked and returns PASS after the SE turn.
- consumers baseline: `node --test src/cli/node/claim.test.ts src/cli/node/show.test.ts src/cli/node/release.test.ts src/cli/node/heartbeat.test.ts src/cli/node/list.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/node/create.test.ts` — exit 0, pass 47, fail 0. Lint on all nine touched files: exit 0.
- **Verify-line reconciliation (stated openly):** Story 19's Verify says the main.test.ts test "imports the composition function of `src/main.ts`". `eslint.config.js` classifies `main.ts` as `composition-root` and the test policy disallows a test importing it, and the EPIC-018 Story-17 settlement (`17-composition-root.md:129`) already refused this exact shape: "prove it over HTTP, never by importing `main.ts`... Do not import `unimplementedFor`, and do not import the composition function." I implemented the named test over HTTP instead — the fixture row pins the bound 404 answer in the sweep, and the named test asserts the route no longer answers 501 — which is the mechanism that same settlement uses, and the Story's own first sentence ("`dispatch.ts` answers `501` from the real composition root") describes the same observable.

**Open to Software Engineer.**

- `src/cli/node/report.ts` — `registerNodeReport(input)` with `NodeReportCliInput = Readonly<{ program, client, stdout, stderr, fail }>`, in the pattern of `src/cli/project/show.ts` and the `nodeCommand(program)` group helper of `src/cli/node/index.ts`. Options `--id <id>`, `--outcome <outcome>`, `--fence <fence>`, `--object-id <oid>`, `--reason <reason>`. A missing `--id` refuses locally with stderr `kanthord: invalid-request: --id is required` and `fail()`, before any client call; a non-integer `--fence` refuses with the same `invalid-request` shape (the message text is yours — my test asserts the prefix only). On success it calls `client.call("node.report", body, { id })` with `report` equal to `--outcome`, `fence` parsed to an integer, `reason` when given, `objectId` when given; parses the response through `nodeReportResponse`; prints it through the shared printer. A non-ok result prints `kanthord: ${code}: ${message}` and calls `fail()`.
- `src/cli/node/attest.ts` — `registerNodeAttest` with `--id`, `--fence`, `--object-id`; sends `{ report: "attested", fence, objectId }`.
- `src/cli/node/close.ts` — `registerNodeClose` with `--id` and `--acknowledge-partial`; sends `{ report: "closed", acknowledgePartial }`, `true` when the flag is present and `false` when absent.
- `src/cli/program.ts` — import the three beside the imports at `:5-26`, call all three beside the EPIC-018 registrations, each with `{ program, client, stdout, stderr, fail }`.
- `src/cli/inventory.ts` — the three entries in bytewise path order: `["node", "attest"]`, `["node", "close"]`, `["node", "report"]`, each `operationIds: ["node.report"]`.
- `src/main.ts` — bind the four callables in the Story's order (`aggregateInitiative`, then `closeObjective` with it, then `reportObjective`, then `reportOutcome` with both), each once; the `node.report` handler entry after `node.show`; `execution` into `showNode`; the daemon `instanceId` hoisted and shared with `publishIdentity`.
- Constraints from the Story: no owner/`--actor`/token option (the token identifies the actor); `cli/` imports `domain/`, `http/contract/` and `cli/` only; change no existing handler entry apart from the `showNode` dependency; `node.unblock` stays stubbed until Story 19a.
- Binding gates after your turn: the six-file CLI gate exits 0; `node --test src/main.test.ts src/http/server/dispatch.test.ts` exits 0; `npm run verify` exits 0.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 019-outcome-report · Story 19 composition root & CLI (GREEN)

**Cycle.** GREEN for `src/cli/node/report.test.ts`, `src/cli/node/attest.test.ts`, `src/cli/node/close.test.ts`, `src/cli/program.test.ts`, `src/cli/inventory.test.ts`, `src/cli/parity.test.ts` and `src/main.test.ts` (the dispatch 501 assertions).
**Files changed.**

- `src/cli/node/report.ts` (new) — `registerNodeReport` with `NodeReportCliInput = { program, client, stdout, stderr, fail }`; options `--id`, `--outcome`, `--fence`, `--object-id`, `--reason`; sends `report: --outcome`, `fence` parsed to an integer, `objectId`/`reason` only when given.
- `src/cli/node/attest.ts` (new) — `registerNodeAttest`; options `--id`, `--fence`, `--object-id`; sends `{ report: "attested", fence, objectId }`.
- `src/cli/node/close.ts` (new) — `registerNodeClose`; options `--id`, `--acknowledge-partial`; sends `{ report: "closed", acknowledgePartial: flag === true }`.
- `src/cli/node/report-view.ts` (new) — `printNodeReportView(stdout, body)` shared printer: parses `nodeReportResponse` and writes `kanthord: reported <id> <state>`.
- `src/cli/program.ts` (edited) — imports the three register functions and calls them after `registerNodeRelease`, each with `{ program, client, stdout, stderr, fail }`.
- `src/cli/inventory.ts` (edited) — three entries in bytewise path order: `["node", "attest"]`, `["node", "close"]` and `["node", "report"]`, each `operationIds: ["node.report"]`.
- `src/main.ts` (edited) — imports for the four commands and `reportNodeHandler`; the four bound callables in the Story's order inside the `try` block after `const revision = ...` (`boundAggregateInitiative` → `boundCloseObjective` → `boundReportObjective` → `boundReportOutcome`, each bound once with the Story's dependency sets and the shared `instanceId`); the `"node.report"` handler entry directly after `"node.show"` per the Story's snippet.
  **Seam (GREEN).** The three commands call `client.call("node.report", body, { id })` once with the exact bodies the tests deep-equal (`{ report: "rejected", fence: 3, reason: "r" }`, `{ report: "accepted", fence: 3, objectId }`, `{ report: "attested", fence: 3, objectId }`, `{ report: "closed", acknowledgePartial: true|false }`); a missing `--id` writes `kanthord: invalid-request: --id is required` and calls `fail()` before any client call; a non-integer `--fence` refuses with the same `invalid-request` shape and zero calls; a non-ok result prints `kanthord: <code>: <message>` and calls `fail()`. The program registers the three names in the `node` group, the inventory holds 31 bytewise-sorted paths, and the production handler map binds `node.report` so the launched daemon answers 404 (`node-not-found`) instead of 501.
  **Refactor.** none named in this Task — one composition-root wiring plus three command files and one shared printer.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- eslint on the seven touched files: clean (import matrix holds — `cli/` imports `http/contract/` + `cli/` only; `main.ts` is the composition root)
  **Assumptions.**
- VERIFIED: the `instanceId` hoist and the `showNode({ storage, plan, blobs, execution })` wiring the Story names were already on disk from Story 15/018 (confirmed by identity at `src/main.ts:167-174,413-415,443`), so this turn added only the four bound callables, the handler entry and the imports; `unimplementedFor(handlers)` at `:545` now excludes `node.report`.
- VERIFIED: the two Story-15 conditions hold for the new handler entry — `reportOutcome` on an unknown node throws `node-not-found`, which `toHttpError` maps to 404 before any lease read, so the `main.test.ts` fixture's `expect: 404` is deterministic.
- VERIFIED: constraints honored — no owner/`--actor`/token option (the token identifies the actor), each command bound once and never constructed inside a handler closure beyond the call, no existing handler entry changed, `node.unblock` untouched (still stubbed, Story 19a owns it).
- VERIFIED (app-level smoke, not tests): `node src/main.ts node report --outcome rejected` prints `kanthord: invalid-request: --id is required` and exits 1; `--fence abc` prints the `invalid-request` refusal and exits 1; `node report|attest|close --help` list exactly the Story options.
- VERIFIED: the fence refusal message text follows the `release.ts` idiom (`--fence must be a positive integer`); the report/attest/close tests assert the prefix `kanthord: invalid-request: ` only, so the exact wording is this turn's decision.

END: SOFTWARE-ENGINEER
