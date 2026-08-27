# Story 5 — The containment test and the reproducibility test

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Depends on: Story 4 — it extends the file Story 4 created.

**Test only.** This story extends `scripts/publish-contract.source.test.ts` and changes no production
file. `scripts/lane-check.sh:87-93` puts it in the test-engineer lane.

**Unlike Story 4, this story has a real RED step.** Test 8 exercises a pure classifier against
synthetic references; write it first and it fails against an unwritten `classifyRef`. Tests 5, 6 and
7 pass on first run, and their failure modes are proved against a scratch copy of the published
output — never against a production file, which this lane may not touch.

## Change

### Extend `scripts/publish-contract.source.test.ts`

Add these imports to the existing list:

```ts
import YAML from "yaml";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import {
  buildOpenApiDocument,
  openApiFeatures,
  renderOpenApiYaml,
} from "../src/http/contract/openapi.ts";
import { buildOpenApiSourceTree } from "../src/http/contract/openapi-source.ts";
import { registry } from "../src/http/contract/registry.ts";
```

`YAML` is needed to parse an emitted `.yaml` file, `statSync` to drop a directory from the walk. Both
are missing from Story 4's import list; add them here rather than assuming them.

**One shared walker, private to this file.** It returns every emitted file path relative to the
publication directory, in bytewise order:

```ts
function emittedFiles(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[])
    .map((name) => name.split(sep).join("/"))
    .filter((name) => statSync(join(directory, name)).isFile())
    .sort(compareBytewise);
}
```

`readdirSync(..., { recursive: true })` yields directories as well as files, so `statSync().isFile()`
is what drops them. This is the same recursive-read idiom `openapi.test.ts:588` uses.
`compareBytewise` is Story 4's private helper, in place.

**The reference collector Story 4 introduced**, restated here because this story is what makes it
walk every reference position rather than a known list of them:

```ts
function collectRefs(node: unknown, found: string[]): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return found;
  }
  if (node !== null && typeof node === "object") {
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === "$ref" && typeof value === "string") found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}
```

It walks every key, so a reference under a root extension key is collected like any other. The 37
references under `x-kanthord-event-payloads` are part of the set by construction, not by a special
case.

**Four further tests.** Write test 8 first — it is the only one with a genuine RED.

5. **`test("resolves every emitted reference inside the publication directory")`** — publish once,
   then walk. For each emitted file whose name ends in `.yaml` or `.json`, parse it — `YAML.parse`
   for `.yaml`, `JSON.parse` for `.json` — and collect its references. For each reference, apply this
   rule, in this order:

   1. Split the reference at the first `#`. The part before it is the **path part**; the part after
      it is the JSON Pointer and this test ignores it.
   2. An empty path part is an internal reference. It resolves inside the file that holds it, so it
      passes.
   3. A path part that starts with `/` is a defect.
   4. A path part that matches `/^[A-Za-z][A-Za-z0-9+.-]*:/` carries a URL scheme and is a defect.
   5. Otherwise compute `resolve(dirname(absoluteFilePath), pathPart)`. It is a defect unless it
      starts with `` `${resolve(directory)}${sep}` ``, and unless `existsSync` of it is `true`.

   Collect every defect rather than throwing on the first, and assert the collected array
   deep-equals `[]`. **The message names the file that holds the reference and the reference
   itself**, which is what the EPIC gate requires:

   ```ts
   assert.deepEqual(
     offenders,
     [],
     offenders.map((o) => `${o.file} holds ${o.ref}`).join("\n"),
   );
   ```

   **Assert the walk by value, not by a threshold.** `AGENTS.md` requires a test to assert a value,
   never "some value", so derive both expectations from the document rather than writing a magic
   number:

   ```ts
   const document = buildOpenApiDocument();
   const methodCount = Object.values(
     document.paths as Record<string, Record<string, unknown>>,
   ).reduce((total, item) => total + Object.keys(item).length, 0);
   const schemaCount = Object.keys(
     (document.components as { schemas: object }).schemas,
   ).length;
   const catalogueCount = Object.keys(
     (document as Record<string, object>)["x-kanthord-event-payloads"],
   ).length;

   const rootRefs = collectRefs(
     YAML.parse(
       readFileSync(join(directory, "source", "openapi.yaml"), "utf8"),
     ),
     [],
   );
   assert.equal(
     rootRefs.length,
     methodCount + 1 + schemaCount + catalogueCount,
   );
   ```

   One reference per path method, one for `bearerAuth`, one per schema, and one per catalogue entry.
   Every term is read from the master at test time, so the assertion survives EPIC 037 and any later
   schema addition without an edit.

   Assert the file walk by value too:

   ```ts
   const exampleCount = registry.filter(
     (entry) => entry.examples !== undefined,
   ).length;
   assert.equal(
     emittedFiles(directory).length,
     1 +
       openApiFeatures().length +
       exampleCount +
       1 +
       buildOpenApiSourceTree().size,
   );
   ```

   The master, the slices, the examples, the manifest and the tree. Measured today that is
   `1 + 19 + 43 + 1 + 35 = 99`, and the expression stays correct when a count moves.

6. **`test("emits identical bytes for every source file across two publications")`** — publish into
   two separate `mkdtemp` directories, with the same `commit` and `tag`. The two directory names
   differ, so a byte difference proves the emission depends on an absolute path. Assert the
   `source/` file lists are equal, then compare each file:

   ```ts
   const first = emittedFiles(a).filter((name) => name.startsWith("source/"));
   const second = emittedFiles(b).filter((name) => name.startsWith("source/"));
   assert.deepEqual(first, second);
   assert.equal(first.length, buildOpenApiSourceTree().size);
   for (const name of first) {
     assert.equal(
       Buffer.compare(readFileSync(join(a, name)), readFileSync(join(b, name))),
       0,
       name,
     );
   }
   ```

   `Buffer.compare` on the raw buffers, not a string comparison — the EPIC's determinism rule is
   about bytes. The expected count is the map size — `1` root plus `19` fragments plus `15` component
   files, `35` today — read from the builder rather than hardcoded, so a lost **write** fails here
   even though a lost **map entry** would not. Story 1 test 1 and Story 3 test 11 pin the map size
   itself by value, which is what closes that second case.

7. **`test("keeps the self-contained forms self-contained")`** — publish once, then:

   ```ts
   const masterPath = join(directory, "openapi.yaml");
   const masterRefs = collectRefs(
     YAML.parse(readFileSync(masterPath, "utf8")),
     [],
   );
   assert.deepEqual(
     masterRefs.filter((ref) => !ref.startsWith("#/components/schemas/")),
     [],
   );
   assert.equal(
     Buffer.compare(
       readFileSync(masterPath),
       Buffer.from(renderOpenApiYaml(), "utf8"),
     ),
     0,
   );
   for (const feature of openApiFeatures()) {
     const slice = join(directory, "features", `${feature.name}.yaml`);
     const sliceRefs = collectRefs(YAML.parse(readFileSync(slice, "utf8")), []);
     assert.deepEqual(
       sliceRefs.filter((ref) => !ref.startsWith("#/components/schemas/")),
       [],
       feature.name,
     );
     assert.equal(
       Buffer.compare(
         readFileSync(slice),
         Buffer.from(renderOpenApiYaml(feature.operations), "utf8"),
       ),
       0,
       feature.name,
     );
   }
   ```

   Walking the references beats a `.includes(".yaml#")` search: the substring test passes a reference
   spelled `../components/actor.yml#/…`, a path-only reference with no fragment, and an absolute
   path. Asserting that every reference starts with `#/components/schemas/` is the positive form of
   "self-contained".

   The `Buffer.compare` against `renderOpenApiYaml` is what pins the master and each slice to the
   canonical renderer. See the note below on what this test can and cannot prove.

> **What the byte assertion proves, and what closes the rest.** This test pins the published master
> and every slice to `renderOpenApiYaml()`, which is the assertion the sibling test at
> `scripts/publish-contract.test.ts:434-437` already makes for the master. It proves the publish step
> did not corrupt the bytes; it cannot by itself prove the renderer emits what it emitted before this
> epic. What closes that half is the change set: no story of this epic edits
> `src/http/contract/openapi.ts`, any module it reads, or `src/domain/version.ts`, and every story's
> scope check asserts it. The EPIC gate states both halves in those terms, so this test delivers the
> bullet as written — it is not a weakened substitute.

## Constraints

- **Extend one file. Change nothing else.** Do not edit `scripts/publish-contract.ts`,
  `src/http/contract/openapi-source.ts` or `scripts/publish-contract.test.ts`.
- **Walk every reference position. Never enumerate a list of known positions.** A walk that visits
  `paths`, `components` and `x-kanthord-event-payloads` by name stops seeing a reference the moment a
  new root key appears, and the EPIC states that the catalogue is one such position among many rather
  than a special one.
- **Collect every defect, then assert once.** Throwing on the first offender reports one file when
  five are broken, and the gate requires the failure to name the offending file.
- **Assert the walk is non-empty before trusting a negative.** An empty walk passes every
  "no reference is bad" assertion. Both the file count and the reference count are asserted by value
  for that reason.
- **An internal `#/...` reference passes.** `features/*.yaml` is self-contained and holds only those.
  A rule that demands a path part on every reference fails every slice.
- **Compare bytes with `Buffer.compare` on buffers.** Do not read as `utf8` and compare strings for
  the reproducibility assertion — the determinism rule is about bytes.
- **Publish into two directories whose names differ.** Two `mkdtemp` calls give that for free. A
  single directory published twice proves nothing about absolute-path independence.
- **Every test owns its own `mkdtemp` directory and removes it in `finally`.** Test 6 owns two.
- **Do not import `@apidevtools/swagger-parser` into a production source.** This story imports
  `renderOpenApiYaml` and `openApiFeatures` from `src/http/contract/openapi.ts` into a test under
  `scripts/`, which is the pattern `scripts/publish-contract.test.ts` already follows.

## Verify

```bash
node --test scripts/publish-contract.source.test.ts
```

All eight tests pass — Story 4's four and this story's four.

**The containment rule gets a real RED, inside this lane.** Extract steps 1 to 5 of test 5 into a
pure private function and test it against synthetic values. No production file is touched, and the
test fails before it passes:

```ts
type RefVerdict = "ok" | "absolute" | "scheme" | "escapes" | "missing";

function classifyRef(
  ref: string,
  fileDirectory: string,
  root: string,
): RefVerdict;
```

8. **`test("classifies a reference against the publication boundary")`** — call `classifyRef`
   directly, with `root` set to a `mkdtemp` directory and `fileDirectory` set to
   `join(root, "source", "features")`:

   | reference                                               | verdict                                                 |
   | ------------------------------------------------------- | ------------------------------------------------------- |
   | `#/components/schemas/Error`                            | `"ok"`                                                  |
   | `../components/actor.yaml#/schemas/actor.list.response` | `"missing"` unless the file exists; `"ok"` once it does |
   | `/components/actor.yaml#/schemas/x`                     | `"absolute"`                                            |
   | `https://example.invalid/a.yaml#/schemas/x`             | `"scheme"`                                              |
   | `../../../components/actor.yaml#/schemas/x`             | `"escapes"`                                             |

   Assert each verdict with `assert.equal`, naming the reference in the message. Write this test
   first and watch all five fail against an unwritten `classifyRef`; that is the RED step, and it
   needs no production mutation.

   Test 5 then calls the same `classifyRef` for every real reference, so the rule the synthetic cases
   pin is the rule the publication is held to.

**Prove the remaining failure modes against a scratch copy, never against a production file.**
`scripts/lane-check.sh:79-84` denies `src/http/contract/openapi-source.ts` to the test-engineer, and
`:91` denies `scripts/publish-contract.ts` to them as well, so mutate the published output inside a
`mkdtemp` directory and re-run the assertion by hand:

- Rewrite one reference in `$OUT/source/features/actor.yaml` to
  `../../components/actor.yaml#/schemas/actor.list.response`. Test 5 reports `escapes` and names the
  file and the reference.
- Delete `$OUT/source/components/blob.yaml`. Test 5 reports `missing` for the reference that pointed
  at it.
- Copy `$OUT/source` aside, change one byte in one component file, and compare the two directories.
  Test 6's `Buffer.compare` loop fails and names that file.

The equivalent mutations against the builder and against `scripts/publish-contract.ts` belong to
Story 3's verification, where the software-engineer holds both lanes; that story names them.

Hermetic check:

```bash
grep -c 'Date.now\|fetch(\|process.env\|execFileSync\|readReleaseFacts' scripts/publish-contract.source.test.ts
```

reports `0`. `grep -c mkdtempSync scripts/publish-contract.source.test.ts` reports `9` — one per
test, and two for the two-directory test.

Scope check:

```bash
git diff --name-only HEAD -- scripts src
```

names exactly `scripts/publish-contract.source.test.ts`. The gate's renderer clause holds trivially
for this story, and the command that asserts it is:

```bash
git diff --quiet HEAD -- \
  src/domain \
  $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$' | grep -v 'openapi-source\.ts$') \
  && echo "master renderer inputs unchanged"
```

`npm run verify` exits 0.

The full EPIC Proof block:

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

prints `PASS EPIC-039`. Story 6 still has to land before the epic is complete, but the Proof command
passes from here.

Proof: this story delivers the `scripts/publish-contract.source.test.ts` clause of the EPIC Proof
block, extended. It delivers the gate bullets **No `$ref` in any emitted file resolves outside the
publication directory**, **Two emissions produce identical bytes for every file under `source/`**,
**`openapi.yaml` is byte-identical to its output before this epic** and **Every test uses its own
`mkdtemp` directory and removes it**.
