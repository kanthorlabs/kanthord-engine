# Story 2 — A broken slice is rejected

Epic: `.agents/plan/epics/038-validate-every-emitted-document.md`
Depends on: Story 1 — it adds the `openApiFeatures` import these tests use.

**Test only.** This story edits one file, `src/http/contract/openapi.test.ts`, and changes no
production file. `scripts/lane-check.sh:72-83` puts it in the test-engineer lane.

**There is no RED step against the product.** Both mutations already reject today. This was verified
before the story was written: the `system` slice missing `info.version` is rejected, and the `system`
slice holding `#/components/schemas/missing` is rejected with `Missing $ref pointer
"#/components/schemas/missing". Token "missing" does not exist.` The two tests pass the first time they
run.

The RED signal is the failure mode of the `## Verify` section: remove the mutation and watch
`assert.rejects` fail. That is what proves the test asserts rejection rather than asserting nothing.

## Change

Edit `src/http/contract/openapi.test.ts`. Add two tests, immediately after the test Story 1 replaced
at line 539 (`"validates the master document and every feature slice"`) and before
`"is never committed to the repository root"` at line 545. Add no import — Story 1 already added
`openApiFeatures`, and `structuredClone`, `YAML`, `SwaggerParser`, `writeFileSync`, `join` and
`assert` are all in place.

### Test 1 — the slice missing `info.version`

Mirror the shape of the master test at `openapi.test.ts:549`, `"rejects a document missing
info.version"`.

```ts
test("rejects a feature slice missing info.version", async () => {
  const feature = openApiFeatures().find((entry) => entry.name === "system");
  assert.ok(feature, "the system feature is absent");
  const document = structuredClone(
    buildOpenApiDocument(feature.operations),
  ) as Record<string, unknown>;
  const info = document.info as Record<string, unknown>;
  delete info.version;
  const filePath = join(openApiDirectory, "broken-no-version.yaml");
  writeFileSync(filePath, YAML.stringify(document), "utf8");
  await assert.rejects(SwaggerParser.validate(filePath));
});
```

### Test 2 — the slice holding a dangling `$ref`

Mirror the shape of the master test at `openapi.test.ts:561`, `"rejects a dangling schema
reference"`. The `system` slice carries the three path keys `/v1/db/status`, `/v1/health` and
`/v1/status`, and `/v1/health` carries the single method `get`. The mutation site is therefore the same
one the master test uses, and it exists inside the slice.

```ts
test("rejects a feature slice with a dangling schema reference", async () => {
  const feature = openApiFeatures().find((entry) => entry.name === "system");
  assert.ok(feature, "the system feature is absent");
  const document = structuredClone(
    buildOpenApiDocument(feature.operations),
  ) as Record<string, unknown>;
  const paths = document.paths as Record<string, unknown>;
  const health = paths["/v1/health"] as Record<string, unknown>;
  const responses = (health.get as Record<string, unknown>).responses as Record<
    string,
    unknown
  >;
  const defaultResponse = responses.default as Record<string, unknown>;
  const content = defaultResponse.content as Record<string, unknown>;
  const json = content["application/json"] as Record<string, unknown>;
  const schema = json.schema as Record<string, unknown>;
  schema.$ref = "#/components/schemas/missing";
  const filePath = join(openApiDirectory, "broken-dangling-ref.yaml");
  writeFileSync(filePath, YAML.stringify(document), "utf8");
  await assert.rejects(SwaggerParser.validate(filePath));
});
```

Five points that fix the two tests exactly.

- **The slice is `system`, selected by name, and the selection is asserted.** `assert.ok(feature, ...)`
  is not decoration: `find` returns `OpenApiFeature | undefined`, and without the assertion the
  subsequent `feature.operations` fails `typecheck`. It also turns a renamed feature into a named
  failure rather than a `TypeError`.
- **`system` is the right slice, and the choice is not arbitrary.** It is the smallest slice that
  carries `/v1/health`, so the second test's mutation path is character-for-character the master test's
  path at lines 567-577. Do not substitute another feature — no other slice holds `/v1/health`.
- **`buildOpenApiDocument(feature.operations)`, not `renderOpenApiYaml`.** The mutation is applied to
  the object, then serialized with `YAML.stringify`, exactly as the two master tests do. `structuredClone`
  is required because `buildOpenApiDocument` returns `Readonly<Record<string, unknown>>`.
- **The file names are `broken-no-version.yaml` and `broken-dangling-ref.yaml`.** They must differ from
  the master tests' `no-version.yaml` and `dangling-ref.yaml`, which are written into the same
  directory by the tests at lines 549 and 561. Two tests writing one path is an order-dependent test.
- **`YAML.stringify(document)` takes no options here.** The master tests call it the same way.
  `renderOpenApiYaml` passes `{ lineWidth: 0 }`, but these two documents are deliberately invalid and
  are never compared by bytes, so the option is irrelevant and its absence matches the sibling tests.

## Constraints

- **Edit one file, and add only these two tests.** No other change to
  `src/http/contract/openapi.test.ts`.
- **Do not modify the two master tests at lines 549 and 561.** This story adds beside them. They keep
  their names, their mutations and their file names.
- **Do not extract a shared helper for the four mutation tests.** The EPIC prescribes mirroring the
  master shape. Four explicit tests, each naming its own document and its own file, is the convention
  of this file; a parameterized helper would hide which document failed.
- **Do not assert the rejection message.** `assert.rejects(SwaggerParser.validate(filePath))` with no
  second argument is what the two master tests do. The validator's message text is a vendor string and
  pinning it couples the suite to a dependency version.
- **Do not add a `mkdtempSync` call.** Both tests write into `openApiDirectory`, which the `after`
  hook at lines 62-64 removes.
- **Change no production source, and add no dependency.**

## Verify

```bash
node --test src/http/contract/openapi.test.ts
```

Every test passes, including the two new ones.

Run the two alone to prove they need no sibling:

```bash
node --test --test-name-pattern='rejects a feature slice' src/http/contract/openapi.test.ts
```

Two tests run and both pass.

Prove the two failure modes. Each is a scratch edit — revert it before the next.

- Delete the line `delete info.version;` from Test 1. `assert.rejects` fails with
  `Missing expected rejection`, because the unmutated `system` slice is valid. This is the proof that
  the test asserts rejection and that the slice is otherwise well-formed.
- Change `schema.$ref = "#/components/schemas/missing";` in Test 2 to
  `schema.$ref = "#/components/schemas/Error";`. `assert.rejects` fails with
  `Missing expected rejection`, because `Error` is a registered component. This is the proof that the
  validator resolves the slice's own components rather than accepting any `$ref`.

Both failure modes must be observed. A rejection test that passes when the mutation is removed asserts
nothing.

Hermetic check: no network, no clock, no ambient git configuration, no new temporary directory.

```bash
grep -c 'mkdtempSync' src/http/contract/openapi.test.ts
```

reports `1`.

Scope check, scoped to the source tree because other agents may be editing `.agents/plan/**`
concurrently:

```bash
git status --porcelain -- src scripts test docs
```

names exactly one file, `src/http/contract/openapi.test.ts`.

`npm run verify` exits 0.

Proof: this story delivers the `src/http/contract/openapi.test.ts` clause of the EPIC Proof block. It
delivers the rejecting direction of the gate bullet **`SwaggerParser.validate` passes for the master
and for each of the 19 slices, and a deliberately broken slice is rejected. Both directions are
asserted** — specifically **The rejected slice loses `info.version` in one test and holds a dangling
`$ref` in the other**.
