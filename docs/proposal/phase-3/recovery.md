# Recovery

Reviewer: runtime or backend engineer. Phase 3. The states are `../phase-1/state-machine.md`. This file is what happens when execution stops in the middle.

## Attribution, not idempotence

Agent work is attributed, not idempotent. A model call is not repeatable. The invariant is that every side effect is attributed to a run and an attempt, and that recovery detects it. Recovery reads the workspace head, the dirty state of the tree and the lease owner, then resumes or abandons.

Execution is at-least-once. Recovery follows the attribution rule and the integration journal, not an idempotency claim.

## Lease expiry

A `running` node found at startup whose lease has expired: the workspace is clean and its head equals the recorded base, so the task returns to `ready`; otherwise it moves to `blocked` with reason `dirty-recovery`, and the human abandons or inspects.

This replaces the manual stale-lease clearing of phase 2. See `../phase-2/agents-and-workers.md`.

## The integration journal

The daemon writes an `operation` row with intent, base and head object ids before it touches git, and marks the row complete after. Intents are `merge`, `sync`, `publish` and `revert`.

Startup reconciles every incomplete row by reading the real ref state:

- `merge` and `sync`: compare the landing ref against the recorded base and head, and complete or discard the row.
- `publish`: compare `git ls-remote origin <publishRef>` against the recorded `landingOid`. A blind retry is not a recovery procedure, because the push may have succeeded before the crash.

## Import

Import stages across the filesystem and the database. A crash before the database commit leaves the source files untouched. A crash between the database commit and the rename leaves the database ahead, and the next import detects it by the graph revision and finishes the rename. See `../phase-1/plan-format.md`.

## Divergence with upstream

A landing branch that diverged from upstream moves the repository to `needs-reconcile` and refuses new objective clones. The daemon never repairs it by resetting or force-updating. Reconciliation is an explicit, verified operation. See `../phase-2/integration-and-publish.md`.

## Races

A discard that races a worker is serialized by the objective lease. The eligibility check runs while holding it.
