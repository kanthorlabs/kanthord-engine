# EPIC 004 — Transport skeleton

Status: **draft**.

## Goal

A request reaches a handler only after it passed the bearer check, the `Origin` rejection and the `Host` allow list. The route registry is typed on zod, it generates `openapi.yaml`, and `npm run verify` refuses a registry that disagrees with `docs/proposal/api/`. The CLI carries a base URL and a token, so it runs on a second machine.

## Non-goals

- No domain routes beyond the two that prove the skeleton. Each use case brings its own.
- No `501` sweep. EPIC 010 enumerates the registry.

## Stories

- **Server bootstrap** — koa, the configured bind address, the supertest application factory in `test/helpers/`, and the start refusals of EPIC 001 enforced at listen time.
- **The migration gate at startup** — the daemon reads the applied migration set before it listens, and it refuses to start when a migration is unapplied. It names `kanthord db migrate` in the refusal. `docs/proposal/api/system.md` states the rule: the daemon owns the database file, and an unmigrated database stops the daemon, which is why migration apply is not a route.
- **Authentication** — a constant-time bearer compare. `system.health` is the one exempt route.
- **Browser defences** — any `Origin` header is `403 origin-forbidden`; a `Host` outside the allow list is `403 host-forbidden`. Both apply to `system.health` as well.
- **Error envelope** — one shape, the code table of `docs/proposal/api/README.md`, and `details` carrying the current value on a precondition failure.
- **Typed route registry in `src/http/contract/`** — one authored module per domain, one zod schema pair per `operationId`, and a path declared as a typed segment tuple that one renderer turns into a string. The parity assertion compares the rendered set against the `routed` and `stubbed` rows of `docs/proposal/api/`, and against those two only. A `post-mvp` row has no registry entry at all, so it is excluded here and EPIC 010 sweeps it from the proposal matrix instead. `openapi.yaml` is generated into a temporary directory, validated, and deleted; it is never committed.
- **CLI program skeleton** — commander, the base URL, the token, `X-Kanthord-Client`, and an exit code routed on the error `code` and never on `message`. `src/cli/` already exists: EPIC 003 created `src/cli/base-url.ts` and `src/cli/db/migrate.ts`, because `AGENTS.md` puts the migration handler in the commander program and `main.ts` injects it. This story **refactors** those two files into the program rather than starting the directory. `--base-url` and `--token` become program-level options with one resolver, `db migrate` reads the resolved base URL instead of its own option, and `isLoopbackUrl` is reused by that resolver and never duplicated. `db migrate` keeps its injected handler and still imports no service, so it stays the one command that reaches storage without HTTP.
- **`system.health` and `system.db`** — the two routes that prove the skeleton end to end, and `kanthord db status` calling the second one over HTTP.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/http/**/*.test.ts src/cli/**/*.test.ts && echo "PASS EPIC-004"
```

Hermetic coverage required beyond the Proof:

- The parity assertion fails when a route is added to the registry and not to `docs/proposal/api/`, and when a route is declared and not registered.
- Registering a `post-mvp` row fails the parity assertion, because that row must have no entry.
- The daemon refuses to listen against a database with an unapplied migration, and it starts after `db migrate` on the same home.
- No request schema in the registry accepts a server file-system path. The assertion reads the authored schemas, which admit only contract-approved fields, rather than searching for path-like names. `plan.import` carries a client-side relative path per document, and that is contract-approved rather than an exemption, because the path is data the client owns and never a location on the daemon.
- The token compare is constant time, asserted by construction rather than by timing.
- `system.health` answers with no token, and still answers `403` to an `Origin` header.
- The `db migrate` refactor preserves every rule EPIC 003 proved: it still refuses a non-loopback base URL with `db-remote-base-url` and writes nothing, it still holds the home lock, it still reads the configured home when no `--home` is given, and `src/cli/` still imports no service. The EPIC 003 tests are the regression suite, and they move to the program-level option rather than being deleted.
- No second loopback classifier exists. One assertion greps `src/` for a `127.` literal and a `"localhost"` literal outside `src/cli/base-url.ts`, so the resolver cannot fork a copy of the policy.
