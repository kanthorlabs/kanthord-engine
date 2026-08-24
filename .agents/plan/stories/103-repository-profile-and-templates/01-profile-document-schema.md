# Story 1 — The `kanthord.profile/v1` schema and the finding list

Epic: `.agents/plan/epics/103-repository-profile-and-templates.md`
Depends on: EPIC 102 (sequence order), and coupled Story 2. `profile-document.ts` imports `profileChecks` from `src/domain/profile-check.ts`, so write both files before running either test file.

## Change

- Add `src/domain/profile-finding.ts`. It imports `comparePaths` from `./plan-path.ts` and nothing else.
- Export `profileFindingCodes` as an `as const` tuple holding exactly these fifteen codes in this order: `body-preamble-unexpected`, `check-cannot-fail`, `check-missing`, `check-name-invalid`, `check-run-empty`, `check-run-invalid`, `check-timeout-invalid`, `document-unparsable`, `frontmatter-invalid`, `role-heading-duplicated`, `role-heading-unknown`, `schema-unknown`, `template-digest-mismatch`, `template-unknown`, `template-version-unknown`.
- Export `ProfileFindingCode = (typeof profileFindingCodes)[number]`.
- Export `ProfileFinding = Readonly<{ code: ProfileFindingCode; locator: string | null; message: string }>`.
- Export `sortProfileFindings(findings: readonly ProfileFinding[]): readonly ProfileFinding[]`. Copy the non-mutating shape of `sortFindings` at `src/domain/plan-finding.ts:39-50`: spread into a new array, then sort.
- Order by `comparePaths(left.code, right.code)` first. When that returns `0`, order by locator: two nulls are equal, a null sorts first, otherwise `comparePaths(left.locator, right.locator)`.
- Add `src/domain/profile-document.ts`. It imports `zod`, `./agent.ts` and `./profile-check.ts` only.
- Export `profileSchemaLiteral = "kanthord.profile/v1"`.
- Export `profileTemplateRef = z.strictObject({ id: z.string().min(1), version: z.string().min(1), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) })`. Declare the regex literally in this file; do not import `blobHash`.
- Export `profileFrontmatter = z.strictObject({ schema: z.literal(profileSchemaLiteral), template: profileTemplateRef, checks: profileChecks })`, where `profileChecks` is the schema Story 2 exports from `src/domain/profile-check.ts`.
- Use `z.strictObject` so a fourth frontmatter key fails the parse.
- Declare three distinct types. They are separate on purpose: the zod output is loose so a zod issue never pre-empts a finding, and the render input allows a null digest that a stored profile may not have.
- Export `RawProfileFrontmatter = z.infer<typeof profileFrontmatter>`. Its `checks` values are `{ run: unknown[]; timeout: unknown }`, the loose shape of Story 2. This is the parse output only.
- Export `ProfileFrontmatter = Readonly<{ schema: typeof profileSchemaLiteral; template: Readonly<{ id: string; version: string; digest: string }>; checks: Readonly<Record<string, ProfileCheck>> }>`, the validated shape, where `ProfileCheck` is `Readonly<{ run: readonly string[]; timeout: string }>` from Story 2. A value of this type exists only after `validateChecks` returned no finding, and `digest` is never null here.
- Export `narrowFrontmatter(raw: RawProfileFrontmatter): ProfileFrontmatter`. It is the one cast site: it asserts the already-validated shape and returns it. Every consumer takes `ProfileFrontmatter`, so no consumer handles `unknown`.
- Export `ProfileSection = Readonly<{ role: AgentKind; text: string }>` and `ProfileDocument = Readonly<{ frontmatter: ProfileFrontmatter; sections: readonly ProfileSection[] }>`, where `AgentKind` comes from `src/domain/agent.ts:7`.
- Export `RenderableProfile = Readonly<{ frontmatter: Readonly<{ schema: string; template: Readonly<{ id: string; version: string; digest: string | null }>; checks: Readonly<Record<string, ProfileCheck>> }>; sections: readonly ProfileSection[] }>`. `ProfileDocument` is assignable to it, and Story 5 builds the digest-free template payload as a `RenderableProfile` that is not a `ProfileDocument`.

## Constraints

- Do not import `src/domain/plan-finding.ts`; the two code lists stay separate.
- Do not import `src/domain/blob.ts`; `profile-document.ts` declares its own digest regex.
- Do not add a `path` or an `id` field to `ProfileFinding`; the only locator field is `locator`.
- Do not read a file, a clock or a random source; `src/domain/layout.test.ts:56-66` asserts every `src/domain/*.ts` file names no `Date.now(`, `new Date(` or `Math.random(`.

## Verify

- Add `src/domain/profile-finding.test.ts`. Assert `profileFindingCodes.length` equals `15` and `assert.deepEqual(profileFindingCodes, [...])` against the exact fifteen-code list above, in that order.
- Assert `sortProfileFindings` orders `{ code: "template-unknown", locator: null }` after `{ code: "check-cannot-fail", locator: "unit" }`, because `check-cannot-fail` sorts before `template-unknown` by code.
- Assert two findings of the same code sort a `null` locator before a non-null one, and sort `e2e` before `unit`.
- Assert `sortProfileFindings` returns a new array and leaves the input array order unchanged.
- Add `src/domain/profile-document.test.ts`. Assert a frontmatter holding `schema`, `template` and `checks` parses, and that adding a fourth key `owner` fails.
- Assert `schema` of `kanthord.profile/v2` fails the parse, and that a `template.digest` of `sha256:zz…` fails while a 64-lowercase-hex digest passes.
- Assert `template` with an extra key `source` fails.
- Assert `profileFrontmatter` accepts a `checks` entry whose `run` is `[]` and whose `timeout` is `10s`, because those are Story 2 findings and never zod issues.
- Run `node --test src/domain/profile-finding.test.ts src/domain/profile-document.test.ts` after Story 2 lands; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage line 64.
