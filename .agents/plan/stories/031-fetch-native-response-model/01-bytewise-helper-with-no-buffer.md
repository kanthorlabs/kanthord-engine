# Story 1 - A bytewise helper with no Buffer

Epic: `.agents/plan/epics/031-fetch-native-response-model.md`
Depends on: EPIC 030.

## Change

- Add `src/http/server/bytewise.ts` with one module-level `TextEncoder` and this export:

  ```ts
  export function compareBytewise(left: string, right: string): number;
  ```

- In `compareBytewise`, encode each input once. Compare corresponding bytes from index zero.
- Return `leftByte - rightByte` at the first difference. Return the encoded length difference when one input is a prefix.
- Edit `src/http/server/dispatch.ts:1,42-46,51-63` inside `dispatchMiddleware` and `readHeaders`.
- Remove the `node:buffer` import. Import `compareBytewise` from `./bytewise.ts`.
- Replace both `Buffer.compare(Buffer.from(...), Buffer.from(...))` callbacks with `compareBytewise`.
- Preserve result-header order and request-header normalization behavior.
- Edit `src/http/server/query.ts:1,3-19` inside `readQuery`.
- Remove the `node:buffer` import. Import `compareBytewise` from `./bytewise.ts`.
- Replace the key comparator with `compareBytewise` without changing repeated-value order.
- Edit `src/http/server/single.ts:1-3,5-21` inside `singleValued`.
- Remove the `node:buffer` import. Import `compareBytewise` from `./bytewise.ts`.
- Replace the key comparator with `compareBytewise`. Keep the bytewise-first repeated-key refusal.
- Edit `src/http/server/invalid-request.ts:1-5,37-53` inside `order`.
- Remove the `node:buffer` import. Import `compareBytewise` from `./bytewise.ts`.
- Compare `path`, then `code`, then `message` with `compareBytewise`.
- Edit `src/http/server/idempotency-response.ts:31-51` inside `captureAnswer`.
- Import `compareBytewise` from `./bytewise.ts` and replace the global `Buffer.compare` callback.
- Preserve lower-casing, volatile-header removal, and pair order.
- Edit `src/http/server/idempotency-key.ts:67-80` inside `recordKey`.
- Import `compareBytewise` from `./bytewise.ts` and replace the global `Buffer.compare` callback.
- Keep `Buffer.byteLength` and the hash input conversion at `src/http/server/idempotency-key.ts:55-57` unchanged.
- Add `src/http/server/bytewise.test.ts` beside the helper with suite name `src/http/server/bytewise.test`.
- Define fixtures with ASCII escapes: `a`, `aa`, `\u00e9`, `\uE000`, and `\u{1F600}`.
- Sort the reverse fixture order with `compareBytewise` and assert this exact order:

  ```ts
  ["a", "aa", "\u00e9", "\uE000", "\u{1F600}"];
  ```

- For every ordered fixture pair, assert `Math.sign(compareBytewise(left, right))` equals the `Buffer.compare` sign.
- Assert JavaScript orders `\u{1F600}` before `\uE000`, while both byte comparators order `\uE000` first.
- In `src/http/server/bytewise.test.ts`, add `productionTypeScriptFiles(root: string): readonly string[]`.
- Recursively walk `src/http/server`, exclude `*.test.ts`, and return repository-relative paths in bytewise order.
- Set `root` to `new URL("../../../", import.meta.url).pathname` and scan `${root}src/http/server`.
- Read each production file and assert the exact `Buffer.compare` offender list equals `[]`.
- Edit `src/http/server/query.test.ts:18-21` in `orders keys bytewise regardless of wire order`.
- Add keys `\uE000` and `\u{1F600}` in reverse byte order through `encodeURIComponent`.
- Assert `Object.keys(readQuery(...))` equals `["\uE000", "\u{1F600}"]`.
- Edit `src/http/server/single.test.ts:43-48` in `orders keys bytewise in the result`.
- Supply computed keys `\u{1F600}` before `\uE000`.
- Assert the result key list equals `["\uE000", "\u{1F600}"]`.
- Keep the ASCII assertions in both tests as regression cases.

## Constraints

- Change only the helper, the six named consumers, and the three named test files.
- Keep all nine comparison sites on one shared helper.
- Do not edit `src/http/contract/openapi.ts:216-218`; it is outside the server runtime.
- Do not remove any `Buffer.byteLength` or hash conversion call.
- Do not add `node:buffer` to production code.
- Test imports of `node:buffer` are allowed only for the current-order oracle.
- Story 1 leaves `src/http/server/blob/show-blob.ts:1` unchanged. Story 2 removes that final production import.

## Verify

- Run:

  ```bash
  node --test \
    src/http/server/bytewise.test.ts \
    src/http/server/dispatch.test.ts \
    src/http/server/idempotency-key.test.ts \
    src/http/server/idempotency-response.test.ts \
    src/http/server/invalid-request.test.ts \
    src/http/server/query.test.ts \
    src/http/server/single.test.ts
  ```

- The exact non-ASCII order, all pair signs, and both consumer key orders pass.
- The source scan reports no production `Buffer.compare` call under `src/http/server/**`.
- `npm run verify` exits 0.
- Proof: delivers the `src/http/server/bytewise.test.ts`, `query.test.ts`, and `single.test.ts` lines.
- Proof: delivers the no-`Buffer.compare` and comparator-agreement coverage bullets.
