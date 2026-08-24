# Story 10 — `aggregateInitiative`

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Story 2 (the three internal triggers of EPIC 014).

## Change

### A new `src/commands/outcome/aggregate-initiative.ts`

```ts
export type AggregateInitiativeDependencies = Readonly<{
  plan: PlanStore;
  events: EventLog;
  clock: Clock;
  instanceId: string;
}>;

export type AggregateInitiativeInput = Readonly<{
  initiativeId: string | null;
  at: number;
}>;

export function aggregateInitiative(
  dependencies: AggregateInitiativeDependencies,
  transaction: Transaction,
  input: AggregateInitiativeInput,
): void;
```

It takes the caller's `transaction` and opens none of its own. It writes no run, because an initiative holds none.

The body runs in this exact order.

1. `input.initiativeId === null` returns without a write.
2. Read the initiative node. A state other than `running` returns without a write.
3. Read every objective of the initiative through `plan.readAllNodes(transaction)`, selecting the nodes whose `parentId` equals the initiative id, in bytewise node-id order.
4. Any non-terminal objective state returns without a write.
5. `const projected = aggregate("initiative", states)` of `src/domain/aggregation.ts:17`.
6. `const outcome = initiativeOutcome(projected, "not-applicable")` of `src/domain/outcome.ts:25`. `docs/proposal/phase-1/state-machine.md:43` records MVP end-to-end detection as `not-applicable`.
7. `plan.setNodeState(transaction, { id, from: "running", to: outcome.state, trigger, blockReason: outcome.blockReason, at: input.at, cause: { revision: node.revision, importId: null } })`, where `trigger` is `initiative-aggregated-done` for `done`, `initiative-aggregated-partial` for `partial` and `initiative-aggregated-discarded` for `discarded`.
8. Append one event:

```ts
dependencies.events.append(transaction, {
  subjectKind: "node",
  subjectId: node.id,
  type:
    outcome.state === "done"
      ? "node.done"
      : outcome.state === "partial"
        ? "node.partial"
        : "node.discarded",
  actorKind: "daemon",
  actorId: dependencies.instanceId,
  payload: {
    from: "running",
    to: outcome.state,
    reason: "objectives-terminal",
    objectiveStates: states,
  },
});
```

All three write paths ship. The `discarded` path is unreachable from a route of this block, because no route writes a `discarded` objective here; a later discard route needs no second change.

## Constraints

- `actorKind` is the literal `"daemon"` and `actorId` is the daemon instance identity of `016-readiness-applied.md:55`. No actor presents anything for a roll-up.
- The payload holds exactly four keys, in the order above. `objectiveStates` is the same ordered list step 3 read.
- Write no run row and call no `Execution` method. The dependency set names no `execution`.
- Return without a write on every early exit. Do not throw on a non-terminal objective set.
- Import no vendor package and no other command.

## Verify

Create `src/commands/outcome/aggregate-initiative.test.ts`, suite name `"src/commands/outcome/aggregate-initiative.test"`. Build the objective states directly in the database, because no route of this block writes a `discarded` objective.

- **Four objective sets, each asserting the written state, the trigger and the event type:**
  - `it("one partial objective gives partial", ...)` — a single `partial` objective; the initiative is `partial`, the trigger is `initiative-aggregated-partial`, the event is `node.partial`.
  - `it("done plus partial gives partial", ...)`.
  - `it("partial plus discarded gives partial", ...)`.
  - `it("every objective discarded gives discarded and never partial", ...)` — the trigger is `initiative-aggregated-discarded` and the event is `node.discarded`.
- `it("every objective done gives done", ...)` — the trigger is `initiative-aggregated-done` and the event is `node.done`.
- `it("the initiative stays running while one objective is not terminal", ...)` — the state is unchanged, no `setNodeState` call is recorded, and no event is appended.
- `it("a null initiative id writes nothing", ...)`.
- `it("an initiative that is not running writes nothing", ...)` — drive `done` and `partial`.
- `it("the event names the daemon instance", ...)` — `actorKind === "daemon"`, `actorId` equal to the constructed `instanceId`, and `Object.keys(payload)` deep-equal to `["from", "to", "reason", "objectiveStates"]`. Run the same fixture through two dependency objects with different `instanceId` values and assert the two recorded ids differ.
- `it("objectiveStates is ordered bytewise by node id", ...)` — a fixture with three objectives whose ids sort non-alphabetically by title; assert the recorded list order through `Buffer.compare`.
- `it("no run row is written", ...)` — `SELECT COUNT(*) FROM run` is unchanged.
- `node --test src/commands/outcome/aggregate-initiative.test.ts src/domain/aggregation.test.ts src/domain/outcome.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/commands/outcome/aggregate-initiative.test.ts`, `src/domain/aggregation.test.ts` and `src/domain/outcome.test.ts`. Hermetic coverage: `019-outcome-report.md:162` and the roll-up rows of `:168`.
