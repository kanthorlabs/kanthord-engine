# Node 24 / TypeScript / SQLite gotchas

Living checklist. **Read before any `src/` edit** — before the edit, not upfront.

Each entry states the failure mode, then the version it was last verified on and
the command that proves it. Platform semantics drift between versions. Re-run the
proof command before you cite an entry as the reason for a change. If the entry
disagrees with the runtime, trust the runtime and correct the entry.

- **Relative imports need explicit `.ts` extensions.** Under type stripping,
  Node does not rewrite extensions. Write `import { x } from "./greeting.ts"`,
  not `"./greeting"`. `allowImportingTsExtensions` in `tsconfig.json` lets `tsc`
  accept this.
  _Verified 24.17: every relative import under `src/` carries `.ts`, and the
  full suite passes — `npm run verify`._

- **`verbatimModuleSyntax` → `import type` is required for type-only imports.**
  A value import of something used only as a type is an error, and a type
  imported without `type` is emitted as a runtime import (which then fails).
  Ports are types: `import type { StatusStore } from "../../storage/port.ts"`.
  _Verified 24.17: `verbatimModuleSyntax` is set in `tsconfig.json` — `npm run
typecheck`._

- **Builtins use the `node:` prefix form.** `import { test } from "node:test"`,
  `import assert from "node:assert/strict"`, `import { DatabaseSync } from
"node:sqlite"`. The bare form (`"test"`) is not resolved the same way.
  _Verified 24.17: no bare builtin specifier exists under `src/` or `test/` —
  `grep -rn 'from "\(test\|assert\|fs\|path\)"' src test`._

- **Top-level `await` is fine in ESM.** No IIFE wrapper needed in `main.ts`.
  _Verified 24.17: `src/main.ts:61` awaits at top level — `npm run verify`._

- **`node:sqlite` exits 0. Never treat stderr noise as failure.** Do **not** add
  stderr filtering. The Proof contract is exit 0 + stdout, not empty stderr.
  _Verified 24.17: `node:sqlite` emits no warning at all — `node
--trace-warnings` on a `DatabaseSync(":memory:")` script prints nothing to
  stderr and exits 0. Node 24.12 emitted an `ExperimentalWarning` here, so the
  absence of a warning is not evidence of a broken run._

- **TypeScript parameter properties are NOT supported in strip-only mode.**
  Do not write `constructor(private readonly store: X) {}`. Declare the field
  explicitly (`readonly #store: X;` or `private readonly store: X;`) and assign
  it in the constructor body. The same restriction hits `enum` and namespaces —
  prefer union types / plain objects.
  _Verified 24.17: both a parameter property and an `enum` fail with
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` — run either form directly through `node`._

- **`noUncheckedIndexedAccess` types indexed access as `T | undefined`.**
  `arr[0]` is `T | undefined`; a `SELECT count(*)` row read by index/key must be
  narrowed before use (guard or assert the shape).
  _Verified 24.17: `noUncheckedIndexedAccess` is set in `tsconfig.json` — `npm
run typecheck`._

- **`assert.throws()` returns `void`. Never assign it and read the error.**
  `const err = assert.throws(fn); err.code` fails with `TS2339: Property 'code'
does not exist on type 'void'`. To assert on a thrown error's fields, use
  `try { fn(); assert.fail("expected a throw"); } catch (error) { … }`.
  _Verified 24.17: the assignment form fails typecheck — `npm run typecheck` on
  a probe that reads a field off the return value._

- **`eslint-plugin-boundaries` classifies an import only if its target file
  exists on disk.** A deny-case lint fixture that imports a path which no file
  occupies does not fire `boundaries/dependencies`, so the test passes while
  asserting nothing. Point a deny-case fixture at a real file in the wrong
  layer.
  _Verified 24.17 during Story 11 of EPIC 002 — see the RED turn in
  `.agents/tdd/history/2026-08-03-002-domain-and-state-machine.md`, which records
  the probe and the resulting fixture substitution._

- **A test fixture path must resolve against the module, never the cwd.**
  `readFileSync("docs/proposal/…")` passes from the repo root and fails
  everywhere else, which breaks the hermetic rule in `AGENTS.md`. Write
  `resolve(import.meta.dirname, "../../docs/proposal/…")`. Add no non-null
  assertion — `import.meta.dirname` types as `string` under this `tsconfig`, so
  `import.meta.dirname!` is redundant.
  _Verified 24.17: `const d: string = import.meta.dirname` typechecks clean —
  `npm run typecheck` on a probe under `src/`._

- **A SQLite `CHECK` fails only on false, so `= 1` accepts a NULL column.**
  `CHECK (flag = 1)` evaluates to `NULL` when `flag` is null, and a `NULL`
  result does not violate the constraint — the row is accepted. The clause
  fails open, and it refuses only an explicit `0`. Write `CHECK (flag IS 1)`,
  which compares across null and returns false. The same trap hits any
  `CHECK`, `WHERE` or `ON` predicate over a nullable column.
  _Verified 24.17: a table with `CHECK (a = 1)` accepts `INSERT … VALUES
(NULL)` and one with `CHECK (a IS 1)` refuses it — two `DatabaseSync`
  tables and one insert each. Found by review of EPIC 003; see R1 in
  `.agents/plan/stories/003-storage/index.md`._
