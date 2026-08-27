# Story 12 - The idempotency helpers on Fetch types

Epic: `.agents/plan/epics/032-the-hono-middleware-chain.md`
Depends on: Story 11. Coupled with Stories 3 through 16.

## Change

### Key reader

- Edit `src/http/server/idempotency-key.ts:3-42`.
- Delete `RawHeaderSource` and change `readIdempotencyKey` to accept `Headers`.
- Read `headers.get(IDEMPOTENCY_HEADER)` once.
- Return `absent` for `null`.
- If the joined value contains `,`, return the existing invalid result with `Idempotency-Key was supplied more than once`.
- Otherwise, preserve the existing length and printable-ASCII grammar, including accepted interior spaces and refused leading or trailing spaces.
- Keep `fingerprint` and `recordKey` behavior unchanged.

### Stored response

- Edit `src/http/server/idempotency-response.ts:1-63`.
- Remove the Koa import and retain `VOLATILE_HEADERS` unchanged.
- Change `StoredAnswer` to this exact shape:

  ```ts
  export type StoredAnswer = Readonly<{
    status: number;
    body: string | Uint8Array | null;
    headers: readonly (readonly [string, string])[];
  }>;
  ```

- Change `headerSnapshot` to accept a `Headers` accumulator and return lower-case names and joined values.
- Change `captureAnswer` to accept the accumulator, prior snapshot, status, and exact stored body type.
- Capture only new or changed non-volatile headers. Store one joined string per lower-case name.
- Sort tuples with `compareBytewise`.
- Delete `applyAnswer`; Story 13 writes `replay` and Story 4 applies it.

### Byte accounting

- Edit `answerBytes` at `src/http/server/idempotency-store.ts:53-64`.
- Count a string with `Buffer.byteLength(body, "utf8")`, a `Uint8Array` with `body.byteLength`, and `null` as zero.
- Add `Buffer.byteLength(JSON.stringify(answer.headers), "utf8")` for all variants.
- Remove arbitrary body serialization and its catch block.

### Tests

- Rewrite key-source fixtures in `src/http/server/idempotency-key.test.ts:16-177` to use Fetch `Headers`.
- Change the comma case from accepted to the exact duplicate-header refusal. Preserve every other grammar row.
- Keep fingerprint and record-key tests unchanged, including whitespace and non-ASCII byte-length cases.
- Rewrite `src/http/server/idempotency-response.test.ts:1-203` around a Fetch `Headers` accumulator.
- Preserve unchanged-header exclusion, changed-header capture, merged `Vary`, volatile removal, and bytewise tuple order.
- Assert that duplicate values store one joined string and that status, exact body, and content type survive capture.
- Delete replay-application tests because `applyAnswer` no longer exists.
- Edit `makeAnswer` at `src/http/server/idempotency-store.test.ts:30-32` to store `JSON.stringify({ tag })` and `headers: []`.
- Replace the cyclic-body test at `src/http/server/idempotency-store.test.ts:290-304` with a table that measures settlement deltas on fresh stores.
- Assert `body: "é", headers: []` adds 4 bytes, `body: Uint8Array.from([0x00, 0x80, 0xff]), headers: []` adds 5 bytes, and `body: null, headers: []` adds 2 bytes.
- Update the exact-size test at `src/http/server/idempotency-store.test.ts:346-361` to compute the string-body length plus serialized tuples.
- Update `the byte bound evicts a completed record too` at `src/http/server/idempotency-store.test.ts:474-497` to use the same string-body formula.
- Change the direct oversized answers at `src/http/server/idempotency-store.test.ts:514-549` to `"x".repeat(4096)` and `"x".repeat(2048)`.
- Keep reservation, joining, TTL, eviction, saturation, and settlement-order tests unchanged.

## Constraints

- Keep `VOLATILE_HEADERS` and bytewise header ordering unchanged.
- A Fetch `Headers` value cannot preserve duplicate physical header count. A comma therefore means duplicate for this API.
- Keep a single key containing an interior space valid.
- Do not change `OutcomeState`, reservation order, TTL, capacity, or waiter behavior.

## Verify

- Run:

  ```bash
  node --test \
    src/http/server/idempotency-key.test.ts \
    src/http/server/idempotency-record.test.ts \
    src/http/server/idempotency-response.test.ts \
    src/http/server/idempotency-store.test.ts
  ```

- Duplicate keys use the current exact message. Body-accounting deltas equal 4, 5, and 2 bytes.
- `npm run verify` exits 0 after the coupled batch lands.
- Proof: delivers the four idempotency helper test lines.
- Proof: delivers the duplicate-key and exact stored-body coverage bullets.
