# Story 5 — The `nodejs` template

Epic: `.agent/plan/epics/103-repository-profile-and-templates.md`
Depends on: Stories 1, 2 and 3.

## Change

- Add `src/domain/profile-template.ts`. It imports `./profile-document.ts` and `./profile-render.ts` only.
- Export `NODEJS_TEMPLATE_ID = "nodejs"` and `NODEJS_TEMPLATE_VERSION = "1.0.0"`.
- Export `nodejsTemplate` as data: `checks` declaring `unit` only, with `run` of `["npm", "test"]` and `timeout` of `10m`, and no `e2e` entry.
- Give it one section per role, in the `agentKinds` order, with exactly this text and no other: `general@1` — `Change the smallest number of files that satisfies the task.`; `swe@1` — `Keep every module inside the import boundaries the repository declares.`; `te@1` — `Write one test per behaviour, and assert an exact value.`; `re@1` — `Judge only the acceptance criteria of the task.`.
- Export `canonicalTemplatePayload: Uint8Array`, the bytes of `renderProfileBytes` over a `RenderableProfile` of Story 1 whose frontmatter carries `schema`, `template` and `checks`, and whose `template` map holds `id` and `version` with `digest` of `null`. It is a `RenderableProfile` and deliberately not a `ProfileDocument`, because a stored profile always carries a digest.
- The payload therefore omits `digest`, so the digest is never defined over bytes that hold it.
- Export `templateProfileDocument(digest: string): ProfileDocument`, which returns the same document with `digest` set on its `template` map. An instantiated profile document is that document, so it differs from the payload the digest covers.
- Export `knownTemplateIds = [NODEJS_TEMPLATE_ID] as const`.
- Compute no hash in this file. `BlobStore.hash` is a service, and `src/commands/profile/instantiate-profile.ts` of Story 7 computes the digest over `canonicalTemplatePayload` and produces `template-unknown`, `template-version-unknown` and `template-digest-mismatch`.

## Constraints

- Do not import `src/services/blob/index.ts` or any service.
- Do not add a second template; phase 2 ships one, and `template.list` and `template.show` stay `stubbed`.
- Do not put `digest` in `canonicalTemplatePayload`.
- Do not derive the payload at call time from a mutable object; export it as one frozen value computed once at module load.

## Verify

- Add `src/domain/profile-template.test.ts`.
- Assert `Buffer.from(canonicalTemplatePayload).includes(Buffer.from("digest", "utf8"))` is `false`.
- Assert `canonicalTemplatePayload` decodes to the exact expected document, written out as a template literal in the test, compared with `Buffer.compare` equal to `0`.
- Assert the decoded payload holds `## general@1`, `## swe@1`, `## te@1` and `## re@1` in that order, found by `indexOf` and asserted as a strictly increasing index sequence.
- Assert `nodejsTemplate` declares `unit` and declares no `e2e` key, with `assert.deepEqual(Object.keys(checks), ["unit"])`.
- Assert `nodejsTemplate.checks.unit.run` deep-equals `["npm", "test"]` and its `timeout` equals `10m`.
- Assert `validateChecks(nodejsTemplate.checks)` of Story 2 returns an empty array, so the shipped template passes its own lint.
- Assert `templateProfileDocument("sha256:" + "a".repeat(64))` renders a document whose bytes do hold `digest`, and that its frontmatter is otherwise identical to the payload.
- Assert the four role texts equal the four exact strings above.
- Run `node --test src/domain/profile-template.test.ts`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage line 52.
