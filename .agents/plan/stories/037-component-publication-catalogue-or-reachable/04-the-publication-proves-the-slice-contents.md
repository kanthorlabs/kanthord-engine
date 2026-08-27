# Story 4 — The publication proves the slice contents

Epic: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`
Depends on: Story 3.

Lane: test-engineer only. `scripts/publish-contract.test.ts` matches `scripts/*`
with a `.test.ts` suffix, so `scripts/lane-check.sh:87-93` grants it to the
test-engineer and denies it to the software-engineer.

`scripts/publish-contract.ts` needs **no code change**. It calls
`renderOpenApiYaml()` at line 66 for the master and `renderOpenApiYaml(feature.operations)`
at line 75 for each of the 19 slices, so the builder of stories 2 and 3 decides
both the extension and the pruning. The script holds no by-name exception for the
`event` feature today, so there is nothing to remove.

## Change

Edit `scripts/publish-contract.test.ts` only. The file already imports what the
new tests need: `SwaggerParser` at line 4, `YAML` at line 16, `mkdtempSync`,
`readFileSync`, `readdirSync` and `rmSync` from `node:fs` at lines 5-12,
`tmpdir` at line 13, `join` at line 14, `publishContract` at line 18,
`openApiFeatures` at line 22, and the `compare` and `sortedBytewise` helpers at
lines 42-48.

Make three import edits.

Edit 1. The existing block at lines 21-24 is:

```ts
import {
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
```

Becomes:

```ts
import {
  eventPayloadCatalogueKey,
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
```

Do not add a second import block from `../src/http/contract/openapi.ts`.

Edit 2 and Edit 3. Add these two new lines directly after that block:

```ts
import { eventPayloads } from "../src/http/contract/event-payload.ts";
import { reachableSchemaNames } from "../src/http/contract/schema-reachability.ts";
```

The suite is one top-level `test("scripts/publish-contract", async (t) => {` at
line 65, with `await t.test(...)` sub-tests. The module-level temporary directory
is `mkdtempSync(join(tmpdir(), "kanthord-contract-"))` at line 60, and the
`after` hook at lines 61-63 removes it. The publication into it already ran, so a
new sub-test reads from `directory` and writes nothing.

Add four sub-tests. Place them directly after
`"the published event feature carries the cursor parameters"`, which ends at line
283, and before `"generation is byte-identical across two runs"` at line 284.

### Sub-test 1 — every emitted document is its own closure

```ts
await t.test("every emitted document holds the closure of its own refs", () => {
  const paths = [
    "openapi.yaml",
    ...featureNames.map((n) => join("features", `${n}.yaml`)),
  ];
  assert.equal(paths.length, 20);
  for (const relative of paths) {
    const document = YAML.parse(
      readFileSync(join(directory, relative), "utf8"),
    );
    const schemas = document.components.schemas as Record<string, unknown>;
    assert.deepEqual(
      sortedBytewise([...reachableSchemaNames(document)]),
      sortedBytewise(Object.keys(schemas)),
      `${relative} is not its own closure`,
    );
  }
});
```

`featureNames` is defined at line 57 and holds 19 names, so `paths.length` is 20.

### Sub-test 2 — the catalogue is in the master and in `event` only

```ts
await t.test("only the master and the event slice carry the catalogue", () => {
  const master = YAML.parse(
    readFileSync(join(directory, "openapi.yaml"), "utf8"),
  );
  assert.deepEqual(
    Object.keys(master[eventPayloadCatalogueKey]),
    sortedBytewise(Object.keys(eventPayloads)),
  );

  for (const name of featureNames) {
    const document = YAML.parse(
      readFileSync(join(directory, "features", `${name}.yaml`), "utf8"),
    );
    const carries = Object.hasOwn(document, eventPayloadCatalogueKey);
    assert.equal(
      carries,
      name === "event",
      `${name} carries the wrong catalogue state`,
    );
  }
});
```

The `name === "event"` comparison is the whole gate item: the key exists in
`features/event.yaml` and in no other slice. `event.list` is the only operation
of the `event` namespace that the extension keys on, and `openApiFeatures` groups
it into the `event` slice.

### Sub-test 3 — `features/node.yaml` holds no payload schema, and `event` holds all 37

```ts
await t.test("the node slice drops every event payload schema", () => {
  const node = YAML.parse(
    readFileSync(join(directory, "features", "node.yaml"), "utf8"),
  );
  const nodeSchemas = node.components.schemas as Record<string, unknown>;
  for (const type of Object.keys(eventPayloads)) {
    assert.equal(
      Object.hasOwn(nodeSchemas, type),
      false,
      `node.yaml holds ${type}`,
    );
  }

  const event = YAML.parse(
    readFileSync(join(directory, "features", "event.yaml"), "utf8"),
  );
  const eventSchemas = event.components.schemas as Record<string, unknown>;
  for (const type of Object.keys(eventPayloads)) {
    assert.equal(
      Object.hasOwn(eventSchemas, type),
      true,
      `event.yaml lost ${type}`,
    );
  }
});
```

### Sub-test 4 — no emitted document holds an external `$ref`

```ts
await t.test(
  "no emitted document holds a $ref outside its own components",
  () => {
    const paths = [
      "openapi.yaml",
      ...featureNames.map((n) => join("features", `${n}.yaml`)),
    ];
    for (const relative of paths) {
      const text = readFileSync(join(directory, relative), "utf8");
      const document = YAML.parse(text);
      const refs: string[] = [];
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) return value.forEach(walk);
        if (value === null || typeof value !== "object") return;
        for (const [key, nested] of Object.entries(value)) {
          if (key === "$ref" && typeof nested === "string") refs.push(nested);
          else walk(nested);
        }
      };
      walk(document);
      assert.ok(refs.length > 0, `${relative} carries no $ref`);
      for (const ref of refs) {
        assert.ok(
          ref.startsWith("#/components/schemas/"),
          `${relative} holds external or malformed $ref ${ref}`,
        );
      }
    }
  },
);
```

This walks the **whole** document, not `paths` alone, and it runs over the master
and over all 19 slices.

### Strengthen the reproducibility comparison

`"generation is byte-identical across two runs"` at line 284 already publishes
into two separate `mkdtemp` directories and compares every written file. It uses
`assert.deepEqual(a, b)` on the two Buffers at line 303, which already proves
byte equality; this edit is not a strengthening of the assertion. Make it only
because the EPIC gate names `Buffer.compare` as the mechanism, so the test then
matches the gate word for word. Replace that one line with:

```ts
assert.equal(Buffer.compare(a, b), 0, `${relative} differs between runs`);
```

Change nothing else in that sub-test. It keeps its own two directories and its
`finally` cleanup at lines 308-311.

### Formatting

```bash
npx prettier --write scripts/publish-contract.test.ts
```

## Constraints

- **No edit to `scripts/publish-contract.ts`.** The builder decides the content.
  A story that edits the script is a defect.
- **No new emitted file, and no manifest change.** The manifest keeps the same
  keys. `features` stays the 19 names.
- **Every existing sub-test passes unmodified**, except the one line of
  `Buffer.compare` named above. In particular
  `"writes the master document, feature documents and examples"` at line 67 keeps
  its `SwaggerParser.validate(filePath)` call at line 99 for every emitted file,
  which proves each pruned slice still validates.
- **Hermetic.** Reuse the module-level `directory`. A sub-test that needs its own
  directory makes it with `mkdtempSync(join(tmpdir(), ...))` and removes it in a
  `finally`. No test reads a wall clock, a shared temporary path or an ambient
  git configuration.
- **`Error` is absent from eight slices after pruning.** The eight are `actor`,
  `blob`, `edge`, `event`, `plan`, `project`, `provider` and `system`. Assert no
  slice-level presence of `Error`; sub-test 1 covers it by the closure rule. Do
  not add an assertion that every slice holds `Error`.

## Verify

```bash
node --test scripts/publish-contract.test.ts
npm run contract:publish -- "$(mktemp -d)"
npm run verify
```

- The four new sub-tests pass, and the 16 existing sub-tests pass.
- `npm run contract:publish -- "$(mktemp -d)"` exits 0. It is outside the Proof
  command because it writes outside the repository.
- `npm run verify` exits 0: `format`, `typecheck`, the full `node:test` suite,
  `eslint .` and `verify-db-status`.

Proof: this story delivers the `scripts/publish-contract.test.ts` line of the
EPIC Proof command, and the gate items "`features/event.yaml` holds the
catalogue, and no other slice does", "Every emitted document holds the transitive
closure of its own references", "Every emitted document is byte-reproducible",
and "No emitted document holds a `$ref` whose value does not begin with `#/`".
