# Event

Reviewer: runtime or backend engineer. Conventions are [README.md](README.md). The decisions are `../phase-1/domain.md`.

Every transition emits one event. Events are an audit trail, and they never reconstruct state.

## Routes

| operationId    | Method and path        | introducedIn | status   | Source                           |
| -------------- | ---------------------- | ------------ | -------- | -------------------------------- |
| `event.list`   | `GET /v1/event`        | phase-1      | routed   | domain.md, "events feed history" |
| `event.stream` | `GET /v1/event/stream` | post-mvp     | deferred | after-the-mvp.md, event stream   |

## `event.list`

Filters are `subjectKind`, `subject`, `type`, `actorKind` and `actor`. `subject` takes a prefixed id, so one filter serves a node, a run, a repository, a candidate and every later subject kind, and no new filter is needed each time a subject kind appears.

Paging is a cursor: `after` takes the **id** of the last event read, and `limit` caps the page. An offset cannot page an append-only log that grows while a human reads it.

`wait` is the sixth parameter, and it turns the same operation into a long poll. It is the decided progress channel for a GUI client, and `event.stream` below states why the stream is not. **`wait` is phase-2.** The cursor ships in phase 1 and answers the same question with a client-side timer; the long poll needs the daemon to hold a request open and to wake on an append, which is a transport capability rather than a parameter. A phase-1 daemon rejects `wait` with `400 invalid-request`, because the request schema declares no such field.

Every event carries its id, the type, the subject kind and identity, the actor kind and identity, and the payload. `../database/event.md` gives the table no sequence column and no timestamp column: the id is a ULID, `ORDER BY id` is creation order, and the timestamp is decoded from the id. The response returns that decoded timestamp, so a client never decodes a ULID to render a history line.

**The order is total, and it carries no gap information.** A ULID is not dense, so no reader detects a missing row by comparing two ids. P3-E1 therefore asserts that state converges and that a transition wrote the events it must write. It never asserts a contiguous sequence, and no client should try to.

A human decision writes an event. Discard, waive, abandon, unblock and approval each record the actor, which the daemon reads from configuration, because one token serves one human and a request-supplied name would be a claim rather than a fact.

The route is read-only. No route writes an event, because an event is a consequence of a transition and never an input to one.

## `event.stream`

Deferred. Status watching over a stream is `../after-the-mvp.md`, and the path returns `404` until it ships.

**A client watches progress by polling `event.list` with the cursor, and that is the decided mechanism rather than a stopgap.** The Flutter client withdrew its own SSE design in favour of it, because a browser cannot set an `Authorization` header on an `EventSource` and this API requires a bearer token on every route, so a stream would have cost a second transport on one platform for no gain. That is why the cursor ships in phase 1.

`event.list` therefore gains one optional query parameter, `wait`, bounded in seconds, **in phase 2**. The daemon holds the request until an event matching the filters arrives or the wait elapses, then answers with the ordinary response shape. **An elapsed wait is a normal empty `200`.** It is never an error and never a timeout, because a client must be able to tell a quiet daemon from an unreachable one, and a client-side receive timeout means the second thing. One outstanding request replaces a poll loop, and it needs no new media type, no new transport and no resume semantics.

**Through phase 1 a client polls the cursor on its own timer.** That is the same mechanism with the wait on the client side, so no client code is thrown away when `wait` arrives: the request gains one parameter and the poll interval goes away. Deferring it keeps the phase-1 transport free of a held request and a wake-up path, and `docs/proposal/api/README.md:54` therefore stays true — every phase-1 route answers with data and no phase-1 route is partially implemented.

Keep the bound conservative. A browser tab holds one connection for the duration of the wait, and any browser, proxy or NAT idle timeout on the path must be longer than it.

A future stream carries lifecycle events only. Nothing in this product carries live agent output, and `../after-the-mvp.md` states that as a refusal rather than a gap.
