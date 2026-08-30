# EPIC 049 — Dual-read plan parsing and the conversion

Status: **draft**. It follows EPIC 048 by sequence order.

## Goal

A plan document carries a deliverable and a verify block, and an existing document still parses:

- `planFrontmatter` accepts `deliverable` and `verify`, and it still accepts `worker`;
- a document that carries both `worker` and `deliverable` is refused, and a document that carries neither is refused;
- `plan import` stores the deliverable and the verify block, and `plan export` round-trips both byte-identically;
- `plan convert` reads a plan directory, runs every generated command at its intended commit, writes only a command that ran, and emits the converted document set plus a report, with no graph row.

## Non-goals

- **No apps-tree conversion.** This epic ships the mechanism. A human runs `plan convert` against `kanthord-apps`, confirms each command, and imports the result. EPIC 046 states the boundary.
- **No unvalidated command reaches a document.** `worker.md` section 12 states the conversion runs every generated command at its intended commit before it writes that command. `plan convert` therefore runs each one. A command that did not run leaves `commands: []`, and the node stays ineligible. The report names it. Nothing writes a command a human must check afterwards.
- **No worker field in a converted document.** The conversion deletes `worker`. `worker.md` section 1 forbids it in a plan document.
- **No assignment in a document.** `assignment` is runtime state. `planFrontmatter` gains no `assignment` key, and a document carrying one is `frontmatter-invalid`.
- **No pair inference beyond the table.** The conversion maps a source field to a deliverable by the table of the Decisions. It infers nothing from a title or a body.
- **No removal of `worker` from the schema.** EPIC 057 removes it. Dual read is the whole point of this epic, per `worker.md` section 13.

## Decisions

- **Dual read is a bounded window, and the two shapes are exclusive per document.** `planFrontmatter` in `src/domain/plan-document.ts:16` gains `deliverable` and `verify` as optional keys, and `planFrontmatterKeys` at line 7 gains both. A document carrying `worker` and `deliverable` together raises `frontmatter-invalid` with the issue path `deliverable`. A document carrying neither raises `frontmatter-invalid` with the issue path `deliverable`. One shape per document, and the window closes at EPIC 057.

- **`verify` is required in the new shape, and it may be empty.** A document that carries `deliverable` and no `verify` raises `frontmatter-invalid` with the issue path `verify`. An initiative and a parent objective carry `verify: {paths: [], commands: []}`, written out in full. An implicit default would make an unwritten block indistinguishable from an author's empty one.

- **`renderDocument` emits `deliverable` and `verify` in a fixed key order, and it drops `worker` when a deliverable is present.** `src/domain/plan-render.ts:41` emits `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`, in that order. That is the order of the four examples in `worker.md` section 2, and a canonical order that disagrees with the design document would make every example in it wrong. `worker` is emitted only for a legacy document, in its current position at line 55. The order is fixed because the round trip must be byte-identical, per the `AGENTS.md` determinism rule.

- **`verify` renders as a nested block, and its scalars are quoted by `quoteScalar`.** The renderer emits `verify:`, then `  paths:` with one `    - <quoted>` line per entry, then `  commands:` likewise. An empty list renders as `  paths: []`. `src/domain/plan-render.ts:17` already holds `quoteScalar`, and a command string holding a quote, a backslash or a tab is therefore round-trip safe.

- **Two finding codes are added, and `worker-unknown` is untouched.** `pair-illegal` names a document whose `(kind, deliverable)` pair fails `nodePairLegality`. `verify-invalid` names a document whose verify block fails `verifyBlock`. Both are `structural` scope in `src/domain/plan-finding.ts:42`. `worker-unknown` keeps its meaning for a legacy document until EPIC 057.

- **The conversion table is the table of `worker.md` section 12, and it adds no row.**

  | Source                            | Result                        |
  | --------------------------------- | ----------------------------- |
  | `worker: claude.te@1`             | `deliverable: test`           |
  | `worker: claude.swe@1`            | `deliverable: implementation` |
  | `kind: initiative`                | `deliverable: expansion`      |
  | `kind: objective`                 | `deliverable: expansion`      |
  | the `**Input:**` path of the body | one `verify.paths` entry      |

  A `kind` rule wins over a `worker` rule, because an initiative and an objective hold children and a child, not a commit, is their outcome. Every objective converts to `expansion` unconditionally, exactly as section 12 states. An atomic objective is legal in the model of EPIC 047, and it is not a conversion result.

  **A `worker` value outside the two rows is not mapped.** `te@1`, `swe@1`, `general@1` and any other value reach `manual` with the reason `worker-unmapped`. Section 12 is a migration rule for one tree, and inventing a row for a value that tree does not hold would convert a document nobody inspected.

  **An initiative and an objective take `paths: []` and `commands: []`.** Section 12 states it. The `**Input:**` rule applies to a task only, and the converter reads no body of an initiative or an objective.

- **The conversion is a document-set function, not a document function.** `convertDocumentSet(documents, templates)` in `src/domain/plan-conversion.ts` takes the whole parsed set. A single-document signature cannot answer the questions the table asks: which repository a task inherits from its objective, which `test` node an `implementation` node depends on, and what command that `test` node produced. The function is pure and it returns the converted set plus the report.

- **A task inherits its repository from its nearest objective ancestor.** `worker.md` section 2 puts `repo` on the objective, and `repo-on-task` is already a finding code at `src/domain/plan-finding.ts:27`. The converter resolves a task's repository by walking to its objective, and it selects that repository's template.

- **An implementation node with two `test` dependencies reaches `manual`.** The reason is `test-dependency-ambiguous`. Picking one would write a command nobody chose.

- **`plan convert` writes files and a report, and it touches no database.** It is a CLI command under `src/cli/plan/convert.ts`, and it reaches no command and no query. `AGENTS.md` states `cli/` imports `domain/`, `http/contract/` and `cli/` only. The conversion rule is the pure function above, and the CLI owns the file system, the checkout and the subprocess.

- **The report names every node the human must finish by hand, and `manual` is a closed set of six reasons.** `convert-report.json` holds, per node, the source path, the derived deliverable, the derived `verify.paths`, the derived `verify.commands`, and a `manual` list. The six reasons are `input-missing`, `input-ambiguous`, `test-dependency-missing`, `test-dependency-ambiguous`, `template-missing` and `command-failed`. `worker.md` section 12 names `test-dependency-missing` and counts 8 such nodes in the apps tree. `command-failed` is the reason a generated command did not run as expected at its intended commit, and it is the reason section 12's validation rule produces. The tuple `manualReasons` is exported and asserted by deep equality, so a seventh reason is a deliberate change.

- **The report is canonical JSON, and its shape is pinned.** Keys sort bytewise at every level. A node entry sorts by its source path through `comparePaths`. A `manual` list sorts by the index of the reason in `manualReasons`. The file ends with one newline. Two-space indentation. A report that is not canonical cannot be compared across two runs, and the idempotence rule below depends on that comparison.

- **A command template is per repository, and its file format is pinned.** `--template <file>` reads a JSON object mapping a repository name to a template string. The template holds exactly one placeholder, `{path}`, which the converter replaces with the node's single `verify.paths` entry, verbatim and unquoted. No other placeholder exists, and an unknown placeholder is a parse error naming it. One placeholder is enough for the shipped apps tree, and a grammar admits an expression nobody can validate. A repository with no entry yields `commands: []` and the reason `template-missing`.

- **A `test` node inverts its command, and an `implementation` node repeats it.** The template yields one command string `C`. A `test` node emits `"! " + C`. An `implementation` node emits the `C` of the `test` node named by its `depends_on`. `worker.md` section 2 states the inversion rule and section 11 states why it is verifiable as a pair.

- **Every generated command runs at its intended commit before it is written.** `worker.md` section 12 states it. `--repo <name>=<path>` names a checkout per repository, and `--at <name>=<ref>` names the intended commit. The converter checks the commit out to a `mktemp` directory it owns, runs the command, and asserts a zero exit. A command that exits non-zero, or that cannot run because no checkout was supplied, is dropped: the node takes `commands: []` and the reason `command-failed`. A generated command never reaches a document unvalidated.

- **`--repo` is required for a node that would take a command, and its absence is a refusal, not a silent empty list.** `plan convert` run with no `--repo` refuses with `checkout-required` and names the repositories it needs, unless `--commands-none` is passed. `--commands-none` converts deliverables and paths only, and every node with a template reaches `manual` with `command-failed`. An operator who forgot the flag must not receive a plausible tree with every command silently dropped.

- **A new-shape document passes through unchanged, and that is what makes the converter idempotent.** After the first run no document holds a `worker` key, so the second run has nothing to map. A document that already carries `deliverable` is copied byte-for-byte, its commands are re-run if a checkout is supplied, and its `manual` reasons are recomputed from the same inputs and therefore reproduce. `convert-report.json` is not a plan document and the converter skips it by exact name.

- **`plan convert` is idempotent, and idempotence is a determinism property, not a validity claim.** The second run produces byte-identical documents and a byte-identical report. A byte-stable command can still be the wrong command; the validation rule above is what makes it right. Both properties are required, and neither substitutes for the other.

- **The output directory must be empty or absent, and it must not sit inside the input directory.** `plan convert` refuses `output-not-empty` and `output-inside-input`. Overwriting in place would destroy the legacy tree the human still needs to compare against, and an output nested in the input would feed the converter its own output on the next run.

- **A report path is relative to the input directory root.** An absolute path would make two runs from two working directories produce two reports, and the idempotence assertion would fail for a reason that is not a defect.

## Stories

1. **The frontmatter accepts both shapes.** Extend `planFrontmatterKeys` at `src/domain/plan-document.ts:7` and `planFrontmatter` at line 16 with `deliverable` and `verify`. Extend `ParsedDocument` at line 38 with `deliverable: Deliverable | null` and `verify: VerifyBlock | null`. Add cases to `src/domain/plan-document.test.ts`: the legacy shape parses; the new shape parses; both keys together raise `frontmatter-invalid` on path `deliverable`; neither key raises `frontmatter-invalid` on path `deliverable`; `deliverable` with no `verify` raises `frontmatter-invalid` on path `verify`; an `assignment` key raises `unknown frontmatter key`.

2. **Two finding codes.** Add `pair-illegal` and `verify-invalid` to `findingCodes` at `src/domain/plan-finding.ts:6` and to `findingScope` at line 42, both `structural`. Update `src/domain/plan-finding.test.ts` for the extended tuple and the sort order over the new codes.

3. **Validation applies the pair and the verify block.** Add the two checks to `src/domain/plan-validate.ts` and `src/domain/plan-candidate.ts`. Add cases to their test files: a task naming `deliverable: expansion` raises exactly one `pair-illegal`; an initiative naming `deliverable: implementation` raises exactly one `pair-illegal`; a document whose `verify.paths` holds an absolute path raises exactly one `verify-invalid`; a legacy document raises neither.

4. **The renderer emits the new keys.** Extend `RenderInput` and `renderDocument` at `src/domain/plan-render.ts:6` and `:41` with the key order `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`, and the nested `verify` block. Add a case asserting each of the four `worker.md` section 2 examples renders byte-identically. Add cases to `src/domain/plan-render.test.ts` asserting the exact bytes of a new-shape document, the exact bytes of an empty verify block, and a command string holding a quote, a backslash and a tab surviving a round trip byte-identically.

5. **Import and export round-trip the new shape.** Extend `src/commands/plan/import-plan.ts` to persist `deliverable` and `verify_json`, and `src/queries/plan/export-plan.ts` to emit them. Add cases to both test files asserting a new-shape plan imports with no finding and exports byte-identical to the input, and asserting a legacy plan still imports and exports byte-identical.

6. **The conversion rule.** Add `src/domain/plan-conversion.ts` with `manualReasons`, `convertDocumentSet(documents, templates)` and `renderConvertReport(report)`. Add `src/domain/plan-conversion.test.ts` asserting: `manualReasons` deep-equals the six-element tuple; the four conversion rows by case; every objective converts to `expansion` whether or not it holds a task child; a `worker` value outside the two rows reaches `manual` with `worker-unmapped`; an initiative and an objective take `paths: []` and `commands: []`; a task inherits its repository from its objective ancestor; the `"! "` inversion on a `test` node; an `implementation` node takes the command of the `test` node its `depends_on` names; an `implementation` node with two `test` dependencies reaches `test-dependency-ambiguous`; the report renders canonical, byte-exact against a literal.

7. **The template file.** Add the template parser to `src/domain/plan-conversion.ts`, reading the repository-to-string map and substituting `{path}` verbatim. Add cases asserting substitution, asserting an unknown placeholder is a parse error naming it, and asserting a repository with no entry yields `commands: []` and `template-missing`.

8. **The command validation pass.** Add `src/cli/plan/convert-run-command.ts` checking a commit out to a `mktemp` directory the CLI owns, running one generated command, asserting a zero exit, and removing the directory. Add its test against the hermetic loopback repository fixture of EPIC 005, asserting a passing command is kept, asserting a non-zero exit drops the command and records `command-failed`, and asserting the temp directory is removed on both paths.

9. **`plan convert` on the CLI.** Add `src/cli/plan/convert.ts` taking a plan directory, an output directory, `--template <file>`, `--repo <name>=<path>`, `--at <name>=<ref>` and `--commands-none`. Add `src/cli/plan/convert.test.ts` running against a hermetic `mktemp` fixture tree, asserting: the written bytes per document; the canonical report bytes; `checkout-required` when a template applies and no `--repo` is given; `--commands-none` converting with every such node at `command-failed`; `output-not-empty` and `output-inside-input` by refusal code; a new-shape document copied byte-for-byte; `convert-report.json` skipped by name; and the second run over its own output producing byte-identical documents and a byte-identical report.

10. **The proposal records dual read and the conversion.** Amend `docs/proposal/phase-1/plan-format.md` with the two frontmatter shapes, the exclusivity rule, the fixed key order and the verify block grammar. Add the conversion table, the six `manual` reasons, the template format, the command validation rule and the report schema to `docs/proposal/phase-2/deliverables-and-pairs.md`. State that dual read closes at EPIC 057.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/plan-document.test.ts \
  src/domain/plan-finding.test.ts \
  src/domain/plan-validate.test.ts \
  src/domain/plan-candidate.test.ts \
  src/domain/plan-render.test.ts \
  src/domain/plan-conversion.test.ts \
  src/commands/plan/import-plan.test.ts \
  src/queries/plan/export-plan.test.ts \
  src/cli/plan/convert-run-command.test.ts \
  src/cli/plan/convert.test.ts \
  && echo "PASS EPIC-049"
```

Hermetic coverage required beyond the Proof:

- A document carrying `worker` and `deliverable` together raises exactly one `frontmatter-invalid`, with the issue path `deliverable`.
- A document carrying neither raises exactly one `frontmatter-invalid`, with the issue path `deliverable`.
- A document carrying `deliverable` and no `verify` raises exactly one `frontmatter-invalid`, with the issue path `verify`.
- A new-shape document renders to exact bytes, asserted against a literal string, with the key order `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`. The four examples of `worker.md` section 2 each render byte-identically to their text in that document.
- An empty verify block renders as `  paths: []` and `  commands: []`, asserted byte-exact.
- A command string holding `"`, `\` and a tab round-trips byte-identically through render and parse.
- A legacy plan imports and exports byte-identically after this epic, proving dual read did not break the shipped shape.
- A `test` node converts to a command that begins with `! `, and the remainder equals the template output exactly.
- An `implementation` node with no `depends_on` naming a `test` node reaches `manual`, with the reason asserted by value.
- A body holding two `**Input:**` lines reaches `manual`, with the reason asserted by value.
- `manualReasons` deep-equals the six-element tuple. Every one of the six is produced by its own case, so no reason is unreachable.
- An objective with no task child converts to `deliverable: expansion`, proving the rule is unconditional.
- A `worker` value of `te@1` reaches `manual` with `worker-unmapped`, and no deliverable is derived from it.
- A task whose objective ancestor names a repository selects that repository's template. The case places the objective two levels above the task.
- A generated command that exits non-zero at its intended commit is dropped, the node takes `commands: []`, and the reason is `command-failed`. The case runs against the hermetic loopback repository.
- `plan convert` with a template in scope and no `--repo` refuses `checkout-required` and names the repository. The refusal is asserted, so a silent empty command list cannot ship.
- An output directory that is non-empty refuses `output-not-empty`, and one nested inside the input refuses `output-inside-input`.
- `plan convert` run twice over its own output writes byte-identical documents and a byte-identical report, asserted by comparing the two output trees file by file, including `convert-report.json`.
