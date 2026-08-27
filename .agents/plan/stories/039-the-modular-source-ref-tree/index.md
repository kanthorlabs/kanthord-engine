# EPIC 039 — The modular `$ref` tree — stories

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Prereq: EPIC 038 (sequence order), and EPIC 037 for the `x-kanthord-event-payloads` root extension.

`npm run contract:publish` writes a second, modular form of the contract under `source/`, built from
external `$ref`: a root, one fragment per feature, one file per component group. The self-contained
master and slices stay, and their bytes stay.

## Dispatch order

1. `01-the-proposal-states-two-forms-and-the-component-files.md` — the two proposal amendments,
   `src/http/contract/openapi-source.ts`, and the 15 component files.
2. `02-the-feature-operation-fragments.md` — the 19 operation fragments.
3. `03-the-modular-root-and-the-publish.md` — the modular root, and the publish script writes the
   tree.
4. `04-the-bundle-equivalence-test.md` — `scripts/publish-contract.source.test.ts`: bundle,
   dereference-equivalence, validate.
5. `05-the-containment-and-reproducibility-tests.md` — reference containment, two-emission byte
   equality, and the self-contained forms stay self-contained.
6. `06-the-manifest-names-the-modular-form.md` — the `source` manifest field.

Stories 1, 2 and 3 are strictly sequential: each adds entries to the map the previous one left, and
none rewrites a line an earlier one wrote. Story 4 needs Story 3, because it reads a published
`source/` tree. Story 5 extends Story 4's file. Story 6 needs Story 3 only, so it may land any time
after it.

There is no coupled pair. Each story passes `npm run verify` on its own.

**Six stories cover the EPIC's six story bullets, one to one.** No bullet is split and none is
merged.

**Four stories cross both lanes and two are test-only.** Stories 1, 2, 3 and 6 edit a production
source or a proposal file **and** a `*.test.ts`, so each is a normal test-engineer /
software-engineer pair. Stories 4 and 5 add or extend `scripts/publish-contract.source.test.ts` only,
which `scripts/lane-check.sh:87-93` grants to the test-engineer and denies to the software-engineer.

**The EPIC's central risk was measured before these stories were written, not assumed.** A prototype
of the whole tree was built against today's registry and run through `@apidevtools/swagger-parser`
12.1.0. It emitted 15 component files; `SwaggerParser.bundle` on the modular root left no external
reference (the stories assert this by walking every reference, not by the substring search the
prototype used); `parser.$refs.circular` was `false`; the two dereferenced documents were deep-equal under the
EPIC's three-part normalisation; and `SwaggerParser.validate` passed on the modular root. Every
number and every reference form in these stories is a measurement.

## Stories

- 1 — two proposal amendments, `buildOpenApiSourceTree`, and `source/components/*.yaml` →
  `01-the-proposal-states-two-forms-and-the-component-files.md`
- 2 — `source/features/<feature>.yaml`, keyed by `operationId` →
  `02-the-feature-operation-fragments.md`
- 3 — `source/openapi.yaml`, and `scripts/publish-contract.ts` writes the tree →
  `03-the-modular-root-and-the-publish.md`
- 4 — `scripts/publish-contract.source.test.ts`: bundle, dereference-equivalence, validate →
  `04-the-bundle-equivalence-test.md`
- 5 — containment, reproducibility, and the self-contained forms →
  `05-the-containment-and-reproducibility-tests.md`
- 6 — `manifest.json` gains `source` → `06-the-manifest-names-the-modular-form.md`

## Two items Ulrich settled, and the EPIC now carries

Both were raised when these stories were written and both were settled on 2026-08-27. The EPIC and
`AGENTS.md` were amended the same day, so nothing here blocks dispatch. They stay recorded because a
reviewer holding an older copy would otherwise read the current text as a deviation.

- B1 - status:FIXED - action:YES - the exact-bytes gate bullet contradicted the no-committed-document
  rule - The gate demanded "The test holds the exact bytes and compares them with `Buffer.compare`"
  for `openapi.yaml` and for a slice. `docs/proposal/api/README.md:19` forbids committing a generated
  document, and an inline literal of a 142-schema document is that artifact under another name.
  - fix:The gate bullet now requires the published master to be compared against
    `renderOpenApiYaml()` and each slice against `renderOpenApiYaml(feature.operations)`, both with
    `Buffer.compare`, **and** requires that no story of the epic edits
    `src/http/contract/openapi.ts`, any module it reads, or `src/domain/version.ts`. Story 5 test 7
    delivers the first half; every story's scope check delivers the second. - why:The renderer cannot
    move, so its output cannot move — that is what the held literal was reaching for, and it is
    provable without one.

  `scripts/publish-contract.test.ts:434-437` already makes the same renderer-agreement assertion for
  the master, so Story 5 extends an existing convention rather than inventing one. The scope check
  covers the whole transitive renderer input — `src/domain` plus every non-test module under
  `src/http/contract/` — and not the five obvious modules alone, because a per-domain zod module such
  as `src/http/contract/node.ts` moves the master bytes just as surely.

- S3 - status:FIXED - action:YES - `AGENTS.md` named one publication form - The bullet is at `:107`,
  not the `:105` the EPIC's open item cited, and it already named the `source/` tree. It did not
  state the two properties a reviewer needs to read the tree as conforming. - fix:The bullet now ends
  "… beside the self-contained forms and never in place of them; its bundle reproduces the master,
  and every reference in it stays inside the publication directory." Ulrich applied it, because
  `scripts/lane-check.sh:43` denies `AGENTS.md` to every agent lane and no story may carry the edit.
  - why:A reviewer reads `AGENTS.md` as the structural contract, and an incomplete bullet made the
    `source/` tree look like a violation of it.

## One open item

- **The EPIC does not mention the assertion it breaks.**
  `scripts/publish-contract.test.ts:75-80` asserts the top-level publication listing deep-equals
  `["examples", "features", "manifest.json", "openapi.yaml"]`. Story 3 writes `source/` and that
  assertion fails. Story 3 names the repair — add `"source"` in bytewise position, after
  `"openapi.yaml"` — and forbids loosening the assertion. The EPIC's story bullet 3 names only
  `scripts/publish-contract.ts`, so an implementer following the EPIC alone would meet this as a
  surprise at `npm run verify` time.

## The debate pass

These stories were run through the adversarial debate engine after they were written. Twelve of its
thirteen objections were valid and are merged: the exact-bytes resolution was raised from an open
note to blocker B1; Story 3's root builder now **refuses** an unknown root key instead of passing it
through generically, and asserts every catalogue value by its exact derived string instead of by a
regex; Story 4 proves "no external reference" by walking every reference rather than by searching for
the substring `.yaml#`, and reads `$refs.circular` from an instance **bundle**; Stories 4 and 5 no
longer instruct the test-engineer to mutate a production file they may not touch, and mutate a
scratch copy of the published output instead; Story 5 gained a real RED step (a pure `classifyRef`
against synthetic references), the missing `YAML` and `statSync` imports, and exact derived counts in
place of the `> 140` and `> 70` thresholds `AGENTS.md` forbids; Story 6's "if that subtest exists and
is unfiltered" conditional became an unconditional subtest; and both hand-verify blocks now state
that `npm run contract:publish` refuses a dirty tree.

The one objection set aside: "land EPIC 037 and EPIC 038 before finalising these stories."
`/author` explicitly permits authoring ahead of N-1, and every 037-dependent instruction here either
derives from the master document at run time or fails loudly when the prerequisite is absent.

## Facts (needed for implementation)

- **The two prefix rules are the same rule over two different name spaces, and they give two
  different counts.** `openApiFeatures` cuts an `operationId` at the first `.` and yields **19**
  features. The component rule cuts a **schema name** at the first `.` and yields **14** prefixes,
  plus `security.yaml`, so **15** component files. Both counts are correct and neither is a typo.
  The 14 are `Error`, `actor`, `blob`, `edge`, `event`, `lease`, `node`, `outcome`, `plan`,
  `project`, `provider`, `recovery`, `repository`, `system`. The two sets overlap in ten names and
  neither contains the other. Nine feature names name no component file — `agent`, `attempt`,
  `binding`, `gitOperation`, `instructions`, `profile`, `run`, `template`, `worker` — because their
  operations are `stubbed` and emit no schema. Four component prefixes name no feature — `Error`,
  `lease`, `outcome`, `recovery` — because they come from the error envelope and the event payload
  catalogue rather than from an `operationId`.

- **`buildOpenApiDocument()` emits 142 schemas today**: `Error`, the 37 event payloads, and 104
  per-operation `.request` / `.response` / `.error` schemas. `components.schemas` is sorted bytewise
  at `openapi.ts:92-95`, so every group is already in order and no story re-sorts one.

- **The 37 event payload schemas add no component file.** Their nine prefixes — `actor`, `lease`,
  `node`, `outcome`, `plan`, `project`, `provider`, `recovery`, `repository` — are all already among
  the 14. `node.yaml` is the largest file at 39 schemas; `blob.yaml`, `outcome.yaml` and `Error.yaml`
  hold one each.

- **Every `$ref` in the master lives inside a path object; no schema body holds one.** Measured:
  `JSON.stringify(document.components.schemas)` contains zero `$ref`, and
  `JSON.stringify(document.paths)` contains 105 distinct ones, every one of the form
  `#/components/schemas/<name>`. Story 1's rewrite over a component body is therefore a no-op today.
  It is still required, because Story 2 applies the same helper to the operation objects, where every
  reference lives.

- **Bytewise order puts `components/Error.yaml` first.** `E` is `0x45`; every other prefix starts
  lower-case. `compareBytewise` at `openapi.ts:216-218` is the comparator, and it uses
  `Buffer.compare`, not `localeCompare`.

- **The exact bytes of `source/components/security.yaml`**, measured:

  ```yaml
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
  ```

  Four lines, one trailing `\n`. It is the file Story 1 asserts byte-exactly.

- **The exact reference line Story 2 asserts**, measured, at fourteen spaces of indentation:

  ```yaml
  $ref: ../components/actor.yaml#/schemas/actor.list.response
  ```

- **An operation-level `$ref` is not valid OpenAPI 3.0 by position, and `SwaggerParser.validate`
  passes it anyway.** An OpenAPI 3.0 Operation Object declares no `$ref` member, and
  `source/openapi.yaml` puts one at `paths.<path>.<method>`. `SwaggerParser.validate` resolves every
  reference before it validates, so it sees the joined document. This was measured, not assumed. A
  position-aware spec linter would object, and adopting one is a decision outside this epic.

- **`SwaggerParser.bundle` and `SwaggerParser.dereference` as static calls expose no `$refs`.** The
  circularity assertion needs the instance form: `const parser = new SwaggerParser(); await parser.dereference(root); parser.$refs.circular`.
  Measured `false` on the prototype.

- **The case-collision refusal is reachable from a test.** A synthetic single-operation registry with
  `operationId: "error.list"` and a `response` schema yields both `Error` and `error.list.response`,
  so the prefixes `Error` and `error` both appear and both fold to `error`. Measured: 39 schemas, 11
  prefixes, both present. `Operation` is a plain readonly object type at
  `src/http/contract/operation.ts:33-48`, so the fixture is an object literal cast through
  `as unknown as Operation`.

- **Two publish-test subtests already cover the `source/` tree with no edit.** The reproducibility
  subtest at `scripts/publish-contract.test.ts:285-310` and the released-versus-unreleased subtest at
  `:344-379` both iterate the returned `written` list and compare bytes per entry, so Story 3's
  pushed `source/...` entries enter both for free.

- **`written` carries the `source/` prefix; the map key does not.**
  `buildOpenApiSourceTree` returns `components/actor.yaml`; `publishContract` pushes
  `source/components/actor.yaml`. The two reproducibility subtests read
  `readFileSync(join(directory, relative))`, so a missing prefix reads the wrong path.

- **`@apidevtools/swagger-parser` is already a dev dependency at `package.json:39`, version
  `12.1.0`.** `scripts/publish-contract.test.ts:4` and `src/http/contract/openapi.test.ts:5` already
  import it. `src/http/contract/openapi.test.ts:585-600` scans every non-test `.ts` under `src/` and
  fails if a production source names the package, so `src/http/contract/openapi-source.ts` must never
  import it.

- **A contract source may import `yaml`.** `src/http/contract/openapi.ts:1` already does, so
  `openapi-source.ts` inherits the permission from the same `no-restricted-imports` glob. It needs
  `yaml`, `./openapi.ts`, `./operation.ts` and `./registry.ts`, and nothing else.

- **The line numbers in Stories 1 and 6 are today's, and EPIC 037 moves them.** EPIC 037 Story 5
  rewrites `docs/proposal/api/README.md:13-21`, and `npm run verify` runs
  `prettier --write … docs …` (`package.json:25,28`), which reflows a paragraph. Every proposal edit
  in these stories therefore quotes the sentence it anchors to. **Find the quoted text, not the
  number, if the two disagree.**

- **The EPIC anchors `docs/proposal/api/README.md:20`, and line 20 is blank.** The paragraph the EPIC
  means is today line 21, opening `` `npm run verify` generates the master document ``. Story 1
  amends that paragraph and inserts the layout block after it. `README.md:30` is exact: it is the
  `manifest.json` bullet Story 6 amends.

- **Lane boundaries, from `scripts/lane-check.sh`.** `src/**/*.test.ts` and `scripts/*.test.ts` are
  the test-engineer (`:77-86`, `:87-93`). `src/**/*.ts` non-test, `scripts/*.ts` non-test and
  `docs/proposal/*` are the software-engineer (`:77-86`, `:91`, `:99-101`). `.agents/plan/*` is
  denied to every lane (`:36`), so no story edits a plan file, and `AGENTS.md` is denied (`:43`),
  which is why the EPIC's own `S1` is a suggestion for Ulrich rather than a story.

- **Other agents hold work in this worktree.** Every scope check in these stories names its paths —
  `git diff --name-only HEAD -- <paths>` — rather than reading a bare diff. **Never use the stash.**
  The stash stack is shared with the main checkout and every other worktree.

- **`npm run verify` is `format && typecheck && test && lint && verify-db-status`**
  (`package.json:28`), and `format` is `prettier --write src test scripts docs eslint.config.js`
  (`package.json:25`). Each story that edits a proposal file runs prettier itself, so the committed
  bytes are the bytes `verify` produces.
