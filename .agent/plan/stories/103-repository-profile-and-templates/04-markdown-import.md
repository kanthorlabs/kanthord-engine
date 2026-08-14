# Story 4 — Markdown import with its findings

Epic: `.agent/plan/epics/103-repository-profile-and-templates.md`
Depends on: Stories 1, 2 and 3.

## Change

- Add `src/domain/profile-parse.ts`. It imports `./profile-document.ts`, `./profile-check.ts`, `./profile-finding.ts`, `./plan-body.ts` and `./agent.ts`. It reads no document and imports no service.
- Export `ParseProfileResult = Readonly<{ document: ProfileDocument | null; template: Readonly<{ id: string; version: string; digest: string }> | null; findings: readonly ProfileFinding[] }>`.
- Export `parseProfile(frontmatter: unknown, body: string): ParseProfileResult`. Collect every finding and stop at none, like `validateDocuments` at `src/domain/plan-validate.ts:33-363`. Return `document: null` when the finding list is not empty.
- Return `template` as the parsed template triple whenever the **frontmatter** parsed, independently of any check finding or body finding, and `null` only when the frontmatter itself failed. Story 7 compares the triple against what the daemon ships, and it must be able to do so for a document that also carries `check-cannot-fail`. Hermetic coverage line 64 depends on exactly that: a document with an unknown template id **and** a `true` unit command returns both findings.
- Validate the frontmatter first. When it is an object holding a `schema` key whose value is a string other than `kanthord.profile/v1`, push `schema-unknown` with `locator` `null` and validate no further key.
- Otherwise parse the frontmatter through `profileFrontmatter` of `src/domain/profile-document.ts`. Push one `frontmatter-invalid` finding per zod issue, with `locator` equal to the issue path joined by `.`, or `null` when the path is empty.
- When the frontmatter parse succeeded, call `validateChecks` of `src/domain/profile-check.ts` on its `checks` map and append every finding it returns.
- Normalize the body through `normalizeBody` of `src/domain/plan-body.ts:21-24`, so CRLF and a lone CR become LF and the body ends with exactly one LF.
- Split the normalized body on every line that begins with the three characters `## `. A heading line is one whose start is at index `0` or immediately after an LF.
- Read the heading text as the remainder of the heading line after `## `, with no trimming, so `## swe@2` yields the locator `swe@2`.
- Take the text before the first heading. Strip its leading and trailing LF characters. When the result is not the empty string, push `body-preamble-unexpected` with `locator` `null`.
- For each heading whose text is not a member of `agentKinds` of `src/domain/agent.ts:3`, push `role-heading-unknown` with the heading text as `locator`, and add no section.
- For each role that a legal heading names more than once, push `role-heading-duplicated` with the role as `locator` once per repeat occurrence, and keep the first occurrence only.
- Build the section text as the body between the end of the heading line and the start of the next heading line, or the end of the body. Strip leading LF characters and trailing LF characters only. Never strip a space or a tab, so a Markdown hard line break survives.
- Return the sections ordered by the index of their role in `agentKinds`, so the parse result feeds `renderProfile` directly.
- Return `sortProfileFindings` of the collected list.
- Use these exact messages, so every finding shape is pinned and none is invented at build time: `schema-unknown` — `the document declares schema <value>`; `frontmatter-invalid` — `the frontmatter is invalid at <locator or "the document root">`; `body-preamble-unexpected` — `the body holds prose before the first role heading`; `role-heading-unknown` — `<heading> is not a role`; `role-heading-duplicated` — `role <role> appears more than once`.
- Do not build `document-unparsable` here. `src/commands/profile/import-profile.ts` of Story 7 catches `DocumentError` of `src/services/document/index.ts:11-19` and builds that finding, because `DocumentError` belongs to a service.

## Constraints

- Do not call `DocumentReader.read`; the caller supplies the already-read frontmatter value and body.
- Do not stop at the first finding. A human who edits a profile by hand gets one round trip.
- Do not treat a line starting with `###` as a role heading; the split is on `## ` exactly.
- Do not trim spaces from a section text or a heading text.

## Verify

- Add `src/domain/profile-parse.test.ts`.
- Assert a body listing `re@1` before `general@1` returns sections ordered `general@1` then `re@1`.
- Assert a body heading `## swe@2` returns `role-heading-unknown` with locator `swe@2`.
- Assert a body holding prose before the first role heading returns `body-preamble-unexpected` with locator `null`.
- Assert a body repeating `## swe@1` returns `role-heading-duplicated` with locator `swe@1`, and keeps one section.
- Assert a frontmatter whose `schema` is `kanthord.profile/v2` returns exactly one finding, `schema-unknown`.
- Assert a frontmatter carrying a fourth key `owner` returns `frontmatter-invalid`.
- Assert a frontmatter with a `checks` map holding a `true` unit command returns `check-cannot-fail` with locator `unit`.
- Assert a document with an unknown template id and a `true` unit command returns `check-cannot-fail`, produces no template finding of its own, and still returns a non-null `template` holding the unknown id, so Story 7 can add `template-unknown`.
- Assert `template` is `null` when the frontmatter fails to parse, and non-null when the frontmatter parses but a body finding exists.
- Assert a body written with CRLF line endings yields the same sections as the LF form, compared with `Buffer.compare`.
- Assert a section text keeps a line with two trailing spaces.
- Assert `parseProfile` returns `document: null` whenever the finding list is not empty, and a non-null document with an empty finding list for a valid input.
- Add a round-trip assertion: `renderProfile(parseProfile(frontmatter, body).document!)` of a canonically rendered document returns the identical string, compared with `Buffer.compare` equal to `0`, including a case whose role prose is non-ASCII.
- Run `node --test src/domain/profile-parse.test.ts`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 66, 67, 68 and 69.
