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
