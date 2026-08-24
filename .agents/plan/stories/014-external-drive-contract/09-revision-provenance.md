# Story 9 — Revision provenance

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order). Independent of Stories 6 to 8.

## Change

### `src/domain/plan-revision.ts`

The file today is:

```ts
export const planRevisionRow = z.object({
  id: identity("planRevision"),
  projectId: identity("project"),
  parentId: identity("planRevision").nullable(),
  importId: z.string(),
  submittedBlob: blobHash,
  choicesBlob: blobHash,
  acceptedBlob: blobHash,
});
```

Make four edits.

1. Add the enum above `planRevisionRow`, in the shape `src/domain/event.ts:6-7` uses:

```ts
export const revisionOrigins = ["import", "node-write"] as const;
export type RevisionOrigin = (typeof revisionOrigins)[number];
```

Declare it in this file. Do not put it in `src/domain/origin.ts`; that file holds the CORS origin canonicalizer of the transport and shares no meaning.

2. Add one field immediately after `parentId` and before `importId`: `origin: z.enum(revisionOrigins),`.
3. Make three fields nullable: `importId: z.string().nullable()`, `submittedBlob: blobHash.nullable()`, `choicesBlob: blobHash.nullable()`. `acceptedBlob` stays required.
4. Add one `.refine` to the object. `planRevisionRow` holds no refine today, so this is its first:

```ts
}).refine(
  (row) =>
    row.origin === "import"
      ? row.importId !== null &&
        row.submittedBlob !== null &&
        row.choicesBlob !== null
      : row.importId === null &&
        row.submittedBlob === null &&
        row.choicesBlob === null,
  {
    message:
      "(origin = 'import') = (import_id IS NOT NULL AND submitted_blob IS NOT NULL AND choices_blob IS NOT NULL)",
  },
);
```

Copy the message exactly. It states the all-or-nothing rule as one conjunction, which is the shape a single zod refine needs.

EPIC 017 carries the same rule as **three** table `CHECK` clauses, one per column, because that shape refuses a partially populated row on every evaluation order:

```sql
CHECK ((origin = 'import') = (import_id IS NOT NULL)),
CHECK ((origin = 'import') = (submitted_blob IS NOT NULL)),
CHECK ((origin = 'import') = (choices_blob IS NOT NULL))
```

Their conjunction equals this refine. The message is therefore not a copy of any one `CHECK`, and no test compares the two.

`acceptedBlob` stays required under both origins, and it stays the whole re-rendered graph, so `plan.export` byte-identity and the `fromRevision` of `plan.import` both survive a per-node write.

### `src/domain/plan-revision.test.ts`

- Add `origin: "import" as const,` to `validRow` at `src/domain/plan-revision.test.ts:10-18`, immediately after `parentId`.
- Add a second fixture inside the `describe`, after `validRow`:

```ts
const validNodeWriteRow = {
  ...validRow,
  origin: "node-write" as const,
  importId: null,
  submittedBlob: null,
  choicesBlob: null,
};
```

- Add `it("revisionOrigins pins the two origins in order", ...)`: `assert.deepEqual([...revisionOrigins], ["import", "node-write"])`, `assert.equal(revisionOrigins.length, 2)`.
- Add `it("accepts a node-write revision that holds no import fact", ...)`: `assert.equal(planRevisionRow.safeParse(validNodeWriteRow).success, true)`.
- Add `it("refuses a node-write revision that carries an import fact", ...)`. Assert `success === false` for each of three inputs, one per field: `{ ...validNodeWriteRow, importId: "import-1" }`, `{ ...validNodeWriteRow, submittedBlob: HASH }`, `{ ...validNodeWriteRow, choicesBlob: HASH }`.
- Add `it("refuses an import revision that omits an import fact", ...)`. Assert `success === false` for each of three inputs, one per field: `{ ...validRow, importId: null }`, `{ ...validRow, submittedBlob: null }`, `{ ...validRow, choicesBlob: null }`.
- Add `it("acceptedBlob is required under both origins", ...)`. Assert `success === false` for `{ ...validRow, acceptedBlob: null }` and for `{ ...validNodeWriteRow, acceptedBlob: null }`.
- Add `it("origin refine: message equals the DDL CHECK expression", ...)`: parse `{ ...validRow, importId: null }` and assert `result.error!.issues[0]!.message` equals the exact message string above.
- Add `it("refuses an unknown origin", ...)`: `{ ...validRow, origin: "restore" }` fails.
- Import `revisionOrigins` beside `planRevisionRow` at `src/domain/plan-revision.test.ts:4`.

## Constraints

- **Do not change the missing-required-key loop at `src/domain/plan-revision.test.ts:24-34`.** In zod 4, `.nullable()` accepts an explicit `null` and still rejects a **missing** key, so deleting `importId`, `submittedBlob` or `choicesBlob` from the fixture still fails the parse. Leaving the loop as it is keeps coverage and adds `origin` to it; editing it would delete a passing assertion. An earlier EPIC draft said the loop "stops expecting rejection for the three now-nullable keys"; `.agents/plan/epics/014-external-drive-contract.md:30` now states the loop is unchanged.
- `planRevisionRow` is referenced only from `src/domain/rows.ts:33`. Change no command, no query and no service.
- Write no SQL and no migration. EPIC 017 owns the `origin` column with its `CHECK`, the three nullable columns and the table `CHECK`.
- Touch nothing in `src/domain/origin.ts`.

## Verify

- `node --test src/domain/plan-revision.test.ts src/domain/rows.test.ts` exits 0.
- `planRevisionRow` refuses a `node-write` revision that carries an `importId`, a `submittedBlob` or a `choicesBlob`, asserted per field.
- `planRevisionRow` refuses an `import` revision that omits any of the three, asserted per field.
- `acceptedBlob` is asserted required under both origins.
- The unchanged loop at `src/domain/plan-revision.test.ts:24-34` exits 0, proving a missing key still fails.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `planRevisionRow` bullet at `.agents/plan/epics/014-external-drive-contract.md:98`.
