# Recovery

Reviewer: runtime or backend engineer. Phase 3. The states are `../phase-1/state-machine.md`. This file is what happens when execution stops in the middle.

## Attribution, not idempotence

Agent work is attributed, not idempotent. A model call is not repeatable. The invariant is that every side effect is attributed to a run and an attempt, and that recovery detects it. Recovery reads the workspace head, the dirty state of the tree and the lease owner, then resumes or abandons.

Execution is at-least-once. Recovery follows the attribution rule and the integration journal, not an idempotency claim.

## Lease expiry

A `running` node found at startup whose lease has expired: the workspace is clean and its head equals the recorded base, so the task returns to `ready`; otherwise it moves to `blocked` with reason `dirty-recovery`, and the human abandons or inspects.

This replaces the manual stale-lease clearing of phase 2. See `../phase-2/agents-and-workers.md`.

## Startup order

Startup takes the exclusive lock on the daemon home before it reads anything. Everything below runs while holding it, and no operation starts until it finishes.

1. Take the home lock. A second daemon refuses to start and names the holder.
2. Remove every `*.lock` file left in a bare home. The home lock guarantees these belong to this home's dead predecessor, and no running operation ever removes a lock it did not create.
3. Reconcile the journal below.
4. Recover expired leases.

## The integration journal

The daemon writes a `git_operation` row with intent, base and head object ids before it touches git, and marks the row complete after. Intents are `merge`, `sync`, `publish` and `revert`.

Startup reconciles every incomplete row by reading the real ref state:

- `merge` and `sync`: compare the landing ref against the recorded base and head, and complete or discard the row.
- `publish`: compare `listServerRefs` for `<publishRef>` against the recorded `landingOid`. A blind retry is not a recovery procedure, because the push may have succeeded before the crash. A value that matches neither the base nor the proposed head means an outside actor moved the ref, and that is reported rather than retried.

## Import

Import is one database transaction, because the daemon holds no plan files. A crash before the commit changes nothing, and the client sends the request again. A crash after the commit loses the response, and the client cannot tell whether the import committed. A retry of the same client-minted `import_id` returns the original revision and the original rewritten document, and it never writes a second revision. See `../phase-1/plan-format.md`.

## Divergence with upstream

A landing branch that diverged from upstream moves the repository to `needs-reconcile` and refuses new objective clones. The daemon never repairs it by resetting or force-updating. Reconciliation is an explicit, verified operation. See `../phase-2/integration-and-publish.md`.

## Races

A discard that races a worker is serialized by the objective lease. The eligibility check runs while holding it.
