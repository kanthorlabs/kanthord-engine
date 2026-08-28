# Story 3 — Plan store passes the extended set through

Epic: `.agents/plan/epics/041-harness-qualified-worker-kinds.md`
Depends on: Story 1

## Change

No production file changes. `src/services/plan/sqlite.ts:251` already spreads
`[...workerKinds]`; after Story 1 that spread produces all seven kinds.

`workerKinds` is already imported in `src/services/plan/sqlite.test.ts:20`.

Add one new test to `src/services/plan/sqlite.test.ts` inside the
`describe("src/services/plan/sqlite.test")` block, after the existing
`readValidationContext` test at line 1977.

### New test — explicit seven-element assertion

The existing test at lines 1940–1977 asserts `workerKinds: [...workerKinds]` on the
right side, which is a spread of the production constant rather than an explicit
literal. Add a new test that names every element explicitly:

```ts
it("readValidationContext.workerKinds deep-equals the seven-element fixed-order array", (t) => {
  const { storage, store, dispose } = build();
  t.after(() => dispose());
  storage.transact(seedAll);

  const context = storage.transact((transaction) =>
    store.readValidationContext(transaction, fixtureIds.project),
  );

  assert.deepEqual(context.workerKinds, [
    "general@1",
    "tdd@1",
    "git@1",
    "claude.swe@1",
    "claude.te@1",
    "opencode.swe@1",
    "opencode.te@1",
  ]);
});
```

## Constraints

- Do not edit `src/services/plan/sqlite.ts`.
- Use `build()`, `seedAll`, and `fixtureIds` exactly as the surrounding tests do.
- The assertion names every element; no spread of the production constant on the
  right side.

## Verify

```bash
node --test src/services/plan/sqlite.test.ts
```

The new test fails if Story 1 has not run (the constant still has three elements),
making the dependency visible.

Proof: delivers `src/services/plan/sqlite.test.ts` line of `PASS EPIC-041`.
