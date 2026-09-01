# EPIC 038 — Validate every emitted document

Status: **draft**. It is the ninth epic of the 030–039 band, inside phase 1b. It follows EPIC 037,
which introduces the build modes and the reachability rule. EPIC 039 follows it, because the modular
`$ref` tree needs the equivalence gate this epic builds.

## Goal

Every document the product emits passes a validator, carries only internal references, and reproduces
byte for byte. The set is the master `openapi.yaml` and each of the 19 `features/*.yaml` slices.

`AGENTS.md:105` states that the master and each slice are self-contained with internal references
only. No test asserts the reference rule over an emitted document. This epic turns that sentence into
a mechanism, and it adds the mechanism to the `AGENTS.md` enforcement table through Open items.

The epic edits test files only. It changes no production source, no schema and no emitted byte.

## Non-goals

- **No external `$ref`.** EPIC 039 owns the modular source tree, and it brings its own
  bundle-equivalence gate. This epic asserts that no external `$ref` exists today.
- **No change to any schema, operation or path.** The registry, the path grammar and
  `buildOpenApiDocument` stay as they are.
- **No change to the master's bytes.** `renderOpenApiYaml()` returns the same string after this epic.
- **No new dependency.** `@apidevtools/swagger-parser` and `yaml` are already installed.
- **No example validation beyond the zod level.** See the decision below.

## Decisions

- **The validated set is the master and each of the 19 slices.** `openApiFeatures()` at
  `src/http/contract/openapi.ts:19` groups the 69 registry operations by the segment before the first
  dot. It returns 19 features: `actor`, `agent`, `attempt`, `binding`, `blob`, `edge`, `event`,
  `gitOperation`, `instructions`, `node`, `plan`, `profile`, `project`, `provider`, `repository`,
  `run`, `system`, `template`, `worker`. `src/http/contract/openapi.test.ts:539` validates the master
  alone. The slice validation lives in `scripts/publish-contract.test.ts` and runs through the
  publisher. This epic validates each slice in `openapi.test.ts`, beside the master, from
  `renderOpenApiYaml(feature.operations)`.

- **A broken slice is rejected, and the test asserts both directions.** `openapi.test.ts:558` and
  `:579` reject a master that lost `info.version` and a master that holds a dangling `$ref`. No test
  rejects a broken slice. One slice takes the same two mutations, and `assert.rejects` proves the
  validator sees the slice.

- **Self-containment is asserted mechanically.** One test parses every emitted document, collects
  every `$ref` value, and fails when a value does not begin with `#/`. It lives in
  `src/http/contract/openapi.test.ts`, and it reuses the local `collectRefs` function at the foot of
  that file. The existing test "refers to components only through internal refs" walks the in-memory
  master object. The new test walks the emitted YAML of the master and of all 19 slices.

- **Reproducibility is asserted per slice, by exact bytes.** `openapi.test.ts` asserts
  `renderOpenApiYaml() === renderOpenApiYaml()` for the master alone. The new test renders each slice
  twice and compares the two strings by exact bytes, through `Buffer.compare` on
  `Buffer.from(value, "utf8")`. `scripts/publish-contract.test.ts:285-310` already compares two
  publish runs file by file, and it stays as it is.

- **`manifest.json` agrees with the file list the publisher returns.** `publishContract` returns the
  written relative paths, sorted bytewise. The existing manifest test compares `manifest.features`
  and `manifest.operations` against lists derived from the registry. The new gate compares them
  against the returned list: each `manifest.features` name maps to a `features/<name>.yaml` entry in
  the returned list, each `manifest.operations` id maps to an `examples/<id>.json` entry, and the
  returned list holds no `features/` or `examples/` entry the manifest omits. The comparison is set
  equality in both directions.

- **Examples stay validated at the zod level, and this epic adds nothing.**
  `scripts/publish-contract.test.ts` holds the subtest "each published example still satisfies its
  schema". It parses each of the 43 `examples/<operationId>.json` files and runs the operation's
  `request`, `query`, `response` and error-envelope schemas over the matching key. Those zod schemas
  are the source of the OpenAPI components, so a second check against the generated JSON Schema tests
  `z.toJSONSchema`, not the example. Validation of an example against the emitted component goes to
  Open items.

- **Each test owns its temporary directory and removes it.** `openapi.test.ts:61` creates one
  directory with `mkdtempSync(join(tmpdir(), "kanthord-openapi-"))` and removes it in an `after` hook.
  The 19 slices write into that same directory, under distinct file names. The directory count stays
  one, and the `after` hook stays the only cleanup.

- **The validator stays out of production sources.** `openapi.test.ts:582` reads every non-test `.ts`
  file under `src/`, and it fails when one holds the string `@apidevtools/swagger-parser`. Every edit
  of this epic lands in a `.test.ts` file, so the guard stays green. Never import the validator from a
  production source, and never move a validation helper into `src/http/contract/openapi.ts`.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **Every slice is emitted and validated beside the master.** In
   `src/http/contract/openapi.test.ts`, replace the test at `:539` with a test that writes
   `openapi.yaml` and `features/<name>.yaml` for each of the 19 features into `openApiDirectory`, then
   awaits `SwaggerParser.validate` on each of the 20 paths. Create the `features` subdirectory with
   `mkdirSync`. Assert the emitted file count is 20. Keep the master assertion.
2. **A broken slice is rejected.** In the same file, after the story-1 test, add one test that takes
   the `system` slice document from `buildOpenApiDocument(feature.operations)`, deletes
   `info.version`, writes it as `broken-no-version.yaml`, and asserts `SwaggerParser.validate`
   rejects. Add a second test that sets a `$ref` to `#/components/schemas/missing` inside that slice,
   writes it as `broken-dangling-ref.yaml`, and asserts the same rejection. Mirror the shape of the
   two master tests at `:549` and `:561`.
3. **No emitted document holds a `$ref` outside `#/`.** In the same file, add one test that reads each
   of the 20 emitted files with `readFileSync`, parses each with `YAML.parse`, collects the refs with
   the local `collectRefs`, and asserts every value starts with `#/components/schemas/`. Assert the
   total ref count is above zero, so an empty walk cannot pass.
4. **Two emissions of every slice produce identical bytes, and the manifest agrees with the file
   list.** In `src/http/contract/openapi.test.ts`, add one test that calls
   `renderOpenApiYaml(feature.operations)` twice per feature and compares the two strings with
   `Buffer.compare` on UTF-8 buffers. In `scripts/publish-contract.test.ts`, add one subtest that
   captures the return value of `publishContract` and asserts the two-way set equality between the
   manifest lists and the returned `features/` and `examples/` entries.

## Verification Gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/openapi.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/path.test.ts \
  src/http/contract/event-payload.test.ts \
  scripts/publish-contract.test.ts \
  scripts/release-gate.test.ts \
  scripts/release-facts.test.ts \
  && echo "PASS EPIC-038"
```

`npm run contract:publish -- "$(mktemp -d)"` exits 0. It is not in the Proof command because it
writes outside the repository.

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `format`, `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **`SwaggerParser.validate` passes for the master and for each of the 19 slices**, and a deliberately
  broken slice is rejected. Both directions are asserted, as the master tests at `openapi.test.ts:558`
  and `:579` assert them. The rejected slice loses `info.version` in one test and holds a dangling
  `$ref` in the other.
- **No emitted document holds a `$ref` outside `#/`.** The walk covers all 20 emitted files, and it
  asserts a non-zero ref count so an empty walk cannot pass.
- **Two emissions produce identical bytes for every emitted file.** Each slice is compared by exact
  bytes through `Buffer.compare`. The existing two-directory publish comparison stays green.
- **`manifest.json` names exactly the features and operations that were written.** The 19 feature
  names map one to one onto the emitted `features/*.yaml` files, and the 43 operation ids map one to
  one onto the emitted `examples/*.json` files. The equality is asserted in both directions.
- **Every test uses its own `mkdtemp` directory and removes it.** No shared temporary directory, no
  network, no wall clock, no ambient git configuration. `openapi.test.ts` keeps one directory and one
  `after` hook.
- **No production source names `@apidevtools/swagger-parser`.** The guard at `openapi.test.ts:582`
  stays green, and no epic edit lands outside a `.test.ts` file.
- **The master's bytes are unchanged.** `renderOpenApiYaml()` returns the same string as before the
  epic, and the emitted `openapi.yaml` still equals it.

## Open items

- **S1 - status:OPEN - action:YES - the enforcement table names the self-containment gate -** The
  `AGENTS.md` table "What is enforced, and by what" holds no row for the reference rule at
  `AGENTS.md:105`. - fix:Add the row `| a self-contained emitted document | a $ref walk over every
emitted document in \`src/http/contract/openapi.test.ts\` |`. - why:`AGENTS.md`is locked by`scripts/lane-check.sh:43`, so no story edits it, and the rule keeps no mechanism until Ulrich
  applies the row.
- **An example is not validated against its emitted OpenAPI component.** The zod schema is the source
  of the component, so a check against the component tests `z.toJSONSchema`. A consumer still reads
  the emitted component and the emitted example together. Deciding this needs a JSON Schema validator,
  which is a new dependency, and a new dependency is a non-goal here.
- **Slice validation now runs in two files.** `scripts/publish-contract.test.ts` validates each slice
  through the publisher, and `src/http/contract/openapi.test.ts` validates each slice from the
  renderer. The two cover different paths to the same bytes. Merging them needs a shared helper under
  `test/helpers/`, and the value is small.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
