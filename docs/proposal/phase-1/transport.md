# Transport

Reviewer: architect, and whoever owns the network. This file defines how a human reaches the daemon.

## HTTP is the surface, the CLI calls it

The CLI calls the HTTP API, so parity between the two surfaces is structural rather than maintained by hand.

This file decides the policy. The routes that policy carries are `../api/`, one file per domain, with the conventions and the lifecycle rules in `../api/README.md`. `kanthord db migrate` is the one command that does not call HTTP, and `../api/system.md` states why.
The version compatibility policy — what `/v1` guarantees, what a client must tolerate, and the `GET /v1/health` handshake that carries the capability list — is `../api/README.md`, section `## Versioning`.

## The CLI exit code names the refusal class

The CLI exits `0` after the daemon accepts the operation. Every other exit code names one class of refusal. A script branches on the exit code, and it parses no text.

| Exit    | Class                 | Condition                                                        |
| ------- | --------------------- | ---------------------------------------------------------------- |
| 0       | success               | the daemon accepted the operation                                |
| 1       | local refusal         | the CLI refused the command, and the daemon wrote nothing        |
| 2       | transport failure     | the CLI got no usable answer, and nothing changed                |
| 3       | indeterminate outcome | the CLI got no usable answer, and a write may have committed     |
| 110-230 | declared refusal      | the daemon answered a code of `../api/README.md`, section Errors |
| 100     | unnamed refusal       | the daemon answered a `4xx` the CLI cannot name                  |
| 200     | unnamed fault         | the daemon answered a `5xx` the CLI cannot name                  |

A declared code takes the base of its status, plus its position in that status group. The base is 110 for `400`, 120 for `401`, 130 for `403`, 140 for `404`, 150 for `409`, 160 for `422`, 210 for `500`, 220 for `501` and 230 for `503`. The order in a group is the order of the table in `../api/README.md`. So `unauthenticated` is 120, `lease-held` is 155, and `plan-invalid` is 160. One code owns one exit code, and no two codes share one.

The exit code comes from the `code` field. It never comes from the `message`, and it never comes from the status alone. One status carries more than one code, so a status cannot name the refusal.

**A status names a code only when it carries exactly one.** A proxy, a truncated body or a malformed envelope can take the `code` field away. The CLI then reads the status against the table of `../api/README.md`. A `400`, a `401`, a `404`, a `500`, a `501` and a `503` each carry one code, so the CLI names it and exits on its declared exit code. A `403`, a `409` and a `422` carry more than one, so the CLI names none of them and exits 100. A status the contract never declares also exits on its band. The CLI never guesses between two codes of one status, because the two carry different advice.

**A new error code appends to the end of its status group.** `../api/README.md`, section `## Versioning`, permits a new code inside `/v1`. An insertion in the middle of a group moves the exit code of every code after it, and a script that reads exit codes would break. So the position of a code inside its group is fixed for the life of `/v1`.

A local refusal covers a missing option, a file the CLI cannot read, an answer of no at a prompt, and a validation finding the CLI declines to import. In each case the CLI stops the command itself, so a repeat needs a different input.

**Exit 2 is not exit 1, because the two carry opposite advice.** A local refusal asks the human to change the command. A transport failure asks the human to send the same command again later. The CLI names the base url it tried, and it prints no stack.

**Exit 3 exists because a client cannot always know whether the daemon ran the operation.** A request can reach the daemon, commit, and then lose its answer to a reset socket or a truncated body. The CLI sees the same failure it sees for an absent daemon, so one class for both would promise more than the client can prove.

The CLI separates the two classes by two facts it does have.

- **A read is always exit 2.** A `GET` changes no state, so a lost answer to a `GET` leaves nothing to be indeterminate.
- **A connect failure is always exit 2.** `ECONNREFUSED`, `ENOTFOUND` and `EAI_AGAIN` all say the request went to no daemon, so no operation ran.
- **Every other lost answer to a write is exit 3.** A reset socket after dispatch, and a body that ends early, both leave the outcome unknown.

Exit 3 does not mean the write failed, and it does not mean the write succeeded. The human reads the state before sending the command again. A re-run is a second operation: the CLI mints a fresh `Idempotency-Key` for each invocation, so a repeat is never a replay of the lost request.

## Bind address

The bind address comes from configuration, and the default is `127.0.0.1`. A human who drives the daemon from a second machine sets it to the address of a private network interface.

## Authentication

Every request carries a bearer token from configuration, and the daemon compares it in constant time. A private network is a network boundary, not an authorization boundary: any host that reaches the interface can otherwise merge to the source of truth. The daemon refuses to start on a non-loopback bind address with no token configured.

A user model exists. The configured bearer token resolves to a bootstrap `human` actor, and a registered actor holds its own token. A registered actor is a `human` or a `harness`, and `harness` is the second registered actor kind. `daemon` stays the third actor kind of the event log, and it registers nothing. EPIC 015 lands the enum, the service-interface type and the `CHECK`.

**There is no exception.** Every route needs the token, and the daemon has no anonymous surface. An earlier draft exempted the health route because it returned a constant; the health route now reports the status of each dependency, so it reads state, and a route that reads state cannot be anonymous on an interface a second machine reaches. An unauthenticated request answers `401` whatever it asks for, and it cannot distinguish a registered path from an unregistered one, so the route table is not readable without the token. See `../api/system.md`.

The consequence is operational and small: a process that probes liveness is configured with the token, the same one the CLI carries.

The browser defences below are a separate control and apply to every route. A token does not stop a browser page — a rebound page sends the victim's credentials by construction — so the `Origin` and `Host` checks are what close that path.

## Transport encryption

Transport encryption comes from the private network, and the daemon serves plain HTTP. It ships no certificate handling.

## Browser defences

The server checks the `Host` header against an allow list from configuration, and it rejects a request that carries an `Origin` header outside a second allow list. Together these block a browser page and a DNS rebind from driving the daemon.

**The `Host` allow list is the DNS rebind defence, and the `Origin` allow list is not.** The two are named in that order deliberately. A rebound page keeps its own origin and its own `Host`, and a same-origin request is not guaranteed to carry an `Origin` header at all, so a rule that reads only `Origin` would let a rebound request through on a missing header. The `Host` check is therefore mandatory and exact on every request that reaches a route, browser or not.

## Browser access

The origin allow list is empty by default, and an empty list means the daemon rejects every request that carries an `Origin` header. That is the original behaviour, and every deployment that configures nothing keeps it.

A human who wants a browser client names the exact origins. The list holds a canonical origin and nothing else: a scheme, a host, and a port when it is not the default. A wildcard, a suffix pattern, a path, a trailing slash and the literal `null` are each refused at configuration load, so the mode cannot be widened by a careless value. The comparison is against the browser's own serialization, so a configured entry is canonicalized on load through the URL parser: the scheme is `http` or `https` and nothing else, credentials are refused, and the host case, an internationalized name, an IPv6 literal and a default port are normalized before storage. A string comparison alone would refuse an entry a browser would have matched.

**A configured origin is an authority, not an application identity.** Every script running at that origin reaches the daemon with it, which includes an injected script, a compromised development server, and any other process that takes the port. Naming an origin is therefore the same class of decision as naming a bind address, and the daemon refuses to start with a non-empty origin list and no token configured.

A browser sends a preflight before an authenticated cross-origin request, and that preflight carries no `Authorization` header. So the preflight is answered before the bearer check, and it is answered **after** the `Host` check, because a browser sends `Host` normally and no request may skip that control. The preflight answer is a constant for every path: it names the four methods the API uses and the headers a client sends, and it never consults the route registry. A path that exists and a path that does not are therefore indistinguishable in a preflight.

**This adds one anonymous surface, and it is named rather than denied.** With browser access configured, an unauthenticated caller learns from a preflight that this daemon is a browser-enabled kanthord, and learns whether a candidate origin is configured. That is a real disclosure. It is accepted because an allowed origin is not a secret and the answer reveals no route and no state, and because the alternative — a preflight behind the bearer check — cannot work in a browser at all. Every other route keeps its behaviour: an unauthenticated request answers `401` whatever it asks for.

The daemon serves plain HTTP, so a browser page must be served over plain HTTP too, from the same private network or from loopback. A page on a public HTTPS origin cannot reach this daemon directly, and mixed content rather than this policy is what stops it. A deployment that needs an HTTPS page puts a reverse proxy in front that serves the application and forwards a same-origin path to the daemon over loopback. The daemon still ships no certificate handling in that topology.

## The request and response contract

This section states what a client observes at the boundary. It names no library, and a replacement
transport reproduces every rule below without changing a single observable byte.

**An absent request body is an empty object.** A write reaches its operation with an empty body in
three cases: the client sends no body, the content type is not JSON, and the body has zero length.
The transport refuses none of the three on its own. Each operation validates its own body, so a
missing field is that operation's own `400`, carrying that operation's own message.

**A body is read only for an operation this build implements.** An operation of `../api/README.md`
that ships in a later phase, and an operation this build declares unimplemented, both answer `501`
with the body unread. A malformed payload therefore never turns a `501` into a `400`, and the answer
to an unimplemented operation does not depend on what the client sent.

**The browser headers survive every refusal.** The allow-origin header and the expose-headers header
are written before the operation runs, so they are present on the answer whatever it turns out to be:
an unauthenticated refusal, an unmatched path, a precondition refusal, and an internal fault each
carry them. One answer carries neither, and it is the refusal of an origin outside the allow list.
That refusal is decided before any header is written.

**`Vary: Origin` covers every answer the daemon completes.** It is present when the request carries
an allowed origin, when the request carries no origin at all, and on the preflight answer. The single
answer without it is the refusal of an origin outside the allow list.

**A path segment is never decoded.** Route matching compares the literal characters between two
slashes. An escape inside a path parameter reaches the operation as the characters the client wrote,
and a malformed escape reaches route matching intact rather than producing a transport refusal.

**A request header reaches the operation once, under a lower-case name.** A name the client sends
twice arrives as one value, with the two values joined by a comma and a space. The operation reads
one string per name, and the names arrive in byte order.

**An answer carries one of two success statuses.** Every operation answers `200`, and the one
operation that serves a byte range answers `206` as well. No other success status exists in the
product.

**One operation writes response headers, and it is the one that serves bytes.** Every other operation
answers with a status and a body alone. A structured answer is JSON. A byte answer carries its exact
length, and a range answer carries its exact range.

**One answer in the product has an empty body, and it is the preflight.** An empty body is an absent
body value: the daemon writes no body at all, not even zero bytes. Every operation returns a body
value, so the one empty-body answer comes from the transport itself. A byte answer of zero length is
not an empty body: it carries an explicit value of zero bytes, and its length header states `0`. Any
other status comes from a refusal, and a refusal carries the error envelope of `../api/README.md`.

## A held request

One route holds a connection open: `GET /v1/event` with `wait`, and `../api/event.md` states the parameter. Nothing else in the product holds a request.

**A shutdown ends every held request at once, and the daemon does not wait for the waiters.** The signal cancels every outstanding wait before it closes the listener, and each cancelled wait answers as a normal empty `200`. So a client sees a quiet daemon and reconnects, rather than seeing a dropped socket, and a stop takes no longer than it took before the parameter existed. Closing the listener first would have made every shutdown last as long as the longest outstanding wait.

**An operator behind a reverse proxy sets the proxy read timeout above `http.event.maxWait`.** Nothing enforces that. A misconfigured proxy shows up as a periodic disconnect the client cannot distinguish from a network fault.

## Every request carries its own payload

The human and the daemon do not share a file system. `plan import` sends the document in the body, and `plan export` returns it in the response. No route names a path on the server file system.
