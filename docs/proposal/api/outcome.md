# Outcome and human control

Reviewer: runtime or backend engineer. Conventions are [README.md](README.md). The decisions are `../phase-3/outcomes.md` and `../phase-2/agents-and-workers.md`.

The operations an actor calls to clear a stuck graph. Every one of them writes an event that records the decision.

## Routes

| operationId    | Method and path             | introducedIn | status  | Source                                                |
| -------------- | --------------------------- | ------------ | ------- | ----------------------------------------------------- |
| `node.report`  | `POST /v1/node/:id/report`  | phase-1      | routed  | 013-external-drive-overview.md, external drive report |
| `node.unblock` | `POST /v1/node/:id/unblock` | phase-1      | routed  | agents-and-workers.md, "manual controls"              |
| `node.abandon` | `POST /v1/node/:id/abandon` | phase-2      | stubbed | outcomes.md, `abandon task` and `abandon objective`   |
| `node.discard` | `POST /v1/node/:id/discard` | phase-3      | stubbed | outcomes.md, discard                                  |
| `node.waive`   | `POST /v1/node/:id/waive`   | phase-3      | stubbed | outcomes.md, waive                                    |

## node.report

One route, and the node kind decides the behaviour. It repeats the one-path rule of [One path for abandon](#one-path-for-abandon) rather than restating it.

- A task report carries one of `accepted`, `rejected`, `failed` and `cancelled`. `accepted` moves the task `running → done` and records the reported object id. `rejected`, `failed` and `cancelled` close the attempt and return the task to `ready` under the attempt limit, and reach `blocked` with reason `attempt-limit` at the limit.
- `timed-out` is not a reported outcome, because an external attempt carries no timeout budget.
- A task report requires a live lease on the task: a matching owner, a matching fence and an unexpired row. Every refusal is `409 lease-held`.
- The authenticated actor is the owner. The request body carries no owner field.
- An objective report with `attested` carries the combined object id, moves the objective `running → awaiting_approval` and releases the objective lease. The daemon infers no objective result.
- An objective report with `closed` carries `acknowledgePartial` only. The daemon derives `done` or `partial` from the task states. A derived `partial` with no acknowledgement is `409 acknowledgement-required`.
- A report on an initiative is `400 invalid-request`.
- A task report admits a `harness` actor, an attestation admits a `harness` actor, and a close admits a `human` actor.

The `node report` task CLI admits exactly these `--outcome` values, in this order: `accepted`, `rejected`, `failed` and `cancelled`. `accepted` requires `--object-id` and refuses `--reason`; `rejected` and `failed` require a non-empty `--reason` and refuse `--object-id`; `cancelled` admits an optional non-empty reason and refuses `--object-id`.

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

Only a human can call `node.unblock`. It clears `attempt-limit` and no other block reason.

- A blocked task with `attempt-limit` returns to `pending`, then readiness promotes it to `ready` when its dependencies are satisfied.
- `dependency-discarded`, `dirty-recovery`, `stale-base` and `abandoned` refuse with `409 illegal-transition`.
- An objective or initiative refuses with `400 invalid-request`. A task that is not blocked refuses with `409 illegal-transition`.
- The route reads no lease and resets no workspace. A block that holds commits needs `node.abandon` first.
