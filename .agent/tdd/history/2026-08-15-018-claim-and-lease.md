---
epic: .agent/plan/epics/018-claim-and-lease.md
opened: 2026-08-15
opener: test-engineer
base-ref: 5df22da4a4c050611e643bdd5bd6a07d6cfe2326
---

# Implementation cycle — 018-claim-and-lease

Pulled from EPIC: `.agent/plan/epics/018-claim-and-lease.md`.

Verification gate (binding, from the EPIC's `## Verification Gate` section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/domain/lease-hierarchy.test.ts \
>   src/domain/external-transition.test.ts \
>   src/domain/attempt.test.ts \
>   src/domain/transition.test.ts \
>   src/domain/layout.test.ts \
>   src/services/storage/migration-0003-execution-and-journal.test.ts \
>   src/services/storage/migration-0007-external-execution.test.ts \
>   src/services/storage/schema-parity.test.ts \
>   src/services/lease/sqlite.test.ts \
>   src/services/execution/sqlite.test.ts \
>   src/commands/node/claim-node.test.ts \
>   src/commands/node/heartbeat-node.test.ts \
>   src/commands/node/release-node.test.ts \
>   src/commands/startup/recover-expired-leases.test.ts \
>   src/commands/actor/revoke-actor.test.ts \
>   src/queries/node/list-node.test.ts \
>   src/http/contract/error-details.test.ts \
>   src/http/contract/parity.test.ts \
>   src/http/contract/registry.test.ts \
>   src/http/server/node/claim-node.test.ts \
>   src/http/server/node/heartbeat-node.test.ts \
>   src/http/server/node/release-node.test.ts \
>   src/http/server/node/list-node.test.ts \
>   src/cli/node/list.test.ts \
>   src/cli/node/show.test.ts \
>   src/cli/node/claim.test.ts \
>   src/cli/node/heartbeat.test.ts \
>   src/cli/node/release.test.ts \
>   src/main.claim.test.ts \
>   && echo "PASS EPIC-018"
> ```
>
> Every file is named. No directory glob stands in for one, because a glob prints PASS the moment one matching file exists and hides the missing heartbeat and release tests. `node --test` exits non-zero on a named path that is absent, so the Proof fails before the epic is built. Fifteen of these paths do not exist today. One of the fifteen, `src/commands/actor/revoke-actor.test.ts`, is authored by EPIC 015 and extended here.

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — 018-claim-and-lease · Story 1 proposal amendment (RED)

**Cycle.** RED for Story 1 (`src/http/contract/proposal-amendment-execution.test.ts`, new). Dispatch order per `index.md:8` starts with `01`; this story carries the two prose sections and the state-machine note only — the three route rows land in Story 14 with the registry entries and both parity count literals.
**Test written.**

- file: `src/http/contract/proposal-amendment-execution.test.ts` (new) — suite `src/http/contract/proposal-amendment-execution.test` — methods:
  - `the leases-have-no-route section keeps its statement and gains the claim amendment clause` — the two unchanged sentences, the `system.status` sentence, and the amendment clause naming the three paths;
  - `execution.md gains the objective-scope section with the three sentences` — the `## The objective scope of a claim` heading and the exact three-sentence body;
  - `state-machine.md line 78 carries the amended running-ready note` — the amended note string, whitespace-insensitively;
  - `transition.ts carries the identical amended note and an unchanged row shape` — `transitions` row `running → ready` note equals the same string, and `task: true`, `objective: false`, `initiative: false` unchanged.
- asserts: the EPIC-018 proposal amendments — the lease amendment clause, the three objective-scope sentences, and the byte-identical amended note on both sides of the EPIC-002 parity.
  **RED proof.**
- command: `node --test src/http/contract/proposal-amendment-execution.test.ts`
- exit: 1 — fail 4, pass 0; failures: `AssertionError [ERR_ASSERTION]: the lease amendment clause is absent`; `AssertionError [ERR_ASSERTION]: missing the objective-scope section`; `AssertionError [ERR_ASSERTION]: the running to ready note is not amended`; and the `strictEqual` note diff on the `transition.ts` row (`actual` = today's note, `expected` = amended note).
- stub probe: none needed — every path exists (`transition.ts` is edited in place, not created); `npm run typecheck` exits 0.
  **Spec note — the story file is stale on two quotes; the EPIC is authoritative.**
- The story's "current Note" quote for `state-machine.md:78` is the pre-EPIC-014 text. EPIC 014 landed its own clause there (`13cb16e`, per `014-external-drive-contract.md:22`), and the EPIC (`018-claim-and-lease.md:53`) says this story's note "gains one clause". The test therefore asserts the **gains** reading: the EPIC-014 clause stays, and "A released or expired external claim also returns the task to the pool, and the daemon writes no `dirty-recovery` for a task that has no working tree." is appended before "O and I:". Nothing anywhere plans to remove the 014 clause (`attempt-rejected` remains a shipped trigger with that note as its documentation).
- The story says "keep the first two sentences unchanged" of the leases section; its body has three sentences today. The test pins all three unchanged and requires only the amendment clause appended.
  **Open to Software Engineer.**
- `docs/proposal/api/execution.md` — "Leases have no route" section body: keep the current three sentences unchanged, append the amendment clause: "the lease is still not addressable, and a claim, a heartbeat and a release are actions on the node, spelled `POST /v1/node/:id/claim`, `POST /v1/node/:id/heartbeat` and `POST /v1/node/:id/release`."; add one new section `## The objective scope of a claim` holding exactly the three sentences: "An external claim holds the objective.", "A task claim holds the objective and the task.", "Two actors never hold two sibling tasks of one objective."
- `docs/proposal/phase-1/state-machine.md:78` — the `running → ready` Note cell becomes, byte for byte: `T: recovery finds an expired lease, a clean tree, and the head at the base, or an external harness reports a rejected attempt under the attempt limit, which ends the attempt and returns the task to the pool. A released or expired external claim also returns the task to the pool, and the daemon writes no `dirty-recovery` for a task that has no working tree. O and I: no operation rewinds a running parent to a claimable state.` The T/O/I cells stay `✅ ❌ ❌`.
- `src/domain/transition.ts:140` — the `note` of the `running → ready` row becomes the identical string. Change `from`, `to`, `task`, `objective` and `initiative` on that row in no way, and edit no other row or note of the file.
- Add no route row, register nothing, change no literal in `src/http/contract/parity.test.ts` (pre-edit values are `62` and `66` — record both in the commit message per Story 1 Verify; Story 14 guards them).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-proposal-amendment · prose amendments and the amended note

**Cycle.** GREEN+REFACTOR for `src/http/contract/proposal-amendment-execution.test.ts`.
**Files changed.**

- `docs/proposal/api/execution.md` (edited) — "Leases have no route" body: three existing sentences kept, amendment clause appended; new section `## The objective scope of a claim` with the three exact sentences
- `docs/proposal/phase-1/state-machine.md` (edited) — `running → ready` Note cell: EPIC-014 clause kept, "A released or expired external claim also returns the task to the pool, and the daemon writes no `dirty-recovery` for a task that has no working tree." inserted before "O and I:"; `✅ ❌ ❌` cells untouched
- `src/domain/transition.ts` (edited) — `running → ready` row `note` at :140 replaced byte-identically with the amended string; `from`, `to`, `task`, `objective`, `initiative` unchanged, no other row or note touched
  **Seam (GREEN).** The four assertions read the amended strings from the two proposal docs and the identical note from the `transitions` row, which now match the test's `amendedRunningReadyNote`.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: TE's spec note — the story's two quoted "current" texts were stale (pre-EPIC-014); applied the "gains" reading: the EPIC-014 clause stays and the new clause is inserted before "O and I:". Cross-checked against the actual file contents and the test's `amendedRunningReadyNote`.
- VERIFIED: `src/http/contract/parity.test.ts` count literals read at :16 `62` and :25 `66`, unchanged — recorded per Story 1 Verify; Story 14 guards them.
- No route row added, nothing registered, no test or helper edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · Story 1 confirm GREEN failed

**Cycle.** Confirm GREEN for Story 1 (`src/http/contract/proposal-amendment-execution.test.ts`) — **failed**: one assertion is still red, so Story 1 stays open. The 02+03+04 group RED opens on the next turn, once the SE's fix confirms.
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`. The SE's cited artifact (typecheck) re-verifies independently.
  **Verification result.**
- command: `node --test src/http/contract/proposal-amendment-execution.test.ts`
- exit: 1 — fail 1, pass 3 — failure: `AssertionError [ERR_ASSERTION]: the lease amendment clause is absent` at `proposal-amendment-execution.test.ts:39:12` — `execution.includes("the lease is still not addressable, and a claim, a heartbeat and a release are actions on the node, spelled `POST /v1/node/:id/claim`, `POST /v1/node/:id/heartbeat`and`POST /v1/node/:id/release`.")` is false.
- `node --test src/domain/transition.test.ts src/http/contract/parity.test.ts` (the rest of the Story-1 Verify) — fail 0.
  **Diagnosis.** The amendment clause is present in `docs/proposal/api/execution.md:90`, but its first word is capitalized: "The lease is still not addressable, ...". The Story file (`01-proposal-amendment.md:11`) and the EPIC (`018-claim-and-lease.md:36`) both pin the clause with a lowercase "the lease is still not addressable, ...", and the test asserts that exact text. One character deviates: `The` → `the`. The three kept sentences, the objective-scope section, the state-machine note and the `transition.ts` row all confirm green.
  **Action required (software-engineer lane).**
- `docs/proposal/api/execution.md:90` — the appended clause's first word: `The lease` → `the lease`. Nothing else changes.

ATTEMPT-FAILED: 01-proposal-amendment — still red after GREEN: `AssertionError [ERR_ASSERTION]: the lease amendment clause is absent` — `docs/proposal/api/execution.md:90` capitalizes the clause as "The lease", while the Story and the EPIC pin "the lease"

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 01-proposal-amendment · clause case fix

**Cycle.** Re-GREEN for `src/http/contract/proposal-amendment-execution.test.ts` (blocker from TE confirm).
**Files changed.**

- `docs/proposal/api/execution.md` (edited) — :90 amendment clause first word: `The lease` → `the lease`. Nothing else changed.
  **Seam (GREEN).** The assertion `execution.includes("the lease is still not addressable, ...")` now matches the file byte-for-byte; the three kept sentences, the objective-scope section and the amended note were already green.
  **Refactor.** None named.
  **Build check.**
- typecheck: exit 0
  **Review blocker addressed.** `docs/proposal/api/execution.md:90` capitalizes the clause as "The lease", while the Story and the EPIC pin "the lease" — one character corrected to the lowercase reading; no other edit.
  **Assumptions.**
- VERIFIED: no other deviation — TE's diagnosis named the single character, and the edit touches only that word.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · 02+03+04 coupled group RED (database amendment, migration 0007, parity split)

**Cycle.** Confirm Story 1 GREEN, then RED for the coupled group `02`+`03`+`04` (`test/helpers/proposal.test.ts` run-pin; `src/services/storage/migration-0007-external-execution.test.ts`, new). Group per `index.md:10` — no verify gate inside.
**Test written.**

- file: `test/helpers/proposal.test.ts` (edited) — `run yields the table and the unique index as two statements in order` — pins the post-0007 run fence of Story 2, stripped as `proposalStatements` strips (comments and whitespace only).
- file: `src/services/storage/migration-0007-external-execution.test.ts` (new) — suite `src/services/storage/migration-0007-external-execution.test` — 27 methods: migration metadata (version 7, name, `rebuild: true`); no pragma in `statements`; fourteen members in the declared leading-keyword order; the index name freed before it is recreated, with a live proof that removing the `DROP INDEX` member fails with `already exists`; both pragmas restored on the success path; per-table row survival across the rebuild; `driver = 'internal'` on every copied run and attempt row; `owner_kind = 'daemon'` on the non-null-owner lease row and null on the null-owner row; `PRAGMA foreign_key_check` empty; no child `REFERENCES` clause moved (no `_old` name, each child names `run` or `attempt`); the injected failure after the copy leaves the database at version 6 with the version-3 DDL byte-identical, no `_old` table, `run_one_active` on `run`, every dependent row intact and both pragmas restored; a failed rebuild leaves a later migration unaffected; the run `CHECK` refusals in both driver directions; the attempt `CHECK` refusals in both directions (fresh `attempt_no` so the refusal is the clause and not the unique index); the composite foreign key refuses both pairings with `PRAGMA foreign_keys` on; `UNIQUE (id, driver)` broke no single-column `REFERENCES run(id)` and `id` is still the only primary key; the lease owner-pair refusals plus the accepted `actor_` identity; `run_one_active` DDL equals the declared index and still refuses a second active run; the rebuilt tables equal the three proposal fences; `run.driver`, `attempt.driver` and `lease.owner_kind` agree with the domain lists; every driver-conditional clause text present and no `head_oid` clause; and the zod-refusal loops over the seven driver-conditional columns (domain parse fails ⇔ equivalent `INSERT` throws).
- file: `src/services/storage/migration-0003-execution-and-journal.test.ts` (edited) — the Story 4 split, done now because it is schema-independent: `normalize` hoisted above the constants; `historicalLeaseStatement`, `historicalRunStatements` (table + index), `historicalAttemptStatement` and `historicalEventStatement` declared as normalized template literals; the parity `it` becomes the ten-statement expectation, title "parity: the ten statements reproduce the nine proposal tables verbatim, in order".
- file: `test/helpers/schema.ts` (new) + `src/services/storage/schema-parity.test.ts` (edited) — the Story 4 helper move: `tableDdl`, `literalListIn` and `assertClauseAgrees` lifted verbatim from `schema-parity.test.ts:31-69`, with `tableDdl`'s and `assertClauseAgrees`'s parameter widened to the `Storage` interface; `schema-parity.test.ts` imports the three and keeps every `it` unchanged.
  **Spec note — Story 4's letter rests on the pre-EPIC-015 test; the binding gate forces one deviation, which follows the plan's own precedent.**
- Story 4 and the EPIC (`018-claim-and-lease.md:79`) say the parity keeps `event` on `proposalStatements` and the title keeps the word ten. That combination is unsatisfiable: EPIC 015 (`f470f4b`) widened the `event` fence to `harness` and edited this very test to filter `event` out and retitle it "the nine statements reproduce the eight proposal tables". Probed: `proposalStatements("event")` is 326 normalized chars against the version-3 statement's 243. Keeping `event` on `proposalStatements` is red forever, and the binding gate (`npm run verify` + the Proof list) requires green.
- Resolution: `event` joins `lease`/`run`/`attempt` as a fourth frozen constant, `historicalEventStatement`, per the 017 precedent's own principle — a table whose fence moved since the migration is frozen. That restores the pre-015 shape exactly: ten statements, nine tables, the word ten in the title, `event` in position 10, filter removed. Deviations from the letter: four constants instead of three, and `event` not on `proposalStatements`. Nothing else changes.
- Story 3's Verify names "the step-7 statement" for `run_one_active`; the index is member 6 of 14. The test filters by prefix, which is order-robust.
- The v6-shaped fixture inserts (`test/helpers/rows.ts` `seedExecution`/`seedLeaseOnNode`, the migration-0003 test's own insert helpers, and the run/attempt/lease inserts of `rotate-actor-token`, `import-plan`, `remove-provider`, `recover-expired-leases`, `read-status` and `plan/sqlite` tests) and the migrations-count assertions of the 0001/0002/0003/0004/0006 tests CANNOT be updated in this turn: the inserts only break once 0007 lands, and updating them now would break the still-version-6 schema. They are confirm-turn work. The migration-0007 fixture seeds its own v6-shaped rows inline and therefore does not depend on the helper updates.
  **RED proof.**
- command: `node --test test/helpers/proposal.test.ts`
- exit: 1 — fail 1, pass 3 — failure: `✖ run yields the table and the unique index as two statements in order` — the fence still holds the version-3 run DDL, so the post-0007 pin is unsatisfied.
- command: `node --test src/services/storage/migration-0007-external-execution.test.ts`
- exit: 1 — fail 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/services/storage/migration-0007-external-execution.ts' imported from .../migration-0007-external-execution.test.ts`.
- command: `node --test src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/schema-parity.test.ts`
- exit: 0 — fail 0 (46 pass): the Story 4 parity split and the helper move are green today and stay green across Story 2, because the four historical constants are frozen.
- stub probe: `src/services/storage/migration-0007-external-execution.ts` — clean: with a throwaway stub of the Story-declared shape, `npm run typecheck` exits 0; the six TS7006 lines the un-stubbed run reports are masking artifacts of the missing-module `any`. Smoke run with the stub: the file executes, only the behaviour assertions fail. Stub deleted before handoff; `git status` shows no trace of it.
  **Open to Software Engineer.**
- Story 2 — the database document amendment, exactly the fences of `02-database-document-amendment.md`:
  - `docs/proposal/database/run.md` — replace the whole ` ```sql ` fence with the post-0007 DDL (table and index, two statements, that order; the five new `--` comments; `head_oid` carries no driver clause), and add the `UNIQUE (id, driver)` prose sentence.
  - `docs/proposal/database/attempt.md` — replace the whole fence with the post-0007 DDL.
  - `docs/proposal/database/lease.md` — replace the whole fence with the post-0007 DDL and amend the `owner` comment.
  - `docs/proposal/database/workspace.md` — add one sentence after the `node_id` paragraph: a workspace row exists for an internal run only, because an external harness owns its own working tree.
- Story 3 — migration 0007:
  - `src/services/storage/migration-0007-external-execution.ts` (new) — `migration0007ExternalExecution: Migration`, `version: 7`, `name: "0007-external-execution"`, `rebuild: true`, `statements` holding exactly the fourteen members in the declared order (three renames, `DROP INDEX run_one_active`, the run table, the index, the attempt table, the lease table, the three `INSERT ... SELECT` copies with `driver = 'internal'` and the `owner_kind` CASE, the three drops) and no pragma. The `rebuild` runner already exists — EPIC 017 shipped it, so the runner section of the story is already satisfied; verify the behaviour matches the story and make no runner edit.
  - `src/services/storage/migrations.ts` — register `migration0007ExternalExecution` as the last member.
- The three fences and the migration statements must agree clause-for-clause: the parity assertions compare them modulo whitespace and comments only.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 02+03+04 coupled group · database fences, migration 0007, parity

**Cycle.** GREEN+REFACTOR for `test/helpers/proposal.test.ts` and `src/services/storage/migration-0007-external-execution.test.ts` (Story 2 + 3; Story 4's test-side was already green).
**Files changed.**

- `docs/proposal/database/run.md` (edited) — post-0007 fence: table + `run_one_active` index in order, `driver` column, nullable `workspace_id`/`worker`/`base_oid` with the three driver-conditional `CHECK`s, `UNIQUE (id, driver)`, `head_oid` with no driver clause; the five pinned `--` comments; the `UNIQUE (id, driver)` prose sentence below the fence
- `docs/proposal/database/attempt.md` (edited) — post-0007 fence: `driver` beside `run_id`, four driver-conditional `CHECK`s, `FOREIGN KEY (run_id, driver) REFERENCES run(id, driver)`
- `docs/proposal/database/lease.md` (edited) — post-0007 fence: `owner_kind` column with its `CHECK`, the null-agreement `CHECK`, the `actor\_%` identity clause; amended `owner` comment
- `docs/proposal/database/workspace.md` (edited) — one sentence added to the `node_id` paragraph: a workspace row exists for an internal run only
- `src/services/storage/migration-0007-external-execution.ts` (new) — `migration0007ExternalExecution: Migration`, `version: 7`, `name: "0007-external-execution"`, `rebuild: true`, fourteen statements in the declared order (three renames, `DROP INDEX run_one_active`, the run table, the index, the attempt table, the lease table, the three `INSERT ... SELECT` copies writing `driver = 'internal'` and the `owner_kind` CASE, three drops), no pragma
- `src/services/storage/migrations.ts` (edited) — `migration0007ExternalExecution` registered as the last member
  **Seam (GREEN).** `proposalStatements("run")` now yields the pinned two statements, and the `0007-external-execution` module exists with the fourteen statements whose DDL matches the three proposal fences modulo comments and whitespace, so both failing tests are satisfied.
  **Refactor.** None named in these Tasks; the runner `rebuild` section of Story 3 was already shipped by EPIC 017 — verified the behaviour matches the story (pragmas set before `BEGIN`, restored in `finally`) and made no runner edit, per the TE's instruction.
  **Build check.**
- typecheck: exit 0
- runtime self-check (app, not tests): normalized fence ↔ migration statement comparison — run ok, attempt ok, lease ok; `node` smoke of the real `migrations` list on a scratch file — all seven apply, no `_old` table, `foreign_keys` reads 1 and `legacy_alter_table` reads 0 after
  **Assumptions.**
- VERIFIED: the `actor\_%` escape is written `'actor\\_%' ESCAPE '\\'` in the template literal, producing the same SQL text as the `event.md`/migration-0005 precedent (`CHECK (actor_kind <> 'harness' OR ...)`), which the lease fence repeats.
- VERIFIED: no pragma in `statements`, `DROP INDEX` sits before the `CREATE UNIQUE INDEX`, and the injected-failure statement 12 (`INSERT INTO no_such_table`) lands between the copies and the drops in the TE's failing-migration probe — all match the declared order.
- VERIFIED (TE-planned): the v6-shaped inserts in `test/helpers/rows.ts` (`seedExecution`/`seedLeaseOnNode`), the migration-0003 test helpers, and the `rotate-actor-token` / `import-plan` / `remove-provider` / `recover-expired-leases` / `read-status` / `plan/sqlite` tests break only once 0007 lands and are the TE's confirm-turn work, per the RED turn; no test or `test/helpers/**` file was touched.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm 02+03+04 group · RED for Story 5 lease hierarchy

**Cycle.** Confirm GREEN for the `02`+`03`+`04` coupled group (plus the re-confirm of Story 1 the failed ATTEMPT-FAILED owed), then RED for Story 5 (`src/domain/lease-hierarchy.test.ts`, new). The deferred confirm-turn fixture work the 02+03+04 RED turn listed is done in this turn.
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.
  **Verification result.**
- command: `node --test src/http/contract/proposal-amendment-execution.test.ts test/helpers/proposal.test.ts src/services/storage/migration-0007-external-execution.test.ts src/services/storage/migration-0003-execution-and-journal.test.ts src/services/storage/schema-parity.test.ts`
- exit: 0 — pass 81, fail 0 — Story 1 (proposal amendment) and the whole 02+03+04 group confirm green.
- Two of the 81 were failing at first run, both defects in my own migration-0007 test file, fixed this turn: (1) `node:sqlite` rows carry a null prototype, so `assert.deepEqual(rows, [{...}])` failed on prototype alone — the expected rows are now built through `Object.assign(Object.create(null), ...)`; (2) a stray `endTaskRun(storage)` ended the fixture's active run, so the duplicate-active-run insert succeeded, `assertRefused` caught its own `assert.fail` and read `errcode` 0 — the call is removed and the insert is refused directly.
  **Confirm-turn fixture work (deferred from the group RED turn, now done).**
- `test/helpers/rows.ts` — `seedExecution`, `seedRunRow` and `seedAttemptRow` write `driver = 'internal'`; `seedLeaseOnNode` writes `owner_kind = 'daemon'`; `seedReleasedLeaseOnNode` unchanged (null owner, null `owner_kind` passes the null-agreement CHECK).
- `src/services/storage/migration-0003-execution-and-journal.test.ts` — `insertRun`/`insertAttempt` write `driver = 'internal'`; `insertLease` unchanged (owner always null).
- `src/commands/startup/recover-expired-leases.test.ts` — both run inserts write `driver = 'internal'`; the two lease inserts already carry null owners, unchanged.
- `src/commands/provider/remove-provider.test.ts` and `src/commands/plan/import-plan.test.ts` — run inserts write `driver = 'internal'`, attempt inserts write `driver = 'internal'`.
- `src/commands/actor/rotate-actor-token.test.ts` — the non-null-owner lease insert writes `owner_kind = 'daemon'`.
- `src/services/plan/sqlite.test.ts` — the four non-null-owner lease inserts write `owner_kind = 'daemon'`, and the `UPDATE lease SET owner = NULL` also clears `owner_kind` (the null-agreement CHECK requires both).
- `src/queries/system/read-status.test.ts` — the lease insert writes `owner_kind` via a `CASE` beside `owner`.
- Migrations-count assertions in `migration-0001`/`0002`/`0003`/`0004`/`0006` tests rise from six to seven with `migration0007ExternalExecution` and version `7` in the name and body.
- `test/helpers/rows.test.ts` — the `seedExecution` proof builds through the full `migrations` list, since the helper now writes post-0007 columns.
- Full suite: `npm test` — exit 0 — 4120 pass, 0 fail. Gate: `npm run verify` — exit 0. `npm run typecheck` — exit 0.
  **Test written.**
- file: `src/domain/lease-hierarchy.test.ts` (new) — suite `src/domain/lease-hierarchy.test` — methods: `leaseRelations holds exactly four members in the declared order`; `an empty live lease set is never a refusal`; `a task claim is refused on another owner's lease over the task itself`; `a task claim is refused on another owner's lease over its parent objective`; `a task claim is refused on another owner's lease over a sibling task`; `an objective claim is refused on another owner's lease over the objective itself`; `an objective claim is refused on another owner's lease over one of its tasks`; `an objective claim is not refused on another owner's lease over a sibling objective`; `an objective claim is not refused on another owner's lease over the initiative`; `a same-owner lease is never a refusal at any relation`; `an initiative claim is never refused`; `relation precedence beats identity order` (the ancestor objective `...D3E` sorts before the self task `...D40`, asserted through `Buffer.compare` in the body, and the refusal is still `self`); `identity order breaks a tie inside one relation` (two sibling leases supplied descending, refusal names the smaller identity, order asserted through `Buffer.compare`); `the refusal carries the holder's fence`; `the function reads no clock` (`expiresAt` 0 and `MAX_SAFE_INTEGER` yield the same relation).
- asserts: the four-relation tuple order; the same-owner exemption at all four task relations and both objective relations; the admitted refusal sets per `targetKind` (`task`: self/ancestor/sibling; `objective`: self/descendant; `initiative`: `null` unconditionally); relation-precedence-first, `Buffer.compare`-identity-second selection; the refusal carries `subjectId`, `holder`, `holderKind`, `fence`, `relation` and `expiresAt`; no liveness decision in the function.
- One extra test beyond the Story's named list: the objective-target `ancestor` non-admission (`...D42` initiative lease → `null`), pinning the rule text's second half beside the named sibling-objective case.
  **RED proof.**
- command: `node --test src/domain/lease-hierarchy.test.ts src/domain/layout.test.ts`
- exit: 1 — fail 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/domain/lease-hierarchy.ts' imported from .../src/domain/lease-hierarchy.test.ts`.
- stub probe: `src/domain/lease-hierarchy.ts` — clean: with a throwaway stub of the Story-declared signature (`leaseRelations`, `LiveLease`, `LeaseHierarchyInput`, `LeaseRefusal`, `liveLeaseRefusal`), `npm run typecheck` exits 0; the test's types agree with the declared surface. Stub deleted before handoff; `git status` shows no trace of it.
- Spec note: Story 5's `leaseOwnerKinds` fallback ("when EPIC 014 declared the type without the runtime list") does not apply — `src/domain/lease.ts:8` already carries `leaseOwnerKinds = ["daemon", "actor"] as const` and the derived `LeaseOwnerKind`. The SE adds no edit there. Two identities beyond the Story's fixed five exist in the test: `...D43` (second sibling for the tie-break) and `...D44` (sibling objective), because the fixed list holds no second sibling and no second objective.
  **Open to Software Engineer.**
- `src/domain/lease-hierarchy.ts` (new) — the Story-declared surface, verbatim: `leaseRelations = ["self", "ancestor", "descendant", "sibling"] as const` with `LeaseRelation`; `LiveLease` (`subjectId`, `owner`, `ownerKind: LeaseOwnerKind`, `fence`, `expiresAt`); `LeaseHierarchyInput` (`targetId`, `targetKind: NodeKind`, `parentId`, `childIds`, `siblingIds`, `owner`, `liveLeases`); `LeaseRefusal` (`subjectId`, `holder`, `holderKind`, `fence`, `relation`, `expiresAt`); `liveLeaseRefusal(input): LeaseRefusal | null`. Imports `NodeKind` from `./state.ts` and `LeaseOwnerKind` from `./lease.ts`, zod at most, no clock, no SQL.
- Behaviour the test pins: a lease whose `owner` equals `input.owner` is never a refusal at any relation; for another owner the first matching relation in `self` → `ancestor` → `descendant` → `sibling` wins, and a lease matching none is ignored; the admitted set is `task` = self/ancestor/sibling, `objective` = self/descendant, `initiative` = `null` unconditionally; when several leases refuse, the earliest relation's group wins and inside it the smallest `subjectId` under `Buffer.compare` (never the input order); the function reads no liveness, `expiresAt` travels only for the report; the function is total and throws never.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 05-lease-hierarchy · the pure hierarchy refusal function

**Cycle.** GREEN+REFACTOR for `src/domain/lease-hierarchy.test.ts`.
**Files changed.**

- `src/domain/lease-hierarchy.ts` (new) — `leaseRelations` tuple + `LeaseRelation`; `LiveLease`; `LeaseHierarchyInput`; `LeaseRefusal`; `liveLeaseRefusal(input): LeaseRefusal | null`; private helpers `relationOf` (self → ancestor → descendant → sibling, first match wins) and `refusesAt` (task: self/ancestor/sibling; objective: self/descendant; initiative: false)
  **Seam (GREEN).** The function returns `null` for every same-owner lease at every relation, for an `initiative` target unconditionally, and for any admitted-set miss; for another owner it groups the refusing leases by relation, picks the earliest relation in `leaseRelations` order, and inside that group the smallest `subjectId` under `Buffer.compare` (never input order), so the fourteen assertions hold.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: `leaseOwnerKinds` already lives at `src/domain/lease.ts:8` with the derived `LeaseOwnerKind` — per the TE's spec note, `src/domain/lease.ts` received no edit and the runtime list stays declared in exactly one place.
- VERIFIED: the tie-break uses `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`, the same bytewise idiom `src/domain/readiness.ts:65` already uses, so the test's `Buffer.compare` probes and the function agree on order.
- The file imports `NodeKind` from `./state.ts` and `LeaseOwnerKind` from `./lease.ts` (both `import type`), imports no service interface, no `Transaction`, no clock and no SQL, and contains no `Date.now(`, `new Date(` or `Math.random(` — the layout purity scan and the domain import matrix both hold.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 5 GREEN · RED for Story 6 external transition rows

**Cycle.** Confirm GREEN for Story 5 (`src/domain/lease-hierarchy.test.ts`), then RED for Story 6 (`src/domain/external-transition.test.ts` + `src/domain/node-trigger.test.ts`, both edited in place — EPIC-014 files, this epic raises six external ids to eight).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 5 confirm).**
- command: `node --test src/domain/lease-hierarchy.test.ts`
- exit: 0 — pass 15, fail 0 — Story 5 closes.
  **Test written.**
- file: `src/domain/external-transition.test.ts` (edited) — suite `src/domain/external-transition.test` — methods:
  - `externalTransitions holds eight trigger ids` (renamed from "externalTriggerIds pins the six trigger ids in row order") — the eight ids as an ordered literal, each exactly once;
  - `externalTransitions holds exactly eight rows in exactly the declared order` — length 8, the `expected` literal gains the two rows after the six EPIC-014 rows, `assert.deepEqual`;
  - `the claim-released row carries every ExternalPrecondition field` — `assert.deepEqual` over all ten members against a literal object;
  - `the claim-expired row carries every ExternalPrecondition field` — the same, plus a key filter proving it differs from `claim-released` in exactly `["leaseFence", "actorKind"]`;
  - `both new rows name a legal matrix cell` — `canTransition("task", "running", "ready")` true for each;
  - `externalTriggerConsumer is total over the eight trigger ids` (renamed) — 8 keys, no missing, no extra;
  - `claim-released names the release command and claim-expired names the sweep` — the two exact path strings `src/commands/node/release-node.ts` and `src/commands/startup/recover-expired-leases.ts`.
  - `every externalTriggerConsumer value starts with src/commands/` — unchanged EPIC-014 test, now over eight entries by iteration, no edit.
- file: `src/domain/node-trigger.test.ts` (edited) — suite `src/domain/node-trigger.test` — methods:
  - `the external id set and the internal id set stay disjoint` (renamed) — union size rises 21 → 23, loop unchanged;
  - `triggerTransition returns the declared triple for claim-released and for claim-expired` — each returns `{ levels: ["task"], from: "running", to: "ready" }`.
- asserts: the exact eight-id set; both rows field-complete per the Story's two literals; consumer totality and the two paths; disjointness over eight ids; the `triggerTransition` triple.
  **RED proof.**
- command: `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/transition.test.ts`
- exit: 1 — fail 9, pass 47 (transition.test green) — failures, verbatim: `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` (`externalTransitions holds eight trigger ids`); `AssertionError [ERR_ASSERTION]: no row for trigger claim-released` at `rowByTrigger`; `Error: no transition row for trigger claim-released` at `node-trigger.ts:139`.
- typecheck: `npm run typecheck` reports exactly six errors, every one an assignability error over `claim-released`/`claim-expired` inside my two edited test files (TS2322 on the expected-row literals, TS7053 on the consumer index, TS2345 on the `triggerTransition` argument) — the RED seam errors that clear the moment the ids enter `ExternalTriggerId`; no production file reports one. One in-turn fix of my own: `ExternalPrecondition` now imported alongside `ExternalTransition` at the test's import site.
- stub probe: none — every imported module exists; the seam is an extension of an existing union, not a new module.
- Unchanged consumers verified green today: `src/services/plan/sqlite.test.ts:1244` iterates every trigger id generically and stays green under eight ids, because `task|running|ready` is already exercised by `attempt-rejected`.
  **Open to Software Engineer.**
- `src/domain/external-transition.ts` — append exactly two rows to `externalTransitions`, after the six EPIC-014 rows, `claim-released` then `claim-expired`: both `level: "task"`, `from: "running"`, `to: "ready"`, `runDriver: "external"`, `activeRun: true`, `attemptLimit: "under"`, `reportedObjectId: "absent"`, `childAggregation: "not-applicable"`; `claim-released` carries `leaseFence: "valid"` and `actorKind: "harness"`, `claim-expired` carries `leaseFence: "none"` and `actorKind: "daemon"`. Append to `externalTriggerConsumer`, same order: `"claim-released": "src/commands/node/release-node.ts"` and `"claim-expired": "src/commands/startup/recover-expired-leases.ts"`. Change no existing row, add no third row, create no command file, write no allow list and restore no source scan.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 06-external-transition-rows · the two task running→ready rows

**Cycle.** GREEN+REFACTOR for `src/domain/external-transition.test.ts` and `src/domain/node-trigger.test.ts`.
**Files changed.**

- `src/domain/external-transition.ts` (edited) — `externalTriggerIds` gains `"claim-released"` and `"claim-expired"` (six → eight, same order the test's literal pins); `externalTransitions` gains exactly two rows after the six EPIC-014 rows, both `task running → ready`, `claim-released` with `leaseFence: "valid"` / `actorKind: "harness"` and `claim-expired` with `leaseFence: "none"` / `actorKind: "daemon"`, each filling all ten members; `externalTriggerConsumer` gains the two entries in the same order, `"claim-released": "src/commands/node/release-node.ts"` and `"claim-expired": "src/commands/startup/recover-expired-leases.ts"`
  **Seam (GREEN).** The two ids enter the `ExternalTriggerId` union through the array, so the exact eight-id literal, the eight-row `deepEqual`, the total-consumer assertion and the `triggerTransition("claim-released" | "claim-expired")` triple all typecheck and resolve; both values start with `src/commands/`.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: no production consumer switches exhaustively over the external ids — `src/domain/node-trigger.ts:135` uses `find`, and `src/services/plan/sqlite.test.ts:1244` iterates generically (TE-confirmed green under eight ids), so no further production edit is owed by the union growth.
- VERIFIED: no row of an existing EPIC-014 entry changed, no third row and no internal row added, and no command file was created — `externalTriggerConsumer` names paths only, per the Story constraint.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 6 GREEN · RED for Story 7 services/lease

**Cycle.** Confirm GREEN for Story 6 (`src/domain/external-transition.test.ts`, `src/domain/node-trigger.test.ts`), then RED for Story 7 (`src/services/lease/sqlite.test.ts`, new).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 6 confirm).**
- command: `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts src/domain/transition.test.ts`
- exit: 0 — fail 0 — Story 6 closes; `npm run verify` stays green because no proposal/registry surface changed.
  **Test written.**
- file: `src/services/lease/sqlite.test.ts` (new) — suite `src/services/lease/sqlite.test` — the Story's 32 methods, verbatim: `a first acquire against an empty lease table inserts the row with fence 1` (whole `lease` table asserted empty first); `the hierarchy read resolves the target from node and not from lease` (empty table, task then initiative with its null parent); `an acquire of an unknown node throws a plain Error`; `the refusal carries the holder's fence`; `a same-owner acquire of a live lease returns acquired false and moves no fence`; `an acquire over a free lease writes fence + 1`; `an acquire over an expired lease writes fence + 1`; `an acquire over a pre-existing free row continues that row's fence and never resets to 1` (seeded free row at fence 7, asserts fence 8); `an acquire whose expires_at equals now exactly is admitted`; `an acquire of a task held by another owner raises lease-held`; `an acquire of a task whose parent objective another owner holds raises lease-held with relation ancestor`; `an acquire of a task whose sibling another owner holds raises lease-held with relation sibling`; `an acquire of an objective one of whose tasks another owner holds raises lease-held with relation descendant`; `an acquire of a task the same owner already holds at the objective succeeds`; `renew with the current fence extends the expiry and moves no fence`; `renew with any other fence raises lease-fenced and writes nothing`; `renew with the wrong owner raises lease-fenced and writes nothing`; `renew of an expired holding raises lease-fenced and writes nothing`; `release of an expired holding raises lease-fenced and writes nothing`; `assertHeld of an expired holding raises lease-fenced`; `release clears owner, owner kind, acquired_at, renewed_at and expires_at, and keeps the fence`; `a released row holds a null in every column but the fence`; `release with the right fence and the wrong owner raises lease-fenced and writes nothing`; `release with the right owner and the wrong fence raises lease-fenced and writes nothing`; `expired returns every node lease at or before now, ordered by subject id`; `expireLeasesOfOwner sets expires_at to now and keeps owner, owner kind and fence`; `expireLeasesOfOwner touches no lease of another owner`; `expireLeasesOfOwner over an owner with no live lease returns an empty list and writes nothing`; `read returns the record or null`; `assertHeld passes for the live owner and fence, and raises lease-fenced for an absent row, a wrong owner and a wrong fence`; `every input carries now and the service reads no clock`; `an acquire on a repository subject throws`.
- asserts: `AcquireLeaseResult.record` deep-equals the eight-member `LeaseRecord` literal on acquisition; `acquired` true/false distinguishes a new acquisition from a same-owner reuse; the fence pins (1, +1 on free/expired, 7→8 on the pre-seeded free row, never reset); the `LeaseError.refusal` object carries `subjectId`, `holder`, `holderKind`, `fence`, `relation`, `expiresAt`; `renew`/`release`/`assertHeld` raise `lease-fenced` on wrong fence, wrong owner and expired holding with the row deep-equal before/after; the released row holds null in all six columns but the fence; `expired` and `expireLeasesOfOwner` return bytewise-identity order with rows inserted in the reverse order; `read` returns the stored record or null; the source read pins no `Date.now(`, no `new Date(` and no `../clock/` import in `sqlite.ts`; `acquire` on `repository` and on an unknown node throws a plain `Error`, not a `LeaseError`. Fixed identities (`task_a`, `objective_a`, `initiative_a`, sibling `task_b` seeded through `seedRegistry`+`seedGraph`+one direct insert), fixed `now = 1700000000000`, `ttlMs = 300000`, actor owners `actor_alpha`/`_beta`/`_gamma` (satisfy the `actor\_%` lease clause).
  **RED proof.**
- command: `node --test src/services/lease/sqlite.test.ts`
- exit: 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/services/lease/sqlite.ts' imported from .../src/services/lease/sqlite.test.ts`.
- command: `node --test src/services/lease/not-implemented.test.ts` — exit 0 — pass 4 — the existing test stays green unchanged (its four methods are a subset of the widened surface).
- stub probe: `src/services/lease/sqlite.ts` — clean: with a throwaway stub of the Story-declared signature (the seven methods and the widened input/result/record shapes declared in the stub), `npm run typecheck` exits 0 — the call sites, the deep-equal literals and the refusal access all agree with the declared surface; the suite registers all 32 tests and executes (2 legitimately pass against the stub: the no-clock source read and the unknown-node plain-Error case). Stub deleted before handoff; `git status` shows no trace of it.
  **Spec notes.**
- The widened `index.ts` types are exercised structurally through the call sites; the test names only `SqliteLease` (from `./sqlite.ts`) and `LeaseError` (from `./index.ts`) plus `domain/`, storage and helper types, so no import of the not-yet-widened surface is needed for the RED to be the missing module and not an interface mismatch.
- `LeaseError` must carry the refusal object on a `refusal` property (test 4 and the four relation tests read it through `LeaseError & { refusal?: LeaseRefusal }`), and the refusal's `holderKind` is the `LeaseOwnerKind` of the live lease.
- Test 31 pins by source read that `sqlite.ts` contains no `Date.now(`, no `new Date(` and no import from `../clock/` — a `Clock` dependency or an in-service clock read fails it.
- `src/domain/layout.test.ts` needs no edit: `lease` is already a listed capability and adding `sqlite.ts` changes no count.
  **Open to Software Engineer.**
- Seam: `src/services/lease/` per `07-services-lease.md` — the Story file is the spec; the test imports `SqliteLease` from `./sqlite.ts` and `LeaseError` from `./index.ts`.
  - `src/services/lease/index.ts` — `LeaseRecord` gains `ownerKind: LeaseOwnerKind | null` (imported from `src/domain/lease.ts`); `AcquireLeaseInput` gains `ownerKind` and `now`; `RenewLeaseInput` gains `ownerKind` and `now`; `ReleaseLeaseInput` gains `owner`, `ownerKind` and `now`; new `AcquireLeaseResult`, `ExpireLeasesOfOwnerInput`, `LeaseSubject`, `ReadLeaseInput` (`now` included) and `AssertHeldInput` (`owner`, `fence`, `now`); the `Lease` interface becomes exactly the seven methods in the Story's order; `LeaseError` gains the `refusal` member carrying the `LeaseRefusal` from `src/domain/lease-hierarchy.ts`.
  - `src/services/lease/not-implemented.ts` — the four signatures widened, the three new methods added, each throwing `LeaseError("not-implemented", ...)`; the file and its test stay.
  - `src/services/lease/sqlite.ts` (new) — `class SqliteLease implements Lease`, no constructor dependency, no clock; the three-statement `acquire` (node-rooted hierarchy read, idempotent same-owner reuse that moves no fence, `INSERT ... ON CONFLICT` upsert that writes fence + 1 and refuses on an empty `RETURNING`), `renew` and `release` matching owner and fence with the `expires_at > ?` safety predicate, `release` clearing the five columns (`acquired_at` included) and keeping the fence, `expired`, `expireLeasesOfOwner` (keeps owner, owner kind and fence; subject list bytewise-ordered), `read` with no expiry predicate, `assertHeld` refusing absent/wrong-owner/wrong-fence/expired; unknown node and `repository` subject are plain `Error`s; every conditional write runs through `RETURNING`.
- Behaviour the test pins beyond the Story text: the refusal object travels on the raised `LeaseError`; a first acquisition over an absent row writes fence 1 and an acquisition over a pre-existing free row continues its fence (7 → 8, never 1); `renew` of an already-expired holding is `lease-fenced` (no resurrection); an acquire at `now` equal to the stored `expires_at` is admitted.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 07-services-lease · the widened interface and SqliteLease

**Cycle.** GREEN+REFACTOR for `src/services/lease/sqlite.test.ts`.
**Files changed.**

- `src/services/lease/index.ts` (edited) — `LeaseRecord` gains `ownerKind: LeaseOwnerKind | null`; `AcquireLeaseInput`/`RenewLeaseInput` gain `ownerKind` and `now`; `ReleaseLeaseInput` gains `owner`, `ownerKind` and `now`; new `AcquireLeaseResult`, `ExpireLeasesOfOwnerInput`, `LeaseSubject`, `ReadLeaseInput` (`now`) and `AssertHeldInput` (`owner`, `fence`, `now`); `Lease` becomes exactly the seven methods in the Story's order; `LeaseError` gains `readonly refusal?: LeaseRefusal` (third constructor argument); `LeaseOwnerKind` imported from `src/domain/lease.ts` and `LeaseRefusal` from `src/domain/lease-hierarchy.ts`, both `import type`
- `src/services/lease/not-implemented.ts` (edited) — the four signatures widened and `expireLeasesOfOwner`/`read`/`assertHeld` added, each throwing `LeaseError("not-implemented", ...)` with the same message; class still satisfies the seven-method interface
- `src/services/lease/sqlite.ts` (new) — `class SqliteLease implements Lease`, no constructor dependency, no clock
  **Seam (GREEN).** The test's call sites — `new SqliteLease()`, the eight-member `LeaseRecord` literals, `acquired` true/false, `LeaseError.code` and the `refusal` property, `renew`/`release`/`assertHeld` lease-fenced refusals, `expired` ordering, `expireLeasesOfOwner` bytewise ordering, and the source read for `Date.now(`/`new Date(`/`../clock/` — all resolve against the widened surface and the implementation's statements, which follow the Story's SQL verbatim: node-rooted hierarchy read (1a + live-lease 1b), idempotent same-owner reuse that moves no fence, `INSERT ... ON CONFLICT` upsert with `fence = lease.fence + 1` and `WHERE lease.owner IS NULL OR lease.expires_at <= ?`, `RETURNING`-guarded renew/release with the `expires_at > ?` safety predicate, release clearing the same five columns as the sweep and keeping the fence, `expired`, `expireLeasesOfOwner` (keeps owner/owner kind/fence), `read` with no expiry predicate, and `assertHeld` refusing absent/wrong-owner/wrong-fence/null-or-expired rows. Unknown node and `repository` subject throw plain `Error`s.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: exit 0
- lint (eslint on the three files): exit 0
- runtime smoke of the app, not tests: a scratch script built `SqliteStorage` on the real `migrations` list with a fixed clock, seeded the initiative/objective/two-task graph by direct `INSERT`, and drove the whole surface — first acquire on an empty lease table (fence 1), same-owner reuse (`acquired: false`, fence unmoved, expiry extended), self/ancestor/sibling/descendant refusals with the refusal object on the `LeaseError`, release clearing the five columns and keeping the fence, `lease-fenced` on a second release, initiative acquire, `expireLeasesOfOwner` bytewise-ordered subjects keeping owner and fence, `assertHeld` refusing an expired holding, repository-subject and unknown-node plain `Error`s — `SMOKE: PASS` (script under the temp dir, not committed)
  **Assumptions.**
- VERIFIED: no production consumer outside `services/lease` names `Lease`, `LeaseRecord` or `LeaseError` — grep over `src/` — so the widening is confined to this capability; `revoke-actor.ts:98` (`leasesFenced = 0`) is Story 13's lane and was not touched.
- VERIFIED: `LeaseOwnerKind` is imported from `src/domain/lease.ts`, never declared in the service, per the Story; the interface carries no eighth method and `LeaseErrorCode` keeps its three members.
- VERIFIED: `acquire` supports `subjectKind: "node"` only; a `repository` subject throws a plain `Error` whose message names the kind, matching the test's `/repository/` match.
- No test file and no `test/helpers/**` file was edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 7 GREEN · RED for Story 8 services/execution

**Cycle.** Confirm GREEN for Story 7 (`src/services/lease/sqlite.test.ts`), then RED for Story 8 (`src/services/execution/sqlite.test.ts`, new).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 7 confirm).**
- command: `node --test src/services/lease/sqlite.test.ts src/services/lease/not-implemented.test.ts`
- exit: 0 — pass 36, fail 0 — Story 7 closes.
- One test was red at first run, a defect in my own test fixture, fixed this turn: `expireLeasesOfOwner touches no lease of another owner` acquired `task_b` by `actorBeta` while `actorAlpha` already held `objective_a` — which the Story's own hierarchy rule (and the suite's sibling test at :483) pins as a `lease-held` ancestor refusal. The other-owner lease is now seeded through `insertLeaseRow` instead of `acquire`, matching the Story's "the other owner's row is deep-equal before and after".
  **Test written.**
- file: `src/services/execution/sqlite.test.ts` (new) — suite `src/services/execution/sqlite.test` — methods (the Story's 18, verbatim): `openRun writes an external objective run with null workspace, worker and base oid`; `openRun writes an external task run whose parent_run_id names the objective run`; `openRun refuses an objective run that names a parent run`; `activeRunOfNode returns the one active run or null`; `a second active run on one node is refused`; `adoptRun moves the lease fence and opens no second run`; `adoptRun on an ended run raises run-not-active`; `endRun writes the outcome and the end instant`; `endRun on an ended run raises run-not-active`; `openAttempt mints attempt_no 1 on an empty run, then 2`; `openAttempt reads the number from the rows` (seeded attempt_no 5 → 6); `closeAttempt writes the outcome and the end instant, and refuses a second close`; `attemptsOfRun returns every attempt ordered by attempt_no`; `runDriversUnderObjective returns every driver under the objective, ended runs included`; `runDriversUnderObjective returns an empty list for an objective with no run`; `an external attempt under an internal run is refused`; `SqliteExecution reads no clock`; `no node column holds an attempt count`.
- file: `src/domain/layout.test.ts` (edited) — capability inventory gains `execution` between `event` and `git`; suite title `seventeen capabilities plus home-lock` → `eighteen capabilities plus home-lock`.
- asserts: returned `RunRecord`/`AttemptRecord` literals; row reads through `transaction.get` (driver-conditional nulls, kind/parent, fence, attempt_limit, state, outcome, ended_at); constraint refusals through errcode 19 plus message (`CHECK constraint failed`, `UNIQUE constraint failed`, `FOREIGN KEY constraint failed`); `ExecutionError` codes `run-not-active` and `attempt-not-open`; `runDriversUnderObjective` ordering pinned by an internal run whose id sorts first under `ORDER BY r.id`; the no-clock source read and the `PRAGMA table_info(node)` attempt-free scan. Fixed identities (`objective_a`, `task_a`, `task_b` sibling, `run_01…`/`attempt_01…` via `createMockIdGenerator`), fixed `now`, `attemptLimit: 3`, `BASE` oid.
  **RED proof.**
- command: `node --test src/services/execution/sqlite.test.ts src/domain/layout.test.ts src/domain/attempt.test.ts`
- exit: 1 — pass 112, fail 3 — failures: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/services/execution/sqlite.ts' imported from .../execution/sqlite.test.ts`; `✖ every service directory holds an index.ts`; `✖ no src/services/*/index.ts contains an implementation` (the latter two fail because my test file created the `src/services/execution/` directory with no `index.ts` yet — they go green with the capability).
- stub probe: `src/services/execution/sqlite.ts` + `src/services/execution/index.ts` — clean: with throwaway stubs of the Story-declared surface, `npm run typecheck` exits 0 after one real fix in my own file (TS2532 — the `SELECT COUNT(*)` row needed the `as { n: number }` cast the lease test already uses); the suite registers all 18 tests and executes (2 legitimately pass against the stub: the no-clock source read and the no-attempt-column PRAGMA scan). Stubs deleted before handoff; `git status` shows only `sqlite.test.ts` under `src/services/execution/`.
  **Spec notes.**
- `RunDriver` is imported from `src/domain/run.ts:8` (EPIC 014 already exports it) — the service `index.ts` imports that one and re-exports no copy, per the Story's constraint.
- The layout `describe` and the `not-implemented.ts` list stay untouched: `execution` joins no fixed-list assertion, and the `agent/verify/lease` not-implemented test at `layout.test.ts:148` names no new capability.
  **Open to Software Engineer.**
- Seam: `src/services/execution/` per `08-services-execution.md` — the Story file is the spec; the test imports `SqliteExecution` from `./sqlite.ts` and `ExecutionError` from `./index.ts`.
- `src/services/execution/index.ts` (new) — interface only: `RunKind`, `RunRecord`, `AttemptRecord`, `OpenRunInput`, `AdoptRunInput`, `EndRunInput`, `OpenAttemptInput`, `CloseAttemptInput`, `Execution` with exactly the eight methods in the Story's order, and `ExecutionError` with `ExecutionErrorCode` of `run-not-found`, `run-not-active` and `attempt-not-open` in the shape of `LeaseError`. `RunDriver` imported from `src/domain/run.ts`, `AttemptOutcome` from `src/domain/attempt.ts:14`.
- `src/services/execution/sqlite.ts` (new) — `class SqliteExecution implements Execution`, constructor dependency `Readonly<{ ids: IdGenerator }>` only, opens no transaction, reads no clock (`at` is an input at every call): `openRun` writes `driver = 'external'` and null in the three internal-only columns, `activeRunOfNode` reads the one active row, `adoptRun`/`endRun` update through `RETURNING` and raise `run-not-active` on an empty result, `openAttempt` numbers from `accountAttempts` over `attemptsOfRun` (never a counter column) and writes null in the four internal-only columns, `closeAttempt` writes `WHERE outcome IS NULL` and raises `attempt-not-open`, `attemptsOfRun` orders by `attempt_no` ascending, `runDriversUnderObjective` runs the Story's `JOIN node` query with the objective id twice and `ORDER BY r.id`.
- Behaviour the test pins beyond the story text: the returned records carry the full member set in the literal shape; the ended-run case of `runDriversUnderObjective` is asserted through a three-member `["external", "external", "external"]` list; the ordering is pinned by the internal run id `run_0000000000000000000000000000` sorting first; `activeRunOfNode` returns `null` (never `undefined`) before any run and after `endRun`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 08-services-execution · the interface and SqliteExecution

**Cycle.** GREEN+REFACTOR for `src/services/execution/sqlite.test.ts`.
**Files changed.**

- `src/services/execution/index.ts` (new) — interface only: `RunKind`, `RunRecord`, `AttemptRecord`, `OpenRunInput`, `AdoptRunInput`, `EndRunInput`, `OpenAttemptInput`, `CloseAttemptInput`, `ExecutionError`/`ExecutionErrorCode` in the shape of `LeaseError`, `Execution` with exactly the eight methods in the Story's order; `RunDriver` imported from `src/domain/run.ts` (EPIC 014 already exports it) and `AttemptOutcome` from `src/domain/attempt.ts`, no copy re-exported
- `src/services/execution/sqlite.ts` (new) — `class SqliteExecution implements Execution`, constructor dependency `Readonly<{ ids: IdGenerator }>` only, opens no transaction, reads no clock
  **Seam (GREEN).** The test's call sites — `new SqliteExecution({ ids })`, the `run_*`/`attempt_*` ids from the mock generator, the external-driver records with null internal-only columns, the constraint refusals, `ExecutionError` codes `run-not-active` and `attempt-not-open`, the `runDriversUnderObjective` ordering pinned by the internal run id, and the no-clock source read — all resolve against the interface and the implementation's statements, which follow the Story's SQL verbatim: `openRun` writing `driver = 'external'` and null in `workspace_id`/`worker`/`base_oid`; `activeRunOfNode` on `node_id` + `state = 'active'`; `adoptRun`/`endRun` through `RETURNING` with `run-not-active` on an empty result; `openAttempt` numbering from `accountAttempts` over `attemptsOfRun` with the run's `attempt_limit` (never a counter column) and null in the four internal-only columns; `closeAttempt` on `outcome IS NULL` with `attempt-not-open`; `attemptsOfRun` ordered by `attempt_no` ascending; `runDriversUnderObjective` running the Story's `JOIN node` query with the objective id twice and `ORDER BY r.id`.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: exit 0
- lint (eslint on the two files): exit 0
- runtime smoke of the app, not tests: a scratch script built `SqliteStorage` on the real `migrations` list, seeded the objective/two-task graph, and drove the whole surface — objective and task `openRun` (external, null workspace/worker/base_oid), `activeRunOfNode` before/during/after, `adoptRun` fence 1→7 with the run count unchanged, `openAttempt` numbering 1 then 2, `closeAttempt` + `attempt-not-open` on the second close, `endRun` + `run-not-active` on adopt/end of an ended run, `attemptsOfRun` ordering, and `runDriversUnderObjective` three externals — `SMOKE: PASS` (script under the temp dir, not committed)
  **Assumptions.**
- VERIFIED: `identityKinds` at `src/domain/identity.ts:14-15` already carries `run` and `attempt`, so `ids.mint("run")`/`ids.mint("attempt")` produce `run_*`/`attempt_*` exactly as the mock generator's `identityPrefixes` does — no identity edit needed.
- VERIFIED: the `run-not-found` code of the Story's declared `ExecutionErrorCode` is raised by `openAttempt` on an unknown run, the one read path in this capability that looks a run up by id; no other method raises it.
- VERIFIED: no ninth method, no `driver` input member, no `nextAttemptNo`/counter column, no import of another capability's implementation — the file imports only `domain/`, the `storage`/`ids` interfaces and its own `index.ts`, so the import matrix holds.
- No test file and no `test/helpers/**` file was edited; `src/domain/layout.test.ts` was already updated by the TE in the RED turn and received no edit here.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 8 GREEN · RED for Story 9 the sweep

**Cycle.** Confirm GREEN for Story 8 (`src/services/execution/sqlite.test.ts`), then RED for Story 9 (`src/commands/startup/recover-expired-leases.test.ts`, extended; `src/commands/startup/recover-home.test.ts`, edited — the `LeasesResultLike`/`RecoveryReport` member Story 9 declares breaks its deep-equal at typecheck, so the test-side is prepared this turn, both-worlds-valid).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 8 confirm).**
- command: `node --test src/services/execution/sqlite.test.ts src/domain/layout.test.ts src/domain/attempt.test.ts`
- exit: 0 — pass 132, fail 0 — Story 8 closes.
  **Test written.**
- file: `test/helpers/lease.ts` (new) — `createLeaseFake()` — the seven `Lease` methods record their name on `calls` and throw `unexpected lease call: <name>`; the sweep tests assert `calls` stays empty, pinning the raw-`UPDATE lease` constraint ("Do not route it through `Lease.release`").
- file: `test/helpers/execution.ts` (new) — `createExecutionFake()` — recording `endRunCalls`/`closeAttemptCalls`/`attemptsOfRunCalls`, a configurable `attemptsByRun` map, and throwing `unexpectedCalls` for the other five methods.
- file: `src/commands/startup/recover-expired-leases.test.ts` (edited) — suite `src/commands/startup/recover-expired-leases.test` — new methods, the Story's names verbatim: `the external task path returns the task to ready under trigger claim-expired`; `the external task path calls no method of the Git fake`; `the external task path never writes dirty-recovery`; `the external objective path ends the objective run and moves no node state`; `the external objective path emits no lease-expired-on-non-task finding`; `the driver branch precedes the missing-workspace check`; `the lease clear keeps the fence on both paths`; `a swept row holds a null in every column but the fence`; `the recovery.leaseRecovered payload carries row.fence`; `sweepExpiredExternalLeases runs inside a supplied transaction`; `the sweep is deterministic in row order`; `one expired claim yields two swept rows`; `no raw node write survives in the file` (a `lintCase` over the file source, `layout.test.ts:68` pattern, asserting no `no-restricted-syntax`). Existing tests: `an expired lease on an objective node is reported and changes nothing` renamed to `an internal non-task lease still emits lease-expired-on-non-task`; the five `fence: 2` literals of the three internal-path tests become `fence: 1`, because the story removes the bump and the payload fence becomes `row.fence`; `runRecover` passes the two new dependencies.
- file: `src/commands/startup/recover-home.test.ts` (edited) — `StepOverrides.leasesResult` becomes `Readonly<Record<string, unknown>>` and the leases step merges it over the three-member default with an `as LeasesResultLike` cast (valid before AND after the SE widens the type); the report-copy test supplies `objectivesFreed: 2` in the override and expects it in the report.
- asserts: external task sweep — node `ready`, recorded `setNodeState` input `{ from: "running", to: "ready", trigger: "claim-expired", blockReason: null, at: NOW, cause }`, `endRunCalls`/`closeAttemptCalls` with `expired`/`cancelled`, lease `owner` null and `fence` unchanged (5), `recovery.leaseRecovered` payload `{ target, clean: false, headOid: null, baseOid: null, fence: 5, driver: "external", runId }`; external objective sweep — run ended, no `setNodeState` call, objective stays `running`, `objectivesFreed` 1, no `lease-expired-on-non-task`; rollback test — `sweepExpiredExternalLeases` called directly inside one `storage.transact`, a throw after it, and the node, run, attempt and lease all unchanged; row order and two-swept-rows — events in `subject_id` order (`objective_01…` before `task_01…`); the swept lease row deep-equals the `{ owner: null, owner_kind: null, fence, acquired_at: null, renewed_at: null, expires_at: null }` literal, the same shape `src/services/lease/sqlite.test.ts` asserts for a released row.
  **RED proof.**
- command: `node --test src/commands/startup/recover-expired-leases.test.ts`
- exit: 1 — fail 1, pass 0 — failure: `SyntaxError: The requested module './recover-expired-leases.ts' does not provide an export named 'sweepExpiredExternalLeases'`.
- command: `node --test src/commands/startup/recover-home.test.ts`
- exit: 1 — fail 1, pass 5 — failure: `✖ the report copies every counter and keeps refusesNewWork unsorted` (expected `objectivesFreed: 2` absent from the report until the SE adds the member).
- `npm run typecheck` — exactly five errors, all in my test file, all seam-shaped: TS2305 `no exported member 'sweepExpiredExternalLeases'`; TS2353 `'lease' does not exist in type` (deps widening); TS2339 `objectivesFreed` ×3. No error in any other file, including `recover-home.test.ts`.
- stub probe: `src/commands/startup/recover-expired-leases.ts` — with a throwaway stub of the Story-declared surface (`SweepExpiredExternalLeases*`, widened deps and result), `npm run typecheck` reports **one** error only, `src/main.ts(222,13)` — the SE's own call site, which the story itself says this story updates; every one of my files is clean. With the stub in place the suite executes: 16 pass, 15 fail — the three internal-path tests fail with `expected: { owner: null, expires_at: null, renewed_at: null, fence: 1 }` against the current fence 2 (the bump removal, right reason), and the twelve external tests fail on the stub. Stub deleted before handoff; `git status` shows no trace of it.
  **Open to Software Engineer.**
- `src/commands/startup/recover-expired-leases.ts` per `09-the-sweep.md` — the story is the spec: `CANDIDATE_SQL` gains `r.id AS run_id` and `r.driver`; `CandidateRow` gains `run_id`/`driver`; the three `SweepExpiredExternalLeases*` exports and the synchronous `sweepExpiredExternalLeases(dependencies, transaction, input)` that takes the caller's transaction, filters `driver = 'external'`, closes attempts `cancelled` and ends runs `expired` through the `Execution` interface, clears the lease with the raw five-column `UPDATE lease` that leaves `fence` alone, moves a task `running → ready` under trigger `claim-expired` through `plan.setNodeState` with `cause: { revision: <the written node's own revision>, importId: null }`, writes no node state for an objective, appends one `recovery.leaseRecovered` per row with `fence: row.fence` and `runId: row.run_id`; `RecoverExpiredLeasesDependencies` gains `lease` and `execution`; `RecoverExpiredLeasesResult` gains `objectivesFreed`; `recoverExpiredLeases` partitions by driver — external partition in one `storage.transact`, internal partition keeps the per-row loop and `writeVerdict`, whose lease UPDATE clears `owner_kind` and `acquired_at` too and stops bumping the fence, and whose payload fence becomes `row.fence`; the internal non-task `lease-expired-on-non-task` finding moves into the internal branch only.
- `src/domain/recovery.ts` — `LeasesResultLike` and `RecoveryReport` each gain `objectivesFreed` beside `returnedToReady`.
- `src/commands/startup/recover-home.ts` — copy `leases.objectivesFreed` into the report.
- `src/main.ts` — construct `new SqliteLease()` and `new SqliteExecution({ ids })` after `events` and pass `lease` and `execution` at the `recoverExpiredLeases` call site (the story owns this edit; Story 17 reuses the bindings).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 09-the-sweep · one sweep function, two entry points

**Cycle.** GREEN+REFACTOR for `src/commands/startup/recover-expired-leases.test.ts` (Story 9).
**Files changed.**

- `src/commands/startup/recover-expired-leases.ts` (edited) — `CANDIDATE_SQL` gains `r.id AS run_id` and `r.driver`; `CandidateRow` gains `run_id`/`driver`; new `SweepExpiredExternalLeasesDependencies`/`Input`/`Result` and the synchronous `sweepExpiredExternalLeases(dependencies, transaction, input)`; `RecoverExpiredLeasesDependencies` gains `lease` and `execution`; `RecoverExpiredLeasesResult` gains `objectivesFreed`; `recoverExpiredLeases` partitions rows by driver — the external partition in one `storage.transact` through the sweep, the internal partition through the unchanged per-row loop and `writeVerdict` — and the non-task `lease-expired-on-non-task` finding moved into the internal branch; `writeVerdict` clears `owner_kind` and `acquired_at` too, stops bumping the fence, and reports `fence: row.fence`
- `src/domain/recovery.ts` (edited) — `LeasesResultLike` and `RecoveryReport` each gain `objectivesFreed` beside `returnedToReady`
- `src/commands/startup/recover-home.ts` (edited) — the report copies `leases.objectivesFreed`
- `src/main.ts` (edited) — `const lease = new SqliteLease()` and `const execution = new SqliteExecution({ ids })` after `events`; the `recoverExpiredLeases` call site passes both
  **Seam (GREEN).** The sweep's call sites — `sweepExpiredExternalLeases({ plan, lease, execution, events }, transaction, { actor, now })` returning `{ returnedToReady, objectivesFreed }`, `execution.attemptsOfRun`/`closeAttempt`/`endRun` in the test-pinned order, `plan.setNodeState` under `claim-expired` with `cause: { revision: row.revision, importId: null }`, the raw five-column `UPDATE lease` that leaves `fence` alone, the `recovery.leaseRecovered` payload `{ target, clean: false, headOid: null, baseOid: row.base_oid, fence: row.fence, driver: "external", runId: row.run_id }`, and the driver-first partition that keeps an external row with no workspace out of `recovery-inputs-missing` — all resolve against the Story's SQL and event shape. The lintCase source scan finds no raw node write, because every state change goes through `plan.setNodeState`.
  **Refactor.** None named in this Task beyond the single-function restructure the Story itself specifies (external partition + internal loop sharing one `CANDIDATE_SQL` read).
  **Build check.**
- typecheck: exit 1 — **one error, in the TE's own file**: `src/commands/startup/recover-home.test.ts(101,14): error TS2352` — the `as LeasesResultLike` cast of the leases-step default literal (details below)
- lint (eslint on the four changed files): exit 0
- runtime smoke of the app, not tests: a scratch script built the Story-9 state on the real `SqliteStorage` + real `SqlitePlanStore`/`SqliteLease`/`SqliteExecution` (objective + task `running`, external objective run fence 3, external task run fence 5, open external attempt, both leases expired) and ran `recoverExpiredLeases` — task `ready` under `claim-expired`, objective stays `running`, both runs `ended`/`expired`, attempt `cancelled`, both leases cleared with fences 3 and 5 kept, two `recovery.leaseRecovered` events in `subject_id` order with payload fences 3 and 5, result `{ returnedToReady: 1, objectivesFreed: 1, blocked: 0, findings: [] }` — `SMOKE: PASS` (script under the workspace root, deleted after; `git status` shows no trace)
  **OPEN: `src/commands/startup/recover-home.test.ts:101-106` — the TE's fixture cast is invalid once the Story's widening lands.**
- What: the leases step builds `{ returnedToReady: 0, blocked: 0, findings: [], ...overrides.leasesResult } as LeasesResultLike`. The TE's turn states this is "valid before AND after the SE widens the type"; it is not. A scratch probe (`tsc --noEmit --strict` on the exact shape) confirms TypeScript infers the literal as `{ returnedToReady: number; blocked: number; findings: never[] }` — the spread of `Readonly<Record<string, unknown>> | undefined` contributes **no** index signature and no member to the object literal's type — so once `objectivesFreed` is a required member (as `09-the-sweep.md:70` mandates), the direct `as LeasesResultLike` cast fails TS2352. The widening is the Story's spec and I will not weaken `objectivesFreed` to optional to paper over a test-file cast.
- Fix (TE's lane): add `objectivesFreed: 0` to the default literal before the spread (making the four-member default mirror the type), or cast through `unknown` (`as unknown as LeasesResultLike`). Both keep the override mechanism intact. No production file needs a change.
- Everything else in this Task is implemented and verified; `npm run typecheck` reports no error in any production file.
  **Assumptions.**
- VERIFIED: `RecoverExpiredLeasesResult` is consumed only by `recover-home` (as `LeasesResultLike`) and the tests — grep over `src/` — so the added member has no further call site to update.
- VERIFIED: the internal-path expectations stay byte-identical: the three internal tests' lease rows keep fence 1 (`insertLease` seeds 1, `writeVerdict` no longer bumps) and the payload fences drop from 2 to 1, matching the renamed `row.fence` semantics of `09-the-sweep.md:90`.
- VERIFIED: `sweepExpiredExternalLeases` opens no transaction, reads no clock, is synchronous, calls no `Git` method, and routes no lease clear through `Lease.release` — the raw `UPDATE lease` runs directly, and `test/helpers/lease.ts`'s recording fake pins that no `Lease` method is called.
- VERIFIED: `main.ts` remains the only file naming `SqliteLease`/`SqliteExecution`; `migrate` (the second `serve`-independent path) needs neither.
- No test file and no `test/helpers/**` file was edited.

ATTEMPT-FAILED: Story 9 the sweep — typecheck blocked by TS2352 at `src/commands/startup/recover-home.test.ts:101` (TE fixture cast invalid after the Story-mandated `objectivesFreed` widening; fix named in OPEN).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 9 GREEN · RED for the coupled 10+11 claimNode

**Cycle.** Confirm GREEN for Story 9 (`src/commands/startup/recover-expired-leases.test.ts` + `recover-home.test.ts`), resolving the SE's OPEN on my fixture cast, then RED for the coupled Stories 10+11 (`src/commands/node/claim-node.test.ts`, new — one file for both, per the Story-10 Verify and Story-11 "Add to").
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact re-verifies independently.
- The SE's OPEN (`recover-home.test.ts:101-106`, cast invalid after the `objectivesFreed` widening) is resolved in the working tree: the leases-step default literal now carries `objectivesFreed: 0` before the spread, exactly the SE's prescribed fix. `npm run typecheck` exits 0 with no error anywhere.
  **Verification result (Story 9 confirm).**
- command: `node --test src/commands/startup/recover-expired-leases.test.ts src/commands/startup/recover-home.test.ts`
- exit: 0 — pass 37, fail 0 — Story 9 closes.
  **Test written.**
- file: `src/commands/node/claim-node.test.ts` (new) — suite `src/commands/node/claim-node.test` — the Story's 42 methods, verbatim names: the 31 Story-10 bullets (`a claim on a ready task returns a lease…`, `…opens an external objective run and an external task run`, `…opens attempt number 1`, `a claim on an objective opens no attempt`, `heartbeatIntervalMs is one third of leaseTtlMs`, `a claim on an initiative is refused initiative-not-claimable and writes nothing`, `an unknown node is refused node-not-found`, `a claim under an objective that holds no task is refused plan-incomplete with exactly objective-without-task`, the six-state `illegal-transition` loop, `a claim on a task whose objective is already running writes no objective state change and still succeeds`, `the state branch holds two cases only`, `a replayed claim writes nothing at all`, `a replayed claim opens no second attempt`, `a new acquisition over a freed row is not mistaken for a replay`, `the same actor claims two ready sibling tasks in turn`, `an actor claims an objective and then a task under it with no self-deadlock`, the three `lease-held` refusals with relation `sibling`/`descendant`/`self` and the refusal-before-any-write deep-equal, `a claim over an expired lease goes through the sweep and never through a takeover branch` (old runs ended `expired`, attempt closed `cancelled`, new fences old+1, new run attempt `1`, events exactly `[recovery, recovery, lease.claimed, node.running]` bytewise), `a re-claim on the same run numbers the next attempt 2`, `no event of type lease.takenOver exists in the repository` (recursive `src/` scan), the two `drive-mode-pinned` refusals with `adoptRun` never called, `a claim whose run history is empty succeeds, and a claim whose history holds external runs only succeeds`, `the claimed task write names trigger claim-taken`, `a setNodeState call whose trigger disagrees with the pair throws and commits nothing`, `no path of the claim writes awaiting_approval`, `the sibling race commits exactly one claim`, `one claim reads the clock once`, `the abandoned objective is freed by expiry and by nothing else`, `the claim-driven sweep needs no restart and no timer`) and the 11 Story-11 bullets (`a task claim starts the objective and then the initiative`, `an objective claim starts the initiative only`, `each cascade write records trigger ancestor-started`, `each cascade event is attributed to the daemon with reason child-started`, `the claimed node's own event keeps the calling actor`, `an ancestor already running is left untouched`, the six-state `ancestor-not-startable` loop, `a refused cascade writes no partial cascade`, `a cascade with the ancestor-started trigger on a task node throws`, `the full event order of one claim is exact`).
- asserts: real SQLite through `createMigratedStorage`; `Lease`/`Execution` are the existing backed fakes of `test/helpers/lease.ts` and `execution.ts` (write real rows, record calls); `PlanStore` is the EPIC-016 recording fake over a real `SqlitePlanStore` with a real readiness; the sweep dependency is the **real** `sweepExpiredExternalLeases` bound with the fakes, so the claim transaction runs the genuine recovery (the two recovery events, the `expired` runs, the `cancelled` attempt and the kept fences are real-row assertions); `databaseBytes` deep-equal before/after every refusal; event order via `events.list` id order; refusal details asserted member-wise per the Story (`{ subject, holder, holderKind, fence, expiresAt, relation }`, `{ state, admitted }` without `ancestorId`, `{ ancestorId, state, admitted }`, `{ pinnedDriver, claimDriver }`, `{ findings }`, `{ refusal }`); `lease.claimed` payload member-wise; cascade events `actorKind: "daemon"`, `actorId: instanceId`, `payload.reason: "child-started"`; the claimed node's own `node.running` keeps the calling `harness` actor. Fixed identities (`task_a`/`task_b`, `objective_a`, `initiative_a`, `task_pb` in project_b, the empty-objective fixture), fixed `now = 1700000000000`, `leaseTtlMs: 300000` → `heartbeatIntervalMs: 100000`, actor owners `actor_alpha`/`actor_beta`.
  **RED proof.**
- command: `node --test src/commands/node/claim-node.test.ts`
- exit: 1 — fail 1 — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/commands/node/claim-node.ts' imported from .../src/commands/node/claim-node.test.ts`.
- command: `npm test` — exit 1 — 4206 pass, 1 fail (the RED file alone); nothing else red.
- stub probe: `src/commands/node/claim-node.ts` — with a throwaway stub of the Story-declared surface, `npm run typecheck` exits 0 after two real fixes in my own file (the three `lease.release` call sites needed `ownerKind` per the widened `ReleaseLeaseInput`, and one undefined `ACTOR_BETA` constant → `ACTOR_B`); with the stub the suite executes all 42 tests: 2 pass, 40 fail — the 2 passes are the repository-wide `lease.takenOver` scan and the direct `setNodeState` trigger-pair guard, both intended to pass today; every other failure is `Error: stub` or `expected ClaimNodeError, got Error: stub`, the right reason. Stub deleted before handoff; `git status` shows only `claim-node.test.ts` under `src/commands/node/`.
- typecheck after stub deletion: exactly one error, `TS2307 Cannot find module './claim-node.ts'`, the seam — nothing of mine hides behind it (the probe proved the suite's types against the declared surface).
  **Spec notes.**
- `claimNode`'s own `ids` dependency is exercised with an empty mock generator: nothing in the Story's flow mints inside the command (run/attempt ids mint inside the `Execution` dependency, event ids inside `EventLog`). If the SE's implementation mints, `ids-exhausted` fires and I will size the mock — but the Story's step list names no mint.
- The `node` member of `ClaimNodeResult` is read for `id` and `state` only; any view carrying both satisfies the suite (the command has no `blobs` dependency, so the full `show-node` view is not reachable — the SE decides the shape, the test pins nothing more).
- The two release-simulation tests (`a new acquisition over a freed row…`, `a re-claim on the same run…`) drive the Story-12 release shape through the fakes — `closeAttempt cancelled` + `endRun released` + `lease.release` + `setNodeState claim-released` — because `releaseNode` is not implemented until Story 12 and cannot be imported here.
- The sibling/descendant/self refusal fixture seeds the sibling task lease directly (backed `acquire` on the task only, no objective lease): with the objective also held, `liveLeaseRefusal` precedence (ancestor before sibling) names the objective, and the Story's assertion requires `subject` = the sibling task.
- The no-restart test asserts the task's `ready` state through direct node reads; the Story's `listNodes({ state: "ready" })` call belongs to Story 15's query and is not importable from a command test.
- No `test/helpers/**` edit was needed: the backed lease/execution fakes and the recording plan fake already exist.
  **Open to Software Engineer.**
- `src/commands/node/claim-node.ts` (new) — Stories `10-claim-node.md` and `11-ancestor-start-cascade.md` are the spec; the test imports `claimNode`, `ClaimNodeError` and `ClaimNodeResult` from `./claim-node.ts`.
- Declared surface, verbatim: `ClaimNodeDependencies` (`storage`, `plan`, `lease`, `execution`, `events`, `clock`, `ids`, the bound `sweepExpiredExternalLeases(transaction, { actor, now }) => void`, `attemptLimit`, `leaseTtlMs`, `instanceId`); `ClaimNodeInput` (`nodeId`, `actorId`, `actorKind: "human" | "harness"`); `ClaimNodeResult` (`lease`, `objectiveLease` as `ClaimedLease { subjectId, owner, ownerKind: "actor", fence, expiresAt }`, `runId`, `objectiveRunId`, `attemptId: string | null`, `attemptNo: number | null`, `heartbeatIntervalMs`, `node` carrying at least `id` and `state`); `ClaimNodeError` with `refusal: ClaimRefusal` and `details`; `ClaimRefusal` the seven-member closed union.
- Behaviour the suite pins (step order normative): one `storage.transact`, one `clock.now()`; sweep first; `readAllNodes` once; completeness over the claimed node and its containment ancestors only with the pinned parents/children order; the read-only `liveLeaseRefusal` pre-check on the claimed node (this is what makes `sibling` and `descendant` reachable); the replay branch before any write (identical fences/runs/attempt, zero events, deep-equal database, one open attempt, `openAttempt` never called); objective scope with `runDriversUnderObjective` + `objectiveDrivePin`; objective run open/adopt with the internal-driver refusal before any adoption; task lease/run/attempt only for a task claim; the two-case state branch (`ready` → `claim-taken`, else `illegal-transition` with `{ state, admitted }` and no `ancestorId`); events `lease.claimed` (payload `{ subjectId, objectiveId, fence, objectiveFence, expiresAt, runId, objectiveRunId, attemptId, attemptNo }`, calling actor) then cascade `node.running` (daemon, `instanceId`, reason `child-started`, nearest ancestor first) then the claimed node's own with the calling actor; `heartbeatIntervalMs = Math.floor(leaseTtlMs / 3)`; the Story-11 cascade verdicts computed before any write with `ancestor-not-startable` `{ ancestorId, state, admitted }`; `cause` = the written node's own revision with `importId: null`; no `awaiting_approval`, no `lease.takenOver`, no git, no takeover branch, no command import.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 10+11 claimNode · the claim command and the ancestor cascade

**Cycle.** GREEN+REFACTOR for `src/commands/node/claim-node.test.ts` (coupled Stories 10 + 11).
**Files changed.**

- `src/commands/node/claim-node.ts` (new) — `ClaimNodeDependencies`, `ClaimNodeInput`, `ClaimNodeResult`, `ClaimNodeError`, `ClaimRefusal`, `ClaimedLease`, `NodeView` and `claimNode`, implementing the Story's steps in the normative order: the bound `sweepExpiredExternalLeases` first on the caller's transaction; one `readAllNodes` and one `clock.now()`; completeness over the containment chain (`parents` from the initiative down, `children` per parent sorted by `Buffer.compare`); the read-only `liveLeaseRefusal` pre-check on the claimed node; the replay branch (`running` + own live lease) before any write; the objective scope with `runDriversUnderObjective` + `objectiveDrivePin`; `lease.acquire` with the `LeaseError` → `ClaimNodeError` mapping; the three-case objective-run rule (open / adopt external / refuse internal); the task lease/run/attempt for a task claim only; the two-case state branch (`ready` → `claim-taken`, every other state → `illegal-transition`); the cascade verdicts computed before any write (nearest ancestor first, `ready` → `ancestor-started`, `running` untouched, anything else → `ancestor-not-startable` with `{ ancestorId, state, admitted }`); then the exact event order `lease.claimed` → cascade `node.running` (daemon, `instanceId`, reason `child-started`) → the claimed node's own `node.running` (calling actor); `cause` is each written node's own revision with `importId: null`; `heartbeatIntervalMs = Math.floor(leaseTtlMs / 3)`.
  **Seam (GREEN).** Every call site of the suite resolves against the declared surface and behavior: the empty mock `ids` generator is never touched (no mint inside the command — run/attempt ids come from the `Execution` dependency, event ids from `EventLog`); the refusals carry exactly the details the tests deep-equal — `{ refusal }`, `{ findings }`, `{ subject, holder, holderKind, fence, expiresAt, relation }`, `{ pinnedDriver, claimDriver }`, `{ state, admitted }` with no `ancestorId`, `{ ancestorId, state, admitted }`; the replay returns identical fences/runs/attempt with zero events and no `openAttempt`; the freed-row claim is not mistaken for a replay (decided from the pre-write state, never from the post-acquisition owner); the claimed node's own event keeps the calling actor while cascade events carry the daemon identity.
  **Refactor.** None named in either Task; the cascade lives as the private `cascadeVerdicts`/`ancestorChain` pair the Story requires, and verdicts are computed before any write so a refused cascade writes no partial state.
  **Build check.**
- typecheck: exit 0
- lint (eslint on the new file): exit 0
- runtime smoke of the app, not tests: a scratch driver over the real `SqliteStorage` + `migrations` + `SqlitePlanStore`/`SqliteLease`/`SqliteExecution`/`SqliteEventLog` + the real bound sweep drove the whole journey — the three lease-held refusals with exact details (sibling names the sibling task, descendant names the held task, self), the full claim (fences 1, external runs, attempt 1, three states by identity, exact event order, `heartbeatIntervalMs` 100000), the replay (identical response, zero events, one attempt), the freed-row claim by a second actor (new run, attempt 1, `+2` events with the claiming actor), the same-owner sibling claim (objective fence unchanged, objective run reused), the expired-leases claim (sweep → fences 1→2, new run with attempt 1, recovery events first in subject order), the abandoned objective (freed by expiry, objective stays `running`, re-claim fence 3, objective replay), the four schema-seedable claimed-task states (`illegal-transition` with exact details, nothing written), all six ancestor states (`ancestor-not-startable`, nothing written), the drive-mode pin on an internal run (never adopted), `plan-incomplete` with exactly `objective-without-task`, and the objective claim (no attempt, run reuse) — `SMOKE: PASS` (pass 59, fail 0; script deleted, `git status` shows no trace)
  **OPEN: the two claimed-task six-state loops seed schema-forbidden states.**
- What: `a claim on the claimed node in any of six states is refused illegal-transition` (`claim-node.test.ts:521`) and `the state branch holds two cases only` (`:585`) loop the claimed **task** through `SIX_STATES` including `awaiting_approval` and `partial`. Migration 0002's node table refuses both on a task: `CHECK (state <> 'awaiting_approval' OR kind = 'objective')` and `CHECK (state <> 'partial' OR kind <> 'task')` at `src/services/storage/migration-0002-graph-and-plan.ts:40-41`. `seedNodeState(task, "awaiting_approval")` throws `CHECK constraint failed` at the seed, before any claim — reproduced directly through the real migrations list. The TE's stub probe never saw it, because the loop aborts at its first iteration (`pending` → `Error: stub`) before reaching the third. The four seedable states (`pending`, `blocked`, `done`, `discarded`) all refuse `illegal-transition` with the exact details through the real implementation, verified by smoke.
- Fix (TE's lane; the established precedent is `src/commands/node/update-node.test.ts:462`, which seeds `awaiting_approval`/`partial` on the **objective** because the schema forbids them on tasks): seed the two states on the claimed objective (an objective claim on an objective in `awaiting_approval`/`partial` reaches the same state branch with the same `{ state, admitted }` details), or drop them from the task loops. No production change can make those two iterations seedable: migration 0002 is not this epic's lane, and weakening its CHECK would break the schema-parity suites.
  **Assumptions.**
- VERIFIED: the ancestor loop (`an ancestor in any of six other states...`, `:1381`) seeds the **objective**, which both CHECKs admit (`kind = 'objective'` / `kind <> 'task'`), so all six `ancestor-not-startable` iterations are seedable and refuse with `{ ancestorId, state, admitted }` — smoke-covered.
- VERIFIED: the file imports only `domain/` and service interfaces (the import matrix holds), calls no command, no git, reads no clock inside a service, and contains no `lease.takenOver` string and no `awaiting_approval` write.
- No test file and no `test/helpers/**` file was edited.

ATTEMPT-FAILED: Story 10+11 claimNode — two iterations of each claimed-task six-state loop seed `awaiting_approval`/`partial` on a task, which migration 0002's node CHECK forbids; the seed throws before the claim (OPEN names the TE-side fixture fix; the four seedable states and every other assertion are green).

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm 10+11 GREEN · RED for Story 12 heartbeat and release

**Cycle.** Confirm GREEN for Stories 10+11 (`src/commands/node/claim-node.test.ts`), resolving the SE's OPEN with two fixture edits in my lane, then RED for Story 12 (`src/commands/node/heartbeat-node.test.ts` + `src/commands/node/release-node.test.ts`, both new).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Stories 10+11 confirm).**
- command: `node --test src/commands/node/claim-node.test.ts`
- exit: 0 — pass 42, fail 0 — Stories 10+11 close.
- The SE's OPEN is resolved with two fixture edits in `claim-node.test.ts` (my lane), both following the `update-node.test.ts:462` precedent:
  1. **The two claimed-node six-state loops** (`a claim on the claimed node in any of six states…` and `the state branch holds two cases only`): `awaiting_approval` and `partial` are schema-forbidden on a task — migration 0002's node CHECKs admit them on an objective only (`state <> 'awaiting_approval' OR kind = 'objective'`, `state <> 'partial' OR kind <> 'task'`). Those two iterations now seed the state on the claimed **objective** and claim the objective; the state branch is kind-agnostic (`claim-node.ts:268`) and refuses with the identical `{ state, admitted: ["ready", "running"] }` details and no `ancestorId`. The four seedable states still drive the task.
  2. **The ancestor loop's `discarded` iteration**: Story 10's mandated discarded-child completeness filter (line 65) excludes the discarded objective from the initiative's children, so `plan-incomplete` fired before the cascade. The iteration now inserts a second live objective under the initiative, so the initiative stays complete and the discarded objective is reached as the claimed task's ancestor — `ancestor-not-startable` with the exact `{ ancestorId, state, admitted }` details Story 11's Verify demands. Verified by probe: with the sibling objective absent, the real command answers `plan-incomplete`; with it present, `ancestor-not-startable`.
  3. A third fix, self-inflicted: the repository-wide `lease.takenOver` scan walked `*.test.ts` files, so my own test file (which must name the literal to assert its absence) was the offender. The scan now skips `*.test.ts` — the assertion's purpose is production files.
     **Test written.**
- file: `src/commands/node/heartbeat-node.test.ts` (new) — suite `src/commands/node/heartbeat-node.test` — the Story's 12 methods, verbatim: `a heartbeat with the current fence extends expires_at on both the task lease and the objective lease` (assert both rows equal `now2 + leaseTtlMs`); `a heartbeat leaves both fences unchanged`; `a heartbeat with any other fence is refused lease-held and writes nothing` (lease rows deep-equal before/after, event count unchanged); `a heartbeat by another owner is refused lease-held and writes nothing`; `a heartbeat moves no node` (recording `PlanStore` fake gained no call, all three states still `running`); `a heartbeat on an objective renews the objective lease only` (task lease row deep-equal before/after); `a heartbeat appends one lease.renewed event` (type, subject, actor, and the six-member payload `{ subjectId, objectiveId, fence, objectiveFence, expiresAt, objectiveExpiresAt }`); `a heartbeat on an unknown node is refused node-not-found`; `a heartbeat on an initiative is refused initiative-not-claimable and writes nothing` (database deep-equal); `a heartbeat whose objective lease is absent or free is refused lease-held and writes nothing` (two fixtures: row deleted, and owner nulled with `owner_kind`); `a heartbeat whose own holding has expired is refused lease-held and writes nothing` (right owner and fence, `now` past `expires_at`); `heartbeatIntervalMs is one third of leaseTtlMs` (assert `100000`).
- file: `src/commands/node/release-node.test.ts` (new) — suite `src/commands/node/release-node.test` — the Story's 13 methods, verbatim: `a task release with the current fence frees the task lease, moves the task to ready, and leaves the fence unchanged` (the released row holds null in `owner`, `owner_kind`, `acquired_at`, `renewed_at` and `expires_at` and keeps fence 1); `a task release leaves the objective lease held and the objective run active` (then a second actor's claim on the objective is refused `lease-held`); `a task release closes the attempt cancelled and ends the run released`; `a task release records trigger claim-released` (recording fake, deep-equal input with `cause { revision, importId: null }`); `a task release with a wrong fence or a wrong owner is refused and writes nothing` (two cases, database deep-equal); `an objective release while a task lease under it is live is refused lease-held and writes nothing` (`details.subject` = the task, `details.holder` = the actor, `details.relation` = `"descendant"`, database deep-equal); `an objective release after every task release frees the objective lease and ends the objective run released` (objective state still `running`); `an objective release writes no objective node state` (no new objective `setNodeState` call); `an initiative release is refused initiative-not-claimable and writes nothing`; `a stale release is refused lease-held and not no-open-attempt`; `a release whose run has no open attempt is refused no-open-attempt` (attempt closed directly through `Execution`, lease still live); `a release result carries the node view`; **`no path of this epic writes awaiting_approval`** — the EPIC `:205` journey, one fixture: claim → heartbeat → release → re-claim → `sweepExpiredExternalLeases` past `TTL` → final re-claim, `everyNodeState` read after each of the six steps and asserted never `awaiting_approval`, then the two rows of this epic (`claim-released`, `claim-expired`) asserted to target no `awaiting_approval`.
- asserts: real SQLite rows through the backed lease/execution fakes and the recording plan fake (Story 10 conventions); `HeartbeatNodeError`/`ReleaseNodeError` with `refusal` and `details`; fixed identities, `now = 1700000000000`, `ttlMs 300000`, `heartbeatIntervalMs 100000`, actors `actor_alpha`/`actor_beta`; the journey uses a hand-rolled mutable clock.
  **RED proof.**
- command: `node --test src/commands/node/heartbeat-node.test.ts src/commands/node/release-node.test.ts`
- exit: 1 — fail 2 (suites) — failure: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/commands/node/heartbeat-node.ts' imported from .../heartbeat-node.test.ts`; the release suite fails on the same missing `heartbeat-node.ts` (first import) and would fail on `release-node.ts` next — both seams absent.
- command: `node --test src/commands/node/claim-node.test.ts` — exit 0 — pass 42 — the confirm suite stays green after the fixture edits.
- stub probe: `src/commands/node/heartbeat-node.ts` + `src/commands/node/release-node.ts` — clean: with throwaway stubs of the Story-declared surfaces, `npm run typecheck` exits 0 and both suites register all 25 tests and execute (25 fail on `Error: stub`, the right reason). Stubs deleted before handoff; `git status` shows only the two `.test.ts` files.
- Spec notes: the `externalTransitions` journey assertion is scoped to this epic's two rows because EPIC-014's `object-reported` row legitimately targets `awaiting_approval`; the release `details` member names follow the claim's `lease-held` vocabulary (`subject`, `holder`, `relation`); the heartbeat result's `lease`/`objectiveLease` are asserted member-wise on the `ClaimedLease` shape.
  **Open to Software Engineer.**
- Seam: `src/commands/node/heartbeat-node.ts` and `src/commands/node/release-node.ts`, per `12-heartbeat-and-release.md` — the Story file is the spec; the tests import `heartbeatNode`, `HeartbeatNodeError`, `HeartbeatNodeResult` from `./heartbeat-node.ts` and `releaseNode`, `ReleaseNodeError`, `ReleaseNodeResult` from `./release-node.ts`.
- `HeartbeatNodeDependencies` (`storage`, `plan`, `lease`, `events`, `clock`, `leaseTtlMs`); `HeartbeatNodeInput` (`nodeId`, `fence`, `actorId`, `actorKind: "human" | "harness"`); `HeartbeatNodeResult` (`lease: ClaimedLease`, `objectiveLease: ClaimedLease`, `heartbeatIntervalMs`); `HeartbeatNodeError` with `refusal` over `"node-not-found" | "initiative-not-claimable" | "lease-held"` in the shape of `ClaimNodeError`.
- `ReleaseNodeDependencies` (`storage`, `plan`, `lease`, `execution`, `events`, `clock`); `ReleaseNodeInput` (same member set); `ReleaseNodeResult` (`node: NodeView` carrying at least `id` and `state`); `ReleaseNodeError` with `refusal` over `"node-not-found" | "initiative-not-claimable" | "lease-held" | "no-active-run" | "no-open-attempt" | "illegal-transition"`.
- Behaviour the suites pin: one transaction and one `clock.now()` per call; heartbeat renews the named node's lease against the presented fence, renews the objective lease of the same owner for a task only (absent/free/other-owner/expired objective → `lease-held`), moves no node and no fence, and appends one `lease.renewed` event with the six-member payload; release validates authority first (`assertHeld` → `lease-held` before any write), a task release closes the open attempt `cancelled`, ends the run `released`, moves the task `running → ready` under `claim-released` and frees the task lease alone, an objective release refuses while any live child lease exists (`lease-held` with `details` naming the task, the holder and `relation: "descendant"`), ends the objective run `released` and frees the objective lease without moving objective state, and neither path writes `awaiting_approval`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 12-heartbeat-and-release · the two commands

**Cycle.** GREEN+REFACTOR for `src/commands/node/heartbeat-node.test.ts` and `src/commands/node/release-node.test.ts` (Story 12).
**Files changed.**

- `src/commands/node/heartbeat-node.ts` (new) — `HeartbeatRefusal` (`node-not-found | initiative-not-claimable | lease-held`), a local `ClaimedLease`, `HeartbeatNodeDependencies` (`storage, plan, lease, events, clock, leaseTtlMs`), `HeartbeatNodeInput`, `HeartbeatNodeResult` (`lease`, `objectiveLease`, `heartbeatIntervalMs`), `HeartbeatNodeError` with `refusal`/`details`, and `heartbeatNode` — one `storage.transact`, one `clock.now()`; unknown node → `node-not-found`, initiative → `initiative-not-claimable`; renew the named node's lease against the presented fence, a `LeaseError` of code `lease-fenced` raising `lease-held`; for a task only, read the objective lease and branch on exactly the four total cases (own live → renew with that row's own fence, other owner / absent or free / own expired → `lease-held`); one `lease.renewed` event with the six-member payload `{ subjectId, objectiveId, fence, objectiveFence, expiresAt, objectiveExpiresAt }`; moves no node and no fence; `heartbeatIntervalMs = Math.floor(leaseTtlMs / 3)`
- `src/commands/node/release-node.ts` (new) — `ReleaseRefusal` (the six-member closed union), a local `NodeView`, `ReleaseNodeDependencies` (`storage, plan, lease, execution, events, clock`), `ReleaseNodeInput`, `ReleaseNodeResult` (`node`), `ReleaseNodeError`; `releaseNode` validates `lease.assertHeld` first (`lease-fenced` → `lease-held`), so a stale caller reads `lease-held` and never `no-open-attempt` or `run-not-active`; the task branch: active run or `no-active-run`, exactly one open attempt or `no-open-attempt` (more than one is a plain `Error` naming the run), `closeAttempt cancelled` → `endRun released` → `setNodeState claim-released` with `cause: { revision: node.revision, importId: null }` → `lease.release` (five columns cleared, fence kept) → one `lease.released` event; the objective branch: a bytewise child scan through `lease.read` refuses a live child with `lease-held` and `details` naming that task, its holder and `relation: "descendant"`, then ends the objective run `released` and frees the objective lease, writing no objective node state; initiative → `initiative-not-claimable`; a task release frees the task lease only, leaving the objective lease and run untouched
  **Seam (GREEN).** The suites' call sites resolve against the declared surface and behave per the pinned fixtures: both `expires_at` values reach `now2 + leaseTtlMs` on a task heartbeat with fences unmoved; every refusal path rolls the transaction back so lease rows, event counts and `databaseBytes` stay deep-equal; the objective-scope heartbeat renews the objective alone; the release's step-0 `assertHeld` ordering answers `lease-held` for the stale release and `no-open-attempt` only when the lease is live and the attempt is closed; the objective release reports the bytewise-first live child with `relation: "descendant"`; the `claim-released` `setNodeState` input deep-equals the pinned literal; the journey drives claim → heartbeat → release → re-claim → sweep → re-claim with no state ever `awaiting_approval`.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: exit 0
- lint (eslint on the two files): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- runtime smoke of the app, not tests: a 34-check driver over the real `SqliteStorage` + `migrations` + `SqlitePlanStore`/`SqliteLease`/`SqliteExecution`/`SqliteEventLog` and the real bound sweep drove the full journey — claim (fences 1, attempt 1, interval 100000); heartbeat at `now2` extending both leases to `now2 + TTL` with fences kept and the six-member payload pinned; wrong-fence and other-owner heartbeats refused `lease-held` with rows byte-identical; objective heartbeat renewing the objective only; objective release refused while the task lease is live with `details.subject`/`relation: "descendant"`; task release freeing the five columns at fence 1, task `ready` under `claim-released`, run `released`, attempt `cancelled`, objective lease held and objective run active; stale release `lease-held`; second-actor objective claim refused; objective release ending the objective run `released` with the objective still `running`; initiative heartbeat/release `initiative-not-claimable`; no-open-attempt release refused; heartbeat of a freed lease `lease-held` — `SMOKE: PASS` (scratch driver deleted; `git status` shows no trace)
  **Assumptions.**
- VERIFIED: `runInTransaction` rolls back on a throw (`src/services/storage/connection.ts:80-88`), so every refusal leaves rows, events and database bytes byte-identical — the deep-equal and event-count assertions hold.
- VERIFIED: `setNodeState` never rewrites `revision` (`UPDATE_NODE_STATE` at `src/services/plan/sqlite.ts:34-35`), so the release's `cause: { revision, importId: null }` deep-equals `fixtureIds.planRevision` even after a claim.
- VERIFIED: the recording `PlanStore` fake records `mutateGraph`/`setNodeState` only (`test/helpers/plan.ts:107-116`), so the heartbeat's `readAllNodes` adds no recorded call and the "moves no node" assertion holds.
- VERIFIED: the protocol section under `## node.heartbeat` of `docs/proposal/api/execution.md` (lines 96-104) already carries every Story-12 bullet verbatim — no doc edit needed.
- Provenance: the two command files were already on disk when this turn began (an unrecorded GREEN attempt); this turn re-verified them against every Story-12 suite scenario, walked the whole journey through the real composition, and ran typecheck/lint/verify-handoff — no edit was needed, and the one failure found during the smoke was a bug in my scratch driver (a stale fence literal after a re-claim), not in the implementation.
- No test file and no `test/helpers/**` file was edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 12 GREEN · RED for Story 13 revocation lease fence

**Cycle.** Confirm GREEN for Story 12 (`src/commands/node/heartbeat-node.test.ts` + `src/commands/node/release-node.test.ts`), then RED for Story 13 (`src/commands/actor/revoke-actor.test.ts`, extended — the file EPIC 015 authored).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 12 confirm).**
- command: `node --test src/commands/node/heartbeat-node.test.ts src/commands/node/release-node.test.ts`
- exit: 0 — pass 25, fail 0 — Story 12 closes.
  **Test written.**
- file: `src/commands/actor/revoke-actor.test.ts` (edited) — suite `src/commands/actor/revoke-actor.test` — the Story's 7 methods, verbatim: `a revocation fences both the task lease and the objective lease of a harness` (both rows carry `expires_at` equal to the revocation instant `1700000001000`, and `owner`, `owner_kind` and `fence` each unchanged from the pre-revocation read); `the actor.revoked payload carries leasesFenced 2`; `a revocation closes no attempt, ends no run and moves no node state` (external objective run + task run + open attempt seeded through plain INSERT, `attempt`/`run`/`node` `SELECT *` deep-equal before/after, nodes seeded `running`); `a revoked actor with no lease records leasesFenced 0 and writes no lease row` (lease table deep-equal before/after); `the fenced rows are sweepable` (both rows satisfy the sweep's own predicate `owner IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= now` via SQL); `a revocation touches no lease of another actor` (second harness owns its own objective/task rows in the second project graph, both deep-equal); `revoking the bootstrap actor is still refused and fences nothing` (a lease row owned by the bootstrap actor survives the `bootstrap-actor` refusal, table deep-equal).
- The five existing tests now pass `lease` at their call sites (the seam member), so `RevokeActorDependencies` gains one member, not a fork of the file. Fixture: lease rows seeded by plain `INSERT INTO lease` inside the test's own `storage.transact` with `owner_kind = 'actor'`, fences 3 and 1, `expires_at = NOW + 300000` — no other command is called, per the Story's constraint. `registerOne` gains an optional `name` parameter for the second harness.
- asserts: real SQLite rows through `createBackedLeaseFake` (the `Lease` interface fake from `test/helpers/lease.ts`, so `expireLeasesOfOwner` writes rows the assertions read); fixed identities, clock `{ start: 1700000000000, step: 1000 }`, revocation instant `NOW + 1000` (register consumes one tick, revoke one), `actor_*` ULIDs; payload read through the existing `readEvents` helper.
  **RED proof.**
- command: `node --test src/commands/actor/revoke-actor.test.ts src/services/lease/sqlite.test.ts` (the Story's Run line)
- exit: 1 — pass 41, fail 3 — failures, verbatim:
  - `a revocation fences both the task lease and the objective lease of a harness` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: + 1700000300000 - 1700000001000` (rows never fenced, `expires_at` still `NOW + TTL`)
  - `the actor.revoked payload carries leasesFenced 2` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: 0 !== 2`
  - `the fenced rows are sweepable` — `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal: + [] - [ 'objective_a', 'task_a' ]`
- The other four methods pass on the current code by design: they pin constraints (no attempt/run/node write, no-lease boundary, other-actor isolation, bootstrap refusal ordering), so they are sensitive to a wrong implementation — a revocation that ended runs, fenced the wrong owner or fenced before the bootstrap check fails them — not to the missing member. State that explicitly: their pass is intended.
- stub probe: cannot stub — the seam is a member change in the existing production file `revoke-actor.ts`, and overwriting it is off-lane. The current-signature probe is complete instead: `npm run typecheck` reports **exactly 11 errors, all `TS2353: Object literal may only specify known properties, and 'lease' does not exist in type 'Readonly<{ storage: Storage; events: EventLog; clock: Clock; }>'`**, every one in `revoke-actor.test.ts` at a `revokeActor` call site, and zero errors anywhere else — TS2353 does not mask body checking, so the test file's own types are proven clean apart from the missing member.
  **Open to Software Engineer.**
- Seam: `src/commands/actor/revoke-actor.ts` — `RevokeActorDependencies` gains `lease: Lease` (`clock` is already a member). Per `13-revoke-actor-lease-fence.md`: inside the revocation transaction, after the `revoked_at`/`revoked_by` stamp and before the `actor.revoked` append, call `dependencies.lease.expireLeasesOfOwner(transaction, { owner: input.actorId, now })` with the one `clock.now()` of the transaction, and write `fenced.length` into the `leasesFenced` payload key. Nothing else changes: no attempt closes, no run ends, no node state moves. The Story's Verify also updates the one call site in `src/main.ts` to pass `lease` and `clock`.
- The suites import `revokeActor` from `./revoke-actor.ts` and pass a `Lease`-shaped fake (`createBackedLeaseFake`); the pinned behaviour is `expires_at = now` on every live lease of the revoked owner with `owner`, `owner_kind` and `fence` unchanged, `leasesFenced` = the affected row count, and the fenced rows satisfying `owner IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= now`.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 13-revoke-actor-lease-fence · the revocation fence

**Cycle.** GREEN+REFACTOR for `src/commands/actor/revoke-actor.test.ts` (Story 13).
**Files changed.**

- `src/commands/actor/revoke-actor.ts` (edited) — `RevokeActorDependencies` gains `lease: Lease` (`import type` from `../../services/lease/index.ts`, `clock` already a member); inside the revocation transaction, after the `revoked_at`/`revoked_by` stamp and before the `actor.revoked` append: `const fenced = dependencies.lease.expireLeasesOfOwner(transaction, { owner: input.id, now: revokedAt })`; the payload's `leasesFenced` becomes `fenced.length`; the `const leasesFenced = 0;` line is gone. Nothing else changes: no attempt closes, no run ends, no node state moves, no second transaction, no second clock read, no import of `recover-expired-leases.ts` or `claim-node.ts`, bootstrap refusal untouched.
- `src/main.ts` (edited) — the one production call site, `"actor.revoke"` at :397, passes `lease` beside `storage`, `events`, `clock`.
  **Seam (GREEN).** `now` is the single `clock.now()` of the transaction — `revokedAt` — so the fence statement (`UPDATE lease SET expires_at = ? WHERE owner = ? AND expires_at > ?`) stamps both seeded rows with `expires_at` equal to the revocation instant and leaves `owner`, `owner_kind` and `fence` byte-identical, and the payload carries `leasesFenced: fenced.length` (2 for the harness rows, 0 for a no-lease actor, 0 on the second revoke because the first stamp made every row non-live). The three RED assertions resolve.
  **Refactor.** None named in this Task.
  **Build check.**
- typecheck: no error in any production file (the five remaining errors are TE-lane test call sites — see OPEN)
- lint (eslint on the two changed files): exit 0
- runtime smoke of the app, not tests: a scratch driver over the real `SqliteStorage` (migrations 1–7) + `SqliteEventLog` + `SqliteLease` + `revokeActor` seeded a `actor_00000000000000000000000001` harness with two live lease rows (`owner_kind = 'actor'`, fences 3 and 1, `expires_at = NOW + 300000`), revoked it, and asserted both rows carry `expires_at = NOW` with `owner`/`owner_kind`/`fence` unchanged, plus `leasesFenced: 2` in the `actor.revoked` payload — `SMOKE: PASS` (script deleted; `git status` shows no trace)
  **OPEN: five TE-lane test call sites still pass no `lease` (TS2345, one per call).**
- The RED turn updated only the `src/commands/actor/revoke-actor.test.ts` call sites; the widened production type now requires `lease` at the other direct `revokeActor` call sites, which the RED turn's typecheck probe could not see (they were valid pre-widening). The five sites, each needing `lease` added to the dependencies literal: `src/commands/actor/rotate-actor-token.test.ts:279-281`, `src/http/server/actor/rotate-actor-token.test.ts:96-98`, `src/http/server/actor/registration.test.ts:113-114`, `src/http/server/actor/revoke-actor.test.ts:33-34`, `src/queries/actor/list-actor.test.ts:119-121`. Minimal fix: `lease: new SqliteLease()` (constructor takes no dependency, storage is already migrated in those fixtures), or a fake from `test/helpers/lease.ts`. Grep over `src/` shows `leasesFenced` appears in no test outside the Story-13 suite, so the added payload key breaks no existing assertion.
  **Assumptions.**
- VERIFIED: `expireLeasesOfOwner` is the only `Lease` method called — no `release`/`acquire`/`endRun`; the sweep's own predicate (`owner IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= now`) holds for the fenced rows by construction, per the Story's Verify.
- VERIFIED: the bootstrap refusal (`bootstrap-actor`) precedes the stamp and the fence, so a revoked bootstrap row is untouched and the `lease` table stays deep-equal — the existing ordering test keeps its meaning.
- No test file and no `test/helpers/**` file was edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 13 GREEN · RED for Story 14 the three routes

**Cycle.** Confirm GREEN for Story 13 (`src/commands/actor/revoke-actor.test.ts`), resolving the SE's OPEN on the five TE-lane call sites, then RED for Story 14 (`src/http/contract/error-details.test.ts` + `registry.test.ts` + `parity.test.ts` edited; `src/http/server/node/claim-node.test.ts`, `heartbeat-node.test.ts`, `release-node.test.ts` new; plus the registry-size collateral literals Story 14 forces).
**Handoff gate.**

- command: `npm run verify:handoff` — first run `VERIFY: FAIL — npm run typecheck exited 2` on exactly the SE's five OPEN call sites; each now passes `lease: createBackedLeaseFake().lease` (a `test/helpers/lease.ts` fake — no service implementation reaches a test outside its capability) and the gate re-runs `VERIFY: PASS — npm run typecheck is clean`.
- OPEN resolved in my lane: `src/commands/actor/rotate-actor-token.test.ts:280`, `src/http/server/actor/rotate-actor-token.test.ts:97`, `src/http/server/actor/registration.test.ts:114`, `src/http/server/actor/revoke-actor.test.ts:34`, `src/queries/actor/list-actor.test.ts:120` — each `revokeActor` dependency literal gains `lease`, and each file gains the `createBackedLeaseFake` import. The revoked actors in those fixtures hold no lease rows, so `expireLeasesOfOwner` returns `[]` and the revocation semantics are untouched.
  **Verification result (Story 13 confirm).**
- command: `node --test src/commands/actor/revoke-actor.test.ts src/services/lease/sqlite.test.ts src/commands/actor/rotate-actor-token.test.ts src/http/server/actor/rotate-actor-token.test.ts src/http/server/actor/registration.test.ts src/http/server/actor/revoke-actor.test.ts src/queries/actor/list-actor.test.ts`
- exit: 0 — pass 67, fail 0 — Story 13 closes.
  **Test written.**
- file: `src/http/contract/error-details.test.ts` (edited) — the old `{ nodes }` `illegalTransitionDetails` describe block is gone (the Story's union replaces the schema); new methods: `leaseHeldDetails parses the held-by-other variant` (deep-equal over all seven members, extra-key failure, `relation` outside `leaseRelations` failure); `leaseHeldDetails parses the stale-fence variant` (success, missing `presentedFence` failure); `leaseHeldDetails refuses a variant with no refusal member`; `leaseHeldDetails refuses a held-by-other object that omits fence`; `illegalTransitionDetails parses all three variants and refuses a fourth refusal literal`; `illegalTransitionDetails refuses an ancestor variant with no ancestorId`; `illegalTransitionDetails refuses a node-state variant that carries an ancestorId`; `every refusal of the three commands has a details variant` — table-driven over the nine mapper rows, each envelope built from `{ ...baselineErrors, leaseHeldDetails, illegalTransitionDetails, planInvalidDetails }` and parsed through `buildErrorEnvelope`.
- file: `src/http/contract/registry.test.ts` (edited) — `harnessOperations` gains the three ids (twelve → fifteen, bytewise); counts `62→65` ×2, routed `35→38`, phase-1 `32→35`, POST policies `25→28`, memory `24→27`; the withRequest/withResponse lists gain the three; new methods: `node.claim, node.heartbeat and node.release each declare memory idempotency and replayable [200]`, `each of the three admits human and harness` (`["human", "harness"]` exact), `the three new paths render as expected` (`/v1/node/:id/claim`, `/v1/node/:id/heartbeat`, `/v1/node/:id/release`); the EPIC-015 named assertion renamed to `the harness set names the six node operations of EPIC 017 and 018`.
- file: `src/http/contract/parity.test.ts` (edited) — the Story's absolutes: `comparable.length` `62→65`, `proposalRows.length` `66→69`, title rewritten to `pins the four deferred rows`. **Guard held**: both literals read `62` and `66` before the edit, so the closed derivation of Story 14 stands and the counts are not a relative delta.
- file: `src/http/contract/example.test.ts` (edited) — scoped `31→34` + title.
- file: `src/http/contract/coverage.test.ts` (edited) — scoped `31→34` + title; `operationAdditions` gains the three ids, each `["illegal-transition", "lease-held", "plan-invalid"]`.
- file: `src/http/contract/openapi.test.ts` (edited) — paths `55→58`, operation ids `62→65`, schema components `82→88` with the six `node.claim.*`/`node.heartbeat.*`/`node.release.*` components in bytewise position.
- file: `src/http/contract/path.test.ts` (edited) — `actionSegments` `19→22`; new method `claim, heartbeat and release are action segments under the node parameter` (inclusion + `renderPath` of the three).
- file: `src/http/server/route.test.ts` (edited) — matrix `66→69`, routed+stubbed `62→65`.
- file: `src/http/server/dispatch.test.ts` (edited) — derived unimplemented ids `33→36`.
- file: `scripts/publish-contract.test.ts` (edited) — published example files `34→37`.
- file: `src/http/server/node/claim-node.test.ts` (new) — suite `src/http/server/node/claim-node.test` — methods: `a successful call answers 200 with the contract response shape` (body parses `nodeClaimResponse`; the stub result carries the full `nodeShowResponse.shape.node` member); `each refusal maps to its declared code` (seven rows: node-not-found → 404 no details, initiative-not-claimable → 400 `{ refusal }`, plan-incomplete → 422 `{ findings }`, drive-mode-pinned → 409 `{ refusal: "drive-mode-pinned", pinnedDriver, claimDriver }`, illegal-transition → 409 `{ refusal: "node-state", state, admitted }`, ancestor-not-startable → 409 `{ refusal: "ancestor-not-startable", ancestorId, state, admitted }`, lease-held → 409 `{ refusal: "held-by-other", subject, holder, holderKind, fence, expiresAt, relation }`, each asserted on status and envelope code, details member-wise); `a body with an unknown key is 400 invalid-request`; `node.claim with any body member is 400 invalid-request` (both `{ actorId }` and `{ fence: 1 }`); `the handler calls its command exactly once`; `the handler passes the authenticated actor and never a body actor` (stub receives `{ nodeId, actorId: HARNESS_ACTOR_FIXTURE.id, actorKind: "harness" }`, body `actorId` refused 400).
- file: `src/http/server/node/heartbeat-node.test.ts` (new) — methods: the success-shape test (parses `nodeHeartbeatResponse`); `each refusal maps to its declared code` (node-not-found 404, initiative-not-claimable 400, lease-held → 409 `{ refusal: "stale-fence", subject: <url node>, presentedFence: <body fence> }` — the no-details variant); unknown key 400; `node.heartbeat with no fence is 400 invalid-request`; exactly-once; actor pass-through; `a replayed node.heartbeat under a repeated Idempotency-Key returns the captured expiresAt and writes nothing` (two requests, same key, second body byte-equal to the first, counting stub called once).
- file: `src/http/server/node/release-node.test.ts` (new) — methods: success shape (parses `nodeReleaseResponse`); six refusal rows (node-not-found, initiative-not-claimable, lease-held → held-by-other with `relation: "descendant"`, no-active-run → node-state, no-open-attempt → node-state, illegal-transition → node-state); unknown key 400; no fence 400; exactly-once; actor pass-through.
- asserts: the two `lease-held` envelope variants against the Story's schemas; every refusal row pinned on both status and code; the contract response schemas parse the success bodies; `holderKind` uses `"actor"` (leaseOwnerKinds is `["daemon", "actor"]`, not `"harness"`).
  **RED proof.**
- command: `node --test src/http/contract/error-details.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/path.test.ts src/http/server/route.test.ts src/http/server/dispatch.test.ts src/http/server/node/claim-node.test.ts src/http/server/node/heartbeat-node.test.ts src/http/server/node/release-node.test.ts scripts/publish-contract.test.ts`
- exit: 1 — 157 pass, 29 fail; every failure names one of this turn's targets, e.g. verbatim: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/http/server/node/claim-node.ts' imported from .../claim-node.test.ts` (all three handler suites); `SyntaxError: The requested module './error-details.ts' does not provide an export named 'leaseHeldDetails'`; `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` with `actual: 62, expected: 65` (parity, registry, openapi, route, dispatch, path, example, coverage); `AssertionError [ERR_ASSERTION]: node.claim` (the three by-operation-id tests; `findOperation` is undefined).
- full suite: `npm test` — exit 1 — 4220 pass, 29 fail (the same twenty-nine; nothing outside the Story-14 target set regressed, Story 13 confirm suites included).
- stub probe: `src/http/server/node/claim-node.ts` + `heartbeat-node.ts` + `release-node.ts` — with throwaway stubs declaring `claimNodeHandler({ claimNode: (input: ClaimNodeInput) => unknown })` etc., `npm run typecheck` reports only the four seam errors of `src/http/contract/path.test.ts` (`action("claim"/"heartbeat"/"release")` and the tuple `includes`, all clearing the moment `actionSegments` gains the three members); every handler test file is clean against the declared surface. Stubs deleted before handoff; `git status` shows no trace of them.
- current-signature probes (the seam is an edit to an existing file, not a new module): `error-details.ts` — the only error in my file is `TS2305: no exported member 'leaseHeldDetails'`, which does not mask body checking; `execution.ts` — the only errors are the three missing response-schema exports; `path.ts` — the four `TS2345` seam errors above.
  **Open to Software Engineer.**
- Seam: Story `14-routes-and-contract.md` is the spec; the suites import `claimNodeHandler` from `src/http/server/node/claim-node.ts`, `heartbeatNodeHandler` from `heartbeat-node.ts`, `releaseNodeHandler` from `release-node.ts`, and `nodeClaimResponse`/`nodeHeartbeatResponse`/`nodeReleaseResponse` from `src/http/contract/execution.ts`.
- `docs/proposal/api/execution.md` — the three route rows after the `worker.list` row (five cells each, table order) and the three sections `## node.claim` / `## node.heartbeat` / `## node.release` after the objective-scope section.
- `src/http/contract/path.ts` — `actionSegments` gains `claim` after `cancel`, `heartbeat` after `export`, `release` after `reconcile`.
- `src/http/contract/error-details.ts` — `leaseHeldDetails` and the `illegalTransitionDetails` discriminated union of the Story, replacing the existing `{ nodes }` strictObject export; `leaseOwnerKinds` and `leaseRelations` imported from `src/domain/lease.ts` and `src/domain/lease-hierarchy.ts`.
- `src/http/contract/execution.ts` — the three operations after `worker.list`, each `phase-1`, `routed`, `idempotency: "memory"`, `replayable: [200]`, `allowedActors: ["human", "harness"]`, with the Story's request/response schemas (declared `claimedLease` once) and literal `examples` (`fence: 1`, `expiresAt: 1722800300000`, `heartbeatIntervalMs: 100000`, `attemptNo: 1`, ULID identities of the existing examples).
- `src/http/server/node/refusals.ts` — the file already maps `NodeWriteError` (EPIC 017); extend the same `toHttpError` with the nine mapper rows of the Story. `lease-held` decides its variant on whether the error carries details: present → `held-by-other` copied member for member; absent → `stale-fence` built from the URL node identity and the fence the caller presented (my heartbeat stale-fence case throws `HeartbeatNodeError("lease-held")` with no details and pins `{ refusal: "stale-fence", subject: <url node>, presentedFence: <body fence> }`).
- `src/http/server/node/claim-node.ts`, `heartbeat-node.ts`, `release-node.ts` — handlers in the shape of `list-node.ts`: parse the body through the contract schema (a failure is `400 invalid-request`), read the node from `context.parameters` and the actor from `context.actor`, call exactly one command, pass every thrown error to the mapper, return `{ status: 200, body }`. The dependency names the suites use are `claimNode` / `heartbeatNode` / `releaseNode`.
- **The success bodies must satisfy the contract response schemas, which reuse `nodeShowResponse.shape.node` as the `node` member.** The command results as they stand carry `node: { id, state }` only, so the claim and release handlers cannot emit a schema-valid body without the command result (or the handler dependency) carrying the full node view. The suites pin the full member set; the widening is the SE's call.
- **`src/http/contract/graph.ts` — `nodeUpdateExamples.error.details` must move to a union-valid shape.** Its `{ nodes: [...] }` details parse against the old schema; the moment `illegalTransitionDetails` becomes the union, `example.test.ts`'s existing `every error example satisfies its own operation's envelope` fails for `node.update`. The example lives in graph.ts (SE lane). The node CRUD runtime details (`{ nodes }`) are pinned by `update-node.test.ts:355` and `delete-node.test.ts` deep-equals — if the SE also aligns the node CRUD runtime with the union, say so in the turn and I will update those two assertions in the confirm turn; the Story itself does not ask for it.
- Behaviour the suites pin: the two `lease-held` envelope variants; the nine-row refusal mapping; the empty-strict-body claim and the `{ fence }` heartbeat/release bodies; the replayed heartbeat answering byte-identical under a repeated key with the stub called once; and the `holderKind` values drawn from `leaseOwnerKinds` (`"actor"`, never `"harness"`).

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 14-routes-and-contract · the three routes, the registry entries, the handler mapper

**Cycle.** GREEN+REFACTOR for the Story-14 test set (contract, registry, parity, handlers).
**Files changed.**

- `src/http/contract/path.ts` (edited) — `actionSegments` gains `claim` (after `cancel`), `heartbeat` (after `export`), `release` (after `reconcile`), alphabetical
- `src/http/contract/error-details.ts` (edited) — `illegalTransitionDetails` becomes the Story's three-variant `z.discriminatedUnion("refusal", ...)` (replacing the `{ nodes }` strictObject); `leaseHeldDetails` appended after `invalidRequestDetails` with the two variants; `nodeIdentity`/`epochMillis`/`runDrivers`/`leaseOwnerKinds`/`leaseRelations` imported from `domain/`
- `src/http/contract/graph.ts` (edited) — `nodeUpdateExamples.error.details` moved to the union-valid `{ refusal: "node-state", state: "running", admitted: [...] }` shape (example.test.ts requirement); node CRUD runtime `{ nodes }` details untouched
- `src/http/contract/execution.ts` (edited) — `claimedLease` declared once; `nodeClaimRequest` (empty strict), `nodeHeartbeatRequest`/`nodeReleaseRequest` (`{ fence }`); `nodeClaimResponse`/`nodeHeartbeatResponse`/`nodeReleaseResponse` with `node: nodeShowResponse`; `nodeClaimExamples`/`nodeHeartbeatExamples`/`nodeReleaseExamples` (literal `request`/`success`/`error`, `fence: 1`, `expiresAt: 1722800300000`, `heartbeatIntervalMs: 100000`, `attemptNo: 1`, ULID identities); the three operations after `worker.list`, each `phase-1` `routed` `idempotency: "memory"` `replayable: [200]` `allowedActors: ["human", "harness"]`, `request`/`response`/`errors` (`lease-held`, `illegal-transition`, `plan-invalid` beside `baselineErrors`)/`examples`
- `src/http/server/node/refusals.ts` (edited) — `toHttpError` extended with the nine-row mapper: `node-not-found` → `not-found`; `initiative-not-claimable` → `invalid-request` `{ refusal }`; `plan-incomplete` → `plan-invalid` `{ findings }`; `drive-mode-pinned` → `illegal-transition` `{ refusal, pinnedDriver, claimDriver }`; `illegal-transition` → `{ refusal: "node-state", state, admitted }`; `ancestor-not-startable` → `{ refusal, ancestorId, state, admitted }`; `lease-held` chooses the variant by whether the command error carries the refusal members (present → `held-by-other` copied member for member, absent → `stale-fence` from the `presented { subject, fence }` the handler passes); `no-active-run` → `node-state` with `state: "ready"`; `no-open-attempt` → `node-state` with `state: "running"`; the `NodeWriteError` mapping stays as EPIC 017 left it
- `src/http/server/node/claim-node.ts`, `heartbeat-node.ts`, `release-node.ts` (new) — handlers in the `create-node.ts` shape: parse the body through the contract request schema (failure → `400 invalid-request`), read `id` from `context.parameters` and the actor from `context.actor`, invoke exactly one command, return `{ status: 200, body: result }`, pass every thrown error to `toHttpError`; the heartbeat and release handlers pass `{ subject: id, fence }` for the stale-fence variant
- `src/commands/node/release-node.ts` (edited) — the objective-release `lease-held` details gain `holderKind`, `fence` and `expiresAt` beside `subject`/`holder`/`relation`, so the real daemon's refusal satisfies `leaseHeldDetails`' `held-by-other` member set; Story-12's command test asserts those three members member-wise and stays green
- `docs/proposal/api/execution.md` (edited) — the three route rows after the `worker.list` row (five cells each, `phase-1`/`routed`); `## node.claim` and `## node.release` sections in table order, and the `## node.heartbeat` section gained its body/response/refusal lead paragraph; every Story-1 asserted string kept byte-identical
  **Seam (GREEN).** The registry now carries 65 operations (38 routed, 35 phase-1, 28 POST policies, 27 memory, 15 withRequest, 37 withResponse) with zero `registryFaults`; `compareRouteSets` reports 65/69 with empty missing/mismatched sets; the three response schemas parse the success stubs, the request schemas parse `{}`/`{ fence }`, and each error example parses its own envelope; all thirteen `leaseHeldDetails`/`illegalTransitionDetails` cases behave as pinned; the handler suites' call sites (`claimNodeHandler({ claimNode })` etc. with `(input) => unknown` stubs) typecheck and the mapper emits exactly the pinned statuses and details.
  **Refactor.** None named in this Task; the mapper split (`claimRefusal`/`heartbeatRefusal`/`releaseRefusal`/`leaseHeld` helpers) is the shape the nine-row table needs.
  **Build check.**
- typecheck: exit 0
- lint (eslint on the nine changed/new files): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- app-level smoke (not tests): a production `createApp` + real handlers on a scratch listener drove all three routes — claim `200` with the full contract body and the authenticated actor passed through; `{ fence: 1 }` body and `actorId` bodies `400`; unknown node `404`; heartbeat/release success `200`; stale fence `409 lease-held` with `{ refusal: "stale-fence", subject: <url node>, presentedFence: <body fence> }`; and all nine mapper rows (held-by-other sibling/descendant, drive-mode-pinned, ancestor-not-startable, plan-incomplete findings, initiative-not-claimable, node-state, no-active-run `state: "ready"`, no-open-attempt `state: "running"`) — `SMOKE: PASS` (script under the temp dir, deleted)
  **OPEN: `src/http/contract/openapi.test.ts` components count — the TE's own two tests contradict, and the components land at 91, not 88.**
- The registry test (`registry.test.ts:102-120`) pins `request !== undefined` on all three operations ("attaches requests to the fifteen write routes"), which matches the Story's `request: nodeClaimRequest` operation shape and the EPIC's "the three operations take `request`" text. With `request` declared, `operationObject` at `src/http/contract/openapi.ts:190-204` registers `node.claim.request`, `node.heartbeat.request` and `node.release.request` unconditionally, so `buildOpenApiDocument` produces **91** schema components. The openapi test pins 88 with only the six `error`/`response` entries (the `.request` entries are absent from the expected list at `openapi.test.ts:214-303`), so it cannot pass while the registry test does. Probed both ways: omit `request` → registry withRequest 12≠15; declare `request` → components 91≠88. There is no production shape that satisfies both; the Story letter and the registry test win.
- Fix (TE lane, mechanical): add the three `.request` entries to the expected list in bytewise position — `node.claim.request` between `node.claim.error` and `node.claim.response`, `node.heartbeat.request` between `node.heartbeat.error` and `node.heartbeat.response`, `node.release.request` between `node.release.error` and `node.release.response` — and retitle "the eighty-eight schema components" → "the ninety-one schema components". Everything else in this Task is implemented and probed green.
  **Assumptions.**
- VERIFIED (widening call, per the TE's note): the claim/release handlers pass the command result through unchanged, so the response `node` member is whatever the command result carries. The full `node.show` view cannot be minted inside `claimNode`/`releaseNode`: their dependency literals are pinned by Stories 10/12 and by Story 17's `main.ts` binding and carry no `blobs`, and `instruction`/`acceptance`/`repo` are blob-derived. The composition root of Story 17 is therefore where the full view must be merged into the response (a binding-time wrap), and this story ships the passthrough the suites pin.
- VERIFIED (zod 4 correction): the Story's `nodeShowResponse.shape.node` does not exist in zod 4 — `.shape` is the raw-shape record, not a ZodType, and `z.toJSONSchema` throws on it. The schema is `nodeShowResponse` itself (the extended object carries the full member set).
- VERIFIED: node CRUD runtime `{ nodes }` details untouched per the Story letter; only the `node.update` example was aligned (example.test.ts requires it). Per the TE's offer, the `update-node.test.ts:546`/`delete-node.test.ts:571,788` deep-equals stay valid and no confirm-turn edit is needed for them.
- VERIFIED: the proposal rows parse with exactly five cells and `phase-1` in cell three; `proposal-amendment.test.ts` (EPIC 017) still finds its three CRUD rows.
- No test file and no `test/helpers/**` file was edited.

ATTEMPT-FAILED: 14-routes-and-contract — openapi components test stays red at 91 vs the TE-pinned 88 because the TE's own registry test requires `request` declared on the three operations, which registers the three `.request` components (OPEN names the exact TE-side list fix; every other Story-14 assertion is probed green)

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 14 GREEN failed · one SE-lane fixture gap

**Cycle.** Confirm GREEN for Story 14 — **failed**: one assertion is still red, and the failing file is software-engineer-lane. The SE's OPEN (openapi 91 components) is resolved in my lane; the collateral count literals the Story-14 RED turn missed are fixed in my lane; the one remaining red is `src/http/contract/field-decisions.fixture.ts`.
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact re-verifies independently.
  **OPEN resolved (my lane).**
- `src/http/contract/openapi.test.ts` — the SE's prescribed fix applied verbatim: `node.claim.request` between `node.claim.error` and `node.claim.response`, `node.heartbeat.request` between the heartbeat error/response pair, `node.release.request` between the release error/response pair, title `eighty-eight` → `ninety-one`. Bytewise positions hold (`request` sorts between `error` and `response`). `node --test src/http/contract/openapi.test.ts` — exit 0, 22 pass.
  **Confirm-turn collateral (my lane — the Story-14 RED turn's count-literal sweep missed three files).**
- `src/http/contract/system.test.ts` — `thirty-four registry entries carry a response and twelve carry a request` → `thirty-seven` / `fifteen`; the response list gains `node.claim`, `node.heartbeat`, `node.release` in bytewise position; the request list gains the same three.
- `src/http/server/app.test.ts` — `requests.length` 64 → 67 in `every path answers identically without a token`; `binding system.health and system.db leaves thirty-three unimplemented ids` → `thirty-six`, literal 33 → 36 (the sibling literal `dispatch.test.ts:214` the RED turn already moved).
- `src/main.test.ts` — the daemon-backed completeness sweep went red because Story 14 put the three routed rows in the registry while `main.ts` binds them only in Story 17, so they answer 501 from the real composition root. The designed mechanism for exactly this state is the `pending` list (EPIC 010's own list, emptied when it bound its operations): the three ids are added with a comment naming Story 17, whose confirm turn removes them and adds the fixture rows. This also repaired the `provider.register` event-test cascade: the aborted fixture-coverage loop never registered `provider-a`, so `attribution-a` became the first LLM and appended two events (`provider.registered` + `provider.defaultSet`); with the sweep green again the loop registers `provider-a` first and the event test passes. `node --test src/main.test.ts` — exit 0, 14 pass.
  **Verification result.**
- command: `node --test src/http/contract/error-details.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/path.test.ts src/http/contract/system.test.ts src/http/server/route.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/http/server/node/claim-node.test.ts src/http/server/node/heartbeat-node.test.ts src/http/server/node/release-node.test.ts scripts/publish-contract.test.ts`
- exit: 1 — pass 280, fail 1 — failure, verbatim: `✖ every field in the registry answers required, nullability and enum, matching the reviewed fixture` at `coverage.test.ts:308` — the computed rows carry 70 members the fixture lacks: `node.claim.response#` 36, `node.heartbeat.request#`+`response#` 14, `node.release.request#`+`response#` 20.
- full suite: `npm test` — exit 1 — 4305 pass, 2 fail (the same one test plus its file record; nothing else red repo-wide). `npm run typecheck` — exit 0.
  **Action required (software-engineer lane).**
- `src/http/contract/field-decisions.fixture.ts` — extend the reviewed fixture with the 70 rows the three new operations' schemas emit, in the fixture's bytewise-sorted order: `node.claim.*` between the `event.list.*` rows and the `node.create.request#` rows; `node.heartbeat.*` between the `node.delete.*` rows and the `node.list.*` rows; `node.release.*` between the `node.list.*` rows and the `node.show.*` rows. The rows are exactly what `fieldRows` at `coverage.test.ts:213-282` computes over the registry — regenerating the file from the registry with that function, sorted bytewise, one quoted string per line, keeping the `export const fieldDecisions: readonly string[] = [` wrapper, is byte-identical to today's file plus those 70 rows: my probe reports `rows in fixture but not in actual: 0`, so no existing line moves one byte. The check is the test: `node --test src/http/contract/coverage.test.ts` must exit 0. Precedent: commit `5df22da` (EPIC 017) extended this fixture in the implementing commit for its three CRUD operations.
  **Open to Software Engineer.**
- The fixture path above — nothing else.

ATTEMPT-FAILED: 14-routes-and-contract — still red after GREEN: `every field in the registry answers required, nullability and enum, matching the reviewed fixture` — `field-decisions.fixture.ts` (SE lane) lacks the 70 field rows of the three new operations; the exact rows derive byte-identically from the registry via the test's own `fieldRows`

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 14-routes-and-contract · the field-decisions fixture regenerated from the registry

**Cycle.** GREEN+REFACTOR for the Story-14 confirm gap: `every field in the registry answers required, nullability and enum, matching the reviewed fixture` at `coverage.test.ts:308`.
**Files changed.**

- `src/http/contract/field-decisions.fixture.ts` (edited) — regenerated from the registry with the test's own `fieldRows` walk (`coverage.test.ts:213-282`): the same `z.toJSONSchema` calls over `query`/`request`/`response` slots, the same property/items/oneOf traversal, the same bytewise sort, the same `export const fieldDecisions: readonly string[] = [` wrapper. The file grows by exactly the 70 rows of the three operations — `node.claim.response#` 36, `node.heartbeat.request#`+`response#` 14, `node.release.request#`+`response#` 20 — and no existing line moves one byte: `git diff` shows +70 / −0 (the lone `-` in the raw count is the diff header), and the generator's probe reported `rows removed: 0`. Transient generator `regenerate-field-fixture.ts` (repo root, outside the tsconfig include) ran once and was deleted before the build check.
  **Seam (GREEN).** The fixture is now the exact bytewise-sorted output the test computes over the registry, so `assert.deepEqual(rows, fieldDecisions)` holds by construction; the added rows carry the values the registry schemas emit (`ownerKind enum=actor` from `leaseOwnerKinds`, the full `nodeShowResponse` member set on the `node` member of claim and release, `fence` required on the two request schemas).
  **Refactor.** None named; the fixture is data, regenerated mechanically.
  **Build check.**
- typecheck: exit 0
- lint (`eslint` on the fixture): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: the 70-row split matches the TE's probe (claim 36 / heartbeat 14 / release 20) member for member, including the bytewise insertion points the TE named (claim rows between `event.list.*` and `node.create.request#`, heartbeat between `node.delete.*` and `node.list.*`, release between `node.list.*` and `node.show.*`).
- No test file and no `test/helpers/**` file was edited; nothing outside `field-decisions.fixture.ts` changed this turn.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 14 GREEN · RED for Story 15 node.list filters

**Cycle.** Confirm GREEN for Story 14 (`field-decisions.fixture.ts` regeneration), then RED for Story 15 (`src/queries/node/list-node.test.ts` + `src/http/server/node/list-node.test.ts` extended; `src/http/contract/registry.test.ts` edited).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 14 confirm).**
- command: `node --test src/http/contract/coverage.test.ts` — exit 0 — pass 14, fail 0 — the regenerated fixture satisfies the field-decisions walk.
- command: `node --test src/http/contract/error-details.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/example.test.ts src/http/contract/coverage.test.ts src/http/contract/openapi.test.ts src/http/contract/path.test.ts src/http/contract/system.test.ts src/http/server/route.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/http/server/node/claim-node.test.ts src/http/server/node/heartbeat-node.test.ts src/http/server/node/release-node.test.ts scripts/publish-contract.test.ts`
- exit: 0 — pass 281, fail 0 — Story 14 closes.
  **Test written.**
- file: `test/helpers/rows.ts` (edited) — `seedListFilterFixture(transaction)` — two projects, each with one initiative, one objective bound to a distinct repository (`repo_a`, `repo_b`), and two tasks; states spread over `pending` (both initiatives), `ready` (both objectives, `task_pb1`, `task_pb2`), `running` (`task_a`), `blocked` (`task_a2` with `dirty-recovery`); `repo_b` registered as a repository row and `project_b` inserted so the node FKs hold.
- file: `src/queries/node/list-node.test.ts` (edited) — suite `src/queries/node/list-node.test` — methods (the Story's names verbatim where given): `the project filter alone selects the rows of one project`; `the kind filter alone selects the rows of one kind`; `the state filter alone selects the rows of one state`; `the blockReason filter alone selects the rows of one block reason`; `the repository filter alone selects the rows of one repository` (each asserting the exact identity list in identity order); `two filters combine with AND` (`state`+`kind` → `["task_pb1", "task_pb2"]`, each element member of both alone-lists, length strictly smaller than both); `repository matches an objective and its tasks, and never an initiative` (`repo_a` → `[objective_a, task_a, task_a2]`, no `objective_pb`/`task_pb1`/initiative; `repo_b` → `[objective_pb, task_pb1, task_pb2]`); `a filter that matches nothing returns an empty list` (`state: "done"`, `repository: "repo_z"`, `kind: "objective"`+`state: "blocked"`); `the order does not depend on the filter` (filtered ids deep-equal the identity-ordered subsequence of the unfiltered list, non-empty and strictly smaller).
- file: `src/http/server/node/list-node.test.ts` (edited) — suite `src/http/server/node/list-node.test` — new `buildFilterApp` over the same fixture; methods: `a repeated filter key is 400 invalid-request` (`?state=ready&state=running`); `an unknown key is 400 invalid-request` (`?owner=me`); `a filter value outside its enum is 400 invalid-request` (`?kind=epic`); `state=ready&kind=task returns only the ready tasks, ordered by identity` (`["task_pb1", "task_pb2"]`); `the handler passes the parsed filter to the query exactly once` (counting stub, `?project=project_b&state=ready` → `{ project: "project_b", state: "ready" }`, one call).
- file: `src/http/contract/registry.test.ts` (edited) — `event.list is the only operation with a query schema` renamed to `event.list and node.list are the only operations with a query schema`, expectation `["event.list", "node.list"]`.
- asserts: the five filters select the pinned identity lists, AND-combine, resolve a task's repository through its parent objective, never match an initiative on `repository`, keep identity order independent of the filter; the handler refuses repeated keys (via `singleValued`), unknown keys and out-of-enum values with `400 invalid-request`, and forwards the parsed single-valued filter to the query exactly once.
- `an empty filter returns every node ordered by identity` and `no query returns exactly what it returned before this epic` are **not** rewritten: the Story names them as the existing assertions, unchanged — the existing `returns the seeded graph ascending by id...` and `GET /v1/node answers 200 with { nodes }...` tests are left byte-identical and keep covering them.
  **RED proof.**
- command: `node --test src/queries/node/list-node.test.ts src/http/server/node/list-node.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts`
- exit: 1 — pass 88, fail 15 — every failure names one of this turn's targets, e.g. verbatim: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:` on `the project filter alone selects the rows of one project` (actual = all eight nodes, the filter never applied); `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` with `actual: 200, expected: 400` on the three handler refusals (the handler ignores the query today); `state=ready&kind=task` actual = all eight ids; `the handler passes the parsed filter...` actual `{}`; and the registry query-schema set `["event.list"]` vs `["event.list", "node.list"]`.
- full suite: `npm test` — exit 1 — 4306 pass, 15 fail (the same fifteen; nothing outside the Story-15 target set regressed).
- current-signature probe (the seam is an edit to existing files, not a new module — no stub possible): `npm run typecheck` reports **exactly 20 errors, all `TS2322: Type 'string' is not assignable to type 'never'`** at the `listNodes` call-site literals of `src/queries/node/list-node.test.ts` (the `Readonly<Record<string, never>>` parameter), and zero errors in any other file — the handler file, the registry file and `rows.ts` are clean, and TS2322 does not mask body checking. `npx eslint` on the four changed files — exit 0. `node scripts/verify-db-status.ts` — `verify db status ok`.
- `npm run verify` today: blocked at the same 20 typecheck errors (the seam), then `npm test` 15 fails; `npm run lint` and the DB check are clean. The gate goes green with the SE's signature widening.
  **Open to Software Engineer.**
- Seam: Story `15-node-list-filters.md` is the spec; the suites import `listNodes` from `src/queries/node/list-node.ts`, `listNodeHandler` from `src/http/server/node/list-node.ts`, and `nodeListQuery` from `src/http/contract/graph.ts`.
- `src/http/contract/graph.ts` — `nodeListQuery = z.strictObject({ project: identity("project").optional(), kind: z.enum(nodeKinds).optional(), state: z.enum(nodeStates).optional(), blockReason: z.enum(blockReasons).optional(), repository: identity("repository").optional() })` (imports from `src/domain/state.ts` and `src/domain/identity.ts`, beside the existing `nodeKinds`/`nodeStates`/`blockReasons` import); add `query: nodeListQuery` to the `node.list` entry; add a `query` member to `nodeListExamples` (the five keys, `project`/`repository` as identity strings, enum values in-domain — `example.test.ts` parses it against the schema).
- `src/queries/node/list-node.ts` — `export type NodeListFilter = Readonly<{ project?: string; kind?: NodeKind; state?: NodeState; blockReason?: string; repository?: string }>`; `listNodes(dependencies, input: NodeListFilter)` filters in JS over the `readAllNodes` rows: `project` → `node.projectId`, `kind` → `node.kind`, `state` → `node.state`, `blockReason` → `node.blockReason`, `repository` → the objective's `repositoryId` (an objective matches its own, a task matches the node its `parentId` names from the same result, an initiative never matches); absent keys filter nothing, keys combine with `AND`, order stays by identity; no SQL change, no `services/plan` method, no sixth key.
- `src/http/server/node/list-node.ts` — `ListNodeHandlerDependencies.listNodes` becomes `(input: NodeListFilter) => readonly NodeListItem[]`; the handler parses `nodeListQuery.safeParse(singleValued(context.query))` and throws `httpError("invalid-request", "the node filters are not valid")` on failure (`singleValued`'s own repeated-key `httpError` propagates as the same 400, per the `list-event.ts` pattern); `dependencies.listNodes(parsed.data)`; no-query requests pass `{}`.
- `src/http/contract/field-decisions.fixture.ts` — regenerate from the registry with the test's own `fieldRows` walk: the five `node.list.query#` rows (`blockReason`, `kind`, `project`, `repository`, `state`, each `required=false nullable=false enum=<domain list or ->`) insert in bytewise position (query rows sort before the `node.list.response#` rows). `docs/proposal/api/graph.md` needs no edit — EPIC 014 already fixed the query-parameter paragraph.
- Behaviour the suites pin: the exact identity lists per filter (both projects' objectives are `ready`, both initiatives `pending`, `task_a` `running`, `task_a2` the one `blocked`/`dirty-recovery`); `repository` resolves a task through its parent and never matches an initiative; AND results are strict subsets of each alone-filter; the filtered list is the identity-ordered subsequence of the unfiltered one; the three `400 invalid-request` refusals; the parsed filter reaches the query once.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 15-node-list-filters · the query schema, the JS filter, the handler, the fixture

**Cycle.** GREEN+REFACTOR for Story 15, per the TE's RED at `list-node.test.ts` (query + server suites), `registry.test.ts` and `parity.test.ts`.
**Files changed.**

- `src/http/contract/graph.ts` (edited) — `nodeListQuery = z.strictObject({ project: identity("project").optional(), kind: z.enum(nodeKinds).optional(), state: z.enum(nodeStates).optional(), blockReason: z.enum(blockReasons).optional(), repository: identity("repository").optional() })` (identity imported from `../../domain/identity.ts`); `query: nodeListQuery` on the `node.list` entry; `query` member on `nodeListExamples` (five in-domain keys, `project_${U}` / `repo_${U}` identity strings, enum values in-domain) so `example.test.ts` parses it.
- `src/queries/node/list-node.ts` (edited) — `NodeListFilter = Readonly<{ project?: string; kind?: NodeKind; state?: NodeState; blockReason?: string; repository?: string }>`; `listNodes(dependencies, input: NodeListFilter)` filters in JS over the `readAllNodes` rows inside the same `transact` read: `project`→`projectId`, `kind`→`kind`, `state`→`state`, `blockReason`→`blockReason`, `repository`→ the objective's `repositoryId` (a task resolves the node its `parentId` names from the same result via a `Map`; an initiative never matches), keys combine with `AND`, absent keys filter nothing, order is the input order (identity).
- `src/http/server/node/list-node.ts` (edited) — `ListNodeHandlerDependencies.listNodes` is `(input: NodeListFilter) => readonly NodeListItem[]`; the handler parses `nodeListQuery.safeParse(singleValued(context.query))`, throws `httpError("invalid-request", "the node filters are not valid")` on failure, and calls `dependencies.listNodes(parsed.data)`; the `singleValued` repeated-key throw propagates as its own `400 invalid-request`, per the `list-event.ts` pattern.
- `src/http/contract/field-decisions.fixture.ts` (edited) — regenerated from the registry with the test's own `fieldRows` walk (`coverage.test.ts:213-282`): the five `node.list.query#` rows insert in bytewise position, every pre-existing row verified as a same-order subsequence of the new output (`rows in fixture but not in actual: 0`), `+5` lines only. Transient generator `regenerate-field-fixture.ts` (repo root, outside the tsconfig include) ran once and was deleted before the build check.
  **Seam (GREEN).** The query schema, the JS filter and the handler parse+forward shape match the suites' imports (`listNodes`, `listNodeHandler`, `nodeListQuery`); the fixture equals the `fieldRows` walk over the registry, so `assert.deepEqual(rows, fieldDecisions)` holds by construction.
  **Refactor.** None named; the filter is the Story's stated shape and the fixture is regenerated data.
  **Build check.**
- typecheck: exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- lint (`eslint` on the four changed files): exit 0
  **Assumptions.**
- VERIFIED: `example.test.ts` requires a `query` example when an operation declares a `query` schema, so `nodeListExamples` gains the five-key example; all values parse in-domain against `nodeListQuery`.
- VERIFIED: `singleValued`'s own throw is already `httpError("invalid-request", ...)`, so the repeated-key refusal needs no extra catch, matching `list-event.ts` exactly as the Story directs.
- No test file and no `test/helpers/**` file was edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 15 GREEN · RED for Story 16 the CLI commands

**Cycle.** Confirm GREEN for Story 15 (`src/queries/node/list-node.test.ts` + `src/http/server/node/list-node.test.ts`), then RED for Story 16 (`src/cli/node/list.test.ts`, `show.test.ts`, `claim.test.ts`, `heartbeat.test.ts`, `release.test.ts` new; `client.test.ts`, `program.test.ts`, `inventory.test.ts`, `parity.test.ts` edited).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 15 confirm).**
- command: `node --test src/queries/node/list-node.test.ts src/http/server/node/list-node.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts`
- exit: 0 — pass 103, fail 0 — Story 15 closes.
- One test was red at first run, a defect in my own handler fixture from the RED turn: `the handler passes the parsed filter to the query exactly once` sent `?project=project_b`, but `nodeListQuery.project` is `identity("project")` — a `project_`+ULID schema — and `project_b` (like the fixture's `project_a`) is not a ULID, so the schema refused it with 400. The counting-stub test needs no database, so the query string now carries the schema-valid literal `project_01JQ8Z7G3HZZZZZZZZZZZZZZZW` and the expected received value matches. The SE's implementation is correct; the query-level tests drive `{ project: "project_b" }` directly into `listNodes` and were already green.
- **Story-15 collateral, fixed this turn:** `src/http/contract/example.test.ts` — `every query example satisfies its query schema` still pinned `["event.list"]`; the SE's Story-15 change (node.list gained `query: nodeListQuery` + `nodeListExamples.query`) put `node.list` beside it, and my Story-15 confirm suite did not run this file. Expected set is now `["event.list", "node.list"]`.
  **Test written.**
- file: `src/cli/client.test.ts` (edited) — suite `src/cli/client.test` — methods:
  - `buildRequest percent-encodes reserved characters in query names and values` (rewritten to the new contract: bytewise order `na%23me` before `q`, space as `%20` — the old URLSearchParams expectation `a+b` is the behavior the Story's `encodeURIComponent` rule replaces);
  - `buildRequest appends no query string when query is absent or fully skipped` (absent → URL unchanged; `{ limit: undefined }` → URL unchanged, never a bare `?`);
  - `buildRequest appends the query keys in bytewise order` (`{ state: "ready", kind: "task" }` → `?kind=task&state=ready`);
  - `buildRequest skips an undefined value` (`{ state: "ready", kind: undefined }` → `?state=ready`);
  - `buildRequest percent-encodes a value that holds a space` (`{ q: "a b" }` → `?q=a%20b`);
  - `buildRequest writes the Idempotency-Key header when present and omits it when absent` (the one place the header is observable, since the CLI suites stub the client).
- file: `src/cli/node/list.test.ts` (new) — suite `src/cli/node/list.test` — methods: `node list calls node.list with no body, no parameters and no options`; `node list passes only the supplied filters` (`--state ready --kind task` → recorded options `{ query: { state: "ready", kind: "task" } }`, deepEqual); `node list with no option passes no query` (recorded `options` is `undefined`, never `{}`); `node list prints one line per node in the returned order` (exact two-line literal: an initiative row prints `- -` for null blockReason/parentId, a task row prints `dirty-recovery` and the objective parent); `node list prints the empty line when there is no node` (`kanthord: no node\n`); `node list prints the error code and calls fail on a refusal`.
- file: `src/cli/node/show.test.ts` (new) — `node show calls node.show with the id parameter and no body`; `node show prints the node line` (`kanthord: node <id> <kind> <state> <title>\n`); refusal.
- file: `src/cli/node/claim.test.ts` (new) — `node claim sends an empty body with the id parameter` (recorded body deep-equals `{}`, never `undefined`); `node claim prints its two lines exactly` (full two-line literal with fence, expires, heartbeat, run, attempt, objective-run, objective-fence); `node claim prints a dash for a null attempt number` (objective-claim case, literal); `node claim sends an Idempotency-Key of 32 lowercase hex characters` (`/^[0-9a-f]{32}$/` on the recorded options member); refusal. Harness injects `randomBytes` per the `registerConfigGenerate` pattern; the arg id and `node.id` are the same value in every fixture, so the printed `nodeId` is robust to either source.
- file: `src/cli/node/heartbeat.test.ts` (new) — `node heartbeat calls node.heartbeat with the id parameter and the fence body` (`{ fence: 3 }`); `node heartbeat prints the renewed line` (`kanthord: renewed <id> fence <fence> expires <expiresAt>\n`); the 32-hex Idempotency-Key test; `node heartbeat mints a different Idempotency-Key on two consecutive calls` (counting `randomBytes` stub, two captured keys differ); `node heartbeat refuses a non-numeric fence without calling the daemon` (`--fence abc`, `--fence 0`, `--fence -1` each → exact stderr `kanthord: invalid-request: --fence must be a positive integer\n`, one `fail`, **zero** client calls — probed that commander 15 hands all three values through as strings); `node heartbeat requires a fence` (`.exitOverride()`, `assert.rejects` with `commander.missingMandatoryOptionValue`, zero calls); refusal.
- file: `src/cli/node/release.test.ts` (new) — the same six shapes: call recording, the `kanthord: released <id> state <state>\n` line, the three non-numeric-fence refusals, the commander-mandatory refusal, the error-code refusal.
- file: `src/cli/program.test.ts` (edited) — `buildProgram registers node list, node show, node claim, node heartbeat and node release` — walks the `node` group's `commands` and pins the name list `["create", "update", "delete", "list", "show", "claim", "heartbeat", "release"]` (the five after `registerPlanExport` in the Story's declared order, after EPIC 017's three).
- file: `src/cli/inventory.test.ts` (edited) — `declares exactly twenty-eight commands`; `commandPaths holds twenty-eight distinct strings`; `flattens to thirty-five entries naming thirty distinct operation ids` (30 → 35 / 26 → 30, `node.show` already present via delete/update); `pins the fifteen paths…` → twenty paths, the five `node claim/heartbeat/list/release/show` entries in bytewise position after `node delete`/before `node update`.
- file: `src/cli/parity.test.ts` (edited) — `programCommandPaths returns the twenty-eight inventory paths` (23 → 28); `pins thirty distinct ids across twenty-five calling entries` (20 → 25 / 26 → 30). The step-only-six and stubbed-only-`run` assertions stay untouched and green.
- asserts: the exact stdout/stderr literals of `16-cli-commands.md:68-76,83`; the two-record `call` argument shapes; `options` `undefined` versus `{ query }` as the only two representations; the minted-key regex and its per-call freshness; the schema-valid fixtures every command parses (`nodeListItem`/`nodeShowResponse` full member sets, `claimedLease` with `ownerKind: "actor"` and ULID identities); the per-file refusal contract of `project/list.ts:26-28`.
  **RED proof.**
- command: `node --test src/cli/node/list.test.ts src/cli/node/show.test.ts src/cli/node/claim.test.ts src/cli/node/heartbeat.test.ts src/cli/node/release.test.ts src/cli/client.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts`
- exit: 1 — pass 46, fail 18 — failures, verbatim: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/cli/node/list.ts' imported from .../list.test.ts` (all five suites); `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:` on the six client tests (URL diffs, e.g. actual `?state=ready&kind=task` vs expected `?kind=task&state=ready`; `idempotencyKey` never written); the four inventory count failures (23 vs 28, 30 vs 35, 26 vs 30, the fifteen-path list); the two parity count failures; the program names-array deep-equal (actual `["create","update","delete"]`).
- full suite: `npm test` — exit 1 — 4314 pass, 18 fail (the same eighteen; nothing outside the Story-16 target set regressed — the Story-15 collateral `example.test.ts` failure was fixed this turn and the full suite re-run).
- stub probe: the five `src/cli/node/{list,show,claim,heartbeat,release}.ts` — clean: with throwaway stubs of the Story-declared register surfaces (each `{ program, client, stdout, stderr, fail }`, claim and heartbeat plus `randomBytes`), `npm run typecheck` reports exactly three errors, all in `client.test.ts` and all seam-shaped against the not-yet-widened `client.ts`: `TS2322: Type 'undefined' is not assignable to type 'string'` ×2 (the `query: { ...: undefined }` literals, clearing when `CallInput.query` becomes `Readonly<Record<string, string | undefined>>`) and `TS2353: 'idempotencyKey' does not exist in type 'Readonly<{...}>'` (clearing when `CallInput` gains the member). No error in any of my other files — the four-parameter recording stubs are assignable to today's three-parameter `DaemonClient` (probed), so the five CLI suites' types agree with the declared surfaces. Stubs deleted before handoff; `git status` shows only the five `.test.ts` files under `src/cli/node/`.
- current-signature probe (the seam is an edit to the existing `client.ts`, not a new module): after stub deletion `npm run typecheck` reports the five `TS2307` seam errors plus their `TS7006` masking artifacts in my test files, and the three `client.test.ts` errors above — nothing in any other file.
  **Open to Software Engineer.**
- Seam: Story `16-cli-commands.md` is the spec; the suites import `registerNodeList` from `src/cli/node/list.ts`, `registerNodeShow` from `show.ts`, `registerNodeClaim` from `claim.ts`, `registerNodeHeartbeat` from `heartbeat.ts`, `registerNodeRelease` from `release.ts`.
- `src/cli/client.ts` — `CallInput` gains `query?: Readonly<Record<string, string | undefined>>` and `idempotencyKey?: string`; `DaemonClient.call` takes the one trailing `options?: Readonly<{ query?: Readonly<Record<string, string | undefined>>; idempotencyKey?: string }>` object as its fourth parameter; `buildRequest` renders the query with keys sorted by `Buffer.compare`, skips `undefined` values, `encodeURIComponent` on every key and value, `&`-joined after a single `?`, and appends nothing (not a bare `?`) when every value is skipped; `buildRequest` writes `headers["Idempotency-Key"]` when the member is present; `call` passes both new members through. Change no existing `client.call` call site (three-argument calls stay valid).
- The five files per the Story — each `registerNodeX({ program, client, stdout, stderr, fail })` (claim and heartbeat also `randomBytes`), guarding duplicate registration via `group.commands.some(...)`, calling its operation through `client.call`, parsing the response through the contract schema, printing the pinned lines: `node list` takes `--project/--kind/--state/--block-reason/--repository`, builds `query` from present options only, passes it as the fourth argument, omits the argument entirely when no option is present (`undefined`, never `{}`), prints `kanthord: node <id> <kind> <state> <blockReason|-> <parentId|->` per node in response order and `kanthord: no node\n` when empty; `node show` one `<id>` argument, prints `kanthord: node <id> <kind> <state> <title>`; `node claim` one `<id>`, empty body `{}`, one fresh `randomBytes(16).toString("hex")` key per invocation, prints the two lines of `16-cli-commands.md:72-73` (fence from `lease`, objective-fence from `objectiveLease`, `attempt -` for a null attemptNo, `expiresAt` raw); `node heartbeat` one `<id>` and a **required** `--fence <n>` option, fresh key per call, prints `kanthord: renewed <id> fence <fence> expires <expiresAt>`; `node release` one `<id>` and a required `--fence <n>`, prints `kanthord: released <id> state <state>`; both fence commands parse with `Number.parseInt(value, 10)` and on a non-positive result print `kanthord: invalid-request: --fence must be a positive integer\n`, call `fail` once and never call the daemon; every refusal prints `kanthord: <code>: <message>\n` to stderr and calls `fail` once.
- `src/cli/program.ts` — import the five `registerNodeX` and call all five after `registerPlanExport` in the order list, show, claim, heartbeat, release, passing `randomBytes: dependencies.randomBytes` to claim and heartbeat.
- `src/cli/inventory.ts` — insert the five entries (`node claim` → `node.claim`, `node heartbeat` → `node.heartbeat`, `node list` → `node.list`, `node release` → `node.release`, `node show` → `node.show`) in bytewise-sorted position among the `node.*` entries.
- Behaviour the suites pin: the exact output literals and the two-representation rule for `options`; the 32-hex fresh key per invocation and its per-call difference; zero daemon calls on a bad fence; commander's own `requiredOption` refusal for a missing fence; the schema-valid success bodies the commands parse.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 16-cli-commands · the client query, the five commands, the registrations

**Cycle.** GREEN+REFACTOR for Story 16, per the TE's RED at the five `src/cli/node/*.test.ts` suites, `client.test.ts`, `program.test.ts`, `inventory.test.ts` and `parity.test.ts`.
**Files changed.**

- `src/cli/client.ts` (edited) — `CallInput` gains `query?: Readonly<Record<string, string | undefined>>` and `idempotencyKey?: string`; `DaemonClient.call` gains the one trailing `options` object (`query` + `idempotencyKey`) as its fourth parameter; `buildRequest` renders the query with keys sorted by `Buffer.compare`, skips `undefined` values, `encodeURIComponent` on every key and value, `&`-joined after a single `?`, and appends nothing when every value is skipped (replaces the `URLSearchParams` form, whose `+`-for-space encoding the suites pin against); `buildRequest` writes `headers["Idempotency-Key"]` only when the member is present; `call` forwards the input unchanged.
- `src/cli/node/list.ts` (new) — `registerNodeList({ program, client, stdout, stderr, fail })`, duplicate-guarded; five options `--project/--kind/--state/--block-reason/--repository`; builds `query` from present options only, passes it as the fourth `client.call` argument, omits the argument entirely when no option is present; prints `kanthord: node <id> <kind> <state> <blockReason|-> <parentId|->` per node and `kanthord: no node\n` when empty.
- `src/cli/node/show.ts` (new) — `registerNodeShow`, one `<id>` argument, `node.show` with no body, prints `kanthord: node <id> <kind> <state> <title>`.
- `src/cli/node/claim.ts` (new) — `registerNodeClaim({ program, client, stdout, stderr, fail, randomBytes })`, one `<id>` argument, empty body `{}`, one fresh `randomBytes(16).toString("hex")` key per invocation, prints the two lines of `16-cli-commands.md:72-73` (fence from `lease`, objective-fence from `objectiveLease`, `attempt -` for a null attemptNo, `expiresAt` raw).
- `src/cli/node/heartbeat.ts` (new) — `registerNodeHeartbeat`, one `<id>` argument, `requiredOption("--fence <n>")`, fresh key per call, `Number.parseInt` with a non-positive result printing `kanthord: invalid-request: --fence must be a positive integer\n`, one `fail`, zero daemon calls; prints `kanthord: renewed <id> fence <fence> expires <expiresAt>`.
- `src/cli/node/release.ts` (new) — `registerNodeRelease`, same fence parse and refusal contract, prints `kanthord: released <id> state <state>`.
- `src/cli/program.ts` (edited) — imports and registers all five after `registerPlanExport` in the order list, show, claim, heartbeat, release, passing `randomBytes: dependencies.randomBytes` to claim and heartbeat; the composed `DaemonClient` forwards `options?.query` and `options?.idempotencyKey` into `CallInput`.
- `src/cli/inventory.ts` (edited) — the five entries `node claim/heartbeat/list/release/show` in bytewise-sorted position among the `node.*` entries.
  **Seam (GREEN).** The suites' imports (`registerNodeList/Show/Claim/Heartbeat/Release`, `buildRequest`, `CallInput`, the four-parameter `DaemonClient`) match the declared surfaces; the output literals, the two-representation rule for `options` (`undefined` vs `{ query }`), the 32-hex fresh key, and the zero-call fence refusals are the behavior implemented.
  **Refactor.** None named; the commands are the Story's stated shape and the client query is its stated renderer.
  **Build check.**
- typecheck: exit 0
- lint (`eslint` on the eight changed files): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Assumptions.**
- VERIFIED: `commandPaths` stays bytewise-sorted after the five insertions (`claim` < `create` < `delete` < `heartbeat` < `list` < `release` < `show` < `update`); the flattened op-id count rises by exactly five to 35 with 30 distinct ids, because `node.show` was already present via delete/update — matching the TE's edited counts in both inventory and parity suites.
- VERIFIED: `Number.parseInt("3.9", 10)` is 3 and `Number.parseInt("3", 10)` is 3, so the `Number.isInteger` + `fence < 1` guard admits the numeric cases the suites drive and refuses `abc`/`0`/`-1`.
- No test file and no `test/helpers/**` file was edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 16 GREEN · RED for Story 17 the composition root

**Cycle.** Confirm GREEN for Story 16 (`src/cli/node/*.test.ts` + `client`/`program`/`inventory`/`parity`), then RED for Story 17 (`src/main.claim.test.ts`, new — the daemon-backed proof).
**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.
  **Verification result (Story 16 confirm).**
- command: `node --test src/cli/node/list.test.ts src/cli/node/show.test.ts src/cli/node/claim.test.ts src/cli/node/heartbeat.test.ts src/cli/node/release.test.ts src/cli/client.test.ts src/cli/program.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts`
- exit: 0 — pass 85, fail 0 — Story 16 closes.
  **Test written.**
- file: `src/main.claim.test.ts` (new) — suite `src/main.claim.test` — the Story-17 journey, one `it` per step in the story's exact order: `plan.import creates one initiative, one objective and two sibling tasks, and actor.register creates two harnesses` (plan.validate over HTTP, the **rendered** response documents feeding the import — the CLI pattern; durable key `claim-journey-1`; two harnesses with tokens and ids); `node.list?state=ready&kind=task returns the two tasks of the objective` (exactly two ready tasks, same parentId; objective and initiative resolved through node.show); `node.claim on the first task answers 200 with external runs, attempt 1 and the full node view` (`heartbeatIntervalMs` 100000, `attemptNo` 1, fence 1, run rows read back directly — task run `parent_run_id` = the objective run id, both `driver` external — all three states `running` through node.show, and the claim response `node` carries `state`, `title` and `parentId` — the binding-time full-view merge Story 14 assigned to Story 17); the two second-actor refusals with full details; `an EPIC-110-style objective acquisition by a daemon owner is refused lease-held` (in-process `new SqliteStorage` + `new SqliteLease` over the daemon's file, `owner: "daemon_x"`, `ownerKind: "daemon"` → `LeaseError` code `lease-held`); `node.heartbeat extends expiresAt and leaves the fence unchanged` (response values equal the lease rows, fences unmoved); `an expired claim returns the task to the pool at the next claim` (the expiry write `UPDATE lease SET expires_at = 1 … RETURNING subject_id` asserting **two** rows, then the re-claim: new fence old+1, attempt 1, old task run and old objective run `expired`, old attempt `cancelled`); `the old owner's node.release is refused lease-held`; `the stale fence differs from the live fence` (the value EPIC 019 must refuse, recorded); `the production composition root binds all three routes` (a fresh claim/heartbeat/release triple on the second task, each `any-but-501`); `every request of this test was served by the production composition root` (source read of itself: no `createTestApp`, no `test/helpers/app.ts`, no `main.ts` import line).
- file: `test/helpers/home.ts` (edited) — the base config gains `leaseTtlMs: 300000` after `attemptLimit` (Story 17's Change section; a test-helper lane edit).
- file: `test/helpers/home.test.ts` (edited) — both base-document deep-equal literals gain `leaseTtlMs: 300000`.
- file: `src/services/config/convict.test.ts` (edited) — happy path asserts `settings.leaseTtlMs === 300000`; the key-order test becomes `home, actor, masterKey, http, tools, attemptLimit, leaseTtlMs`; new env test `KANTHORD_LEASE_TTL_MS=700000 wins over file leaseTtlMs` (mirrors the attemptLimit env test).
  **Spec note — Story 17's relation pins are unachievable; the EPIC's own Decisions win.**
- Verify step 5 pins `details.relation` `sibling` and step 6 pins `descendant`. Both are impossible in this journey: step 4's claim takes the mandatory objective scope (EPIC `:26`), so the objective lease is live under the first actor, and the Story-5 hierarchy precedence (`self` → `ancestor` → `descendant` → `sibling`, shipped green and pinned by Story 10) refuses on it first. The sibling claim is therefore refused with relation `ancestor` and subject the objective; the objective claim with relation `self` and subject the objective. Story 10 reaches `sibling`/`descendant` only by seeding the sibling task lease with no objective lease, which the journey cannot do. The refusals the EPIC goal names (`:7`) all still occur; the tests assert `{ subject: objectiveId, holder: harnessA, holderKind: "actor", relation: "ancestor" }` and `{ … relation: "self" }` with fence/expiresAt, matching the EPIC's own decision text (`"An objective held by another actor refuses the task claim"`).
- Smoke of the setup portion ran against the **current** daemon (config without `leaseTtlMs`): validate/import/register/list/show all green, and the claim answers `501` — the story's headline defect, proven live before Story 17.
  **RED proof.**
- command: `node --test src/main.claim.test.ts`
- exit: 1 — fail 1 (suite) — failure, verbatim: `Error: daemon exited before ready` … `stderr: kanthord: config-invalid: configuration param 'leaseTtlMs' not declared in the schema` — the Story-17 config seam; the daemon cannot start until the schema key lands.
- command: `node --test src/services/config/convict.test.ts test/helpers/home.test.ts`
- exit: 1 — 122 pass, 3 fail — the three failures, all the same seam: `returns Settings with each value from a complete file` (leaseTtlMs undefined), `Settings key order is home, actor, masterKey, http, tools, attemptLimit, leaseTtlMs` (deep-equal 6 vs 7 keys), `KANTHORD_LEASE_TTL_MS=700000 wins over file leaseTtlMs` (`configuration param 'leaseTtlMs' not declared in the schema`); `test/helpers/home.test.ts` passes.
- full suite: `npm test` — exit 1 — 4293 pass, 31 fail, 43 cancelled — every failure outside the three convict ones is the identical `config-invalid: leaseTtlMs not declared` in the daemon-starting suites (`src/main.test.ts`, `src/main.node-write.test.ts`, `src/main.readiness.test.ts`, `test/helpers/daemon.test.ts`, `test/helpers/cli.test.ts`, `src/services/config/startup.test.ts`, `src/services/home-lock/startup.test.ts`, `scripts/verify-db-status.test.ts`) — all collateral of the base-config addition, all green once the schema key lands; nothing else regressed.
- typecheck: `npm run typecheck` — exactly two errors, both `TS2339: Property 'leaseTtlMs' does not exist on type 'Readonly<{…}>'` at my two `convict.test.ts` assertions — the seam; no error in `src/main.claim.test.ts` or any other file; TS2339 does not mask body checking. Stub probe: none — the seam is a member/schema change in existing production files, not a new module.
- smoke: `claim-setup-smoke.mjs` (repo root, deleted after; `git status` shows no trace) drove the setup portion against the real daemon — `SMOKE: PASS — setup portion green; claim answers 501 (the seam)`; the expiry `UPDATE … RETURNING` statement probed standalone against a scratch `node:sqlite` — two rows in the right shape.
  **Open to Software Engineer.**
- Seam: Story `17-composition-root.md` is the spec; `src/main.claim.test.ts` drives the real daemon over HTTP and imports nothing of `main.ts`.
- `src/services/config/index.ts` — `Settings` gains `leaseTtlMs: number` after `attemptLimit` at `:29`.
- `src/services/config/convict.ts` — the schema entry `leaseTtlMs: { format: "positiveInteger", default: 300000, env: "KANTHORD_LEASE_TTL_MS" }` beside `attemptLimit` at `:221-225`; the env-integer list at `:331-340` gains `["KANTHORD_LEASE_TTL_MS", "leaseTtlMs"]`; the projection at `:496` gains `leaseTtlMs: config.get("leaseTtlMs") as number`.
- `src/main.ts` — construct neither `SqliteLease` nor `SqliteExecution` a second time (Story 9 already did); the handler map at `:247` gains exactly three entries after `node.show` at `:334-336` — `node.claim` = `claimNodeHandler({ claimNode: (input) => claimNode({ storage, plan, lease, execution, events, clock, ids, sweepExpiredExternalLeases: (transaction, sweepInput) => sweepExpiredExternalLeases({ plan, lease, execution, events }, transaction, sweepInput), attemptLimit: settings.attemptLimit, leaseTtlMs: settings.leaseTtlMs, instanceId }, input) })`, `node.heartbeat` = `heartbeatNodeHandler({ heartbeatNode: … })` with `leaseTtlMs: settings.leaseTtlMs`, `node.release` = `releaseNodeHandler({ releaseNode: … })`; `unimplementedFor(handlers)` then holds none of the three. **The claim and release responses must carry the full node view**: the command results carry `node: { id, state }` only while the contract schemas require the full `nodeShowResponse` — the binding-time wrap in `main.ts` (Story 14's OPEN assigned it here) merges the `showNode` view into both response bodies; the suites pin `node.state`, `node.title` and `node.parentId` on both responses.
- Behaviour the suite pins beyond the Story text: the claim response `node` is the full view; the refusal `holderKind` is `"actor"`; the heartbeat response values equal the lease rows; the expiry write reports exactly the two rows; the re-claim fence is old+1 with attempt 1; the stale-fence release is `409 lease-held`.
- Confirm-turn work (my lane, next turn): remove the three ids from `pending` in `src/main.test.ts:24` and add their fixture rows (missing-id → 404), per the mechanism Story 14's confirm installed.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — 17-composition-root · leaseTtlMs config and the three route bindings

**Cycle.** GREEN+REFACTOR for Story 17, per the TE's RED at `src/main.claim.test.ts` (daemon `config-invalid: leaseTtlMs not declared`) and `convict.test.ts` / `home.test.ts`.
**Files changed.**

- `src/services/config/index.ts` (edited) — `Settings` gains `leaseTtlMs: number`, declared after `attemptLimit` at `:29`.
- `src/services/config/convict.ts` (edited) — the schema entry `leaseTtlMs: { format: "positiveInteger", default: 300000, env: "KANTHORD_LEASE_TTL_MS" }` beside `attemptLimit`; the env-integer list gains `["KANTHORD_LEASE_TTL_MS", "leaseTtlMs"]`; the projection gains `leaseTtlMs: config.get("leaseTtlMs") as number`.
- `src/main.ts` (edited) — imports `claimNode`, `heartbeatNode`, `releaseNode`, the three handlers, and `sweepExpiredExternalLeases` (extended from the existing `recoverExpiredLeases` import). The handler map gains exactly three entries after `node.show`:
  - `node.claim` = `claimNodeHandler` with the full `claimNode` dependency set (`storage, plan, lease, execution, events, clock, ids, sweepExpiredExternalLeases: (transaction, sweepInput) => sweepExpiredExternalLeases({ plan, lease, execution, events }, transaction, sweepInput), attemptLimit: settings.attemptLimit, leaseTtlMs: settings.leaseTtlMs, instanceId`), wrapped so the response `node` is the **full view** — the command result's `{ id, state }` is replaced by `showNode({ storage, plan, blobs }, { id: result.node.id })` at binding time, with a throw on a missing view.
  - `node.heartbeat` = `heartbeatNodeHandler` with `{ storage, plan, lease, events, clock, leaseTtlMs: settings.leaseTtlMs }`.
  - `node.release` = `releaseNodeHandler` with `{ storage, plan, lease, execution, events, clock }`, wrapped with the same full-view merge (the Story-14 OPEN assigned the merge here; the contract schemas require `nodeShowResponse` on both responses and the suites pin `node.state`, `node.title` and `node.parentId`).
    **Seam (GREEN).** `Settings.leaseTtlMs` exists and the daemon schema declares `KANTHORD_LEASE_TTL_MS`, so the daemon starts; the three operation ids are bound, so `unimplementedFor(handlers)` holds none of them and the real root answers no `501`.
    **Refactor.** None named. `lease` and `execution` were already constructed by Story 9 and `revokeActor` already carries `lease` (Story 13); no second construction and no other binding edit was needed, per the Story's assertion step.
    **Build check.**
- typecheck: exit 0
- lint (`eslint` on the three changed files): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
  **Runtime smoke.** One-off `claim-smoke.mjs` (repo root, deleted after) migrated a fresh home, launched the real `src/main.ts`, and drove the four routes over HTTP with the production composition root: `claim`/`heartbeat`/`release` on an unknown node answer `404 not-found` (bound handlers reached) and `node.list?state=ready&kind=task` answers `200` — no route answers `501`; daemon boots with `leaseTtlMs`. `SMOKE: PASS — daemon boots with leaseTtlMs; no route answers 501`.
  **Assumptions.**
- VERIFIED: the release-node command does not need `leaseTtlMs` (Story constraint: the TTL reaches `claimNode` and `heartbeatNode` and nothing else).
- VERIFIED: `sweepExpiredExternalLeases` returns `SweepExpiredExternalLeasesResult`; the `claimNode` dependency types it `=> void`, and a non-void return is assignable at that call site — typecheck confirms.
- No test file and no `test/helpers/**` file was edited.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm Story 17 GREEN · OPEN on Story 18 (lane-locked planning document)

**Cycle.** Confirm GREEN for Story 17 (`src/main.claim.test.ts`), with the deferred confirm-turn work of the Story-17 RED turn, then the next Task — Story 18 `18-epic-110-reconciliation` — **blocked**: its only permitted output path is denied to every role by the lane guard. No test is written this turn; the blocker is reported with the full probe.

**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; SE's cited artifact (typecheck) re-verifies independently.

**Verification result (Story 17 confirm).**

- command: `node --test src/main.claim.test.ts src/main.test.ts src/services/config/convict.test.ts test/helpers/home.test.ts`
- exit: 0 — pass 151, fail 0 — `src/main.claim.test` (861.8ms) and `src/main.test` (3.1s) both green; Story 17 closes.
- Full gate: `npm run verify` — exit 0 (typecheck, `npm test`, `npm run lint`, `verify-db-status` all green).

**Confirm-turn work (deferred from the Story-17 RED turn, now done).**

- `src/main.test.ts` — the three ids left the `pending` list (now `[] as const`, comment updated); the fixtures gain the three rows in bytewise position: `node.claim` (`{ id: missing("node") }, body: {}, expect: 404`), `node.heartbeat` (`body: { fence: 1 }`, 404), `node.release` (`body: { fence: 1 }`, 404). The bound routes answer 404 on the unknown node; the completeness sweep of `covered` vs `routed` holds with an empty pending list.

**Confirm-turn repair (my lane, found by the Story-17 full-gate lint).**

- The first full `npm run lint` of the epic reported three `no-restricted-syntax` errors in my own test files — raw `INSERT INTO node` writes in files the exemption list (correctly) does not carry: `src/services/lease/sqlite.test.ts:29:7` (`task_b`), `src/services/execution/sqlite.test.ts:34:7` (same), `src/commands/node/claim-node.test.ts:1420:13` (`objective_sibling`). The config comment directs new files to seed through `test/helpers/rows.ts`.
- Fix: `test/helpers/rows.ts` gains `seedSiblingTask(transaction)` (the `task_b` sibling under `fixtureIds.objective`, pending, `fixtureIds.planRevision`) and `seedSiblingObjective(transaction)` (the `objective_sibling` second live objective under `fixtureIds.initiative`, ready, `fixtureIds.repository`), both byte-identical row shapes to the removed inserts; the three test files import and call them.
- `npm run lint` — exit 0; `npm run typecheck` — exit 0; `node --test src/services/lease/sqlite.test.ts src/services/execution/sqlite.test.ts src/commands/node/claim-node.test.ts` — exit 0, pass 92.

**OPEN: Story 18 is unimplementable inside the lane system — the plan tree is locked for every role.**

- Story file: `18-epic-110-reconciliation.md` — "This is a planning-document story. It edits no source file and no test." No `Action — RED:` block exists; its Verify is grep-based (`git diff --name-only` lists exactly one path, five greps over `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md`) plus `npm run verify` staying green; it delivers no Proof line.
- The one path it permits, `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md`, is denied to every role by `scripts/lane-check.sh` (`case .agent/plan/*) deny "the plan tree is locked"`). Probed this turn: `scripts/lane-check.sh software-engineer <path>` → `lane violation: ... (the plan tree is locked)`, exit 1; `scripts/lane-check.sh test-engineer <path>` → the same, exit 1. There is no test I can write (the story forbids tests and names none), and a GREEN-ONLY pass-through would open a lane-denied path to the software-engineer — which my role boundary forbids ("name only software-engineer-lane paths") and which would burn the SE's turn on the identical denial.
- Ask the human to choose: (a) apply the Story-18 edit directly — it is a plan-tree edit, the plan owner's lane — per `18-epic-110-reconciliation.md` (the published-surface list, the one-lease-row correction, `0009-one-objective-run`, the `AND driver = 'internal'` predicate, the provenance wording), then re-dispatch for the grep Verify; or (b) amend the lane guard for this one story and re-dispatch the pass-through to the SE. Every story before it (1–17) is green; the epic's Proof list needs no Story-18 file.

**Cycle end state.** Stories 1–17 green; `npm run verify` green end-to-end. Story 18 is the sole remaining task and cannot proceed without the human's lane decision.

ATTEMPT-FAILED: 18-epic-110-reconciliation — the only path the story permits (.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md) is denied to every role by scripts/lane-check.sh ("the plan tree is locked"); no RED test is writable for a planning-document story, and a GREEN-ONLY pass-through would open a lane-denied path and burn the SE's turn on the same denial

END: TEST-ENGINEER

## HUMAN — 018-claim-and-lease · Story 18 `18-epic-110-reconciliation` · CLOSED

**Route taken.** Option (a) of the test-engineer blocker: the edit is a plan-tree edit and the plan owner applied it directly. `scripts/lane-check.sh` was not amended, and no lane-denied path was handed to a subagent.

**State found.** Commit `35d221b` ("docs(phase-2): reconcile epics with the external-drive block") had already landed four of the five obligations of the story into `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md`:

- one lease row, both directions — story five, line 32: `liveLeaseRefusal` refuses another owner on the objective or on any task of it, and the reverse refusal stops a harness task claim under a worker-held objective.
- the migration number — `migration 9`, `0009-one-objective-run` at lines 29, 97 and 131; line 23 records `EPIC 015 owns 0005, EPIC 017 owns 0006, EPIC 018 owns 0007, EPIC 105 owns 0008`. No `0006-one-objective-run` and no migration `6` of this epic remains.
- the driver predicate — line 29 carries `AND driver = 'internal'` in the index DDL, line 131 asserts the predicate verbatim from `sqlite_master`, line 138 asserts an external objective run admits an internal one beside it; every `run` and `attempt` write of stories five, six, nine and eleven names `driver: "internal"` explicitly.
- the lease provenance wording — line 34 names `owner_kind = 'daemon'` for a worker holding and `owner_kind = 'actor'` for a harness holding; line 152 asserts both.

**Edit applied.** One file, one hunk, story 73 (`Two new stores, the published Execution extended, ...`). The published-surface sentence already named the seven `Lease` methods, `AcquireLeaseResult` with `record` and `acquired`, `LeaseRecord` with `ownerKind`, and the `now`/`ownerKind` members. It gained the three missing members of the story's list: `AcquireLeaseInput` and `ReleaseLeaseInput` also carrying `owner`; `LeaseError` holding exactly `lease-held` and `lease-fenced`; and `liveLeaseRefusal` of `src/domain/lease-hierarchy.ts` beside `leaseRelations` — closed with the sentence that the list is the whole consumed surface and nothing more.

**Verify.**

- `git diff --name-only -- .agent/` lists exactly one path, `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md`. No file under `src/`, `test/` or `docs/` was touched by this story.
- `0006-one-objective-run`: 0 occurrences. `0009-one-objective-run`: 3 (the migration file name, the Proof test path, the migration assertion) — one migration identity, cited three times.
- `run_one_active_objective`: 5 mentions; the index definition and both coverage assertions carry the `driver` predicate.
- The published-surface list appears once and names all seven `Lease` methods.
- `npm run verify` — exit 0 (typecheck, `npm test` pass 4367 / fail 0, `eslint`, `verify-db-status`), unchanged by this story.
- Proof: this story delivers no `PASS` line. It closes the reconciliation obligation of `.agent/plan/epics/013-external-drive-overview.md:108`, covered by the Gates line.

**Deviation from the story's Verify, stated.** The story's grep "every `run_one_active_objective` mention carries `AND driver = 'internal'`" is not literally true of line 150, which names the index only as the source of the `ExecutionError("run-active")` race refusal and describes no index shape. No edit was made there: adding the predicate to a sentence about an error path would state the DDL twice. The intent of the check — that no mention describes the index without its driver predicate — holds.

**Epic state.** Stories 1–18 complete. `npm run verify` green end-to-end. EPIC 018 is ready for human review.

END: HUMAN

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.** Every Story of EPIC 018 is implemented and green. The human closed Story 18 (`18-epic-110-reconciliation`) as a plan-tree edit, so no Task is outstanding and no story file is unexpanded. Both parts of the gate were executed this turn.

**Gates.**

- `typecheck` (npm run typecheck): exit 0 — run inside `npm run verify`; the chain passed to the next step.
- `unit` (npm test): exit 0 — 4366 pass, 0 fail, 0 cancelled (inside `npm run verify`).
- `npm run verify` (the EPIC `Gates:` line, full chain: typecheck, `npm test`, `eslint .`, `scripts/verify-db-status.ts`): exit 0 — lint clean, final line `kanthord: verify db status ok`.
- Note on the count: the previous human turn reported 4367 pass; this turn it is 4366 because I removed the stray untracked root-level scratch file `probe-heartbeat-scratch.test.ts` (a leftover `*.test.ts` probe from the Story 12 CLI work, unmentioned in any journal — test-file debris is my lane; it carried one trivial test). No epic test was touched.

**Proof.** The EPIC `Proof:` command — `node --test` over the 30 named paths `&& echo "PASS EPIC-018"` — exit 0, 612 pass / 0 fail across 44 suites, and it printed the exact success string: `PASS EPIC-018`. Every one of the 30 named files exists; `src/main.claim.test.ts` (11 tests) drove the whole claim/heartbeat/release/expiry sequence through the real composition root with no injected handler map.

**Tasks closed.** 18 across 18 Stories (01–18), with no Story outstanding. `npm run verify` (Gates) and the Proof both green end-to-end; the proof line of the gate names no story file.

```
IMPLEMENTATION_READY_FOR_REVIEW:
- gates: PASS
- proof: PASS (node --test <30 named paths> && echo "PASS EPIC-018") — "PASS EPIC-018"
- stories: 18/18 complete
- date: 2026-08-16
- state: local-uncommitted
```

END: TEST-ENGINEER

AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 3 action:NO finding(s) recorded for the human.
BLOCKER: B1 recover-expired-leases sweep closes completed attempts — src/commands/startup/recover-expired-leases.ts:87 calls closeAttempt on every attempt of an expired run, but closeAttempt rejects a completed (outcome non-null) row and rolls back the whole recovery transaction; Story 9 line 49 requires closing every OPEN attempt only and EPIC line 207 requires successful claim-driven recovery — fix: filter attempts to outcome === null before closing them, and add coverage for a run with mixed completed and open attempt history.
BLOCKER: B4 EPIC 110 lease-input wording — .agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:73 says every lease input carries ownerKind, but ReadLeaseInput, AssertHeldInput and the owner-expiry inputs do not; Story 7 line 29 already corrects this — fix: apply Story 7's wording (every input carries now; owner-writing inputs carry ownerKind).
INFO: B2 refusal-precedence conflict (NEEDS-HUMAN) — src/main.claim.test.ts:422 expects ancestor/self, Story 17 lines 119-120 requires sibling/descendant, and Story 5 lines 77-80 mandates the self->ancestor->descendant->sibling precedence; reconcile the precedence then align liveLeaseRefusal, claimNode and the real-daemon assertions.
INFO: B3 test-import boundary (NEEDS-HUMAN) — src/main.claim.test.ts:16 imports SqliteStorage, SqliteLease, migrations and SystemClock, which that test does not cover; AGENTS.md:49,113 restricts a test to service interfaces and implementations of its covered capability; define an allowed seam for the same-database acquisition proof.
INFO: B5 LeaseError code union (NEEDS-HUMAN) — .agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:73 says LeaseError has exactly two codes, but the published type also holds not-implemented; Story 7 line 51 requires three codes; decide the union then align the implementation and EPIC 110.

## TEST-ENGINEER — 018-claim-and-lease · review blocker B1 regression RED · B4 escalated to human

**Cycle.** RED for the AUTO_REVIEW blocker B1 (the sweep closes completed attempts), written as one focused regression test per the review-blocker exception. B4 is escalated to the human: its only fix path is the plan tree, which the lane guard denies to every role.
**Test written.**

- file: `src/commands/startup/recover-expired-leases.test.ts` (edited) — suite `src/commands/startup/recover-expired-leases.test` — method: `the sweep closes only the open attempt of a run with mixed completed and open history`.
- asserts: recovery through the real statements (backed execution fake over real SQLite rows) succeeds on a task run whose history holds a completed attempt (attempt_no 1, outcome `rejected`, ended_at NOW − 1000) and an open attempt (attempt_no 2): `returnedToReady` 1 and `blocked` 0, the completed attempt row byte-identical after the sweep, the open attempt closed `cancelled` at `NOW`, the run ended `expired` at `NOW`, the task back to `ready` under `claim-expired`, the lease cleared at fence 5, exactly one `recovery.leaseRecovered` event, and `closeAttemptCalls` deep-equal `[{ attemptId: openAttemptId, outcome: "cancelled", at: NOW }]` — the completed attempt id is never passed to `closeAttempt`.
  **RED proof.**
- command: `node --test src/commands/startup/recover-expired-leases.test.ts`
- exit: 1 — pass 31, fail 1 — failure, verbatim: `Error [ExecutionError]: attempt attempt_ext_01ARZ3NDEKTSV4RRFFQ69G5FAZ is not open` at `Object.closeAttempt` (`test/helpers/execution.ts:334:15`) via `sweepExpiredExternalLeases` (`recover-expired-leases.ts:91:32`) inside `runInTransaction` — the review's exact defect: the sweep closes the completed attempt, the `WHERE outcome IS NULL` guard refuses it, and the whole recovery transaction rolls back.
- full suite: `npm test` — exit 1 — 4366 pass, 1 fail (the regression test alone); nothing else red repo-wide.
- typecheck: `npm run typecheck` — exit 0. One in-turn fix of my own: TS2698 on the raw `transaction.all` rows (spread of `unknown`) — hoisted to a cast `as readonly Readonly<Record<string, unknown>>[]` before the `{ ...row }` map, the same idiom as the file's `readLease`.
- stub probe: none needed — the seam is a behavior change inside the existing production file, not a new module; no TS2307 anywhere, and the backed-fake call sites typecheck against the declared `Execution` surface.
  **Open to Software Engineer.**
- `src/commands/startup/recover-expired-leases.ts` — in `sweepExpiredExternalLeases`, the per-run attempt loop at :87-96: close **only the open attempts** — filter the `attemptsOfRun` result to `outcome === null` before each `closeAttempt` call. Story 9 line 49 says "close every open attempt"; a completed attempt is not open, and `closeAttempt` refuses it with `attempt-not-open`, which rolls the whole recovery transaction back (EPIC line 207 requires claim-driven recovery to succeed). Everything else stays exactly as shipped: `endRun` with outcome `expired`, the five-column `UPDATE lease` that keeps the fence, `setNodeState` under `claim-expired`, and the `recovery.leaseRecovered` payload with `fence: row.fence`.
- The regression test drives the real statements through `createBackedExecutionFake` (`test/helpers/execution.ts`), so the fix must leave the completed attempt row byte-identical (outcome `rejected`, `ended_at` unchanged) and close only the open one.
  **Escalation to human — B4, plan tree locked (Story-18 precedent).**
- B4: `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:73` says "every input carries `now` and `ownerKind`", but `ReadLeaseInput`, `AssertHeldInput` and `ExpireLeasesOfOwnerInput` carry `now` only; `ownerKind` rides only on the owner-writing inputs `acquire`, `renew` and `release`. Story 7 line 29 already prescribes the corrected wording — "every input carries `now`, and every input that **writes** an owner carries `ownerKind`". The fix is a one-sentence edit to the plan tree, which `scripts/lane-check.sh` denies to every role (proven in the Story-18 cycle; the human closed that story by direct edit). No test is writable for a wording change, and I will not open a lane-denied path to the software-engineer. Ask the human to apply the correction at :73 directly (option (a) of the Story-18 decision), then re-dispatch.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — review blocker B1 · the sweep closes open attempts only

**Cycle.** GREEN+REFACTOR for `src/commands/startup/recover-expired-leases.test.ts` (B1 regression: `the sweep closes only the open attempt of a run with mixed completed and open history`).
**Files changed.**

- `src/commands/startup/recover-expired-leases.ts` (edited) — in `sweepExpiredExternalLeases`, the per-run attempt loop at :87-96 gains an `if (attempt.outcome !== null) continue;` guard, so `closeAttempt` receives only open attempts; a completed attempt (outcome non-null) is never passed to `closeAttempt` and stays byte-identical. Everything else stays exactly as shipped: `endRun` with outcome `expired`, the five-column `UPDATE lease` that keeps the fence, `setNodeState` under `claim-expired` with `cause: { revision, importId: null }`, and the `recovery.leaseRecovered` payload with `fence: row.fence`.
  **Seam (GREEN).** The sweep now closes only the open attempt (attempt_no 2) of the mixed-history run; the completed attempt (attempt_no 1, `rejected`, ended at NOW − 1000) is untouched, so `closeAttemptCalls` deep-equals `[{ attemptId: openAttemptId, outcome: "cancelled", at: NOW }]`, the recovery transaction commits, `returnedToReady` is 1 with `blocked` 0, the run ends `expired`, the task returns to `ready` under `claim-expired`, and the lease is cleared at fence 5.
  **Refactor.** None named.
  **Build check.**
- typecheck: exit 0
- lint (eslint on the changed file): exit 0
- verify:handoff: `VERIFY: PASS — npm run typecheck is clean`
- runtime smoke of the app, not tests: a scratch driver over the real `SqliteStorage` + `migrations` + `SqlitePlanStore`/`SqliteLease`/`SqliteExecution`/`SqliteEventLog` seeded a task run with a completed attempt (`rejected`, ended NOW − 1000) and an open attempt (2) plus an expired lease at fence 5, and ran the real `sweepExpiredExternalLeases` inside one `storage.transact` — `closeAttempt` called exactly once with the open attempt id, the completed row byte-identical, the open attempt `cancelled` at NOW, the run `ended`/`expired`, the task `ready`, the lease cleared with fence 5 kept, result `{ returnedToReady: 1, objectivesFreed: 0 }` — `SMOKE: PASS` (script in the temp dir, deleted after)
  **Review blocker addressed.** `BLOCKER: B1 recover-expired-leases sweep closes completed attempts — src/commands/startup/recover-expired-leases.ts:87 calls closeAttempt on every attempt of an expired run, but closeAttempt rejects a completed (outcome non-null) row and rolls back the whole recovery transaction; Story 9 line 49 requires closing every OPEN attempt only and EPIC line 207 requires successful claim-driven recovery — fix: filter attempts to outcome === null before closing them, and add coverage for a run with mixed completed and open attempt history.`
  **Assumptions.**
- VERIFIED: a guard over the loop and a filtered list are equivalent for the pinned `closeAttemptCalls`; the guard is the smaller diff and keeps the loop shape intact.
- No test file and no `test/helpers/**` file was edited; the regression test is the TE's and stays untouched.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — 018-claim-and-lease · confirm B1 GREEN · B4 still pending human

**Cycle.** Confirm GREEN for the AUTO_REVIEW blocker B1 (`the sweep closes only the open attempt of a run with mixed completed and open history`). B4's plan-tree edit has not landed: the defect sentence is still at `110-scheduler-leases-and-the-general-worker.md:73`, no HUMAN turn followed the escalation, and a fresh lane probe confirms the path stays denied to every role.

**Handoff gate.**

- command: `npm run verify:handoff` — `VERIFY: PASS — npm run typecheck is clean`; the SE's cited artifact (typecheck) re-verifies independently.
- The B1 fix is present as the smallest correct change: `if (attempt.outcome !== null) continue;` inside the per-run attempt loop of `sweepExpiredExternalLeases`, so `closeAttempt` receives open attempts only; the SE's turn names it as the sole edit and the file carries nothing else beyond the shipped Story 9 sweep.

**Verification result (B1 confirm).**

- command: `node --test src/commands/startup/recover-expired-leases.test.ts src/commands/node/claim-node.test.ts`
- exit: 0 — pass 74, fail 0 — the regression test is green, and the claim suite, which runs the real bound sweep inside its own transaction, stays green beside it.
- full suite: `npm test` — exit 0 — 4367 pass, 0 fail, 0 cancelled.
- Gates: `npm run verify` — exit 0 (typecheck, 4367 pass, lint, `kanthord: verify db status ok`). B1 closes.

**B4 status — still escalated to the human; the edit has not landed.**

- `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:73` still reads "every input carries `now` and `ownerKind`" — the B4 defect verbatim. Story 7 line 29 prescribes the corrected wording: "every input carries `now`, and every input that **writes** an owner carries `ownerKind`" — those are `acquire`, `renew` and `release`; `ReadLeaseInput`, `AssertHeldInput` and `ExpireLeasesOfOwnerInput` carry `now` only.
- Fresh probe this turn: `scripts/lane-check.sh software-engineer .agent/plan/epics/110-scheduler-leases-and-the-general-worker.md` → `lane violation: ... (the plan tree is locked)`, exit 1. No role may edit the plan tree, no test is writable for a wording change, and no lane-denied path will be opened to the software-engineer.
- Action required (human): apply the one-sentence correction at `:73` per option (a) of the Story-18 decision, then re-dispatch for the review re-run. Every code-level review finding is now green: B1 fixed and confirmed; B2, B3 and B5 stand recorded as action:NO for the human's review pass.

END: TEST-ENGINEER

## HUMAN — 018-claim-and-lease · review findings B2, B3, B4, B5 · CLOSED

**Route taken.** Three of the four are plan-tree edits, denied to every role by `scripts/lane-check.sh`; the plan owner applied them directly, the Story-18 precedent. B3 is a test-tree edit and was applied beside them, because its fix is a helper seam and not a production change. `scripts/lane-check.sh` was not amended and no lane-denied path was handed to a subagent. B4 rode with B5: both defects sit in one sentence of `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:73`, and one edit closes both.

### B2 — refusal precedence · resolved in favour of Story 5 · Story 17 amended

**The conflict, stated exactly.** Story 5 (`05-lease-hierarchy.md:77-80`) is normative on two counts: the admitted relation set per `targetKind`, and the selection order when more than one lease refuses — relation precedence first in `leaseRelations` order (`self`, `ancestor`, `descendant`, `sibling`), identity by `Buffer.compare` second. Story 17 (`17-composition-root.md:119-120`) named `sibling` for step 5 and `descendant` for step 6. Both are unreachable under Story 5.

- Step 5, the sibling task claim. Two live leases refuse it: the objective, held by the first harness through the ancestor start cascade, at relation `ancestor`; and the first task at relation `sibling`. `ancestor` precedes `sibling`, so the refusal names the objective at `ancestor`. `sibling` is reachable only when no ancestor lease exists, which the cascade of story eleven makes impossible for a claimed task.
- Step 6, the objective claim. Two live leases refuse it: the objective itself at `self`, and the first task at `descendant`. `self` precedes `descendant`, so the refusal names the objective at `self`. Story 17 step 7 depends on that same objective lease existing, so the two lines contradicted each other inside one story.

**Decision.** Story 5's precedence stands unchanged. It is the story that owns the rule, it states the reason for it ("`self` is the refusal that names why the claim cannot proceed"), and `src/domain/lease-hierarchy.ts` already implements it exactly — `refusesAt` admits `self`, `ancestor` and `sibling` for a task and `self` and `descendant` for an objective, and `liveLeaseRefusal` walks `leaseRelations` in order and breaks a tie by `Buffer.compare` over `subjectId`. Story 17's two labels were the authoring defect.

**Edit applied.** One file, one hunk: `.agent/plan/stories/018-claim-and-lease/17-composition-root.md:119-120`. Step 5 now requires `details.subject` of the objective and `details.relation` of `ancestor`; step 6 requires `details.subject` of the objective and `details.relation` of `self`. Each line names both refusing leases and the precedence that selects between them, so the expected value is derivable from Story 5 rather than asserted bare.

**No code changed.** `src/domain/lease-hierarchy.ts`, `src/commands/node/claim-node.ts` and the two daemon assertions at `src/main.claim.test.ts:421` and `:437` were already aligned with Story 5. The reviewer read the daemon test as the deviation; it is the story that deviated.

### B3 — the test-import boundary · a helper seam

**The violation.** `src/main.claim.test.ts:16-19` imported `SqliteStorage`, `SqliteLease`, `migrations` and `SystemClock` — four implementations across three capabilities, none of which that test covers. `AGENTS.md:49` limits a test to its module under test, `domain/`, service interfaces, `test/helpers/` and `node:` builtins, and `AGENTS.md:113` adds that it reaches an implementation only in the capability it covers. `eslint.config.js:388-407` relaxes `boundaries/dependencies` for a test to everything except the composition root, so lint never caught it; the rule is prose and the reviewer applied it correctly.

**The seam defined.** `test/helpers/**` is the declared place for a real-implementation fixture, and the tree already does exactly this: `test/helpers/database.ts` constructs `SqliteStorage` over `migrations`, `test/helpers/recovery.ts` constructs `SqliteEventLog`, `test/helpers/plan.ts` constructs `SqlitePlanStore` and `SqliteBlobStore`. The same-database acquisition proof of Story 17 step 7 belongs there and not in the test.

**Edit applied.**

- `test/helpers/lease.ts` (edited) — gains `ForeignLeaseAcquisitionInput` and `acquireLeaseOnDatabaseFile(input)`, beside the existing `createLeaseFake`. It opens the named database file with the real `SqliteStorage` over the real `migrations`, runs one real `SqliteLease.acquire` inside one `storage.transact`, and closes the handle in a `finally`. It throws the real `LeaseError` and returns the real `AcquireLeaseResult`, so the caller loses no fidelity. The clock is `createMockClock({ start: input.now })`, not `SystemClock`: the helper opens an already-migrated file and reads no wall clock.
- `src/main.claim.test.ts` (edited) — the four implementation imports are replaced by one import of `acquireLeaseOnDatabaseFile` from `../test/helpers/lease.ts`. The test now imports only its module under test, `test/helpers/`, `node:` builtins, `cli/client.ts` and the `LeaseError` **type** from the `services/lease` interface. That is the `AGENTS.md:49` row exactly.
- The proof itself is unchanged in meaning and gained determinism: `now` is `SEED_AT` rather than `Date.now()`, so the assertion carries no wall-clock dependency (`AGENTS.md:110`). The daemon minted its lease with `expiresAt` far above `SEED_AT`, so the row is live at that instant and the refusal is the same one Story 17 step 7 requires.

**No production file changed.** The seam is a test-tree seam; `src/services/lease/sqlite.ts` and `src/services/storage/sqlite.ts` are byte-identical.

### B5 with B4 — the `LeaseError` union, and the lease-input wording

**B5, the union.** Three codes, not two. `src/services/lease/index.ts:75` declares `LeaseErrorCode` as `not-implemented | lease-held | lease-fenced`, and Story 7 (`07-services-lease.md`) requires it verbatim: "`LeaseErrorCode` at `:36` keeps its three members". `not-implemented` is load-bearing and cannot be dropped: `src/services/lease/not-implemented.ts` throws it from all seven methods, and `src/domain/layout.test.ts:144` asserts that file exists. EPIC 110's "exactly the codes `lease-held` and `lease-fenced`" was a stale reading of the pre-EPIC-018 surface. EPIC 110 is the consumer and Story 7 is the owner, so EPIC 110 is corrected.

**B4, the wording.** `ReadLeaseInput`, `AssertHeldInput` and `ExpireLeasesOfOwnerInput` carry `now` only; `ownerKind` rides on `acquire`, `renew` and `release`, which are the three inputs that write an owner. Story 7 already prescribes the corrected sentence.

**Edit applied.** One file, one sentence: `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md:73`. "every input carries `now` and `ownerKind`" becomes "every input carries `now` and every input that **writes** an owner carries `ownerKind` — those are `acquire`, `renew` and `release`", and "`LeaseError` holds exactly the codes `lease-held` and `lease-fenced`" becomes "`LeaseError` holds exactly the codes `not-implemented`, `lease-held` and `lease-fenced`". Every other clause of the published-surface list is unchanged, including the seven method names, `AcquireLeaseResult`, `LeaseRecord.ownerKind`, the `owner` member of `AcquireLeaseInput` and `ReleaseLeaseInput`, and `liveLeaseRefusal` beside `leaseRelations`.

**Verify.**

- `npm run verify` — exit 0: typecheck clean, `npm test` 4367 pass / 0 fail / 0 cancelled, `eslint .` clean, final line `kanthord: verify db status ok`. Unchanged from the count before these edits: no test was added or removed, only one test's imports and one test's clock source changed.
- Proof: the EPIC `Proof:` command over the 30 named paths — exit 0, 613 pass / 0 fail across 44 suites, and it printed `PASS EPIC-018`. The count is 613 rather than the 612 of the previous turn because the B1 regression test of this cycle is inside the named set.
- `node --test src/main.claim.test.ts` alone — exit 0, 12 pass / 0 fail. The two renamed-expectation tests ("a second actor's claim on the sibling task is refused lease-held on the objective" with `relation` of `ancestor`, and "a second actor's claim on the objective is refused lease-held on the objective itself" with `relation` of `self`) are green and now match Story 17 as amended.
- `eslint src/main.claim.test.ts test/helpers/lease.ts` — exit 0.
- `git diff --name-only` over the four files: `.agent/plan/epics/110-scheduler-leases-and-the-general-worker.md`, `.agent/plan/stories/018-claim-and-lease/17-composition-root.md`, `src/main.claim.test.ts`, `test/helpers/lease.ts`. No other path under `src/`, `test/`, `docs/` or `.agent/` was touched.

**Finding state.**

- B1 - status:FIXED - action:YES - sweep closes completed attempts - closed in the prior SOFTWARE-ENGINEER turn and confirmed green.
- B2 - status:FIXED - action:YES - refusal-precedence conflict - Story 5's precedence is normative; Story 17 amended to `ancestor` and `self`; no code changed.
- B3 - status:FIXED - action:YES - test-import boundary - `acquireLeaseOnDatabaseFile` added to `test/helpers/lease.ts`; the test drops four implementation imports.
- B4 - status:FIXED - action:YES - lease-input wording - EPIC 110 `:73` now carries Story 7's corrected sentence.
- B5 - status:FIXED - action:YES - `LeaseError` code union - three codes; EPIC 110 `:73` aligned to `src/services/lease/index.ts:75` and Story 7.

**Epic state.** Stories 1–18 complete. Every AUTO_REVIEW finding is closed. `npm run verify` green end-to-end and the Proof prints `PASS EPIC-018`. EPIC 018 is ready for the human review pass.

END: HUMAN
