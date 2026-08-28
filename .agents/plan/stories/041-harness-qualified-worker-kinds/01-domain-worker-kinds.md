# Story 1 — Extend `workerKinds` and update `worker.test.ts`

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`

## Change

### `src/domain/worker.ts:3`

Replace the current three-element tuple with the seven-element tuple in the fixed order:

```ts
export const workerKinds = [
  "general@1",
  "tdd@1",
  "git@1",
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const;
```

Lines 5 and 7 (`workerKind` and `WorkerKind`) require no change; they derive from `workerKinds`.

### `src/domain/worker.test.ts`

Four edits, all in `describe("src/domain/worker.test")`:

**Edit 1 — line 8.** Update the `workerKinds` deep-equal to name all seven elements:

```ts
assert.deepEqual(workerKinds, [
  "general@1",
  "tdd@1",
  "git@1",
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
]);
```

**Edit 2 — line 11-13.** Update the `workerKind.options` deep-equal to the same seven-element array (identical literal).

**Edit 3 — the accept loop (lines 15-19).** Extend the iterated array with the four new values:

```ts
for (const kind of [
  "general@1",
  "tdd@1",
  "git@1",
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const) {
  it(`workerKind.safeParse accepts "${kind}"`, () => {
    assert.equal(workerKind.safeParse(kind).success, true);
  });
}
```

**Edit 4 — the reject loop (lines 21-32).** Add `"swe@1"`, `"te@1"`, `"claude.swe"` and `"claude.swe@2"` to the iterated array. The full array after the edit:

```ts
[
  "general",
  "general@2",
  "re@1",
  "mr@1",
  "",
  "GENERAL@1",
  "swe@1",
  "te@1",
  "claude.swe",
  "claude.swe@2",
];
```

Each value produces one test asserting `workerKind.safeParse(value).success === false`.

## Constraints

- Do not change lines 5 or 7 of `worker.ts`.
- The array order in the tuple is fixed: existing three kinds first, then the four in the order above.
- The `workerKind.safeParse(v).success` pattern must be used (not `throws`).

## Verify

```bash
node --test src/domain/worker.test.ts
```

All tests pass. The test output includes:

- `workerKinds deep-equals the expected array` — the seven-element literal.
- `workerKind.options deep-equals the expected array` — same seven-element literal.
- Seven accept cases, one per value in fixed order.
- Ten reject cases: the original six plus `swe@1`, `te@1`, `claude.swe`, `claude.swe@2`.

Proof: delivers `src/domain/worker.test.ts` line of `PASS EPIC-041`.
