# Story 1 — The proposal states two forms, and `source/components/*.yaml` exists

Epic: `.agents/plan/epics/039-the-modular-source-ref-tree.md`
Depends on: EPIC 037 (the catalogue extension and the reachability pruning) and EPIC 038 (the
validation harness), by sequence order.

**Two lanes.** The proposal edits and `src/http/contract/openapi-source.ts` are the
software-engineer lane (`scripts/lane-check.sh:99-101` and `:77-86`).
`src/http/contract/openapi-source.test.ts` is the test-engineer lane (`scripts/lane-check.sh:79-84`).

This story creates the module and emits the component files only. Story 2 adds the feature
fragments, Story 3 adds the root. Neither rewrites a line this story writes; both extend the same
file.

## Change

### Amend `docs/proposal/api/new-decisions.md`

One bullet. Find it by its opening text, not by its number — EPIC 037 rewrites
`docs/proposal/api/README.md:13-21` first, and prettier reflows both files.

The bullet is today line 11 and it opens:

```
- **`openapi.yaml` is generated, self-contained and not committed.** External `$ref` files are refused for generator, viewer and publish portability.
```

Replace the second sentence, `External $ref files are refused for generator, viewer and publish
portability.`, with:

```
The master and each `features/*.yaml` slice are self-contained, because a generator, a viewer and a publish step each resolve a relative file reference differently. The publication adds a second, modular form under `source/`, built from external `$ref`, beside the self-contained forms and never in place of them. Its bundle reproduces the master, and every reference in it stays inside the publication directory.
```

Change no other sentence of the bullet, and change no other bullet.

### Amend `docs/proposal/api/README.md`

The EPIC anchors this at `:20`. Line 20 is blank. The paragraph the EPIC means is today line 21 and
it opens `` `npm run verify` generates the master document into a temporary directory ``. EPIC 037
rewrites lines 13-21 of this file before this story runs, so **find the paragraph by that opening
text**, not by its number.

Two edits in that paragraph's section.

1. In that paragraph, replace the sentence
   `` `npm run contract:publish -- <output-directory>` publishes the master document, feature documents and examples. ``
   with:

   ```
   `npm run contract:publish -- <output-directory>` publishes the master document, feature documents, examples and the modular `source/` tree.
   ```

2. Immediately after that paragraph, insert one blank line, then this block verbatim:

   ````
   The publication writes two forms of the same contract:

   ```text
   openapi.yaml                    self-contained canonical master
   features/<feature>.yaml         self-contained scoped bundles
   examples/<operationId>.json     request and response examples
   manifest.json                   the publication manifest
   source/openapi.yaml             modular root
   source/features/<feature>.yaml  operation fragments
   source/components/*.yaml        shared schemas and security schemes
   ```

   A consumer that reads `openapi.yaml` sees no change. A consumer that edits, diffs or vendors the
   contract reads `source/`, where one schema lives in one place. A `$ref` under `source/` is a
   relative path plus a JSON Pointer fragment, and it always resolves to a file inside the
   publication directory. `SwaggerParser.bundle` on `source/openapi.yaml` reproduces the master.
   ````

Run `npx prettier --write docs/proposal/api/new-decisions.md docs/proposal/api/README.md` after both
edits, so the committed bytes are the bytes `npm run verify` produces.

### Create `src/http/contract/openapi-source.ts`

One new production file under `src/http/contract/`. It imports `yaml`, `./openapi.ts`,
`./operation.ts` and `./registry.ts`, and nothing else.

```ts
import YAML from "yaml";

import { buildOpenApiDocument } from "./openapi.ts";
import type { Operation } from "./operation.ts";
import { registry } from "./registry.ts";

export function buildOpenApiSourceTree(
  entries: readonly Operation[] = registry,
): ReadonlyMap<string, string>;
```

**The map key is the path relative to `source/`**, with no `source/` prefix and no leading `/`:
`components/actor.yaml`, and later `features/actor.yaml` and `openapi.yaml`. **The map value is the
file text**, ending in exactly one `\n`, as `YAML.stringify(value, { lineWidth: 0 })` produces.

**The map is built in bytewise key order**, so iteration order is the emission order and two calls
produce the same sequence. Sort with the same comparator `openapi.ts:216-218` uses:

```ts
function compareBytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}
```

Duplicate that private helper in this file. Do not export it from `openapi.ts` — the export surface
of `openapi.ts` is contract, and this story adds no export to it.

**The prefix rule.** One private helper, used by every later story too:

```ts
function prefixOf(name: string): string {
  const separator = name.indexOf(".");
  return separator === -1 ? name : name.slice(0, separator);
}
```

This is the rule `openApiFeatures` applies at `openapi.ts:23-27` to an `operationId`. Here it applies
to a schema name. `Error` holds no `.`, so it is its own prefix.

**The reference rewrite.** One private recursive helper, shared by this story and Story 2:

```ts
function rewriteRefs(value: unknown, base: string): unknown;
```

It walks arrays and plain objects. On a key `$ref` whose value is a string starting with
`#/components/schemas/`, it replaces the value with
`` `${base}components/${prefixOf(name)}.yaml#/schemas/${name}` ``, where `name` is the remainder of
the pointer. It copies every other key and value unchanged, and it preserves array order and object
key order. `base` is `"./"` or `"../"`, and the caller supplies it.

Call it with `"./"` for a component file value, because a component file sits in
`source/components/` and refers to a sibling in the same directory.

> **Today the rewrite changes nothing inside a component schema.** `buildOpenApiDocument()` emits
> 142 schemas and none of their bodies holds a `$ref` — every `$ref` in the master sits inside a
> path object. The helper is still required here, because Story 2 uses the same helper on the
> operation objects, where every reference lives. Write it once, use it in both.

**Component grouping.** Read `buildOpenApiDocument(entries).components.schemas`. For each schema
name, compute `prefixOf(name)`. Group the schemas by prefix, keeping each group's key order as it
arrived — the master already sorts `components.schemas` bytewise at `openapi.ts:92-95`, so each group
is already in bytewise order.

Each group emits one file at key `` `components/${prefix}.yaml` ``, whose value is:

```ts
YAML.stringify({ schemas: group }, { lineWidth: 0 });
```

One top-level key, `schemas`. No `openapi`, no `info`, no `components` wrapper.

**The security file.** Emit one further file at key `components/security.yaml`, whose value is:

```ts
YAML.stringify(
  { securitySchemes: buildOpenApiDocument(entries).components.securitySchemes },
  { lineWidth: 0 },
);
```

Its one top-level key is `securitySchemes`. It is not a schema file and it carries no `schemas` key.

**The case-collision refusal.** Before emitting, fold every component file name — the schema prefixes
and the literal `security` — to lower case. If two distinct names fold to the same value, throw an
`Error` whose message names both, in bytewise order, for example:

```
component file name collision: Error and error
```

A case-insensitive file system merges the two files and one silently wins, so this is a refusal, not
a warning. Today no collision exists: the 14 prefixes are `Error`, `actor`, `blob`, `edge`, `event`,
`lease`, `node`, `outcome`, `plan`, `project`, `provider`, `recovery`, `repository`, `system`, and
`security` collides with none of them.

Call `buildOpenApiDocument(entries)` **once** and reuse the result. Two calls produce two equal
documents, and one call is the simpler code.

### Create `src/http/contract/openapi-source.test.ts`

One new test file. Follow the flat `test(...)` style of `openapi.test.ts:1-30`: `node:test`,
`node:assert/strict`, no `describe`.

```ts
import { buildOpenApiSourceTree } from "./openapi-source.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import type { Operation } from "./operation.ts";
import { z } from "zod";
import { test } from "node:test";
import assert from "node:assert/strict";
```

Six tests.

1. **`test("emits fifteen component files")`** — build the tree with no argument. Filter the map keys
   to those that start with `components/`. Assert the count is `15` by value, and assert the sorted
   key list deep-equals, in bytewise order:

   ```ts
   [
     "components/Error.yaml",
     "components/actor.yaml",
     "components/blob.yaml",
     "components/edge.yaml",
     "components/event.yaml",
     "components/lease.yaml",
     "components/node.yaml",
     "components/outcome.yaml",
     "components/plan.yaml",
     "components/project.yaml",
     "components/provider.yaml",
     "components/recovery.yaml",
     "components/repository.yaml",
     "components/security.yaml",
     "components/system.yaml",
   ];
   ```

   The bytewise order puts `Error.yaml` first, because `E` is `0x45` and every other name starts
   lower-case.

2. **`test("names each component file after the schema-name prefix")`** — for every key of
   `buildOpenApiDocument().components.schemas`, assert that the tree holds the key
   `` `components/${name.split(".")[0]}.yaml` ``, and that parsing that file's text with `YAML.parse`
   yields an object whose `schemas` key holds `name`. The message names the schema that found no
   file. This is the naming rule asserted over all 142 schemas rather than over a sample.

3. **`test("places an event payload schema by its event-type prefix")`** — parse
   `components/node.yaml`, and assert `Object.keys(parsed.schemas).includes("node.created")`.
   Assert the same file also holds `node.list.response`, so the test proves an event payload and an
   operation schema share one file.

4. **`test("holds the exact bytes of the security component file")`** — assert the map value for
   `components/security.yaml` equals this string exactly:

   ```ts
   const expected =
     "securitySchemes:\n" +
     "  bearerAuth:\n" +
     "    type: http\n" +
     "    scheme: bearer\n";
   ```

   Compare with `assert.equal`, then compare again with
   `assert.equal(Buffer.compare(Buffer.from(actual, "utf8"), Buffer.from(expected, "utf8")), 0)`.
   The second comparison is the byte assertion the EPIC gate names.

5. **`test("leaves no internal component pointer in a component file")`** — for every
   `components/*.yaml` value, assert `value.includes("#/components/schemas/")` is `false`. Today no
   component body holds a reference at all, so this test passes on an empty rewrite; it is the guard
   that a schema body which later gains a reference does not ship an unrewritten pointer.

6. **`test("refuses two component file names that differ only by letter case")`** — build a
   synthetic single-operation registry whose `operationId` is `error.list`, so the emitted schema set
   holds `Error` and `error.list.response`:

   ```ts
   const colliding = [
     {
       operationId: "error.list",
       method: "GET",
       path: [{ kind: "resource", value: "actor" }],
       introducedIn: "phase-1",
       status: "routed",
       allowedActors: ["human"],
       response: z.object({ ok: z.boolean() }),
     },
   ] as unknown as Operation[];

   assert.throws(
     () => buildOpenApiSourceTree(colliding),
     /component file name collision: Error and error/,
   );
   ```

   Verified against the tree: `buildOpenApiDocument(colliding)` emits `Error` and
   `error.list.response`, so the two prefixes `Error` and `error` are both present and both fold to
   `error`.

## Constraints

- **Add one production file and one test file, and amend two proposal files. Change nothing else.**
  Do not edit `src/http/contract/openapi.ts`, `scripts/publish-contract.ts` or any emitted-document
  test. Story 3 owns the publish script.
- **Export exactly one symbol from `openapi-source.ts`: `buildOpenApiSourceTree`.** `prefixOf`,
  `rewriteRefs` and `compareBytewise` stay private. Stories 2 and 3 extend this file and use them
  in place.
- **Never import `@apidevtools/swagger-parser` from a production source.**
  `openapi.test.ts:585-600` scans every non-test `.ts` under `src/` and fails on the string. This
  file is a production source.
- **`http/contract/` may import `domain/` and `http/contract/` only.** This file needs `yaml`,
  `./openapi.ts`, `./operation.ts` and `./registry.ts`, and nothing else. It imports no
  `services/`, `commands/`, `queries/` or `http/server/`. `registry.ts` is needed for the default
  parameter value, which mirrors `openapi.ts:18-20` and `:46-48`.
- **The emitted text is `YAML.stringify(value, { lineWidth: 0 })` and nothing else.** No manual
  string building, no post-processing, no second newline. This is the call `renderOpenApiYaml` makes
  at `openapi.ts:107-111`, and matching it is what keeps the two forms byte-comparable.
- **Do not change the bytes of `openapi.yaml` or of any `features/*.yaml` slice.** This story adds a
  module; it calls `buildOpenApiDocument` and mutates nothing it returns. If the implementation needs
  to change a value, deep-copy it first.
- **Preserve array order everywhere.** `parameters` order is contract. `rewriteRefs` maps an array to
  a new array of the same length in the same order.
- **Anchor both proposal edits by the quoted sentence, not by the line number.** EPIC 037 rewrites
  `README.md:13-21` before this story lands, and prettier reflows the paragraph. Find the text.

## Verify

```bash
node --test src/http/contract/openapi-source.test.ts
```

All six tests pass.

```bash
node --test src/http/contract/openapi.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts
```

All pass unchanged — this story adds no reference to the master and changes no emitted byte.

```bash
node --test scripts/publish-contract.test.ts
```

Passes unchanged. Nothing writes `source/` yet, so the directory-listing assertion at
`scripts/publish-contract.test.ts:75-80` still sees exactly
`["examples", "features", "manifest.json", "openapi.yaml"]`.

Prove the module changed no emitted byte. Never stash — the stash stack is shared with the main
checkout and with every other worktree, and other agents work in this tree. Assert the renderer's
inputs are untouched instead:

```bash
git diff --quiet HEAD -- \
  src/domain \
  $(git ls-files 'src/http/contract/*.ts' | grep -v '\.test\.ts$' | grep -v 'openapi-source\.ts$') \
  && echo "master renderer inputs unchanged"
```

`renderOpenApiYaml` reads `src/http/contract/openapi.ts`, every per-domain schema module
`registry.ts` pulls in, and `src/domain/version.ts` for `info.version`. Naming the five obvious
modules is not enough — a per-domain zod module such as `src/http/contract/node.ts` moves the master
bytes just as surely. The command above covers the whole transitive input set, minus the one new
file this story adds.

Scope check — name the paths, because other agents have work in this tree:

```bash
git diff --name-only HEAD -- docs/proposal src scripts
```

names exactly four files — `docs/proposal/api/new-decisions.md`, `docs/proposal/api/README.md`,
`src/http/contract/openapi-source.ts`, `src/http/contract/openapi-source.test.ts` — plus whatever
another epic's agent has open. Confirm the four, and confirm this story added no fifth.

Hermetic check: `grep -c 'mkdtemp\|Date.now\|fetch(\|process.env' src/http/contract/openapi-source.test.ts`
reports `0`. This test writes no file and reads no directory.

`npm run verify` exits 0 — `format`, `typecheck`, the full `node:test` suite, `eslint .` and
`verify-db-status`.

Proof: this story delivers the `src/http/contract/openapi-source.test.ts` clause of the EPIC Proof
block. It delivers the gate bullets **The component file count is 15**, **A component file name
collision is refused**, and it keeps **`openapi.yaml` is byte-identical to its output before this
epic** true.
