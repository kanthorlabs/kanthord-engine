# Story 8 — `services/execution`, the run and attempt record

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 3 (the `driver` columns).

## Change

A new capability, `src/services/execution/`. The `boundaries/elements` pattern at `eslint.config.js:67` is `src/services/*`, so the new directory needs no eslint edit.

### `src/services/execution/index.ts`

The interface only. `src/domain/layout.test.ts:159` asserts no `src/services/*/index.ts` contains the literal `implements `.

Every method takes the storage `Transaction` first, because the transaction rule of `AGENTS.md` requires a claim and its run to be one transaction.

```ts
export type RunKind = "objective" | "task";
export type RunDriver = "internal" | "external";

export type RunRecord = Readonly<{
  id: string;
  kind: RunKind;
  nodeId: string;
  parentRunId: string | null;
  driver: RunDriver;
  leaseFence: number;
  attemptLimit: number;
  state: "active" | "ended";
  outcome: string | null;
  headOid: string | null;
  endedAt: number | null;
}>;

export type AttemptRecord = Readonly<{
  id: string;
  runId: string;
  driver: RunDriver;
  attemptNo: number;
  headOid: string | null;
  outcome: AttemptOutcome | null;
  endedAt: number | null;
}>;

export type OpenRunInput = Readonly<{
  nodeId: string;
  kind: RunKind;
  parentRunId: string | null;
  leaseFence: number;
  attemptLimit: number;
}>;

export type AdoptRunInput = Readonly<{ runId: string; leaseFence: number }>;

export type EndRunInput = Readonly<{
  runId: string;
  outcome: string;
  at: number;
}>;

export type OpenAttemptInput = Readonly<{ runId: string }>;

export type CloseAttemptInput = Readonly<{
  attemptId: string;
  outcome: AttemptOutcome;
  at: number;
}>;

export interface Execution {
  openRun(transaction: Transaction, input: OpenRunInput): RunRecord;
  activeRunOfNode(transaction: Transaction, nodeId: string): RunRecord | null;
  adoptRun(transaction: Transaction, input: AdoptRunInput): RunRecord;
  endRun(transaction: Transaction, input: EndRunInput): RunRecord;
  openAttempt(transaction: Transaction, input: OpenAttemptInput): AttemptRecord;
  closeAttempt(
    transaction: Transaction,
    input: CloseAttemptInput,
  ): AttemptRecord;
  attemptsOfRun(
    transaction: Transaction,
    runId: string,
  ): readonly AttemptRecord[];
  runDriversUnderObjective(
    transaction: Transaction,
    objectiveId: string,
  ): readonly RunDriver[];
}
```

`AttemptOutcome` comes from `src/domain/attempt.ts:14`. `RunDriver` is declared here; if EPIC 014 already exports it from `src/domain/run.ts`, import that one and re-export no copy.

`runDriversUnderObjective` is the eighth method and it is required by Story 10: `claimNode` reads the driver of every run ever opened under the objective and passes the list to `objectiveDrivePin`. Placing the query here keeps `commands/` free of SQL.

`ExecutionError` with `ExecutionErrorCode` of `run-not-found`, `run-not-active` and `attempt-not-open`, in the shape of `LeaseError` at `src/services/lease/index.ts:38-45`.

### `src/services/execution/sqlite.ts`

`class SqliteExecution implements Execution`. Constructor dependency is `Readonly<{ ids: IdGenerator }>` only. It opens no transaction and reads no clock: `at` is an input at every call.

- `openRun` writes `driver = 'external'`, `input.nodeId`, `input.kind`, `input.parentRunId`, `input.leaseFence`, `input.attemptLimit`, `state = 'active'`, and **null in `workspace_id`, `worker` and `base_oid`**, which the three driver clauses of migration 0007 require. `head_oid`, `outcome` and `ended_at` are null. The id comes from `ids.next("run")`. An objective run carries `kind = 'objective'` and a null `parent_run_id`; a task run carries `kind = 'task'` and the objective run id, so `CHECK ((kind = 'objective') = (parent_run_id IS NULL))` at `src/services/storage/migration-0003-execution-and-journal.ts:44` holds in both cases.
- `activeRunOfNode` selects the one row with `node_id = ? AND state = 'active'`. `run_one_active` guarantees at most one. It is what lets a second task claim reuse the one active objective run.
- `adoptRun` runs `UPDATE run SET lease_fence = ? WHERE id = ? AND state = 'active'` with `RETURNING`, and raises `ExecutionError("run-not-active", ...)` on an empty result. **It opens no second run**, because `run_one_active` allows one.
- `endRun` runs `UPDATE run SET state = 'ended', outcome = ?, ended_at = ? WHERE id = ? AND state = 'active'` with `RETURNING`, and raises `ExecutionError("run-not-active", ...)` on an empty result.
- `openAttempt` reads `attemptsOfRun(transaction, input.runId)`, calls `accountAttempts({ attempts, limit })` from `src/domain/attempt-accounting.ts:32` with the run's `attempt_limit`, and writes `attempt_no = accounting.nextAttemptNo`. **The number comes from the rows and never from a counter column.** It writes `driver = 'external'` and null in `provider_id`, `provider_model`, `timeout_ms` and `base_oid`, which the four driver clauses require. `head_oid`, `outcome` and `ended_at` are null. The id comes from `ids.next("attempt")`.
- `closeAttempt` runs `UPDATE attempt SET outcome = ?, ended_at = ? WHERE id = ? AND outcome IS NULL` with `RETURNING`, and raises `ExecutionError("attempt-not-open", ...)` on an empty result.
- `attemptsOfRun` selects every attempt of the run **ordered by `attempt_no` ascending**. `accountAttempts` is order-insensitive, and the order is pinned anyway so a snapshot assertion is reproducible.
- `runDriversUnderObjective` runs

  ```sql
  SELECT r.driver FROM run r
  JOIN node n ON n.id = r.node_id
  WHERE r.node_id = ? OR n.parent_id = ?
  ORDER BY r.id
  ```

  with the objective id twice. It returns the driver of **every run ever opened** under the objective, the objective's own runs included, ended runs included, ordered by run id so `objectiveDrivePin` reports a reproducible `pinnedDriver`.

### `src/domain/layout.test.ts`

The capability inventory at `src/domain/layout.test.ts:101-125` is an exact sorted list. Add `execution` between `event` and `git`. The suite title at `:101` names a count; raise it by one. EPIC 016 adds `readiness` and EPIC 015 adds `secret` to the same list, so take the count that is there when this story runs and add one.

## Constraints

- `openRun` and `openAttempt` write `driver = 'external'` unconditionally in this epic. Do not add a `driver` input member: no path of this block opens an internal run, and EPIC 110 widens the interface when it needs to.
- `SqliteExecution` opens no transaction and reads no clock.
- `commands/` never runs SQL. Every read this epic needs from `run` or `attempt` is a method here.
- Do not add a `nextAttemptNo` column, a counter column or an attempt count to `node`.
- Do not import `src/services/plan/sqlite.ts` or any other capability's implementation.
- Add no ninth method.

## Verify

New test file `src/services/execution/sqlite.test.ts`, on real SQLite through `createMigratedStorage`, with a recording `IdGenerator` fake from `test/helpers/ids.ts`. Seed one project, one initiative, one objective and two sibling tasks by direct `INSERT` into `node`.

- `openRun writes an external objective run with null workspace, worker and base oid` — read the row and assert all four columns, plus `kind`, `parent_run_id` null, `lease_fence`, `attempt_limit` and `state`.
- `openRun writes an external task run whose parent_run_id names the objective run` — assert `kind` and `parent_run_id`.
- `openRun refuses an objective run that names a parent run` — the `CHECK` throws; assert it.
- `activeRunOfNode returns the one active run or null` — before any run, `null`; after `openRun`, the record; after `endRun`, `null`.
- `a second active run on one node is refused` — assert `openRun` throws on the unique index.
- `adoptRun moves the lease fence and opens no second run` — assert the fence, and assert the `run` row count is unchanged.
- `adoptRun on an ended run raises run-not-active`.
- `endRun writes the outcome and the end instant` — assert `state`, `outcome` and `ended_at`.
- `endRun on an ended run raises run-not-active`.
- `openAttempt mints attempt_no 1 on an empty run, then 2` — assert both numbers, and assert `provider_id`, `provider_model`, `timeout_ms` and `base_oid` are all null on both rows.
- `openAttempt reads the number from the rows` — insert an attempt with `attempt_no` 5 directly, then `openAttempt`, and assert `6`. This proves the number comes from `accountAttempts` and not from a count.
- `closeAttempt writes the outcome and the end instant, and refuses a second close` — assert the row, then assert the second call raises `attempt-not-open`.
- `attemptsOfRun returns every attempt ordered by attempt_no` — three attempts inserted out of order, asserted `[1, 2, 3]`.
- `runDriversUnderObjective returns every driver under the objective, ended runs included` — open an objective run and two task runs, end one, and assert the returned list is three members of `external`, ordered by run id. Then insert an `internal` run under one task directly and assert the list holds that member too.
- `runDriversUnderObjective returns an empty list for an objective with no run`.
- `an external attempt under an internal run is refused` — insert an `internal` run directly, then call `openAttempt` on it, and assert it throws on the composite foreign key.
- `SqliteExecution reads no clock` — assert by source read that `src/services/execution/sqlite.ts` includes none of `Date.now(`, `new Date(` and no import from `../clock/`.
- `no node column holds an attempt count` — read `PRAGMA table_info(node)` and assert no column name includes the substring `attempt`.

`accountAttempts` itself is covered by `src/services/execution/sqlite.test.ts` through `openAttempt`, and its unit coverage stays in `src/domain/attempt-accounting.test.ts` unchanged. `src/domain/attempt.test.ts` is in the Proof because EPIC 014 refines `attemptRow` there; add no assertion to it in this story.

Run:

- `node --test src/services/execution/sqlite.test.ts src/domain/layout.test.ts src/domain/attempt.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/services/execution/sqlite.test.ts`, `src/domain/layout.test.ts` and `src/domain/attempt.test.ts`. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:206`.
