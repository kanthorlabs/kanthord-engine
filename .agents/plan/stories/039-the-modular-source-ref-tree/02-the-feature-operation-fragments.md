# Story 2 — `source/features/<feature>.yaml` holds the operation fragments

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Depends on: Story 1 — it extends the module and the test file Story 1 created, and it reuses Story
1's private `prefixOf` and `rewriteRefs`.

**Two lanes.** `src/http/contract/openapi-source.ts` is the software-engineer lane;
`src/http/contract/openapi-source.test.ts` is the test-engineer lane
(`scripts/lane-check.sh:77-86`).

This story adds entries to the map. It rewrites no line Story 1 wrote and changes no component file
byte.

## Change

### Extend `buildOpenApiSourceTree` in `src/http/contract/openapi-source.ts`

Emit one file per feature of `openApiFeatures(entries)`. Import it beside `buildOpenApiDocument`:

```ts
import { buildOpenApiDocument, openApiFeatures } from "./openapi.ts";
```

**There are 19 features today**, because `openApiFeatures` groups by the `operationId` prefix, not by
the schema-name prefix: `actor`, `agent`, `attempt`, `binding`, `blob`, `edge`, `event`,
`gitOperation`, `instructions`, `node`, `plan`, `profile`, `project`, `provider`, `repository`,
`run`, `system`, `template`, `worker`. That is a different set and a different count from the 15
component files, and both are correct. A `stubbed` feature such as `agent` emits schemas for no
operation, so its fragment holds a reference to `Error` alone.

**The map key** is `` `features/${feature.name}.yaml` ``.

**The map value** is:

```ts
YAML.stringify({ operations }, { lineWidth: 0 });
```

One top-level key, `operations`. No `paths`, no `components`, no `openapi`, no `info`.

**Building `operations`.** The keys are the `operationId` values of that feature, in bytewise order.
`openApiFeatures` already sorts each feature's operations bytewise by `operationId` at
`openapi.ts:38-40`, so iterate `feature.operations` in the order it hands them over and insert each
key in that order. Do not re-sort, and do not build the object from `Object.keys` of anything else.

**The value of each key is the operation object the master document already holds.** Do not call
`operationObject` — it is private to `openapi.ts` and this story adds no export to that file. Take
the object out of `buildOpenApiDocument(entries).paths` instead, and index it by `operationId`:

```ts
const operationsById = new Map<string, unknown>();
for (const pathObject of Object.values(
  document.paths as Record<string, unknown>,
)) {
  for (const operation of Object.values(
    pathObject as Record<string, unknown>,
  )) {
    const id = (operation as { operationId?: unknown }).operationId;
    if (typeof id === "string") operationsById.set(id, operation);
  }
}
```

Build that index once, beside the component grouping, from the one `buildOpenApiDocument(entries)`
call Story 1 already makes. An `operationId` is unique across the document — `registry.test.ts`
asserts it — so the map never overwrites.

**Rewrite each operation with base `"../"`**, because a feature fragment sits in `source/features/`
and reaches a sibling directory:

```ts
operations[id] = rewriteRefs(operationsById.get(id), "../");
```

That is Story 1's helper, unchanged. It turns `#/components/schemas/actor.list.response` into
`../components/actor.yaml#/schemas/actor.list.response`.

**An operation whose id the index does not hold is a defect, not a skip.** Throw an `Error` naming
the id. `openApiFeatures(entries)` and `buildOpenApiDocument(entries)` read the same `entries`, so
the two sets are equal by construction; a silent `continue` would emit a short fragment and the
Story 4 bundle would then fail with an unrelated message.

### Extend `src/http/contract/openapi-source.test.ts`

Four further tests, after Story 1's six.

7. **`test("emits nineteen feature fragments")`** — filter the map keys to those starting with
   `features/`. Assert the count is `19` by value, and assert the sorted key list deep-equals the
   bytewise sort of `openApiFeatures().map((feature) => \`features/${feature.name}.yaml\`)`.

8. **`test("keys a fragment by operationId in bytewise order")`** — for every feature, parse
   `` `features/${feature.name}.yaml` `` with `YAML.parse` and assert
   `Object.keys(parsed.operations)` deep-equals
   `feature.operations.map((entry) => entry.operationId)`. That expected array is already bytewise
   sorted, so this asserts the order and the membership in one comparison. Assert the parsed object
   holds exactly one top-level key: `assert.deepEqual(Object.keys(parsed), ["operations"])`.

9. **`test("holds the exact reference line of actor.list")`** — assert the raw text of
   `features/actor.yaml` includes this line exactly, verified against the tree:

   ```ts
   assert.ok(
     text.includes(
       "              $ref: ../components/actor.yaml#/schemas/actor.list.response\n",
     ),
   );
   ```

   Fourteen spaces of indentation: `operations` (0), `actor.list` (2), `responses` (4), `"200"` (6),
   `content` (8), `application/json` (10), `schema` (12), `$ref` (14). Assert the sibling error line
   the same way:

   ```ts
   assert.ok(
     text.includes(
       "              $ref: ../components/actor.yaml#/schemas/actor.list.error\n",
     ),
   );
   ```

10. **`test("leaves no internal component pointer in a feature fragment")`** — for every
    `features/*.yaml` value, assert `value.includes("#/components/schemas/")` is `false`, and assert
    `value.includes("../components/")` is `true` for at least the `actor` fragment. The first
    assertion is the guard; the second stops an empty rewrite from passing the first vacuously.

## Constraints

- **Extend one production file and one test file. Change nothing else.** Do not edit
  `src/http/contract/openapi.ts`. In particular do not export `operationObject` — a fragment reads
  the built document, and that keeps the two forms provably the same object.
- **Do not re-sort `feature.operations`.** `openapi.ts:38-40` already sorts it bytewise by
  `operationId`. A second sort is a second source of truth for one order.
- **The fragment holds `operations` and nothing else.** No `paths` key. The EPIC's decision is that a
  path-keyed fragment cannot assign `/v1/project/{id}/node` to one feature, because that path carries
  `project.nodes` and `node.create`. An operation-keyed fragment is what makes the split possible, and
  the root joins the operations back into a path item in Story 3.
- **Use base `"../"` here and `"./"` in a component file.** The two differ because the files sit at
  two depths. Passing `"./"` here emits `./components/actor.yaml#/...` from
  `source/features/actor.yaml`, which resolves to `source/features/components/actor.yaml` and does not
  exist. Story 5's containment test catches it; do not rely on that.
- **Do not mutate the document `buildOpenApiDocument` returned.** `rewriteRefs` builds a new object.
  The same operation object is also read by Story 3's root builder, and a mutation there would move
  the master bytes.
- **Preserve `parameters` array order.** It is contract, and the Story 4 comparison does not normalise
  it.
- **Change no component file byte.** Story 1's exact-bytes test for `components/security.yaml` and the
  fifteen-file count must both still pass unchanged.

## Verify

```bash
node --test src/http/contract/openapi-source.test.ts
```

All ten tests pass — Story 1's six and this story's four.

```bash
node --test src/http/contract/openapi.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts scripts/publish-contract.test.ts
```

All pass unchanged. Nothing writes `source/` yet.

Prove the fragment set covers every routed and stubbed operation exactly once:

```bash
node -e '
const { buildOpenApiSourceTree } = await import("./src/http/contract/openapi-source.ts");
const { registry } = await import("./src/http/contract/registry.ts");
const YAML = (await import("yaml")).default;
const tree = buildOpenApiSourceTree();
const ids = [];
for (const [key, text] of tree) {
  if (!key.startsWith("features/")) continue;
  ids.push(...Object.keys(YAML.parse(text).operations));
}
const expected = registry.map((e) => e.operationId).sort();
console.log("fragment ids:", ids.length, "registry ids:", expected.length);
console.log("equal:", JSON.stringify(ids.sort()) === JSON.stringify(expected));
'
```

reports equal counts and `equal: true`.

Scope check — name the paths, because other agents have work in this tree:

```bash
git diff --name-only HEAD -- src/http/contract
```

names exactly `src/http/contract/openapi-source.ts` and
`src/http/contract/openapi-source.test.ts`.

The gate's renderer clause:

```bash
git diff --quiet HEAD -- \
  src/domain \
  $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$' | grep -v 'openapi-source\.ts$') \
  && echo "master renderer inputs unchanged"
```

exits 0. This story edits no module `renderOpenApiYaml` reads, so the published master and every
slice keep the bytes they hold today.

Hermetic check:
`grep -c 'mkdtemp\|Date.now\|fetch(\|process.env' src/http/contract/openapi-source.test.ts` reports
`0`.

`npm run verify` exits 0.

Proof: this story delivers the `src/http/contract/openapi-source.test.ts` clause of the EPIC Proof
block, extended. It carries no gate bullet of its own; it is the precondition for the root of Story
3 and for the bundle of Story 4.
