# EPIC 026 — Event long poll

Status: **draft**. It is outside the external-drive block. It lands after EPIC 025 closes phase 1b.

Source: `kanthord-apps/docs/api/blockers.md`, item E5. The client has withdrawn SSE in favour of long
polling, and interval polling works today. This epic makes the channel good rather than merely
correct.

## Goal

`GET /v1/event?after=<id>&wait=<seconds>` holds the request until an event arrives or the wait
elapses, then answers with the response shape `event.list` already returns. An elapsed wait is a
normal empty `200`, so a client can tell a quiet daemon from an unreachable one.

## Why it is not in phase 1b

Stated once, here, so no later reader re-opens it.

- Interval polling is already correct, and `kanthord-apps/docs/api/polling.md` is built on it.
- No scenario of the external-drive block needs it. `013-external-drive-overview.md` exits on two
  harnesses claiming and reporting, and neither waits on an event.
- **It is the first route in this product that holds a connection open.** `src/http/server/start.ts:11-39`
  calls `server.close()` with no connection draining and no in-flight tracking, and
  `src/http/server/shutdown.ts:12-43` runs that close before it closes storage. A thirty-second wait
  would make every shutdown take up to thirty seconds. D5 is the repair, and it is a change to the
  daemon lifecycle rather than to one handler.

## Non-goals

- **No stream, and no new media type.** `docs/proposal/after-the-mvp.md` refuses a prompt-carrying
  stream, and `event.stream` stays `post-mvp` and `deferred` in the registry.
- **No resume semantics beyond the existing cursor.** `after` is the cursor and it is unchanged.
- **No agent output.** The channel carries lifecycle events only, per `polling.md`. No mechanism in
  this product carries live agent output.
- **No new filter.** The five filters of `src/http/contract/event.ts:12-16` are the exact set.
- **No push, no webhook, no callback.** The client polls.
- **No change to `allowedActors`.** `event.list` stays `["human"]`, as at `src/http/contract/event.ts:62-75`.
  See Open items.

## Decisions

### D1 — `wait` is an optional query field in seconds, and its absence is today's behaviour

`eventListRequest` at `src/http/contract/event.ts:11-17` extends `cursorRequest`. It gains one member:

```ts
wait: z.coerce.number().int().min(0).max(60).optional(),
```

`z.coerce` because every query value arrives as a string, exactly as `limit` already does in
`src/http/contract/cursor.ts`. An absent `wait` and `wait=0` both answer immediately, so **every
existing client keeps its exact behaviour** and this is an additive optional request field — which is
what EPIC 023's D1 permits inside `/v1`.

`singleValued` at `src/http/server/single.ts:5-23` already refuses a repeated key, and the handler at
`src/http/server/event/list-event.ts:18` already turns a parse failure into `400 invalid-request`. A
`wait` over the maximum is therefore a `400` and never a silent clamp: a client that asks for five
minutes has a wrong idea of the contract and should be told.

### D2 — an elapsed wait is `200` with an empty array

Never `204`, never `408`, never an error envelope. The client must distinguish a quiet daemon from an
unreachable one, and a status class is the only signal it has before it parses anything.

The response shape is unchanged: `{ events: [] }` against `eventListResponse` at
`src/http/contract/event.ts:30-32`.

### D3 — the wait polls, and it does not notify

Two designs exist. The daemon can notify a waiting request when an append commits, or it can re-read
on an interval. **This epic polls, at a fixed 250 ms.**

`EventLog.append` at `src/services/event/index.ts:47-53` runs inside a transaction, so a notification
raised at append time fires before commit and a waiting reader would see nothing. Firing it after
commit means a post-commit hook on `services/storage`, which owns the transaction under `AGENTS.md`.
That is a change to the one service every write path goes through, and it buys latency this product
does not need: a lifecycle event is read by a human watching a screen.

A poll costs one indexed read of a local SQLite file per 250 ms per waiting request. The upgrade path
is recorded under Open items and it is not taken now.

### D4 — the timer is injected, and the seam already exists

`Schedule` at `src/http/server/idempotency-store.ts:18-21` is
`(milliseconds: number, callback: () => void) => () => void`, and `systemSchedule` at
`src/http/server/app.ts:58-62` is its production binding with `timer.unref()`. **The wait reuses that
type and that binding**, so no sleep service is invented and no test waits on a wall clock. A test
drives a fake `Schedule` and advances it deliberately, which is what `AGENTS.md` requires of a
hermetic test.

`Handler` at `src/http/server/app.ts:43-45` already admits `Promise<HandlerResult>`, so the middleware
chain needs no change. `listEventHandler` becomes `async` and every other handler stays synchronous.

### D5 — a shutdown ends every wait immediately, and the daemon does not wait for the waiters

`createShutdown` at `src/http/server/shutdown.ts:12-43` calls `listener.close()` first, and
`server.close()` waits for in-flight requests. Without this decision a shutdown would take as long as
the longest outstanding wait.

So the wait is cancellable, and shutdown cancels before it closes:

- the app exposes one `cancelWaits()`, held beside the idempotency store in `createApp`;
- `createShutdown` calls it as its **first** step, before `listener.close()`;
- every pending wait resolves at once as a normal empty `200`, per D2, so a client sees a quiet
  daemon and reconnects rather than seeing a dropped socket.

This is a lifecycle change and it is the reason the epic is not a one-file edit.

### D6 — the maximum is conservative, and it is configuration

The schema maximum is 60 seconds, and the daemon maximum is configuration:
`http.event.maxWait`, `KANTHORD_HTTP_EVENT_MAX_WAIT`, default **30**, following
`http.idempotency.joinTimeout` at `src/services/config/convict.ts` which is a duration in seconds
with a default of 30. A `wait` above the configured maximum is refused with `400 invalid-request`,
not clamped, for the reason in D1.

A browser tab holds one connection for the duration, and any browser, proxy or NAT idle timeout in
the path must be longer than the wait. The proposal states that so an operator behind a reverse proxy
reads it before they tune it.

### D7 — a capability name, so a client asks instead of guessing

EPIC 023 makes `GET /v1/health` report a capability list. This epic adds `event-wait` to
`capabilityOperations` in `src/http/contract/capability.ts`, mapped to `event.list`. A newer client
against an older daemon therefore reads the list and falls back to interval polling, which is the
skew case EPIC 023 exists to answer.

**This is the epic's one dependency**, and it is the reason 023 lands inside the block and this one
does not.

## Stories

- **The proposal states the wait** — `docs/proposal/api/event.md`, or the `event.list` section of the
  API documents, gains the parameter, the elapsed-wait rule of D2, the maximum of D6 and the
  idle-timeout warning. `docs/proposal/phase-1/transport.md` gains the shutdown consequence of D5.
- **The contract** — `eventListRequest` gains `wait`, and `eventListExamples` gains a query example
  carrying it, so `src/http/contract/example.test.ts` validates it.
- **The waiter** — a small module holding the poll loop over an injected `Schedule` and a cancel
  token, with its own test against a fake schedule. It calls the existing `listEvents` query and owns
  no SQL.
- **The handler** — `src/http/server/event/list-event.ts` becomes `async`, calls the query once, and
  enters the waiter only when `wait` is present, non-zero and the first read is empty. **A first read
  that returns events never waits**, which is what makes a catch-up client fast.
- **The lifecycle** — `createApp` builds the waiter and exposes `cancelWaits()`, and
  `createShutdown` calls it first. `src/main.ts` binds the configuration value.
- **The configuration** — `http.event.maxWait` in `src/services/config/convict.ts`, with its env var
  and its default, plus the generated configuration file sample if one is asserted.
- **The capability** — `event-wait` in `src/http/contract/capability.ts`, per D7.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/event.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/capability.test.ts \
  src/http/server/event/list-event.test.ts \
  src/http/server/event/wait.test.ts \
  src/http/server/shutdown.test.ts \
  src/services/config/convict.test.ts \
  src/main.event-wait.test.ts \
  && echo "PASS EPIC-026"
```

Hermetic coverage required beyond the Proof:

- **No test waits on a wall clock.** Every wait assertion drives a fake `Schedule` and advances it
  explicitly. A test that sleeps is a defect this gate rejects.
- **The behaviour matrix, against a fake schedule.** `wait` absent answers immediately. `wait=0`
  answers immediately. `wait=5` with events already present answers immediately and never schedules a
  timer, asserted by the fake recording zero scheduled callbacks. `wait=5` with no events schedules,
  and after the full elapse answers `200` with `{ events: [] }`. `wait=5` with an event appended
  after two poll ticks answers `200` with that event and cancels its timer, asserted through the
  cancel function the fake returns.
- **The elapsed wait is not an error.** The status is `200`, the body parses against
  `eventListResponse`, and the response carries no error envelope. Asserted by value, because this is
  the property the client's reachability logic rests on.
- **The cursor is honoured under a wait.** With `after` set to the last known id, a wait that returns
  carries only events after that id, and a second call with the returned last id returns empty. No
  event is delivered twice and none is skipped.
- **The maximum is a refusal, not a clamp.** `wait=61` is `400 invalid-request` at the schema.
  `wait=45` with `http.event.maxWait` at 30 is `400 invalid-request`, and the assertion checks the
  code and not the message text.
- **A repeated key is refused.** `?wait=1&wait=2` is `400 invalid-request` through
  `singleValued`, matching the existing behaviour for the other query keys.
- **Shutdown does not wait for a waiter.** A daemon-backed test opens a request with `wait=30`,
  confirms it is pending, sends `SIGTERM`, and asserts two things: the pending request answers `200`
  with an empty array, and the process exits without the wait elapsing. The elapsed time is asserted
  as a bound — under one second — rather than as a value, because a bound is the only honest
  assertion about a process exit.
- **Shutdown order.** `cancelWaits` is called before `listener.close()`, asserted through a recording
  fake that captures the call order, not through timing.
- **`GET /v1/event` still writes nothing.** The full contents of `event` plus `PRAGMA data_version`
  are compared before and after a waited call that elapses, and after one that returns an event.
- **Concurrency.** Two waiting requests with different filters both return when one matching event
  arrives for one of them: the matching request returns the event, the other elapses empty. This
  proves the waiter filters per request and holds no shared cursor.
- **The capability appears.** `declaredCapabilities()` includes `event-wait` after this epic and the
  exact expected list is asserted, per EPIC 023's mechanism.
- **The route-level acceptance test.** `src/main.event-wait.test.ts` drives the real composition root
  through `launchDaemon`, with no injected handler map.

## Open items

- **Notification instead of polling.** A post-commit hook on `services/storage` would drop the
  latency from up to 250 ms to near zero and remove the idle read. It is the upgrade path if a load
  case ever appears, and it is a change to the service every write goes through.
- **A harness that waits.** `event.list` admits `human` only. A harness that wants to react to a
  sibling's progress would need the route and a narrower view of it, because the event log spans every
  project. That is an authorization decision and it belongs with whichever epic gives a harness a
  reason to watch.
- **A proxy in the path.** An operator behind a reverse proxy must set the proxy read timeout above
  `http.event.maxWait`. The proposal states it; nothing enforces it, and a misconfigured proxy shows
  up as a periodic disconnect the client cannot distinguish from a network fault.
