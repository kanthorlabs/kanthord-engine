# Story 3 — The canonical render

Epic: `.agents/plan/epics/103-repository-profile-and-templates.md`
Depends on: Stories 1 and 2.

## Change

- Add `src/domain/profile-render.ts`. It imports `quoteScalar` from `./plan-render.ts`, `comparePaths` from `./plan-path.ts`, `agentKinds` from `./agent.ts`, and the types of `./profile-document.ts`. It imports no vendor package.
- Export `renderProfile(document: RenderableProfile): string`, taking the render type of Story 1, not `ProfileDocument`. `ProfileDocument` is assignable to it, and Story 5 passes a payload whose `template.digest` is `null`.
- Throw `new Error("a profile renders at least one check")` when the `checks` map holds zero entries. A validated profile always declares `unit`, so this state is unreachable from `parseProfile`; throwing keeps the renderer total rather than emitting a bare `checks:` line that would re-import as `null`.
- Emit the frontmatter block first. Line one is `---`. Key order is `schema`, `template`, `checks`. There is no other key.
- Emit `schema: <quoteScalar(schema)>`.
- Emit `template:` on its own line, then a block map indented two spaces with key order `id`, `version`, `digest`, each value through `quoteScalar`. Omit the `digest` line when `digest` is `null`; emit no other key conditionally.
- Emit `checks:` on its own line, then each entry indented two spaces as `<name>:`, with entry names sorted through `comparePaths`. Under each entry emit `run:` indented four spaces, then one `- <quoteScalar(element)>` line per element indented six spaces in the declared order, then `timeout: <quoteScalar(timeout)>` indented four spaces.
- Never sort `run`; it is the argument vector.
- Close the frontmatter with a `---` line.
- Emit the body after the frontmatter. Order the sections by the index of their role in `agentKinds` of `src/domain/agent.ts:3`, which is `general@1`, `swe@1`, `te@1`, `re@1`. Omit an absent role.
- Build each section as the line `## <role>`, one empty line, then the section text exactly as stored, with no trailing LF of its own.
- Join the frontmatter block and the body with one empty line, join two sections with one empty line, and end the document with exactly one LF.
- Render a document with zero sections as the frontmatter block alone, ending with the LF that closes its final `---` line and nothing after it.
- Use `\n` only. Never emit `\r`, a flow collection, a single quote, an anchor or an alias.
- Export `renderProfileBytes(document: RenderableProfile): Uint8Array` as `new TextEncoder().encode(renderProfile(document))`.
- Render a section whose `text` is the empty string as the heading line, one empty line, and nothing else, so two such sections in sequence produce `## general@1`, an empty line, an empty line, `## swe@1`. Pin those exact bytes in a test rather than leaving the newline assembly to the implementer.
- Change `RenderInput` and `renderDocument` of `src/domain/plan-render.ts` in no way. Only `quoteScalar` is reused.
- Extend `ProfileFrontmatter` handling so the renderer accepts a `template` whose `digest` is `null`; Story 5 renders the template payload through that path.

## Constraints

- Do not compute a hash in `src/domain/`. `src/domain/layout.test.ts:56-66` and the import matrix keep `domain/` on `zod` alone, and `BlobStore.hash` is a service.
- Do not import `src/services/blob/index.ts`.
- Do not re-escape a scalar; `quoteScalar` at `src/domain/plan-render.ts:17-39` is the one escaping rule, and it leaves non-ASCII unescaped.
- Do not emit a trailing space on any structural line.

## Verify

- Add `src/domain/profile-render.test.ts`.
- Assert a document with `checks` holding `e2e` and `unit` renders `e2e` before `unit`, because `e` sorts before `u` bytewise.
- Assert `run` of `["npm", "run", "test:unit"]` renders three sequence lines in that exact order, and that the render of `["b", "a"]` keeps `b` first.
- Assert the exact bytes of a full one-role document with `Buffer.compare(Buffer.from(renderProfile(document), "utf8"), expected) === 0`, where `expected` is a template literal written out in the test.
- Assert a document whose sections are supplied in the order `re@1`, `general@1` renders `## general@1` before `## re@1`.
- Assert a document holding only `swe@1` renders one section and no heading for the other three roles.
- Assert the rendered text ends with exactly one LF, and that it contains no `\r` and no `{`.
- Assert a section text holding non-ASCII prose survives verbatim, compared with `Buffer.compare`.
- Assert a `template` with `digest: null` renders `id` and `version` and no `digest` line, and that `Buffer.from(renderProfile(document), "utf8").includes(Buffer.from("digest", "utf8"))` is `false` for that document.
- Assert a section text holding a line with two trailing spaces keeps both spaces.
- Assert a document with zero sections renders frontmatter only and ends with one LF.
- Assert the exact bytes of a document whose first section text is the empty string and whose second is non-empty, with `Buffer.compare` equal to `0`.
- Assert the exact bytes of a section text holding only two spaces, so the spaces survive and are not trimmed to an empty section.
- Assert `renderProfile` throws `a profile renders at least one check` for a `checks` map with zero entries.
- Run `node --test src/domain/profile-render.test.ts`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 52, 57, 58, 66 and 69.
