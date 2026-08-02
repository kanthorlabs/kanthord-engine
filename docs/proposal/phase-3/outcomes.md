# Outcomes

Reviewer: runtime or backend engineer, and whoever approves merges. Phase 3. This file covers an objective that ships less than it declared, and the tools that clear a stuck graph.

## `partial` needs an explicit acknowledgement

The aggregation table is normative in `../phase-1/state-machine.md`. This phase builds the projection.

The terminal state is known before integration, because every task is already terminal when the objective enters `awaiting_approval`. The candidate therefore declares the projected outcome, `done` or `partial`, and lists every discarded task with its title and the reason it was discarded.

When the projection is `partial`, the approval request must carry `acknowledge_partial`. The daemon refuses the approval without it and returns the discarded tasks again. A human can never integrate an incomplete objective by accident. The CLI prints the discarded tasks and asks for a second confirmation.

## Discard

Discard cascades down the containment tree only: initiative to objectives to tasks. It never follows a dependency edge.

Discard is atomic. One transaction writes the node, every descendant, every dependent blocked by the rule below, and every event.

Integrated work cannot be discarded. "Committed" means integrated into the bare home. The eligibility check covers the whole subtree, and a refusal names the descendants that hold commits.

A discarded node blocks its dependents. Task C depends on task B. A discard of B moves C to `blocked` with reason `dependency-discarded`.

## Abandon

Unintegrated work is abandoned, not discarded. A blocked task holding only workspace commits could otherwise never reach a human decision.

`abandon task` resets the workspace to the base object id recorded for that task, so its commits disappear and the commits of the earlier tasks survive. The task returns to `pending`. Tasks run in sequence, so the commits of the current blocked task always sit at the workspace tip, and the reset never touches another task. The daemon refuses the operation when the task commits are not at the tip, and it names the tasks that sit above.

`abandon objective` is the coarse tool for that case. It resets the workspace to the clone base and returns every non-terminal task to `pending`.

Both are refused after integration. Discard of an unintegrated task is legal after its abandon, because no commit remains.

## Clearing a blocked dependency

Clearing a `dependency-discarded` block needs an explicit edge change. `unblock` alone cannot help, because readiness needs every dependency `done`. The human calls `waive` to drop the edge to the discarded node, or re-imports a plan that rewires it. Both write an event that records the human decision.
