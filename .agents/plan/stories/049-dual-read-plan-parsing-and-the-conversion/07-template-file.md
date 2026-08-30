# Story 7 — Template file

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Story 6 (`src/domain/plan-conversion.ts` exists with `ConversionTemplates`)

## Change

**`src/domain/plan-conversion.ts` — add template parsing**

Add the following exports to `src/domain/plan-conversion.ts`:

**`TemplateParseError`** — error class:

```ts
export class TemplateParseError extends Error {
  readonly code = "template-parse-error";
  readonly detail: string;
  constructor(detail: string) {
    super(`template-parse-error: ${detail}`);
    this.detail = detail;
  }
}
```

**`parseTemplateFile`** — function. Signature:

```ts
export function parseTemplateFile(text: string): ConversionTemplates;
```

Rules:

1. Parse `text` as JSON. If parsing fails, throw `TemplateParseError` with `detail: "not valid JSON"`.
2. Assert the top-level value is a plain object (`typeof value === "object" && value !== null && !Array.isArray(value)`). If not, throw `TemplateParseError` with `detail: "expected object"`.
3. For each key-value pair: assert the value is a string. If not, throw `TemplateParseError` with `detail: "repository ${key}: expected string"`.
4. For each template string value: count occurrences of `{path}`. If the count is zero, throw `TemplateParseError` with `detail: "repository ${key}: missing {path} placeholder"`. If the count is two or more, throw `TemplateParseError` with `detail: "repository ${key}: duplicate {path} placeholder"`.
5. For each template string value: search for any `{...}` placeholder that is not `{path}`. The pattern is `/\{[^}]+\}/g`; filter out `{path}`. If any remain, throw `TemplateParseError` with `detail: "repository ${key}: unknown placeholder ${placeholder}"`. Name the first such placeholder.
6. Return a `new Map(entries)` as `ConversionTemplates`.

**`applyTemplate`** — function. Signature:

```ts
export function applyTemplate(template: string, path: string): string;
```

Replace the single `{path}` occurrence in `template` with `path` verbatim (no escaping). Return the result.

**Usage in `convertDocumentSet`** — update step 6c and 6d from Story 6:

After looking up the template string, call `applyTemplate(templateString, verifyPath)` to produce the raw command string `C`. Store `verifyCommands = []` in the conversion result — command validation (Story 8) fills in commands. The template is applied here only to produce the command for Story 8 to run; at this layer, commands remain empty until Story 8 validates them.

Note: the `convertDocumentSet` function from Story 6 returns `verifyCommands = []` and sets `pendingCommand` on test and implementation nodes. Story 9's CLI action handler reads `pendingCommand` from each node, runs it via `runCommandAtCommit` (Story 8), and fills in the `commands` array on the written output documents. Story 8 itself only provides the `runCommandAtCommit` helper.

## Constraints

- `applyTemplate` replaces the first occurrence of `{path}` using `template.replace("{path}", path)`. This is safe because `parseTemplateFile` guarantees exactly one `{path}`.
- `parseTemplateFile` does not import `node:fs`. It takes the file text as a string. The CLI (Story 9) owns file reading.
- The error `detail` strings are exact. A test asserts them by value.

## Verify

```
node --test src/domain/plan-conversion.test.ts
```

Add the following `it` blocks to `src/domain/plan-conversion.test.ts` (continuing from Story 6's test file):

1. `"parseTemplateFile parses a valid template map"` — input `'{"kanthord-apps": "node --test {path}"}'`. Assert the returned map has key `"kanthord-apps"` with value `"node --test {path}"`.

2. `"parseTemplateFile substitutes the path via applyTemplate"` — template `"node --test {path}"`, path `"src/foo.ts"`. Assert `applyTemplate(template, path) === "node --test src/foo.ts"`.

3. `"parseTemplateFile rejects an unknown placeholder"` — input `'{"r": "node {path} {file}"}'` (has `{path}` plus unknown `{file}`). Assert throws `TemplateParseError` with `detail` containing `"unknown placeholder {file}"`. Note: a template with no `{path}` at all is caught by rule 4 ("missing {path} placeholder") before rule 5 is reached; the unknown-placeholder test must include `{path}` so rule 4 passes and rule 5 fires.

4. `"parseTemplateFile rejects a missing placeholder"` — input `'{"r": "node --test"}'`. Assert throws `TemplateParseError` with `detail` containing `"missing {path} placeholder"`.

5. `"parseTemplateFile rejects a duplicate placeholder"` — input `'{"r": "cp {path} {path}"}'`. Assert throws `TemplateParseError` with `detail` containing `"duplicate {path} placeholder"`.

6. `"a repository with no entry in templates yields commands [] and template-missing"` — run `convertDocumentSet` with a task document (worker `claude.te@1`, body `**Input:** src/x.ts`, objective ancestor with repo `"other-repo"`) and a `templates` map that has no key `"other-repo"`. Assert `manualReasons` deep-equals `["template-missing"]` and `verify.commands` is empty.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/domain/plan-conversion.test.ts` in `PASS EPIC-049`. Hermetic coverage: substitution; unknown placeholder named; missing placeholder; duplicate placeholder; missing repo entry.
