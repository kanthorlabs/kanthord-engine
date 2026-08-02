# node

**Question it answers:** what is the work, where does it sit in the tree, and what state is it in?

```sql
CREATE TABLE node (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES project(id),                               -- project that owns the graph
  kind             TEXT NOT NULL CHECK (kind IN ('initiative', 'objective', 'task')),  -- containment level; the id prefix matches it
  parent_id        TEXT REFERENCES node(id),                                           -- containment parent; null only on an initiative
  title            TEXT NOT NULL,
  instruction_blob TEXT NOT NULL REFERENCES blob(hash),                                -- body before the acceptance heading: what the agent is told
  acceptance_blob  TEXT REFERENCES blob(hash),                                         -- the ## Acceptance criteria section re@1 judges against; tasks only
  worker           TEXT,                                                               -- worker kind bound at this node; it overrides project.worker
  repository_id    TEXT REFERENCES repository(id),                                     -- repository the objective works in; objectives only
  state            TEXT NOT NULL,                                                      -- current state; the CHECK below holds the allowed values
  block_reason     TEXT,                                                               -- why it parked, set only while blocked; a human clears it
  discard_reason   TEXT,                                                               -- why a human discarded it; approval evidence lists it
  revision         TEXT NOT NULL REFERENCES plan_revision(id),                         -- plan revision that last wrote this row
  updated_at       INTEGER NOT NULL,                                                   -- last transition or import
  CHECK ((kind = 'initiative') = (parent_id IS NULL)),
  CHECK ((kind = 'objective') = (repository_id IS NOT NULL)),
  CHECK ((kind = 'task') = (acceptance_blob IS NOT NULL)),
  CHECK (state IN ('pending', 'ready', 'running', 'blocked',
                   'awaiting_approval', 'done', 'partial', 'discarded')),
  CHECK ((state = 'blocked') = (block_reason IS NOT NULL)),
  CHECK (block_reason IS NULL OR block_reason IN ('attempt-limit', 'dependency-discarded',
                   'stale-base', 'dirty-recovery', 'e2e-failed', 'abandoned')),
  CHECK (state <> 'awaiting_approval' OR kind = 'objective'),
  CHECK (state <> 'partial' OR kind <> 'task')
) STRICT;
```

The `CHECK` clauses are the normative rules of [state-machine.md](../phase-1/state-machine.md), enforced by the database rather than by a comment. A task is never `partial`. Only an objective reaches `awaiting_approval`. An objective names a repository, a task never does, and import rejects a task that names one.

`acceptance_blob` is mandatory on a task, because `re@1` judges against the `## Acceptance criteria` section. `instruction_blob` is everything before that heading.

`discard_reason` is separate from `block_reason`. Approval evidence lists every discarded task with its reason, and a block reason cannot carry that.

There is no attempt counter here. The count is the number of `attempt` rows of the active task run, so there is one truth. There is no position field, per [state-machine.md](../phase-1/state-machine.md). The tie-break is the ULID part of the id, which sorts by creation time. Two compared tasks share the `task_` prefix, so a plain string comparison is correct.

`revision` is the plan revision that last wrote this node.

## Example

```
id                     kind        parent_id              title                       state    repository_id
initiative_01JQ8Z8J5K  initiative  (null)                 Harden the verify CLI       pending  (null)
objective_01JQ8Z9L7M   objective   initiative_01JQ8Z8J5K  Add a --json output flag    ready    repo_01JQ8Z4A2B
task_01JQ8ZAN9P        task        objective_01JQ8Z9L7M   Render the report as JSON   done     (null)
task_01JQ8ZBQ1R        task        objective_01JQ8Z9L7M   Cover the flag with a test  running  (null)
```

`kanthord plan import` inserts these four rows in one transaction. Containment is `parent_id`, and the id prefix repeats the kind so a reference in a log or a CLI argument names its own level.

Only the objective carries a `repository_id`, and import rejects a task that names one. Each task carries an `acceptance_blob`, because `re@1` judges the diff against it. `block_reason` stays null until a task parks: a third rejection sets `state = 'blocked'` and `block_reason = 'attempt-limit'`, and the `CHECK` clause refuses one without the other.
