# EPIC 027 — Plan choice values — stories

Epic: `.agents/plan/epics/027-plan-choice-values.md`
Prereq: EPIC 026 (sequence order). It landed at `a763870`, which is the `base-ref` of the cycle.

Every `plan.validate` choice branch carries `values`, the field values of the side that branch leaves in place, so a human resolving a conflict sees what each branch holds instead of an identity alone.

## Dispatch order

1. `01-the-domain-projects-the-choice-values.md` — passes the full gate alone.
2. `02-the-contract-declares-the-branch.md` — **coupled with Story 3.**
3. `03-the-query-composes-the-values.md` — **coupled with Story 2.** Run the full gate once, after this story.
4. `04-the-proposal-records-the-choice-values.md` — documentation only.

**Every blocker is closed. All four stories are dispatchable in this order.**

**Run no gate between Stories 2 and 3.** Story 2 declares a required `values` member and Story 3 is what produces it, so the tree is red between them. The red is confined to `src/http/server/plan/validate-plan.test.ts` and inside it to the two `planValidateResponse.safeParse` assertions, at lines 140 and 172. Typecheck stays green across the pair, because the query's `ChoiceEntry` type is hand-written and not derived from the zod schema.

The order cannot be reversed. Story 3 before Story 2 would be red too, because the pre-epic `planChoiceEntry` is a `z.strictObject` and would refuse the query's new `values` and `path` keys. The pair is atomic in either direction.

## Stories

- 1 — `ChoiceValues`, `storedValues` and `submittedValues` join the comparison in `src/domain/plan-diff.ts` → `01-the-domain-projects-the-choice-values.md`
- 2 — `planChoiceBody`, `planChoiceValues`, `planChoiceBranch` and `path` reach `src/http/contract/graph.ts`, and the published example carries a choice entry → `02-the-contract-declares-the-branch.md`
- 3 — `src/queries/plan/validate-plan.ts` composes the two branches and the `path` → `03-the-query-composes-the-values.md`
- 4 — `docs/proposal/api/graph.md` and `new-decisions.md` record the member → `04-the-proposal-records-the-choice-values.md`

## Blockers — all closed

- B1 - status:FIXED - action:YES - `path` is the canonical path of the submitted document - D2 had fixed `path` as the authored submitted path while the gate required every non-null `path` to name one member of `documents`, which carries the canonical set from `renderDocumentSet` at `src/queries/plan/validate-plan.ts:278`; the authored `plan/i--01/initiative.md` never matches the canonical `plan/ship-kanthord--<ulid>/initiative.md`, so the join found zero - fix:resolution **(a)** applied. The EPIC's D2 and its gate bullet now name the canonical path, and Story 3 hoists the existing `canonicalNodes` construction above the choice loop, adds `const submittedPaths = canonicalPaths(canonicalNodes);`, and sets `path` to `submittedPaths.get(identity) ?? null`. `renderDocumentSet` derives its own paths from `canonicalPaths(nodes)` (`src/domain/plan-render.ts:84`), so the two maps are the same pure function over the same argument and the join holds by construction. - why:the join is the only reason the member exists, so the member takes the value that joins. `canonicalPaths` is pure domain with no `PlanStore` or `BlobStore` access, so running it twice per request leaves the read count unmoved and D4's "no extra read" intact.
- B2 - status:FIXED - action:YES - the non-ASCII order contrast is bare `.sort()`, not `Buffer.compare` - the gate claimed `comparePaths` and `Buffer.compare` differ; they agree for every well-formed string, because UTF-8 byte order equals code-point order, and `src/domain/plan-path.test.ts:160` already asserts that agreement over the same pair - fix:the EPIC's bullet now names bare `Array.prototype.sort` as the contrast and records both caveats — the agreement fails only for a lone surrogate, which UTF-8 maps to U+FFFD, and neither test identity is a reachable product identity. Story 1 already asserts it that way. - why:`.sort()` compares UTF-16 code units and reverses the pair, so it is the substitution a test can catch; a `Buffer.compare` assertion passes under both a correct and an incorrect implementation and proves nothing.
- B3 - status:FIXED - action:YES - the publish check runs from a clean tree only - the gate ended with `node scripts/publish-contract.ts "$(mktemp -d)"`, but `scripts/release-gate.ts:36` returns `dirty-tree` before it tests `unreleased`, so the command was refused in the only state a story could run it - fix:the EPIC's bullet now states that the check runs after the epic's commit, or from a temporary worktree at that commit, and passes `--unreleased` so an untagged commit is accepted. Story 3 carries the same wording and command. - why:as written the check was unrunnable where it was specified, so it would report a false failure or be skipped without anyone noticing.

## Facts (needed for implementation)

- **Two different symbols are named `differingFields`.** `src/domain/plan-diff.ts:6` exports a **function** `(stored, submitted, blobs) => readonly DifferingField[]`. `src/domain/node-write-legality.ts:14-21` exports the six-name **array**, re-exported through `src/domain/plan-choice.ts:5-10`. `plan-diff.ts` therefore cannot import the array under its own name, and Story 1 writes the six names as six literal `if` statements instead.
- **The EPIC's line citations for `graph.ts` and the fixture are stale.** `planValidateExamples.success.choices` is at `src/http/contract/graph.ts:283`, not 236. `planImportExamples.request.choices` is at `:308`, not 262. The fixture's `submitted` rows are at 329-331 and its `database` rows at 321-323, not 320-321 and 328-329. The stories use the real anchors.
- **The stored and submitted property names are not symmetric.** `parent` is `stored.parentId` against `submitted.parentIdentity`; `repo` is `stored.repositoryId` against `submitted.repo`. `src/domain/plan-diff.ts:32-37` is the existing precedent.
- **`depends_on` reads `dependencies`, never `dependsOn`.** `ParsedDocument.dependsOn` (`src/domain/plan-document.ts:43`) is the raw frontmatter list; `ResolvedDocument.dependencies` (`src/domain/plan-identity.ts:18`) is the resolved identity list, and it is what `plan-diff.ts:24` compares.
- **`ResolvedDocument` already carries `path`**, inherited from `ParsedDocument` (`src/domain/plan-document.ts:39`) and populated at `src/domain/plan-validate.ts:157`. It is the **authored** path, and it is **not** the value the `path` member takes — see B1. `StoredNode` carries no path at all, which is why a `database-only` entry has none.
- **`renderDocumentSet` derives every path from `canonicalPaths(nodes)`** (`src/domain/plan-render.ts:84`), then sorts the set by `comparePaths` (`:109`). So `canonicalPaths(canonicalNodes)` computed anywhere returns exactly the paths the response's `documents` carry. `canonicalPaths` is pure — `src/domain/plan-canonical-path.ts` reads no file, no clock and no store — and `src/queries/plan/validate-plan.ts:17` already imports it.
- `storedPaths` at `src/queries/plan/validate-plan.ts:85-100` is **not** the join map. It runs `canonicalPaths` over the **stored** graph and reverses the result to `path -> identity`, so it holds no entry for a `document-only` node and its path can differ from the newly rendered one after a submitted title or parent change. Use a fresh `canonicalPaths(canonicalNodes)` over the submitted set.
- `document` and `node` in the choice loop are `Map.get` results, so they are `undefined` when absent, never `null` (`src/queries/plan/validate-plan.ts:176-177`).
- `blobHashes` is keyed by identity and its value is `{ instruction: string; acceptance: string | null }` (`:171-174`, set at `:196`) — exactly the shape `submittedValues` takes.
- `repairedChoices` at `:247-250` spreads `...entry` and overrides only `suggested`, so `values` and `path` survive it with no edit.
- `BlobStore.get` returns `null` when the blob is absent, and `BlobStore.put` is the only writer and takes a `Transaction` the query never opens (`src/services/blob/index.ts:21-25`).
- `blobHash` is `/^sha256:[0-9a-f]{64}$/` (`src/domain/blob.ts:5`). Uppercase hex is refused. `EXAMPLE_HASH` is `sha256:` plus 64 `a` characters.
- The field-decisions fixture is regenerated, never hand-edited: `node scripts/field-decisions-probe.mjs --write`. It prints `fixture in sync` when clean and exits 1 when stale. `src/http/contract/coverage.test.ts:314` is `assert.deepEqual(rows, fieldDecisions)`, so the fixture must equal the live walk exactly. The file is sorted bytewise and carries no header comment.
- `coverage.test.ts` hard-codes no property-name allow-list for `plan.validate`. Its only per-operation entry is `operationAdditions["plan.validate"] = ["plan-invalid"]` at line 30, which lists error codes.
- `openapi.test.ts` asserts the `components.schemas` key list at lines 280-294. `planChoiceBody`, `planChoiceValues` and `planChoiceBranch` inline into `planChoiceEntry` and add no key, so that list is unaffected.
- `example.test.ts` walks the same `registry` and names `plan.validate` at line 38, so the new example is parsed against `planValidateResponse` by the existing test with no edit.
- `plan.validate` lands in the `plan` feature slice, because `openApiFeatures` groups on the `operationId` prefix before the first `.` (`src/http/contract/openapi.ts:18-42`). The published slice is `features/plan.yaml`.
- `scripts/publish-contract.ts` takes `[--unreleased] <output-directory>` and refuses any other flag or a second positional argument. `yaml` is a runtime dependency at `2.9.0`, so a `node --input-type=module` check may import it.
- `src/http/contract/parity.test.ts` parses only lines starting with `|` that carry exactly five cells, across `docs/proposal/api/*.md` except `README.md` and `new-decisions.md` (`test/helpers/proposal.ts:57,64-84`). Prose edits cannot break it. It pins 70 comparable and 74 total rows.
- `src/http/contract/proposal-amendment.test.ts` reads `graph.md` whitespace-squashed and asserts the three node-route headings and the concurrency-classes paragraph at `graph.md:176` verbatim. Leave both alone.
- No test or script validates a `new-decisions.md` row. The file is excluded from the route-matrix parser.
- `docs/**/*.md` runs through `prettier --write` on every commit via `.husky/pre-commit` → `lint-staged`. `.prettierrc.json` sets no `proseWrap`, so prose does not reflow.
- `src/domain/plan-diff.test.ts` builds its `StoredNode` and `ResolvedDocument` fixtures inline through `stored()` and `submitted()` at lines 51-59; `test/helpers/` holds no domain-level builder for either type. Suite names are the test file's own module path.
- `src/queries/plan/validate-plan.test.ts` runs against real SQLite through `build()` at lines 174-200 and mocks only `ids`. `createRecordingPlanStore` in `test/helpers/plan.ts:62` counts only the two write methods, so a read-counting wrapper is new and local to the test file.
- `src/commands/plan/import-plan.ts:274-330` holds a loop structurally identical to the query's, with the same `blobHashes` shape. It is deliberately **not** in scope: its `choiceVerdict` call uses only `.submitted` and needs no value. Leaving it untouched is what proves the D4 boundary.
