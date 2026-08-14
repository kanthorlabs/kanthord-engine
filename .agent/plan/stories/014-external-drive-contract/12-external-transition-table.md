# Story 12 — The external transition table

Epic: `.agent/plan/epics/014-external-drive-contract.md`
Depends on: Story 6 (`RunDriver`). Stories 13, 14 and 15 build on this file; run them after it, in numeric order.

## Change

### A new `src/domain/external-transition.ts`

It imports `type NodeKind` and `type NodeState` from `./state.ts`, and `type RunDriver` from `./run.ts`. It imports nothing else, and it imports no `zod`.

Export the trigger tuple first, in the row order below:

```ts
export const externalTriggerIds = [
  "attempt-rejected",
  "outcome-accepted",
  "attempt-limit-reached",
  "object-reported",
  "human-close",
  "human-close-partial",
] as const;
export type ExternalTriggerId = (typeof externalTriggerIds)[number];
```

Then the two types. `ExternalPrecondition` is a total record of seven closed fields, and **no field is optional**:

```ts
export type ExternalPrecondition = Readonly<{
  runDriver: RunDriver;
  activeRun: boolean;
  leaseFence: "valid" | "none";
  actorKind: "human" | "daemon" | "harness";
  attemptLimit: "under" | "reached" | "not-applicable";
  reportedObjectId: "required" | "absent";
  childAggregation:
    | "every-task-terminal-one-done"
    | "every-task-done"
    | "at-least-one-task-discarded"
    | "not-applicable";
}>;

export type ExternalTransition = Readonly<{
  level: NodeKind;
  from: NodeState;
  to: NodeState;
  trigger: ExternalTriggerId;
  precondition: ExternalPrecondition;
}>;
```

Then the six rows, exactly these, in exactly this order. Every row carries `runDriver: "external"` and `activeRun: true`.

```ts
export const externalTransitions: readonly ExternalTransition[] = [
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "attempt-rejected",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "under",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "done",
    trigger: "outcome-accepted",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "task",
    from: "running",
    to: "blocked",
    trigger: "attempt-limit-reached",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "reached",
      reportedObjectId: "absent",
      childAggregation: "not-applicable",
    },
  },
  {
    level: "objective",
    from: "running",
    to: "awaiting_approval",
    trigger: "object-reported",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "valid",
      actorKind: "harness",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "every-task-terminal-one-done",
    },
  },
  {
    level: "objective",
    from: "awaiting_approval",
    to: "done",
    trigger: "human-close",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "human",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "every-task-done",
    },
  },
  {
    level: "objective",
    from: "awaiting_approval",
    to: "partial",
    trigger: "human-close-partial",
    precondition: {
      runDriver: "external",
      activeRun: true,
      leaseFence: "none",
      actorKind: "human",
      attemptLimit: "not-applicable",
      reportedObjectId: "required",
      childAggregation: "at-least-one-task-discarded",
    },
  },
] as const;
```

Six of the seven cells the block needs are already legal, so the external drive is data about the trigger of a cell rather than a new matrix row.

## Constraints

- The set is exact at the close of this epic: **exactly these six external triggers.** EPIC 018 adds `claim-released` and `claim-expired` and reaches eight, per `018-claim-and-lease.md:102,207`. EPIC 019 adds `attempt-failed` and `report-cancelled` and reaches **ten**, per `019-outcome-report.md:66,165`. Add none of them here.
- **The progression is 6 → 8 → 10.** The three initiative aggregation triggers are **internal**, per `.agent/plan/epics/014-external-drive-contract.md:41` and `019-outcome-report.md:66`, so they enter no external total. Story 13 declares them in `internalTransitions`. An earlier EPIC draft said thirteen by counting them as external; `:37` and `:83` now read ten.
- Add no internal trigger. Story 13 owns the internal table, and no internal trigger enters `externalTransitions`.
- Add no `objectiveDrivePin` and no `externalTriggerConsumer`. Stories 14 and 15 add them to this file.
- Every field of `ExternalPrecondition` is required. Do not mark one optional and do not give one a default.
- `src/domain/layout.test.ts:55-66` asserts every non-test file in `src/domain/` names no `Date.now(`, `new Date(` or `Math.random(`. This file reads no clock.
- Add no consumer. EPIC 019 is the writer of `objective running → awaiting_approval`; this row is the contract it reads.

## Verify

- Add `src/domain/external-transition.test.ts` with the suite name `"src/domain/external-transition.test"`. It imports `canTransition` from `./transition.ts`.
- Assert `externalTransitions.length === 6`.
- Assert every row names a legal cell: for each row, `canTransition(row.level, row.from, row.to) === true`. A row that names an illegal cell fails.
- Assert the trigger id set exactly: `externalTransitions.map((row) => row.trigger)` deep-equals `[...externalTriggerIds]`, `externalTriggerIds.length === 6`, and `new Set(externalTriggerIds).size === 6` so each id appears once. This assertion pins six ids at the close of this epic. EPIC 018 raises it to eight and EPIC 019 raises it to ten, each in its own change.
- Assert every precondition field by field against the six rows above. Write the six expected `{ level, from, to, trigger, precondition }` objects as literals and `assert.deepEqual(externalTransitions, expected)`, then add one `it` per trigger that reads the row by trigger id and asserts each of the seven precondition fields with a separate `assert.equal`.
- Assert `runDriver === "external"` and `activeRun === true` on every row.
- Assert the `object-reported` row carries `leaseFence: "valid"` and `actorKind: "harness"`.
- Assert the `outcome-accepted` row carries `reportedObjectId: "required"`.
- `node --test src/domain/external-transition.test.ts src/domain/transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`, with `src/domain/external-transition.test.ts` named explicitly in the Proof block. Hermetic coverage: the legal-cell bullet at `.agent/plan/epics/014-external-drive-contract.md:82`, the exact-id bullet at `:83` and the two-row bullet at `:84`.
