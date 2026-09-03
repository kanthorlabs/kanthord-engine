# Story 1 — Migration 14

Epic: `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md`
Depends on: EPIC 051 Story 1 (`01-migration-13`), which takes version `13` and creates `workspace_branch`. EPIC 050.1 Story 1 and EPIC 050 own migration `12`, which this migration reads through the `run` and `attempt` tables.
Kind: story-foundation

## Change

**`src/services/storage/migration-0014-checkpoint.ts` — add the migration at version `14`.** It is
additive. It creates one index, one table and one trigger, in that order, and it declares no
`rebuild` flag.

### 1 — the module

Copy the module shape of `src/services/storage/migration-0007-external-execution.ts:4` — `version`:
one exported object literal with `version`, `name` and `statements`, each statement a separate array
member with no trailing semicolon and no `PRAGMA`. The export is `migration0014Checkpoint`, the name
is `"0014-checkpoint"`.

Do **not** set `rebuild`. `src/services/storage/migration.ts:5` — `rebuild` types it `?: true`, and
`src/services/storage/sqlite.ts:77` — `foreign_keys` turns the foreign-key pragma off only for a
migration that declares it. No shipped table is rebuilt here.

### 2 — the unique index, first

```
CREATE UNIQUE INDEX attempt_id_run_id ON attempt (id, run_id)
```

It is the first statement. SQLite accepts a composite foreign key only against a PRIMARY KEY or a
UNIQUE index on the parent columns. `src/services/storage/migration-0007-external-execution.ts:34` —
`attempt` holds `id TEXT PRIMARY KEY` and
`src/services/storage/migration-0007-external-execution.ts:47` — `UNIQUE` on `(run_id, attempt_no)`,
and no key on `(id, run_id)`. `id` is already the primary key, so the pair is unique for every row
and the index constrains nothing new; it exists to satisfy the reference.

**The defect it prevents does not surface at DDL.** `CREATE TABLE checkpoint` succeeds without it,
and the first `INSERT` fails with `foreign key mismatch - "checkpoint" referencing "attempt"`,
because `src/services/storage/connection.ts:8` — `foreign_keys` sets the pragma on at every open.

### 3 — the table

```
CREATE TABLE checkpoint (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('execution', 'structural', 'review')),
  node_id        TEXT NOT NULL REFERENCES node(id),
  run_id         TEXT NOT NULL REFERENCES run(id),
  attempt_id     TEXT NOT NULL,
  fence          INTEGER NOT NULL,
  caller         TEXT,
  subject        TEXT,
  created_at     INTEGER NOT NULL,
  repository_id  TEXT REFERENCES repository(id),
  base_oid       TEXT,
  accepted_oid   TEXT,
  landed_oid     TEXT,
  graph_revision TEXT REFERENCES plan_revision(id),
  patch_blob     TEXT REFERENCES blob(hash),
  verdict        TEXT CHECK (verdict IS NULL OR verdict IN ('accept', 'reject')),
  judged_checkpoint_id TEXT REFERENCES checkpoint(id),
  judged_oid     TEXT,
  reason_blob    TEXT REFERENCES blob(hash),
  CONSTRAINT checkpoint_execution_accepted_oid
    CHECK ((kind = 'execution') = (accepted_oid IS NOT NULL)),
  CONSTRAINT checkpoint_execution_repository
    CHECK ((kind = 'execution') = (repository_id IS NOT NULL)),
  CONSTRAINT checkpoint_structural_patch
    CHECK ((kind = 'structural') = (patch_blob IS NOT NULL)),
  CONSTRAINT checkpoint_review_verdict
    CHECK ((kind = 'review') = (verdict IS NOT NULL)),
  CONSTRAINT checkpoint_review_judged
    CHECK ((kind = 'review') = (judged_checkpoint_id IS NOT NULL)),
  FOREIGN KEY (attempt_id, run_id) REFERENCES attempt(id, run_id)
) STRICT
```

- **`caller` and `subject` are nullable, and they stay nullable.** Neither concept has a source yet:
  `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:28` — `attempt.caller` adds `attempt.caller` and
  `attempt.subject` nullable in its own migration, and `:13` owns the rule that derives both from
  authenticated state. EPIC 057 tightens both.
- **The review group is complete here, and EPIC 053 adds no column.** The epic's Goal says migration
  `14` creates the whole `checkpoint` table, and its Decisions require a CHECK "of the same shape for
  the review group"; a review CHECK needs review columns. The column set is the one
  `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md:29` — `every column is stated` enumerates
  — `verdict`, `judged_oid`, `reason_blob` and `judged_checkpoint_id` — so nothing here is invented. **EPIC 053 becomes writer-only**: it
  gains the review acceptance path and adds no migration column, which is also what spares
  `checkpoint` a later rebuild, because SQLite cannot widen a CHECK in place.
- **Two CHECKs bind the review group, not one.** `verdict` alone would admit a `kind = 'execution'`
  row carrying `judged_checkpoint_id`, and a review row carrying neither. `judged_oid` and
  `reason_blob` stay unconstrained on purpose: `worker.md` section 8 makes the attestation's
  repository-qualified commit reachable through `judged_checkpoint_id`, and the reason is optional
  evidence.
- **Every CHECK is named.** SQLite reports a named constraint as
  `CHECK constraint failed: <name>`, so a test asserts the exact clause that fired rather than a
  generic message. EPIC 053 cites `checkpoint_review_verdict` and `checkpoint_review_judged` in its
  own gate, and it creates neither.
- **`judged_checkpoint_id` is a self-reference**, `TEXT REFERENCES checkpoint(id)`, which SQLite
  accepts inside the same `CREATE TABLE`.
- `attempt_id` carries no single-column `REFERENCES`, because the composite `FOREIGN KEY` clause is
  the reference.

### 4 — the `workspace_branch` delete trigger

```
CREATE TRIGGER workspace_branch_checkpoint_guard BEFORE DELETE ON workspace_branch BEGIN
  SELECT RAISE(ABORT, 'a workspace_branch row named by a checkpoint cannot be deleted')
  WHERE EXISTS (
    SELECT 1 FROM checkpoint c
    JOIN node n ON n.id = c.node_id
    WHERE c.node_id = OLD.node_id OR n.parent_id = OLD.node_id
  );
END
```

EPIC 051's Decisions place this trigger here, because a trigger naming an absent table is not
creatable and `checkpoint` does not exist before this migration.

`workspace_branch.node_id` is the **objective**, and `checkpoint.node_id` is the node that ran, which
is the objective itself for an atomic objective and a child task otherwise. The predicate therefore
tests both, and `src/services/storage/migration-0002-graph-and-plan.ts:33` — `CHECK` is what makes an
objective the only kind carrying a repository, so no deeper level exists to walk.

`src/services/storage/migration-0009-one-branch.ts:8` — `TRIGGER` is the only trigger in the shipped
migration set and it fixes the syntax convention: the `BEGIN`/`END` body sits inside one template
literal, the inner `SELECT RAISE(...)` carries its `;`, and the statement carries none after `END`.

### 5 — the registration

`src/services/storage/migrations.ts:27` — `migration0012RunModel` is the last entry today. Import
`migration0014Checkpoint` and append it after EPIC 051's `migration0013WorkspaceBranch`.

## Constraints

- The unique index statement comes before `CREATE TABLE checkpoint`. Reversed, the table still
  creates and the first insert fails at run time.
- No `rebuild` flag, no `PRAGMA` statement, no `ALTER TABLE`, no `DROP`.
- `caller` and `subject` stay nullable. Do not write a placeholder value and do not make either
  `NOT NULL`.
- Do not add the review columns. EPIC 053 owns them.
- Do not change any shipped table, index or trigger.

## Verify

```
node --test src/services/storage/migration-0014-checkpoint.test.ts src/services/storage/schema-parity.test.ts
```

Add `src/services/storage/migration-0014-checkpoint.test.ts`, modelled on
`src/services/storage/migration-0007-external-execution.test.ts:1104` — `it` for the index assertion
and on its local helpers `normalize` and `assertRefused`. Build the database with
`test/helpers/database.ts:32` — `createMigratedStorage`, and the pre-migration state with
`test/helpers/database.ts:50` — `createStorageAtVersion` at version `13`. Seed the parent rows with
`test/helpers/rows.ts:21` — `seedRegistry` and `test/helpers/rows.ts:102` — `seedGraph`, then a run
row and an attempt row.

Add, each as a separate `it`:

1. `"an execution checkpoint inserts against a real migrated database"` — seed run `run_b` over task
   `task_a` and attempt `attempt_a` on that run, then insert a `kind = 'execution'` row with
   `repository_id: "repo_a"`, `base_oid`, `accepted_oid`, `landed_oid`, `fence: 1`, `caller: null`,
   `subject: null`. Assert the row count is `1`. **This is the control for the unique index**: drop
   `attempt_id_run_id` first in a second storage built from the same statements minus that one, and
   assert the same insert throws with a message holding `foreign key mismatch`.

2. `"a structural checkpoint and a review checkpoint each insert"` — one `kind = 'structural'` row
   with `patch_blob` set and every execution and review column null, and one `kind = 'review'` row
   with `verdict: 'accept'` and `judged_checkpoint_id` naming the execution row of case 1, every
   execution and structural column null. Assert both succeed, and assert the self-reference resolves
   by reading the row back.

3. `"each cross-kind column combination is refused"` — one case body holding ten `assertRefused`
   calls, two per CHECK, by refusal message. Each CHECK is a biconditional, so each is driven from
   both sides: an `execution` row with `accepted_oid` null and a `structural` row carrying
   `accepted_oid`; an `execution` row with `repository_id` null and a `review` row carrying
   `repository_id`; a `structural` row with `patch_blob` null and an `execution` row carrying
   `patch_blob`; a `review` row with `verdict` null and an `execution` row carrying `verdict`; a
   `review` row with `judged_checkpoint_id` null and a `structural` row carrying
   `judged_checkpoint_id`. Assert each throws a `SQLITE_CONSTRAINT` error naming the expected
   constraint — `checkpoint_execution_accepted_oid`, `checkpoint_execution_repository`,
   `checkpoint_structural_patch`, `checkpoint_review_verdict` or `checkpoint_review_judged` — and
   leaves the row count unchanged.

3b. `"the review verdict CHECK admits accept and reject and refuses anything else"` — insert one
review row per legal verdict and assert both succeed, then assert a third value is refused.

4. `"the composite attempt foreign key refuses an attempt of another run"` — seed a second run
   `run_a` and insert a checkpoint naming `attempt_id: "attempt_a"` with `run_id: "run_a"`. Assert
   the insert throws, and that the same row with `run_id: "run_b"` succeeds. The second half is the
   control.

5. `"a checkpoint inserts with caller and subject null"` — assert both read back `null` by value.

6. `"migration 14 rebuilds no table"` — read `PRAGMA foreign_keys` and `PRAGMA legacy_alter_table`
   before and after, asserting `1` and `0` in both readings, and assert the
   `SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name` dump of every table that
   exists at version `13` is deep-equal before and after.

7. `"the declared index survives into sqlite_master"` — read
   `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'attempt_id_run_id'` and
   `deepEqual` its `normalize`d text against the declared statement, following
   `src/services/storage/migration-0007-external-execution.test.ts:1104` — `it`.

8. `"the workspace_branch delete trigger refuses a delete while a checkpoint names the row"` — seed a
   `workspace_branch` row on `objective_a` and an execution checkpoint on task `task_a`, whose
   `parent_id` is `objective_a`. Assert `DELETE FROM workspace_branch WHERE node_id = 'objective_a'`
   throws with a message holding
   `a workspace_branch row named by a checkpoint cannot be deleted`, and that the row still exists.

9. `"the workspace_branch delete trigger permits a delete when no checkpoint names the row"` — the
   control for case 8: the same fixture with no checkpoint row. Assert the delete succeeds and the
   row count is `0`.

10. `"migration 14 is registered at version 14 with its name"` — assert
    `migration0014Checkpoint.version === 14`, `migration0014Checkpoint.name === "0014-checkpoint"`,
    `migration0014Checkpoint.rebuild === undefined`, and that `migrations` holds it exactly once at
    the last position.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/storage/migration-0014-checkpoint.test.ts` in
`PASS EPIC-051.3`.
