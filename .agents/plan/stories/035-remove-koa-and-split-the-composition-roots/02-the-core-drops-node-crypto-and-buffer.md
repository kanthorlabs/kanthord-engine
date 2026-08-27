# Story 2 — The core drops `node:crypto` and the global `Buffer`

Epic: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`
Depends on: EPIC 031 story 1, which creates `src/http/server/bytewise.ts` with `compareBytewise` and a module-level `TextEncoder`. EPIC 032 story 12 and story 13, which reshape `readIdempotencyKey` and the `fingerprint` call site.

## Change

### 1. `byteLength` joins the bytewise helper

- In `src/http/server/bytewise.ts`, add `export function byteLength(value: string): number`. It returns `encoder.encode(value).byteLength` over the module-level `TextEncoder` that EPIC 031 declared in that file. Declare no second `TextEncoder`.
- Add no second helper file. `src/http/server/bytewise.ts` is the only home for both functions.

### 2. `idempotency-key.ts` becomes Web-native

In `src/http/server/idempotency-key.ts`:

- Delete `import { createHash } from "node:crypto";` at `:1`. The file has no `node:buffer` import to delete.
- Extend the existing `./bytewise.ts` import with `byteLength`. EPIC 031 story 1 already added `import { compareBytewise } from "./bytewise.ts";` to this file. Add no second import statement, and do not re-import `compareBytewise`.
- At `:55`, replace `Buffer.byteLength(part, "utf8")` with `byteLength(part)`.
- At `:57`, replace `createHash("sha256").update(Buffer.from(joined, "utf8")).digest("hex")` with a `crypto.subtle.digest("SHA-256", …)` over the UTF-8 bytes of `joined`, hex-encoded lower-case, two hex digits per byte, no separator. Encode `joined` with a `TextEncoder` declared in this file.
- Change the signature at `:52` to `export async function fingerprint(input: FingerprintInput): Promise<string>`.
- Do **not** touch the `recordKey` comparator at `:69`. EPIC 031 story 1 already replaced it with `compareBytewise(a, b)`. A second replacement is a defect.
- `:55` and `:57` hold the last two `Buffer` reads EPIC 031 leaves in the file. After the edit the text `Buffer` appears nowhere in it.
- Change no other behaviour: the join separator stays the single code point `U+0001`, the `length:value` prefix stays, the digest stays SHA-256, the encoding stays lower-case hex, and `recordKey` returns the same string for the same input.

### 3. The one call site awaits

- In `src/http/server/idempotency.ts`, change `const print = fingerprint({ … });` at `:85` to `const print = await fingerprint({ … });`. The enclosing middleware is already `async`, so no signature changes.

### 4. `idempotency-store.ts` measures with `byteLength`

In `src/http/server/idempotency-store.ts`:

- Add `import { byteLength } from "./bytewise.ts";`.
- Replace `Buffer.byteLength(<expression>, "utf8")` with `byteLength(<expression>)` at all six sites: `:61`, `:62`, `:98`, `:99`, `:112` and `:113`.
- After the edit the text `Buffer` appears nowhere in the file. The measured numbers are identical, so every size-budget assertion keeps its value.

## Constraints

- No behaviour change. The fingerprint hex, the record key, the byte counts and every emitted answer are identical.
- Touch neither `dispatch.ts`, `query.ts`, `single.ts`, `invalid-request.ts` nor `idempotency-response.ts`. EPIC 031 owns those five.
- Touch `src/http/server/blob/show-blob.ts` not at all. EPIC 031 story 2 converts it to `Uint8Array`.
- Add no `node:` import anywhere under `src/http/server/` outside `runtime/`.
- Do not edit `eslint.config.js` or `package.json`.

## Verify

- `node --test src/http/server/bytewise.test.ts` — add four cases to the existing file:
  - `byteLength("")` equals `0`.
  - `byteLength("abc")` equals `3`.
  - `byteLength("é")` equals `2` and `byteLength("€")` equals `3`.
  - `byteLength("\u{1D11E}")` equals `4`.
- `node --test src/http/server/idempotency-key.test.ts` — every existing case passes with `await fingerprint(...)`. Add two cases:
  - the fingerprint is pinned. For the input `{ method: "POST", path: "/v1/project", query: "", rawBody: '{"name":"alpha"}' }`, `await fingerprint(input)` equals the exact string `66b93b3eabfa98df5795caabe974cdea65919a17be5586c784d59570c2e435e3`. That is the value the `node:crypto` implementation produces for the same input, so an idempotency record written before this story still matches.
  - `recordKey` sorts parameter names bytewise. Pass a `parameters` object whose insertion order differs from its bytewise order and whose names hold a non-ASCII code point, and assert the exact returned string. This case is a regression guard over EPIC 031's edit; add it only if EPIC 031 left none.
- `node --test src/http/server/idempotency.test.ts src/http/server/idempotency-record.test.ts src/http/server/idempotency-response.test.ts src/http/server/idempotency-store.test.ts` — all pass unchanged. Every size-budget and saturation assertion keeps its current expected number.
- `node --test src/http/server/dispatch.test.ts src/http/server/query.test.ts src/http/server/single.test.ts src/http/server/invalid-request.test.ts` — all pass unchanged, and no expectation in them is edited by this story.
- `npm run verify` exits 0. `npm run typecheck` proves no caller of `fingerprint` treats the value as a plain string.
- Proof: the `src/http/server/bytewise.test.ts`, `src/http/server/idempotency-key.test.ts`, `src/http/server/idempotency.test.ts`, `src/http/server/idempotency-record.test.ts`, `src/http/server/idempotency-response.test.ts`, `src/http/server/idempotency-store.test.ts`, `src/http/server/dispatch.test.ts`, `src/http/server/query.test.ts`, `src/http/server/single.test.ts` and `src/http/server/invalid-request.test.ts` lines of the EPIC Proof.
