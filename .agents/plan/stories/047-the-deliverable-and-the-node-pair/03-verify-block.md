# Story 03 — The verify block

Epic: `.agents/plan/epics/047-the-deliverable-and-the-node-pair.md`

## Change

Create `src/domain/verify-block.ts`. Export:

```ts
export const verifyBlock = z.strictObject({
  paths: z.array(z.string()),
  commands: z.array(z.string()),
});

export type VerifyBlock = z.infer<typeof verifyBlock>;

export class VerifyBlockError extends Error {
  readonly code: "verify-json-malformed";
  constructor(message: string) {
    super(message);
    this.name = "VerifyBlockError";
    this.code = "verify-json-malformed";
  }
}

export function renderVerifyBlock(block: VerifyBlock): string;

export function parseVerifyBlock(text: string): VerifyBlock;
```

### `verifyBlock` schema

`z.strictObject` — a third key causes a parse failure rather than silent strip.

`paths` accepts absolute paths only. It is validated element-by-element with a `.superRefine` or `.refine` that refuses relative paths and structurally invalid values:

- An empty string.
- An element that holds a NUL byte (`\0`).
- An element that holds an unpaired surrogate.
- An element that holds a backslash (`\`).
- An element with an empty segment, other than the leading empty segment an absolute path produces (split on `/`; for a path starting with `/`, skip index 0).
- An element that contains a `.` or `..` segment (split on `/`, check each segment).
- An element that ends with `/` (trailing slash).

Do not reuse `parseSubmittedPath` from `src/domain/plan-path.ts`. That grammar requires a `plan/` prefix and a `.md` suffix, and it refuses an absolute path. A verify path names source, not a plan document.

When any element fails, the Zod issue path must be `["paths", index]` so the caller can name the position.

`commands` has no element-level validation. A duplicate command is legal.

### `renderVerifyBlock`

Produces a canonical JSON string with key order `paths` then `commands` and no extra whitespace. Steps:

1. Sort `block.paths` with `comparePaths` from `src/domain/plan-path.ts:106`. Refuse a duplicate path by throwing `VerifyBlockError("duplicate path: <path>")`.
2. Produce `JSON.stringify({ paths: sorted, commands: block.commands })`.

The empty block renders as `{"paths":[],"commands":[]}` byte-exact — no spaces, no trailing newline.

### `parseVerifyBlock`

1. Call `JSON.parse(text)`. If it throws, throw `VerifyBlockError("not valid JSON: ...")` with `code: "verify-json-malformed"`.
2. Call `verifyBlock.safeParse(parsed)`. If `.success` is false, throw `VerifyBlockError("malformed verify block: ...")` with `code: "verify-json-malformed"`.
3. Return `.data`.

Imports: `zod` for the schema, `comparePaths` from `src/domain/plan-path.ts`. No other production dependency.

## Constraints

- `verifyBlock` uses `z.strictObject` — a caller cannot pass `z.looseObject` behavior.
- `parseVerifyBlock` never returns `null` on invalid input. It throws `VerifyBlockError`.
- `renderVerifyBlock` preserves `commands` order verbatim.
- `paths` sorting is always performed inside `renderVerifyBlock`, never by the caller.

## Tasks

### Task 03 — Cover the verify block

**Input:** `src/domain/verify-block.test.ts`, `src/domain/verify-block.ts`

**Action — RED:** Create `src/domain/verify-block.test.ts`. Write every assertion named
under `## Verify` — items 1 to 7, 7b to 7g, and 8 to 12. Import `verifyBlock`,
`VerifyBlockError`, `renderVerifyBlock` and `parseVerifyBlock` from `./verify-block.ts`.

Assert every thrown error through its `code` property. Never assert a message string.

The test file is the required Proof target. The Proof command names
`src/domain/verify-block.test.ts`, so no other lane can supply it.

Two first-run results are valid, as in Task 01. State which one happened. Do not raise
`ATTEMPT-FAILED:` for a first-run pass.

**Action — GREEN:** Create `src/domain/verify-block.ts` exactly as `## Change` names it.
When the file already satisfies every assertion, record a no-op turn.

**Action — REFACTOR:** None.

## Verify

```bash
node --test src/domain/verify-block.test.ts
```

Create `src/domain/verify-block.test.ts` with:

1. `renderVerifyBlock({ paths: [], commands: [] })` equals `'{"paths":[],"commands":[]}'` by `assert.strictEqual`.
2. `renderVerifyBlock({ paths: ["b/f.ts", "a/f.ts"], commands: [] })` equals `'{"paths":["a/f.ts","b/f.ts"],"commands":[]}'` — `paths` emits bytewise sorted.
3. Non-ASCII path sorting: `renderVerifyBlock` with `paths: ["ñ/f.ts", "a/f.ts"]` places `"a/f.ts"` first and `"ñ/f.ts"` second. Assert by constructing the expected sorted array via `[...paths].sort((l, r) => Buffer.compare(Buffer.from(l, "utf8"), Buffer.from(r, "utf8")))` and comparing the `paths` field of the parsed output — `comparePaths` and Buffer bytewise agree for valid UTF-8.
4. `renderVerifyBlock({ paths: ["a", "a"], commands: [] })` throws `VerifyBlockError` with `code: "verify-json-malformed"` — assert by error `code` property.

   `assert.throws(() => renderVerifyBlock({ paths: ["a", "a"], commands: [] }), (e) => e instanceof VerifyBlockError && e.code === "verify-json-malformed")`.

5. `commands` order preserved: `renderVerifyBlock({ paths: [], commands: ["b", "a", "b"] })` parsed back gives `commands: ["b", "a", "b"]` with both entries and in that order.
6. `verifyBlock.safeParse({ paths: [], commands: [], extra: 1 }).success` is `false` — third key refused, not stripped.
7. `verifyBlock.safeParse({ paths: ["/abs/src/foo.ts"], commands: [] })` returns `success: true` — an absolute path is accepted. Assert `result.success === true` and `result.data.paths` deep-equals `["/abs/src/foo.ts"]`.

7b. `verifyBlock.safeParse({ paths: ["src/foo.ts"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — a relative path is refused.

7c. `verifyBlock.safeParse({ paths: [""], commands: [] })` returns `success: false` AND the first issue's path is `["paths", 0]` — an empty string is refused. Assert both `.success === false` and `result.error.issues[0].path` deep-equals `["paths", 0]`.

7d. `verifyBlock.safeParse({ paths: ["a\u0000b"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — a NUL byte is refused.

7e. `verifyBlock.safeParse({ paths: ["a\\b"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — a backslash is refused.

7f. `verifyBlock.safeParse({ paths: ["a//b"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — an empty segment is refused.

7g. `verifyBlock.safeParse({ paths: ["a/./b"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — a `.` segment is refused. 8. `verifyBlock.safeParse({ paths: ["a/../b"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — `..` segment refused at the correct path. 9. `verifyBlock.safeParse({ paths: ["a/"], commands: [] })` returns `success: false` with issue path `["paths", 0]` — trailing slash refused at the correct path. 10. `parseVerifyBlock("{")` throws `VerifyBlockError` with `code === "verify-json-malformed"`. 11. `parseVerifyBlock("[]")` throws `VerifyBlockError` with `code === "verify-json-malformed"` (not an object). 12. `parseVerifyBlock('{"paths":[]}')` throws `VerifyBlockError` with `code === "verify-json-malformed"` — missing `commands` key.

All assertions on thrown errors check the `code` property, not the message string.

Test framework: `node:test` and `node:assert/strict`. No SQLite, no I/O.

Proof: PASS EPIC-047 line for `src/domain/verify-block.test.ts`; hermetic coverage — empty block byte-exact, non-ASCII sort asserted via Buffer.compare, duplicate path refused, commands order preserved, third key refused, absolute paths accepted, relative paths refused, empty/NUL/backslash/empty-segment/dot/dot-dot/trailing-slash paths refused, parseVerifyBlock refuses invalid JSON and missing key by error code.
