# EPIC 010.5 — Browser access — stories

Epic: `.agent/plan/epics/010.5-browser-access.md`
Prereq: EPIC 010 (sequence order).

A browser client reaches the daemon when, and only when, a human names its exact origin in
configuration; an empty origin list keeps the EPIC 004 behaviour byte for byte.

## Dispatch order

1. `01-the-origin-configuration.md`
2. `02-the-startup-refusal.md`
3. `03-the-origin-decision.md`
4. `04-the-preflight-answer.md`
5. `05-the-middleware-order.md`
6. `06-the-exposed-response-headers.md`

Story 1 is the hard prerequisite: Stories 2 and 3 both read `http.allowedOrigins`. Stories 4
and 5 are a **coupled pair** — Story 4 writes `preflightMiddleware` and Story 5 is the only
thing that mounts it, so Story 4's app-level behaviour is unobservable until Story 5 lands.
Story 6 edits the same allowed branch of `src/http/server/origin.ts` that Story 3 creates, so
it must follow Story 3; it is independent of Stories 4 and 5 apart from the `OPTIONS` guard.

## Facts (needed for implementation)

### Nothing in this codebase sets a response header yet

- `src/http/server/envelope.ts:13-27` writes only `context.status` and `context.body`.
  `src/http/server/dispatch.ts:34-35` does the same. A repo-wide grep finds no `Vary`, no
  `Access-Control-*`, and no `OPTIONS` handling in `src/` or `test/`.
- `HandlerContext` (`src/http/server/app.ts:21-25`) is `{ operation, parameters, body }` and
  `HandlerResult` (`app.ts:27`) is `{ status, body }`. A handler cannot set a header. This
  epic needs nothing from that: every header it adds is set by middleware.
- The one precedent for asserting a header in a test is
  `src/http/server/envelope.test.ts:22`, which reads
  `response.headers["content-type"]` and wraps it in `String(...)`.

### koa behaviour confirmed empirically before these stories were written

- A header set **before** `await next()` survives a downstream throw, because
  `envelopeMiddleware` only assigns `status` and `body`. This is what makes a `401` carry
  `Access-Control-Allow-Origin`.
- koa's built-in `context.vary("Origin")` **merges** into an existing value rather than
  replacing it: a downstream `Vary: Accept` becomes `Vary: Accept, Origin`. Called from a
  `finally` after `next()`, it also runs when downstream throws.

### `URL` parser facts that decide the canonicalization rules

All measured, not assumed. **The headline: `new URL` accepts many non-origin spellings and
silently normalizes them into a valid HTTP origin.** That is why Story 1 validates the raw
string against an origin grammar first and uses `URL` only to canonicalize a value that
already passed. A `URL`-first algorithm accepts every value in the first group below.

Values that `new URL` accepts and normalizes to origin `http://a.test`, and that must
therefore be refused on the raw string:

- `http:a.test` and `http:/a.test` — no `://` at all, so any check keyed on `"://"` is
  undefined here.
- `http://a.test\path` — a backslash is a path separator for a special scheme.
- `  http://a.test` and `http://a.test  ` — leading and trailing whitespace is stripped.
- `http://@a.test` and `http://:@a.test` — empty userinfo, so `url.username` and
  `url.password` are both `""`.
- `http://a.test?` and `http://a.test#` — a bare delimiter, so `url.search` and `url.hash`
  are both `""`.

Further facts:

- `new URL("http://a.test").pathname` and `new URL("http://a.test/").pathname` are **both**
  `"/"`. `pathname` cannot detect a trailing slash.
- `new URL("http://*.test")` **parses cleanly**, with `origin === "http://*.test"`. A
  wildcard must be refused by an explicit test, not by relying on a parse failure.
- `new URL("*")` throws `ERR_INVALID_URL`; `new URL("null")` throws too, but Story 1 refuses
  it earlier as `scheme`.
- `new URL("ftp://a.test").origin` is `"ftp://a.test"` — the scheme must be checked
  explicitly.
- `new URL("http://user:pw@a.test").origin` is `"http://a.test"` — credentials vanish from
  `origin`.
- `new URL("http://a.test?q=/")` puts the slash in `search`, so a raw-suffix scan for `/`
  would misreport it as a path. Story 1 takes the **first** delimiter to keep the reason
  deterministic.
- `url.origin` does every normalization the epic asks for: `http://LOCALHOST:80` →
  `http://localhost`, `https://a.test:443` → `https://a.test`, `http://пример.рф` →
  `http://xn--e1afmkfd.xn--p1ai`, `http://[::1]:8080` → `http://[::1]:8080`.

### The registry method set

`[...new Set(registry.map((e) => e.method))].sort().join(", ")` is exactly
`DELETE, GET, POST, PUT` today, which is why that is the `Access-Control-Allow-Methods`
constant. Registry statuses in use are `routed` and `stubbed` only — no `post-mvp` entry
exists, matching the EPIC non-goal. Story 4 adds a parity test so the constant cannot drift.

### `domain/` may use `URL`

`src/domain/loopback.ts:20` already constructs `new URL`, and `eslint.config.js:203-213`
restricts `domain/` to `domain/` plus `zod` only — a global is not an import. So
`src/domain/origin.ts` is the correct home for canonicalization.

### The config service has no convict `coerce`

- A comma-separated list env var is normalized **manually**, in the sandwich between
  `config.load(parsed)` (`src/services/config/convict.ts:177`) and `config.validate`
  (`:187`). The model is `normalizeAllowedHosts` (`:92-105`) wired in at `:179-180`.
- `src/services/config/convict.d.ts:21-24` types `addFormats` as accepting `{ validate }`
  only, so a `coerce`-bearing format would not typecheck. Do not try.
- `default: null` plus a non-empty-array validator is how this schema expresses "required"
  (`http.allowedHosts` at `:63`, and `home`, `actor`, `http.port`). `http.allowedOrigins` is
  optional, so its default is `[]` and its validator tolerates an empty array.
- `config.validate({ allowed: "strict" })` makes an unknown config-file key
  `config-invalid`, so the schema entry must land before any file mentions the field.
- No property in this schema has a `doc` key. Do not add one.

### `assertStartable` has exactly one production call site

`src/services/config/convict.ts:216-222`. It runs after `config.validate` and before the
master-key base64 decode. Its rules are first-match and their order is pinned by
`src/services/config/refusals.test.ts:149-170`.

### The current middleware order, and why the epic does not disturb it

`src/http/server/app.ts:51-59` is envelope → origin → host → auth → route → body → dispatch.
`src/http/server/app.test.ts:44-52` pins `origin-forbidden` winning over `host-forbidden`.

`docs/proposal/phase-1/transport.md:45` requires the preflight to be answered **after** the
`Host` check. These do not conflict, and that is why the epic splits the concern in two: the
origin **decision** stays at position 2, and a separate `preflightMiddleware` terminates
behind the host check. Both assertions hold simultaneously.

### Every `TransportSettings` literal must gain `allowedOrigins`

Adding a required property to `TransportSettings` (`src/http/server/app.ts:16-19`) breaks the
typecheck at every construction, so `npm run verify` fails before a single assertion runs.
The complete list is in Story 3 step 4: `src/http/server/app.test.ts:149`,
`src/http/server/dispatch.test.ts:18-21`, `src/http/server/start.test.ts:34`,
`src/http/server/start.test.ts:102`, `test/helpers/app.ts:47`, and `src/main.ts:268`.
`dispatch.test.ts` is the easiest to miss — its literal is a module-level
`const settings: TransportSettings`, not an inline argument to `createApp`.

Config-file fixtures need no edit: `http.allowedOrigins` has a default, and
`config.validate({ allowed: "strict" })` rejects only an _unknown_ key, not an omitted
optional one. So `test/helpers/home.ts:25` and
`src/services/home-lock/startup.test.ts:118,149` are untouched.

### Test fixture and its two hard-coded counts

- `test/helpers/app.ts:34-84` is `createTestApp`. It defaults `token` to `"test-token"` and
  `allowedHosts` to `["kanthord.test"]`, derives `unimplemented` via `unimplementedFor`
  (`:16-23`), and returns `get/post/put/del` helpers that pre-set `Host` and
  `Authorization`, plus `raw` — a bare supertest agent with no headers.
- An `OPTIONS` request must go through `app.raw.options(...)`; the typed wrapper exposes no
  `options` verb, and no test in the repo calls `.options(` today.
- `test/helpers/agent.ts` memoizes one server per koa app in a `WeakMap` and binds
  `127.0.0.1:0`. A test that forgets `.set("Host", ...)` gets `403 host-forbidden` rather
  than the code under test (pinned by `src/http/server/host.test.ts:48-57`).
- `app.test.ts:92` asserts `requests.length === 55` and `:165` asserts
  `unimplementedFor(bound).length === 21`. This epic adds **no** registry entry, so both must
  stay unchanged. A changed count means an `OPTIONS` operation leaked into the registry.

### Error codes and the envelope shape

`src/http/contract/errors.ts:3-25`: `origin-forbidden` → `403`, `host-forbidden` → `403`,
`unauthenticated` → `401`, `not-found` → `404`. `errorEnvelope` (`:77-84`) omits `details`
when undefined, so an error body is exactly `{ error: { code, message } }` — which is what
lets the existing `assert.deepEqual` body assertions work.

`httpError` overloads (`:59-75`) force a `details` argument for any `409` code only;
`origin-forbidden` takes two arguments.

### `blob.show` is not implemented in this epic

Registry entry at `src/http/contract/system.ts:53-59`, `status: "routed"`, no handler, so it
answers `501` until EPIC 010 lands `src/http/server/blob/show-blob.ts`. Story 6 asserts the
`Access-Control-Expose-Headers` header on the response and never the body, so it holds
whatever status the route returns. The three exposed names come from
`docs/proposal/api/system.md:77-79`: `ETag` (quoted hash), `Accept-Ranges: bytes` on every
response, `Content-Range` on a `206`.

### The header string constants, fixed

Every one is exact, lowercase where shown, comma-space separated. A test asserts the string,
so a reformatting is a failure.

- `Access-Control-Allow-Methods`: `DELETE, GET, POST, PUT`
- `Access-Control-Allow-Headers`:
  `authorization, content-type, idempotency-key, if-none-match, x-kanthord-client`
- `Access-Control-Max-Age`: `86400`
- `Access-Control-Expose-Headers`: `etag, accept-ranges, content-range`
- `Access-Control-Allow-Credentials`: never set, anywhere.

`x-kanthord-client` is the header the CLI already sends (`src/cli/client.ts:65`).
`idempotency-key` is listed ahead of EPIC 010.6 because a header absent from this list is a
header a browser refuses to send.

### Verification gate coverage

The EPIC Proof runs every suite this epic touches:

```bash
node --test src/domain/origin.test.ts src/services/config/refusals.test.ts \
  src/services/config/convict.test.ts src/http/server/origin.test.ts \
  src/http/server/preflight.test.ts src/http/server/app.test.ts && echo "PASS EPIC-010.5"
```

Two of those files are new (`src/domain/origin.test.ts`,
`src/http/server/preflight.test.ts`), so the Proof command fails until Story 1 and Story 4
land. That is expected: the Proof is the completion marker, not a per-story check. Each story
names its own `node --test` line in its `Verify` section.

## Decisions the EPIC did not state

Both are settled. Each is pinned in the stories, so `/work` stays mechanical.

- **`Access-Control-Max-Age: 86400`.** The EPIC says only "sets `Access-Control-Max-Age`" and
  names no value. Story 4 pins `86400`, the Chrome cap.
- **`OPTIONS` with no `Origin` answers `404 not-found`.** Story 4 pins fall-through to
  `routeMiddleware`, which finds no `OPTIONS` operation. This keeps the preflight answer a
  constant and adds no error code to the registry.
- The EPIC Proof command was widened to cover all six suites. It previously ran only
  `origin.test.ts`, `app.test.ts` and `refusals.test.ts`, so it omitted canonicalization,
  configuration loading and standalone preflight behaviour.
