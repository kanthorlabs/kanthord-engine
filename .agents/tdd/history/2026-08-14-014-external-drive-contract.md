---
epic: .agents/plan/epics/014-external-drive-contract.md
opened: 2026-08-14
opener: test-engineer
base-ref: a3937d87d2837d1859cc311bd4e3b849a96e96d5
---

# Implementation cycle — 014-external-drive-contract

Pulled from EPIC: `.agents/plan/epics/014-external-drive-contract.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/*.test.ts \
>   src/domain/external-transition.test.ts \
>   src/domain/node-trigger.test.ts \
>   src/domain/revision-guard.test.ts \
>   src/domain/plan-completeness.test.ts \
>   src/queries/plan/validate-plan.test.ts \
>   && echo "PASS EPIC-014"
> ```
>
> The four new files are named explicitly beside the domain glob. `node --test` fails on a path that does not exist, so the Proof fails before the epic is built rather than collecting a green sibling suite. `src/domain/*.test.ts` is taken whole for the reason `008-project-and-plan.md:57` gives. `src/queries/plan/validate-plan.test.ts` is present because `completenessFindings` replaces two blocks that query reaches.
>
> Hermetic coverage required beyond the Proof:
>
> - `transitions.length` still equals 56, and the full cross product of eight states at three levels still asserts every cell. Exactly one cell flips: `ready → pending` is `true` at all three levels, and every other cell holds the boolean EPIC 002 pinned.
> - `src/domain/transition.test.ts` asserts that `pending` is written only from `blocked` and from `ready`, at all three levels. A third source fails it.
> - `choiceVerdict` returns `suggested: "submitted"` and `submitted.legal: true` for a `ready` node with a structural change and `containmentMovable: true`. It returns `submitted.legal: false` for the same node with `containmentMovable: false`, so the lease guard is asserted to survive the flip.
> - Every row of `externalTransitions` names a cell where `canTransition(level, from, to)` returns `true`. A row that names an illegal cell fails.
> - The trigger id set of `externalTransitions` is asserted exactly, each id appears once, and every precondition is asserted field by field against the six rows above. The assertion pins six external ids at the close of this epic. EPIC 018 raises it to eight and EPIC 019 raises it to ten, and each one edits this assertion in its own change.
> - The `object-reported` row is asserted to carry `leaseFence: "valid"` and `actorKind: "harness"`, and the `outcome-accepted` row is asserted to carry `reportedObjectId: "required"`.
> - `externalTriggerConsumer` is asserted total over the trigger ids, and every value is asserted to start with `src/commands/`. `object-reported` is asserted to name `src/commands/outcome/report-objective.ts`, and no value names `src/commands/outcome/aggregate-objective.ts`.
> - `objectiveDrivePin` returns null for an empty `runDrivers` list, and null for a list whose every member equals `claimDriver`. Both drivers are asserted in both directions. A list holding the other driver returns a refusal naming that driver as `pinnedDriver`, and a mixed list returns the first differing member.
> - Every row of `internalTransitions` names a legal cell: `canTransition(level, from, to)` returns `true` for every member of its `levels` list. A row that names an illegal cell at any level fails.
> - The internal trigger id set is asserted exactly, and it holds the fifteen ids above, each once. The `levels`, the `from` and the `to` of each row are asserted field by field. Every `levels` list is non-empty and holds no duplicate, and it is ordered `initiative`, `objective`, `task`.
> - The internal id set and the external id set are asserted disjoint, so `NodeTriggerId` resolves one row per trigger.
> - `triggerTransition` is total over `NodeTriggerId`. It returns the declared triple for an internal trigger, and it returns a one-member `levels` list holding the declared `level` for an external trigger. Every external trigger and every internal trigger is asserted.
> - `externalTriggerConsumer` holds no internal trigger id as a key, asserted against the internal id set.
> - The union of the external ids and the internal ids covers every pair that a command of EPICs 016, 018, 019 and 110 writes. The assertion lists those pairs by level, `from` and `to`, and asserts each one is the triple of at least one row.
> - `findingScope` is asserted total over `findingCodes`: every code has a scope, and no key exists that `findingCodes` does not hold. The completeness set is asserted to equal exactly the two codes.
> - `completenessFindings` is asserted directly over both `subject` values, for the empty-parent case, the satisfied case and the empty-input case. It returns the same findings as the two inline blocks it replaces, asserted through the unchanged `plan-validate`, `plan-candidate` and `validate-plan` suites.
> - `revisionGuardFor` is asserted over every member of `nodeWriteKinds`, and the result set is asserted to equal `{ node, project }` with no third value.
> - `runRow` refuses an `external` run that carries a `workspaceId`, a `worker` or a `baseOid`, and refuses an `internal` run that omits any of the three. Both directions are asserted per field.
> - `attemptRow` refuses an `external` attempt that carries a `providerId`, a `providerModel`, a `timeoutMs` or a `baseOid`, and refuses an `internal` attempt that omits any of the four. Both directions are asserted per field.
> - `planRevisionRow` refuses a `node-write` revision that carries an `importId`, a `submittedBlob` or a `choicesBlob`, and refuses an `import` revision that omits any of the three. `acceptedBlob` is asserted required under both origins.
> - `leaseRow` refuses a row where `owner` is null and `ownerKind` is set, and refuses the reverse.
> - `src/domain/event.ts` still exports two actor kinds, and `src/services/storage/migration-0003-execution-and-journal.test.ts:403-421` and `src/services/storage/migration-0002-graph-and-plan.test.ts:207-217` both stay green with no edit. This epic changes no `docs/proposal/database/` file, so no migration parity test moves.
> - Each refinement above carries a SQL obligation on its owning epic: `run` and `attempt` and `lease` on EPIC 018, `plan_revision` on EPIC 017. Each owning epic adds one or more table `CHECK` clauses whose conjunction repeats the refinement, and one domain-to-DDL parity assertion beside `assertClauseAgrees` at `src/services/storage/schema-parity.test.ts:49`. A refinement that ties several columns to a discriminator takes one clause per column, so a partially populated row is refused on every evaluation order: `plan_revision` takes three, `run` three and `attempt` four. A refinement that only makes two columns null together is symmetric and takes one clause, which is why `lease` takes one. `src/services/storage/schema-parity.test.ts:104-118` proves table-name parity only, so it proves no column, no nullability and no cross-column constraint.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 014-external-drive-contract · Story 01 — state-machine notes

**Cycle.** RED for Story `01-state-machine-notes` (`node --test src/domain/transition.test.ts`).
**Test written.**

- file: `src/domain/transition.test.ts` (edited) — suite: `src/domain/transition.test` — methods: `every matrix row of state-machine.md equals its transitions row`, `five notes name the external trigger`
- asserts: the parity test parses `docs/proposal/phase-1/state-machine.md` rows that start with a pipe, split on pipe, drop first/last, trim, keep six cells whose first two are `/^`([a-z_]+)`$/`, asserts the row count is exactly 36, and per row: the matching `transitions` entry exists, its `note` equals the sixth cell exactly, and the three marks equal `row.task`/`row.objective`/`row.initiative`. The five-pairs test asserts that for `running`/`ready`, `running`/`awaiting_approval`, `running`/`done`, `awaiting_approval`/`done` and `awaiting_approval`/`partial`, the `transitions` row note contains the substring `external`.
  **RED proof.**
- command: `node --test src/domain/transition.test.ts`
- exit: 1 — failure: `AssertionError [ERR_ASSERTION]: note for running→ready does not name the external trigger` (at `src/domain/transition.test.ts:307`); `ℹ tests 16`, `ℹ pass 15`, `ℹ fail 1`
- The parity test passes on the unamended tree, which is the Story's documented pin: it turns red the moment a document note and a code note drift apart. The five-pairs test is the sensitivity carrier for this Story's change: none of the five notes names the external drive today.
- stub probe: n/a — no missing seam; `npm run typecheck` exits 0 with the new tests in place.
  **Open to Software Engineer.**
- `src/domain/transition.ts` — the five `note` strings at the rows `running`→`ready` (line 140), `running`→`awaiting_approval` (156), `running`→`done` (164), `awaiting_approval`→`done` (276) and `awaiting_approval`→`partial` (284). Each becomes byte-identical to its document note below, per the Story file's fenced blocks. Change no boolean and no row order (`transitions.length` stays 56).
- `docs/proposal/phase-1/state-machine.md` — the same five notes at lines 78, 80, 81, 95 and 96, plus the three aggregation cells at lines 39 and 40: the Task `Reaches done` cell, the Objective `Reaches done` cell and the Objective `Reaches partial` cell. Copy each fenced block of `01-state-machine-notes.md` verbatim. The parity test asserts document note equals code note, so both sides change together. Do not touch line 47 or line 70 (Stories 10 and 2 own them).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 01 — state-machine notes

**Cycle.** GREEN for `src/domain/transition.test.ts` (RED turn: `note for running→ready does not name the external trigger` at `transition.test.ts:307`).
**Files changed.**

- `src/domain/transition.ts` (edited) — the five `note` strings at rows `running`→`ready`, `running`→`awaiting_approval`, `running`→`done`, `awaiting_approval`→`done`, `awaiting_approval`→`partial`; each now byte-identical to the amended document note and contains the substring `external`. No boolean, no row order, no row count changed (`transitions.length` stays 56).
- `docs/proposal/phase-1/state-machine.md` (edited) — the same five notes at lines 78, 80, 81, 95, 96, plus the three aggregation cells at lines 39-40 (Task `Reaches done`, Objective `Reaches done`, Objective `Reaches partial`), each taken verbatim from the Story's fenced blocks. Line 47 and line 70 untouched (Story 10 and Story 2 own them).
  **Seam (GREEN).** The parity test parses the 36 matrix rows and asserts each sixth cell equals the `transitions` row note; the five-pairs test asserts each of the five row notes contains `external`. Both now hold.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- parity probe (plain string comparison, not the test runner): 36 doc rows vs 56 `transitions` entries — all notes and all three mark cells agree, `PARITY OK`
- inspection greps: line 39 holds `external: the harness reports an accepted outcome`; both `external: a \`human\` actor closes the attested objective …` cells are present verbatim.
  **Assumptions.**
- VERIFIED: `npm run typecheck` exits 0 on the tree with the TE's RED tests in place.
- NOTE for the TE: the Story's Verify inspection says `grep -c "actor closes the attested objective"` returns 2. The two occurrences both live on line 40 (the Objective row holds both amended cells on one line), so `grep -c` counts one matching line and prints 1. Both exact fenced strings are present — `grep -o … | wc -l` returns 2 — matching the Story's own "Keep every row on one line" constraint.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 02 — ready→pending matrix flip

**Cycle.** Confirm-GREEN Story 1, then RED for Story `02-ready-to-pending-flip` (`node --test src/domain/transition.test.ts`).
**Confirm GREEN (Story 1).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/transition.test.ts` → exit 0, `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/transition.test.ts` (edited) — suite: `src/domain/transition.test` — methods: `exhaustive per-level assertion` (affected), `only blocked→pending and ready→pending write pending` (rewritten)
- asserts: `"ready→pending"` added to all three `allowedPairs` sets (task, objective, initiative), each immediately after its `"pending→discarded"` entry, so the 168-cell oracle now demands the flipped cell; the former `only blocked→pending writes pending` test is renamed `only blocked→pending and ready→pending write pending`, keeps the `nodeStates` loop with `from === "blocked"` and `from === "ready"` skipped, and adds a second loop over `["task", "objective", "initiative"] as const` asserting `canTransition(level, "blocked", "pending") === true` and `canTransition(level, "ready", "pending") === true` — six positive assertions.
  **RED proof.**
- command: `node --test src/domain/transition.test.ts`
- exit: 1 — failure: `AssertionError [ERR_ASSERTION]: canTransition("task", "ready", "pending") should be true for ready→pending` (exhaustive per-level assertion); `AssertionError [ERR_ASSERTION]: canTransition("task", "ready", "pending") should be true` (only blocked→pending and ready→pending write pending); `ℹ tests 16`, `ℹ pass 14`, `ℹ fail 2`
- The matrix parity test stays green (code booleans and document marks still agree on ❌/false) and turns red only if one side flips alone — it is the document-to-code fence.
- stub probe: n/a — the seam exists; `npm run typecheck` exits 0 with the RED tests in place.
  **Open to Software Engineer.**
- `src/domain/transition.ts` — the row at lines 70-77 (`from: "ready"`, `to: "pending"`): set `task`, `objective` and `initiative` to `true`, and replace the note with exactly `A topology write and an import write it, when the accepted graph adds an unsatisfied dependency to a node that was already `ready`.` Change nothing else in the file; `transitions.length` stays 56 and row order stays sorted.
- `docs/proposal/phase-1/state-machine.md:70` — change the three `❌` marks to `✅` and replace the note with the same exact string; keep the `From` and `To` cells byte-identical and keep the row on one line. Both files change together, or the Story 1 parity test turns red.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 02 — ready→pending matrix flip

**Cycle.** GREEN for `src/domain/transition.test.ts` (RED turn: `canTransition("task", "ready", "pending") should be true` in the exhaustive per-level assertion and in `only blocked→pending and ready→pending write pending`).
**Files changed.**

- `src/domain/transition.ts` (edited) — the row `from: "ready"`, `to: "pending"` at lines 70-77: `task`, `objective` and `initiative` set to `true`, note replaced with `A topology write and an import write it, when the accepted graph adds an unsatisfied dependency to a node that was already \`ready\`.` No other boolean, no row added or removed (`transitions.length` stays 56), row order unchanged.
- `docs/proposal/phase-1/state-machine.md` (edited) — the row at line 70: the three `❌` marks become `✅`, the note becomes the same exact string, the `From` and `To` cells stay byte-identical, the row stays on one line.
  **Seam (GREEN).** The three `allowedPairs` sets each gain `"ready→pending"` (the oracle now demands the flipped cell), and the rewritten pending-source test asserts the two positive pairs per level. The code booleans and the document marks now both carry the flip, so the Story 1 parity test stays green.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- row-count probe: 56 rows / 56 notes inside the `transitions` array body — unchanged.
- document probe: 36 matrix rows parse; `ready → pending` row shows `✅ ✅ ✅` and the exact note string; code row carries the same note string byte-for-byte (both probed against the Story's fenced string).
  **Assumptions.**
- VERIFIED: `npm run typecheck` exits 0 on the tree with the TE's RED tests in place.
- VERIFIED: the flipped cell is `true` at all three levels in both files, so the Story 1 matrix parity test (document note equals code note) cannot drift apart.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 03 — structural edit at ready

**Cycle.** Confirm-GREEN Story 2, then RED for Story `03-structural-edit-at-ready` (`node --test src/domain/plan-choice.test.ts`).
**Confirm GREEN (Story 2).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/transition.test.ts` → exit 0, `ℹ tests 16`, `ℹ pass 16`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/plan-choice.test.ts` (edited) — suite: `src/domain/plan-choice.test` — methods: `ready accepts a structural change` (renamed from `ready refuses a structural change`), `ready refuses a parent or repo move while a node or descendant is contained` (new), `running refuses a structural change`, `done refuses a structural change`, `each of the eight states is exercised for a prose and a structural change` (affected)
- asserts: the rewritten ready test keeps the same input (`presence: "both"`, `state: "ready"`, `fields: ["parent"]`, `containmentMovable: true`) and demands `{ suggested: "submitted", submitted: { legal: true, reason: null }, database: { legal: true, reason: null } }`. The new containment test loops `["parent", "repo"]` at `state: "ready"` with `containmentMovable: false` and demands `submitted.legal: false` with the containment reason, plus a free-move case (`containmentMovable: true`) demanding `submitted` of `{ legal: true, reason: null }` — the lease guard is asserted to survive the flip. The running/done reason literals become `"a structural edit needs pending, blocked or ready"`, and the `structural.ready` oracle row becomes `{ suggested: "submitted", legal: true }`.
  **RED proof.**
- command: `node --test src/domain/plan-choice.test.ts`
- exit: 1 — failures: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` (`ready accepts a structural change`, actual suggested `database` vs expected `submitted`); `AssertionError [ERR_ASSERTION]: structural suggested at ready` (`+ 'database' - 'submitted'`, table driver); `ℹ tests 21`, `ℹ pass 16`, `ℹ fail 5`
- The five failing tests are exactly the five Story-named expectations: the renamed ready test, the new containment test, the two reason literals, and the oracle row. The untouched suites (`validate-plan`, `import-plan`) cannot see this file, and the old reason literal now appears in no test file (grep-verified), so the SE's reason change breaks no sibling suite.
- stub probe: n/a — the seam exists; `npm run typecheck` exits 0 with the RED tests in place.
  **Open to Software Engineer.**
- `src/domain/plan-choice.ts:91` — the branch `if (facts.state === "pending" || facts.state === "blocked")` also accepts `facts.state === "ready"`; the `containmentMovable` guard at lines 86-89 stays unchanged.
- `src/domain/plan-choice.ts:109` — the reason string becomes exactly `"a structural edit needs pending, blocked or ready"`.
- `docs/proposal/phase-1/plan-format.md:109` — the Suggestion cell `` `database` `` becomes `` `submitted` `` and the other-choice cell `illegal` becomes `legal`; the Case cell stays byte-identical.
- Keep green after the flip: `node --test src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts` (repair only an expectation the flip made stale; no production change in either caller).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 03 — structural edit at ready

**Cycle.** GREEN for `src/domain/plan-choice.test.ts` (RED turn: `ready accepts a structural change` — actual suggested `database` vs expected `submitted`; 5 failing tests).
**Files changed.**

- `src/domain/plan-choice.ts` (edited) — `choiceVerdict`: the structural branch at lines 91-95 now also accepts `facts.state === "ready"`; the fallback reason at line 113 is exactly `"a structural edit needs pending, blocked or ready"`. The `containmentMovable` guard at lines 86-89 is unchanged, so a `ready` node whose subtree holds a lease, a workspace or a commit still refuses a `parent`/`repo` move.
- `docs/proposal/phase-1/plan-format.md` (edited) — line 109: Suggestion cell `` `database` `` → `` `submitted` ``, other-choice cell `illegal` → `legal`; Case cell byte-identical; cell widths match the sibling rows (all three lines are 157 chars).
  **Seam (GREEN).** The rewritten `ready accepts a structural change` expects `{ suggested: "submitted", submitted: { legal: true, reason: null } }`; the new containment test expects `submitted.legal: false` with the containment reason at `ready` when `containmentMovable: false`; the running/done reason literals and the `structural.ready` oracle row match the new branch.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/plan-choice.ts`): exit 0
- literal grep: the new reason string exists in `plan-choice.ts` only (production); the old literal survives in no production and no test file.
- doc probe: no test under `src/` parses `plan-format.md`; line 109 layout byte-matches the sibling rows.
  **Assumptions.**
- VERIFIED: `validate-plan.test.ts`, `export-plan.test.ts` and `list-revision.test.ts` hold no `ready` reference (grep over the suites), so the flip cannot stale them.
- OPEN (TE lane): `src/commands/plan/import-plan.test.ts:1414-1478` — the test `submitted on a structural edit is refused at ready, running, awaiting_approval, done, partial and discarded` lists `["ready", planFixtureIdentities.task]` at line 1416 and asserts `error.refusal === "choices-changed"`. After the flip a `ready` task whose only differing field is `depends_on` has `structuralLegal: true` (`movable` defaults to `true` and `depends_on` is neither `parent` nor `repo`), so `choiceVerdict` returns `submitted.legal: true`, the import succeeds and `error.refusal` is `null` — the assertion fails on the first case. Repair: drop the `ready` case from the refusal list, or move it into the accepted loop of `submitted on a structural edit is accepted at pending and blocked` at line 1480, which drives the same `withTaskDependsOn` document and passes at `ready` unchanged.

ATTEMPT-FAILED: 03-structural-edit-at-ready — the flip leaves the `ready` refusal case of `import-plan.test.ts:1416` stale; the repair edits a test file, which is the TE's lane.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 04 — actor-model amendment (GREEN-only)

**Cycle.** Confirm-GREEN Story 3 (repair of the stale `ready` refusal case in the TE lane), then GREEN-ONLY pass-through for Story `04-actor-model-amendment`.
**Test written (repair, TE lane).**

- file: `src/commands/plan/import-plan.test.ts` (edited) — suite: `src/commands/plan/import-plan.test` — methods: `submitted on a structural edit is refused at running, awaiting_approval, done, partial and discarded` (renamed), `submitted on a structural edit is accepted at pending, blocked and ready, and a blocked node keeps its block_reason` (renamed)
- asserts: the refusal list drops `["ready", planFixtureIdentities.task]` (the flip makes `submitted` legal at `ready`, so the refusal is stale, per the SE's ATTEMPT-FAILED report); the accepted loop gains `"ready"` with an explicit `UPDATE node SET state = 'ready'` (the fixture seeds `pending`), keeping the edge-commit, revision and blocked-reason assertions per state.
  **Confirm GREEN (Story 3).**
- command: `node --test src/domain/plan-choice.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts` → exit 0, `ℹ tests 76`, `ℹ pass 76`, `ℹ fail 0`
- command: `npm run typecheck` → exit 0 (clean with the repaired tests in place)
  **Story file.** `.agents/plan/stories/014-external-drive-contract/04-actor-model-amendment.md` — "Document-only story. It writes no TypeScript."
  **Tasks forwarded to Software Engineer.**
- `04-actor-model-amendment`: `docs/proposal/phase-1/transport.md:19`, `docs/proposal/api/README.md:146,148`, `docs/proposal/api/graph.md:7` — replace the three document passages with the Story's exact fenced strings; both files name `harness` and EPIC 015; `graph.md:9` stays word for word; no route table row and no `src/` file changes.
  **No RED phase.** Coverage owned elsewhere per the Story's Verify: `npm run verify`, the unchanged `src/domain/event.test.ts` (two actor kinds, no edit), and the three grep probes (`no user model` count 0, `harness` present in both, `Only an actor mutates the graph` at line 7).
  **Open to Software Engineer.**
- Implement GREEN per the Story file's `## Change` and `## Constraints` sections. Constraints: no route table row of `graph.md` (the `parity.test.ts` matrix parse must survive), no file under `src/`, no `docs/proposal/database/` file, `graph.md:9` quoted unchanged, and `transport.md:17` and `:21` stay word for word.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 04 — actor-model amendment

**Cycle.** GREEN-ONLY implementation for Tasks: `04-actor-model-amendment`.
**Files changed.**

- `docs/proposal/phase-1/transport.md` (edited) — line 19 replaced with the Story's fenced string: a user model exists, the configured bearer token resolves to a bootstrap `human` actor, `harness` is the second registered actor kind, `daemon` registers nothing, EPIC 015 lands the enum, the service-interface type and the `CHECK`. Lines 17 and 21 untouched word for word.
- `docs/proposal/api/README.md` (edited) — lines 146 and 148 replaced with the Story's two fenced paragraphs: the token identifies the actor and `event.actor_id` records the resolved actor; a registered actor is `human` or `harness`, no request carries an actor field, every human decision stamps the resolved actor, EPIC 015 lands the enum, the service-interface type and the `CHECK`. Heading at line 144 and blank lines kept.
- `docs/proposal/api/graph.md` (edited) — line 7 heading becomes `## Only an actor mutates the graph`. Line 9 quoted unchanged, and no route table row touched (`readRouteMatrix` parse survives).
  **Seam (GREEN-ONLY).** No RED phase; coverage is owned by `npm run verify`, the unchanged `src/domain/event.test.ts`, and the Story's grep probes. Constraints met: no file under `src/`, no `docs/proposal/database/` file, no route table row, `harness` and EPIC 015 named in both files.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- probe `grep -c "no user model"`: 0 for both `transport.md` and `README.md`
- probe `grep -n "harness"`: present in `transport.md:19` and `README.md:148`
- probe `grep -n "Only an actor mutates the graph"`: `graph.md:7`
  **Assumptions.**
- VERIFIED: the two README paragraphs sit at lines 146/148 with the heading at 144 and the blank-line separation intact, matching the Story's fenced layout.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · GREEN-only Tasks

**Cycle.** Confirm-GREEN Story 4 (build-only check, GREEN-only), then GREEN-ONLY pass-through for Tasks: `05-query-parameter-correction`.
**Confirm GREEN (Story 4, GREEN-only).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`
- command: `npm run typecheck` → exit 0
- Story 4 Verify probes: `grep -c "no user model"` → 0 in both `transport.md` and `api/README.md`; `harness` at `transport.md:19` and `api/README.md:148`; `Only an actor mutates the graph` at `graph.md:7`; `node --test src/http/contract/parity.test.ts` → exit 0, `ℹ tests 1`, `ℹ pass 1`, `ℹ fail 0` (route table byte-equivalent to the registry).
  **Story file.** `.agents/plan/stories/014-external-drive-contract/05-query-parameter-correction.md` — "Document-only story. It writes no TypeScript."
  **Tasks forwarded to Software Engineer.**
- `05-query-parameter-correction`: `docs/proposal/api/graph.md:102` — replace the stale paragraph with the Story's exact fenced string: the corrected claim states the query-parameter mechanism exists and cites `src/http/contract/operation.ts:41` and `src/http/contract/event.ts:69`, and it keeps the `repository.list` sentence as its own claim. Line 104 stays word for word.
  **No RED phase.** Coverage owned elsewhere per the Story's Verify: `npm run verify`, the unchanged `node --test src/http/contract/parity.test.ts` (the route table of `graph.md` must stay byte-equivalent to the registry, so no route row may move), and the four grep probes: the old claim count returns `0`, both citations return line 102, and `blockReason` still returns line 104.
  **Open to Software Engineer.**
- Implement GREEN per the Story file's `## Change` and `## Constraints` sections. Constraints: change no other line of `docs/proposal/api/graph.md` (Story 4 owns line 7), change no route table row (`test/helpers/proposal.ts:54` `readRouteMatrix` parses the five-column route table of this file, and `src/http/contract/parity.test.ts` compares it against the registry), change no file under `src/` (EPIC 018 adds the `node.list` filters), and do not delete or extend the `repository.list` sentence to `node.list`. No refactor is named in this Story.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 05 — stale query-parameter correction

**Cycle.** GREEN-ONLY implementation for Tasks: `05-query-parameter-correction`.
**Files changed.**

- `docs/proposal/api/graph.md` (edited) — line 102 replaced with the Story's fenced string: the corrected claim names `src/http/contract/operation.ts:41` and `src/http/contract/event.ts:69`, states EPIC 018 declares the `node.list` filters, and keeps `repository.list` unfiltered by choice as its own sentence. Line 104 untouched word for word, no route table row touched, no file under `src/`, no `docs/proposal/database/` file.
  **Seam (GREEN-ONLY).** No RED phase; coverage is owned by `npm run verify`, the unchanged `node --test src/http/contract/parity.test.ts` (route table byte-equivalence), and the Story's grep probes.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- probe `grep -c "no query-parameter mechanism: an operation declares"`: 0
- probe `grep -n "src/http/contract/operation.ts:41"` and `grep -n "src/http/contract/event.ts:69"`: both line 102
- probe `grep -n "blockReason"`: line 104 still present (the pre-existing `node.show` occurrence at line 110 is untouched)
  **Assumptions.**
- VERIFIED: the replaced paragraph is byte-identical to the Story's fenced block, and the edit touched no other line of the file (single-string replacement of the exact "reads today" text).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 06 — run driver

**Cycle.** Confirm-GREEN Story 5 (build-only check, GREEN-only), then RED for Task `06-run-driver` (`node --test src/domain/run.test.ts src/domain/rows.test.ts`).
**Confirm GREEN (Story 5, GREEN-only).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (run on the SE's handoff tree — my RED edits stashed for the gate, then restored)
- Story 5 Verify probes: `grep -c "no query-parameter mechanism: an operation declares"` → 0; both citations (`src/http/contract/operation.ts:41`, `src/http/contract/event.ts:69`) at `graph.md:102`; `blockReason` still at line 104 (line 110 pre-existing untouched).
  **Test written.**
- file: `src/domain/run.test.ts` (edited) — suite: `src/domain/run.test` — methods: `runDrivers pins the two drivers in order`, `accepts an external run that holds no workspace, worker or base`, `refuses an external run that carries a daemon-worker fact`, `refuses an internal run that omits a daemon-worker fact`, `driver refine: message equals the DDL CHECK expression`, `refuses an unknown driver`
- asserts: `validObjectiveRun` and `validTaskRun` each gain `driver: "internal" as const` right after `kind`, and a new `validExternalRun` fixture spreads `validObjectiveRun` with `driver: "external"` and the three daemon-worker facts null. The order test pins `[...runDrivers]` deep-equals `["internal", "external"]` and length 2. The refusal tests assert `success === false` per field: external plus `workspaceId`/`worker: "general@1"`/`baseOid`, and internal with each of the three null. The message test parses `{ ...validObjectiveRun, workspaceId: null }` and asserts `issues[0].message` equals `(driver = 'internal') = (workspace_id IS NOT NULL AND worker IS NOT NULL AND base_oid IS NOT NULL)`. `driver: "hybrid"` fails. The missing-required-key loop is untouched and now also covers `driver`.
  **RED proof.**
- command: `node --test src/domain/run.test.ts src/domain/rows.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './run.ts' does not provide an export named 'runDrivers'` (at `src/domain/run.test.ts:4`); `ℹ tests 7`, `ℹ pass 6`, `ℹ fail 1` — the 6 passes are `rows.test.ts` (unaffected; it only maps the schema reference, never constructs a run row).
- The existing `refine: message equals the DDL CHECK expression` test stays green both before and after the change: its input keeps the driver combination valid, so only the first-chained `parentRunId` refine fires.
- stub probe: n/a — `npm run typecheck` reports TS2305, not TS2307: the module resolves, so `tsc` checks the whole test-file body and the only error is the missing `runDrivers` member (0 other errors). No stub: `src/domain/run.ts` is an existing production file, and the Story pins the exact enum shape.
  **Open to Software Engineer.**
- `src/domain/run.ts` — the four edits of the Story's `## Change` section, exactly: `runDrivers`/`RunDriver` above `runRow`; `driver: z.enum(runDrivers)` after `kind` and before `nodeId`; `workspaceId`, `worker` and `baseOid` nullable; the second `.refine` chained **after** the existing `parentRunId` refine with the exact message `(driver = 'internal') = (workspace_id IS NOT NULL AND worker IS NOT NULL AND base_oid IS NOT NULL)`. Change no command, query or service (`runRow` has one consumer, `src/domain/rows.ts:39`, a schema map only). Write no SQL and no migration — EPIC 018 owns the column and the table `CHECK`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 06 — run driver

**Cycle.** GREEN for `src/domain/run.test.ts src/domain/rows.test.ts` (RED turn: `SyntaxError: The requested module './run.ts' does not provide an export named 'runDrivers'`).
**Files changed.**

- `src/domain/run.ts` (edited) — `runDrivers`/`RunDriver` added above `runRow` in the `event.ts:6-7` shape; `driver: z.enum(runDrivers)` after `kind` and before `nodeId`; `workspaceId`, `worker` and `baseOid` made nullable; second `.refine` chained after the existing `parentRunId` refine, message exactly `(driver = 'internal') = (workspace_id IS NOT NULL AND worker IS NOT NULL AND base_oid IS NOT NULL)`.
  **Seam (GREEN).** `runDrivers` is now exported, the driver field parses `"internal"`/`"external"` and refuses `"hybrid"`, an `external` run with any daemon-worker fact fails the chained refine, an `internal` run missing any of the three fails it, and `issues[0].message` of the driver refine is the DDL CHECK expression the Story pins.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/run.ts`): exit 0
  **Assumptions.**
- VERIFIED: `headOid`, `outcome` and `endedAt` stay nullable and unchanged; the existing `parentRunId` refine and its message are untouched; the driver refine is chained after it, so the `issues[0]` message ordering both tests pin holds.
- VERIFIED: `runRow`'s only consumer is `src/domain/rows.ts:39` (schema map) — no command, query or service edited, and no SQL written (EPIC 018 owns the column and table `CHECK`).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 07 — attempt driver

**Cycle.** Confirm-GREEN Story 6, then RED for Task `07-attempt-driver` (`node --test src/domain/attempt.test.ts src/domain/rows.test.ts`).
**Confirm GREEN (Story 6).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/run.test.ts src/domain/rows.test.ts` → exit 0, `ℹ tests 27`, `ℹ pass 27`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/attempt.test.ts` (edited) — suite: `src/domain/attempt.test` — methods: `accepts an external attempt that holds no provider fact`, `refuses an external attempt that carries a provider fact`, `refuses an internal attempt that omits a provider fact`, `driver refine: message equals the DDL CHECK expression`, `refuses an unknown driver`
- asserts: `validRow` gains `driver: "internal" as const` immediately after `attemptNo`, and a new `validExternalRow` fixture spreads `validRow` with `driver: "external"` and the four provider facts null. The accepts test parses `validExternalRow` and demands success. The external-refusal test asserts `success === false` for each of the four fields populated on the external row (`providerId`, `providerModel`, `timeoutMs`, `baseOid`). The internal-refusal test asserts `success === false` for each of the four fields nulled on the internal row. The message test parses `{ ...validRow, providerId: null }` and asserts `issues[0].message` equals `(driver = 'internal') = (provider_id IS NOT NULL AND provider_model IS NOT NULL AND timeout_ms IS NOT NULL AND base_oid IS NOT NULL)`. `driver: "hybrid"` fails. The missing-required-key loop is untouched and now also covers `driver`; the `attemptOutcomes` tests and the `headOid`/`outcome`/`endedAt` nullability are untouched.
  **RED proof.**
- command: `node --test src/domain/attempt.test.ts src/domain/rows.test.ts`
- exit: 1 — failures: `AssertionError [ERR_ASSERTION]: expected rejection when driver is missing` (missing-required-key loop, at `attempt.test.ts:41`); `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: false !== true` (`accepts an external attempt that holds no provider fact`); `+ 'Invalid input: expected string, received null' - "(driver = 'internal') = (provider_id ..."` (message test); `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: true !== false` (`refuses an unknown driver`); `ℹ tests 19`, `ℹ pass 15`, `ℹ fail 4`
- The four failures are exactly the Story-named gaps: no `driver` field yet (missing key accepted, unknown value stripped by the non-strict object), non-nullable provider facts, and no refine with the DDL message. `refuses an external attempt that carries a provider fact` and `refuses an internal attempt that omits a provider fact` currently pass for the wrong reason (non-nullable fields) and stay green once the nullable fields + refine land.
- stub probe: n/a — the seam `attemptRow` exists, so `tsc` checks the whole test body: `npm run typecheck` exits 0 with the RED tests in place, 0 errors.
  **Open to Software Engineer.**
- `src/domain/attempt.ts` — the four edits of the Story's `## Change` section, exactly: import `runDrivers` from `./run.ts` after the existing `./column.ts` import (no second enum); `driver: z.enum(runDrivers)` immediately after `attemptNo` and before `providerId`; `providerId: identity("provider").nullable()`, `providerModel: z.string().nullable()`, `timeoutMs: z.int().nullable()`, `baseOid: objectId.nullable()`; one `.refine` (the object's first) with the exact message `(driver = 'internal') = (provider_id IS NOT NULL AND provider_model IS NOT NULL AND timeout_ms IS NOT NULL AND base_oid IS NOT NULL)`. Change no command, query or service (`attemptRow` has one consumer, `src/domain/rows.ts:23`, a schema map only). Write no SQL and no migration — EPIC 018 owns the column and the table `CHECK`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 07 — attempt driver

**Cycle.** GREEN for `src/domain/attempt.test.ts src/domain/rows.test.ts` (RED turn: four failures — missing-key loop, external-accepts, DDL message, unknown driver).
**Files changed.**

- `src/domain/attempt.ts` (edited) — `import { runDrivers } from "./run.ts"` added after the `./column.ts` import (no second enum); `driver: z.enum(runDrivers)` immediately after `attemptNo` and before `providerId`; `providerId`, `providerModel`, `timeoutMs` and `baseOid` made nullable; one `.refine`, the object's first, with the exact message `(driver = 'internal') = (provider_id IS NOT NULL AND provider_model IS NOT NULL AND timeout_ms IS NOT NULL AND base_oid IS NOT NULL)`.
  **Seam (GREEN).** The missing-required-key loop now fails on a missing `driver`; an external attempt with no provider fact parses; each provider fact populated on an external attempt fails the refine; each fact omitted on an internal attempt fails it; `issues[0].message` of the refine is the DDL CHECK expression; `driver: "hybrid"` fails the enum.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/attempt.ts`): exit 0
  **Assumptions.**
- VERIFIED: `headOid`, `outcome` and `endedAt` stay nullable and unchanged; `attemptOutcomes`/`attemptOutcome` untouched; `attemptRow`'s only consumer is `src/domain/rows.ts:23` (schema map) — no command, query or service edited, and no SQL written (EPIC 018 owns the column and the table `CHECK`).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 08 — lease owner kind

**Cycle.** Confirm-GREEN Story 7, then RED for Task `08-lease-owner-kind` (`node --test src/domain/lease.test.ts src/domain/rows.test.ts`).
**Confirm GREEN (Story 7).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/attempt.test.ts src/domain/rows.test.ts` → exit 0, `ℹ tests 19`, `ℹ pass 19`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/lease.test.ts` (edited) — suite: `src/domain/lease.test` — methods: `leaseOwnerKinds pins the two owner kinds in order`, `accepts an unheld lease with both owner fields null`, `accepts an actor-held lease`, `refuses a lease whose owner and owner kind disagree on null`, `owner-kind refine: message equals the DDL CHECK expression`, `refuses an unknown owner kind`
- asserts: `validRow` gains `ownerKind: "daemon" as const` immediately after `owner`; the order test pins `[...leaseOwnerKinds]` deep-equals `["daemon", "actor"]` and length 2; the unheld test parses `{ ...validRow, owner: null, ownerKind: null }`; the actor-held test parses `{ ...validRow, owner: "actor_" + ULID_A, ownerKind: "actor" }`; the disagreement test asserts `success === false` for both directions (`{ ...validRow, owner: null }` and `{ ...validRow, ownerKind: null }`); the message test parses `{ ...validRow, owner: null }`, asserts `success === false`, and asserts `issues[0].message` equals `(owner IS NULL) = (owner_kind IS NULL)`; `ownerKind: "worker"` fails. The missing-required-key loop at lines 27-37 is untouched and now also covers `ownerKind` (zod `.nullable()` rejects a missing key). No existing test sets `owner: null` on a spread, so no other test needed a `ownerKind: null` beside it — the file's other six tests are unchanged.
  **RED proof.**
- command: `node --test src/domain/lease.test.ts src/domain/rows.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './lease.ts' does not provide an export named 'leaseOwnerKinds'` (at `src/domain/lease.test.ts:4`); `ℹ tests 7`, `ℹ pass 6`, `ℹ fail 1` — the 6 passes are `rows.test.ts` (unaffected; it only maps the schema reference, never constructs a lease row).
- The suite-level failure is the missing export, the Story 6 pattern: once the export exists, the four refusal/message tests and the missing-key loop fail on the unamended fields — the loop deletes `ownerKind` from a validRow spread and gets an accepted parse today (unknown key stripped); `{ ...validRow, owner: null }` and `{ ...validRow, ownerKind: null }` parse today (no refine) and must fail; the message test gets `success: true` and fails; `ownerKind: "worker"` is stripped and accepted. The two accepts tests (unheld, actor-held) pass today for the wrong reason (unknown-key stripping) and pin the accepted shape once the field exists.
- stub probe: n/a — `npm run typecheck` reports TS2305, not TS2307: the module resolves, so `tsc` checks the whole test-file body and the only error is the missing `leaseOwnerKinds` member (0 other errors). No stub: `src/domain/lease.ts` is an existing production file, and the Story pins the exact enum shape.
  **Open to Software Engineer.**
- `src/domain/lease.ts` — the three edits of the Story's `## Change` section, exactly: `leaseOwnerKinds`/`LeaseOwnerKind` immediately after `leaseSubjectKinds` in the `event.ts:6-7` shape; `ownerKind: z.enum(leaseOwnerKinds).nullable()` immediately after `owner` and before `fence`; the object's first `.refine` with the exact message `(owner IS NULL) = (owner_kind IS NULL)`. `leaseSubjectKinds`, `subjectKind`, `subjectId`, `fence` and the three epoch fields stay unchanged. Change no command, query or service (`leaseRow` has one consumer, `src/domain/rows.ts:30`, a schema map only). Write no SQL and no migration — EPIC 018 owns the `owner_kind` column and the table `CHECK`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 08 — lease owner kind

**Cycle.** GREEN for `src/domain/lease.test.ts src/domain/rows.test.ts` (RED turn: `SyntaxError: The requested module './lease.ts' does not provide an export named 'leaseOwnerKinds'`).
**Files changed.**

- `src/domain/lease.ts` (edited) — `leaseOwnerKinds`/`LeaseOwnerKind` added immediately after `leaseSubjectKinds` in the `event.ts:6-7` shape; `ownerKind: z.enum(leaseOwnerKinds).nullable()` immediately after `owner` and before `fence`; the object's first `.refine` chained after the object literal, message exactly `(owner IS NULL) = (owner_kind IS NULL)`.
  **Seam (GREEN).** `leaseOwnerKinds` is now exported and pins `["daemon", "actor"]` in order; the owner-kind field parses both kinds, accepts `null` and refuses `"worker"`; the refine refuses a row where `owner` and `ownerKind` disagree on null in either direction, and `issues[0].message` of the refine is the DDL CHECK expression.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/lease.ts`): exit 0
  **Assumptions.**
- VERIFIED: `leaseSubjectKinds`, `subjectKind`, `subjectId`, `fence`, `acquiredAt`, `renewedAt` and `expiresAt` unchanged; `leaseRow`'s only consumer is `src/domain/rows.ts:30` (schema map) — no command, query or service edited, and no SQL written (EPIC 018 owns the `owner_kind` column and the table `CHECK`).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 09 — revision provenance

**Cycle.** Confirm-GREEN Story 8, then RED for Task `09-revision-provenance` (`node --test src/domain/plan-revision.test.ts src/domain/rows.test.ts`).
**Confirm GREEN (Story 8).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/lease.test.ts src/domain/rows.test.ts` → exit 0, `ℹ tests 18`, `ℹ pass 18`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/plan-revision.test.ts` (edited) — suite: `src/domain/plan-revision.test` — methods: `revisionOrigins pins the two origins in order`, `accepts a node-write revision that holds no import fact`, `refuses a node-write revision that carries an import fact`, `refuses an import revision that omits an import fact`, `acceptedBlob is required under both origins`, `origin refine: message equals the DDL CHECK expression`, `refuses an unknown origin`
- asserts: `validRow` gains `origin: "import" as const` immediately after `parentId`, and the new `validNodeWriteRow` fixture spreads it with `origin: "node-write"` and the three import facts null. The order test pins `[...revisionOrigins]` deep-equals `["import", "node-write"]` and length 2. The node-write refusal test asserts `success === false` for each of the three fields populated on the node-write row (`importId`, `submittedBlob`, `choicesBlob`), and the import-omission test asserts `success === false` for each of the three fields nulled on the import row. `acceptedBlob: null` fails under both origins. The message test parses `{ ...validRow, importId: null }` and asserts `issues[0].message` equals `(origin = 'import') = (import_id IS NOT NULL AND submitted_blob IS NOT NULL AND choices_blob IS NOT NULL)`. `origin: "restore"` fails. The missing-required-key loop is untouched and now also covers `origin` (zod `.nullable()` rejects a missing key); the three pre-existing tests are unchanged.
  **RED proof.**
- command: `node --test src/domain/plan-revision.test.ts src/domain/rows.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './plan-revision.ts' does not provide an export named 'revisionOrigins'` (at `src/domain/plan-revision.test.ts:4`); `ℹ tests 7`, `ℹ pass 6`, `ℹ fail 1` — the 6 passes are `rows.test.ts` (unaffected; it only maps the schema reference, never constructs a revision row).
- The suite-level failure is the missing export, the Story 6 pattern: once the export exists, the message test, the unknown-origin test and the missing-key loop fail on the unamended fields — the loop deletes `origin` from a validRow spread and gets an accepted parse today (unknown key stripped); `{ ...validRow, importId: null }` parses today and must fail; `origin: "restore"` is stripped and accepted. The two accepts tests (valid row, node-write row) pass today for the wrong reason (unknown-key stripping) and pin the accepted shapes once the field exists.
- stub probe: n/a — `npm run typecheck` reports TS2305, not TS2307: the module resolves, so `tsc` checks the whole test-file body and the only error is the missing `revisionOrigins` member (0 other errors). No stub: `src/domain/plan-revision.ts` is an existing production file, and the Story pins the exact enum shape.
  **Open to Software Engineer.**
- `src/domain/plan-revision.ts` — the four edits of the Story's `## Change` section, exactly: `revisionOrigins`/`RevisionOrigin` above `planRevisionRow`, declared in this file and not in `src/domain/origin.ts` (that file holds the CORS origin canonicalizer and shares no meaning); `origin: z.enum(revisionOrigins)` immediately after `parentId` and before `importId`; `importId: z.string().nullable()`, `submittedBlob: blobHash.nullable()`, `choicesBlob: blobHash.nullable()` (`acceptedBlob` stays required); the object's first `.refine` with the exact message `(origin = 'import') = (import_id IS NOT NULL AND submitted_blob IS NOT NULL AND choices_blob IS NOT NULL)`. Change no command, query or service (`planRevisionRow` has one consumer, `src/domain/rows.ts:33`, a schema map only). Write no SQL and no migration — EPIC 017 owns the `origin` column with its `CHECK` and the three table `CHECK` clauses.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 09 — revision provenance

**Cycle.** GREEN for `src/domain/plan-revision.test.ts src/domain/rows.test.ts` (RED turn: `SyntaxError: The requested module './plan-revision.ts' does not provide an export named 'revisionOrigins'`).
**Files changed.**

- `src/domain/plan-revision.ts` (edited) — `revisionOrigins`/`RevisionOrigin` added above `planRevisionRow` (declared here, not in `src/domain/origin.ts`); `origin: z.enum(revisionOrigins)` immediately after `parentId` and before `importId`; `importId`, `submittedBlob` and `choicesBlob` made nullable (`acceptedBlob` stays required); the object's first `.refine` added, message exactly `(origin = 'import') = (import_id IS NOT NULL AND submitted_blob IS NOT NULL AND choices_blob IS NOT NULL)`.
  **Seam (GREEN).** `revisionOrigins` is now exported and pins `["import", "node-write"]` in order; the origin field parses both kinds and refuses `"restore"`; a `node-write` revision carrying any import fact fails the refine, an `import` revision omitting any of the three fails it, `acceptedBlob: null` fails under both origins, and `issues[0].message` of the refine is the exact DDL-conjunction string. The unchanged missing-required-key loop now also rejects a missing `origin` (zod `.nullable()` accepts an explicit `null`, still rejects a missing key).
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `planRevisionRow`'s only production consumer is `src/domain/rows.ts:33` (schema map only) — no command, query or service edited, and no SQL written (EPIC 017 owns the `origin` column with its `CHECK` and the three table `CHECK` clauses).
- VERIFIED: `parentId`, `acceptedBlob` and the `identity`/`blobHash` helpers unchanged; `src/domain/origin.ts` untouched.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 10 — validity split

**Cycle.** RED for Task `10-validity-split` (`node --test src/domain/plan-completeness.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/queries/plan/validate-plan.test.ts`).
**Test written.**

- file: `src/domain/plan-completeness.test.ts` (new) — suite: `src/domain/plan-completeness.test` — methods: `empty parents yield no findings under both subjects`, `empty children emit one finding per non-task parent under both subjects`, `a satisfied parent yields no finding under both subjects`, `a task parent emits nothing under both subjects`, `the wrong child kind does not satisfy a parent`, `a child whose parent key is null satisfies no parent`, `path and id are copied from the parent`, `output order equals the parents order`
- file: `src/domain/plan-finding.test.ts` (edited) — suite: `src/domain/plan-finding.test` — methods: `validationScopes pins the two scopes in order`, `findingScope is total over findingCodes`, `the completeness scope holds exactly the two completeness codes`
- asserts: the eight completeness tests drive `completenessFindings` over both `subject` values (`"document"` and `"record"`): empty parents returns `[]`; an `initiative` parent and an `objective` parent with `children: []` return two findings in parents order with codes `["initiative-without-objective", "objective-without-task"]` and the exact per-subject messages (`the initiative holds no objective document` / `the initiative holds no objective`, `the objective holds no task document` / `the objective holds no task`); a satisfied pair (objective child of `parentKey: "A"`, task child of `parentKey: "B"`) returns `[]`; a `task` parent emits nothing; only a `task` child under an `initiative` parent still yields `initiative-without-objective`; an `objective` child of `parentKey: null` satisfies no parent; `path` and `id` are copied from the parent in both directions; three parents keyed `z`, `a`, `m` return findings in that order. The finding tests assert `validationScopes` deep-equals `["structural", "completeness"]`, `Object.keys(findingScope).length === 24`, every `findingCodes` member is a key and every key is a member of `findingCodes`, and filtering `findingCodes` on `findingScope[code] === "completeness"` equals exactly the two codes.
  **RED proof.**
- command: `node --test src/domain/plan-completeness.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/queries/plan/validate-plan.test.ts`
- exit: 1 — failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/domain/plan-completeness.ts' imported from src/domain/plan-completeness.test.ts` (the new seam, whole suite); `SyntaxError: The requested module './plan-finding.ts' does not provide an export named 'findingScope'` (suite-level import failure); `ℹ tests 70`, `ℹ pass 68`, `ℹ fail 2` — the 68 passes are `plan-validate.test.ts`, `plan-candidate.test.ts` and `validate-plan.test.ts` unchanged, so the extraction's behaviour pin is already green.
- The two failing suites are exactly the two RED targets. Once the seam and the two exports exist, the message tests, the order test and the path/id tests assert the Story's exact contract; the wrong-kind and null-parentKey tests pin the child-kind match that keeps `plan-validate` and `plan-candidate` behaviour identical.
- stub probe: `src/domain/plan-completeness.ts` — with a throwaway stub holding the Story-pinned signatures (`CompletenessParent`, `CompletenessChild`, `CompletenessInput`, `completenessFindings`), `npm run typecheck` reports 0 errors in `plan-completeness.test.ts`; the only remaining errors are `TS2724: no exported member named 'findingScope'` and `TS2305: no exported member 'validationScopes'` in `plan-finding.test.ts` (TS2305 pattern of Stories 6-9, the SE's lane). Stub deleted; no trace at handoff.
  **Open to Software Engineer.**
- `src/domain/plan-completeness.ts` (new) — export the three types and one function exactly as the Story's `## Change` fenced blocks declare: `CompletenessParent` (`kind: NodeKind; key: string; path: string | null; id: string | null`), `CompletenessChild` (`kind: NodeKind; parentKey: string | null`), `CompletenessInput` (`subject: "document" | "record"`; `parents`; `children`), `completenessFindings(input): readonly Finding[]`. Pure function: walk `parents` in input order, at most one finding per parent, sort nothing; `task` emits nothing; `initiative` requires an `objective` child with equal `parentKey`, `objective` requires a `task` child; message `the ${parent.kind} holds no ${requiredChildKind}` plus the suffix ` document` for `subject: "document"`; finding carries `path` and `id` from the parent. Imports only `type NodeKind` from `./state.ts` and `type Finding` from `./plan-finding.ts`. The type is named `Finding`, not `PlanFinding`.
- `src/domain/plan-finding.ts` — `validationScopes`/`ValidationScope` above `findingCodes`; `findingScope: Readonly<Record<FindingCode, ValidationScope>>` after the `Finding` type, keys in `findingCodes` order, with exactly `initiative-without-objective` and `objective-without-task` as `completeness` and every other code `structural`.
- `src/domain/plan-validate.ts:241-268` — delete the two-branch block and call `completenessFindings` once with `subject: "document"`, parents from `resolved` keyed by path (`id: null`), children from `kindChecked` keyed by `derivedParentPath`, per the Story's fenced call; add the import.
- `src/domain/plan-candidate.ts:123-150` — delete the two-branch block and call `completenessFindings` once with `subject: "record"`, both lists from `candidate.nodes` (`path: null`, keyed by id/`parentId`), per the Story's fenced call; add the import.
- `docs/proposal/phase-1/state-machine.md:47` — replace the line with exactly `An objective with no tasks, or an initiative with no objectives, is incomplete. Every write reports the finding and commits. A claim under an incomplete node is refused.` (Story 1's parity test does not read line 47; no other doc edit in this Story).
- Constraints: no branch reads `findingScope`; no structural validity function; no sort inside `completenessFindings`; `import-plan.ts:214-219` and `:337-343` stay exactly as they are (the gap between the amended line 47 and the current refusal is deliberate and belongs to EPIC 017); the three existing suites must stay green with no test edit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 10 — validity split

**Cycle.** GREEN for `src/domain/plan-completeness.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/queries/plan/validate-plan.test.ts` (RED turn: `ERR_MODULE_NOT_FOUND: .../src/domain/plan-completeness.ts` and `no exported member named 'findingScope'`).
**Files changed.**

- `src/domain/plan-completeness.ts` (new) — `CompletenessParent`, `CompletenessChild`, `CompletenessInput`, `completenessFindings(input): readonly Finding[]`. Pure; walks `parents` in input order, at most one finding per parent, no sort; `task` emits nothing; `initiative` requires an `objective` child of equal `parentKey`, `objective` requires a `task` child; message `` `the ${kind} holds no ${childKind}` `` plus ` document` for `subject: "document"`; finding copies `path` and `id` from the parent. Imports only `type Finding` from `./plan-finding.ts` and `type NodeKind` from `./state.ts`.
- `src/domain/plan-finding.ts` (edited) — `validationScopes`/`ValidationScope` above `findingCodes`; `findingScope: Readonly<Record<FindingCode, ValidationScope>>` after the `Finding` type, keys in `findingCodes` order, exactly `initiative-without-objective` and `objective-without-task` as `completeness`, every other code `structural`.
- `src/domain/plan-validate.ts` (edited) — the two-branch block between the `parent-missing` loop and the dependency loop deleted; one call to `completenessFindings` with `subject: "document"`, parents from `resolved` keyed by path (`id: null`), children from `kindChecked` keyed by `derivedParentPath`; import added after `plan-body.ts` in sorted order.
- `src/domain/plan-candidate.ts` (edited) — the two-branch block between the parent loop and the worker loop deleted; one call with `subject: "record"`, both lists from `candidate.nodes` (`path: null`, keyed by id/`parentId`); import added after `identity.ts` in sorted order.
- `docs/proposal/phase-1/state-machine.md` (edited) — line 47 now reads exactly `An objective with no tasks, or an initiative with no objectives, is incomplete. Every write reports the finding and commits. A claim under an incomplete node is refused.` (Story 1's parity test does not read line 47.)
  **Seam (GREEN).** `completenessFindings` exists with the Story-pinned contract (both subjects, empty-parent, empty-children, satisfied, wrong-kind, null-parentKey, path/id copy, parents order); `validationScopes` and `findingScope` are exported with the total 24-key map; both callers now delegate to the one function with behaviour and finding order unchanged, so the untouched `plan-validate`, `plan-candidate` and `validate-plan` suites stay green.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint` on the four edited production files): exit 0
- runtime probe (plain `node`, not the test runner): `validationScopes` deep-equals `["structural","completeness"]`; `findingScope` has 24 keys in exact `findingCodes` order; completeness set is exactly the two codes; sample document-subject finding emits `the initiative holds no objective document` with parent `path`/`id` copied; satisfied record case returns `[]`
- doc probe: `grep -c "is invalid. Import rejects it"` → 0; the amended sentence sits at `state-machine.md:47` verbatim
  **Assumptions.**
- VERIFIED: `plan-completeness.ts` imports only `./plan-finding.ts` and `./state.ts` (both `import type`), names no `Date.now(`/`new Date(`/`Math.random(`, and sorts nothing, per the Story constraints and `layout.test.ts:55-66`.
- VERIFIED: the old `plan-validate` children check matched `derivedParentPath` only; adding the kind match is behaviour-preserving per `plan-path.ts:132-139` (kind is derived from the path), and the fenced call adds it as the Story dictates.
- NOTE: the amended `state-machine.md:47` states the EPIC 017 contract, not the code after this epic — `import-plan.ts:214-219` and `:337-343` still refuse a completeness finding and stay exactly as they are, per the Story's constraint.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 11 — two concurrency classes

**Cycle.** Confirm-GREEN Story 10, then RED for Task `11-revision-guard-classes` (`node --test src/domain/revision-guard.test.ts`).
**Confirm GREEN (Story 10).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/plan-completeness.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/queries/plan/validate-plan.test.ts` → exit 0, `ℹ tests 82`, `ℹ pass 82`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/revision-guard.test.ts` (new) — suite: `src/domain/revision-guard.test` — methods: `nodeWriteKinds pins the four write kinds in order`, `revisionGuardClasses pins the two classes in order`, `revisionGuardFor maps update-fields to node and every other kind to project`, `the revision guard result set is exactly node and project`
- asserts: `[...nodeWriteKinds]` deep-equals `["create", "update-fields", "update-topology", "delete"]` with length 4; `[...revisionGuardClasses]` deep-equals `["node", "project"]` with length 2; one `revisionGuardFor` assertion per member — `create` → `project`, `update-fields` → `node`, `update-topology` → `project`, `delete` → `project`; `new Set(nodeWriteKinds.map(revisionGuardFor))` has size 2 and `[...set].sort()` deep-equals `["node", "project"]` — a third class fails it.
  **RED proof.**
- command: `node --test src/domain/revision-guard.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/domain/revision-guard.ts' imported from src/domain/revision-guard.test.ts`; `ℹ pass 0`, `ℹ fail 1` — the suite-level failure is the missing seam file, the Story 10 pattern: the file does not exist, so `node --test` fails on the path, and every assertion of the suite is the Story-pinned contract.
- stub probe: `src/domain/revision-guard.ts` — with a throwaway stub holding the Story-pinned declarations (`nodeWriteKinds`, `NodeWriteKind`, `revisionGuardClasses`, `RevisionGuardClass`, `revisionGuardFor` with a `throw` body), `npm run typecheck` reports 0 errors in `revision-guard.test.ts`; the test-file types are clean. Stub deleted; no trace at handoff.
  **Open to Software Engineer.**
- `src/domain/revision-guard.ts` (new) — export the two tuples, two types and one function exactly as the Story's `## Change` fenced block declares: `nodeWriteKinds`, `NodeWriteKind`, `revisionGuardClasses`, `RevisionGuardClass`, `revisionGuardFor(kind: NodeWriteKind): RevisionGuardClass`. Pure and total over the closed set: `update-fields` returns `node`, `create`, `update-topology` and `delete` return `project`. No `default` branch, no `throw`, no import (the file needs neither a domain import nor `zod`). Add no consumer — EPIC 017 reads this file. `revisionGuardClasses` stays a tuple so the value set stays assertable.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 11 — two concurrency classes

**Cycle.** GREEN for `src/domain/revision-guard.test.ts` (RED turn: `ERR_MODULE_NOT_FOUND: Cannot find module '.../src/domain/revision-guard.ts'` — the missing seam file).
**Files changed.**

- `src/domain/revision-guard.ts` (new) — `nodeWriteKinds` tuple (`create`, `update-fields`, `update-topology`, `delete`), `NodeWriteKind`; `revisionGuardClasses` tuple (`node`, `project`), `RevisionGuardClass`; `revisionGuardFor(kind): RevisionGuardClass` as the Story's fenced ternary — `update-fields` returns `node`, every other kind returns `project`. No `default` branch, no `throw`, no import (the file needs neither a domain import nor `zod`).
  **Seam (GREEN).** The suite imports `./revision-guard.ts` and asserts the two tuples' order and length, one `revisionGuardFor` assertion per kind, and the result set exactly `{ node, project }` via `Set` size 2 — all satisfied by the pinned file.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/revision-guard.ts`): exit 0
- runtime probe (plain `node`, not the test runner): all four `revisionGuardFor` mappings, both tuple orders and both lengths hold — `PROBE OK`
  **Assumptions.**
- VERIFIED: `revisionGuardClasses` stays a tuple (`as const`), so the value set stays assertable; no consumer added — EPIC 017 reads this file; the file body is byte-identical to the Story's fenced block.
- VERIFIED: `eslint.config.js:230-247` permits only relative domain imports and `zod` in `src/domain/` — this file imports neither, so lint passes under the layer rule.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 12 — external transition table

**Cycle.** Confirm-GREEN Story 11, then RED for Task `12-external-transition-table` (`node --test src/domain/external-transition.test.ts src/domain/transition.test.ts`).
**Confirm GREEN (Story 11).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/revision-guard.test.ts` → exit 0, `ℹ tests 4`, `ℹ pass 4`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/external-transition.test.ts` (new) — suite: `src/domain/external-transition.test` — methods: `externalTriggerIds pins the six trigger ids in row order`, `externalTransitions holds exactly six rows in exactly the declared order`, `every row names a legal cell`, `every row carries runDriver external and activeRun true`, `the object-reported row carries a valid lease fence and the harness actor kind`, `the outcome-accepted row carries a required reported object id`, `the attempt-rejected row carries the attempt-rejected precondition`, `the outcome-accepted row carries the outcome-accepted precondition`, `the attempt-limit-reached row carries the attempt-limit-reached precondition`, `the object-reported row carries the object-reported precondition`, `the human-close row carries the human-close precondition`, `the human-close-partial row carries the human-close-partial precondition`
- asserts: the six expected `{ level, from, to, trigger, precondition }` objects written as literals, `assert.deepEqual(externalTransitions, expected)`, `externalTransitions.length === 6`, and `externalTransitions.map(row => row.trigger)` deep-equals `[...externalTriggerIds]`; `externalTriggerIds.length === 6` with `new Set(...).size === 6`; the legal-cell test drives `canTransition(row.level, row.from, row.to) === true` per row (imported from `./transition.ts`); the driver test asserts `runDriver === "external"` and `activeRun === true` on every row; the two row-level tests pin `object-reported` → `leaseFence: "valid"` + `actorKind: "harness"` and `outcome-accepted` → `reportedObjectId: "required"`; one `it` per trigger reads its row by trigger id and asserts each of the seven precondition fields with a separate `assert.equal` plus the `level`, `from` and `to` cells.
  **RED proof.**
- command: `node --test src/domain/external-transition.test.ts src/domain/transition.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/domain/external-transition.ts' imported from src/domain/external-transition.test.ts`; `ℹ pass 16`, `ℹ fail 1` — the 16 passes are the untouched `transition.test.ts` suite, so the matrix cells the six rows name are already legal; the whole new suite fails at the missing seam import, and every assertion inside is the Story-pinned contract (exact row literals, exact id set, per-field preconditions).
- stub probe: `src/domain/external-transition.ts` — with a throwaway stub holding the Story's fenced declarations (`externalTriggerIds`, `ExternalTriggerId`, `ExternalPrecondition`, `ExternalTransition`, `externalTransitions` with an empty body), `npm run typecheck` reports 0 errors in `external-transition.test.ts`; the test-file types are clean against the pinned signatures. Stub deleted; no trace at handoff (`git status` clean of the file, RED re-confirmed after deletion).
  **Open to Software Engineer.**
- `src/domain/external-transition.ts` (new) — the Story's `## Change` fenced blocks, verbatim: `externalTriggerIds` tuple + `ExternalTriggerId`; `ExternalPrecondition` (seven closed fields, none optional); `ExternalTransition`; `externalTransitions` with exactly the six rows in exactly the declared order, every row carrying `runDriver: "external"` and `activeRun: true`. Imports only `type NodeKind` and `type NodeState` from `./state.ts` and `type RunDriver` from `./run.ts`; no `zod`, no clock. Add no `objectiveDrivePin`, no `externalTriggerConsumer` (Stories 14 and 15 own them), no internal trigger (Story 13 owns the internal table), and no consumer — EPIC 019 reads this file.
- Constraints: `src/domain/layout.test.ts:55-66` refuses `Date.now(`/`new Date(`/`Math.random(` in the file; every `ExternalPrecondition` field is required with no default; the six-cell/56-row `transition.ts` matrix is unchanged (the Story's legal-cell assertion passes on the current tree and must stay passing).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 12 — external transition table

**Cycle.** GREEN for `src/domain/external-transition.test.ts src/domain/transition.test.ts` (RED turn: `ERR_MODULE_NOT_FOUND: Cannot find module '.../src/domain/external-transition.ts'` — the missing seam file).
**Files changed.**

- `src/domain/external-transition.ts` (new) — `externalTriggerIds` tuple + `ExternalTriggerId`; `ExternalPrecondition` (seven closed fields, none optional); `ExternalTransition`; `externalTransitions` with exactly the six rows in exactly the declared order, every row carrying `runDriver: "external"` and `activeRun: true`. Imports only `type RunDriver` from `./run.ts` and `type NodeKind`, `type NodeState` from `./state.ts`; no `zod`, no clock.
  **Seam (GREEN).** The suite imports the new module and asserts `externalTransitions.length === 6`, the row literals via `assert.deepEqual`, `row.trigger` deep-equals `[...externalTriggerIds]`, `new Set(externalTriggerIds).size === 6`, legal cells via `canTransition`, the driver/active pair on every row, and each precondition field per trigger — all satisfied by the Story's fenced blocks verbatim.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/external-transition.ts`): exit 0
- runtime probe (plain `node`, not the test runner): 6 rows, trigger order matches `[...externalTriggerIds]`, set size 6, every row `runDriver: "external"` + `activeRun: true`, levels only `task`/`objective` — `PROBE OK`
  **Assumptions.**
- VERIFIED: the file names no `Date.now(`/`new Date(`/`Math.random(` and imports only the three pinned type paths, so `layout.test.ts:55-66` and the import-matrix lint cannot fire.
- VERIFIED: `externalTransitions` is declared `readonly ExternalTransition[]` with an `as const` body per the Story's fenced block; the six cells are already legal in the unchanged `transition.ts` matrix, so `canTransition(row.level, row.from, row.to) === true` holds on the current tree.
- VERIFIED: no `objectiveDrivePin`, no `externalTriggerConsumer`, no internal trigger, and no consumer added — Stories 13, 14 and 15 and EPIC 019 own them.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 13 — internal trigger table

**Cycle.** Confirm-GREEN Story 12, then RED for Task `13-internal-trigger-table` (`node --test src/domain/node-trigger.test.ts src/domain/external-transition.test.ts src/domain/transition.test.ts`).
**Confirm GREEN (Story 12).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/external-transition.test.ts src/domain/transition.test.ts` → exit 0, `ℹ tests 28`, `ℹ pass 28`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/node-trigger.test.ts` (new) — suite: `src/domain/node-trigger.test` — methods: `internalTriggerIds pins the fifteen trigger ids in row order`, `internalTransitions holds exactly fifteen rows in exactly the declared order`, `every levels list is non-empty, duplicate-free and fixed-order`, `every row names a legal cell at every level`, `the internal id set and the external id set are disjoint`, `triggerTransition returns the declared triple for every internal trigger`, `triggerTransition reads an external row's single level as a one-member list`, `the union of both tables covers every pair a command of EPICs 016, 018, 019 and 110 writes`
- asserts: the fifteen expected rows written as literals with `assert.deepEqual(internalTransitions, expected)` plus `length === 15`; `row.trigger` maps deep-equal `[...internalTriggerIds]` and the id set has size 15; the fixed-order check filters `["initiative", "objective", "task"]` by membership and deep-equals the result to `row.levels`; the legal-cell check drives `canTransition(level, row.from, row.to) === true` per row per level; the disjoint check holds `internalTriggerIds` against the external id set and pins the union at size 21; `triggerTransition` deep-equals the declared triple per internal row and the one-member `levels` list per external row; the pair-coverage check builds `` `${level}|${from}|${to}` `` over both tables (internal rows expanded across their levels), sorts, and deep-equals the nineteen Story entries.
  **RED proof.**
- command: `node --test src/domain/node-trigger.test.ts src/domain/external-transition.test.ts src/domain/transition.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/tuannguyen/Projects/kanthorlabs/kanthord-engine/src/domain/node-trigger.ts' imported from src/domain/node-trigger.test.ts`; `ℹ tests 29`, `ℹ pass 28`, `ℹ fail 1` — the 28 passes are the unchanged `external-transition.test.ts` and `transition.test.ts` suites, so the cells the fifteen rows name are already legal; the whole new suite fails at the missing seam import, and every assertion inside is the Story-pinned contract.
- stub probe: `src/domain/node-trigger.ts` — 1 error found: `TS2345` at `node-trigger.test.ts:173` — `externalTriggerIds.includes(id)` narrows the `includes` parameter to the external literals, so an `InternalTriggerId` argument is refused by the type; fixed in the test with a `new Set<string>([...externalTriggerIds])` membership check. Re-probe after the fix: `npm run typecheck` exits 0, 0 errors. Stub deleted; no trace at handoff (`git status` shows no `node-trigger.ts`; RED re-confirmed after deletion).
  **Open to Software Engineer.**
- `src/domain/node-trigger.ts` (new) — the Story's `## Change` fenced blocks, verbatim: imports only `type NodeKind` and `type NodeState` from `./state.ts` and `externalTransitions`, `externalTriggerIds` and `type ExternalTriggerId` from `./external-transition.ts`; `internalTriggerIds` tuple + `InternalTriggerId`; `NodeTriggerId = ExternalTriggerId | InternalTriggerId`; `InternalTransition` (levels, from, to, trigger — no `precondition` field); the fifteen rows in exactly the declared order; `triggerTransition(trigger: NodeTriggerId)` total and pure — look up `internalTransitions` first and return `{ levels: row.levels, from: row.from, to: row.to }`, then `externalTransitions` and return `{ levels: [row.level], from: row.from, to: row.to }`, throw on no match. Add no `precondition` to `InternalTransition`, move no external row to `levels`, add no `externalTriggerConsumer` entry, create no `setNodeState` (EPIC 016 owns it), and add no consumer of `triggerTransition`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 13 — internal trigger table

**Cycle.** GREEN for `src/domain/node-trigger.test.ts src/domain/external-transition.test.ts src/domain/transition.test.ts` (RED turn: `ERR_MODULE_NOT_FOUND: Cannot find module '.../src/domain/node-trigger.ts'` — the missing seam file).
**Files changed.**

- `src/domain/node-trigger.ts` (new) — `internalTriggerIds` tuple + `InternalTriggerId`; `NodeTriggerId = ExternalTriggerId | InternalTriggerId`; `InternalTransition` (levels/from/to/trigger, no `precondition`); `internalTransitions` with exactly the fifteen rows in exactly the declared order; `triggerTransition(trigger)` total and pure — `internalTransitions` lookup first, `externalTransitions` second, throw on no match. Imports only `type NodeKind` and `type NodeState` from `./state.ts` plus `externalTransitions`, `externalTriggerIds` and `type ExternalTriggerId` from `./external-transition.ts`; no `zod`, no clock.
  **Seam (GREEN).** The suite imports the new module and asserts `internalTransitions.length === 15`, the row literals via `assert.deepEqual`, `row.trigger` deep-equals `[...internalTriggerIds]`, set size 15, fixed-order non-duplicate `levels`, legal cells via `canTransition` per level, disjoint id sets with union size 21, `triggerTransition`'s declared triples for internal rows and one-member lists for external rows, and the nineteen-pair union coverage — all satisfied by the Story's fenced blocks verbatim.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`eslint src/domain/node-trigger.ts`): exit 0
- runtime probe (plain `node`, not the test runner): 15 rows / 15 ids / set size 15 / trigger order match; disjoint ids, union size 21; union of both tables sorted deep-equals the Story's nineteen pairs; `triggerTransition` returns the declared triple per internal row and one-member `levels` list per external row; throws on an unknown trigger — `PROBE OK`
  **Assumptions.**
- VERIFIED: no `precondition` field on `InternalTransition`, no external row moved to `levels`, no `externalTriggerConsumer` entry, no `setNodeState`, and no consumer of `triggerTransition` added — EPIC 016 and the later stories own them.
- VERIFIED: the file names no `Date.now(`/`new Date(`/`Math.random(` and imports only the two pinned modules, so `layout.test.ts:55-66` and the domain import-matrix lint cannot fire.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 14 — drive-mode pin

**Cycle.** Confirm-GREEN Story 13, then RED for Task `14-drive-mode-pin` (`node --test src/domain/external-transition.test.ts`).
**Confirm GREEN (Story 13).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/node-trigger.test.ts src/domain/external-transition.test.ts src/domain/transition.test.ts` → exit 0, `ℹ tests 36`, `ℹ pass 36`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/external-transition.test.ts` (edited) — suite: `src/domain/external-transition.test` — methods (nested `describe("objectiveDrivePin")`): `an empty run history pins nothing under either claim driver`, `a uniform run history pins nothing in both directions`, `a single-member run history matching the claim driver pins nothing in both directions`, `a run history holding only the other driver refuses it as pinnedDriver in both directions`, `a mixed run history refuses the first differing member in both directions`
- asserts: `objectiveDrivePin({ runDrivers: [], claimDriver: "internal" })` and the `"external"` twin both `assert.equal` `null`; `["internal", "internal"]` + `"internal"` and `["external", "external"]` + `"external"` both `null`; the single-member matching case in both directions (`["internal"]`/`"internal"`, `["external"]`/`"external"`) both `null`; the other-driver case deep-equals `{ pinnedDriver: "external", claimDriver: "internal" }` and its mirror `{ pinnedDriver: "internal", claimDriver: "external" }`; the mixed case returns the **first** differing member — `["internal", "external"]` + `"external"` deep-equals `{ pinnedDriver: "internal", claimDriver: "external" }`, and `["external", "internal"]` + `"internal"` deep-equals `{ pinnedDriver: "external", claimDriver: "internal" }`. All `as const` lists, so the input types check against `DrivePinInput` without naming `RunDriver` in the test.
  **RED proof.**
- command: `node --test src/domain/external-transition.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './external-transition.ts' does not provide an export named 'objectiveDrivePin'`; `ℹ tests 1`, `ℹ pass 0`, `ℹ fail 1` — the whole suite fails at the missing export import, the Story 12 pattern; the twelve assertions inside the new `describe` are the Story-pinned contract (empty, uniform, single-member, other-driver, first-differing-member, both directions each).
- stub probe: n/a — `npm run typecheck` reports TS2305, not TS2307: the module resolves, so `tsc` checks the whole test-file body and the only error is the missing `objectiveDrivePin` member (`error TS2305: Module '"./external-transition.ts"' has no exported member 'objectiveDrivePin'`, 0 other errors). No stub: `src/domain/external-transition.ts` is an existing production file, and the Story pins the exact signatures.
  **Open to Software Engineer.**
- `src/domain/external-transition.ts` — add below `externalTransitions`, per the Story's `## Change` fenced blocks exactly: `DrivePinInput` (`runDrivers: readonly RunDriver[]`; `claimDriver: RunDriver`), `DrivePinRefusal` (`pinnedDriver: RunDriver`; `claimDriver: RunDriver`), and `objectiveDrivePin(input: DrivePinInput): DrivePinRefusal | null` — `null` for an empty `runDrivers`, `null` when every member equals `claimDriver`, otherwise `{ pinnedDriver, claimDriver }` with `pinnedDriver` the **first** member that differs. `RunDriver` already imports from `./run.ts`. No clock, no SQL, no consumer (EPIC 018 enforces the pin inside `claimNode`), no third drive mode, and `externalTransitions`, `externalTriggerIds` and `ExternalPrecondition` stay unchanged.
- Constraints: `src/domain/layout.test.ts:55-66` refuses `Date.now(`/`new Date(`/`Math.random(` in the file; the function takes the driver list as input and reads no `run.driver`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 14 — drive-mode pin

**Cycle.** GREEN for `src/domain/external-transition.test.ts` (RED turn: `SyntaxError: The requested module './external-transition.ts' does not provide an export named 'objectiveDrivePin'`).
**Files changed.**

- `src/domain/external-transition.ts` (edited) — `DrivePinInput`, `DrivePinRefusal` and `objectiveDrivePin(input)` added below `externalTransitions`, exactly per the Story's fenced block: `null` for an empty `runDrivers`, `null` when every member equals `claimDriver`, otherwise `{ pinnedDriver, claimDriver }` with `pinnedDriver` the first differing member (`Array.prototype.find`).
  **Seam (GREEN).** The suite imports `objectiveDrivePin` and drives the twelve pinned cases (empty, uniform, single-member, other-driver, first-differing-member, both directions each) against the exported function — all satisfied: the `find` on `runDrivers` returns `undefined` for the empty and uniform cases (→ `null`) and the first differing member otherwise.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`npx eslint src/domain/external-transition.ts`): exit 0
- runtime probe (plain `node`, not the test runner): all ten Story-pinned call cases deep-equal their expected values — `PROBE OK (10/10)`
  **Assumptions.**
- VERIFIED: `RunDriver` already imports from `./run.ts:1`, so no import change; `externalTransitions`, `externalTriggerIds` and `ExternalPrecondition` untouched; no consumer, no clock, no SQL, no third drive mode; the file still names no `Date.now(`/`new Date(`/`Math.random(`, so `layout.test.ts:55-66` cannot fire.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 15 — trigger consumption map

**Cycle.** Confirm-GREEN Story 14, then RED for Task `15-trigger-consumer-map` (`node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts`).
**Confirm GREEN (Story 14).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/external-transition.test.ts` → exit 0, `ℹ tests 17`, `ℹ pass 17`, `ℹ fail 0`
  **Test written.**
- file: `src/domain/external-transition.test.ts` (edited) — suite: `src/domain/external-transition.test` — methods (nested `describe("externalTriggerConsumer")`): `is total over the external trigger ids`, `names a command module path under src/commands for every trigger`, `maps object-reported to the attestation command`, `names no aggregate-objective command`, `holds no internal trigger id as a key`, `maps the three report-outcome triggers and the two close triggers in id order`
- asserts: `Object.keys(externalTriggerConsumer).length === 6` plus `externalTriggerIds.length === keys.length`, every member of `externalTriggerIds` is a key (`id in`), and every key is a member (`(externalTriggerIds as readonly string[]).includes(key)` — the Story 13 cast pattern, because the tuple's `includes` narrows to the literals); every value `startsWith("src/commands/")`; `externalTriggerConsumer["object-reported"]` equals `src/commands/outcome/report-objective.ts`; no value equals or contains `src/commands/outcome/aggregate-objective.ts`; `internalTriggerIds` (imported from `./node-trigger.ts`) yields no key (`!(id in externalTriggerConsumer)`); filtering `externalTriggerIds` on the `report-outcome.ts` value deep-equals `["attempt-rejected", "outcome-accepted", "attempt-limit-reached"]` and on the `close-objective.ts` value deep-equals `["human-close", "human-close-partial"]`.
  **RED proof.**
- command: `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './external-transition.ts' does not provide an export named 'externalTriggerConsumer'` (at `src/domain/external-transition.test.ts:1:1`); `ℹ tests 9`, `ℹ pass 8`, `ℹ fail 1` — the 8 passes are the untouched `node-trigger.test.ts` suite; the whole `external-transition.test.ts` suite fails at the missing export import, the Story 12 pattern, and every assertion inside the new `describe` is the Story-pinned contract.
- stub probe: `src/domain/external-transition.ts` — temporarily appended the Story's fenced map below `objectiveDrivePin` and re-ran `npm run typecheck`: exits 0, 0 errors, so the test-file types are clean against the pinned signatures (the two TS18046 `value is of type unknown` errors seen in the pre-probe run are artifacts of the missing binding and vanish once the export exists). Stub removed; the file is restored to its 145-line original (`git status` unchanged: still untracked as before, no trace of the probe).
  **Open to Software Engineer.**
- `src/domain/external-transition.ts` — add below `objectiveDrivePin`, per the Story's fenced block exactly: `externalTriggerConsumer: Readonly<Record<ExternalTriggerId, string>>` with the six entries — `attempt-rejected`, `outcome-accepted` and `attempt-limit-reached` map to `src/commands/outcome/report-outcome.ts`; `object-reported` to `src/commands/outcome/report-objective.ts`; `human-close` and `human-close-partial` to `src/commands/outcome/close-objective.ts`. No value names `src/commands/outcome/aggregate-objective.ts`. Change no other file: `externalTransitions`, `externalTriggerIds`, `ExternalPrecondition`, `objectiveDrivePin` and every file under `src/commands/` stay untouched (the three command files do not exist yet — EPIC 019 owns the on-disk existence check).
- Constraints: no source scan and no per-file allow list (the deleted literal-pair scan is not restored); the map is keyed by `ExternalTriggerId` only, so an internal trigger id cannot be a key.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 15 — trigger consumption map

**Cycle.** GREEN for `src/domain/external-transition.test.ts src/domain/node-trigger.test.ts` (RED turn: `SyntaxError: The requested module './external-transition.ts' does not provide an export named 'externalTriggerConsumer'`).
**Files changed.**

- `src/domain/external-transition.ts` (edited) — `externalTriggerConsumer: Readonly<Record<ExternalTriggerId, string>>` added below `objectiveDrivePin`, exactly per the Story's fenced block: the six entries — `attempt-rejected`, `outcome-accepted` and `attempt-limit-reached` map to `src/commands/outcome/report-outcome.ts`; `object-reported` to `src/commands/outcome/report-objective.ts`; `human-close` and `human-close-partial` to `src/commands/outcome/close-objective.ts`. No value names `src/commands/outcome/aggregate-objective.ts`.
  **Seam (GREEN).** The suite imports `externalTriggerConsumer` and asserts totality over `externalTriggerIds` (six keys, both directions), the `src/commands/` prefix on every value, the `object-reported` attestation command, no `aggregate-objective.ts` value, no internal trigger id as a key (against `internalTriggerIds` from `./node-trigger.ts`), and the filtered key order for the `report-outcome.ts` and `close-objective.ts` values — all satisfied by the map literal. The `Record<ExternalTriggerId, string>` key type admits no internal trigger id, so the disjoint check cannot fail by construction.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- lint (`npx eslint src/domain/external-transition.ts`): exit 0
- runtime probe (plain `node`, not the test runner): six keys total, both inclusion directions, every value `startsWith("src/commands/")`, `object-reported` maps to `report-objective.ts`, no `aggregate-objective` in any value, no internal id is a key, and the two filtered key lists deep-equal the Story's orders — `PROBE OK`
  **Assumptions.**
- VERIFIED: `externalTransitions`, `externalTriggerIds`, `ExternalPrecondition` and `objectiveDrivePin` untouched; no file under `src/commands/` changed; no on-disk existence check added (the three command files do not exist yet — EPIC 019 owns it); no source scan and no per-file allow list.
- VERIFIED: the file still names no `Date.now(`/`new Date(`/`Math.random(` and imports only the two pinned modules, so `layout.test.ts:55-66` and the domain import-matrix lint cannot fire.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 014-external-drive-contract · Story 16 — domain document amendment (GREEN-only)

**Cycle.** Confirm-GREEN Story 15, then GREEN-ONLY pass-through for Task `16-domain-document-amendment`.
**Confirm GREEN (Story 15).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts` → exit 0, `ℹ tests 31`, `ℹ pass 31`, `ℹ fail 0`
  **Story file.** `.agents/plan/stories/014-external-drive-contract/16-domain-document-amendment.md` — "Document-only story. It writes no TypeScript." Run last; depends on Stories 4 (actor kinds) and 10 (validity scopes).
  **Tasks forwarded to Software Engineer.**
- `16-domain-document-amendment`: `docs/proposal/phase-1/domain.md` — insert the two fenced paragraphs verbatim at the exact anchors: the validity-scope paragraph after line 16 and before the `## Three entries above persist nothing` heading at line 18; the actor-kind paragraph after line 29 and before the `## Storage` heading at line 31; each separated by a blank line on each side.
  **No RED phase.** Coverage owned elsewhere per the Story's Verify: `node --test src/domain/rows.test.ts` exits 0 with no edit (the marker line `` `node:sqlite`. Tables: `` at line 33 and the first non-empty line after it at line 35 must survive), the four grep probes (`Plan validity holds two scopes` above the `## Three entries above persist nothing` heading; `An event names its actor kind` above `## Storage`; `harness` returns at least one line; `plan-completeness.ts` returns at least one line), `npm run verify`, and the Proof `PASS EPIC-014` through the unchanged `src/domain/*.test.ts` glob.
  **Open to Software Engineer.**
- Implement GREEN per the Story file's `## Change` and `## Constraints` sections. Constraints: change no other line of `docs/proposal/phase-1/domain.md` and no other file; `src/domain/rows.test.ts:59-90` takes the first non-empty line after the marker as the table declaration line and deep-equals its backticked names to `Object.keys(rows)`, so lines 33 and 35 stay byte-identical with nothing inserted between them; `rows.test.ts:46-57` requires every backticked table name to survive; neither new paragraph may add a backticked word to the table declaration line, and both sit outside the `## Storage` section entirely; write no TypeScript (`src/domain/event.ts:6` keeps `["human", "daemon"]` — EPIC 015 widens it). No refactor is named in this Story.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · Story 16 — domain document amendment

**Cycle.** GREEN-ONLY implementation for Tasks: `16-domain-document-amendment`.
**Files changed.**

- `docs/proposal/phase-1/domain.md` (edited) — two paragraphs inserted, each byte-identical to the Story's fenced blocks, each separated by a blank line on each side: the validity-scope paragraph after line 16 and before the `## Three entries above persist nothing` heading (now lines 18-20); the actor-kind paragraph after line 29 and before the `## Storage` heading (now lines 33-35). No other line of the file changed; no other file changed; no TypeScript written.
  **Seam (GREEN-ONLY).** No RED phase; coverage is owned by the unchanged `node --test src/domain/rows.test.ts` (the marker line `` `node:sqlite`. Tables: `` at line 37 and the first non-empty line after it at line 39 stay byte-identical with nothing inserted between them, and no backticked table name moved), the Story's four grep probes, `npm run verify`, and the Proof `PASS EPIC-014` through the unchanged `src/domain/*.test.ts` glob.
  **Refactor.** None named in this Story.
  **Build check.**
- typecheck: exit 0
- probe `grep -n "Plan validity holds two scopes"`: line 18, above the `## Three entries above persist nothing` heading at line 20
- probe `grep -n "An event names its actor kind"`: line 33, above the `## Storage` heading at line 35
- probe `grep -n "harness"`: present (line 33, two occurrences in the one paragraph)
- probe `grep -n "plan-completeness.ts"`: present (line 18)
  **Assumptions.**
- VERIFIED: both inserted paragraphs are byte-identical to the Story's fenced blocks; both sit outside the `## Storage` section, so neither adds a backticked lowercase-and-underscore word to the table declaration line; `src/domain/event.ts:6` untouched (keeps `["human", "daemon"]` — EPIC 015 widens it).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirm-GREEN Story 16 (build-only, GREEN-only), then full Verification Gate for EPIC 014. Every one of the 16 Stories is implemented and green: 01-03 and 06-15 went RED → GREEN, 04, 05 and 16 were document-only GREEN-only, and the one stale `ready`-refusal repair of Story 03 landed in the TE lane.
**Confirm GREEN (Story 16, GREEN-only).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `npm run typecheck` → exit 0
- command: `node --test src/domain/rows.test.ts` → exit 0, `ℹ tests 6`, `ℹ pass 6`, `ℹ fail 0` (the marker/declaration lines survived with no edit, per the Story's Verify)
- Story 16 Verify probes: `Plan validity holds two scopes` at `domain.md:18` above the `## Three entries above persist nothing` heading at line 20; `An event names its actor kind` at `domain.md:33` above the `## Storage` heading at line 35; `harness` present (count 1); `plan-completeness.ts` present (count 1).
  **EPIC verification gate.**
- `npm run verify` (Gates) → exit 0 (lint, migration application, verify db status ok)
- `npm run typecheck` → exit 0
- `npm test` (unit) → exit 0, `ℹ tests 3537`, `ℹ suites 357`, `ℹ pass 3537`, `ℹ fail 0`
  **Proof.**
- command: `node --test src/domain/*.test.ts src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/revision-guard.test.ts src/domain/plan-completeness.test.ts src/queries/plan/validate-plan.test.ts && echo "PASS EPIC-014"` → exit 0
- printed: `PASS EPIC-014` — `ℹ tests 954`, `ℹ suites 87`, `ℹ pass 954`, `ℹ fail 0`
- The four new files are named explicitly beside the domain glob and exist on disk, so the Proof exercised the full domain suite plus `validate-plan`, covering every Story's hermetic requirement (56-row matrix with the one flipped cell, the pending-source pair, the ready structural flip with the surviving containment guard, the six-row external table with per-field preconditions, the fifteen-row internal table with fixed-order levels, disjoint id sets, the total `triggerTransition`, the coverage union, the total `findingScope`/`externalTriggerConsumer`, the pin function in both directions, the four class mappings, and the per-field row refusals of `run`, `attempt`, `lease` and `plan_revision`).
  **Tasks closed.** 16 across 16 Stories — 01-state-machine-notes, 02-ready-to-pending-flip, 03-structural-edit-at-ready, 04-actor-model-amendment, 05-query-parameter-correction, 06-run-driver, 07-attempt-driver, 08-lease-owner-kind, 09-revision-provenance, 10-validity-split, 11-revision-guard-classes, 12-external-transition-table, 13-internal-trigger-table, 14-drive-mode-pin, 15-trigger-consumer-map, 16-domain-document-amendment. No Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/*.test.ts src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/revision-guard.test.ts src/domain/plan-completeness.test.ts src/queries/plan/validate-plan.test.ts && echo "PASS EPIC-014") — "PASS EPIC-014"
- stories: 16/16 complete
- date: 2026-08-14
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 pending-writer contract contradiction — docs/proposal/phase-1/state-machine.md:19 still names import and unblock as the only pending writers, while the matrix names topology writes too; revise the line to distinguish the blocked→pending and ready→pending writers.
BLOCKER: B2 ready parent-move contract contradiction — docs/proposal/phase-1/plan-format.md:124 permits parent changes only at pending or blocked, but the normative table and implementation now permit a movable ready node; include ready in the containment rule.

## TEST-ENGINEER — 014-external-drive-contract · review blockers B1 and B2 — regression tests

**Cycle.** Review-fix RED for the AUTO_REVIEW BLOCKERs B1 (`state-machine.md:19` pending-writer contradiction) and B2 (`plan-format.md:124` ready parent-move contradiction). One focused regression test per blocker, outside planned coverage, per the review-blocker exception (`node --test src/domain/transition.test.ts src/domain/plan-choice.test.ts`).
**Test written.**

- file: `src/domain/transition.test.ts` (edited) — suite: `src/domain/transition.test` — methods: `the pending-writer paragraph names the blocked→pending and ready→pending writers` (new)
- file: `src/domain/plan-choice.test.ts` (edited) — suite: `src/domain/plan-choice.test` — methods: `the containment rule admits a ready task parent change` (new)
- asserts: B1 — locate the pending-writer paragraph of `docs/proposal/phase-1/state-machine.md` by its surviving tail sentence (`An abandon never returns a node to \`pending\``) and assert it names the `ready→pending`topology writer and the import writer, names the`blocked→pending` `unblock`writer, and no longer carries the stale claim`the only writers of`. B2 — locate the task parent-change bullet of `docs/proposal/phase-1/plan-format.md` by its anchor (`A task changes parent only while it is`) and assert it names `` `ready` `` among the legal states and keeps the no-lease containment condition (`holds no lease`).
  **RED proof.**
- command: `node --test src/domain/transition.test.ts src/domain/plan-choice.test.ts`
- exit: 1 — failures: `AssertionError [ERR_ASSERTION]: the paragraph does not name the ready→pending topology writer` (at `src/domain/transition.test.ts:341`, B1 — the current line 19 names only import and `unblock`); `AssertionError [ERR_ASSERTION]: the containment bullet still refuses a parent change at ready` (at `src/domain/plan-choice.test.ts:503`, B2 — the current bullet 124 names only `pending` or `blocked`); `ℹ tests 39`, `ℹ pass 37`, `ℹ fail 2` (the 37 passes include every pre-existing assertion of both suites, so the blockers' regressions are the only red).
- stub probe: n/a — no missing seam: both tests parse documents only, and `npm run typecheck` exits 0 with the RED tests in place, 0 errors.
  **Open to Software Engineer.**
- B1 — `docs/proposal/phase-1/state-machine.md:19` — revise the paragraph so it distinguishes the two pending writers instead of claiming one only-writers set: `unblock` writes `blocked → pending`, and a topology write and an import write `ready → pending` when the accepted graph adds an unsatisfied dependency to a node that was already `ready` (the matrix note of line 70 amended in Story 02). The paragraph keeps naming import, `unblock` and `topology write`, and the phrase `the only writers of` is gone. Keep the `An abandon never returns a node to \`pending\``tail sentence. No code change:`src/domain/transition.ts` already carries the flipped cell from Story 02, and the B1 test parses the document only.
- B2 — `docs/proposal/phase-1/plan-format.md:124` — the task parent-change bullet names `ready` alongside `pending` and `blocked` (the structural `ready` row at line 109 and `choiceVerdict` of Story 03 both permit a movable `ready` node), and it keeps the no-lease/no-workspace/no-attempt-commit/no-retained-commit condition word for word. No code change: the `containmentMovable` guard in `src/domain/plan-choice.ts` already covers `ready` from Story 03, and the B2 test parses the document only.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 014-external-drive-contract · review blockers B1 and B2 — document seams

**Cycle.** GREEN for the two review-fix regression tests (`node --test src/domain/transition.test.ts src/domain/plan-choice.test.ts`, RED turn: `the paragraph does not name the ready→pending topology writer` at `transition.test.ts:341` and `the containment bullet still refuses a parent change at ready` at `plan-choice.test.ts:503`).
**Files changed.**

- `docs/proposal/phase-1/state-machine.md` (edited) — line 19: the pending-writer paragraph now reads `` `unblock` writes `blocked → pending`, and a topology write and an import write `ready → pending` when the accepted graph adds an unsatisfied dependency to a node that was already `ready`. `unblock` clears the block reason and nothing else, and the scheduler then re-derives readiness. An abandon never returns a node to `pending`. `` — the `the only writers of` claim is gone, the tail sentence is kept verbatim, and no matrix row moved.
- `docs/proposal/phase-1/plan-format.md` (edited) — line 124: the task parent-change bullet now names `` `ready` `` alongside `` `pending` `` and `` `blocked` `` — `` while it is `pending`, `ready` or `blocked` `` — and keeps the containment condition word for word (`holds no lease, no workspace, no attempt commit and no retained commit`).
  **Review blocker addressed.** B1 — `docs/proposal/phase-1/state-machine.md:19 still names import and unblock as the only pending writers, while the matrix names topology writes too; revise the line to distinguish the blocked→pending and ready→pending writers.` (both writers named, only-writers claim removed). B2 — `docs/proposal/phase-1/plan-format.md:124 permits parent changes only at pending or blocked, but the normative table and implementation now permit a movable ready node; include ready in the containment rule.` (`ready` named, no-lease condition kept).
  **Seam (GREEN).** B1: the paragraph still locates by the `An abandon never returns a node to \`pending\``tail sentence and now contains`topology write`, `import`and`unblock`while containing no`the only writers of`. B2: the bullet still locates by `A task changes parent only while it is` and now contains `` `ready` `` and `holds no lease`. No code change: `src/domain/transition.ts`already carries the flipped cell from Story 02 and`src/domain/plan-choice.ts`already covers`ready` from Story 03 — both blockers were document-only.
  **Refactor.** None named in this review-fix.
  **Build check.**
- typecheck: exit 0
- probe (plain string checks, not the test runner): all five B1 assertions and all four B2 assertions hold — `PROBE OK (9/9)`
  **Assumptions.**
- VERIFIED: the B1 paragraph is a prose line, not a matrix row, so the Story 1 parity test (36 pipe-rows only) and the five-notes test cannot see the change; no test under `src/` parses `plan-format.md`, so the B2 bullet edit cannot stale a sibling suite.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Confirm-GREEN of the two review-fix regression tests (AUTO_REVIEW BLOCKERs B1 and B2), then a fresh full Verification Gate for EPIC 014. All 16 Stories plus the two blocker repairs are green.

**Confirm GREEN (review blockers B1 and B2).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean` (SE's typecheck claim re-verified independently)
- command: `node --test src/domain/transition.test.ts src/domain/plan-choice.test.ts` → exit 0, `ℹ tests 39`, `ℹ suites 2`, `ℹ pass 39`, `ℹ fail 0` — both regression tests pass: `the pending-writer paragraph names the blocked→pending and ready→pending writers` (B1, `state-machine.md:19` names `unblock` for `blocked → pending` and the topology/import writers for `ready → pending`, with `the only writers of` gone) and `the containment rule admits a ready task parent change` (B2, `plan-format.md:124` names `` `ready` `` alongside `` `pending` ``/`` `blocked` `` and keeps the no-lease condition).

**EPIC verification gate.**

- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0, `ℹ tests 3539`, `ℹ suites 357`, `ℹ pass 3539`, `ℹ fail 0`
- Gates (`npm run verify`) → exit 0 (lint clean, migrations 1-4 applied, `kanthord: verify db status ok`)

**Proof.**

- command: `node --test src/domain/*.test.ts src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/revision-guard.test.ts src/domain/plan-completeness.test.ts src/queries/plan/validate-plan.test.ts && echo "PASS EPIC-014"` → exit 0
- printed: `PASS EPIC-014` — `ℹ tests 956`, `ℹ suites 87`, `ℹ pass 956`, `ℹ fail 0`
- The four new files are named explicitly beside the domain glob and exist on disk; the Proof exercised the full domain suite plus `validate-plan`, covering every Story's hermetic requirement (56-row matrix with the one flipped cell, the pending-source pair, the ready structural flip with the surviving containment guard, the six-row external table with per-field preconditions, the fifteen-row internal table with fixed-order levels, disjoint id sets, the total `triggerTransition`, the coverage union, the total `findingScope`/`externalTriggerConsumer`, the pin function in both directions, the four class mappings, the per-field row refusals of `run`, `attempt`, `lease` and `plan_revision`, and the two review-blocker document-parity assertions).

**Tasks closed.** 16 across 16 Stories — 01-state-machine-notes, 02-ready-to-pending-flip, 03-structural-edit-at-ready, 04-actor-model-amendment, 05-query-parameter-correction, 06-run-driver, 07-attempt-driver, 08-lease-owner-kind, 09-revision-provenance, 10-validity-split, 11-revision-guard-classes, 12-external-transition-table, 13-internal-trigger-table, 14-drive-mode-pin, 15-trigger-consumer-map, 16-domain-document-amendment. No Story outstanding; the two AUTO_REVIEW BLOCKERs B1 and B2 are resolved and regression-pinned.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/*.test.ts src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/revision-guard.test.ts src/domain/plan-completeness.test.ts src/queries/plan/validate-plan.test.ts && echo "PASS EPIC-014") — "PASS EPIC-014"
- stories: 16/16 complete
- date: 2026-08-14
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
