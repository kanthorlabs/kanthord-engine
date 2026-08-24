# Story 3 — The key and its fingerprint

Epic: `.agents/plan/epics/010.6-idempotent-post.md`

## Change

### 1. New file `src/http/server/idempotency-key.ts`

It imports `node:crypto` and nothing else. No koa import: every function takes a structural input,
so its test needs no server. `src/http/server/auth.ts:1` already imports `node:crypto`, so the
layer permits it.

```ts
import { createHash } from "node:crypto";

export const IDEMPOTENCY_HEADER = "idempotency-key";
export const MAX_KEY_LENGTH = 255;

const KEY_GRAMMAR = /^[\x21-\x7E](?:[\x20-\x7E]{0,253}[\x21-\x7E])?$/;

export type KeyRead =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "ok"; key: string }>
  | Readonly<{ kind: "invalid"; message: string }>;

export type RawHeaderSource = Readonly<{ rawHeaders: readonly string[] }>;

export function readIdempotencyKey(source: RawHeaderSource): KeyRead;

export type FingerprintInput = Readonly<{
  method: string;
  path: string;
  query: string;
  rawBody: string;
}>;

export function fingerprint(input: FingerprintInput): string;

export type RecordKeyInput = Readonly<{
  operationId: string;
  parameters: Readonly<Record<string, string>>;
  key: string;
}>;

export function recordKey(input: RecordKeyInput): string;
```

#### `readIdempotencyKey`

Read `source.rawHeaders`, the flat `[name0, value0, name1, value1, …]` array Node exposes on
`IncomingMessage`. **Do not read `headers["idempotency-key"]`**: Node joins repeated headers with
`", "`, a comma is a legal key character under the grammar below, and the join is therefore
indistinguishable from a single key that contains a comma.

Apply these steps in this exact order:

1. Walk `rawHeaders` at even indices. Collect every `rawHeaders[i + 1]` whose `rawHeaders[i]`
   lowercases to `IDEMPOTENCY_HEADER`. Preserve encounter order.
2. `values.length === 0` → `{ kind: "absent" }`.
3. `values.length > 1` → `{ kind: "invalid", message: "Idempotency-Key was supplied more than
once" }`.
4. `!KEY_GRAMMAR.test(values[0])` → `{ kind: "invalid", message: "Idempotency-Key must be 1 to 255
printable ASCII characters with no leading or trailing space" }`.
5. `{ kind: "ok", key: values[0] }`.

Both messages are exact strings. A test asserts the response body byte for byte, so a reworded
message is a failure.

The grammar is printable ASCII, `\x20`–`\x7E`, 1 to 255 characters, with the first and last
character restricted to `\x21`–`\x7E`. An **interior space is legal**; a leading or trailing space
is not, because HTTP strips the optional whitespace around a field value, so an edge space could
never survive the wire and a key that relied on one would silently become a different key.

It admits a ULID, a UUID, a base64url string, and a free-form `importId` such as
`release candidate`. It refuses a tab, a control character, a non-ASCII character, an edge space
and an empty value.

`importId` is `z.string().min(1).max(100)`
(`.agents/plan/stories/008-project-and-plan/11-import-transaction.md:118-127`) — free-form, so a
**non-ASCII** `importId` such as `café` is legal in the body and cannot be carried in an HTTP header
value at all. That is a property of HTTP, not of this grammar: RFC 9110 field values are ASCII, and
`obs-text` is deprecated. The consequence is that a non-ASCII `importId` cannot use the keyed
`plan.import` path, and the fix belongs in EPIC 008's `importId` schema, not here. See open question
**B3** in `index.md`.

#### `fingerprint`

```ts
const parts = [input.method, input.path, input.query, input.rawBody];
const joined = parts
  .map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`)
  .join("");
return createHash("sha256").update(Buffer.from(joined, "utf8")).digest("hex");
```

The byte-length prefix is what makes the join unambiguous: without it, a method and a path could
be repartitioned into a different pair with the same concatenation. The output is 64 lowercase hex
characters.

`query` is the query string **without** its leading `?`, and it is `""` when there is none — that
is exactly koa's `context.querystring`. `rawBody` is `""` when no body was parsed.

#### `recordKey`

```ts
const names = Object.keys(input.parameters).sort((a, b) =>
  Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
);
const rendered = names
  .map((name) => `${name}=${input.parameters[name] ?? ""}`)
  .join("");
return `${input.operationId}�${rendered}�${input.key}`;
```

The sort is bytewise, so the same parameter set always renders the same string. The record key
scopes a record to one operation and one concrete resource: the same key sent to two operations, or
to the same operation under two project ids, is two records and not a mismatch.

### 2. `src/http/server/app.ts:66` — assert the raw body, do not configure it

`@koa/bodyparser@6.1.0` hard-codes `returnRawBody: true`
(`node_modules/@koa/bodyparser/dist/body-parser.mjs`, inside `parseBody`) and then assigns
`ctx.request.rawBody = response.raw`. **There is no option that controls it**, and
`src/services/config/convict.d.ts`-style widening does not apply here: the vendor type declares
`Request.rawBody: string`. So this story adds **no** option to the `bodyParser({ enableTypes:
["json"] })` call at `app.ts:66`. It pins the behaviour with a test instead.

Two consequences the implementer must honour, both deterministic:

- `ctx.request.rawBody` is a **`utf-8` string**, not a `Buffer`. `Buffer.from(rawBody, "utf8")`
  recovers the bytes, and `fingerprint` does exactly that through its length prefix. A decoded
  string round-trips to the original bytes only for **valid** UTF-8 input; invalid UTF-8 decodes to
  `U+FFFD` and is lossy. That case never reaches the fingerprint: the parser accepts JSON only,
  JSON is UTF-8 by definition, and invalid UTF-8 fails `JSON.parse` and answers
  `400 invalid-request` at `app.ts:76-79` before this middleware runs. Two requests that differ only
  in invalid UTF-8 bytes are therefore both rejected, never conflated.
- `ctx.request.rawBody` is `undefined` when no body was parsed: when the content type is not JSON,
  and whenever `bodyParserForHandled` (`app.ts:67-87`) skips parsing because the operation is
  `stubbed` or has no bound handler. Every reader coalesces with `?? ""`.

## Constraints

- Do not read `context.headers` or `context.get("Idempotency-Key")` for the presence check. Only
  `context.req.rawHeaders` distinguishes a repeated header.
- Do not change `bodyParserForHandled`'s gating, its `enableTypes`, or its `SyntaxError` mapping.
- Do not normalize, trim, lowercase or URL-decode the key. The grammar accepts or refuses the exact
  received value.
- `src/http/server/idempotency-key.ts` imports `node:crypto` only.

## Verify

`node --test src/http/server/idempotency-key.test.ts` — new file. Suite name
`src/http/server/idempotency-key.test`. No koa, no supertest.

**`readIdempotencyKey`** — build `{ rawHeaders: [...] }` literals:

| rawHeaders                                          | result                               |
| --------------------------------------------------- | ------------------------------------ |
| `[]`                                                | `{ kind: "absent" }`                 |
| `["Host", "a.test"]`                                | `{ kind: "absent" }`                 |
| `["Idempotency-Key", "abc"]`                        | `{ kind: "ok", key: "abc" }`         |
| `["idempotency-key", "abc"]`                        | `{ kind: "ok", key: "abc" }`         |
| `["IDEMPOTENCY-KEY", "abc"]`                        | `{ kind: "ok", key: "abc" }`         |
| `["Idempotency-Key", "a", "Idempotency-Key", "b"]`  | `invalid`, message "…more than once" |
| `["Idempotency-Key", "a", "idempotency-key", "a"]`  | `invalid`, message "…more than once" |
| `["Idempotency-Key", ""]`                           | `invalid`, grammar message           |
| `["Idempotency-Key", "a b"]`                        | `ok`, key `"a b"`                    |
| `["Idempotency-Key", "release candidate"]`          | `ok`                                 |
| `["Idempotency-Key", " ab"]`                        | `invalid`, grammar message           |
| `["Idempotency-Key", "ab "]`                        | `invalid`, grammar message           |
| `["Idempotency-Key", " "]`                          | `invalid`, grammar message           |
| `["Idempotency-Key", "a\tb"]`                       | `invalid`, grammar message           |
| `["Idempotency-Key", "café"]`                       | `invalid`, grammar message           |
| `["Idempotency-Key", "a"]`                          | `ok`, key `"a"`                      |
| `["Idempotency-Key", "a".repeat(255)]`              | `ok`                                 |
| `["Idempotency-Key", "a".repeat(256)]`              | `invalid`, grammar message           |
| `["Idempotency-Key", "01JQ8Z7G3H4K5M6N7P8Q9R0S1T"]` | `ok`                                 |
| `["Idempotency-Key", "a,b"]`                        | `ok`, key `"a,b"`                    |
| `["Idempotency-Key", "!~"]`                         | `ok`, key `"!~"`                     |

Assert both `kind` and the exact `message` / `key`. The `"a,b"` row and the two repeated-header
rows together are what prove `rawHeaders` is read rather than the joined `headers` value: do not
drop them.

**`fingerprint`**:

- `fingerprint({ method: "POST", path: "/v1/project", query: "", rawBody: "{}" })` is 64 characters
  and matches `/^[0-9a-f]{64}$/`.
- Determinism: two calls with identical input return the identical string.
- A different `rawBody` changes it: `{"a":1}` versus `{"a":2}`.
- Whitespace matters: `{"a":1}` versus `{ "a": 1 }` are different fingerprints. This is the
  raw-byte property.
- Key order matters: `{"a":1,"b":2}` versus `{"b":2,"a":1}` are different fingerprints.
- A different `query` changes it: `""` versus `"force=1"`.
- A different `path` changes it: `/v1/project` versus `/v1/project/p_1`.
- A different `method` changes it: `POST` versus `PUT`.
- Non-ASCII survives the length prefix:
  `{ method: "POST", path: "/v1/project", query: "", rawBody: '{"n":"é"}' }` differs from the same
  input with `'{"n":"e"}'`, and both are 64 hex characters.
- The length prefix is load-bearing: assert
  `fingerprint({ method: "AB", path: "C", query: "", rawBody: "" })` differs from
  `fingerprint({ method: "A", path: "BC", query: "", rawBody: "" })`.

**`recordKey`**:

- `recordKey({ operationId: "project.create", parameters: {}, key: "k" })` equals
  `"project.create��k"`.
- `recordKey({ operationId: "plan.validate", parameters: { id: "p_1" }, key: "k" })` equals
  `"plan.validate�id=p_1�k"`.
- Two operations, one key: `recordKey({ operationId: "a", parameters: {}, key: "k" })` differs from
  `recordKey({ operationId: "b", parameters: {}, key: "k" })`.
- Two resources, one key and one operation: `parameters: { id: "p_1" }` differs from
  `{ id: "p_2" }`.
- Parameter order does not matter: `{ id: "1", hash: "2" }` and `{ hash: "2", id: "1" }` render the
  identical string `"x�hash=2id=1�k"` — bytewise sort, `hash` before `id`.

**Raw body preservation** — one extra `describe` inside the same new file, because the vendor
contract is what the fingerprint rests on. A handler never sees `context`, so this is asserted
against a standalone koa app rather than through `createApp`.

Build it exactly as `src/http/server/origin.test.ts:10-18` builds its probe app: `new Koa()`, then
`app.use(bodyParser({ enableTypes: ["json"] }))` imported from `@koa/bodyparser`, then one terminal
middleware `(context) => { context.body = { raw: context.request.rawBody ?? null }; }`. Reach it
with `loopbackAgent(app)` from `test/helpers/agent.ts`. Assert:

- `POST` with `Content-Type: application/json` and the literal body `{ "a" : 1 }` answers
  `body.raw === '{ "a" : 1 }'` — byte for byte, inner spaces included. This assertion fails if a
  vendor bump ever drops `returnRawBody`, which is the whole reason it exists.
- `POST` with `Content-Type: text/plain` and body `hello` answers `body.raw === null`, pinning the
  `undefined` case every reader coalesces with `?? ""`.
- `GET` with no body answers `body.raw === null`.

`npm run verify` exits 0.

Proof: delivers the `src/http/server/idempotency.test.ts` Proof lines that depend on key validation
and fingerprinting — "a key that is too long, that carries an illegal character, or that arrives
twice", "the same key with a different body", "the same key with a different query string", and
"one key sent to two different operations records two entries".
