# Story 4 — The Koa-absence test fails on the string `koa`

Epic: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`
Depends on: EPIC 034 story 3, which takes the last koa caller. Story 3 of this epic lands first, in dispatch order.

## Change

Add `src/koa-absence.test.ts`. Add no production file, and change no production file.

- Resolve the repository root as `resolve(import.meta.dirname, "..")`, which is the parent of `src`.
- Walk exactly three roots, in this order: `src`, `test`, `scripts`. Use `readdirSync(directory, { withFileTypes: true })` and recurse into every subdirectory. There is no directory exemption.
- Collect every regular file. The three trees hold text only: `.ts`, `.md`, `.mjs`, `.sh`, `Containerfile`, and the extensionless `scripts/e2e/podman/bin/kanthordc`.
- Exclude one file by path: `src/koa-absence.test.ts` itself, compared against the repository-relative path of the walked file.
- Sort the collected repository-relative paths with `compareBytewise` from `src/http/server/bytewise.ts`.
- Read each file with `readFileSync(file, "utf8")`, split on `"\n"`, and test each line with `/koa/i`.
- Build the offender list as `` `${relativePath}:${lineNumber}` ``, with `lineNumber` 1-based, one entry per matching line, in file order then line order.
- Assert with `assert.deepEqual(offenders, [])`. The failure message therefore names every offending file and its line number.
- The match is case-insensitive. `Koa`, `koa` and `KoaBridge` all fail. On the tree story 4 lands into, `grep -rniE koa src/ test/ scripts/` returns nothing, so the case-insensitive form is satisfiable. The EPIC gate names a case-sensitive grep; the case-insensitive form is a deliberate strengthening, and its cost is that a future identifier which merely contains the letters `koa` also fails. No such identifier exists in the three trees today.

## Constraints

- Import only `node:test`, `node:assert/strict`, `node:fs`, `node:path` and `src/http/server/bytewise.ts`.
- Walk `src`, `test` and `scripts` only. Do not walk `docs/`, `.agents/`, `node_modules/`, `dist/` or the repository root files. `eslint.config.js` and `package.json` still name koa until the human applies S1 and S2.
- Do not edit `package.json`. Removing the five koa dependencies is S1 of the EPIC, and the human applies it after this story and after `npm run verify` is green.
- Do not edit `eslint.config.js`.
- The suite name is `src/koa-absence.test`.

## Verify

- `node --test src/koa-absence.test.ts` passes. Cases:
  - **no file under `src`, `test` or `scripts` names koa** — the offender list over the real trees deep-equals `[]`.
  - **a koa import is detected** — run the line scan over the in-memory string `import Koa from "koa";` and assert the reported line number is `1`.
  - **the case-insensitive form is detected** — run the line scan over the in-memory two-line string whose second line is `const bridge = koaFromHono(app);` and assert the reported line number is `2`.
  - **the test excludes itself** — assert the walked path list contains `src/koa-absence.test.ts` nowhere, and contains `src/main.ts`.
  - **the three roots are walked** — assert the walked path list contains `src/main.ts`, `test/helpers/agent.ts` and `scripts/lane-check.sh`.
- `grep -rn --exclude=koa-absence.test.ts "koa" src/ test/ scripts/` prints nothing. The exclusion is required: `src/koa-absence.test.ts` names koa in its own path, in its suite name and in its synthetic fixtures, so the unqualified grep of the EPIC gate cannot return nothing once this story lands. The test is the mechanism; the grep is the human's cross-check.
- `npm run verify` exits 0.
- Proof: the `src/koa-absence.test.ts` line of the EPIC Proof.
