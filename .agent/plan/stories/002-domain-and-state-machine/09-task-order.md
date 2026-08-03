# Story 09 — Task order

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 02 (`src/domain/identity.ts`).

## Change

### `src/domain/task-order.ts` (new)

```ts
export type DependencyEdge = Readonly<{
  from: string;
  to: string;
  waived: boolean;
}>;

export type TaskOrderInput = Readonly<{
  tasks: readonly string[];
  edges: readonly DependencyEdge[];
}>;

export type TaskOrderErrorCode =
  | "task-order-cycle"
  | "task-order-unknown-task"
  | "task-order-duplicate-task"
  | "task-order-duplicate-edge";

export class TaskOrderError extends Error {
  readonly code: TaskOrderErrorCode;

  constructor(code: TaskOrderErrorCode, message: string) {
    super(message);
    this.name = "TaskOrderError";
    this.code = code;
  }
}

export function taskOrder(input: TaskOrderInput): readonly string[];
```

Edge direction, from `docs/proposal/database/edge.md:8-9,16`: `from` is the dependent task, `to` is the task that must finish first. `to` therefore precedes `from` in the result.

The algorithm runs in five phases, in this exact order. Validation is complete before the walk starts, so the reported error never depends on how far the walk got.

**Phase 1 — validate `input.tasks`.** Walk `input.tasks` in array order. The first id already seen throws `TaskOrderError("task-order-duplicate-task", \`${id} appears twice\`)`. `docs/proposal/database/node.md:7`makes`id` the primary key, so a duplicate is a caller defect, not an ordering question.

**Phase 2 — validate `input.edges`.** Walk `input.edges` in array order. Both endpoint checks run on **every** edge, waived or not, before any edge is dropped:

- an endpoint that is not a member of `input.tasks` throws `TaskOrderError("task-order-unknown-task", \`${id} is not a task of this objective\`)`. Inside one edge, `from`is checked before`to`.
- an edge whose `(from, to)` pair was already seen throws `TaskOrderError("task-order-duplicate-edge", \`${from} -> ${to} appears twice\`)`. `docs/proposal/database/edge.md:11`declares`UNIQUE (from_node, to_node)`, so a repeat is a caller defect. The pair is directed: `(A, B)`and`(B, A)` are two distinct pairs and both are legal input — they form a cycle, which phase 5 reports.

Because both phases scan every edge before the walk, the error a malformed input produces is independent of the order of `input.edges` in every case except which of two malformed edges is named first. That single ordering dependence is intended: the message names the first offender in array order.

**Phase 3 — drop waived edges.** Remove every edge with `waived === true`. `docs/proposal/database/edge.md:18` makes readiness ignore a waived row, so the walk ignores it too. A waived edge still had to pass phase 2.

**Phase 4 — the Kahn walk.** `available` is the set of tasks whose remaining in-degree — the count of surviving edges where the task is the `from` end — is zero. Each round takes the **lexicographically smallest** id in `available`, compared with `<` on the raw id string. `docs/proposal/phase-1/plan-format.md:41`: "a Kahn walk inside the objective that takes the lexicographically smallest identity whenever several tasks are available." `docs/proposal/database/node.md:40`: every compared id carries the `task_` prefix, so a plain string comparison lands on creation order. Removing a task decrements the in-degree of every task that depends on it.

**Phase 5 — detect the cycle.** When the result is shorter than `input.tasks.length`, throw `TaskOrderError("task-order-cycle", "the dependency graph holds a cycle")`. Phase 1 guarantees `input.tasks` holds no duplicate, so a short result is a cycle and nothing else.

`taskOrder` does not validate that an id is a `task_` identity. A caller passes the task ids of one objective, and `docs/proposal/phase-1/plan-format.md:41` scopes the walk to that objective. The function compares whatever strings it is given, and the tie-break is correct for any set of ids that share one prefix.

## Constraints

- No position field, no sort key, no insertion order fallback. `docs/proposal/phase-1/state-machine.md:111` and `docs/proposal/database/node.md:40` state that the ULID is the whole tie-break.
- For a valid input, the result does not depend on the order of `input.tasks` or of `input.edges`. Two valid inputs that differ only by a permutation produce the same array. For a malformed input, the error **code** is likewise permutation-independent within one phase, and only the id named in the message follows array order.
- `graphology` is not imported. `src/domain/` is pure — the walk is hand-written. The `graph` service interface of Story 11 is a separate seam.
- Comparison is `<` on the full id string, not on a sliced ULID. Every task id shares the `task_` prefix, so the two are identical, and a slice would silently accept a mixed-kind list.

## Verify

`node --test src/domain/task-order.test.ts` — new file, suite `"src/domain/task-order.test"`.

Fixed ids, used in every case, chosen so that lexicographic order is `A < B < C < D`:

```
A = "task_01HZY8QF3M4N5P6R7S8T9V0W1A"
B = "task_01HZY8QF3M4N5P6R7S8T9V0W1B"
C = "task_01HZY8QF3M4N5P6R7S8T9V0W1C"
D = "task_01HZY8QF3M4N5P6R7S8T9V0W1D"
```

- Empty input: `taskOrder({ tasks: [], edges: [] })` deep-equals `[]`.
- One task, no edge: deep-equals `[A]`.
- **Tie-break.** `taskOrder({ tasks: [C, A, B], edges: [] })` deep-equals `[A, B, C]` — no edge, so the whole order is the tie-break.
- **Direction.** `taskOrder({ tasks: [A, B], edges: [{ from: A, to: B, waived: false }] })` deep-equals `[B, A]`. `A` depends on `B`, so `B` runs first, and the edge beats the tie-break.
- **Chain.** `tasks: [D, C, B, A]`, edges `B→A`, `C→B`, `D→C` (each `from` depending on `to`) deep-equals `[A, B, C, D]`.
- **Diamond.** `tasks: [A, B, C, D]`, edges `{from: B, to: A}`, `{from: C, to: A}`, `{from: D, to: B}`, `{from: D, to: C}` deep-equals `[A, B, C, D]`.
- **Tie inside a walk.** `tasks: [A, C, B]`, edges `{from: A, to: B}`, `{from: A, to: C}` deep-equals `[B, C, A]` — `B` and `C` are available together and the smaller id goes first.
- **Determinism across repeated runs.** A graph with two unordered tasks — `tasks: [B, A]`, `edges: []` — is walked 100 times in a loop and every result deep-equals `[A, B]`.
- **Determinism under permutation.** For the diamond graph, every one of the 24 permutations of `input.tasks` and, separately, every one of the 24 permutations of `input.edges`, produce a result deep-equal to `[A, B, C, D]`.
- **Waived edge.** `tasks: [A, B]`, edges `[{ from: A, to: B, waived: true }]` deep-equals `[A, B]` — the edge is dropped, so the tie-break decides.
- **Cycle.** `tasks: [A, B]`, edges `{from: A, to: B}` and `{from: B, to: A}` throws, `error instanceof TaskOrderError`, `error.code === "task-order-cycle"`. Both orders of the two edges throw the same code.
- **Self edge is a cycle.** `tasks: [A]`, edges `[{ from: A, to: A, waived: false }]` throws with `code === "task-order-cycle"`. (`docs/proposal/database/edge.md:12` forbids the row; the walk still refuses it.)
- **Unknown endpoint.** `tasks: [A]`, edges `[{ from: A, to: B, waived: false }]` throws with `code === "task-order-unknown-task"` and a message containing `B`. `tasks: [A]`, edges `[{ from: B, to: A, waived: false }]` throws the same code with a message containing `B`.
- **A waived edge is still validated.** `tasks: [A]`, edges `[{ from: A, to: B, waived: true }]` throws with `code === "task-order-unknown-task"` — phase 2 runs before phase 3.
- **Duplicate task.** `tasks: [A, A]`, edges `[]` throws with `code === "task-order-duplicate-task"` and a message containing `A`. `tasks: [A, B, A]` throws the same code. This is the case the earlier draft left contradictory: a duplicate is rejected by name, never reported as a cycle.
- **Duplicate edge.** `tasks: [A, B]`, edges `[{from: A, to: B, waived: false}, {from: A, to: B, waived: false}]` throws with `code === "task-order-duplicate-edge"`. The same pair with `waived: true` on the second entry throws the same code.
- **A reversed pair is not a duplicate.** `tasks: [A, B]`, edges `[{from: A, to: B, waived: false}, {from: B, to: A, waived: false}]` throws `"task-order-cycle"`, not `"task-order-duplicate-edge"`.
- **Validation precedes the walk.** `tasks: [A, A]`, edges `[{ from: A, to: A, waived: false }]` throws `"task-order-duplicate-task"` — phase 1 wins over phase 5.
- **Error code is permutation-independent.** For the input `tasks: [A, B]`, edges `[{from: A, to: C, waived: false}, {from: B, to: A, waived: false}]`, both orders of the edge array throw `"task-order-unknown-task"`.
- **Result is a permutation of the input.** For every passing case above, the result length equals `input.tasks.length` and the sorted result deep-equals the sorted input.

`npm run verify` exits 0.

Proof: contributes `src/domain/task-order.test.ts` to `node --test src/domain/**/*.test.ts`.
