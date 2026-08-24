---
epic: .agents/plan/epics/027-plan-choice-values.md
opened: 2026-08-21
opener: test-engineer
base-ref: a7638702498a7e05f21f8bdb13f57a0fac2f7a32
---

# Implementation cycle — 027-plan-choice-values

Pulled from EPIC: `.agents/plan/epics/027-plan-choice-values.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test src/domain/plan-diff.test.ts \
>   src/domain/plan-choice.test.ts \
>   src/queries/plan/validate-plan.test.ts \
>   src/commands/plan/import-plan.test.ts \
>   src/http/server/plan/validate-plan.test.ts \
>   src/http/contract/graph.test.ts \
>   src/http/contract/coverage.test.ts \
>   src/http/contract/example.test.ts \
>   src/http/contract/openapi.test.ts \
>   src/http/contract/parity.test.ts && echo "PASS EPIC-027"
> ```
>
> Hermetic coverage required beyond the Proof:
>
> - A `both` entry whose `fields` is `["title"]`: `submitted.values` deep-equals `{ title: "<the document title>" }` and `database.values` deep-equals `{ title: "<the stored title>" }`. Exactly one key on each side. This is the entry the client named.
> - A `database-only` entry: `database.values` holds all six names with the stored node's values, and `submitted.values` deep-equals `{}`. Its `fields` is `[]`, and the test asserts that too, because an empty `fields` beside a populated `values` is the fact D1 turns on.
> - A `document-only` entry: the mirror of the above, `submitted.values` complete and `database.values` `{}`.
> - A `both` entry whose `fields` is `[]` — two identical sides: both `values` deep-equal `{}`.
> - A `both` entry differing only in acceptance text: `fields` is `["body"]`, and each `values.body` deep-equals `{ instructionBlob: <the same hash on both sides>, acceptanceBlob: <a different hash per side> }`. Asserts that `body` names both blobs, per D2.
> - A `both` entry whose stored acceptance is absent and whose document supplies one: `database.values.body.acceptanceBlob` is `null` and the submitted one is a hash.
> - A `both` entry whose dependency lists differ only in order, with a repeat on one side: `fields` does **not** contain `depends_on` and neither `values` carries it. Then the same case with a genuinely different member: both `values.depends_on` are the **normalized** lists — sorted by `comparePaths`, duplicates dropped — asserted as exact arrays. This is D3, and the first half is what makes it a rule rather than a preference.
> - A `depends_on` case with a non-ASCII identity, asserting `comparePaths` order and not `Buffer.compare` order. The two differ, and the test names which one it asserts.
> - `Object.keys(values)` of an entry whose `fields` is all six names deep-equals `["body", "depends_on", "parent", "repo", "title", "worker"]`, and the same call with the `fields` argument reversed returns the identical array. Two calls produce identical `JSON.stringify` bytes. This is the D4 determinism claim.
> - **A submitted hash is not in the blob store, asserted rather than assumed.** After a `plan.validate` call over a document set that differs from the stored graph, `BlobStore.get(<the submitted instructionBlob>)` returns `null`, and `BlobStore.get(<the database instructionBlob>)` returns a record. This is the fact D2's retrieval rule turns on, and a later epic that made `plan.validate` write blobs would fail this assertion and have to amend the decision.
> - `path` equals the submitted document's path for a `both` entry and for a `document-only` entry, and is `null` for a `database-only` entry. For every entry whose `path` is non-null, exactly one member of the response's `documents` array carries that path, asserted by lookup. This is the join the client performs.
> - `planChoiceEntry.safeParse` refuses the pre-epic entry — a branch of `{ legal, reason }` with no `values` — and refuses `values: { title: 1 }` and `values: { unknown: "x" }`. The first pins that `values` is required, the last pins `additionalProperties: false`.
> - `choiceVerdict` is byte-identical before and after: its `ChoiceFacts` input, its `ChoiceVerdict` output and every existing case of `src/domain/plan-choice.test.ts` are unchanged, and `src/commands/plan/import-plan.test.ts` passes with no edit. This is the D4 boundary, asserted as an absence of change.
> - `planValidateResponse.parse(planValidateExamples.success)` succeeds, and the parsed choice entry's `submitted.values` and `database.values` each hold exactly one `title` key with different values. The published example is the one a client copies, so it is asserted and not only present.
> - `plan.validate` through the real koa app returns a body that `planValidateResponse` parses, for a project holding one `both` conflict, one `document-only` entry and one `database-only` entry in one call.
> - The `plan.validate` call performs the same number of `PlanStore` reads as it does on the pre-epic tree, counted through a counting fake. This asserts D4's "no extra read".
> - A publish into a temporary directory carries `values` under both branches and the `path` member in `features/plan.yaml`:
>
> ```bash
> node scripts/publish-contract.ts "$(mktemp -d)"
> ```

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — plan-choice-values · story expansion required

**Cycle.** Blocked before Task selection for EPIC 027.
**Story file.**

- No `.agents/plan/stories/027-plan-choice-values/` directory exists.
- The EPIC lists four story summaries but provides no Acceptance Criteria, `### Task` headings, `Action — RED:` blocks, verify paths, or test method names.
  **Open.**
- `OPEN: EPIC-027 — binding Story files are absent, so the next test target and assertions are undefined.`
- B1 - status:OPEN - action:YES - Story expansion - add the binding Story files for EPIC 027 - fix:create the Story files with their Acceptance Criteria, Tasks, RED blocks and verification targets - why:Aelita cannot choose a test target or assertion without inventing the locked plan.
  **Action required.** Ulrich must expand the EPIC into Story files before the test lane can write RED coverage; no production seam is open.

ATTEMPT-FAILED: EPIC-027 — no active Story Task exists because the Story files are absent

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 027-plan-choice-values · Story expansion required

**Cycle.** Blocked before implementation for `EPIC-027`.
**Files changed.**

- None — the binding Story files are absent, so no production Task is active.
  **Open.**
- `OPEN: EPIC-027 — binding Story files are absent, so no production seam or Task is defined.`
- B1 - status:OPEN - action:YES - Story expansion - add the binding Story files for EPIC 027 - fix:create Story files with Acceptance Criteria, Tasks, RED blocks and verification targets - why:the software-engineer lane cannot implement an undefined Task without inventing the locked plan.
  **Build check.**
- typecheck: exit 0

ATTEMPT-FAILED: EPIC-027 — no active Story Task exists because the Story files are absent

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 027-plan-choice-values · Story expansion required

**Cycle.** Blocked before Task selection for EPIC-027.
**Handoff verification.**

- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Story file.**
- No `.agents/plan/stories/027-plan-choice-values/` directory exists.
- The EPIC lists four story summaries but provides no Acceptance Criteria, `### Task` headings, `Action — RED:` blocks, verify paths, or test method names.
  **Open.**
- `OPEN: EPIC-027 — binding Story files are absent, so the next test target and assertions are undefined.`
- B1 - status:OPEN - action:YES - Story expansion - add the binding Story files for EPIC-027 - fix:create the Story files with their Acceptance Criteria, Tasks, RED blocks and verification targets - why:Aelita cannot choose a test target or assertion without inventing the locked plan.
  **Action required.** Ulrich must expand the EPIC into Story files before the test lane can write RED coverage; no production seam is open.

ATTEMPT-FAILED: EPIC-027 — no active Story Task exists because the Story files are absent

END: TEST-ENGINEER

## ULRICH — 027-plan-choice-values · Story expansion delivered

**Cycle.** B1 of the three failed attempts is closed. The blocking condition — absent Story files — no longer holds.
**Files created.**

- `.agents/plan/stories/027-plan-choice-values/index.md`
- `.agents/plan/stories/027-plan-choice-values/01-the-domain-projects-the-choice-values.md`
- `.agents/plan/stories/027-plan-choice-values/02-the-contract-declares-the-branch.md`
- `.agents/plan/stories/027-plan-choice-values/03-the-query-composes-the-values.md`
- `.agents/plan/stories/027-plan-choice-values/04-the-proposal-records-the-choice-values.md`

Each story carries Acceptance Criteria as a `## Change` section with exact file and site, a `## Constraints` section, and a `## Verify` section naming the exact test files, the exact assertions and the Proof lines it delivers. Every one of the EPIC's 17 Hermetic coverage bullets is assigned to a story or recorded as blocked.

**Grounding.** Four read-only explorations mapped the domain, the contract, the query and the proposal surfaces. Two EPIC citations were stale and the stories use the real anchors: `planValidateExamples.success.choices` is at `src/http/contract/graph.ts:283` (not 236), `planImportExamples.request.choices` at `:308` (not 262), and the fixture's branch rows are at 321-331 (not 320-329).

**Adversarial review.** The expansion went through the debate engine (`pi`, read-only). Twelve catches, nine merged, three set aside. Five merged catches were factual defects in the first draft, each verified against the tree before merging:

- the `path` fixture row is `nullable=true`, not `nullable=false` — `z.string().nullable()` follows the `state` row precedent;
- `seedPlanFixture` stores the title `Harden the verify CLI` on all three nodes, not `Render the manifest`;
- the koa presence counts are two `both`, one `document-only`, one `database-only` — "exactly one of each" is impossible with a three-node fixture;
- `splitBody` keeps the blank line before the acceptance heading, so the task instruction is `Build the renderer.\n\n`, not `Build the renderer.\n`;
- the red window spans both `planValidateResponse.safeParse` assertions, lines 140 and 172.

**Open.**

- B1 - status:OPEN - action:YES - the `path` member cannot serve the join the gate demands - D2 fixes `path` as the submitted document's path, while the gate requires every non-null `path` to match one member of `documents`, which carries canonical rendered paths from `renderDocumentSet` at `src/queries/plan/validate-plan.ts:278` - fix:decide (a) `path` is the canonical rendered path, and the EPIC states how it is obtained, because `storedPaths` at lines 85-100 is the stored graph reversed and holds no `document-only` entry, or (b) `path` stays the submitted path and the gate drops the join bullet - why:option (a) delivers the capability D2 argues for and option (b) ships a member whose stated purpose it does not serve; the answer changes the contract, the query, the tests and one proposal paragraph, so it is not Aelita's to pick.
- B2 - status:OPEN - action:YES - the non-ASCII order contrast is not `Buffer.compare` - the gate asks a test to assert `comparePaths` order "and not `Buffer.compare` order", stating the two differ; they agree for every well-formed string, and `src/domain/plan-path.test.ts:160` already asserts that agreement over the same pair - fix:amend the EPIC bullet to name the bare `Array.prototype.sort` as the contrast, which Story 1 already asserts - why:`.sort()` compares UTF-16 code units and genuinely reverses the pair, so it is the substitution a test can catch; a `Buffer.compare` assertion passes under both correct and incorrect implementations.
- B3 - status:OPEN - action:YES - the publish check cannot run from a dirty tree - the gate ends with `node scripts/publish-contract.ts "$(mktemp -d)"`, but `scripts/release-gate.ts:36` refuses `dirty-tree` before it tests `unreleased`, so the command is refused in the only state a story could run it - fix:the EPIC states the publish check runs after the epic's commit or from a temporary worktree, with `--unreleased` - why:as written the check is unrunnable where it is specified, so it reports a false failure or is silently skipped.

**Dispatch.** Stories 1 and 2 are dispatchable now. Story 3's `values` half is dispatchable; its `path` half and Story 4 wait on B1. Stories 2 and 3 are a coupled pair in either direction — run no gate between them.

**Action required.** Ulrich answers B1, B2 and B3. B1 is the only one that changes source; B2 and B3 amend the EPIC's Verification Gate. Then `/work` resumes on EPIC 027.

END: ULRICH

## ULRICH — 027-plan-choice-values · B1, B2 and B3 resolved

**Cycle.** Every blocker is closed. All four Stories are dispatchable in order.

**B1 — resolved as option (a): `path` is the canonical path of the submitted document.**

- `renderDocumentSet` derives every path from `canonicalPaths(nodes)` (`src/domain/plan-render.ts:84`), so a `canonicalPaths(canonicalNodes)` call anywhere returns exactly the paths the response's `documents` carry. The join then holds by construction.
- The query hoists its existing `canonicalNodes` construction from `src/queries/plan/validate-plan.ts:269-277` to sit after `storedByIdentity` at `:161`, adds `const submittedPaths = canonicalPaths(canonicalNodes);`, and sets `path` to `submittedPaths.get(identity) ?? null`. `canonicalPaths` is already imported at `:17`.
- `canonicalPaths` runs twice per request and is pure domain with no `PlanStore` or `BlobStore` access, so D4's "no extra read" holds and the counting test is unchanged.
- `storedPaths` at `:85-100` is **not** the join map: it runs over the stored graph, is reversed to `path -> identity`, and holds no entry for a `document-only` node. The stories say so.
- The join test and a second test asserting `path` is **not** the authored path are now written in Story 3. Hermetic coverage bullet 11 moves from blocked to delivered.

**B2 — resolved: the contrast is bare `Array.prototype.sort`, not `Buffer.compare`.** The EPIC bullet now names `.sort()`, and records both caveats: the `Buffer.compare` agreement fails only for a lone surrogate, which UTF-8 maps to U+FFFD; and neither test identity is a reachable product identity, so the case is a unit-level guard. `src/domain/plan-path.test.ts:160` already asserts the agreement over the same pair, so the old bullet contradicted an existing test.

**B3 — resolved: the publish check runs from a clean tree.** The EPIC bullet now states that it runs after the epic's commit, or from a temporary worktree at that commit, and passes `--unreleased`. `scripts/release-gate.ts:36` returns `dirty-tree` before it tests `unreleased`, so the previous command was unrunnable where it was specified.

**Files changed.**

- `.agents/plan/epics/027-plan-choice-values.md` — D2's `path` definition and its rationale, the `plan.validate` `documents` paragraph, the query Story bullet, and three Verification Gate bullets. **This is a non-source file, edited on Ulrich's instruction.**
- `.agents/plan/stories/027-plan-choice-values/02-the-contract-declares-the-branch.md` — the example note.
- `.agents/plan/stories/027-plan-choice-values/03-the-query-composes-the-values.md` — the hoist, the composition, the canonical `path` values in `expectedChoices`, and the two join tests.
- `.agents/plan/stories/027-plan-choice-values/04-the-proposal-records-the-choice-values.md` — the join-key wording in both edits.
- `.agents/plan/stories/027-plan-choice-values/index.md` — three blockers `status:FIXED`, dispatch order unblocked, three new canonical-path facts.

All six files pass `npx prettier --check`, so the commit hook rewrites nothing.

**Open.** None. No blocker and no suggestion is outstanding for EPIC 027.

**Action required.** None from Ulrich. `/work` may resume on EPIC 027 and dispatch Story 1.

END: ULRICH

## TEST-ENGINEER — the domain projects the choice values · Story 1 RED

**Cycle.** RED for Story 1 (`src/domain/plan-diff.test.ts`) — `ChoiceValues`, `storedValues` and `submittedValues` join the comparison, per D2, D3 and D4.
**Test written.**

- file: `src/domain/plan-diff.test.ts` (edited) — suite: `src/domain/plan-diff.test` — methods: `storedValues publishes exactly the selected field`, `storedValues selects nothing when the field list is empty`, `storedValues publishes all six values when the side is the only side`, `a stored node without an acceptance publishes a null acceptanceBlob`, `a null value stays a present key with a null value`, `an unselected name is absent from the record`, `storedValues maps parent from parentId and repo from repositoryId`, `submittedValues publishes exactly the selected field`, `submittedValues selects nothing when the field list is empty`, `submittedValues publishes all six values when the side is the only side`, `a submitted body pair comes from the blob hashes argument`, `submittedValues maps parent from parentIdentity and repo from repo`, `submittedValues reads the resolved dependencies and not the raw frontmatter list`, `a body conflict names both blobs on each side`, `an absent stored acceptance and a supplied submitted acceptance differ inside body`, `a reorder with a repeat is no conflict and still publishes the normalized list`, `a genuinely different dependency publishes two different normalized lists`, `depends_on is ordered by code point and not by UTF-16 code unit`, `the value keys follow the differingFields order whatever the argument order`, `the value keys are the differingFields vocabulary in its own order`
- asserts: each choice branch projects the field values of the side it leaves in place — exactly the selected names for a non-null `fields`, all six names for `null`, an absent key versus a present `null` distinguished through `Object.hasOwn`, the `body` pair naming both blob hashes with the value taken from the hashes argument, `depends_on` published as the normalized code-point-sorted list (and refused under bare `.sort()` order), and key order fixed to the `differingFields` vocabulary regardless of the argument order, pinned structurally against the exported array. The thirteen pre-existing tests are unmodified.
  **RED proof.**

- command: `node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './plan-diff.ts' does not provide an export named 'storedValues'`
- baseline: all 23 tests of `src/domain/plan-choice.test` pass in the same run, unmodified — the D4 boundary holds before any production change.
- stub probe: `src/domain/plan-diff.ts` — clean (`npm run typecheck` exit 0 with the Story-declared stubs in place; no errors surfaced in the test file; stub deleted before handoff, `git status` shows only the test file modified)

**Open to Software Engineer.**

- seam: `src/domain/plan-diff.ts` — export the types `ChoiceBody` and `ChoiceValues` and the functions `storedValues(stored: StoredNode, fields: readonly DifferingField[] | null): ChoiceValues` and `submittedValues(submitted: ResolvedDocument, blobs: Readonly<{ instruction: string; acceptance: string | null }>, fields: readonly DifferingField[] | null): ChoiceValues`, exactly as the Change section of `.agents/plan/stories/027-plan-choice-values/01-the-domain-projects-the-choice-values.md` specifies. No other file changes: `differingFields` stays byte-identical, `normalized` and `equalIdentities` stay private, and `src/domain/plan-choice.ts` is untouched.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the domain projects the choice values · Story 1 GREEN

**Cycle.** GREEN for `src/domain/plan-diff.test.ts` — the RED proof's missing export `storedValues` (with `submittedValues`, `ChoiceBody`, `ChoiceValues`) is in place.
**Files changed.**

- `src/domain/plan-diff.ts` (edited) — added exported types `ChoiceBody` and `ChoiceValues` after the imports; appended private `selects(fields, name)` and exported `storedValues(stored: StoredNode, fields: readonly DifferingField[] | null): ChoiceValues` and `submittedValues(submitted: ResolvedDocument, blobs: Readonly<{ instruction: string; acceptance: string | null }>, fields: readonly DifferingField[] | null): ChoiceValues`.

**Seam (GREEN).** The two functions project a branch's field values from its own side — `fields === null` selects all six names, otherwise exactly the listed ones — reading the exact source properties the Story's table fixes (`parentId`/`repositoryId` vs `parentIdentity`/`repo`; `dependencies` through the existing private `normalized`; the `body` pair from `instructionBlob`/`acceptanceBlob` or the hashes argument), inserting keys in the fixed order `body, depends_on, parent, repo, title, worker` regardless of the `fields` argument order.
**Refactor.** None named by the Task; the Story's Change section is applied whole as the green state, with `differingFields`, `normalized` and `equalIdentities` byte-identical and no new import.
**Build check.**

- typecheck: exit 0
- lint: exit 0

**Assumptions.**

- VERIFIED: `git diff src/domain/plan-diff.ts` shows additions only; `git status --porcelain` lists no production path beyond it plus the TE-owned test file.
- VERIFIED: key-order pinning holds by insertion order — each `if` block runs in source order before any return, so `Object.keys` matches the exported `differingFields` vocabulary whatever the argument order.
- Note: `npm run verify` was not run — test execution is the TE's gate. The story's `node --test` line remains yours to confirm.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the contract declares the branch · Story 2 RED

**Cycle.** RED for Story 2 (`src/http/contract/graph.test.ts`) — `planChoiceBody`, `planChoiceValues`, `planChoiceBranch` and `path` join the contract, per D1 and D2.
**Handoff verification.**

- software-engineer claim: typecheck exit 0, lint exit 0 (Story 1 GREEN turn)
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Prior GREEN confirmed (Story 1).**

- command: `node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts`
- exit: 0 — 56 pass / 0 fail; `src/domain/plan-choice.ts` carries no diff, so the D4 boundary held before any production change.
  **Test written.**

- file: `src/http/contract/graph.test.ts` (edited) — suite: `src/http/contract/graph.test` — methods: `planChoiceEntry accepts an entry whose branches carry values and a path`, `planChoiceEntry refuses the pre-epic entry whose branches carry no values`, `planChoiceEntry refuses a branch that misses only its values`, `planChoiceValues accepts an empty record and the three nullable names`, `planChoiceValues refuses a numeric title, a null title and an unknown key`, `depends_on keeps its underscore and refuses the camelCase spelling`, `planChoiceValues parses all six names together`, `body carries a pair of blob hashes and accepts a null acceptanceBlob`, `body refuses a null instructionBlob, a non-hash, a missing hash and uppercase hex`, `body refuses a third key`, `path is required and nullable`, `the plan.validate example carries one both entry whose values name the two titles`, `the plan.validate example joins its choice path to one document`
- asserts: the wire contract of a choice entry — `values` required on each branch and closed over the six names with `body` a strict pair of blob hashes (`acceptanceBlob` nullable, uppercase hex refused), `path` required and nullable, and the published `planValidateExamples.success` parsing through `planValidateResponse` with exactly one `both` entry whose two branches hold different single-key `title` values joined by `path` to exactly one document. All thirteen pre-existing tests are unmodified.
  **RED proof.**

- command: `node --test src/http/contract/graph.test.ts`
- exit: 1 — failure: `SyntaxError: The requested module './graph.ts' does not provide an export named 'planChoiceValues'`
- stub probe: `src/http/contract/graph.ts` — first probe with `planChoiceValues` alone stubbed surfaced 8 errors in the test file (`values`/`path` missing off the branch and entry types); extended the throwaway stub to the full Story-declared seam (`planChoiceBody`, `planChoiceValues`, `planChoiceBranch`, branches replaced, `path` added) and `npm run typecheck` exited 0 — the test file is type-sound against the completed seam. Stub deleted before handoff; `git diff` on `graph.ts` is empty.
  **Coupling note.** Stories 2 and 3 are atomic: this story makes `values` and `path` required, so after it lands `src/http/server/plan/validate-plan.test.ts` is red at its two `planValidateResponse.safeParse` assertions (lines 140 and 172). That red is expected — run no gate between the pair, and go straight to Story 3.

**Open to Software Engineer.**

- seam: `src/http/contract/graph.ts` — add the three exported zod schemas `planChoiceBody`, `planChoiceValues`, `planChoiceBranch` immediately before `planChoiceEntry`, replace `planChoiceEntry`'s inline branch objects with `planChoiceBranch`, and add `path: z.string().nullable()` between `fields` and `submitted`; replace `planValidateExamples.success.choices` (`[]` at line 283) with the one-entry example specified in the Change section of `.agents/plan/stories/027-plan-choice-values/02-the-contract-declares-the-branch.md` (`path` = `"initiative/atlas.md"`, the shared `planDocument_example.path`). Then regenerate `src/http/contract/field-decisions.fixture.ts` by running `node scripts/field-decisions-probe.mjs --write` and re-run it flagless for `fixture in sync` — never hand-edit the fixture. No other file changes: leave `planImportExamples`, `planValidateRequest`, `planImportRequest` untouched, and expect `src/http/server/plan/validate-plan.test.ts` to stay red until Story 3.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the contract declares the branch · Story 2 GREEN

**Cycle.** GREEN for `src/http/contract/graph.test.ts` — the RED proof's missing export `planChoiceValues` (with `planChoiceBody`, `planChoiceBranch`, `path`, and the example entry) is in place.
**Files changed.**

- `src/http/contract/graph.ts` (edited) — added exported zod schemas `planChoiceBody`, `planChoiceValues` and `planChoiceBranch` immediately before `planChoiceEntry`; replaced `planChoiceEntry`'s two inline branch objects with `planChoiceBranch`; added `path: z.string().nullable()` between `fields` and `submitted`; replaced `planValidateExamples.success.choices` (`[]`) with the one-entry `both` example whose branches carry the two titles and whose `path` is `"initiative/atlas.md"` (`planDocument_example.path`).
- `src/http/contract/field-decisions.fixture.ts` (regenerated) — via `node scripts/field-decisions-probe.mjs --write`; grew by exactly 19 rows and lost none; flagless re-run prints `fixture in sync: 661 rows`. The `path` row landed at line 336, between `kind` (335) and `presence` (337), as the Story predicted.

**Seam (GREEN).** The wire contract of a choice branch now declares `values` required and closed over the six names with `body` a strict blob-hash pair, plus a required nullable `path` on the entry, and the published `planValidateExample.success` carries one parseable choice entry joined to its one document.
**Refactor.** None named by the Task; no import added (`blobHash` was already imported), `planValidateRequest`/`planValidateResponse`/`planDocument`/`planImportExamples` byte-identical, per the Story's constraints.
**Build check.**

- typecheck: exit 0
- lint: exit 0
- fixture probe (flagless): `fixture in sync: 661 rows`

**Assumptions.**

- VERIFIED: probe output before write listed exactly the 19 missing rows the Story enumerates (9 per branch + `path`), so schema and expected wire shape agree; nothing was hand-edited.
- Note: test execution stays the TE's gate. Per the coupling note, `src/http/server/plan/validate-plan.test.ts` is expected to stay red at its two `planValidateResponse.safeParse` assertions until Story 3 lands.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the query composes the values · Story 3 RED

**Cycle.** RED for Story 3 (`src/queries/plan/validate-plan.test.ts`, `src/http/server/plan/validate-plan.test.ts`) — the query composes `values` on both branches and the canonical `path` onto each entry, per D1, D2 and D4.
**Handoff verification.**

- software-engineer claim: typecheck exit 0, lint exit 0, fixture probe `fixture in sync: 661 rows` (Story 2 GREEN turn)
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Prior GREEN confirmed (Story 2).**

- command: `node --test src/http/contract/graph.test.ts`
- exit: 0 — 26 pass / 0 fail.
  **Test written.**

- file: `src/queries/plan/validate-plan.test.ts` (edited) — suite: `src/queries/plan/validate-plan.test` — methods: `a title edit to the pending task publishes the two titles as the only values`, `an acceptance-only edit names one instruction and two acceptances inside body`, `plan.validate performs the same PlanStore reads as the pre-epic tree`, `every non-null choice path names exactly one returned document`, `the choice path is the canonical path and not the authored submitted path`; extended `a re-import of the exported documents suggests database everywhere`, `a prose edit to the pending task suggests submitted with fields body`, `a database-only node appears in the choice set`, `the whole query is deterministic across two runs with a fresh mock`; `expectedChoices` amended to carry `path` and both branches' `values`.
- file: `src/http/server/plan/validate-plan.test.ts` (edited) — suite: `src/http/server/plan/validate-plan.test` — methods: `a validate over an edited fixture set answers all three presences with values and joinable paths`; extended `leaves every row count unchanged for every request in the suite` to also send the edited-fixture request against a fixture-seeded app.
- asserts: each choice branch carries the field values of the side it leaves in place — exactly the selected names for a `both` entry, all six names with `{}` opposite on either single-sided presence, `{}` on both sides of an equivalent `both` entry; `body` names both blob hashes with a null `acceptanceBlob` where a side has no acceptance; `depends_on` absent when equal; `path` is the canonical path of the submitted document (null for `database-only`), joins to exactly one member of `documents`, and is never the authored path; a submitted instruction hash is absent from the blob store while the stored one is present; the read count over five counted `PlanStore` methods stays at the pre-epic values; the wire body parses through `planValidateResponse` with all three presences in one call and writes nothing.
  **RED proof.**

- command: `node --test src/queries/plan/validate-plan.test.ts src/http/server/plan/validate-plan.test.ts`
- exit: 1 — 11 fail / 14 pass. Verbatim failing lines: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` (`expectedChoices` lacks `values`/`path` off the produced entries), `TypeError: Cannot read properties of undefined (reading 'body')` (branch carries no `values`), `AssertionError [ERR_ASSERTION]: path undefined does not name exactly one document`, and on the wire `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` `false !== true` (`planValidateResponse.safeParse(...).success`). The two pre-existing koa `safeParse` failures are the documented coupling-window red from Story 2; they turn green with this story.
- intended first-run passes, pinned not probed: `plan.validate performs the same PlanStore reads as the pre-epic tree` and the determinism `JSON.stringify` addition characterize "no extra read" and D4 key order — they pass before and after by design, and fail if the epic ever adds a read or reorders `values`.
- stub probe: `src/queries/plan/validate-plan.ts` — 12 errors found in my two test files (5× TS2532 indexing a `Record<string, number>` counter under `noUncheckedIndexedAccess`; 7× implicit-any from iterating untyped supertest `response.body`), fixed — counter rebuilt as a literal with dot access, koa assertions iterate `planValidateResponse.parse(response.body)` after the `safeParse` assertion; `npm run typecheck` exit 0 against the Story-declared types. Stub reverted via `git checkout`; `git status` shows no production diff.
  **Deviations (test-lane corrections, disclosed).**

- The Story's prose-edit bullet names the `taskPath` constant for `entry.path`. That constant is the canonical path of the _document-only_ submission (`plan/ship-kanthord--…/01-render-the-manifest--…`); the edited fixture task's canonical path is `plan/harden-the-verify-cli--01arz…/harden-the-verify-cli--01bqz…/01-harden-the-verify-cli--01drz….md` (probe: `canonicalPaths` over the fixture-resolved set, byte-exact). The assertion pins the true canonical path via a local `fixtureTaskPath` constant — the Story's intent, which is that `entry.path` joins the edited task to its rendered document.
- `editedFixtureSet` (both files) drops the objective by its rendered body discriminator, retitles the task to `Harden the verify CLI v2`, and adds one initiative carrying the explicit identity `initiative_01FQZ3NDEKTSV4RRFFQ69G5FAV`, so no mint fires and the three presences are deterministic.

**Open to Software Engineer.**

- seam: `src/queries/plan/validate-plan.ts` — apply the Change section of `.agents/plan/stories/027-plan-choice-values/03-the-query-composes-the-values.md` exactly: export `ChoiceBranch` and extend `ChoiceEntry` with `path: string | null` and branch members `values: ChoiceValues`; import `storedValues`/`submittedValues` and `import type { ChoiceValues }` from `../../domain/plan-diff.ts`; hoist the existing `canonicalNodes` construction above the choice loop with `const submittedPaths = canonicalPaths(canonicalNodes);` beside it; compose each branch as `{ ...verdict.submitted, values: … }` / `{ ...verdict.database, values: … }` behind the exact D4 guards (`document === undefined` / `node === undefined` produce `{}`, `selected = presence === "both" ? fields : null`), with `path: submittedPaths.get(identity) ?? null`. No other file changes: `src/commands/plan/import-plan.ts`, `src/domain/plan-choice.ts`, `src/domain/plan-diff.ts` and `src/http/contract/**` stay untouched, and `src/domain/plan-diff.test.ts` + `src/http/contract/graph.test.ts` must still pass unmodified.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the query composes the values · Story 3 GREEN

**Cycle.** GREEN for `src/queries/plan/validate-plan.test.ts` + `src/http/server/plan/validate-plan.test.ts` — resumed from an interrupted dispatch whose uncommitted `src/queries/plan/validate-plan.ts` edit was found in the working tree.

**Interruption disposition.** Inspected the orphaned edit line-by-line against the Change section of `.agents/plan/stories/027-plan-choice-values/03-the-query-composes-the-values.md`: all four edits are present and verbatim — the import block; `ChoiceBranch` plus the extended `ChoiceEntry`; the hoisted `canonicalNodes` with `submittedPaths` beside it and the original declaration deleted (one occurrence: lines 170, 179, 295); the three locals and the composed push behind the exact D4 guards. Kept as-is. This turn makes no further source change and records the outcome as its own.

**Files changed.**

- `src/queries/plan/validate-plan.ts` (edited — kept from the interrupted dispatch) — exported `ChoiceBranch`; `ChoiceEntry` gains `path: string | null` and typed its branches `ChoiceBranch` (`values: ChoiceValues`); imports `storedValues`/`submittedValues` and `import type { ChoiceValues }` from `../../domain/plan-diff.ts`; hoists the `canonicalNodes` construction above the identity loop with `const submittedPaths = canonicalPaths(canonicalNodes);` beside it; composes each branch as `{ ...verdict.<side>, values }` with `path: submittedPaths.get(identity) ?? null`.

**Seam (GREEN).** Each choice branch carries `values` projected only by the domain functions — `submittedValues` when a document exists, `storedValues` when a node exists, `{}` from the `document === undefined` / `node === undefined` guards, `selected = presence === "both" ? fields : null` — and every entry carries `path` from the same `canonicalPaths(canonicalNodes)` map that renders `documents`, so the join holds by construction and a `database-only` entry yields `null`.

**Refactor.** None named by the Task; the Story's Change section applied whole — the `choiceVerdict` call stays byte-identical, `repairSuggestions`/`bodies`/`renderDocumentSet`/the returned object are untouched, no comment added.

**Build check.**

- typecheck: exit 0
- lint: exit 0

**Assumptions.**

- VERIFIED: `git diff --quiet src/commands/plan/import-plan.ts src/domain/plan-choice.ts` succeeds — the D4 boundary files carry no change (Story Verify bullet).
- VERIFIED: `canonicalNodes` occurs exactly once (declaration at line 170, reads at 179 and 295), and the diff is pure move/addition with no second loop and no new `PlanStore` or `BlobStore` call — the read-count test stays at pre-epic values by construction.
- VERIFIED: `git status --porcelain` traces every modified path to a recorded turn — TE REDs (the three test files), Story 1 (`src/domain/plan-diff.ts`), Story 2 (`src/http/contract/graph.ts` + regenerated fixture), and this query edit.
- Note: test execution stays the TE's gate. Stories 2 and 3 are both landed — per the coupling note, run the full Verification Gate now.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the proposal records the choice values · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: Story 4 (`04-the-proposal-records-the-choice-values`).
**Handoff verification.**

- software-engineer claim: typecheck exit 0, lint exit 0 (Story 3 GREEN turn)
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Prior GREEN confirmed (Stories 1–3; the coupling window is closed).**

- command: the EPIC Proof line — `node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/validate-plan.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts`
- exit: 0 — 219 tests, 219 pass, 0 fail; `PASS EPIC-027` printed. The two koa `planValidateResponse.safeParse` assertions of the documented Story-2/3 coupling red now pass with no edit, so the coupled pair is closed. `src/commands/plan/import-plan.test.ts` passed unmodified — the D4 boundary holds.
  **Story file.** `.agents/plan/stories/027-plan-choice-values/04-the-proposal-records-the-choice-values.md`
  **Tasks forwarded to Software Engineer.**

- Story 4: `.agents/plan/stories/027-plan-choice-values/04-the-proposal-records-the-choice-values.md` — apply its two proposal edits verbatim: in `docs/proposal/api/graph.md` replace the one choice-set bullet line and add the four paragraphs after the "provisional in name only" paragraph; in `docs/proposal/api/new-decisions.md` add exactly one bullet under `## Decided here`; then run the Story's `npx prettier --write` command on both files.

**No RED phase.** Documentation only per the Story gate — no file under `src/` or `scripts/` changes, so no test can fail before the edit. The Story's Verify section owns the evidence: parity and proposal-amendment stay green, the diffs are exact, and the grep assertions pin the four bold lead-ins byte for byte.
**Open to Software Engineer.**

- implement the Change section of the Story file exactly. Copy the replacement line and the four paragraphs from the Story, which fixes their text; do not rephrase the canonical-path wording (B1's resolution) and write nothing about a diff format or `diffBlob`. Touch no route-table row, no node-operation heading, no concurrency paragraph, and no other proposal file. Then run the Formatting command from the Story so the committed bytes are stable.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the proposal records the choice values · Story 4 GREEN-ONLY

**Cycle.** GREEN-ONLY implementation for Tasks: Story 4 (`04-the-proposal-records-the-choice-values`).
**Files changed.**

- `docs/proposal/api/graph.md` (edited) — replaced the choice-set bullet of the `plan.validate` response list with the line that adds "the canonical path of the submitted document" and "the field values of that side"; added the four `values` paragraphs (the unbolded lead paragraph, then **Presence decides which names appear, not `fields`.**, **An absent key and a present `null` differ.**, **A `body` value is a pair of blob hashes, never prose.** — the last carrying **A submitted hash is not in the blob store** inline) immediately after the "provisional in name only" paragraph, one blank line apart, before `## \`plan.import\``.
- `docs/proposal/api/new-decisions.md` (edited) — added exactly one bullet, **A choice branch carries the field values of its own side.**, under `## Decided here`, between the existing `plan.validate` bullet and the plan-document-shape bullet.

**Implementation.** Both edits are the Story's Change-section text verbatim: canonical-path wording per B1's resolution, no diff-format or `diffBlob` wording, nothing about `values` on `plan.import`, and no other site touched — the `graph.md` diff is one hunk inside the `plan.validate` section, so the route table, the three node-route headings and the concurrency-classes paragraph are byte-identical.
**Refactor.** None named by the Task; documentation only.
**Formatting.** `npx prettier --write docs/proposal/api/graph.md docs/proposal/api/new-decisions.md` — both files report `unchanged`, so the committed bytes are the edited bytes.
**Build check.**

- typecheck: exit 0
- lint: exit 0

**Story Verify greps (mine to run; test execution stays the TE's gate).**

- the four bold lead-in substrings: all present via `grep -Fq`
- `one entry per node of the required choice set` in `graph.md`: `1`
- `A choice branch carries the field values of its own side` in `new-decisions.md`: `1`
- `diffBlob` in `graph.md`: `0`
- `git diff` shape: `graph.md` 10 insertions / 1 deletion (one replaced line plus four paragraphs with blank separators, one hunk); `new-decisions.md` exactly 1 added line

**Assumptions.**

- VERIFIED: `git status --porcelain` traces every modified path to a recorded turn; this turn added only the two proposal paths — no path under `src/` or `scripts/` changed.
- Note: `parity.test.ts` + `proposal-amendment.test.ts` and `npm run verify` remain the TE's gate per the Story's Verify section; the Story delivers no `PASS EPIC-027` line itself.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** All four Stories green — Stories 1–3 confirmed at the previous gate run, Story 4 (GREEN-only) verified this turn. Full EPIC gate executed end-to-end.
**Handoff verification.**

- software-engineer claim: typecheck exit 0, lint exit 0, prettier unchanged (Story 4 GREEN-ONLY turn)
- command: `npm run verify:handoff`
- exit: 0 — `VERIFY: PASS — npm run typecheck is clean`
  **Prior GREEN confirmed (Story 4, GREEN-only).**

- Story Verify assertions re-run independently: `node --test src/http/contract/proposal-amendment.test.ts` → 9 pass / 0 fail; the four bold lead-ins present in `docs/proposal/api/graph.md`; `one entry per node of the required choice set` count 1; `A choice branch carries the field values of its own side` count 1 in `new-decisions.md`; `diffBlob` count 0; diff shape 9 insertions / 1 deletion (`graph.md`) and exactly 1 added line (`new-decisions.md`); `git status --porcelain` traces every modified path to a recorded turn.
  **Test-lane corrections this turn (both files are test files — TE lane; no production path touched).**

- The Gate's first run failed on three stale test-lane conformers of the Story-2 contract change, outside the Proof list:
  - `src/cli/plan/import.test.ts` (edited) — the two fake-daemon `choice()` builders still produced the pre-epic wire shape, so `planValidateResponse.parse` at `src/cli/plan/import.ts:92` threw on the now-required `values` and `path`. Updated both builders to the Story-2 wire shape (`path` set to the first fixture document's canonical path, `values: {}` on both branches of these `fields: []` entries). Conformer sweep over all `legal:` matches in `src/**/*.test.ts`: every other site is either already updated (Stories 2–3), a direct domain-level call that never touches the zod schema, or an intentional refusal case.
  - `src/http/contract/system.test.ts` (edited) — `no response schema names a server path` bans the bare name `path` with an allow-list of plan-relative locations (`documents.path`, `findings.path`, `completeness.path`). D2 mandates `planChoiceEntry.path` as the canonical plan-relative join key, so `choices.path` joined that allow-list, exactly like its three precedents. The guard against server paths (`filePath`, `cwd`, `absolutePath`, …) keeps its full force.
- After both edits: the two suites pass (34/34), and the full gate below passes end-to-end.
  **EPIC verification gate.**

- handoff (`npm run verify:handoff`) → exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- gates (`npm run verify`) → exit 0 — 5027 tests, 5027 pass, 0 fail; final line `kanthord: verify db status ok`
- unit (`npm test` equivalent over the Proof files) → exit 0 — 219 tests, 219 pass, 0 fail
  **Proof.**

- command: `node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/validate-plan.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts && echo "PASS EPIC-027"` → exit 0
- success string printed verbatim: `PASS EPIC-027`
  **Hermetic coverage beyond the Proof — the clean-tree publish probe.**

- The tree is dirty with the epic's own uncommitted edits, so per B3's resolution the check ran from a temporary worktree at the working tree materialized as a throwaway commit object (`git stash create` → `28810b51aca39f6b2a83a211a6f7f53cca6640ba`, `git worktree add --detach`; worktree status clean — 0 dirty lines; `node_modules` resolved through a symlink in the parent temp directory so the worktree stayed pristine; worktree and symlink removed afterwards).
- command: `node scripts/publish-contract.ts --unreleased "$(mktemp -d)"` → exit 0, notice `publishing an unreleased artifact`
- `features/plan.yaml`: `values:` appears exactly twice — once under each branch of the inlined choice entry (lines 2138 and 2184), each carrying `body.instructionBlob` / `body.acceptanceBlob`; the entry-level `path:` member sits beside them.
- `examples/plan.validate.json`: the one `both` entry with `fields: ["title"]`, `suggested: "submitted"`, both branches `legal: true` / `reason: null` holding two different single-key titles, and `path: "initiative/atlas.md"` joining to exactly one member of `success.documents`.
  **Tasks closed.** 4 across 4 Stories — none outstanding, every Story expanded and implemented.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/validate-plan.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts) — "PASS EPIC-027"
- stories: 4/4 complete
- date: 2026-08-21
- state: local-uncommitted

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 4 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: incomplete database-only assertion — src/queries/plan/validate-plan.test.ts:767-781 checks all keys but omits exact depends_on, repo and acceptanceBlob values; deep-equal the complete database.values record against the stored node (gate line 302).
BLOCKER: acceptance-only body assertion is weaker than required — src/queries/plan/validate-plan.test.ts:639-647 checks only equality/inequality relations; deep-equal both body records against their expected instruction and acceptance hashes (gate line 305).
BLOCKER: missing both-entry null-acceptance coverage — src/domain/plan-diff.test.ts:361-370 invokes projections separately and never builds a both choice entry; add the validatePlan scenario asserting both branch values for stored acceptanceBlob null versus a submitted hash (gate line 306).
BLOCKER: dependency-entry contract is not exercised — src/domain/plan-diff.test.ts:373-419 passes fields null for equivalent lists so both projections carry depends_on; exercise both cases through validatePlan and assert neither branch carries depends_on for an order-only difference, then exact normalized arrays for a real one (gate line 307).

## TEST-ENGINEER — implementation ready for review

**Cycle.** The four AUTO_REVIEW `BLOCKER:` lines are resolved. A prior test-engineer dispatch for these blockers was interrupted before it could append; its uncommitted edits to `src/queries/plan/validate-plan.test.ts` were inspected line-by-line against each blocker, found complete, kept, and formatted. Full EPIC gate re-run end-to-end this turn — green.
**Test written.**

- file: `src/queries/plan/validate-plan.test.ts` (edited — kept from the interrupted dispatch) — suite: `src/queries/plan/validate-plan.test` — methods: `a both entry whose stored acceptance is absent publishes a null acceptanceBlob against the submitted hash`, `an order-only dependency difference with a repeat names no field and carries no depends_on`, `a genuinely different dependency publishes two normalized lists sorted by comparePaths`; strengthened `an acceptance-only edit names one instruction and two acceptances inside body` and `a database-only node appears in the choice set` to full deep-equals
- asserts: B1 — the `database-only` entry's `database.values` deep-equals the complete six-name record (exact body hash pair, `depends_on: []`, `parent`, `repo: null`, `title`, `worker: null`) beside `fields: []` and `submitted.values: {}`; B2 — both `values.body` records of an acceptance-only edit deep-equal their expected instruction and acceptance hashes; B3 — a `both` entry built through `validatePlan` whose stored acceptance is absent carries `database.values.body.acceptanceBlob: null` against the submitted hash; B4 — an order-only dependency difference with a repeat names no field and neither branch carries `depends_on`, while a genuinely different member publishes both normalized lists (`comparePaths` order, duplicates dropped) as exact arrays
- first-run pass intended: these are review-blocker regression tests pinning shipped behavior (production landed in Stories 1–3), so sensitivity is proven by perturbation probes below, not by a red run

**Sensitivity probes (each expectation perturbed, failure captured verbatim, then reverted).**

- B1 probe: expected `repo: "kanthord-verify"` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` on `repo`
- B2 probe: swapped the two acceptance-hash expectations → `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` on `acceptanceBlob`
- B3 probe: replaced `acceptanceBlob: null` with the submitted hash → `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` on `acceptanceBlob`
- B4a probe: expected `fields: ["depends_on"]` → `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` `actual: []`, `expected: [ 'depends_on' ]`
- B4b probes: expected the raw repeated list → fails on dedup (`actual: { depends_on: [ 'task_01FRZ…' ] }`); reversed the stored list order → fails on `comparePaths` order (`actual: [ 'task_01ERZ…', 'task_01FRZ…' ]`)
- after reverts: 22 pass / 0 fail in the suite; `git status --porcelain` traces every modified path to a recorded turn

**Test-lane corrections this turn (both files are test files — TE lane).**

- `src/queries/plan/validate-plan.test.ts`, `src/http/server/plan/validate-plan.test.ts` — `npx prettier --write` (formatting only: return-type wrapping, filter-line breaks, literal formatting from the unformatted additions); both now report `All matched files use Prettier code style!`

**EPIC verification gate.**

- handoff (`npm run verify:handoff`) → exit 0 — `VERIFY: PASS — npm run typecheck is clean`
- gates (`npm run verify`) → exit 0 — 5030 tests, 5030 pass, 0 fail; final line `kanthord: verify db status ok`
- unit (the Proof files) → exit 0 — 222 tests, 222 pass, 0 fail
  **Proof.**

- command: `node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/validate-plan.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts && echo "PASS EPIC-027"` → exit 0
- success string printed verbatim: `PASS EPIC-027`
  **Tasks closed.** 4 across 4 Stories — none outstanding, every Story expanded and implemented; the four routed blockers carry regression coverage.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/plan-diff.test.ts src/domain/plan-choice.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/validate-plan.test.ts src/http/contract/graph.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/openapi.test.ts src/http/contract/parity.test.ts) — "PASS EPIC-027"
- stories: 4/4 complete
- date: 2026-08-21
- state: local-uncommitted

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
