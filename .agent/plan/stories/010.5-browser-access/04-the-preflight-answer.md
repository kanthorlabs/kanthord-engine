# Story 4 — The preflight answer

Epic: `.agent/plan/epics/010.5-browser-access.md`
Depends on: Story 3 (`context.state.allowedOrigin`).

## Change

### New file `src/http/server/preflight.ts`

```ts
import type { Context, Next } from "koa";

const ALLOWED_METHODS = "DELETE, GET, POST, PUT";
const ALLOWED_HEADERS =
  "authorization, content-type, idempotency-key, if-none-match, x-kanthord-client";
const MAX_AGE = "600";

export function preflightMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void> {
  return async (context, next) => {
    const isPreflight =
      context.method === "OPTIONS" && context.state.allowedOrigin !== undefined;
    if (!isPreflight) {
      await next();
      return;
    }
    context.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    context.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    context.set("Access-Control-Max-Age", MAX_AGE);
    context.status = 204;
  };
}
```

Five points are normative.

- **The answer is a constant.** It never reads `context.path`, and it never imports
  `registry` or `matchRoute`. A path that exists and a path that does not are therefore
  indistinguishable. `docs/proposal/phase-1/transport.md:47` names the disclosure this
  accepts: an unauthenticated caller learns that this daemon is a browser-enabled kanthord,
  and learns whether a candidate origin is configured. It learns no route and no state.
- **The middleware terminates.** It does not call `next()` on the preflight path. Neither
  `authMiddleware` nor `routeMiddleware` runs, which is why a preflight needs no bearer
  token.
- **`ALLOWED_METHODS` is the exact string `DELETE, GET, POST, PUT`** — the four methods the
  registry uses, in alphabetical order. No `OPTIONS` entry is added to the registry.
- **`ALLOWED_HEADERS` is the exact string above**, lowercase, comma-space separated,
  alphabetical. `if-none-match` is present because `blob.show` sets an `ETag`.
  `idempotency-key` is present ahead of EPIC 010.6, because a header absent from this list is
  a header a browser refuses to send. `x-kanthord-client` is the header the CLI already sends
  (`src/cli/client.ts:65`).
- **A gate condition, not a method check alone.** An `OPTIONS` request with **no** `Origin`
  header is not a preflight. `context.state.allowedOrigin` is `undefined`, so this middleware
  calls `next()`, and `routeMiddleware` (`src/http/server/route.ts:14-21`) finds no operation
  for `OPTIONS` and throws `404 not-found`. An `OPTIONS` from a **disallowed** origin never
  reaches here: `originMiddleware` already threw `403 origin-forbidden`.

**The detector is deliberately broader than browser preflight semantics.** A real CORS
preflight also carries `Access-Control-Request-Method`, and this middleware does not require
it: every `OPTIONS` from an allowed origin gets the `204`. That is a named policy, not an
oversight. It keeps the answer a pure constant — requiring the header would make the answer
depend on the request — at the cost of enlarging the anonymous surface slightly beyond actual
preflights. The disclosure this accepts is still exactly the one
`docs/proposal/phase-1/transport.md:47` names, because the extra requests learn nothing the
preflight did not already tell them.

**"Constant" is scoped.** The answer is constant across **paths and methods**, which is the
security property that matters: a path that exists and a path that does not are
indistinguishable. It is not constant across origins — `Access-Control-Allow-Origin`
necessarily echoes the allowed origin — and a disallowed origin or a disallowed `Host` is
refused before this middleware runs.

`context.status = 204` is set with no body assignment, so koa sends no body.

Wiring this middleware into `createApp` is Story 5.

## Constraints

- Import nothing from `../contract/registry.ts` and nothing from `../contract/operation.ts`.
  The constant answer is the whole security property, and a registry import is the way it
  gets broken later.
- Do not set `Access-Control-Allow-Origin` here — Story 3 already set it on the allowed path.
- Do not set `Access-Control-Allow-Credentials`.
- Do not add an `OPTIONS` entry to the registry, and do not touch `renderPath`.
- Do not read the `Access-Control-Request-Method` or `Access-Control-Request-Headers` request
  headers. The answer is a constant and does not echo the request.

## Verify

`node --test src/http/server/preflight.test.ts` — new file. Build the harness the way
`src/http/server/origin.test.ts:10-18` does: a bare koa app with `envelopeMiddleware`, then
`originMiddleware({ allowedOrigins: ["http://localhost:8080"] })`, then
`preflightMiddleware()`, then a downstream that sets `{ reached: true }`.

`test/helpers/agent.ts` returns a raw supertest agent, so an `OPTIONS` request is
`(await loopbackAgent(app)).options(path)`. No existing test uses `.options(...)`; the typed
`TestApp` wrapper exposes only `get/post/put/del`, so an app-level preflight test must use
`app.raw.options(...)`.

- `OPTIONS /` with `Origin: http://localhost:8080` answers `204`, the downstream is never
  reached, and the headers are exactly:
  - `access-control-allow-origin`: `http://localhost:8080`
  - `access-control-allow-methods`: `DELETE, GET, POST, PUT`
  - `access-control-allow-headers`:
    `authorization, content-type, idempotency-key, if-none-match, x-kanthord-client`
  - `access-control-max-age`: `600`
  - `vary`: `Origin`
  - `access-control-allow-credentials`: absent
- The same request carries no `Authorization` header and still answers `204`.
- `OPTIONS /` with `Origin: http://evil.test` answers `403`, `body.error.code` is
  `origin-forbidden`, and `access-control-allow-origin` is absent.
- `OPTIONS /` with **no** `Origin` header reaches the downstream (`200`,
  `{ reached: true }`) and carries no `access-control-*` header — the middleware passed it
  through.
- `GET /` with `Origin: http://localhost:8080` reaches the downstream (`200`,
  `{ reached: true }`) and carries **no** `access-control-allow-methods`,
  `access-control-allow-headers` or `access-control-max-age`. The preflight answer applies to
  `OPTIONS` only.
- An `OPTIONS` from the allowed origin that carries **no** `Access-Control-Request-Method`
  still answers `204`, pinning the deliberate breadth of the detector.

**The identical-answer assertion, and what "byte for byte" means here.** A literal wire-byte
comparison is impossible: Node emits a `Date` header. Define the compared value as a helper
in the test file and use it for both requests:

```ts
function answerOf(response: request.Response) {
  return {
    status: response.status,
    text: response.text,
    headers: {
      "access-control-allow-origin":
        response.headers["access-control-allow-origin"],
      "access-control-allow-methods":
        response.headers["access-control-allow-methods"],
      "access-control-allow-headers":
        response.headers["access-control-allow-headers"],
      "access-control-max-age": response.headers["access-control-max-age"],
      "access-control-expose-headers":
        response.headers["access-control-expose-headers"],
      "access-control-allow-credentials":
        response.headers["access-control-allow-credentials"],
      vary: response.headers["vary"],
      "content-type": response.headers["content-type"],
      etag: response.headers["etag"],
    },
  };
}
```

Every application-controlled header is compared, including the ones that must be **absent** —
an absent header reads as `undefined` and `assert.deepEqual` compares that. Transport-generated
headers (`date`, `connection`, `keep-alive`, `transfer-encoding`, `content-length`) are
excluded by construction, because the object names its keys rather than taking the whole
`response.headers`.

- `OPTIONS /` and `OPTIONS /nothing/here/at/all` yield `assert.deepEqual(answerOf(a),
answerOf(b))`, and `a.text` is `""`.
- The same equality holds for `OPTIONS /v1/status` versus `OPTIONS /v1/no/such/thing`, so a
  real registry path and an absent one are indistinguishable.

**Registry parity for the method list.** Production must not import the registry, but a test
may. Add to this file:

- `ALLOWED_METHODS` split on `", "` equals the sorted unique set of `entry.method` over
  `registry`. Import `registry` from `../contract/registry.ts` in the test only. This is what
  stops the constant drifting when a future epic adds a method.

`npm run verify` exits 0.

Proof: contributes to the `src/http/server/app.test.ts` leg once Story 5 wires the
middleware. This story delivers the gate items "a preflight from an allowed origin answers
`204` with no bearer token", the byte-identical answer for a path that matches no operation,
and "a preflight from an origin outside the list answers `403 origin-forbidden` and carries
no `Access-Control-Allow-Origin`".
