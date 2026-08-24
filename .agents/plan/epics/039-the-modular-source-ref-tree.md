# EPIC 039 — The modular source `$ref` tree

Status: **draft**. It is the tenth and last epic of the phase 1b band, after EPIC 038 and before any
phase-2 epic. It depends on EPIC 037 for the component set and the root event payload extension, and on EPIC 038 for the validation and
reproducibility harness. It amends `docs/proposal/api/new-decisions.md:11` and
`docs/proposal/api/README.md:20`, so it lands before a phase-2 epic reads the publication layout.

## Goal

`npm run contract:publish` writes a second form of the contract. The second form is modular. It
splits the master document into a root, one fragment per feature and one file per component group,
joined by external `$ref`. The self-contained documents stay, and their bytes stay.

The published layout:

```text
openapi.yaml                    self-contained canonical master
features/<feature>.yaml         self-contained scoped bundles
examples/<operationId>.json     request and response examples
manifest.json                   the publication manifest
source/openapi.yaml             modular root
source/features/<feature>.yaml  operation fragments
source/components/*.yaml        shared schemas and security schemes
```

A consumer that reads `openapi.yaml` sees no change. A consumer that edits, diffs or vendors the
contract reads `source/`, where one schema lives in one place.

## Non-goals

- **No change to the bytes of the canonical master.** `openapi.yaml` and each `features/*.yaml`
  slice keep the exact bytes they hold today.
- **No change to a schema, an operation or a path.** The registry and every zod module stay as they
  are. This epic reshapes a file layout, not a contract.
- **No removal of the self-contained slices.** `features/<feature>.yaml` stays self-contained.
- **No move to OpenAPI 3.1.** EPIC 037 settled the version.
- **No new dependency.** `@apidevtools/swagger-parser` 12.1.0 is already a dev dependency, and it
  exports `validate`, `bundle` and `dereference`. The gates need nothing else.

## Decisions

- **The modular tree is additional, never a replacement.** The self-contained master and the
  self-contained feature slices stay the stable consumer interface. A tool that resolves no external
  reference reads them and works. The modular tree is a second artifact beside them.

- **Every reference stays inside the publication directory.** A `$ref` in an emitted file is a
  relative path plus a JSON Pointer fragment. The path resolves, from the directory of the file that
  holds it, to a file inside the publication directory. A `$ref` that starts with `/`, with a URL
  scheme, or with a `../` sequence that escapes the publication directory is a defect. A test
  resolves every `$ref` of every emitted file and names the offending file. The rule holds for every
  reference position, and a reference under `x-kanthord-event-payloads` is one such position.

- **Bundling the modular root reproduces the canonical master.** `SwaggerParser.bundle` on
  `source/openapi.yaml` succeeds and leaves no external reference. The semantic comparison then runs
  on the dereferenced forms: dereference `source/openapi.yaml`, dereference `openapi.yaml`, and
  compare the two results. The comparison normalises three things and nothing else:

  1. the values pass through `JSON.stringify` and `JSON.parse`, so a `undefined` value and a
     prototype difference disappear;
  2. every object key set sorts bytewise at every depth, because a bundler picks its own key order;
  3. nothing else changes. Array order stays, because `parameters` order is contract.

  The root extension key `x-kanthord-event-payloads` is ordinary document content, so the
  comparison covers it under this same normalisation. The epic adds no special case for it. After
  the dereference, the master resolves each of its 37 entries to an inline schema, and the modular
  root resolves each of its 37 entries to the same inline schema.

  A byte comparison is wrong here. A bundler picks its own key order and its own inline-versus-
  reference placement, and both choices are outside this product.

- **The modular layout is deterministic.** Each fragment renders through
  `YAML.stringify(value, { lineWidth: 0 })`, the same call `renderOpenApiYaml` uses. A directory name
  is fixed. A file name derives from the rule below. A key order inside a fragment follows the key
  order of the master document, which `buildOpenApiDocument` already sorts bytewise. Two emissions
  into two directories produce identical bytes for every file under `source/`.

- **A component file name is the schema-name prefix.** Take the schema name. Cut it at the first
  `.`. That prefix, plus `.yaml`, is the file name. A schema name that holds no `.` is its own
  prefix, so `Error` lands in `source/components/Error.yaml`. This is the rule
  `openApiFeatures` at `src/http/contract/openapi.ts:19-27` already applies to an `operationId`, so
  the component grouping and the feature grouping share one rule. The security schemes are not
  schemas and take the fixed name `source/components/security.yaml`. Two component file names that
  differ only by letter case are a defect, because a case-insensitive file system merges them.

  An event payload schema carries the name of its event type, so this rule already places it. The
  37 event payload schemas hold nine distinct prefixes: `actor`, `lease`, `node`, `outcome`, `plan`,
  `project`, `provider`, `recovery` and `repository`. Each prefix already names a component file, so
  `node.state.changed` lands in `source/components/node.yaml`. The component file count stays 15:
  14 schema prefixes plus `security.yaml`.

- **The modular root carries the event payload catalogue.** EPIC 037 adds the root extension
  `x-kanthord-event-payloads` to the master and to each `features/*.yaml` slice. It maps each of the
  37 event types to a reference to its component schema. The modular root holds the same key with
  the same 37 type keys, in the key order of the master, and rewrites each value to an external
  reference into `source/components/`:

  ```yaml
  x-kanthord-event-payloads:
    node.state.changed:
      $ref: ./components/node.yaml#/schemas/node.state.changed
  ```

  The value is the `./components/<prefix>.yaml#/schemas/<name>` form of the reference-style decision
  below, the same form the root uses for `components.schemas`. A feature fragment holds no copy of
  the extension, because the extension is a root key.

- **A feature fragment holds operations, keyed by `operationId`.** One path carries operations from
  two features: `/v1/project/{id}/node` carries `project.nodes` and `node.create`. A path-keyed
  fragment therefore cannot assign that path to one feature. An operation-keyed fragment assigns
  each operation to the feature of its own `operationId` prefix, and the root joins them back into a
  path item.

- **The version stays `3.0.3` in both forms.** The split and the OpenAPI version are independent
  decisions.

- **`manifest.json` gains a `source` field.** A consumer discovers the second form without a guess.
  The field holds the relative path of the modular root, `"source/openapi.yaml"`. It sits after
  `tag` and before `features`, so the manifest key order stays fixed and stated.

- **The reference style.** A fragment references a component by a relative path plus a JSON Pointer
  fragment. Three exact forms exist, and no other:

  ```yaml
  $ref: ../components/actor.yaml#/schemas/actor.list.response
  $ref: ./components/actor.yaml#/schemas/actor.list.response
  $ref: ./features/actor.yaml#/operations/actor.list
  ```

  A reference object in these documents carries the key `$ref` and no other key. The OpenAPI 3.0
  rule that ignores a sibling of `$ref` therefore changes nothing here, and the modular form and the
  bundled form carry the same meaning.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **The proposal states two forms, and `source/components/*.yaml` exists.** Amend
   `docs/proposal/api/new-decisions.md:11`: the master stays self-contained, and the publication adds
   a modular `source/` tree that uses external `$ref`. Amend `docs/proposal/api/README.md:20` with
   the layout block of the Goal above. Add `src/http/contract/openapi-source.ts`, which exports
   `buildOpenApiSourceTree(entries?: readonly Operation[]): ReadonlyMap<string, string>`. The map key
   is a relative path under `source/`; the map value is the file text. This story emits the component
   files only: one file per schema-name prefix, plus `security.yaml`. Each schema value has its
   internal `#/components/schemas/<name>` references rewritten to
   `./components/<prefix>.yaml#/schemas/<name>`. Add `src/http/contract/openapi-source.test.ts` with
   the naming rule, the case-collision refusal, and the exact bytes of one small component file. The
   test also asserts that `source/components/node.yaml` holds the key `node.state.changed` under
   `schemas`, and that the emitted map holds 15 component files.

2. **`source/features/<feature>.yaml` holds the operation fragments.** Extend
   `buildOpenApiSourceTree` in `src/http/contract/openapi-source.ts`. One file per feature of
   `openApiFeatures()`. The file holds one top-level key, `operations`, whose keys are the
   `operationId` values of that feature in bytewise order. Each value is the operation object that
   `buildOpenApiDocument` produces, with every `#/components/schemas/<name>` reference rewritten to
   `../components/<prefix>.yaml#/schemas/<name>`. Extend
   `src/http/contract/openapi-source.test.ts` with the exact reference line of one operation.

3. **`source/openapi.yaml` is the modular root, and the publish writes the tree.** Extend
   `buildOpenApiSourceTree` with the root. The root holds `openapi`, `info`, `security`, `paths`,
   `components` and `x-kanthord-event-payloads`, in the root key order of the master document.
   `paths` copies the path keys and the method keys of the master. Each
   method value is `{ $ref: "./features/<feature>.yaml#/operations/<operationId>" }`.
   `components.securitySchemes.bearerAuth` is
   `{ $ref: "./components/security.yaml#/securitySchemes/bearerAuth" }`.
   `components.schemas` copies the master schema keys, and each value is
   `{ $ref: "./components/<prefix>.yaml#/schemas/<name>" }`. `x-kanthord-event-payloads` copies the
   37 event type keys of the master extension in the master key order, and each value is
   `{ $ref: "./components/<prefix>.yaml#/schemas/<type>" }`, where `<prefix>` is the event type cut
   at the first `.`. Extend `src/http/contract/openapi-source.test.ts` with the exact root line
   `$ref: ./components/node.yaml#/schemas/node.state.changed` under the key `node.state.changed`,
   and with the count of 37 extension keys. Then edit
   `scripts/publish-contract.ts`: remove `source` beside the four existing removals at lines 48-57,
   create `source/components` and `source/features`, write every entry of the map, and push each
   relative path onto `written`. The sort at line 117 stays.

4. **The bundle-equivalence test.** Add `scripts/publish-contract.source.test.ts`. Publish into a
   `mkdtemp` directory. Assert `SwaggerParser.bundle` on `source/openapi.yaml` succeeds, reports
   `$refs.circular === false`, and leaves no `.yaml#` string in the result. Then dereference
   `source/openapi.yaml`, dereference `openapi.yaml`, apply the normalisation of the Decisions, and
   assert `deepStrictEqual`. Assert `SwaggerParser.validate` passes on `source/openapi.yaml`.

5. **The containment test and the reproducibility test.** Extend
   `scripts/publish-contract.source.test.ts`. Walk every emitted file, collect every `$ref` string,
   and assert that each one resolves to a file inside the publication directory; the failure message
   names the file that holds the reference and the reference itself. The walk reads every reference
   position, so the 37 references under `x-kanthord-event-payloads` are part of the assertion.
   Publish twice into two
   `mkdtemp` directories and assert identical bytes for every file under `source/`. Assert that
   `openapi.yaml` and every `features/*.yaml` hold no `.yaml#` string.

6. **`manifest.json` names the modular form.** Edit the manifest object at
   `scripts/publish-contract.ts:103-109` and add `source: "source/openapi.yaml"` after `tag`. Amend
   `docs/proposal/api/README.md:30` so the manifest field list names `source` in position. Extend
   the manifest agreement test of EPIC 038 with the new field and the new key order.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/contract/openapi-source.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  scripts/publish-contract.test.ts \
  scripts/publish-contract.source.test.ts \
  scripts/release-gate.test.ts \
  scripts/release-facts.test.ts \
  && echo "PASS EPIC-039"
```

`npm run contract:publish -- "$(mktemp -d)"` exits `0` and writes both forms. It is not in the Proof
command because it writes outside the repository.

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **`openapi.yaml` is byte-identical to its output before this epic.** The test holds the exact bytes
  and compares them with `Buffer.compare`. A `features/*.yaml` slice is asserted the same way.
- **`SwaggerParser.validate` passes on `source/openapi.yaml`** with every external reference
  resolved from disk.
- **`SwaggerParser.bundle` on `source/openapi.yaml` agrees with the canonical master** under the
  normalisation the Decisions state. The bundle reports `$refs.circular === false` and holds no
  external reference.
- **No `$ref` in any emitted file resolves outside the publication directory.** The test resolves
  every reference and names the offending file in the failure message. The 37 references under the
  root key `x-kanthord-event-payloads` of `source/openapi.yaml` are inside that set.
- **`source/openapi.yaml` carries `x-kanthord-event-payloads` with 37 external references.** Each
  value is `./components/<prefix>.yaml#/schemas/<type>`, and the dereference-equivalence assertion
  above compares the resolved catalogue against the catalogue of the canonical master.
- **The component file count is 15.** The 37 event payload schemas add no file, because each event
  type prefix already names a component file.
- **Two emissions produce identical bytes for every file under `source/`.** The two output
  directories differ in name, so the emission depends on no absolute path.
- **`manifest.json` names the modular form**, and the manifest agreement test asserts the value
  `"source/openapi.yaml"` and the key order `version`, `commit`, `tag`, `source`, `features`,
  `operations`.
- **A component file name collision is refused.** Two schema prefixes that differ only by letter case
  produce a named failure rather than a lost file.
- **Every test uses its own `mkdtemp` directory and removes it.** No shared temporary directory, no
  network, no wall clock, no ambient git configuration.

## Open items

- S1 - status:OPEN - action:YES - `AGENTS.md:105` names one publication form - The line states that
  the master and each `features/*.yaml` slice are self-contained with internal references only, and
  that `npm run contract:publish -- <output-directory>` emits the master, feature slices and
  examples. The sentence stays true after this epic and becomes incomplete, because a second form
  appears. This epic cannot edit the file: `scripts/lane-check.sh:44` denies `AGENTS.md` to every
  lane. - fix:Append to the bullet: "The publication also emits a modular `source/` tree, built from
  external `$ref`, whose bundle reproduces the master. Every reference in it stays inside the
  publication directory." - why:A reviewer reads `AGENTS.md` as the structural contract, and an
  incomplete bullet makes the `source/` tree look like a violation of it.

- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids the opening of
  another **phase-2** epic before it closes. This epic is phase 1b, and the whole 030-039 band is
  exempt for the same reason.

- **A consumer-facing note in the artifact.** The publication holds no `README` that tells a consumer
  which form to read. A short generated note is one file and one decision, and no epic declares it.

- **The component grouping is a naming rule, not a semantic one.** `Error.yaml` holds one schema, and
  `node.yaml` holds thirty-nine. A grouping by reuse count or by domain ownership is a different rule,
  and a change to it changes every reference. This epic ships the prefix rule.
