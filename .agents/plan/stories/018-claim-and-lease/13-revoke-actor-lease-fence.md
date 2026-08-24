# Story 13 — Revocation fences the live leases of the revoked actor

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 3, Story 7, Story 9, Story 10. **Depends on EPIC 015**, which authors `src/commands/actor/revoke-actor.ts` and its test.

`.agents/plan/epics/015-actor-identity.md:29` decides the policy and assigns the mechanism here: EPIC 018 implements the fence when `lease.owner_kind` exists. Migration 0007 creates that column, so this epic takes the obligation and closes it.

## Change

All edits are in `src/commands/actor/revoke-actor.ts`, the file EPIC 015 created.

- `RevokeActorDependencies` gains `lease: Lease` and `clock: Clock`. A command names a service interface; `src/main.ts` binds `SqliteLease` there in Story 17.
- Inside the revocation transaction, **after** the `revoked_at` and `revoked_by` stamp and **before** the `actor.revoked` append, call:

  ```ts
  const fenced = dependencies.lease.expireLeasesOfOwner(transaction, {
    owner: input.actorId,
    now,
  });
  ```

  `now` is one `clock.now()` read once for the whole transaction.

- Write `fenced.length` into the `leasesFenced` key of the `actor.revoked` payload that `.agents/plan/epics/015-actor-identity.md:57` already declares. The payload key set does not otherwise change.

`expireLeasesOfOwner` sets `expires_at = now` on every live lease the revoked actor owns, and it keeps `owner`, `owner_kind` and `fence`. **Clearing `owner` in place is wrong**: a cleared lease has a null `expires_at`, so the sweep never reads it and the task stays `running` for ever.

**Nothing else changes.** No attempt closes, no run ends and no node state moves in that transaction, which is what the policy requires. The work returns to the pool at the next `node.claim`, through the one sweep of Story 9, so it leaves the pool for no part of the lease term.

**The objective lease is fenced by the same statement as a task lease**, because both are `lease` rows the actor owns, so a revoked harness releases its whole objective and not only its current task.

A revocation of the bootstrap `human` actor is still `400 invalid-request` with `details.refusal = "bootstrap-actor"`, so it never reaches this path. A second revoke of the same actor still returns the same view with `200`; on that second call the actor owns no live lease, so `leasesFenced` is `0`.

## Constraints

- One transaction, shared with the revocation stamp and the event append.
- One `clock.now()`.
- Call `expireLeasesOfOwner` and nothing else on `Lease`. Do not call `release`, `acquire` or `endRun`.
- Do not close an attempt, do not end a run and do not move a node state in this command.
- Do not add a `Storage` transaction of its own, and do not import `src/commands/startup/recover-expired-leases.ts`.
- Do not import `src/commands/node/claim-node.ts`, in the command or in its test.
- Do not change any other key of the `actor.revoked` payload.
- Do not weaken the bootstrap refusal.

## Verify

`src/commands/actor/revoke-actor.test.ts` — extend the file EPIC 015 authored. Keep every existing assertion green.

**This test calls no other command.** `src/domain/layout.test.ts:177` asserts no file under `src/commands/` imports another command module, and a command test that reaches `claimNode` to build its fixture reintroduces exactly that coupling in the test tree. **Seed the lease rows directly** with plain `INSERT INTO lease` inside the test's own `storage.transact`: one row for the objective and one for the task, each with the harness's actor id as `owner`, `owner_kind` of `actor`, a known `fence`, and an `expires_at` in the future. That is the state a claim leaves, and this suite asserts what a revocation does to it — not how it came about. Story 10 owns the proof that a claim writes those rows.

- `a revocation fences both the task lease and the objective lease of a harness` — seed the two rows as above, revoke, then assert **both** carry `expires_at` equal to the revocation instant, an **unchanged** `owner`, an **unchanged** `owner_kind` and an **unchanged** `fence`. Assert all four columns per row.
- `the actor.revoked payload carries leasesFenced 2` — assert the exact payload value.
- `a revocation closes no attempt, ends no run and moves no node state` — assert the `attempt`, `run` and `node` rows are deep-equal before and after, row by row.
- `a revoked actor with no lease records leasesFenced 0 and writes no lease row` — assert the payload and assert the `lease` table is deep-equal before and after.
- `the fenced rows are sweepable` — after the revocation, assert both rows satisfy the sweep's own predicate: `owner IS NOT NULL AND expires_at IS NOT NULL AND expires_at <= now`. That is what proves the work returns to the pool at the next claim. **Assert the predicate, not a `claimNode` call**: the end-to-end proof that a second actor then takes the task belongs to `src/main.claim.test.ts` of Story 17, which drives it over HTTP through the real composition root.
- `a revocation touches no lease of another actor` — a second harness holds its own objective and task; assert both its rows are deep-equal before and after.
- `revoking the bootstrap actor is still refused and fences nothing` — assert the refusal and assert the `lease` table is deep-equal before and after.

Run:

- `node --test src/commands/actor/revoke-actor.test.ts src/services/lease/sqlite.test.ts` exits 0.
- `npm run typecheck` exits 0. `RevokeActorDependencies` gained two members, so **this story also updates the one call site** in `src/main.ts` to pass `lease` and `clock`. Story 9 already constructs `lease` there. A story that changes a required signature updates its call sites in the same story.
- Proof: `PASS EPIC-018`, through `src/commands/actor/revoke-actor.test.ts`. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:195`.
