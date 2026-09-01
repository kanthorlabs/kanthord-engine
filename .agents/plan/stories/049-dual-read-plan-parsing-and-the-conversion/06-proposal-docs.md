# Story 6 — Proposal records dual read

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Stories 1-5 (all implementation stories complete and passing)

## Change

**`docs/proposal/phase-1/plan-format.md`**

Amend the "Frontmatter fields" section (currently at line 21) and the "Frontmatter key order" section (currently at line 49) to document both shapes.

Add a new section (insert after the existing key-order section) titled `### Dual-read window` containing:

- The two shapes are exclusive per document. A document carries either `worker` (legacy) or `deliverable` + `verify` (new), never both.
- A document carrying both raises `frontmatter-invalid` on the issue path `deliverable`.
- A document carrying neither field is legal through the dual-read window. `worker` is nullable in the `node.create` request, so the daemon creates such a node itself. EPIC 057 closes the window and makes `deliverable` mandatory.
- A document carrying `deliverable` and no `verify` raises `frontmatter-invalid` on the issue path `verify`.
- `verify` is required in the new shape and may be `{ paths: [], commands: [] }`.
- The dual-read window closes at EPIC 057, which removes the `worker` field.

Update the "Frontmatter key order" section at line 49 to state both orders:

- Legacy shape (worker): `id`, `kind`, `title`, `depends_on`, `worker`, `repo`. An absent field is omitted.
- New shape (deliverable): `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`. An absent field is omitted. `depends_on` moves after `repo` in the new shape.

Add a new section titled `### verify block` containing:

- The `verify` block is a nested YAML structure with exactly two keys: `paths` (list of absolute paths, anchored at the repository root) and `commands` (list of shell strings). EPIC 047 fixed the grammar at `src/domain/verify-block.ts`: a path with no leading `/` is refused.
- An empty list renders as `  paths: []` on one line.
- A non-empty `paths` list renders as one `    - <quoted-path>` line per entry.
- A non-empty `commands` list renders as one `    - <quoted-command>` line per entry.
- Paths are sorted bytewise; commands preserve author order.

**`docs/proposal/phase-2/deliverables-and-pairs.md`**

This file is created by EPIC 047 Story 9. Amend the closing `## Legacy worker field` section only. Append one paragraph after the existing sentence:

The `worker` field in a plan document is a transitional form. A document carries either `worker` or `deliverable` + `verify`, never both, and EPIC 057 removes `worker` from `planFrontmatter`, `planFrontmatterKeys` and every rendering path. See [phase-1/plan-format.md](../phase-1/plan-format.md) for the two shapes.

Add no conversion section. `plan convert` is not part of this epic.

## Constraints

- Do not rewrite existing content in either file. Append and amend only the sections stated above.
- Do not create new files. `deliverables-and-pairs.md` was created by EPIC 047.

## Verify

```
pnpm run verify
```

Assert `pnpm run verify` exits 0 after all story files exist. No automated test covers the proposal doc content; correctness is verified by human review.

Proof: No PASS line in the test proof is gated on this story. `pnpm run verify` exits 0 (it passes if all prior stories pass). This story is a documentation obligation and has no test artifact.
