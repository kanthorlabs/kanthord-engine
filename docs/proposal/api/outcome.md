# Outcome and human control

Reviewer: runtime or backend engineer. Conventions are [README.md](README.md). The decisions are `../phase-3/outcomes.md` and `../phase-2/agents-and-workers.md`.

The operations a human calls to clear a stuck graph. Every one of them writes an event that records the human decision.

## Routes

| operationId    | Method and path             | introducedIn | status  | Source                                              |
| -------------- | --------------------------- | ------------ | ------- | --------------------------------------------------- |
| `node.unblock` | `POST /v1/node/:id/unblock` | phase-2      | stubbed | agents-and-workers.md, "manual controls"            |
| `node.abandon` | `POST /v1/node/:id/abandon` | phase-2      | stubbed | outcomes.md, `abandon task` and `abandon objective` |
| `node.discard` | `POST /v1/node/:id/discard` | phase-3      | stubbed | outcomes.md, discard                                |
| `node.waive`   | `POST /v1/node/:id/waive`   | phase-3      | stubbed | outcomes.md, waive                                  |

## One path for abandon

`abandon task` and `abandon objective` are one route. The node kind decides the behaviour, and the client cannot pick the wrong one for the node it names.

- A task resets the workspace to the base object id recorded for that task, and moves the task to `blocked` with reason `abandoned`. The refusal is `409` when the task commits are not at the tip, and `details` names the tasks that sit above.
- An objective resets the workspace to the clone base, and it cascades to every task. The objective and every task that is not `discarded` move to `blocked` with reason `abandoned`.

An abandon parks work and never resumes it. A human then revises the plan, discards the subtree, or calls `node.unblock`. See [../phase-1/state-machine.md](../phase-1/state-machine.md).

Both are refused after integration. `abandon` on a live lease is `409 lease-held`. In phase 2 a human calls it on a stale lease by hand; in phase 3 startup reconciliation reaches the same node first.

## `node.discard`

**The body carries a mandatory `reason`.** `node.discard_reason` exists because approval evidence lists every discarded task with its title and the reason it was discarded, and no other input supplies it. A block reason cannot carry it: a block is a daemon observation, and a discard is a human decision. The reason is stored on every node the discard touches, and the cascade below records the same reason on each descendant.

Discard cascades down the containment tree only, and never along a dependency edge. It is one transaction: the node, every descendant, every dependent it blocks, and every event.

Integrated work cannot be discarded. The refusal is `409` and `details` names the descendants that hold commits.

A discard of B moves every dependent of B to `blocked` with reason `dependency-discarded`. The response lists them, because the human now owns them.

## `node.waive`

The body names the edge by its `edgeId`, which `edge.list` returns. An endpoint pair would be ambiguous to read back and would break the moment a re-import inserts a second edge between the same two nodes.

The route stamps `waived_at` and never deletes the row, so the human decision survives next to its event. Readiness then ignores the edge.

`unblock` alone cannot clear a `dependency-discarded` block, because readiness needs every dependency terminal and successful. A re-import that rewires the edge does the same job through [graph.md](graph.md), and it never clears a waiver, because that would erase a human decision.

## `node.unblock`

Returns the node to `pending`. It clears the block reason and nothing else. It never resets a workspace, so a block that holds commits needs `node.abandon` first.
