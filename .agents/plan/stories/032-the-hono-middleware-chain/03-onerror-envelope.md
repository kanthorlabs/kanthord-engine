# Story 3 - app.onError owns the envelope

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 2. Coupled with Stories 4 through 16.

## Change

- Edit `src/http/server/envelope.ts:1-45`.
- Delete the Koa imports, `EnvelopeDependencies`, and `envelopeMiddleware`.
- Keep `Materialized` and `materializeError(error: unknown): Materialized` behavior unchanged.
- Export `errorResponse(materialized: Materialized, headers: Headers): Response`.
- If the accumulator lacks `content-type`, set it to `application/json; charset=utf-8`.
- Serialize `materialized.body` once with `JSON.stringify` and return a `Response` with that string, `materialized.status`, and the same accumulator.
- Export `class ThrownValueError extends Error` with `readonly value: unknown`.
- Its constructor stores the exact value and uses `a non-Error value was thrown` as the message.
- Export `errorValue(error: Error): unknown`. Return `error.value` for `ThrownValueError`; otherwise return `error` unchanged.
- Rewrite `src/http/server/envelope.test.ts:1-164` as direct function and class tests.
- Preserve the existing `materializeError` rows for ordinary `HttpError`, detailed 409, plain `Error`, string, `undefined`, and declared `internal-error`.
- Assert that `errorResponse` returns the exact status, exact JSON text, and default JSON content type.
- Seed a custom content type and CORS headers. Assert that `errorResponse` preserves those exact values.
- Construct `ThrownValueError` with a string and with `undefined`. Assert the exact message and exact stored value.
- Assert that `errorValue` unwraps both wrappers and preserves a plain `Error` by identity.

## Constraints

- Do not report internal errors in this module. Story 16 owns `onInternalError`.
- Do not catch serialization failures in `errorResponse`.
- Do not change any error status, code, message, details, or `internal` classification.
- Do not retain a Koa middleware export.

## Verify

- Run `node --test src/http/server/envelope.test.ts` after Stories 3 through 16 land.
- Every existing materialization row remains exact. Error responses preserve accumulator headers and explicit content type.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/envelope.test.ts` line.
- Proof: supports the plain and non-`Error` internal-error envelope assertions.
