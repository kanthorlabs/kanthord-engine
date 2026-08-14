# Story 6 — The eslint rule

Epic: `.agent/plan/epics/016-readiness-applied.md`
Depends on: Story 7 and Story 8. Both remove a raw node or edge write from a production file. Run this story after them, or `npm run lint` fails on `src/commands/startup/recover-expired-leases.ts:147`.

## Change

### `eslint.config.js`

`eslint.config.js` holds **no** `no-restricted-syntax` block today. Add exactly one, as a new object appended after the block at `eslint.config.js:326-342` and before the test block at `:343`.

Declare the pattern once, above the exported array, beside `const gitLibraries` at `eslint.config.js:7`:

```js
const nodeEdgeWritePattern = String.raw`\b(insert\s+into|update|delete\s+from)\s+[\x22\x27\x60\x5b]?(node|edge)\b`;
const nodeEdgeWriteMessage =
  "a node or edge write belongs in src/services/plan/sqlite.ts";
```

The character class `[\x22\x27\x60\x5b]` is the double quote, the single quote, the backtick and the opening bracket. Write it as hex escapes; a literal backtick inside an esquery attribute regex inside a JS template literal is unreadable and easy to break.

Declare the exemption as an **enumerated list**, beside the pattern, not as a `src/**/*.test.ts` glob:

```js
// The only files that may hold a node or edge write. src/services/plan/sqlite.ts
// is the mutation boundary. The rest are pre-existing test fixtures that seed
// rows with raw SQL; a NEW file belongs on neither list — seed through
// test/helpers/rows.ts instead.
const nodeEdgeWriteExemptions = [
  "src/services/plan/sqlite.ts",
  "src/commands/plan/import-plan.test.ts",
  "src/commands/provider/remove-provider.test.ts",
  "src/commands/startup/recover-expired-leases.test.ts",
  "src/http/server/plan/import-plan.test.ts",
  "src/queries/edge/list-edge.test.ts",
  "src/queries/node/list-node.test.ts",
  "src/queries/node/show-node.test.ts",
  "src/queries/plan/export-plan.test.ts",
  "src/queries/plan/validate-plan.test.ts",
  "src/queries/project/read-project-status.test.ts",
  "src/queries/system/read-status.test.ts",
  "src/services/event/atomicity.test.ts",
  "src/services/plan/sqlite.test.ts",
  "src/services/storage/migration-0002-graph-and-plan.test.ts",
];
```

That is exactly fifteen entries: the mutation boundary plus the fourteen test files that hold a matching literal in the current tree. Verify the fourteen with:

```bash
grep -rniE '(insert[[:space:]]+into|update|delete[[:space:]]+from)[[:space:]]+["'"'"'`\[]?(node|edge)\b' src/ --include='*.ts' -l | sort
```

The block:

```js
  {
    files: ["src/**/*.ts"],
    ignores: nodeEdgeWriteExemptions,
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: `Literal[value=/${nodeEdgeWritePattern}/i]`,
          message: nodeEdgeWriteMessage,
        },
        {
          selector: `TemplateElement[value.raw=/${nodeEdgeWritePattern}/i]`,
          message: nodeEdgeWriteMessage,
        },
      ],
    },
  },
```

**An enumerated list, not a `src/**/*.test.ts` glob.** A glob exempts every test file that will ever exist, so the rule would stop being the mechanism for "a node or edge write lives in one place" the moment somebody adds a test. The enumerated list makes each exemption a visible decision: a new test that seeds a `node` or `edge` row with raw SQL fails `npm run lint` and its author reaches for `seedRegistry` and `seedGraph` at `test/helpers/rows.ts:21,79` instead. Those helpers live outside `src/`, so they are outside the rule's `files` and need no exemption.

`no-restricted-syntax` appears in no other block, so the flat-config last-wins note at `eslint.config.js:204-207` and `:384-387` raises no conflict here.

**No story of this epic adds a file to the list.** Story 4 and Story 5 add raw SQL to `src/services/plan/sqlite.test.ts`, which is already on it. Story 11's `src/main.readiness.test.ts` calls `seedRegistry` and holds no SQL literal of its own.

### `AGENTS.md`

Add one row to the "What is enforced, and by what" table, after the row `an unclassified `src/` file` at `AGENTS.md:132`:

```
| a node or edge write outside the plan store       | `no-restricted-syntax`, with an enumerated exemption list          |
```

The row claims exactly what the mechanism enforces. The exemption list is enumerated, so the rule does cover a new test file, and the row needs no "production code" qualifier. The fourteen listed test files are named legacy, not a category.

`ignores` is a flat-config **block** key, not an option of `no-restricted-syntax`. It belongs beside `files` on the block object, exactly as written above, and every other scoped block in `eslint.config.js` uses it the same way (`:202-229`, `:230-247`, `:248-274`).

## Constraints

- Do not add `no-restricted-syntax` to an existing block. Flat config resolves one rule name by last-wins per file, so a second block naming it would silence this one.
- **Do not use a glob in `nodeEdgeWriteExemptions`.** Every entry is one exact path. A `src/**/*.test.ts` entry, or any other pattern, defeats the rule.
- Do not add a sixteenth entry. The list is exactly the fifteen paths above.
- Do not change any `no-restricted-imports` block.
- `src/services/storage/migration-*.ts` production files declare `CREATE TABLE` and match no branch of the pattern. Only the `migration-0002-graph-and-plan.test.ts` file is exempt, and it is already on the list.

## Verify

Add to `src/domain/layout.test.ts`, inside `describe("src/domain/layout.test", ...)`, in the pattern of `src/domain/layout.test.ts:68-77`. Each case calls `lintCase({ filePath, code })` from `test/helpers/lint.ts` and asserts on the returned rule ids.

- `it("a DELETE FROM edge literal in src/commands/plan/import-plan.ts triggers no-restricted-syntax", ...)` — `filePath: "src/commands/plan/import-plan.ts"`, `code: 'const q = "DELETE FROM edge WHERE id = ?";'`; assert `rules.includes("no-restricted-syntax")`.
- `it("the same literal in src/services/plan/sqlite.ts triggers nothing", ...)` — `filePath: "src/services/plan/sqlite.ts"`, same code; assert `!rules.includes("no-restricted-syntax")`.
- `it("a lowercase delete from edge literal triggers no-restricted-syntax", ...)` — `filePath: "src/commands/plan/import-plan.ts"`, `code: 'const q = "delete from edge where id = ?";'`; assert it triggers.
- `it("an UPDATE edge literal triggers no-restricted-syntax", ...)` — `filePath: "src/commands/plan/import-plan.ts"`, `code: 'const q = "UPDATE edge SET waived_at = ?";'`; assert it triggers.
- `it("an UPDATE node template literal triggers no-restricted-syntax", ...)` — `filePath: "src/commands/plan/import-plan.ts"`, ``code: 'const q = `UPDATE node SET state = ${x}`;'``; assert it triggers. This proves the `TemplateElement` selector.
- `it("an INSERT INTO node literal triggers no-restricted-syntax", ...)` — `filePath: "src/commands/startup/recover-expired-leases.ts"`; assert it triggers.
- `it("an UPDATE lease literal triggers nothing", ...)` — `filePath: "src/commands/startup/recover-expired-leases.ts"`, `code: 'const q = "UPDATE lease SET owner = NULL";'`; assert `!rules.includes("no-restricted-syntax")`. The pattern names `node` and `edge` only.
- `it("a SELECT FROM node literal triggers nothing", ...)` — `filePath: "src/queries/node/list-node.ts"`, `code: 'const q = "SELECT id FROM node";'`; assert it does not trigger.
- **`it("a new test file is not exempt from the node and edge write ban", ...)`** — `filePath: "src/queries/node/new-thing.test.ts"`, `code: 'const q = "INSERT INTO node (id) VALUES (?)";'`; assert `rules.includes("no-restricted-syntax")`. A path not on `nodeEdgeWriteExemptions` is covered even when it ends in `.test.ts`. This is the assertion that a `src/**/*.test.ts` glob would break.
- **`it("a listed legacy test file is exempt", ...)`** — `filePath: "src/queries/node/list-node.test.ts"`, same code; assert `!rules.includes("no-restricted-syntax")`.
- **`it("the node and edge write exemption list holds exactly fifteen exact paths", ...)`** — read `eslint.config.js`, slice from `const nodeEdgeWriteExemptions = [` to the next `];`, and assert the slice holds exactly fifteen quoted strings and that none of them contains `*`. The list then cannot grow or turn into a glob without a failing test.
- `node --test src/domain/layout.test.ts` exits 0.
- `npm run lint` exits 0 over the whole tree. No file under `src/` outside the fifteen exempt paths holds a matching literal after Story 7 and Story 8.
- `grep -c "no-restricted-syntax" eslint.config.js` returns `1`.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/domain/layout.test.ts`. Hermetic coverage: `.agent/plan/epics/016-readiness-applied.md:106`.
