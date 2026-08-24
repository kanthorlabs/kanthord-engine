# Story 03 — `blob.show`

Epic: `.agents/plan/epics/010-contract-completion.md`
Depends on: Story 01 (it writes `HandlerResult.headers` and reads `HandlerContext.headers`). Story 02 must land before this story's `src/main.test.ts` edit — see the index dispatch order.

`blob.show` is `routed` at `src/http/contract/system.ts:53-59` and answers `501` today. `SqliteBlobStore.get` (`src/services/blob/sqlite.ts:33-64`) already reads the row and is constructed nowhere. This story adds the media contract, the query, the handler, the binding, and the `Range` behaviour.

The contract is `docs/proposal/api/system.md:73-80`, six clauses: the `sha256:<hex>` path parameter verbatim, the payload bytes, `Content-Type: application/octet-stream`, `ETag` as the quoted hash with `Cache-Control: private, immutable`, an answered `Range`, the bearer token, and `404` for an unknown hash.

## Change

### 1. `src/http/contract/operation.ts:19-28` — one new optional field

Add `responseMedia?: string;` after `response?: ZodType;`:

```ts
export type Operation = Readonly<{
  operationId: string;
  method: Method;
  path: readonly Segment[];
  introducedIn: IntroducedIn;
  status: "routed" | "stubbed";
  successStatus?: number;
  request?: ZodType;
  response?: ZodType;
  responseMedia?: string;
}>;
```

`responseMedia` is the media contract the EPIC names. It is not a body schema: `blob.show` still carries no `response`, so `src/http/contract/system.test.ts:168-171` stays true and is not edited.

**`response` and `responseMedia` are mutually exclusive, and the registry enforces it.** Add a rule to `registryFaults` (`src/http/contract/registry.ts:118-235`), in the same shape as the eight rules already there:

```ts
if (entry.response !== undefined && entry.responseMedia !== undefined) {
  faults.push({
    operationId: entry.operationId,
    reason: "response and responseMedia both declared",
  });
}
```

Without it the two fields could both be set and one would be silently dropped by the generator, which is contradictory registry data rather than a contract.

### 2. `src/http/contract/system.ts:53-59` — declare it

Add `responseMedia: "application/octet-stream",` to the `blob.show` entry. No other entry gains the field.

### 3. `src/http/contract/openapi.ts:89-103` — emit it

Inside the `routed` branch, when `entry.responseMedia !== undefined`, the success response gains:

```ts
content: {
  [entry.responseMedia]: { schema: { type: "string", format: "binary" } },
},
```

No component is registered, so `components.schemas` is unchanged and the schema is inline. The two fields cannot both be set, because the `registryFaults` rule above refuses it, so the branch needs no precedence rule.

**Whether the document also declares a `206` response depends on B4.** If Ulrich settles the `Range` contract as Story 03 pins it, the operation can answer `206` and a document that declares only `200` is incomplete. `src/http/contract/openapi.test.ts:184-203` deep-equals `Object.keys(responses)` per entry, so adding `206` is a one-line test edit — but it is a public contract change and it is not the planner's to make. Story 03 emits `["200", "default"]` until B4 is answered.

### 4. `src/queries/blob/show-blob.ts` (new)

```ts
export type ShowBlobDependencies = Readonly<{
  blobs: BlobStore;
}>;

export type BlobView = Readonly<{
  hash: string;
  size: number;
  content: Uint8Array;
  createdAt: number;
}>;

export function showBlob(
  dependencies: ShowBlobDependencies,
  input: Readonly<{ hash: string }>,
): BlobView | null;
```

The body is one call: `return dependencies.blobs.get(input.hash);`. `BlobStore` comes from `../../services/blob/index.ts`, a service interface. `BlobRecord` is structurally `BlobView`, so the return passes through unchanged. The query never names `SqliteBlobStore`.

**`BlobView` exists for the same reason `EventView` does in Story 02.** `eslint.config.js:140-156` does not allow `http-server` to import a service, so a handler dependency typed `BlobRecord` fails `npm run lint`.

Synchronous, for the reason in Story 02.

### 5. `src/http/server/blob/range.ts` (new)

```ts
export type ByteRange = Readonly<{ start: number; end: number }>;

export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | null;
```

`end` is inclusive. `null` means "serve the whole payload with `200`".

Every rule below is now stated in `docs/proposal/api/system.md` — the three accepted forms, the `200` fallback, the explicit refusal of `416`, and the one-year `max-age`. This story implements the proposal rather than inventing it:

- `header === undefined` → `null`.
- The header must match `/^bytes=(\d*)-(\d*)$/` after trimming. Anything else — a second range, a non-`bytes` unit, a malformed value — → `null`.
- `bytes=a-b` with `a <= b` and `a < size` → `{ start: a, end: Math.min(b, size - 1) }`.
- `bytes=a-` with `a < size` → `{ start: a, end: size - 1 }`.
- `bytes=-n` with `n > 0` → `{ start: Math.max(0, size - n), end: size - 1 }`.
- `bytes=-0` → `null`.
- `bytes=-` (both sides empty) → `null`.
- `a >= size` → `null`.
- `a > b` → `null`.
- `size === 0` → `null` for every header.
- A digit run that does not satisfy `Number.isSafeInteger` after parsing → `null`. `bytes=0-99999999999999999999` is unparseable, not a clamp.
- `size` is **`content.length` of the payload the store returned**, never the `size` column. The two agree by construction (`src/services/blob/sqlite.ts:24-31` hashes the same bytes it stores), and using the byte length means a row whose column disagreed cannot produce a `Content-Range` that overruns the body.

**An unsatisfiable or unparseable `Range` is ignored and the whole payload is returned with `200`.** `docs/proposal/api/system.md` states it and gives the reason: a `Range` is a client optimisation rather than a precondition, so serving the whole payload always satisfies the request the client actually made. The route never answers `416`, and `docs/proposal/api/README.md:165-187` declares no such code.

### 6. `src/http/server/blob/show-blob.ts` (new)

```ts
export type ShowBlobHandlerDependencies = Readonly<{
  showBlob: (input: Readonly<{ hash: string }>) => BlobView | null;
}>;

export function showBlobHandler(
  dependencies: ShowBlobHandlerDependencies,
): Handler;
```

Parse, invoke, format:

```ts
return (context) => {
  const hash = context.parameters["hash"];
  if (hash === undefined || !blobHash.safeParse(hash).success) {
    throw httpError("not-found", `no blob ${hash ?? ""}`);
  }
  const record = dependencies.showBlob({ hash });
  if (record === null) {
    throw httpError("not-found", `no blob ${hash}`);
  }
  const content = Buffer.from(record.content);
  const headers = {
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, immutable, max-age=31536000",
    "Content-Type": "application/octet-stream",
    ETag: `"${record.hash}"`,
  };
  const range = parseRange(context.headers["range"], content.length);
  if (range === null) {
    return { status: 200, body: content, headers };
  }
  return {
    status: 206,
    body: content.subarray(range.start, range.end + 1),
    headers: {
      ...headers,
      "Content-Range": `bytes ${range.start}-${range.end}/${content.length}`,
    },
  };
};
```

Four fixed decisions:

- **A malformed hash is `404`, not `400`.** `docs/proposal/api/system.md:80` — "An unknown hash is `404 not-found`". A value that cannot be a hash was never stored. `blobHash` is `src/domain/blob.ts:5`, and validating in the handler means the query never sees a value that would make `SqliteBlobStore.get` throw `blob-hash-invalid`.
- **`max-age` is `31536000`.** `docs/proposal/api/system.md` states the full header value, one year.
- **The `ETag` is the stored hash including the `sha256:` prefix, in literal double quotes.** `docs/proposal/api/system.md:75-77` — the API never reformats the value, and `ETag` is "the hash as a quoted entity tag".
- **No `If-None-Match` and no `304`.** `docs/proposal/api/system.md` now states the refusal explicitly: the `ETag` exists so a cache can key on it, not so a client can revalidate an address that cannot change.

The path parameter is keyed `hash`, not `id`. `src/http/contract/path.ts:92` builds `{ kind: "parameter", value: "hash" }`, and `blob.show` is the one operation in the registry that does (`src/http/contract/registry.test.ts:105-118`). A colon is legal in a path segment, so nothing is percent-encoded (`docs/proposal/api/system.md:75`).

### 7. `src/main.ts` — construct the store and bind the handler

**Use the semantic anchors below, not line numbers.** EPICs 008 and 009 are unbuilt and both edit `src/main.ts` heavily.

- Immediately after the `const events = new SqliteEventLog({ storage, ids });` line in the `serve` action (currently `:144`) add:

```ts
const blobs = new SqliteBlobStore({ storage, clock });
```

`SqliteBlobStore` is imported from `./services/blob/sqlite.ts`; its dependencies are `{ storage, clock }` (`src/services/blob/sqlite.ts:8-22`), both already in scope at that point.

- Add to the `const handlers = { … }` object literal in the same scope (currently `:193-256`):

```ts
"blob.show": showBlobHandler({
  showBlob: (input) => showBlob({ blobs }, input),
}),
```

No edit to the `unimplemented` list: the `const unimplemented = registry…` block that follows the handlers object derives it.

### 8. `src/main.test.ts` — the pending constant empties

- `const pending = [] as const`, and the residue deep-equal becomes `[]`. **This story lands after Story 02 and writes the final value.**
- Add a `blob.show` fixture. Its parameter is `{ hash: "sha256:" + "0".repeat(64) }`, per `.agents/plan/stories/009-cli-and-composition-root/07-composition-root-asserted-complete.md:79`, and its expectation is `404`: the daemon under test stores no blob, so `404` is the correct answer and it proves the route is bound rather than `501`.

## Constraints

- No migration. `blob` exists at `src/services/storage/migration-0001-core-entities.ts:7-12`.
- No new error code, no new operation, no new path. `src/http/contract/registry.test.ts:14-16` (53 entries) and `:29-38` (23 routed / 30 stubbed), `src/http/contract/parity.test.ts` in full, and `src/http/contract/openapi.test.ts:74-80` (47 paths) and `:112-120` (53 ids) are all unchanged.
- `components.schemas` is unchanged. The binary schema is inline, so `src/http/contract/openapi.test.ts:205-230` keeps whatever key list EPIC 009 left it with, and this story must not edit that list.
- No edit to `src/services/blob/`. `get` at `src/services/blob/sqlite.ts:33-64` needs nothing.
- **No size limit, and the payload is materialized.** `docs/proposal/database/blob.md` now states why: `node:sqlite` exposes no incremental blob API — `DatabaseSync` has no `blobOpen` — so a `BLOB` column is read as one buffer whatever the reader intends, and a streamed response would wrap a buffer already in memory. The `size` column serves `Content-Length`, not a refusal. No threshold is invented. The epic that first writes a payload large enough to matter is the epic that moves `content` out of the row.
- The handler never sniffs content to choose a type (`docs/proposal/api/system.md:76`).

## Verify

```bash
node --test src/http/server/blob/range.test.ts src/http/server/blob/show-blob.test.ts src/queries/blob/show-blob.test.ts src/http/contract/system.test.ts src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/main.test.ts
```

### `src/http/server/blob/range.test.ts` (new)

Suite name `"src/http/server/blob/range.test"`. A pure table test over `parseRange`, one assertion per row, `size = 10` unless the row says otherwise.

| header                           | size | result                 |
| -------------------------------- | ---- | ---------------------- |
| `undefined`                      | 10   | `null`                 |
| `"bytes=0-4"`                    | 10   | `{ start: 0, end: 4 }` |
| `"bytes=2-2"`                    | 10   | `{ start: 2, end: 2 }` |
| `"bytes=0-99"`                   | 10   | `{ start: 0, end: 9 }` |
| `"bytes=5-"`                     | 10   | `{ start: 5, end: 9 }` |
| `"bytes=-3"`                     | 10   | `{ start: 7, end: 9 }` |
| `"bytes=-99"`                    | 10   | `{ start: 0, end: 9 }` |
| `"bytes=-0"`                     | 10   | `null`                 |
| `"bytes=-"`                      | 10   | `null`                 |
| `"bytes=10-12"`                  | 10   | `null`                 |
| `"bytes=6-4"`                    | 10   | `null`                 |
| `"bytes=0-4, 6-8"`               | 10   | `null`                 |
| `"items=0-4"`                    | 10   | `null`                 |
| `"0-4"`                          | 10   | `null`                 |
| `"bytes=0-4"`                    | 0    | `null`                 |
| `"bytes=abc-4"`                  | 10   | `null`                 |
| `"bytes=0-99999999999999999999"` | 10   | `null`                 |
| `"  bytes=0-4  "`                | 10   | `{ start: 0, end: 4 }` |

### `src/queries/blob/show-blob.test.ts` (new)

Suite name `"src/queries/blob/show-blob.test"`. **No SQLite and no `SqliteBlobStore`.** This test covers `src/queries/`, not `src/services/blob/`, and `AGENTS.md` lets a test reach an implementation only in the capability it covers. Persistence, hashing and deduplication are already proved by `src/services/blob/sqlite.test.ts`.

`showBlob` is a one-call adapter, so the test is a **Mock** of `BlobStore` whose `put` throws if called and whose `get` records its argument.

- **The hash is forwarded byte for byte.** `showBlob({ blobs: mock }, { hash })` calls `mock.get` exactly once with the hash **including the `sha256:` prefix**, and with no second argument, so the query never opens a transaction.
- **The record is returned by identity.** `assert.strictEqual(showBlob(...), theRecordTheMockReturned)`.
- **A `null` from the store returns `null`.** The query invents no empty record.

### `src/http/server/blob/show-blob.test.ts` (new)

Suite name `"src/http/server/blob/show-blob.test"`. Built on `createTestApp({ handlers: { "blob.show": showBlobHandler({ showBlob }) } })` with an injected fake returning a fixed record. The fixture is 10 bytes, `Buffer.from("0123456789")`, and its real sha256 is computed once in the test with `node:crypto` so the `ETag` assertion is an exact string. Every response body is read with `.buffer()`, never parsed as JSON.

- `GET /v1/blob/<hash>` answers `200`, the body is the 10 bytes, and the four headers are exactly `accept-ranges: bytes`, `cache-control: private, immutable, max-age=31536000`, `content-type` matching `/application\/octet-stream/`, and `etag` equal to `"<hash>"` with the quotes.
- The handler calls `showBlob` exactly once, with `{ hash }` deep-equal to the path segment **including the `sha256:` prefix**. This is the no-reformatting assertion.
- `Range: bytes=0-4` answers `206`, a 5-byte body equal to `"01234"`, and `content-range: bytes 0-4/10`. The other four headers are unchanged.
- `Range: bytes=-3` answers `206`, body `"789"`, `content-range: bytes 7-9/10`.
- `Range: bytes=5-` answers `206`, body `"56789"`, `content-range: bytes 5-9/10`.
- `Range: bytes=99-100` answers `200` with the full 10 bytes and **no** `content-range` header.
- `Range: potato` answers `200` with the full 10 bytes and no `content-range` header.
- A `showBlob` returning `null` answers `404` with `error.code === "not-found"` and a message containing the hash.
- `GET /v1/blob/notahash` answers `404` and `showBlob` is **never called**.
- `GET /v1/blob/sha256:ABCDEF...` (uppercase hex, 64 chars) answers `404` and `showBlob` is never called: `src/domain/blob.ts:5` requires lowercase.
- No token answers `401`; an `Origin` header answers `403`. `docs/proposal/api/system.md:79` — a hash is not a capability.
- A zero-byte blob answers `200` with an empty body and `Range: bytes=0-0` also answers `200`, not `206`.

### `src/http/contract/openapi.test.ts` (edited)

- `/v1/blob/{hash}` `get` `responses["200"].content["application/octet-stream"].schema` deep-equals `{ type: "string", format: "binary" }`.
- `Object.keys(responses)` for `blob.show` stays `["200", "default"]`, so `src/http/contract/openapi.test.ts:184-203` needs no change.
- `components.schemas` gains no key. Assert the key count is unchanged from what EPIC 009 left.
- The document still validates through `@apidevtools/swagger-parser` and every `$ref` still resolves (`src/http/contract/openapi.test.ts:232-263`). `format: "binary"` is legal in OpenAPI 3.0.3.
- Two renders stay byte-identical (`src/http/contract/openapi.test.ts:251-257`).

### `src/http/contract/registry.test.ts` (edited)

- `registryFaults(registry)` still deep-equals `[]`. The new rule fires on nothing that ships.
- A synthetic entry carrying **both** `response` and `responseMedia` yields exactly one fault whose `reason` is `"response and responseMedia both declared"`. `src/http/contract/registry.test.ts` already builds synthetic entries for each of the eight existing fault rules; copy that shape.

### `src/http/contract/system.test.ts` (edited)

- `findOperation("blob.show")?.responseMedia` equals `"application/octet-stream"`.
- `findOperation("blob.show")?.response` is still `undefined`. The existing assertion at `src/http/contract/system.test.ts:168-171` is not weakened.
- Every other registry entry has `responseMedia === undefined`. Assert by filtering the whole registry, so a second media declaration cannot appear unnoticed.

### `src/main.test.ts` (edited)

- `pending` deep-equals `[]`. Every `routed` operation is bound.
- The `blob.show` fixture answers `404`, not `501`.

`npm run verify` exits 0.

Proof: contributes `src/http/server/blob/*.test.ts`, `src/queries/blob/show-blob.test.ts` and the two contract-test edits. Only the contract edits are inside the EPIC Proof glob — see B1 in the index.
