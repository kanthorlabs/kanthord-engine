# EPIC 038 — Validate every emitted document — stories

Epic: `.agents/plan/epics/038-validate-every-emitted-document.md`
Prereq: EPIC 037 (sequence order).

Every document the product emits — the master `openapi.yaml` and each of the 19 `features/*.yaml`
slices — passes `SwaggerParser.validate`, carries only `#/components/schemas/` references, and renders
to identical bytes twice. `manifest.json` names exactly the files the publisher wrote.

## Dispatch order

1. `01-every-slice-is-emitted-and-validated.md` — adds the emitter helper and replaces the master
   validation test.
2. `02-a-broken-slice-is-rejected.md` — two rejection tests beside it.
3. `03-no-emitted-document-holds-an-external-ref.md` — the `$ref` walk over all 20 documents.
4. `04-slices-reproduce-and-the-manifest-agrees.md` — per-slice byte equality, and the manifest gate in
   `scripts/publish-contract.test.ts`.

**The four stories are strictly sequential. Dispatch them 1, then 2, then 3, then 4.** Each story's
insertion anchor is the test the previous story added: Story 2 places its two tests after the test
Story 1 replaced, Story 3 places its test after the two tests Story 2 added, and Story 4's Edit 1 places
its test after the test Story 3 added. Landing them out of order leaves an anchor that does not exist,
which pushes the placement decision to build time. There is no coupled pair, and each story passes
`npm run verify` on its own.

Story 1 is first because it adds the `openApiFeatures` import all three later stories use and the
`emitEveryDocument` helper Story 3 calls. Story 4 is last because it is the only story that touches a
second file and the only one that completes the `PASS EPIC-038` line.

The four insertion points all sit between `"renders canonical yaml"` (`openapi.test.ts:531`) and
`"is never committed to the repository root"` (`:545`), so the block grows downward in story order and
no story rewrites a line an earlier one wrote.

**Four stories cover the EPIC's four story bullets, one to one.** No bullet is split and none is
merged.

**Every story is the test-engineer lane, and the software-engineer writes nothing in this epic.** All
five edits land in a `*.test.ts` file: `scripts/lane-check.sh:72-83` grants a `*.test.ts` under `src/`
to the test-engineer and denies it to the software-engineer, and `scripts/lane-check.sh:85-91` does the
same for a `*.test.ts` under `scripts/`. No story crosses the line, and no story has a GREEN step. Each
story states where its RED signal comes from instead.

**This epic changes no production file.** After all four stories land, the epic-wide scope check is:

```bash
git diff --name-only "$(git merge-base HEAD main)"..HEAD -- src scripts test docs
```

It must name exactly two files: `src/http/contract/openapi.test.ts` and
`scripts/publish-contract.test.ts`. Two details of that command are load-bearing.

- **The base is pinned to `git merge-base HEAD main`**, not left as a placeholder. Substitute the epic's
  actual base branch if it is not `main`; do not leave the choice to the agent running the check.
- **The check is path-scoped to `src scripts test docs`.** Other agents work in this tree concurrently
  and edit `.agents/plan/**`, so an unscoped `git diff --name-only` reports their work as well and
  cannot be asserted. Every per-story scope check is scoped the same way, with
  `git status --porcelain -- src scripts test docs`.

No single story can run the epic-wide check; run it once at the end. `renderOpenApiYaml()` therefore
returns the same string as before the epic, which is the EPIC's **The master's bytes are unchanged**
gate bullet. That bullet is discharged by reasoning from the diff, not by an assertion — it is the one
gate bullet no test covers, and no test can cover it without a committed golden file, which
`AGENTS.md:105` forbids.

## Stories

- 1 — the emitter helper, and `SwaggerParser.validate` over the master and all 19 slices →
  `01-every-slice-is-emitted-and-validated.md`
- 2 — the `system` slice missing `info.version`, and holding a dangling `$ref`, both rejected →
  `02-a-broken-slice-is-rejected.md`
- 3 — one walk over all 20 emitted files asserts every `$ref` starts `#/components/schemas/` →
  `03-no-emitted-document-holds-an-external-ref.md`
- 4 — two renders per slice compared by `Buffer.compare`, and two-way set equality between
  `manifest.json` and the publisher's returned file list →
  `04-slices-reproduce-and-the-manifest-agrees.md`

## Facts (needed for implementation)

Every number and every behaviour below was verified against the tree before the stories were written,
by rendering and validating all 20 documents. None is inferred from the EPIC.

- **The EPIC's counts are correct.** The registry holds 69 operations
  (`src/http/contract/registry.ts:25`), `openApiFeatures()` returns 19 features, 44 operations are
  `routed`, and 43 registry entries carry `examples`. The 19 feature names, in the bytewise order
  `openApiFeatures()` returns at `openapi.ts:35`, are `actor`, `agent`, `attempt`, `binding`, `blob`,
  `edge`, `event`, `gitOperation`, `instructions`, `node`, `plan`, `profile`, `project`, `provider`,
  `repository`, `run`, `system`, `template`, `worker`. Their operation counts are `actor:5 agent:1
attempt:1 binding:1 blob:1 edge:1 event:1 gitOperation:1 instructions:1 node:17 plan:4 profile:4
project:7 provider:8 repository:6 run:4 system:3 template:2 worker:1`, which sums to 69.

- **The EPIC's line numbers for `openapi.test.ts` are exact.** `:512` is `"refers to components only
through internal refs"`, `:531` is `"renders canonical yaml"`, `:539` is the master validation test
  Story 1 replaces, `:549` and `:561` are the two master rejection tests Story 2 mirrors, `:582` is the
  validator guard, and `collectRefs` occupies `:603-620`. The file is 620 lines. The EPIC's references
  to `:558` and `:579` are lines _inside_ the tests at `:549` and `:561`, not test openings — cite the
  test names, not those two numbers.

- **All 19 slices already validate.** `SwaggerParser.validate` accepts each
  `renderOpenApiYaml(feature.operations)` document. No slice needs a fixture, a stub or a repair. Story
  1 therefore has no failing product state to fix.

- **No slice emits zero `$ref`.** The master emits 129 `$ref` values and the 19 slices emit 129 between
  them. Every value begins `#/components/schemas/`. This is why Story 3 asserts the non-zero count per
  document as well as in aggregate — a per-document assertion is available and is strictly stronger.

- **Every slice renders byte-identically across two calls**, including the master. Story 4's loop
  cannot be satisfied vacuously and needs no tolerance.

- **`system` is the only slice that carries `/v1/health`.** Its three path keys are `/v1/db/status`,
  `/v1/health` and `/v1/status`, and `/v1/health` carries the single method `get`. That is why Story 2
  uses the `system` slice: the dangling-`$ref` mutation path is identical to the master test's path at
  `openapi.test.ts:567-577`. Both mutations were confirmed to reject, the second with
  `Missing $ref pointer "#/components/schemas/missing". Token "missing" does not exist.`

- **`publishContract` returns `readonly string[]`** — the relative paths written, sorted bytewise at
  `scripts/publish-contract.ts:117`. The list holds `openapi.yaml`, 19 `features/<name>.yaml`, 43
  `examples/<operationId>.json` and `manifest.json` — 64 entries. The relative paths are built with
  `join("features", ...)` at `:72` and `join("examples", ...)` at `:94`, so a test must build its
  expected strings the same way rather than hardcoding a separator.

- **The manifest shape is fixed at `scripts/publish-contract.ts:103-109`:** `version`, `commit`, `tag`,
  `features`, `operations`, in that key order. `features` is `features.map((f) => f.name)` and
  `operations` is `publishedEntries.map((e) => e.operationId)` where `publishedEntries` is
  `registry.filter((entry) => entry.examples !== undefined)` at `:81-83`. Both lists are already in
  bytewise order, because `openApiFeatures()` sorts names at `openapi.ts:35` and the registry is sorted
  by `operationId` at `registry.ts:37-39`.

- **`openapi.test.ts` keeps one temporary directory and one cleanup**, established at lines 61-64:
  `mkdtempSync(join(tmpdir(), "kanthord-openapi-"))` and one `after` hook running
  `rmSync(..., { recursive: true, force: true })`. No story adds a second `mkdtempSync` to that file;
  `grep -c 'mkdtempSync' src/http/contract/openapi.test.ts` must stay `1`.

- **`publish-contract.test.ts` has both conventions.** One shared `directory` at line 60 with one
  `after` hook, and per-subtest own directories created inline with `mkdtempSync` and removed in
  `finally` — lines 285-286 and 309-310 are the model Story 4 follows.

- **The two files use different test shapes.** `openapi.test.ts` is flat top-level `test()` calls with
  no `describe`. `publish-contract.test.ts` is one top-level `test("scripts/publish-contract", async (t)
=> {` at line 65 with `await t.test(...)` subtests. Follow each file's own shape; do not add a
  `describe` to either.

- **`emitEveryDocument` must stay idempotent by bytes, and that is why Story 3 works.** Story 1's helper
  overwrites the same 20 files with the same content, so Story 3's test calls it rather than reading
  what Story 1's test wrote. Two top-level `test()` calls sharing a side effect is an order-dependent
  test and a determinism defect. If a later epic makes the emission non-deterministic, Story 4's test
  fails first and names the slice.

- **The file count is asserted through the helper's return value and the `features` subdirectory, never
  through `readdirSync(openApiDirectory)`.** That top-level directory also holds `no-version.yaml`,
  `dangling-ref.yaml`, `broken-no-version.yaml` and `broken-dangling-ref.yaml`, so its entry count
  depends on which tests have run.

- **Every failure-mode proof in this epic mutates a test file, never a production file.**
  `scripts/lane-check.sh test-engineer src/http/contract/openapi.ts` denies the path
  (`production source is not the test-engineer lane`), and
  `scripts/lane-check.sh test-engineer scripts/publish-contract.ts` denies it
  (`scripts are the software-engineer lane`). A scratch edit reverted before the commit is still outside
  the lane while it exists. Stories 1 and 3 mutate inside `emitEveryDocument`, which lives in the test
  file; Story 4 mutates the parsed `manifest.json` object and the argument of one `compare` call. No
  story instructs an edit to the renderer or the publisher.

- **Sorting a mapped file path is not the same as sorting the bare name, and Story 4 depends on the
  difference.** For ids `A` and `B` where `A` is a proper dot-prefix of `B`, comparing `A + ".json"`
  against `B + ".json"` falls between `"."` and `"."`, then between `"j"` and the first letter of B's
  next segment — so `node.claim.abort.json` sorts before `node.claim.json` while `node.claim` sorts
  before `node.claim.abort`. Verified: today's 43 example ids hold zero prefix pairs and the 19 feature
  names hold zero, so path-sort and name-sort agree right now. Story 4 therefore sorts **both** sides of
  its equality rather than relying on that agreement, and pins the manifest's own order against its own
  source in a separate assertion.

- **`eslint.config.js` enables no type-checked typescript-eslint rules.** It sets `parser:
tseslint.parser` at lines 87 and 425 and nothing more, so `no-unsafe-argument` and
  `no-unsafe-assignment` are off. `YAML.parse(...)` returns `any`, and passing it straight into
  `collectRefs` in Story 3 is not a lint error.

- **`assert.ok(value, message)` narrows the type under this repo's tsconfig.** Verified with
  `tsc --noEmit` under `strict`, `verbatimModuleSyntax` and `noUncheckedIndexedAccess`: after
  `assert.ok(feature, ...)`, `feature` is `OpenApiFeature` rather than `OpenApiFeature | undefined`, and
  TS2775 does not fire. Story 2 depends on this.

- **The validator must not reach a production source.** The guard at `openapi.test.ts:582` reads every
  `.ts` file under `src/` that is not a `.test.ts` or a `.d.ts` and fails when one holds the string
  `@apidevtools/swagger-parser`. Every edit of this epic lands in a `.test.ts` file, so the guard stays
  green. Never move a validation helper into `src/http/contract/openapi.ts`.

- **A contract test may import `node:fs`, `node:os` and `node:path`.** The `no-restricted-imports` block
  for `src/http/contract/**/*.ts` at `eslint.config.js:309-334` carries `ignores:
["src/**/*.test.ts"]`, and `openapi.test.ts:9-18` already imports all three.

- **`npm run verify` is `format && typecheck && test && lint && verify-db-status`** (`package.json:28`),
  and `format` is `prettier --write src test scripts docs eslint.config.js` (`package.json:25`). Run
  prettier before committing so the committed bytes are stable.

## One item Ulrich owns, and it blocks no story

The EPIC's `## Open items` S1 asks for a row in the `AGENTS.md` table "What is enforced, and by what".
`AGENTS.md` is locked by `scripts/lane-check.sh:43`, so no story edits it. Story 3 builds the mechanism;
the row that names it is Ulrich's to apply.

- **S1 - status:OPEN - action:YES - the enforcement table names the self-containment gate -** The
  `AGENTS.md` table holds no row for the reference rule stated at `AGENTS.md:105`, so the rule keeps no
  mechanism a reviewer can cite. - fix:Add the row `| a self-contained emitted document | a $ref walk
over every emitted document in \`src/http/contract/openapi.test.ts\` |`. - why:Story 3 delivers the
  walk, and a rule with no mechanism is a rule a reviewer applies inconsistently.
