# event

**Question it answers:** what happened, in order, and who decided it?

```sql
CREATE TABLE event (
  id           TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL,                                            -- entity the event is about
  subject_id   TEXT NOT NULL,                                            -- that entity, prefixed
  type         TEXT NOT NULL,                                            -- transition or human decision name
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('human', 'daemon')),  -- who acted
  actor_id     TEXT NOT NULL,                                            -- which human, or which daemon instance
  payload_json TEXT NOT NULL                                             -- the fields of this event type, small and fixed in shape
) STRICT;
```

Every transition writes a state row and appends one event, in one transaction. Events feed history and the status stream. They never reconstruct state.

`id` is a ULID, and it is the only ordering and the only timestamp this table needs. `ORDER BY id` is creation order, history reads the events of one subject in that order, and a client resumes a stream by passing the last `id` it saw.

The order is total and it holds no gap information. A ULID is not dense, so no reader detects a missing row by comparing two ids. The crash matrix of [../phase-3/recovery.md](../phase-3/recovery.md) therefore asserts convergence of state, and the presence of the events a transition must write. It never asserts a contiguous sequence.

The table is append only. No command updates or deletes a row.

## Example

```
id                subject_id            type                actor_kind  actor_id
event_01JQ8ZQ10A  task_01JQ8ZBQ1R       attempt.rejected    daemon      daemon_01JQ8Z2H4G
event_01JQ8ZQ32B  task_01JQ8ZBQ1R       task.done           daemon      daemon_01JQ8Z2H4G
event_01JQ8ZQ54C  objective_01JQ8Z9L7M  objective.awaiting  daemon      daemon_01JQ8Z2H4G
event_01JQ8ZQ76D  objective_01JQ8Z9L7M  objective.approved  human       ulrich
event_01JQ8ZQ98E  repo_01JQ8Z4A2B       publish.started     daemon      daemon_01JQ8Z2H4G
```

Every transition writes its state row and appends one event, in one transaction. `kanthord status --history` reads these rows in `ORDER BY id`, which is creation order because the id is a ULID.

The fourth row is why `actor_id` exists. `actor_kind = 'human'` alone cannot say who approved, and an approval is the one decision the daemon never makes for itself. A `waive` and a `discard` write the same shape.

Events are the audit trail, not the state. A reader that rebuilt state from these rows would be a second implementation of the state machine, and the two would disagree eventually.
