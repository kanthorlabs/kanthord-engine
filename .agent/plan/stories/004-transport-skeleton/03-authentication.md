# Story 03 — Authentication

Epic: `.agent/plan/epics/004-transport-skeleton.md`
Depends on: Story 05 (`src/http/contract/errors.ts`, `src/http/server/envelope.ts`).

**Every route carries the bearer token. No route is exempt.** That is a decision Ulrich took against `docs/proposal/api/README.md:177` and `docs/proposal/phase-1/transport.md:21`, both of which exempt `system.health`. `system.health` now reports per-dependency status, so it reads state and must not read it anonymously. Open item S4 in the index carries the two proposal amendments.

The consequence is a simpler chain than an exempting daemon needs: `authMiddleware` reads no route match, so it runs **before** route resolution and `401` precedes `404` structurally rather than by splitting resolution across two middleware.

## Change

### 1. `src/http/server/auth.ts` (new)

```ts
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context, Next } from "koa";

export function tokensMatch(configured: string, presented: string): boolean;

export function bearerToken(header: string | undefined): string | null;

export type AuthDependencies = Readonly<{ token: string }>;

export function authMiddleware(
  dependencies: AuthDependencies,
): (context: Context, next: Next) => Promise<void>;
```

`tokensMatch`:

```ts
const a = createHash("sha256").update(configured, "utf8").digest();
const b = createHash("sha256").update(presented, "utf8").digest();
return timingSafeEqual(a, b);
```

The digest step is not decoration. `timingSafeEqual` throws when its two buffers differ in length, so comparing the raw tokens would leak the configured length through an exception and would fail outright on a wrong-length token. Two SHA-256 digests are always 32 bytes, so the compare always runs and always runs in constant time. `docs/proposal/phase-1/transport.md:17` requires the constant-time compare, and `AGENTS.md` requires `timingSafeEqual` asserted by construction.

`bearerToken(header)` returns the token or `null`. Split the header on the first `" "`. Return `null` when there is no space, when the scheme lowercased is not `"bearer"`, or when the remainder is empty. The scheme compare is case-insensitive because an HTTP auth scheme is; the token compare never is.

`authMiddleware`:

1. When `dependencies.token` is the empty string, await `next()` and return. An empty configured token means no token is configured, and `src/services/config/refusals.ts:63` already refuses to start a daemon on a non-loopback bind address without one. A loopback daemon with no token is the documented local case, and this middleware does not second-guess it.
2. `const presented = bearerToken(context.request.headers.authorization)`. When `presented` is `null`, throw `httpError("unauthenticated", "no bearer token")`.
3. When `tokensMatch(dependencies.token, presented)` is `false`, throw `httpError("unauthenticated", "the bearer token is not valid")`.
4. Await `next()`.

There is no exemption list and no route lookup. `authMiddleware` never reads `context.state`, which is what lets Story 01 place it before route resolution. A future exemption would have to reintroduce both the lookup and the two-middleware split, so the assertion below pins the absence.

## Constraints

- Never compare the two token strings with `===`, `!==`, `==`, `localeCompare` or `Buffer.compare`. `timingSafeEqual` is the only compare.
- Never include the presented token, the configured token, or either length in a response body or a message. The two messages are the two literals above.
- `authMiddleware` reads no `context.state` and imports nothing from `src/http/contract/registry.ts`. It is route-independent by construction.
- Do not read `context.request.header.authorization` through a koa helper that falls back to another header. Read `context.request.headers.authorization`.

## Verify

`node --test src/http/server/auth.test.ts` — new file, suite `"src/http/server/auth.test"`.

Unit cases:

- `tokensMatch("abc", "abc")` is `true`. `tokensMatch("abc", "abd")` is `false`.
- `tokensMatch("abc", "abcd")` is `false` and does **not** throw. This is the case a raw `timingSafeEqual` would fail on, so it is the one that proves the digest step.
- `tokensMatch("", "")` is `true`, and `tokensMatch("abc", "")` is `false`.
- `tokensMatch("Abc", "abc")` is `false` — the token compare is case-sensitive.
- A table over `bearerToken`, asserting each pair: `undefined` → `null`; `""` → `null`; `"abc"` → `null`; `"Bearer"` → `null`; `"Bearer "` → `null`; `"Bearer abc"` → `"abc"`; `"bearer abc"` → `"abc"`; `"BEARER abc"` → `"abc"`; `"Basic abc"` → `null`; `"Bearer abc def"` → `"abc def"`.

Constant time asserted by construction. Read `src/http/server/auth.ts` as text with `fs.readFileSync`, resolving the path from `import.meta.url`, and assert:

- it includes `"timingSafeEqual("`;
- it includes `'createHash("sha256")'`;
- it does not match `/configured\s*[=!]==?\s*presented/`;
- it does not match `/presented\s*[=!]==?\s*configured/`;
- it does not include `"Buffer.compare"`;
- it does not include `"localeCompare"`.

Route independence asserted by construction, in the same read:

- the file does not include `"context.state"`;
- the file does not include `"registry"`;
- the file does not include `"operationId"`.

Those three are the mechanism, not a style rule. A reviewer who reintroduces an exemption must also reorder Story 01's chain, and this assertion is what makes the coupling visible at the point of the edit.

Request cases. The test file builds its own bare application, in the shape Story 05 established:

```ts
function buildApp(token: string): Koa {
  const app = new Koa();
  app.use(envelopeMiddleware({ onInternalError: () => {} }));
  app.use(authMiddleware({ token }));
  app.use((context) => {
    context.body = { reached: true };
  });
  return app;
}
```

- `buildApp("test-token")` with no `Authorization` answers `401` with body deep-equal to `{ error: { code: "unauthenticated", message: "no bearer token" } }`, and the body has no `reached` key.
- The same app with `Authorization: Bearer wrong` answers `401` with message `"the bearer token is not valid"`.
- The same app with `Authorization: Basic test-token` answers `401` with message `"no bearer token"` — a wrong scheme is a missing token, not a wrong one.
- The same app with `Authorization: Bearer test-token` answers `200` with `{ reached: true }`.
- The refusal does not depend on the path or the method: assert the same `401` for `GET /v1/health`, `GET /v1/anything`, `POST /v1/repository` and `DELETE /v1/provider/x`. `system.health` is refused exactly like every other path, which is the whole of Ulrich's decision expressed as a test.
- **An empty configured token disables the check.** `buildApp("")` with no `Authorization` answers `200`, and with `Authorization: Bearer anything` also answers `200`. EPIC 001 owns the refusal that makes that safe — `src/services/config/refusals.ts:63` refuses to start on a non-loopback bind address with no token.

`npm run verify` exits 0.

Proof: contributes `src/http/server/auth.test.ts` to `node --test src/http/**/*.test.ts`.
