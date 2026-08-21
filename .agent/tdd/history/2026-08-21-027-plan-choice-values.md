---
epic: .agent/plan/epics/027-plan-choice-values.md
opened: 2026-08-21
opener: test-engineer
base-ref: a7638702498a7e05f21f8bdb13f57a0fac2f7a32
---

# Implementation cycle — 027-plan-choice-values

Pulled from EPIC: `.agent/plan/epics/027-plan-choice-values.md`.

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

- No `.agent/plan/stories/027-plan-choice-values/` directory exists.
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
- No `.agent/plan/stories/027-plan-choice-values/` directory exists.
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

- `.agent/plan/stories/027-plan-choice-values/index.md`
- `.agent/plan/stories/027-plan-choice-values/01-the-domain-projects-the-choice-values.md`
- `.agent/plan/stories/027-plan-choice-values/02-the-contract-declares-the-branch.md`
- `.agent/plan/stories/027-plan-choice-values/03-the-query-composes-the-values.md`
- `.agent/plan/stories/027-plan-choice-values/04-the-proposal-records-the-choice-values.md`

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

- `.agent/plan/epics/027-plan-choice-values.md` — D2's `path` definition and its rationale, the `plan.validate` `documents` paragraph, the query Story bullet, and three Verification Gate bullets. **This is a non-source file, edited on Ulrich's instruction.**
- `.agent/plan/stories/027-plan-choice-values/02-the-contract-declares-the-branch.md` — the example note.
- `.agent/plan/stories/027-plan-choice-values/03-the-query-composes-the-values.md` — the hoist, the composition, the canonical `path` values in `expectedChoices`, and the two join tests.
- `.agent/plan/stories/027-plan-choice-values/04-the-proposal-records-the-choice-values.md` — the join-key wording in both edits.
- `.agent/plan/stories/027-plan-choice-values/index.md` — three blockers `status:FIXED`, dispatch order unblocked, three new canonical-path facts.

All six files pass `npx prettier --check`, so the commit hook rewrites nothing.

**Open.** None. No blocker and no suggestion is outstanding for EPIC 027.

**Action required.** None from Ulrich. `/work` may resume on EPIC 027 and dispatch Story 1.

END: ULRICH
