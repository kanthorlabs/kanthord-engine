# Plan 05: Engine repository — the floor of the affected selector

## Scope

Repository: `kanthorlabs/kanthord-engine`. Landing: Ulrich (decision D10). The plan changes the gate files `scripts/affected-tests.mjs` and `scripts/affected-reporter.mjs` of `.kanthord/affected-tests.json:5-16`.

This plan makes the engine selector write the affected report version 2 with `floor` (decision D7).

Today the selector writes `version: 1` (`scripts/affected-tests.mjs:92`, `:538-556`). Its graph holds only the reverse edges, from a file to its importers (`:281-301`). The reporter writes only the failed test ids (`scripts/affected-reporter.mjs`), so the selector knows no test time.

The plan delivers:

- The test time of each test file in the reporter output.
- The forward edges and the import closure of a file in the selector graph.
- `floorOf(graph)` and the report `version: 2` with `floor`.
- The exports that plan 06 uses: `buildGraph`, `closureOf`, `floorOf`, `isRunTest` and `runTests` with the test time.

Out of scope:

- The apps selector. It keeps version 1 (decision D7).
- The suite pass record. Plan 06 owns it.

## Model

Sonnet at high effort. The change stays in two scripts and their test file. The rules of decision D7 fix every value.

## Sources

- `docs/brainstorm/worker-service.impl.md:1595-1598` — version 2, the floor and its keys.
- `docs/brainstorm/worker-service.impl.md:1600-1611` — the version 2 example.
- `docs/brainstorm/project-service.impl.md:411` — the import closure comes from the graph of the selector, and no second map exists.
- Open item O3 of `00-index.md` — the production file.

## Depends on

- Plan 02 of this set merged. The worker then accepts version 2 (ruling of root pull request #275).
- Ulrich ruled open item O3. With a ruling other than option A, change only task 05.2 step 2.
- Start from `origin/main` of `kanthorlabs/kanthord-engine`.

## Provides

The contract of plan 06:

| Item                       | Shape                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `buildGraph(root)`         | adds `importsByFile: Map<string, Set<string>>` and keeps every field of today                          |
| `closureOf(graph, path)`   | sorted `string[]`: the file and each file that its forward edges reach, the files of a prefix included |
| `floorOf(graph)`           | sorted `string[]`: every floor test file of decision D7                                                |
| `runTests(root, files, n)` | `{ passed, ids, seconds: Map<string, number> }`                                                        |
| `PRODUCTION_ENTRY`         | `"src/main.ts"`                                                                                        |
| Report                     | `version: 2` and `floor: { tests, seconds, total_seconds }`                                            |

## Tasks

### 05.1 Write the reproducing tests

- Files: `scripts/affected-tests.test.mjs` (edit)
- Do:
  1. Add the test "the floor holds each test file whose closure holds every production file". Build a fixture repository as the tests of `:87-108` do. `src/main.ts` imports `src/a.ts` and `src/b.ts`. `src/full.test.ts` imports `src/main.ts`. `src/part.test.ts` imports `src/a.ts`. Each fixture test waits 200 ms, so its test time is above 0. Assert `floorOf(buildGraph(root))` equal to `["src/full.test.ts"]`.
  2. Add the test "a data edge counts in the closure". `src/main.ts` reads `new URL("../static/openapi/", import.meta.url)`. Assert that `closureOf` of `src/full.test.ts` holds each file under `static/openapi/`.
  3. Add the test "a selection all writes version 2 with the floor and the total test time". Run `affectedReport` on the fixture with a change of `package.json`. Assert `version: 2`, `floor.tests: 1`, a `floor.seconds` above 0 and a `floor.total_seconds` at least `floor.seconds`.
  4. Add the test "a related selection writes a floor with a null total". Change `src/a.ts`. Assert `floor.tests: 1` and `floor.total_seconds: null`.
  5. Add the test "a selection none writes a floor of 0 seconds". Change one inert file. Assert `floor.tests: 1`, `floor.seconds: 0` and `floor.total_seconds: null`.
  6. Add the test "the reporter writes the test time of each file". Run `runTests` on two fixture test files. Assert a `seconds` entry above 0 for each file.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 scripts/affected-tests.test.mjs` fails on the new tests only.

### 05.2 Build the closure and the floor

- Files: `scripts/affected-tests.mjs` (edit)
- Do:
  1. In `buildGraph` (`:281-301`), also record `importsByFile`, from each parsed file to the files and the prefixes that it names. Keep `importersByFile` and `prefixEdges` as they are.
  2. Add `PRODUCTION_ENTRY = "src/main.ts"`. A production file is a file of `closureOf(graph, PRODUCTION_ENTRY)`.
  3. Add `closureOf(graph, path)`. It walks the forward edges from `path`. A prefix edge reaches each present file whose path starts with the prefix. It answers the sorted present files.
  4. Add `floorOf(graph)`. It answers each present file with `isRunTest` true whose closure holds every production file, sorted.
  5. Export `buildGraph`, `closureOf`, `floorOf`, `isRunTest` and `runTests`.
- Cite: decision D7.
- Verify: the tests of task 05.1 steps 1 and 2 pass.

### 05.3 Write the test time and the report version 2

- Files: `scripts/affected-reporter.mjs`, `scripts/affected-tests.mjs` (edit)
- Do:
  1. In `affected-reporter.mjs`, on each `test:summary` event that holds `data.file`, write one line `{ "file": <path>, "seconds": <duration_ms / 1000> }`. When that event is absent for a file, use the `test:complete` event with the nesting 0 whose name equals the file argument. Node.js 24 sends no file-level `test:pass` for a passing file. Keep the failed id lines as they are.
  2. In `runTests` (`:450-480`), split the lines: a line with `seconds` goes to the map `seconds`, and a line with `name` goes to `ids`.
  3. Set `REPORT_VERSION` (`:92`) to 2.
  4. In `affectedReport` (`:558-585`), compute the floor of decision D7. Sum the test time of the first run of each floor file in `tests`. A rerun adds no time. `total_seconds` is the sum of the test time of every file of `tests` for the selection `all`, else null. Round each sum to 0.1 s.
  5. Pass `floor` to `buildReport` (`:538-556`). `fitSize` cuts no key of `floor`.
- Cite: decision D7; `worker-service.impl.md:1597`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 scripts/affected-tests.test.mjs scripts/test-reporter.test.mjs` passes.

### 05.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the tests of task 05.1 failed before task 05.2 and pass after task 05.3.
- In a clean clone of the branch, run `KANTHORD_AFFECTED_REPORT="$(mktemp)" pnpm --silent run test:affected --base origin/main`. Parse it with `node --input-type=module -e 'import { readFileSync } from "node:fs"; import { parseReport } from "./src/worker/unit/affected.ts"; const r = parseReport(readFileSync(process.argv[1], "utf8"), 0); console.log(JSON.stringify(r)); process.exit("report" in r && r.report.version === 2 && r.report.floor ? 0 : 1)' <report>`. It exits 0, so the report is valid and holds `version: 2` and `floor`. Paste `floor` into the pull request body.
- The pull request body states: "Gate files change. Ulrich lands this pull request."
