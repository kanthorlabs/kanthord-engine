# Story 05 — The node row carries the two fields

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 01, Story 02, Story 03

## Change

### `src/domain/node.ts`

At line 24, after the `updatedAt` field, add two new fields to the `z.object` call:

```ts
deliverable: deliverable.nullable(),
verifyJson: z.string().nullable(),
```

After the last existing `.refine()` call (currently at line 47–49), add one new refine:

```ts
.refine(
  (row) => {
    if (row.deliverable === null) return true;
    return nodePairLegality(row.kind, row.deliverable).legal;
  },
  { message: "pair-illegal: kind and deliverable combination is not legal" },
)
```

Add imports at the top of `node.ts`:

- `import { deliverable } from "./deliverable.ts";`
- `import { nodePairLegality } from "./node-pair.ts";`

Do NOT add `assignment` to `nodeRow`. The field stays absent from the schema until EPIC 050.

### `src/domain/plan-graph.ts`

In the `StoredNode` type at lines 3–19, add two fields after line 17 (`updatedAt: number;`) and before line 18 (`dependencies: readonly string[];`):

```ts
deliverable: string | null;
verifyJson: string | null;
```

Do NOT add `assignment` to `StoredNode`.

## Constraints

- The new refine delegates to `nodePairLegality` — it does not re-implement the pair table.
- `nodeRow` holds no `assignment` field.
- `StoredNode` holds no `assignment` field.
- The refine passes when `deliverable` is `null` (no pair check on a node without a deliverable).

## Verify

```bash
node --test src/domain/node.test.ts
```

Extend `src/domain/node.test.ts` with:

1. `nodeRow.safeParse({ ...validObjective, deliverable: null, verifyJson: null }).success` is `true` — null deliverable is valid regardless of kind.
2. `nodeRow.safeParse({ ...validTask, deliverable: null, verifyJson: null }).success` is `true`.
3. `nodeRow.safeParse({ ...validInitiative, deliverable: null, verifyJson: null }).success` is `true`.
4. Each of the 4 illegal pairs causes `nodeRow.safeParse` to return `success: false`:
   - `{ ...validInitiative, deliverable: "test", verifyJson: null }`
   - `{ ...validInitiative, deliverable: "implementation", verifyJson: null }`
   - `{ ...validInitiative, deliverable: "review", verifyJson: null }`
   - `{ ...validTask, deliverable: "expansion", verifyJson: null }`
5. Each of the 8 legal pairs causes `nodeRow.safeParse` to return `success: true`. Use representative fixtures: `{ ...validInitiative, deliverable: "expansion", verifyJson: null }`, `{ ...validObjective, deliverable: "test", verifyJson: null }`, `{ ...validTask, deliverable: "test", verifyJson: null }`, etc.
6. Assert that `nodeRow.shape` (or equivalent Zod introspection) does not contain an `assignment` key — `"assignment" in nodeRow.shape` is `false`.
7. The refine delegates to `nodePairLegality` and does not mirror the table. The EPIC requires "changes the table in a test double and observes the refine follow it, so a mirrored second implementation fails." The viable mechanism in this codebase: add a test in `node.test.ts` that imports `nodePairLegality` directly, calls it with a pair you expect to be legal, and confirms `nodeRow.safeParse` with that same pair is also legal. Then pick a pair that IS currently illegal, change the test expectation to legal, and confirm that `nodeRow.safeParse` ALSO moves — this is done by temporarily patching `nodePairLegality` inline using `vi.spyOn` if the test runner supports mocking, or by structuring a separate integration assertion:
   - Write an assertion: for each of the 12 pairs, `nodePairLegality(kind, deliverable).legal === nodeRow.safeParse({ ...validFixture, kind, deliverable, verifyJson: null }).success`. This asserts the two must agree for every pair, which fails if `nodeRow` hard-codes the table differently from `nodePairLegality`.
   - This comparison test is deterministic and falsifiable: a mirrored but divergent hard-coding in `nodeRow` will fail it for any pair where the two diverge.

Test framework: `node:test` and `node:assert/strict`. No SQLite, no I/O.

Proof: PASS EPIC-047 line for `src/domain/node.test.ts`; hermetic coverage — `nodeRow`'s refine refuses each of the 4 illegal pairs, admits the 8 legal pairs, `nodeRow` holds no `assignment` key.
