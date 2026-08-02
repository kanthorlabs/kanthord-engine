# EPIC 004 — Transport skeleton

Status: **draft**.

## Goal

A request reaches a handler only after it passed the bearer check, the `Origin` rejection and the `Host` allow list. The route registry is typed on zod, it generates `openapi.yaml`, and `npm run verify` refuses a registry that disagrees with `docs/proposal/api/`. The CLI carries a base URL and a token, so it runs on a second machine.

## Non-goals

- No domain routes beyond the two that prove the skeleton. Each use case brings its own.
- No `501` sweep. EPIC 009 enumerates the registry.

## Stories

- **Server bootstrap** — koa, the configured bind address, and the start refusals of EPIC 001 enforced at listen time.
- **Authentication** — a constant-time bearer compare. `system.health` is the one exempt route.
- **Browser defences** — any `Origin` header is `403 origin-forbidden`; a `Host` outside the allow list is `403 host-forbidden`. Both apply to `system.health` as well.
- **Error envelope** — one shape, the code table of `docs/proposal/api/README.md`, and `details` carrying the current value on a precondition failure.
- **Typed route registry** — one zod schema pair per `operationId`, `openapi.yaml` generation, and the parity assertion that the set of `operationId`, method and path equals the declaration in `docs/proposal/api/`.
- **CLI program skeleton** — commander, the base URL, the token, `X-Kanthord-Client`, and an exit code routed on the error `code` and never on `message`.
- **`system.health` and `system.db`** — the two routes that prove the skeleton end to end, and `kanthord db status` calling the second one over HTTP.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/http/**/*.test.ts src/cli/**/*.test.ts && echo "PASS EPIC-004"
```

Hermetic coverage required beyond the Proof:

- The parity assertion fails when a route is added to the registry and not to `docs/proposal/api/`, and when a route is declared and not registered.
- The token compare is constant time, asserted by construction rather than by timing.
- `system.health` answers with no token, and still answers `403` to an `Origin` header.
