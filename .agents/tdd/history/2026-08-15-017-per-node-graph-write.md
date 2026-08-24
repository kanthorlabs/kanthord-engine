---
epic: .agents/plan/epics/017-per-node-graph-write.md
opened: 2026-08-15
opener: test-engineer
base-ref: c77a57e6adbe353648d15d2e554f749c545c91cb
---

# Implementation cycle — 017-per-node-graph-write

Pulled from EPIC: `.agents/plan/epics/017-per-node-graph-write.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/node-write-legality.test.ts \
>   src/domain/layout.test.ts \
>   src/domain/plan-candidate.test.ts \
>   src/domain/plan-choice.test.ts \
>   src/domain/plan-validate.test.ts \
>   src/services/storage/migration-0002-graph-and-plan.test.ts \
>   src/services/storage/migration-0006-revision-origin.test.ts \
>   src/services/revision/node-write.test.ts \
>   src/services/plan/sqlite.test.ts \
>   src/commands/node/create-node.test.ts \
>   src/commands/node/update-node.test.ts \
>   src/commands/node/delete-node.test.ts \
>   src/commands/plan/import-plan.test.ts \
>   src/commands/project/replace-project-repositories.test.ts \
>   src/queries/plan/export-plan.test.ts \
>   src/queries/plan/validate-plan.test.ts \
>   src/queries/plan/list-revision.test.ts \
>   src/http/contract/*.test.ts \
>   src/http/server/node/create-node.test.ts \
>   src/http/server/node/update-node.test.ts \
>   src/http/server/node/delete-node.test.ts \
>   src/cli/node/create.test.ts \
>   src/cli/node/update.test.ts \
>   src/cli/node/delete.test.ts \
>   src/main.node-write.test.ts \
>   && echo "PASS EPIC-017"
> ```
>
> Every file this epic creates is named explicitly, and no directory glob stands in for one. `node --test` exits non-zero on an absent path, so the Proof fails before the epic is built. `src/http/contract/*.test.ts` is a glob because this epic edits files that already exist in it, `registry.test.ts` and `parity.test.ts` included. `src/domain/layout.test.ts` is present because this epic edits its capability list.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 017-per-node-graph-write · Story 1 proposal amendment (RED)

**Cycle.** RED for Story 1 (`src/http/contract/proposal-amendment.test.ts`, new). Dispatch order `01 → 02+03 → …` per `index.md:8`; Story 1 first because `src/http/contract/parity.test.ts` reads the route matrix.
**Test written.**

- file: `src/http/contract/proposal-amendment.test.ts` (new) — suite `src/http/contract/proposal-amendment.test` — methods:
  - `the routes table holds the three node operations` — `readRouteMatrix` yields `node.create` `POST /v1/project/:id/node`, `node.update` `POST /v1/node/:id/update`, `node.delete` `POST /v1/node/:id/delete`, each `phase-1`/`routed`, each row citing `013-external-drive-overview.md` as source;
  - `graph.md gains one section per node route` — the three `## \`node.<verb>\`` headings;
  - `the paragraph states the two concurrency classes and the refusal sets` — the exact three-fact paragraph after the sections, whitespace-insensitively;
  - `state-machine.md line 47 carries the amended completeness sentence` — the exact EPIC-017 sentence (intended pass: EPIC 014 already landed it — characterization pin, passes today);
  - `plan-format.md line 135 names the structurally valid baseline` — the new line present, the old `always valid` wording absent;
  - `the precondition table carries fromRevision for the three node operations` — one `| \`node.<verb>\` | \`fromRevision\` |` row each;
  - `binding-in-use widens to removals, containment moves and deletes` — the new README.md:178 text present, the old narrow text absent;
  - `plan_revision.md normalizes to the revision-origin DDL` — `proposalStatements("plan_revision")` deep-equals the Story-2 statement-4 DDL, whitespace-collapsed;
  - `migration.md lists six migrations including 0006-revision-origin` — rows 1-6 in the example fence, `0006-revision-origin` named exactly once, `Six rows appear` and `prints these six versions` present, the five-row prose absent.
- asserts: the Story-1 proposal-amendment contract — the route rows, the sections, the three-fact paragraph, the two amended sentences, the precondition rows, the widened `binding-in-use`, the plan_revision fence and the migration list.
  **RED proof.**
- command: `node --test src/http/contract/proposal-amendment.test.ts`
- exit: non-zero — 8 failing, 1 passing; failures: `AssertionError: missing route row for node.create`; `AssertionError: missing section for node.create`; `AssertionError: the paragraph after the three sections states the three facts`; the plan-format deep-equal diff (`+ '…baseline is always valid, so the procedure terminates.' - '…always structurally valid…'`); `AssertionError: missing precondition row for node.create`; `AssertionError [ERR_ASSERTION]: …` on the new binding-in-use text; the plan_revision deep-equal diff (`+ '…import_id TEXT NOT NULL, submitted_blob TEXT NOT NULL…' - '…origin TEXT NOT NULL CHECK (origin IN (''import'', ''node-write''))…'`); `AssertionError: missing row for version 6`. The one pass is the state-machine characterization pin — intended, since EPIC 014 already landed line 47's exact text.
- stub probe: not needed — the file imports only `node:fs`, `node:path`, `node:test`, `node:assert/strict` and `test/helpers/proposal.ts`; `npm run typecheck` exits 0.
- expected red elsewhere: `src/http/contract/parity.test.ts` turns red the moment Story 1 lands (comparable 59→62, total 63→66, `missingFromRegistry` lists the three ops) and stays red until Story 13's contract rows — recorded per Story 1's Verify; the test is not weakened and I did not edit it.
  **Open to Software Engineer.**
- `docs/proposal/api/graph.md` — three Routes-table rows after `edge.list` (source `013-external-drive-overview.md:23`), three sections in the `plan.import` shape, and the one paragraph stating the two concurrency classes, the structural-only refusal set and the reported completeness set; `docs/proposal/phase-1/plan-format.md:135` — the `structurally valid` line; `docs/proposal/api/README.md` — three precondition rows each carrying `fromRevision`, and the widened `binding-in-use` cell at `:178`; `docs/proposal/database/plan_revision.md` — the amended sql fence that normalizes to Story 2's statement-4 DDL; `docs/proposal/database/migration.md` — the `0006-revision-origin` row and the six-row prose. `docs/proposal/phase-1/state-machine.md:47` already reads the target text — change nothing. (`docs/proposal/*` is the software-engineer lane per `scripts/lane-check.sh`; this story carries no `src/` seam.)

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 1 proposal amendment (GREEN)

**Cycle.** GREEN for `src/http/contract/proposal-amendment.test.ts`.
**Files changed.**

- `docs/proposal/api/graph.md` (edited) — three Routes-table rows after `edge.list`, sourced `013-external-drive-overview.md:23` in the plain-text style of neighbouring rows; three `## \`node.<verb>\``sections in the`plan.import`shape (create/update/delete, each naming request fields, response fields carrying`revision`+`completeness`, delete adds `deleted`, and the declared error codes); the three-fact paragraph after the sections.
- `docs/proposal/api/README.md` (edited) — three precondition rows `node.create` / `node.update` / `node.delete`, each token `` `fromRevision` ``, after the `plan.import` row; `binding-in-use` description cell replaced with the widened text.
- `docs/proposal/phase-1/plan-format.md` (edited) — line 135: "always valid" → "always structurally valid".
- `docs/proposal/database/plan_revision.md` (edited) — the `sql` fence replaced with the migration-0006 DDL (origin column, nullable import fields, three explicit CHECKs, `STRICT`), keeping `-- ` comments and column alignment.
- `docs/proposal/database/migration.md` (edited) — example fence gains row `6 0006-revision-origin`, prose "Five rows appear"/"prints these five versions" → "Six rows appear"/"prints these six versions".
  **Seam (GREEN).** The test reads `readRouteMatrix` and the doc fences/prose; the route rows normalize to the five-cell shape the helper parses, and the `plan_revision` fence normalizes, through `proposalStatements`, to the exact statement-4 DDL the test names.
  **Refactor.** none named in Story 1 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- Story-1 Verify greps: `is always valid, so the procedure terminates` → 0; `0006-revision-origin` in migration.md → 1; `node.create` in graph.md → 2; five-row prose → 0.
  **Assumptions.**
- VERIFIED: `state-machine.md:47` already reads the exact EPIC-017 sentence (EPIC 014 landed it) — changed nothing, per the Story's own instruction.
- VERIFIED: the route rows must combine method and path in one cell (`POST /v1/project/:id/node`), because `readRouteMatrix` at `test/helpers/proposal.ts:75` splits the second cell on a space; the Story's schematic five-cell fence is not the literal format.
- The Story-1 Verify line "npm run verify exits 0 only after Story 12 lands" holds — `parity.test.ts` is expected red until the registry rows land; recorded, not weakened.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Stories 2+3 migration 0006 and migration parity (RED, coupled pair)

**Cycle.** Confirm GREEN for Story 1, then RED for the coupled pair Task 2 (`src/services/storage/migration-0006-revision-origin.test.ts`, new) and Task 3 (`src/services/storage/migration-0002-graph-and-plan.test.ts`, `migration-0001-core-entities.test.ts`, `migration-0003-execution-and-journal.test.ts`, `migration-0004-event-indexes.test.ts` — edited). Per `index.md:11` the pair shares one turn with no verify gate between them, and every Task-3 change is test-side, so all of it lands here; the software-engineer implements Task 2 only.
**Confirm GREEN (Story 1).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; `node --test src/http/contract/proposal-amendment.test.ts` → fail 0. Story 1 is green.
  **Test written.**
- file: `src/services/storage/migration-0006-revision-origin.test.ts` (new) — suite `src/services/storage/migration-0006-revision-origin.test` — methods: `migration0006RevisionOrigin carries version 6, its name and rebuild`; `statements hold the rename, create, copy and drop in order, and no pragma`; `migrations holds six entries, versions 1 to 6 with the six names in order`; `the rebuild applies on a version-5 database and copies every row`; `a failed rebuild leaves the database at version 5 with the original table and both pragmas restored`; `a node-write row carrying any import-only column is refused`; `an import row omitting any import-only column is refused`; `an origin outside the two values is refused`; `an accepted_blob of NULL is refused under both origins`; `two node-write rows under one project both insert`; `the CREATE TABLE statement equals the plan_revision proposal fence`.
- file: `src/services/storage/migration-0002-graph-and-plan.test.ts` (edited) — `historicalPlanRevisionStatement` constant holding the version-2 DDL literal; parity assertion now `[historicalPlanRevisionStatement, ...["node", "edge"].flatMap(proposalStatements)]` with the Story-3 title; registry pin deep-equals all six constants with the six-name title.
- file: `src/services/storage/migration-0001-core-entities.test.ts` (edited) — registry pin → six constants, title names six.
- file: `src/services/storage/migration-0003-execution-and-journal.test.ts` (edited) — pin → six constants, versions `[1..6]`, title names six.
- file: `src/services/storage/migration-0004-event-indexes.test.ts` (edited) — versions `[1..6]` and six names, title "migrations holds six entries, versions 1 to 6 in order".
- asserts: the corrected rebuild contract — four statements (rename, create, copy, drop) with no pragma and `rebuild: true`; the runner restores `legacy_alter_table = 0` and `foreign_keys = 1` on success and on failure; a version-5 database with two revisions and referencing nodes migrates losslessly with byte-identical `node` schema text and a clean `PRAGMA foreign_key_check`; a rollback leaves version 5, the original table, the nodes and no `plan_revision_old`; the six per-column CHECK refusals, the origin refusal, the NULL `accepted_blob` refusal under both origins, and two `node-write` rows coexisting under one project; the single `CREATE TABLE` statement equals `proposalStatements("plan_revision")`.
  **RED proof.**
- command: `node --test src/services/storage/migration-0001-core-entities.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0006-revision-origin.test.ts`
- exit: 1 — fail 5, pass 8; failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../migration-0006-revision-origin.ts'` on the four files that import the seam, and `AssertionError` on `migrations holds six entries, versions 1 to 6 in order` (versions `[1, 2, 3, 4, 5]` vs `[1, 2, 3, 4, 5, 6]`) in the 0004 file that maps only.
- command: `npm run typecheck` — exit 2; every error is `TS2307: Cannot find module './migration-0006-revision-origin.ts'` in the four test files that import it.
- stub probe: `src/services/storage/migration-0006-revision-origin.ts` — 2 errors found in `migration-0006-revision-origin.test.ts`, fixed: a local `after` variable shadowed the `node:test` hook import (renamed to `afterRows`), and `satisfies Migration` excess-checks the new `rebuild` member (annotation dropped, object stays structurally assignable); the `historicalPlanRevisionStatement` literal was verified exact against `graphAndPlan.statements[0]` before the stub was deleted. Stub deleted before handoff; typecheck with the stub in place was exit 0.
- **Spec note — the story file is stale; the EPIC is authoritative.** `02-migration-0006-revision-origin.md` still holds the seven-statement in-transaction pragma recipe (`defer_foreign_keys`/`legacy_alter_table` inside `statements`), which commit `285c653` superseded after a spike: while `foreign_keys` is ON, `ALTER TABLE ... RENAME` rewrites every child `REFERENCES` clause even under `legacy_alter_table = ON`, so `node.revision` would name `plan_revision_old`. The EPIC (`017-per-node-graph-write.md:63-65`) and EPIC 018's story `03-migration-0007-external-execution.md:16-43` settle the corrected mechanism: `Migration` gains `rebuild?: true`, the **runner** sets `PRAGMA foreign_keys = OFF` then `PRAGMA legacy_alter_table = ON` before `BEGIN IMMEDIATE` and restores `PRAGMA legacy_alter_table = OFF` then `PRAGMA foreign_keys = ON` in a `finally`, and migration 0006's `statements` hold the four statements and no pragma. I verified both recipes against `node:sqlite` on 3.53: recipe B (story file) fails the drop with `FOREIGN KEY constraint failed`; recipe A (EPIC) leaves the node schema byte-identical. The tests assert recipe A.
  **Open to Software Engineer.**
- `src/services/storage/migration-0006-revision-origin.ts` — exports `migration0006RevisionOrigin` with `version: 6`, `name: "0006-revision-origin"`, `rebuild: true`, and the four statements in this order: `ALTER TABLE plan_revision RENAME TO plan_revision_old`; the `CREATE TABLE plan_revision` DDL of Story 2's statement 4, verbatim; the `INSERT INTO plan_revision ... SELECT ... FROM plan_revision_old` copy; `DROP TABLE plan_revision_old`. No pragma in the list.
- `src/services/storage/migration.ts` — `Migration` gains one optional member, `rebuild?: true`.
- `src/services/storage/sqlite.ts` — the per-migration `runInTransaction` call honors `rebuild === true`: both pragmas set before `BEGIN IMMEDIATE`, both restored in a `finally`; a migration with no `rebuild` member takes today's path byte for byte (per EPIC 018 story 03, "whichever epic lands first ships the runner change" — this one is first).
- `src/services/storage/migrations.ts` — append `migration0006RevisionOrigin` after `migration0005Actor`.
- Do not touch `docs/proposal/database/plan_revision.md` (Story 1 owns it; the CREATE statement is asserted against it) and none of the five test files (Task 3 is entirely test-side and already landed in this turn). Per `03-migration-parity.md:83`, confirm by hand once that a one-character edit to the fence turns the 0006 test red and leaves the 0002 test green, revert it, and record the confirmation in the commit message.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Stories 2+3 migration 0006 and parity (GREEN, blocked on a test-side type error)

**Cycle.** GREEN for the coupled pair Task 2 + Task 3 (production side of Task 2; Task 3 is entirely test-side and landed in the TE turn).
**Files changed.**

- `src/services/storage/migration.ts` (edited) — `Migration` gains `rebuild?: true`, exactly as the EPIC (`017-per-node-graph-write.md:65`) and the TE instruction name it.
- `src/services/storage/migration-0006-revision-origin.ts` (new) — `migration0006RevisionOrigin`, `version: 6`, `name: "0006-revision-origin"`, `rebuild: true`, four statements in order: `ALTER TABLE plan_revision RENAME TO plan_revision_old`, the `CREATE TABLE plan_revision` DDL (origin column between `parent_id` and `import_id`, nullable import columns, `UNIQUE (project_id, import_id)`, three per-column CHECKs, `STRICT`), the `INSERT … SELECT …, 'import', … FROM plan_revision_old` copy, `DROP TABLE plan_revision_old`. No pragma in the list.
- `src/services/storage/sqlite.ts` (edited) — `migrate()` honours `rebuild === true`: `PRAGMA foreign_keys = OFF` then `PRAGMA legacy_alter_table = ON` before `runInTransaction` (`BEGIN IMMEDIATE`), both restored (`legacy_alter_table = OFF` then `foreign_keys = ON`) in a `finally`. Non-rebuild migrations take today's path byte for byte.
- `src/services/storage/migrations.ts` (edited) — `migration0006RevisionOrigin` imported and appended after `migration0005Actor`.

**Seam (GREEN).** The test imports `migration0006RevisionOrigin`, `migrations` and `SqliteStorage`; the runner change makes the version-5 → 6 rebuild lossless (the rename no longer rewrites `node.revision` to `plan_revision_old`, because `foreign_keys = OFF` precedes it), and the `finally` restore is what the two pragma-value assertions (success and injected-failure paths) read.
**Blocked — `OPEN:`.**

- `src/services/storage/migration-0006-revision-origin.test.ts:314-330` — the injected `failing` const is unannotated, so `rebuild: true` widens to `boolean`, and `migrations: [...VERSION_FIVE, failing]` is not assignable to `readonly Migration[]` under the spec-mandated `rebuild?: true` (TS2322 at `:330,20` and `:330,37`). This is the only typecheck error in the repository. Fix, in the TE's lane: annotate the const `const failing: Migration = { … }` (`Migration` is already imported as a type at line 18 of that file) — the contextual type keeps `rebuild` the literal `true`; `as const` also works. I will not weaken `rebuild?: true` to `boolean`: the EPIC and the TE instruction both declare the literal type, and `rebuild: false` would silently disable the pragma path.
  **Refactor.** none named in the coupled pair (`03-migration-parity.md` carries no `Action — REFACTOR:`).
  **Build check.**
- typecheck: exit 2 — two TS2322 errors, both in the TE's `migration-0006-revision-origin.test.ts:330` only; every `src/services/storage/*.ts` change typechecks clean.
- static DDL↔fence equivalence (the assertion the 0006 test's last method makes, checked without running the test): `fence parts: 1 mine parts: 1 equal: true` against `docs/proposal/database/plan_revision.md`.
- the one-character-fence probe the TE asked me to "confirm by hand" is a test execution, which is the TE's sole gate — deferred to the TE's confirm-GREEN turn (the 0006 test's CREATE assertion reads the fence; the 0002 test compares its own historical literal, so it cannot go red).

ATTEMPT-FAILED: Task 2+3 — the RED turn's `failing` const widens `rebuild: true` to `boolean`, which `Migration.rebuild?: true` (spec-mandated) rejects; the one-line fix is in the TE's test file, raised OPEN above.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Stories 2+3 confirmed GREEN, Story 4 store-origin RED

**Cycle.** Confirm GREEN for the coupled pair Task 2+3 (`src/services/storage/migration-0006-revision-origin.test.ts`, `migration-0002-graph-and-plan.test.ts`), then RED for Task 4 (`src/services/plan/sqlite.test.ts`, `src/queries/plan/list-revision.test.ts`).
**Confirm GREEN (Stories 2+3).**

- command: `node --test src/services/storage/migration-0001-core-entities.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0006-revision-origin.test.ts` → pass 112, fail 0; `npm run typecheck` → exit 0.
- Test-side fixes landed this turn (all mine): the `failing: Migration` annotation the SE's `OPEN:` named (`rebuild` widened to `boolean`); the `readCopyColumns` prototype mismatch in the rebuild deep-equal (node:sqlite rows are `[Object: null prototype]`); the missing `seedRegistry` before the two-node-write insert (FK on `project`/`blob`); and `test/helpers/rows.ts` `seedGraph` now writes `origin = 'import'` when `PRAGMA table_info(plan_revision)` reports the column — it serves version-2, version-5 and version-6 databases from one insert.
- Fence-sensitivity probe (the SE deferred it here): one-character edit to `docs/proposal/database/plan_revision.md` (`node-write` → `node-writes`) → 0006 suite 1 fail, 0002 suite green; reverted → 0006 suite green again. The 0006 CREATE assertion is live and the 0002 historical literal is independent.
  **Test written.**
- file: `src/services/plan/sqlite.test.ts` (edited) — suite `src/services/plan/sqlite.test` — methods: `insertRevision writes an import revision with every provenance column`; `insertRevision writes a node-write revision with three null provenance columns`; `findByImportId never returns a node-write revision`; `newestRevision returns a node-write revision minted after an import revision`; `mutateGraph deletes a node`; `mutateGraph deletes edges before it deletes nodes`; `mutateGraph applies nodeDeletes in the given order` (two independent fixtures, child-first succeeds and parent-first throws on the `node.parent_id` foreign key); `mutateGraph applies readiness after the deletes` (surviving node promoted `pending → ready`, `readiness-promoted`); `MutateGraphInput declares no trigger member` (the old compile probe extended with the source scan that slices `export type MutateGraphInput` to the next `};` and asserts the slice holds `nodeDeletes` and no `trigger` — the EPIC 016 assertion stays, renamed to the Story-4 Verify name).
- asserts: `insertRevision` persists the origin and the three nullable provenance columns read-back through `listRevisions` field by field; a `node-write` row is never a `findByImportId` hit; `newestRevision` prefers the later-minted `node-write` row; `nodeDeletes` removes rows, runs after the edge deletes, applies the given order, and precedes the readiness pass.
- compat edits, all in my lane, so the SE's handoff typecheck stays clean: `origin: "import"` on the six store `insertRevision` call sites (export-plan.test.ts:208, validate-plan.test.ts:552, list-revision.test.ts:49/:104, sqlite.test.ts both sites of `insertRevision writes every column…`) plus `origin: "import"` in the three revision-record deepEquals (listRevisions, findByImportId ×2); `origin, 'import'` on six raw-SQL `plan_revision` inserts against the version-6 schema (`test/helpers/recovery.ts`, recover-expired-leases.test.ts, read-project-status.test.ts, remove-provider.test.ts, import-plan.test.ts:845, sqlite.test.ts seedSecondProject + three in-test inserts); `nodeDeletes: []` on the 24 `mutateGraph` call sites across nine files (sqlite.test.ts, list-edge.test.ts ×2, list-node.test.ts, http/server/plan/import-plan.test.ts, export-plan.test.ts, validate-plan.test.ts, test/helpers/plan.ts, import-plan.test.ts) — the Story's compat list names only the insertRevision sites and five fixture files; the probe below surfaced these, and the Story's own rule ("widening breaks every existing caller; this story owns each edit") covers them; list-revision.test.ts `assert.match` now skips the null members.
  **RED proof.**
- command: `node --test src/services/plan/sqlite.test.ts src/queries/plan/list-revision.test.ts src/http/contract/graph.test.ts`
- exit: 1 — sqlite.test.ts fail 12/54: `Error: NOT NULL constraint failed: plan_revision.origin` at `SqlitePlanStore.insertRevision (sqlite.ts:309)` on the four revision tests and the three updated existing tests; `AssertionError: true !== false` on the four mutateGraph delete tests (the ignored `nodeDeletes` leaves the node in place); `AssertionError: true !== false` at sqlite.test.ts:953 on `MutateGraphInput declares no trigger member` (the slice lacks `nodeDeletes`); list-revision.test.ts fail 2 (`NOT NULL constraint failed: plan_revision.origin`); graph.test.ts pass 0 fail.
- compat verification: read-project-status.test.ts, remove-provider.test.ts, recover-expired-leases.test.ts, sweep-remnants.test.ts → pass 36, fail 0 (the raw-insert fixes are live); import-plan.test.ts fail 36, all through the production `insertRevision` (SE lane).
- typecheck: exit 2, errors only in my test files — TS2353 excess `origin`/`nodeDeletes` on the call sites the SE's Story-4 change legitimises; no TS2307 anywhere.
- stub probe: `src/services/plan/index.ts` — patched to the Story-declared signatures (`RevisionRecord.origin` + nullable trio, `MutateGraphInput.nodeDeletes`), re-ran typecheck: every error confined to the SE's two production files (`src/commands/plan/import-plan.ts:156,399,478`, `src/services/plan/sqlite.ts:199,221`), my files clean; probe reverted, `src/services/plan/index.ts` restored byte-identical.
- expected red elsewhere (recorded, not touched): `parity.test.ts` and `route.test.ts` (route-matrix rows until Story 13), `http/server/plan/import-plan.test.ts`, `idempotency.test.ts`, `main.readiness.test.ts` (cascade through the production store).
  **Open to Software Engineer.**
- Story 4 seam, per `04-plan-store-origin.md`: `src/services/plan/index.ts` — `RevisionRecord` gains `origin: RevisionOrigin` between `parentId` and `importId`, `importId`/`submittedBlob`/`choicesBlob` nullable; `MutateGraphInput` gains `nodeDeletes: readonly string[]` after `deleteEdgeIds`, no `trigger` member, no fourth mutation method. `src/services/plan/sqlite.ts` — `SELECT_REVISION` and `RevisionRow` gain `origin`, `insertRevision` writes the eight columns (bind order = column order), `mutateGraph` deletes nodes after the edge deletes and before the edge inserts and the readiness pass, `DELETE_NODE` declared above `INSERT_NODE`. `src/http/contract/graph.ts` — `planRevisionEntry` gains `origin: z.enum(revisionOrigins)` and the nullable trio, `planRevisionsExamples` success example carries `origin: "import"`. `src/commands/plan/import-plan.ts:395` — `origin: "import"` on the insertRevision call and `nodeDeletes: []` on the mutateGraph call. Everything else is the story file's Change section; the test-side compat edits already landed in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 4 store-origin (GREEN)

**Cycle.** GREEN for `src/services/plan/sqlite.test.ts` + `src/queries/plan/list-revision.test.ts` (RED turn).
**Files changed.**

- `src/services/plan/index.ts` (edited) — `RevisionRecord` gains `origin: RevisionOrigin` between `parentId` and `importId`; `importId`, `submittedBlob`, `choicesBlob` now nullable; `import type { RevisionOrigin }` from `../../domain/plan-revision.ts`. `MutateGraphInput` gains `nodeDeletes: readonly string[]` after `deleteEdgeIds`; no `trigger` member; no fourth mutation method.
- `src/services/plan/sqlite.ts` (edited) — `SELECT_REVISION` gains `origin` between `parent_id` and `import_id`; `RevisionRow` declares `origin: RevisionOrigin` (not `string`) and the nullable trio; `DELETE_NODE` constant declared above `INSERT_NODE` (the first `ON CONFLICT` in the module still belongs to `INSERT_NODE`); `insertRevision` writes the eight columns with bind order matching column order; `mutateGraph` runs `DELETE_NODE` once per `nodeDeletes` member, after the edge deletes and before the edge inserts and the readiness pass; both row-to-record mappers carry `origin` through.
- `src/http/contract/graph.ts` (edited) — `planRevisionEntry` gains `origin: z.enum(revisionOrigins)` and the nullable trio (value import of `revisionOrigins`); `planRevisionsExamples` success example carries `origin: "import"`.
- `src/commands/plan/import-plan.ts` (edited) — `insertRevision` call gains `origin: "import"`; `mutateGraph` call gains `nodeDeletes: []`; nothing else per Story 4's Change list — except the one typecheck-named fix: `retryResult`'s `existing` parameter is now `RevisionRecord` (the file's local structural type was narrower than the widened record, TS2345 at `:156`; the Story's own "change nothing unless `npm run typecheck` names it" rule applies, as it does for `list-revision.ts`).
- `src/queries/plan/list-revision.ts` — unchanged (typecheck did not name it; `RevisionEntry` is `RevisionRecord`).
  **Seam (GREEN).** The tests insert through `insertRevision` and read through `listRevisions`/`findByImportId`/`newestRevision`; the eight-column insert satisfies `plan_revision.origin`'s `NOT NULL`, the nullable provenance columns carry the `node-write` row, and the `DELETE_NODE` step after the edge deletes is what makes `mutateGraph deletes edges before it deletes nodes` pass the `edge`→`node` foreign key. The source-scan assertions find `nodeDeletes` inside `MutateGraphInput` and no `trigger`, and the first `ON CONFLICT` still belongs to `INSERT_NODE`.
  **Refactor.** none named in Story 4 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint: 1 pre-existing error, **not mine and not caused by this commit** — `src/services/storage/migration-0006-revision-origin.test.ts:210:9` `no-restricted-syntax` (a node write outside `src/services/plan/sqlite.ts` in the TE's test file). Reproduced with my changes stashed: the same single error fires on the pre-commit tree. The fix is test-side (an exemption entry in `eslint.config.js` is a build-config file, out of my lane).

**Assumptions.**

- VERIFIED: the `retryResult` widening is in-scope — `import-plan.ts:156` failed typecheck with TS2345 the moment `RevisionRecord` widened, and Story 4's "Change nothing in this file unless `npm run typecheck` names it" rule (stated for `list-revision.ts`) covers typecheck-named edits; no behaviour changed.
- VERIFIED: `revisionOrigins` needs a value import in `graph.ts` (`z.enum(revisionOrigins)` evaluates it), while `RevisionOrigin` in `services/plan/*` is type-only under `verbatimModuleSyntax`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 5 structural validity (RED, after Story 4 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 4 (`src/services/plan/sqlite.test.ts`, `src/queries/plan/list-revision.test.ts`), then RED for Task 5 (`05-structural-validity`): `src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`, `src/queries/plan/validate-plan.test.ts`, `src/commands/plan/import-plan.test.ts`, `src/http/contract/graph.test.ts`.
**Confirm GREEN (Story 4).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; `node --test src/services/plan/sqlite.test.ts src/queries/plan/list-revision.test.ts src/http/contract/graph.test.ts src/services/storage/migration-0001-core-entities.test.ts src/services/storage/migration-0002-graph-and-plan.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/migration-0004-event-indexes.test.ts src/services/storage/migration-0006-revision-origin.test.ts` → pass 175, fail 0; `npm run lint` → exit 0.
- Test-side fixes this turn, both mine:
  - the lint error the SE flagged in Stories 2+3 (`migration-0006-revision-origin.test.ts:210` `no-restricted-syntax`): the raw `INSERT INTO node` moved out of the test into a new `seedSecondRevisionWithTask` helper in `test/helpers/rows.ts` — the eslint exemption comment says a NEW file belongs on neither list, so seeding goes through `rows.ts`. Lint is exit 0.
  - my Story-4 source-scan probe `MutateGraphInput declares no trigger member` was broken: `indexOf("};", start)` never matches in `src/services/plan/index.ts` (every type closes with `}>;`), so the slice ran to EOF, absorbed `SetNodeStateInput`'s `trigger` and failed even against the SE's correct implementation. Fixed to scan for `}>;` with an `assert.ok(end !== -1)`. It is green now; the Story-4 RED-turn description ("slice lacks nodeDeletes") was the same bug misread.
    **Test written.**
- file: `src/domain/plan-candidate.test.ts` (edited) — suite `src/domain/plan-candidate.test` — methods:
  - `a task under an initiative is parent-missing` — code, id and exact message `the parent <initiative> is not an objective`;
  - `an objective under a task is parent-missing` — message `the parent <task> is not an initiative`;
  - `a task under an objective and an objective under an initiative are clean` — `[]`;
  - `an initiative is exempt from the parent-kind rule` — no parent finding on `parentId: null`;
  - `the parent-kind rule is structural` — `findingScope["parent-missing"] === "structural"`;
  - `validateCandidateStructural drops both completeness codes` — empty objective + empty initiative fixture yields `[]`;
  - `validateCandidateCompleteness keeps both completeness codes and nothing else` — codes `["initiative-without-objective", "objective-without-task"]` in validateCandidate order;
  - `the two partitions are exhaustive` — repo-missing fixture: `structural.length + completeness.length === validateCandidate(...).length` and the per-partition codes;
  - `repairSuggestions terminates on an incomplete baseline` — stored objective-with-no-task graph, all-database verdicts, returns both verdicts resolved without throwing;
  - edited the two completeness tests (`reports objective-without-task…`, `reports initiative-without-objective…`) to also assert `validateCandidateStructural` over the same fixtures returns `[]` — the Story's `:451-479` named edit.
- file: `src/domain/plan-validate.test.ts` (edited) — `a plan holding both containment faults yields both findings` gains per-finding `findingScope === "completeness"` assertions (the Story's `:1034` named test; `validateDocuments` still reports both scopes — characterization pin, passes today, intended).
- file: `src/queries/plan/validate-plan.test.ts` (edited) — `a kind change is an addition and a retention`: the `:536` component-reset assertion now names the literal post-repair choice, `added.suggested === "submitted"` (the repair loop no longer sees the completeness finding); the Story-09 comment replaced by a Story-05 one.
- file: `src/commands/plan/import-plan.test.ts` (edited) — suite `src/commands/plan/import-plan.test`, new `completeness findings` describe — methods:
  - `an import of a graph with an empty objective succeeds and reports the finding` — round trip minus the T1 document; `result.revision` is a string (`revision_${U_REV}`) and `result.completeness` codes are exactly `["objective-without-task"]` (exactly once);
  - `an import of a graph with an empty initiative succeeds and reports the finding` — single initiative document; codes exactly `["initiative-without-objective"]`;
  - `an import with a structural finding still refuses` — objective document without `repo:`; `ImportPlanError` refusal `plan-invalid`, `details.findings` codes exactly `["repo-missing"]` (structural partition only, no `objective-without-task`);
  - `completeness is sorted and deduplicated` — two initiatives, one empty objective under the second; codes exactly `["initiative-without-objective", "objective-without-task"]` (one entry per code).
- file: `src/http/contract/graph.test.ts` (edited) — compat: the success body of `planImportResponse parses the response shape…` gains `completeness: []`, because the schema member Story 5 adds is required (`z.strictObject`).
- asserts: the Story-5 contract — the parent-kind rule with its exact messages, both partition functions, structural-only repair termination, completeness partitions carried in the import response and merged to one entry per code, and the structural-only refusal partition.
  **RED proof.**
- command: `node --test src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/import-plan.test.ts src/http/contract/graph.test.ts`
- exit: 1 — fail 7, pass 102; failures:
  - `SyntaxError: The requested module './plan-candidate.ts' does not provide an export named 'validateCandidateCompleteness'` (whole candidate suite at load);
  - `Error [ImportPlanError]: the submission is not a valid plan` at import-plan.ts:220 on all three success-path import tests (completeness still refuses today);
  - `AssertionError … + 'objective-without-task', 'repo-missing'` on the structural-refusal test (`details.findings` carries both scopes today, not the structural partition);
  - `AssertionError: false !== true` at graph.test.ts:77 (`planImportResponse` strictObject rejects the `completeness` member it gains in the SE change);
  - `AssertionError: + actual - expected` on `a kind change is an addition and a retention` (`"database"` vs `"submitted"`).
- repair probe: `repairSuggestions` over the stored objective-with-no-task baseline throws today — `repairSuggestions exceeded its iteration cap` (the EPIC's exact failure mechanism); the new test asserts termination.
- typecheck: exit 2 — every error in my test files only: TS2305 ×2 (missing exports), TS2339 ×3 (`completeness` on `ImportPlanResult`), TS7006 cascades.
- stub probe: `src/domain/plan-candidate.ts` (both functions with the Story's declared signatures) and `src/commands/plan/import-plan.ts` (`ImportPlanResult.completeness: readonly Finding[]` + type import) — remaining typecheck errors exactly the two SE-lane return sites `import-plan.ts:142` (main return) and `:582` (retryResult), my files clean; stubs deleted, both files byte-identical to the SE's Story-4 state.
- expected red elsewhere (recorded, not touched): `parity.test.ts` still red from Story 1 (route rows until Story 13), unchanged.
  **Open to Software Engineer.**
- `src/domain/plan-candidate.ts` — export `validateCandidateStructural` and `validateCandidateCompleteness` (the Story's exact signatures, filtering `validateCandidate` output on `findingScope`); the parent-kind check in the parent loop after the parent-exists check (code `parent-missing`, distinct message `the parent ${parentId} is not an ${required}`); the `repairSuggestions` loop at `:291` calls `validateCandidateStructural`. `src/commands/plan/import-plan.ts` — `:219` refuses `plan-invalid` only on the non-empty structural partition with `details.findings` carrying that partition only; `:338` calls `validateCandidateStructural` plus `validateCandidateCompleteness`; `ImportPlanResult` gains `completeness: readonly Finding[]` merged from both partitions, passed through `sortFindings` and deduplicated keeping the first occurrence (both `:142` and `:582` must satisfy the type). `src/http/contract/graph.ts` — `planImportResponse` gains `completeness: z.array(planFinding)`, and `planImportExamples.success` carries `completeness: []`. The server handler needs no edit (it spreads the result minus `retried` — verified). `src/queries/plan/validate-plan.ts` stays as it is.
- **One reconciliation note on the merge:** the document-side finding is `{code, path, id: null}` and the candidate-side one is `{code, path: null, id}` — distinct triples, so a literal `(code, path, id)` dedup keeps both and the tests fail. The Story's own Verify text demands one entry per code ("names `objective-without-task` exactly once", "a fixture producing the same code from both the document side and the candidate side yields one entry"). The tests pin the collapsed outcome; the mechanism is yours.
- The four tests that must stay green through the change: the two EPIC-014 `ready`-accepts-structural tests, the `choices-invalid` cycle refusal, and the server `plan-invalid`/`choices-invalid` 422 tests (both structural codes, refusal unchanged).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 5 structural validity (GREEN, one TE fixture defect raised OPEN)

**Cycle.** GREEN for the Story 5 RED turn (`src/domain/plan-candidate.test.ts`, `src/domain/plan-validate.test.ts`, `src/queries/plan/validate-plan.test.ts`, `src/commands/plan/import-plan.test.ts`, `src/http/contract/graph.test.ts`).
**Files changed.**

- `src/domain/plan-candidate.ts` (edited) — `validateCandidateStructural` and `validateCandidateCompleteness` exported below `validateCandidate`, each delegating and filtering on `findingScope` (value import of `findingScope`); the parent-kind check added to the parent loop immediately after the parent-exists check (code `parent-missing`, message `` `the parent ${parentId} is not an ${required}` ``, `required` = `"initiative"` for an objective, `"objective"` otherwise, initiative exempt); `repairSuggestions` calls `validateCandidateStructural` inside the loop.
- `src/commands/plan/import-plan.ts` (edited) — `validation.findings` partitioned on `findingScope`; `plan-invalid` throws only on the non-empty structural partition with `details.findings` carrying that partition; the completeness partition carried in a local; `choices-invalid` throws only on `validateCandidateStructural`, and `validateCandidateCompleteness` runs over the same candidate; `ImportPlanResult` gains `completeness: readonly Finding[]`; the main return merges `[...documentCompleteness, ...candidateCompleteness]` through a new `deduplicateCompleteness` (sortFindings, then one entry per `code`, first occurrence — the Story's triple-dedup would keep both sides of the same code and the TE's tests pin one entry per code, per the TE's own reconciliation note); `retryResult` returns `completeness: []`.
- `src/http/contract/graph.ts` (edited) — `planImportResponse` gains `completeness: z.array(planFinding)`; `planImportExamples.success` carries `completeness: []`.
- `src/queries/plan/validate-plan.ts`, `src/http/server/plan/import-plan.ts` — unchanged (Story: stays as-is; handler spreads the result minus `retried`, so `completeness` reaches the body).
  **Seam (GREEN).** The domain tests import the two new functions and drive the parent-kind rule; the repair-loop tests terminate because a database baseline has no structural finding; the import tests succeed past the refusal because only the structural partition throws, and the response schema accepts the merged `completeness`.
  **Blocked — `OPEN:` (TE lane).**
- `src/domain/plan-candidate.test.ts:479-503` — `an objective under a task is parent-missing`: the fixture's stray `task1` is parentless (`submittedDocument(task1, "task", { worker: "tdd" })`), so the pre-existing "an objective or task holds no parent" check fires for it beside the new wrong-kind finding for `objectiveO1`. Probe of the production module with the exact fixture: `count: 2` (`[{code:"parent-missing",id:"objective_01BQ…",message:"the parent task_01ER… is not an initiative"},{code:"parent-missing",id:"task_01ER…",message:"an objective or task holds no parent"}]`), while the test asserts `parentFindings.length === 1` with the objective's message. With `parentIdentity: objectiveO1` added to `task1`'s overrides, the same probe yields exactly the asserted single finding. Recommended one-line fix, in the TE's lane: `submittedDocument(task1, "task", { parentIdentity: objectiveO1, worker: "tdd" })`. Alternative: assert both findings — under `sortFindings` `[0]` is already the objective one (`"objective_…" < "task_…"`), so only the length assertion and a `[1]` message check would change. I will not weaken the Story's additive rule (removing the holds-no-parent check) to dodge the fixture: the Story's snippet is explicit.
  **Refactor.** none named in Story 5 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- lint: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- behavior probe (production module, not a test run): the "task under initiative" fixture yields 1 parent-missing finding with the exact asserted message; the "objective under task" fixture yields 2 (the OPEN above); the same fixture with the recommended parent override yields exactly the asserted shape. Probe file removed after the run.

ATTEMPT-FAILED: Task 5 — `an objective under a task is parent-missing` asserts 1 parent-missing finding but the fixture's parentless `task1` also fires the pre-existing holds-no-parent check (probe-verified count 2); the one-line fixture fix (`parentIdentity: objectiveO1` on `task1`) is in the TE's test file.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 6 write-legality (RED, after Story 5 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 5 (`05-structural-validity`), then RED for Task 6 (`06-node-write-legality`): `src/domain/node-write-legality.test.ts`, new.
**Confirm GREEN (Story 5).**

- The SE's Story-5 GREEN raised one `OPEN:` in my lane: `src/domain/plan-candidate.test.ts:479-503` — the fixture's stray parentless `task1` fired the pre-existing holds-no-parent check beside the new wrong-kind finding, so the probe count was 2 against the asserted 1.
- Fix (mine, per the SE's recommended one-liner): `submittedDocument(task1, "task", { parentIdentity: objectiveO1, worker: "tdd" })` — the parent-kind check on `objectiveO1` under `task1` is the single remaining finding; `task1` under an objective is legal.
- Second defect found during the same confirm (also mine): `src/queries/plan/validate-plan.test.ts:504` — the new-objective path embedded `low(planFixtureIdentities.initiative)` (the `initiative_` prefix included) while `canonicalPaths` segments are `<slug>--<bare-ulid>` (`plan-canonical-path.ts:24`), so the derived parent path resolved to nothing and a structural `parent-missing` fired, keeping the repair-loop reset. Fixed to `low(U_INITIATIVE)` — the probe then reports only the two `objective-without-task` findings and `added.suggested === "submitted"`.
- command: `node --test src/domain/plan-candidate.test.ts src/domain/plan-validate.test.ts src/queries/plan/validate-plan.test.ts src/commands/plan/import-plan.test.ts src/http/server/plan/import-plan.test.ts src/http/contract/graph.test.ts` → pass 149, fail 0. Story 5 is green.
  **Test written.**
- file: `src/domain/node-write-legality.test.ts` (new) — suite `src/domain/node-write-legality.test` — methods:
  - `nodeWriteRefusals deep-equals the two refusals in order` — `["state", "containment"]`, length 2;
  - `proseFields and structuralFields keep their exact members` — `["body","title"]` / `["depends_on","parent","repo","worker"]` / the six-member `differingFields` union;
  - `a prose-only edit is legal at all eight states` — `title` and `body` over every `nodeStates` member with `containmentMovable: false`, sixteen `{ legal: true }` calls;
  - `a structural edit is legal at exactly pending, ready and blocked` — `depends_on` with `containmentMovable: true` over all eight; `{ legal: true }` at the three, `{ legal: false, refusal: "state" }` at the other five;
  - `an immovable containment refuses a parent edit and a repo edit at the three legal states` — six `{ legal: false, refusal: "containment" }` assertions;
  - `an immovable containment does not refuse a depends_on or worker edit` — six `{ legal: true }` assertions;
  - `state precedes containment in the refusal order` — `running` + `parent` + `containmentMovable: false` → `state`;
  - `an empty field set is legal at all eight states`;
  - `a mixed prose and structural edit is structural` — `["title", "parent"]` at `running` → `state`;
  - `plan-choice.ts re-exports the field tuples from node-write-legality.ts` — source read asserts the import line, then a dynamic import of `plan-choice.ts` deep-equals the tuples exported by `node-write-legality.ts` (same values, so consumers keep their import paths);
  - `the dependency runs one way: node-write-legality.ts imports nothing from plan-choice.ts` — source read of the new file.
- asserts: the Story-6 contract — the two-refusal closed set, the 3-of-8 legal structural states, containment refusal only for `parent`/`repo` at legal states, `state` before `containment`, the moved tuples with their exact members, the one-way import direction and the re-export.
  **RED proof.**
- command: `node --test src/domain/node-write-legality.test.ts src/domain/plan-choice.test.ts src/domain/layout.test.ts`
- exit: 1 — fail 1, pass 122; failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/domain/node-write-legality.ts' imported from .../src/domain/node-write-legality.test.ts` (whole file at load). `plan-choice.test.ts` and `layout.test.ts` pass unchanged — the EPIC 014 cases "ready accepts a structural change" and the `structural.ready` matrix row are green on the current `choiceVerdict`, which Story 6 must preserve.
- typecheck: exit 2 — exactly the two TS2307 lines for `./node-write-legality.ts` in the new test file; no other error anywhere.
- lint: `npx eslint src/domain/node-write-legality.test.ts` — 2 `boundaries/no-unknown-dependencies` on the two import lines of the missing file; both clear the moment the SE creates the seam (domain → domain is allowed).
- stub probe: `src/domain/node-write-legality.ts` — clean; with the Story-declared signatures in place, typecheck exits 0 and the test file carries no own-type error. Stub deleted before handoff (no trace; the turn snapshot compares against HEAD).
  **Open to Software Engineer.**
- `src/domain/node-write-legality.ts` — new, pure. Exports the tuple `nodeWriteRefusals = ["state", "containment"] as const` and its `NodeWriteRefusal` type, `NodeWriteFacts` (`state: NodeState`, `fields: readonly DifferingField[]`, `containmentMovable: boolean`), the `NodeWriteLegality` union (`{ legal: true }` | `{ legal: false; refusal }`), and `nodeWriteLegality(facts)` with the Story's five steps in its exact order (structural detection via the `structuralFields` tuple, prose-legal-everywhere, the three-state gate, the containment gate, `{ legal: true }`). It also declares `proseFields`, `structuralFields`, `differingFields` and `DifferingField` (moved out of `plan-choice.ts`, members unchanged).
- `src/domain/plan-choice.ts` — delete the four moved declarations, re-export them from `node-write-legality.ts` (type-and-value re-export, so `plan-diff.ts` and `http/contract/graph.ts` keep their import paths untouched), and replace the structural branch at `:86-112` with a call to `nodeWriteLegality`, mapping `containment` to the existing reason `"the node or a descendant holds a lease, a workspace or a commit"` and `state` to `"a structural edit needs pending, blocked or ready"`. Do not change any other branch. `plan-choice.test.ts` must pass with no edit.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 6 write-legality (GREEN)

**Cycle.** GREEN for `src/domain/node-write-legality.test.ts` (RED turn).
**Files changed.**

- `src/domain/node-write-legality.ts` (new) — `nodeWriteRefusals` (tuple, two members), `NodeWriteRefusal`, `proseFields`, `structuralFields`, `differingFields`, `DifferingField` (the four moved from `plan-choice.ts`, members byte-identical), `NodeWriteFacts`, `NodeWriteLegality`, and `nodeWriteLegality(facts)` with the Story's five steps in order: structural detection via the `structuralFields` tuple, prose → `{ legal: true }`, the three-state gate (`pending`/`ready`/`blocked`), the containment gate (`parent`/`repo` and immovable), `{ legal: true }`. Pure; imports only `type NodeState` from `./state.ts`.
- `src/domain/plan-choice.ts` (edited) — the four moved declarations replaced by a type-and-value re-export `export { differingFields, proseFields, structuralFields, type DifferingField } from "./node-write-legality.ts"`, so `plan-diff.ts`, `graph.ts`, `import-plan.ts` and `validate-plan.ts` keep their import paths; local value import of `nodeWriteLegality` and `structuralFields` plus a type import of `DifferingField` (a re-export does not bring the names into the re-exporting module's own scope — typecheck named the gap); the structural branch of `choiceVerdict` replaced by a `nodeWriteLegality` call mapping `{ legal: true }` → `submitted`, `refusal: "containment"` → the existing lease/workspace/commit reason, `refusal: "state"` → `a structural edit needs pending, blocked or ready`; the other four branches untouched.
  **Seam (GREEN).** The test imports the six exports and drives `nodeWriteLegality` over the eight states; the source reads pin the one-way dependency (`plan-choice.ts` imports `./node-write-legality.ts`, never the reverse) and the re-export equality. `plan-choice.test.ts` passes unchanged because `choiceVerdict` maps every `nodeWriteLegality` outcome to the exact reason strings the EPIC 014 tests assert, including "ready accepts a structural change".
  **Refactor.** none named in Story 6 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (both changed files): exit 0
  **Assumptions.**
- VERIFIED: `ChoiceFacts.state` is `NodeState | null` while `NodeWriteFacts.state` is `NodeState`, so the call site passes `facts.state as NodeState`. Runtime semantics are unchanged: in the structural branch `presence === "both"` implies a non-null stored state, and a null state would fail the three-state gate in `nodeWriteLegality` and yield exactly the refusal the old branch produced for it.
- VERIFIED: the `hasStructural` pre-check at the top of the prose branch stays — it is what makes a prose edit at `running` suggest `submitted`; `nodeWriteLegality` cannot absorb it without changing the prose verdict.
- VERIFIED: the `structuralFields.includes(field)` form of the Story's step 1 needs the `(structuralFields as readonly string[])` cast under the tuple's narrower `includes` parameter — the same idiom the moved code already used.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 7 services-revision (RED, after Story 6 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 6 (`src/domain/node-write-legality.test.ts`, `src/domain/plan-choice.test.ts`, `src/domain/layout.test.ts`), then RED for Task 7 (`07-services-revision`): `src/services/revision/node-write.test.ts` (new), `src/domain/layout.test.ts` (edited), and every `exportPlan` call site (all test-side; the Story owns them).
**Confirm GREEN (Story 6).**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; `node --test src/domain/node-write-legality.test.ts src/domain/plan-choice.test.ts src/domain/layout.test.ts` → pass 134, fail 0. Story 6 is green.
  **Test written.**
- file: `src/services/revision/node-write.test.ts` (new) — suite `src/services/revision/node-write.test` — methods: `render translates a repository id to its name`; `render throws repository-unknown for an unregistered repository` (exact message `repository repo_ghost is not registered`); `render throws on a missing instruction blob` (error names the hash); `render returns documents sorted by canonical path` (reverse-canonical input, task/objective/initiative output); `render reproduces the pre-extraction export bytes` (golden-bytes test: three literal constants, compared through `Buffer.compare`); `record writes one node-write revision and one blob` (row carries `origin: "node-write"` and three nulls, blob decodes to the input canonical JSON); `record writes the given parent` (null and `revision_a` cases); `record reads no graph` (full graph seeded, ghost documents stored byte-identically); `src/services/revision/index.ts contains no occurrence of implements ` (source read).
- Golden capture: before any edit, ran the live pre-refactor `exportPlan` on three fixture graphs and captured `canonicalDocumentsJson(result.documents)` — G1 = base `seedPlanFixture` (task with acceptance, objective with repo, null cases), G2 = task with `worker: "tdd@1"`, G3 = second task with a `depends_on` edge. Each literal re-verified against an independent derivation (G1 vs the `expectedDocuments` of export-plan.test.ts; G2/G3 vs direct `renderDocumentSet` builds) — all three match.
- file: `src/domain/layout.test.ts` (edited) — title `sixteen capabilities plus home-lock` → `seventeen…`; `"revision"` added between `"readiness"` and `"storage"`.
- file: `test/helpers/plan.ts` (edited) — `createRevision(blobs: BlobStore, plan: PlanStore): Revision` returning `new NodeWriteRevision({ blobs, plan })`, per the Story's shared-fixture rule.
- call-site edits (all test-side, the Story owns each): `src/queries/plan/export-plan.test.ts` (14 sites, `build()` gains `revision`), `src/queries/plan/validate-plan.test.ts` (7 sites, `build()` gains `revision`), `src/commands/plan/import-plan.test.ts` (3 sites via `ImportFixture.revision` — the Story's `:629,:908` is stale, drift to `:682,:1260,:1706`), `src/http/server/plan/import-plan.test.ts` (2 sites), `src/http/server/plan/export-plan.test.ts` (1 site), and `src/http/server/idempotency.test.ts` (1 site — **not in the Story's list**, but it is an `exportPlan` caller and would break the SE's handoff typecheck in a file it cannot edit; the Story's own rule "this story owns each of those edits" covers it).
- asserts: the Story-7 contract — the shared projection translates id→name, refuses with `repository-unknown` and the exact message, throws naming a missing hash, sorts canonically, reproduces the pre-extraction bytes; `record` writes one revision + one blob, honors the given parent, and reads no graph; the capability list holds `revision`.
  **RED proof.**
- command: `node --test src/services/revision/node-write.test.ts src/queries/plan/export-plan.test.ts src/domain/layout.test.ts`
- exit: 1 — fail 4, pass 98; failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/services/revision/index.ts' imported from .../src/services/revision/node-write.test.ts`; `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/services/revision/node-write.ts' imported from .../test/helpers/plan.ts` (kills export-plan.test.ts at load); `AssertionError [ERR_ASSERTION]: revision is missing index.ts`; the `no src/services/*/index.ts contains an implementation` ENOENT on `revision/index.ts`. All four fail for the one reason: the seam does not exist.
- ripple (recorded, not touched): the five other call-site suites fail at load on the same `node-write.ts` import — validate-plan, commands/plan import-plan, http/server/plan import-plan, http/server/plan export-plan, idempotency — pass 0, fail 5.
- typecheck: exit 2, 39 errors — 6 TS2307 on the two seam paths, 28 TS2353 against the SE-lane `ExportPlanDependencies` (`blobs` not yet replaced by `revision`), 4 cascade errors in my new file, 1 TS2307 on the `Revision` type import.
- stub probe: `src/services/revision/index.ts` (the Story's exact declarations) + `node-write.ts` (constructor `{ blobs, plan }`) — probe surfaced my own error first: call sites that did not destructure `revision` from `build()` (TS18004 ×21), fixed in all nine destructures; with the stubs in place the remaining 29 errors are exactly the SE-lane `ExportPlanDependencies` type and the stub's own no-arg constructor (TS2554 at plan.ts:60). Stubs deleted before handoff; no trace.
- lint: my new test file passes `no-restricted-syntax` (the G3 fixture drops the raw `UPDATE edge` — the exemption list does not cover this file, and the render path never reads the edge table, so the bytes are waiver-independent; G3 re-verified after the drop). The only remaining lint errors are `boundaries/no-unknown-dependencies` on the two missing-seam imports, which clear the moment the SE creates the files.
  **Open to Software Engineer.**
- `src/services/revision/index.ts` — the Story's exact interface file: `RevisionRenderInput`, `RevisionRecordInput`, `RevisionRefusal = "repository-unknown"`, `RevisionError` (refusal + message), `interface Revision { render(transaction, input): readonly RenderedDocument[]; record(transaction, input): void }`. No `implements ` in the file (layout.test.ts asserts it), imports `domain/` and service interfaces only.
- `src/services/revision/node-write.ts` — `class NodeWriteRevision implements Revision`, constructor object `{ blobs: BlobStore; plan: PlanStore }`. `render` runs the Story's exact order: repository name map, per-node blob loads (missing blob → `Error(\`blob ${hash} is missing from the store\`)`), `TextDecoder` decode, id→name translation (`RevisionError("repository-unknown", \`repository ${id} is not registered\`)`), `CanonicalNode`build,`renderDocumentSet`. `record`puts`canonicalDocumentsJson(documents)`and calls`insertRevision`with`origin: "node-write"` and the three nulls.
- `src/queries/plan/export-plan.ts` — `ExportPlanDependencies` gains `revision: Revision` and drops `blobs` (delete `readRepositoryNamesById`, the bodies loop and the `canonicalNodes` map; one `dependencies.revision.render(transaction, { nodes })` call, mapping `RevisionError` → `ExportPlanError`). This is the type my 28 TS2353 errors resolve against.
- `src/main.ts:335` — `exportPlan: (input) => exportPlan({ storage, plan, revision }, input)` with `revision = new NodeWriteRevision({ blobs, plan })` constructed once beside the other service implementations.
- Do not touch `src/commands/plan/import-plan.ts` (Story: no change) and none of the test files — every call-site edit already landed in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 7 services/revision (GREEN)

**Cycle.** GREEN for `src/services/revision/node-write.test.ts` + `src/queries/plan/export-plan.test.ts` + `src/domain/layout.test.ts` (RED turn).
**Files changed.**

- `src/services/revision/index.ts` (new) — the Story's interface file verbatim: `RevisionRenderInput`, `RevisionRecordInput`, `RevisionRefusal = "repository-unknown"`, `RevisionError` (refusal + message), `interface Revision { render; record }`. Imports `../storage/index.ts` and `domain/` only; contains no `implements ` (grep count 0).
- `src/services/revision/node-write.ts` (new) — `NodeWriteRevision implements Revision`, constructor object `{ blobs: BlobStore; plan: PlanStore }` with explicit `readonly #blobs`/`#plan` fields (parameter properties are unsupported under strip-only mode). `render` is the pre-extraction `export-plan.ts:63-125` body moved with no behaviour change: repository name map from `SELECT id, name FROM repository`, per-node blob loads with the same missing-blob message shape, one module-level `TextDecoder`, id→name translation (`RevisionError("repository-unknown", \`repository ${id} is not registered\`)`), `CanonicalNode`map,`renderDocumentSet`. `record`puts`canonicalDocumentsJson(input.documents)`through a module-level`TextEncoder`and calls`insertRevision`with`origin: "node-write"`and the three nulls. Imports only`domain/`, service interfaces and its own capability.
- `src/queries/plan/export-plan.ts` (edited) — `ExportPlanDependencies` gains `revision: Revision`, drops `blobs` and the `BlobStore` import; `readRepositoryNamesById`, the bodies loop, the `canonicalNodes` map and the module-level `decoder` deleted; replaced with one `dependencies.revision.render(transaction, { nodes })` call in a `try` mapping `RevisionError` → `ExportPlanError(error.refusal, error.message)`. `ExportPlanRefusal` is unchanged, so the declared error set of `plan.export` does not change.
- `src/main.ts` (edited) — `new NodeWriteRevision({ blobs, plan })` constructed once beside the other service implementations; `plan.export` wiring becomes `exportPlan({ storage, plan, revision }, input)`. This is the whole composition edit the Story makes.
  **Seam (GREEN).** The test drives `NodeWriteRevision` through `createRevision(blobs, plan)` and asserts the golden bytes, the `repository-unknown` message and the `node-write` row; `export-plan.test.ts` passes because the shared projection reproduces the pre-extraction export bytes, and `layout.test.ts` finds the `revision` directory with an `index.ts` that holds no implementation.
  **Refactor.** none named in Story 7 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (the two new files + export-plan.ts + main.ts): exit 0
  **Assumptions.**
- VERIFIED: `BlobStore.get(hash, transaction)` accepts the explicit transaction (optional second parameter) — the pre-extraction code already called it that way, and the golden-bytes tests pin the exact bytes.
- VERIFIED: `RevisionError` needs a value import in `export-plan.ts` (`instanceof` evaluates it), while `Revision` stays `import type` there and in `node-write.ts` — `verbatimModuleSyntax`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 8 concurrency classes (RED, after Story 7 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 7 (`07-services-revision`), then RED for Task 8 (`08-concurrency-classes`): `src/commands/node/create-node.test.ts`, new — the shared refusal type asserted there, per the Story's Verify.
**Confirm GREEN (Story 7).**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; `node --test src/services/revision/node-write.test.ts src/queries/plan/export-plan.test.ts src/domain/layout.test.ts` → pass 121, fail 0. Story 7 is green.
  **Test written.**
- file: `src/commands/node/create-node.test.ts` (new) — suite `src/commands/node/create-node.test` — methods:
  - `nodeWriteRefusalCodes deep-equals the seven shared codes in order` — deep-equal against `["project-not-found", "node-not-found", "kind-mismatch", "stale-revision", "plan-invalid", "illegal-transition", "binding-in-use"]`;
  - `NodeWriteError carries its name, refusal and details` — `name === "NodeWriteError"`, `refusal === "stale-revision"`, `details` deep-equal `{ guard, expected, actual }`, and `instanceof Error`;
  - `NodeWriteError leaves details undefined when omitted` — two-argument constructor, `details === undefined`.
- The file is the Story-8 skeleton only; the guard-rule assertions the Story lists ("a create against an empty project with `fromRevision: null` succeeds; a create with a stale project revision throws `stale-revision` with `details.guard === 'project'`") need `createNode` and land in this file's Story-9 RED turn. Each story's own command test file owns its cross-route assertions, per `08-concurrency-classes.md:66-72`.
- asserts: the Story-8 Verify contract — the seven codes in order and the `NodeWriteError` shape (`name`, `refusal`, `details`, omitted-details).
  **RED proof.**
- command: `node --test src/commands/node/create-node.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/commands/node/refusal.ts' imported from .../src/commands/node/create-node.test.ts` (whole file at load). One failing test, three occurrences.
- typecheck: exit 2 — exactly one line, `src/commands/node/create-node.test.ts(7,8): error TS2307: Cannot find module './refusal.ts'`; nothing else anywhere.
- lint: `npx eslint src/commands/node/create-node.test.ts` — 1 `boundaries/no-unknown-dependencies` on the `./refusal.ts` import; clears the moment the SE creates the seam (commands → commands is allowed).
- stub probe: `src/commands/node/refusal.ts` — clean; with the Story-declared signatures in place, typecheck exits 0 and the test passes 3/3. Stub deleted before handoff; `git status` shows `?? src/commands/node/` holding only the test file, no trace.
- **Recorded discrepancy, no action taken:** the Story's Verify bullet "`node --test src/commands/node/refusal.test.ts` exits 0" is unsatisfiable as literally written — the Story's own Change section and the EPIC Proof both state `refusal.ts` gets no test file of its own, and `node --test` on an absent path exits 1 (probed: exit 1). The EPIC Proof names every file this epic creates and names no `refusal.test.ts`, so the gate is unaffected; the bullet reads as a drafting leftover from an earlier revision. Flagged for the human's review, not opened — the Task's substance is implementable and executed above.
- expected red elsewhere (recorded, not touched): `parity.test.ts`/`route.test.ts` still red from Story 1 until Story 13, unchanged.
  **Open to Software Engineer.**
- `src/commands/node/refusal.ts` — new, the Story's exact declarations: `nodeWriteRefusalCodes` (the seven-code `as const` tuple above), `NodeWriteRefusalCode` derived from it, and `class NodeWriteError extends Error` with `readonly refusal: NodeWriteRefusalCode`, `readonly details: unknown`, the `(refusal, message, details?)` constructor, and `name === "NodeWriteError"` — the `ImportPlanError` shape at `src/commands/plan/import-plan.ts:87-97`. Nothing else: the guard rule (`revisionGuardFor` calls per command) is implemented by Stories 9, 10 and 11, and no `refusal.test.ts` is created. Do not touch the test file — it is this turn's, and Story 9 extends it.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 8 concurrency classes (GREEN)

**Cycle.** GREEN for `src/commands/node/create-node.test.ts` (RED turn).
**Files changed.**

- `src/commands/node/refusal.ts` (new) — `nodeWriteRefusalCodes` (the seven-code `as const` tuple), `NodeWriteRefusalCode = (typeof nodeWriteRefusalCodes)[number]`, and `NodeWriteError extends Error` with `readonly refusal: NodeWriteRefusalCode`, `readonly details: unknown`, and the `(refusal, message, details?)` constructor setting `this.name = "NodeWriteError"` — the `ImportPlanError` shape at `import-plan.ts:87-97`.
  **Seam (GREEN).** The test imports the two exports from `./refusal.ts`; the tuple deep-equals the seven codes in order, and the error carries `name`, `refusal` and `details`, with `details === undefined` when the third argument is omitted.
  **Refactor.** none named in Story 8 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (new file): exit 0
  **Assumptions.**
- VERIFIED: the guard rule itself (`revisionGuardFor` calls, `stale-revision` details, the topology classification) is Stories 9-11 territory — `08-concurrency-classes.md:4` says this story owns the shared refusal type and the cross-route guard tests, and the TE's RED turn names exactly the same boundary ("nothing else … implemented by Stories 9, 10 and 11").

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 9 createNode (RED, after Story 8 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 8 (`src/commands/node/create-node.test.ts`, `src/commands/node/refusal.ts`), then RED for Task 9 (`09-create-node`): `src/commands/node/create-node.test.ts` (edited — the Story-8 skeleton extended with the Story-9 suite), `test/helpers/plan.ts` (edited — the Story-9 recording fixture).
**Confirm GREEN (Story 8).**

- The SE's Story-8 claim (typecheck exit 0, `VERIFY: PASS`) was re-verified with the new RED test file temporarily moved out of `src/commands/node/` — the tree then holds exactly the SE's Story-8 handoff plus my additive helper, which compiles clean: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`. The file was restored byte-identical before this turn was composed.
- The three Story-8 tests run green against the current production code: pass 3 in the stub-probe run below (only the missing seam was stubbed; `refusal.ts` is the SE's file).
  **Test written.**
- file: `src/commands/node/create-node.test.ts` (edited) — suite `src/commands/node/create-node.test` — the Story-8 skeleton unchanged, plus twenty-one methods:
  - `creates an initiative in an empty project` — `fromRevision: null` succeeds; `result.id` carries `initiative_`; `plan_revision` holds one row with `origin: "node-write"` and three null provenance columns; `result.completeness` codes are exactly `["initiative-without-objective"]`;
  - `mints the revision before the node row` — the node row's `revision` column equals the returned revision and the `plan_revision` row resolves;
  - `takes the project revision as the new parent` — after `seedPlanFixture`, the new revision row's `parent_id` equals `revision_a`;
  - `refuses a stale project revision` — `stale-revision` with `details` deep-equal `{ guard: "project", expected: "revision_a", actual: "revision_stale" }`, node/edge/plan_revision counts equal;
  - six named structural refusals, one test each (`parent-missing` task-under-initiative, `worker-unknown` ghost worker, `repository-unknown` ghost repo, `repository-unbound` known-but-unbound `repo_b`, `reference-unresolved` absent target, `dependency-cross-parent` target under another parent) — each asserts `refusal === "plan-invalid"`, the code by name in `details.findings`, and equal node/edge/plan_revision counts;
  - `dependency-self and dependency-cycle are unreachable on a create` — three creates on an empty project, the third with `dependsOn` naming every stored node, succeeds; two edges written to the two earlier initiatives;
  - `sorts dependsOn bytewise` — three sibling tasks seeded under the objective through `plan.mutateGraph`, create with `dependsOn` in reverse bytewise order; edge rows map minted ids `edge_<U_E_SORT1..3>` to `to_node` in bytewise order (proves the sort precedes the mint), `readGraph` returns the dependencies bytewise;
  - `deduplicates dependsOn` — a repeated id writes one edge;
  - `export bytes equal the accepted blob` — `exportPlan` after the create, blob fetched by the new revision's `acceptedBlob`, compared through `Buffer.compare` against `canonicalDocumentsJson` of the export documents;
  - `a stored objective renders its repository name in the accepted blob` — blob text holds `kanthord-verify` and not `repo_a`;
  - `appends one node.created event carrying the resolved actor` — harness `ActorRow`; the `node.created` row holds `actor_kind = 'harness'` and the actor id; payload deep-equals `{ kind: "task", parentId, revision }`;
  - `calls mutateGraph exactly once and setNodeState never` — recorded call list exactly `["mutateGraph"]`, recorded input holds no `trigger` key;
  - `a create with no dependency promotes the node to ready in the same mutation` — recorded transitions deep-equal `[{ nodeId, from: "pending", to: "ready", trigger: "readiness-promoted" }]`, stored `node.state` is `ready`;
  - `one clock read per command` — advancing mock clock; the new node's `updated_at` equals the first read (`CLOCK_START`), and the distinct `updated_at` set over all node rows is exactly `{1, CLOCK_START}`;
  - `a create with an unsatisfied dependency leaves the node pending` — recorded transitions empty, stored state `pending`;
  - `a create changes no other node` — every other node's `state`, `revision` and `updatedAt` equal before and after, and the only added id is the new node.
- file: `test/helpers/plan.ts` (edited) — `RecordedPlanCall` (`method`, `input`, `transitions`) and `createRecordingPlanStore(plan)` wrapping a real `SqlitePlanStore`, recording per call the method name, the input object and the transition list each mutation returned; records only the two mutation methods, so "every mutation call is `mutateGraph`" reads the list directly. Serves Stories 9, 10, 11 and 14.
- asserts: the Story-9 contract — the empty-project create, the parent/guard/mint order observables, the six reachable structural codes with no write on refusal, the bytewise sort and dedupe, the export↔accepted-blob byte equality, the harness-resolved event, the recording-store mutation and transition assertions, the single clock read, the pending case, and the untouched other nodes.
  **RED proof.**
- command: `node --test src/commands/node/create-node.test.ts`
- exit: 1 — fail 1, pass 0: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/commands/node/create-node.ts' imported from .../src/commands/node/create-node.test.ts` (whole file at load).
- typecheck: exit 2 — exactly `create-node.test.ts(4,28)` and `(8,8)` TS2307 for `./create-node.ts`, plus one TS7006 cascade (`finding` implicit any on the untyped `completeness`); nothing else anywhere.
- lint: `npx eslint src/commands/node/create-node.test.ts test/helpers/plan.ts` — 2 `boundaries/no-unknown-dependencies` on the two `./create-node.ts` imports (clear the moment the SE creates the seam), helper file clean; no `no-restricted-syntax` — sibling tasks are seeded through `plan.mutateGraph`, and the `repo_b` insert targets `repository`, not `node`/`edge`.
- stub probe: `src/commands/node/create-node.ts` — the Story's exact declarations — clean: typecheck exit 0; the probe run is pass 3, fail 21, every one of the 21 failing with `Error: stub` at the seam (no assertion error, no fixture defect); the 3 passes are the Story-8 tests. Stub deleted before handoff; `ls src/commands/node/` holds only `create-node.test.ts` and `refusal.ts`.
- expected red elsewhere (recorded, not touched): `parity.test.ts`/`route.test.ts` still red from Story 1 until Story 13, unchanged.
  **Open to Software Engineer.**
- `src/commands/node/create-node.ts` — the Story-9 seam: `NodeCreateBody` (the three-member discriminated union of the Story file), `CreateNodeDependencies` `{ storage, plan, blobs, graph, ids, clock, events, revision }`, `CreateNodeInput` `{ projectId, fromRevision, node, actor: ActorRow }`, `CreateNodeResult` `{ revision, id, completeness }`, and `createNode(dependencies, input)`. The Story file's step list is normative: the single clock read first; `project-not-found` check; the project-class guard compare (`revisionGuardFor("create")`) throwing `NodeWriteError("stale-revision", ..., { guard: "project", expected, actual })`; mints; blob puts; `readGraph`; repository id/name separation; the in-memory post-write node set; the `Candidate` with `source: "database"` and name-mapped repository ids (the `import-plan.ts:186-198` idiom); `validateCandidateStructural` refusing `plan-invalid` with `details.findings`; `Revision.render`; `Revision.record` before `mutateGraph`; one `mutateGraph` with the new node stamped `revision: revisionId`, edges per `dependsOn` sorted bytewise by `toNode`, and no `trigger` member; `validateCandidateCompleteness` for the response; one `node.created` event with the resolved actor; the return. Six structural codes reachable (`parent-missing`, `worker-unknown`, `repository-unknown`, `repository-unbound`, `reference-unresolved`, `dependency-cross-parent`); `dependency-self`/`dependency-cycle` unreachable; `setNodeState` never. The transition observations read `createRecordingPlanStore` — already landed in `test/helpers/plan.ts` (mine). Do not touch the two test-side files.
- The readiness derivation runs inside `mutateGraph` per `016-readiness-applied.md`; the promotion the tests pin (`readiness-promoted`, pending → ready) is the existing store behaviour — the command only names the mutation.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 9 createNode (GREEN, one TE fixture defect raised OPEN)

**Cycle.** GREEN for `src/commands/node/create-node.test.ts` (RED turn).
**Files changed.**

- `src/commands/node/create-node.ts` (new) — `NodeCreateBody` (the three-member discriminated union of Story 12's schema, declared locally — importing `http/contract` is not legal under the import matrix), `CreateNodeDependencies` `{ storage, plan, blobs, graph, ids, clock, events, revision }`, `CreateNodeInput` `{ projectId, fromRevision, node, actor }`, `CreateNodeResult` `{ revision, id, completeness }`, and `createNode` running the Story's fourteen steps in the normative order inside one `storage.transact`.
  **Seam (GREEN).** The test drives `createNode` through real SQLite plus the recording `PlanStore`; the single clock read (`at`) stamps the node, `revisionGuardFor("create")` yields the `project` guard details, the `source: "database"` candidate maps stored `repositoryId` ids to names and the new node to the submitted name, `validateCandidateStructural` refuses `plan-invalid` with the six reachable codes, `Revision.record` precedes `mutateGraph` (the node row's `revision` FK resolves), `dependsOn` is deduplicated and sorted bytewise before edges are minted and before the candidate dependencies, and the response carries the completeness partition. Readiness applies inside `mutateGraph` — the recording fixture observes `[{ pending → ready, "readiness-promoted" }]` for a dependency-free create and `[]` for a dependency on a merely-`ready` node (an unsatisfied dependency, per `satisfiesDependency`).
  **Blocked — `OPEN:` (TE lane).**
- `src/commands/node/create-node.test.ts:758-799` — `appends one node.created event carrying the resolved actor` reads the `event` **table** (`rows.length === 1`), but `build()` wires `createRecordingEventLog()` (a fake whose `append` only pushes into `recorded` and never persists). Probe of the production module with the exact fixture shape: the `event` table holds 0 rows after a successful create, while the fake records `["node.ready", "node.created"]` in that order (readiness appends inside `mutateGraph` before the command's own append). The assertion cannot pass against any correct implementation. Recommended fix, in the TE's lane: assert the fake instead — `fixture.recorded.find((a) => a.input.type === "node.created")` with `input.actorKind`, `input.actorId` and `input.payload` — matching the pattern import-plan.test.ts already uses; or wire a real `SqliteEventLog({ storage, ids })` into `build()` and note that every `build()` ulid list then needs one extra ulid for the `event` mint (`createMockIdGenerator` throws `ids-exhausted` past the list).
  **Refactor.** none named in Story 9 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (new file): exit 0
- behavior probe (production module, not a test run): empty-project create returns the minted id/revision, `completeness = ["initiative-without-objective"]`, one `plan_revision` row `origin "node-write"` with three nulls, exactly one `mutateGraph` call with no `trigger` key, the recorded promotion transition, stored state `ready`, and `updated_at` = the single clock read; the event-table emptiness above. Probe file removed after the run.
  **Assumptions.**
- VERIFIED: `NodeWriteError("stale-revision", …)` details deep-equal `{ guard: "project", expected: newest, actual: input.fromRevision }` — `revisionGuardFor("create")` returns `"project"` (`revision-guard.ts:12-14`), and the guard comparison runs inside the transaction, so a refusal rolls back every write (`BEGIN IMMEDIATE` + rollback), which the row-count assertions observe.
- VERIFIED: the event `payload.parentId` is the new node's parent (`null` for an initiative) — `JSON.stringify` keeps `"parentId": null`, matching the test's deep-equal on the parsed payload.

ATTEMPT-FAILED: Task 9 — one TE fixture defect: `appends one node.created event carrying the resolved actor` reads the `event` table while `build()` wires a recording fake that never persists (probe-verified 0 rows, `node.created` only in `fixture.recorded`); the other 23 tests are implemented per the Story and pass the behavior probe.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 9 confirm-GREEN + Story 10 updateNode (RED)

**Cycle.** Confirm GREEN for Task 9 (`src/commands/node/create-node.test.ts`), then RED for Task 10 (`10-update-node`): `src/commands/node/update-node.test.ts`, new.

**Confirm GREEN (Story 9).**

- The SE's Story-9 GREEN raised one `OPEN:` in my lane: `appends one node.created event carrying the resolved actor` read the `event` table while `build()` wires a recording fake that never persists (probe-verified 0 rows). Fixed per the SE's recommended pattern, the one import-plan.test.ts already uses: the test now asserts `fixture.recorded` — the single `node.created` append, `input.actorKind === "harness"`, `input.actorId` and `input.payload` deep-equal `{ kind, parentId, revision }`.
- A second defect surfaced in the same confirm, also mine: `export bytes equal the accepted blob` failed because the seeded baseline `revision_a` sorts ABOVE every minted ULID revision bytewise (`'a' > '0'`), so `PlanStore.newestRevision` (`ORDER BY id DESC`) never advances past the seed — `exported.revision` stays `revision_a` after a create. The production code is right (every production revision is a minted ULID); the fixture is not. Fixed with `nodeBaselineRevision = "revision_00000000000000000000000000"` and `reseedBaselineRevision(storage)` in `test/helpers/plan.ts` (copy the baseline row as `origin: 'node-write'` with null provenance — a straight copy collides with `UNIQUE (project_id, import_id)` — re-stamp the `node.revision` columns, delete `revision_a`), applied inside `build()` of both node-command test files. Without it the Story-10 guard assertions and the concurrency proof (`R2.parentId === R1`, `exportPlan reports R2`) are unassertable.
- **Layout-test amendment, flagged for the human's review.** Story 8 mandates `src/commands/node/refusal.ts` as the shared refusal module of the three node commands; `create-node.ts` importing it trips the pre-existing `no file under src/commands/ imports another command module` assertion (green at Story 6, red since Story 9 landed). `npm run verify` runs the full suite, so the EPIC gate needs the test amended: it now exempts exactly the resolved path `node/refusal.ts`; every other commands→commands import is still flagged.
- command: `node --test src/commands/node/create-node.test.ts` → pass 24, fail 0; `node --test src/domain/layout.test.ts` → pass 100, fail 0; full confirm run (create-node, layout, export-plan, import-plan, sqlite, node-write-legality, plan-choice, revision/node-write) → pass 287, fail 0.
  **Test written.**
- file: `src/commands/node/update-node.test.ts` (new) — suite `src/commands/node/update-node.test` — 28 methods:
  - `a title edit succeeds at every state` — all eight `nodeStates`, title-only update, success each time;
  - `a structural edit succeeds at pending, ready and blocked and is illegal-transition at the other five` — depends_on edit per state; `details.nodes` deep-equal `[{ id, state }]` on each refusal;
  - `a field-only update at the node revision succeeds and the same request at the project revision is stale-revision` — preamble edit mints R1; node-revision success then `details` `{ guard: "node", expected, actual }`;
  - `a depends_on change at the node revision is stale-revision with guard project and succeeds at the project revision`;
  - `a parent change classifies as topology and a worker and a repo change as fields` — parent at the node revision refused with `guard: "project"`, worker and repo edits at the node revision succeed (repo target seeded bound);
  - `the concurrency proof: two field-only updates at their own node revisions make a linear chain` — `R2.parentId === R1`, `acceptedBlob(R2)` holds both titles, `exportPlan` reports R2, export bytes equal the blob through `Buffer.compare`, each node `revision` column holds R1/R2;
  - eight named structural refusals, one test each (`parent-missing`, `worker-unknown`, `repository-unknown`, `repository-unbound`, `reference-unresolved`, `dependency-cross-parent`, `dependency-self`, `dependency-cycle`) — `plan-invalid`, the code by name in `details.findings`, node/edge/plan_revision counts equal before and after;
  - `a parent move of a task holding a workspace is binding-in-use` — `details.blockers` deep-equal `[{ nodeId, blocker: "workspace" }]`;
  - `an objective move uses the subtree facts` — lease on a descendant task, blocker `lease`;
  - `an empty differing-field set still mints a revision` — new `plan_revision` row, `node.revision` moved to it;
  - `an update that empties an objective succeeds and reports the finding` — `completeness` names `objective-without-task`, `showNode` keeps the objective `ready`, `plan.import` of the export at the returned revision answers with the same code;
  - `an update that adds an unsatisfied dependency to a ready node demotes it` — stored `pending`, recorded transition `[{ nodeId, from: "ready", to: "pending", trigger: "readiness-demoted" }]`, one `node.pending` append with `actorKind: "daemon"` in the same transaction;
  - `an update that removes the same dependency promotes it back` — `ready`, trigger `readiness-promoted`, one `node.ready` append with `actorKind: "daemon"`;
  - `export bytes equal the accepted blob` — `exported.revision === result.revision` and `Buffer.compare` against the minted revision's `acceptedBlob`;
  - `appends one node.updated event whose payload lists the differing fields` — payload `{ fields: ["title", "worker"], revision }` exactly;
  - `calls mutateGraph exactly once and setNodeState never` — recorded call list `["mutateGraph"]`, no `trigger` key;
  - `edge reconciliation deletes before it inserts` — one recorded `mutateGraph` input with `deleteEdgeIds` `["edge_fixture_swap"]` and one `insertEdges` entry `{ id: "edge_<minted>", fromNode, toNode }`, contents asserted;
  - `an update that drops a waived edge is refused` — `binding-in-use`, blocker `waived-edge`, the edge and its `waived_at` survive, no `plan_revision` row added;
  - `an update that keeps a waived edge succeeds`;
  - `a kind change is kind-mismatch and writes nothing` — `details` `{ expected: "task", actual: "objective" }`, counts equal;
  - `one clock read per command` — the edited node's `updated_at` is the first clock read, the distinct set over all nodes is exactly `{1, CLOCK_START}`.
- file: `test/helpers/rows.ts` (edited) — `seedNodeState`, `seedWaivedEdge`, `seedWorkspaceOnNode`, `seedLeaseOnNode` (raw node/edge/workspace/lease writes live under `test/helpers`, outside the `no-restricted-syntax` glob that covers `src/**/*.ts`).
- asserts: the Story-10 contract — state legality, the three guard classes, the concurrency chain, the eight reachable codes, the containment blockers, the waived-edge refusal, the empty-field mint, the completeness report and the re-import, the demote/promote readiness events, the recorded-mutation and payload assertions, the single clock read.
  **RED proof.**
- command: `node --test src/commands/node/update-node.test.ts`
- exit: 1 — fail 28, pass 0; failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/commands/node/update-node.ts' imported from .../src/commands/node/update-node.test.ts` (whole file at load).
- typecheck: exit 2 — exactly `src/commands/node/update-node.test.ts(4,28)` and `(8,8)` TS2307 for `./update-node.ts` plus one TS7006 cascade (`finding` implicit any on the untyped `reimport.completeness`); nothing else anywhere.
- lint: `npx eslint src/commands/node/update-node.test.ts test/helpers/plan.ts test/helpers/rows.ts src/domain/layout.test.ts` — 2 `boundaries/no-unknown-dependencies` on the two missing-seam imports only; helper and layout files clean; no `no-restricted-syntax` (raw node/edge writes only in `test/helpers`, all seeding through `plan.mutateGraph`).
- stub probe: `src/commands/node/update-node.ts` — the Story's exact declarations (`NodeUpdateBody` three-member union, `UpdateNodeInput`, `UpdateNodeResult`, `updateNode` throwing) — clean: typecheck exit 0; the probe run is fail 28, every failure `Error: stub` or `expected a NodeWriteError, got Error: stub` (no assertion error, no fixture defect). The probe surfaced one own-type error first: `Partial<UpdateNodeInput["node"]>` widened `kind` in the body helpers (`"objective" | "task"` not assignable) — fixed with `Extract`-typed override records. Stub deleted before handoff; `ls src/commands/node/` holds only the two test files, `create-node.ts` and `refusal.ts`, no trace.
- expected red elsewhere (recorded, not touched): `parity.test.ts`/`route.test.ts` still red from Story 1 until Story 13, unchanged.
  **Open to Software Engineer.**
- `src/commands/node/update-node.ts` — the Story-10 seam: `NodeUpdateBody` (the same three-member discriminated union as Story 9, declared here), `UpdateNodeInput` `{ id, fromRevision, node, actor: ActorRow }`, `UpdateNodeResult` `{ revision, completeness }`, `UpdateNodeDependencies` the same eight members as `CreateNodeDependencies`, and `updateNode(dependencies, input)` running the story's step list in order: the single clock read first; `node-not-found`; `kind-mismatch` at a submitted/stored kind mismatch (`details` `{ expected, actual }`); repo-name resolution and the stored instruction/acceptance hashes; `differingFields` with the two `blobs.hash`es computed without writing; the `update-topology`/`update-fields` classification and `revisionGuardFor`; the guard compare (`node` class against the stored `node.revision`, `project` class against `newestRevision`), mismatch → `NodeWriteError("stale-revision", ..., { guard, expected, actual })`; `readContainmentFacts` for a task and `readSubtreeContainmentFacts` for an objective or initiative, `containmentMovable`, `nodeWriteLegality` with `state` → `illegal-transition` `{ nodes: [{ id, state }] }` and `containment` → `binding-in-use` `{ blockers }` (one entry per true fact, in the declared order); mint + newest read; blob puts; the in-memory post-write node set with the edited node stamped `revision: revisionId`, `updatedAt: at`, dependencies deduplicated and bytewise-sorted; `validateCandidateStructural` → `plan-invalid` `{ findings }`; `Revision.render`; `Revision.record`; the waiver check — any computed edge delete holding non-null `waived_at` → `binding-in-use` `{ blockers: [{ nodeId, blocker: "waived-edge" }] }` before any write; one `mutateGraph` with the changed node, the delete-then-insert edge reconciliation (delete stored pairs absent from the wanted set, insert wanted pairs absent from the stored set sorted by `fromNode` then `toNode`), `nodeDeletes: []`, `at`, `cause: { revision: revisionId, importId: null }`, no `trigger` member; `validateCandidateCompleteness` for the response; one `node.updated` event with `payload: { fields, revision: revisionId }`; the return. Eight structural codes reachable (the six of Story 9 plus `dependency-self` and `dependency-cycle`); `setNodeState` never; an empty differing-field set still mints a revision.
- Do not touch the test file or `test/helpers/` — everything test-side already landed in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 10 updateNode (GREEN, one TE fixture defect raised OPEN)

**Cycle.** GREEN for `src/commands/node/update-node.test.ts` (RED turn).
**Files changed.**

- `src/commands/node/update-node.ts` (new) — `NodeUpdateBody` (the same three-member discriminated union as Story 9, declared here), `UpdateNodeDependencies` (the same eight members as `CreateNodeDependencies`), `UpdateNodeInput` `{ id, fromRevision, node, actor }`, `UpdateNodeResult` `{ revision, completeness }`, and `updateNode` running the Story's eighteen steps in order inside one `storage.transact`: the single clock read (`at`) first; `node-not-found`; `kind-mismatch` with `{ expected, actual }`; repo name→id resolution; `differingFields` against a `ResolvedDocument`-shaped value with the two submitted blob hashes computed through `blobs.hash` without writing; the `update-topology`/`update-fields` classification through `revisionGuardFor`; the guard compare (`node` class against `before.revision`, `project` class against `newestRevision`), mismatch → `stale-revision` `{ guard, expected, actual }`; `readContainmentFacts` (task) / `readSubtreeContainmentFacts` (objective, initiative), `containmentMovable`, `nodeWriteLegality` with `state` → `illegal-transition` `{ nodes: [{ id, state }] }` and `containment` → `binding-in-use` `{ blockers }` (one entry per true fact in the declared order `lease`, `workspace`, `attempt-commit`, `retained-commit`); mint + newest read; blob puts; the in-memory post-write `after` set with the edited node stamped `revision: revisionId`, `updatedAt: at` and deduplicated bytewise-sorted dependencies; the `source: "database"` candidate with repository names mapped; `validateCandidateStructural` → `plan-invalid` `{ findings }`; `Revision.render`; `Revision.record` with the parent read inside the transaction; the delete-then-insert edge reconciliation keyed on `(fromNode, toNode)` (deletes in stored order, inserts sorted by `fromNode` then `toNode`), the waiver check refusing `binding-in-use` `{ blockers: [{ nodeId, blocker: "waived-edge" }] }` when any computed delete holds a non-null `waived_at`; one `mutateGraph` with the changed node, `nodeDeletes: []`, `at`, `cause: { revision: revisionId, importId: null }` and no `trigger` member; `validateCandidateCompleteness` for the response; one `node.updated` event with `payload: { fields, revision: revisionId }`; the return. An empty differing-field set still mints a revision.
  **Seam (GREEN).** The test drives `updateNode` through real SQLite plus the recording `PlanStore`; the field/topology classification makes the `node`-guard tests pass at the node revision and the `project`-guard tests refuse at it with the exact `details` triples, `nodeWriteLegality` answers the three-state legality and the containment blockers, the in-memory `after` set feeds the shared `Revision.render` so `exported.revision` equals the minted revision and the bytes equal the `acceptedBlob`, the single `clock.now()` read stamps `updated_at`, the recording store observes exactly one `mutateGraph` call with no `trigger` key, the readiness pass inside the store demotes/promotes with `readiness-demoted`/`readiness-promoted`, and the waiver check runs before `mutateGraph` so the refusal writes nothing.
  **Blocked — `OPEN:` (TE lane).**
- `src/commands/node/update-node.test.ts:999` — `an update that empties an objective succeeds and reports the finding` re-imports with `validatedRevision: null` while `newestRevision` is non-null (`revision_<U_REV>`), and `src/commands/plan/import-plan.ts:175` throws `choices-stale` on that pair. Probe of the production modules with the exact fixture shape: `ImportPlanError(choices-stale)`; the same call with `validatedRevision: exported.revision` succeeds (`PROBE-7`). The one-line fix, in the TE's lane: `validatedRevision: exported.revision`.
  **Refactor.** none named in Story 10 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (new file): exit 0
- behavior probe (production module, not a test run): demote/promote transitions with their triggers, one `mutateGraph` call with no `trigger` key, `node.pending` with `actorKind: "daemon"` in the same transaction, the `node.updated` payload `{ fields: ["depends_on"], revision }`, both guard classes with exact `stale-revision` details, `illegal-transition` at `running` with a successful prose edit beside it, the waived-edge refusal with the edge and its `waived_at` surviving, the workspace containment blocker, and the choices-stale reimport defect above. Probe file removed after the run.
  **Assumptions.**
- VERIFIED: the `repo` diff compares the resolved repository **id** against the stored id (`submitted.repo: repositoryId`), so a resubmitted unchanged repo is not a differing field; the candidate still carries the submitted repo **name** for the edited node, matching `createNode` and the name-keyed `ValidationContext`.
- VERIFIED: the readiness demotion is real — `satisfiesDependency` (`src/domain/readiness.ts:10`) treats `ready` as unsatisfied, so a `depends_on` edge to a `ready` node demotes the edited `ready` node, exactly what the tests pin.
- VERIFIED: `blobs.hash` is pure (no transaction), so the step-4 comparison computes both submitted hashes without writing.

ATTEMPT-FAILED: Task 10 — one TE fixture defect: the reimport in `an update that empties an objective succeeds and reports the finding` passes `validatedRevision: null` at a non-null newest, which `import-plan.ts:175` refuses with `choices-stale` (probe-verified; `validatedRevision: exported.revision` fixes it); the other 27 tests are implemented per the Story and pass the behavior probe.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 11 deleteNode (RED, after Story 10 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 10 (`src/commands/node/update-node.test.ts`), then RED for Task 11 (`11-delete-node`): `src/commands/node/delete-node.test.ts` (new) and the Story-11 store tests in `src/services/plan/sqlite.test.ts` (present in the tree when this turn opened, verified live against the stub this turn).

**Confirm GREEN (Story 10).**

- The SE's Story-10 GREEN raised one `OPEN:` in my lane: the reimport in `an update that empties an objective succeeds and reports the finding` passed `validatedRevision: null` at a non-null newest, which `import-plan.ts:175` refuses with `choices-stale`. The recommended fix (`validatedRevision: exported.revision`) is already in the tree at `update-node.test.ts:1031`.
- command: `node --test src/commands/node/update-node.test.ts` → pass 28, fail 0. Story 10 is green.
  **Test written.**
- file: `src/commands/node/delete-node.test.ts` (new) — suite `src/commands/node/delete-node.test` — 24 methods: `deletes an objective and every task under it` (deleted list bytewise, `plan_revision` +1 with `origin node-write`, three null provenance columns, `parent_id` = the project revision); `removes every edge touching the subtree` (whole `edge` table read: surviving edge only, no row whose `from_node`/`to_node` is absent from `node`); `refuses a stale project revision` (`{ guard: "project", expected, actual }`, counts equal); `refuses a subtree node in a non-deletable state` (`{ nodes: [{ id, state: "done" }] }`); seven blocker refusals (`a lease/workspace/run/attempt/commit/check-result/git-operation blocks the delete`, each with the blocker name in `details.blockers` and the whole database byte-identical before and after through `databaseBytes`); `a run with an attempt reports both blockers` (deep-equal `[run, attempt]` in the declared order); `a waived edge refuses the delete` (edge and its `waived_at` survive); `the refusal order is state, then execution, then waiver` (all three seeded, `illegal-transition` reported); `restamps only the survivors whose dependency set shrank` (restamped carries the minted revision and the single clock read, every other node byte-identical); `deletes child-first` (custom tree `initiative_zzzz`/`objective_aaaa`/`task_bbbb` — identity order contradicts depth order — recorded `nodeDeletes` child-first, response `deleted` bytewise); `a released lease blocks the delete` (`owner = NULL` row still blocks); `one clock read per command` (two restamped dependents, both `updated_at === CLOCK_START`, distinct set `{1, CLOCK_START}`); `promotes a dependent that loses its only dependency` (`ready`, one `node.ready` event with `actorKind: "daemon"` in the same transaction, trigger `readiness-promoted`, no demote anywhere); `never demotes` (no transition on a plain delete); `reports completeness and refuses nothing` (`["objective-without-task"]`, objective unchanged); `export bytes equal the accepted blob` (`exported.revision === result.revision`, `Buffer.compare`); `appends one node.deleted event per deleted node in bytewise identity order, carrying the resolved actor` (harness actor on both); `calls mutateGraph exactly once and setNodeState never` (recorded call list `["mutateGraph"]`, no `trigger` key). `assertNoOrphanedLease` runs after the three success fixtures.
- file: `src/services/plan/sqlite.test.ts` (in tree; Story-11 store block, verified this turn) — `readSubtree orders by depth descending then id ascending` (three-level tree, two siblings at one depth, exact array) and the four `readSubtreeExecutionFacts` methods (clean subtree → `[]`; one fact per blocker; dedup of a repeated pair; node-bytewise-then-blocker-order sort).
- asserts: the Story-11 Verify contract — subtree cascade with bytewise response, the three refusals in the declared order, the seven closed blockers with byte-identical databases, the attempt/run pair, the released lease, child-first `nodeDeletes`, survivor-only restamp, single clock read, the promotion with its readiness event, completeness reporting, export↔accepted-blob byte equality, the per-node `node.deleted` events with the resolved actor, the one `mutateGraph` call.
  **RED proof.**
- command: `node --test src/commands/node/delete-node.test.ts src/services/plan/sqlite.test.ts`
- exit: 1 — `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/commands/node/delete-node.ts'` (whole delete suite at load) and `SyntaxError: The requested module '../../domain/plan-graph.ts' does not provide an export named 'executionBlockers'` (whole sqlite suite at load). Both fail for the one reason: the Story-11 seams do not exist.
- typecheck: exit 2 — 17 errors, every one on the missing Story-11 seams (TS2307 ×2 + one TS7006 cascade in `delete-node.test.ts`; TS2305/TS2339 ×7 in `sqlite.test.ts`; TS2353/TS2339 ×7 in the `test/helpers/plan.ts` recording wrapper's `readSubtree`/`readSubtreeExecutionFacts` passthroughs). Nothing elsewhere.
- lint: `npx eslint` on both files — 2 `boundaries/no-unknown-dependencies` on the `./delete-node.ts` imports only (clear the moment the SE creates the seam; commands → commands is allowed); no `no-restricted-syntax` (all node/edge writes go through `plan.mutateGraph` and the `test/helpers` seeders).
- stub probe: stubbed `src/commands/node/delete-node.ts` (the Story's exact declarations, `deleteNode` throwing) plus `executionBlockers`/`SubtreeExecutionFact` in `plan-graph.ts` and `readSubtree`/`readSubtreeExecutionFacts` on `PlanStore` + `SqlitePlanStore` — typecheck exit 0; probe run: `delete-node.test.ts` fail 24, every failure `Error: stub` or `expected a NodeWriteError, got Error: stub` (no fixture defect, no assertion error); `sqlite.test.ts` pass 54, fail 5 (`Error: stub` on the store methods only — the other 54, Story-4 store tests included, pass). Stubs deleted before handoff; `ls src/commands/node/` holds the two test files plus the SE's three files, no trace.
- **Recovery note — reconstruction, verified equivalent.** Reverting the probe stubs with `git checkout` also reverted the uncommitted Story-4 work in `src/services/plan/index.ts` and `src/services/plan/sqlite.ts` (the whole epic's work sits uncommitted on top of c77a57e, so a checkout of those paths discards it). I reconstructed both files from the SE's Story-4 change list and the pinned tests (`RevisionRecord.origin` + nullable trio, `MutateGraphInput.nodeDeletes`, `SELECT_REVISION`/`RevisionRow` origin, `DELETE_NODE` above `INSERT_NODE`, the eight-column `insertRevision`, the `nodeDeletes` loop after the edge deletes and before the edge inserts and the readiness pass, `origin` through both mappers). Verification: `npm run typecheck` shows the identical pre-turn error set (17 errors, all Story-11 seams, none in the two files); `sqlite.test.ts` passes 54/54 non-seam tests against a temporary `executionBlockers` stub; the consumer sweep is green — create-node 24, update-node 28, export-plan, import-plan, validate-plan, http/server plan import + export, idempotency, main.readiness, revision/node-write, list-revision: 118 + 97 pass, 0 fail. `git status` matches the pre-turn modified set plus this turn's test file.
- expected red elsewhere (recorded, not touched): `parity.test.ts`/`route.test.ts` still red from Story 1 until Story 13, unchanged.
  **Open to Software Engineer.**
- Story 11 seam, per `11-delete-node.md`: `src/domain/plan-graph.ts` — `executionBlockers` (the seven-name `as const` tuple), `ExecutionBlocker`, `SubtreeExecutionFact`. `src/services/plan/index.ts` + `sqlite.ts` — `PlanStore.readSubtree(transaction, nodeId): readonly string[]` (the depth-carrying recursive CTE, `ORDER BY depth DESC, id ASC`) and `readSubtreeExecutionFacts(transaction, nodeId): readonly SubtreeExecutionFact[]` (the seven fixed queries; the `lease` query carries **no** `owner IS NOT NULL` filter; dedup to one entry per `(nodeId, blocker)` pair, sorted by `nodeId` bytewise then by blocker position). `src/commands/node/delete-node.ts` — `DeleteNodeDependencies` (the same eight members as `CreateNodeDependencies`), `DeleteNodeInput` `{ id, fromRevision, actor }`, `DeleteNodeResult` `{ revision, deleted, completeness }`, `deleteNode(dependencies, input)` running the story's steps in order: `node-not-found`; the project-class guard (`revisionGuardFor("delete")`) with `stale-revision` `{ guard: "project", expected, actual }`; the single clock read; `readSubtree`; the three refusals in the declared order — state (`illegal-transition` `{ nodes }`, sorted bytewise), execution (`binding-in-use` `{ blockers }`), waiver (`binding-in-use` `{ blockers: [{ nodeId, blocker: "waived-edge" }] }`); mint + newest; the in-memory `after` set with every survivor whose dependency set shrank restamped (`revision: revisionId`, the single clock read); `Revision.render`; `Revision.record` with `parentRevision: newest`; one `mutateGraph` with the restamped survivors in bytewise id order, `insertEdges: []`, `deleteEdgeIds` bytewise, `nodeDeletes` exactly as `readSubtree` returned it, and `cause` with the minted revision; one `node.deleted` event per deleted node in bytewise identity order carrying the resolved actor; response `deleted` sorted bytewise and `completeness` from `validateCandidateCompleteness`. `setNodeState` never; no `trigger` member. Do not touch the two test files or `test/helpers/` — everything test-side already landed.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 11 deleteNode (GREEN)

**Cycle.** GREEN for `src/commands/node/delete-node.test.ts` + `src/services/plan/sqlite.test.ts` (RED turn).
**Files changed.**

- `src/domain/plan-graph.ts` (edited) — `executionBlockers` (the seven-name `as const` tuple), `ExecutionBlocker`, `SubtreeExecutionFact`.
- `src/services/plan/index.ts` (edited) — `PlanStore` gains `readSubtree(transaction, nodeId): readonly string[]` and `readSubtreeExecutionFacts(transaction, nodeId): readonly SubtreeExecutionFact[]`.
- `src/services/plan/sqlite.ts` (edited) — `readSubtree` runs the depth-carrying recursive CTE, `SELECT id FROM descendant ORDER BY depth DESC, id ASC`; `readSubtreeExecutionFacts` resolves the subtree with the plain CTE, runs one fixed query per blocker over the id set (the `lease` query carries **no** `owner IS NOT NULL` filter — a released lease row still names its node and no FK guards it), dedupes to one entry per `(nodeId, blocker)` pair, sorts by `nodeId` bytewise via `Buffer.compare` then blocker position in `executionBlockers`.
- `src/commands/node/delete-node.ts` (new) — `DeleteNodeDependencies` (the same eight members as `CreateNodeDependencies`), `DeleteNodeInput` `{ id, fromRevision, actor }`, `DeleteNodeResult` `{ revision, deleted, completeness }`, `deleteNode` running the Story's fourteen steps in order inside one `storage.transact`: `node-not-found`; the project-class guard (`revisionGuardFor("delete")`) with `stale-revision` `{ guard: "project", expected: newest, actual: input.fromRevision }`; the single clock read (`at`); `readSubtree`; the three refusals in the declared order — state (`illegal-transition` `{ nodes }`, sorted bytewise by id) over the deletable `pending`/`ready`/`blocked` set, execution (`binding-in-use` `{ blockers }` straight from the store read), waiver (`binding-in-use` `{ blockers: [{ nodeId, blocker: "waived-edge" }] }`, one entry per subtree node a waived edge touches, deduplicated, sorted bytewise); mint; the in-memory `after` set with every survivor whose dependency set shrank restamped (`revision: revisionId`, `updatedAt: at`); `Revision.render`; `Revision.record` with `parentRevision: newest`; one `mutateGraph` with the restamped survivors in bytewise id order, `insertEdges: []`, `deleteEdgeIds` (every edge touching the delete set, sorted bytewise), `nodeDeletes` exactly as `readSubtree` returned it (child-first), `at`, `cause: { revision: revisionId, importId: null }`; `validateCandidateCompleteness` over a `source: "database"` candidate built from `after` with repository names mapped (the create-node idiom); one `node.deleted` event per deleted node in bytewise identity order with `payload: { kind, parentId, revision: revisionId }`; the response with `deleted` bytewise-sorted. `validateCandidateStructural` is **not** called (a delete reaches no structural code), `setNodeState` never, no `trigger` member.
  **Seam (GREEN).** The command tests drive `deleteNode` through real SQLite plus the recording `PlanStore`; the guard details, the three refusal orders and the `node.deleted` event order read the same code paths the tests assert, `readSubtree` supplies the child-first `nodeDeletes` that defeats the fixture's identity order, the restamp/readiness interplay (promotion with `readiness-promoted`, never a demote) comes from the store's existing readiness pass inside the single `mutateGraph`, and the store tests pin the two new reads directly, `executionBlockers` imported from `plan-graph.ts`.
  **Refactor.** none named in Story 11 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (the four changed/new files): exit 0 — no `no-restricted-syntax` (all node/edge writes go through `plan.mutateGraph`; the command's own SQL is read-only)
- behavior probe (production modules, not a test run): delete of an objective returns `deleted` `[objective_01BQ…, task_01DR…]` bytewise, one `plan_revision` row with `origin: "node-write"`, three null provenance columns and `parent_id` = the baseline revision, `exported.revision === result.revision`, export bytes equal the `acceptedBlob` through `Buffer.compare`, exactly one recorded `mutateGraph` call, completeness `["initiative-without-objective"]` on that fixture; the all-three-refusals fixture throws `illegal-transition` with `details.nodes` naming the single `done` task. Probe file removed after the run.
  **Assumptions.**
- VERIFIED: `deleted` in the response and the event order are bytewise id order while `nodeDeletes` is `readSubtree`'s depth order — the Story's step 11 and step 14 name the two different orders explicitly, and the child-first test reads the recorded `mutateGraph` input for one while asserting the other on the response.
- VERIFIED: the restamp marker is the shrunken dependency set, not revision equality — a survivor whose dependencies changed is the only node carrying the freshly minted revision, so the `nodes` upsert list is exactly the restamped set.
- VERIFIED: `deletableStates.includes(node.state)` needs the `(deletableStates as readonly string[])` cast under the tuple's narrower `includes` parameter — the same idiom `node-write-legality.ts` already uses.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 12 project-binding-invariant (RED, after Story 11 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 11 (`src/commands/node/delete-node.test.ts`, `src/services/plan/sqlite.test.ts`), then RED for Task 12 (`12-project-binding-invariant`): `src/commands/project/replace-project-repositories.test.ts` (edited), `src/http/server/project/replace-project-repositories.test.ts` (edited), `src/http/contract/project.test.ts` (new), `src/http/contract/coverage.test.ts` (edited — compat).

**Confirm GREEN (Story 11).**

- First confirm run was red: fail 8, and every one was a **test-side fixture defect of mine**, masked in the RED turn by the seam stub (the SE's GREEN probed production behaviour and could not see them; the failing tests died in fixture setup before reaching the seam). `npm run verify:handoff` passed. All eight fixed in my lane, in this turn:
  - `removes every edge touching the subtree` — `deepEqual` on `[Object: null prototype]` rows vs plain literals; expected now built by spread-normalising the read.
  - `a run blocks the delete`, `an attempt blocks the delete`, `a commit blocks the delete`, `a run with an attempt reports both blockers` — `seedRunOnTask` passed `kind: "task"` with `parentRunId: null`, violating the run CHECK `(kind = 'objective') = (parent_run_id IS NULL)`; the helper now seeds an objective run (parent null) then the task run under it, and the attempt/candidate rows name the task run.
  - `restamps only the survivors whose dependency set shrank` — the loop compared every `before` row including the deleted node; it now skips the deleted id.
  - `readSubtree orders by depth descending then id ascending` — `seedSecondRevisionWithTask` (rows.ts) inserted `plan_revision` without `origin` against the version-6 schema; now version-aware like `seedGraph`.
  - `readSubtreeExecutionFacts deduplicates a repeated pair` — two workspaces on one node are impossible (`workspace.node_id UNIQUE`); the fixture now uses two runs on the same node (one `ended` — `seedRunRow` gains an optional `state`), which the production query reads as one deduplicated `{ nodeId, blocker: "run" }` fact.
- command: `node --test src/commands/node/delete-node.test.ts src/services/plan/sqlite.test.ts` → pass 83, fail 0. Sweep with the node-command and revision suites: pass 244, fail 0. Story 11 is green.

**Test written.**

- file: `src/commands/project/replace-project-repositories.test.ts` (edited) — suite `src/commands/project/replace-project-repositories.test` — methods:
  - `refuses a drop of a repository a stored objective names` — `ReplaceProjectRepositoriesError` with `refusal === "binding-in-use"`, the exact message `a stored objective names a repository the new set drops`, `details` deep-equal `{ blockers: [{ nodeId: fixtureIds.objective, blocker: "repository-bound" }] }`, `project_binding` rows byte-identical before and after;
  - `lists every blocked objective, sorted bytewise` — second objective seeded through `plan.mutateGraph` with id `objective_0` (sorts before `objective_a`, inserted after it); `details.blockers` deep-equals `[objective_0, objective_a]` in bytewise order;
  - `allows a drop of a repository no node names` — repository `repo_b` inserted, no graph; replacement with `[repo_b]` succeeds and the git binding target is `repo_b` (intended pass today: current code refuses nothing — the pin the Story demands);
  - `allows a replacement that keeps every named repository` — graph objective names `repo_a`, replacement `[repo_a]` succeeds (intended pass today);
  - `an objective in another project never blocks` — second project `project_b` with an objective naming `repo_a` (seeded via `mutateGraph`); first project's replacement with `[]` succeeds and its git bindings are empty (intended pass today — sensitive to the scoping: an unscoped `readGraph` would refuse it);
  - `refuses before it writes` — provider binding seeded beside the git one; refusal path leaves the row count and every row unchanged;
  - plus the local `ReplaceProjectRepositoriesDependencies` type gains `plan: PlanStore` and all 12 existing call sites gain `plan: createPlanStore()` (compat — the Story's deps change would otherwise break the SE's handoff typecheck in this file).
- file: `src/http/server/project/replace-project-repositories.test.ts` (edited) — `PUT dropping a repository a stored objective names answers 409 binding-in-use` — status 409, `error.code === "binding-in-use"`, `details.blockers` deep-equal `[{ nodeId: fixtureIds.objective, blocker: "repository-bound" }]`; the three existing wiring sites gain `plan`.
- file: `src/http/contract/project.test.ts` (new) — suite `src/http/contract/project.test` — `project.repositories declares binding-in-use in its errors map` (the operation entry's `errors["binding-in-use"]` is a zod schema) and `the binding-in-use envelope carries a blockers details list` (the operation's envelope admits the code with a blockers details payload). The inner blocker shape is currently the shared `bindingInUseDetails` shape; Story 13 re-shapes that schema and owns the fixture update.
- file: `src/http/contract/coverage.test.ts` (edited) — compat: `operationAdditions` gains `"project.repositories": ["binding-in-use"]`, so the per-operation error-addition assertion is red until the SE lands the errors-map change and green after.
- asserts: the Story-12 contract — the refusal with exact message and `{ blockers }` details, bytewise blocker order, byte-identical bindings on refusal, per-project scoping, kept-set tolerance, the handler 409 mapping and the contract errors-map row.
  **RED proof.**
- command: `node --test src/commands/project/replace-project-repositories.test.ts src/http/server/project/replace-project-repositories.test.ts src/http/contract/project.test.ts`
- exit: 1 — fail 6, pass 18; failures:
  - `AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:` at `assert.ok(caught instanceof ReplaceProjectRepositoriesError)` on the three refusal tests (the current code writes without refusing);
  - `AssertionError [ERR_ASSERTION]: binding-in-use is not declared on project.repositories`;
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: false !== true` (envelope without the code);
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 200 !== 409` (handler without the refusal mapping).
- The three `allows…`/`an objective…` tests pass today as characterization pins — current code refuses nothing; they pin the behaviour that must survive the SE's change, and the stub probe below proves they stay green on the corrected logic.
- typecheck: exit 2 — 24 errors, every one in my two test files (20 + 4): TS2353 excess `plan` on the call sites and TS2339 `details` on `ReplaceProjectRepositoriesError`; no error anywhere else.
- lint (six touched files, `npx eslint`): exit 0 — no `no-restricted-syntax` (all node/edge writes go through `plan.mutateGraph` and the `test/helpers` seeders; only `project`, `plan_revision`, `project_binding` and `repository` are written raw).
- stub probe: `src/commands/project/replace-project-repositories.ts` — Story-declared declarations plus the exact check (readGraph → kept set → bytewise-sorted blockers → refusal before the DELETE; `git checkout` restore verified safe: the file is unmodified from HEAD). Probe typecheck: exit 1 with exactly one error, `src/main.ts(319,40) TS2345` — the SE-lane binding the Story's Change section names; my files clean. Probe run: command suite pass 18, fail 0 (all six new tests green against the corrected logic — fixtures and assertions are right); contract suite fail 2 and handler fail 1, all three SE-lane (`project.ts` errors map, `refusals.ts` mapping — the handler answers 500 `!== 409` while the refusal is unmapped). Stub restored byte-identical; `git status` shows only the test files.
- expected red elsewhere (recorded, not touched): `parity.test.ts`/`route.test.ts` still red from Story 1; `coverage.test.ts` `every field in the registry answers…` is pre-existing — reproduced with my coverage edit stashed, so it predates this turn (Story 13's registry rows resolve it).
  **Open to Software Engineer.**
- Story 12 seam, per `12-project-binding-invariant.md`: `src/commands/project/replace-project-repositories.ts` — `ReplaceProjectRepositoriesDependencies` gains `plan: PlanStore`; `ReplaceProjectRepositoriesRefusal` gains `"binding-in-use"`; `ReplaceProjectRepositoriesError` gains `readonly details: unknown` and a third constructor parameter (the `ImportPlanError` shape); the check inserted between the per-repository existence loop and the `DELETE FROM project_binding` — read the project graph, keep-set over `input.repositories`, every node whose `repositoryId` is non-null and not kept becomes `{ nodeId, blocker: "repository-bound" }` sorted bytewise by `nodeId`, and a non-empty list throws `ReplaceProjectRepositoriesError("binding-in-use", "a stored objective names a repository the new set drops", { blockers })`. `src/http/server/project/refusals.ts` — the `binding-in-use` case maps to `httpError("binding-in-use", error.message, { blockers })` in the `ReplaceProjectRepositoriesError` switch. `src/http/contract/project.ts` — the `project.repositories` errors map gains `"binding-in-use"` with the blocker-list details schema (the shared `bindingInUseDetails`; Story 13 re-shapes it). `src/main.ts:319` — pass `plan` into the `replaceProjectRepositories` binding. Do not touch the four test files — every call-site wiring edit already landed in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 12 project-binding-invariant (GREEN)

**Cycle.** GREEN for `src/commands/project/replace-project-repositories.test.ts` + `src/http/server/project/replace-project-repositories.test.ts` + `src/http/contract/project.test.ts` (RED turn).
**Files changed.**

- `src/commands/project/replace-project-repositories.ts` (edited) — `ReplaceProjectRepositoriesDependencies` gains `plan: PlanStore`; `ReplaceProjectRepositoriesRefusal` gains `"binding-in-use"`; `ReplaceProjectRepositoriesError` gains `readonly details: unknown` and a third constructor parameter in the `ImportPlanError` shape; the check sits between the per-repository existence loop and the `DELETE FROM project_binding`: `plan.readGraph(transaction, input.id)`, keep-set over `input.repositories`, every node whose `repositoryId` is non-null and not kept maps to `{ nodeId, blocker: "repository-bound" }`, sorted bytewise through `Buffer.compare(Buffer.from(id, "utf8"))`, and a non-empty list throws `ReplaceProjectRepositoriesError("binding-in-use", "a stored objective names a repository the new set drops", { blockers })`.
- `src/http/server/project/refusals.ts` (edited) — the `binding-in-use` case maps to `httpError("binding-in-use", error.message, details(error))` with a small `details` helper in the pattern of `src/http/server/plan/refusals.ts:42-44`.
- `src/http/contract/project.ts` (edited) — the `project.repositories` errors map gains `"binding-in-use": bindingInUseDetails` (the shared blocker-list schema from `error-details.ts:19`; Story 13 re-shapes it).
- `src/main.ts` (edited) — `plan` passed into the `replaceProjectRepositories` binding at the `"project.repositories"` handler.
  **Seam (GREEN).** The command tests throw the real `ReplaceProjectRepositoriesError` whose `refusal`, exact message and `details.blockers` the assertions read; the bytewise blocker order, the byte-identical `project_binding` (the check runs before the first write), the kept-set and cross-project scoping all fall out of the same code path, the handler test maps the refusal through `toHttpError` to the declared `409 binding-in-use` envelope, and the contract test reads the operation's errors-map row.
  **Refactor.** none named in Story 12 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (the four changed files): exit 0 — no `no-restricted-syntax` (the new read is `plan.readGraph`, no raw SQL added)
- behavior probe (production modules, not a test run): drop of a bound repository throws `binding-in-use` with `details.blockers` deep-equal `[{ nodeId: "objective_a", blocker: "repository-bound" }]` and `project_binding` byte-identical before and after; a replacement that keeps the named repository succeeds; an objective in another project never blocks (graph-less `project_a2` replaced with `[]` succeeds while `project_b`'s objective names the dropped repo); the same project's own objective still refuses. Probe file removed after the run.
  **Assumptions.**
- VERIFIED: `readGraph` at `src/services/plan/sqlite.ts` filters by `project_id`, so the Story's scoping claim ("an objective in another project never blocks") holds by construction, confirmed by the probe.
- VERIFIED: `StoredNode.repositoryId` is `string | null` (`src/services/plan/index.ts:34`), so the filter must test `!== null` before `!kept.has(...)` — the Story's expression with a plain `!kept.has(repositoryId)` would refuse nodes that carry no repository.
- VERIFIED: the refusal leaves `project_binding` byte-identical because the check precedes both the `DELETE` and the inserts, inside the same transaction that rolls back on the throw.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 13 contract rows, handlers and actors (RED, after Story 12 confirm-GREEN)

**Cycle.** Confirm GREEN for Task 12 (`12-project-binding-invariant`), then RED for Task 13 (`13-contract-handlers-actors`): `src/http/contract/*.test.ts` (ten files edited), `src/http/server/route.test.ts` + `app.test.ts` + `dispatch.test.ts` (edited), `src/http/server/credential/refusals.test.ts` + `plan/refusals.test.ts` + `plan/import-plan.test.ts` + `src/commands/plan/import-plan.test.ts` (edited), `src/http/server/node/create-node.test.ts` + `update-node.test.ts` + `delete-node.test.ts` (new), `src/main.node-write.test.ts` (new).

**Confirm GREEN (Story 12).**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`; `node --test src/commands/project/replace-project-repositories.test.ts src/http/server/project/replace-project-repositories.test.ts src/http/contract/project.test.ts` → pass 24, fail 0.

**Test written.**

- `src/http/contract/path.test.ts` (edited) — sizes 15/19; `node is a subresource segment and update and delete are action segments` (member assertions + the three rendered paths).
- `src/http/contract/registry.test.ts` (edited) — `harnessOperations` gains `node.create`/`node.delete`/`node.update` bytewise (twelve members), `the harness set names node.create, node.update and node.delete`; counts raised: sixty-two, routed 35, phase-1 32, twelve write routes, thirty-four responses, twenty-five POST policies, twenty-four memory entries.
- `src/http/contract/parity.test.ts` (edited) — comparable 59→62, total 63→66 (the Story's stale 54→57/58→61 superseded by the current rows).
- `src/http/server/route.test.ts` (edited) — matrix 63→66, comparable 59→62.
- `src/http/contract/coverage.test.ts` (edited) — `operationAdditions` gains the three node ops, each `["stale-revision", "plan-invalid", "illegal-transition", "binding-in-use"]`; scoped 28→31.
- `src/http/contract/example.test.ts` (edited) — scoped 28→31.
- `src/http/contract/openapi.test.ts` (edited) — 55 paths, 62 operation ids, 82 schema components with the nine `node.create/update/delete.{error,request,response}` entries in bytewise positions.
- `src/http/server/app.test.ts` (edited) — 61→64 request set; 30→33 unimplemented. `src/http/server/dispatch.test.ts` (edited) — 30→33.
- `src/http/contract/system.test.ts` (edited) — `thirty-four registry entries carry a response and twelve carry a request` with the three ops in both lists; `planRelativePathLocations` gains `completeness.path` (planFinding's `path` member entered response schemas via `completeness` — red since Story 5, unrun; the exemption mechanism is the file's own).
- `src/http/contract/error-details.test.ts` (edited) — `staleRevisionDetails` rewritten to `{ guard: z.enum(revisionGuardClasses), expected, actual }` (guard required, `current` rejected, unknown guard rejected); `bindingInUseDetails` rewritten to `{ nodeId, blocker }` pairs (old kind-shape rejected); `illegalTransitionDetails` block (nodes with registered states, missing state rejected, unknown state rejected — no min(1), per the Story's schema).
- `src/http/contract/project.test.ts` (edited) — the Story-12 envelope fixture `{ kind: "repository", repositoryId }` → `{ nodeId: "objective_a", blocker: "repository-bound" }` (the re-shape the Story owns).
- `src/http/server/credential/refusals.test.ts` (edited) — provider removal details parse against the operation's **declared** `provider.remove` errors schema (`findOperation(...).errors["binding-in-use"]`) instead of the shared schema, which no longer accepts the kind-based blockers; the SE's reconciliation of `provider.remove` is therefore pinned by construction.
- `src/http/server/plan/refusals.test.ts` (edited) — stale details constructed `{ guard: "project", expected, actual }`.
- `src/http/server/plan/import-plan.test.ts` (edited) — `details.current` → `details.guard === "project"` + `details.actual`.
- `src/commands/plan/import-plan.test.ts` (edited) — the two stale deep-equals now `{ guard: "project", expected, actual }`.
- `src/http/contract/graph.test.ts` (edited) — the three request unions (initiative/objective/task parse; repo-on-task, missing-repo-on-objective and omitted-field reject; create's `fromRevision` nullable, update's and delete's strings), the three responses (revision string + `completeness`), and the three operation rows (POST, memory, `[200]`, `["human", "harness"]`, the four error codes).
- `src/http/server/node/create-node.test.ts` (new) — suite `src/http/server/node/create-node.test`: valid create 200 + `nodeCreateResponse` parse + non-empty revision; three 400 schema refusals (omitted field, repo-on-task, missing-repo-on-objective); 404 unknown project writes nothing; `stale-revision` with `{ guard: "project", expected: null, actual }`; 422 `plan-invalid` with the `parent-missing` finding, no write; `Idempotency-Key` replay 200 with no second `plan_revision`; harness token 200 + `provider.list` 403.
- `src/http/server/node/update-node.test.ts` (new) — suite `src/http/server/node/update-node.test`: valid field-only update 200 + `nodeUpdateResponse` parse; three 400 schema refusals; 404; `kind-mismatch` 400 with `{ expected, actual }`; node-guard stale 409 at a stale node revision; project-guard stale 409 for a `depends_on` change at the node revision (preamble title-edit of a seeded second task advances the project revision first — the command-test pattern); `illegal-transition` 409 `{ nodes }` on a running task; `binding-in-use` 409 `{ blockers: [{ nodeId, blocker: "workspace" }] }` on a parent move; 422 `dependency-self`; replay; harness 200 + 403.
- `src/http/server/node/delete-node.test.ts` (new) — suite `src/http/server/node/delete-node.test`: valid delete 200 + `nodeDeleteResponse` parse + `deleted` list; 404; project-guard stale 409; `illegal-transition` 409 `{ nodes: [{ id, state: "done" }] }`; `binding-in-use` 409 with `[run, attempt]` blockers in the declared order; replay returns the captured 200 body and not a 404; harness 200 + 403.
- `src/main.node-write.test.ts` (new) — suite `src/main.node-write.test`, in the `main.readiness.test.ts` pattern (one migrated home, one seeded database — `seedRegistry` plus a second project `project_b` with its git binding — one real daemon, recorded fetch URLs): two sequences. Sequence A (project_a, complete): create initiative (`fromRevision: null`) → create objective at R1 → stale third create at R1 (409) → `plan.export` refresh (revision == R2) → create task at R2 → create second task → title update at the task's own node revision → delete the second task (graph stays complete) → export → `plan.revisions` (newest entry id == export revision, `origin: "node-write"`) → blob fetch of the newest `acceptedBlob` → `plan.validate` (findings `[]`) → `plan.import` at the returned revision (200, completeness `[]`). Sequence B (project_b, the delete leaves the graph incomplete): same chain, the delete removes the only task; export bytes still equal the fetched blob bytes, `plan.validate` reports `["objective-without-task"]` and `plan.import` answers 200 with the same code. The guard-token assertion: `plan.revisions` was called nowhere before the third create (`planRevisionsCalls` counter, asserted 0), and the export refresh returned the second create's revision. The import choices drop the deleted node's id (a stale choice would refuse with `choice-extra`).
- asserts: the Story-13 Verify contract — the segment/action membership, the registry rows with the harness set at twelve, the raised parity/route/openapi/coverage/system counts, the re-shaped details schemas, the three request/response contracts, the three handlers' success/schema/refusal/idempotency/actor behaviour, and the route-level acceptance sequence twice.

**RED proof.**

- command: `node --test src/http/contract/*.test.ts src/http/server/node/create-node.test.ts src/http/server/node/update-node.test.ts src/http/server/node/delete-node.test.ts src/main.node-write.test.ts`
- exit: 1 — pass 203, fail 26; failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/http/server/node/create-node.ts' imported from .../src/http/server/node/create-node.test.ts` (same for update/delete); `SyntaxError: The requested module './graph.ts' does not provide an export named 'nodeCreateRequest'`; `SyntaxError: The requested module './error-details.ts' does not provide an export named 'illegalTransitionDetails'`; the count pins (`AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` on `registers sixty-two operations`, `counts routed and stubbed entries`, `counts introducedIn`, `pins the closed-array sizes`, `attaches requests to the twelve…`, `declares exactly the twenty-five POST policies`, `counts twenty-four memory-policy operations`, parity `matches the routed and stubbed matrix exactly`, `thirty-four registry entries…`, coverage/example `thirty-one…`, openapi `fifty-five/`sixty-two`/`eighty-two`, `the harness set equals the named twelve`); `Error: unknown operation id: node.create`on all seven`src/main.node-write.test` its (the daemon's registry lacks the routes until Story 13 lands).
- expected red elsewhere (recorded, not touched): the three plan-import stale suites (`commands/plan/import-plan.test.ts` ×2, `http/server/plan/import-plan.test.ts` ×1) — they assert the new `{ guard, expected, actual }` shape while `import-plan.ts:172` still throws `{ expected, current }`; `coverage.test.ts` `every field in the registry answers…` and `credential.test.ts`/`example.test.ts` envelope tests — the SE-lane reconciliation items below.
- typecheck: exit 2 — 19 errors, every one in my test files and every one on a missing Story-13 seam (TS2307/TS2305/TS2724 on the handlers, the three response schemas and `illegalTransitionDetails`; TS2345 on the three new path segments). Nothing elsewhere.
- lint: `npx eslint` on all 20 touched files — 3 `boundaries/no-unknown-dependencies`, one per missing handler import; all clear the moment the SE creates the seams. No `no-restricted-syntax` (all node/edge writes go through `plan.mutateGraph` and the `test/helpers` seeders; the acceptance test writes only `project` and `project_binding` raw).
- stub probe: stubbed the complete Story-13 seam set — `path.ts` segments, the `error-details.ts` re-shapes plus `illegalTransitionDetails`, the `graph.ts` schemas, operations and examples, the three handlers and `refusals.ts`. Typecheck exit 0; the three handler suites pass 29/29 against the real commands — fixtures, guard details, blockers, idempotency replay, harness 200/403 all verified; the contract suite fails exactly three, all SE-lane reconciliation: (1) the stale `field-decisions.fixture.ts` (red since Story 4's `origin`/nullable trio; the SE regenerates it), (2) `credential.test.ts` `every example parses…` — the re-shaped `bindingInUseDetails` no longer accepts `provider.remove`'s kind-based blockers (the SE reconciles `credential.ts`), (3) `example.test.ts` `every error example…` — `planImportExamples.error` still carries `current` against the re-shaped `staleRevisionDetails` (the SE updates it). The probe also surfaced two facts the tests pin: `context.actor` is the full `ActorRow` — the handlers pass `actor: context.actor` to the commands (which take `ActorRow`), unlike `plan.import`'s string — and `z.string()` admits `""`, so the response-revision check asserts a missing member, not an empty one. Stubs deleted before handoff; `path.ts` and `error-details.ts` restored byte-identical to HEAD (no diff), `graph.ts` restored to its pre-turn Story-4/5 state (diff unchanged), `git status` shows only the test files.
- sweep: the previously-green suites stay green — `src/commands/node/{create,update,delete}-node.test.ts`, `src/commands/project/replace-project-repositories.test.ts`, `src/domain/node-write-legality.test.ts`, `src/services/plan/sqlite.test.ts`, `src/services/revision/node-write.test.ts`, `src/http/server/project/replace-project-repositories.test.ts`, `src/queries/plan/{export-plan,list-revision}.test.ts` → pass 194, fail 0.

**Open to Software Engineer.**

- `src/http/contract/path.ts` — `subresourceSegments` gains `"node"` between `"landing-branch"` and `"plan"`; `actionSegments` gains `"delete"` between `"cancel"` and `"discard"` and `"update"` between `"unblock"` and `"validate"`.
- `src/http/contract/error-details.ts` — `staleRevisionDetails` re-shaped to `{ guard: z.enum(revisionGuardClasses), expected: z.string().nullable(), actual: z.string().nullable() }` (the `current` member is gone); `bindingInUseDetails` re-shaped to `{ blockers: z.array(z.strictObject({ nodeId: z.string(), blocker: z.string() })).min(1) }`; new `illegalTransitionDetails` `{ nodes: z.array(z.strictObject({ id: z.string(), state: z.enum(nodeStates) })) }` (no min — the tests reject a missing state and an unregistered state, not an empty list).
- `src/http/contract/graph.ts` — the three request schemas (`nodeCreateRequest` with nullable `fromRevision`, `nodeUpdateRequest` with string, `nodeDeleteRequest` strict single member) over the three-member discriminated union, the three response schemas exactly as the Story declares them, and the three operations after `edge.list` with `introducedIn: "phase-1"`, `status: "routed"`, `idempotency: "memory"`, `replayable: [200]`, `allowedActors: ["human", "harness"]`, the four error codes beside `baselineErrors`, and examples in the shape of `planImportExamples` (the example error details must satisfy the re-shaped envelopes — `stale-revision` carries `{ guard, expected, actual }`, `illegal-transition` carries `{ nodes }`, `binding-in-use` carries `{ blockers: [{ nodeId, blocker }] }`). The paths come from the typed segments: `[resource("project"), parameter("project"), sub("node")]`, `[resource("node"), parameter("node"), action("update")]`, `[resource("node"), parameter("node"), action("delete")]`.
- The three handlers — `src/http/server/node/create-node.ts`, `update-node.ts`, `delete-node.ts` — each in the `plan/import-plan.ts` pattern (path parameter, `safeParse`, one command call, `toHttpError`), reading the calling actor as `context.actor` — the **full `ActorRow`**, because `CreateNodeInput`/`UpdateNodeInput`/`DeleteNodeInput` carry `actor: ActorRow` (not a string like `ImportPlanInput`). `src/http/server/node/refusals.ts` maps `NodeWriteError` over its seven codes per the Story's table (kind-mismatch → `invalid-request` with the details, the rest pass their details through), exhaustive, ending `throw error`.
- `src/main.ts` — construct `NodeWriteRevision` (already present), bind the three commands with the full dependency sets (`{ storage, plan, blobs, graph, ids, clock, events, revision }`), register the three handlers.
- **The shared-schema ripples, forced by the Story's own re-shapes:** `src/commands/plan/import-plan.ts:172` — the stale-revision details become `{ guard: "project", expected: input.fromRevision, actual: newest }` (three test files already assert the new shape); `src/http/contract/graph.ts` `planImportExamples.error` — `{ expected: null, current: ... }` → `{ guard: "project", expected: null, actual: ... }`; `src/http/contract/credential.ts` — `provider.remove` still emits kind-based blockers while the re-shaped `bindingInUseDetails` no longer admits them; give `provider.remove` its own schema (its example and the credential refusals test pin the outcome — the test parses the emitted details against the operation's declared schema, so any consistent choice passes); `src/http/contract/field-decisions.fixture.ts` — regenerate the rows list to match the current registry (stale since Story 4's `origin`/nullable trio; the coverage diff names the missing/extra rows, the three new operations add theirs).
- Do not touch any test file or `test/helpers/` — every test-side edit this story requires has landed in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 13 contract rows, handlers and actors (GREEN)

**Cycle.** GREEN for the Story-13 seam set behind `src/http/contract/*.test.ts`, `src/http/server/node/{create,update,delete}-node.test.ts` and `src/main.node-write.test.ts` (RED turn).
**Files changed.**

- `src/http/contract/path.ts` (edited) — `subresourceSegments` gains `"node"` between `"landing-branch"` and `"plan"`; `actionSegments` gains `"delete"` between `"cancel"` and `"discard"` and `"update"` between `"unblock"` and `"validate"`.
- `src/http/contract/error-details.ts` (edited) — `staleRevisionDetails` re-shaped to `{ guard: z.enum(revisionGuardClasses), expected: nullable, actual: nullable }` (the `current` member is gone, both imports from `domain/`); `bindingInUseDetails` re-shaped to `{ blockers: z.array(z.strictObject({ nodeId, blocker })).min(1) }`; new `illegalTransitionDetails` `{ nodes: z.array(z.strictObject({ id, state: z.enum(nodeStates) })) }`.
- `src/http/contract/graph.ts` (edited) — `nodeInitiativeFields`/`nodeObjectiveFields`/`nodeTaskFields` strict objects, the three-member `nodeWriteFields` tuple (`as const` so `z.discriminatedUnion("kind", ...)` infers the tuple), `nodeCreateRequest` (nullable `fromRevision`) and `nodeUpdateRequest` (string) wrapping the union, `nodeDeleteRequest` strict single member; the three response schemas exactly as the Story declares; `planImportExamples.error` re-shaped to `{ guard: "project", expected: null, actual }`; `nodeCreateExamples`/`nodeUpdateExamples`/`nodeDeleteExamples` (error examples satisfy the re-shaped envelopes); three operations after `edge.list` with `POST`, `phase-1`, `routed`, `idempotency: "memory"`, `replayable: [200]`, `allowedActors: ["human", "harness"]`, the four error codes beside `baselineErrors`, paths built from typed segments.
- `src/http/contract/credential.ts` (edited) — `provider.remove` declares its own `providerBindingInUseDetails` (the pre-epic kind-based union), so the re-shaped shared schema no longer constrains it; the shared `bindingInUseDetails` import is gone.
- `src/commands/plan/import-plan.ts` (edited) — the stale-revision details at the `fromRevision !== newest` refusal become `{ guard: "project", expected: input.fromRevision, actual: newest }`; the three stale suites assert this shape.
- `src/http/server/node/refusals.ts` (new) — `toHttpError` mapping `NodeWriteError` over all seven codes per the Story table (`project-not-found`/`node-not-found` → `not-found`; `kind-mismatch` → `invalid-request` with details; the rest pass details through), exhaustive switch ending `throw error`.
- `src/http/server/node/create-node.ts`, `update-node.ts`, `delete-node.ts` (new) — handlers in the `plan/import-plan.ts` pattern: path parameter, `safeParse`, one command call, `toHttpError`; `actor: context.actor` (the full `ActorRow`, matching `CreateNodeInput`/`UpdateNodeInput`/`DeleteNodeInput`).
- `src/main.ts` (edited) — `createNode`/`updateNode`/`deleteNode` command imports, the three handler imports, and the three handler bindings with the full dependency set `{ storage, plan, blobs, graph, ids, clock, events, revision }`; `NodeWriteRevision` was already constructed.
- `src/http/contract/field-decisions.fixture.ts` (edited) — regenerated (338 → 405 rows) by the same walk as `coverage.test.ts`'s field-rows assertion: registry → `z.toJSONSchema(target: "openapi-3.0")` → emit required/nullable/enum per property, bytewise sort; the three node operations' rows are present.
  **Seam (GREEN).** The contract suites read the new segments, the re-shaped details schemas, the request/response schemas and the operation rows; the handler suites drive the real commands through the new handlers and read the `NodeWriteError` details through the mapper (stale `{ guard, expected, actual }`, `{ nodes }`, `{ blockers }`); the acceptance test launches the real daemon whose registry now contains the three routes bound in `main.ts`.
  **Refactor.** none named in Story 13 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (all eleven touched files): exit 0 — no `no-restricted-syntax`, no boundary violations (`http/contract` → `domain/` imports only)
- contract probe (production modules, not a test run): the three paths render `/v1/project/:id/node`, `/v1/node/:id/update`, `/v1/node/:id/delete`; all graph.test.ts parse cases hold (initiative/objective/task, repo-on-task and missing-repo refusals, nullable vs string `fromRevision`, `nodeDeleteRequest` string-only); registry length 62; the three ops carry POST/memory/`[200]`/`["human","harness"]`/the four codes; the re-shaped details schemas reject the old shapes; the three example sets and `planImportExamples.error` and `provider.remove`'s example parse against their own envelopes.
- daemon smoke (real `serve()` boot on a migrated temp home): `node.create` on an unknown project answers `404 not-found`, `node.update` and `node.delete` on unknown nodes answer `404`, an invalid body answers `400 invalid-request`; a real create at `fromRevision: null` answers `200` with `revision`, `id` and a reported `initiative-without-objective` completeness finding; a create naming an unregistered repository answers `422 plan-invalid` with `repository-unknown`; a create at a stale token answers `409 stale-revision` (guard `project`, expected `null`) — the whole route → schema → command → refusal → envelope chain works through the composition root.
  **Assumptions.**
- VERIFIED: zod 4.4.3's `discriminatedUnion` requires a readonly tuple; `as const` on the member array satisfies it, and the two earlier TS2345 errors (array not a tuple) disappeared with it — `npm run typecheck`.
- VERIFIED: `nodeWriteFields` union members must stay `strictObject`s so an omitted editable field on update is `400` rather than a silent keep — the graph.test.ts omitted-field cases pass in the probe.
- VERIFIED: the fixture regeneration walks the registry with the exact walk of `coverage.test.ts` (same pointer scheme, emit rules and bytewise sort), so the regenerated 405 rows equal what the test computes; the previous 338-row file was already stale (the TE recorded the `every field in the registry answers…` red as pre-existing).
- VERIFIED: `context.actor` is the full `ActorRow` (`src/http/server/app.ts:34`), which the three command inputs require; the plan-import handler's string actor is not the pattern to copy here.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 13 confirm-GREEN + Story 14 readiness-corrected (RED, intended-pass characterization)

**Cycle.** Confirm GREEN for Task 13 (`src/http/contract/*.test.ts`, `src/http/server/node/{create,update,delete}-node.test.ts`, `src/main.node-write.test.ts`), then RED for Task 14 (`14-readiness-corrected`, assertions-only — it adds no production code): `src/commands/node/create-node.test.ts`, `update-node.test.ts`, `delete-node.test.ts`.

**Confirm GREEN (Story 13).**

- `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- First confirm run was red — one failing test, **my own fixture defect**: `src/main.node-write.test.ts` `two creates chain the guard token without a plan.revisions call` — the `revisionsCallsBeforeThirdCreate` counter was captured at the END of `runWriteSequence` (in the return object), i.e. AFTER the sequence's explicit `plan.revisions` call, so it read 1 against the asserted 0. Masked in the Story-13 RED turn: the sequence never ran there (every `main.node-write` test died on `unknown operation id: node.create`), so the counter capture never executed against the real daemon. Fixed in my lane: capture `planRevisionsCalls` into a local right before the third create and return that.
- command: `node --test src/http/contract/*.test.ts src/http/server/node/create-node.test.ts src/http/server/node/update-node.test.ts src/http/server/node/delete-node.test.ts src/main.node-write.test.ts` → pass 311, fail 0.

**Full-gate gaps, found by `npm run verify` (all in my lane — the three test files, per `scripts/lane-check.sh`; each red at the SE's Story-13 handoff, which never ran the full gate):**

- `src/cli/plan/import.test.ts` — the `REVISIONS` fake's entry lacked `origin` (`planRevisionEntry` requires it since Story 4; the story's compat list missed this consumer, and no later turn ran the cli suite), and the three `plan.import` response fakes lacked `completeness` (Story 5's `planImportResponse` member). 17 failures, all one ZodError. Fixed: `origin: "import"` on the entry, `completeness: []` on the three bodies.
- `src/main.test.ts` — the `fixtures` map lacked `node.create`, `node.update`, `node.delete` (registry gained them at Story 13; my Story-13 RED turn updated app/dispatch/route tests but missed this one). The third failure (`provider.register` event 2 !== 1) was a cascade of the same gap: the fixtures deepEqual died before the call loop, so `provider-a` never registered and the later test's `attribution-a` hit the first-LLM `provider.defaultSet` path (2 events). Fixed: three fixtures, each against `missing(...)` ids with schema-valid bodies, `expect: 404`.
- `scripts/publish-contract.test.ts` — `exampleFiles.length` 31 → 34 (three new example sets). Fixed.

**Test written.** (Story 14 — the Verify's routing rule: create/update/delete assertions go to their own file, all-three assertions to all three files, driven from a shared local helper in each.)

- file: `src/commands/node/create-node.test.ts` (edited) — suite `src/commands/node/create-node.test` — methods:
  - `every readiness transition on node.create carries its matching trigger` — dependency-free create, then the local helper sweeps every recorded transition: `pending → ready` must carry `readiness-promoted`, `ready → pending` must carry `readiness-demoted`, any other pair fails — so no other trigger can appear on the route;
  - `a mismatched trigger pair is refused by the store and writes nothing` — local helper drives `setNodeState({ id, from: "ready", to: "pending", trigger: "readiness-promoted" })` (the pair the trigger does not declare) through the recording store: throws the exact message `trigger readiness-promoted declares pending -> ready, the write names ready -> pending`, and the node row is deep-equal before and after;
  - local helper `assertTriggersMatchTransitions(calls)` and `assertMismatchedTriggerRefused(fixture, nodeId)` — the Story's "shared local helper in each".
- file: `src/commands/node/update-node.test.ts` (edited) — suite `src/commands/node/update-node.test` — methods:
  - `every readiness transition on node.update carries its matching trigger` — one build drives the demotion then the promotion (adds then removes the same `depends_on`), sweep covers both triggers;
  - `one pass is a fixed point over a chain of three nodes` — chain task → taskTwo → taskThree (taskTwo/taskThree seeded pending with edges in one mutation); the write removes taskTwo's edge (one `mutateGraph` carrying the restamped node and the edge delete); the first call returns exactly `[{ taskTwoId, pending → ready, readiness-promoted }]` with at most one transition per node, and the **identical replay** over the resulting graph returns `[]`;
  - `an update that empties an objective keeps its state byte-identical` — task moved out of the objective (Story-10 fixture shape); the objective's stored node row deep-equals before and after;
  - `a mismatched trigger pair is refused by the store and writes nothing` — the same local helper as create;
  - local helpers `seedChain`, `assertTriggersMatchTransitions`, `assertMismatchedTriggerRefused`.
- file: `src/commands/node/delete-node.test.ts` (edited) — suite `src/commands/node/delete-node.test` — methods: `every readiness transition on node.delete carries its matching trigger` (the promote-dependent delete fixture of Story 11) and `a mismatched trigger pair is refused by the store and writes nothing`, both via the file's local helpers.
- The Story-14 Verify bullets already green in the tree from Stories 9-11, verified, no edit: `calls mutateGraph exactly once and setNodeState never` (recorded list exactly `["mutateGraph"]`, so `setNodeState` zero times) and the `Object.hasOwn(input, "trigger") === false` check in all three files; the six inventory rows (create promote / create no-transition / create changes no other node's state+revision+updatedAt / update removes promotes / update adds demotes with `showNode` pending / delete promotes and never demotes).
- asserts: the Story-14 contract — every recorded transition on each route carries its matching readiness trigger and no other, the mismatched stamped pair throws and commits nothing, the chain write is a one-pass fixed point, and the emptied objective's state is byte-identical.

**RED proof.**

- command: `node --test src/commands/node/create-node.test.ts src/commands/node/update-node.test.ts src/commands/node/delete-node.test.ts`
- exit: 0 — pass 84, fail 0 (76 pre-existing + 8 new). **Intended pass, explicitly**: Story 14 writes no production code (`14-readiness-corrected.md:8`), so every new assertion pins already-shipped behaviour — the EPIC's own transition inventory (`017-per-node-graph-write.md:97`) and the `setNodeState` trigger check (`src/services/plan/sqlite.ts:486-491`, already pinned by EPIC 016). First-run red in this turn was one **fixture** defect of mine, not the production code: the chain write stamped `revision_${U_REV}`, which no `plan_revision` row carries (the `node.revision` FK refuses the upsert); switched to `nodeBaselineRevision` (the reseeded baseline every fixture holds) and the suite went green.
- sensitivity probes (throwaway probe file, deleted before handoff — each assertion demonstrated live against the production modules): the sweep helper fails on a doctored `{ pending → ready, readiness-demoted }` transition and on an unknown pair; the mismatched `setNodeState` pair throws the exact message with the node row unchanged while the matching pair proceeds (the refusal is pair-specific, not blanket); and on the chain, reverting the applied transition makes the identical replay produce the promotion again — so the `[]` assertion genuinely depends on the first write having applied its transition.
- full gate: `npm run verify` → exit 0, pass 4065, fail 0 (was exit 1 / fail 22 before the three test-side compat fixes above); `npm run typecheck` → exit 0; `npm run lint` → exit 0.
- Story-14 Verify lines: the three `src/commands/node/*.test.ts` command exits 0; `npm run lint` exit 0; `npm run verify` exit 0 — all met. The `PASS EPIC-017` Proof is the epic-closing gate and cannot run yet: `src/cli/node/*.test.ts` (Story 15) do not exist, so the Proof's `node --test` would exit non-zero on the absent paths.
- expected red elsewhere: none — parity/route/coverage pins are green at Story 13 as recorded.

**Open to Software Engineer.**

- **No production seam in this task.** Story 14's Change section states no production file changes, and its Constraints forbid readiness code, trigger constants and a second readiness pass. Every assertion above reads already-shipped behaviour through the recording `PlanStore` and the real `SqlitePlanStore`. The SE's GREEN for Task 14 is a no-op confirm (no files to change); the next RED task is Story 15 (`15-cli.md`), whose seam is `src/cli/node/create.ts`, `update.ts`, `delete.ts`, `index.ts`, the `src/cli/inventory.ts` entries and the `src/cli/program.ts` registrations.
- Nothing test-side is delegated: the three test-file edits and the three compat fixes (cli fake, main.test fixtures, publish-contract count) all landed in this turn.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 14 readiness-corrected (no-op confirm)

**Cycle.** GREEN for Task 14 (`src/commands/node/create-node.test.ts`, `update-node.test.ts`, `delete-node.test.ts`) — intended-pass characterization, no production seam.
**Files changed.** none — `14-readiness-corrected.md:4,8` writes no production code, and its Constraints forbid readiness code, trigger constants and a second readiness pass. The TE's RED turn ran green (exit 0, pass 84) and its `Open to Software Engineer` declares the SE's GREEN for Task 14 a no-op confirm; `git status` shows no production file pending for it.
**Seam (GREEN).** Every new assertion pins already-shipped behaviour: the three commands already write through `mutateGraph` (recorded list exactly `["mutateGraph"]`, no `trigger` key via `Object.hasOwn`), the store's readiness pass already stamps `readiness-promoted`/`readiness-demoted` and throws on a mismatched `setNodeState` pair, and one pass is a fixed point because `deriveReadiness` computes both directions in one pass inside the store.
**Refactor.** none named in Story 14 (no `Action — REFACTOR:` block; the Constraints forbid readiness code, so there is nothing to apply).
**Build check.**

- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: the next RED is Story 15 (`15-cli.md`), whose seam the TE names as `src/cli/node/create.ts`, `update.ts`, `delete.ts`, `index.ts`, the `src/cli/inventory.ts` entries and the `src/cli/program.ts` registrations — recorded here; the active work stays the TE's selection, not opened this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 15 CLI (RED, after Story 14 no-op confirm)

**Cycle.** Confirm GREEN for Task 14 (SE no-op), then RED for Task 15 (`15-cli.md`): `src/cli/node/create.test.ts`, `src/cli/node/update.test.ts`, `src/cli/node/delete.test.ts` (new), `src/cli/inventory.test.ts` + `src/cli/parity.test.ts` (edited — the count pins the three inventory entries raise).

**Confirm GREEN (Story 14).**

- The SE's Story-14 turn is a declared no-op (no production files changed, `git status` shows none pending for it). `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`. Story 14 is green.

**Test written.**

- file: `src/cli/node/create.test.ts` (new) — suite `src/cli/node/create.test` — methods:
  - `node create sends the newest revision as fromRevision with the body the kind selects` — recorded calls exactly `["plan.revisions", "node.create"]`, both with `{ id: PROJECT }`; `body.fromRevision === REVISION_B`; `body.node` deep-equals the full task body from the options (`--instruction`/`--acceptance` values verbatim, `--worker "tdd@1"`, `--depends-on` variadic as `["task_a", "task_b"]`);
  - `node create in an empty project sends null as fromRevision` — `{ revisions: [] }` → null;
  - `node create sends an objective body with parentId and repo and an initiative body with neither` — objective carries `repo`/`parentId`; the initiative body deep-equals the strict-object shape and `Object.hasOwn(node, "parentId")` and `"repo"` are false (the schema refuses extra members);
  - `node create prints the id and the revision` — stdout exactly `kanthord: id <id>\nkanthord: revision <revision>\n`, fails 0, exits [];
  - `node create prints a completeness finding on standard error and exits zero` — stderr exactly `kanthord: completeness: initiative-without-objective an initiative holds no objective\n`, fails 0, exits [];
  - `node create exits non-zero on a stale-revision refusal` — exits `[150]`, stderr `kanthord: stale-revision: <message>\n`.
- file: `src/cli/node/update.test.ts` (new) — suite `src/cli/node/update.test` — methods:
  - `node update fills the whole field set from node.show` — `node.show` then `node.update`, both `{ id: TASK }`; `fromRevision === REVISION_B` (the show revision); `node.kind === "task"` (stored), `title` = the given option, `parentId`/`worker`/`dependsOn` = the stored values (`dependencies` mapped to `dependsOn`); `instruction` and `acceptance` asserted present as strings — **presence only, see the note below**;
  - `node update sends the node revision on a field-only change and never calls plan.revisions` — calls exactly `["node.show", "node.update"]`;
  - `node update sends the project revision on a parent change` — `--parent` different from the stored parentId → `plan.revisions` with `{ id: PROJECT }` (projectId from the show), `fromRevision === REVISION_C` (newest);
  - `node update sends the project revision on a depends_on change` — `--depends-on task_b` vs stored `["task_a"]` → the same chain;
  - `node update prints the returned revision` — stdout `kanthord: revision <revision>\n`;
  - `node update prints a completeness finding on standard error and exits zero`;
  - `node update exits non-zero on a stale-revision refusal` — `[150]`, and the script has **no** `plan.revisions` entry (field-only path, proving the refusal path skips it too).
- file: `src/cli/node/delete.test.ts` (new) — suite `src/cli/node/delete.test` — methods: `node delete sends the newest project revision` (calls `["node.show", "plan.revisions", "node.delete"]`, parameters `{ id: TASK }` / `{ id: PROJECT }` / `{ id: TASK }`, body deep-equals `{ fromRevision: REVISION_C }`); `node delete prints each deleted id on its own line` (stdout exactly `task_x\ntask_y\n`); `node delete prints a completeness finding on standard error and exits zero`; `node delete exits non-zero on a stale-revision refusal` (`[150]`).
- file: `src/cli/inventory.test.ts` (edited) — `declares exactly twenty-three commands`; `commandPaths holds twenty-three distinct strings`; `flattens to twenty-eight entries naming twenty-five distinct operation ids`; `pins the fifteen paths the P1-E1 scan never names` (the three node paths bytewise between `db status` and `project list`).
- file: `src/cli/parity.test.ts` (edited) — `programCommandPaths returns the twenty-three inventory paths`; `pins twenty-five distinct ids across twenty calling entries`; `reaches six ids only as a step of another command` (`node.show` joins the five); `never lists a group command as a path` gains `node`.
- asserts: the Story-15 Verify contract — the newest/`null` guard token on create, the node-vs-project revision split on update, the show-derived project id on delete, the exact stdout/stderr texts, zero exit with a completeness report, non-zero through `exitCodeForError` on a refusal, and the raised inventory/parity pins.
- **Design notes the tests pin (the SE matches these):** `--instruction <path>` and `--acceptance <path>` carry the instruction/acceptance **text verbatim** — the register input carries no `fs`/`readFile` member (the Story's `{ program, client, stdout, stderr, fail, exit }` list), so the option value is the content, not a file to read; the `<path>` metavar stays as the Story writes it. `--depends-on <id...>` is variadic. Omitted `--worker` sends `null`, omitted `--depends-on` sends `[]`. Completeness findings print as `kanthord: completeness: <code> <message>\n` per finding on stderr. Create stdout is two lines (`kanthord: id <id>` then `kanthord: revision <revision>`), update prints `kanthord: revision <revision>`, delete prints one bare `<id>` per line (the `actor list` precedent). A refusal prints `kanthord: <code>: <message>\n` and calls `exit(exitCodeForError(code, status))` — `stale-revision` is 150.
- **The one story gap, flagged for the SE (and the human):** `node.show` carries `instructionBlob`/`acceptanceBlob` hashes and `repositoryId`, never the instruction text, the acceptance text or the repository name, so "an option the caller omits takes the stored value" is unsatisfiable for those three fields. The tests assert `typeof instruction === "string"` and `typeof acceptance === "string"` only — every other editable field is asserted to its stored value. The mapping decision for the three un-derivable fields is the SE's; the request must still parse through `nodeUpdateRequest`, and no extra operation may join the calls (the inventory pins `["node.show", "plan.revisions", "node.update"]`).

**RED proof.**

- command: `node --test src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts`
- exit: 1 — fail 10, pass 13; failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/cli/node/create.ts' imported from .../src/cli/node/create.test.ts` (same for update/delete — the three suites die at load); the four inventory pins (`Expected values to be strictly equal` on 23/23/28/25 and the fifteen-path deep-equal, actual 20/22/twelve); the three parity pins (`programCommandPaths returns the twenty-three…` actual 20, the 25/20 pin, and `reaches six ids` deep-equal showing actual `['plan.revisions', …]` without `node.show`).
- typecheck: exit 2 — 9 errors, every one in my three new test files and every one on the missing seams (TS2307 ×3, TS7006 ×6 cascades on the untyped `stdout`/`stderr` lambdas); nothing elsewhere in the repository.
- lint: `npx eslint` on all five touched files — exactly the 3 `boundaries/no-unknown-dependencies` on the missing seams (cli → cli clears when the SE creates them); no `no-restricted-syntax`.
- stub probe: `src/cli/node/{create,update,delete}.ts` with the Story-declared signatures and `throw new Error("stub")` bodies — typecheck exit 0 (my files clean, no own-type error); probe run: fail 17, every failure `Error: stub`, no assertion error and no fixture defect (the fixture responses all parse against the contract schemas — `planRevisionsResponse`, `nodeShowResponse`, the three response schemas). Stubs deleted before handoff; `git status` shows `?? src/cli/node/` holding only the three test files.
- expected red elsewhere (recorded, not touched): `parity.test.ts`/`route.test.ts`-family and `npm run verify` are green since Story 13; the CLI-side sweep (`program`, `exit-code`, `options`, `client` suites) re-run this turn: pass 63, fail 0. The Story-15 Verify line `node --test ... src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/program.test.ts` exits 0 only after the SE lands the inventory entries and the program registrations; the EPIC Proof cannot run yet — the three `src/cli/node/*.test.ts` suites stay red until the seam exists.

**Open to Software Engineer.**

- `src/cli/node/index.ts` — `nodeCommand(program)` in the `plan/index.ts` shape (one `node` group, idempotent).
- `src/cli/node/create.ts` — `registerNodeCreate({ program, client, stdout, stderr, fail, exit })`; options `--project <id>`, `--kind <kind>`, `--title <text>`, `--parent <id>`, `--repo <name>`, `--worker <name>`, `--instruction <path>`, `--acceptance <path>`, `--depends-on <id...>` (variadic); step order: `plan.revisions` with `{ id: project }` → `revisions[0]?.id ?? null` → `node.create` with `{ id: project }` and `{ fromRevision, node }` where `node` is the union member the `--kind` selects (`--parent`/`--repo`/`--acceptance` per kind; worker default `null`, `dependsOn` default `[]`); refusal → `kanthord: <code>: <message>\n` + `exit(exitCodeForError(code, status))`; success → `kanthord: id <id>\n` + `kanthord: revision <revision>\n`, then each `completeness` finding as `kanthord: completeness: <code> <message>\n` on stderr.
- `src/cli/node/update.ts` — `registerNodeUpdate` with the same input shape; options `--id <id>` plus the create field options; step order: `node.show` with `{ id }`; the request body carries the stored kind/title/parentId/worker and the stored `dependencies` as `dependsOn` for every omitted option, and the given option values for the rest; when the given `--parent`/`--depends-on` differ from the stored values, `plan.revisions` with `{ id: <show.projectId> }` and `fromRevision = newest`, otherwise `fromRevision = <show.revision>` and **no** `plan.revisions` call; `node.update` with `{ id }`; success prints `kanthord: revision <revision>\n` plus the completeness lines; refusal exits through `exitCodeForError`.
- `src/cli/node/delete.ts` — `registerNodeDelete`; options `--id <id>`; `node.show` → `plan.revisions` for the show's `projectId` → `node.delete` with `{ id }` and `{ fromRevision: newest }`; success prints one bare `<id>\n` per `deleted` member plus the completeness lines; refusal exits through `exitCodeForError`.
- `src/cli/inventory.ts` — the three Story entries (sorted by path: `node create`, `node delete`, `node update`), with `node delete` carrying `["node.show", "plan.revisions", "node.delete"]` per the Story's own correction of the EPIC list.
- `src/cli/program.ts` — register the three commands (all take `client`, `stdout`, `stderr`, `fail`, `exit`; none needs a new dependency member).
- Do not touch the five test-side files — everything test-side landed in this turn. The `instruction`/`acceptance` fill decision is yours (the tests assert presence only); if you judge the Story unimplementable there, raise `OPEN:` with the exact blocker.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · Story 15 CLI (GREEN, two TE count pins raised OPEN)

**Cycle.** GREEN for `src/cli/node/create.test.ts`, `src/cli/node/update.test.ts`, `src/cli/node/delete.test.ts`, `src/cli/inventory.test.ts`, `src/cli/parity.test.ts` (RED turn).
**Files changed.**

- `src/cli/node/index.ts` (new) — `nodeCommand(program)` in the `plan/index.ts` shape: one `node` group, idempotent.
- `src/cli/node/create.ts` (new) — `registerNodeCreate({ program, client, stdout, stderr, fail, exit })`; the nine Story options (`--depends-on <id...>` variadic); local required-option validation in the house style (`--project`/`--kind`/`--title`, plus `--parent` for objective/task and `--repo` for objective); body typed `z.infer<typeof nodeCreateRequest>["node"]`, built per kind with defaults `instruction: ""`, `acceptance: ""`, `worker: null`, `dependsOn: []`; `plan.revisions` (`{ id: project }`) → `revisions[0]?.id ?? null` → `node.create` (`{ id: project }`); refusals print `kanthord: <code>: <message>\n` and `exit(exitCodeForError(...))`; success prints `kanthord: id <id>\n` + `kanthord: revision <revision>\n` and each finding as `kanthord: completeness: <code> <message>\n` on stderr.
- `src/cli/node/update.ts` (new) — `registerNodeUpdate`; `node.show` → body carries the stored kind/title/parentId/worker/dependencies for every omitted option; the topology classification compares given vs stored `parent` and `depends_on` with the daemon's own normalized comparison (bytewise sort + dedupe, `comparePaths`), so an order-only `depends_on` replay stays a field-only update; topology → `plan.revisions` (`{ id: show.projectId }`) + newest revision, otherwise `show.revision` and no `plan.revisions` call; `--kind` differing from the stored kind fails locally; success prints `kanthord: revision <revision>\n` plus the completeness lines.
- `src/cli/node/delete.ts` (new) — `registerNodeDelete`; `node.show` → `plan.revisions` for `show.projectId` → `node.delete` (`{ id }`, body `{ fromRevision }`); success prints one bare `<id>\n` per `deleted` member plus the completeness lines.
- `src/cli/inventory.ts` (edited) — the three Story entries, bytewise-sorted (`node create` < `node delete` < `node update`); `node delete` carries `["node.show", "plan.revisions", "node.delete"]` per the Story's correction of the EPIC list (the EPIC's `["plan.revisions", "node.delete"]` omits the project-id read the show supplies).
- `src/cli/program.ts` (edited) — `registerNodeCreate`/`registerNodeUpdate`/`registerNodeDelete` imports and registrations with `{ program, client, stdout, stderr, fail, exit }`; no new dependency member.
  **Seam (GREEN).** The tests drive the three register functions through the recording client; the recorded call lists, parameters, bodies, stdout/stderr texts and exit codes match the pins — verified by a production-module probe against the exact fixture shapes (create task/objective/initiative bodies byte-exact, `null` on empty revisions, the two-line and one-line stdout, the completeness stderr line, `[150]` on stale with the field-only update refusing without a `plan.revisions` call, delete body `{ fromRevision }` and bare-id stdout). Program↔inventory parity holds both directions: 23 paths, none missing.
  **Blocked — `OPEN:` (TE lane).**
- Two count pins contradict the Story's own entries, which are explicit and which the TE's own call-list tests pin. The current inventory holds 20 entries / 22 flattened / 22 distinct; the three Story entries add 2 + 3 + 3 = 8 flattened and 4 distinct ids (`node.create`, `node.delete`, `node.show`, `node.update`), so the correct totals are 23 / 30 / 26. The TE's pins count as if `node delete` and `node update` carried two operations each:
  - `src/cli/inventory.test.ts` — `flattens to twenty-eight entries naming twenty-five distinct operation ids`: fix to `thirty` / `twenty-six` (probe-verified 30 / 26).
  - `src/cli/parity.test.ts` — `pins twenty-five distinct ids across twenty calling entries`: the calling count (20) is right; fix the distinct pin to `twenty-six`.
- No other discrepancy: the fifteen-path pin, the 23/23 pins, the six step-only ids (`node.show` joins), and the program-parity pins all hold with the Story entries (probe-verified).
  **Refactor.** none named in Story 15 (no `Action — REFACTOR:` block).
  **Build check.**
- typecheck: exit 0
- lint (the six touched files): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- behavior probe (production modules, not a test run): all pinned fixtures above; probe file removed before handoff (`git status` shows only the test files + the six production files).
  **Assumptions.**
- VERIFIED: the mapping decision for the three fields `node.show` cannot supply (it returns `instructionBlob`/`acceptanceBlob` hashes and `repositoryId`, never the instruction text, the acceptance text or the repository name): omitted `--instruction`/`--acceptance` on update send `""` — the schema requires the member, the tests pin presence only, and `""` is the only parseable value that does not invent content. Consequence, flagged for the human: the daemon treats `""` as a differing field, so a real field-only update that omits both options blanks the stored texts; the API gap the TE named forces it. Omitted `--repo` on an objective update sends `""`, which the schema's `min(1)` refuses with `400` — an objective update needs an explicit `--repo` today.
- VERIFIED: the CLI's topology classification must match the daemon's `differingFields`, which normalizes `depends_on` (sort + dedupe) before comparing — an order-only replay sends the node revision, not the project revision, so no false `stale-revision` 409.
- VERIFIED: `--kind` is declared on update per "the same field options as create", but the request always carries the stored kind; a given differing kind fails locally with the house-style invalid-request message, mirroring the daemon's kind-mismatch refusal.
- VERIFIED: `node.delete`'s `fromRevision` cannot be null in practice — `node.show` succeeding implies a `plan_revision` row exists (the `node.revision` foreign key), so `revisions[0]` is defined.

ATTEMPT-FAILED: Task 15 — two TE count pins are arithmetically inconsistent with the Story's own entries (inventory `28/25` and parity `25` distinct vs the correct 30 flattened / 26 distinct: the three entries add 2+3+3 ops and four new ids); every call-list, body, output and exit-code assertion is implemented per the Story and probe-verified, and the two pins live in the TE's test files.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · Story 15 confirm-GREEN + implementation ready for review

**Cycle.** Confirm GREEN for Task 15 (`src/cli/node/{create,update,delete}.test.ts`, `src/cli/inventory.test.ts`, `src/cli/parity.test.ts`, `src/cli/program.test.ts`), then the epic-closing Verification Gate (Gates + Proof) — every Story is green, so this turn closes the epic.

**Confirm GREEN (Story 15).**

- The SE's Story-15 GREEN raised one `OPEN:` in my lane — two count pins arithmetically inconsistent with the Story's own entries. Verified by hand against `src/cli/inventory.ts`: the three node entries add 2 + 3 + 3 = 8 flattened operation ids and 4 distinct ids (`node.create`, `node.show`, `node.delete`, `node.update`), so the pre-epic 22/22 grows to 30 flattened / 26 distinct; the 20 calling entries is unchanged and right.
- Fixes (mine): `inventory.test.ts` — `flattens to twenty-eight entries naming twenty-five distinct operation ids` → `thirty` / `twenty-six` (28→30, 25→26); `parity.test.ts` — `pins twenty-five distinct ids across twenty calling entries` → `twenty-six` (25→26).
- Third fix, also mine, surfaced by the same confirm run: `src/cli/program.test.ts` `registers the ten declared top-level commands, sorted bytewise` — the SE's Story-15 registration added the `node` group, so the pin is stale at eleven, with `node` bytewise between `db` and `plan`; title and list updated. This pin was invisible in the Story-15 RED turn because the three new suites died at load on the missing seams, so the confirm run was the first time the program suite ran against the SE's registration.
- command: `node --test src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/program.test.ts` → exit 0, pass 44, fail 0.
- Story-15 Verify lines: all met — the three command suites, the inventory/parity covers, the program pin, `npm run verify` exits 0, and the Proof runs through the three `src/cli/node/*.test.ts` files.

**EPIC verification gate.**

- typecheck (`npm run typecheck`): exit 0
- lint (`npm run lint`): exit 0
- unit (`npm test`): exit 0 — tests 4082, pass 4082, fail 0
- Gates (`npm run verify`): exit 0 — tests 4082, pass 4082, fail 0 (migrations 0001-0006 apply, OpenAPI emits and validates, `verify db status ok`)

**Proof.**

- command: the EPIC's exact `node --test` list (26 files incl. `src/http/contract/*.test.ts` and `src/main.node-write.test.ts`) — exit 0, tests 815, pass 815, fail 0, and it printed the success string: `PASS EPIC-017`.
- Hermetic coverage beyond the Proof is in place and green, per the per-story turns: the route-level acceptance sequence twice (complete and delete-left-incomplete graphs), the migration rebuild/rollback/CHECK/foreign_key_check assertions, the byte-equality through `Buffer.compare`, the concurrency proof and the guard-token chaining with no `plan.revisions` call, the harness set at twelve, the seven blockers with byte-identical databases, the readiness triggers, the idempotency replays, and the CLI inventory parity.

**Tasks closed.** 15 tasks across 15 Stories — Story 1 proposal amendment, 2+3 migration 0006 + parity (coupled pair), 4 store origin, 5 structural validity, 6 write legality, 7 services/revision, 8 concurrency classes, 9 createNode, 10 updateNode, 11 deleteNode, 12 project binding invariant, 13 contract rows/handlers/actors, 14 readiness corrected, 15 CLI. No Story outstanding.

```
IMPLEMENTATION_READY_FOR_REVIEW:
- gates: PASS
- proof: PASS (node --test — 26 named files incl. src/http/contract/*.test.ts and src/main.node-write.test.ts) — "PASS EPIC-017"
- stories: 15/15 complete
- date: 2026-08-15
- state: local-uncommitted
```

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 3 action:YES finding(s) to the TDD loop; 2 action:NO finding(s) recorded for the human.
BLOCKER: completeness deduplication drops distinct findings — `import-plan.ts` deduplicates by `finding.code` alone; dedupe on the exact `(code, path, id)` triple (Story 5 line 83).
BLOCKER: import retries erase completeness reports — `import-plan.ts` returns `completeness: []` on a committed retry; return the committed import's deterministic completeness array and add incomplete-import retry coverage.
BLOCKER: CLI path options become literal document content — `create.ts`/`update.ts` send `--instruction`/`--acceptance` option strings directly instead of reading the named files; use the injected `readFile` seam (Story 15 lines 14/22).
INFO: node update cannot preserve omitted fields — `node.show` exposes only blob hashes and `repositoryId`, so an omitted `--instruction`/`--acceptance`/`--repo` becomes `""`; needs a contract seam that provides stored content and repository names (human decision).
INFO: update cannot clear nullable or list fields — `--worker` cannot select `null` and `--depends-on` cannot express an empty list; needs a product decision on clearing syntax.

## TEST-ENGINEER — 017-per-node-graph-write · review-blocker regressions (3 AUTO_REVIEW BLOCKERs)

**Cycle.** Review-blocker RED for the three routed `AUTO_REVIEW` findings — repair path, outside the planned coverage: completeness dedupe on `(code, path, id)`, import-retry completeness repetition, and CLI `--instruction`/`--acceptance` file reads. The two `INFO` findings (`action:NO`) stay recorded for the human: update cannot preserve omitted fields, and no clearing syntax for nullable/list fields.

**Test written.**

- file: `src/commands/plan/import-plan.test.ts` (edited) — suite: `src/commands/plan/import-plan.test.ts` — methods: `two empty objectives report two findings that share one code`, `a retry of a committed incomplete import repeats the completeness report`
  - asserts: two objectives without tasks produce two `objective-without-task` findings with distinct `(path, id)` pairs, and no `initiative-without-objective`; a committed incomplete import retried with identical input returns `retried: true` and a `completeness` array deep-equal to the first import's.
- file: `src/cli/node/create.test.ts` (edited) — suite: `src/cli/node/create.test.ts` — harness gains a recording `readFile` and a `reads()` accessor; every `--instruction`/`--acceptance` option now names a file path whose registered content is what the body must carry; the first test asserts `reads()` holds exactly `[ACCEPTANCE_PATH, INSTRUCTION_PATH]`
  - asserts: the option values are file paths, the command reads them through the injected seam, and the sent body carries the file contents.
- file: `src/cli/node/update.test.ts` (edited) — suite: `src/cli/node/update.test.ts` — methods: `node update reads --instruction and --acceptance paths and sends the file contents`
  - asserts: `readFile` is called with both paths, the update body carries the contents, and the field-only change still sends the node revision (`REVISION_B`) with no `plan.revisions` call.

**RED proof.**

- command: `node --test src/commands/plan/import-plan.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts` → exit non-zero — tests 70, pass 65, fail 5:
  - `AssertionError [ERR_ASSERTION]: ... actual: 1, expected: 2` — `two empty objectives report two findings that share one code` (dedupe by `code` drops the second objective)
  - `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + [] - [ { code: 'objective-without-task', ... message: 'the objective holds no task' } ]` — `a retry of a committed incomplete import repeats the completeness report` (retry returns `completeness: []`)
  - `+ acceptance: 'acceptances/add-health-route.md', - acceptance: '## Acceptance criteria\n- The health route answers.\n'` — `node create sends the newest revision as fromRevision with the body the kind selects` (the path string travels, not the content)
  - `+ instruction: 'instructions/objective.md', - instruction: 'Do the objective work.\n'` — `node create sends an objective body with parentId and repo and an initiative body with neither`
  - `AssertionError [ERR_ASSERTION]: the option values name files that the command reads + [] - [ 'acceptances/add-health-route.md', 'instructions/add-health-route.md' ]` — `node update reads --instruction and --acceptance paths and sends the file contents`
- typecheck: `npm run typecheck` → exit non-zero, the only two errors are the seam signals in my files: `src/cli/node/create.test.ts(128,5): error TS2353: ... 'readFile' does not exist in type 'Readonly<{ program: Command; client: ... }>'` and the identical line for `src/cli/node/update.test.ts(139,5)`.
- stub probe: cannot stub — the `readFile` member of `NodeCreateCliInput`/`NodeUpdateCliInput` is the SE's declaration decision, and the two TS2353 lines above are exactly the seam signal; nothing else in the tree is unchecked.

**Open to Software Engineer.**

- `src/commands/plan/import-plan.ts` — the completeness array of `ImportPlanResult` must keep every distinct finding (the review: dedupe on the `(code, path, id)` triple, keeping the first occurrence) and `retryResult` must return the committed import's deterministic completeness array instead of `[]`.
- `src/cli/node/create.ts` and `src/cli/node/update.ts` — `NodeCreateCliInput` and `NodeUpdateCliInput` gain `readFile: (path: string) => string`; `--instruction <path>` and `--acceptance <path>` read the named file and send its content; `src/cli/program.ts` passes `dependencies.readFile` through (it already exists in `ProgramDependencies` and `main.ts` already injects it).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 017-per-node-graph-write · review-blocker regressions (3 AUTO_REVIEW BLOCKERs, GREEN)

**Cycle.** GREEN for the three routed review blockers behind `src/commands/plan/import-plan.test.ts`, `src/cli/node/create.test.ts`, `src/cli/node/update.test.ts` (TE review-blocker RED turn).
**Review blocker addressed.**

- `BLOCKER: completeness deduplication drops distinct findings — import-plan.ts deduplicates by finding.code alone; dedupe on the exact (code, path, id) triple (Story 5 line 83).`
- `BLOCKER: import retries erase completeness reports — import-plan.ts returns completeness: [] on a committed retry; return the committed import's deterministic completeness array and add incomplete-import retry coverage.`
- `BLOCKER: CLI path options become literal document content — create.ts/update.ts send --instruction/--acceptance option strings directly instead of reading the named files; use the injected readFile seam (Story 15 lines 14/22).`
  **Files changed.**
- `src/commands/plan/import-plan.ts` (edited) — `deduplicateCompleteness` now keys on the `(code, path, id)` triple (first occurrence after `sortFindings`); the response `completeness` is the candidate-side partition of the committed graph only (`deduplicateCompleteness(candidateCompleteness)`); the `documentCompleteness` merge block is deleted; `retryResult` derives the committed graph's completeness deterministically — `readValidationContext` + `readGraph` → `Candidate` with `source: "database"` on every node → `validateCandidateCompleteness` → `deduplicateCompleteness` — and returns it in place of `[]`.
- `src/cli/node/create.ts` (edited) — `NodeCreateCliInput` gains `readFile: (path: string) => string`; `--instruction`/`--acceptance` option values are file paths read through the seam (`options.instruction === undefined ? "" : input.readFile(options.instruction)`), the content travels in the body.
- `src/cli/node/update.ts` (edited) — `NodeUpdateCliInput` gains the same `readFile` member; the same path-read rule for the two options in all three kind branches.
- `src/cli/program.ts` (edited) — `readFile: dependencies.readFile` passed into `registerNodeCreate` and `registerNodeUpdate` (already a `ProgramDependencies` member, already injected by `main.ts`).
  **Seam (GREEN).** The dedupe tests: two empty objectives yield exactly two `objective-without-task` findings with distinct `(path, id)` pairs and no `initiative-without-objective`; a committed incomplete import retried with identical input returns `retried: true` with `completeness` deep-equal to the first import's. The CLI tests: the recording `readFile` is called with both option paths and the bodies carry the file contents, with the pinned call lists unchanged. Behavior probes against the exact fixtures (production modules, probe files removed): N1 gives the two candidate-side findings, N2 first === retried, create/update bodies carry `INSTRUCTION`/`ACCEPTANCE` with reads `[instructions/..., acceptances/...]`, and the Story-5 `completeness is sorted and deduplicated` fixture still yields exactly `["initiative-without-objective", "objective-without-task"]`.
  **One reconciliation, flagged for the human.** A literal "concatenate both partitions then dedupe on the triple" cannot satisfy the TE's pin: a document-side finding `{code, path, id: null}` and the candidate-side finding of the same node `{code, path: null, id}` are disjoint triples, so the merge keeps both and N1 would report four findings for two empty objectives. The response therefore reports the **candidate-side partition of the committed graph** (one finding per empty node, `path: null`, `id` set — the TE's own "one finding per empty objective, not one per code"), triple-deduped. That also restores the Story's stated property: the array is a pure function of the graph, which is exactly what makes the retry derivation deterministic (the accepted-blob graph at retry time equals the first import's committed graph in the covered case). The document-side partition still drives nothing else in the response.
  **Refactor.** none named (review-blocker cycle, not a Story step).
  **Build check.**
- typecheck: exit 0
- lint: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: `validateCandidateCompleteness` output depends only on `(kind, parentId, id)` per node, so the retry's stored-graph candidate reproduces the first import's candidate-side partition exactly — the completeness checks in `plan-candidate.ts:136-150` touch no context member and no repository field.
- VERIFIED: no test pins the document-side completeness message (`holds no task document`) in any response — grepped across `src/` and `test/`; `main.node-write.test.ts` asserts codes only (`[]` and `["objective-without-task"]`), which the candidate-side partition satisfies.
- VERIFIED: `idempotency.test.ts`'s plan.import replay asserts revision equality and recorded counts, never the completeness array — the retry derivation cannot break it.
- VERIFIED: `program.test.ts` and `parity.test.ts` build the program with a throwing fake `readFile` but never execute the node create/update actions with file options, so the new seam is never touched there.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 017-per-node-graph-write · review blockers confirmed GREEN, implementation ready for review

**Cycle.** Confirm GREEN for the three review-blocker regressions (`src/commands/plan/import-plan.test.ts`, `src/cli/node/create.test.ts`, `src/cli/node/update.test.ts`), then re-run the epic-closing Verification Gate (Gates + Proof) end-to-end. This is the second issuance: the first was returned by AUTO_REVIEW with 3 BLOCKERs and 2 INFO findings; the 3 BLOCKERs were repaired through the review-blocker cycle (my regressions + the SE's GREEN) and every gate is re-verified below.

**Confirm GREEN (review blockers).**

- command: `npm run verify:handoff` → `VERIFY: PASS — npm run typecheck is clean`.
- command: `node --test src/commands/plan/import-plan.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts` → exit 0 — tests 70, pass 70, fail 0. The two dedupe/retry regressions and the two CLI read-file regressions are green; the pinned call lists (`["plan.revisions", "node.create"]`, field-only update without `plan.revisions`) hold beside the new `readFile` reads.

**EPIC verification gate.**

- typecheck (`npm run typecheck`): exit 0 (via the verify:handoff run above)
- lint (`npm run lint`): exit 0 (inside `npm run verify`)
- unit (`npm test`): exit 0 — tests 4085, pass 4085, fail 0
- Gates (`npm run verify`): exit 0 — tests 4085, pass 4085, fail 0; migrations 0001-0006 apply; OpenAPI emits and validates; `kanthord: verify db status ok`
- Proof: the EPIC's exact `node --test` list (26 files incl. `src/http/contract/*.test.ts` and `src/main.node-write.test.ts`) — exit 0, tests 818, pass 818, fail 0, and it printed the success string: `PASS EPIC-017`

**Tasks closed.** 15 tasks across 15 Stories, plus the 3 review-blocker regressions — all green. No Story outstanding. The two `action:NO` INFO findings from AUTO_REVIEW remain recorded for the human: `node.update` cannot preserve omitted `--instruction`/`--acceptance`/`--repo` values (the contract exposes blob hashes and `repositoryId`, not stored content), and no clearing syntax exists for `--worker null` or an empty `--depends-on`.

```
IMPLEMENTATION_READY_FOR_REVIEW:
- gates: PASS
- proof: PASS (node --test — 26 named files incl. src/http/contract/*.test.ts and src/main.node-write.test.ts) — "PASS EPIC-017"
- stories: 15/15 complete
- date: 2026-08-15
- state: local-uncommitted
```

END: TEST-ENGINEER

HUMAN_REVIEW: PASS
