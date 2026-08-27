# Story 3 — The core-purity test fails on a `node:` import

Epic: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`
Depends on: Story 1 and Story 2. The test fails while `start.ts` or the `node:crypto` import survives.

## Change

Add `src/http/server/core-purity.test.ts`. Add no production file, and change no production file.

The test reads the tree from disk, so a core file added later is covered on the day it lands.

- Resolve the core root as `resolve(import.meta.dirname)`, which is `src/http/server`.
- Walk the tree with `readdirSync(directory, { withFileTypes: true })`, recursing into every subdirectory.
- Express the directory exemption as one named local function, `isExempt(relativeDirectoryPath: string): boolean`, that returns `relativeDirectoryPath === "runtime"`. It compares the whole repository-core-relative path, so a nested directory named `runtime` is **not** exempt. That function is what a case below tests directly.
- **Collect** a file only when its name ends `.ts` and does not end `.test.ts`.
- Sort the collected relative paths with `compareBytewise` from `src/http/server/bytewise.ts`, so the reported offenders are in one fixed order.
- Read each file with `readFileSync(file, "utf8")`, then **strip comments before matching**: remove every `/* … */` block and every `// …` line remainder. A specifier inside a comment is not an import.
- Match a module specifier through the **import and export grammar**, never the bare text `node:`. Use these four patterns over the comment-stripped text, and no others:
  - static and re-export, single line or multiline: `/\b(?:import|export)\b[\s\S]*?\bfrom\s*["']([^"']+)["']/g`
  - side-effect import: `/\bimport\s*["']([^"']+)["']/g`
  - `import type` follows the first pattern, because `type` sits between `import` and `from`.
  - dynamic import: `/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g`
- The first pattern is non-greedy and therefore matches the nearest `from`, which is the correct one for a multiline named-import list. Both quote styles are covered by the character class.
- Build **three** offender lists from the captured specifiers, and assert each one deep-equals `[]`:
  1. **no `node:` builtin** — a specifier that starts `node:`. Entry text: `` `${relativePath}: ${specifier}` ``.
  2. **no reach into a runtime root** — a specifier that contains `runtime/`. A core file that imports `./runtime/node/listen.ts` carries no `node:` specifier, so list 1 misses it while a bundler still traverses it. Entry text: `` `${relativePath}: ${specifier}` ``.
  3. **no runtime-only vendor package** — a specifier equal to `@hono/node-server` or starting `@hono/node-server/`. That package is Node-only and it belongs to the Node root. Entry text: `` `${relativePath}: ${specifier}` ``.
- Add a fourth assertion over `src/`, outside the core: **`src/main.ts` is the only production importer of the Node root.** Walk `resolve(import.meta.dirname, "../..")`, collect every `.ts` file that does not end `.test.ts`, apply the same four patterns, and collect every file other than `main.ts` whose specifier resolves to `http/server/runtime/`. Assert that list deep-equals `[]`. That is the EPIC gate row "the Node root is the only Node-only place".
- Assert every list with `assert.deepEqual(list, [])`, so the failure message names each offending file and its specifier.

The bare-text match is forbidden because `src/http/server/node/create-node.ts:33` and `src/http/server/node/update-node.ts:33` hold the object property `node: parsed.data.node,`.

## Constraints

- The test file lives under `src/http/server/`, and it is skipped by its own `.test.ts` filter.
- Import only `node:test`, `node:assert/strict`, `node:fs`, `node:path` and `src/http/server/bytewise.ts`.
- Expose the specifier extractor and `isExempt` as local functions in the test file, so a case calls each one directly. Export nothing from a test file.
- Do not edit `eslint.config.js`. The eslint half of the rule is S2 of the EPIC, and the human applies it.
- Do not edit `AGENTS.md`. The enforcement-table row is S3 of the EPIC, and the human applies it.
- Do not weaken the walk with an allow-list of file names. `runtime` is the one exemption.

## Verify

- `node --test src/http/server/core-purity.test.ts` passes on the tree story 2 leaves. Cases:
  - **the core imports no `node:` builtin** — offender list 1 over the real tree deep-equals `[]`.
  - **the core reaches into no runtime root** — offender list 2 over the real tree deep-equals `[]`.
  - **the core imports no runtime-only vendor package** — offender list 3 over the real tree deep-equals `[]`.
  - **`src/main.ts` is the only production importer of the Node root** — the fourth list over `src/` deep-equals `[]`.
  - Every case below runs the extractor over an in-memory string. Write no file into the tree.
  - **a single-line `node:` import is detected** — `import { createServer } from "node:http";` yields exactly `["node:http"]`.
  - **a multiline `node:` import is detected** — the three-line form whose named list sits on its own line, `import {`, `  createServer,`, `} from "node:http";`, yields exactly `["node:http"]`.
  - **a `node:` re-export is detected** — `export { createServer } from "node:http";` yields exactly `["node:http"]`.
  - **a `node:` type import is detected** — `import type { Server } from "node:http";` yields exactly `["node:http"]`.
  - **a `node:` side-effect import is detected** — `import "node:http";` yields exactly `["node:http"]`.
  - **a `node:` dynamic import is detected** — `await import("node:http")` yields exactly `["node:http"]`.
  - **a single-quoted specifier is detected** — the single-quoted form of the first case yields exactly `["node:http"]`.
  - **a commented import is not detected** — a line-comment form and a block-comment form of the first case each yield `[]`.
  - **an object property named `node:` is not detected** — `const row = { node: parsed.data.node };` yields `[]`.
  - **a runtime reach is detected** — `import { listen } from "./runtime/node/listen.ts";` lands in list 2 and not in list 1.
  - **the vendor package is detected** — `import { serve } from "@hono/node-server";` lands in list 3.
  - **`isExempt` compares the whole path** — `isExempt("runtime")` is `true`, and `isExempt("node/runtime")`, `isExempt("runtime/node")` and `isExempt("event")` are each `false`.
  - **the walk applies the exemption** — the walked file list contains `runtime/node/listen.ts` nowhere, and contains `app.ts`, `idempotency-key.ts` and `node/create-node.ts`.
- `npm run verify` exits 0.
- Proof: the `src/http/server/core-purity.test.ts` line of the EPIC Proof.
