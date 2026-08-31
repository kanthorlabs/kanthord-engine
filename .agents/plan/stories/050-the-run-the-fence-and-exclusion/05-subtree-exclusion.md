# Story 5 — Subtree exclusion

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: Story 1 (`RunKind`). No storage dependency — this story adds a pure function.

## Change

**Create `src/domain/run-exclusion.ts`** (greenfield). This story adds `subtreeExclusion`; Story 6 adds `objectiveBusy` to the same file.

Export:

```ts
export type ExclusionRun = Readonly<{
  runId: string;
  nodeId: string;
  state: "active" | "ended";
  expiresAt: number | null;
}>;

export type SubtreeExclusionInput = Readonly<{
  targetId: string;
  ancestorIds: readonly string[];
  descendantIds: readonly string[];
  runs: readonly ExclusionRun[];
  now: number;
}>;

export type SubtreeExclusionRefusal = Readonly<{
  refusal: "subtree-busy";
  relation: "self" | "ancestor" | "descendant";
  nodeId: string;
  runId: string;
  expiresAt: number | null;
}>;

export function subtreeExclusion(
  input: SubtreeExclusionInput,
): SubtreeExclusionRefusal | null;
```

**Algorithm.** Deterministic, three ordered passes:

1. Build the live set: every `run` in `input.runs` where `run.state === "active"` **and** (`run.expiresAt === null` or `run.expiresAt > input.now`). A run whose `expiresAt` is exactly `input.now` is **not** live, matching the `>=` boundary rule the EPIC states for expiry. A run with a null `expiresAt` is live, because a legacy row carries no budget.

2. Check in this fixed relation order, and return the first hit:
   - `self` — a live run whose `nodeId === input.targetId`;
   - `ancestor` — a live run whose `nodeId` is in `input.ancestorIds`;
   - `descendant` — a live run whose `nodeId` is in `input.descendantIds`.

   `self` is checked first because it is the most specific statement about the target. Within one relation, if two live runs match, take the one whose `nodeId` sorts first bytewise via `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`, and break a further tie by `runId` the same way. The tie-break makes the refusal reproducible for the same input set in any order.

3. Return `null` when no live run matches.

The refusal carries the matched run's `nodeId`, `runId` and `expiresAt`, so a client learns which node holds the subtree and until when.

`ancestorIds` and `descendantIds` are supplied by the caller. `subtreeExclusion` computes no hierarchy and reads no store; Story 8 derives both sets from `plan.readAllNodes` inside the claim transaction.

## Constraints

- Pure. No clock, no store, no `Date.now()`. `now` is an input.
- `input.targetId` appears in neither `ancestorIds` nor `descendantIds`. The function does not assert that; the caller builds the sets.
- Do not fold the objective-branch rule in here. That is `objectiveBusy` in Story 6, and it carries a different refusal code.
- Do not use `Array.prototype.sort` on the input arrays. Sort a copy, or select the minimum by comparison, so the caller's arrays are not mutated.

## Verify

```
node --test src/domain/run-exclusion.test.ts
```

Create `src/domain/run-exclusion.test.ts`. Suite name `"src/domain/run-exclusion.test"`. `node:test` and `node:assert/strict`.

Fixtures at module scope: `const NOW = 1700000000000;` and node ids `"objective_a"`, `"task_a"`, `"task_b"`, `"initiative_a"`.

Assert, each as a separate `it`:

1. `"a run on an ancestor refuses a claim on a descendant, naming the ancestor"` — target `"task_a"`, `ancestorIds: ["initiative_a", "objective_a"]`, `descendantIds: []`, one active run on `"objective_a"` with `runId: "run_a"` and `expiresAt: NOW + 1000`. Assert the result deep-equals `{ refusal: "subtree-busy", relation: "ancestor", nodeId: "objective_a", runId: "run_a", expiresAt: NOW + 1000 }`. Assert the whole object with `assert.deepEqual`, not the code alone.

2. `"a run on a descendant refuses a claim on an ancestor, naming the descendant"` — target `"objective_a"`, `descendantIds: ["task_a"]`, `ancestorIds: []`, one active run on `"task_a"`. Assert `relation === "descendant"` and `nodeId === "task_a"`, by `assert.deepEqual` on the full refusal.

3. `"a run on the target itself refuses with relation self"` — target `"task_a"`, one active run on `"task_a"`. Assert `relation === "self"`.

4. `"a run on an unrelated node admits the claim"` — target `"task_a"`, `ancestorIds: ["objective_a"]`, `descendantIds: []`, one active run on `"task_b"` which is in neither set. Assert the result is `null`.

5. `"an expired run in the input set does not refuse"` — target `"task_a"`, one run on `"objective_a"` with `state: "active"` and `expiresAt: NOW - 1`. Assert `null`.

6. `"a run whose expiresAt is exactly now does not refuse"` — `expiresAt: NOW`. Assert `null`. The boundary instant is expired, matching the renew rule.

7. `"a run whose expiresAt is one millisecond after now refuses"` — `expiresAt: NOW + 1`. Assert the refusal is non-null. Cases 6 and 7 pin the boundary from both sides.

8. `"an ended run does not refuse, even with a future expiresAt"` — `state: "ended"`, `expiresAt: NOW + 100000`. Assert `null`.

9. `"a run with a null expiresAt refuses"` — `state: "active"`, `expiresAt: null`. Assert the refusal is non-null and carries `expiresAt: null`. This is the legacy row.

10. `"self is reported before ancestor"` — one active run on the target and one active run on an ancestor, both live. Assert `relation === "self"`.

11. `"ancestor is reported before descendant"` — one active run on an ancestor and one on a descendant, both live. Assert `relation === "ancestor"`.

12. `"two live ancestor runs are broken by bytewise node id"` — `ancestorIds: ["objective_b", "objective_a"]` with a live run on each. Assert `nodeId === "objective_a"`.

13. `"the same run set in two different array orders produces a deep-equal refusal"` — build one input, then a second identical input with `runs` reversed. Assert `assert.deepEqual(subtreeExclusion(a), subtreeExclusion(b))`.

14. `"the input arrays are not mutated"` — pass a `runs` array and an `ancestorIds` array, capture copies before the call, and assert both deep-equal their copies after.

15. `"an empty run set admits the claim"` — `runs: []`. Assert `null`.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/run-exclusion.test.ts` in `PASS EPIC-050`.
