# Story 1 — Run authority

Epic: `.agents/plan/epics/050.2-the-run-renew-release-and-report.md`
Depends on: EPIC 050 Story 2 (`02-the-run-row`), for `runRow` and its authority fields. No storage dependency — this story adds a pure function.
Kind: story-foundation

## Change

**Create `src/domain/run-authority.ts`** (greenfield). No file of that name exists under `src/domain/`, and `assertRunAuthority` appears nowhere in `src/`, `test/` or `scripts/`.

```ts
export const runAuthorityRefusals = [
  "run-not-found",
  "run-ended",
  "run-expired",
  "run-caller-mismatch",
  "target-outside-run",
  "fence-stale",
] as const;
export type RunAuthorityRefusalCode = (typeof runAuthorityRefusals)[number];

export type AuthorityRun = Readonly<{
  id: string;
  nodeId: string;
  state: "active" | "ended";
  fence: number | null;
  expiresAt: number | null;
  worker: string | null;
}>;

export type RunAuthorityInput = Readonly<{
  run: AuthorityRun | null;
  runId: string;
  fence: number;
  targetNodeId: string;
  caller: string;
  now: number;
}>;

export type RunAuthorityRefusal = Readonly<{
  refusal: RunAuthorityRefusalCode;
  runId: string;
}>;

export function assertRunAuthority(
  input: RunAuthorityInput,
): RunAuthorityRefusal | null;
```

**The six conditions, in this exact order.** Return the first that fails, and return `null` when all six hold:

1. `run-not-found` — `input.run === null`, or `input.run.id !== input.runId`.
2. `run-ended` — `input.run.state !== "active"`.
3. `run-expired` — `input.run.expiresAt !== null && input.run.expiresAt <= input.now`. A null `expiresAt` never expires, and cases 6 to 8 pin all three boundaries.
4. `run-caller-mismatch` — `input.run.worker !== input.caller`.
5. `target-outside-run` — `input.targetNodeId !== input.run.nodeId`. The binding is the run's own node and nothing wider. A structural objective run holds no task attempt, so admitting a descendant would let an objective run authorize a task release or a task report that no attempt can answer. The claim-time subtree rule of EPIC 050 governs exclusion, not authority, and the subtree-bound structural mutation of `docs/workflow/worker.md:412` is EPIC 052's: it declares its own admission and its own control case, and it never widens this condition in place.
6. `fence-stale` — `input.run.fence !== input.fence`.

The order is what makes an ended run presented with its own last fence refuse `run-ended` rather than pass: condition 2 fires before condition 6 ever runs. A fence comparison alone would admit that row, because the daemon raises the fence when it ends a run, so the worker's stored fence is one behind and the check would only catch it by accident.

**The refusal carries `refusal` and `runId` and nothing else.** It never carries a fence, a current fence, an `expiresAt` or a worker id. Handing the replacement value to a writer that just proved it holds a stale one gives that writer the authority the raise was meant to remove.

## Constraints

- Pure. `now` and `caller` are inputs. No clock, no store.
- The refusal object has exactly two keys. Do not add a `message`; the caller builds one.
- Do not throw. The function returns a refusal or `null`; Story 3 (`03-the-renew`), Story 5 (`05-the-release`) and Story 6 (`06-the-report-prelude`) each turn a refusal into their own error class.
- Take no subtree. The run row carries `nodeId`, and condition 5 needs nothing else.

## Verify

```
node --test src/domain/run-authority.test.ts
```

Create `src/domain/run-authority.test.ts`. Suite name `"src/domain/run-authority.test"`. `node:test`, `node:assert/strict`.

Module-scope fixtures: `const NOW = 1700000000000;`, `const RUN_ID = "run_a";`, `const NODE_ID = "task_a";`, `const CALLER = "general@1";`, and one `validInput` const holding a passing input, with variants built by spread — the convention of `src/domain/run.test.ts:45` — `validRun`.

Assert, each as a separate `it`:

1. `"a valid input returns null"` — assert `assertRunAuthority(validInput) === null`.

2. `"run-not-found when the run is null"` — `run: null`. Assert the result deep-equals `{ refusal: "run-not-found", runId: RUN_ID }`.

3. `"run-not-found when the run id does not match"` — a run whose `id` is `"run_b"` while `runId` is `"run_a"`. Assert `refusal === "run-not-found"`.

4. `"run-ended when the run state is ended"` — assert `refusal === "run-ended"`.

5. `"run-expired when expiresAt is before now"` — `expiresAt: NOW - 1`. Assert `refusal === "run-expired"`.

6. `"run-expired when expiresAt is exactly now"` — `expiresAt: NOW`. Assert `refusal === "run-expired"`. The boundary instant is expired.

7. `"a run whose expiresAt is one millisecond after now passes"` — assert `null`.

8. `"a run with a null expiresAt passes"` — assert `null`.

9. `"run-caller-mismatch when the worker differs from the caller"` — run `worker: "tdd@1"`, caller `"general@1"`. Assert `refusal === "run-caller-mismatch"`.

10. `"run-caller-mismatch when the run worker is null"` — assert `refusal === "run-caller-mismatch"`.

11. `"target-outside-run when the target is not the run node"` — `targetNodeId: "task_z"`. Assert `refusal === "target-outside-run"`.

12. `"the run's own node is the only node inside the run"` — `targetNodeId === run.nodeId`. Assert `null`.

13. `"target-outside-run for a descendant of the run node"` — `run.nodeId: "objective_a"`, `targetNodeId: "task_a"`. Assert `refusal === "target-outside-run"`. This is the control for condition 5: a descendant of the run's node is outside the run's authority.

14. `"fence-stale when the presented fence is behind"` — run `fence: 4`, input `fence: 3`. Assert `refusal === "fence-stale"`.

15. `"fence-stale when the presented fence is ahead"` — run `fence: 4`, input `fence: 5`. Assert `refusal === "fence-stale"`.

16. `"fence-stale when the run fence is null"` — run `fence: null`, input `fence: 1`. Assert `refusal === "fence-stale"`.

17. `"an ended run presented with its own last fence refuses run-ended"` — a run with `state: "ended"` and `fence: 4`, presented with `fence: 4`. Assert `refusal === "run-ended"`. A fence comparison alone would admit this input, which is why the order is fixed.

18. `"an input failing run-ended and fence-stale reports run-ended"` — `state: "ended"`, run `fence: 9`, input `fence: 1`. Assert `refusal === "run-ended"`.

19. `"an input failing run-expired and target-outside-run reports run-expired"` — assert `refusal === "run-expired"`.

20. `"an input failing run-caller-mismatch and fence-stale reports run-caller-mismatch"` — assert `refusal === "run-caller-mismatch"`.

21. `"the refusal order is exactly the pinned tuple"` — assert `assert.deepEqual([...runAuthorityRefusals], ["run-not-found","run-ended","run-expired","run-caller-mismatch","target-outside-run","fence-stale"])` and `assert.equal(runAuthorityRefusals.length, 6)`.

22. `"no refusal carries a fence value"` — build one input per refusal code that produces it, collect the six refusal objects, and for each assert `assert.deepEqual(Object.keys(refusal).sort(), ["refusal", "runId"])`. The assertion scans the key set, per the EPIC's gate, rather than checking for one named key.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/run-authority.test.ts` in `PASS EPIC-050.2`.
