# Story 6 — `services/execution` gains two methods

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: EPIC 018, which creates `src/services/execution/index.ts` and `src/services/execution/sqlite.ts` (`018-claim-and-lease.md:83`).

## Change

### `src/services/execution/index.ts`

Add one input type and two methods to `interface Execution`. Place `stampRunHead` immediately after `endRun` and `latestRunOfNode` immediately after `activeRunOfNode`, so the interface keeps its write-then-read grouping.

```ts
export type StampRunHeadInput = Readonly<{
  runId: string;
  headOid: string;
}>;
```

```ts
  stampRunHead(transaction: Transaction, input: StampRunHeadInput): void;
  latestRunOfNode(transaction: Transaction, nodeId: string): RunRecord | null;
```

`RunRecord` is the record type `activeRunOfNode` already returns; reuse it and declare no second shape.

### `src/services/execution/sqlite.ts`

- `stampRunHead` runs exactly one statement:

  ```sql
  UPDATE run SET head_oid = ? WHERE id = ? AND ended_at IS NULL
  ```

  It moves no other column. It throws the capability's own error with code `run-not-active` when the statement changes no row, so a stamp on an ended run or an unknown run is never silent.

- `latestRunOfNode` runs exactly one statement and maps the row with the same mapper `activeRunOfNode` uses:

  ```sql
  SELECT * FROM run WHERE node_id = ? ORDER BY id DESC LIMIT 1
  ```

  It returns `null` on no row. A run id is a ULID, so `ORDER BY id DESC` is the newest run and the read is deterministic.

- `latestRunOfNode` needs no tie-break beyond `ORDER BY id DESC`: `run.id` is a ULID and the primary key, so two runs never share one id and the greatest id is the newest run. Do not order by a timestamp column, which can tie.

- `attemptsOfRun` already exists from EPIC 018. Confirm it returns the whole attempt row including `head_oid`. If it projects a narrower shape, widen it to the whole row and change no caller behaviour. The caller of Story 7 maps the row to the `AttemptRecord` shape of `src/domain/attempt-accounting.ts:3-6`.

## Constraints

- **Every read of this capability declares an explicit `ORDER BY`.** SQLite row order is otherwise unspecified. `attemptsOfRun` orders by `attempt_no` ascending; if EPIC 018 left it unordered, add the clause and change nothing else.
- Add no third method and no second capability. `src/domain/layout.test.ts` needs no edit in this epic.
- `stampRunHead` never ends a run and never writes `outcome` or `ended_at`. `endRun` is the only path that ends a run.
- Both methods take the caller's `Transaction` as the first argument, per the transaction rule of `AGENTS.md`.
- Do not add a migration. `run.head_oid` already exists and is nullable (`018-claim-and-lease.md:57`).

## Verify

Edit `src/services/execution/sqlite.test.ts`, over a real `node:sqlite` database on a temporary file, in the fixture style EPIC 018 established in that file.

- `it("stampRunHead writes head_oid on an active run and moves no other column", ...)` — open a run, read the whole row, stamp a 40-character object id, read the row again, and assert `head_oid` changed and every other column is equal field by field.
- `it("stampRunHead accepts a 64-character object id", ...)`.
- `it("stampRunHead refuses an ended run", ...)` — end the run, then assert the call throws with code `run-not-active`, and assert the row is unchanged field by field.
- `it("stampRunHead refuses an unknown run id", ...)` — assert the same code.
- `it("latestRunOfNode returns the run with the greatest id", ...)` — open a run, end it, open a second run under the same node, and assert the returned id equals the second run id. Assert it also returns the ended run when it is the only run.
- `it("latestRunOfNode returns null for a node with no run", ...)`.
- `it("latestRunOfNode returns the ended run after the close", ...)` — end the newest run and assert the same id comes back with its `head_oid` intact.
- `it("attemptsOfRun returns head_oid", ...)` — close an attempt with an object id and assert the returned row carries it.
- `node --test src/services/execution/sqlite.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/services/execution/sqlite.test.ts`.
