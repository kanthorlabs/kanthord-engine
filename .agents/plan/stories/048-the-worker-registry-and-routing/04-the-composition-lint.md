# Story 4 — The composition lint

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 2

## Change

- Edit `eslint.config.js`. Add one new object block at the end of the exported array, after the existing `no-restricted-syntax` block at lines 421–436:

  ```js
  {
    files: ["src/**/*.ts"],
    ignores: [
      "src/domain/worker-registry.ts",
      "src/domain/worker-registry.test.ts",
      "src/queries/worker/list-workers.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression > Identifier.property[name=\"composition\"]",
          message: "Read .metadata.composition only in the three permitted files.",
        },
        {
          selector: "MemberExpression[computed=true] > Literal.property[value=\"composition\"]",
          message: "Read [\"composition\"] only in the three permitted files.",
        },
      ],
    },
  },
  ```

- Add `src/domain/worker-registry-lint.test.ts`. This file uses `eslint`'s `Linter` to assert the rule in memory; it writes no fixture file into the linted tree.

  The test must:
  1. Import `Linter` from `eslint`.
  2. Construct one `Linter` instance with `{ configType: "flat" }`.
  3. Define the rule configuration inline (identical to the block added to `eslint.config.js` above):
     ```js
     const compositionRuleConfig = [
       {
         files: ["*.ts"],
         ignores: [],
         rules: {
           "no-restricted-syntax": [
             "error",
             {
               selector:
                 'MemberExpression > Identifier.property[name="composition"]',
               message: "...",
             },
             {
               selector:
                 'MemberExpression[computed=true] > Literal.property[value="composition"]',
               message: "...",
             },
           ],
         },
       },
     ];
     ```
  4. Call `linter.verify("const x = entry.metadata.composition;", compositionRuleConfig, { filename: "test.ts" })` and assert the returned messages array contains exactly one message whose `ruleId` is `"no-restricted-syntax"`.
  5. Call `linter.verify("const x = entry.metadata[\"composition\"];", compositionRuleConfig, { filename: "test.ts" })` and assert exactly one `"no-restricted-syntax"` message.
  6. Call `linter.verify("const x = entry.metadata.driver;", compositionRuleConfig, { filename: "test.ts" })` and assert the messages array is empty.
  7. Add a fourth assertion: call `linter.verify("INSERT INTO node VALUES (1);", compositionRuleConfig, { filename: "test.ts" })` and assert the messages array is empty — confirming the composition rule does NOT carry the node/edge write selectors. This is the regression proof that the two `no-restricted-syntax` blocks remain independent and the old enforcement is preserved (it applies via a separate block in `eslint.config.js` with its own `ignores`).

  Note: `RuleTester` requires a rule implementation object, not a rule configuration value. Use `Linter.verify()` to test rule behavior from a flat-config rule setting.

## Constraints

- The `ignores` array uses the exact three paths listed above. A path not in this list must not be added; a path in this list must not be removed.
- No fixture `.ts` file carrying `metadata.composition` is committed under `src/` — `pnpm run lint` must exit 0 after this story.
- The existing `no-restricted-syntax` block (lines 421–436) is not modified. ESLint flat config applies ALL matching blocks, but for a given rule name the last matching block wins. Adding the new block after line 436 means files not in `compositionExemptions` get only the new block's selectors for `no-restricted-syntax`. The node/edge write enforcement at lines 421–436 is preserved only for files that appear in `nodeEdgeWriteExemptions` (the ignores list of the existing block) — because for those files only the first block applies. Confirm this by running `pnpm run lint` after the change and verifying no pre-existing lint error disappears.

## Verify

- `pnpm run lint` exits 0.
- `node --test src/domain/worker-registry-lint.test.ts` passes: the two forbidden selectors each produce one error on their respective source strings, the non-matching source produces no error, and the `INSERT INTO node` source produces no error from the composition rule.
- Proof: `PASS EPIC-048` line `src/domain/worker-registry-lint.test.ts`
