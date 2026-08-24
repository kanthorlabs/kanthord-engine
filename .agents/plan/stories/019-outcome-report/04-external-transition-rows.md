# Story 4 — The two external transition rows and the two consumer entries

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Story 2. EPIC 018 raised the table to eight rows; this story raises it to ten.

## Change

### `src/domain/external-transition.ts`

Append two ids to `externalTriggerIds`, **after** the eight EPIC 018 leaves, in this order:

```ts
  "attempt-failed",
  "report-cancelled",
```

Append the two matching rows to `externalTransitions`, in the same order, at the end of the array:

```ts
  {
    level: "task",
    from: "running",
    to: "ready",
    trigger: "attempt-failed",
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
    to: "ready",
    trigger: "report-cancelled",
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
```

The two preconditions are field-identical to each other and to the `attempt-rejected` row of `.agents/plan/stories/014-external-drive-contract/12-external-transition-table.md`.

Add two entries to `externalTriggerConsumer`, keeping the key order of `externalTriggerIds`:

```ts
  "attempt-failed": "src/commands/outcome/report-outcome.ts",
  "report-cancelled": "src/commands/outcome/report-outcome.ts",
```

## Constraints

- Add no row for the three initiative roll-up triggers. `initiative-aggregated-done`, `initiative-aggregated-partial` and `initiative-aggregated-discarded` are internal, they live in `internalTransitions`, and an `ExternalPrecondition` on them would record seven `not-applicable` fields.
- `ExternalPrecondition` stays total. No field becomes optional, and the `childAggregation` union gains no member.
- Add no `aggregate-objective.ts` value. That file exists in no epic.
- Change no existing row and no existing consumer entry.
- Add no on-disk file check here. Story 12 owns it, because the four consumer files do not exist yet.

## Verify

Edit `src/domain/external-transition.test.ts`.

- Raise the exact-id assertion from eight to ten: `externalTriggerIds.length === 10`, `new Set(externalTriggerIds).size === 10`, and `externalTransitions.map((row) => row.trigger)` deep-equals `[...externalTriggerIds]`.
- Raise `externalTransitions.length` to `10`.
- `it("the attempt-failed row is field by field the failed report contract", ...)` — read the row by trigger id and assert each of the seven `ExternalPrecondition` members with a separate `assert.equal`, plus `level`, `from` and `to`.
- `it("the report-cancelled row is field by field the cancelled report contract", ...)` — the same seven plus three assertions.
- `it("both new rows name a legal cell", ...)` — `canTransition("task", "running", "ready") === true` read through each row's own `level`, `from` and `to`.
- `it("the three initiative roll-up triggers are internal", ...)` — assert each of `initiative-aggregated-done`, `initiative-aggregated-partial` and `initiative-aggregated-discarded` is absent from `externalTriggerIds` and present in `internalTriggerIds`, and assert `canTransition("initiative", "running", to) === true` for `done`, `partial` and `discarded`.
- Raise the `externalTriggerConsumer` totality assertion from six keys to ten: `Object.keys(externalTriggerConsumer).length === 10`, every member of `externalTriggerIds` is a key, every key is a member of `externalTriggerIds`.
- `it("the two new triggers name report-outcome.ts", ...)` — assert both values equal `"src/commands/outcome/report-outcome.ts"` exactly.
- `node --test src/domain/external-transition.test.ts src/domain/transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/domain/external-transition.test.ts`. Hermetic coverage: `019-outcome-report.md:165` and `:166`.
