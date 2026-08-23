---
epic: .agent/plan/epics/029-one-branch-field-and-objective-feature-branches.md
opened: 2026-08-22
opener: test-engineer
base-ref: b7154a64912f313f08737702d932cdb5634e9843
---

# Implementation cycle — 029-one-branch-field-and-objective-feature-branches

Pulled from EPIC: `.agent/plan/epics/029-one-branch-field-and-objective-feature-branches.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/repository.test.ts \
>   src/services/storage/migration-0009-one-branch.test.ts \
>   src/services/storage/migration-0001-core-entities.test.ts \
>   src/services/storage/sqlite.test.ts \
>   src/services/git/seed.test.ts \
>   src/services/git/preflight.test.ts \
>   src/services/git/clone.test.ts \
>   src/services/git/binary.test.ts \
>   src/queries/repository/show-repository.test.ts \
>   src/queries/repository/list-repository.test.ts \
>   src/commands/repository/register-repository.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/coverage.test.ts \
>   src/http/contract/openapi.test.ts \
>   src/http/contract/example.test.ts \
>   src/http/contract/path.test.ts \
>   src/http/contract/event-payload.test.ts \
>   src/http/server/repository/register-repository.test.ts \
>   src/http/server/repository/list-repository.test.ts \
>   src/http/server/repository/show-repository.test.ts \
>   src/cli/repository/register.test.ts \
>   src/cli/repository/show.test.ts \
>   src/cli/confirm.test.ts \
>   src/cli/reachability.test.ts \
>   src/cli/inventory.test.ts \
>   src/main.repository-branch.test.ts \
>   && echo "PASS EPIC-029"
> ```
>
> `npm run contract:publish -- "$(mktemp -d)"` exits 0, and no emitted example names a dropped field.
> It is not in the Proof command because it writes outside the repository.
>
> Hermetic coverage required beyond the Proof:
>
> - **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
>   `verify-db-status`.
> - **A fresh database migrates 0001 through 0009**, and `PRAGMA table_info(repository)` names `branch`
>   and names neither `landing_branch` nor `publish_ref`. The column list is asserted by value, not by
>   absence alone.
> - **The migration refuses a row it cannot migrate, and names it.** A `landing_branch` differing from
>   `upstream_branch`, and a `publish_ref` differing from `refs/heads/<upstream_branch>`, are each
>   refused. The refusal names one repository, chosen by `ORDER BY name`, so two divergent rows always
>   produce the same message. A refusal leaves the schema and the `migration` table untouched and
>   leaves no temporary object behind.
> - **A registration against the loopback fixture of EPIC 005** seeds a bare home whose only local head
>   is `refs/heads/<branch>`, asserted through `repository.show` in one daemon-backed test rather than
>   across two unit tests that never meet.
> - **The three refs are derived, never stored.** `repositoryView` reports `landingRef`, `trackingRef`
>   and `publishRef` rendered from `branch`, asserted by exact string for a branch name that contains a
>   slash.
> - **An objective clone reports `feature/<node id>` as its checked-out branch**, asserted through
>   `git symbolic-ref --quiet HEAD` against the fully-qualified ref, and the object-file link count
>   still proves isolation.
> - **The registry equals the proposal contract**, and `repository.landingBranch` appears in neither the
>   registry, the proposal, nor the path grammar.
> - **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
>   A test that needs a remote uses the loopback fixture of EPIC 005.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — the proposal states one branch field · Story 1 · GREEN-only Tasks

**Cycle.** GREEN-ONLY pass-through for Tasks: `01-the-proposal-states-one-branch-field` — first Task of the first Story of EPIC `029-one-branch-field-and-objective-feature-branches`; this discussion file had no prior turns.

**Story file.** `.agent/plan/stories/029-one-branch-field-and-objective-feature-branches/01-the-proposal-states-one-branch-field.md`

**Tasks forwarded to Software Engineer.**

- `01-the-proposal-states-one-branch-field`: `docs/proposal/phase-1/git-foundation.md`, `docs/proposal/api/repository.md`, `docs/proposal/phase-2/integration-and-publish.md`, `docs/proposal/database/repository.md`, `docs/proposal/phase-1/README.md` — documentation-only edit: Edits 1–17 verbatim replacements per the Story's Change section (ref-role table, seeding sequence, `## Three branch fields` → `## One branch field` section, clone sequence + new paragraph, register-flag prose, body/route prose, publish sequence, DDL collapse to one `branch` column, sample row, README flag), then `npx prettier --write` over the five files.

**No RED phase.** The Story changes no file under `src/`, `test/` or `scripts/`; its Verify section runs the existing `src/http/contract/parity.test.ts` and `src/cli/inventory.test.ts` unchanged plus `git diff --stat`/`grep -c` inspections of the five docs files. Coverage owned elsewhere per the Story gate — no test is written for documentation.

**Open to Software Engineer.**

- Implement GREEN per the Story file's Change section, byte-for-byte as quoted. Pre-checked against the working tree: every quoted "today" line matches except two line numbers in `api/repository.md` have drifted by one — the "Returns the branch fields…" paragraph is at **line 100** (Story cites 101) and the "P1-E4 and P3-E6 assert…" paragraph is at **line 104** (Story cites 105). Locate those two by their quoted text. All other cited anchors verified exact: `git-foundation.md` 21–22, 35–36, 211, 237, closing fence 243, insertion point before 245; `api/repository.md` 24 and 58; `integration-and-publish.md` 38, 55–56, 62; `database/repository.md` 12–14, 20, 28, 76–78, 90, with line 34 left byte-identical; `README.md` 71.
- Honour the Constraints section: touch no route-table line (`api/repository.md` 9–16 and 108/110/111 stay untouched — Story 2 owns them), amend no epic or plan file, keep `publishOnApproval` on the register body, do not describe force rules, clone-isolation assertions, the readable feature-branch alias, or pushing `feature/*` to origin.
- After your edit, run the Story Verify inspections (`node --test src/http/contract/parity.test.ts src/cli/inventory.test.ts` must pass unchanged with counts still 70/74; the five-file diff scope; the four `grep -c` zeros and the `feature/<node id>` count of 3), then `npm run typecheck`. My next turn runs the build-proof gate (`npm run verify`) via `npm run verify:handoff` and opens Story 2.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the proposal states one branch field · docs-only Edits 1–17

**Cycle.** GREEN-ONLY implementation for Tasks: `01-the-proposal-states-one-branch-field`.

**Files changed.**

- `docs/proposal/phase-1/git-foundation.md` (edited) — ref-role table gains the Objective-work row and names `refs/heads/<branch>` (Edit 1); seeding sequence reads `<branch>` on both lines (Edit 2); `## Three branch fields` replaced in full by `## One branch field` with the role/ref table and the `feature/<node id>` rule (Edit 3); clone sequence becomes `--branch <branch>` plus `checkout -b feature/<node id>` with the new post-fence paragraph (Edit 4).
- `docs/proposal/api/repository.md` (edited) — register flag prose now `--branch <branch>` (line 24, Edit 5); body holds the one branch field (line 58, Edit 6); show returns `branch` and the three refs it renders (line 100, Edit 7); derived-read-only-refs paragraph (line 104, Edit 8). Route-table lines 9–16 and 108/110/111 untouched.
- `docs/proposal/phase-2/integration-and-publish.md` (edited) — publish steps assert/push `refs/heads/<branch>` (lines 55–56, Edit 9); branch-protection paragraph rewritten around one field (line 62, Edit 10); `mr@1` integrates from `feature/<node id>` to `refs/heads/<branch>` (line 38).
- `docs/proposal/database/repository.md` (edited) — DDL collapses to the single `branch` column (Edit 11); `updated_at` comment drops "field" (Edit 12); one-branch-field prose with the three derived refs stored nowhere (Edit 13); sample row collapses to `branch main` (Edit 15); example interpretation rewritten (Edit 16). Line 34 left byte-identical per Edit 14.
- `docs/proposal/phase-1/README.md` (edited) — P1-E1 oracle flag renamed to `--branch` (line 71, Edit 17).

Formatting: `npx prettier --write` ran over all five per the Story's Formatting section; only `git-foundation.md` changed bytes under it (markdown table column-width realignment).

**Seam (GREEN).** n/a — documentation-only Task; conformance target was the Story's Change section, applied byte-for-byte as quoted. The two drifted anchors the pass-through flagged were located by quoted text at lines 100 and 104 of `api/repository.md`; every other cited anchor matched its stated line number.

**Refactor.** none named by the Task.

**Build check.**

- typecheck: exit 0
- `git diff --stat -- docs/`: exactly the five named files, nothing else
- `git diff -U0 -- docs/proposal/api/repository.md`: hunks touch lines 24, 58, 100, 104 only
- `git status --porcelain`: no modification outside the five docs files
- `grep -c "Three branch fields\|three branch fields" git-foundation.md` → 0
- `grep -c "feature/<node id>" git-foundation.md` → 3
- The two `node --test` inspections (`parity.test.ts`, `inventory.test.ts`) were not executed: running tests is the test-engineer's lane even when a hand-off names them, and your next-turn `verify:handoff` re-runs both.

**OPEN — three Story Verify zero-greps contradict the Story's own Change/Constraints.**

- B1 - status:OPEN - action:YES - grep #1 hits Edit 3's own replacement text - `grep -c "upstreamBranch\|landingBranch" docs/proposal/phase-1/git-foundation.md` reports **1**, at line 224: "`upstreamBranch` at `main`. That mode is gone." — words the Story itself mandates verbatim in Edit 3's block - fix: amend the Verify bullet (scope the pattern to exclude the historical paragraph, or drop the bullet) - why: reaching 0 requires altering text the Story quotes byte-for-byte, which the pass-forward forbids.
- B2 - status:OPEN - action:YES - grep #3 hits Edit 14's protected line - `grep -c "upstream_branch\|landing_branch\|publish_ref" docs/proposal/database/repository.md` reports **1**, at line 34 ("A change to `landing_branch` is an explicit command…"), which Edit 14 orders byte-identical because a later story owns it alongside `api/repository.md:15` - fix: move this bullet to the story that rewrites line 34 - why: editing the line now manufactures the source-of-truth self-contradiction Edit 14 exists to prevent.
- B3 - status:OPEN - action:YES - grep #4 hits an unenumerated line - `grep -c "\-\-upstream" docs/proposal/api/repository.md` reports **1**, at line 42 ("…the same rule as `--upstream`"), covered by no Edit 5–8 and barred by "Change no other line" - fix: human adds an Edit renaming it to `--branch` (it dangles against Edit 5's rename), or scopes the bullet - why: only a human may amend the plan, and the fourth grep does name a genuine leftover reference.
- The fourth inspection of that group passes: `grep -c "\-\-upstream" docs/proposal/phase-1/README.md` → 0.

I edited none of the three lines: two sit inside byte-level mandates and one inside an explicit prohibition, and a silent deviation from any of them is worse than surfacing the contradiction. Every other Verify inspection passes as reported above; all seventeen edits landed clean, so adjudicating B1–B3 requires no rework of this turn.

**Assumptions.**

- VERIFIED: each residual grep hit traces to a Story-mandated or Story-protected line (quoted above with locations).
- UNVERIFIED: parity/inventory counts still read 70/74 — left to your gate; the Story's own analysis states the inventory regex discards trailing flags and no route row moved.

ATTEMPT-FAILED: 01-the-proposal-states-one-branch-field — three Story Verify zero-greps (B1–B3) contradict the same Story's mandated/protected lines; all seventeen edits applied cleanly, no code touched

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — the landingBranch operation leaves · Story 2 · Task 02

**Cycle.** Per Ulrich's adjudication: Story 1 (`01-the-proposal-states-one-branch-field`) is complete — its five-file edit set landed exactly as described (verified by grep: Edit 3/5/6/17 present, `feature/<node id>` count 3; the two residual grep hits are precisely B1's line 224 and B2's protected line 34). Build-only check for the GREEN-only flow: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Advancing to Story 2 — RED for Task `02-the-landing-branch-operation-leaves` (`src/http/contract/*` + `src/http/server/repository/list-repository.test.ts`).

**Test written.** (Story 2's Verify section edits live in existing test files — test-engineer lane.)

- file: `src/http/contract/registry.test.ts` (edited) — suite: `src/http/contract/registry.test` — methods renamed/repinned: `registers sixty-nine operations` (70→69), `sorts the registry bytewise…` Set size 70→69, stubbed count 26→25, phase-2 count 28→27, `declares exactly the twenty-nine POST policies the story names` with `"repository.landingBranch"` removed from the array, `counts twenty-eight memory-policy operations` (29→28).
- file: `src/http/contract/parity.test.ts` (edited) — suite: `src/http/contract/parity.test` — comparable length 70→69, proposal-row total 74→73.
- file: `src/http/contract/coverage.test.ts` (edited) — suite: `src/http/contract/coverage.test` — stubbed count 26→25 (the `:416` count of 38 stays, untouched).
- file: `src/http/contract/openapi.test.ts` (edited) — suite: `src/http/contract/openapi.test` — operation-id count 70→69; path count pinned by `renders sixty-one distinct paths in bytewise order` (62→61); the landing-branch exemplar half of `plan.import's default response refs its own error component…` generalised into a loop over every `status === "stubbed"` registry entry rendering each path via `renderOpenApiPath` and asserting its default response refs `#/components/schemas/Error` (plan.import half unchanged); adds one import of `renderOpenApiPath` from `./path.ts`.
- file: `src/http/contract/path.test.ts` (edited) — suite: `src/http/contract/path.test` — `pins the closed-array sizes`: `subresourceSegments.length` 17→16; the ordering test now reads `graph` after `edge` and before `llm` (adjacent pair after the deletion), same explicit-index shape.
- file: `src/http/server/repository/list-repository.test.ts` (edited) — deleted `POST /v1/repository/<id>/landing-branch answers 501 ships in phase-2 and writes nothing` in full; the reconcile 501 test and the view fixture stay byte-identical.
- asserts: the registry, the proposal matrix, the coverage counts and the closed path grammar shrink by exactly one stubbed phase-2 operation, and no test names the landing-branch route or segment any more.

**RED proof.**

- command: `node --test src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/path.test.ts src/http/contract/example.test.ts src/http/server/repository/list-repository.test.ts`
- exit: 1 — 12 failures, all count pins against the still-present operation. Verbatim: `✖ registers sixty-nine operations … AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 70 !== 69`. Also red: parity `70 !== 69` / `74 !== 73`, coverage `actual: 26, expected: 25`, openapi `actual: 70, expected: 69` / `actual: 62, expected: 61`, path `actual: 17, expected: 16`. `example.test.ts` and `list-repository.test.ts` pass — correct: deletion and a loop that already holds today carry no RED; the pins above are the sensitive assertions.
- `npm run typecheck` exit 0 on my edits.

**Open to Software Engineer.**

- Delete the seam the tests prove present: the `repository.landingBranch` operation entry in full from `src/http/contract/repository.ts` (lines 240–253, so `repository.reconcile` follows `repository.show`; entry carries no request/response/examples), and `"landing-branch"` from `subresourceSegments` in `src/http/contract/path.ts` (line 28). Nothing else in either file.
- Docs per Story §3–4: delete `docs/proposal/api/repository.md` line 15 (route row) and lines 108–111 (`## repository.landingBranch` section), replace `docs/proposal/database/repository.md` line 34 with the Story's quoted replacement sentence, then `npx prettier --write` over both files (route-table reflow is required).
- One edit beyond the Story §Change list, required by the Story §Verify grep `grep -rl "landing-branch" src docs | wc -l` → 0: `docs/proposal/api/README.md:107` lists `` `landing-branch` `` among the subresource example values; drop it from that enumeration so the grammar doc stops naming a segment the closed set no longer contains. This is consistent with the Story's own rationale ("the grammar doc … the set shrinks with the route") and contradicts nothing mandated — unlike Story 1's B1–B3, nothing quotes or protects this line.
- Constraints: touch no branch field anywhere; do **not** regenerate `src/http/contract/field-decisions.fixture.ts` (a stubbed op contributes no fixture row — if the probe diffs, stop); `repository.reconcile` stays stubbed/phase-2; delete no schema component; add no operation or segment. The with-request/with-response arrays need no edit (confirmed: a stubbed entry is in neither).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — the landingBranch operation leaves · Task 02

**Cycle.** GREEN for `src/http/contract/*` + `src/http/server/repository/list-repository.test.ts` RED (12 count-pin failures).

**Files changed.**

- `src/http/contract/repository.ts` (edited) — deleted the `repository.landingBranch` operation entry in full; `repository.reconcile` now follows `repository.show` directly in the `operations([...])` array.
- `src/http/contract/path.ts` (edited) — deleted `"landing-branch"` from `subresourceSegments` (closed grammar shrinks with the route).
- `docs/proposal/api/repository.md` (edited) — deleted the route row and the `## repository.landingBranch` section (heading, blank line, paragraph, trailing blank line), so `## repository.reconcile` follows `## repository.show`'s last paragraph with one blank line between.
- `docs/proposal/database/repository.md` (edited) — replaced the "explicit command" sentence with the Story's quoted replacement ("A registered repository does not change its branch…").
- `docs/proposal/api/README.md` (edited) — dropped `` `landing-branch` `` from the subresource example-values enumeration in the path-grammar table, per your Open item.

Formatting: `npx prettier --write` over both Story-named docs files; only `api/repository.md` reflowed (route-table column widths), `database/repository.md` unchanged bytes.

**Seam (GREEN).** The registry, the closed segment grammar and both proposal documents no longer declare `repository.landingBranch`, so every pinned count moves by exactly one and the two absence greps reach 0.

**Refactor.** none named by the Task.

**Build check.**

- typecheck: exit 0
- `grep -rl "repository\.landingBranch" src docs | wc -l` → 0
- `grep -rl "landing-branch" src docs | wc -l` → 0
- `git diff --stat src/http/contract/field-decisions.fixture.ts` → empty (no diff)
- Runtime probe (`node -e` import of the contract module, not a test run): 5 repository operations remain (was 6), 0 `landingBranch` entries, `reconcile` at index `show`+1.

**Assumptions.**

- VERIFIED: `api/repository.md` route-table lines 9–16 minus row 15 now end at `repository.reconcile`; no branch field touched anywhere (Story 3 owns those); `repository.reconcile` stays `stubbed`/`phase-2`; no schema component deleted; with-request/with-response arrays untouched.
- VERIFIED: prettier on `docs/proposal/api/README.md` was not run — it is not named by the Story's Formatting section and the edited table cell still fits prettier's existing column alignment; a lint-staged commit hook will reflow if not.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — one branch field lands · Story 3 · Task 03

**Cycle.** Handoff gate first: software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Prior GREEN confirmed: Story 2's seven-file command block → 140 pass / 0 fail. Advancing to Story 3 (`03-one-branch-field-lands`) — RED for the whole story (its Verify section is the test spec; it has no sub-Tasks).

**Test written.**

- file: `src/services/storage/migration-0009-one-branch.test.ts` (new) — suite: `src/services/storage/migration-0009-one-branch.test` — methods: `migration0009OneBranch carries version 9, its name, and no rebuild`, `migrations holds exactly nine migrations with migration0009OneBranch last`, `a fresh database migrates 0001 through 0009 and repository carries branch and neither dropped column` (column list asserted by value, twelve names), `a divergent landing_branch is refused, names the repository ORDER BY name picks, and changes nothing` (inserts zulu then alpha, asserts `alpha`, applied still `[1..8]`, legacy columns intact, temp objects 0), `a divergent publish_ref is refused by name too`, `a clean row migrates and its node and project binding survive`, `re-applying the full chain to an already-migrated database is a no-op`.
- file: `src/main.repository-branch.test.ts` (new) — suite: `src/main.repository-branch.test` — method: `a registration seeds a bare home whose only local head is the one branch, and the view reports the derived refs`. Daemon-backed over the EPIC 005 loopback fixture: migrate via CLI, launch daemon, register provider + repository with body carrying `branch` and neither dropped key, assert show view by value plus absence of `upstreamBranch`/`landingBranch`, then `git --git-dir=<home>/repos/<name>.git for-each-ref refs/heads` deep-equals `["refs/heads/main"]`.
- file: `src/domain/repository.test.ts` (edited) — fixture collapses to `branch: "main"`; adds exact-string renderer tests for `headRefOf`/`trackingRefOf` (plain + slash), function-identity asserts `landingRefOf === publishRefOf === headRefOf`, and the zod-strip test proving `landingBranch`/`publishRef` survive neither parse.
- file: `src/queries/repository/show-repository.test.ts` (edited) — sixteen-member sorted key list; `view.branch`; UPDATE collapsed to `SET branch = ?`; new test `a branch of kanthord/landing reports all three derived refs by exact string`.
- file: `src/queries/repository/list-repository.test.ts` (edited) — shared INSERT collapses to twelve columns.
- files: `src/http/server/repository/{register,list,show}-repository.test.ts` (edited) — view fixtures collapse to `branch` keeping the three derived refs; register validBody collapses; missing-field tests collapse to one; negative four rewritten (`../etc`, `-x`, `main.lock`, unknown-key `publishRef` refused as proof the field left the wire).
- file: `src/http/contract/event-payload.test.ts` (edited) — `repository.registered` fixture becomes one `branch` key; `credentialRejected` keeps its `publishRef` key.
- file: `src/commands/repository/register-repository.test.ts` (edited) — RecordedSeed/RepositoryRowReadback/MockView/baseInput/seedHome recorder/readback SQL collapse; registered payload asserts `branch: "main"`; seed asserts `seed.branch === "main"`, `"publishRef" in seed === false`, `"landingBranch" in seed === false`.
- file: `src/services/git/seed.test.ts` (edited) — seedInput collapses to one `branch` default `"main"`; sequence-test push refspec constant becomes `refs/heads/main`; deletes `a branch mode writes one landing branch under another name`; adds `a non-default branch names both the tracking ref and the only local head` using the Story's fallback (fixture serves only `main`, so it seeds `main` and asserts both refs from the one name); missing-branch override renamed; read-only-preflight message assertion follows the rendered ref to `refs/heads/main`.
- file: `src/cli/repository/register.test.ts` (edited) — every `--upstream` argv literal becomes `--branch`; `--publish-ref` pairs deleted; VIEW/body assertions collapse to `branch`; flag-rename and no-terminal tests renamed with the `--branch is required…` expectation; two `--landing` tests deleted; adds `the register body carries branch and neither landingBranch nor publishRef`; prompt question pinned exact `"branch? [trunk]"`.
- files: `src/cli/confirm.test.ts`, `src/cli/repository/show.test.ts`, `src/cli/project/repository.test.ts`, `src/cli/reachability.test.ts` (edited) — flag/question renames and fixture collapses; show stdout line becomes `kanthord: branch main`.
- files: `test/helpers/rows.ts` (both fixtures), `test/helpers/recovery.ts`, `test/helpers/recovery-home.ts` and the thirteen enumerated INSERT sites (`create-node`, `update-node` ×2, `import-plan`, `main.claim`, `replace-project-repositories` ×2, `remove-provider` ×2, `journal`, `recover-expired-leases`, `read-status`, `plan/sqlite`) (edited) — every non-0001 INSERT collapses to the twelve-column form.
- files: storage registry pins (edited) — `migration-000{1,2,3,4,6,8}` test registry pins move from eight to nine entries / versions `[1..9]`.

**Plan deviations I had to make inside my lane — flagged, not silent:**

- B1 - status:FIXED - action:YES - migration-0001 parity vs Story 1's DDL edit - the Story says this file stays byte-identical, but its parity test compares 0001's statements against the live proposal DDL, which Story 1 already collapsed to one `branch` column; the test was red before this turn started and no production edit can fix it (shipped migrations are never rewritten) - fix: I reworked only that one test (five tables still compared verbatim against the doc; repository's statement pinned as its exact pre-migration literal) and moved its `migrations` pin to nine entries; its `repositoryColumns`, insert and all other tests stay byte-identical - why: the alternative leaves the EPIC Proof permanently red on a file the Proof itself names.
- B2 - status:FIXED - action:YES - unenumerated registry pins - registering migration 0009 (§Change 4) breaks the eight-entry pins in `migration-000{2,3,4,6,8}` tests, which the Story's Verify section does not list - fix: updated those five pins to nine entries / versions `[1..9]` / names + `0009-one-branch` - why: anti-pattern #2 makes conformers that a mandated change breaks part of this task.
- B3 - status:FIXED - action:YES - seed.test.ts new test name vs fallback - the Story fixes the name but its own instruction resolves to seeding `branch: "main"` because the loopback fixture serves only `main` - fix: kept the verbatim name, implemented the fallback body exactly as prescribed - why: inventing a second fixture branch is explicitly forbidden.
- B4 - status:FIXED - action:NO - `binary.test.ts:209` - the cited `publishRef` occurrence is a `canPush` input (`CanPushInput.publishRef`), which the Constraints keep unchanged; no seedHome input literal exists in that file - fix: none; file untouched - why: the Verify bullet's line reference describes a field that must survive.

**RED proof.**

- command: `node --test src/main.repository-branch.test.ts src/domain/repository.test.ts src/services/storage/migration-0009-one-branch.test.ts … src/cli/inventory.test.ts` (Story §Commands block, 22 files)
- exit: 1 — ℹ tests 284 · pass 220 · fail 64. Failing suites are exactly the rename-coupled ones; confirm, inventory, coverage, parity, registry, openapi, example, preflight and sqlite stay green, as the Story predicts (no count moves; preflight untouched). Verbatim failures: migration test → `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '…/src/services/storage/migration-0009-one-branch.ts'`; domain → `SyntaxError: The requested module './repository.ts' does not provide an export named 'headRefOf'`; queries/fixtures → `Error: table repository has no column named branch`; daemon path → `AssertionError: {"ok":false,"status":400,"code":"invalid-request",…"issues":[{"path":"branch","code":"unrecognized_keys","message":"Unrecognized key: \"branch\""}…]}`.
- stub probe: wrote throwaway `src/services/storage/migration-0009-one-branch.ts` (typed `Migration`, empty statements), ran `npm run typecheck`, found 30 errors — 29 intended rename mismatches confined to my edited test files (missing renderer exports, `branch` absent from the not-yet-renamed production types) plus 1 genuine bug of mine (`TS2304 migration0008GraphIndexes` in the reworked 0008 pin), fixed; stub deleted before this turn. Post-GREEN typecheck should be clean when the rename lands atomically.

**Open to Software Engineer.**

- Implement Story 3 §Change 1–15 exactly as written: domain field + renderers, migration 0009 file + registration, queries, git service interface/seed, command, contract schemas/examples/event payload, handler, both CLIs, and regenerate `src/http/contract/field-decisions.fixture.ts` via `node scripts/field-decisions-probe.mjs --write` (diff must touch only `repository.*` rows).
- The test side is done and above: do not edit any `*.test.ts` or `test/helpers/**`. My storage-pin updates (B1/B2) are already in place and will go green with your registration of 0009.
- Constraints binding you: never edit migration 0001 or `sqlite.ts`/`Migration`; refusal covers both old columns; `domain/` stays pure; leave `preflight.ts` and `CanPushInput.publishRef` alone; keep the `credentialRejected` payload's `publishRef` key; `publishOnApproval`/`hostFingerprint` stay; no `z.enum`; `repository.reconcile` stays stubbed.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — one branch field lands · Story 3 · Task 03

**Cycle.** GREEN for Story 3 (`03-one-branch-field-lands`), recovered per the operator's retry note: a cancelled dispatch had already edited production files before appending. I audited every one of its edits against the Story §Change 1–15 line-by-line, found all fifteen sections present and conformant, corrected nothing, and completed the verification the cancelled turn never reached.

**Files changed** (all by the recovered dispatch, audited this turn against the Story text):

- `src/domain/repository.ts` (edited) — `repositoryRow` collapses to one `branch: z.string()`; `RepositoryView.branch`; appends `headRefOf`, `trackingRefOf`, and the two identity aliases `landingRefOf = publishRefOf = headRefOf` (§1).
- `src/services/storage/migration-0009-one-branch.ts` (new) — verbatim per §3: temp guard table + trigger with expression `RAISE(ABORT, …)`, divergent-row probe covering both old columns with `ORDER BY name LIMIT 1`, objects dropped on success, then RENAME/DROP/DROP; no `rebuild`.
- `src/services/storage/migrations.ts` (edited) — registers `migration0009OneBranch` last (§4).
- `src/queries/repository/show-repository.ts` (edited), `src/queries/repository/list-repository.ts` (edited) — row type and SELECT collapse to `branch`; the three view refs derive via the renderers (§5–6).
- `src/services/git/index.ts` (edited) — `SeedHomeInput.branch` replaces the three fields (§7); `src/services/git/seed.ts` (edited) — `SeedHomeExtended` loses `publishRef`, every use renders from `input.branch` (§8).
- `src/commands/repository/register-repository.ts` (edited) — input collapses to `branch`; twelve-column INSERT with one bound value; `credentialRejected` payload keeps its `publishRef` key rendered via `publishRefOf`; `git_operation.ref` and `resolveRef` use `landingRefOf`; `repository.registered` carries `branch` (§9).
- `src/http/contract/repository.ts` (edited) — register request holds `branch: branchName` (`publishRef` regex leaves with the field); view keeps the three derived refs; view example `trackingRef` corrected to `refs/remotes/origin/main` per §10's pre-existing-drift note (§10).
- `src/http/contract/event-payload.ts` (edited) — `repository.registered` holds one `branch` key; `credentialRejected` untouched (§11).
- `src/http/server/repository/register-repository.ts` (edited) — handler forwards `branch: parsed.data.branch` only (§12).
- `src/cli/repository/register.ts` (edited) — `--branch <branch>` option, confirmation `flagName "--branch"` / question `"branch?"`, body carries `branch`, output line `kanthord: branch ${view.branch}` (§13); `src/cli/repository/show.ts` (edited) — same output line (§14).
- `src/http/contract/field-decisions.fixture.ts` (regenerated) — diff touches only `repository.*` rows; each new `branch` row sorts before its schema's `credential` row as §15 predicts (§15).
- `scripts/e2e/007/09-bare-home-seeding.e2e.ts` (edited) — three `seedHome` call sites collapse to `branch` so the e2e script typechecks against the new `SeedHomeInput` (`scripts/**` is SE lane).
- `docs/proposal/api/new-decisions.md` (edited) — the decision-log line "`repository.register` takes `--upstream <branch>`" now reads `--branch <branch>`. Not named by any Story section; kept under Ulrich's adjudication that proposal-doc changes are acceptable where the work requires them — it retires the same dangling reference class as Story 1's B3.

**Seam (GREEN).** Every consumer of the repository branch data — domain, storage, queries, git service, command, contract, handler, CLI — now reads the single `branch` field and renders `landingRef`/`trackingRef`/`publishRef` through the domain renderers whose identity (`landingRefOf === publishRefOf === headRefOf`) makes the one-branch invariant true by construction; the RED turn's 64 failures (missing module, missing renderer exports, `no column named branch`, `Unrecognized key "branch"`) all resolve against these shapes.

**Constraints audited.** `migration-0001-core-entities.ts`, `sqlite.ts`, `preflight.ts`: zero diff. `repository.reconcile` still `stubbed`/phase-2. No `z.enum` added. `publishOnApproval`/`hostFingerprint` untouched. `credentialRejected` keeps its `publishRef` key.

**Refactor.** none named by the Task.

**Build check.**

- typecheck: exit 0
- prettier --check over all 15 touched files: clean
- eslint over all 14 touched `src/` files: exit 0
- `node scripts/field-decisions-probe.mjs` (read-only): `fixture in sync: 657 rows`
- snake-case grep per §Verify reports 0 after excluding the two migration files

**OPEN — one Story Verify inspection contradicts the Story's own test spec.**

- O1 - status:OPEN - action:YES - §Verify grep #1 cannot report 0 - `grep -rl "upstreamBranch\|landingBranch" src test | wc -l` is **4**, every hit inside a TE-authored test file whose content the Story itself mandates verbatim: `register.test.ts:441` (test name "…neither landingBranch nor publishRef", §The CLI), `main.repository-branch.test.ts:116-117` (absence assertions, §The composed acceptance path), `register-repository.test.ts:553` (`"landingBranch" in seed` false, §The command), `domain/repository.test.ts:67` (zod-strip fixture, §The domain) - fix: scope the grep to production sources or accept the mandated literals, at gate time - why: reaching 0 requires editing TE-lane test files, which this role may not touch; the strings are assertions of absence, not survivors.

**Assumptions.**

- VERIFIED: all fifteen §Change sections match the Story's quoted code and line intents (audited file-by-file this turn, not assumed from the retry note).
- VERIFIED: fixture regeneration proven by the read-only probe, not trusted from the working tree.
- UNVERIFIED: suite green — running tests is the TE's gate; my end state is the conformant code plus clean typecheck/lint/format/probe.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — an objective clone creates its feature branch · Story 4 · whole-story RED

**Cycle.** Handoff gate first: the software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Prior GREEN for Story 3 confirmed after two TE-lane fixture repairs (below): Story 3's §Commands block → **352 pass / 0 fail, exit 0**. Story 3's O1 adjudicated (below). Advancing to Story 4 (`04-an-objective-clone-creates-its-feature-branch`) — RED for the whole story (its Verify section is the test spec; it has no sub-Tasks).

**Confirm-GREEN fallout repaired in my lane (flagged, not silent):**

- B5 - status:FIXED - action:YES - shared registry fixture vs the 0001-only database - collapsing `test/helpers/rows.ts` to twelve columns in the Story 3 RED turn broke all 24 `migration-0001-core-entities.test.ts` tests that seed through `buildMigrated` → `seedRegistry` (`Error: table repository has no column named branch`) - fix: `seedRegistry` now probes `PRAGMA table_info(repository)` for `upstream_branch` and inserts the fourteen-column legacy form when present, mirroring the file's own `seedGraph` precedent over `plan_revision.origin`; `migration-0001-core-entities.test.ts` stays byte-identical as the Story mandates - why: the Story's premise that every non-migration INSERT runs against the full chain is false for the 0001 test's use of the shared fixture.
- B6 - status:FIXED - action:YES - latent fixture bugs in my `migration-0009-one-branch.test.ts` surfaced once production let the file load - `insertRepository` re-inserted the provider row per repository (`UNIQUE constraint failed: provider.name`) and `seedProjectDependents` inserted `plan_revision` without the `origin NOT NULL` column migration 0006 adds - fix: provider insert moved into `buildMigratedThroughEight`; plan_revision insert gained `'import'` origin satisfying 0006's three CHECK clauses - why: at RED the file failed wholesale at import so no body ever ran; both are test-fixture repairs, zero production edits.
- O1 adjudication: Story 3 §Verify grep #1 reports **4** hits and grep #2 reports **1** hit after the Story's own exclusions — every one inside a TE-authored file whose literal the Story itself mandates (absence assertions, zod-strip fixture) or that must name old columns to serve a pre-0009 table (B5's probe). Scoped to non-test sources both greps report **0**. Per Ulrich's standing adjudication on mandated-content greps, accepted at gate time rather than rewriting mandated test literals; no ATTEMPT-FAILED raised.

**Test written.**

- file: `src/domain/repository.test.ts` (edited) — suite: `src/domain/repository.test` — methods added: `featureBranchOf renders feature over an objective node id`, `featureRefOf renders refs/heads/feature over an objective node id`, `featureRefOf is refs/heads wrapped around featureBranchOf`; imports gain the two renderers.
- file: `src/services/git/clone.test.ts` (edited) — suite: `src/services/git/clone.test` — all ten `cloneObjective` call sites gain `objectiveId: "objective_01JQ8Z4A2B"`; the landing-branch test rewritten as `the clone starts at the landing branch and works on the feature branch` (published path; rev-parse HEAD still c2; symbolic-ref equals `refs/heads/feature/objective_01JQ8Z4A2B`; `refs/heads/land` still exists at c2; `for-each-ref --format=%(refname) refs/heads` deep-equals the two heads, f before l); five new tests: `a feature branch name already in the source is refused`, `a clone on the wrong branch is refused before the rename`, `a detached HEAD is refused`, `the feature branch carries no upstream`, `the checkout runs before the remote is removed` (full ordered six-subcommand list asserted by deepEqual, not includes). Link-count isolation, hard-link control, no-remote and no-alternates tests keep every assertion.
- file: `src/services/git/binary.test.ts` (edited) — suite: `src/services/git/binary.test` — the `git.clone` recording input gains `objectiveId: "objective_01JQ8Z4A2B"`.
- One deviation inside a new test, forced by anti-pattern #3: `the feature branch carries no upstream` first asserts `rev-parse --verify refs/heads/feature/objective_01JQ8Z4A2B` succeeds before asserting `config --get branch.feature/<id>.remote` fails — without it the config assertion passes vacuously today (a missing branch also yields non-zero) and would prove nothing once the branch exists. The Story names only the config check.

**RED proof.**

- command: `node --test src/domain/repository.test.ts src/services/git/clone.test.ts src/services/git/binary.test.ts`
- exit: 1 — 7 failures, each sensitive. Verbatim: `SyntaxError: The requested module './repository.ts' does not provide an export named 'featureBranchOf'` (domain, file-level); rewritten test → `Expected values to be strictly equal: + 'refs/heads/land' - 'refs/heads/feature/objective_01JQ8Z4A2B'`; the two wrong-branch/detached refusal tests and the preexisting-name test → `AssertionError [ERR_ASSERTION]: null` (no rejection thrown yet); no-upstream → `fatal: Needed a single revision … 128 !== 0` (the existence precondition fires); order test → recorded list missing `'checkout -b'`. `binary.test` stays green — correct: pass-through shape, its coupling is type-level only.
- stub probe: appended the Story-declared `featureBranchOf`/`featureRefOf` exports to `src/domain/repository.ts` and `objectiveId: string` to `CloneInput` in `src/services/git/index.ts`, ran `npm run typecheck` — clean (exit 0) after it exposed one genuine error of mine (the dash-source call site had missed the member), fixed; both stubs then reverted byte-exact (shasums match pre-probe values a8ef2e9e… / ce5b472a…), leaving exactly 17 seam errors: 14 × TS2353 + binary TS2353 + 2 × TS2305, nothing else.

**Open to Software Engineer.**

- Seams the tests import: two string renderers exported from `src/domain/repository.ts` — `featureBranchOf(nodeId: string): string` rendering `` `feature/${nodeId}` `` and `featureRefOf(nodeId: string): string` rendering `` `refs/heads/feature/${nodeId}` `` (bodies quoted verbatim in the Story's §Change 1); and `CloneInput` in `src/services/git/index.ts` gaining required `objectiveId: string` (§Change 2). Implement Story 4 §Change 3's behaviour contract: `checkout -b <rendered feature branch>` runs immediately after the clone-failure check and before `remote remove origin`; after the promisor check and before the staging rename, `symbolic-ref --quiet HEAD` must equal the rendered fully-qualified ref, with the GitError messages the tests pin (`git checkout -b failed with code <n>…`, `the clone has no symbolic HEAD; git symbolic-ref exited <n>`, `the clone HEAD is <observed> and not <expected>`). `binary.ts` needs no change — pass-through.
- Constraints binding you: do not change the clone argument vector, the three existing isolation assertions or their order; checkout precedes remote removal; render via the renderers so no file outside `src/domain/repository.ts` writes the literal `feature/`; add no readable alias; never push `feature/*`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — an objective clone creates its feature branch · Story 4 · whole-story RED

**Cycle.** GREEN for `src/domain/repository.test.ts` + `src/services/git/{clone,binary}.test.ts` RED (7 failures).

**Files changed.**

- `src/domain/repository.ts` (edited) — appends `featureBranchOf(nodeId)` rendering `` `feature/${nodeId}` `` and `featureRefOf(nodeId)` rendering `` `refs/heads/feature/${nodeId}` `` beside the existing ref renderers (§Change 1 verbatim).
- `src/services/git/index.ts` (edited) — `CloneInput` gains required `objectiveId: string` (§Change 2).
- `src/services/git/clone.ts` (edited) — imports both renderers from `../../domain/repository.ts`; binds `const featureBranch = featureBranchOf(input.objectiveId)` as the first statement of the `try`; inserts the `checkout -b <featureBranch>` runner call with its `git checkout -b failed with code <n>` GitError immediately after the clone-failure check, before `remote remove origin`; inserts the `symbolic-ref --quiet HEAD` assertion (missing-head and wrong-head GitErrors, rendered against `featureRefOf`) after the promisor check, before `renameSync` (§Change 3 verbatim). The clone argument vector and the three isolation assertions are byte-identical.
- `src/services/git/binary.ts` — untouched per §Change 4; the pass-through carries the new member.

**Seam (GREEN).** Six of the seven RED failures resolve by construction against these shapes; the happy path was additionally verified live — a probe seeding the real EPIC 005 fixture via `test/helpers/remote/seed.ts`, writing `refs/heads/land` at c2, and running the real `cloneObjective` **resolved**, which proves `checkout -b` created the branch and the internal `symbolic-ref --quiet HEAD` assertion matched `refs/heads/feature/objective_01JQ8Z4A2B`.

**Refactor.** none named by the Task.

**Build check.**

- typecheck: exit 0
- eslint over the three touched files: exit 0
- prettier --check over the three touched files: clean
- grep: the literal `feature/` appears on exactly two non-test lines under `src/`, both renderers inside `src/domain/repository.ts`
- no `scripts/**` file constructs a `CloneInput`

**OPEN — one RED test asserts a git behaviour that does not exist.**

- B1 - status:OPEN - action:YES - `a feature branch name already in the source is refused` is unreachable under any conforming implementation - the test writes `refs/heads/feature/objective_01JQ8Z4A2B` into the SOURCE home, then expects `checkout -b` inside the fresh clone to fail with "git checkout -b failed with code". git does not do that: a standard clone copies every non-checked-out source head to `refs/remotes/origin/<name>` only, and `checkout -b <name>` refuses only a LOCAL `refs/heads/<name>`. Evidence: (1) raw-git scratch experiment → `Switched to a new branch 'feature/objective_X'`, exit 0; (2) the real-fixture probe above ran this exact scenario through the real production `cloneObjective` → outcome `resolved`, i.e. no rejection raised. Producing the pinned message would require fabricating a failure the checkout did not produce — test scaffolding inside production code. - fix: human picks one — (a) TE rewrites the test's precondition to wrap the runner so the `checkout` request answers non-zero (the file's own `answeringRemoteRunner` pattern), keeping the mechanism honest; (b) drop the test, since re-clone refusal is already covered by `an existing target refuses and leaves it unchanged`; (c) amend EPIC/Story to mandate a source-side ref pre-check as new production behaviour, which is a plan change I will then implement. - why: the test premise contradicts observed tool behaviour; the test file is TE-lane, and faking the error message in production is worse than surfacing the contradiction.
- All other tests in the three suites are green by construction: the wrong-branch and detached wrappers hit the two new GitErrors with the exact pinned messages (`the clone HEAD is refs/heads/land and not refs/heads/feature/objective_01JQ8Z4A2B`, `the clone has no symbolic HEAD; git symbolic-ref exited 1`); the ordered six-subcommand assertion matches the inserted call order (clone → checkout -b → remote remove → remote → config --get-regexp → symbolic-ref --quiet); the rewritten landing/feature test ran end-to-end green in the live probe.

**Assumptions.**

- VERIFIED: plain-git `checkout -b` succeeds when the branch name exists only as a remote-tracking ref in the source (scratch experiment + real-fixture probe, both quoted above).
- VERIFIED: the full happy path through the real `cloneObjective` resolves with the new symbolic-ref assertion active.
- UNVERIFIED: suite green — running tests is the TE's gate.

ATTEMPT-FAILED: 04-an-objective-clone-creates-its-feature-branch — one RED test (`a feature branch name already in the source is refused`) premises a git refusal that does not occur; all Story §Change edits landed conformant with typecheck/eslint/prettier clean

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**Cycle.** Handoff gate first: the software-engineer's last turn cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. Active dispute adjudicated (below); Story 4 confirmed GREEN — its §Commands block → **48 pass / 0 fail, exit 0**. The stories index states "Four stories cover the EPIC's seven story bullets"; all four are green, so no Task remains. Full EPIC Verification Gate run end-to-end this turn (below) and it passes.

**Dispute adjudication — Task `04-an-objective-clone-creates-its-feature-branch`: test rewritten (option a), not dropped.** Applied Ulrich's ruling to my own file. Rewrite chosen over drop because real, observable behaviour remains in the same scenario. `a feature branch name already in the source is refused` becomes `a feature name already on the source does not block the checkout` (`src/services/git/clone.test.ts`): the source home carries `refs/heads/feature/objective_01JQ8Z4A2B` at **c1** while `<branch>` tip is c2; the clone resolves; `symbolic-ref --quiet HEAD` equals the fully-qualified `refs/heads/feature/objective_01JQ8Z4A2B`; `rev-parse HEAD` still equals **c2** — proving the feature branch is created from the checked-out `<branch>` and not reset to the namesake's commit; local heads deep-equal exactly the expected two; staging left empty. This pins the mechanism the SE proved (the source head arrives only as a remote-tracking ref, so `checkout -b` legitimately creates the local head), keeps the EPIC non-goal "no change to clone isolation" intact, and keeps the gate's checked-out assertion binding. The refusal premise survives where it is real: target-side collision stays covered by `an existing target refuses and leaves it unchanged`.

**Confirm-GREEN fallout repaired in my lane (flagged, not silent):**

- B7 - status:FIXED - action:YES - four count pins outside every Story Verify list and the Proof's 27 files went red under the full suite - `app.test.ts` request-set pin 72→71, `dispatch.test.ts` stubbed-drive pin 26→25, `route.test.ts` proposal-matrix pins 74→73 and 70→69, `migration-0008-graph-indexes.test.ts` re-apply helper now builds an explicit eight-migration list so the second storage knowing only [1..8] no longer opens a database holding 0009 (`StorageError: … which this binary does not know`) - fix: repaired as anti-pattern #2 conformers of Stories 2–3; assertions keep their by-value shape - why: the EPIC gate runs `npm run verify`, which executes the whole suite, and these broke when the registry shrank and migration 0009 registered.
- B8 - status:FIXED - action:YES - `list-event.test.ts` "rejects sideways order with no error details" fails at the EPIC base ref too — pre-existing, not a defect of this epic - commit `9563779` ("name the failing property in every invalid-request", ancestor of base `b7154a6`) taught the handler to emit `details.refusal/issues` but missed this one stale assertion; nothing in the 029 diff touches the error path (verified: zero working-tree delta on `invalid-request.ts`/`list-event.ts`) - fix: rewrote the test in that commit's own convention (`details.refusal === "query-schema"`, issue paths deep-equal `["order"]`) and renamed it `rejects sideways order naming the order parameter` - why: the gate cannot pass while an assertion pins behaviour a shipped commit deliberately replaced.
- B9 - status:FIXED - action:YES - `eslint .` failed on two raw `INSERT INTO node` statements inside my new `migration-0009-one-branch.test.ts` (`no-restricted-syntax`: a node or edge write belongs in plan store) - fix: both rows now seed through `seedNode` from `test/helpers/rows.ts`; my constants mirror `fixtureIds` value-for-value (`provider_a`…`revision_a`, blob `sha256:0…0`), so seeded rows are byte-equivalent and all seven suite tests stay green - why: AGENTS.md reserves the exemption list for pre-existing fixtures; a new file seeds through the helper.

**EPIC verification gate.**

- Gates: `npm run verify` → **exit 0** — typecheck clean; full suite **5130 tests · 5130 pass · 0 fail**; `eslint .` clean; migrations through `0009-one-branch applied`; `kanthord: verify db status ok`.
- Proof: the EPIC's verbatim 27-file `node --test` block `&& echo "PASS EPIC-029"` → **exit 0** — **402 tests · 402 pass · 0 fail** — printing exactly:
  > PASS EPIC-029
- Contract publish: the `contract:publish` CLI refuses a dirty tree by design (release hygiene — it stamps the commit sha into `manifest.json`), and this cycle is local-uncommitted by definition. The gate's substance was verified by invoking the exported `publishContract({ outputDirectory: <mktemp>, commit: probe, tag: null })` against the working tree: exit 0, 64 files emitted; over every emitted file `"upstreamBranch"` → 0 hits, `"landingBranch"` → 0 hits, `landing_branch` → 0, `publish_ref` → 0; `"publishRef"` occurs only inside the three repository-view success examples beside `landingRef`/`trackingRef` (derived strings the EPIC keeps), and the `repository.register` request example carries `branch`, `publishOnApproval`, `hostFingerprint` and neither dropped key. After the human commits, the CLI form can be re-run verbatim.
- Hermetic coverage beyond the Proof, each gate bullet mapped: fresh database migrates 0001–0009 with the twelve-column list asserted by value, and both divergent-row refusals name the repository `ORDER BY name` picks while leaving schema and `migration` table untouched (`migration-0009-one-branch.test.ts`, in Proof); one daemon-backed registration over the EPIC 005 loopback fixture asserts through `repository.show` that the bare home's only local head is `refs/heads/<branch>` (`main.repository-branch.test.ts`, in Proof); the three refs are derived by exact string for a branch containing a slash (`show-repository.test.ts` plus the domain renderer identities, in Proof); the objective clone reports `feature/<node id>` checked out via `git symbolic-ref --quiet HEAD` against the fully-qualified ref with the object-file link count proving isolation (`clone.test.ts`, in Proof); the registry equals the proposal contract and `repository.landingBranch` appears nowhere (`parity.test.ts`, `registry.test.ts`, `path.test.ts`, in Proof); no wall clock, shared temporary directory or ambient git configuration anywhere (verify-green suite and pinned git environment confirm).

**Tasks closed.** 4 across 4 Stories — equals the total, with no Story outstanding or unexpanded (index.md: "Four stories cover the EPIC's seven story bullets").

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/repository.test.ts … src/main.repository-branch.test.ts && echo "PASS EPIC-029") — "PASS EPIC-029"
- stories: 4/4 complete
- date: 2026-08-23
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 1 action:NO finding(s) recorded for the human.
BLOCKER: B1 out-of-scope event assertion — src/http/server/event/list-event.test.ts rewrites an event-validation assertion unrelated to EPIC 029 (reviewer confirms it is a pre-existing defect per discussion lines 353-355); fix: revert that file to its base-ref state so every changed file traces to this EPIC (committing a prerequisite is the human's act, not this cycle's).
BLOCKER: B2 test scaffolding in production — src/services/git/seed.ts exposes failAfter/abort used only by tests (seed.test.ts, binary.test.ts); fix: remove failAfter, abort and their synthetic tests; inject real dependency failures through GitRunner instead.
INFO: B3 NEEDS-HUMAN contract-publish gate — `npm run contract:publish -- "$(mktemp -d)"` refuses a dirty tree by design; the gate's substance was verified by calling publishContract directly (64 files, zero dropped-field hits); after Ulrich commits, rerun the exact command.
BLOCKER: S1 (routed as blocker) impossible repository-view fixtures — src/cli/repository/show.test.ts and src/cli/reachability.test.ts pair branch "main" with non-derived refs; fix: set fixtures to refs/heads/main and refs/remotes/origin/main so response shapes stay producible.

## TEST-ENGINEER — post-review blockers · B1, B2 (test half), S1 repairs

**Cycle.** AUTO_REVIEW routed three action:YES findings back into the cycle. All three live in test-engineer-lane files; repaired this turn. B2's production half opens to the software-engineer below. No planned Task is active — this is review-blocker repair, not new coverage.

**Repairs.**

- B1 - status:FIXED - action:YES - out-of-scope event assertion - `src/http/server/event/list-event.test.ts` restored byte-exact to base ref `b7154a64912f313f08737702d932cdb5634e9843` (`git show <base>:<path> > <path>`; `git diff b7154a6 -- <path>` is empty) - fix: revert applied; every changed file now traces to this EPIC again - why: the reviewer confirmed the sideways-order rewrite is a pre-existing defect outside EPIC 029, and committing a prerequisite is the human's act, not this cycle's. Known consequence, verified empirically below: the stale base assertion fails again (`true !== false` at line 223) — exactly as it does at the base ref. **The pre-existing defect stays for a separate epic; it is not this cycle's to fix.**
- B2 - status:FIXED (test half) - action:YES - synthetic failure scaffolding pinned by tests - the two `failAfter`-driven tests replaced with GitRunner-injected equivalents or deleted, so `src/services/git/seed.ts` no longer has any test consumer of `failAfter`/`SeedStep` (grep: zero references outside that one file) - fix: software-engineer deletes the scaffolding (below); tests stay green through pure deletion - why: dependency failures must enter through the runner seam, never a production knob only tests flip.
  - `src/services/git/seed.test.ts` — `"a failure after the fetch leaves no visible home, only a staging directory"` split into two injected tests: `"a failed fetch leaves no visible home and no staging directory"` (wraps the real `createGitRunner`; the fetch request answers `code 128`, so the rejection is the production `GitError` whose message names `git fetch failed with code 128`; asserts no visible home and zero `.staging-*` leftovers — cleanup ran) and `"a crash before cleanup leaves exactly one staging directory behind"` (the former second half, byte-equivalent: throwing wrapper plus `chmod 0o500` proves a crash outside cleanup leaves exactly one staging directory). `seedInput` loses its `failAfter` override; the `SeedStep` import is gone.
  - `src/services/git/seed.test.ts` — `"failAfter rename rejects after the home is visible"` deleted. Its scenario is unreachable through any real seam: no runner call exists between `renameSync` and return, so no GitRunner wrapper can produce a failure at that point, and the surviving injected tests plus the refusal tests pin everything observable the old test covered.
  - `src/services/git/binary.test.ts` — `"failAfter reaches no production caller"` deleted together with its now-orphaned `readFileSync`, `readdirSync` and `fileURLToPath` imports: once the knob is gone the grep pins a string that exists nowhere, which is vacuously true forever.
- S1 - status:FIXED - action:YES - impossible repository-view fixtures - fixtures paired `branch: "main"` with refs no conforming implementation can derive - fix: `src/cli/repository/show.test.ts` view `publishRef` becomes `"refs/heads/main"` (stdout assertion line updated to match) and `src/cli/reachability.test.ts` repository fixture `landingRef` becomes `"refs/heads/main"`; both files' response shapes are now producible by `headRefOf`/`trackingRefOf`/`publishRefOf` over the named branch - why: a fixture a handler could never emit asserts nothing about shipped behaviour.

**Verification.**

- `node --test src/services/git/seed.test.ts src/services/git/binary.test.ts src/cli/repository/show.test.ts src/cli/reachability.test.ts` → exit 0 — **43 pass / 0 fail** (seed 17, binary 14, cli show 3, reachability 9).
- `node --test src/http/server/event/list-event.test.ts` → exit 1 — sole failure `✖ rejects sideways order with no error details … true !== false` at line 223, the verbatim base-ref failure signature; all other tests in the suite pass.
- `npm run typecheck` → exit 0.
- `npx eslint` over the five touched files → exit 0.
- `rg "failAfter|SeedStep" src scripts test` excluding `src/services/git/seed.ts` → no matches.

**Open to Software Engineer.**

- B2 production half, pure deletion in `src/services/git/seed.ts`: remove the exported `SeedStep` union, the `failAfter?: SeedStep` member of `SeedHomeExtended`, and the local `abort` helper with its nine call sites. Nothing else in the file changes; no other production file is involved (grep above). My rewritten tests must stay untouched and stay green.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — post-review blocker B2 · production half

**Review blocker addressed.** BLOCKER: B2 test scaffolding in production — src/services/git/seed.ts exposes failAfter/abort used only by tests (seed.test.ts, binary.test.ts); fix: remove failAfter, abort and their synthetic tests; inject real dependency failures through GitRunner instead. (Test half already landed in your previous turn; this turn removes the production scaffolding.)

**Files changed.**

- `src/services/git/seed.ts` (edited) — deleted the exported `SeedStep` nine-member union, the `failAfter?: SeedStep` member of `SeedHomeExtended`, and the local `abort` helper with all nine call sites (`host-key`, `init`, `remote-add`, `refspec`, `fetch`, `read-upstream`, `preflight`, `landing`, `rename`). No other line changed; `SeedHomeResult`, `SeedHomeExtended` (minus the knob), `stagingPathFor` and `seedHome` keep their shapes.

**Seam (GREEN).** Pure deletion with no behaviour change on any conforming path: `failAfter` had no production writer, so every `abort(...)` call evaluated a comparison against `undefined` and fell through; the step sequence, guard order and error messages are byte-identical.

**Refactor.** none named — this turn IS the named blocker fix; nothing beyond it.

**Build check.**

- typecheck: exit 0
- eslint over `src/services/git/seed.ts`: exit 0
- prettier --check over `src/services/git/seed.ts`: clean ("All matched files use Prettier code style!")
- `rg "failAfter|SeedStep|seed aborted after" src/services/git/seed.ts` → no matches

**Assumptions.**

- VERIFIED: zero references to `SeedStep` or `failAfter` anywhere outside that one file — grep over `src/`, `scripts/`, `test/` matches your own (`rg … excluding seed.ts → no matches`); your rewritten GitRunner-injected tests import only `seedHome`, `stagingPathFor` and `type SeedHomeExtended`, all retained, so they stay green through pure deletion.
- UNVERIFIED: suite re-run — running tests is your gate.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — post-review re-verification · Gates blocked by the B1-mandated revert

**Cycle.** Handoff verification gate first: the software-engineer's last turn (B2 production half) cites `typecheck: exit 0`; `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`, exit 0. B1 revert confirmed byte-exact (`git diff b7154a6 -- src/http/server/event/list-event.test.ts` is empty; `seed.ts`'s delta vs base is the B2 deletion alone). Post-fix suites confirmed green: seed + binary + cli show + reachability → **43 pass / 0 fail**. `list-event.test.ts` at its mandated base state → 34 pass / 1 fail, the known pre-existing assertion. Full EPIC Verification Gate then ran end-to-end: the Proof passes, the Gates command exits 1 on that one out-of-epic test. Not green → no IMPLEMENTATION_READY_FOR_REVIEW this turn; escalating to Ulrich below.

**Verification result.**

- Gates: `npm run verify` → **exit 1** — typecheck clean; full suite **5129 tests · 5128 pass · 1 fail**; the `&&` chain stopped before lint and db-status. Verbatim failure:
  > test at src/http/server/event/list-event.test.ts:217:3
  > ✖ rejects sideways order with no error details (2.748541ms)
  > AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  > true !== false
  > at TestContext.<anonymous> (…/src/http/server/event/list-event.test.ts:223:12)
- Decomposed chain stages, each green independently: `npm run lint` (`eslint .`) → exit 0; `node scripts/verify-db-status.ts` → `kanthord: verify db status ok`, exit 0.
- Proof: the EPIC's verbatim 27-file `node --test` block `&& echo "PASS EPIC-029"` → **exit 0** — **401 tests · 401 pass · 0 fail** — printing exactly:
  > PASS EPIC-029

**Deadlock, not a repairable failure.** The reviewer's B1 ruling orders `list-event.test.ts` held byte-exact at base ref `b7154a6`, and the same review confirmed the sideways-order rewrite was a pre-existing defect outside EPIC 029 (B8: commit `9563779` taught the handler to emit `details.refusal`/`issues` and missed this one stale assertion). At base state that assertion is red — provably so without any experiment: the working-tree copy is byte-identical to base and fails today with `true !== false`. Two binding directives therefore cannot both hold: the gate bullet "`npm run verify` is clean" versus the blocker "this file stays at base". Re-applying the rewrite violates B1; editing the file in any other form is the same violation; weakening or skipping the assertion is barred outright. Only the human can resolve this.

**OPEN:** EPIC-029 gate vs AUTO_REVIEW B1 — `npm run verify` can never report clean while `src/http/server/event/list-event.test.ts` sits at base ref `b7154a6`, because that exact content fails its own stale assertion (`rejects sideways order with no error details`, `true !== false` at line 223), a defect commit `9563779` introduced and every later epic inherited. Human options:

- (a) commit a prerequisite repair of that one assertion as its own commit before reviewing this epic — the B8 rewrite pins `details.refusal === "query-schema"` with issue paths deep-equal `["order"]` — after which `npm run verify` goes green and this cycle emits IMPLEMENTATION_READY_FOR_REVIEW unchanged;
- (b) waive the full-suite bullet of this EPIC's gate, taking the Proof (which excludes that file) plus the decomposed stages (typecheck/lint/db-status all exit 0) as the gate of record;
- (c) overturn B1 and let the rewrite ride inside this epic's diff.

Everything else is done: all four Story Tasks remain implemented and green; the sole red among 5129 tests is this one out-of-epic line. The INFO finding (contract-publish CLI refusing a dirty tree) stays recorded for the human; nothing in the B2 deletion is an input to publishContract, so the prior substance check (64 files emitted, zero dropped-field hits) stands unrepeated.

ATTEMPT-FAILED: post-review-gate — `npm run verify` exit 1 on the B1-reintroduced pre-existing list-event assertion (`true !== false` at list-event.test.ts:223); Proof green (401/401, "PASS EPIC-029"), all four Story Tasks remain green

END: TEST-ENGINEER

## TEST-ENGINEER — post-review · amended B1 scope exception applied · ready for review

**Cycle.** Ulrich's AMENDED B1 RULING adjudicates the deadlock my last turn escalated: B1's classification stands, its revert remedy does not, because the review base itself is defective at `src/http/server/event/list-event.test.ts` — commit `9563779` deliberately changed invalid-request handler behaviour, updated sibling assertions, and missed this one stale assertion, so base content asserts `true !== false`. The ruling converts B1 into a documented scope exception authorizing exactly one narrow carry-over repair; this turn applies it, re-runs the full Verification Gate, and closes the cycle.

**Scope exception — carried for HUMAN_REVIEW adjudication.** The single edit below is an out-of-scope correction riding inside EPIC 029's diff by explicit operator authorization, not planned coverage of this EPIC. Origin of the defect it repairs: commit `9563779e3331ba6980d6c5092ae6312d840ee01c` ("name the failing property in every invalid-request"), which taught the handler to emit `details.refusal`/`issues` and updated sibling tests but left this assertion stale. The human retains full authority to accept, isolate into a prerequisite commit post-hoc, or reject at review; nothing in this cycle decides that. The EPIC diff carries zero production delta on `invalid-request.ts`/`list-event.ts`.

**Repair applied (the one authorized change, nothing more).**

- B1(amended) - status:FIXED - action:YES - stale invalid-request assertion at base ref - `src/http/server/event/list-event.test.ts`: test renamed `rejects sideways order with no error details` → `rejects sideways order naming the order parameter`; body now asserts `response.body.error.details.refusal === "query-schema"` and issue paths deep-equal `["order"]`, in exactly the shape that passed during the first ready-marker run - fix: applied as ruled - why: the base content contradicts shipped handler behaviour from `9563779`; the gate cannot pass while it stands.
- Delta audit: `git diff b7154a6 -- src/http/server/event/list-event.test.ts` shows exactly one hunk, +8/-2, that one test — no other file touched this turn.
- Suite proof: `node --test src/http/server/event/list-event.test.ts` → **35 pass / 0 fail**, exit 0.

**EPIC verification gate.**

- Gates: `npm run verify` → **exit 0** — typecheck clean; full suite **5129 tests · 5129 pass · 0 fail**; `eslint .` clean; migrations through `0009-one-branch applied`; `kanthord: verify db status ok`.
- Proof: the EPIC's verbatim 27-file `node --test` block `&& echo "PASS EPIC-029"` → **exit 0** — **401 tests · 401 pass · 0 fail** — printing exactly:
  > PASS EPIC-029
- Contract publish: the `contract:publish` CLI again refuses a dirty tree by design (`dirty-tree`, exit 2 — release hygiene; it stamps the commit sha into `manifest.json`, and this cycle is local-uncommitted). The gate's substance re-verified against the current working tree via direct `publishContract({ outputDirectory: <mktemp>, commit: probe, tag: null })`: exit 0, **64 files emitted**; over every emitted file `"upstreamBranch"` → 0 hits, `"landingBranch"` → 0, `landing_branch` → 0, `publish_ref` → 0. Residual `"publishRef"` occurrences are exactly two kept shapes: the repository-view derived string beside `landingRef`/`trackingRef` in view schemas/examples (`repository.list.json` sample: `"publishRef": "refs/heads/main"`), and the required `repository.register.credentialRejected` event-payload key the Story explicitly preserves. After the human commits, the CLI form can be re-run verbatim.
- Hermetic coverage beyond the Proof: unchanged from the first ready-marker run and re-proven green inside today's gates — fresh database migrates 0001–0009 with the twelve-column list asserted by value and both divergent-row refusals naming the repository `ORDER BY name` picks (`migration-0009-one-branch.test.ts`, in Proof); one daemon-backed registration over the EPIC 005 loopback fixture asserting through `repository.show` that the bare home's only local head is `refs/heads/<branch>` (`main.repository-branch.test.ts`, in Proof); the three refs derived by exact string for a branch containing a slash (`show-repository.test.ts` plus the renderer identities, in Proof); the objective clone reporting `feature/<node id>` checked out via `git symbolic-ref --quiet HEAD` with the object-file link count proving isolation (`clone.test.ts`, in Proof); registry equals proposal contract with `repository.landingBranch` nowhere (`parity.test.ts`, `registry.test.ts`, `path.test.ts`, in Proof); no wall clock, shared temporary directory or ambient git configuration anywhere.

**Tasks closed.** 4 across 4 Stories — equals the total, with no Story outstanding or unexpanded (stories index: "Four stories cover the EPIC's seven story bullets"). Review blockers B1 (per amended ruling), B2 (both halves) and S1 all repaired and verified above; INFO finding on the dirty-tree publish refusal stays recorded for the human.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (node --test src/domain/repository.test.ts … src/main.repository-branch.test.ts && echo "PASS EPIC-029") — "PASS EPIC-029"
- stories: 4/4 complete
- date: 2026-08-23
- state: local-uncommitted

END: TEST-ENGINEER
