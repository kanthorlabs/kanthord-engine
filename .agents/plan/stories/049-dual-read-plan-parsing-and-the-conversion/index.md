# EPIC 049 — Dual-read plan parsing and the conversion — stories

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Prereq: EPIC 048 (sequence order). EPIC 047 must be implemented before any story in this epic runs — its outputs (`src/domain/deliverable.ts`, `src/domain/node-pair.ts`, `src/domain/verify-block.ts`, `docs/proposal/phase-2/deliverables-and-pairs.md`) are imported by Stories 1, 3, 4, 6, and 10.

A plan document carries `deliverable` and `verify`; the legacy `worker` field still parses; and `plan convert` produces a converted document set with a canonical report.

## Dispatch order

Stories 1 and 2 are independent and can run concurrently. Story 3 depends on Stories 1 and 2. Story 4 depends on Story 1. Story 5 depends on Stories 1 and 4. Stories 6 and 7 form a coupled pair — implement Story 7 directly after Story 6 in the same unit. Story 8 depends on Stories 6 and 7. Story 9 depends on Stories 4 and 8. Story 10 depends on all prior stories.

## Stories

- 1 — Frontmatter accepts both shapes → `01-frontmatter-dual-shape.md`
- 2 — Two finding codes → `02-two-finding-codes.md`
- 3 — Validation applies pair and verify block → `03-validation-pair-and-verify.md`
- 4 — Renderer emits new keys → `04-renderer-new-keys.md`
- 5 — Import and export round-trip the new shape → `05-import-export-round-trip.md`
- 6 — Conversion rule → `06-conversion-rule.md`
- 7 — Template file → `07-template-file.md`
- 8 — Command validation pass → `08-command-validation-pass.md`
- 9 — `plan convert` CLI → `09-plan-convert-cli.md`
- 10 — Proposal docs → `10-proposal-docs.md`

## Facts (needed for implementation)

- `src/domain/plan-document.ts:7-14` — `planFrontmatterKeys` is a module-private `Set` constructed inline; add `"deliverable"` and `"verify"` to it.
- `src/domain/plan-document.ts:16-36` — `planFrontmatter` uses `.passthrough().superRefine(...)` to reject unknown keys; the mutual-exclusivity rule must be added as a second `.superRefine`.
- `src/domain/plan-document.ts:38-49` — `ParsedDocument` is a `Readonly<{...}>` type alias; add `deliverable: Deliverable | null` and `verify: VerifyBlock | null`. `derivedParentPath: string | null` is already present at line 46.
- `src/domain/plan-finding.ts:6-31` — `findingCodes` is a `string[]` declared `as const` in bytewise order; current count is 24. Insert `"pair-illegal"` before `"parent-missing"` (position 15) and `"verify-invalid"` before `"worker-unknown"` (position 25). New count: 26.
- `src/domain/plan-finding.ts:42-67` — `findingScope` is a `Record<FindingCode, ValidationScope>` map; add both new codes with scope `"structural"`.
- `src/domain/plan-render.ts:6-15` — `RenderInput` is a `Readonly<{...}>` type alias.
- `src/domain/plan-render.ts:17` — `quoteScalar` escapes `\`, `"`, `\n`, `\r`, `\t`, and control chars.
- `src/domain/plan-render.ts:41-61` — `renderDocument` builds lines array; current key order: `id`, `kind`, `title`, `depends_on` (if any), `worker` (if any), `repo` (if any). New-shape order: `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`. Legacy order unchanged.
- `src/commands/plan/import-plan.ts:454-467` — NodeWrite array assembled here; add `deliverable` and `verifyJson` fields from `ParsedDocument`.
- `src/cli/plan/convert.ts` — already exists as a harness-plan converter (epics→plan docs). Story 9 must rename its Commander registration from `"convert"` to `"convert-harness"` before adding the new `plan convert`.
- `src/cli/plan/convert.test.ts` — already exists for the harness converter; Story 9 renames it to `convert-harness.test.ts`.
- `src/domain/deliverable.ts`, `src/domain/node-pair.ts`, `src/domain/verify-block.ts` — all greenfield in EPIC 047, all required before this epic.
- `manualReasons` tuple has exactly six elements: `"command-failed"`, `"input-ambiguous"`, `"input-missing"`, `"template-missing"`, `"test-dependency-ambiguous"`, `"test-dependency-missing"`. `worker-unmapped` is a CLI refusal, not a conversion reason.
- Hermetic git fixture from EPIC 005: `export function seedRepositories(tools: GitTools): SeedRoot` at `test/helpers/remote/seed.ts:124`. Use `resolveTools(process.env, ["git"])` from `test/helpers/remote/tools.ts:102` to get `Tools<"git">`, which satisfies the `GitTools` shape expected by `seedRepositories`. The resulting `SeedRoot` holds `repositories["fixture.git"].path` (bare repo path) and `repositories["fixture.git"].head` (HEAD commit SHA). Stories 8 and 9 use this fixture for hermetic subprocess tests.
- `eslint.config.js:240-263` — the `node:child_process` process-creation exemption list currently names `src/services/git/launcher.ts` and test files. Story 8 adds `src/services/verify/node-spawn.ts` to the `ignores` array of that block. The `cli/` ban at `eslint.config.js:374-400` explicitly lists `node:child_process` as forbidden in `src/cli/**/*.ts`; Story 8's modules live in `src/services/verify/`, not `src/cli/`.
- `src/services/verify/index.ts:22` — `VerifyErrorCode` is currently `"not-implemented"`; Story 8 adds `"process-unavailable"`.
