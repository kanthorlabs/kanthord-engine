# Story 03 — Layer boundaries

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: Story 02. The lint cases name `src/services/config/*.ts`, `src/domain/version.ts` and `src/main.ts`, and every path a case names must be a real committed file.

## Change

**1. `eslint.config.js:32`** — one element per capability. Replace

```js
{ type: "service", pattern: "src/services", partialMatch: false },
```

with

```js
{
  type: "service",
  pattern: "src/services/*",
  capture: ["capability"],
  partialMatch: false,
},
```

Add no policy for the capture. Measured with `eslint-plugin-boundaries@7.0.2`: the plugin allows an import inside one element already, so the capture alone makes a same-capability import legal and a cross-capability implementation import illegal. A policy templated on `{{from.capability}}` matches every pair instead and reopens the rule.

**2. `eslint.config.js:55`** — the test category must reach `test/`. Replace

```js
{ category: "test", pattern: "src/**/*.test.ts" },
```

with

```js
{ category: "test", pattern: ["src/**/*.test.ts", "test/**/*.test.ts"] },
```

Measured: without this, a file under `test/helpers/` is in no category, the relaxed block's `default: "allow"` applies, and a helper test may import `src/main.ts`.

**3. `eslint.config.js`, the relaxed test block** — the category fix covers `test/helpers/*.test.ts` and leaves a non-test helper such as `test/helpers/daemon.ts` uncovered, because a non-test helper is in no category either. Add a second policy beside the existing one, in the block whose `files` are `["src/**/*.test.ts", "test/**/*.ts"]`:

```js
{
  from: { element: { types: "test-helper" } },
  disallow: { to: { file: { categories: "composition-root" } } },
},
```

Measured: with both policies, a non-test helper and a helper test are each refused an import of `src/main.ts`, while a helper importing another helper, a helper importing the `eslint` package, and a co-located test importing its implementation all stay clean. Story 08 asserts the non-test-helper case, because it creates the first non-test helper.

Change nothing else in `eslint.config.js`. Add no `boundaries/root-path`: `npm run lint` runs at the repository root, which is the plugin's default.

**4. `tsconfig.json:18`** — the type check must cover the first `test/` files this story creates. Replace

```json
"include": ["src/**/*.ts"]
```

with

```json
"include": ["src/**/*.ts", "test/**/*.ts"]
```

**5. `test/helpers/lint.ts`** — new file. It runs the committed `eslint.config.js`, never a copy of it.

```ts
export type LintCase = Readonly<{ filePath: string; code: string }>;

export async function lintCase(input: LintCase): Promise<readonly string[]>;
```

- `repositoryRoot` is `fileURLToPath(new URL("../../", import.meta.url))`.
- Construct `new ESLint({ cwd: repositoryRoot })` once per call. Pass no `overrideConfig` and no `overrideConfigFile`.
- Call `lintText(input.code, { filePath: join(repositoryRoot, input.filePath) })`.
- Return every reported `ruleId`, deduplicated and sorted with `Buffer.compare` on the utf8 bytes.

**6. `test/helpers/lint.test.ts`** — new file, the assertions below.

## Constraints

- `lintCase` asserts on `ruleId`, never on a message string. A plugin release rewords a message.
- Every `filePath` and every imported path in a case names a file that exists in the repository at this story. `lintText` resolves an import against the real file system, and a missing target reports `boundaries/no-unknown-dependencies` instead of the rule under test.
- Story 05 adds the cross-capability cases to this same test file, and Story 08 adds the non-test-helper cases, each when the files those cases name exist. Do not stub either set here.

## Verify

`node --test test/helpers/lint.test.ts`, which asserts, one test per case:

| `filePath`                       | import in the code             | expected `ruleIds`            |
| -------------------------------- | ------------------------------ | ----------------------------- |
| `src/services/config/convict.ts` | `./search-order.ts`            | `[]`                          |
| `src/services/config/convict.ts` | `../../domain/version.ts`      | `[]`                          |
| `src/services/config/convict.ts` | `../../main.ts`                | `["boundaries/dependencies"]` |
| `src/domain/version.ts`          | `node:fs`                      | `["no-restricted-imports"]`   |
| `src/domain/version.ts`          | `../services/config/index.ts`  | `["boundaries/dependencies"]` |
| `test/helpers/lint.test.ts`      | `../../src/main.ts`            | `["boundaries/dependencies"]` |
| `test/helpers/lint.ts`           | `eslint`                       | `[]`                          |
| `src/main.ts`                    | `./services/config/convict.ts` | `[]`                          |

Each case's code is the import line followed by `console.log(<binding>);`, so no unused-binding rule can confuse the result.

`npm run lint` exits 0 on the whole tree.
`npm run typecheck` exits 0 and now covers `test/`.
`npm run verify` exits 0.

Proof: `PASS 001-BOUNDARIES`.
