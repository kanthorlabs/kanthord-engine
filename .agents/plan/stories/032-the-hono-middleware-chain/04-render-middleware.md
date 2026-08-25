# Story 4 - The render middleware

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 3. Coupled with Stories 3 through 16.

## Change

- Add `src/http/server/render.ts`.
- Export `MaterializedResult = Readonly<{ status: HandlerStatus; body: string | Uint8Array | null }>`.
- Export `materializeResult(result: HandlerResult, operation: Operation | undefined, headers: Headers): MaterializedResult`.
- Read `operation` only for a `bytes` result. A `json` result and an `empty` result admit `undefined`.
- For `json`, set `application/json; charset=utf-8` only when content type is absent, call `JSON.stringify(result.body)` once, and return the exact string.
- If JSON serialization returns `undefined`, throw `TypeError("the handler result is not json serializable")`.
- If JSON serialization throws, propagate the same value unchanged.
- For `bytes`, set the default content type from `operation.responseMedia` only when absent and return the same `Uint8Array` object.
- Preserve EPIC 031's `internal-error` refusal when a bytes operation lacks `responseMedia`, and raise the same refusal when a bytes result carries no operation.
- For `empty`, set no content type and return `null` with status 204 or 304.
- Export `renderMiddleware()` for `AppEnv`.
- Await `next()`, then apply these branches in exact order:
- If `c.error !== undefined`, return without reading `result` or `replay` and without replacing `c.res`.
- If `optional(c, "replay")` returns an answer, set each stored header tuple into the accumulator and return `new Response(answer.body, { status: answer.status, headers })`.
- Otherwise, if `optional(c, "result")` returns a result, materialize once and return a `Response` from its exact status, body, and accumulator.
- Pass `demand(c, "match").operation` for a `bytes` result. Pass `undefined` for a `json` result and for an `empty` result.
- Otherwise, throw `httpError("internal-error", "the transport produced no result")`.
- Add `src/http/server/render.test.ts` with suite name `src/http/server/render.test`.
- Test `materializeResult` for JSON, bytes, 204, and 304. Assert exact status, body value, byte identity, `application/json; charset=utf-8`, operation media type, and content-type absence for empty results.
- Test handler content-type precedence for JSON and bytes.
- Test a stateful `toJSON` value. Assert one call and the exact serialized string.
- Test `JSON.stringify` returning `undefined` and throwing an `Error`. Assert the exact transport `TypeError` and original thrown object.
- Test middleware replay for a stored JSON string, a stored `Uint8Array`, and `null`. Assert exact status, exact bytes, and exact content type.
- Test a normal result response, the missing-result internal error, and a pre-set `c.error` with a pre-set `c.res`. Assert that the error response object remains unchanged.
- Test an `empty` 204 result on a context that carries no `match`. Assert status 204, an empty body, and no throw. This is the preflight shape: `preflightMiddleware` writes `result` and never calls `next()`, so `routeMiddleware` never runs.
- Test a `bytes` result on a context that carries no `match`. Assert the `internal-error` refusal.

## Constraints

- A replay is never converted into `HandlerResult`.
- Serialize a JSON result once.
- Apply replay headers with `set`, not `append`.
- Set no content type for an empty result.
- Do not build an error envelope in this module.
- Do not demand `match` for a `json` result or an `empty` result.

## Verify

- Run `node --test src/http/server/render.test.ts` after Stories 3 through 16 land.
- All four middleware branches and all three result variants return exact status, headers, and bytes.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/render.test.ts` line.
- Proof: delivers "Stored bodies are exact response bodies" and "render.ts leaves an error answer alone."
