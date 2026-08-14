# EPIC 018 — Claim, lease and the execution record — stories

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Prereq: EPIC 017 (sequence order), and through it EPICs 014, 015 and 016.

A harness claims a `ready` task through `POST /v1/node/:id/claim` against the real composition root, takes the objective scope, keeps the claim alive through `POST /v1/node/:id/heartbeat`, gives it back through `POST /v1/node/:id/release`, and an expired lease returns its task to the pool at the next claim with no daemon restart and no timer.

## Dispatch order

`01` → `02`+`03`+`04` → `05` → `06` → `07` → `08` → `09` → `10`+`11` → `12` → `13` → `14` → `15` → `16` → `17` → `18`

Two coupled groups. **Do not run a verify gate inside a group.**

- **`02`+`03`+`04`** — the proposal fence rewrite, migration 0007, and the parity split. `02` alone turns `src/services/storage/migration-0003-execution-and-journal.test.ts` red; `04` is what makes it green.
- **`10`+`11`** — `claimNode` and its ancestor cascade. The cascade is a private function of the same file.

`npm run verify` is red from `01` until `14`, on `src/http/contract/parity.test.ts` only: `01` adds three proposal rows and `14` adds the matching registry rows. That is the intended coupling of a proposal-first amendment. It is green at the close of `04` for everything else, and green at the close of `14` for everything.

## Stories

- 1 — the proposal amendment: three routed rows, the objective-scope section, the amended `running → ready` note → `01-proposal-amendment.md`
- 2 — the database document amendment: the post-0007 fences of `run`, `attempt` and `lease` → `02-database-document-amendment.md`
- 3 — migration 0007, the foreign-key-safe rebuild of three tables → `03-migration-0007-external-execution.md`
- 4 — migration parity, split in two questions → `04-migration-parity.md`
- 5 — the lease hierarchy as a pure function → `05-lease-hierarchy.md`
- 6 — the two external transition rows, and the rise from six trigger ids to eight → `06-external-transition-rows.md`
- 7 — `services/lease` gains its complete interface and `SqliteLease` → `07-services-lease.md`
- 8 — `services/execution`, the run and attempt record → `08-services-execution.md`
- 9 — the startup sweep and the claim-time sweep become one function → `09-the-sweep.md`
- 10 — `claimNode`, the command → `10-claim-node.md`
- 11 — the ancestor start cascade → `11-ancestor-start-cascade.md`
- 12 — `heartbeatNode`, `releaseNode` and the heartbeat protocol → `12-heartbeat-and-release.md`
- 13 — revocation fences the live leases of the revoked actor → `13-revoke-actor-lease-fence.md`
- 14 — the three routes and their contract entries → `14-routes-and-contract.md`
- 15 — `node.list` filters → `15-node-list-filters.md`
- 16 — the CLI commands, registered → `16-cli-commands.md`
- 17 — the composition root binds every route this epic adds → `17-composition-root.md`
- 18 — what EPIC 110 consumes from this epic → `18-epic-110-reconciliation.md`

## Facts (needed for implementation)

### Greenfield gaps — none of these exists in the repository today

- `src/commands/node/` does not exist. Stories 10, 11 and 12 create it.
- `src/services/execution/` does not exist. Story 8 creates it.
- `src/services/lease/sqlite.ts` does not exist; `src/services/lease/not-implemented.ts` refuses every method. Story 7 creates the implementation.
- `src/domain/lease-hierarchy.ts` does not exist. Story 5 creates it.
- `src/cli/node/` does not exist. Story 16 creates it.
- `src/main.claim.test.ts` and `src/main.readiness.test.ts` do not exist; the only daemon-backed application test is `src/main.test.ts`.
- The highest migration in the repository is **0004** (`src/services/storage/migrations.ts:7-12`). EPIC 015 takes 0005, EPIC 017 takes 0006, this epic takes 0007.
- `src/commands/actor/`, `src/domain/external-transition.ts`, `src/domain/node-trigger.ts` and `src/domain/plan-completeness.ts` do not exist. EPICs 014, 015 and 016 create them, and this epic extends them.
- `src/main.ts` constructs **no** `Lease` at all today, neither `SqliteLease` nor `NotImplementedLease`.

### Two stated amendments to the EPIC

Both are recorded here so a reviewer finds them without reading all eighteen files.

- **`Lease.release` clears five columns, not four.** `.agent/plan/epics/018-claim-and-lease.md:81` enumerates four cleared columns for a release and leaves `acquired_at` set, while the expiry sweep at `:108` clears five. Two paths that both free a lease must leave the same row shape, so Story 7 clears `acquired_at` on the release too. `fence` is the only column that survives either path. Story 7 and Story 9 assert the **same literal row shape**, so the amendment has a mechanism and not only a sentence.
- **The two parity counts are absolutes, derived, and guarded.** `.agent/plan/epics/018-claim-and-lease.md:115` says the counts at `src/http/contract/parity.test.ts:16,25` "rise by three". A relative delta applied to an unverified base hides a sibling epic's contract change behind a green test. Story 14 therefore writes the absolutes `65` and `69`, derived in a table from the route counts of EPICs 014 to 018, and **stops and reports to the human** when the pre-edit values are not `62` and `66`. Story 1 records the pre-edit values in its commit message as the input to that guard.

### Gotchas

- **`Transaction` has no row count.** `src/services/storage/index.ts:1-5` gives `run`, `get` and `all`, and `run` returns `void`. Every conditional lease write therefore runs through `transaction.all` with a `RETURNING` clause, and an empty result is the refusal. Add no `Transaction` method, and do not use `SELECT changes()`.
- **`lease` is not prepopulated.** A conditional `UPDATE` alone changes zero rows for ever, so `acquire` needs the `INSERT ... ON CONFLICT` upsert of Story 7.
- **`recoverExpiredLeases` opens one transaction per row today**, inside `writeVerdict` at `src/commands/startup/recover-expired-leases.ts:141`. Story 9 keeps that shape for the internal partition and runs the external partition in one caller-supplied transaction.
- **The current sweep bumps the fence** at `src/commands/startup/recover-expired-leases.ts:151`, and reports `row.fence + 1` at `:168`. Story 9 removes both. Safety comes from the owner match, not from a bump.
- **`src/cli/client.ts` renders no query string.** `CallInput` at `:12-16` carries no `query` and `buildRequest` at `:38-79` appends none. `node list` needs one, and Story 16 adds it with a bytewise key order.
- **`src/cli/client.ts` sets no `Idempotency-Key` header.** Story 16 adds an optional `idempotencyKey` member, because `node heartbeat` must mint a fresh one per call.
- **A real daemon runs `SystemClock`.** `src/main.claim.test.ts` expires a lease by writing `lease.expires_at` through a second `node:sqlite` connection on the daemon's database, not by sleeping. WAL and `PRAGMA busy_timeout = 5000` at `src/services/storage/connection.ts:6-10` make that safe.
- **`registryFaults` has no `allowedActors` check today.** EPIC 015 adds the required member and the mechanism; this epic only declares three rows and extends EPIC 015's named assertion.
- **Event types are free strings.** `AppendEventInput.type` at `src/services/event/index.ts:8` is `string`, so `lease.claimed`, `lease.renewed`, `lease.released` and `recovery.leaseRecovered` need no registry edit. `actorKind` at `:3` is a closed union that EPIC 015 widens with `harness`.
- **`legacy_alter_table` is mandatory in the rebuild.** With the pragma off, `ALTER TABLE run RENAME` repoints `attempt`, `agent_invocation`, `candidate`, `check_result` and `git_operation` at the temporary name, which is the opposite of the wanted result.
- **`node.parent_id` carries no index** in `src/services/storage/migration-0002-graph-and-plan.ts`, and none is added. The claim-time completeness read is one full-graph read, O(nodes + edges), under the 2000-node bound.
- **A new `src/services/*` directory needs no eslint edit.** `boundaries/elements` at `eslint.config.js:67` matches `src/services/*`. `src/domain/layout.test.ts:101-125` does hold an exact capability name list, and Story 8 adds `execution` to it.
- **`node.repositoryId` is non-null on an objective only**, by the refine at `src/domain/node.ts:29-31`. Story 15's `repository` filter resolves a task through its parent and never matches an initiative.

### Anchors to mirror

- The version-3 DDL of `run`, `run_one_active`, `attempt` and `lease`: `src/services/storage/migration-0003-execution-and-journal.ts:20-60`. The ten-statement order is `workspace`, `lease`, `run`, `run_one_active`, `attempt`, `agent_invocation`, `candidate`, `check_result`, `git_operation`, `event`.
- The rename-first rebuild sequence: `.agent/plan/epics/017-per-node-graph-write.md:55-64`.
- The frozen-historical-DDL precedent: `.agent/plan/epics/017-per-node-graph-write.md:67`.
- `assertClauseAgrees` and `tableDdl`: `src/services/storage/schema-parity.test.ts:30-68`. Story 4 exports `assertClauseAgrees` rather than copying it.
- The refusal-mapper pattern: `src/http/server/plan/refusals.ts`.
- The single-valued query pattern: `src/http/server/event/list-event.ts:18` and `src/http/server/single.ts:5`.
- The CLI command and group pattern: `src/cli/project/list.ts` and `src/cli/project/index.ts`.
- The CLI test harness pattern: `src/cli/project/list.test.ts:22-60`.
- The daemon-backed test pattern: `src/main.test.ts:1-30`, `test/helpers/daemon.ts:29` and `test/helpers/home.ts:11`.
- The capability-with-transaction-first pattern: `src/services/event/index.ts:46-52`.
- `accountAttempts`: `src/domain/attempt-accounting.ts:32-82`. `nextAttemptNo` is `counter + 1`, computed from the rows.
