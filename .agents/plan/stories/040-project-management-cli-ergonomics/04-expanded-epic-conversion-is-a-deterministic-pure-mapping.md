# Story 4 — The expanded-EPIC conversion is a deterministic pure mapping

Epic: `.agents/plan/epics/040-project-management-cli-ergonomics.md`
Depends on: Story 3 only by dispatch order.

## Change

### New `src/cli/plan/convert-harness-plan.ts`

Export these types and one function:

```ts
export type HarnessPlanSource = Readonly<{
  epic: Readonly<{ path: string; content: string }>;
  stories: readonly Readonly<{ path: string; content: string }>[];
  repository: string;
}>;

export type ConvertedPlanDocument = Readonly<{
  path: string;
  content: string;
}>;

export function convertHarnessPlan(
  input: HarnessPlanSource,
): readonly ConvertedPlanDocument[];
```

The function performs no file read, file write, clock read, random call or network call.

### Normalize and validate the EPIC

- Normalize CRLF and lone CR to LF before parsing every input document.
- Derive `epicSlug` from the basename of `input.epic.path` without `.md`; refuse a non-`.md` basename with `Error("the EPIC path must end in .md")`.
- Require line 1 to match `# EPIC ([0-9]+) — (.+)` exactly and retain the decimal spelling and non-empty title. Otherwise throw `Error("the EPIC heading is invalid")`.
- Extract a top-level section as bytes after an exact `## <name>` line through the byte before the next line beginning `## `. Trim leading/trailing blank lines and restore exactly one final LF.
- Require non-empty `input.repository`; otherwise throw `Error("the repository name is empty")`.
- Require non-empty `## Goal`; otherwise throw `Error("the EPIC Goal is missing")`.
- In `## Stories`, count lines matching `^[1-9][0-9]*\. ` and require the resulting numbers to be exactly `1..N` in source order. No row means `Error("the EPIC Stories list is empty")`; a gap or duplicate means `Error("the EPIC Stories list is not contiguous")`.

### Normalize and validate Story records

- Consider only records whose basename matches `^[0-9]{2}-.*\.md$`; ignore `index.md` and every other path. Sort considered records by `path` with `comparePaths`.
- Require the considered record count to equal the EPIC numbered-story count; otherwise throw `Error("expected <N> expanded Story files; found <M>")`.
- For sorted position N, require filename prefix `NN` with two decimal digits. A duplicate, gap or displaced prefix throws `Error("expected Story file <NN>; found <basename>")`.
- Require line 1 to equal `# Story <N> — <non-empty title>` with decimal N equal to the filename position. Otherwise throw `Error("<path> heading does not name Story <N>")`.
- Require non-empty `## Change`, `## Constraints` and `## Verify` through the same top-level-section extractor. A miss throws `Error("<path> has no non-empty ## <name> section")`.

### Render exact documents

- Render YAML scalar values with `JSON.stringify`, which supplies the required double quotes and escaping. Render no key with an absent value.
- Use applicable canonical frontmatter key order from `docs/proposal/phase-1/plan-format.md`: `kind`, `title`, `depends_on`, `worker`, `repo` after omitted `id`.
- Build these documents with LF and exactly one final LF:
  1. `plan/<epicSlug>/initiative.md`, frontmatter `kind`, `title`; title `EPIC <number> — <title>`; body is the normalized Goal body.
  2. For Story N with source basename `<file>` and stem `<stem>`, `plan/<epicSlug>/<stem>/objective.md`; frontmatter `kind`, `title`, optional `depends_on`, `repo`. Story 1 omits `depends_on`; Story N>1 renders exactly `depends_on:\n  - "../<previous-stem>/objective.md"`. Body is exactly `Source story: .agents/plan/stories/<epicSlug>/<file>.\n`.
  3. `plan/<epicSlug>/<stem>/01-implement.md`; frontmatter `kind`, `title`, `worker`; title `Implement Story <N> — <title>` and worker `tdd@1`. Body is `## Change\n\n<Change body>\n## Constraints\n\n<Constraints body>\n## Acceptance criteria\n\n<Verify body>`, normalized to one final LF.
- Sort the complete array with `comparePaths` before returning it. For the two-Story fixture the exact path order is Story 1 task, Story 1 objective, Story 2 task, Story 2 objective, initiative.
- Emit no `id`, task `repo`, objective `worker` or task `depends_on` key.
- Return a frozen-independent readonly value: no returned document reuses a mutable input object.

### Proposal

- In `docs/proposal/api/graph.md`, insert `## Local plan conversion` immediately before `## plan.import` at `:61`.
- State the command grammar, one-initiative/one-objective-and-task-per-Story mapping, serial objective dependency, exact prose mapping, absent identities, deterministic bytes and no network/import side effect.
- State every refusal class above and that existing output is Story 5's command concern.
- Run Prettier on the proposal file.

## Constraints

- Import only `node:path` and `src/domain/plan-path.ts`; import no service, HTTP contract, YAML package or ULID package.
- Do not read the repository's actual `.agents/plan` tree in production or tests from this module.
- Do not infer dependencies from prose. Story order is the one serial order.
- Do not emit canonical ULID-bearing paths; canonicalization remains `plan.validate`/`plan.import` work.

## Verify

- Add `src/cli/plan/convert-harness-plan.test.ts` with an in-memory two-Story EPIC fixture.
- Assert the returned array deep-equals five exact path/content records, including:
  - no `id:` text;
  - objective 2's one relative dependency on objective 1;
  - the repository on both objectives only;
  - `worker: "tdd@1"` on both tasks only;
  - Goal, Change, Constraints and Verify bytes in their exact destinations;
  - exactly one LF at every document end.
- Reverse the input Story record order and assert `deepStrictEqual` with the first output.
- Add one exact throw assertion for: non-Markdown EPIC path, bad EPIC heading, empty repository name, missing Goal, empty Stories, non-contiguous EPIC numbers, count mismatch, duplicate/skipped Story prefix, mismatched Story heading, and each missing required Story section.
- Add CRLF input and quoted/backslash title cases; assert LF-only output and the exact `JSON.stringify`-escaped title lines.
- `node --test src/cli/plan/convert-harness-plan.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: the `src/cli/plan/convert-harness-plan.test.ts` line of the EPIC Proof; the final sentinel is delivered collectively.
