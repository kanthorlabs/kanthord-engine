# Story 1 — The run kind

Epic: `.agents/plan/epics/050-the-run-the-fence-and-exclusion.md`
Depends on: EPIC 047 Story 1 (`src/domain/deliverable.ts` exports `deliverables` and `Deliverable`).
Kind: story-foundation

## Change

**Create `src/domain/run-kind.ts`** (greenfield).

Export in this order:

```ts
export const runKinds = ["structural", "execution", "review"] as const;
export type RunKind = (typeof runKinds)[number];

export function runKindFor(deliverable: Deliverable): RunKind;
```

Import `Deliverable` from `"./deliverable.ts"` as a type-only import.

`runKindFor` is a total lookup over a `Record<Deliverable, RunKind>` declared at module scope:

```ts
const runKindByDeliverable: Readonly<Record<Deliverable, RunKind>> = {
  expansion: "structural",
  implementation: "execution",
  review: "review",
  test: "execution",
};
```

The record keys are in bytewise order. The annotation `Readonly<Record<Deliverable, RunKind>>` is what makes the mapping total: a fifth deliverable added to `deliverables` fails type checking here, so no default branch and no `switch` is written. `runKindFor` returns `runKindByDeliverable[deliverable]` and nothing else. It throws no error and has no fallback.

`runKinds` is the pinned tuple `run.kind` widens to in Story 2.

## Constraints

- `src/domain/` is pure. Import `zod` only if a schema is needed; this story needs none.
- Do not add a `research` row. EPIC 047 defers `research` out of the `deliverables` tuple. The epic that restores it adds its `execution` row.
- Do not write a `switch` and do not write a `default` branch. The record annotation is the exhaustiveness mechanism.
- Do not export a zod schema for `RunKind` from this file. Story 2 builds the `run.kind` enum from `runKinds` inside `src/domain/run.ts`.

## Verify

```
node --test src/domain/run-kind.test.ts
```

Create `src/domain/run-kind.test.ts`. Suite name `"src/domain/run-kind.test"`. Use `node:test` `describe`/`it` and `node:assert/strict`, matching `src/domain/run.test.ts:1-2`.

Assert, each as a separate `it`:

1. `"runKinds equals the pinned tuple in its declared order"` — `assert.deepEqual([...runKinds], ["structural", "execution", "review"])` and `assert.equal(runKinds.length, 3)`. The tuple is **not** bytewise sorted, and no assertion or test name may describe it as such.

2. `"runKindFor maps expansion to structural"` — `assert.equal(runKindFor("expansion"), "structural")`.

3. `"runKindFor maps test to execution"` — `assert.equal(runKindFor("test"), "execution")`.

4. `"runKindFor maps implementation to execution"` — `assert.equal(runKindFor("implementation"), "execution")`.

5. `"runKindFor maps review to review"` — `assert.equal(runKindFor("review"), "review")`.

6. `"runKindFor is total over the deliverables tuple"` — import `deliverables` from `"./deliverable.ts"`. Iterate it:

   ```ts
   for (const value of deliverables) {
     const result = runKindFor(value);
     assert.ok(runKinds.includes(result), `${value} produced ${result}`);
   }
   ```

   Then assert the count matches the tuple: `assert.equal(deliverables.length, 4)`. A fifth deliverable added to the tuple fails type checking in `run-kind.ts` before this test runs, and this count assertion fails after, so the pair names the gap in both directions.

7. `"every run kind is produced by at least one deliverable"` — build `new Set(deliverables.map(runKindFor))` and assert `assert.deepEqual([...produced].sort(), ["execution", "review", "structural"])`. This proves no run kind is unreachable.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/domain/run-kind.test.ts` in `PASS EPIC-050`.
