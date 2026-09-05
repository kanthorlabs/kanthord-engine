# Story 2 — The authority seams

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: EPIC 050 Story 2 (`02-the-run-row`), for `runRow`; EPIC 050.1 Story 3 (`03-the-claim-of-a-task`), for the `RunRecord` shape below and for migration `12`.
Kind: story-foundation

Two seam names the diagrams of Story 3 (`03-the-renew`) through Story 6 (`06-the-report-prelude`) draw
do not exist yet. This story declares them and implements them. It draws no path: declaring an
interface moves no call.

It also repairs the recorder, because the token those diagrams draw is one the recorder cannot emit
today.

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

### 2b — `endRun` raises the fence

**`endRun` writes `fence = fence + 1` beside `state`, `outcome` and `ended_at`.**
`src/services/execution/sqlite.ts:219` — `endRun` writes the other three and no fence today:

```sql
UPDATE run SET state = 'ended', fence = fence + 1, outcome = ?, ended_at = ?
WHERE id = ? AND state = 'active'
RETURNING <RUN_COLUMNS>
```

This is the write EPIC 050's Decisions assert and no `## Change` section instructs.
`.agents/plan/epics/050.5-the-lease-table-removal.md:115` names this story as its owner, and
`.agents/plan/epics/050.2-the-run-renew-release-and-report.md:50` states the property — "Ending a run
writes `run.state = 'ended'` and raises the fence". Story 5 (`05-the-release`) case 1 asserts it, and
EPIC 051.3's two land settles read the raised value off the returned record.

Three facts make the write correct where it is.

- **`RETURNING` reports the new value**, so `RunRecord.fence` on the returned record is the raised
  fence and no caller re-reads the row. EPIC 051.3's accepted settle appends `run.ended` with it.
- **The guard makes the raise happen exactly once.** `WHERE id = ? AND state = 'active'` means a
  second `endRun` on the same run matches no row and raises `run-not-active` through
  `src/services/execution/sqlite.ts:228` — `ExecutionError`, so the fence cannot rise twice for one
  end. The shipped case at `src/services/execution/sqlite.test.ts:325` — `it` already pins that
  refusal and is the control.
- **The two ends agree after this change.** `src/services/execution/sqlite.ts:145` — `fence` is the
  expiry pass, already `fence + 1`, and these two are the only writes that end a run. The property
  "the daemon raises the fence when it ends a run, and nowhere else" holds when both do it and
  nothing else does.

No signature changes. `EndRunInput` at `src/services/execution/index.ts:62` — `EndRunInput` gains no
field, and `RunRecord` already carries `fence` after EPIC 050.1 Story 3 (`03-the-claim-of-a-task`).

**Seven shipped call sites end a run and none passes or reads a fence today**:
`src/commands/node/release-node.ts:138` — `endRun`, `:268` and `:274`,
`src/commands/outcome/report-outcome.ts:275` — `endRun`,
`src/commands/outcome/close-objective.ts:162` — `endRun`, and
`src/commands/startup/recover-expired-leases.ts:119` — `endRun` and `:202`. Each keeps its call
unchanged, and each now leaves the run at a raised fence. **Check the three `databaseBytes` snapshots
before you land it** — `src/commands/node/release-node.test.ts`,
`src/commands/outcome/report-outcome.test.ts` and
`src/commands/outcome/close-objective.test.ts` each import
`test/helpers/database.ts:117` — `databaseBytes`. A snapshot taken across a **successful** end moves
by one column; a snapshot taken across a refusal does not, and that is what those files assert today.
Case 11 below is the sweep that proves it.

### 3 — the recorder projects a primitive argument

`test/helpers/sequence-conformance.ts:121` — `input` reads `args.at(-1)` and calls
`projections[method]` **only when that argument is an object**. `runById(transaction, runId)` takes
the run id as a primitive, so its entry at
`test/helpers/sequence-conformance.ts:57` — `runById` never fires and the recorder emits a bare
`execution.runById`. Story 3 (`03-the-renew`) and Story 5 (`05-the-release`) draw
`execution.runById:R`, EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`) and EPIC 050.5 Stories 1
and 2 draw `execution.attemptsOfRun:R`, and `attemptsOfRun` at
`src/services/execution/index.ts:115` — `attemptsOfRun` has the same shape. **Every one of those
scenarios fails on the token.**

Neither alternative is available. Dropping the label loses discrimination, because an unlabelled
`execution.runById` cannot appear twice for two runs in one diagram. Widening the two signatures to
take an input object changes a production interface to satisfy a notation, which
`.agents/plan/authoring.md` refuses.

Change the recorder to call a declared projection whatever the argument's type is, and to push the
bare token only when no projection is declared:

```ts
const method = `${key}.${String(property)}`;
const projection = projections[method];
const labels =
  projection === undefined
    ? []
    : projection(input, { method, sets }).map(
        (label) => aliases[label] ?? label,
      );
```

Add the two entries beside the object-reading ones, each reading the argument directly:

```ts
  "execution.runById": (input) => [String(input)],
  "execution.attemptsOfRun": (input) => [String(input)],
```

`test/helpers/sequence-conformance.ts:14` — `field` stays as it is; it is the object-reading helper
and these two do not use it.

**No shipped diagram changes.** `clock.now` passes `undefined` and `storage.transact` passes a
function, and neither has a projection entry, so both stay bare. `plan.readNode` takes a primitive
and gains no entry, so it stays bare too. Cases 7 to 10 assert all four.

## Constraints

- `renewRun` never writes `fence`, `state`, `ended_at` or `outcome`. The fence rises when a run ends.
- `endRun` raises the fence by exactly one, and it raises it only when it ends a run. Do not write
  `fence` from any other method, and do not accept a fence on `EndRunInput`: the value is derived from
  the stored row, never presented by a caller.
- Do not relax `WHERE id = ? AND state = 'active'`. That predicate is what makes the raise happen
  once per end.
- The recorder pushes a bare token when a method has no projection entry, whatever its argument type.
  Only a declared entry produces a label.
- Do not add a projection entry for `plan.readNode`, `clock.now` or `storage.transact`.
- Both methods take the caller's `transaction` as the first parameter. Neither opens one.
- `runById` filters on `id` alone. It applies no state and no expiry predicate.
- Do not change `activeRunOfNode`. Story 5 (`05-the-release`) and Story 6 (`06-the-report-prelude`)
  stop calling it; `releaseObjective` keeps it at `src/commands/node/release-node.ts:240` —
  `activeRunOfNode`.

## Verify

```
node --test src/services/execution/sqlite.test.ts test/helpers/sequence-conformance.test.ts src/commands/node/release-node.test.ts src/commands/outcome/report-outcome.test.ts src/commands/outcome/close-objective.test.ts src/commands/startup/recover-expired-leases.test.ts
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

7. `"endRun raises the fence by exactly one and reports the raised value"` — seed `fence: 3`, call
   `endRun`, and assert in the one case that the returned record's `fence` is `4`, that the stored
   `run.fence` is `4`, and that `state`, `outcome` and `ended_at` carry the values the shipped case
   at `src/services/execution/sqlite.test.ts:299` — `it` already asserts. Extend that shipped case
   with the `fence` assertion rather than duplicating it.

8. `"a second endRun raises no fence"` — the control for case 7. Call `endRun` twice, assert the
   second raises `run-not-active`, and assert the stored `fence` is still `4`. Without it, case 7
   passes for an implementation that raises on every call.

9. `"a renew between two ends leaves the fence alone"` — seed `fence: 3`, call `renewRun`, assert
   `fence` is `3`, then call `endRun` and assert `fence` is `4`. This is the pair that proves the
   raise belongs to the end and not to any run write.

10. `"the expiry pass and endRun agree on the raise"` — end one run with `endRun` and expire another
    with `expireDueRuns` in the same fixture, and assert both moved from `3` to `4`. The two are the
    only writes that end a run, and this asserts they do the same thing.

11. `"every shipped endRun caller leaves its run at a raised fence"` — one case body per call site,
    seven in total, driving each command over real SQLite and asserting the run's `fence` moved by
    one. Sites: `release-node` on its three arms, `report-outcome` on the accepted arm,
    `close-objective`, and `recover-expired-leases` on both. Where a file snapshots `databaseBytes`
    across a successful end, update the snapshot in the same case.

Add to `test/helpers/sequence-conformance.test.ts`, each as a separate `it`:

12. `"a projection fires for a method taking a primitive last argument"` — record a call to
    `execution.runById(transaction, "run_b")` with the alias `{ run_b: "R" }` and assert the token is
    `"execution.runById:R"`. Assert the same for `execution.attemptsOfRun`.

13. `"a method with no projection stays bare whatever its argument"` — record
    `plan.readNode(transaction, "task_a")` and assert the token is `"plan.readNode"`. This is the
    control for case 12: without it, case 12 passes for a change that labelled every primitive call.

14. `"a no-argument method stays bare"` — record `clock.now()` and assert the token is `"clock.now"`.

15. `"a function-argument method stays bare"` — record `storage.transact(callback)` and assert the
    token is `"storage.transact"`. Cases 14 and 15 are the two argument shapes the old object guard
    happened to exclude, and they must stay excluded by the absence of an entry and not by the
    guard.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` in `PASS EPIC-050.2`.
