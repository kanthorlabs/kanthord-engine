# Story 06 — Transition matrix as data

Epic: `.agents/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 03 (`src/domain/state.ts`).

## Change

### `src/domain/transition.ts` (new)

```ts
import { nodeStates } from "./state.ts";
import type { NodeKind, NodeState } from "./state.ts";

export type TransitionRow = Readonly<{
  from: NodeState;
  to: NodeState;
  task: boolean;
  objective: boolean;
  initiative: boolean;
  note: string;
}>;

export const transitions: readonly TransitionRow[];

export function canTransition(
  level: NodeKind,
  from: NodeState,
  to: NodeState,
): boolean;
```

`transitions` holds exactly **56** rows: every ordered pair of two different members of `nodeStates` (`8 × 7`). The array is sorted by `nodeStates.indexOf(from)`, then by `nodeStates.indexOf(to)`.

`note` is the `Note` cell of the matching row of `docs/proposal/phase-1/state-machine.md:61-99`, copied verbatim as a single-line string. Four source rows are compressed and expand across several pairs, each expansion carrying that row's note verbatim:

- line 96 `done → blocked` — one pair.
- line 97 `done → any other` — the six pairs `done → pending | ready | running | awaiting_approval | partial | discarded`.
- line 98 `partial → any` — the seven pairs out of `partial`.
- line 99 `discarded → any` — the seven pairs out of `discarded`.

**The allowed cells, exhaustively.** Every pair not listed here is `false` at that level.

`task: true` for these 12 pairs:

```
pending → ready, pending → blocked, pending → discarded,
ready → running, ready → blocked, ready → discarded,
running → ready, running → blocked, running → done,
blocked → pending, blocked → discarded,
done → blocked
```

`objective: true` for these 14 pairs:

```
pending → ready, pending → blocked, pending → discarded,
ready → running, ready → blocked, ready → discarded,
running → blocked, running → awaiting_approval, running → discarded,
blocked → pending, blocked → discarded,
awaiting_approval → blocked, awaiting_approval → done, awaiting_approval → partial
```

`initiative: true` for these 12 pairs:

```
pending → ready, pending → blocked, pending → discarded,
ready → running, ready → blocked, ready → discarded,
running → blocked, running → done, running → partial, running → discarded,
blocked → pending, blocked → discarded
```

`canTransition(level, from, to)`:

- returns `false` when `from === to`. `docs/proposal/phase-1/state-machine.md:103` states that an abandon over an already-`blocked` node writes no transition, so the matrix holds no identity pair.
- otherwise finds the single row with that `from` and `to` and returns its `task`, `objective` or `initiative` field according to `level`.
- the lookup is a module-level `Map` keyed `` `${from}->${to}` ``, built once from `transitions`, so the function does no linear scan.

## Constraints

- Encode the matrix as data and read it. No `switch`, no `if` chain over state names inside `canTransition`.
- Do not derive a row from another row. Every one of the 56 rows is written out.
- `running → ready` is `true` for a task only. `running → done` is `true` for a task and an initiative only. `running → discarded` is `true` for an objective and an initiative only. `done → blocked` is `true` for a task only. These four rows are the ones the levels disagree on — check each against `docs/proposal/phase-1/state-machine.md:76`, `:79`, `:81` and `:96`.
- No aggregation, no readiness, no block-reason logic in this file. Those are Stories 07 and 08.

## Verify

`node --test src/domain/transition.test.ts` — new file, suite `"src/domain/transition.test"`:

- `transitions.length` equals `56`.
- The full cross product is covered exactly once: a loop over `nodeStates × nodeStates` skipping `from === to` collects `` `${from}->${to}` `` into a `Set`, and that set has size `56` and equals the set of keys built from `transitions`. A missing pair therefore fails rather than passing silently.
- No duplicate row: `new Set(transitions.map((row) => \`${row.from}->${row.to}\`)).size`equals`56`.
- `transitions` is sorted: mapping each row to `nodeStates.indexOf(row.from) * 8 + nodeStates.indexOf(row.to)` yields a strictly increasing sequence.
- Every row has a `note` with `note.length > 0` and no `\n`.
- **Exhaustive per-level assertion.** The test declares three literal `Set<string>` constants holding the 12, 14 and 12 allowed pairs above. It then loops the full cross product and asserts, for each pair and each of the three levels, that `canTransition(level, from, to)` equals `allowed[level].has(\`${from}->${to}\`)`. That is 168 assertions and it fails on any drift in either direction.
- `transitions` agrees with `canTransition`: for every row, `row.task === canTransition("task", row.from, row.to)`, and the same for `objective` and `initiative`.
- Identity pairs: for every state and every level, `canTransition(level, state, state)` is `false`.
- Terminal fences, asserted directly:
  - for every `to` other than `partial`, `canTransition(level, "partial", to)` is `false` at all three levels.
  - for every `to` other than `discarded`, `canTransition(level, "discarded", to)` is `false` at all three levels.
  - for every `to` other than `done` and `blocked`, `canTransition(level, "done", to)` is `false` at all three levels; and `canTransition("task", "done", "blocked")` is `true` while the objective and initiative values are `false`.
- The gate is objective-only: for every `from`, `canTransition("task", from, "awaiting_approval")` and `canTransition("initiative", from, "awaiting_approval")` are both `false`.
- A task never reaches `partial`: for every `from`, `canTransition("task", from, "partial")` is `false`.
- Only `blocked → pending` writes `pending`: for every `from` other than `blocked`, `canTransition(level, from, "pending")` is `false` at all three levels.

`npm run verify` exits 0.

Proof: contributes `src/domain/transition.test.ts` to `node --test src/domain/**/*.test.ts`.
