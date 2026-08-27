# Story 2 — The builder emits the catalogue extension

Epic: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`
Depends on: Story 1.

Lane: software-engineer writes `src/http/contract/openapi.ts`; test-engineer
writes `src/http/contract/openapi.test.ts`. `scripts/lane-check.sh:78-85` splits
them by the `.test.ts` suffix.

This story adds the root extension only. It does not prune. Story 3 adds the
pruning, and it reuses the helper this story introduces.

## Change

Edit `src/http/contract/openapi.ts`. Three edits, in this order.

### Edit 1 — export the key

Line 11 today is:

```ts
const fixedMethodOrder = ["delete", "get", "post", "put"] as const;
```

Insert directly after it, separated by one blank line:

```ts
export const eventPayloadCatalogueKey = "x-kanthord-event-payloads";
```

### Edit 2 — add the catalogue helper

Add this function immediately before `compareBytewise` at line 216, which is the
last function in the file:

```ts
function eventPayloadCatalogue(
  entries: readonly Operation[],
): Record<string, { $ref: string }> | undefined {
  if (!entries.some((entry) => entry.operationId === "event.list")) {
    return undefined;
  }
  const catalogue: Record<string, { $ref: string }> = {};
  for (const type of Object.keys(eventPayloads).sort(compareBytewise)) {
    catalogue[type] = { $ref: `#/components/schemas/${type}` };
  }
  return catalogue;
}
```

`eventPayloads` is already imported at line 6. `Operation` is already imported as
a type at line 8. The explicit `.sort(compareBytewise)` is required even though
`Object.keys(eventPayloads)` is already in bytewise order today, because the key
order is then a property of this function and not of the declaration order in
`src/domain/event-type.ts`.

### Edit 3 — emit the key after `components`

`buildOpenApiDocument` returns an object literal at lines 95-104. Replace that
`return` statement with:

```ts
const document: Record<string, unknown> = {
  openapi: "3.0.3",
  info: { title: "kanthord", version: KANTHORD_VERSION },
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: sortedSchemas,
  },
};

const catalogue = eventPayloadCatalogue(entries);
if (catalogue !== undefined) {
  document[eventPayloadCatalogueKey] = catalogue;
}

return document;
```

The assignment after the literal puts `x-kanthord-event-payloads` last in
insertion order, so it renders after `components` in YAML. The declared return
type of `buildOpenApiDocument` stays `Readonly<Record<string, unknown>>`, and the
single `entries` parameter stays.

### Formatting

```bash
npx prettier --write src/http/contract/openapi.ts
```

## Tests

Edit `src/http/contract/openapi.test.ts`. Add the four tests directly after the
test `"registers every schema component in bytewise order"`, which ends at line 360. The helpers `compare` and `sortedBytewise` are already defined at lines
23-29, and `registry` is already imported at line 2.

Line 1 today is:

```ts
import { buildOpenApiDocument, renderOpenApiYaml } from "./openapi.ts";
```

Becomes:

```ts
import {
  buildOpenApiDocument,
  eventPayloadCatalogueKey,
  renderOpenApiYaml,
} from "./openapi.ts";
```

Add one import line directly after line 3:

```ts
import { eventPayloads } from "./event-payload.ts";
```

### Test 1 — the key set equals the sorted event types

```ts
test("carries the event payload catalogue in bytewise key order", () => {
  const document = buildOpenApiDocument();
  const catalogue = document[eventPayloadCatalogueKey] as Readonly<
    Record<string, unknown>
  >;
  assert.deepEqual(
    Object.keys(catalogue),
    sortedBytewise(Object.keys(eventPayloads)),
  );
  assert.equal(Object.keys(catalogue).length, 37);
});
```

The count is 37, asserted by value.

Add a third assertion to this test, against `eventTypes` itself:

```ts
assert.deepEqual(Object.keys(catalogue), sortedBytewise([...eventTypes]));
```

Import `eventTypes` from `../../domain/event-type.ts`. The gate item says "The
catalogue key set equals `eventTypes`", so the test compares against
`eventTypes` directly. A comparison against `Object.keys(eventPayloads)` alone
proves the builder agrees with the catalogue object, not with the domain list;
the two are kept equal by `event-payload.test.ts:373`, but this story asserts the
gate item as written rather than relying on that.

### Test 2 — every entry is a resolving internal `$ref`

```ts
test("resolves every catalogue entry to a component of the same document", () => {
  const document = buildOpenApiDocument();
  const catalogue = document[eventPayloadCatalogueKey] as Readonly<
    Record<string, { $ref: string }>
  >;
  const components = document.components as Readonly<Record<string, unknown>>;
  const schemas = components.schemas as Readonly<Record<string, unknown>>;
  for (const [type, entry] of Object.entries(catalogue)) {
    assert.deepEqual(Object.keys(entry), ["$ref"]);
    assert.equal(entry.$ref, `#/components/schemas/${type}`);
    assert.equal(
      Object.hasOwn(schemas, type),
      true,
      `${type} is not a component`,
    );
  }
});
```

`assert.deepEqual(Object.keys(entry), ["$ref"])` is the gate item "Each entry
holds exactly one key `$ref`".

### Test 3 — a slice without `event.list` omits the key

```ts
test("omits the event payload catalogue from a document without event.list", () => {
  const nodeOperations = registry.filter((entry) =>
    entry.operationId.startsWith("node."),
  );
  assert.ok(nodeOperations.length > 0);
  assert.equal(
    nodeOperations.some((entry) => entry.operationId === "event.list"),
    false,
  );
  const document = buildOpenApiDocument(nodeOperations);
  assert.equal(Object.hasOwn(document, eventPayloadCatalogueKey), false);
});
```

The filter reproduces the `node` slice that `openApiFeatures` at
`src/http/contract/openapi.ts:18` groups, because that function splits an
`operationId` at its first `.`. The filter avoids importing `openApiFeatures`.

### Test 4 — the extension is the only new root key

```ts
test("adds the catalogue as the only root key beyond the document core", () => {
  const document = buildOpenApiDocument();
  assert.deepEqual(Object.keys(document), [
    "openapi",
    "info",
    "security",
    "paths",
    "components",
    eventPayloadCatalogueKey,
  ]);

  const components = document.components as Readonly<Record<string, unknown>>;
  assert.deepEqual(Object.keys(components), ["securitySchemes", "schemas"]);
  assert.deepEqual(components.securitySchemes, {
    bearerAuth: { type: "http", scheme: "bearer" },
  });
});
```

This is the first half of the gate item "The master changes by exactly one root
key", asserted for the root key list and its order. Story 3 adds the second half,
which is that the pruning removes nothing from the master.

The two `components` assertions close the one hole the rest of the suite leaves.
`openapi.test.ts:130-131` already pins `securitySchemes.bearerAuth` by value and
the `security` root by value, but nothing pins that `components` holds no third
key and that `securitySchemes` holds no second scheme. The EPIC Verification gate
names this assertion for that reason.

## Constraints

- **No change to `paths`, to a schema, or to an operation.** The registry is
  untouched. No `z.toJSONSchema` call changes.
- **No pruning.** `sortedSchemas` at lines 89-93 keeps every seeded key. Story 3
  changes it.
- **`renderOpenApiYaml` keeps its single parameter** and its body at line 110.
- **The version stays `3.0.3`.**
- **Every existing test in `openapi.test.ts` passes unmodified.** Change only
  line 1, add one import line, and append the four tests. Edit no existing test
  body.

## Verify

```bash
node --test \
  src/http/contract/openapi.test.ts \
  src/http/contract/event-payload.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/path.test.ts
npm run typecheck && npx eslint .
```

- The four new tests pass.
- `"registers every schema component in bytewise order"` at line 211 passes
  unmodified, which proves `components.schemas` still holds the same 142 keys in
  the same order.
- `"refers to components only through internal refs"` at line 512 passes
  unmodified. It walks the whole document with `collectRefs` at lines 603-620, so
  it now covers the 37 new `$ref` values and proves each one resolves. This is a
  second, independent proof of the gate item "Every catalogue entry resolves".
- `"renders canonical yaml"` at line 531 passes unmodified, so the added root key
  keeps one trailing newline and no CR.
- `"validates the generated document and deletes its directory"` at line 539
  passes unmodified. It calls `SwaggerParser.validate` on the emitted master, so
  it is the gate item "The master validates: `SwaggerParser` accepts the master
  with the root extension present."

Proof: this story delivers the `openapi.test.ts` line of the EPIC Proof command,
and it keeps green the `event-payload.test.ts`, `registry.test.ts`,
`parity.test.ts`, `coverage.test.ts`, `example.test.ts` and `path.test.ts` lines
of that command, which the Verify command above runs for that reason.

It delivers these gate items in full: "The catalogue key set equals
`eventTypes`", "Every catalogue entry resolves", and "The master validates".

It delivers the first half of the gate item "The master changes by exactly one
root key": the root key list and its order, and the `components` key set and
`securitySchemes` value. Story 3 delivers the second half, which is that the
pruning filter is the identity on the master. The EPIC gate names the existing
contract suite as the rest of the baseline, so every existing test in this file
must pass unmodified.
