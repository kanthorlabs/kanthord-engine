# attempt

**Question it answers:** which try is this, and which account and provider_model did it use?

```sql
CREATE TABLE attempt (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES run(id),                                   -- task run this try belongs to
  attempt_no  INTEGER NOT NULL,                                                   -- try number the attempt-limit block counts, from 1
  provider_id TEXT NOT NULL REFERENCES provider(id),                              -- registration pinned for the whole try
  provider_model TEXT NOT NULL,                                                   -- model pinned for the whole try
  timeout_ms  INTEGER NOT NULL,                                                   -- wall clock budget; expiry kills the process tree
  base_oid    TEXT NOT NULL,                                                      -- workspace head when the try started
  head_oid    TEXT,                                                               -- workspace head when it finished; the pair attributes its commits
  outcome     TEXT CHECK (outcome IS NULL OR outcome IN
                ('accepted', 'rejected', 'failed', 'timed-out', 'cancelled')),  -- how the try ended
  ended_at    INTEGER,                                                            -- close time; the id is the start time
  UNIQUE (run_id, attempt_no)
) STRICT;
```

An attempt is one task try, and it is the unit of provider selection. The daemon resolves the binding once here and pins `provider_id` and `provider_model` for the whole attempt. See [../phase-2/providers-and-credentials.md](../phase-2/providers-and-credentials.md).

`attempt_no` stays even though the id already orders the rows, because the attempt number is what the block reason `attempt-limit` counts and what the human reads. The attempt counter is `MAX(attempt_no)` of the active task run. `attempt_no = attempt_limit` with an `outcome` of `rejected` moves the task to `blocked` with reason `attempt-limit`.

`base_oid` and `head_oid` attribute every commit of the attempt. The invariant of [../phase-3/recovery.md](../phase-3/recovery.md) is attribution, not idempotence, and a diff alone cannot say which attempt produced which commit. The commit message also carries the run id and the attempt id, so the git history is readable without the database.

## Example

```
id                  run_id          attempt_no  provider_id          provider_model base_oid   outcome
attempt_01JQ8ZH34C  run_01JQ8ZG12B  1           provider_01JQ8Z3K7M  claude-opus-5  b7c204...  rejected
attempt_01JQ8ZJ56D  run_01JQ8ZG12B  2           provider_01JQ8Z3K7M  claude-opus-5  b7c204...  accepted
```

Task 2 needed two tries. `re@1` rejected the first diff, the worker routed back to the implementer, and the second try was accepted.

The binding resolves once per attempt, so both rows pin the same registration and provider_model. A provider failure ends the attempt as a failure rather than switching mid-flight, because a switch replays the context and pays for the work twice.

`MAX(attempt_no)` is the attempt counter. A third rejection here would reach `attempt_limit = 3`, and the task would move to `blocked` with reason `attempt-limit`.
