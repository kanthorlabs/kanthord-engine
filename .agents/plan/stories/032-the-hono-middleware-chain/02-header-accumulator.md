# Story 2 - The header accumulator

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 1.

## Change

- Add `src/http/server/headers.ts` with exported `headersMiddleware()`.
- Return a Hono middleware for `AppEnv`.
- For each invocation, create one new `Headers`, store it as `headers`, then await `next()` exactly once.
- Add `src/http/server/headers.test.ts` with suite name `src/http/server/headers.test`.
- Invoke the middleware with a `Context<AppEnv>` and a counting `next` function.
- Inside `next`, demand `headers`, capture its identity, and increment the call count.
- After the middleware returns, assert one call and strict identity between the downstream value and `demand(c, "headers")`.
- Invoke the middleware against a second context. Assert that the two stored accumulators are different objects.

## Constraints

- Do not write through `c.header` or `c.res`.
- Do not reuse a module-level `Headers` instance.
- Do not edit any existing production or test file.

## Verify

- Run `node --test src/http/server/headers.test.ts`.
- Each request gets one independent accumulator before downstream code runs.
- `npm run verify` exits 0.
- Proof: delivers the `src/http/server/headers.test.ts` line.
