# Story 11 - The gated body parse

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 10. Coupled with Stories 3 through 16.

## Change

- Add `src/http/server/body.ts` with `export const BODY_LIMIT_BYTES = 1_048_576` and exported `bodyMiddleware(handlers)` for `AppEnv`.
- Accept the same `Readonly<Record<string, Handler>>` map as `dispatchMiddleware`.
- Apply these gates in exact order before reading any body byte:
- If `c.req.method` is not `POST`, `PUT`, or `PATCH`, await `next()` without writing `body` or `rawBody`.
- Demand `match`. If the operation is stubbed or has no bound handler, await `next()` without writing either variable.
- Parse the media type before the first `;`, trim it, and lower-case it.
- Admit exactly `application/json`, `application/json-patch+json`, `application/vnd.api+json`, `application/csp-report`, `application/reports+json`, and `application/scim+json`.
- For any other or absent media type, set `body` to `{}`, leave `rawBody` absent, then await `next()`.
- Before reading the stream, parse a decimal `content-length` when present. If it is greater than `BODY_LIMIT_BYTES`, throw `new Error("request body exceeds the limit")` without pulling the body stream.
- Otherwise, read `c.req.raw.body` once through its reader. Add each chunk's `byteLength` before retaining it. Fail as soon as the total exceeds `BODY_LIMIT_BYTES` and do not request another chunk.
- On the streamed refusal, call `reader.cancel()` first, then throw the same `new Error("request body exceeds the limit")`.
- Both refusals throw a plain `Error`, never an `HttpError`. `materializeError` maps it to the generic 500 envelope and `onInternalError` receives that exact `Error`.
- Concatenate retained chunks in arrival order and decode them once with UTF-8 `TextDecoder`. Use `""` when the body stream is null.
- Store the exact decoded text as `rawBody`.
- If the text is empty, store `{}` as `body`, then await `next()`.
- If the first character after `\x20`, `\x09`, `\x0a`, and `\x0d` whitespace is not `[` or `{`, throw `httpError("invalid-request", "the request body is not valid json")`.
- Parse with `JSON.parse`. Map only `SyntaxError` to the same `invalid-request` error and message. Store every successful value as `body`, then await `next()`.
- Edit `src/http/server/app.ts:1-2,98,115-140` only to remove the `@koa/bodyparser` import, its registration, and `bodyParserForHandled`. Story 16 inserts `bodyMiddleware` at the removed registration site.
- Add `src/http/server/body.test.ts` with suite name `src/http/server/body.test`.
- Use direct Hono contexts with seeded `headers` and `match` variables, deterministic handlers, and an `onError` fixture built from Story 3 helpers.
- Add method rows for GET, DELETE, POST, PUT, and PATCH. Assert absent variables for GET and DELETE, and parsed bodies for the three write methods.
- Add operation-gate rows for a stubbed operation and a routed operation without a bound handler. Use malformed JSON and assert no body pull, absent variables, and downstream execution.
- Add a table for all six admitted media types. Include mixed case and parameters across the rows. Assert exact `rawBody` and parsed object.
- Add `text/plain` and absent-content-type rows. Assert `body` deep-equals `{}` and `rawBody` is absent.
- Send `{ "a" : 1 }` and assert the exact whitespace survives in `rawBody` while `body` equals `{ a: 1 }`.
- Send zero bytes as JSON. Assert `rawBody === ""` and `body` deep-equals `{}`.
- Send scalar `1` and `"a"`, plus malformed `{"oops`. Assert status 400 and exact `invalid-request` message for each.
- For the declared-length cap, use `content-length: 1048577` with a pull-counting stream. Assert generic status 500, exact generic envelope, and zero pulls.
- For the streamed cap, provide chunks totaling exactly 1048576 bytes, then one byte, then a sentinel chunk. Assert generic status 500, exact generic envelope, that the sentinel is never pulled, and that `reader.cancel()` ran.
- For both cap rows, assert that `onInternalError` receives an `Error` whose message is `request body exceeds the limit`.
- Add an exact-boundary row with `{"x":"${"a".repeat(1_048_568)}"}`. Assert its UTF-8 length is 1048576, its exact parsed object, and one downstream call.

## Constraints

- Count request bytes, not JavaScript string code units.
- Read an admitted body once. Do not call both the stream reader and `c.req.text()`.
- Do not read bodies for method, operation, handler, or media-type bypasses.
- Keep the 1 MiB overflow on the generic internal-error path, not a declared 413 path.
- Do not restore the vendor prototype-poisoning refusal.
- Do not edit EPIC 030 parity files.

## Verify

- Run `node --test src/http/server/body.test.ts` after the coupled batch lands.
- Every gate, six media types, strict JSON rule, raw text rule, and both limit paths pass with exact values.
- Run `node --test src/http/server/app.parity-body.test.ts` and confirm that the file remains unchanged.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the `src/http/server/body.test.ts` line.
- Proof: delivers the routed-operation 400 and all body-rule coverage bullets. Story 14 owns the stubbed-operation 501 regression.
