# workspace

**Question it answers:** which clone do the tasks of this objective work in, and what was pinned for them?

```sql
CREATE TABLE workspace (
  id                    TEXT PRIMARY KEY,
  node_id               TEXT NOT NULL UNIQUE REFERENCES node(id),  -- the objective; all of its tasks share this clone
  repository_id         TEXT NOT NULL REFERENCES repository(id),   -- repository cloned
  path                  TEXT NOT NULL,                             -- clone directory on the daemon machine
  clone_base_oid        TEXT NOT NULL,                             -- landing tip cloned from; abandon objective resets here
  upstream_oid_at_clone TEXT NOT NULL,                             -- origin tip seen at clone time, so the base is attributable
  profile_blob          TEXT NOT NULL REFERENCES blob(hash),       -- profile document pinned for the whole objective
  convention_version    TEXT NOT NULL,                             -- verification convention pinned, so verified cannot be redefined later
  ambient_blob          TEXT REFERENCES blob(hash),                -- repository root ambient file, frozen at the pinned commit; null if none
  state                 TEXT NOT NULL,                             -- clone lifecycle: whether the directory exists and is usable
  updated_at            INTEGER NOT NULL                           -- last state change
) STRICT;
```

`node_id` is an objective, and the unique index is the clone granularity rule of [git-foundation.md](../phase-1/git-foundation.md). All tasks of one objective share this clone. A workspace row exists for an internal run only, because an external harness owns its own working tree.

`profile_blob` is the pin. An edit of the profile during the run cannot change the instruction, because every render resolves this hash. `convention_version` pins the verification convention the same way, so a later change cannot alter what "verified" meant.

`ambient_blob` is the repository root ambient file, read once from the pinned commit and frozen for the objective. A null value means the repository holds none. Host ambient files are configuration, not a workspace field.

`abandon objective` resets to `clone_base_oid`.

## Example

```
id                     workspace_01JQ8ZDV5W
node_id                objective_01JQ8Z9L7M
repository_id          repo_01JQ8Z4A2B
path                   .data/workspaces/objective_01JQ8Z9L7M/
clone_base_oid         a3f19c...
upstream_oid_at_clone  a3f19c...
profile_blob           sha256:9f2a...
convention_version     coding/v1
ambient_blob           sha256:1d90...
state                  ready
```

The scheduler runs the freshness pass, then clones the bare home for this objective. Both tasks work in this one directory, one at a time, because they share a working tree.

`profile_blob` is the pin that makes an edit mid-run harmless: the human fixes the `unit` command while task 2 runs, and task 2 still renders from `sha256:9f2a...`. `ambient_blob` is the repository `AGENTS.md` read once at the pinned commit, which is why an agent that rewrites that file inside its own clone cannot influence its own next attempt.

`clone_base_oid` is where `abandon objective` resets to.
