# Story 2 — The `ready → pending` matrix flip

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: Story 1 (same two files, disjoint lines; run in numeric order).

## Change

Exactly one cell of the matrix flips, at all three levels.

### `docs/proposal/phase-1/state-machine.md:70`

The row reads today:

```
| `ready`             | `pending`           | ❌  | ❌  | ❌  | An abandon parks the node in `blocked`. Only import and `unblock` write `pending`.                                                                                                                                       |
```

Change the three marks to `✅` and replace the note with exactly:

`A topology write and an import write it, when the accepted graph adds an unsatisfied dependency to a node that was already `ready`.`

Keep the `From` and `To` cells byte-identical and keep the row on one line.

### `src/domain/transition.ts:70-77`

The row reads today:

```ts
  {
    from: "ready",
    to: "pending",
    task: false,
    objective: false,
    initiative: false,
    note: "An abandon parks the node in `blocked`. Only import and `unblock` write `pending`.",
  },
```

Set `task`, `objective` and `initiative` to `true`, and set `note` to the exact string above. Change nothing else in the file.

### `src/domain/transition.test.ts`

- Add `"ready→pending"` to each of the three `allowedPairs` sets: `task` at `src/domain/transition.test.ts:9-22`, `objective` at `:23-38`, `initiative` at `:39-52`. Insert it immediately after the `"pending→discarded"` entry of each set, so each set keeps its `from`-major then `to` order.
- Rewrite the test at `src/domain/transition.test.ts:236-247`. Rename it to `"only blocked→pending and ready→pending write pending"`. Keep the loop over `nodeStates` and the inner loop over the three levels, and skip `from === "blocked"` and `from === "ready"`. Assert `canTransition(level, from, "pending") === false` for every other `from`.
- Add to the same test, **after** the `nodeStates` loop closes, a second loop of its own over `["task", "objective", "initiative"] as const` holding two positive assertions per level: `canTransition(level, "blocked", "pending") === true` and `canTransition(level, "ready", "pending") === true`. That is six assertions in total. Declare the level binding inside this second loop; the `level` of the negative loop is out of scope here.

## Constraints

- `transitions.length` stays 56. Add no row and remove no row.
- The row order of `src/domain/transition.ts` stays sorted `from`-major then `to` in `nodeStates` order. The test at `src/domain/transition.test.ts:80-94` asserts that order and must not need an edit.
- Change no other boolean. `src/domain/transition.test.ts:106-120` is the per-level oracle; after the three set edits it must pass with no further change.
- The consumer of this cell is the topology write of EPIC 017, not EPIC 016. Add no caller here.

## Verify

- `node --test src/domain/transition.test.ts` exits 0.
- `src/domain/transition.test.ts:55-57` still asserts `transitions.length === 56`.
- `src/domain/transition.test.ts:59-73` still asserts the full 56-pair cross product with no duplicate.
- `src/domain/transition.test.ts:106-120` asserts every one of the 168 `level × from × to` cells against `allowedPairs`, so exactly one cell changed value at three levels and no other cell moved.
- The rewritten `"only blocked→pending and ready→pending write pending"` fails if a third source of `pending` appears.
- The matrix parity test Story 1 adds to `src/domain/transition.test.ts` compares the three mark cells of every one of the 36 document rows against `row.task`, `row.objective` and `row.initiative`. It therefore fails if this story flips the code booleans without flipping `state-machine.md:70`, or the reverse. That test is the mechanism that keeps the document and the matrix in agreement; do not weaken it.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-014`. Hermetic coverage: the `transitions.length` bullet at `.agents/plan/epics/014-external-drive-contract.md:79` and the `pending` source bullet at `:80`.
