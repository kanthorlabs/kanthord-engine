# Story 02 — The node pair table

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`
Depends on: Story 01

## Change

Create `src/domain/node-pair.ts`. Export one function:

```ts
export type NodePairLegal = {
  legal: true;
  shape: "parent" | "atomic";
  stateOwner: "aggregate" | "attestation-then-human" | "report";
};

export type NodePairIllegal = {
  legal: false;
  refusal: "pair-illegal";
};

export type NodePairResult = NodePairLegal | NodePairIllegal;

export function nodePairLegality(
  kind: NodeKind,
  deliverable: Deliverable,
): NodePairResult;
```

The function encodes the complete pair table from `worker.md` section 2. The implementation must be a lookup, not a series of conditions that a reviewer must mentally validate against the table.

Complete table — 12 concrete pairs, 8 legal, 4 illegal:

| kind         | deliverable      | legal | shape    | stateOwner               |
| ------------ | ---------------- | ----- | -------- | ------------------------ |
| `initiative` | `expansion`      | true  | `parent` | `aggregate`              |
| `initiative` | `test`           | false | —        | —                        |
| `initiative` | `implementation` | false | —        | —                        |
| `initiative` | `review`         | false | —        | —                        |
| `objective`  | `expansion`      | true  | `parent` | `aggregate`              |
| `objective`  | `test`           | true  | `atomic` | `attestation-then-human` |
| `objective`  | `implementation` | true  | `atomic` | `attestation-then-human` |
| `objective`  | `review`         | true  | `atomic` | `attestation-then-human` |
| `task`       | `test`           | true  | `atomic` | `report`                 |
| `task`       | `implementation` | true  | `atomic` | `report`                 |
| `task`       | `review`         | true  | `atomic` | `report`                 |
| `task`       | `expansion`      | false | —        | —                        |

Imports: `NodeKind` and `nodeKinds` from `src/domain/state.ts` (confirmed — `show-node.ts` imports `NodeKind` from `../../domain/state.ts`), `Deliverable` and `deliverables` from `src/domain/deliverable.ts`. No other imports.

Story 05 will make `src/domain/node.ts` import from `node-pair.ts`. Therefore `node-pair.ts` MUST NOT import from `node.ts` — that would create a cycle. `NodeKind` and `nodeKinds` from `src/domain/state.ts` is the correct source.

## Constraints

- No import from `zod`. Pure TypeScript only.
- `stateOwner` for atomic objectives is `"attestation-then-human"` — not `"attestation"`.
- The function is the only legality authority. Do not duplicate the logic elsewhere in this story.

## Tasks

### Task 02 — Cover the node pair table

**Input:** `src/domain/node-pair.test.ts`, `src/domain/node-pair.ts`

**Action — RED:** Create `src/domain/node-pair.test.ts`. Write the three assertion groups
named under `## Verify`. Import `nodePairLegality` from `./node-pair.ts`, `nodeKinds` from
`./state.ts`, and `deliverables` from `./deliverable.ts`.

Enumerate the matrix by iterating `nodeKinds` against `deliverables`. Do not write the 12
pairs as a literal list — the enumeration is what proves the table is complete.

The test file is the required Proof target. The Proof command names
`src/domain/node-pair.test.ts`, so no other lane can supply it.

Two first-run results are valid, as in Task 01. State which one happened. Do not raise
`ATTEMPT-FAILED:` for a first-run pass.

**Action — GREEN:** Create `src/domain/node-pair.ts` exactly as `## Change` names it. When
the file already satisfies every assertion, record a no-op turn.

**Action — REFACTOR:** None.

## Verify

```bash
node --test src/domain/node-pair.test.ts
```

Create `src/domain/node-pair.test.ts` with:

1. Iterate `nodeKinds` (from `src/domain/state.ts`) against `deliverables` (from `src/domain/deliverable.ts`) to produce all 12 concrete pairs. Assert `legalCount === 8` and `illegalCount === 4`, each as exact numbers via `assert.strictEqual`.
2. Assert each of the 8 legal pairs by full result object using `assert.deepStrictEqual`. The assertion includes `shape` and `stateOwner` — never `legal` alone. All three `(objective, non-expansion)` pairs assert `stateOwner: "attestation-then-human"`.
3. Assert each of the 4 illegal pairs returns `{ legal: false, refusal: "pair-illegal" }`:
   - `nodePairLegality("initiative", "test")`
   - `nodePairLegality("initiative", "implementation")`
   - `nodePairLegality("initiative", "review")`
   - `nodePairLegality("task", "expansion")`

Test framework: `node:test` and `node:assert/strict`. No SQLite, no I/O.

Proof: PASS EPIC-047 line for `src/domain/node-pair.test.ts`; hermetic coverage — pair matrix enumerated over all 12 concrete pairs, legal count 8, illegal count 4, each asserted as a number; each legal pair asserted by full result object; each illegal pair by value.
