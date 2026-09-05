# Runs and exclusion

Reviewer: runtime or backend engineer. Phase 2. What a checkpoint is belongs to `checkpoints.md`. This file is the run that carries one.

## Three run kinds, selected by the node deliverable

A run is `structural`, `execution` or `review`. The daemon maps `expansion` to `structural`, `test` and `implementation` to `execution`, and `review` to `review`. Worker metadata does not select the kind. `research` is absent because this phase defers that deliverable.

## The run owns the fence

The fence is a counter on the run. Every later write carries the run id and the fence. The daemon raises the fence when it ends a run, and at no other time. The authority section of a later epic defines what a later write does with the pair.

## A run covers the claimed node and every descendant

At most one active run covers a node. The `run_one_active` partial index defends the same-node case only. The subtree rule is a pure function over the ancestor, descendant and target sets. A run whose expiry has passed is not counted, and the boundary instant is expired.

## One active run per objective branch, and a task claim is refused rather than queued

The daemon refuses a second active run in one objective branch with `objective-busy`. The subtree rule refuses an active run over the claimed node with `subtree-busy`. The refusal names the sibling node id, its run id and that run's `expires_at`, so a client knows what it waits on and until when. The daemon holds no queue. A blocking wait would hold one request open for a run lifetime, and a queue would make the daemon a scheduler. The caller retries. One liveness predicate governs this rule and the subtree rule, so the two cannot disagree about an expired run.

## A task claim opens an objective run and a task run

At the first task claim on an unassigned node, the daemon writes `node.assignment`, opens the structural objective run and inserts the execution task run in one storage transaction. Later task claims under the same objective reuse its active objective run and open their own task run. One operation prevents a crash from leaving an assignment without its authority, which would make the next claim read an assignment that nobody holds. The claim uses an immediate write transaction, so two sibling claims serialize and the loser sees the winner's objective run.

## An unassigned node routes, and an assigned node compares

An unassigned node routes to the first worker in the intersection of capable, authorized and available workers. An assigned node compares the assignment with the claiming worker. A mismatch refuses `assignment-held` and offers a human a worker switch. An ordinary failure never changes an assignment. The worker switch in EPIC 056 is the only operation that changes one.

## The caller asserts availability, and the daemon never probes

A worker runs a self health check before it claims. The claim request carries `available`. A false value refuses `unroutable` with `failedSet: "available"`. The daemon trusts a caller that asserts true when the worker is not available. The guarantees table records this trust.

## The claim has one path

A node with a null `deliverable` is refused `pair-illegal`. The column stays nullable until EPIC 057, and the claim dispatches on no other shape. An initiative claim opens one structural run. A task claim opens or reuses the structural objective run and opens one execution task run, and it never adopts a task run. A second claim by the same worker on a node with an active run is refused with `subtree-busy`. Retrying a lost response is the transport's job.

## The refusal order is fixed

The claim uses one total refusal order:

1. `node-not-found`
2. `pair-illegal`
3. `plan-incomplete`
4. `assignment-held`
5. `unroutable`
6. `review-head-unavailable`
7. `lease-held`
8. `drive-mode-pinned`
9. `objective-busy`
10. `subtree-busy`
11. `illegal-transition`
12. `ancestor-not-startable`

A claim that fails two conditions reports the earlier one, so a client sees the cause it can act on first. Every refusal is evaluated before the first mutation: before a lease is taken, a run is opened, an attempt is opened, a node state changes or an event is appended. A refusal writes nothing. A node whose deliverable is `expansion` is exempt from the completeness check for its own missing children, because producing those children is the work.

## A review claim is refused until the workspace exists

A review run records the commit it judges at claim time. This phase creates no workspace record, so no head can be pinned. The refusal is `review-head-unavailable`. A null pin is not an option: a value written later records a commit chosen after the claim, which is the retrospective choice that the pin prevents.

## Every run operation evaluates expiry first

Every run operation evaluates expiry first. The claim runs the expiry pass before anything else, inside its one transaction. Sweeping only at the next claim would leave an expired run able to renew itself back to life. The expiry is a conditional update, so two racing sweeps cannot raise the fence twice, and the transition and its event are one transaction. Expiry is transactional maintenance: a command that expires a run and then refuses rolls the expiry back with everything else, because a refusal writes nothing. The next operation sweeps the run again. Renew, release and report run the same pass in EPIC 050.2.

## Run authority

A write is admitted only when its run is active, unexpired, held by the caller, bound to the target and carrying the current fence. The six refusal codes appear in this fixed order:

1. `run-not-found`
2. `run-ended`
3. `run-expired`
4. `run-caller-mismatch`
5. `target-outside-run`
6. `fence-stale`

A refusal names the run id and the reason only. It never returns the current fence, because giving its replacement value to a writer with a stale fence would give that writer the authority the raise was meant to remove.

The target is bound to the run when it is the run's own node or a descendant in that node's subtree.

A renew sets `expires_at = min(now + runTtlMs, max_lifetime_at)` and refuses `lifetime-exceeded` when `now >= max_lifetime_at`.
A renew never changes the fence.

A release means that a worker voluntarily ends its run with no checkpoint. The node returns to `ready`, the open attempt is cancelled, the run ends and the fence rises.

A transitional renew renews both leases until EPIC 050.4 Story 4 removes the node lease without changing wire shape.

The expiry pass and release paths append exactly one of `run.ended` or `run.expired`, never both and never neither, in the same transaction as the transition and the fence raise. The report path remains outstanding for EPIC 050.4 Story 6.

## base is a set qualified by repository

The base set lives in `run_base`, keyed by run and repository. An `execution` run holds at most one row. A `structural` or `review` run holds none, because a structural run claims an initiative, which owns no repository. The lower bound rises to exactly one in the epic that writes the row. `graph_revision` is recorded on every run and compared only at the structural checkpoint.

## Provenance is two columns, not a blob

The run holds the worker id and the agent list from the registry entry. An external run records an empty agent list, because a self-managed harness selects its own agents and the daemon observes none. The daemon knows both at claim time and asks the worker for neither.

## Both run budgets are configuration

`runTtlMs` and `runMaxLifetimeMs` are settings, and both are validated at startup. A `runTtlMs` below 1000 is refused. A `runMaxLifetimeMs` below `runTtlMs` is refused. A non-integer is refused. A run carries both budgets as absolute timestamps. The renew formula belongs to the epic that ships the renew.
