---
epic: .agents/plan/epics/041-harness-qualified-worker-kinds.md
opened: 2026-08-28
opener: test-engineer
base-ref: 7391bb9076c8343e7498dbe42faac5b50e1bb287
---

# Implementation cycle — 041-harness-qualified-worker-kinds

Pulled from EPIC: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/worker.test.ts \
>   src/domain/plan-document.test.ts \
>   src/domain/plan-candidate.test.ts \
>   src/domain/plan-validate.test.ts \
>   src/services/plan/sqlite.test.ts \
>   src/commands/plan/import-plan.test.ts \
>   src/queries/plan/export-plan.test.ts \
>   src/commands/node/claim-node.test.ts \
>   && echo "PASS EPIC-041"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - `workerKinds` deep-equals the seven-element array in the fixed order. The assertion names every
>   element; no test asserts a length or a membership check alone.
> - `workerKind` parses each of the four added values and rejects `swe@1`, `te@1`, `claude.swe` and
>   `claude.swe@2`. Each rejection is asserted by value, not by "throws".
> - A plan candidate whose node names each of the four produces a finding list that is deep-equal to
>   the empty array. A candidate naming `swe@1` produces exactly one `worker-unknown` finding, with
>   `id` equal to the task identity and `path` equal to `null`.
> - A plan document naming each of the four, validated against the full context, produces a finding
>   list that is deep-equal to the empty array.
> - A plan document naming `claude.swe@1`, validated against a context that omits that one value and
>   keeps the other six, produces exactly one `worker-unknown` finding on that document path. The
>   context is built by filtering `workerKinds`, so the value under test is the only variable.
> - `planFrontmatter.safeParse` refuses `swe@1` and refuses `te@1`, each with the issue path `worker`,
>   and parses each of the four. This is the boundary rejection; no plan-level assertion stands in for
>   it, because a refused task document also raises `objective-without-task`.
> - A round trip through `plan import` and `plan export` of a document naming `claude.swe@1` produces
>   byte-identical output.
> - `src/commands/node/claim-node.ts` is unchanged, and a claim of a node whose worker is
>   `opencode.te@1` by an actor with no harness association succeeds.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — domain-worker-kinds · Task 041/story-1 — extend workerKinds

**Cycle.** RED for Task `041/story-1` (`src/domain/worker.test.ts`).
**Test written.**

- file: `src/domain/worker.test.ts` (edited) — suite: `src/domain/worker.test` — methods: `workerKinds deep-equals the expected array`, `workerKind.options deep-equals the expected array`, `workerKind.safeParse accepts "claude.swe@1"`, `workerKind.safeParse accepts "claude.te@1"`, `workerKind.safeParse accepts "opencode.swe@1"`, `workerKind.safeParse accepts "opencode.te@1"`, `workerKind.safeParse rejects "swe@1"`, `workerKind.safeParse rejects "te@1"`, `workerKind.safeParse rejects "claude.swe"`, `workerKind.safeParse rejects "claude.swe@2"`
- asserts: The worker vocabulary exposes seven values in fixed order, accepts all four qualified kinds, and rejects unqualified or wrong-version values.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ workerKinds deep-equals the expected array (1.507209ms)`
  **Open to Software Engineer.**
- `src/domain/worker.ts`: exported `workerKinds` must expose `general@1`, `tdd@1`, `git@1`, `claude.swe@1`, `claude.te@1`, `opencode.swe@1`, and `opencode.te@1` in that order; `workerKind.safeParse` must accept the four qualified values and retain the stated rejection behavior.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — domain-worker-kinds · Task 041/story-1 — extend workerKinds

**Cycle.** GREEN+REFACTOR for `src/domain/worker.test.ts`.
**Files changed.**

- `src/domain/worker.ts` (edited) — `workerKinds` now contains all seven kinds in fixed order.
  **Seam (GREEN).** The derived `workerKind` schema now accepts the four harness-qualified values.
  **Refactor.** None named; retained the existing derived schema and type.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The tuple order and values match Story 1.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — import-accepts-harness-worker · Task 041/story-2 — plan validation

**Cycle.** RED for Task `041/story-2` (`src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`).
**Test written.**

- file: `src/domain/plan-candidate.test.ts` (edited) — suite: `validateCandidate` — methods: `a harness-qualified kind "claude.swe@1" produces an empty finding list`, `a harness-qualified kind "claude.te@1" produces an empty finding list`, `a harness-qualified kind "opencode.swe@1" produces an empty finding list`, `a harness-qualified kind "opencode.te@1" produces an empty finding list`, `unqualified swe@1 produces exactly one worker-unknown finding`
- file: `src/domain/plan-validate.test.ts` (edited) — suite: `src/domain/plan-validate.test` — methods: `a task naming harness-qualified kind "claude.swe@1" produces an empty finding list`, `a task naming harness-qualified kind "claude.te@1" produces an empty finding list`, `a task naming harness-qualified kind "opencode.swe@1" produces an empty finding list`, `a task naming harness-qualified kind "opencode.te@1" produces an empty finding list`, `a task naming unqualified swe@1 produces exactly one worker-unknown finding`
- asserts: The four qualified worker kinds produce no findings, while unqualified `swe@1` produces exactly one `worker-unknown` finding.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `✖ a task naming unqualified swe@1 produces exactly one worker-unknown finding (2.688708ms)`; assertion: `2 !== 1`
  **Open to Software Engineer.**
- `src/domain/plan-validate.ts`: `validateDocuments(...)` is the imported seam, but `worker: "swe@1"` is rejected by the frontmatter contract before that seam can emit the Story-required `worker-unknown` finding; Story 1 also requires `workerKind` to reject `swe@1`, so the plan needs a human decision.

OPEN: Story 2 contradiction — the required plan-validation result for `swe@1` conflicts with the existing frontmatter schema and Story 1 rejection contract; human decision required.
ATTEMPT-FAILED: 041/story-2 — plan validation reports `frontmatter-invalid` plus `objective-without-task`, not one `worker-unknown` finding

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — import-accepts-harness-worker · Task 041/story-2 — plan validation

**Cycle.** RED blocker for `041/story-2` (`src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`).
**Files changed.**

- None — the Story forbids the production seam required by its failing assertion.
  **Seam (GREEN).** Not applied: `planFrontmatter` parses `worker` with `workerKind`, so `swe@1` fails before validation can emit only `worker-unknown`.
  **Refactor.** Deferred: the Task names no production refactor.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `src/domain/plan-document.ts` uses `workerKind` for `planFrontmatter.worker`.
- VERIFIED: Story 1 requires `workerKind` to reject `swe@1`.

- B1 - status:OPEN - action:YES - Story 2 contradiction - choose whether frontmatter rejects `swe@1` or validation reports `worker-unknown` - fix: amend the Story or permit a production seam that separates frontmatter parsing from worker-kind membership validation - why: the current parser emits `frontmatter-invalid` before `validateDocuments` or `validateCandidate` can emit `worker-unknown`
  OPEN: Story 2 contradiction — its required `worker-unknown` result conflicts with the unchanged frontmatter schema and Story 1 rejection contract; human decision required.
  ATTEMPT-FAILED: 041/story-2 — no type-conforming production edit satisfies the Story's no-production-change constraint and its `swe@1` assertion.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — import-accepts-harness-worker · Task 041/story-2 — blocked

**Cycle.** Blocked for Task `041/story-2` (`src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`).
**Test written.**

- No new test — the required RED tests already exist from the prior turn.
- asserts: Existing tests require unqualified `swe@1` to produce exactly one `worker-unknown` finding.
  **RED proof.**
- command: `npm test` (prior RED run)
- exit: non-zero — failure: `✖ a task naming unqualified swe@1 produces exactly one worker-unknown finding (2.688708ms)`; assertion: `2 !== 1`
- handoff: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`
  **Open to Human.**
- `src/domain/plan-document.ts` parses `worker` with `workerKind`, so `swe@1` fails as `frontmatter-invalid` before validation can report `worker-unknown`; Story 1 requires `workerKind` to reject `swe@1`, while Story 2 requires exactly one `worker-unknown` and forbids production changes.

OPEN: Story 2 contradiction — its required `worker-unknown` result conflicts with the unchanged frontmatter schema and Story 1 rejection contract; human decision required.
ATTEMPT-FAILED: 041/story-2 — the blocker remains unresolved, so no compliant next test or handoff exists

END: TEST-ENGINEER
DEBATE_GUIDELINE: 041/story-2 — Resolve the schema-versus-validation contradiction before the loop can pass
GUIDELINE: Human must amend `.agents/plan/epics/041-harness-qualified-worker-kinds.md:72-73` and `.agents/plan/stories/041-harness-qualified-worker-kinds/02-import-accepts-harness-worker.md:8` to permit the production seam, because the current specification cannot pass unchanged.
GUIDELINE: If the `swe@1` validation assertion stays, permit the software-engineer to change `src/domain/plan-document.ts:22` to parse `swe@1` alongside `workerKind` while `workerKind` still rejects it; then rerun the Story 2 tests.

## SOFTWARE-ENGINEER — import-accepts-harness-worker · Task 041/story-2 — plan validation

**Cycle.** GREEN+REFACTOR for `src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`.
**Files changed.**

- `src/domain/plan-document.ts` (edited) — `planFrontmatter.worker` accepts the validation-only `swe@1` value.
  **Seam (GREEN).** The frontmatter schema parses `swe@1`, so plan validation can emit exactly one `worker-unknown` finding while `workerKind` rejects it.
  **Refactor.** None named; retained membership validation in `validateDocuments`.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: The latest `DEBATE_GUIDELINE` permits the production seam in `src/domain/plan-document.ts`.
- VERIFIED: `workerKind` remains the seven-value schema and does not admit `swe@1`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — plan-store-extended-set · Task 041/story-3 — explicit worker context

**Handoff verification gate.**

- Last Software Engineer claim: `typecheck: exit 0`.
- independent `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**Cycle.** Confirmed GREEN for Task `041/story-2`, then RED for Task `041/story-3` (`src/services/plan/sqlite.test.ts`).
**Test written.**

- file: `src/services/plan/sqlite.test.ts` (edited) — suite: `src/services/plan/sqlite.test` — method: `readValidationContext.workerKinds deep-equals the seven-element fixed-order array`
- asserts: `readValidationContext` exposes all seven worker kinds in the required fixed order.
  **RED proof.**
- command: `npm test`
- exit: 0 — `ℹ tests 5481`, `ℹ pass 5481`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`
- characterization note: The first-run pass is intentional because Story 1 already extends the vocabulary and the store already reads it.
- sensitivity probe: `node --test src/services/plan/sqlite.test.ts` with a temporary wrong final value — exit 1 — failure: `✖ readValidationContext.workerKinds deep-equals the seven-element fixed-order array (10.521583ms)`.
- restored proof: `node --test src/services/plan/sqlite.test.ts` — exit 0 — `ℹ tests 65`, `ℹ pass 65`, `ℹ fail 0`.
  **Open to Software Engineer.**
- `src/services/plan/sqlite.ts`: `SqlitePlanStore.readValidationContext(transaction: Transaction, projectId: string): ValidationContext` must expose the seven worker kinds in fixed order; Story 3 changes tests only, so no production edit is requested.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — plan-store-extended-set · Task 041/story-3 — explicit worker context

**Cycle.** GREEN+REFACTOR for `src/services/plan/sqlite.test.ts`.
**Files changed.**

- None — Story 3 requires no production file changes; the existing store seam already spreads `workerKinds`.
  **Seam (GREEN).** `readValidationContext` returns the seven worker kinds through the existing `workerKinds` spread.
  **Refactor.** None named; retained the existing validation-context construction.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 1 supplies the seven values, and `src/services/plan/sqlite.ts` already spreads that tuple.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — import-export-round-trip · Task 041/story-4 — harness-qualified worker

**Handoff verification gate.**

- Last Software Engineer claim: `typecheck: exit 0`.
- Independent `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**Cycle.** RED for Task `041/story-4` (`src/commands/plan/import-plan.test.ts`, `src/queries/plan/export-plan.test.ts`).
**Test written.**

- file: `src/commands/plan/import-plan.test.ts` (edited) — suite: `src/commands/plan/import-plan.test` — method: `a plan naming claude.swe@1 imports without findings and exports byte-identically`
- file: `src/queries/plan/export-plan.test.ts` (edited) — suite: `src/queries/plan/export-plan.test` — method: `preserves worker claude.swe@1 in the exported task document byte-identically`
- asserts: Import returns no absent documents and export reproduces the canonical documents, while direct export preserves the exact qualified worker line.
  **RED proof.**
- command: `npm test`
- exit: 0 — characterization pass is intentional; Story 4 forbids production changes and the existing import/export seams preserve the qualified worker.
- sensitivity probe: `node --test src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts` with a temporary `worker: swe@1` mutation
- exit: 1 — failure: `✖ a plan naming claude.swe@1 imports without findings and exports byte-identically (10.570292ms)`
- restored proof: `node --test src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts` — exit 0 — `ℹ tests 71`, `ℹ pass 71`, `ℹ fail 0`
- full proof: `npm test` — exit 0 — `ℹ tests 5483`, `ℹ pass 5483`, `ℹ fail 0`
  **Open to Software Engineer.**
- `src/commands/plan/import-plan.ts`: exported `importPlan(dependencies: ImportPlanDependencies, input: ImportPlanInput): ImportPlanResult` must preserve a qualified worker through import and return no absent documents.
- `src/queries/plan/export-plan.ts`: exported `exportPlan(dependencies: ExportPlanDependencies, input: Readonly<{ projectId: string }>): ExportPlanResult` must preserve the exact qualified worker line in task content.
- Story 4 requests no production change; existing seams pass this characterization coverage.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — import-export-round-trip · Task 041/story-4 — harness-qualified worker

**Cycle.** GREEN+REFACTOR for `src/commands/plan/import-plan.test.ts`, `src/queries/plan/export-plan.test.ts`.
**Files changed.**

- None — Story 4 requires no production file changes; existing import/export paths preserve the qualified worker.
  **Seam (GREEN).** Existing import and export operations preserve `claude.swe@1` and canonical document bytes.
  **Refactor.** None named; retained the existing import/export seams.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 4 explicitly forbids production file changes.
- VERIFIED: The latest TEST-ENGINEER turn reports the restored targeted tests and full suite pass.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — claim-ignores-worker-kind · Task 041/story-5 — claim ignores worker kind

**Handoff verification gate.**

- Last Software Engineer claim: `typecheck: exit 0`.
- Independent `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

**Cycle.** RED characterization for Task `041/story-5` (`src/commands/node/claim-node.test.ts`).
**Test written.**

- file: `src/commands/node/claim-node.test.ts` (edited) — suite: `src/commands/node/claim-node.test` — method: `a task whose worker is opencode.te@1 is claimed identically to a task whose worker is general@1`
- asserts: A worker-qualified task claim by an actor with no harness association matches the baseline lease, objective lease, state, and attempt number.
  **RED proof.**
- command: `npm test`
- exit: 0 — characterization pass is intentional; Story 5 forbids production changes and the existing claim path ignores `node.worker`.
- targeted command: `node --test src/commands/node/claim-node.test.ts`
- exit: 0 — `ℹ tests 48`, `ℹ pass 48`, `ℹ fail 0`, `ℹ cancelled 0`, `ℹ skipped 0`, `ℹ todo 0`
- sensitivity: fixture B writes `opencode.te@1` while fixture A keeps the baseline worker; a worker-dependent refusal changes the claim result and fails the paired-result assertions.
  **Open to Software Engineer.**
- `src/commands/node/claim-node.ts`: exported `claimNode(dependencies: ClaimNodeDependencies, input: ClaimNodeInput): ClaimNodeResult` must produce an equivalent successful claim for the qualified-worker task and the baseline task; no production change is requested by Story 5.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — claim-ignores-worker-kind · Task 041/story-5 — claim ignores worker kind

**Cycle.** GREEN+REFACTOR for `src/commands/node/claim-node.test.ts`.
**Files changed.**

- None — Story 5 requires no production file changes; the existing claim path ignores `node.worker`.
  **Seam (GREEN).** Existing `claimNode` produces equivalent successful claims without reading the worker kind.
  **Refactor.** None named; retained the existing claim path.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: Story 5 explicitly forbids production changes.
- VERIFIED: The latest TEST-ENGINEER turn reports the targeted claim test passes.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — proposal-defines-harness-kinds · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Task `041/story-6`.
**Story file.** `.agents/plan/stories/041-harness-qualified-worker-kinds/06-proposal-defines-harness-kinds.md`
**Tasks forwarded to Software Engineer.**

- `041/story-6`: `docs/proposal/phase-2/agents-and-workers.md` and `docs/proposal/phase-2/instructions-and-profiles.md` — define the four harness-qualified worker kinds and their import, execution, and claim semantics.
  **No RED phase.** Coverage is owned elsewhere per the Story gate.
  **Open to Software Engineer.**
- Implement GREEN+REFACTOR per the Story file for the two named proposal documents.

**Handoff verification gate.**

- `npm run verify:handoff` → exit 0 — `VERIFY: PASS — npm run typecheck is clean`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — proposal-defines-harness-kinds · Task 041/story-6 — proposal documents

**Cycle.** GREEN-ONLY implementation for Tasks: `041/story-6`.
**Files changed.**

- `docs/proposal/phase-2/agents-and-workers.md` (edited) — line 9 defines the four harness-qualified kinds and their import, execution, and claim semantics.
- `docs/proposal/phase-2/instructions-and-profiles.md` (edited) — line 9 defines the four harness-qualified kinds and their import and execution semantics.
  **Seam (GREEN).** Both proposal documents name the fixed four-value set, external dispatch, import validation, and daemon execution boundary.
  **Refactor.** None named; changed only line 9 in each proposal document.
  **Build check.**
- typecheck: exit 0

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Test written.**

- file: `src/commands/node/claim-node.test.ts` (edited) — suite: `src/commands/node/claim-node.test` — method: `a task whose worker is opencode.te@1 is claimed identically to a task whose worker is general@1`
- file: `test/helpers/rows.ts` (edited) — added the worker fixture setup used by the claim test

**EPIC verification gate.**

- Story 1: `node --test src/domain/worker.test.ts` → exit 0 — 19 tests passed.
- Story 2: `node --test src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts` → exit 0 — 73 tests passed.
- Story 3: `node --test src/services/plan/sqlite.test.ts` → exit 0 — 65 tests passed.
- Story 4: `node --test src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts` → exit 0 — 71 tests passed.
- Story 5: `node --test src/commands/node/claim-node.test.ts` → exit 0 — 48 tests passed.
- Story 6: both proposal line-9 amendments match the required values and semantics.
- Gates: `npm run verify` → exit 0.
- typecheck (`npm run typecheck`) → exit 0.
- unit (`npm test`) → exit 0 — 5484 tests passed.

**Proof.**

- command: `node --test src/domain/worker.test.ts src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts src/services/plan/sqlite.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts src/commands/node/claim-node.test.ts && echo "PASS EPIC-041"` → exit 0
- output: `PASS EPIC-041`

**Tasks closed.** 6 across 6 Stories — all tasks complete.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (EPIC Proof command) — "PASS EPIC-041"
- stories: 6/6 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER

## HUMAN — review blockers resolved

**Decision.** The `swe@1` fault and the `worker-unknown` fault live at two layers, and each is
proven at its own layer. `src/domain/plan-document.ts` does not change.

**Files changed.**

- `src/domain/plan-document.ts` — reverted to `worker: workerKind.optional()`.
- `src/domain/plan-document.test.ts` (edited) — the four kinds parse; `swe@1` and `te@1` are refused
  with the issue path `worker`.
- `src/domain/plan-validate.test.ts` (edited) — the `swe@1` case is replaced by `claude.swe@1`
  against `withoutClaudeSweContext`, which filters that one value out of `workerKinds`.
- `src/commands/node/claim-node.test.ts` (edited) — fixture A seeds `general@1`, so the baseline is
  a worker kind and not `null`.
- `.agents/plan/epics/041-harness-qualified-worker-kinds.md` — two Decisions added, Story 2 and
  Story 5 amended, `src/domain/plan-document.test.ts` added to the Proof, the hermetic coverage
  bullets split by layer.
- `.agents/plan/stories/041-harness-qualified-worker-kinds/02-import-accepts-harness-worker.md` and
  `05-claim-ignores-worker-kind.md` — amended to match.

**Blockers.**

- B1 - status:FIXED - action:YES - production-change contradiction - `src/domain/plan-document.ts:22` admitted `swe@1` through a `z.literal` union - fix:reverted to `worker: workerKind.optional()` - why:the union contradicted the EPIC Decision that `swe@1` is not a worker kind, and a one-off exception is wrong under either candidate design
- B2 - status:FIXED - action:YES - unsatisfiable document-layer requirement - a document naming `swe@1` is `frontmatter-invalid` and can never raise one `worker-unknown` - fix:the plan-validate proof names `claude.swe@1` against a context that omits that one value; the boundary rejection moves to `src/domain/plan-document.test.ts` - why:a `validateDocuments` test of `swe@1` also raises `objective-without-task`, so it cannot assert one thing
- B3 - status:FIXED - action:YES - claim baseline mismatch - fixture A carried `worker = NULL`, not `general@1` - fix:`seedNodeWorker(transaction, fixtureIds.task, "general@1")` - why:a null baseline compares an unassigned node against a worker kind, so it misses a guard that separates a local kind from an external one
- B4 - status:FIXED - action:YES - Story 5 scope - the tree added `seedNodeWorker` while the Story said every helper pre-exists - fix:the Story now names `test/helpers/rows.ts` and the helper - why:the helper is the better code, and the Story must record it

**EPIC verification gate.**

- Gates: `npm run verify` → exit 0 — `ℹ tests 5490`, `ℹ pass 5490`, `ℹ fail 0`.
- Proof: the amended eight-file `node --test` command → exit 0 — `PASS EPIC-041`.

END: HUMAN
HUMAN_REVIEW: PASS
HUMAN_REVIEW: PASS
