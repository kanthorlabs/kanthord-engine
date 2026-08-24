# Story 04 — Browser defences

Epic: `.agents/plan/epics/004-transport-skeleton.md`
Depends on: Story 05 (`src/http/contract/errors.ts`, `src/http/server/envelope.ts`).

Two middleware modules and their own tests. Story 01 wires them into `createApp` and owns every assertion about the chain — the order between them, the `system.health` case, and the precedence over the token.

## Change

### 1. `src/http/server/origin.ts` (new)

```ts
import type { Context, Next } from "koa";

export function originMiddleware(): (
  context: Context,
  next: Next,
) => Promise<void>;
```

Throw `httpError("origin-forbidden", "the request carried an Origin header")` when `context.request.headers.origin !== undefined`. Otherwise await `next()`.

The **presence** of the header is the whole condition. `docs/proposal/api/README.md:149` says "the request carried an `Origin` header", and no value is ever inspected — not `null`, not the empty string, not a loopback origin. A value check would be the allow list that `docs/proposal/phase-1/transport.md:29` refuses to build.

### 2. `src/http/server/host.ts` (new)

```ts
import type { Context, Next } from "koa";

export type HostDependencies = Readonly<{ allowedHosts: readonly string[] }>;

export function hostMiddleware(
  dependencies: HostDependencies,
): (context: Context, next: Next) => Promise<void>;
```

1. `const host = context.request.headers.host`.
2. Throw `httpError("host-forbidden", "the request carried no Host header")` when `host` is `undefined`.
3. Build the allowed set once, outside the returned middleware: every entry of `dependencies.allowedHosts` lowercased. Compare `host.toLowerCase()` against it.
4. Throw `httpError("host-forbidden", \`the Host header ${host} is outside the allow list\`)` on a miss. The refused value is echoed because it is the caller's own header and it is what a human needs to fix the configuration.
5. Await `next()` on a hit.

A host name is case-insensitive, so both sides lowercase. Nothing else is normalised: a port is part of the comparison, an IDN form is compared as sent, and a trailing dot is a miss. `src/services/config/convict.ts:66-79` already trims and drops empty entries, so this middleware trims nothing.

`context.request.headers.host` is the raw header. `context.request.host` consults `X-Forwarded-Host` when `app.proxy` is true, and Story 01 keeps `app.proxy` false — reading the raw header means a later `proxy: true` cannot open the rebind path this check closes.

### 3. Position in the chain

Story 01 places `originMiddleware` second and `hostMiddleware` third, both **before** `authMiddleware` and `routeMiddleware`. Two consequences follow, and Story 01 asserts both because it owns the order:

- The defences apply to every route, `system.health` included. `docs/proposal/api/system.md:28` — "a route exempt from them would reopen the DNS rebind path this daemon closes."
- `origin-forbidden` wins over `host-forbidden`, and a browser code wins over `401`. That precedence is policy decided in this epic, not a reading of the error table.

Neither middleware knows its position. Each refuses on its own header and calls `next()` otherwise, which is why both are testable before `createApp` exists.

## Constraints

- Never inspect the value of `Origin`. Presence is the condition.
- Never fall back to `X-Forwarded-Host`, and never read `context.request.host` or `context.host`.
- Add no CORS middleware. `@koa/cors` is an installed dependency and it is the wrong tool here: this daemon refuses a browser rather than negotiating with one. Do not import it.
- The `allowedHosts` list comes from configuration and has no default. `src/services/config/convict.ts:52-56` makes it required, so no code path invents `127.0.0.1`.

## Verify

Both test files build their own bare application, in the shape `src/http/server/envelope.test.ts` established in Story 05, so neither depends on `createApp` or on `test/helpers/app.ts`:

```ts
function buildApp(middleware: Middleware): Koa {
  const app = new Koa();
  app.use(envelopeMiddleware({ onInternalError: () => {} }));
  app.use(middleware);
  app.use((context) => {
    context.body = { reached: true };
  });
  return app;
}
```

A `200` with body `{ reached: true }` means the middleware called `next()`. Drive each case with `supertest(buildApp(...).callback())`.

`node --test src/http/server/origin.test.ts` — new file, suite `"src/http/server/origin.test"`:

- A request with no `Origin` answers `200` with body deep-equal to `{ reached: true }`.
- A request with `Origin: http://evil.example` answers `403` with body deep-equal to `{ error: { code: "origin-forbidden", message: "the request carried an Origin header" } }`, and the downstream middleware is not reached — the body has no `reached` key.
- A table asserting that same `403` and that same body for each of these `Origin` values: `"null"`, `""`, `"http://127.0.0.1"`, `"http://localhost:7421"`, `"https://kanthord.test"`. A loopback origin is refused exactly like a remote one, and the empty string is refused exactly like a value.
- The refusal does not depend on the method: assert the same `403` for `GET`, `POST`, `PUT` and `DELETE`.
- A neighbouring header is not confused for it: `Referer: http://evil.example` answers `200`.

`node --test src/http/server/host.test.ts` — new file, suite `"src/http/server/host.test"`. Each case builds `buildApp(hostMiddleware({ allowedHosts }))` with the allow list the case names:

- `allowedHosts: ["kanthord.test"]` with `Host: kanthord.test` answers `200`.
- The same app with `Host: evil.example` answers `403` with body deep-equal to `{ error: { code: "host-forbidden", message: "the Host header evil.example is outside the allow list" } }`.
- The same app with no `Host` override answers `403`. `supertest` sends `127.0.0.1:<ephemeral port>`, which is outside the allow list — this case is also why every `test/helpers/app.ts` method presets the header.
- Case-insensitivity, both directions: `allowedHosts: ["Kanthord.Test"]` with `Host: kanthord.test` answers `200`, and `allowedHosts: ["kanthord.test"]` with `Host: KANTHORD.TEST` answers `200`.
- A port is part of the comparison: `allowedHosts: ["kanthord.test:7421"]` answers `403` for `Host: kanthord.test` and `200` for `Host: kanthord.test:7421`.
- A trailing dot is a miss: `allowedHosts: ["kanthord.test"]` with `Host: kanthord.test.` answers `403`.
- Multiple entries: `allowedHosts: ["a.test", "b.test"]` answers `200` for each of `Host: a.test` and `Host: b.test`, and `403` for `Host: c.test`.
- An empty allow list refuses everything: `allowedHosts: []` with `Host: kanthord.test` answers `403`. Configuration makes the list required, and this pins the behaviour if one ever arrives empty.
- `X-Forwarded-Host` is ignored: `Host: evil.example` with `X-Forwarded-Host: kanthord.test` answers `403`. The forwarded header cannot rescue a refused Host.
- The message echoes the sent value and nothing else: for `Host: evil.example:9999` the message is exactly `"the Host header evil.example:9999 is outside the allow list"`, and the response text does not contain `"kanthord.test"`. The allow list never reaches a response body.

`npm run verify` exits 0.

Proof: contributes `src/http/server/origin.test.ts` and `src/http/server/host.test.ts` to `node --test src/http/**/*.test.ts`.
