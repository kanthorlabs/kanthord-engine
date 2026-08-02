# State machine

Reviewer: runtime or backend engineer. Phase 1 defines the machine. Phase 2 drives it on the happy path. Phase 3 handles everything else.

## States

Non-terminal:

| State               | Meaning                                                  | Leaves by    |
| ------------------- | -------------------------------------------------------- | ------------ |
| `pending`           | dependencies are not satisfied                           | scheduler    |
| `ready`             | a worker can claim it                                    | worker claim |
| `running`           | a worker holds the lease                                 | agent result |
| `blocked`           | attempt limit reached, dependency invalid, or base stale | human        |
| `awaiting_approval` | work is complete, the human gate is open                 | human        |

Terminal: `done`, `partial`, `discarded`.

Block reasons: `attempt-limit`, `dependency-discarded`, `stale-base`, `dirty-recovery`, `e2e-failed`.

## There is no terminal error state

A failed task parks in `blocked`. A human clears it. The scheduler never propagates failure by itself.

## Terminal states and aggregation

A parent whose children are all terminal is not always `done`. `done` means every child is `done`. `partial` means at least one child is `done` and at least one is `discarded`. `discarded` means every child is `discarded`. A task has no children, so a task is never `partial`.

The levels do not share one rule. This table is normative.

| Level      | Reaches `awaiting_approval`                            | Reaches `done`                                                                  | Reaches `partial`                                         | Reaches `discarded`                              |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------ |
| Task       | never                                                  | verification passes and `re@1` accepts                                          | never                                                     | human discard                                    |
| Objective  | every task is terminal and at least one task is `done` | integration succeeds and every task is `done`                                   | integration succeeds and at least one task is `discarded` | every task is `discarded`, or human discard      |
| Initiative | never                                                  | every objective is `done`, and the end-to-end check passed or is not applicable | as `done`, but at least one objective is `discarded`      | every objective is `discarded`, or human discard |

An initiative does not become terminal the moment its objectives do. When the last objective integrates, the end-to-end check runs, and the initiative stays non-terminal until it returns. A failure moves the initiative to `blocked` with reason `e2e-failed`. Initiative end-to-end detection is deferred past the MVP, so an MVP initiative always records `not-applicable`.

An objective that reaches `partial` still integrated. `partial` records that the objective shipped less than it declared, so a status view can show it without a human reading every task.

An objective with no tasks, or an initiative with no objectives, is invalid. Import rejects it.

The `partial` projection and `acknowledge_partial` are built in phase 3. See `../phase-3/outcomes.md`.

## Task order

Task order comes from the dependency graph, with a deterministic tie-break. The graph has a root, and edges express sequence and parallelism. Tasks that share one objective still run one at a time, because they share a working tree. The runner walks the topological order and breaks a tie by ULID, which sorts by creation time. No position field exists. Two tasks with no edge between them therefore run in an arbitrary but reproducible order, which is correct only if they are truly independent.

## Rules

- A node is `ready` when every dependency is `done` or `partial`. `partial` satisfies a dependency, because it shipped work and holds no error.
- Attempt accounting belongs to the domain. Each rejection increments the attempt counter. The limit moves the task to `blocked` with reason `attempt-limit`. The default limit is 3, from configuration.
- Execution is at-least-once. Agent work is attributed, not idempotent, because a model call is not repeatable. The invariant is that every side effect is attributed to a run and an attempt, and that recovery detects it. See `../phase-3/recovery.md`.
- A repository in `needs-reconcile` gets no new objective clone. Its objectives stay `ready`, the scheduler skips them, and `status` names the repository. This is a repository state, not a node block reason, because the divergence is between the landing branch and remote origin rather than in any one candidate. See `../phase-2/integration-and-publish.md`.
