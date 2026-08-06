# Story 3 — The origin decision

Epic: `.agent/plan/epics/010.5-browser-access.md`
Depends on: Story 1 (`settings.http.allowedOrigins`).

## Change

### 1. `src/http/server/origin.ts` — replace the whole file

The current file (18 lines) refuses every `Origin` unconditionally. Replace it:

```ts
import type { Context, Next } from "koa";

import { httpError } from "../contract/errors.ts";

export type OriginDependencies = Readonly<{
  allowedOrigins: readonly string[];
}>;

export type OriginState = Readonly<{ allowedOrigin: string | undefined }>;

export function originMiddleware(
  dependencies: OriginDependencies,
): (context: Context, next: Next) => Promise<void> {
  const allowed = new Set(dependencies.allowedOrigins);
  return async (context, next) => {
    const origin = context.request.headers.origin;
    if (origin === undefined) {
      await next();
      return;
    }
    if (!allowed.has(origin)) {
      throw httpError(
        "origin-forbidden",
        `the Origin header ${origin} is outside the allow list`,
      );
    }
    context.set("Access-Control-Allow-Origin", origin);
    context.state.allowedOrigin = origin;
    try {
      await next();
    } finally {
      context.vary("Origin");
    }
  };
}
```

Four mechanics are load-bearing and each was confirmed against koa before this story was
written. Do not restructure them.

- **No `Origin` header passes through untouched.** No header is set and
  `context.state.allowedOrigin` stays `undefined`. A CLI request is byte-identical to its
  pre-epic behaviour.
- **The comparison is exact and case-sensitive.** Story 1 stores the canonical serialization,
  and a browser sends that same serialization. `https://localhost:8080` and
  `http://localhost:8080` are therefore distinct, and a configured `http://LOCALHOST:80`
  matches a received `http://localhost` because the config stored `http://localhost`.
- **`Access-Control-Allow-Origin` is set before `next()`.** A downstream throw is caught by
  `envelopeMiddleware` (`src/http/server/envelope.ts:13-27`), which writes only
  `context.status` and `context.body`. A header set before the throw survives, so a `401`
  carries the header and a browser can read the `401` instead of an opaque failure.
- **`Vary` is appended in a `finally`, after `next()`.** koa's built-in `context.vary()`
  merges into an existing value rather than replacing it: a downstream `Vary: Accept` becomes
  `Vary: Accept, Origin`. The append must run after `next()` so a downstream value already
  exists to merge with, and it must sit in a `finally` so it also runs when downstream
  throws.

An empty `Origin` header is a present header, not an absent one: `""` is not `undefined`, it
is not in the allow list, and it answers `403`.

Nothing sets `Access-Control-Allow-Credentials`, here or anywhere.

### 2. `src/http/server/app.ts:16-19` — widen `TransportSettings`

```ts
export type TransportSettings = Readonly<{
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;
```

### 3. `src/http/server/app.ts:54` — pass the dependency

Replace `app.use(originMiddleware());` with:

```ts
app.use(
  originMiddleware({ allowedOrigins: dependencies.settings.allowedOrigins }),
);
```

Leave the middleware order alone in this story. Origin stays between `envelope` and `host`.
Story 5 inserts the preflight.

### 4. Every existing `TransportSettings` literal — add `allowedOrigins`

`allowedOrigins` is a required property of `TransportSettings`, so **every** construction of
that type stops typechecking until it is supplied. `npm run verify` fails at the typecheck
step, before any assertion runs. This is the complete list; add `allowedOrigins: []` to each,
except where noted:

| site                                                                                      | value                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `src/http/server/app.test.ts:149`                                                         | `allowedOrigins: []`                             |
| `src/http/server/dispatch.test.ts:18-21` (the shared `const settings: TransportSettings`) | `allowedOrigins: []`                             |
| `src/http/server/start.test.ts:34`                                                        | `allowedOrigins: []`                             |
| `src/http/server/start.test.ts:102`                                                       | `allowedOrigins: []`                             |
| `test/helpers/app.ts:47`                                                                  | from the new override, default `[]` (see step 5) |
| `src/main.ts:268`                                                                         | `settings.http.allowedOrigins` (see step 6)      |

`[]` is the value that preserves current meaning everywhere: an empty list refuses every
`Origin`, which is exactly what these suites assert today.

### 5. `test/helpers/app.ts` — extend the fixture

`TestAppOverrides` (`test/helpers/app.ts:9-14`) gains `allowedOrigins?: readonly string[]`.
In `createTestApp` (`:34-84`), default it to `[]` and pass it into the `settings` object at
`:47`.

The `[]` default is what keeps `src/http/server/app.test.ts` green: with an empty list, every
`Origin` still answers `403 origin-forbidden`, so `app.test.ts:44-52` ("origin-forbidden wins
over host-forbidden") and `:54-66` ("a browser check wins over the token") keep their
meaning.

### 6. `src/main.ts:265-270` — pass the configured value

The `settings` object handed to `createApp` gains:

```ts
            allowedOrigins: settings.http.allowedOrigins,
```

## Constraints

- Do not change the middleware order. That is Story 5.
- Do not set `Access-Control-Allow-Credentials`, and do not add
  `Access-Control-Expose-Headers`. The expose header is Story 6.
- Do not answer `OPTIONS` here. That is Story 4.
- `hostMiddleware` is untouched. The `Host` allow list stays mandatory and exact.
- Do not lowercase the received `Origin` and do not re-parse it. Canonicalization happens
  once, at config load.
- `app.test.ts:92` asserts `requests.length === 55` and `:165` asserts
  `unimplementedFor(bound).length === 21`. This story adds no registry entry, so both counts
  must stay unchanged.
- The pinned **behavioural** assertions of `app.test.ts`, `dispatch.test.ts` and
  `start.test.ts` do not change. Their `TransportSettings` **literals** do, per step 4 — a
  compile-level edit, not a semantic one. Do not weaken any assertion to make a suite pass.

## Verify

`node --test src/http/server/origin.test.ts` — rewrite. The existing file builds a bare koa
app with `envelopeMiddleware` plus the middleware under test plus a downstream that sets
`{ reached: true }` (`origin.test.ts:10-18`); keep that harness and give `originMiddleware`
its dependency. `refusedBody` at `:20-25` must change, because the refusal message is now
per-origin.

Read a response header through `response.headers["<lowercase-name>"]`, the convention at
`src/http/server/envelope.test.ts:22`.

Empty allow list (`allowedOrigins: []`):

- No `Origin` header → `200`, body `{ reached: true }`, and **no**
  `access-control-allow-origin` and **no** `vary` header.
- A table over `"http://evil.example"`, `"null"`, `""`, `"http://127.0.0.1"`,
  `"http://localhost:7421"`, `"https://kanthord.test"`: each answers `403`, body
  `{ error: { code: "origin-forbidden", message: "the Origin header <value> is outside the allow list" } }`,
  the downstream is never reached, and no `access-control-allow-origin` is present.
- A `Referer` header alone does not trigger the check → `200`.
- Every method (`get`, `post`, `put`, `delete`) with a disallowed `Origin` answers `403`.

Allow list `["http://localhost:8080"]`:

- `Origin: http://localhost:8080` → `200`, `access-control-allow-origin` exactly
  `http://localhost:8080`, `vary` exactly `Origin`.
- A table where each of `http://localhost:8081`, `https://localhost:8080`,
  `http://localhost.evil.test:8080`, `http://evil.test`, and `null` answers `403` and carries
  no `access-control-allow-origin`.

Allow list `["http://localhost"]` (what Story 1 stores for a configured
`http://LOCALHOST:80`):

- `Origin: http://localhost` → `200` with `access-control-allow-origin` exactly
  `http://localhost`, proving the default port and host case canonicalize on load.

`Vary` merging and error survival:

- A downstream that sets `Vary: Accept` before responding yields `vary` exactly
  `Accept, Origin` — the pre-existing value is kept and `Origin` is appended.
- A downstream that throws an `HttpError` still yields `vary` containing `Origin` and the
  correct `access-control-allow-origin`.
- `access-control-allow-credentials` is absent on every response above, allowed and refused
  alike.

`node --test src/http/server/app.test.ts` — extend, and confirm the existing suite is
unchanged.

- With `allowedOrigins: ["http://localhost:8080"]` and no bearer token, a `GET /v1/status`
  from that origin answers `401` with `body.error.code` `unauthenticated` **and** carries
  `access-control-allow-origin: http://localhost:8080`.
- With `allowedOrigins: ["http://localhost:8080"]`, a request from that origin with a valid
  token and an allowed `Host` reaches the route and carries the header.
- With the default empty list, `app.test.ts:44-52` and `:54-66` still pass, and
  `requests.length` is still `55`.

`npm run verify` exits 0.

Proof: delivers the `src/http/server/origin.test.ts` leg of the EPIC Proof line, plus the
gate items on the empty list, the `http://localhost:8080` table, the canonicalized
`http://LOCALHOST:80`, `Vary` appending, the `401` carrying
`Access-Control-Allow-Origin`, and the absence of `Access-Control-Allow-Credentials`.
