# Story 2 — The run row

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 1 (`runKinds`), EPIC 048 Story 1 (`WORKER_ID_PATTERN` in `src/domain/worker-id.ts`).
Kind: story-foundation

This story registers no table. `run_base` is registered in `src/domain/rows.ts` by EPIC 050.1, in the story that lands migration `12` and creates the table: `src/services/storage/schema-parity.test.ts:90-105` asserts the migrated table set equals `Object.keys(rows)`, so the registration and the table must land together.

## Change

**`src/domain/run.ts` — extend `runRow` at line 12-45.**

Add to the object at `src/domain/run.ts:13-28`, keeping every shipped field and inserting each new field next to the column it mirrors in the migration `12` DDL of EPIC 050.1:

```ts
kind: z.enum(runKinds),
...
worker: workerId,
fence: z.int().min(1),
attemptLimit: z.int(),
headOid: objectId.nullable(),
judgedOid: objectId.nullable(),
graphRevision: identity("planRevision").nullable(),
agents: z.array(workerId),
expiresAt: epochMillis,
maxLifetimeAt: epochMillis,
```

**Delete `leaseFence`, `baseOid` and `parentRunId`.** Migration `12` drops all three columns. `worker`, `fence`, `agents`, `expiresAt` and `maxLifetimeAt` are **not** nullable, matching the `NOT NULL` the migration lands. Only `graphRevision`, `judgedOid`, `headOid`, `workspaceId`, `outcome` and `endedAt` stay nullable.

Import `runKinds` from `"./run-kind.ts"` and `workerId` from `"./worker-id.ts"`. `agents` is the decoded form of the `agents_json` column; the store encodes and decodes it, and the schema names the decoded shape.

**Widen `worker` at `src/domain/run.ts:20`** from `workerKind.nullable()` to `workerId` — non-nullable. The shipped `workerKind` enum at `src/domain/worker.ts:3-11` holds dotted names such as `claude.swe@1`, which `WORKER_ID_PATTERN` refuses, and EPIC 048's registry mints ids under the new grammar. Every run this epic opens carries a routed worker id. Remove the `workerKind` import at `src/domain/run.ts:5`.

**Add `workerId` as a zod schema.** EPIC 048 Story 1 exports `WORKER_ID_PATTERN` and a parser, and states it adds no zod schema. This story adds one, in `src/domain/worker-id.ts`, beside the pattern:

```ts
export const workerId = z.string().regex(WORKER_ID_PATTERN);
```

Export the schema and **no type alias**. EPIC 048 Story 1 already exports `WorkerId` from this file as the parsed record `Readonly<{ name: string; version: number; id: string }>`. A second `export type WorkerId = z.infer<typeof workerId>` would be a duplicate export of the same name with a different meaning — a string — and would not typecheck. Where a story needs the schema's output type, write `z.infer<typeof workerId>` inline; it is `string`.

The schema is declared there and not in `run.ts`, because Story 3 needs the same schema for `node.assignment`. `src/domain/` may import `zod`.

**Delete both shipped refines at `src/domain/run.ts:29-45`.** The objective refine reads `(kind === "objective") === (parentRunId === null)`; `objective` is no longer a kind and `parentRunId` is no longer a column. The driver refine reads `(driver === "internal") === (workspaceId !== null && worker !== null && baseOid !== null)`; `baseOid` is gone and every run now carries a non-null `worker`. EPIC 050.1's migration `12` drops the four SQL CHECKs they mirror. A refine with no CHECK behind it asserts a rule the database does not hold.

**Add the `run_base` cardinality refine, at its upper bound.** The cardinality is a property of a run and its `run_base` rows, and `runRow` describes one run row, so the refine reads a companion field rather than a second table. Add to `runRow`:

```ts
baseCount: z.int().min(0),
```

and one refine:

```ts
.refine(
  (row) =>
    row.kind === "execution"
      ? row.baseCount <= 1
      : row.kind === "structural" || row.kind === "review"
        ? row.baseCount === 0
        : true,
  {
    message:
      "an execution run holds at most one run_base row, and a structural or review run holds none",
  },
)
```

The bound is `<= 1` and not `=== 1`. EPIC 050 creates the table and the rule; EPIC 051 writes the row inside the same claim. An `execution` run therefore holds no row for the whole of this epic, and migration `12` writes no row for a run whose `base_oid` is null, so `=== 1` would refuse every run this epic opens and part of its own backfill. EPIC 051 raises the bound to exactly one in the epic that writes the row.

The refine is a schema statement, not a runtime guard. `runRow` is parsed only in `src/domain/run.test.ts`; `src/domain/rows.ts` holds the reference and `src/services/storage/schema-parity.test.ts:90-105` compares table names only, so no production path validates a live `run` row against it.

`runKinds` has exactly three members and the refine covers all three, so no final fall-through branch is needed. Write it as an exhaustive check over the three kinds.

**Add `runBaseRow`** to `src/domain/run.ts`, after `runRow`:

```ts
export const runBaseRow = z.object({
  runId: identity("run"),
  repositoryId: identity("repository"),
  oid: objectId,
});
export type RunBaseRow = z.infer<typeof runBaseRow>;
```

**Register `run_base` nowhere.** `src/domain/rows.ts`, `src/domain/rows.test.ts` and `docs/proposal/phase-1/domain.md:39` keep their shipped 21-table list. `src/services/storage/schema-parity.test.ts:90-105` asserts the migrated table set equals `Object.keys(rows)`, and no migration of this epic creates `run_base`, so a registration here fails that test. EPIC 050.1 owns the registration, in the story that lands migration `12`.

**Amend `docs/proposal/phase-1/domain.md:24`.** It reads that `project.worker`, `node.worker` and `run.worker` hold a worker **kind**, and that the set is a `CHECK` clause and a zod enum. Widening `run.worker` to the worker id grammar contradicts that sentence. Amend it to say `run.worker` holds a worker **id** under the grammar of `src/domain/worker-id.ts`, and that `project.worker` and `node.worker` keep the legacy kind until EPIC 057 removes them.

## Constraints

- Only fields declared nullable in `## Change` use `.nullable()`, never `.optional()`. `worker`, `fence`, `attemptLimit`, `agents`, `expiresAt`, `maxLifetimeAt` and `baseCount` stay required.
- Delete `leaseFence`. EPIC 050.1's migration `12` drops the column.
- Do not add a refine tying `judgedOid` to `kind === "review"`. EPIC 050.1's migration `12` adds no such CHECK, and the EPIC states it carries no kind-conditional CHECK.
- Do not add a refine on `graphRevision`.
- Do not reorder the shipped fields.

## Verify

```
node --test src/domain/run.test.ts src/domain/worker-id.test.ts
```

Extend `src/domain/run.test.ts`. Keep the suite name `"src/domain/run.test"` and the file's conventions: fixtures as consts with `as const` on enum fields, `assert.equal(runRow.safeParse({...}).success, true|false)`, and a `refine:` name prefix on every refine case.

Update the fixtures at `src/domain/run.test.ts:10-50` to carry the new fields. The missing-key loop at `:60-70` iterates `Object.keys(validObjectiveRun)`, so the new keys are covered by construction once the fixture holds them.

Add, each as a separate `it`:

1. `"the kind enum admits exactly the three run kinds"` — one `safeParse` per value of `["structural","execution","review"]`, each asserted `true`.

2. `"the kind enum refuses objective, task and research"` — three cases, each asserted `false`. `objective` and `task` are gone from the model, not merely unused.

3. `"fence is a required positive integer"` — `fence: 1` asserted `true`; `fence: null`, `fence: 0` and `fence: 1.5` each asserted `false`.

4. `"agents accepts a worker id array and an empty array, and refuses null"` — `["general@1"]` and `[]` asserted `true`, `null` asserted `false`. The empty array is the external-run case the EPIC names; a null is not a legal value.

5. `"agents refuses a value outside the worker id grammar"` — `agents: ["claude.swe@1"]` asserted `false`. The dot is what the grammar refuses.

6. `"worker is required and refuses a dotted legacy name"` — `"general@1"` asserted `true`; `"claude.swe@1"` and `null` each asserted `false`.

7. `"judgedOid accepts a forty-character object id and null"` — and refuses a 39-character value.

8. `"graphRevision accepts a plan revision identity and null"` — `graphRevision: "revision_" + ULID_A` asserted `true`, `null` asserted `true`, and `graphRevision: 41` asserted `false`. The column is `TEXT REFERENCES plan_revision(id)`, not an integer.

8b. `"expiresAt and maxLifetimeAt are required"` — each accepts an integer and refuses `null`. Two cases, two branches each.

8c. `"leaseFence, baseOid and parentRunId are not accepted"` — `runRow` is a plain `z.object`, so an unknown key is stripped rather than refused; assert instead that the parsed output has no `leaseFence`, `baseOid` or `parentRunId` key, by `assert.deepEqual(Object.keys(result.data!).sort(), <the pinned key list>)`. The removal is the assertion.

9. `"refine: an execution run holding no run_base row passes"` — `kind: "execution"`, `baseCount: 0`, asserted `true`. This is the row every claim of EPIC 050.1 writes. EPIC 051 changes this case to `false` when it writes the row.

10. `"refine: an execution run holding one run_base row passes"` — `baseCount: 1`, asserted `true`.

11. `"refine: an execution run holding two run_base rows fails"` — `baseCount: 2`, asserted `false`.

12. `"refine: a structural run holding a run_base row fails"` — `kind: "structural"`, `baseCount: 1`, asserted `false`.

13. `"refine: a review run holding a run_base row fails"` — `kind: "review"`, `baseCount: 1`, asserted `false`.

14. `"refine: a structural run holding no run_base row passes"` — and the same for `review`. Both directions of the cardinality rule are asserted, per the EPIC's gate.

15. `"refine: message equals the stated cardinality sentence"` — assert `result.error!.issues[0]!.message` equals `"an execution run holds at most one run_base row, and a structural or review run holds none"`, mirroring `src/domain/run.test.ts:139-143`.

16. `"runBaseRow accepts a run id, a repository id and an object id"` — one passing case, then one case per field with a wrong identity prefix asserted `false`.

17. `"the driver refine is gone: an external run carrying a worker passes"` — `driver: "external"`, `worker: "general@1"`, `workspaceId: null`, `kind: "execution"`, `baseCount: 0`, asserted `true`. This is the row the dropped refine would have refused, and it is the provenance shape the claim writes.

Add to `src/domain/worker-id.test.ts` (created by EPIC 048 Story 1):

19. `"the workerId schema accepts every value the pattern accepts"` — `workerId.safeParse("general@1").success === true`; and `false` for each of `"claude.swe@1"`, `"general"`, `"general@"`, `"general@0"`, `"General@1"`. Those five are the refusals EPIC 048 Story 1 pins.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/run.test.ts` in `PASS EPIC-050`.
