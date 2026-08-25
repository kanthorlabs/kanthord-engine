# Story 2 — Add the level-1 Fetch agent

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: Story 1.

## Change

### `test/helpers/agent.ts`

- Add value and type imports for `Hono` and `Env` from `hono` at the import block.
- Keep `loopbackServer` and `loopbackAgent` byte for byte.
- Export `AgentResponse` with `status`, lower-case `headers`, `body`, and UTF-8 `text`.
- Type `body` as `any`. Type headers as `Readonly<Record<string, string>>`.
- Export `AgentRequest` as `Promise<AgentResponse>` plus chainable `set`, `send`, and `buffer` methods.
- Export `Agent` with `get`, `post`, `put`, `del`, `delete`, and `options` methods.
- Export `fetchAgent<E extends Env>(app: Hono<E>): Agent`.
- Map `del` and `delete` to `DELETE`. Map every other member to its uppercase HTTP method.
- Create one mutable `Headers` instance and one optional byte body per request builder.
- Make `.set(name, value)` call `headers.set(name, value)` and return the same request object.
- Make `.send(object)` use `JSON.stringify`, encoded as bytes.
- If `.send(object)` sees no content type, set `content-type` to `application/json`.
- Preserve a caller-supplied content type for `.send(object)`.
- Make `.send(string)` encode the exact string as bytes and add no content type.
- Make `.buffer()` return the same request object without state change.
- Dispatch only when `then`, `catch`, or `finally` first requests the response.
- Store that dispatch promise and reuse it for every later await or promise method.
- Add `[Symbol.toStringTag]: "Promise"` and delegate `then`, `catch`, and `finally` to the cached promise.
- Call `app.request(path, { method, headers, body })` during dispatch.
- Omit the request body when `.send` was never called.
- Read the response once as bytes. Decode those bytes as UTF-8 into `text`.
- Build response headers by iterating `response.headers`; retain lower-case keys.
- A `Headers` iterator joins a repeated ordinary header, but it yields `set-cookie` once per value.
- When iteration yields a key already present, join the prior value and the new value with `", "`.
- Resolve `body` in this exact order. Test the empty case first.
- For zero response bytes, set `body` to `{}` and `text` to `""`. Parse nothing.
- Otherwise treat `application/json`, ignoring parameters and case, as JSON.
- For JSON, parse `text` into `body`. For every other content type, set `body` to `Buffer` bytes.

The exported contracts are exact:

```ts
export type AgentResponse = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  body: any;
  text: string;
}>;

export type AgentRequest = Promise<AgentResponse> & {
  set(name: string, value: string): AgentRequest;
  send(body: unknown): AgentRequest;
  buffer(): AgentRequest;
};

export type Agent = Readonly<{
  get(path: string): AgentRequest;
  post(path: string): AgentRequest;
  put(path: string): AgentRequest;
  del(path: string): AgentRequest;
  delete(path: string): AgentRequest;
  options(path: string): AgentRequest;
}>;
```

### `test/helpers/agent.test.ts`

- Add `Hono` and `fetchAgent` imports at `test/helpers/agent.test.ts:1-5`.
- Append exactly fourteen cases after the five level-2 cases.
- Keep the following case order and assertions.

1. `lower-cases response header names`: return `X-Answer`; assert only `x-answer` holds its value.
2. `joins duplicate response header values, set-cookie included`: append `X-A: one` and `X-A: two`,
   and append `Set-Cookie: a=1` and `Set-Cookie: b=2`; assert `x-a` equals `one, two` and
   `set-cookie` equals `a=1, b=2`.
3. `parses a JSON response into body`: return `{ ok: true }`; deep-equal `body` to that object.
4. `returns a Buffer body for a non-JSON response`: return bytes `[0, 255]`; deep-equal the Buffer.
5. `returns an empty object for an empty response`: return an empty 204; deep-equal `body` to `{}`.
6. `decodes response text as UTF-8`: return `h\u00e9`; assert `text` equals `h\u00e9`.
7. `send object sets the JSON content type`: echo the request header and text; assert JSON and `{"a":1}`.
8. `send object preserves a caller content type`: set `application/custom`; assert it and `{"a":1}`.
9. `send string preserves its bytes and sets no content type`: send `{ "a" : 1 }`; assert exact text and no header.
10. `dispatches lazily after set calls`: build the request, set two headers, then assert zero handler calls.
11. `memoizes one response across repeated awaits`: await one request twice; assert one call and response identity.
12. `options sends the OPTIONS method`: echo `c.req.method`; assert `OPTIONS`.
13. `delete and del send the DELETE method`: issue both requests; assert `DELETE` for both.
14. `opens no listening socket`: compare `TCPServerWrap` counts before and after one completed request.

- In case 10, await after the zero-call assertion and assert both late headers reached the application.
- In case 14, filter `process.getActiveResourcesInfo()` by the exact literal `TCPServerWrap`.

## Constraints

- Add exactly fourteen cases. The file total becomes nineteen.
- Keep all five prior cases unchanged.
- Do not subclass `Promise` and do not dispatch from an HTTP method call.
- Do not use Supertest, a socket, a port, a timer, or a runtime adapter inside `fetchAgent`.
- Join duplicate `set-cookie` values at level 1. Story 6 owns separate values over the wire.

## Verify

- Run `node --test test/helpers/agent.test.ts`.
- The command passes nineteen cases and fails zero cases.
- Run `npm run typecheck`; `AgentRequest` is assignable to `Promise<AgentResponse>`.
- Run `npm run verify`; it exits 0.
- Proof: delivers the `test/helpers/agent.test.ts` line for the complete level-1 contract.
- Proof: delivers the gate bullets for no `TCPServerWrap` and unref'd level-2 listeners.
- Proof: the repository pass count rises by exactly fourteen from Story 1.
