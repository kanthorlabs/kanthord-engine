# check_result

**Question it answers:** which command ran against which commit or manifest, and what did it decide?

```sql
CREATE TABLE check_result (
  id                 TEXT PRIMARY KEY,
  subject_kind       TEXT NOT NULL CHECK (subject_kind IN ('candidate', 'merge',
                       'task-diagnostic', 'reconcile', 'profile-gate', 'initiative-e2e')),  -- what this run judged
  subject_id         TEXT,                                                                    -- candidate or git_operation row it belongs to, prefixed
  node_id            TEXT REFERENCES node(id),                                                -- node the result is attributed to
  run_id             TEXT REFERENCES run(id),                                                 -- execution it is attributed to
  commit_oid         TEXT,                                                                    -- exact commit checked out; null only for a manifest subject
  manifest_blob      TEXT REFERENCES blob(hash),                                              -- repository-to-commit manifest of a deferred initiative check
  check_name         TEXT NOT NULL,                                                           -- key in the profile checks map, such as unit
  command_json       TEXT NOT NULL,                                                           -- argv exactly as executed
  cwd                TEXT NOT NULL,                                                           -- working directory it ran in
  env_identity       TEXT NOT NULL,                                                           -- sanitized environment identity, so a pass stays reproducible
  toolchain_version  TEXT NOT NULL,                                                           -- language or tool version that ran it
  timeout_ms         INTEGER NOT NULL,                                                        -- budget; expiry kills the process tree
  authoritative      INTEGER NOT NULL,                                                        -- 0 is a diagnostic that gates nothing; 1 gates the objective
  result             TEXT NOT NULL CHECK (result IN ('running', 'passed', 'failed',
                       'error', 'timed-out', 'cancelled', 'not-applicable')),               -- explicit, never inferred from exit_code
  exit_code          INTEGER,                                                                 -- process exit status; null when killed or not applicable
  output_blob        TEXT REFERENCES blob(hash),                                              -- captured output, evidence for re@1 and for the human
  profile_blob       TEXT REFERENCES blob(hash),                                              -- profile that declared the command; null for a project-level binding
  convention_version TEXT NOT NULL,                                                           -- verification convention in force
  invalidated_at     INTEGER,                                                                 -- set when the subject changed, so the result proves nothing now
  ended_at           INTEGER,                                                                 -- close time; the id is the start time
  CHECK (result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL)
) STRICT;
```

The row is inserted with `result = 'running'` when the command starts, so the id is the start time, and `ended_at` closes it. A duration and a timeout comparison need both.

`result` is explicit and never inferred from `exit_code`. A killed command, a timeout and a check that never applied all leave no exit code, and the four cases are different facts. An MVP initiative records `not-applicable`, which is a recorded result and never a pass.

`commit_oid` is the subject for every objective-level and task-level check. `manifest_blob` is the repository-to-commit manifest of the deferred initiative check, which has no single commit.

`authoritative = 0` is the per-task diagnostic of [../phase-2/gates-and-approval.md](../phase-2/gates-and-approval.md). It is recorded and attributed to the task, and it gates nothing.

`profile_blob` is null for a project-level end-to-end run, because that command comes from the project binding rather than from a repository profile. `subject_id` is polymorphic and carries no foreign key, so the command validates it.

## Example

```
id                subject_kind     commit_oid  node_id               authoritative  result
check_01JQ8ZN34H  task-diagnostic  b7c204...   task_01JQ8ZAN9P       0              passed
check_01JQ8ZN56J  task-diagnostic  e91f37...   task_01JQ8ZBQ1R       0              failed
check_01JQ8ZN78K  candidate        e91f37...   objective_01JQ8Z9L7M  1              passed
check_01JQ8ZN90L  merge            5c88a1...   objective_01JQ8Z9L7M  1              passed
```

The first two rows are diagnostics. The objective's `unit` command runs after each task so a broken tree is visible immediately, and `authoritative = 0` means neither row gates anything. Task 2 reached `done` with a failed diagnostic, because `re@1` is the task gate.

Rows three and four are the point of the table. `e91f37...` is the frozen candidate. `5c88a1...` is the merge commit, whose tree is not the candidate's tree, and which is what actually lands. A candidate can pass alone and fail against newer work on the landing branch, so the check runs again against the merge commit before the ref moves.

Every row carries the command, the working directory, the environment identity, the toolchain version, the timeout and the `profile_blob`, so "verified" means something specific and a later profile edit cannot redefine it. When a recompute discards `5c88a1...`, row four gets an `invalidated_at` and the check runs again; row three stands, because a candidate is immutable.
