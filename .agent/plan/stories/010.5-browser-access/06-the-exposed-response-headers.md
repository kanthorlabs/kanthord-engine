# Story 6 — The exposed response headers

Epic: `.agent/plan/epics/010.5-browser-access.md`
Depends on: Story 3.

## Change

### `src/http/server/origin.ts` — set the expose header on the non-preflight allowed path

Add the constant beside the imports:

```ts
const EXPOSED_HEADERS = "etag, accept-ranges, content-range";
```

In the allowed branch built by Story 3, after
`context.set("Access-Control-Allow-Origin", origin);` and before
`context.state.allowedOrigin = origin;`, add:

```ts
if (context.method !== "OPTIONS") {
  context.set("Access-Control-Expose-Headers", EXPOSED_HEADERS);
}
```

Three points are normative.

- **The value is the exact string `etag, accept-ranges, content-range`**, lowercase,
  comma-space separated, in that order. It is a constant and never assembled per route.
- **The guard is `context.method !== "OPTIONS"`.** `Access-Control-Expose-Headers` describes
  a real response and means nothing on a preflight. `originMiddleware` runs before
  `preflightMiddleware`, so without this guard the header would appear on the `204` too.
- **It is set before `next()`**, so it survives an error answer for the same reason
  `Access-Control-Allow-Origin` does: `envelopeMiddleware`
  (`src/http/server/envelope.ts:13-27`) writes only `context.status` and `context.body`.

These three headers are what `blob.show` produces per `docs/proposal/api/system.md:77-79`:
`ETag` is the quoted hash, `Accept-Ranges: bytes` is on every response, and `Content-Range`
appears on a `206`. Without this header a cross-origin script reads the body and none of the
caching or range metadata.

No other file changes. The handler does not participate: the expose list is transport policy,
set by the origin middleware, so it needs nothing from `HandlerResult`.

## Constraints

- One constant, no per-operation list, and no registry import in `origin.ts`.
- Do not set `Access-Control-Allow-Credentials`.
- Do not add the header when the request carries no `Origin`, and do not add it on a `403`
  refusal. Both fall outside the allowed branch.
- Do not touch `preflightMiddleware`.

## Verify

`node --test src/http/server/origin.test.ts` — extend the Story 3 suite.

With `allowedOrigins: ["http://localhost:8080"]`:

- `GET /` with `Origin: http://localhost:8080` carries `access-control-expose-headers`
  exactly `etag, accept-ranges, content-range`.
- Each of `post`, `put`, `delete` from the allowed origin carries the same exact value.
- `OPTIONS /` with the allowed origin carries **no** `access-control-expose-headers`.
- `GET /` with **no** `Origin` header carries no `access-control-expose-headers`.
- `GET /` with `Origin: http://evil.test` answers `403` and carries no
  `access-control-expose-headers`.
- A downstream that throws an `HttpError` still yields the exact
  `access-control-expose-headers` value.
- `access-control-allow-credentials` is absent on every response above.

`node --test src/http/server/app.test.ts` — extend.

- With `allowedOrigins: ["http://localhost:8080"]`, a valid token and an allowed `Host`, a
  `GET /v1/blob/x_01` from that origin carries `access-control-expose-headers` exactly
  `etag, accept-ranges, content-range`. Assert the header, not the body — `blob.show` becomes
  a real handler in EPIC 010, and this assertion must hold whatever status it returns.
- The same request with the default empty `allowedOrigins` and no `Origin` header carries no
  `access-control-expose-headers`.

`npm run verify` exits 0.

Proof: contributes to the `src/http/server/origin.test.ts` and
`src/http/server/app.test.ts` legs of the EPIC Proof line, and delivers the gate item "a
`GET /v1/blob/:hash` from an allowed origin carries `Access-Control-Expose-Headers` naming
`etag`, `accept-ranges` and `content-range`".
