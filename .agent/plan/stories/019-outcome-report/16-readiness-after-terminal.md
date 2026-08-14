# Story 16 — Readiness after a terminal transition

Epic: `.agent/plan/epics/019-outcome-report.md`
Depends on: Stories 7, 9, 10, 11.

**This story adds no production code.** EPIC 016 derives readiness inside `PlanStore.setNodeState`, and every node state write of this epic already runs through it. The story exists to prove that, because the mechanism is a boundary rather than a call each command makes.

## Change

Audit and assert only. Confirm by reading each command file that **no** state write of this epic bypasses `plan.setNodeState`:

- `src/commands/outcome/report-outcome.ts`
- `src/commands/outcome/report-objective.ts`
- `src/commands/outcome/close-objective.ts`
- `src/commands/outcome/aggregate-initiative.ts`

None of the four runs an `UPDATE node` statement, and none writes `state` or `block_reason` through `transaction.run`. If one does, that is a defect in the story that wrote it; fix it there.

## Constraints

- Add no exempt-command list anywhere. The mutation boundary of `016-readiness-applied.md:49` is the mechanism.
- Add no second readiness call and no second `node.ready` event. `deriveReadiness` stamps `readiness-promoted` and `readiness-demoted` itself.
- Do not widen `MutateGraphInput` or `SetNodeStateInput`.

## Verify

Add these assertions to the test file of the command each one covers, over real sqlite.

- In `src/commands/outcome/report-outcome.test.ts`: `it("an accepted task report promotes a dependent task", ...)` — the dependent task moves `pending → ready` in the same transaction, exactly one `node.ready` event is appended with `actorKind: "daemon"` and the daemon instance id, and the promotion carries the readiness trigger.
- In the same file: `it("a rejected, a failed and a cancelled report promote nothing", ...)` — three cases; the dependent task stays `pending` and no `node.ready` event is appended. `running → ready` turns one non-satisfying state into another.
- In the same file: `it("a report at the limit promotes nothing", ...)` — `running → blocked` promotes nothing.
- In `src/commands/outcome/report-objective.test.ts`: `it("the attestation promotes nothing", ...)` — `running → awaiting_approval` promotes nothing, and no `node.ready` event is appended for the objective's dependents.
- In `src/commands/outcome/close-objective.test.ts`: `it("the close promotes a dependent objective", ...)` — one `node.ready` event with `actorKind: "daemon"`, inside the same transaction. Assert the same for a `partial` close, because `partial` satisfies a dependency per `docs/proposal/phase-1/state-machine.md:117`.
- In `src/commands/outcome/aggregate-initiative.test.ts`: `it("the roll-up promotes a dependent initiative", ...)` — one `node.ready` event with `actorKind: "daemon"`.
- In each case assert the readiness event and the transition event are two events of one transaction, distinguished by `actorKind`.
- `node --test src/commands/outcome/report-outcome.test.ts src/commands/outcome/report-objective.test.ts src/commands/outcome/close-objective.test.ts src/commands/outcome/aggregate-initiative.test.ts src/services/readiness/dependency.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: the four `src/commands/outcome/*.test.ts` paths of the Proof block. Hermetic coverage: `019-outcome-report.md:164`.
