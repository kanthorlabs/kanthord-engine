# Story 4 — The composition lint

Epic: `.agents/plan/epics/048-the-worker-registry-and-routing.md`
Depends on: Story 2

## Change

- Edit `eslint.config.js`. For one rule name, the last matching flat-config block wins. The composition restriction and the node/edge write restriction both use `no-restricted-syntax` and carry different exemption lists. Therefore replace the single node/edge write block with three blocks, so each file matches exactly one block:

  ```js
  const compositionMessage =
    "read .metadata.composition only in the worker registry and the worker list query";

  const compositionExemptions = [
    "src/domain/worker-registry.ts",
    "src/domain/worker-registry.test.ts",
    "src/queries/worker/list-workers.ts",
  ];

  const nodeEdgeWriteSelectors = [
    {
      selector: `Literal[value=/${nodeEdgeWritePattern}/i]`,
      message: nodeEdgeWriteMessage,
    },
    {
      selector: `TemplateElement[value.raw=/${nodeEdgeWritePattern}/i]`,
      message: nodeEdgeWriteMessage,
    },
  ];

  const compositionSelectors = [
    {
      selector: 'MemberExpression > Identifier.property[name="composition"]',
      message: compositionMessage,
    },
    {
      selector:
        'MemberExpression[computed=true] > Literal.property[value="composition"]',
      message: compositionMessage,
    },
  ];
  ```

  ```js
  {
    files: ["src/**/*.ts"],
    ignores: [...nodeEdgeWriteExemptions, ...compositionExemptions],
    rules: {
      "no-restricted-syntax": ["error", ...nodeEdgeWriteSelectors, ...compositionSelectors],
    },
  },
  {
    files: nodeEdgeWriteExemptions,
    rules: { "no-restricted-syntax": ["error", ...compositionSelectors] },
  },
  {
    files: compositionExemptions,
    rules: { "no-restricted-syntax": ["error", ...nodeEdgeWriteSelectors] },
  },
  ```

  The two exemption lists are disjoint, so the second and third blocks never match the same file and their order does not matter.

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
  7. Add a fourth assertion: call `linter.verify()` on a node write source and assert the messages array is empty — confirming the composition rule does NOT carry the node/edge write selectors. The verified source must be valid JavaScript, because ESLint reports a fatal parse error for anything else. Use `const q = "INSERT INTO node VALUES (1);";`. Build that source by concatenating two string parts, so the test file itself does not trip the node/edge write restriction:
     ```ts
     const nodeWriteSource = 'const q = "INSERT INTO ' + 'node VALUES (1);";';
     ```

  Note: `RuleTester` requires a rule implementation object, not a rule configuration value. Use `Linter.verify()` to test rule behavior from a flat-config rule setting.

## Constraints

- The `ignores` array uses the exact three paths listed above. A path not in this list must not be added; a path in this list must not be removed.
- No fixture `.ts` file carrying `metadata.composition` is committed under `src/` — `pnpm run lint` must exit 0 after this story.
- The node/edge write enforcement stays intact for every file outside `nodeEdgeWriteExemptions`. Prove it: lint a source that holds a node write in a non-exempt `src/` file and confirm one `no-restricted-syntax` error.

## Verify

- `pnpm run lint` exits 0.
- `node --test src/domain/worker-registry-lint.test.ts` passes: the two forbidden selectors each produce one error on their respective source strings, the non-matching source produces no error, and the node write source produces no error from the composition rule.
- Proof: `PASS EPIC-048` line `src/domain/worker-registry-lint.test.ts`
