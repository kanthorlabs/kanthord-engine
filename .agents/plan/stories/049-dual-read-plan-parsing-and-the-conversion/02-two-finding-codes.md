# Story 2 — Two finding codes

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`

## Change

**`src/domain/plan-finding.ts` — `findingCodes` (lines 6-31)**

Insert two new string literals into the `as const` array. The array must stay in bytewise (lexicographic) order. Current count: 24. New count: 26.

Insert `"pair-illegal"` between `"objective-without-task"` (line 20 in the array) and `"parent-missing"` (line 21). Bytewise: `"pai" < "par"`.

Insert `"verify-invalid"` between `"repository-unknown"` (line 29) and `"worker-unknown"` (line 30). Bytewise: `"v" < "w"`.

The resulting 26-element array in order:

```
"acceptance-heading-duplicated"
"acceptance-heading-not-at-line-start"
"acceptance-missing"
"acceptance-unexpected"
"dependency-cross-parent"
"dependency-cycle"
"dependency-self"
"document-unparsable"
"frontmatter-invalid"
"identity-duplicate"
"identity-invalid"
"identity-kind-mismatch"
"initiative-without-objective"
"objective-without-task"
"pair-illegal"
"parent-missing"
"path-duplicate"
"path-invalid"
"reference-ambiguous"
"reference-unresolved"
"repo-missing"
"repo-on-task"
"repository-unbound"
"repository-unknown"
"verify-invalid"
"worker-unknown"
```

**`src/domain/plan-finding.ts` — `findingScope` (lines 42-67)**

Add two entries to the `Record<FindingCode, ValidationScope>` object:

- `"pair-illegal": "structural"`
- `"verify-invalid": "structural"`

Insert them in the same bytewise order as `findingCodes`. `"pair-illegal"` goes between `"objective-without-task"` and `"parent-missing"`. `"verify-invalid"` goes between `"repository-unknown"` and `"worker-unknown"`.

**`src/domain/verify-block.ts` — add `decodeVerifyBlock`**

This file is created by EPIC 047 Story 3. This story extends it. Add before `parseVerifyBlock`:

```ts
export function decodeVerifyBlock(
  text: string,
): { ok: true; block: VerifyBlock } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const result = verifyBlock.safeParse(parsed);
  if (!result.success) return { ok: false };
  return { ok: true, block: result.data };
}
```

Express `parseVerifyBlock` over `decodeVerifyBlock`:

```ts
export function parseVerifyBlock(text: string): VerifyBlock {
  const result = decodeVerifyBlock(text);
  if (!result.ok) throw new VerifyBlockError(text);
  return result.block;
}
```

`parseVerifyBlock` throws `VerifyBlockError` when `decodeVerifyBlock` returns `{ ok: false }`. The candidate guard (`validateCandidate` in `plan-candidate.ts`) and the query reader share one parse path through `decodeVerifyBlock` and cannot drift.

Dependency: EPIC 047 Story 3 creates `src/domain/verify-block.ts`. Implement this change after that story.

## Constraints

- `findingCodes` must remain `as const` and sorted bytewise. A mis-sorted array will fail the existing sort assertion in the test.
- Both new codes carry scope `"structural"`, not `"completeness"`.
- `findingScope` must remain total over `findingCodes`. The existing test asserts count equality in both directions.
- `decodeVerifyBlock` is non-throwing. It returns `{ ok: false }` for any JSON parse failure or schema validation failure.
- `parseVerifyBlock` is expressed entirely over `decodeVerifyBlock` — it contains no independent parse or validate logic.

## Verify

```
node --test src/domain/plan-finding.test.ts
```

Update `src/domain/plan-finding.test.ts`:

1. Replace the `expectedCodes` constant (lines 12-37) with a 26-element array that includes `"pair-illegal"` and `"verify-invalid"` in their correct positions.
2. Update the `"findingCodes pins the twenty-four codes in bytewise order"` assertion: change the count from `24` to `26` and update the name to reflect 26.
3. The `"findingScope is total over findingCodes"` assertion already checks count equality; its numeric literal `24` must change to `26`.
4. The `"the completeness scope holds exactly the two completeness codes"` assertion is unchanged — both new codes are structural, not completeness.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/domain/plan-finding.test.ts` in `PASS EPIC-049`.
