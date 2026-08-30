# Story 6 — The objective-branch rule

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 5 (`src/domain/run-exclusion.ts` and its `ExclusionRun` type).

## Change

**`src/domain/run-exclusion.ts` — add a second exported function**, after `subtreeExclusion`.

```ts
export type ObjectiveBusyInput = Readonly<{
  objectiveId: string;
  siblingRuns: readonly ExclusionRun[];
  now: number;
}>;

export type ObjectiveBusyRefusal = Readonly<{
  refusal: "objective-busy";
  objectiveId: string;
  siblingNodeId: string;
  siblingRunId: string;
  expiresAt: number | null;
}>;

export function objectiveBusy(
  input: ObjectiveBusyInput,
): ObjectiveBusyRefusal | null;
```

**Algorithm.** Filter `input.siblingRuns` to the live set by the same rule Story 5 uses: `state === "active"` and (`expiresAt === null` or `expiresAt > input.now`). Extract that predicate into a module-private `isLive(run, now)` helper and have `subtreeExclusion` call it too, so one rule governs both functions.

If the live set is empty, return `null`. Otherwise pick the run whose `nodeId` sorts first bytewise, breaking a further tie by `runId` bytewise, and return the refusal carrying `input.objectiveId`, that run's `nodeId` as `siblingNodeId`, its `runId` as `siblingRunId`, and its `expiresAt`.

`siblingRuns` holds the runs on the other task children of the objective. The caller builds the set; `objectiveBusy` resolves no hierarchy. The claimed node's own run is never in the set — Story 8 excludes it when it assembles the input, and `subtreeExclusion` covers the same-node case.

The refusal names the sibling node, the sibling run and that run's `expires_at`, so the client knows what it waits on and until when. The daemon holds no queue; the caller retries.

## Constraints

- Pure. `now` is an input.
- The refusal never carries a fence. The EPIC states a refusal never returns the current fence, and this refusal is one of them.
- One `isLive` helper serves both functions. Do not duplicate the liveness predicate.
- Do not mutate `input.siblingRuns`.

## Verify

```
node --test src/domain/run-exclusion.test.ts
```

Add to `src/domain/run-exclusion.test.ts`, inside a nested `describe("objectiveBusy", ...)`:

1. `"a sibling task with an active run refuses, naming the sibling node, its run and its expiresAt"` — `objectiveId: "objective_a"`, one live run `{ runId: "run_a", nodeId: "task_b", state: "active", expiresAt: NOW + 5000 }`. Assert the result deep-equals `{ refusal: "objective-busy", objectiveId: "objective_a", siblingNodeId: "task_b", siblingRunId: "run_a", expiresAt: NOW + 5000 }`. All three named fields are asserted in one `assert.deepEqual`, per the EPIC's gate.

2. `"a sibling task with an ended run admits"` — one run with `state: "ended"` and a future `expiresAt`. Assert `null`.

3. `"a sibling task with an expired run admits"` — `state: "active"`, `expiresAt: NOW - 1`. Assert `null`.

4. `"a sibling run whose expiresAt is exactly now admits"` — `expiresAt: NOW`. Assert `null`.

5. `"an empty sibling set admits"` — `siblingRuns: []`. Assert `null`.

6. `"a sibling run with a null expiresAt refuses and reports a null expiresAt"` — assert the refusal is non-null and `expiresAt === null`.

7. `"two live sibling runs are broken by bytewise node id"` — live runs on `"task_c"` and `"task_b"`. Assert `siblingNodeId === "task_b"`.

8. `"two live sibling runs on the same node are broken by bytewise run id"` — two live runs both on `"task_b"`, with `runId` `"run_b"` and `"run_a"`. Assert `siblingRunId === "run_a"`.

9. `"the same sibling set in two array orders produces a deep-equal refusal"` — assert `assert.deepEqual(objectiveBusy(a), objectiveBusy(b))` where `b` reverses `siblingRuns`.

10. `"the refusal carries no fence key"` — assert `Object.keys(refusal!).includes("fence") === false`. The key set is scanned, per the EPIC's gate on refusals.

11. `"the input array is not mutated"` — capture a copy of `siblingRuns` before the call and assert deep equality after.

Add one case asserting the shared predicate:

12. `"objectiveBusy and subtreeExclusion agree on the liveness boundary"` — for `expiresAt` values `NOW - 1`, `NOW` and `NOW + 1`, assert that `objectiveBusy` returns `null` exactly when `subtreeExclusion` returns `null` for the same run. Three iterations, asserted by value.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/run-exclusion.test.ts` in `PASS EPIC-050`.
