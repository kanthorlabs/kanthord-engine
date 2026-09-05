# Story 2 — The run's base home is one read

Epic: `.agents/plan/epics/051.5-the-targeted-post-expiry-candidate-cleanup.md`
Depends on: Story 1 (`01-the-expired-run-is-a-domain-type`), for nothing this story reads — it runs
after it only to keep one interface edit per dispatch.
Kind: story-foundation

## Change

**`src/services/execution/index.ts` — declare `runBaseHomes` and its row type.** Append the method
after `src/services/execution/index.ts:119` — `runDriversUnderObjective`, the last member of
`src/services/execution/index.ts:95` — `Execution`:

```ts
export type RunBaseHome = Readonly<{
  runId: string;
  homePath: string;
}>;
```

```ts
  runBaseHomes(
    transaction: Transaction,
    runIds: readonly string[],
  ): readonly RunBaseHome[];
```

It is **synchronous**, like every other member of the interface, and the transaction is the first
positional parameter. `RunBaseHome` sits beside `RunRecord` and `AttemptRecord` in the same file. The
capability owns the join because `execution` owns `run_base`: `repository_id` belongs to an objective
alone, and an `ExpiredRun.nodeId` is a task, so the node cannot answer it.

### `src/services/execution/sqlite.ts` — one join, one order

Add the method to `src/services/execution/sqlite.ts:92` — `SqliteExecution`, modelled on
`src/services/execution/sqlite.ts:328` — `runDriversUnderObjective`, the class's only other joining
method, and on `src/services/execution/sqlite.ts:175` — `activeRunsOfNodes`, its only other read over
a list:

```ts
  runBaseHomes(
    transaction: Transaction,
    runIds: readonly string[],
  ): readonly RunBaseHome[] {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => "?").join(", ");
    const rows = transaction.all(
      `SELECT rb.run_id, r.home_path
FROM run_base rb
JOIN repository r ON r.id = rb.repository_id
WHERE rb.run_id IN (${placeholders})
ORDER BY rb.run_id, rb.repository_id`,
      runIds,
    ) as readonly Readonly<{ run_id: string; home_path: string }>[];
    return rows.map((row) => ({
      runId: row.run_id,
      homePath: row.home_path,
    }));
  }
```

Four properties of that statement are load-bearing:

- **The join is an inner join, so a run with no base row contributes no row.** That is the skip a
  structural run needs, and it is why the caller reads absence rather than a null `home_path`.
- **The order is `rb.run_id, rb.repository_id`.** `run_base` declares
  `src/services/storage/migration-0012-run-model.ts:36` — `run_base` with
  `PRIMARY KEY (run_id, repository_id)`, so `run_id` alone is not unique at the SQL level and a
  single-key order admits two traces. SQLite compares `TEXT` in a `STRICT` table bytewise under the
  default collation, so `ORDER BY rb.run_id` **is** the bytewise order the epic requires, and the
  second key only fixes the tie. This is not the `Buffer.compare` of
  `src/services/execution/sqlite.ts:156` — `Buffer.compare`, which sorts in JavaScript because
  `RETURNING` has no defined order; a `SELECT` with `ORDER BY` needs none.
- **The empty list returns before the statement**, matching
  `src/services/execution/sqlite.ts:175` — `activeRunsOfNodes`. `IN ()` is not valid SQLite.
- **The bare home comes from `repository.home_path`**, declared at
  `src/services/storage/migration-0001-core-entities.ts:45` — `home_path`. It is `TEXT NOT NULL` and
  survives migration 0009, which renames the branch columns beside it.

Add `type RunBaseHome,` to the `./index.ts` import block at `src/services/execution/sqlite.ts:12` —
`ExpireDueRun`, in its sorted position.

### the two fakes gain the member

`Execution` gains a member, so both objects in `test/helpers/execution.ts` stop type checking until
they carry it.

- `test/helpers/execution.ts:31` — `createExecutionFake` is the strict fake whose unneeded members
  throw by name. Add `runBaseHomes(): never { return unexpected("runBaseHomes"); }` beside the other
  refusing arms. No command test of this fake reaches the reap.
- `test/helpers/execution.ts:220` — `createBackedExecutionFake` mirrors the real statements against
  real SQLite. Add `runBaseHomes` with the **same** SQL as `sqlite.ts`, byte-for-byte including the
  `ORDER BY`, and a `runBaseHomesCalls` array recording each `runIds` argument. Stories 6, 7 and 8
  drive the real `claimNode` through this fake, and a stub would make their fixtures unreachable.

### the fixture seeder

Add to `test/helpers/rows.ts`, beside `test/helpers/rows.ts:102` — `seedGraph`:

```ts
export function seedRunBase(
  transaction: Transaction,
  input: Readonly<{ runId: string; repositoryId: string; oid: string }>,
): void;
```

It runs `INSERT INTO run_base (run_id, repository_id, oid) VALUES (?, ?, ?)`. `run_base` has no
seeder today, and `eslint.config.js:13` — `no-restricted-syntax` rules that a new fixture file seeds
through `test/helpers/rows.ts` rather than holding its own raw SQL.

## Constraints

- `runBaseHomes` is synchronous and takes the caller's `Transaction`. Every member of
  `src/services/execution/index.ts:95` — `Execution` is, and
  `src/services/storage/index.ts:33` — `transact` is synchronous, so an asynchronous member could not
  run inside the caller's transaction.
- Join `run_base` to `repository` on `repository_id`. Do not reach `repository_id` through
  `workspace`, as `src/commands/startup/recover-expired-leases.ts:55` — `run_base` does: that join is
  keyed on an active run's workspace, and an ended run's workspace says nothing about its base.
- Read `home_path`, never `workspace.path`. The reap deletes a ref in the bare home, not in a
  worktree.
- Do not dedupe. A run carrying two base rows is a state
  `src/domain/run.ts:34` — `baseCount` already refuses for an execution run; hiding it here would
  make the refusal unobservable.
- Do not add an `ExecutionErrorCode`. An absent base row is a returned absence, not an error.
- Do not change any existing member of `Execution`, `SqliteExecution` or either fake.

## Verify

```
node --test src/services/execution/sqlite.test.ts
```

Extend `src/services/execution/sqlite.test.ts`, suite `"src/services/execution/sqlite.test"`. Build
through `src/services/execution/sqlite.test.ts:35` — `build`, which calls
`test/helpers/database.ts:32` — `createMigratedStorage` and seeds with
`test/helpers/rows.ts:21` — `seedRegistry` and `test/helpers/rows.ts:102` — `seedGraph`; the seeded
repository is `repo_a` with `home_path` `"repos/r.git"`. The ordering idiom is
`src/services/execution/sqlite.test.ts:454` — `attemptsOfRun`, which seeds out of order and asserts
the projection in order; the empty idiom is
`src/services/execution/sqlite.test.ts:728` — `runDriversUnderObjective`.

Add, each as a separate `it`:

1. `"runBaseHomes returns one row per run that has a base row, in bytewise run id order"` — seed a
   second repository `repo_b` with `home_path` `"repos/b.git"`, open three runs and rename them so
   their ids are `"run_c"`, `"run_b"` and `"run_a"`, seed a base row for `"run_c"` on `repo_a` and for
   `"run_a"` on `repo_b` and **none** for `"run_b"`, then assert
   `execution.runBaseHomes(transaction, ["run_c", "run_b", "run_a"])` deep-equals
   `[{ runId: "run_a", homePath: "repos/b.git" }, { runId: "run_c", homePath: "repos/r.git" }]`. Three
   facts in one value: the middle run is absent, the order is by run id and not by argument order, and
   each home is its own repository's.

2. `"runBaseHomes on an empty list returns an empty list and runs no statement"` — wrap
   `transaction.all` so it pushes each SQL string onto a log, assert
   `execution.runBaseHomes(transaction, [])` deep-equals `[]` and the log deep-equals `[]`. Then call
   it again with `["run_a"]` and assert the log has length `1`. The second half is the control:
   without it the empty log passes for a method that never queries.

3. `"runBaseHomes skips a run whose id matches no base row"` — assert
   `execution.runBaseHomes(transaction, ["run_absent"])` deep-equals `[]` while a sibling run with a
   base row in the same call returns its row, both in one case. This is the structural-run skip, and
   the sibling is its control.

4. `"a run carrying two base rows returns both rows"` — seed `"run_a"` on `repo_a` and on `repo_b`,
   assert the returned array deep-equals both rows in `repository_id` order. `run_base` permits the
   pair, so the read reports it rather than hiding it; `src/domain/run.ts:34` — `baseCount` is what
   refuses the state.

5. `"the backed fake and the service run byte-identical run_base SQL"` — read
   `src/services/execution/sqlite.ts` and `test/helpers/execution.ts` with `fs.readFileSync`, extract
   from each the whole template literal that contains `FROM run_base`, and assert the two extracted
   strings are **equal**. A shared substring is not enough: a differing `WHERE` predicate or a
   differing `ORDER BY` would pass a substring check and would make the two disagree about ordering,
   which is the property Story 5's deletion order depends on. The two implementations have already
   drifted at `endRun`, and this case pins the statement this story adds.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` in `PASS EPIC-051.5`.
