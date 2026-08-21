# System

Reviewer: architect. Conventions are [README.md](README.md).

The daemon itself: liveness, schema state, and the one aggregate view a human reads first.

## Routes

| operationId     | Method and path      | introducedIn | status | Source                                         |
| --------------- | -------------------- | ------------ | ------ | ---------------------------------------------- |
| `system.health` | `GET /v1/health`     | phase-1      | routed | new decision, dependency status, authenticated |
| `system.db`     | `GET /v1/db/status`  | phase-1      | routed | `../phase-1/domain.md`, `npm run verify`       |
| `system.status` | `GET /v1/status`     | phase-1      | routed | P1-E1, `kanthord status`                       |
| `blob.show`     | `GET /v1/blob/:hash` | phase-1      | routed | `../database/blob.md`, every large payload     |

## `system.health`

Answers whether the daemon can do its work, by asking each dependency to report its own status. It carries the bearer token like every other route.

```json
{
  "status": "degraded",
  "version": "27.8.1",
  "capabilities": ["external-drive", "per-node-write", "project-graph"],
  "dependencies": [
    { "name": "storage", "status": "ok" },
    { "name": "git", "status": "failed" }
  ]
}
```

`status` is the roll-up: `ok` when no dependency reports `failed`, and `degraded` otherwise. A dependency reports `ok`, `failed`, or `not-implemented`, and `not-implemented` never degrades the daemon — `agent`, `verify` and `lease` are unimplemented through phase 1, and a phase-1 daemon without them is healthy by definition. `dependencies` is ordered by `name`, bytewise, so identical state produces identical bytes.

The HTTP status is `200` even when the body says `degraded`. A reachable daemon reporting truthfully is not an HTTP error, a caller reads the body field, and a `5xx` would collapse "I am unwell" into "I failed to answer" — which is what the absence of a response already means.

A probe that reads state cannot also be anonymous. An earlier draft made this route a constant `{ "status": "ok" }` and exempted it from the bearer scheme, on the ground that a constant reveals nothing. Reporting per-dependency status is worth more than an anonymous probe is: it tells a human which subsystem to fix, and it is the one route a monitor calls on a schedule. So the route reads state and takes the token, and the daemon keeps no anonymous surface. See [README.md](README.md).

The token requirement means an external monitor is configured with the token. The daemon has one token and one human, so that is a line of configuration rather than a user model.

The browser defences apply here as they do everywhere. The `Origin` rejection and the `Host` allow list are not authentication, and a route exempt from them would reopen the DNS rebind path this daemon closes — a rebound browser page would carry the token by construction.

`version` is the daemon build string. `capabilities` names the product abilities this daemon serves, sorted bytewise, and a name appears only when every operation it covers is routed. A client renders a feature on the presence of a name, never on a version comparison. The list is additive, so a client written against an older list ignores a newer name. It is not a route directory: a client that asks whether one route exists calls it and reads `404` or `501`.

The bind address and the process start time are on `system.status`, which reports what the daemon _is_ rather than whether it is well. `capabilities` is on `system.health` only, and not on `system.status`, because `system.health` is the one of the two a `harness` actor reaches. A value in two places is a value that drifts.

## `system.db`

Returns every migration and whether it is applied. `npm run verify` calls `db status`, so the query ships in phase 1. That call needs a daemon, so `verify` starts one against a temporary home for the step and stops it after. See `../phase-1/domain.md`.

**Migration apply is the one command that does not call HTTP.** The daemon owns the database file, and the daemon applies every pending migration at startup. A route that applies migrations is therefore unreachable exactly when it is needed: before the first start, and on a home whose daemon does not run. `kanthord db migrate` opens SQLite directly on the daemon machine, and it needs no daemon. `kanthord db status` calls this route. The CLI refuses `db migrate` when it is configured with a non-loopback base URL, because the schema of another machine is not reachable from here.

This is the single documented exception to the parity rule of `../phase-1/transport.md`, and it is named so that a reviewer sees it rather than finds it.

## `system.status`

The aggregate view. It returns:

- the daemon version, the bind address and the process start time,
- every node by kind and state, with `blockReason` where the state is `blocked`,
- every repository whose state is `needs-reconcile`, with both object ids,
- every expired lease, of either subject kind, with its owner and its fence.

The lists come from one route because a human asks one question: what is stuck. `../phase-1/state-machine.md` requires the repository line, and `../phase-2/agents-and-workers.md` requires the stale lease line.

The lease list covers a node and a repository, because `../database/lease.md` makes the objective lease and the repository lock one table. A repository lock that outlived its operation stops every fetch, merge and publish on that repository, and a status view that showed only node leases would report a healthy graph while nothing could move.

The identity fields sit here rather than on `system.health` because the two routes answer different questions: `system.health` reports whether the daemon can work, and this route reports what it is and what is stuck. Both carry the token, so the split is about meaning rather than about disclosure. This route also carries the dependency list of `system.health`, from the same query, so the two can never disagree about the same daemon.

A node list with filters is `graph.md`. This route is the summary, not a replacement for it.

## `blob.show`

Returns one immutable payload by its content hash. Every route that would otherwise carry a rendered prompt, a tool trace, a diff, a check log, a reviewer reason, an approval evidence document, a plan document, a profile document or an error detail returns the hash instead, and the client fetches what it needs.

The route sits here because a blob belongs to no one domain. `../database/blob.md` is one store for every payload an audit must reproduce, and the client machine cannot open SQLite.

The contract:

- The path parameter is the `blob.hash` value exactly as the citing field returned it: `GET /v1/blob/sha256:9f2a…`. The API never reformats it, and a client never strips the algorithm prefix. A colon is legal in a path segment, so nothing is percent-encoded.
- The response body is the payload bytes. The `Content-Type` is `application/octet-stream` unless the citing field declares a narrower one, and the daemon never sniffs content to choose a type.
- `ETag` is the hash as a quoted entity tag, and `Cache-Control` is `private, immutable, max-age=31536000`. A blob is content addressed, so the payload behind one hash never changes. `private` keeps it out of a shared cache, because a prompt and a diff carry the work of one human. One year is the lifetime because an immutable address has no expiry and the number only has to be longer than a session.
- No conditional request is answered. `If-None-Match` is ignored and the route never returns `304`. The `ETag` exists so a cache can key on it, not so a client can revalidate an address that cannot change.
- A single `Range` request is answered, because a check log runs to tens of kilobytes and a client may want its tail. `bytes=a-b`, `bytes=a-` and `bytes=-n` are the three accepted forms, and the answer is `206` with `Content-Range`. Every response carries `Accept-Ranges: bytes`.
- **Anything else is ignored, and the whole payload is returned with `200`.** A multi-range request, a malformed value, a non-`bytes` unit and a range that starts past the end all take that path. The route never answers `416`: the error matrix of [README.md](README.md) declares no such code, a `Range` is a client optimisation rather than a precondition, and serving the whole payload always satisfies the request the client actually made.
- The bearer token applies. A hash is not a capability, and an unauthenticated read of an unguessable name is still an unauthenticated read.
- An unknown hash is `404 not-found`. A blob is never deleted while a row cites it, so a `404` means the hash was never stored, not that it expired.

The daemon serves this route from phase 1, because `plan.import` and `plan.export` cite blobs before any agent runs.
