# Story 8 — `recover-expired-leases` writes through the mutation API

Epic: `.agent/plan/epics/016-readiness-applied.md`
Depends on: Story 4 and Story 5.

**Member of the atomic unit 04 + 05 + 07 + 08 + 10.** Run every member before `npm run verify`; no intermediate state of the unit typechecks. See `index.md` for why.

## Change

### `src/commands/startup/recover-expired-leases.ts`

Add `plan: PlanStore` to `RecoverExpiredLeasesDependencies` at `src/commands/startup/recover-expired-leases.ts:10-15`, after `storage`. Import the type from `../../services/plan/index.ts`.

Rewrite `writeVerdict` at `:130-172`.

- Delete the `canTransition` guard at `:142-144`. `setNodeState` performs it.
- Delete the `import { canTransition } from "../../domain/transition.ts";` line when no other use remains in the file.
- Replace the raw `transaction.run("UPDATE node SET ...")` at `:146-149` with:

```ts
dependencies.plan.setNodeState(transaction, {
  id: row.subject_id,
  from: "running",
  to: verdict.target,
  trigger:
    verdict.target === "ready" ? "recovery-requeued" : "recovery-blocked",
  blockReason: verdict.target === "ready" ? null : "dirty-recovery",
  at: now,
  cause: { revision: row.revision, importId: null },
});
```

- Keep the `blockReason` derivation of `:145` as the `blockReason` argument. Delete the now-unused local when it has no second reader.
- Keep the `UPDATE lease` statement at `:150-153` unchanged. It touches no node row and no edge row.
- Keep the `recovery.leaseRecovered` and `recovery.leaseBlocked` appends at `:154-170` unchanged, with `actorKind: "daemon"` and `actorId: actor`.

`row.revision` is the node revision. `CANDIDATE_SQL` at `:34-45` does not select it today. Add `n.revision AS revision` to the select list and add `revision: string` to `CandidateRow`. Change no `WHERE`, no `JOIN` and no `ORDER BY` of that statement.

### `src/main.ts`

`src/main.ts:191-195` constructs the `recoverExpiredLeases` dependency bag. Add `plan` to it. Story 10 owns the construction order that makes `plan` available at that point; this story only adds the member.

## Constraints

- Do not add a readiness argument, a readiness import or a readiness call to this command. `setNodeState` applies readiness for it.
- Do not change the two-transaction shape. The candidate read at `:52-54` stays its own transaction, and each `writeVerdict` stays its own transaction at `:141`.
- Do not change the git calls at `:89-94` and do not change `RecoverExpiredLeasesResult`.
- The command imports no service implementation. `eslint.config.js:248-274` bans `node:sqlite`, `node:fs` and every vendor package here.
- `running → ready` and `running → blocked` both turn one non-satisfying state into another, so `readiness.apply` returns an empty list for each. Do not add a special case and do not add an exempt-file list.

## Verify

### `src/commands/startup/recover-expired-leases.test.ts`

- `runRecover` at `src/commands/startup/recover-expired-leases.test.ts:341-354` gains a `plan` member. Supply a **recording `PlanStore` fake** that wraps `createPlanStore(createReadiness(fixture.events, "daemon_test"))` from `test/helpers/plan.ts`: every method delegates, and `setNodeState` pushes its `input` onto a local array before delegating. The real store still writes, so every existing row assertion holds.
- Add `it("a clean expired lease writes running to ready under recovery-requeued", ...)`. Assert the recorded `setNodeState` input deep-equals `{ id: TASK_A, from: "running", to: "ready", trigger: "recovery-requeued", blockReason: null, at: <the fixture clock value>, cause: { revision: <the seeded node revision>, importId: null } }`.
- Add `it("a dirty expired lease writes running to blocked under recovery-blocked", ...)`. Assert the recorded input deep-equals the same shape with `to: "blocked"`, `trigger: "recovery-blocked"` and `blockReason: "dirty-recovery"`.
- Add `it("readiness returns an empty transition list for both recovery writes", ...)`. Assert the value `setNodeState` returned is `[]` for each of the two verdicts, captured by the recording fake.
- Add `it("recovery appends no node.ready and no node.pending event", ...)`. Read the events through `fixture.listEvents()` and assert the count of `node.ready` and of `node.pending` is `0` before and after the run.
- Every existing assertion in the file stays. `readNode` at `:356-364` and `readLease` at `:366-377` need no change, and the row assertions at `:447-456` must still pass field for field.
- The domain test at `:815` (`canTransition pins the guard's premise for both targets`) stays word for word. It asserts the matrix, not the deleted guard.
- `node --test src/commands/startup/recover-expired-leases.test.ts src/services/plan/sqlite.test.ts` exits 0.
- `grep -c "UPDATE node" src/commands/startup/recover-expired-leases.ts` returns `0`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/commands/startup/recover-expired-leases.test.ts`. Hermetic coverage: `.agent/plan/epics/016-readiness-applied.md:104`.
