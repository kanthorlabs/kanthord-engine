# Story 08 — Readiness and block reasons

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 03 (`src/domain/state.ts`).

## Change

### `src/domain/readiness.ts` (new)

```ts
import type { BlockReason, NodeState } from "./state.ts";

export type Dependency = Readonly<{
  state: NodeState;
  waived: boolean;
}>;

export function satisfiesDependency(state: NodeState): boolean;

export function isReady(dependencies: readonly Dependency[]): boolean;

export type Clearance = "unblock" | "waive" | "import";

export const blockReasonClearance: Readonly<
  Record<BlockReason, readonly Clearance[]>
>;

export function clearedByUnblock(reason: BlockReason): boolean;
```

Exact behaviour:

- `satisfiesDependency(state)` returns `true` for `"done"` and `"partial"`, `false` for the other six states. `docs/proposal/phase-1/state-machine.md:115`: "A node is `ready` when every dependency is `done` or `partial`."
- `isReady(dependencies)` returns `true` when every dependency with `waived === false` satisfies `satisfiesDependency`. A dependency with `waived === true` is skipped. `docs/proposal/database/edge.md:18`: readiness ignores a row with a `waived_at` value. An empty array returns `true`.
- `blockReasonClearance` maps all six reasons:

  | reason                 | clearances            |
  | ---------------------- | --------------------- |
  | `attempt-limit`        | `["unblock"]`         |
  | `dependency-discarded` | `["waive", "import"]` |
  | `stale-base`           | `["unblock"]`         |
  | `dirty-recovery`       | `["unblock"]`         |
  | `e2e-failed`           | `["import"]`          |
  | `abandoned`            | `["unblock"]`         |

  This is `docs/proposal/phase-1/state-machine.md:82`: `unblock` clears `attempt-limit`, `dirty-recovery`, `stale-base` and `abandoned`; `dependency-discarded` needs `waive` **or** a re-import that rewires the edge; `e2e-failed` clears when the repair objective imports. The value is a list because `dependency-discarded` carries two documented paths, and a single enum member would drop one of them.

- Each list is sorted in the order `["unblock", "waive", "import"]`, so two implementers write the same array.
- `clearedByUnblock(reason)` returns `blockReasonClearance[reason].includes("unblock")`.

## Constraints

- `isReady` answers about dependencies only. It reads no node state, no lease, no repository state. A `needs-reconcile` repository is a scheduler skip per `docs/proposal/phase-1/state-machine.md:118`, not a readiness input.
- `unblock` writes `pending`, never `ready`. This file computes readiness and writes no state. `docs/proposal/phase-1/state-machine.md:83` is the reason.
- `blockReasonClearance` has one entry per member of `blockReasons`. `Record<BlockReason, readonly Clearance[]>` makes a missing entry a type error.
- Every list is non-empty. A block reason with no clearance path would park a node forever.
- Do not import `src/domain/transition.ts` or `src/domain/aggregation.ts`.

## Verify

`node --test src/domain/readiness.test.ts` — new file, suite `"src/domain/readiness.test"`:

- A loop over all eight members of `nodeStates` asserts `satisfiesDependency(state)` equals `state === "done" || state === "partial"`.
- `isReady([])` is `true`.
- `isReady([{ state: "done", waived: false }])` is `true`.
- `isReady([{ state: "partial", waived: false }])` is `true`.
- `isReady([{ state: "done", waived: false }, { state: "partial", waived: false }])` is `true`.
- For each of the six non-satisfying states, `isReady([{ state, waived: false }])` is `false`, and `isReady([{ state: "done", waived: false }, { state, waived: false }])` is `false`.
- For each of the six non-satisfying states, `isReady([{ state, waived: true }])` is `true` — a waived edge is ignored.
- `isReady([{ state: "discarded", waived: true }, { state: "running", waived: false }])` is `false` — one live unsatisfied dependency is enough.
- `Object.keys(blockReasonClearance).length` equals `6`, and every member of `blockReasons` is a key.
- Each of the six mappings is asserted with `assert.deepEqual` against the exact literal array of the table above, including `blockReasonClearance["dependency-discarded"]` deep-equalling `["waive", "import"]`.
- Every list is non-empty, and every member of every list is one of `"unblock"`, `"waive"`, `"import"`.
- `blockReasons.filter(clearedByUnblock)` deep-equals `["attempt-limit", "stale-base", "dirty-recovery", "abandoned"]` — the order is the order of `blockReasons`.
- `clearedByUnblock("dependency-discarded")` is `false` and `clearedByUnblock("e2e-failed")` is `false`.

`npm run verify` exits 0.

Proof: contributes `src/domain/readiness.test.ts` to `node --test src/domain/**/*.test.ts`.
