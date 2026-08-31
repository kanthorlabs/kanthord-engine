# Story 01 — The deliverable enum

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`

## Change

Create `src/domain/deliverable.ts`. Mirror the shape of `src/domain/worker.ts` exactly (one file, one exported tuple const, one Zod enum derived from it, one inferred type).

Export three names:

```ts
export const deliverables = [
  "test",
  "implementation",
  "review",
  "expansion",
] as const;

export const deliverable = z.enum(deliverables);

export type Deliverable = z.infer<typeof deliverable>;
```

The tuple order is observable (the pair table in Story 02 iterates it) and must match `worker.md` section 2 exactly. Do not reorder.

## Constraints

- Import only `zod`. No other dependency.
- No default export. No extra functions or constants.

## Tasks

### Task 01 — Cover the deliverable enum

**Input:** `src/domain/deliverable.test.ts`, `src/domain/deliverable.ts`

**Action — RED:** Create `src/domain/deliverable.test.ts`. Write the nine assertions named
under `## Verify`, in that order. Import `deliverables` and `deliverable` from
`./deliverable.ts`.

The test file is the required Proof target. The Proof command names
`src/domain/deliverable.test.ts`, so no other lane can supply it.

Two first-run results are valid, and both are correct:

- `src/domain/deliverable.ts` does not exist — the import fails to resolve. That is the RED.
- `src/domain/deliverable.ts` already exists from an earlier cycle — every assertion passes.

State in the turn which of the two happened. Do not raise `ATTEMPT-FAILED:` for a first-run
pass, and do not delete or weaken an assertion to force a failure.

**Action — GREEN:** Create `src/domain/deliverable.ts` exactly as `## Change` names it. When
the file already satisfies every assertion, record a no-op turn that lists `None` under
`**Files changed.**` and reports `pnpm run typecheck` exit 0.

**Action — REFACTOR:** None.

## Verify

```bash
node --test src/domain/deliverable.test.ts
```

Create `src/domain/deliverable.test.ts` with:

1. `deliverables` deep-equals `["test", "implementation", "review", "expansion"]` by `assert.deepStrictEqual` — every element named explicitly.
2. `deliverable.parse("test")` returns `"test"`.
3. `deliverable.parse("implementation")` returns `"implementation"`.
4. `deliverable.parse("review")` returns `"review"`.
5. `deliverable.parse("expansion")` returns `"expansion"`.
6. `deliverable.safeParse("expansions").success` is `false`.
7. `deliverable.safeParse("impl").success` is `false`.
8. `deliverable.safeParse("").success` is `false`.
9. `deliverable.safeParse("research").success` is `false`. `research` is deliberately absent in this phase.

Test framework: `node:test` (`describe`/`it`) and `node:assert/strict`. No SQLite, no I/O.

Proof: PASS EPIC-047 line for `src/domain/deliverable.test.ts`; hermetic coverage — `deliverables` deep-equals the four-element array in the fixed order.
