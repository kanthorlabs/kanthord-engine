# Story 03 — document parse

Epic: `.agents/plan/epics/008-project-and-plan.md`

YAML frontmatter, the body, and the `## Acceptance criteria` split. `docs/proposal/phase-1/plan-format.md:11` makes the `yaml` dependency the parser, and `AGENTS.md` keeps `zod` as the only runtime dependency of `domain/`. So the parser lives behind a service interface and the split lives in `domain/`.

## Change

### 1. `src/services/document/index.ts` (new — a fourteenth capability)

```ts
export type Frontmatter = Readonly<{
  frontmatter: unknown;
  body: string;
}>;

export type DocumentErrorCode =
  | "document-frontmatter-missing"
  | "document-frontmatter-unparsable"
  | "document-frontmatter-not-a-map";

export class DocumentError extends Error {
  readonly code: DocumentErrorCode;
  constructor(code: DocumentErrorCode, message: string);
}

export interface DocumentReader {
  read(text: string): Frontmatter;
}
```

`read` returns the frontmatter as `unknown`. Validation is `zod` in `domain/`, so the service performs no schema work and holds no plan vocabulary.

### 2. `src/services/document/yaml.ts` (new)

```ts
export class YamlDocumentReader implements DocumentReader { … }
```

`import { parse } from "yaml";` lives here. The frontmatter grammar is fixed and narrow:

- The text must begin with the three bytes `---` followed by one LF. Otherwise `document-frontmatter-missing`.
- The closing delimiter is the first line after the opener whose whole content is exactly `---`. Absent, that is `document-frontmatter-missing`.
- The frontmatter text is every byte between the two delimiter lines. It is passed to `parse(text, { schema: "core", version: "1.2" })`. A thrown parser error becomes `document-frontmatter-unparsable`, carrying the parser's message.
- A parse result that is not a plain object — `null`, an array, a scalar — is `document-frontmatter-not-a-map`.
- The body is every byte after the closing delimiter line's LF. A closing delimiter that is the last line yields an empty body.

Normalization runs before the scan, in this order, so a CRLF document parses: `\r\n` → `\n`, then a remaining lone `\r` → `\n`. `docs/proposal/phase-1/plan-format.md:49`.

The service performs **no** trailing-LF work. That is body normalization and it belongs to `domain/`, because the same rule governs the renderer.

### 3. `src/domain/plan-body.ts` (new — pure)

```ts
export const ACCEPTANCE_HEADING = "## Acceptance criteria";

export function normalizeBody(body: string): string;

export type BodySplit = Readonly<{
  instruction: string;
  acceptance: string | null;
}>;

export type BodySplitErrorCode =
  "acceptance-heading-duplicated" | "acceptance-heading-not-at-line-start";

export class BodySplitError extends Error {
  readonly code: BodySplitErrorCode;
}

export function splitBody(body: string): BodySplit;
```

`normalizeBody` maps `\r\n` and a lone `\r` to `\n`, strips every trailing `\n`, and appends exactly one `\n`. An empty body normalizes to `"\n"`. Trailing spaces on a line survive untouched — two of them are a Markdown hard line break (`plan-format.md:49`).

`splitBody` runs on an already normalized body and splits at the **first** line whose whole content equals `ACCEPTANCE_HEADING`:

- `instruction` is every byte before that line, including the LF that ends the preceding line.
- `acceptance` is the heading line itself and every byte after it.
- `instruction + (acceptance ?? "")` equals the input, byte for byte. That identity is the whole reason the heading belongs to `acceptance` rather than being re-emitted: the renderer of Story 07 concatenates the two blobs and needs no knowledge of the heading.
- No heading yields `{ instruction: body, acceptance: null }`.
- A second line equal to the heading is `acceptance-heading-duplicated`.
- A line that contains the heading with leading whitespace, or with trailing content, is not the heading and does not split. A line equal to the heading followed by trailing spaces **is** the heading with its trailing spaces, so it is not a match; a line matching `/^## Acceptance criteria[ \t]+$/` is `acceptance-heading-not-at-line-start`, because that is a typo a human makes and silently treating it as prose loses the whole acceptance section.

Whether an acceptance section is required is a validation rule, not a split rule. Story 05 owns it.

### 4. `eslint.config.js` — deny `yaml` outside its two legal sites

`vendorPackages` at `:9-18` omits `yaml`, so the lint permits `import { parse } from "yaml"` inside `src/commands/` and `src/queries/` — which `AGENTS.md` forbids ("they import no vendor package at all"). Adding `"yaml"` to `vendorPackages` is wrong: that list is also applied to `src/http/contract/**` at `:246-270`, where `src/http/contract/openapi.ts:1` imports `yaml` legally.

Add `"yaml"` to the group of the `src/commands/**` + `src/queries/**` block at `:222-245`, and to the `src/domain/**` block at `:202-219`. Those two blocks each carry their own complete restriction set (`:176-179` states why), so the edit is one string in each and no other block changes. `src/cli/**` at `:271-296` is left alone: a CLI command reads and writes plan files, and `yaml` is a legal tool there if a later story needs it.

### 5. `test/helpers/plan.ts` — `createPlanReader()`

One line, returning a real `YamlDocumentReader`. Story 02.5 creates the file. Story 05's domain test and Stories 08 and 11's query and command tests all need real parsing, and none of them may import `src/services/document/yaml.ts` directly under `AGENTS.md`'s test rule.

### 6. `src/domain/layout.test.ts` — the service directory list, and the two new lint cases

`:101-123` deep-equals thirteen names. Insert `"document"` between `"crypto"` and `"event"`. Story 02.5 inserts `"plan"` after `"lease"`, so the final array holds fifteen and the final title is exactly `"src/services/ holds exactly the fourteen capabilities plus home-lock"`. Whichever of the two stories lands second writes that title. `:125-140` (every service directory holds an `index.ts`) and `:157-173` (no `index.ts` contains `implements `) then cover the new directory with no edit.

`eslint.config.js:37-42` matches `src/services/*` with a capture, so the new capability needs no configuration change.

Add two `lintCase` assertions beside the existing vendor-package cases at `:251-277`, in the list-driven form those use, so section 4 is enforced by a mechanism rather than by review:

- `import { parse } from "yaml";` in each of `src/commands/plan/import-plan.ts`, `src/queries/plan/export-plan.ts` and `src/domain/plan-document.ts` **must** report `no-restricted-imports`.
- The same import in `src/http/contract/openapi.ts` and in `src/services/document/yaml.ts` **must not** report it.

Five cases, one table. The negative pair is what would catch adding `"yaml"` to `vendorPackages` instead of to the two scoped blocks.

## Constraints

- `yaml` is imported in `src/services/document/yaml.ts` and in `src/http/contract/openapi.ts`, and nowhere else. A test asserts exactly those two files.
- `src/domain/plan-body.ts` imports nothing. It is a pure string module.
- `normalizeBody` is idempotent: `normalizeBody(normalizeBody(x)) === normalizeBody(x)`.
- `splitBody(b).instruction + (splitBody(b).acceptance ?? "") === b` for every input, and a test asserts it over every case in the suite.
- The reader never inspects a field name. It has no knowledge of `id`, `kind`, `title`, `depends_on`, `worker` or `repo`.

## Verify

`node --test src/services/document/yaml.test.ts src/domain/plan-body.test.ts src/domain/layout.test.ts`

### `yaml.test.ts`

- A document with `---\nid: "task_01A"\n---\nbody\n` returns `frontmatter` deep-equal to `{ id: "task_01A" }` and `body` exactly `"body\n"`.
- The same document with CRLF line endings returns the identical result, byte for byte.
- The same document with lone CR line endings returns the identical result.
- A document with no leading `---` throws `document-frontmatter-missing`.
- A document with an opener and no closer throws `document-frontmatter-missing`.
- A closing `---` as the last line yields `body === ""`.
- A `---` line inside the body after the closer stays in the body.
- Broken YAML (`id: "unterminated`) throws `document-frontmatter-unparsable`, and the message contains the parser's own text.
- Frontmatter that parses to a list, to a scalar and to nothing each throw `document-frontmatter-not-a-map` (three cases).
- A frontmatter value written unquoted, single-quoted and double-quoted all parse to the same string. A human authors any of the three (`plan-format.md:52`).
- `depends_on: [a.md, b.md]` in flow form and in block form both parse to `["a.md","b.md"]`.
- A YAML anchor and alias in the frontmatter parses without throwing. The renderer never emits one, and refusing one on input would refuse a legal YAML document the daemon can read.
- The reader is called twice on one input and the two results `deepEqual`.
- `yaml` import sites: read every non-test `.ts` under `src/` and assert the set containing `"yaml"` in an `import` line is exactly `["src/http/contract/openapi.ts","src/services/document/yaml.ts"]`.

### `plan-body.test.ts`

- `normalizeBody("a\r\nb")` is `"a\nb\n"`; `normalizeBody("a\rb")` is `"a\nb\n"`; `normalizeBody("a\n\n\n")` is `"a\n"`; `normalizeBody("")` is `"\n"`; `normalizeBody("a")` is `"a\n"`.
- `normalizeBody("a  \nb\n")` is `"a  \nb\n"` — the two trailing spaces survive, asserted byte for byte.
- Idempotence over all of the above.
- `splitBody("intro\n## Acceptance criteria\n- one\n")` returns `instruction === "intro\n"` and `acceptance === "## Acceptance criteria\n- one\n"`.
- The concatenation identity holds for every case, asserted in a loop over the case table.
- A body with no heading returns `acceptance === null` and `instruction` equal to the input.
- A heading as the very first line returns `instruction === ""`.
- A second heading throws `acceptance-heading-duplicated`.
- `"  ## Acceptance criteria\n"` does not split — `acceptance` is `null`.
- `"## Acceptance criteria extra\n"` does not split.
- `"## acceptance criteria\n"` does not split. The match is bytewise and case-sensitive.
- `"## Acceptance criteria  \n"` throws `acceptance-heading-not-at-line-start`.
- A heading with no trailing newline (the last line of the body) returns `acceptance === "## Acceptance criteria"`, and the concatenation identity still holds.

### `layout.test.ts` — the five `yaml` lint cases

The three positive and two negative cases of section 6, asserted through `lintCase` from `test/helpers/lint.ts:7`. `lintCase` lints text against the real configuration, so no file needs to exist for a case to run.

`npm run verify` exits 0.

Proof: contributes `src/services/document/yaml.test.ts` and `src/domain/plan-body.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
