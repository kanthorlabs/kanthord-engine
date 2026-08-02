# Event

Reviewer: runtime or backend engineer. Conventions are [README.md](README.md). The decisions are `../phase-1/domain.md`.

Every transition emits one event. Events are an audit trail, and they never reconstruct state.

## Routes

| operationId    | Method and path         | introducedIn | status   | Source                           |
| -------------- | ----------------------- | ------------ | -------- | -------------------------------- |
| `event.list`   | `GET /v1/events`        | phase-1      | routed   | domain.md, "events feed history" |
| `event.stream` | `GET /v1/events/stream` | post-mvp     | deferred | after-the-mvp.md, event stream   |

## `event.list`

Filters are `subjectKind`, `subject`, `type`, `actorKind` and `actor`. `subject` takes a prefixed id, so one filter serves a node, a run, a repository, a candidate and every later subject kind, and no new filter is needed each time a subject kind appears.

Paging is a cursor: `after` takes the **id** of the last event read, and `limit` caps the page. An offset cannot page an append-only log that grows while a human reads it.

Every event carries its id, the type, the subject kind and identity, the actor kind and identity, and the payload. `../database/event.md` gives the table no sequence column and no timestamp column: the id is a ULID, `ORDER BY id` is creation order, and the timestamp is decoded from the id. The response returns that decoded timestamp, so a client never decodes a ULID to render a history line.

**The order is total, and it carries no gap information.** A ULID is not dense, so no reader detects a missing row by comparing two ids. P3-E1 therefore asserts that state converges and that a transition wrote the events it must write. It never asserts a contiguous sequence, and no client should try to.

A human decision writes an event. Discard, waive, abandon, unblock and approval each record the actor, which the daemon reads from configuration, because one token serves one human and a request-supplied name would be a claim rather than a fact.

The route is read-only. No route writes an event, because an event is a consequence of a transition and never an input to one.

## `event.stream`

Deferred. Status watching over a stream is `../after-the-mvp.md`. The path returns `404` until it ships. A client polls `event.list` with a cursor in the meantime, which is why the cursor ships in phase 1, and a client resumes a future stream by passing the last id it saw.
