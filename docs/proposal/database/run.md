# run

**Question it answers:** which execution of this node is this one — which worker ran it, under which lease generation, from which base commit, and how did it end?

```sql
CREATE TABLE run (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('objective', 'task')),  -- execution level; an objective run schedules its task runs
  node_id       TEXT NOT NULL REFERENCES node(id),                    -- node being executed
  parent_run_id TEXT REFERENCES run(id),                              -- objective run that scheduled this task run; null on an objective run
  driver        TEXT NOT NULL CHECK (driver IN ('internal', 'external')),  -- who executes: the daemon's worker, or an external harness
  workspace_id  TEXT REFERENCES workspace(id),                        -- clone the execution happens in; null on an external run
  worker        TEXT,                                                 -- worker kind that resolved at execution time; null on an external run
  lease_fence   INTEGER NOT NULL,                                     -- lease generation that authorized this epoch
  attempt_limit INTEGER NOT NULL,                                     -- limit in force for this execution, from configuration
  base_oid      TEXT,                                                 -- commit this execution started from; null on an external run
  head_oid      TEXT,                                                 -- commit it ended at
  state         TEXT NOT NULL CHECK (state IN ('active', 'ended')),   -- one active run per node, by the index below
  outcome       TEXT,                                                 -- how it ended: done, abandoned, blocked or failed
  ended_at      INTEGER,                                              -- close time; the id is the start time
  CHECK ((kind = 'objective') = (parent_run_id IS NULL)),
  CHECK ((driver = 'internal') = (workspace_id IS NOT NULL)),
  CHECK ((driver = 'internal') = (worker IS NOT NULL)),
  CHECK ((driver = 'internal') = (base_oid IS NOT NULL)),
  UNIQUE (id, driver)  -- second candidate key, so attempt can declare a composite foreign key
) STRICT;

CREATE UNIQUE INDEX run_one_active ON run (node_id) WHERE state = 'active';
```

`UNIQUE (id, driver)` is a second candidate key that exists so `attempt` can declare a composite foreign key; `PRIMARY KEY (id)` is unchanged, and every single-column reference to `run(id)` stays valid.

A run is one execution epoch of one node. `kind` names the level, as it does on `node`.

- An **objective run** is one leased execution of the objective by a worker. `base_oid` is the clone base.
- A **task run** is one execution of one task inside it. `parent_run_id` is the objective run. `base_oid` is the workspace head when the task starts. That is the base object id per task that `abandon task` resets to, and it is why no separate table holds it.

The objective level is not redundant with `node`, `lease` and `workspace`, and each of the following facts has no other home:

- **The worker that actually ran.** `project.worker` and `node.worker` are mutable defaults. `run.worker` is the kind that resolved at execution time, which is what a reader needs six weeks later.
- **The lease generation that authorized the epoch.** A `lease` row is reused and keeps only its latest `fence` and `owner`. `run.lease_fence` keeps the generation of this execution.
- **The interval and the outcome of one execution.** `node.state` is current state, not "this execution began here and ended so".
- **The epoch identity.** A workspace is one long-lived clone per objective. It cannot separate an abandon from the retry that follows, and a task run needs to say which objective execution scheduled it.

Every objective-level side effect therefore cites a run: `candidate.run_id`, `git_operation.run_id`, and `check_result.run_id`. That is the attribution invariant of [../phase-3/recovery.md](../phase-3/recovery.md) — every side effect is attributed to a run and, for agent work, an attempt.

The row is inserted when the run starts, so the id is the start time. `ended_at` is a column, because a duration needs both ends.

The partial index gives one active run per node, so `abandon task` has exactly one authoritative base. An abandon ends the run and moves the task to `blocked` with reason `abandoned`. A later execution opens a new run, and the old row stays as history, ordered after it by id.

## Example

```
id              kind       node_id               parent_run_id   base_oid   state   worker
run_01JQ8ZEX7Y  objective  objective_01JQ8Z9L7M  (null)          a3f19c...  active  general@1
run_01JQ8ZFZ9A  task       task_01JQ8ZAN9P       run_01JQ8ZEX7Y  a3f19c...  ended   general@1
run_01JQ8ZG12B  task       task_01JQ8ZBQ1R       run_01JQ8ZEX7Y  b7c204...  active  general@1
```

The objective run opens when the worker claims the objective. Each task run opens as the runner walks the topological order.

Task 1 started at the clone base. Task 2 started at `b7c204...`, the workspace tip after task 1 committed. That is why `abandon task` on task 2 removes only its own commits and leaves task 1 intact.

`worker` is the kind that actually resolved, not the current default, so a later edit to `project.worker` does not rewrite history. `lease_fence` records which lease generation authorized the epoch. Abandon task 2 and run it again, and `run_01JQ8ZG12B` stays as history while a new row becomes the active one.
