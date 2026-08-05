# Transport

Reviewer: architect, and whoever owns the network. This file defines how a human reaches the daemon.

## HTTP is the surface, the CLI calls it

The CLI calls the HTTP API, so parity between the two surfaces is structural rather than maintained by hand.

This file decides the policy. The routes that policy carries are `../api/`, one file per domain, with the conventions and the lifecycle rules in `../api/README.md`. `kanthord db migrate` is the one command that does not call HTTP, and `../api/system.md` states why.

## Bind address

The bind address comes from configuration, and the default is `127.0.0.1`. A human who drives the daemon from a second machine sets it to the address of a private network interface.

## Authentication

Every request carries a bearer token from configuration, and the daemon compares it in constant time. A private network is a network boundary, not an authorization boundary: any host that reaches the interface can otherwise merge to the source of truth. The daemon refuses to start on a non-loopback bind address with no token configured.

There is no user model. One token serves one human.

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

## Every request carries its own payload

The human and the daemon do not share a file system. `plan import` sends the document in the body, and `plan export` returns it in the response. No route names a path on the server file system.
