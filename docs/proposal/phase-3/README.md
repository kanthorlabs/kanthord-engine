# Phase 3 — Resilience

The name is resilience, not end to end, because "end-to-end check" already names the initiative-level detection run of [../phase-2/gates-and-approval.md](../phase-2/gates-and-approval.md).

## Goal

The daemon survives every path that is not the happy path. Daily use becomes trustworthy on a bad day.

**Blocker removed:** a crash, a race or a discarded dependency costs a corrupted repository or a graph a human cannot clear.

**Exit criteria:** the crash matrix passes at every named boundary, and Ulrich clears every block reason — `attempt-limit`, `dependency-discarded`, `stale-base`, `dirty-recovery` — from the CLI over the VPN.

## Files

| File                       | Subject                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| [recovery.md](recovery.md) | attribution, lease expiry, the journal, import idempotency, races |
| [outcomes.md](outcomes.md) | `partial`, discard, abandon, waive                                |

## Deliverables

- Named failpoints at every durable boundary, and the crash injection harness over the phase 2 fakes.
- Startup order: the exclusive home lock, then the sweep of every `*.lock` file left in a bare home, then the journal, then lease recovery.
- Integration journal reconciliation at startup, including the `listServerRefs` check for an incomplete `publish`.
- Lease expiry recovery. A `running` node whose lease expired returns to `ready` when the tree is clean and its head equals the recorded base, and moves to `blocked` with reason `dirty-recovery` otherwise. This replaces the manual stale-lease clearing of phase 2.
- `stale-base`: the recompute loop, the retry limit, and the invalidation of a recorded check result when the merge commit changes.
- The `partial` projection and `acknowledge_partial`.
- Discard with the subtree check, the dependent block with reason `dependency-discarded`, `abandon objective`, and `waive`.
- Import idempotency: a retry of a committed `import_id` returns the original revision and document.

## Verification

`npm run verify` holds the permutations:

- Recovery: kill execution at each boundary — before and after the task commit, the state write, the event append, the ref update, and the approval — then restart and assert the state converges with no duplicate commit.
- Ref write: a kill between the `.lock` write and the rename leaves the ref at its old value, and startup removes the lock. A kill after the rename leaves the new value, and the journal completes the row. No boundary leaves a truncated ref.
- Home lock: a second daemon against one home refuses to start. A `SIGKILL` releases the lock, so the next start takes it with no manual cleanup.
- Journal: an incomplete `merge` row is completed or discarded by reading the real ref state; an incomplete `publish` row is reconciled from `listServerRefs` and never by a retry. A ref that matches neither `base_oid` nor `proposed_head_oid` reports an outside writer rather than retrying.
- Lease: a `running` node with an expired lease and a clean tree returns to `ready`; with a dirty tree it moves to `blocked` with reason `dirty-recovery`. A discard that races a worker is serialized by the objective lease.
- Integration: an objective integrates from an older base and merges cleanly. A second case touches the same lines and asserts `blocked` with reason `stale-base`. A third changes the landing branch between the freeze and the approval and asserts the compare-and-swap refuses. A fourth forces a recompute and asserts the recorded check result is invalidated and runs again.
- Aggregation: an objective with one `done` task and one `discarded` task projects `partial`, lists the discarded task, refuses an approval without `acknowledge_partial`, then integrates and becomes `partial`, not `done`.
- Discard: a discard of an integrated node fails and names the descendants. A discard of a blocked task fails until `abandon task` runs, then succeeds, and the earlier task commits survive. A discard of B blocks C, and `waive` releases it.
- Import: a crash after the commit loses the response, and a retry of the same `import_id` returns the original revision and document rather than a second revision.

## End-to-end scenarios

The convention, the modes and the evidence format are in [../README.md](../README.md).

### P3-E1 — The crash matrix

- **Mode:** `deterministic`
- **Why it exists:** recovery is the reason the daemon may touch a real repository unattended, and it can only be proven by killing a real process and restarting it.
- **Automation:** `scripts/e2e/run.mjs P3-E1 --failpoint <name>`, once per boundary, and `scripts/e2e/run.mjs P3-E1 --all`
- **Human action:** none. A failpoint pauses at a named durable boundary and announces arrival. The harness sends `SIGKILL` from outside, so real startup reconciliation runs. A failpoint never simulates the recovery outcome.
- **Oracle:** for each boundary — after restart with the same daemon home, `kanthord status` converges to the declared state; the landing branch holds no duplicate commit; the journal has no incomplete row; the event sequence has no gap.
- **Boundaries:** before and after the task commit, the state write, the event append, the ref update, the publish, and the approval. Plus between the `.lock` write and the rename of a ref update, and after the import commit and before the response.
- **Evidence:** one bundle per boundary, each holding the pre-kill and post-restart status and ref state.

### P3-E2 — Recovery of an interrupted attempt

- **Mode:** `deterministic`
- **Why it exists:** phase 2 leaves a stuck node for the human, and the whole point of this phase is that the daemon sorts it out.
- **Automation:** `scripts/e2e/run.mjs P3-E2`
- **Human action:** none
- **Oracle:** a `running` node killed with a clean tree at the recorded base returns to `ready` after restart and runs again. A `running` node killed with a dirty tree moves to `blocked` with reason `dirty-recovery`, names the dirty paths, and `abandon task` clears it.
- **Evidence:** the workspace state and the lease record before and after.

### P3-E3 — Stale base and the recompute loop

- **Mode:** `deterministic`
- **Why it exists:** the landing branch moves between the freeze and the update whenever anything else integrates, and a wrong answer merges untested code.
- **Automation:** `scripts/e2e/run.mjs P3-E3`
- **Method:** a failpoint holds the objective after its unit check and before the ref update, while the harness advances the landing branch through the public surface.
- **Oracle:** the compare-and-swap fails, the precomputed merge commit is discarded, a new merge commit is built against the new tip, and the unit check runs again against that new merge commit before the ref moves. A content conflict instead reaches `blocked` with reason `stale-base`. Retry exhaustion also reaches `blocked`.
- **Evidence:** the object id of each discarded and rebuilt merge commit, and the check result attached to each.

### P3-E4 — Clearing a graph a human must untangle

- **Mode:** `deterministic`
- **Why it exists:** the exit criterion is a human clearing every block reason, and these operations mutate the graph and the workspace together.
- **Automation:** `scripts/e2e/run.mjs P3-E4`
- **Human action:** none. The runner supplies `acknowledge_partial` where the procedure requires it, and records that it did.
- **Oracle:**
  - An objective with one `done` and one `discarded` task projects `partial`, lists the discarded task, and refuses approval without `acknowledge_partial`. With it, the objective integrates and reports `partial`, not `done`.
  - A discard of an integrated node is refused and names the descendants that hold commits.
  - A discard of task B moves dependent C to `blocked` with reason `dependency-discarded`, and `waive` releases it.
  - `abandon objective` returns every non-terminal task to `pending` and resets the workspace to the clone base.
- **Evidence:** the graph state before and after each operation, and the event written for each human decision.

### P3-E5 — A crash during a remote-driven run

- **Mode:** `deployment`
- **Why it exists:** the exit criterion places the human on a second machine, and a daemon that recovers locally but reports incoherently to a remote client has not recovered as far as the human is concerned.
- **Automation:** `scripts/e2e/run.mjs P3-E5 --daemon-host <a> --client-host <b>`
- **Human action:** none
- **Oracle:** the client drives a run, the harness kills the daemon at one boundary, the daemon restarts, and the client observes the converged state and the block reason through the CLI alone. Every block reason is cleared from the client host.
- **Evidence:** the client-side transcript and both host identities.
