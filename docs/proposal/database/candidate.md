# candidate

**Question it answers:** what exactly am I approving, and is it still what is there?

```sql
CREATE TABLE candidate (
  id                   TEXT PRIMARY KEY,
  node_id              TEXT NOT NULL REFERENCES node(id),                                   -- objective being approved
  run_id               TEXT NOT NULL REFERENCES run(id),                                    -- objective run that froze it
  workspace_id         TEXT NOT NULL REFERENCES workspace(id),                              -- clone the candidate commit lives in
  revision             TEXT NOT NULL,                                                       -- freeze revision the approval request must carry
  candidate_oid        TEXT NOT NULL,                                                       -- the frozen commit the authoritative unit check ran against
  landing_base_oid     TEXT NOT NULL,                                                       -- landing tip at freeze; the compare-and-swap expects it
  merge_oid            TEXT,                                                                -- merge commit built from the two above; a recompute replaces it
  projected_outcome    TEXT NOT NULL CHECK (projected_outcome IN ('done', 'partial')),      -- known before integration, because every task is terminal
  evidence_blob        TEXT NOT NULL REFERENCES blob(hash),                                 -- frozen evidence: diff, commits, discarded tasks and their reasons
  profile_blob         TEXT NOT NULL REFERENCES blob(hash),                                 -- profile in force, so a later edit cannot redefine the approval
  convention_version   TEXT NOT NULL,                                                       -- verification convention in force
  state                TEXT NOT NULL CHECK (state IN ('open', 'approved', 'invalidated')),  -- invalidated once the workspace stopped matching the freeze
  acknowledged_partial INTEGER,                                                             -- 1 when the human acknowledged a partial outcome
  publish_requested    INTEGER,                                                             -- 1 to chain a publish onto this approval
  approved_actor       TEXT,                                                                -- who approved
  approved_at          INTEGER,                                                             -- when they approved
  invalidated_at       INTEGER,                                                             -- when the freeze stopped matching
  invalidated_reason   TEXT,                                                                -- what changed, so the human knows what to review again
  updated_at           INTEGER NOT NULL,                                                    -- last state change
  UNIQUE (node_id, revision),
  CHECK (state <> 'approved' OR projected_outcome = 'done' OR acknowledged_partial IS 1)
) STRICT;
```

The daemon writes a candidate when an objective enters `awaiting_approval`, so the id is the freeze time. The approval endpoint carries `revision`, and any change to the workspace invalidates the row. `approved_at` and `invalidated_at` are later decisions and stay as columns.

`evidence_blob` is the frozen approval evidence: the projected outcome, every discarded task with its title and its discard reason, the diff, the commit list, and the base and head object ids. It is frozen at freeze time and not derived at approval time. A title changes on the next import, and the workspace is unreachable from the client machine, so a late derivation would answer a different question than the one the human agreed to. The check results and the attempt history are joined by id and stay in their own tables, because they are immutable already.

The last `CHECK` clause is `acknowledged_partial`. The database refuses an approved `partial` candidate with no acknowledgement.

`merge_oid` is the merge commit built from `landing_base_oid` and `candidate_oid`. When the compare-and-swap fails and the landing tip moved, the recompute discards the merge commit and writes a new `merge_oid`. That invalidates the check result recorded against the old merge commit only. The result recorded against `candidate_oid` stands, because the candidate is immutable.

## Example

```
id                    candidate_01JQ8ZM12G
node_id               objective_01JQ8Z9L7M
run_id                run_01JQ8ZEX7Y
revision              cand-4
candidate_oid         e91f37...
landing_base_oid      a3f19c...
merge_oid             5c88a1...
projected_outcome     done
evidence_blob         sha256:7b41...
profile_blob          sha256:9f2a...
state                 approved
publish_requested     1
approved_actor        ulrich
acknowledged_partial  (null)
```

Both tasks reached `done`, so the objective entered `awaiting_approval` and the daemon froze this candidate.

The human reads the evidence on a train and approves twenty minutes later, and the request carries `revision = 'cand-4'`. Anything that touched the workspace in between sets `state = 'invalidated'`, so an approval can never apply to a diff that no longer exists.

`evidence_blob` is frozen at freeze time, not derived at approval time. It holds the projected outcome, the diff, the commit list, and every discarded task with its title and reason. A title changes on the next import, and the human's laptop cannot open the clone, so a late derivation would answer a different question than the one the human agreed to.

Had one task been discarded, `projected_outcome` would read `partial`, and the `CHECK` clause would refuse this approval until `acknowledged_partial = 1`. The database itself makes an accidental partial integration impossible.
