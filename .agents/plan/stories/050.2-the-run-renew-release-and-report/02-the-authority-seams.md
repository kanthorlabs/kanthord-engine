# Story 2 — The authority seams

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: EPIC 050 Story 2 (`02-the-run-row`), for `runRow`; EPIC 050.1 Story 3 (`03-the-claim-of-a-task`), for the `RunRecord` shape below and for migration `12`.
Kind: story-foundation

Two seam names the diagrams of Story 3 (`03-the-renew`) through Story 6 (`06-the-report-prelude`) draw
do not exist yet. This story declares them and implements them. It draws no path: declaring an
interface moves no call.

## Change

**`src/services/execution/index.ts` gains two methods** on the `Execution` interface at
`src/services/execution/index.ts:74` — `Execution`:

```ts
runById(transaction: Transaction, runId: string): RunRecord | null;

renewRun(
  transaction: Transaction,
  input: Readonly<{ runId: string; expiresAt: number }>,
): RunRecord;
```

Neither name exists today. `runById` and `renewRun` appear nowhere in `src/`, `test/` or `scripts/`.
The interface holds ten methods, and the nearest existing reads are
`src/services/execution/index.ts:76` — `activeRunOfNode` and `src/services/execution/index.ts:77` —
`latestRunOfNode`.

`assertRunAuthority` is pure, so the run row is read at the seam. **`runById` returns an ended run
rather than null**, because the authority function refuses it with `run-ended` and a null would
collapse that code into `run-not-found`. `activeRunOfNode` answers a different question — one node,
its active run — and cannot answer this one: its predicate is `WHERE node_id = ? AND state = 'active'`
at `src/services/execution/sqlite.ts:118` — `state`.

**`RunRecord` must already carry the authority fields when this story runs.** `RunRecord` at
`src/services/execution/index.ts:7` — `RunRecord` holds eleven fields, and the fence field is named
`src/services/execution/index.ts:13` — `leaseFence`. It carries no `fence`, no `expiresAt`, no
`worker` and no `maxLifetimeAt`, and `src/services/execution/index.ts:5` — `RunKind` is
`"objective" | "task"`.

The physical table matches that gap. The effective DDL is
`src/services/storage/migration-0007-external-execution.ts:12` — `CREATE TABLE run`, fourteen columns,
and it holds `src/services/storage/migration-0007-external-execution.ts:20` — `lease_fence` but no
`fence`, no `expires_at` and no `max_lifetime_at`. The highest shipped migration is
`src/services/storage/migration-0011-deliverable.ts:4` — `version`, so there is no migration `12`.

EPIC 050.1 Story 3 (`03-the-claim-of-a-task`) rewrites `openRun` against migration `12` and is the
first consumer, so it lands the new `RunRecord`, the new `RunKind` and the three new columns. If it
did not, this story lands them here before it adds the two methods, and the implementing agent
reports the gap rather than inventing the migration.

**`renewRun` writes `UPDATE run SET expires_at = ? WHERE id = ?` and touches no other column.** The
`min(now + runTtlMs, max_lifetime_at)` arithmetic belongs to the command, and the write belongs here,
because SQL lives in the execution implementation. Both methods select through
`src/services/execution/sqlite.ts:20` — `RUN_COLUMNS`, extended by EPIC 050.1 Story 3
(`03-the-claim-of-a-task`) with the three new columns.

## Constraints

- `renewRun` never writes `fence`, `state`, `ended_at` or `outcome`. The fence rises when a run ends.
- Both methods take the caller's `transaction` as the first parameter. Neither opens one.
- `runById` filters on `id` alone. It applies no state and no expiry predicate.
- Do not change `activeRunOfNode`. Story 5 (`05-the-release`) and Story 6 (`06-the-report-prelude`)
  stop calling it; `releaseObjective` keeps it at `src/commands/node/release-node.ts:240` —
  `activeRunOfNode`.

## Verify

```
node --test src/services/execution/sqlite.test.ts
```

Extend `src/services/execution/sqlite.test.ts`, suite name `"src/services/execution/sqlite.test"` at
`src/services/execution/sqlite.test.ts:145` — `describe`. Its helpers are
`src/services/execution/sqlite.test.ts:8` — `createMigratedStorage`,
`src/services/execution/sqlite.test.ts:9` — `createMockIdGenerator` and
`src/services/execution/sqlite.test.ts:11` — `fixtureIds`, and the local builder is
`src/services/execution/sqlite.test.ts:35` — `build`. The file uses real SQLite on a temporary file
and asserts raw rows; it imports no `databaseBytes`.

Add, each as a separate `it`:

1. `"runById returns an ended run rather than null"` — seed a run with `state: 'ended'`, then assert
   the returned record is not null and its `state` equals `"ended"`.
2. `"runById returns null for an unknown id"` — assert the result is `null` for `"run_zzz"`.
3. `"runById returns an expired run that is still active"` — seed `expires_at: NOW - 1` with
   `state: 'active'`, and assert the record is returned with `state` `"active"`. The expiry pass is
   the caller's, not this read's filter.
4. `"renewRun writes expires_at and leaves fence unchanged"` — seed `fence: 3` and
   `expires_at: NOW`, call `renewRun` with `expiresAt: NOW + 1000`, and assert both
   `expires_at === NOW + 1000` and `fence === 3` in the one case.
5. `"renewRun touches no other column"` — read the whole row before and after, and assert every
   column except `expires_at` is deep-equal. The control is case 4's `fence` assertion, which proves
   this comparison detects a changed column.
6. `"renewRun on an unknown run id raises run-not-found"` — assert an `ExecutionError` whose `code`
   is `"run-not-found"`, matching `src/services/execution/index.ts:61` — `ExecutionErrorCode`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` in `PASS EPIC-050.2`.
