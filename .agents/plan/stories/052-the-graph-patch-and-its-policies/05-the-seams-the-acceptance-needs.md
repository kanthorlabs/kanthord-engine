# Story 5 — The seams the acceptance needs

Epic: `.agents/plan/epics/052-the-graph-patch-and-its-policies.md`
Depends on: EPIC 051 Story 1 (`01-migration-13`) and EPIC 051.3 Story 1 (`01-migration-14`) for the `checkpoint` table, and EPIC 051.3 Story 2 (`02-the-checkpoint-row`) for `WriteCheckpointInput`, `CheckpointRecord`, `checkpointKinds` and the `checkpoint` identity kind. It depends on no story of this epic, and no story of this epic depends on it.
Kind: story-foundation

This story widens two service interfaces and their implementations. It has no caller: EPIC 052.1
Story 9 (`09-the-accepted-patch`) writes the structural checkpoint and EPIC 052.1 Story 6
(`06-a-fixed-pair-refuses-before-the-validator`) reads the predicate. It changes no drawn path,
so it draws nothing.

**The checkpoint half of this story is not buildable against the tree as it stands.** The highest
shipped migration is `12`, at `src/services/storage/migrations.ts:27` — `migration0012RunModel`, and
`grep -rn checkpoint src/` returns nothing. Migration `13` and migration `14` are both unshipped.
`identityKinds` at `src/domain/identity.ts:3` — `identityKinds` holds no `"checkpoint"`, so
`src/services/ids/index.ts:16` — `mint` cannot mint a checkpoint id. The implementing agent stops and
reports the gap rather than inventing any of the three.

## Change

### 1 — `NodeWrite` gains two optional fields

At `src/services/plan/index.ts:25` — `NodeWrite`, add two members:

```ts
  deliverable?: string | null;
  verifyJson?: string | null;
```

**Both stay optional, and the key presence is the semantics.**
`src/services/plan/sqlite.ts:435` — `hasDeliverable` reads `Object.hasOwn(node, "deliverable")`, and
`src/services/plan/sqlite.ts:46` — `CASE` turns that flag into
`deliverable = CASE WHEN ? THEN excluded.deliverable ELSE deliverable END` on the upsert arm. An
**omitted** key leaves the stored column; a key **present** with `null` writes `NULL`. Optional is
therefore the only type that expresses the shipped write.

At `src/services/plan/sqlite.ts:433` — `Partial`, replace
`NodeWrite & Partial<Pick<StoredNode, "deliverable" | "verifyJson">>` with `NodeWrite`. The
intersection existed because the interface could not say what the implementation does; it now can.
`src/services/plan/sqlite.ts:471` — `input.nodes` passes `NodeWrite` values with no cast and does not
change.

**Four construction sites, and none needs a repair.** Each omits both keys or already supplies both,
and an optional member is omissible:

- `src/commands/node/create-node.ts:250` — `NodeWrite` omits both.
- `src/commands/node/update-node.ts:362` — `NodeWrite` omits both, which is what preserves a node's
  deliverable across a field update today.
- `src/commands/node/delete-node.ts:143` — `NodeWrite` omits both on every restamped node. Do not add
  them: the values would be equal but the has-flags would flip from `0` to `1`.
- `src/commands/plan/import-plan.ts:446` — `NodeWrite` declares
  `(NodeWrite & Pick<StoredNode, "deliverable" | "verifyJson">)[]` and supplies both. `Pick` stays the
  stricter component of the intersection, so the annotation still type-checks. Leave it as it is:
  narrowing it is a separate change.

**Do not touch `StoredNode`.** `src/domain/plan-graph.ts:19` — `deliverable` and
`src/domain/plan-graph.ts:20` — `verifyJson` are `string | null` and not optional, and
`src/domain/plan-graph.test.ts:12` — `StoredNode` pins that member set.

### 2 — `WriteCheckpointInput` widens to a discriminated union

EPIC 051.3 Story 2 (`02-the-checkpoint-row`) declares `WriteCheckpointInput` with
`kind: "execution"` a literal, and states that EPIC 052 and EPIC 053 widen it when they gain a
writer. Replace it with a union and add the structural member:

```ts
export type WriteExecutionCheckpointInput = Readonly<{
  kind: "execution";
  nodeId: string;
  runId: string;
  attemptId: string;
  fence: number;
  createdAt: number;
  repositoryId: string;
  baseOid: string;
  acceptedOid: string;
  landedOid: string;
}>;

export type WriteStructuralCheckpointInput = Readonly<{
  kind: "structural";
  nodeId: string;
  runId: string;
  attemptId: string;
  fence: number;
  createdAt: number;
  graphRevision: string;
  patchBlob: string;
}>;

export type WriteCheckpointInput =
  WriteExecutionCheckpointInput | WriteStructuralCheckpointInput;
```

`writeCheckpoint(transaction, input): CheckpointRecord` keeps its name and its signature. EPIC 052.1
draws one `execution.writeCheckpoint` step, at
`.agents/plan/epics/052.1-the-structural-acceptance.md:162` — `execution.writeCheckpoint`, so a
second method would give that path a second token.

**The structural member carries no `repositoryId`, no `baseOid`, no `acceptedOid` and no
`landedOid`, and the implementation writes all four `NULL`.** Migration 14's named CHECKs decide it:
`(kind = 'execution') = (accepted_oid IS NOT NULL)` and
`(kind = 'execution') = (repository_id IS NOT NULL)` refuse a structural row that carries either, and
`(kind = 'structural') = (patch_blob IS NOT NULL)` requires `patch_blob`. All three are at
`.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:64` — `CONSTRAINT`.

**`graphRevision` is required on the structural member and no CHECK enforces it.**
`graph_revision TEXT REFERENCES plan_revision(id)` is nullable in migration 14, so the type is what
carries the requirement. It is a `plan_revision` id, and equality is the only comparison the product
makes of it.

**`caller` and `subject` stay out of the input and are written `NULL`**, exactly as EPIC 051.3
Story 2 (`02-the-checkpoint-row`) rules. EPIC 054 fills them.

Implement the structural arm in `src/services/execution/sqlite.ts` beside the execution arm, minting
the id with `this.ids.mint("checkpoint")` and mapping the returned row through the same
`toCheckpointRecord` EPIC 051.3 Story 2 adds. Follow that file's own SQL convention — a module
constant for the column list and the statement inline as a template literal, as
`src/services/execution/sqlite.ts:22` — `RUN_COLUMNS` and
`src/services/execution/sqlite.ts:165` — `activeRunOfNode` do. Do not import
`src/services/plan/sqlite.ts`'s whole-statement convention into this file.

`node scripts/verify-schema-writers.ts` runs inside `pnpm run verify` and prepares every `INSERT` in
the tree against the migrated schema, so a column the migration does not hold fails there and not at
run time.

### 3 — `hasAcceptedCheckpoint`

Add to the `Execution` interface at `src/services/execution/index.ts:95` — `Execution`:

```ts
hasAcceptedCheckpoint(transaction: Transaction, nodeId: string): boolean;
```

The bare-scalar form matches `src/services/execution/index.ts:101` — `activeRunOfNode` and
`src/services/execution/index.ts:115` — `attemptsOfRun`.

**Every checkpoint row is an accepted checkpoint, so the predicate is a bare existence test.** The
`checkpoint` table has no `accepted` column: `accepted_oid` is non-null only for the `execution`
kind, `verdict` only for the `review` kind, and a `structural` row carries neither. A checkpoint is
written only on an acceptance, and `../docs/workflow/worker.md:447` states a review verdict of `reject` is still a
delivered verdict, so a rejected review checkpoint counts. The query is

```sql
SELECT 1 FROM checkpoint WHERE node_id = ? LIMIT 1
```

with `transaction.get(...) !== undefined`, which is the shipped idiom at
`src/services/plan/sqlite.ts:586` — `anyRow`. `src/services/execution/sqlite.ts` holds no boolean
method today; this is its first.

**Three implementations of `Execution` move, not one.**
`src/services/execution/sqlite.ts:92` — `SqliteExecution`,
`test/helpers/execution.ts:43` — `Execution` and
`test/helpers/execution.ts:247` — `Execution`. The first fake throws `unexpected(name)` for an
unstubbed method; give the new member that treatment. The second is SQLite-backed and mirrors the
real statements, so it gets the real query. There is no `as Execution` escape anywhere, so the type
checker finds all three.

## Constraints

- `writeCheckpoint` writes `caller` and `subject` as `null` and takes neither.
- The structural arm writes `repository_id`, `base_oid`, `accepted_oid` and `landed_oid` as `NULL`.
  Passing a value for any of them is a CHECK failure, not a preference.
- `hasAcceptedCheckpoint` filters on `node_id` alone. It applies no kind predicate, no verdict
  predicate and no run predicate.
- Both new members take the caller's `transaction` as the first parameter. Neither opens one.
- **The two fakes are a test-engineer edit and the interface is a software-engineer edit.**
  `scripts/lane-check.sh test-engineer test/helpers/execution.ts` allows it and
  `scripts/lane-check.sh software-engineer test/helpers/execution.ts` denies it, while
  `src/services/execution/index.ts` is the reverse. `pnpm run typecheck` fails while the interface
  holds a member the two fakes do not, so the two edits land in the same cycle and the case is not
  green until both do. Neither path is locked to both roles, so this story declares no `Paths:` line.
- Do not add a `checkpoint` delete cascade and do not add a delete trigger. A checkpoint row is
  immutable evidence bound to a `plan_revision` that still exists.
- Do not change `INSERT_NODE` at `src/services/plan/sqlite.ts:43` — `INSERT_NODE`, and do not place a
  new SQL constant holding the text `ON CONFLICT` above it: `src/services/plan/sqlite.test.ts:1742` — `ON CONFLICT` scans the source for the first occurrence.
- Do not touch `src/services/plan/index.ts:45` — `MutateGraphInput`.
  `src/services/plan/sqlite.test.ts:1198` — `MutateGraphInput` slices the source from that
  declaration and asserts on the substring.

## Verify

```
node --test src/services/plan/sqlite.test.ts src/services/execution/sqlite.test.ts src/commands/node/create-node.test.ts src/commands/node/update-node.test.ts src/commands/node/delete-node.test.ts src/commands/plan/import-plan.test.ts
```

Extend `src/services/plan/sqlite.test.ts`, suite name at
`src/services/plan/sqlite.test.ts:271` — `describe`, whose fixture builder is
`src/services/plan/sqlite.test.ts:50` — `build` over
`test/helpers/database.ts:32` — `createMigratedStorage`, seeded with
`src/services/plan/sqlite.test.ts:108` — `seedAll`. It uses `it("…", (t) => {` with
`t.after(() => dispose())`.

Extend `src/services/execution/sqlite.test.ts`, suite name at
`src/services/execution/sqlite.test.ts:152` — `describe`, whose builder is
`src/services/execution/sqlite.test.ts:35` — `build`. It uses `it("…", () => {` with a
`try`/`finally` and `assertConstraint` at
`src/services/execution/sqlite.test.ts:106` — `assertConstraint`.

Add, each as a separate `it`:

1. `"mutateGraph writes a deliverable and a verify block through the NodeWrite seam"` — pass a
   `NodeWrite` **written inline** in `nodes: [{ … deliverable: "test", verifyJson }]`, not bound to a
   `const` first, and assert the stored row's `deliverable` and `verify_json` by reading it back with
   `SELECT`. The inline literal is the point: it fails excess-property checking today and compiles
   after the widening, which is what proves the seam moved rather than the storage.
   `src/services/plan/sqlite.test.ts:558` — `it` covers the read-back through `readNode` and
   `readGraph` already and stays unchanged. Gate row 19.

2. `"mutateGraph omitting both fields leaves an existing row's deliverable and verify_json"` — the
   shipped case at `src/services/plan/sqlite.test.ts:711` — `it` asserts exactly this. Extend it with
   a type-level assertion that the omitting literal is a well-formed `NodeWrite`, and assert in the
   same case that a literal **carrying** `deliverable: null` overwrites the column to `NULL`. The
   second half is the control: without it, case 2 passes for an implementation that ignores both
   fields entirely. Gate row 20.

3. `"every shipped NodeWrite construction site still type-checks and behaves identically"` — a
   build-only check plus four runs. `pnpm run typecheck` exits 0, and each of
   `src/commands/node/create-node.test.ts`, `src/commands/node/update-node.test.ts`,
   `src/commands/node/delete-node.test.ts` and `src/commands/plan/import-plan.test.ts` passes one
   existing case unchanged, named in the case body. `pnpm run verify` exits 0. Gate row 21.

4. `"a structural checkpoint row writes with graph_revision and patch_blob set and accepted_oid null"`
   — seed a structural run and an open attempt, call `writeCheckpoint` with the structural member, and
   assert the returned `CheckpointRecord` field by field, then read the row back with `SELECT *` and
   assert `repository_id`, `base_oid`, `accepted_oid`, `landed_oid`, `verdict`,
   `judged_checkpoint_id`, `caller` and `subject` are all `null` while `graph_revision` and
   `patch_blob` carry their values. Against real SQLite, on the pattern of
   `src/services/execution/sqlite.test.ts:153` — `it`. Gate row 22.

5. `"a structural checkpoint carrying an accepted_oid is refused by the migration"` — the control for
   case 4. Insert a structural row with `accepted_oid` set by raw SQL and assert with
   `assertConstraint` that the message names `checkpoint_execution_accepted_oid`. Without it, case 4
   passes for a table with no CHECK at all.

6. `"hasAcceptedCheckpoint is true for a node holding a checkpoint of any kind and false for one holding none"`
   — in one fixture, seed `task_a` with an execution checkpoint and `task_b` with a structural one,
   and leave `task_c` with none. Assert `true` for `task_a`, `true` for `task_b` and `false` for
   `task_c`. The second seeded node is what asserts the key predicate: a query missing its
   `WHERE node_id = ?` returns `true` for `task_c` too. Gate row 23.

7. `"a node named by a checkpoint row cannot be deleted"` — seed one node, one run, one attempt and
   one `kind = 'structural'` checkpoint naming that node, then delete the node through
   `mutateGraph`'s `nodeDeletes` and assert the call raises `FOREIGN KEY constraint failed`.
   `.agents/plan/stories/051.3-the-checkpoint-and-the-land/01-migration-14.md:47` — `node_id` declares
   `node_id TEXT NOT NULL REFERENCES node(id)` with no `ON DELETE` clause, and
   `src/services/storage/connection.ts:8` — `foreign_keys` turns the pragma on at every open, so
   SQLite applies `NO ACTION` immediately. The control: the same node with its checkpoint removed
   deletes. This is the schema fact the delete guard turns into a typed refusal. Gate row 24.

8. `"three nodeStates values delete and the other five refuse"` — iterate
   `src/domain/state.ts:7` — `nodeStates`, seeding one child per value under one objective with
   `test/helpers/rows.ts:359` — `seedNode`. Assert the delete guard admits `pending`, `ready` and
   `blocked`, and refuses the other five with `patch-delete-ineligible`. The split is exhaustive
   because it is iterated from the tuple. **Seed no run for any of the eight.**
   `src/services/storage/migration-0007-external-execution.ts:15` — `node_id` makes `run.node_id` a
   foreign key on `node(id)`, so a node carrying a run row cannot be deleted whatever its state, and
   a fixture that seeds one turns a state test into a foreign-key test. Gate row 25.

9. `"a child carrying a run row is not deletable"` — the control for case 8. Seed one child in state
   `running` **with** a run row, attempt the same delete, and assert the foreign-key failure with
   `assertConstraint`. Without it, case 8 reads as a claim that any node deletes, which is false.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/plan/sqlite.test.ts` and
`src/services/execution/sqlite.test.ts` in `PASS EPIC-052`.
