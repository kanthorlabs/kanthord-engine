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

Paging is a cursor: `after` takes the **id** of the last event read, `before` takes an **id** upper bound, and `limit` caps the page. **Both bounds are exclusive**, so `after` and `before` together select the open range `(after, before)`. An offset cannot page an append-only log that grows while a human reads it.

`order` is `asc` or `desc`, and `asc` is the default, so a request that omits it returns the page it always returned. The limit applies after the ordering, so `order=desc` returns the newest page and nothing else. **The first id of an `order=desc` page is the newest id in the filter.** No operation returns a tail id, because `GET /v1/event?order=desc&limit=1` already answers that question.

**An empty or inverted range is a normal `200` with an empty array.** An `after` at or above `before` returns no row. The daemon does not compare the two ids and does not refuse the request.

`wait` is the sixth parameter, in seconds, and it turns the same operation into a long poll. The daemon holds the request until an event matching the filters arrives or the wait elapses, then answers with the ordinary response shape. It is the decided progress channel for a GUI client, and `event.stream` below states why the stream is not.

**An elapsed wait is a normal `200` with an empty array.** It is never `204`, never `408` and never an error envelope. A client must be able to tell a quiet daemon from an unreachable one, and the status class is the only signal it has before it parses anything.

**An absent `wait` and `wait=0` both answer at once, and a first read that returns events never waits.** A catch-up client is therefore as fast as it was before the parameter existed, and every client written against the cursor alone keeps its exact behaviour.

**The bound is refused, never clamped.** The request schema caps `wait` at 60 seconds, and the daemon caps it again at `http.event.maxWait`, which defaults to 30. A `wait` above either bound answers `400 invalid-request`, because a client that asks for five minutes has a wrong idea of the contract and should be told. A browser tab holds one connection for the duration, so any browser, proxy or NAT idle timeout on the path must be longer than the configured maximum.

Every event carries its id, the type, the subject kind and identity, the actor kind and identity, and the payload. `../database/event.md` gives the table no sequence column and no timestamp column: the id is a ULID, `ORDER BY id` is creation order, and the timestamp is decoded from the id. The response returns that decoded timestamp, so a client never decodes a ULID to render a history line.

**The order is total, and it carries no gap information.** A ULID is not dense, so no reader detects a missing row by comparing two ids. P3-E1 therefore asserts that state converges and that a transition wrote the events it must write. It never asserts a contiguous sequence, and no client should try to.

A human decision writes an event. Discard, waive, abandon, unblock and approval each record the actor, which the daemon reads from configuration, because one token serves one human and a request-supplied name would be a claim rather than a fact.

The route is read-only. No route writes an event, because an event is a consequence of a transition and never an input to one.

## `event.stream`

Deferred. Status watching over a stream is `../after-the-mvp.md`, and the path returns `404` until it ships.

**A client watches progress by polling `event.list` with the cursor, and that is the decided mechanism rather than a stopgap.** The Flutter client withdrew its own SSE design in favour of it, because a browser cannot set an `Authorization` header on an `EventSource` and this API requires a bearer token on every route, so a stream would have cost a second transport on one platform for no gain. That is why the cursor ships in phase 1.

`event.list` carries one optional query parameter, `wait`, bounded in seconds, and the section above states it. One outstanding request replaces a poll loop, and it needs no new media type, no new transport and no resume semantics.

**A client that cannot hold a request open still polls the cursor on its own timer.** That is the same mechanism with the wait on the client side, so no client code was thrown away when `wait` arrived: the request gained one parameter and the poll interval went away.

The bound is conservative for that reason, and `../phase-1/transport.md` states what a held request costs the daemon lifecycle.

A future stream carries lifecycle events only. Nothing in this product carries live agent output, and `../after-the-mvp.md` states that as a refusal rather than a gap.
