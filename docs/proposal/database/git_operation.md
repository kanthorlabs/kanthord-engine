# git_operation

**Question it answers:** a git ref write did not finish. Did it happen?

```sql
CREATE TABLE git_operation (
  id                  TEXT PRIMARY KEY,
  repository_id       TEXT NOT NULL REFERENCES repository(id),                                 -- repository whose refs are written
  intent              TEXT NOT NULL CHECK (intent IN ('merge', 'sync', 'publish', 'revert')),  -- which git write this row journals
  node_id             TEXT REFERENCES node(id),                                                -- objective the write serves
  run_id              TEXT REFERENCES run(id),                                                 -- execution it is attributed to
  candidate_id        TEXT REFERENCES candidate(id),                                           -- candidate being integrated, for a merge
  lease_fence         INTEGER NOT NULL,                                                        -- repository lease generation that authorized the write
  ref                 TEXT NOT NULL,                                                           -- ref written: local for a merge, remote for a publish
  base_oid            TEXT NOT NULL,                                                           -- value the ref must hold before the write
  proposed_head_oid   TEXT NOT NULL,                                                           -- value this attempt intends to write
  result_head_oid     TEXT,                                                                    -- value observed on the ref after the write; it differs after a recompute
  expected_remote_oid TEXT,                                                                    -- publish only: value the remote ref held when checked; null means it must not exist
  state               TEXT NOT NULL CHECK (state IN ('open', 'complete', 'discarded')),        -- open until git answered; startup reconciles every open row
  outcome             TEXT,                                                                    -- classified result: fast-forward, non-fast-forward, auth-failed, policy-rejected, conflict
  detail_blob         TEXT REFERENCES blob(hash),                                              -- verbatim git output, including a policy rejection
  child_token         TEXT,                                                                    -- path of the pid file the launcher writes before it execs git; startup reaps an orphan through it
  completed_at        INTEGER                                                                  -- closed after git returned; the id is the moment before the write
) STRICT;
```

This is the integration journal. Git and SQLite cannot share a transaction, so the row is written before git and completed after. The id is therefore the moment before the git write, and `completed_at` is the moment after. Startup reconciles every row with `state = 'open'` by reading the real ref state.

`proposed_head_oid` and `result_head_oid` are separate. A `merge` proposes a merge commit that a failed compare-and-swap discards, and a recompute must not overwrite what the first attempt intended.

For a `publish`, `base_oid` is the reviewed `landingOid`, `expected_remote_oid` is the object id the remote ref must hold, and `ref` is the `publishRef`. Reconciliation compares `git ls-remote` against these, and it never retries the push.

`expected_remote_oid` is advisory freshness, not a remote compare-and-swap. That is a product decision rather than a tooling limit: `push --force-with-lease` would close the race between the preflight and the push, and this design accepts that race instead, because the server already arbitrates the outcome safely: a non-fast-forward is rejected and recorded, and a stale expectation whose value is already an ancestor of the pushed commit succeeds. A null value means the ref was absent when it was checked, which is a first publication. It is not enforced at push time: another actor can create the ref inside that window, and the push still succeeds when the new value is already an ancestor of the pushed commit. See [../phase-1/git-foundation.md](../phase-1/git-foundation.md).

`result_head_oid` is what `git ls-remote` observed after the push, not proof of what this operation wrote, because another actor can move a remote ref immediately afterwards. Recovery therefore treats an observed value that is neither `base_oid` nor `proposed_head_oid` as "someone else moved it", and reports rather than retries.

`child_token` is the reap record of [../phase-3/recovery.md](../phase-3/recovery.md). It is the path of a pid file, and it is committed **before** the spawn, which a process id cannot be: a pid does not exist until the process does.

The daemon spawns a launcher rather than `git` directly. The launcher writes its own process id into that path and then `exec`s `git`, and `exec` keeps the process id, so the recorded value is the git process itself. The write happens before `git` begins, so an absent pid file means `git` never started and every remnant of that row is stale.

`child_token` is set only while `state = 'open'`, and completing or discarding a row clears it and removes the file. Clearing the token commits first and the file is removed after, because the two cannot be atomic: a removal that preceded a failed commit would leave an open row naming a file that is gone, which the next startup would read as "git never started".

This paragraph governs a journaled operation only. Not every spawn has a row: registration seeds a bare home before its `repository` row exists, and `repository_id` cannot reference a row that is not there while `ref`, `base_oid` and `proposed_head_oid` cannot be filled before the fetch. Such a spawn is recorded by its pid file alone, and [../phase-3/recovery.md](../phase-3/recovery.md) holds that rule. The reap therefore takes both sources — every open row's token, and every pid file in the run directory — and a row is never a precondition of reaping a child.

Startup decides liveness from the file rather than from a recorded timestamp. A pid is this row's child when it is alive **and** its operating-system start time precedes the creation time of the pid file. A process that reused the number necessarily started after the file existed, so the comparison separates them without storing a timestamp that the daemon could crash before writing.

`intent` disambiguates the ref namespace. `merge` and `sync` name a local `refs/heads/*`, and `publish` names a ref on the remote, and both can read `refs/heads/main`. Every query for "the last completed operation on this ref" filters by intent, or it compares a local ref against a remote history.

`detail_blob` holds the verbatim rejection of a publish, which is reported unchanged and never resolved by the daemon.

## Example

```
id                intent   ref              base_oid   proposed_head_oid  expected_remote_oid  state
gitop_01JQ8ZP56J  merge    refs/heads/main  a3f19c...  5c88a1...          (null)               complete
gitop_01JQ8ZP78M  publish  refs/heads/main  5c88a1...  5c88a1...          a3f19c...            open
```

The merge row is written before the `update-ref` of `refs/heads/main` from `a3f19c...` to `5c88a1...`, and closed after it returned. The publish row is written before the push, and the daemon was killed while the push was in flight.

The open row is the whole reason this table exists. The daemon reconciles it with `git ls-remote` for `refs/heads/main`, after startup rather than during it, because that call needs the network. If the remote holds `5c88a1...`, the push succeeded before the crash and the row is completed. If it still holds `a3f19c...`, nothing happened. A blind retry is not a recovery procedure, because the push may have already landed.

`proposed_head_oid` and `result_head_oid` are separate for a merge. A failed compare-and-swap means the landing tip moved, the proposed merge commit is discarded, and a recompute builds a new one — and what the first attempt intended must survive that.
