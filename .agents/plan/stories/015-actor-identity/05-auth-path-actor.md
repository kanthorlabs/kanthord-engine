# Story 5 — The auth path keeps its refusals and gains an actor

Epic: `.agents/plan/epics/015-actor-identity.md`
Depends on: Story 2, Story 4.

This story passes the full gate standing alone.

## Change

- **Delete `tokensMatch` from `src/http/server/auth.ts:6-10`** and delete the now-unused `createHash` and `timingSafeEqual` imports at `:1`. After this edit `auth.ts` imports nothing from `node:crypto`, because `resolveActor` performs every comparison. This deletion belongs here, not in Story 2, because this is the change that removes the last caller.
- `src/http/server/auth.ts`: widen `AuthDependencies` at `:31-33` to

  ```ts
  export type AuthDependencies = Readonly<{
    token: string;
    resolveActor: (presented: string) => ActorRow | null;
  }>;
  ```

  The dependency is a **callable**, not the query module. `http/server/` may import `queries/`, but taking a callable keeps the middleware testable with a plain function and matches how `main.ts` binds every other handler. **There is exactly one identity dependency**: Story 4's step 0 makes `resolveActor` serve the empty-configured-token mode too, so no second `bootstrapActor` dependency exists and identity policy is not duplicated in middleware.

- Rewrite the body of `authMiddleware` at `:35-52` to this exact order.
  1. When `dependencies.token === ""`, call `dependencies.resolveActor("")`, write the result to `context.state.actor`, then `await next()` and return. No bearer token is read and none is required, exactly as `:39` behaves today. Story 4's step 0 returns the bootstrap row for this call.
  2. Read the presented token with the existing `bearerToken(context.request.headers.authorization)`. A `null` result throws `httpError("unauthenticated", "no bearer token")`, unchanged.
  3. Call `dependencies.resolveActor(presented)`. A `null` result throws `httpError("unauthenticated", "the bearer token is not valid")` — the **same code and the same message** the invalid-token branch uses today, so an unresolved token and a wrong token are indistinguishable to a client.
  4. Write the resolved row to `context.state.actor` and `await next()`.
- Step 1 must not throw when `resolveActor` returns `null`. That can happen only against a database with no bootstrap row, which the migration gate at `src/main.ts:157` already prevents. Assert the non-null invariant with a thrown `httpError("internal-error", ...)` rather than passing `null` into `context.state`, so `HandlerContext.actor` is never `undefined`.
- Add `export type AuthenticatedState = Readonly<{ actor: ActorRow }>;` to `src/http/server/auth.ts`, mirroring `RoutedState` at `src/http/server/route.ts:1`. Every later reader narrows `context.state` through it.
- `src/http/server/app.ts`: add a required `actor: ActorRow` field to `HandlerContext` at `:26-32`, after `body`. Update the one site that builds a `HandlerContext` — in `src/http/server/dispatch.ts` — to read `(context.state as AuthenticatedState).actor`. A handler now reads a fact rather than a claim.
- `src/http/server/app.ts`: add `resolveActor` to `AppDependencies` at `:44-52`, and pass it into `authMiddleware` at the call site in the middleware chain (`:78`). Its type matches `AuthDependencies`.
- `test/helpers/app.ts`: `createTestApp` gains one optional override, `resolveActor`. The default returns a fixed bootstrap `ActorRow` literal: `id` `bootstrapActorId`, `kind` `"human"`, `name` `"bootstrap"`, `tokenSha256` `null`, `registeredBy` `null`, `createdAt` `0`, `revokedAt` `null`, `revokedBy` `null`. Export that literal as `BOOTSTRAP_ACTOR_FIXTURE` from the helper so Stories 7, 10 and 13 reuse it. With the default, every existing test keeps passing: the default `token` is `"test-token"` and the default `resolveActor` returns the bootstrap row for any presented value.

## Constraints

- The refusal code and message for an unresolved token must equal the existing invalid-token refusal exactly. A distinct message would tell a caller that its actor id exists.
- `authMiddleware` still runs **before** `routeMiddleware` (`src/http/server/app.ts:78-79`), so it stays route-independent. Do not read `context.state.match`, `registry` or `operationId` in `auth.ts`; the `"stays route-independent by construction"` case at `src/http/server/auth.test.ts:78-83` asserts their absence in the source and must keep passing.
- Perform no authorization here. The actor kind is checked by Story 7's `authorize.ts`.
- `HandlerContext.actor` is required, not optional, so a handler cannot silently read `undefined`.
- Do not change `bearerToken` at `:12-29`.
- A database that holds no actor row cannot be served: migration 0005 inserts the bootstrap row, and `assertMigrated` at `src/main.ts:157` refuses to listen against an unapplied migration.

## Verify

- `src/http/server/auth.test.ts`, extending the existing suite:
  - A missing `Authorization` header is `401` with the message `no bearer token`, unchanged.
  - A header the resolver rejects is `401` with the message `the bearer token is not valid`. Assert the body is **byte-identical** to the body of a `401` produced by a well-formed-but-unknown token and by a revoked token, using three different `resolveActor` fakes that all return `null`.
  - A header the resolver accepts reaches the terminal handler, and `context.state.actor` holds the returned row, asserted field by field.
  - With `token: ""`, no `Authorization` header at all reaches the terminal handler, and `context.state.actor` equals the bootstrap row. Assert `resolveActor` recorded exactly one call, with the argument `""`.
  - With `token: ""` and an arbitrary `Authorization` header present, the request still reaches the handler with the bootstrap actor, so the empty-token mode is unchanged.
  - **`auth.ts` no longer names `node:crypto`**, asserted by reading its source and checking it contains neither `timingSafeEqual` nor `createHash`. Assert `tokensMatch` is no longer exported.
- **Delete the `tokensMatch` cases from `src/http/server/auth.test.ts`** in this story, because this is the story that deletes the function: the `tokensMatch` unit tests, the `"compares in constant time by construction"` case at `:64-68` and the operator-absence case at `:70-76`. Story 2 already re-established that coverage in `src/services/secret/node-crypto.test.ts`. Keep the `"stays route-independent by construction"` case at `:78-83` and every `authMiddleware` behaviour case.
  - `resolveActor` is called exactly once per request, with the exact presented token string, asserted for a token containing a `.`.
- `src/http/server/dispatch.test.ts`: add a case asserting the handler receives `context.actor` equal to the actor on `context.state`.
- Run `node --test --test-timeout=60000 src/http/server/auth.test.ts src/http/server/dispatch.test.ts src/http/server/app.test.ts src/services/secret/node-crypto.test.ts src/queries/actor/resolve-actor.test.ts`; each exits 0.
- `npm run verify` exits 0. This is the gate for the whole Story 2–4–5 unit.
- Proof: `PASS EPIC-015`, and Hermetic coverage line 113.
