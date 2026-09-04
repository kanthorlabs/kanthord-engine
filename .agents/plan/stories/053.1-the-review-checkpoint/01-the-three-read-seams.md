# Story 1 — The three read seams

Epic: `.agents/plan/epics/053.1-the-review-checkpoint.md`
Depends on: EPIC 051.3 Story 1 (`01-migration-14`), for the `checkpoint` table and its five named
CHECKs; EPIC 051.3 Story 2 (`02-the-checkpoint-row`), for `src/domain/checkpoint.ts`, `CheckpointRow`
and `identity("checkpoint")`; EPIC 053, for the `"053"` entry in
`authoredEpics` that this story inserts after.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line.

**The second seam is named `newestExecutionCheckpoint`, not `newestAcceptedCheckpoint`.** EPIC 052
Story 5 (`05-the-seams-the-acceptance-needs`) already settled that there is no unaccepted checkpoint:
`.agents/plan/stories/052-the-graph-patch-and-its-policies/05-the-seams-the-acceptance-needs.md:138`
— `accepted` states every checkpoint row is an accepted checkpoint, and that a reader expecting a
`WHERE accepted = 1` clause looks for a column the schema will never have. Migration `14` carries
that: `checkpoint_execution_accepted_oid` forces `accepted_oid IS NOT NULL` for **every**
`kind = 'execution'` row, so `accepted_oid` cannot separate two execution rows. A method named
`newestAcceptedCheckpoint` would promise a predicate the schema cannot express.

## Change

### 1 — `src/services/execution/index.ts` — two read members

**Extend `src/services/execution/index.ts`.** Add two members to `Execution`, whose interface opens at `src/services/execution/index.ts:95` —
`Execution`. Insert both after `src/services/execution/index.ts:106` — `latestRunOfNode`, which is
the shipped nullable single-row read they copy:

```ts
readCheckpoint(
  transaction: Transaction,
  checkpointId: string,
): CheckpointRow | null;
newestExecutionCheckpoint(
  transaction: Transaction,
  nodeId: string,
): CheckpointRow | null;
```

`CheckpointRow` is EPIC 051.3 Story 2 (`02-the-checkpoint-row`)'s `z.infer` type, and it already
carries `verdict`, `judgedCheckpointId`, `judgedOid` and `reasonBlob`. **Return `CheckpointRow`, not
the `CheckpointRecord` that story declares for `writeCheckpoint`.** That record holds fifteen fields
and none of the four review columns, so a read returning it could not answer
`judged-checkpoint-not-execution` or copy `acceptedOid`.

Both take the caller's `Transaction`, imported at `src/services/execution/index.ts:4` — `Transaction`.
Neither opens one.

### 2 — `src/services/execution/sqlite.ts` — the two implementations

**Extend `src/services/execution/sqlite.ts`.** Add both to `SqliteExecution` at
`src/services/execution/sqlite.ts:92` — `SqliteExecution`. Add a
`CHECKPOINT_COLUMNS` constant beside `src/services/execution/sqlite.ts:22` — `RUN_COLUMNS`, listing
the nineteen columns of migration `14` in declaration order, and a `toCheckpointRow` mapper beside
`src/services/execution/sqlite.ts:58` — `toRunRecord`.

`readCheckpoint` follows `src/services/execution/sqlite.ts:165` — `activeRunOfNode` exactly:

```sql
SELECT <CHECKPOINT_COLUMNS> FROM checkpoint WHERE id = ?
```

with `transaction.get(...) as CheckpointDbRow | undefined` and
`return row === undefined ? null : toCheckpointRow(row);`.

`newestExecutionCheckpoint` follows `src/services/execution/sqlite.ts:191` — `latestRunOfNode`, whose
newest-of-many idiom is `src/services/execution/sqlite.ts:196` — `ORDER`:

```sql
SELECT <CHECKPOINT_COLUMNS> FROM checkpoint
WHERE node_id = ? AND kind = 'execution'
ORDER BY id DESC LIMIT 1
```

**`ORDER BY id DESC` is the whole of "newest".** A checkpoint id is `identity("checkpoint")`, so it is
a prefixed ULID, and SQLite's default `BINARY` collation agrees with `Buffer.compare` on it. There is
no `created_at` tie-break: two rows cannot share an id.

**The `kind = 'execution'` predicate is the only filter.** No verdict predicate, no run predicate and
no `accepted_oid` predicate, for the reason stated above the `## Change`.

### 3 — `src/services/plan/index.ts` — one read member

**Extend `src/services/plan/index.ts`.** Add one member to `PlanStore` at
`src/services/plan/index.ts:70` — `PlanStore`. Insert it after
`src/services/plan/index.ts:106` — `readSubtree`, whose return shape it copies:

```ts
readDependencies(transaction: Transaction, nodeId: string): readonly string[];
```

**It exists because `readGraph` cannot answer the question.**
`src/services/plan/index.ts:71` — `readGraph` takes a `projectId` the command does not hold, and it
returns every node and every edge of the project to decide one membership test.

### 4 — `src/services/plan/sqlite.ts` — the implementation

**Extend `src/services/plan/sqlite.ts`.** Add `readDependencies` to `SqlitePlanStore` at
`src/services/plan/sqlite.ts:142` — `SqlitePlanStore`. The statement already exists inside `readNode`, at
`src/services/plan/sqlite.ts:174` — `to_node`:

```sql
SELECT to_node FROM edge WHERE from_node = ? ORDER BY to_node ASC
```

Return the `to_node` list unchanged. **`from_node` is the dependent and `to_node` is the
dependency**, fixed by `src/services/plan/sqlite.ts:118` — `from_node` in the shared mapper, and the
wire spelling is `depends_on`.

**It needs no de-duplication.** `src/services/storage/migration-0002-graph-and-plan.ts:48` —
`UNIQUE` declares `UNIQUE (from_node, to_node)` on `edge`, so two edges naming one dependency cannot
exist. The `includes` check at `src/services/plan/sqlite.ts:179` — `includes` is defensive, and this
seam does not copy it: a filter that can never fire is dead logic.

**It applies no `waived_at` filter**, because `readNode` applies none at
`src/services/plan/sqlite.ts:174` — `to_node`, and a waived edge is still a declared dependency.

Order is bytewise ascending, which is what `src/services/plan/sqlite.ts:125` — `sort` produces for
`readNode`. The SQL `ORDER BY to_node ASC` and `Buffer.compare` agree, because SQLite's default
collation on these ids is binary.

### 5 — the three fake surfaces

**Extend `test/helpers/execution.ts` for both new members.**
`test/helpers/execution.ts:31` — `createExecutionFake` throws `unexpected(name)` for an unstubbed
method; give both members that treatment.
`test/helpers/execution.ts:220` — `createBackedExecutionFake` mirrors the real statements; give both
the real query.

**Extend `test/helpers/plan.ts` for `readDependencies`.**
`test/helpers/plan.ts:62` — `createRecordingPlanStore` enumerates every method explicitly; add one arm
beside `test/helpers/plan.ts:98` — `readSubtree`.

`pnpm run typecheck` fails while an interface holds a member a fake does not, and there is no
`as Execution` escape, so the type checker finds all three. **The interface edit and the helper edits
land in the same cycle**, because `src/services/execution/index.ts` is a software-engineer path and
`test/helpers/execution.ts` is a test-engineer path.

### 6 — `test/helpers/rows.ts` — a checkpoint seeder

**Extend `test/helpers/rows.ts`.** Add `seedCheckpointRow` beside `test/helpers/rows.ts:789` —
`seedAttemptRow`. There is no checkpoint fixture in `test/` today. Its input is a discriminated union
on `kind`, so a caller cannot name a column of the wrong group:

```ts
type SeedCheckpointInput = Readonly<{
  id: string;
  nodeId: string;
  runId: string;
  attemptId: string;
  fence: number;
  createdAt: number;
}> &
  (
    | Readonly<{
        kind: "execution";
        repositoryId: string;
        baseOid: string | null;
        acceptedOid: string;
        landedOid: string | null;
      }>
    | Readonly<{
        kind: "structural";
        graphRevision: string | null;
        patchBlob: string;
      }>
    | Readonly<{
        kind: "review";
        verdict: "accept" | "reject";
        judgedCheckpointId: string;
        judgedOid: string | null;
        reasonBlob: string | null;
      }>
  );

export function seedCheckpointRow(
  transaction: Transaction,
  input: SeedCheckpointInput,
): void;
```

It issues one `INSERT INTO checkpoint` over the full nineteen-column list, binding every column of
the other two groups as `NULL`, and binding `caller` and `subject` as `NULL` on every kind. The union
is what makes the named CHECKs unreachable from a well-typed call: a caller that wants to violate one
does it with raw SQL, as Story 8 (`08-the-attestation-with-no-reason`) cases 5 to 7 do.

### 7 — `scripts/epic-sequence-range.ts` — append `"053.1"` to `authoredEpics`

**Edit `scripts/epic-sequence-range.ts`.** Insert `"053.1"` into `authoredEpics` at
`scripts/epic-sequence-range.ts:1` — `authoredEpics`, one
element after the `"053"` entry EPIC 053 adds, in sequence
order. Do **not** touch the `shippedEpics` tuple of `scripts/epic-sequence-range.ts`; Story 10
(`10-the-report-route-carries-a-verdict`) appends that, last in dispatch order.

**Move the pinned literal with it.** `test/sequence/conformance.test.ts:255` — `authoredEpics` holds
the ordered list by value, so the insert lands in both files or `pnpm run verify` is red.
`test/sequence/conformance.test.ts:83` — `shipped` scopes the scenario requirement to `shippedEpics`,
so putting `"053.1"` in `authoredEpics` alone makes this epic's stories parse-checked by
`scripts/verify-epic-sequence.ts` and makes none of its eight diagrams scenario-due yet.

## Constraints

- Every one of the three reads takes the caller's transaction as the first parameter and opens none.
- `newestExecutionCheckpoint` filters on `node_id` and `kind = 'execution'`, and on nothing else.
- `readDependencies` reads the `edge` table only. It never reads `node`, so it returns an empty list
  for an absent node id and never distinguishes that from a node with no dependency.
- Do not add a `checkpoint` delete cascade and do not add a delete trigger.
- `readCheckpoint` returns `CheckpointRow`. Narrowing it to `CheckpointRecord` breaks Stories 4 and 7.

## Verify

```
node --test src/services/execution/sqlite.test.ts src/services/plan/sqlite.test.ts test/helpers/rows.test.ts test/sequence/conformance.test.ts
```

Extend `src/services/execution/sqlite.test.ts`, whose suite is at
`src/services/execution/sqlite.test.ts:152` — `describe` and whose fixture builder is
`src/services/execution/sqlite.test.ts:35` — `build`, over real SQLite from
`test/helpers/database.ts:32` — `createMigratedStorage`. Extend
`src/services/plan/sqlite.test.ts`, whose suite is at `src/services/plan/sqlite.test.ts:271` —
`describe` and whose builder is `src/services/plan/sqlite.test.ts:50` — `build`. Seed edges with
`test/helpers/rows.ts:421` — `seedEdge`. Dispose with `t.after(() => dispose())`.

Add, each as a separate `it`:

1. `"readCheckpoint returns the stored row field by field for each kind"` — seed one `execution`, one
   `structural` and one `review` checkpoint with `seedCheckpointRow`, then `deepEqual` each returned
   value against the complete nineteen-field object, by value. The `review` case asserts `verdict` is
   `"accept"`, `judgedCheckpointId` is the seeded execution id, `judgedOid` is that row's
   `acceptedOid`, and `reasonBlob` is the seeded hash. This is the epic's gate row 1.

2. `"readCheckpoint returns null for an absent id"` — `assert.equal(readCheckpoint(transaction,
"checkpoint_missing"), null)`.

3. `"newestExecutionCheckpoint returns the newer of two execution checkpoints of one node"` — seed
   two `execution` rows on `fixtureIds.task` with ids `checkpoint_a` and `checkpoint_b`, inserted in
   that order and then in reverse order in a second fixture. Assert the returned `id` is
   `"checkpoint_b"` in both, so the oracle is the id order and not the insertion order. This is the
   epic's gate row 2.

4. `"newestExecutionCheckpoint skips a structural and a review row of the same node"` — seed
   `checkpoint_a` as `execution` and `checkpoint_z` as `structural`, then a third fixture with
   `checkpoint_z` as `review`. Assert the returned `id` is `"checkpoint_a"` in both. `checkpoint_z`
   sorts after `checkpoint_a`, so an unfiltered query returns the wrong row and this case fails.
   This is the epic's gate row 2.

5. `"newestExecutionCheckpoint returns null for a node with no checkpoint"` — assert `null` for
   `fixtureIds.objective` while `fixtureIds.task` holds one. The second half is the control that the
   query is reached at all.

6. `"readDependencies returns the depended-upon node ids bytewise ascending"` — seed
   `edge_1: task_a -> objective_a` then `edge_2: task_a -> initiative_a`, in that order, and assert
   `deepEqual(result, ["initiative_a", "objective_a"])`. Insertion order is reversed from the
   expected order, so a query with no `ORDER BY` fails. This mirrors
   `src/services/plan/sqlite.test.ts:450` — `readGraph` and is the epic's gate row 1.

7. `"readDependencies returns an empty list for a node with no dependency"` — assert
   `deepEqual(result, [])` for `fixtureIds.initiative`, with the two-edge `task_a` of case 6 in the
   same fixture as the control.

8. `"a duplicate dependency edge cannot be seeded"` — `assert.throws` on inserting `edge_2` with
   the same `(from_node, to_node)` as `edge_1`, asserting the `SQLITE_CONSTRAINT` code with the
   `errcode & 0xff === 19` idiom of `src/services/execution/sqlite.test.ts:106` — `assertConstraint`.
   This is what makes the missing de-duplication correct rather than an omission.

9. `"readDependencies returns a waived edge"` — seed one edge with `test/helpers/rows.ts:702` —
   `seedWaivedEdge` and assert it appears. A waived edge is a declared dependency, and this pins that
   the seam takes no waiver predicate.

10. `"every Execution and PlanStore fake implements the three new members"` — assert
    `createExecutionFake().readCheckpoint` and `.newestExecutionCheckpoint` each throw
    `unexpected(name)` when called unstubbed, assert `createBackedExecutionFake()` returns the same
    value as `SqliteExecution` for one seeded checkpoint under `deepEqual`, and assert
    `createRecordingPlanStore(plan).readDependencies` returns the same list as the wrapped store and
    records the call. `pnpm run typecheck` carries the type-level obligation; this case carries the
    behavioural one.

11. `"shippedEpics is a prefix of authoredEpics"` — update the pinned literal at
    `test/sequence/conformance.test.ts:255` — `authoredEpics` to hold `"053.1"` after `"053"`, and
    assert the existing three assertions of that `it` still pass. `shippedEpics` is untouched here.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/execution/sqlite.test.ts` and
`src/services/plan/sqlite.test.ts` in `PASS EPIC-053.1`.
