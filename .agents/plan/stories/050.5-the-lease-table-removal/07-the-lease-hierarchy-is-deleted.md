# Story 7 — The lease hierarchy is deleted

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Depends on: Story 6 (the last two importers), and EPIC 050.4 Story 8 (the contract package's imports of `leaseRelations` **and** `leaseOwnerKinds`).
Kind: story-foundation

This story deletes a pure domain module. It draws no path: `liveLeaseRefusal` is a domain function, and
a domain call is invisible at the seam the recorder wraps.

## Change

**Delete `src/domain/lease-hierarchy.ts` whole**, with its test. It exports `leaseRelations`,
`LeaseRelation`, `LiveLease`, `LeaseHierarchyInput`, `LeaseRefusal`, and the function `liveLeaseRefusal`
with its two private helpers `relationOf` and `refusesAt`.

**Its importers are gone by this point, and each was removed by a named story.** Verify all four before
deleting, and report a survivor rather than editing it here:

| importer                             | site   | removed by           |
| ------------------------------------ | ------ | -------------------- |
| `src/http/contract/error-details.ts` | `:6`   | EPIC 050.4 Story 8   |
| `src/commands/node/claim-node.ts`    | `:3-5` | EPIC 050.4 Story 1   |
| `src/services/lease/index.ts`        | `:2`   | Story 6 of this epic |
| `src/services/lease/sqlite.ts`       | `:3-6` | Story 6 of this epic |

**`src/domain/lease.ts` survives, whole, and the reason is decided rather than left open.**
`src/domain/rows.ts:10,33` registers `leaseRow` as the row schema of the `lease` table, and
`src/services/storage/schema-parity.test.ts:90` asserts the migrated table set equals
`Object.keys(rows)`. The table survives this epic — no story here drops it — so `rows.lease` must
survive, so `leaseRow`, `leaseSubjectKinds` and `leaseOwnerKinds` must all survive with it. Deleting
any of the three here fails schema parity, and deleting `rows.lease` instead fails it the other way.

**EPIC 057's migration `17` is where all four go together**, and that epic already owns the lease rows:
its Stories 6 and 7 delete the `subject_kind = 'node'` rows and narrow the CHECK. The amendment this
epic asks for is that migration `17` **drops the table** rather than narrowing it, and deletes
`src/domain/lease.ts` and `rows.lease` in the same edit.

## Constraints

- Delete the module, not selected exports. A surviving `LeaseRelation` is a type nothing produces.
- Verify the four importers are gone before deleting. Report a survivor as a defect of the story that owed it; do not edit that file here.
- Do not delete `src/domain/lease.ts` or `rows.lease`. Both are load-bearing for schema parity until EPIC 057's migration `17` drops the table.
- Do not move `leaseOwnerKinds` out of `src/domain/lease.ts`. It is used by `leaseRow` in that file.

## Verify

```
node --test src/http/contract/error-details.test.ts src/http/contract/parity.test.ts src/domain/version.test.ts
```

Add, each as a separate `it`:

1. `"src/domain/lease-hierarchy.ts is absent"` — assert by a directory listing rather than by an import, which would fail to resolve the test itself.

2. `"no production file imports domain/lease-hierarchy"` — enumerate every non-test file under `src/` and assert none holds a matching import specifier. Report the file names on failure.

3. `"no production file names liveLeaseRefusal, LeaseRefusal, LiveLease or leaseRelations"` — the four identifiers, not the substring `lease`, which matches `release`.

4. `"src/domain/lease.ts still exports leaseRow, leaseSubjectKinds and leaseOwnerKinds"` — assert by export name. The survival is deliberate and load-bearing, and this case is what stops a later reader deleting it and breaking schema parity.

4b. `"schema parity still holds"` — the shipped `src/services/storage/schema-parity.test.ts` run unchanged. It is what would fail if `rows.lease` or `leaseRow` went early.

5. `"the emitted contract documents are unchanged by this story"` — the shipped parity harness, run unchanged. Deleting a domain module a contract file once imported must move no schema, and this is what proves it.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.5`.
