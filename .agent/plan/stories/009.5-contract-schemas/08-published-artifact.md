# Story 08 — one script publishes the document and the example set

Epic: `.agent/plan/epics/009.5-contract-schemas.md`
Depends on: Story 07.

`npm run verify` generates, validates and deletes the document inside `src/http/contract/openapi.test.ts`. This
story adds the one script that writes it to a named output directory for a consumer to pin. The document stays
uncommitted.

## Change

### 1. New file `scripts/publish-contract.ts` — a pure function plus a thin CLI wrapper

The commit must be **injected, never read inside the function**, so the test is hermetic and byte-identity does
not depend on `HEAD` staying still between two runs.

```ts
export type PublishInput = Readonly<{
  outputDirectory: string;
  commit: string;
  dirty: boolean;
}>;

export function publishContract(input: PublishInput): readonly string[];
```

`publishContract` performs every write and returns the relative paths it wrote, bytewise sorted. It reads no
clock, no environment and no `git`. The module runs the CLI wrapper only when it is the entry point
(`import.meta.filename === process.argv[1]`), so the test imports the function without triggering a write.

The wrapper does the three impure things:

1. Read the output directory from `process.argv[2]`.
2. `commit` = `execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()`.
3. `dirty` = `execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0`.

Then it calls `publishContract` and exits `0`.

Mirror the style of `scripts/verify-db-status.ts`.

```ts
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { KANTHORD_VERSION } from "../src/domain/version.ts";
import { renderOpenApiYaml } from "../src/http/contract/openapi.ts";
import { registry } from "../src/http/contract/registry.ts";
```

Behaviour of `publishContract`:

1. When `outputDirectory` is absent or empty, the **wrapper** writes
   `usage: node scripts/publish-contract.ts <output-directory>` to `process.stderr` and exits `2`.
2. **Refuse to publish into the repository.** Resolve `outputDirectory` and the repository root, both through
   `realpathSync` where the path exists, and exit `2` with
   `refusing to publish into the repository: <path>` when the resolved output directory is the repository root
   or any ancestor of it. Without this the script happily writes `openapi.yaml` into the tree when invoked with
   `.`, and `docs/proposal/api/README.md:17` forbids a committed document. A test that only checks one
   temporary-directory invocation proves nothing about that.
3. **Clear the output directory first**, so a stale file from an earlier publication cannot sit beside the new
   artifact and be mistaken for part of it: `rmSync(join(<out>, "examples"), { recursive: true, force: true })`,
   then remove `<out>/openapi.yaml` and `<out>/manifest.json` with `rmSync(..., { force: true })`. Remove
   nothing else — the directory may legitimately be a consumer's checkout holding its own files.
4. `mkdirSync(<out>, { recursive: true })` and `mkdirSync(join(<out>, "examples"), { recursive: true })`.
5. Write `<out>/openapi.yaml` with `renderOpenApiYaml()`, encoding `"utf8"`.
6. Select the entries to publish: `registry.filter((entry) => entry.examples !== undefined)`. `registry` is
   already sorted bytewise by `operationId` (`src/http/contract/registry.ts:34-36`), so the walk order is fixed
   and needs no re-sort.
7. For each selected entry write `<out>/examples/<operationId>.json`. The body is
   `JSON.stringify(ordered, null, 2) + "\n"`, where `ordered` holds only the present keys of
   `entry.examples`, in the fixed order `query`, `request`, `success`, `error`.
8. Write `<out>/manifest.json` with `JSON.stringify(manifest, null, 2) + "\n"`, where `manifest` is:

   ```ts
   {
     version: KANTHORD_VERSION,
     commit: input.commit,
     dirty: input.dirty,
     operations: <the selected operationIds, in registry order>,
   }
   ```

   The key order is exactly `version`, `commit`, `dirty`, `operations`. The manifest carries **no timestamp**:
   `AGENTS.md` names a timestamp in a snapshot a defect, and a timestamp would break the byte-identity test.

   **`dirty` is required, and it is not cosmetic.** The document and the examples are generated from the
   working tree, not from the commit. A publication from a dirty tree that recorded only `commit` would claim
   the artifact corresponds to that commit while shipping uncommitted schemas — a consumer would pin a lie.
   `dirty: true` says the bytes do not correspond to any commit.

9. Write nothing else. Delete nothing outside the three artifact paths of step 3. The script never writes into the repository root.
10. Exit `0`.

### 2. New npm script

`package.json`, in the `scripts` block, after `"verify:guards"`:

```json
    "contract:publish": "node scripts/publish-contract.ts",
```

Do **not** add it to `"verify"`. `verify` must not write outside a temporary directory, and
`src/http/contract/openapi.test.ts` already validates and deletes the document inside `npm test`.

### 3. New file `scripts/publish-contract.test.ts`

`describe` title: `"scripts/publish-contract.test"`. Style follows `scripts/verify-db-status.test.ts`. Create one
`mkdtempSync(join(tmpdir(), "kanthord-contract-"))` at module scope and remove it in an `after` hook with
`rmSync(directory, { recursive: true, force: true })`, exactly as `src/http/contract/openapi.test.ts:60-63`
does.

Invoke the script with `execFileSync(process.execPath, ["scripts/publish-contract.ts", <dir>], { cwd:
repositoryRoot, encoding: "utf8" })`, where `repositoryRoot` is computed as
`fileURLToPath(new URL("../", import.meta.url))`.

Tests:

- `"writes the document, the manifest and one example file per operation"` — after one run, `readdirSync(<dir>)`
  bytewise sorted deep-equals `["examples", "manifest.json", "openapi.yaml"]`, and
  `readdirSync(join(<dir>, "examples"))` bytewise sorted has 22 entries, each named `<operationId>.json`, and
  the id list deep-equals the 22 from `registry.filter((e) => e.examples !== undefined).map((e) =>
e.operationId)`.
- `"the document is the generated document"` — the file content equals `renderOpenApiYaml()` exactly.
- `"the manifest carries the version, the commit, the dirty flag and the operation list"` — the parsed
  manifest's `version` equals `KANTHORD_VERSION`; `operations` deep-equals the same 22 ids in the same order;
  `Object.keys(manifest)` deep-equals `["version", "commit", "dirty", "operations"]`; `typeof manifest.dirty`
  is `"boolean"`. Assert `commit` matches `/^[0-9a-f]{40,64}$/` and **not** a hard 40, so the test does not
  fail in a SHA-256 repository.
- `"the manifest carries no timestamp"` — assert the raw manifest text contains none of `"generatedAt"`,
  `"timestamp"` or `"date"`.
- `"each example file holds its keys in the fixed order"` — for `project.create` assert the parsed keys
  deep-equal `["request", "success", "error"]`; for `project.list` assert `["success", "error"]`; for
  `event.list` assert `["query", "success", "error"]`.
- `"each published example still satisfies its schema"` — read each example file, and for the matching registry
  entry parse `success` through `entry.response`, `request` through `entry.request` when present, `query`
  through `entry.query` when present, and `error` through `buildErrorEnvelope(entry.errors)`.
- `"generation is byte-identical across two runs"` — call **`publishContract`** directly, not the CLI, twice
  into two separate temporary directories, passing the same fixed
  `{ commit: "0".repeat(40), dirty: false }` both times. Assert every file's bytes are equal — `openapi.yaml`,
  `manifest.json` and all 22 example files. Using the pure function with an injected commit is what makes this
  hermetic: the CLI reads `HEAD`, and `HEAD` can move between two invocations.
- `"the manifest records a dirty tree"` — call `publishContract` with `{ commit: "0".repeat(40), dirty: true }`
  and assert the parsed manifest has `dirty: true`, and that its bytes differ from the `dirty: false` run.
- `"refuses to publish into the repository"` — `assert.throws` on `execFileSync` with the repository root as the
  argument, and again with `"."`; assert `status` is `2` and `stderr` contains `refusing to publish into the
repository`. Then assert `existsSync(join(repositoryRoot, "openapi.yaml"))` is still `false`.
- `"clears a stale file from a previous publication"` — write `<dir>/examples/gone.json` and
  `<dir>/openapi.yaml` with junk bytes, run `publishContract`, and assert `gone.json` is absent and
  `openapi.yaml` equals `renderOpenApiYaml()`.
- `"refuses to run with no output directory"` — `assert.throws` on `execFileSync` without the argument, and
  assert the thrown error's `status` is `2` and its `stderr` contains `usage:`.
- `"writes no document into the repository root"` — `existsSync(join(repositoryRoot, "openapi.yaml"))` is
  `false`, and the same for `manifest.json`.

### 4. Keep the validator out of production sources

`src/http/contract/openapi.test.ts:312` asserts no non-test `.ts` file under `src/` names
`@apidevtools/swagger-parser`. `scripts/publish-contract.ts` lives outside `src/` and must not import the
validator either — validation stays in `openapi.test.ts`. Add nothing to that assertion.

## Constraints

- The script writes only inside the directory it is given. It never touches the repository root, and it never
  deletes.
- No timestamp, no random value and no wall-clock read in any published byte.
- Do not add `contract:publish` to `npm run verify`.
- `publishContract` reads no `git`, no clock and no environment. Only the CLI wrapper does, and no test invokes
  the wrapper for a byte-identity assertion. That is what keeps the suite hermetic — AGENTS.md forbids a test
  that depends on ambient `git` configuration.
- The test removes its temporary directories, so the suite stays hermetic.
- `scripts/publish-contract.test.ts` is outside the epic Proof glob `src/http/contract/**/*.test.ts`. It runs
  under the `Gates:` line, because `npm run verify` runs `npm test` and `node --test` discovers it.

## Verify

- `node --test scripts/publish-contract.test.ts` — every test above passes. Then, restoring after each: add
  `generatedAt: Date.now()` to the manifest and confirm both the no-timestamp test and the byte-identical test
  fail; remove the repository-root refusal and confirm the refusal test fails; remove the clear step and confirm
  the stale-file test fails.
- `npm run contract:publish "$(mktemp -d)"` exits 0.
- `npm run contract:publish .` exits 2 and writes nothing.
- `node --test src/http/contract/openapi.test.ts` — passes unchanged, including `:275` and `:312`.
- `node --test src/http/contract/example.test.ts` and `node --test src/http/contract/coverage.test.ts` — pass
  unchanged.
- `git status --porcelain` is empty after a publish run, which proves the script wrote nothing into the tree.
- `npm test` — the whole suite passes.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-009.5`, delivered by the `src/http/contract/` suites the earlier stories wrote. This story's
  own test runs under `Gates:`.
