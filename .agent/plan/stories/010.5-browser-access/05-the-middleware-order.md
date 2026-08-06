# Story 5 — The middleware order

Epic: `.agent/plan/epics/010.5-browser-access.md`
Depends on: Story 3 and Story 4.

## Change

### `src/http/server/app.ts:51-59` — insert the preflight

Add the import beside the others at `src/http/server/app.ts:8-14`:

```ts
import { preflightMiddleware } from "./preflight.ts";
```

The chain becomes exactly this, with the new line inserted between `hostMiddleware`
(`app.ts:55`) and `authMiddleware` (`app.ts:56`):

```ts
app.use(envelopeMiddleware({ onInternalError: dependencies.onInternalError }));
app.use(
  originMiddleware({ allowedOrigins: dependencies.settings.allowedOrigins }),
);
app.use(hostMiddleware({ allowedHosts: dependencies.settings.allowedHosts }));
app.use(preflightMiddleware());
app.use(authMiddleware({ token: dependencies.settings.token }));
app.use(routeMiddleware());
app.use(bodyParserForHandled(dependencies.handlers));
app.use(dispatchMiddleware({ handlers: dependencies.handlers }));
```

That is: envelope, origin decision, host, preflight termination, auth, route, body, dispatch.

Two placements are the point of the story, and both come from
`docs/proposal/phase-1/transport.md:45`.

- The preflight is answered **before** the bearer check, because a browser sends no
  `Authorization` header on a preflight.
- The preflight is answered **after** the `Host` check, because a browser sends `Host`
  normally and no request may skip that control. The `Host` allow list is the DNS rebind
  defence (`transport.md:35`).

**Say "before the preflight", never "first".** The `Host` check runs before preflight
termination and before auth, but it does **not** run before the origin decision: a request
carrying both a disallowed `Origin` and a disallowed `Host` answers `origin-forbidden`
without ever evaluating `Host`. That is pinned by `app.test.ts:44-52` and it is intentional.
Do not restate it as "the Host check runs first" in a test name or a comment.

The origin **decision** stays before `hostMiddleware`, where it already is. Only the
preflight **termination** moves behind the host check. This is why the two concerns are two
middlewares: `app.test.ts:44-52` already pins `origin-forbidden` winning over
`host-forbidden`, and that assertion stays true.

No other line in `createApp` changes. `bindingOffenders` is untouched.

## Constraints

- Do not move `originMiddleware`. It stays at position 2.
- Do not move `hostMiddleware`, `authMiddleware`, `routeMiddleware`, the body parser, or
  `dispatchMiddleware`.
- `preflightMiddleware` takes no arguments.
- The registry gains nothing, so `app.test.ts:92` (`requests.length === 55`) and `:165`
  (`unimplementedFor(bound).length === 21`) keep their current values.

## Verify

`node --test src/http/server/app.test.ts` — extend. This file asserts order behaviourally,
through precedence-of-answer tests, and never introspects the chain; follow that convention.
Use `app.raw.options(...)` with explicit `Host` and `Origin` headers, because the typed
wrapper exposes only `get/post/put/del`.

Order assertions, each with `allowedOrigins: ["http://localhost:8080"]`:

- **Host beats preflight.** `OPTIONS /v1/status` with `Origin: http://localhost:8080` and
  `Host: evil.example` answers `403` with `body.error.code` `host-forbidden` — not `204`.
  This proves the host check runs before the preflight.
- **Origin beats host.** `OPTIONS /v1/status` with `Origin: http://evil.test` and
  `Host: evil.example` answers `403` with `body.error.code` `origin-forbidden`, and carries no
  `access-control-allow-origin`.
- **Preflight beats auth.** `OPTIONS /v1/status` with `Origin: http://localhost:8080`, an
  allowed `Host`, and **no** `Authorization` header answers `204`.
- **Preflight beats route.** `OPTIONS /v1/does/not/exist` with an allowed origin and an
  allowed `Host` answers `204`, and its four `access-control-*` header values are
  `assert.deepEqual` to those of the `OPTIONS /v1/status` answer.
- **Auth still beats route for a non-preflight.** `GET /v1/status` from the allowed origin
  with an allowed `Host` and no token answers `401 unauthenticated`, and carries
  `access-control-allow-origin: http://localhost:8080`.
- **An `OPTIONS` with no `Origin` is not a preflight.** `app.raw.options("/v1/status")` with
  an allowed `Host` and a valid token answers `404` with `body.error.code` `not-found`,
  because the registry declares no `OPTIONS` operation.

**The empty-list table.** The EPIC gate requires one assertion covering a routed route, a
stubbed route and `system.health`. Build the three paths from the registry so the table cannot
drift: pick the first `status === "routed"` entry, the first `status === "stubbed"` entry, and
the `system.health` entry, rendering each with `renderPath` and replacing a `:param` segment
with `x_01` — the convention already used at `app.test.ts:80`. With the default empty
`allowedOrigins`, a valid token and an allowed `Host`, assert for each of the three:

- With `Origin: http://evil.test` → `403`, `body.error.code` `origin-forbidden`, and no
  `access-control-allow-origin`.
- With `Origin: null` → the identical `403 origin-forbidden`.
- With **no** `Origin` header → the exact status and body the route answers today, captured in
  the same test by issuing the request twice rather than hard-coding a status, so the
  assertion states "unchanged" rather than a literal that drifts.

Regression, with the default empty `allowedOrigins`:

- `app.test.ts:44-52`, `:54-66`, `:68-76`, `:108-118` and `:127-144` all still pass with no
  change to their assertions.
- `app.test.ts:78-106` still counts `55` requests and still finds every answer identical
  without a token.

`npm run verify` exits 0.

Proof: delivers the `src/http/server/app.test.ts` leg of the EPIC Proof line, plus the gate
items "a preflight from an allowed origin with a `Host` outside the allow list answers
`403 host-forbidden`, proving the host check runs first" and the identical-`204` pair.
