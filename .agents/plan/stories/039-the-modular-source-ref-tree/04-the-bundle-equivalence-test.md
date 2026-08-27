# Story 4 — The bundle-equivalence test

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Depends on: Story 3 — the publish must write `source/` before this test can read it.

**Test only.** This story adds one file, `scripts/publish-contract.source.test.ts`, and changes no
production file. `scripts/lane-check.sh:87-93` puts a `*.test.ts` under `scripts/` in the
test-engineer lane and denies it to the software-engineer.

**There is no RED step against the product, and that is correct for this story.** Stories 1 to 3
already emit a correct tree, so these four tests pass the first time they run. An absent test file is
not a failing test, and this story must not pretend otherwise. Story 5 adds the one test in this file
that does have a genuine RED.

**Get the RED signal from the mutations of the `## Verify` section, and mutate only a scratch copy.**
`scripts/lane-check.sh:79-84` and `:91` deny both `src/http/contract/openapi-source.ts` and
`scripts/publish-contract.ts` to the test-engineer, so a "mutate the builder, watch it fail, revert"
loop is not this lane's to run — it is Story 3's, and that story names the same mutations. Here,
publish into a `mkdtemp` directory and edit the emitted file on disk.

**If a test fails on the unmutated tree, diagnose — do not weaken the test.** The failure is either
in this test, which is the test-engineer's to repair, or in the emitted tree, which belongs to
Stories 1 to 3 and to the software-engineer lane. Compare the failing reference against Story 3's
reference forms before changing a line, and escalate the second case rather than editing around it.

## Change

### Create `scripts/publish-contract.source.test.ts`

One new test file. Follow the conventions of `scripts/publish-contract.test.ts:1-10`: `node:test`,
`node:assert/strict`, `mkdtempSync` into `tmpdir()`, `try`/`finally` with `rmSync`.

```ts
import { publishContract } from "./publish-contract.ts";
import SwaggerParser from "@apidevtools/swagger-parser";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

**Each test owns its own `mkdtemp` directory and removes it in `finally`.** Do not share one
directory across tests, and do not reuse the directory `scripts/publish-contract.test.ts` creates.
`EPIC 038` deferred the merge of these helpers into `test/helpers/`, so duplicate the four lines.

Publish with a fixed commit and a fixed tag, so no test reads the git tree:

```ts
publishContract({
  outputDirectory: directory,
  commit: "0".repeat(40),
  tag: null,
});
```

That is the call shape `publish-contract.test.ts:69-73` uses.

**One shared normaliser, private to this file:**

```ts
function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function normalise(value: unknown): unknown {
  const plain = JSON.parse(JSON.stringify(value)) as unknown;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(node as Record<string, unknown>).sort(
        compareBytewise,
      )) {
        sorted[key] = walk((node as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return node;
  };
  return walk(plain);
}
```

It does the three things the EPIC's Decisions name, and nothing else. `JSON.stringify` then
`JSON.parse` drops an `undefined` value and a prototype difference. The key sort runs at every depth,
because a bundler picks its own key order. **Array order is untouched** — `parameters` order is
contract, and normalising it would hide a real defect.

**Four tests.**

1. **`test("bundles the modular root with no external reference left")`** — publish, then bundle and
   **walk every reference**, rather than searching the serialised form for a substring. A
   `.yaml#` search proves only that no reference spells `.yaml#`; a reference of the form
   `../components/actor.yml#/…`, `./components/actor.yaml` with no fragment, or an absolute path
   would all pass it.

   ```ts
   const bundled = await SwaggerParser.bundle(
     join(directory, "source", "openapi.yaml"),
   );
   const refs = collectRefs(bundled, []);
   assert.deepEqual(
     refs.filter((ref) => !ref.startsWith("#/")),
     [],
   );
   ```

   `collectRefs` is the recursive walker Story 5 introduces; write it in this story and Story 5
   reuses it in place. Every remaining reference must be an internal JSON Pointer.

   Assert the bundle is the whole document, by value rather than by a threshold:

   ```ts
   assert.deepEqual(
     Object.keys((bundled as { paths: object }).paths),
     Object.keys(buildOpenApiDocument().paths),
   );
   assert.equal(refs.length > 0, true, "the bundle holds no reference at all");
   ```

   Import `buildOpenApiDocument` from `../src/http/contract/openapi.ts` for the comparison.

2. **`test("reports no circular reference in the modular root")`** — a bundle of an empty document
   also reports no cycle, so read the parser instance rather than the static helper, and read it
   from a **bundle**, which is what the EPIC gate names:

   ```ts
   const parser = new SwaggerParser();
   await parser.bundle(join(directory, "source", "openapi.yaml"));
   assert.equal(parser.$refs.circular, false);
   assert.equal(
     parser.$refs.paths().length > 1,
     true,
     "the parser resolved only the root file",
   );
   ```

   `SwaggerParser.bundle` and `SwaggerParser.dereference` as static calls return the document alone
   and expose no `$refs`; the instance form is what carries it. The second assertion is what stops a
   root that references nothing from reporting `circular === false` vacuously — `$refs.paths()`
   lists every file the parser actually opened, and a correct run opens 35.

3. **`test("dereferences to the same document as the canonical master")`** — publish once, then:

   ```ts
   const fromSource = await SwaggerParser.dereference(
     join(directory, "source", "openapi.yaml"),
   );
   const fromMaster = await SwaggerParser.dereference(
     join(directory, "openapi.yaml"),
   );
   assert.deepStrictEqual(normalise(fromSource), normalise(fromMaster));
   ```

   `SwaggerParser.dereference` mutates and caches per call, so dereference each file with a separate
   call and do not reuse a parser instance across the two.

   Assert the comparison is non-vacuous before it runs, by value rather than by a threshold:

   ```ts
   assert.deepEqual(
     Object.keys((fromMaster as { paths: object }).paths),
     Object.keys(buildOpenApiDocument().paths),
   );
   ```

   Then assert the catalogue survived the round trip by value, so a document that lost the extension
   on both sides cannot pass this test silently:

   ```ts
   const catalogue = (fromSource as Record<string, Record<string, unknown>>)[
     "x-kanthord-event-payloads"
   ];
   assert.equal(Object.keys(catalogue).length, 37);
   ```

   **A byte comparison is wrong here and must not be written.** A bundler picks its own key order and
   its own inline-versus-reference placement, and both choices are outside this product. The
   normalised deep comparison is the assertion.

4. **`test("validates the modular root from disk")`** — publish, then
   `await SwaggerParser.validate(join(directory, "source", "openapi.yaml"))`. The call resolves every
   external reference from disk and then validates the resolved document, so a broken relative path
   fails here. It needs no assertion; a rejection fails the test.

   > **Why an operation-level `$ref` validates.** `source/openapi.yaml` puts a `$ref` at
   > `paths.<path>.<method>`, and an OpenAPI 3.0 Operation Object declares no `$ref` member.
   > `SwaggerParser.validate` resolves every reference before it validates, so it sees the joined
   > document and passes. This was measured against the tree, not assumed. A stricter
   > position-aware spec linter would object, and adopting one is a separate decision.

## Constraints

- **Add one file. Change nothing else.** Do not edit `scripts/publish-contract.ts`,
  `src/http/contract/openapi-source.ts` or `scripts/publish-contract.test.ts`.
- **Never normalise array order.** `parameters` order is contract. Sorting an array would let a real
  reordering pass.
- **Normalise exactly three things**: the `JSON` round trip, the recursive key sort, and nothing
  else. Do not delete a key, do not coerce a type, do not drop an extension key. Every extra
  normalisation is a defect this test can no longer see.
- **Compare with `assert.deepStrictEqual`, not `assert.deepEqual`.** The EPIC names the strict form,
  and the `JSON` round trip has already removed the prototype differences that would otherwise make
  it noisy.
- **Do not add a dependency.** `@apidevtools/swagger-parser` is already a dev dependency at
  `package.json:39`, version `12.1.0`, and it exports `validate`, `bundle` and `dereference`. Nothing
  else is needed.
- **Do not import `@apidevtools/swagger-parser` from a production source.**
  `src/http/contract/openapi.test.ts:585-600` scans every non-test `.ts` under `src/` for that string.
  This file is a test under `scripts/`, so it is free to import it — `publish-contract.test.ts:4`
  already does.
- **Every test owns its own `mkdtemp` directory and removes it in `finally`.** No shared temporary
  directory, no network, no wall clock, no ambient git configuration. Pass `commit` and `tag`
  explicitly so the test never reads a real tag.
- **Do not run the CLI entry point.** Call `publishContract` directly. The CLI path reads
  `readReleaseFacts`, which shells out to git and is neither hermetic nor deterministic in a worktree
  other agents are writing to.

## Verify

```bash
node --test scripts/publish-contract.source.test.ts
```

All four tests pass.

```bash
node --test scripts/publish-contract.test.ts src/http/contract/openapi.test.ts
```

Both pass unchanged — this story adds a file and touches no emitted byte.

**Prove the failure modes without touching a production file.** The test-engineer holds this lane
and `scripts/lane-check.sh:79-84` denies `src/http/contract/openapi-source.ts` to them, so do not
mutate the builder here. Mutate the **published copy inside a scratch `mkdtemp` directory** instead:
publish, edit one emitted file on disk, and re-run the assertion by hand. Nothing under version
control is touched, so nothing needs reverting.

```bash
OUT=$(mktemp -d)
node --input-type=module -e '
import { publishContract } from "./scripts/publish-contract.ts";
publishContract({ outputDirectory: process.argv[1], commit: "0".repeat(40), tag: null });
' "$OUT"
```

- Rewrite one `../components/actor.yaml#/…` reference in `$OUT/source/features/actor.yaml` to
  `./components/actor.yaml#/…`. `SwaggerParser.validate` on `$OUT/source/openapi.yaml` rejects, and
  the walk of test 1 reports an unresolved path.
- Delete the `x-kanthord-event-payloads` block from `$OUT/source/openapi.yaml`. The dereference
  comparison of test 3 fails and names the missing root key.
- Reverse the `parameters` array of one operation in `$OUT/source/features/event.yaml`. The
  dereference comparison of test 3 fails. This is the check that proves the normaliser does not sort
  arrays — and note the array lives in a **feature fragment**, never in the root, which holds
  reference objects only.
- Point one `components.schemas` reference in `$OUT/source/openapi.yaml` at the wrong component file.
  `SwaggerParser.validate` rejects on a missing pointer.

Remove `$OUT` afterwards. The equivalent mutations against the builder itself belong to Story 3's
verification, where the software-engineer holds the lane; that story names them.

Hermetic check:

```bash
grep -c 'Date.now\|fetch(\|process.env\|execFileSync\|readReleaseFacts' scripts/publish-contract.source.test.ts
```

reports `0`. And `grep -c mkdtempSync scripts/publish-contract.source.test.ts` reports `4`, one per
test.

Scope check:

```bash
git diff --name-only HEAD -- scripts src
```

names exactly `scripts/publish-contract.source.test.ts`.

The gate's renderer clause:

```bash
git diff --quiet HEAD -- \
  src/domain \
  $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$' | grep -v 'openapi-source\.ts$') \
  && echo "master renderer inputs unchanged"
```

exits 0. This story edits no module `renderOpenApiYaml` reads, so the published master and every
slice keep the bytes they hold today.

`npm run verify` exits 0.

Proof: this story delivers the `scripts/publish-contract.source.test.ts` clause of the EPIC Proof
block. It delivers the gate bullets **`SwaggerParser.validate` passes on `source/openapi.yaml`**,
**`SwaggerParser.bundle` on `source/openapi.yaml` agrees with the canonical master**, and the
dereference half of **`source/openapi.yaml` carries `x-kanthord-event-payloads` with 37 external
references**.
