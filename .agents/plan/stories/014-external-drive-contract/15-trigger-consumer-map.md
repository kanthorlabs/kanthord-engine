# Story 15 — The trigger consumption assertion

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: Story 12 (same file), Story 14 (the map is added below `objectiveDrivePin`, which Story 14 creates) and Story 13 (the test asserts the map holds no internal trigger id).

## Change

### `src/domain/external-transition.ts`

Add one map below `objectiveDrivePin`. It names the command module that must reach each external trigger:

```ts
export const externalTriggerConsumer: Readonly<
  Record<ExternalTriggerId, string>
> = {
  "attempt-rejected": "src/commands/outcome/report-outcome.ts",
  "outcome-accepted": "src/commands/outcome/report-outcome.ts",
  "attempt-limit-reached": "src/commands/outcome/report-outcome.ts",
  "object-reported": "src/commands/outcome/report-objective.ts",
  "human-close": "src/commands/outcome/close-objective.ts",
  "human-close-partial": "src/commands/outcome/close-objective.ts",
};
```

`object-reported` maps to `report-objective.ts`, the attestation command, because no aggregation command writes that transition. `src/commands/outcome/aggregate-objective.ts` exists in no epic and must appear in no value.

## Constraints

- **This story asserts one thing only:** the map is total over the trigger ids, and every value is a path under `src/commands/`. The three files do not exist yet.
- **EPIC 019 owns the second assertion:** every path in `externalTriggerConsumer` exists on disk and names its trigger id. EPIC 019 adds it to `src/domain/external-transition.test.ts` and runs it in its own gate, because EPIC 019 creates those three files. Do not add an on-disk existence check here; it would fail.
- **Write no source scan.** An earlier draft scanned every non-test file under `src/commands/` for a literal `from` and `to` pair of an `externalTransitions` row, in the pattern of `src/domain/layout.test.ts`. That scan matches syntax and not intent: it flags a legitimate internal write of the same pair, and `src/commands/startup/recover-expired-leases.ts` already writes `task running → ready` for an internal lease. Do not add it, and do not add a per-file allow list.
- Add no key for an internal trigger id. The map is keyed by `ExternalTriggerId` only.
- Do not change `externalTransitions`, `externalTriggerIds`, `ExternalPrecondition` or `objectiveDrivePin`.
- Change no file under `src/commands/`.

## Verify

- Extend `src/domain/external-transition.test.ts`, in a nested `describe("externalTriggerConsumer", ...)`. Import `internalTriggerIds` from `./node-trigger.ts`.
- Assert the map is total over the trigger ids: `Object.keys(externalTriggerConsumer).length === 6`, every member of `externalTriggerIds` is a key, and every key is a member of `externalTriggerIds`.
- Assert every value starts with `src/commands/`.
- Assert `externalTriggerConsumer["object-reported"] === "src/commands/outcome/report-objective.ts"`.
- Assert no value equals or contains `src/commands/outcome/aggregate-objective.ts`.
- Assert `externalTriggerConsumer` holds no internal trigger id as a key, checked against `internalTriggerIds`.
- Assert the three `report-outcome.ts` keys deep-equal `["attempt-rejected", "outcome-accepted", "attempt-limit-reached"]` when `externalTriggerIds` is filtered on that value, and the two `close-objective.ts` keys deep-equal `["human-close", "human-close-partial"]`.
- `node --test src/domain/external-transition.test.ts src/domain/node-trigger.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `externalTriggerConsumer` bullet at `.agents/plan/epics/014-external-drive-contract.md:85` and the internal-key bullet at `:91`.
