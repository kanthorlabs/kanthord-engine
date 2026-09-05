# Story 2 — The checkpoint row

Epic: `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md`
Depends on: Story 1 (`01-migration-14`), which creates the table `schema-parity` then compares.
Kind: story-foundation

## Change

### 1 — `src/domain/checkpoint.ts`

Add `checkpointRow`, following the convention of `src/domain/node.ts:35` — `repositoryId`: the
predicate reads camelCase fields and the `message` is the literal SQL CHECK expression in snake_case,
so the schema and the migration are readable against each other.

```ts
export const checkpointKinds = ["execution", "structural", "review"] as const;
export type CheckpointKind = (typeof checkpointKinds)[number];

export const checkpointRow = z
  .object({
    id: identity("checkpoint"),
    kind: z.enum(checkpointKinds),
    nodeId: nodeIdentity,
    runId: identity("run"),
    attemptId: identity("attempt"),
    fence: z.int().min(1),
    caller: z.string().nullable(),
    subject: z.string().nullable(),
    createdAt: epochMillis,
    repositoryId: identity("repository").nullable(),
    baseOid: objectId.nullable(),
    acceptedOid: objectId.nullable(),
    landedOid: objectId.nullable(),
    graphRevision: identity("planRevision").nullable(),
    patchBlob: blobHash.nullable(),
    verdict: z.enum(["accept", "reject"]).nullable(),
    judgedCheckpointId: identity("checkpoint").nullable(),
    judgedOid: objectId.nullable(),
    reasonBlob: blobHash.nullable(),
  })
  .refine((row) => (row.kind === "execution") === (row.acceptedOid !== null), {
    message: "(kind = 'execution') = (accepted_oid IS NOT NULL)",
  })
  .refine((row) => (row.kind === "execution") === (row.repositoryId !== null), {
    message: "(kind = 'execution') = (repository_id IS NOT NULL)",
  })
  .refine((row) => (row.kind === "structural") === (row.patchBlob !== null), {
    message: "(kind = 'structural') = (patch_blob IS NOT NULL)",
  })
  .refine((row) => (row.kind === "review") === (row.verdict !== null), {
    message: "(kind = 'review') = (verdict IS NOT NULL)",
  })
  .refine(
    (row) => (row.kind === "review") === (row.judgedCheckpointId !== null),
    { message: "(kind = 'review') = (judged_checkpoint_id IS NOT NULL)" },
  );

export type CheckpointRow = z.infer<typeof checkpointRow>;
```

One refine per CHECK of Story 1, in the same order, and no sixth. The review group is complete here
for the reason Story 1 (`01-migration-14`) gives, so EPIC 053 adds a writer and no column.
`identity`, `nodeIdentity`, `objectId`, `blobHash` and `epochMillis` are the shipped aliases the
sibling row modules already import.

`identity("checkpoint")` needs a `checkpoint` member in
`src/domain/identity.ts:3` — `identityKinds` and a prefix in `identityPrefixes`, so
`src/services/ids/index.ts:15` — `IdGenerator` can mint one. **Three shipped pins move with it**:
`src/domain/identity.test.ts:17` — `it`, `:21` — `it` and `:25` — `it` each assert `19`, and each
becomes `20`.

### 2b — the proposal document

`src/domain/rows.test.ts:62` — `it` reads the table declaration line that follows the
`` `node:sqlite`. Tables: `` marker in `docs/proposal/phase-1/domain.md` and asserts the declared
names, sorted, deep-equal `Object.keys(rows)`. Add `` `checkpoint` `` to that line in its bytewise
position. Without it, registering the row fails a test this story does not name.

### 2 — the registry

Register `checkpoint: checkpointRow` in `src/domain/rows.ts`, in its bytewise position between
`check_result` and `edge`. `check_result` sorts **before** `checkpoint`: the two share the prefix
`check`, and `_` is `0x5F` against `p` at `0x70`. `src/domain/rows.test.ts:41` — `Object.keys` asserts
`Object.keys(rows)` equals its own sort, so the position is not free. `src/services/storage/schema-parity.test.ts:90` — `it` compares the
migrated table set with `Object.keys(rows).sort()`, so an unregistered table fails there and a
registered table with no migration fails there too.

### 3 — `execution.writeCheckpoint`

Add to `src/services/execution/index.ts:95` — `Execution`, beside
`src/services/execution/index.ts:111` — `closeAttempt`:

```ts
export type WriteCheckpointInput = Readonly<{
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

export type CheckpointRecord = Readonly<{
  id: string;
  kind: CheckpointKind;
  nodeId: string;
  runId: string;
  attemptId: string;
  fence: number;
  caller: string | null;
  subject: string | null;
  createdAt: number;
  repositoryId: string | null;
  baseOid: string | null;
  acceptedOid: string | null;
  landedOid: string | null;
  graphRevision: string | null;
  patchBlob: string | null;
}>;

writeCheckpoint(transaction: Transaction, input: WriteCheckpointInput): CheckpointRecord;
```

`kind` is a literal `"execution"` here: this epic writes no other kind, and EPIC 052 and EPIC 053
widen the input when they gain a writer. The input carries no `caller` and no `subject`; the
implementation writes both as `null`.

Implement it in `src/services/execution/sqlite.ts` beside
`src/services/execution/sqlite.ts:287` — `closeAttempt`, minting the id with `this.ids.mint`
exactly as `openAttempt` does, one `INSERT ... RETURNING` over the full column list, and a
`toCheckpointRecord` mapper in the shape of `src/services/execution/sqlite.ts:80` —
`toAttemptRecord`. `graph_revision` and `patch_blob` are written `null`.

## Constraints

- One refine per migration CHECK, five in total, with the SQL expression as the message and in the
  migration's order.
- `checkpointRow` is registered in `rows` in bytewise position. `databaseBytes` at
  `test/helpers/database.ts:117` — `databaseBytes` iterates that registry, so an omission silently
  drops the table from every byte-identical assertion in the suite.
- `writeCheckpoint` writes `caller` and `subject` as `null` and takes neither.
- The store performs no validation against `checkpointRow`. No shipped store parses a row schema, and
  this one does not start.

## Verify

```
node --test src/domain/checkpoint.test.ts src/domain/rows.test.ts src/services/storage/schema-parity.test.ts src/services/execution/sqlite.test.ts
```

Add `src/domain/checkpoint.test.ts` and extend `src/services/execution/sqlite.test.ts`, which builds
storage with `test/helpers/database.ts:32` — `createMigratedStorage`.

Add, each as a separate `it`:

1. `"schema-parity finds checkpoint in the migrated table set"` — the shipped case at
   `src/services/storage/schema-parity.test.ts:90` — `it` covers it once `rows` carries the key;
   assert here additionally that `Object.keys(rows)` holds `"checkpoint"` exactly once and that the
   array equals its own bytewise sort.

2. `"checkpointRow accepts one valid row per kind"` — parse an execution row, a structural row and a
   review row with every optional column null. Assert all three succeed.

3. `"checkpointRow refuses an execution row with no accepted_oid"` — assert the issue message equals
   `"(kind = 'execution') = (accepted_oid IS NOT NULL)"`.

4. `"checkpointRow refuses a structural row carrying an accepted_oid"` — the same message. Cases 3
   and 4 are the two directions of one biconditional, so neither passes for a one-sided predicate.

5. `"checkpointRow refuses an execution row with no repository_id"` — assert the issue message
   equals `"(kind = 'execution') = (repository_id IS NOT NULL)"`.

6. `"checkpointRow refuses a review row carrying a repository_id"` — the same message.

7. `"checkpointRow refuses a structural row with no patch_blob and an execution row carrying one"` —
   two parses in one case, both asserting the message
   `"(kind = 'structural') = (patch_blob IS NOT NULL)"`.

7b. `"checkpointRow refuses a review row with no verdict and an execution row carrying one"` — two
parses, both asserting `"(kind = 'review') = (verdict IS NOT NULL)"`.

7c. `"checkpointRow refuses a review row with no judged_checkpoint_id and a structural row carrying one"`
— two parses, both asserting
`"(kind = 'review') = (judged_checkpoint_id IS NOT NULL)"`.

8. `"checkpointRow accepts a null caller and a null subject"` — parse an otherwise valid execution
   row with both null and assert success. EPIC 054 fills them and EPIC 057 tightens them, so a
   `NOT NULL` assertion here would pin a state this epic cannot reach.

9. `"writeCheckpoint returns the row it inserted, field by field"` — seed a run and an open attempt,
   call `writeCheckpoint` with pinned values, and `deepEqual` the returned record against the
   expected object with the minted id read from the mock id generator. Assert `caller` and `subject`
   are `null`.

10. `"identityKinds carries checkpoint and the three pinned counts read 20"` — assert
    `identityKinds` holds `"checkpoint"`, that `identityPrefixes` holds a unique prefix for it, and
    that the three shipped assertions at `src/domain/identity.test.ts:17` — `it` onward read `20`.

11. `"domain.md declares checkpoint in its table line"` — the shipped case at
    `src/domain/rows.test.ts:62` — `it` covers it once the document carries the name; assert here
    additionally that the declared list holds no duplicate.

12. `"writeCheckpoint stores a row that checkpointRow parses"` — read the inserted row back with
    `SELECT *`, map it to camelCase and assert `checkpointRow.parse` does not throw. This is what
    binds case 2's schema to the migration of Story 1.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/checkpoint.test.ts` and
`src/services/storage/schema-parity.test.ts` in `PASS EPIC-051.3`.
