# Story 14 — The drive-mode pin

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: Story 12 (same file) and Story 6 (`RunDriver`).

## Change

### `src/domain/external-transition.ts`

Add one type and one total pure function to the file Story 12 created. Add them below `externalTransitions`.

```ts
export type DrivePinInput = Readonly<{
  runDrivers: readonly RunDriver[];
  claimDriver: RunDriver;
}>;

export type DrivePinRefusal = Readonly<{
  pinnedDriver: RunDriver;
  claimDriver: RunDriver;
}>;

export function objectiveDrivePin(input: DrivePinInput): DrivePinRefusal | null;
```

`input.runDrivers` holds the driver of every run ever opened under the objective, in any order.

Its exact behaviour:

- Return `null` when `runDrivers` is empty.
- Return `null` when every member of `runDrivers` equals `claimDriver`.
- Otherwise return `{ pinnedDriver, claimDriver }`, where `pinnedDriver` is the **first** member of `runDrivers` that differs from `claimDriver`.

The function reads no clock and runs no SQL.

An objective's drive mode is pinned at its first claim, and it cannot change while the objective is non-terminal. An internal worker cannot claim an objective that holds an external run in its history, and an external harness cannot claim an objective that holds an internal run.

## Constraints

- The refusal names the **first** differing member, not the last and not the most frequent. A mixed list is deterministic because the caller supplies a fixed order.
- Add no consumer. **EPIC 018 enforces this inside `claimNode`**, and its claim-side run reuse refuses an active run whose driver is not the driver of the claim rather than adopting it.
- Do not read `run.driver` anywhere in this file. The function takes the driver list as input.
- Do not add a third drive mode. `runDrivers` from `src/domain/run.ts` is the closed set.
- Do not change `externalTransitions`, `externalTriggerIds` or `ExternalPrecondition`.

## Verify

- Extend `src/domain/external-transition.test.ts`, in a nested `describe("objectiveDrivePin", ...)`.
- Assert `objectiveDrivePin({ runDrivers: [], claimDriver: "internal" })` is `null`, and the same for `claimDriver: "external"`.
- Assert a uniform list returns `null` in both directions: `{ runDrivers: ["internal", "internal"], claimDriver: "internal" }` is `null`, and `{ runDrivers: ["external", "external"], claimDriver: "external" }` is `null`. Assert the single-member case in both directions too.
- Assert a list holding the other driver returns a refusal naming that driver as `pinnedDriver`, in both directions: `{ runDrivers: ["external"], claimDriver: "internal" }` deep-equals `{ pinnedDriver: "external", claimDriver: "internal" }`, and `{ runDrivers: ["internal"], claimDriver: "external" }` deep-equals `{ pinnedDriver: "internal", claimDriver: "external" }`.
- Assert a mixed list returns the **first** differing member: `{ runDrivers: ["internal", "external"], claimDriver: "external" }` deep-equals `{ pinnedDriver: "internal", claimDriver: "external" }`, and `{ runDrivers: ["external", "internal"], claimDriver: "internal" }` deep-equals `{ pinnedDriver: "external", claimDriver: "internal" }`.
- `node --test src/domain/external-transition.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `objectiveDrivePin` bullet at `.agents/plan/epics/014-external-drive-contract.md:86`.
