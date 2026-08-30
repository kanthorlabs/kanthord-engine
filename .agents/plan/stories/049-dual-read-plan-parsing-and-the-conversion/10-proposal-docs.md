# Story 10 — Proposal records dual read and the conversion

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Stories 1-9 (all implementation stories complete and passing)

## Change

**`docs/proposal/phase-1/plan-format.md`**

Amend the "Frontmatter fields" section (currently at line 21) and the "Frontmatter key order" section (currently at line 49) to document both shapes.

Add a new section (insert after the existing key-order section) titled `### Dual-read window` containing:

- The two shapes are exclusive per document. A document carries either `worker` (legacy) or `deliverable` + `verify` (new), never both.
- A document carrying both raises `frontmatter-invalid` on the issue path `deliverable`.
- A document carrying neither raises `frontmatter-invalid` on the issue path `deliverable`.
- A document carrying `deliverable` and no `verify` raises `frontmatter-invalid` on the issue path `verify`.
- `verify` is required in the new shape and may be `{ paths: [], commands: [] }`.
- The dual-read window closes at EPIC 057, which removes the `worker` field.

Update the "Frontmatter key order" section at line 49 to state both orders:

- Legacy shape (worker): `id`, `kind`, `title`, `depends_on`, `worker`, `repo`. An absent field is omitted.
- New shape (deliverable): `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`. An absent field is omitted. `depends_on` moves after `repo` in the new shape.

Add a new section titled `### verify block` containing:

- The `verify` block is a nested YAML structure with exactly two keys: `paths` (list of repository-relative paths) and `commands` (list of shell strings).
- An empty list renders as `  paths: []` on one line.
- A non-empty `paths` list renders as one `    - <quoted-path>` line per entry.
- A non-empty `commands` list renders as one `    - <quoted-command>` line per entry.
- Paths are sorted bytewise; commands preserve author order.

**`docs/proposal/phase-2/deliverables-and-pairs.md`**

This file is created by EPIC 047 Story 9. Append a new section titled `## Conversion` to the end of the file.

The `## Conversion` section contains:

**Conversion table** (markdown table with Source and Result columns):

| Source                    | Result                        |
| ------------------------- | ----------------------------- |
| `worker: claude.te@1`     | `deliverable: test`           |
| `worker: claude.swe@1`    | `deliverable: implementation` |
| `kind: initiative`        | `deliverable: expansion`      |
| `kind: objective`         | `deliverable: expansion`      |
| `**Input:**` path in body | one `verify.paths` entry      |

Notes:

- A `kind` rule wins over a `worker` rule. Every objective converts to `expansion` unconditionally.
- A `worker` value outside the two rows is a CLI refusal (`worker-unmapped`), not a conversion reason. `plan convert` refuses and names the path; the output directory stays empty.
- An initiative and an objective take `paths: []` and `commands: []`.

**Manual reasons** (bulleted list of all six values):

- `command-failed` — a generated command exited non-zero at its intended commit.
- `input-ambiguous` — the body holds two or more `**Input:**` lines.
- `input-missing` — the body holds no `**Input:**` line.
- `template-missing` — no template entry for the node's repository.
- `test-dependency-ambiguous` — an implementation node depends on two or more test nodes.
- `test-dependency-missing` — an implementation node depends on no test node.

**Template format**: The `--template <file>` argument reads a JSON object mapping repository name to a template string. The template string must contain exactly one `{path}` placeholder. The converter replaces `{path}` with the node's `verify.paths` entry verbatim.

**Command validation rule**: Every generated command runs at its intended commit (specified by `--at <name>=<ref>`) in a temporary checkout before being written. A command that exits non-zero is dropped; the node takes `commands: []` and the reason `command-failed`. A generated command never reaches a document unvalidated.

**Report schema**: `convert-report.json` holds one JSON object with key `"nodes"` (array). Each node entry has keys (bytewise order): `"deliverable"` (string or null), `"manualReasons"` (array of strings sorted by index in `manualReasons` tuple), `"sourcePath"` (string, relative to the input directory root), `"verify"` (object with keys `"commands"` and `"paths"`). The file ends with one newline. Two-space indentation.

**Idempotence statement**: `plan convert` run twice over the same legacy input tree, into two separate empty output directories, writes byte-identical documents and a byte-identical report.

**Dual read closure**: The `worker` field in a plan document is a transitional form. EPIC 057 removes it from `planFrontmatter`, `planFrontmatterKeys`, and all rendering paths.

## Constraints

- Do not rewrite existing content in either file. Append and amend only the sections stated above.
- Do not create new files. `deliverables-and-pairs.md` was created by EPIC 047.
- The conversion table in the proposal must match the table in the EPIC exactly — no extra rows.

## Verify

```
pnpm run verify
```

Assert `pnpm run verify` exits 0 after all story files exist. No automated test covers the proposal doc content; correctness is verified by human review.

Proof: No PASS line in the test proof is gated on this story. `pnpm run verify` exits 0 (it passes if all prior stories pass). This story is a documentation obligation and has no test artifact.
