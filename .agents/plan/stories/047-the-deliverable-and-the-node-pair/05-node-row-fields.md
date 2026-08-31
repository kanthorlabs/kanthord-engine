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

## Tasks

### Task 05 — Cover the two node-row fields

**Input:** `src/domain/node.test.ts`, `src/domain/plan-graph.test.ts`,
`src/domain/node-view.test.ts`, `src/domain/plan-candidate.test.ts`,
`src/domain/plan-diff.test.ts`, `src/domain/node.ts`, `src/domain/plan-graph.ts`,
`src/commands/node/create-node.ts`, `src/services/plan/sqlite.ts`

**Action — RED:** Two parts. Write both before you hand the Task over.

Part A — extend `src/domain/node.test.ts` with the seven assertion groups named under
`## Verify`. `src/domain/node.test.ts` is a required Proof target.

Part B — repair the fixtures the two new required fields make stale. Every existing
`nodeRow` and `StoredNode` fixture gains `deliverable: null` and `verifyJson: null`:

- `src/domain/node.test.ts` — every `validInitiative`, `validObjective` and `validTask`
  fixture, and every inline row the refine tests build. Fifteen assertions fail without it.
- `src/domain/plan-graph.test.ts:12` — `StoredNode carries exactly its seventeen members`.
  Rename the title to nineteen, add both fields to the fixture, and place `deliverable`
  before `dependencies` in the expected sorted key list. `deliverable` sorts before
  `dependencies` bytewise, because `l` precedes `n`.
- `src/domain/node-view.test.ts`, `src/domain/plan-candidate.test.ts` and
  `src/domain/plan-diff.test.ts` — every `StoredNode` fixture.

**Action — GREEN:** Edit `src/domain/node.ts` and `src/domain/plan-graph.ts` exactly as
`## Change` names them. Both new `StoredNode` members are required, so every production
producer must also supply them: `src/commands/node/create-node.ts` initialises both to
`null`, and `src/services/plan/sqlite.ts` exposes both on every read. Story 06 replaces the
`sqlite.ts` placeholder with the real column round-trip; this Task only has to typecheck.

**Action — REFACTOR:** None.

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
7. The refine delegates to `nodePairLegality` and does not mirror the table. The test runner is `node:test`, which has no module mock, so the parity assertion is the mechanism:
   - Write an assertion: for each of the 12 pairs, `nodePairLegality(kind, deliverable).legal === nodeRow.safeParse({ ...validFixture, kind, deliverable, verifyJson: null }).success`. This asserts the two must agree for every pair, which fails if `nodeRow` hard-codes the table differently from `nodePairLegality`.
   - This comparison test is deterministic and falsifiable: a mirrored but divergent hard-coding in `nodeRow` will fail it for any pair where the two diverge.

Test framework: `node:test` and `node:assert/strict`. No SQLite, no I/O.

Proof: PASS EPIC-047 line for `src/domain/node.test.ts`; hermetic coverage — `nodeRow`'s refine refuses each of the 4 illegal pairs, admits the 8 legal pairs, `nodeRow` holds no `assignment` key.
