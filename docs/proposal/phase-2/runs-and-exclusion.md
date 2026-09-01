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

## base is a set qualified by repository

The base set lives in `run_base`, keyed by run and repository. An `execution` run holds at most one row. A `structural` or `review` run holds none, because a structural run claims an initiative, which owns no repository. The lower bound rises to exactly one in the epic that writes the row. `graph_revision` is recorded on every run and compared only at the structural checkpoint.

## Provenance is two columns, not a blob

The run holds the worker id and the agent list from the registry entry. An external run records an empty agent list, because a self-managed harness selects its own agents and the daemon observes none. The daemon knows both at claim time and asks the worker for neither.

## Both run budgets are configuration

`runTtlMs` and `runMaxLifetimeMs` are settings, and both are validated at startup. A `runTtlMs` below 1000 is refused. A `runMaxLifetimeMs` below `runTtlMs` is refused. A non-integer is refused. A run carries both budgets as absolute timestamps. The renew formula belongs to the epic that ships the renew.
