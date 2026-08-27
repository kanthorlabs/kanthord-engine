# Story 3 — Transitive reachability, applied to every document

Epic: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`
Depends on: Story 2.

Lane: software-engineer writes `src/http/contract/schema-reachability.ts` and
`src/http/contract/openapi.ts`; test-engineer writes
`src/http/contract/schema-reachability.test.ts`.

This story adds the closure rule and applies it to every document the builder
emits. The master keeps all 142 schemas, because the extension of story 2 reaches
the 37 that `paths` does not. Every slice except `event` loses the 37.

## Change

### Add `src/http/contract/schema-reachability.ts`

The file exports one function and imports nothing.

```ts
const componentPrefix = "#/components/schemas/";

function decodePointer(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

export function reachableSchemaNames(
  document: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const components = document.components as
    Readonly<Record<string, unknown>> | undefined;
  const schemas = (components?.schemas ?? {}) as Readonly<
    Record<string, unknown>
  >;

  const reached = new Set<string>();
  const pending: string[] = [];

  const collect = (raw: string): void => {
    if (!raw.startsWith(componentPrefix)) return;
    const name = decodePointer(raw.slice(componentPrefix.length));
    if (reached.has(name)) return;
    reached.add(name);
    pending.push(name);
  };

  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) scan(element);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      if (key === "$ref" && typeof nested === "string") {
        collect(nested);
        continue;
      }
      if (
        key === "discriminator" &&
        nested !== null &&
        typeof nested === "object"
      ) {
        const mapping = (nested as Record<string, unknown>).mapping;
        if (mapping !== null && typeof mapping === "object") {
          for (const target of Object.values(
            mapping as Record<string, unknown>,
          )) {
            if (typeof target === "string") collect(target);
          }
        }
        continue;
      }
      scan(nested);
    }
  };

  for (const [key, value] of Object.entries(document)) {
    if (key === "components") continue;
    scan(value);
  }

  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined) continue;
    scan(schemas[name]);
  }

  return reached;
}
```

Four properties this code carries, each of which a test pins:

- It **seeds from every root key except `components`**, so `paths` and
  `x-kanthord-event-payloads` are read by the same rule. It still resolves a name
  through `document.components.schemas`, because that is where a body lives.
- It **decodes `~1` to `/` before `~0` to `~`**, which is the order RFC 6901
  requires. The reverse order corrupts a name that holds `~1`.
- It **terminates on a cycle**, because `collect` adds a name to `reached` before
  it pushes the name, and it returns early on a name already in `reached`.
- The returned set is **membership only**. No caller reads its iteration order,
  so the traversal order of `pending` does not affect any output.

### Edit `src/http/contract/openapi.ts`

Add the import after line 6:

```ts
import { reachableSchemaNames } from "./schema-reachability.ts";
```

Replace lines 89-93, which today are:

```ts
const sortedSchemas: Record<string, unknown> = {};
for (const key of [...schemas.keys()].sort(compareBytewise)) {
  const schema = schemas.get(key);
  if (schema !== undefined) sortedSchemas[key] = schema;
}
```

with:

```ts
const allSchemas: Record<string, unknown> = {};
for (const key of [...schemas.keys()].sort(compareBytewise)) {
  const schema = schemas.get(key);
  if (schema !== undefined) allSchemas[key] = schema;
}
```

Then replace the whole return block that story 2 produced with this. It builds
the **complete unpruned document**, runs the traversal over that same object, and
replaces `components.schemas` with the filtered map:

```ts
const document: Record<string, unknown> = {
  openapi: "3.0.3",
  info: { title: "kanthord", version: KANTHORD_VERSION },
  security: [{ bearerAuth: [] }],
  paths,
  components: {
    securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
    schemas: allSchemas,
  },
};

const catalogue = eventPayloadCatalogue(entries);
if (catalogue !== undefined) {
  document[eventPayloadCatalogueKey] = catalogue;
}

const reachable = reachableSchemaNames(document);
const sortedSchemas: Record<string, unknown> = {};
for (const key of Object.keys(allSchemas)) {
  if (reachable.has(key)) sortedSchemas[key] = allSchemas[key];
}
(document.components as Record<string, unknown>).schemas = sortedSchemas;

return document;
```

Story 2 declared `const catalogue = eventPayloadCatalogue(entries);` inside the
return block. This edit keeps exactly one declaration, in the position above.
Delete no other line of story 2's edit.

**Traverse the document, never a probe.** An earlier draft of this story ran the
traversal over a synthetic object `{ paths, components: { schemas: allSchemas } }`
plus the catalogue. Do not do that. Such an object omits the root keys `openapi`,
`info` and `security`, so the code would not seed from every root key that the
emitted document actually holds, and the traversal rule and its application would
disagree. Those three roots carry no `$ref` today, so both forms produce the same
bytes now; the document form stays correct when a later epic puts a `$ref` under a
new root key. EPIC 039 is that epic.

Mutating `document.components.schemas` once, after the traversal, is deliberate:
it keeps one object as both the thing traversed and the thing returned. The
declared return type stays `Readonly<Record<string, unknown>>`.

Three ordering facts this edit depends on:

- `operationObject` at line 113 **mutates** the `schemas` map as it builds each
  path object. The paths loop at lines 77-87 must therefore stay before the
  schema map is frozen. It does.
- The traversal runs against the **full** `allSchemas`, because it resolves a
  name into its body. Pruning happens after it, never before.
- `Object.keys(allSchemas)` is already in bytewise order, so the filtered
  `sortedSchemas` keeps that order. This is the requirement "keep the bytewise
  key order".

### Formatting

```bash
npx prettier --write src/http/contract/schema-reachability.ts src/http/contract/openapi.ts
```

## Tests

Add `src/http/contract/schema-reachability.test.ts`. Use `node:test` and
`node:assert/strict`, and name the suite `src/http/contract/schema-reachability`.
Every fixture is a hand-written literal. The file starts the daemon nowhere,
reads no clock and writes no file.

Write six tests, each asserted by exact set membership through
`assert.deepEqual([...result].sort(), [...expected].sort())`.

**Write every fixture as a complete object literal in the test file.** Each
fixture is a document with a `paths` key and a `components.schemas` key, spelled
out in full. Do not build a fixture from a helper, a loop or a spread of another
fixture. The descriptions below name the exact shape and the exact expected set,
so two implementers produce the same literal.

1. **A nested `$ref` chain of depth three.** `paths` refs `A`; `A` refs `B` in a
   nested `properties` object; `B` refs `C` inside an `items` object. The result
   is exactly `["A", "B", "C"]`. A fourth schema `D`, present in
   `components.schemas` and referenced by nobody, is absent from the result.
2. **A `discriminator.mapping` with two entries.** A schema `Parent` holds
   `discriminator: { propertyName: "kind", mapping: { one: "#/components/schemas/One", two: "#/components/schemas/Two" } }`.
   `paths` refs `Parent`. The result is exactly `["Parent", "One", "Two"]`.
3. **A name that contains an escaped `/`.** `components.schemas` holds the key
   `a/b`, and `paths` refs `#/components/schemas/a~1b`. The result holds `a/b`.
4. **A name that contains an escaped `~`.** `components.schemas` holds the key
   `a~b`, and `paths` refs `#/components/schemas/a~0b`. The result holds `a~b`.

   Then, in the same test, pin the decode **order** with one discriminating
   fixture. `components.schemas` holds the key `~1`, and `paths` refs
   `#/components/schemas/~01`. Assert the result is exactly `["~1"]`, and assert
   `result.has("/")` is `false`.

   That fixture separates the two orders. Decoding `~1` first leaves `~01`
   untouched, because `~01` holds no `~1` substring, and the later `~0` step
   yields `~1`, which is correct. Decoding `~0` first yields `~1`, and the later
   `~1` step then yields `/`, which is wrong. A fixture that carries no `~0`
   followed by `1` does not separate the two orders: `a~0b` decodes to `a~b` and
   `a~1b` decodes to `a/b` under either order, so neither one proves the rule.

5. **A two-schema cycle.** `X` refs `Y` and `Y` refs `X`. `paths` refs `X`. The
   test returns, and the result is exactly `["X", "Y"]`. A test that hangs is the
   failure.
6. **A `$ref` under a root extension key.** Two separate documents, two
   separate calls, two separate assertions, in one test.

   Document A holds `paths: {}`, `components.schemas` with the single key `T`
   whose body is `{ type: "object" }`, and the root key
   `"x-kanthord-event-payloads": { t: { $ref: "#/components/schemas/T" } }`.
   Assert the result of `reachableSchemaNames(documentA)` is exactly `["T"]`.
   This proves a root extension key is a seed.

   Document B holds `paths: {}`, no extension key, and `components.schemas` with
   two keys: `Orphan`, whose body refs `#/components/schemas/Unreached`, and
   `Unreached`, whose body is `{ type: "object" }`. Assert the result of
   `reachableSchemaNames(documentB)` is exactly `[]`, the empty set. This proves
   `components` is not a seed, so a schema reachable only from inside
   `components` is not reached.

Add two tests to `src/http/contract/openapi.test.ts`, after the four tests of
story 2. Import `reachableSchemaNames` from `./schema-reachability.ts`.

7. **The master is its own closure, and pruning removes nothing from it.**

```ts
test("the master holds exactly the transitive closure of its own references", () => {
  const document = buildOpenApiDocument();
  const components = document.components as Readonly<Record<string, unknown>>;
  const schemas = components.schemas as Readonly<Record<string, unknown>>;
  assert.deepEqual(
    sortedBytewise([...reachableSchemaNames(document)]),
    sortedBytewise(Object.keys(schemas)),
  );
  assert.equal(Object.keys(schemas).length, 142);
  for (const type of Object.keys(eventPayloads)) {
    assert.equal(Object.hasOwn(schemas, type), true, `${type} was pruned`);
  }
});
```

The `142` and the 37-key loop together are the gate items "The master holds all
37 event payload schemas after pruning" and the second half of "The master
changes by exactly one root key": the pruning filter is the identity on the
master, so `components.schemas` is unchanged by this story.

8. **A slice is its own closure, and the `node` slice drops the payloads.**

```ts
test("a slice holds exactly the transitive closure of its own references", () => {
  const nodeOperations = registry.filter((entry) =>
    entry.operationId.startsWith("node."),
  );
  const document = buildOpenApiDocument(nodeOperations);
  const components = document.components as Readonly<Record<string, unknown>>;
  const schemas = components.schemas as Readonly<Record<string, unknown>>;
  assert.deepEqual(
    sortedBytewise([...reachableSchemaNames(document)]),
    sortedBytewise(Object.keys(schemas)),
  );
  for (const type of Object.keys(eventPayloads)) {
    assert.equal(Object.hasOwn(schemas, type), false, `${type} still seeded`);
  }
});
```

## Constraints

- **`schema-reachability.ts` imports nothing.** It is a pure traversal over a
  plain object. It reads no clock and no file. `AGENTS.md` puts it under
  `http/contract/`, which may import `domain/` and `http/contract/` only, and this
  file needs neither.
- **No change to `paths`, to an operation, or to an emitted schema body.** Only
  the schema key set of a slice changes.
- **Pruning never removes a name that the traversal reached.** The filter keeps
  a key of `allSchemas` when the reached set holds it, so pruning cannot turn a
  live `$ref` into a dangling one. It does not follow that every reached name
  exists: the traversal collects the target of a `$ref` even when
  `components.schemas` has no such key, and filtering cannot create a missing
  key. A pre-existing dangling `$ref` therefore stays dangling, and the closure
  test plus `SwaggerParser` are what detect it. Do not add code that invents a
  body for a missing name.
- **One traversal, no build mode.** `buildOpenApiDocument` and
  `renderOpenApiYaml` keep their single `entries` parameter. Add no flag.
- **`Error` disappears from eight slices, and that is the rule working.** The
  eight are `actor`, `blob`, `edge`, `event`, `plan`, `project`, `provider` and
  `system`. Every operation in each of those declares `errors`, so each gets its
  own `<operationId>.error` component and no operation refs
  `#/components/schemas/Error`. The other eleven slices keep `Error`. Do not add
  `Error` back.

## Verify

```bash
node --test \
  src/http/contract/schema-reachability.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/event-payload.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/path.test.ts
npm run typecheck && npx eslint .
```

- The eight new tests pass, and test 5 returns rather than hangs.
- `"registers every schema component in bytewise order"` at
  `src/http/contract/openapi.test.ts:211` passes **unmodified**. It pins the exact
  ordered list of the master's 142 component keys, so its passing is the proof
  that pruning changed the master by nothing.
- `"each payload schema emits as a named component"` at
  `src/http/contract/event-payload.test.ts:564` passes **unmodified**. It asserts
  every one of the 37 types is a named component of the master.
- `"refers to components only through internal refs"` at
  `src/http/contract/openapi.test.ts:512` passes unmodified, which proves pruning
  left no dangling `$ref` in the master.

Proof: this story delivers the `schema-reachability.test.ts` line of the EPIC
Proof command, and it keeps green the `openapi.test.ts`, `event-payload.test.ts`,
`registry.test.ts`, `parity.test.ts`, `coverage.test.ts`, `example.test.ts` and
`path.test.ts` lines of that command.

It delivers these gate items in full: "A pointer escape round-trips" and "The
master holds all 37 event payload schemas after pruning".

It delivers the gate item "Every emitted document holds the transitive closure of
its own references" **in part only**: for the master and for one slice built in
process, plus the fixtures for a nested `$ref` and for a `discriminator` mapping.
Story 4 delivers the rest, which is the same assertion over all 20 documents the
publication writes to disk. Do not read this story as closing that gate item.

It delivers the second half of the gate item "The master changes by exactly one
root key": test 7 asserts `reachableSchemaNames` over the master equals the
master's full 142-key schema set, so the pruning filter is the identity on the
master and `components.schemas` cannot have changed. Story 2 delivers the first
half. The EPIC gate names the existing contract suite as the rest of the
baseline, and no test of that suite may be edited by either story.
