# Story 1 — Migration 13

Epic: `.agents/plan/epics/051-the-workspace-branch.md`
Depends on: EPIC 050.1 Story 1 and EPIC 050, which own migration `12`. Nothing of this epic runs before it.
Kind: story-foundation

## Change

**`src/services/storage/migration-0013-workspace-branch.ts` — add the migration at version `13`.**
It creates `workspace_branch` and one trigger, and it rebuilds `git_operation` to widen the `intent`
CHECK with `cut`. It declares `rebuild: true`.

### 1 — the module

Copy the module shape of `src/services/storage/migration-0006-revision-origin.ts:3` —
`migration0006RevisionOrigin`: one exported object literal with `version`, `name`, `rebuild` and
`statements`, each statement a separate array member, no trailing semicolon and no `PRAGMA`. The
export is `migration0013WorkspaceBranch` and the name is `"0013-workspace-branch"`.

The export name is pinned outside this epic:
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:131` —
`migration0013WorkspaceBranch` appends migration `14` after it.

`src/services/storage/migration.ts:5` — `rebuild` types the flag `?: true`, so `rebuild: true` is the
only legal value and its absence is the no-rebuild state.

### 2 — the six statements, in this order

```
ALTER TABLE git_operation RENAME TO git_operation_old
```

```
CREATE TABLE git_operation (
  id                  TEXT PRIMARY KEY,
  repository_id       TEXT NOT NULL REFERENCES repository(id),
  intent              TEXT NOT NULL CHECK (intent IN ('merge', 'sync', 'publish', 'revert', 'cut')),
  node_id             TEXT REFERENCES node(id),
  run_id              TEXT REFERENCES run(id),
  candidate_id        TEXT REFERENCES candidate(id),
  lease_fence         INTEGER NOT NULL,
  ref                 TEXT NOT NULL,
  base_oid            TEXT NOT NULL,
  proposed_head_oid   TEXT NOT NULL,
  result_head_oid     TEXT,
  expected_remote_oid TEXT,
  state               TEXT NOT NULL CHECK (state IN ('open', 'complete', 'discarded')),
  outcome             TEXT,
  detail_blob         TEXT REFERENCES blob(hash),
  child_token         TEXT,
  completed_at        INTEGER
) STRICT
```

```
INSERT INTO git_operation (id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at) SELECT id, repository_id, intent, node_id, run_id, candidate_id, lease_fence, ref, base_oid, proposed_head_oid, result_head_oid, expected_remote_oid, state, outcome, detail_blob, child_token, completed_at FROM git_operation_old
```

```
DROP TABLE git_operation_old
```

```
CREATE TABLE workspace_branch (
  node_id    TEXT PRIMARY KEY REFERENCES node(id),
  origin_oid TEXT NOT NULL,
  head_oid   TEXT NOT NULL
) STRICT
```

```
CREATE TRIGGER workspace_branch_origin_immutable BEFORE UPDATE OF origin_oid ON workspace_branch BEGIN
  SELECT RAISE(ABORT, 'workspace_branch.origin_oid is immutable')
  WHERE NEW.origin_oid <> OLD.origin_oid;
END
```

- **The rebuild is the four-statement single-table form**, not the fourteen-statement form.
  `src/services/storage/migration-0006-revision-origin.ts:8` — `ALTER` is the recipe: rename, create,
  insert with an **explicit** column list on both sides, drop. No index and no trigger is recreated,
  because `git_operation` carries neither: every `CREATE INDEX` of the shipped migration set names
  `run`, `event`, `node`, `edge` or `provider_login`, and
  `src/services/storage/migration-0009-one-branch.ts:8` — `TRIGGER` is the only trigger and it is a
  TEMP trigger dropped inside its own migration.
- **The whole column list is copied verbatim from
  `src/services/storage/migration-0003-execution-and-journal.ts:127` — `git_operation`**, with one
  character changed: `src/services/storage/migration-0003-execution-and-journal.ts:130` — `intent`
  gains `'cut'` at the end of the literal list. Every other column, type, nullability, CHECK and
  foreign key is byte-identical.
- **`'cut'` is appended last**, not inserted, because case 12 asserts the SQL literal order equals
  `gitIntents` order and `test/helpers/schema.ts:45` — `deepEqual` compares the two as ordered lists.
- **The trigger fires on `BEFORE UPDATE OF origin_oid` and compares `NEW` against `OLD`.** A CHECK
  cannot see the old row, which is why the epic's Decisions make this a trigger. No shipped UPDATE
  trigger exists, so the syntax convention comes from
  `src/services/storage/migration-0009-one-branch.ts:8` — `TRIGGER`: the `BEGIN`/`END` body sits in
  one template literal, the inner `SELECT RAISE(...)` carries its `;`, and the statement carries none
  after `END`.
- **The comparison is `<>`, so an UPDATE that writes `origin_oid` to its current value is admitted.**
  `RAISE(ABORT, ...)` on every write of the column would refuse an idempotent rewrite that changes
  nothing, and case 3 carries both directions.
- **`workspace_branch` is created after the rebuild.** `src/services/storage/sqlite.ts:77` —
  `foreign_keys` turns the pragma off for the whole migration, so `REFERENCES node(id)` is not
  checked at creation time; the order is chosen so the file reads as one repair followed by one
  addition.

### 3 — the domain intent enum moves with the CHECK

`src/domain/git-operation.ts:7` — `gitIntents` gains `"cut"` as its fifth member, in the SQL literal
order. `src/services/git/index.ts:197` — `GitIntent` gains `| "cut"`.

Do **not** widen `src/services/git/index.ts:146` — `intent`. That inline union belongs to
`OutsideWriterInput`, which asks whether an outside writer moved a ref the daemon is about to write.
A `cut` creates a ref that does not exist, so it reaches no outside-writer check, and widening the
union would admit a call no code makes.

### 4 — the registration

`src/services/storage/migrations.ts:13` — `migration0012RunModel` is the last import and
`src/services/storage/migrations.ts:27` — `migration0012RunModel` is the last array member. Add one
import line after `:13` and one array member after `:27`.

### 5 — the red interval this story opens

`src/services/storage/schema-parity.test.ts:90` — `it` compares the migrated table set against
`Object.keys(rows).sort()`, and `src/domain/rows.ts:23` — `rows` does not yet carry
`workspace_branch`. That case is red from this story until Story 2
(`02-the-workspace-branch-record`) registers the row. The two stories dispatch back to back, and this
story's `## Verify` command therefore does not name `schema-parity.test.ts`.

## Constraints

- `rebuild: true`, and no `PRAGMA` statement inside `statements`.
  `src/services/storage/sqlite.ts:76` — `rebuild` owns both pragmas and
  `src/services/storage/sqlite.ts:99` — `finally` restores them on the success and the failure path.
  `src/services/storage/migration-0011-deliverable.ts:8` — `PRAGMA` inlines them and is the deviant;
  do not copy it.
- The `INSERT ... SELECT` names all seventeen columns on both sides. Never `INSERT INTO t SELECT *`.
- `DROP TABLE git_operation_old` is the last statement of the rebuild. A surviving `_old` table fails
  `src/services/storage/schema-parity.test.ts:90` — `it` once Story 2 lands.
- Do not touch the `workspace` table, its columns, its constraints or its rows.
- Do not register `workspace_branch` in `src/domain/rows.ts` here. Story 2 owns it.
- `origin_oid` and `head_oid` are `NOT NULL` from this migration. No later epic tightens them:
  `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` enumerates every column its
  migration tightens and names no workspace column.
- Add no `CREATE INDEX` on `workspace_branch`. `node_id` is the primary key, and every read is by
  that key.

## Verify

```
node --test src/services/storage/migration-0013-workspace-branch.test.ts src/domain/git-operation.test.ts
```

Add `src/services/storage/migration-0013-workspace-branch.test.ts`, modelled on
`src/services/storage/migration-0007-external-execution.test.ts:1104` — `it` and on its local helpers
`src/services/storage/migration-0007-external-execution.test.ts:46` — `normalize`,
`src/services/storage/migration-0007-external-execution.test.ts:261` — `tableSql` and
`src/services/storage/migration-0007-external-execution.test.ts:268` — `assertRefused`. Build the
pre-migration state with `test/helpers/database.ts:50` — `createStorageAtVersion` at version `12`,
seed with `test/helpers/rows.ts:21` — `seedRegistry`, `test/helpers/rows.ts:102` — `seedGraph` and
`test/helpers/rows.ts:878` — `seedGitOperationRow`, then reopen on the same path with the full
`migrations` array and migrate, following
`src/services/storage/migration-0007-external-execution.test.ts:242` — `buildMigratedThroughSeven`.

Add, each as a separate `it`:

1. `"migration 13 is registered once at version 13 with its name and rebuild true"` — assert
   `migration0013WorkspaceBranch.version === 13`,
   `migration0013WorkspaceBranch.name === "0013-workspace-branch"`,
   `migration0013WorkspaceBranch.rebuild === true`, and that `migrations` holds it exactly once at
   the last position.

2. `"the statements hold six members in the declared order and no pragma"` — `deepEqual` the leading
   keywords against
   `["ALTER", "CREATE", "INSERT", "DROP", "CREATE", "CREATE"]`, and assert
   `!statement.includes("PRAGMA")` for each, following
   `src/services/storage/migration-0007-external-execution.test.ts:405` — `it`.

3. `"workspace_branch refuses a null origin_oid and a null head_oid"` — two `assertRefused` calls,
   one per column, each asserting `errcode & 0xff === 19`. The control is a third insert of the full
   row `{ node_id: "objective_a", origin_oid: commit1, head_oid: commit1 }`, asserted to succeed and
   to leave a row count of `1`.

4. `"the origin_oid trigger refuses an UPDATE that changes it"` — seed the row of case 3, then assert
   `UPDATE workspace_branch SET origin_oid = ? WHERE node_id = 'objective_a'` with `commit2` throws
   with a message holding `workspace_branch.origin_oid is immutable`, and that `origin_oid` still
   reads `commit1`.

5. `"the origin_oid trigger admits a head_oid move and an idempotent origin rewrite"` — the control
   for case 4. Assert `UPDATE workspace_branch SET head_oid = ?` with `commit2` succeeds and reads
   back `commit2`, and that `UPDATE workspace_branch SET origin_oid = ?` with the **current**
   `commit1` succeeds and leaves `origin_oid` at `commit1`.

6. `"workspace_branch keys on node_id and references node"` — assert a second insert on
   `objective_a` throws, and that an insert naming `objective_missing` throws with a message holding
   `FOREIGN KEY`. `src/services/storage/connection.ts:8` — `foreign_keys` sets the pragma on at every
   open, so the reference is live outside the migration.

7. `"the shipped workspace table is unchanged by migration 13"` — capture
   `SELECT sql FROM sqlite_master WHERE name = 'workspace'`, `PRAGMA table_info(workspace)` and
   `SELECT * FROM workspace ORDER BY id` before and after the migration, and `deepEqual` all three
   pairs.

8. `"git_operation survives the rebuild whole"` — capture `PRAGMA table_info(git_operation)`,
   `SELECT * FROM git_operation ORDER BY id`, and the index and trigger lists
   `SELECT name FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name = 'git_operation'`
   before and after. `deepEqual` each pair, and assert the index and trigger lists are both `[]`
   in both readings. Assert
   `SELECT count(*) AS c FROM sqlite_master WHERE name LIKE '%\_old' ESCAPE '\'` reads `0`.

9. `"intent = 'cut' inserts and the four shipped intents still insert"` — five inserts, one per
   member of `gitIntents`, each asserted to succeed by row count. The control is a sixth insert with
   `intent = 'claim'`, asserted refused by `assertRefused`.

10. `"no child table REFERENCES clause moved"` — for each of `attempt`, `candidate`, `check_result`,
    `run`, `run_base` and `workspace`, assert `tableSql(storage, table)` holds no `_old`, following
    `src/services/storage/migration-0007-external-execution.test.ts:585` — `it`.

11. `"PRAGMA foreign_keys and legacy_alter_table are back to 1 and 0"` — read both after the
    migration and assert `foreign_keys === 1` and `legacy_alter_table === 0` by value, following
    `src/services/storage/migration-0007-external-execution.test.ts:490` — `it`. Assert
    `PRAGMA foreign_key_check` returns `[]`.

12. `"gitIntents and the git_operation intent CHECK agree, in order"` — call
    `test/helpers/schema.ts:26` — `assertClauseAgrees` with
    `(storage, "git_operation", "intent", gitIntents)`. The control is that reversing the local copy
    of `gitIntents` makes the same call throw, which is what proves the assertion sees order.

13. `"GitIntent admits cut"` — extend `src/domain/git-operation.test.ts` and assert
    `gitOperationRow.safeParse({ ...validRow, intent: "cut" }).success === true` and that
    `intent: "claim"` parses `false`.

14. `"OutsideWriterInput does not admit cut"` — assert `src/services/git/index.ts:146` — `intent`
    still lists four members, by reading the source file and matching the union text. This is the
    control for the constraint above, and its only oracle is absence, so the nearby forbidden case is
    a five-member union.

`pnpm run verify` exits 0 once Story 2 (`02-the-workspace-branch-record`) closes the red interval of
`## Change` step 5.

Proof: PASS line delivered — `src/services/storage/migration-0013-workspace-branch.test.ts` in
`PASS EPIC-051`.
