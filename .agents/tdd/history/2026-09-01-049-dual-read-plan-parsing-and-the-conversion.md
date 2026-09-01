---
epic: .agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md
opened: 2026-09-01
opener: test-engineer
base-ref: f2117179665543b6c12ddc2fe868a1414ddf5431
---

# Implementation cycle — 049-dual-read-plan-parsing-and-the-conversion

Pulled from EPIC: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `pnpm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/plan-document.test.ts \
>   src/domain/plan-finding.test.ts \
>   src/domain/plan-validate.test.ts \
>   src/domain/plan-candidate.test.ts \
>   src/domain/plan-render.test.ts \
>   src/commands/plan/import-plan.test.ts \
>   src/queries/plan/export-plan.test.ts \
>   && echo "PASS EPIC-049"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - A document carrying `worker` and `deliverable` together raises exactly one `frontmatter-invalid`, with the issue path `deliverable`.
> - A document carrying neither `worker` nor `deliverable` parses, asserted for `initiative`, `objective` and `task`. The daemon creates such a node through `node.create`, and it must re-read its own export.
> - A document carrying `deliverable` and no `verify` raises exactly one `frontmatter-invalid`, with the issue path `verify`.
> - A new-shape document renders to exact bytes, asserted against a literal string, with the key order `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`.
> - Each of the four `worker.md` section 2 examples renders to exact bytes, asserted against a literal, and reproduces that example's key order exactly. The literal is written in the shipped quoted form. The examples in `worker.md` are printed with unquoted YAML scalars, and `quoteScalar` at `src/domain/plan-render.ts:17` quotes every scalar, so the two forms differ by quoting alone.
> - A container created through `node.create` exports and re-imports at status `200`, proving the shipped write path still round-trips.
> - An empty verify block renders as `  paths: []` and `  commands: []`, asserted byte-exact.
> - A command string holding `"`, `\` and a tab round-trips byte-identically through render and parse.
> - A plan whose tasks carry `worker` imports and exports byte-identically after this epic, proving dual read did not break the shipped task shape.
> - A `verify_json` value of `{"paths":["a/../b"],"commands":[]}` is inserted through real SQLite, passes migration 11's `json_valid` CHECK, and then produces exactly one `verify-invalid` finding from `validateCandidate`. The case proves the CHECK and the schema guard cover different things, so neither is redundant.
> - A stored node with a non-null `deliverable` and a null `verify_json` produces exactly one `verify-invalid` finding, asserted by code and by node id. The case is a cross-column invariant and not a grammar question.
> - `validateCandidate` returns findings for two bad rows in one candidate rather than aborting at the first, asserted by a finding count of two.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** `pnpm run verify` → exit 0; all 5855 tests pass.

- typecheck (`pnpm run typecheck`) → exit 0
- unit (`pnpm test`) → exit 0 — `ℹ tests 5855`, `ℹ pass 5855`, `ℹ fail 0`
  **Proof.** `node --test src/domain/plan-document.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/domain/plan-render.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts && echo "PASS EPIC-049"` → exit 0; output: `PASS EPIC-049`
  **Tasks closed.** 6 across 6 Stories — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/plan-document.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/domain/plan-render.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts && echo "PASS EPIC-049") — "PASS EPIC-049"
- stories: 6/6 complete
- date: 2026-09-01
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 5 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: B1 verify paths render in input order — sort a copied path list with comparePaths before rendering and assert descending and non-ASCII inputs.
BLOCKER: B2 legacy import cannot clear a stored new shape — make explicit null replace stored values while omitted fields retain existing values and add a new-shape-to-legacy transition test.
BLOCKER: B3 duplicate verify paths become an internal import failure — reject duplicate paths at the submitted verify-schema boundary and cover validation plus import.
BLOCKER: B4 field-decisions equality test rewrites its expected fixture — regenerate the fixture and restore direct rows versus fieldDecisions equality.
BLOCKER: S1 redundant renderer test type cast — use RenderInput and import renderDocument directly to preserve compile-time checking.

## TEST-ENGINEER — review blocker B1 · verify path ordering

**Cycle.** RED regression for review blocker `B1` (`src/domain/plan-render.test.ts`).
**Test written.**

- file: `src/domain/plan-render.test.ts` (edited) — suite: `src/domain/plan-render.test` — methods: `renders verify paths in comparePaths order without mutating descending non-ASCII input`
- asserts: `renderDocument` emits verify paths in canonical order and preserves the caller's path list.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `✖ renders verify paths in comparePaths order without mutating descending non-ASCII input (1.07675ms)`
  **Open to Software Engineer.**
- `src/domain/plan-render.ts`: the imported `renderDocument(input: RenderInput): string` seam must render `verify.paths` in `comparePaths` order for descending non-ASCII input without changing the caller-visible input.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — dual-read plan parsing · verify path ordering

**Cycle.** GREEN+REFACTOR for `src/domain/plan-render.test.ts`.
**Review blocker addressed.** B1 verify paths render in input order — sort a copied path list with comparePaths before rendering and assert descending and non-ASCII inputs.
**Files changed.**

- `src/domain/plan-render.ts` (edited) — sort copied verify paths with `comparePaths` before emission.
  **Seam (GREEN).** `appendVerifyBlock` now emits canonical verify paths without mutating `VerifyBlock.paths`.
  **Refactor.** Applied B1's requested copied-list ordering.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `comparePaths` is the domain canonical path comparator in `src/domain/plan-path.ts`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker B2 · legacy transition

**Cycle.** RED regression for review blocker `B2` (`src/commands/plan/import-plan.test.ts`).
**Test written.**

- file: `src/commands/plan/import-plan.test.ts` (edited) — suite: `src/commands/plan/import-plan.test` — methods: `a new-shape plan can transition to a legacy document and clear stored fields`
- asserts: A legacy import clears submitted `deliverable` and `verify_json`, retains database-selected values, and exports legacy bytes.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 'test' !== null`
  **Open to Software Engineer.**
- `src/commands/plan/import-plan.ts`: the imported `importPlan(dependencies: ImportPlanDependencies, input: ImportPlanInput): ImportPlanResult` seam must clear new-shape fields for a submitted legacy document and retain values for database-selected nodes.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — dual-read plan parsing · legacy transition

**Cycle.** GREEN+REFACTOR for `src/commands/plan/import-plan.test.ts`.
**Review blocker addressed.** B2 legacy import cannot clear a stored new shape — make explicit null replace stored values while omitted fields retain existing values and add a new-shape-to-legacy transition test.
**Files changed.**

- `src/services/plan/sqlite.ts` (edited) — distinguish explicit null fields from omitted fields during node upserts.
  **Seam (GREEN).** `SqlitePlanStore` now applies submitted null `deliverable` and `verifyJson`, while omitted fields retain stored values.
  **Refactor.** Applied B2's explicit-null versus omitted-field upsert semantics.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `Object.hasOwn` identifies fields supplied by import node writes; `pnpm run typecheck` exits 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker B3 · duplicate verify paths

**Cycle.** RED regression for review blocker `B3` (`src/domain/verify-block.test.ts`, `src/domain/plan-validate.test.ts`, `src/commands/plan/import-plan.test.ts`).
**Test written.**

- file: `src/domain/verify-block.test.ts` (edited) — suite: `src/domain/verify-block.ts` — methods: `the submitted verify schema refuses duplicate paths`
- file: `src/domain/plan-validate.test.ts` (edited) — suite: `src/domain/plan-validate.test` — methods: `a submitted verify block with duplicate paths is frontmatter-invalid`
- file: `src/commands/plan/import-plan.test.ts` (edited) — suite: `src/commands/plan/import-plan.test` — methods: `a duplicate submitted verify path is refused as plan-invalid`
- asserts: Duplicate submitted verify paths are rejected at the schema boundary, reported during validation, and refused by import without writes.
  **RED proof.**
- command: `pnpm test`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: expected an ImportPlanError, got VerifyBlockError: duplicate path: /src/foo.ts`
  **Open to Software Engineer.**
- `src/domain/verify-block.ts`: the imported `verifyBlock.safeParse(value)` schema seam must reject duplicate submitted paths.
- `src/domain/plan-validate.ts`: the imported `validateDocuments(dependencies, input): ValidationResult` seam must report one `frontmatter-invalid` finding for the duplicate-path document.
- `src/commands/plan/import-plan.ts`: the imported `importPlan(dependencies: ImportPlanDependencies, input: ImportPlanInput): ImportPlanResult` seam must refuse the duplicate-path submission with `ImportPlanError.refusal === "plan-invalid"` and leave storage unchanged.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — dual-read plan parsing · duplicate verify paths

**Cycle.** GREEN+REFACTOR for `src/domain/verify-block.test.ts`, `src/domain/plan-validate.test.ts` and `src/commands/plan/import-plan.test.ts`.
**Review blocker addressed.** B3 duplicate verify paths become an internal import failure — reject duplicate paths at the submitted verify-schema boundary and cover validation plus import.
**Files changed.**

- `src/domain/verify-block.ts` (edited) — reject duplicate paths through `verifyBlock.safeParse`.
  **Seam (GREEN).** The submitted verify schema now rejects duplicate paths before import serialization can throw `VerifyBlockError`.
  **Refactor.** Applied B3 schema-level duplicate path validation while preserving the non-throwing decoder.
  **Build check.**
- typecheck: exit 0

**Assumptions.**

- VERIFIED: `verifyBlock` is the submitted frontmatter schema and `decodeVerifyBlock` uses it for stored-state validation.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — review blocker B4 · field-decision fixture equality

**Cycle.** RED regression for review blocker `B4` (`src/http/contract/coverage.test.ts`).
**Test written.**

- file: `src/http/contract/coverage.test.ts` (edited) — suite: `src/http/contract/coverage.test` — methods: `every field in the registry answers required, nullability and enum, matching the reviewed fixture`
- asserts: The registry field rows equal the reviewed `fieldDecisions` fixture directly, without a derived expected copy.
  **RED proof.**
- command: `pnpm test src/http/contract/coverage.test.ts`
- exit: non-zero — failure: `✖ every field in the registry answers required, nullability and enum, matching the reviewed fixture (6.471042ms)`
  **Open to Software Engineer.**
- `src/http/contract/field-decisions.fixture.ts`: the `fieldDecisions` expected rows must match the registry rows, including `pair-illegal` and `verify-invalid`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — dual-read plan parsing · field-decision fixture

**Cycle.** GREEN+REFACTOR for `src/http/contract/coverage.test.ts`.
**Review blocker addressed.** B4 field-decisions equality test rewrites its expected fixture — regenerate the fixture and restore direct rows versus fieldDecisions equality.
**Files changed.**

- `src/http/contract/field-decisions.fixture.ts` (edited) — add `pair-illegal` and `verify-invalid` to every finding-code enum row.
  **Seam (GREEN).** `fieldDecisions` now matches the registry schemas derived from the 26-code `findingCodes` tuple.
  **Refactor.** Applied B4's direct reviewed-fixture equality data update.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `findingCodes` orders `pair-illegal` and `verify-invalid` in `src/domain/plan-finding.ts`; typecheck exits 0.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** `pnpm run verify` → exit 0.

- typecheck (`pnpm run typecheck`) → exit 0
- unit (`pnpm test`) → exit 0 — `ℹ tests 5860`, `ℹ pass 5860`, `ℹ fail 0`
  **Proof.** `node --test src/domain/plan-document.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/domain/plan-render.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts && echo "PASS EPIC-049"` → exit 0; output: `PASS EPIC-049`
  **Tasks closed.** 6 across 6 Stories — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/plan-document.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/domain/plan-render.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts && echo "PASS EPIC-049") — "PASS EPIC-049"
- stories: 6/6 complete
- date: 2026-09-01
- state: local-uncommitted

END: TEST-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** `pnpm run verify` → exit 0; review finding S1 is addressed in `src/domain/plan-render.test.ts`.

- typecheck (`pnpm run typecheck`) → exit 0
- unit (`pnpm test`) → exit 0 — `ℹ tests 5860`, `ℹ pass 5860`, `ℹ fail 0`
  **Proof.** `node --test src/domain/plan-document.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/domain/plan-render.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts && echo "PASS EPIC-049"` → exit 0; output: `PASS EPIC-049`
  **Tasks closed.** 6 across 6 Stories — no Story outstanding.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/plan-document.test.ts src/domain/plan-finding.test.ts src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts src/domain/plan-render.test.ts src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts && echo "PASS EPIC-049") — "PASS EPIC-049"
- stories: 6/6 complete
- date: 2026-09-01
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
