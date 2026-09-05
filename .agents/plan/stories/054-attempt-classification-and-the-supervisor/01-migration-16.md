# Story 1 — Migration 16

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: EPIC 053.1 Story 10 (`10-the-report-route-carries-a-verdict`), for the `"053.1"` entry in
`authoredEpics` this story inserts after; EPIC 051.3 Story 1 (`01-migration-14`) and every other
authored migration of the 051 and 052 families, for versions `13` to `15`.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**Every column is added in place, and this migration rebuilds nothing.** `ALTER TABLE ... ADD COLUMN`
accepts a named CHECK on the added column, and the CHECK expression may name another column of the
table, so both constraints this migration needs attach to an added column with no rebuild. That was
verified against `node:sqlite` before this story was written, on the real pre-migration `attempt`
shape: both `CONSTRAINT attempt_termination_value` and `CONSTRAINT attempt_termination_outcome`
attach, all three refusals fire by constraint name, and a `failed` attempt carrying `'semantic'`
commits.

**A rebuild here would be a defect, not a style choice, and the reason is a foreign key.**
EPIC 051.3 Story 1 (`01-migration-14`) creates
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:27` —
`attempt_id_run_id`, a unique index on `attempt (id, run_id)`, because
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:74` — `REFERENCES
attempt(id, run_id)` declares a composite foreign key from `checkpoint` onto it. An index belongs to
its table: a rename-old, create-new, drop-old rebuild carries `attempt_id_run_id` onto `attempt_old`
and drops it, and a `CREATE TABLE attempt` that does not recreate it leaves every `checkpoint` insert
failing on a foreign-key mismatch. `src/services/storage/migration-0012-run-model.ts:14` — `DROP
INDEX` and `:35` — `CREATE UNIQUE INDEX` show the shipped rebuild paying that cost for
`run_one_active`. `ADD COLUMN` does not touch an index at all, so it avoids the cost rather than
paying it. Case 7 pins that, so a later author who reaches for a rebuild fails a case.

**Versions `13`, `14` and `15` are not this story's to create, and `15` belongs to no authored
story.** `src/services/storage/migrations.ts:15` — `migrations` tops out at
`src/services/storage/migration-0012-run-model.ts:4` — `version` today. Version `13` is EPIC 051
Story 1 (`01-migration-13`) and version `14` is EPIC 051.3 Story 1 (`01-migration-14`); a grep of the
plan tree finds no owner for `15`. `src/services/storage/sqlite.ts:181` — `validateMigrations` admits
any unique positive version, so `16` applies beside `12` with no gap check — and that is exactly the
hazard the epic's Decisions name: an epic that later claims `15` would apply it **after** `16` on an
upgraded database and **before** `16` on a fresh one. This epic keeps the number `16` the epic
declares, and the unowned `15` is reported to the human rather than closed here.

## Change

### 1 — `src/services/storage/migration-0016-termination.ts` — the migration

**Create `src/services/storage/migration-0016-termination.ts`**. It declares **no** `rebuild` flag,
because it renames nothing:

```ts
import type { Migration } from "./migration.ts";

export const migration0016Termination: Migration = {
  version: 16,
  name: "0016-termination",
  statements: [
    `ALTER TABLE node ADD COLUMN ambiguous_used INTEGER`,
    `ALTER TABLE attempt ADD COLUMN caller TEXT`,
    `ALTER TABLE attempt ADD COLUMN subject TEXT`,
    `ALTER TABLE attempt ADD COLUMN termination TEXT
       CONSTRAINT attempt_termination_value CHECK (termination IS NULL OR termination IN
         ('semantic', 'infrastructure', 'ambiguous'))
       CONSTRAINT attempt_termination_outcome CHECK (termination IS NULL OR
         (outcome IS NOT NULL AND outcome <> 'accepted'))`,
  ],
};
```

**`termination` is added last, and both CHECKs hang off it.** `attempt_termination_outcome` names
`outcome`, which the pre-migration table already holds, so the order of the three `attempt` statements
is free — but attaching both constraints to the one column they govern keeps them findable, and
attaching the cross-column one to `caller` or `subject` would name a constraint after a column it says
nothing about.

**Both CHECKs are named, and the four shipped ones stay unnamed.** SQLite reports
`CHECK constraint failed: attempt_termination_value` for a named constraint and
`CHECK constraint failed: attempt` for an unnamed one, so a name is what makes the epic's gate rows 2
and 3 — "refused by the named CHECK" — assertable by value instead of by table. Renaming the four
shipped CHECKs is out of scope: no case reads their message today.

**`attempt_termination_outcome` is `termination IS NULL OR (outcome IS NOT NULL AND outcome <>
'accepted')`.** The epic's Decisions state why the shorter `outcome <> 'accepted' OR termination IS
NULL` is wrong: with `outcome` null that expression evaluates to SQL `NULL`, SQLite admits a row whose
CHECK is not false, and an **open** attempt could then carry a termination. Do not simplify it. Case 4
is the row that form would admit.

**No column carries a `DEFAULT`, and no statement backfills.** `ALTER TABLE ADD COLUMN` with no
default writes `NULL` into every existing row, which is the epic's stated decision and what case 6
asserts. `ambiguous_used` takes no `DEFAULT 0` either: a null counter and a zero counter classify
identically, and Story 4 (`04-the-node-ambiguous-counter`) carries the `COALESCE` that makes them so.

**`ADD COLUMN` is the first in this tree, and that is deliberate.**
`grep -rn "ADD COLUMN" src/services/storage/` finds nothing today, and every shipped schema change is
a rebuild — but each of those changed or dropped an existing column, tightened an existing CHECK, or
introduced a `NOT NULL`, none of which `ADD COLUMN` can do. This migration only appends nullable
columns, so it is the first change the cheaper statement fits.

### 2 — `src/services/storage/migrations.ts` — register it

**Add an import and a list entry to `src/services/storage/migrations.ts`.** The import goes after
`src/services/storage/migrations.ts:13` — `migration0012RunModel`, and the entry after
`src/services/storage/migrations.ts:27` — `migration0012RunModel`, both last. An epic of the 051,
052 or 053 family that lands versions `13` to `15` inserts before this entry;
`src/services/storage/sqlite.ts:70` — `sort` orders the application by version, so list position is
readability and never ordering.

### 3 — `scripts/epic-sequence-range.ts` — insert `"054"` into `authoredEpics`

**Insert `"054"` into `scripts/epic-sequence-range.ts:1`** — `authoredEpics`, keeping the array in
sequence order: after `"053.1"` and before `"054.1"`. **Read the array before you edit it.** At the
time this story was written it ended `"052.2"`, `"054.2"` — `"053"`, `"053.1"`, `"054"` and `"054.1"`
were all absent while `"054.2"` was present, so the array was already out of sequence order. Insert
this epic's entry in sequence order and leave every other entry alone; a reordering of entries this
epic does not own belongs to the human. Do **not** touch
`scripts/epic-sequence-range.ts:20` — `shippedEpics`; Story 10
(`10-the-proposal-records-classification`) appends that.

**Move the pinned literal with it.** `test/sequence/conformance.test.ts:255` — `authoredEpics` holds
the array by value, and `test/sequence/conformance.test.ts:274` — `shippedEpics` holds the other.
`test/sequence/conformance.test.ts:83` — `shipped` scopes the scenario requirement to `shippedEpics`,
so `"054"` in `authoredEpics` alone makes this epic's stories parse-checked by
`scripts/verify-epic-sequence.ts` and requires no scenario file. This epic declares no diagram, so
that stays true after Story 10 too.

## Constraints

- **Do not edit the SQL fence of `docs/proposal/database/attempt.md`, and this is a deferral rather
  than a rule.** `docs/proposal/database/README.md:7` — `CREATE TABLE` says every table file holds its
  `CREATE TABLE`, so the fence is **meant** to be current and a stale one is documentation debt.
  Updating it here turns a shipped assertion red:
  `src/services/storage/migration-0007-external-execution.test.ts:1159` — `proposalStatements` pins
  migration `7`'s own `CREATE TABLE attempt` against that fence, and repairing that assertion means
  moving the parity claim to the latest migration of the table — the pattern
  `src/services/storage/migration-0009-one-branch.test.ts:272` — `proposalStatements` uses for
  `repository`, comparing the **live** schema rather than one migration's text. That repair is not
  this epic's, and the debt is not new:
  `docs/proposal/database/run.md:10` — `parent_run_id` still describes the pre-migration-`12` `run`
  table and nothing asserts it. The three added columns are stated by this migration and by Story 10's
  `docs/proposal/phase-2/attempts-and-classification.md`, and the fence debt is recorded with its
  repair and its trigger at `.agents/plan/pending/proposal-database-fences.md`.
  `test/helpers/proposal.ts:15` — `sqlFence` reads the fence alone, so the **prose** of that file is
  outside the pin and Story 10 (`10-the-proposal-records-classification`) does edit it.
- **Do not edit `docs/proposal/database/node.md`.** Its fence is already three columns behind
  migration `11`, and `docs/proposal/database/node.md:42` — `attempt counter` stays true:
  `ambiguous_used` counts ambiguous terminations, and the attempt counter is still
  `MAX(attempt_no)` of the run.
- **The migration renames no table, drops no table and declares no `rebuild` flag.** A future author
  who converts it to a rebuild must recreate
  `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:27` —
  `attempt_id_run_id`; case 7 is what fails if they do not.
  `src/services/storage/sqlite.ts:81` — `runInTransaction` wraps every statement of one migration in
  one transaction, so the four statements commit together or not at all.
- Add no index. Neither `attempt.caller`, `attempt.subject` nor `node.ambiguous_used` has a read
  predicate in this epic.
- SQLite appends an added column before the table-level constraint list, so the live `attempt` DDL
  reads `... ended_at INTEGER, caller TEXT, subject TEXT, termination TEXT CONSTRAINT ..., UNIQUE
(run_id, attempt_no), CHECK ...`. `src/services/execution/sqlite.ts:25` — `ATTEMPT_COLUMNS` names
  its columns explicitly and never selects a star, so column position is not load-bearing for it.

## Verify

```
node --test src/services/storage/migration-0016-termination.test.ts test/sequence/conformance.test.ts
```

Add `src/services/storage/migration-0016-termination.test.ts`, following
`src/services/storage/migration-0011-deliverable.test.ts`, whose `PRAGMA table_info` read is at
`src/services/storage/migration-0011-deliverable.test.ts:102` and whose null-carry assertions are at
`:122`. Use `createStorageAtVersion` at `test/helpers/database.ts:50` to build the pre-migration
database and `createTemporaryDatabase` at `test/helpers/database.ts:14` under it. Seed rows with
`seedRegistry` at `test/helpers/rows.ts:21`, `seedGraph` at `test/helpers/rows.ts:102`, `seedRunRow`
at `test/helpers/rows.ts:759` and `seedAttemptRow` at `test/helpers/rows.ts:789`. **None of those
helpers changes**: each names its columns explicitly and the added columns default null.

Add, each as a separate `it`:

1. `"migration 16 leaves every added column nullable"` — read `PRAGMA table_info(attempt)` and
   `PRAGMA table_info(node)` on a fully migrated database, and assert for each of `termination`,
   `caller`, `subject` and `ambiguous_used` that the row exists, that `notnull` is `0` and that
   `dflt_value` is `null`. Assert by value on all four, not by presence. This is the epic's gate
   row 1.

2. `"an accepted attempt carrying a termination is refused by the named CHECK"` —
   `assert.throws` around an `UPDATE attempt SET outcome = 'accepted', termination = 'semantic',
ended_at = ?` over a seeded open attempt, and assert the error message matches
   `/CHECK constraint failed: attempt_termination_outcome/`. This is the epic's gate row 2.

3. `"a cancelled attempt carrying no termination is accepted"` — the same `UPDATE` with
   `outcome = 'cancelled'` and no `termination` commits, and the row reads back
   `outcome = 'cancelled'`, `termination = null`. This is the control for case 2, and it is what
   proves `attempt_termination_outcome` is not a null-equivalence rule. This is the epic's gate
   row 2.

4. `"an open attempt carrying a termination is refused by the named CHECK"` —
   `assert.throws` around `UPDATE attempt SET termination = 'ambiguous' WHERE id = ?` on an attempt
   whose `outcome` is null, asserting `/CHECK constraint failed: attempt_termination_outcome/`. This
   is the row the `outcome <> 'accepted' OR termination IS NULL` form would admit. This is the epic's
   gate row 3.

5. `"a termination outside the three values is refused by the named CHECK"` — `assert.throws` around
   `UPDATE attempt SET outcome = 'failed', termination = 'flaky', ended_at = ?`, asserting
   `/CHECK constraint failed: attempt_termination_value/`. The control is the same statement with
   `'semantic'`, `'infrastructure'` and `'ambiguous'` in turn, each of which commits — three
   sub-cases asserted by reading the stored value back.

6. `"every pre-existing attempt and node row survives with the added columns null"` — build with
   `createStorageAtVersion(15)`, seed one `node` row through `seedGraph` and one closed `attempt` row
   through `seedAttemptRow`, snapshot both with `SELECT *` into a sorted key-value object, run
   `storage.migrate()` on the same file with the full `migrations` list, snapshot again, and assert
   the second object deep-equals the first plus exactly `{ termination: null, caller: null,
subject: null }` on the attempt and `{ ambiguous_used: null }` on the node. **`15` and not `12`**:
   `test/helpers/database.ts:50` — `createStorageAtVersion` filters by `version <= n`, so the case
   keeps its meaning when EPIC 051 and EPIC 051.3 add versions `13` and `14`. This is the epic's gate
   row 4.

7. `"the attempt composite key and its checkpoint foreign key survive migration 16"` — on a fully
   migrated database, assert
   `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'attempt_id_run_id'` returns a row,
   assert `PRAGMA foreign_key_check` returns no row, and **insert a real `checkpoint` row** naming a
   seeded `(attempt_id, run_id)` pair and assert it commits. The control is the same insert naming a
   `(attempt_id, run_id)` pair no attempt row carries, which must be refused with a foreign-key error.
   A rebuild that dropped `attempt_id_run_id` fails the insert with a foreign-key mismatch, and an
   index assertion alone would not catch a rebuild that recreated the index with the columns
   transposed. **Skip this case, and only this case, while EPIC 051.3's migration `14` is absent** —
   an implementing agent that finds no `checkpoint` table reports the gap and does not invent one.

8. `"an agent_invocation row still resolves its attempt"` — seed an `agent_invocation` row at
   version `15` against the seeded attempt id, migrate, and assert the join
   `SELECT a.id FROM agent_invocation i JOIN attempt a ON a.id = i.attempt_id` returns that attempt
   id. `src/services/storage/migration-0003-execution-and-journal.ts:63` — `REFERENCES attempt(id)`
   is the reference this asserts survives. `ADD COLUMN` cannot break it; the case exists so a
   conversion to a rebuild has to keep it passing.

9. `"the migration list declares version 16 once, with no rebuild and no higher version"` — assert
   `migrations.filter((m) => m.version === 16).length` is `1`, that the entry's `name` is
   `"0016-termination"`, that its `rebuild` is `undefined`, and that
   `Math.max(...migrations.map((m) => m.version))` is `16`. Asserting `rebuild` is `undefined` is what
   states the design as a check: a rebuild reintroduces the `attempt_id_run_id` hazard case 7 guards.

10. `"054 follows 053.1 in authoredEpics"` — update the pinned literal at
    `test/sequence/conformance.test.ts:255` — `authoredEpics` to hold `"054"` after `"053.1"`, and
    assert the three existing assertions of that `it` still pass. `shippedEpics` is untouched here.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/storage/migration-0016-termination.test.ts` in
`PASS EPIC-054`.
