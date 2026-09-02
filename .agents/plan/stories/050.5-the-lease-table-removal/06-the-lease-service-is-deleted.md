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

**`test/helpers/lease.ts` is deleted with the service, and its importers are named.** It imports
`SqliteLease` from `services/lease/sqlite.ts`, seven types and `LeaseError` from
`services/lease/index.ts`, and `liveLeaseRefusal` from `domain/lease-hierarchy.ts`, so it cannot
survive this story. It exports `createLeaseFake`, `createBackedLeaseFake` and
`acquireLeaseOnDatabaseFile`, and fourteen test files import one of the three. **Each importer is
repaired by the first story that invalidates it, and this story takes only the residue.**

| importer                                            | repaired by                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `src/commands/node/claim-node.test.ts`              | EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`)       |
| `src/commands/node/heartbeat-node.test.ts`          | EPIC 050.4 Story 4 (`04-the-renew-drops-the-lease`)                 |
| `src/commands/node/release-node.test.ts`            | EPIC 050.4 Story 5 (`05-the-release-drops-the-lease`)               |
| `src/commands/outcome/report-outcome.test.ts`       | EPIC 050.4 Story 6 (`06-the-report-drops-the-lease`)                |
| `src/commands/outcome/report-objective.test.ts`     | EPIC 050.4 Story 7 (`07-the-objective-attestation-drops-the-lease`) |
| `src/main.claim.test.ts`                            | EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`)       |
| `src/commands/startup/recover-expired-runs.test.ts` | Story 1 and Story 2 of this epic                                    |
| `src/commands/actor/revoke-actor.test.ts`           | Story 3 of this epic                                                |
| `src/http/server/actor/revoke-actor.test.ts`        | Story 3 of this epic                                                |
| `src/commands/outcome/close-objective.test.ts`      | this story                                                          |
| `src/commands/actor/rotate-actor-token.test.ts`     | this story                                                          |
| `src/http/server/actor/rotate-actor-token.test.ts`  | this story                                                          |
| `src/http/server/actor/registration.test.ts`        | this story                                                          |
| `src/queries/actor/list-actor.test.ts`              | this story                                                          |

The five in the last group hold the fake only as an inert dependency of a command whose behaviour
this epic does not change, so they lose the import and the fixture key and assert nothing new.
**`src/main.claim.test.ts` also imports `LeaseError` from `services/lease/index.ts` directly**, at
`:17`, and uses it at `:472-483` to assert a foreign `lease-held` takeover; that case dies with the
claim's lease, and EPIC 050.4 Story 1 (`01-the-claim-of-a-task-drops-the-lease`) owns it. **Report a survivor in the first two groups as a defect
of the story that owed it**, and delete only the helper and the last group here. A repair this story
takes for a file the table assigns elsewhere hides a red boundary in the epic that caused it.

**`src/domain/layout.test.ts` moves with the directory.** `:101` asserts the service directory list by
value and `:151` asserts that `agent`, `verify`, `lease` and `worker-health` each hold a
`not-implemented.ts`. Remove `"lease"` from both literals and take the count in the `:101` suite name
from twenty-one to **twenty**. The suite name counts capabilities and `home-lock` separately — today
it reads "the twenty-one capabilities plus home-lock" over a 22-entry literal — so removing one
capability lands on twenty plus home-lock. Story 4 no longer touches this file, so this story is the
only one that moves the count.

**The three-importer assertion of EPIC 050.4 Story 9
(`09-the-proposal-records-one-authority`) is retired here.** That story lands
`it("the Lease service keeps exactly three importers")`, asserting the importer set deep-equals
`["src/commands/actor/revoke-actor.ts", "src/commands/startup/recover-expired-leases.ts", "src/main.ts"]`.
Two of those files no longer import the service and the third no longer exists under that name, so the
assertion cannot pass. Delete it and let case 3 below take its place: an empty importer set is the same
claim, made against a tree the service has left.

**`src/domain/lease-hierarchy.ts` is not deleted here.** Story 7 deletes it, once this story has
orphaned it: `src/services/lease/index.ts:2` and `sqlite.ts:3-6` are its last two importers, and EPIC 050.4 Story 8 (`08-lease-held-is-retired`) removed the contract package's.

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
- Delete `test/helpers/lease.ts` whole. Do not keep `createBackedLeaseFake` against raw SQL: a lease row is seeded by `test/helpers/rows.ts`, which imports no lease module and survives to EPIC 057.
- Take the `:101` count to twenty, not twenty-one. No story of this epic adds a capability.
- Repair only the five importers the table assigns to this story. Report a survivor in the other two groups rather than fixing it here.

## Verify

```
node --test src/main.test.ts src/http/contract/parity.test.ts src/domain/layout.test.ts src/commands/outcome/close-objective.test.ts src/commands/actor/rotate-actor-token.test.ts src/http/server/actor/rotate-actor-token.test.ts src/http/server/actor/registration.test.ts src/queries/actor/list-actor.test.ts
```

Add, each as a separate `it`:

1. `"src/services/lease is absent"` — assert by a directory listing rather than by an import, which would fail to resolve the test itself.

1b. `"test/helpers/lease.ts is absent"` — the same directory listing, over `test/helpers/`. A helper that survives its service is a module nothing can resolve.

1c. `"no test file imports test/helpers/lease.ts"` — enumerate every `*.test.ts` under `src/` and assert none holds a matching import specifier. Report the file names on failure. Case 3 covers production files and case 4 covers the identifier; neither sees a test helper, which is how this deletion was missed.

1d. `"the service inventory names no lease"` — the shipped `src/domain/layout.test.ts:101` case with `"lease"` removed and the suite name at twenty, and the `:151` case over `agent`, `verify` and `worker-health` alone.

2. `"src/main.ts imports nothing from services/lease"` — an import-graph assertion over that one file. `main.ts` exports no dependency map to introspect — it is the composition root and `src/main.test.ts` drives the daemon through its routes — so the import graph is the decidable proof, and it is exact: the implementation cannot be constructed without importing it.

3. `"no production file imports services/lease"` — enumerate every non-test file under `src/` and assert none holds an import specifier matching `services/lease`. Assert the offending list is empty and report the file names on failure.

4. `"no production file names LeaseError"` — the identifier, not the substring.

5. `"every shipped main.test case still passes"` — the production handler map is asserted unchanged apart from the removed dependency.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/main.test.ts` in `PASS EPIC-050.5`.
