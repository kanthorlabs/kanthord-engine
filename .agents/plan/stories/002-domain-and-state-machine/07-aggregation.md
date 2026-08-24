# Story 07 — Aggregation per level

Epic: `.agents/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 03 (`src/domain/state.ts`), Story 06 (`src/domain/transition.ts`, for the agreement test only).

Two files. `aggregation.ts` projects the children onto a terminal outcome. `outcome.ts` maps that projection onto the state the parent actually enters, which is not the same value at either level.

## Change

### 1. `src/domain/aggregation.ts` (new)

```ts
import type { NodeKind, TerminalState } from "./state.ts";

export type ParentKind = Extract<NodeKind, "objective" | "initiative">;

export type AggregationErrorCode = "empty-parent" | "invalid-child-state";

export class AggregationError extends Error {
  readonly code: AggregationErrorCode;

  constructor(code: AggregationErrorCode, message: string) {
    super(message);
    this.name = "AggregationError";
    this.code = code;
  }
}

export function aggregate(
  parent: ParentKind,
  children: readonly TerminalState[],
): TerminalState;
```

Exact behaviour, in this order:

1. `children.length === 0` throws `AggregationError("empty-parent", \`an ${parent} with no child is invalid\`)`. `docs/proposal/phase-1/state-machine.md:45` makes an objective with no tasks and an initiative with no objectives invalid.
2. `parent === "objective"` and any child is `"partial"` throws `AggregationError("invalid-child-state", "a task is never partial")`. An objective's children are tasks, and `docs/proposal/database/node.md:30` forbids a `partial` task.
3. `children.every((child) => child === "done")` returns `"done"`.
4. `children.every((child) => child === "discarded")` returns `"discarded"`.
5. Otherwise returns `"partial"`.

Step 5 is total. It covers `{done, discarded}` from `docs/proposal/phase-1/state-machine.md:31`, and it covers the three combinations that line leaves open at the initiative level — `{done, partial}`, `{partial}` and `{partial, discarded}` — because a `partial` objective already shipped some work and discarded some, so it carries both facts upward.

`docs/proposal/phase-1/state-machine.md:33` states the same rule: "A `partial` child counts as both. It carries one `done` and one `discarded` into its parent." The Initiative row at `:41` reaches `partial` when at least one objective is `discarded` **or** `partial`.

`aggregate` takes no `"task"` parent. A task has no child, and the type rejects the call at compile time.

**`aggregate` returns a projection, never a transition target.** `docs/proposal/database/candidate.md:15` names the same value `projected_outcome`, "known before integration, because every task is terminal". An objective whose tasks are all `done` projects `done`, and yet `canTransition("objective", "running", "done")` is `false` — the objective enters `awaiting_approval` first. `outcome.ts` below is the mapping, and no caller may treat an `aggregate` result as a state.

### 2. `src/domain/outcome.ts` (new)

```ts
import type { NodeState, TerminalState } from "./state.ts";

export const e2eResults = [
  "pending",
  "passed",
  "failed",
  "not-applicable",
] as const;

export type E2eResult = (typeof e2eResults)[number];

export type LevelOutcome = Readonly<
  | { state: Exclude<NodeState, "blocked">; blockReason: null }
  | { state: "blocked"; blockReason: "e2e-failed" }
>;

export function objectiveOutcome(projected: TerminalState): LevelOutcome;

export function initiativeOutcome(
  projected: TerminalState,
  e2e: E2eResult,
): LevelOutcome;
```

A returned `state` equal to the parent's current state means "write no transition". Every other value is the target state, and it is a legal edge out of `running` at that level.

`objectiveOutcome(projected)`, from the Objective row of `docs/proposal/phase-1/state-machine.md:38`:

| projected   | result                                              | source                                                                                                                        |
| ----------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `discarded` | `{ state: "discarded", blockReason: null }`         | "every task is `discarded`" reaches `discarded` directly                                                                      |
| `done`      | `{ state: "awaiting_approval", blockReason: null }` | "every task is terminal and at least one task is `done`" reaches the gate; `done` arrives only after approval and integration |
| `partial`   | `{ state: "awaiting_approval", blockReason: null }` | the same gate; `partial` arrives after approval carrying `acknowledge_partial`                                                |

`initiativeOutcome(projected, e2e)`, from the Initiative row of `docs/proposal/phase-1/state-machine.md:39` and the paragraph at `:41`, evaluated in this order:

1. `projected === "discarded"` returns `{ state: "discarded", blockReason: null }`, whatever `e2e` holds. `docs/proposal/phase-1/state-machine.md:41` runs the check "when the last objective integrates". Every objective is discarded, so nothing integrated and no check exists.
2. `e2e === "pending"` returns `{ state: "running", blockReason: null }` — "the initiative stays non-terminal until it returns".
3. `e2e === "failed"` returns `{ state: "blocked", blockReason: "e2e-failed" }`.
4. `e2e === "passed"` or `e2e === "not-applicable"` returns `{ state: projected, blockReason: null }`. `docs/proposal/phase-1/state-machine.md:41` makes `not-applicable` the MVP value, so an MVP initiative always takes this branch.

`e2eResults` holds `"pending"` as a distinct member. An absent or in-flight check is not the same fact as `not-applicable`, and collapsing the two would terminalize an initiative before the check returns.

## Constraints

- The function reads only the child states. It reads no clock, no id, and no order — the result is invariant under a permutation of `children`.
- `aggregate` never returns a non-terminal state. Aggregation leaves `running` per `docs/proposal/phase-1/state-machine.md:53`.
- Neither file writes a transition, reads a clock, or touches storage. `outcome.ts` returns the target state, and the phase-2 command writes it inside the transaction that appends the event.
- Neither file imports `src/domain/transition.ts`. `outcome.ts` states the enabled edge; `transition.ts` states the legal edge. The test asserts they agree; the code does not chain them.
- **The completeness precondition is the caller's.** `readonly TerminalState[]` proves every supplied child is terminal. It does not prove that every child of the parent was supplied, that the snapshot is current, or that the read and the write share one transaction. `docs/proposal/phase-1/state-machine.md:53` — "A parent is `running` while any child is non-terminal" — is the rule, and the phase-2 command that loads the authoritative child set inside the write transaction is what enforces it. EPIC 002 delivers no such enforcement and must not pretend the type is one.

## Verify

`node --test src/domain/aggregation.test.ts` — new file, suite `"src/domain/aggregation.test"`:

**Literal table, objective parent** — children drawn from `["done", "discarded"]`, every tuple of size 1 and 2, six rows, each asserted as an exact literal:

| children                     | result        |
| ---------------------------- | ------------- |
| `["done"]`                   | `"done"`      |
| `["discarded"]`              | `"discarded"` |
| `["done", "done"]`           | `"done"`      |
| `["done", "discarded"]`      | `"partial"`   |
| `["discarded", "done"]`      | `"partial"`   |
| `["discarded", "discarded"]` | `"discarded"` |

**Literal table, initiative parent** — children drawn from `["done", "partial", "discarded"]`, every tuple of size 1 and 2, twelve rows, each asserted as an exact literal:

| children                     | result        |
| ---------------------------- | ------------- |
| `["done"]`                   | `"done"`      |
| `["partial"]`                | `"partial"`   |
| `["discarded"]`              | `"discarded"` |
| `["done", "done"]`           | `"done"`      |
| `["done", "partial"]`        | `"partial"`   |
| `["done", "discarded"]`      | `"partial"`   |
| `["partial", "done"]`        | `"partial"`   |
| `["partial", "partial"]`     | `"partial"`   |
| `["partial", "discarded"]`   | `"partial"`   |
| `["discarded", "done"]`      | `"partial"`   |
| `["discarded", "partial"]`   | `"partial"`   |
| `["discarded", "discarded"]` | `"discarded"` |

**Generated sweep, size 3** — a nested loop builds every 3-tuple: 8 for the objective parent, 27 for the initiative parent. Each is compared against a count-based oracle written in the test:

```
const doneCount = children.filter((c) => c === "done").length;
const discardedCount = children.filter((c) => c === "discarded").length;
const expected =
  doneCount === children.length ? "done"
  : discardedCount === children.length ? "discarded"
  : "partial";
```

**Permutation invariance** — for each 3-tuple of the initiative sweep, `aggregate("initiative", tuple)` equals `aggregate("initiative", [...tuple].reverse())`.

**Errors**:

- `aggregate("objective", [])` throws with `code === "empty-parent"`.
- `aggregate("initiative", [])` throws with `code === "empty-parent"`.
- `aggregate("objective", ["partial"])` throws with `code === "invalid-child-state"`.
- `aggregate("objective", ["done", "partial"])` throws with `code === "invalid-child-state"`.
- Every thrown error satisfies `error instanceof AggregationError`.

**Result domain** — across every case above, the returned value is a member of `terminalStates` and is never `"running"`, `"pending"`, `"ready"`, `"blocked"` or `"awaiting_approval"`.

`node --test src/domain/outcome.test.ts` — new file, suite `"src/domain/outcome.test"`:

- `e2eResults` deep-equals `["pending", "passed", "failed", "not-applicable"]`.
- **`objectiveOutcome`, all three inputs, exact literals:**

  | input         | result                                              |
  | ------------- | --------------------------------------------------- |
  | `"done"`      | `{ state: "awaiting_approval", blockReason: null }` |
  | `"partial"`   | `{ state: "awaiting_approval", blockReason: null }` |
  | `"discarded"` | `{ state: "discarded", blockReason: null }`         |

- `objectiveOutcome("done").state` is **not** `"done"`. This is the assertion that stops an implementer treating a projection as a target.
- **`initiativeOutcome`, the full 3 × 4 cross product**, twelve rows asserted as exact literals:

  | projected   | `pending`   | `passed`    | `failed`                 | `not-applicable` |
  | ----------- | ----------- | ----------- | ------------------------ | ---------------- |
  | `done`      | `running`   | `done`      | `blocked` / `e2e-failed` | `done`           |
  | `partial`   | `running`   | `partial`   | `blocked` / `e2e-failed` | `partial`        |
  | `discarded` | `discarded` | `discarded` | `discarded`              | `discarded`      |

  The `discarded` row is constant across every `e2e` value, including `"failed"`.

- `blockReason` is `null` in every result except the two `e2e-failed` cells, where it is `"e2e-failed"` and the state is `"blocked"`.
- **Agreement with the matrix.** A loop over every result of both functions asserts that either `result.state === "running"` — no transition — or `canTransition(level, "running", result.state)` from `src/domain/transition.ts` is `true`, with `level` being `"objective"` or `"initiative"`. That fails if `outcome.ts` ever names an edge the matrix forbids.
- **The gate is reachable only where the matrix allows it.** `objectiveOutcome` never returns `"done"` or `"partial"` as a state, because `canTransition("objective", "running", "done")` is `false`. `initiativeOutcome` never returns `"awaiting_approval"`, because `canTransition("initiative", from, "awaiting_approval")` is `false` for every `from`.
- Every returned `blockReason` that is not `null` is a member of `blockReasons`.

`npm run verify` exits 0.

Proof: contributes `src/domain/aggregation.test.ts` and `src/domain/outcome.test.ts` to `node --test src/domain/**/*.test.ts`.
