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

The server rejects a request that carries an `Origin` header, and it checks the `Host` header against an allow list from configuration. This blocks a browser page and a DNS rebind from driving the daemon.

## Every request carries its own payload

The human and the daemon do not share a file system. `plan import` sends the document in the body, and `plan export` returns it in the response. No route names a path on the server file system.
