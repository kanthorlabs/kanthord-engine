# Story 6 — The lease service is deleted

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Depends on: Stories 1, 2 and 3 — the last three importers of the service.
Kind: story-foundation

This story deletes a service interface and its implementations. It draws no path: after Stories 1 to 3
no command calls a lease method, so no command's seam trace changes when the service goes.

## Change

**Delete `src/services/lease/` whole**, all five files:

| file                      | what it holds                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------- |
| `index.ts`                | the `Lease` interface, seven input types, `LeaseRecord`, `LeaseSubjectKind`, `LeaseError` |
| `sqlite.ts`               | `SqliteLease`, the only production writer of the table                                    |
| `not-implemented.ts`      | the stub implementation                                                                   |
| `sqlite.test.ts`          | 1309 lines                                                                                |
| `not-implemented.test.ts` | 31 lines                                                                                  |

**`src/main.ts`** — delete the `SqliteLease` import at `:47` and its construction at `:262`. By this
story every injection site is already gone: Story 1 removed it from the sweep and from `claim-node.ts`,
Story 2 from the recovery pass, Story 3 from `revoke-actor`, and EPIC 050.4 from all four worker
commands and from `report-objective.ts`.

**`LeaseError` goes with the interface.** Its `LeaseErrorCode` values are `not-implemented`,
`lease-held` and `lease-fenced`; EPIC 050.4 retired `lease-held` from the contract, and nothing
catches the other two once no caller exists. Delete every `catch (error) { if (error instanceof
LeaseError ...` that survives — after EPIC 050.4 there should be none, and one that survives is a
defect that epic left, reported rather than patched around.

**`Lease.expired()` has no production caller.** `grep -rn '\.expired(' src/` returns test files only,
so no command loses a call when the interface goes.

**`src/domain/lease-hierarchy.ts` is not deleted here.** Story 7 deletes it, once this story has
orphaned it: `src/services/lease/index.ts:2` and `sqlite.ts:3-6` are its last two importers, and EPIC
050.4 Story 8 removed the contract package's.

**`src/domain/lease.ts` is not deleted, here or anywhere in this epic.** It exports `leaseRow`, which
`src/domain/rows.ts:10,33` registers as the row schema of the `lease` table, and
`src/services/storage/schema-parity.test.ts:90` asserts the migrated table set equals
`Object.keys(rows)`. The table survives this epic, so `rows.lease` must survive with it, so
`leaseRow` must too. EPIC 057's migration `17` drops the table, and that is the one edit that can
remove all three at once.

## Constraints

- Delete the directory, not selected exports. A surviving `LeaseRecord` type is a type nothing can produce.
- Do not delete `src/domain/lease-hierarchy.ts` or `src/domain/lease.ts`. Story 7 owns both.
- Do not touch the `lease` table, `src/domain/lease.ts` or `src/domain/rows.ts`. All three survive until EPIC 057's migration `17`.
- If a `LeaseError` catch survives anywhere, report it as an EPIC 050.4 defect rather than editing that command here.

## Verify

```
node --test src/main.test.ts src/http/contract/parity.test.ts
```

Add, each as a separate `it`:

1. `"src/services/lease is absent"` — assert by a directory listing rather than by an import, which would fail to resolve the test itself.

2. `"src/main.ts imports nothing from services/lease"` — an import-graph assertion over that one file. `main.ts` exports no dependency map to introspect — it is the composition root and `src/main.test.ts` drives the daemon through its routes — so the import graph is the decidable proof, and it is exact: the implementation cannot be constructed without importing it.

3. `"no production file imports services/lease"` — enumerate every non-test file under `src/` and assert none holds an import specifier matching `services/lease`. Assert the offending list is empty and report the file names on failure.

4. `"no production file names LeaseError"` — the identifier, not the substring.

5. `"every shipped main.test case still passes"` — the production handler map is asserted unchanged apart from the removed dependency.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/main.test.ts` in `PASS EPIC-050.5`.
