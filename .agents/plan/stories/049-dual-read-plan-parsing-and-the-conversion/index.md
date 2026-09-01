# EPIC 049 — Dual-read plan parsing — stories

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Prereq: EPIC 048 (sequence order). EPIC 047 must be implemented before any story in this epic runs — its outputs (`src/domain/deliverable.ts`, `src/domain/node-pair.ts`, `src/domain/verify-block.ts`, `docs/proposal/phase-2/deliverables-and-pairs.md`) are imported by Stories 1, 3, 4 and 6.

A plan document carries `deliverable` and `verify`, and the legacy `worker` field still parses. The two shapes are exclusive: a document names one of them, or neither, and never both.

## Dispatch order

Stories 1 and 2 are independent and can run concurrently. Story 3 depends on Stories 1 and 2. Story 4 depends on Story 1. Story 5 depends on Stories 1 and 4. Story 6 depends on all prior stories.

## Stories

- 1 — Frontmatter accepts both shapes → `01-frontmatter-dual-shape.md`
- 2 — Two finding codes → `02-two-finding-codes.md`
- 3 — Validation applies pair and verify block → `03-validation-pair-and-verify.md`
- 4 — Renderer emits new keys → `04-renderer-new-keys.md`
- 5 — Import and export round-trip the new shape → `05-import-export-round-trip.md`
- 6 — Proposal docs → `06-proposal-docs.md`

## Facts (needed for implementation)

- `src/domain/plan-document.ts:7-14` — `planFrontmatterKeys` is a module-private `Set` constructed inline; add `"deliverable"` and `"verify"` to it.
- `src/domain/plan-document.ts:16-36` — `planFrontmatter` uses `.passthrough().superRefine(...)` to reject unknown keys; the mutual-exclusivity rule must be added as a second `.superRefine`.
- `src/domain/plan-document.ts:38-49` — `ParsedDocument` is a `Readonly<{...}>` type alias; add `deliverable: Deliverable | null` and `verify: VerifyBlock | null`. `derivedParentPath: string | null` is already present at line 46.
- `src/domain/plan-finding.ts:6-31` — `findingCodes` is a `string[]` declared `as const` in bytewise order; current count is 24. Insert `"pair-illegal"` before `"parent-missing"` (position 15) and `"verify-invalid"` before `"worker-unknown"` (position 25). New count: 26.
- `src/domain/plan-finding.ts:42-67` — `findingScope` is a `Record<FindingCode, ValidationScope>` map; add both new codes with scope `"structural"`.
- `src/domain/plan-render.ts:6-15` — `RenderInput` is a `Readonly<{...}>` type alias.
- `src/domain/plan-render.ts:17` — `quoteScalar` escapes `\`, `"`, `\n`, `\r`, `\t`, and control chars.
- `src/domain/plan-render.ts:41-61` — `renderDocument` builds lines array; current key order: `id`, `kind`, `title`, `depends_on` (if any), `worker` (if any), `repo` (if any). New-shape order: `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`. Legacy order unchanged.
- The shipped legacy format puts `worker` on a task only, and `worker` is nullable in the `node.create` request for every kind. A document naming neither `worker` nor `deliverable` is therefore normal, and `planFrontmatter` accepts it.
- `src/commands/plan/import-plan.ts:454-467` — NodeWrite array assembled here; add `deliverable` and `verifyJson` fields from `ParsedDocument`.
- `src/domain/deliverable.ts`, `src/domain/node-pair.ts`, `src/domain/verify-block.ts` — all greenfield in EPIC 047, all required before this epic.
