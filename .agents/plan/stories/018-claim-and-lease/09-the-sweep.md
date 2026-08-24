# Story 9 — The startup sweep and the claim-time sweep are one function

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 3, Story 7, Story 8, Story 6. EPIC 016 already moved this file to `plan.setNodeState`.

Recovery is claim-driven, not timer-driven. One `node.claim` anywhere returns every dead harness's task to `ready`, with no daemon restart, no background loop and no timer.

## Change

All edits are in `src/commands/startup/recover-expired-leases.ts`.

### The candidate query

`CANDIDATE_SQL` at `src/commands/startup/recover-expired-leases.ts:34-45` gains two selected columns, `r.id AS run_id` and `r.driver`. `CandidateRow` at `:25-32` gains `run_id: string | null` and `driver: string | null`. Change no clause of the `WHERE` and keep `ORDER BY l.subject_id`.

### The second entry point

Export a second function from the same file:

```ts
export type SweepExpiredExternalLeasesDependencies = Readonly<{
  plan: PlanStore;
  lease: Lease;
  execution: Execution;
  events: EventLog;
}>;

export type SweepExpiredExternalLeasesInput = Readonly<{
  actor: string;
  now: number;
}>;

export type SweepExpiredExternalLeasesResult = Readonly<{
  returnedToReady: number;
  objectivesFreed: number;
}>;

export function sweepExpiredExternalLeases(
  dependencies: SweepExpiredExternalLeasesDependencies,
  transaction: Transaction,
  input: SweepExpiredExternalLeasesInput,
): SweepExpiredExternalLeasesResult;
```

It takes the **caller's** transaction, so `claimNode` runs it inside its own. It is synchronous: no external row calls git.

It reads `CANDIDATE_SQL` with `input.now`, filters to the rows whose `driver` is `external`, and for each row in the returned `subject_id` order:

1. When `run_id` is not null, close every open attempt of that run through `execution.closeAttempt` with outcome `cancelled` and `at: input.now`, in `attemptsOfRun` order, then end the run through `execution.endRun` with outcome `expired` and `at: input.now`.
2. Clear the lease with one statement:

   ```sql
   UPDATE lease SET owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL
   WHERE subject_kind = 'node' AND subject_id = ?
   ```

   **The fence is left alone.** Safety comes from the owner match, not from a bump: after the sweep `owner` is null, so every later write that presents the old owner and the old fence finds no matching row.

   These are the same five columns `Lease.release` of Story 7 clears, so a released lease and a swept lease leave the identical row shape and only `fence` survives either path.

3. When `kind` is `task`, call `plan.setNodeState(transaction, { id: row.subject_id, from: "running", to: "ready", trigger: "claim-expired", blockReason: null, at: input.now, cause })` and count `returnedToReady`. When `kind` is `objective`, write **no** node state and count `objectivesFreed`. The objective state stays `running`.
4. Append one `recovery.leaseRecovered` event on the caller's transaction, `subjectKind: "node"`, `subjectId: row.subject_id`, `actorKind: "daemon"`, `actorId: input.actor`, payload `{ target, clean: false, headOid: null, baseOid: row.base_oid, fence: row.fence, driver: "external", runId: row.run_id }`. `target` is `ready` for a task and `running` for an objective. **`fence` is `row.fence` and not `row.fence + 1`.**

An external row calls **no** method of `Git`. It never writes `dirty-recovery`, because a task with no working tree has no tree to be dirty.

**One expired claim yields two candidate rows, and both are swept.** A task claim acquires an objective lease and a task lease on one `now` with one `leaseTtlMs`, so both expire at the same instant. `CANDIDATE_SQL` selects a `running` node with an expired lease, and an abandoned objective stays `running`, so both rows match. The sweep therefore emits **two** `recovery.leaseRecovered` events, in `subject_id` order, and the caller must expect two. It ends two runs, the objective run and the task run, and it moves one node state, the task's.

### `RecoverExpiredLeasesResult` gains one member

`objectivesFreed`, so the startup report distinguishes a freed objective from a requeued task. `LeasesResultLike` at `src/domain/recovery.ts:74-78` gains it, and `RecoveryReport` at `:87-97` gains it beside `returnedToReady`. `renderFinding` is unchanged. Without the member an external objective recovery is invisible in the startup output.

### The composition edit belongs to this story

`RecoverExpiredLeasesDependencies` gains `lease` and `execution` in this story, so **this story also updates the one call site**, `src/main.ts:190-194`, to pass them. `main.ts` already constructs neither, so this story adds `const lease = new SqliteLease();` and `const execution = new SqliteExecution({ ids });` after `events` at `src/main.ts:165`, and Story 17 then reuses those two bindings rather than creating them.

**A story that changes a required signature updates its call sites in the same story.** Leaving the binding to Story 17 makes `npm run typecheck` red from here to there for a reason no story declares, which defeats the gate for seven stories.

### `recoverExpiredLeases`

Restructure it to reuse the same function. It stays `async`, keeps its own `storage.transact` calls, and it keeps its `RecoverExpiredLeasesResult`.

1. Read the candidate rows once, as it does today at `:52-54`.
2. Partition the rows by `driver`. The external partition runs inside **one** `storage.transact`, which calls `sweepExpiredExternalLeases` with `{ actor: input.actor, now }`. Add its `returnedToReady` to the total.
3. The internal partition keeps today's per-row loop and today's per-row `storage.transact` inside `writeVerdict`. Reading the candidate rows twice is avoided by passing the partitioned rows into the internal loop.

Four defects are fixed with it.

- **The driver branch runs first.** The partition precedes the missing-workspace check at `:71-85`, not merely the git calls at `:90-94`. Under the current order an external run has no workspace and takes `recovery-inputs-missing` before the branch is ever read.
- **A non-task row is no longer refused outright.** Line 61 rejects every non-task. An **external objective** lease is now recovered by the function above. An internal non-task row keeps today's `lease-expired-on-non-task` finding, so move that check into the internal branch only.
- **The lease update at line 151 stops incrementing the fence.** `writeVerdict` on the internal path writes `owner = NULL, owner_kind = NULL, acquired_at = NULL, renewed_at = NULL, expires_at = NULL` and leaves `fence` alone. Clearing `owner_kind` beside `owner` is required by the null-agreement `CHECK` of migration 0007. The `fence` in the `recovery.leaseRecovered` payload at `:168` becomes `row.fence`.
- **The node write goes through `plan.setNodeState`.** EPIC 016 already made that change and already deleted `readinessObligated`, `readinessExempt`, `upsertNode`, `insertEdge` and `deleteEdge`. The internal rows keep the triggers EPIC 016 named: `running → ready` is `recovery-requeued`, and `running → blocked` is `recovery-blocked`. **Every earlier claim that this file "stays `readinessExempt`" is void**: no obligation registry exists, and the eslint rule of EPIC 016 fences every node write into `src/services/plan/sqlite.ts`.

`Git` stays in `RecoverExpiredLeasesDependencies` and is unused on the external path. `RecoverExpiredLeasesDependencies` gains `lease` and `execution` beside the `plan` EPIC 016 added, so it can pass them through.

## Constraints

- `sweepExpiredExternalLeases` opens no transaction. It takes the caller's.
- `sweepExpiredExternalLeases` reads no clock. `now` is an input.
- `sweepExpiredExternalLeases` is synchronous. An `async` signature would force `claimNode` to hold an open transaction across an `await`.
- The external path calls no method of `Git` and never writes the `dirty-recovery` block reason.
- No raw `UPDATE node` literal survives in the file. The eslint rule of EPIC 016 fails on one.
- The lease clear is a raw `UPDATE lease`, which no eslint rule forbids. Do not route it through `Lease.release`: `release` matches on owner and fence and raises `lease-fenced`, and the sweep has no live owner to present.
- Add no timer, no interval and no background loop anywhere in this story.
- `commands/` imports no other command. `claimNode` receives this function through `main.ts`, which Story 17 wires.

## Verify

`src/commands/startup/recover-expired-leases.test.ts` — extend, do not rewrite. Keep every existing internal-path assertion green. Use a `Git` fake that counts its calls, and the recording `PlanStore` fake EPIC 016 introduced.

- `the external task path returns the task to ready under trigger claim-expired` — assert the node state, the recorded `setNodeState` trigger, the run `outcome` is `expired`, the attempt `outcome` is `cancelled`, the lease `owner` is null and the lease `fence` is unchanged.
- `the external task path calls no method of the Git fake` — assert the fake's call count is exactly zero.
- `the external task path never writes dirty-recovery` — assert `block_reason` is null and no `recovery.leaseBlocked` event exists.
- `the external objective path ends the objective run and moves no node state` — assert the run `outcome` is `expired`, the lease `owner` is null, the objective `state` is still `running`, and the recording `PlanStore` fake recorded no call for that node.
- `the external objective path emits no lease-expired-on-non-task finding` — assert the findings list holds no such code.
- `an internal non-task lease still emits lease-expired-on-non-task`.
- `the driver branch precedes the missing-workspace check` — a fixture whose **external** run has no workspace and no `base_oid` still reaches `ready`, and the findings list holds no `recovery-inputs-missing`.
- `an internal lease with no workspace still emits recovery-inputs-missing` — the existing assertion, unchanged.
- `an internal lease over a dirty tree still writes dirty-recovery` — the existing assertion, unchanged, and the recorded trigger is `recovery-blocked`.
- `an internal lease over a clean tree at the base still reaches ready` — the existing assertion, and the recorded trigger is `recovery-requeued`.
- `the lease clear keeps the fence on both paths` — assert `fence` is equal before and after, for one external row and one internal row.
- `a swept row holds a null in every column but the fence` — assert the row deep-equals `{ subjectKind: "node", subjectId, owner: null, ownerKind: null, fence: <the pre-sweep fence>, acquiredAt: null, renewedAt: null, expiresAt: null }`, the **same literal shape** `src/services/lease/sqlite.test.ts` asserts for a released row. A released lease and a swept lease are therefore indistinguishable by row shape, which is what the Story 7 amendment exists for.
- `the recovery.leaseRecovered payload carries row.fence` — assert the payload `fence` equals the pre-sweep fence, and assert it does **not** equal that value plus one.
- `sweepExpiredExternalLeases runs inside a supplied transaction` — call it directly inside one `storage.transact`, throw after it returns, and assert the whole transaction rolled back: the node is still `running`, the run is still `active`, the attempt is still open and the lease still names its owner.
- `the sweep is deterministic in row order` — two expired external task leases whose identities sort in a known bytewise order; assert the `recovery.leaseRecovered` events appear in that order.
- `one expired claim yields two swept rows` — seed the state a real claim leaves, an expired **objective** lease and an expired **task** lease under it, both nodes `running`. Assert the sweep emits exactly **two** `recovery.leaseRecovered` events in `subject_id` order, ends **both** runs with outcome `expired`, closes the task's attempt `cancelled`, moves the task to `ready`, and leaves the objective `running`. Assert `returnedToReady` is `1` and `objectivesFreed` is `1`.
- `npm run typecheck exits 0 at the close of this story` — `src/main.ts` passes the two new dependencies, so no signature is left unsatisfied.
- `no raw node write survives in the file` — a `lintCase` assertion in the pattern of `src/domain/layout.test.ts:68`, driving the eslint rule of EPIC 016 over the file source.

Run:

- `node --test src/commands/startup/recover-expired-leases.test.ts src/domain/layout.test.ts` exits 0.
- Proof: `PASS EPIC-018`, through `src/commands/startup/recover-expired-leases.test.ts`. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:198-201`.
