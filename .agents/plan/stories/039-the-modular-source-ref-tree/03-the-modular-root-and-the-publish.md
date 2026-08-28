# Story 3 — `source/openapi.yaml` is the modular root, and the publish writes the tree

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Depends on: Story 2 — the root references the fragments Story 2 emits, and Story 1's component files.

**Two lanes.** `src/http/contract/openapi-source.ts` and `scripts/publish-contract.ts` are the
software-engineer lane (`scripts/lane-check.sh:77-86` and `:87-94`).
`src/http/contract/openapi-source.test.ts` and `scripts/publish-contract.test.ts` are the
test-engineer lane (`scripts/lane-check.sh:79-84` and `:88-89`).

**This story breaks a live assertion, and repairing it is part of the story.**
`scripts/publish-contract.test.ts:75-80` asserts the top-level publication listing deep-equals
`["examples", "features", "manifest.json", "openapi.yaml"]`. Writing `source/` adds a fifth entry and
that assertion fails. It is a correct failure — the listing changed on purpose — and the fix is to
add `"source"` in bytewise position, not to loosen the assertion. Do not discover this at
`npm run verify` time; the `## Change` section below names the edit.

## Change

### Extend `buildOpenApiSourceTree` in `src/http/contract/openapi-source.ts`

One further map entry, at key `openapi.yaml`. Its value is
`YAML.stringify(root, { lineWidth: 0 })`.

**The root key order follows the master document's key order.** Build the root by walking
`Object.keys(document)` in order and mapping each key, rather than by writing an object literal:

```ts
const root: Record<string, unknown> = {};
for (const key of Object.keys(document)) {
  root[key] = rootValueFor(key, document);
}
```

Today that order is `openapi`, `info`, `security`, `paths`, `components`, and after EPIC 037 it is
those five followed by `x-kanthord-event-payloads`. Walking the master's keys is what keeps the two
forms in step when EPIC 037's key lands, and it is why this story hardcodes no root key list.

**Per key:**

- **`openapi`, `info`, `security`** — copy the master value unchanged. `openapi` stays `"3.0.3"`. The
  split and the OpenAPI version are independent decisions.

- **`paths`** — copy every path key of the master, in the master's order, and inside each path object
  copy every method key in the master's order. Replace each method value with:

  ```ts
  {
    $ref: `./features/${prefixOf(operationId)}.yaml#/operations/${operationId}`;
  }
  ```

  where `operationId` is the `operationId` of the master's operation object at that position.
  `prefixOf` is Story 1's helper, applied here to an `operationId`, which is exactly the rule
  `openApiFeatures` applies at `openapi.ts:23-27`. The reference object carries the key `$ref` and no
  other key.

- **`components`** — an object with two keys, in the master's order, `securitySchemes` then `schemas`:

  ```ts
  {
    securitySchemes: {
      bearerAuth: { $ref: "./components/security.yaml#/securitySchemes/bearerAuth" },
    },
    schemas: /* one entry per master schema key, in the master's order */,
  }
  ```

  Each `schemas` value is
  ``{ $ref: `./components/${prefixOf(name)}.yaml#/schemas/${name}` }``.

  Copy the `securitySchemes` key set from the master rather than writing `bearerAuth` twice. Today
  the master holds exactly one scheme, `bearerAuth` (`openapi.ts:100`), so the emitted object holds
  exactly that one entry.

- **`x-kanthord-event-payloads`** — apply `rewriteRefs(document[key], "./")`. EPIC 037 emits that
  value as an object of 37 keys, in bytewise order, each `{ $ref: "#/components/schemas/<type>" }`.
  Story 1's rewrite turns each into `` `./components/${prefixOf(type)}.yaml#/schemas/${type}` ``,
  which is the form the EPIC states. **Add no special case for this key.** It is ordinary document
  content and one generic rewrite already produces the right answer. The nine prefixes the 37 types
  carry — `actor`, `lease`, `node`, `outcome`, `plan`, `project`, `provider`, `recovery`,
  `repository` — each already name a component file, so the file count stays 15.

- **Any other root key** — **throw**, naming the key:

  ```ts
  throw new Error(`unknown root key in the master document: ${key}`);
  ```

  The EPIC states an exact root shape, and a silent generic pass-through would publish a future root
  key in a reference form nobody decided. A refusal turns that into one failing test at the moment
  the key appears, which is the deterministic outcome. Do not replace this arm with
  `rewriteRefs(document[key], "./")`.

  The six keys the arms above cover — `openapi`, `info`, `security`, `paths`, `components`,
  `x-kanthord-event-payloads` — are the whole master root after EPIC 037. Five of them exist today.

A feature fragment holds no copy of `x-kanthord-event-payloads`, because it is a root key.

### Edit `scripts/publish-contract.ts`

Four edits.

1. **Import the builder**, beside the existing import at lines 6-9:

   ```ts
   import { buildOpenApiSourceTree } from "../src/http/contract/openapi-source.ts";
   ```

2. **Remove a stale `source/`.** Immediately after the `features` removal that ends at line 55, and
   before the `openapi.yaml` removal at line 56, insert:

   ```ts
   rmSync(join(outputDirectory, "source"), {
     recursive: true,
     force: true,
   });
   ```

   The three directory removals then sit together, followed by the two file removals.

3. **Create the two directories.** After `mkdirSync(join(outputDirectory, "features"), …)` at line 61,
   insert:

   ```ts
   mkdirSync(join(outputDirectory, "source", "components"), {
     recursive: true,
   });
   mkdirSync(join(outputDirectory, "source", "features"), { recursive: true });
   ```

   `recursive: true` creates `source` itself. There is no third `mkdirSync` for `source` alone.

4. **Write the tree.** After the examples loop ends at line 101, and before the manifest object at
   line 103, insert:

   ```ts
   for (const [relative, text] of buildOpenApiSourceTree()) {
     const target = join("source", relative);
     writeFileSync(join(outputDirectory, target), text, { encoding: "utf8" });
     written.push(target);
   }
   ```

   The map is already in bytewise key order, and the sort at line 117 is unchanged and still runs
   over the whole `written` list.

Change nothing else in this file. The manifest object stays as it is — Story 6 adds its `source`
field.

### Extend `src/http/contract/openapi-source.test.ts`

Five further tests, after Story 2's four.

11. **`test("emits one root, nineteen fragments and fifteen component files")`** — assert the map
    size is `35`, and assert the map holds the key `openapi.yaml`.

12. **`test("keeps the root key order of the master document")`** — assert
    `Object.keys(YAML.parse(tree.get("openapi.yaml")))` deep-equals
    `Object.keys(buildOpenApiDocument())`. Pin the master order by value in the same test, so a
    silent reordering upstream is visible here:
    `assert.deepEqual(Object.keys(buildOpenApiDocument()).slice(0, 5), ["openapi", "info", "security", "paths", "components"])`.

13. **`test("references a fragment from every path method")`** — parse the root. For every path key
    and every method key, assert the value deep-equals
    ``{ $ref: `./features/${prefix}.yaml#/operations/${operationId}` }`` where `operationId` comes
    from the master's operation at the same position. `deepEqual` against a one-key object is what
    asserts the reference object carries `$ref` and no sibling. Assert the root's path keys and each
    path's method keys deep-equal the master's, so the join is order-preserving.

14. **`test("references a component from every schema and from the security scheme")`** — assert
    `Object.keys(root.components.schemas)` deep-equals `Object.keys(master.components.schemas)`, and
    for every name assert the value deep-equals
    ``{ $ref: `./components/${name.split(".")[0]}.yaml#/schemas/${name}` }``. Assert
    `root.components.securitySchemes` deep-equals
    `{ bearerAuth: { $ref: "./components/security.yaml#/securitySchemes/bearerAuth" } }`.

15. **`test("carries the event payload catalogue as thirty-seven external references")`** — assert
    the root holds the key `x-kanthord-event-payloads`. Assert its key count is `37` by value, and
    that its key order deep-equals the master extension's key order. Assert the raw root text
    includes this line exactly:

    ```ts
    assert.ok(
      text.includes(
        "  node.created:\n    $ref: ./components/node.yaml#/schemas/node.created\n",
      ),
    );
    ```

    Assert **every** value by its exact derived string, not by a pattern:

    ```ts
    for (const [type, value] of Object.entries(catalogue)) {
      assert.deepEqual(value, {
        $ref: `./components/${type.split(".")[0]}.yaml#/schemas/${type}`,
      });
    }
    ```

    `deepEqual` against a one-key object is what asserts the reference object carries `$ref` and no
    sibling. A regex would accept a reference into the wrong component file; this does not.

    **This test depends on EPIC 037.** If the extension key is absent, the epic's prerequisite did
    not land — report that, do not weaken the test to skip the key.

16. **`test("refuses an unknown root key")`** — call `buildOpenApiSourceTree` on a synthetic
    document is not possible, because the function takes `entries`, not a document. Assert the
    refusal by construction instead: assert that the set of master root keys is exactly the set the
    builder handles.

    ```ts
    assert.deepEqual(
      Object.keys(buildOpenApiDocument()).filter(
        (key) =>
          ![
            "openapi",
            "info",
            "security",
            "paths",
            "components",
            "x-kanthord-event-payloads",
          ].includes(key),
      ),
      [],
    );
    ```

    When EPIC 037 or a later epic adds a root key, this test fails first and names it, before the
    thrown `Error` reaches a publish. That is the assertion that makes the refusal arm reachable
    knowledge rather than dead code.

### Extend `scripts/publish-contract.test.ts`

Three edits.

- **Repair the listing assertion at `:75-80`.** Add `"source"` in bytewise position — after
  `"openapi.yaml"`, because `o` is `0x6f` and `s` is `0x73`:

  ```ts
  assert.deepEqual(sortedBytewise(readdirSync(directory)), [
    "examples",
    "features",
    "manifest.json",
    "openapi.yaml",
    "source",
  ]);
  ```

- **Assert the tree reached disk.** In the same subtest, after that assertion, add:

  ```ts
  assert.deepEqual(sortedBytewise(readdirSync(join(directory, "source"))), [
    "components",
    "features",
    "openapi.yaml",
  ]);
  assert.equal(readdirSync(join(directory, "source", "components")).length, 15);
  assert.equal(readdirSync(join(directory, "source", "features")).length, 19);
  ```

- **Extend the stale-file subtest** — the one named `"clears a stale file from a previous publication"`,
  today at `:419`. Add a stale file beside the three it already writes, and assert it is gone:

  ```ts
  writeFileSync(join(directory, "source", "components", "gone.yaml"), "junk");
  ```

  ```ts
  assert.equal(
    existsSync(join(directory, "source", "components", "gone.yaml")),
    false,
  );
  ```

  This is the coverage for edit 2 of the publish script.

The reproducibility subtest at `:285-310` and the released-versus-unreleased subtest at `:344-379`
both iterate the returned `written` list, so they now cover every `source/` file with no edit.

## Constraints

- **Do not loosen `scripts/publish-contract.test.ts:75-80`.** The publication listing is an exact set
  and it stays one. Add `"source"`; do not switch to a subset check, a filter or an `ok`.
- **Do not touch the manifest object.** Story 6 adds `source: "source/openapi.yaml"`. Two stories
  editing one object literal is what makes a rebase lose a field.
- **Do not touch the sort at `scripts/publish-contract.ts:117`.** It sorts the whole `written` list
  bytewise, and a `source/...` entry sorts correctly with no help.
- **`written` holds the path relative to the output directory, with the `source/` prefix.** It is
  `source/components/actor.yaml`, not `components/actor.yaml`. The map key carries no prefix; the
  publish script adds it. The reproducibility subtest reads `join(directory, relative)`, so a missing
  prefix silently reads the wrong file.
- **`components.schemas` in the modular root is a map of reference objects, and it is not pruned.**
  EPIC 037 prunes the master to its reachable closure; the root copies whatever the master holds after
  that pruning. Do not add a second reachability pass here.
- **Add no special case for `x-kanthord-event-payloads`.** One generic rewrite covers it. A special
  case is a second place to update when the catalogue moves.
- **`scripts/publish-contract.ts` imports the builder from `src/`, which is already its pattern**
  (`:5-10` imports `src/domain/version.ts`, `src/http/contract/openapi.ts` and
  `src/http/contract/registry.ts`). Add no logic to the script beyond the loop above — the shape of
  the tree is the module's decision, and the script writes bytes.
- **Do not change the bytes of `openapi.yaml` or of any `features/*.yaml` slice.** Those writes at
  `:66-79` are untouched.

## Verify

```bash
node --test src/http/contract/openapi-source.test.ts
```

All fifteen tests pass.

```bash
node --test scripts/publish-contract.test.ts scripts/release-gate.test.ts scripts/release-facts.test.ts
```

`publish-contract.test.ts` passes, including the repaired listing assertion, the new `source/`
listing assertions and the extended stale-file subtest. The two release tests pass unchanged — this
story edits `scripts/publish-contract.ts`, which imports both modules at `:11-12`, and it changes
neither.

Publish once by hand and read the tree. **The CLI refuses a dirty working tree** — `cliDecision`
at `scripts/release-gate.ts` exits `2` with `dirty-tree`, and `--unreleased` skips the tag check
only. Run this after committing the story, or expect `dirty-tree` and read it as the release gate
working, not as this story failing. The hermetic proof is the test above, which calls
`publishContract` directly and never reads the git tree.

```bash
OUT=$(mktemp -d)
node scripts/publish-contract.ts --unreleased "$OUT" && \
  find "$OUT" -type f | sed "s|$OUT/||" | sort | head -20 && \
  echo "--- counts ---" && \
  ls "$OUT/source/components" | wc -l && \
  ls "$OUT/source/features" | wc -l && \
  head -3 "$OUT/source/openapi.yaml"
rm -rf "$OUT"
```

reports `15` component files, `19` fragments, and a root whose first key is `openapi: 3.0.3`.

Prove the root resolves before Story 4 automates it. Same clean-tree precondition:

```bash
OUT=$(mktemp -d)
node scripts/publish-contract.ts --unreleased "$OUT" >/dev/null
node -e '
const SwaggerParser = (await import("@apidevtools/swagger-parser")).default;
const root = process.argv[1] + "/source/openapi.yaml";
const bundled = await SwaggerParser.bundle(root);
console.log("external refs left:", JSON.stringify(bundled).includes(".yaml#"));
await SwaggerParser.validate(root);
console.log("validate: PASS");
' "$OUT"
rm -rf "$OUT"
```

reports `external refs left: false` and `validate: PASS`.

Scope check:

```bash
git diff --name-only HEAD -- src/http/contract scripts
```

names exactly `src/http/contract/openapi-source.ts`,
`src/http/contract/openapi-source.test.ts`, `scripts/publish-contract.ts` and
`scripts/publish-contract.test.ts`.

The gate's renderer clause:

```bash
git diff --quiet HEAD -- \
  src/domain \
  $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$' | grep -v 'openapi-source\.ts$') \
  && echo "master renderer inputs unchanged"
```

exits 0. This story edits no module `renderOpenApiYaml` reads, so the published master and every
slice keep the bytes they hold today.

**The production-mutation failure proofs belong to this story, not to Story 4 or Story 5.** Only
the software-engineer may edit `src/http/contract/openapi-source.ts`
(`scripts/lane-check.sh:79-84` denies it to the test-engineer), so run them here, after Stories 4
and 5 land, and revert each one before the next. Confirm every revert with
`git diff --quiet HEAD -- src/http/contract/openapi-source.ts`.

- Pass `"./"` instead of `"../"` when rewriting a feature fragment.
  `test("validates the modular root from disk")` rejects.
- Delete the `x-kanthord-event-payloads` arm, so the root omits the key.
  `test("dereferences to the same document as the canonical master")` fails and names the missing
  root key.
- Reverse one operation's `parameters` array **in the feature-fragment builder** — the root holds
  reference objects and no `parameters` array, so the root builder is the wrong site for this one.
  `test("dereferences to the same document as the canonical master")` fails. This is the mutation
  that proves the Story 4 normaliser does not sort arrays.
- Point one `components.schemas` reference at the wrong component file.
  `test("validates the modular root from disk")` rejects on a missing pointer.
- Emit one reference as `../../components/actor.yaml#/...` from a feature fragment.
  `test("resolves every emitted reference inside the publication directory")` fails and names the
  file and the reference.

`npm run verify` exits 0.

Proof: this story delivers the `src/http/contract/openapi-source.test.ts` and
`scripts/publish-contract.test.ts` clauses of the EPIC Proof block, and it is what makes
`npm run contract:publish -- "$(mktemp -d)"` write both forms. It delivers the gate bullet
**`source/openapi.yaml` carries `x-kanthord-event-payloads` with 37 external references** for the
emission half; Story 4 delivers its dereference half.
