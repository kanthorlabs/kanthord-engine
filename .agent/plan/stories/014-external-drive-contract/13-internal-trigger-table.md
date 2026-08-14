# Story 13 — The internal trigger table

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: Story 12 (this file imports `ExternalTriggerId` and `externalTransitions`) and Story 2 (the `readiness-demoted` row names `ready → pending`, which is illegal until the flip lands).

## Change

### A new `src/domain/node-trigger.ts`

It imports `type NodeKind` and `type NodeState` from `./state.ts`, and `externalTransitions`, `externalTriggerIds` and `type ExternalTriggerId` from `./external-transition.ts`. It imports nothing else.

Export the internal trigger tuple first, in the row order below:

```ts
export const internalTriggerIds = [
  "readiness-promoted",
  "readiness-demoted",
  "claim-taken",
  "ancestor-started",
  "recovery-requeued",
  "recovery-blocked",
  "worker-objective-started",
  "worker-task-started",
  "worker-task-accepted",
  "worker-attempt-limit-reached",
  "run-cancelled-requeued",
  "run-cancelled-abandoned",
  "initiative-aggregated-done",
  "initiative-aggregated-partial",
  "initiative-aggregated-discarded",
] as const;
export type InternalTriggerId = (typeof internalTriggerIds)[number];
export type NodeTriggerId = ExternalTriggerId | InternalTriggerId;
```

Then the row type. **An internal row carries no precondition**, because an `ExternalPrecondition` states what an external actor presents and an internal write presents nothing. **An internal row declares `levels` and not one `level`**, because the readiness pass writes one pair at all three levels from one call site:

```ts
export type InternalTransition = Readonly<{
  levels: readonly NodeKind[];
  from: NodeState;
  to: NodeState;
  trigger: InternalTriggerId;
}>;
```

Every `levels` list is non-empty, holds no duplicate, and holds `initiative`, `objective` and `task` in that fixed order.

Then the fifteen rows, exactly these, in exactly this order:

```ts
export const internalTransitions: readonly InternalTransition[] = [
  {
    levels: ["initiative", "objective", "task"],
    from: "pending",
    to: "ready",
    trigger: "readiness-promoted",
  },
  {
    levels: ["initiative", "objective", "task"],
    from: "ready",
    to: "pending",
    trigger: "readiness-demoted",
  },
  {
    levels: ["objective", "task"],
    from: "ready",
    to: "running",
    trigger: "claim-taken",
  },
  {
    levels: ["initiative", "objective"],
    from: "ready",
    to: "running",
    trigger: "ancestor-started",
  },
  {
    levels: ["task"],
    from: "running",
    to: "ready",
    trigger: "recovery-requeued",
  },
  {
    levels: ["task"],
    from: "running",
    to: "blocked",
    trigger: "recovery-blocked",
  },
  {
    levels: ["objective"],
    from: "ready",
    to: "running",
    trigger: "worker-objective-started",
  },
  {
    levels: ["task"],
    from: "ready",
    to: "running",
    trigger: "worker-task-started",
  },
  {
    levels: ["task"],
    from: "running",
    to: "done",
    trigger: "worker-task-accepted",
  },
  {
    levels: ["task"],
    from: "running",
    to: "blocked",
    trigger: "worker-attempt-limit-reached",
  },
  {
    levels: ["task"],
    from: "running",
    to: "ready",
    trigger: "run-cancelled-requeued",
  },
  {
    levels: ["objective"],
    from: "running",
    to: "blocked",
    trigger: "run-cancelled-abandoned",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "done",
    trigger: "initiative-aggregated-done",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "partial",
    trigger: "initiative-aggregated-partial",
  },
  {
    levels: ["initiative"],
    from: "running",
    to: "discarded",
    trigger: "initiative-aggregated-discarded",
  },
] as const;
```

Then one total pure resolver over a trigger of either table. It reads an external row's single `level` as a one-member list:

```ts
export function triggerTransition(
  trigger: NodeTriggerId,
): Readonly<{ levels: readonly NodeKind[]; from: NodeState; to: NodeState }>;
```

Implement it by looking the trigger up in `internalTransitions` first and returning `{ levels: row.levels, from: row.from, to: row.to }`, then in `externalTransitions` and returning `{ levels: [row.level], from: row.from, to: row.to }`. The two id sets are disjoint, so exactly one branch matches. Throw on no match, so the function stays total against a cast.

**The three initiative rows are internal and not external**, although `aggregateInitiative` of EPIC 019 runs inside an externally driven close: no actor presents anything for them, and the daemon derives the roll-up from the objective states.

## Constraints

- The set is exact at the close of this epic: **exactly these fifteen internal triggers.** EPIC 019 is the first epic that adds a row, and it is the one epic of this block that extends the set: it adds `manual-unblock` for `task blocked → pending`, and reaches sixteen at the close of the block. EPIC 111 is the next such epic, and it adds a row for `node.abandon` alone; its widening of the already-routed `node.unblock` declares no second trigger.
- Add no `precondition` field to `InternalTransition`. A record of seven `not-applicable` fields is the dead data this table exists to avoid.
- Do not move an external row to `levels`. An external row keeps its single `level`.
- Add no `externalTriggerConsumer` entry for an internal trigger. That map binds an external trigger to the command a harness must reach, and an internal trigger is reached by the daemon alone.
- `setNodeState` does not exist yet. `grep -rn "setNodeState" src/` returns nothing, and `src/services/plan/index.ts:39-78` `PlanStore` holds no state write. EPIC 016 creates `setNodeState` and makes its `trigger` parameter required over `NodeTriggerId`. **Do not create it here, and change no service interface.**
- Add no consumer of `triggerTransition`.

## Verify

- Add `src/domain/node-trigger.test.ts` with the suite name `"src/domain/node-trigger.test"`. It imports `canTransition` from `./transition.ts` and `externalTriggerIds` from `./external-transition.ts`.
- Assert `internalTransitions.length === 15` and `internalTriggerIds.length === 15`.
- Assert the internal id set exactly: `internalTransitions.map((row) => row.trigger)` deep-equals `[...internalTriggerIds]`, and `new Set(internalTriggerIds).size === 15` so each id appears once.
- Assert `levels`, `from` and `to` of each row field by field. Write the fifteen expected rows as literals and `assert.deepEqual(internalTransitions, expected)`.
- Assert every `levels` list is non-empty, holds no duplicate (`new Set(row.levels).size === row.levels.length`), and is ordered `initiative`, `objective`, `task`: filter `["initiative", "objective", "task"]` by membership in `row.levels` and deep-equal the result to `row.levels`.
- Assert every row names a legal cell at every level: for each row and each member of `row.levels`, `canTransition(level, row.from, row.to) === true`. A row that names an illegal cell at any level fails.
- Assert the internal id set and the external id set are disjoint: no member of `internalTriggerIds` appears in `externalTriggerIds`, and the union has size `21`.
- Assert `triggerTransition` is total over `NodeTriggerId`. For every member of `internalTriggerIds`, it returns the declared triple. For every member of `externalTriggerIds`, it returns a one-member `levels` list holding the declared `level` of that row plus the declared `from` and `to`. Every external trigger and every internal trigger is asserted.
- Assert the union of both tables covers every pair a command of EPICs 016, 018, 019 and 110 writes. Build the set of `` `${level}|${from}|${to}` `` over both tables, expanding each internal row across its `levels`, sort it, and `assert.deepEqual` it to exactly these nineteen entries:

```
initiative|pending|ready
initiative|ready|pending
initiative|ready|running
initiative|running|discarded
initiative|running|done
initiative|running|partial
objective|awaiting_approval|done
objective|awaiting_approval|partial
objective|pending|ready
objective|ready|pending
objective|ready|running
objective|running|awaiting_approval
objective|running|blocked
task|pending|ready
task|ready|pending
task|ready|running
task|running|blocked
task|running|done
task|running|ready
```

- `node --test src/domain/node-trigger.test.ts src/domain/external-transition.test.ts src/domain/transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`, with `src/domain/node-trigger.test.ts` named explicitly in the Proof block. Hermetic coverage: the legal-cell bullet at `.agent/plan/epics/014-external-drive-contract.md:87`, the exact-id bullet at `:88`, the disjoint bullet at `:89`, the `triggerTransition` bullet at `:90` and the pair-coverage bullet at `:92`.
