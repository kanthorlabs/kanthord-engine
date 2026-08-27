# Story 1 — Every slice is emitted and validated beside the master

Epic: `.agents/plan/epics/038-validate-every-emitted-document.md`

**Test only.** This story edits one file, `src/http/contract/openapi.test.ts`. It changes no production
file. `scripts/lane-check.sh:72-83` puts a `*.test.ts` under `src/` in the test-engineer lane and
denies it to the software-engineer, so the software-engineer writes nothing for this story.

**There is no RED step against the product, and that is correct.** The 19 slices already validate
today. This was verified before the story was written: `SwaggerParser.validate` accepts all 19 slice
documents rendered from `renderOpenApiYaml(feature.operations)`. The test passes the first time it
runs.

Get the RED signal from the failure modes of the `## Verify` section instead. A test that cannot be
made to fail proves nothing.

## Change

Edit `src/http/contract/openapi.test.ts`. Three edits, in this order.

### Edit 1 — add `openApiFeatures` and `mkdirSync` to the imports

EPIC 037 story 2 already rewrote the `./openapi.ts` import into a multi-line
block and added `eventPayloadCatalogueKey` to it. Read the block before editing:
it is at line 1 and it reads

```ts
import {
  buildOpenApiDocument,
  eventPayloadCatalogueKey,
  renderOpenApiYaml,
} from "./openapi.ts";
```

Add `openApiFeatures` in alphabetical position, between
`eventPayloadCatalogueKey` and `renderOpenApiYaml`:

```ts
import {
  buildOpenApiDocument,
  eventPayloadCatalogueKey,
  openApiFeatures,
  renderOpenApiYaml,
} from "./openapi.ts";
```

Do not add a second import block from `./openapi.ts`. If the block instead reads
`import { buildOpenApiDocument, renderOpenApiYaml } from "./openapi.ts";` on one
line, then EPIC 037 did not land; stop and report that, because this epic depends
on it.

`openApiFeatures` is exported at `src/http/contract/openapi.ts:18`. Its signature is
`openApiFeatures(entries: readonly Operation[] = registry): readonly OpenApiFeature[]`, and
`OpenApiFeature` is `Readonly<{ name: string; operations: readonly Operation[] }>` at
`openapi.ts:13-16`. Call it with no argument.

Add `mkdirSync` to the `node:fs` import block at lines 9-16, in the existing alphabetical position —
between `existsSync` and `mkdtempSync`:

```ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
```

Add no other import. `SwaggerParser` (line 5), `YAML` (line 6), `join` (line 18) and `writeFileSync`
are already imported.

### Edit 2 — add the module-level emitter helper

Place it immediately after the `after` hook at lines 61-64, before the first `test(` at line 66.

```ts
function emitEveryDocument(): string[] {
  const written: string[] = [];
  const masterPath = join(openApiDirectory, "openapi.yaml");
  writeFileSync(masterPath, renderOpenApiYaml(), "utf8");
  written.push(masterPath);
  const featuresDirectory = join(openApiDirectory, "features");
  mkdirSync(featuresDirectory, { recursive: true });
  for (const feature of openApiFeatures()) {
    const path = join(featuresDirectory, `${feature.name}.yaml`);
    writeFileSync(path, renderOpenApiYaml(feature.operations), "utf8");
    written.push(path);
  }
  return written;
}
```

Three properties of this helper are load-bearing, and none of them is optional.

- **It writes into `openApiDirectory`, the one `mkdtempSync` directory of the file.** The EPIC fixes
  the directory count at one and the cleanup at the single `after` hook of lines 61-64. This helper
  adds no `mkdtempSync` call and no second `after` hook.

  The EPIC states the layout twice and the two statements read differently. Its Decisions say the 19
  slices "write into that same directory, under distinct file names", and its Story 1 bullet says
  "Create the `features` subdirectory with `mkdirSync`". This helper follows the bullet, which is the
  more specific instruction. Both are satisfied on the reading that matters: one `mkdtempSync`
  allocation, one `after` hook, and every file inside that one directory tree.

- **It is idempotent by bytes.** `renderOpenApiYaml` is deterministic — this was verified for the
  master and for all 19 slices. A second call overwrites each of the 20 files with the same bytes.
  That is what lets Story 3 call the helper and read the files without depending on this story's test
  having run first. Two top-level `test()` calls must never share a side effect.
- **It returns the 20 absolute paths, master first and then the 19 slices in `openApiFeatures()`
  order.** `openApiFeatures()` sorts feature names bytewise at `openapi.ts:35`, so the order is
  fixed. Do not sort the returned array again, and do not return relative paths.

Use `{ recursive: true }` on `mkdirSync` so a second call does not throw `EEXIST`.

### Edit 3 — replace the test at line 539

The test at `openapi.test.ts:539` today is:

```ts
test("validates the generated document and deletes its directory", async () => {
  const filePath = join(openApiDirectory, "openapi.yaml");
  writeFileSync(filePath, renderOpenApiYaml(), "utf8");
  await SwaggerParser.validate(filePath);
});
```

Replace it, in place, with:

```ts
test("validates the master document and every feature slice", async () => {
  const paths = emitEveryDocument();
  assert.equal(paths.length, 20);
  assert.equal(readdirSync(join(openApiDirectory, "features")).length, 19);
  for (const path of paths) {
    await SwaggerParser.validate(path);
  }
});
```

Four points on the assertions.

- **The file count is asserted as `20` through the helper's return value and as `19` through the
  `features` subdirectory, never through `readdirSync(openApiDirectory)`.** That top-level directory
  also holds `no-version.yaml` and `dangling-ref.yaml`, written by the tests at lines 549 and 561,
  and it holds the two files Story 2 adds. Counting its entries yields a number that depends on test
  order, which is a non-deterministic assertion and a planning defect. The `features` subdirectory
  holds exactly the 19 slices and nothing else.
- **`20` and `19` are literals, asserted by value.** The registry holds 69 operations and
  `openApiFeatures()` returns 19 features: `actor`, `agent`, `attempt`, `binding`, `blob`, `edge`,
  `event`, `gitOperation`, `instructions`, `node`, `plan`, `profile`, `project`, `provider`,
  `repository`, `run`, `system`, `template`, `worker`. A new first path segment in the registry adds a
  twentieth feature and must fail here.
- **Validate every path, including the master.** The master assertion the old test carried is kept:
  `paths[0]` is `openapi.yaml` and the loop awaits it.
- **`await` inside the loop, sequentially.** Do not use `Promise.all`. `SwaggerParser` carries
  per-instance resolver state, and a sequential walk is what the existing master test does.

The test name changes because the old name described the deleted directory, which the `after` hook
owns. Keep the test at the same position in the file — after `"renders canonical yaml"` at line 531
and before `"is never committed to the repository root"` at line 545.

## Constraints

- **Edit one file.** `src/http/contract/openapi.test.ts` only. This story adds no file and deletes
  none.
- **Change no production source.** The EPIC changes no schema, no operation, no path and no emitted
  byte. `renderOpenApiYaml()` returns the same string after this story.
- **Do not name `@apidevtools/swagger-parser` outside a `.test.ts` file.** The guard at
  `openapi.test.ts:582` reads every non-test `.ts` file under `src/` and fails when one holds that
  string. Do not move `emitEveryDocument` into `src/http/contract/openapi.ts` — it belongs in the test
  file, and a production helper there would put the emission path one import away from the validator.
- **Add no `mkdtempSync` call and no second `after` hook.** One temporary directory, one cleanup, as
  lines 61-64 already establish.
- **Do not touch the tests at lines 549, 561 or 582.** Story 2 adds beside the first two; the third
  stays exactly as it is.
- **Do not delete the test at line 545**, `"is never committed to the repository root"`. It asserts
  `openapi.yaml` is absent from the repository root and is unrelated to the temporary directory.
- **Do not add a dependency.** `@apidevtools/swagger-parser` and `yaml` are already installed and
  already imported by this file.

## Verify

```bash
node --test src/http/contract/openapi.test.ts
```

Every test in the file passes, including the replaced one.

Prove the three failure modes. Each is a scratch edit — revert it before the next, and none reaches a
commit.

- Change the `20` to `21`. The test fails on `20 !== 21`. This proves the count is asserted, not
  narrated.
- Change the `19` to `18`. The test fails on the `features` directory count, which proves the
  subdirectory is read and that all 19 slices were written.
- Break one slice at the source of the loop: temporarily wrap the slice write as
  `writeFileSync(path, renderOpenApiYaml(feature.operations).replace("openapi: 3.0.3\n", ""), "utf8")`.
  `SwaggerParser.validate` rejects and the test fails, naming the first slice by path. This proves the
  validator reads the slice file rather than passing vacuously. Revert the wrap.

Isolation check — run the replaced test alone. This proves the test needs no sibling's side effect. It
does not exercise a different ordering: `node:test` has no shuffle flag, and the guarantee this story
relies on is idempotence of `emitEveryDocument`, not a reordered run.

```bash
node --test --test-name-pattern='validates the master document and every feature slice' src/http/contract/openapi.test.ts
```

It passes in isolation. The test depends on no other test's side effect.

Hermetic check: the test touches no network, no clock and no ambient git configuration. It writes only
inside `openApiDirectory`, which the `after` hook removes.

```bash
grep -c 'mkdtempSync' src/http/contract/openapi.test.ts
```

reports `1`.

Scope check, scoped to the source tree because other agents may be editing `.agents/plan/**`
concurrently:

```bash
git status --porcelain -- src scripts test docs
```

names exactly one file, `src/http/contract/openapi.test.ts`. An unscoped `git diff --name-only` also
reports another agent's plan-tree edits and cannot be asserted in a shared tree.

`npm run verify` exits 0 — `format`, `typecheck`, the full `node:test` suite, `eslint .` and
`verify-db-status`.

Proof: this story delivers the `src/http/contract/openapi.test.ts` clause of the EPIC Proof block. It
delivers the gate bullet **`SwaggerParser.validate` passes for the master and for each of the 19
slices** in its passing direction, and the gate bullet **Every test uses its own `mkdtemp` directory
and removes it**. Story 2 delivers the rejecting direction. The `PASS EPIC-038` line prints only after
Story 4.
