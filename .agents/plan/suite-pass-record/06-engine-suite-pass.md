# Plan 06: Engine repository — the suite pass record

## Scope

Repository: `kanthorlabs/kanthord-engine`. Landing: Ulrich (decision D10). The plan changes the gate files `.kanthord/affected-tests.json`, `package.json` and `scripts/affected-tests.mjs`, and it adds the gate files `.kanthord/suite-pass.json`, `.github/workflows/ci.yml` and `scripts/suite-pass.mjs`.

This plan builds the suite pass record of the engine repository (decision D8), and adds `.kanthord/suite-pass.json` and `.github/workflows/ci.yml` to `gate_files` (root `docs/brainstorm/HANDOFF.md:89`).

Today the `check` job runs every test file that needs no `sshd`, and the `e2e` job runs every test file that needs one (`.github/workflows/ci.yml:20-71`). Each pull request and each push to `main` runs the whole suite again, also for a test file whose inputs did not change.

The plan delivers:

- `scripts/suite-pass.mjs` and `scripts/suite-pass.test.mjs`.
- `.kanthord/suite-pass.json` with the always-run list.
- The gitignore exception and the three new paths in `gate_files`.
- `ci.yml`: the record store through `actions/cache/restore` and `actions/cache/save`, the suite pass step in `check` and `e2e`, the job summary and the nightly full run.
- One section "The suite pass record" in `docs/testing.md`.

Out of scope:

- The apps repository. Plan 07 owns it.
- Records that a developer or KanthorD writes (`project-service.impl.md:413`).
- The suite pass proposal (open items O1 and O2).

## Model

Opus at medium effort. The plan joins the selector graph, the test run, the git state, the cache scope of GitHub Actions and two CI jobs. A wrong key skips a test that must run.

## Sources

- `docs/brainstorm/project-service.impl.md:403-435` — the suite pass record and its configuration.
- `docs/brainstorm/worker-service.impl.md:1539-1540` — the gate files and the CI rule before the landing.
- Root `docs/brainstorm/HANDOFF.md:89` at `c418936` — the two paths in `gate_files`.
- The ruling of root pull request #275, Project Service item — "In `engine`, the global inputs also hold `static/pi-tools.json`." and the accepted limits.

## Depends on

- Plan 05 landed on `main` of `kanthorlabs/kanthord-engine`. This plan imports `buildGraph`, `closureOf`, `floorOf`, `isRunTest` and `runTests`.
- Start from `origin/main` after that landing.

## Provides

| Item                                  | Shape                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `node scripts/suite-pass.mjs run`     | `--job <name>`, `[--write]`, `[--full]`, `--concurrency <n>`, then the test files; exit 0 exactly when every run file passes |
| `keyOf(root, graph, file, toolchain)` | SHA-256 hex of decision D8                                                                                                   |
| Record store                          | `node_modules/.cache/suite-pass/records.json`: `{ version: 1, records: { <key>: { file, seconds, written_at } } }`           |
| Job summary                           | the lines `Floor: <n> test files, <s> s`, `Ran: <n> test files`, `Skipped: <n> test files`, `Saved share: <p>%`              |

## Tasks

### 06.1 Write the reproducing tests

- Files: `scripts/suite-pass.test.mjs` (new)
- Do:
  1. Add the test "a test file with a matching record is skipped". Build a fixture repository with a commit, as `scripts/affected-tests.test.mjs:87-108` does. It holds `src/a.ts`, `src/a.test.ts`, `src/b.test.ts`, `.kanthord/affected-tests.json`, `.kanthord/suite-pass.json` and a `.gitignore` with `node_modules/`. Run `run --write` once, then again. Assert that the second run runs no test file and prints a saved share of `100%`.
  2. Add the test "a change in the closure of a test file runs it again". After the first run, commit a change of `src/a.ts`. Assert that the second run runs `src/a.test.ts` only.
  3. Add the test "a change of a global input or a gate file runs every test file". Commit a change of `package.json`, then of `.kanthord/affected-tests.json`. Assert that each run runs every test file.
  4. Add the test "a file of always_run runs with a matching record". List `src/b.test.ts` in `.kanthord/suite-pass.json`. Assert that the second run runs `src/b.test.ts` only.
  5. Add the test "a dirty or untracked tree writes no record". Add an untracked file and run `run --write`. Assert the refusal and no record store. Repeat with a modified tracked file.
  6. Add the test "a failed test file writes no record". Make `src/b.test.ts` fail. Assert a record for `src/a.test.ts` only and exit code 1.
  7. Add the test "the full flag runs every test file and writes records".
  8. Add the test "the key changes with the Node.js version and the pnpm version". Call `keyOf` with two toolchains.
  9. Add the test "the store keeps the 20000 newest records".
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 scripts/suite-pass.test.mjs` fails, because `scripts/suite-pass.mjs` does not exist.

### 06.2 Write the record steps

- Files: `scripts/suite-pass.mjs` (new), `scripts/affected-tests.mjs`, `package.json` (edit)
- Do:
  1. In `suite-pass.mjs`, read `.kanthord/suite-pass.json`. It is a strict object of `version: 1` and `always_run`, a list of repository paths. Another shape exits 2 with the parse error.
  2. Read `gate_files` of `.kanthord/affected-tests.json` of the checkout.
  3. Read the toolchain: `process.versions.node` and the output of `pnpm --version`.
  4. Read the blob ids with `git ls-tree -r -z HEAD`. Build the key of each test file of the arguments with decision D8: the global inputs are `GLOBAL_INPUTS` of the selector and `static/pi-tools.json`.
  5. Read the record store. An absent or invalid store reads as empty.
  6. Select the run files: each argument file with no record of its key, and each file of `always_run`. With `--full`, select every argument file.
  7. With `--write`, refuse with exit 2 when `git status --porcelain --untracked-files=all` prints a line.
  8. Run the selected files with `runTests` of the selector and the `--concurrency` value.
  9. With `--write`, check the git status again. On a clean tree, add one record for each passed file with its test time and the time of the run. Keep the 20000 newest records, and write the store.
  10. Write the job summary of section "Provides" to `$GITHUB_STEP_SUMMARY` when it is set, and to the standard output. The floor count is the count of `floorOf` among the argument files. The floor seconds is the test time of the floor files that ran. The saved share follows decision D8.
  11. Exit 0 when every run file passes. Exit 1 when a run file fails.
  12. In `scripts/affected-tests.mjs`, add `scripts/suite-pass.test.mjs` to `TEST_SCRIPTS` (`:40-44`).
  13. In `package.json`, add `scripts/suite-pass.test.mjs` to the `test` script, and `scripts/suite-pass.mjs` and `scripts/suite-pass.test.mjs` to the `lint` script.
- Cite: decision D8; `project-service.impl.md:407-415`.
- Verify: the tests of task 06.1 pass.

### 06.3 Add the configuration and the gate files

- Files: `.kanthord/suite-pass.json` (new), `.kanthord/affected-tests.json`, `.gitignore` (edit)
- Do:
  1. Build the always-run list. Run `git ls-files 'src/*.test.ts' | xargs rg -l 'bin/|dist/|esbuild|build\('`. Read each match. Keep each test file that bundles code, reaches `bin/` or `dist/`, or reads a path that it builds at run time (`project-service.impl.md:433`). Name each kept file and its reason in the pull request body.
  2. Write `.kanthord/suite-pass.json` with `version: 1` and the sorted list.
  3. Add `!/.kanthord/suite-pass.json` to `.gitignore` after `!/.kanthord/comments.json`.
  4. Add `.kanthord/suite-pass.json`, `.github/workflows/ci.yml` and `scripts/suite-pass.mjs` to `gate_files` of `.kanthord/affected-tests.json`.
- Cite: decision D8; `project-service.impl.md:420`, `:435`.
- Verify: `git check-ignore .kanthord/suite-pass.json` prints nothing. `node scripts/suite-pass.mjs run --job local --concurrency 4 src/kernel/json.test.ts` exits 0.

### 06.4 Use the record in CI

- Files: `.github/workflows/ci.yml` (edit)
- Do:
  1. Add the trigger `schedule: - cron: "0 3 * * *"`.
  2. In `check` and in `e2e`, after `pnpm install --frozen-lockfile` and before the test step, add `actions/cache/restore@v6` with the path `node_modules/.cache/suite-pass`, the key `suite-pass-<job>-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}` and the restore key `suite-pass-<job>-${{ runner.os }}-`.
  3. Replace the test command of `check` (`:41-45`) with `node scripts/suite-pass.mjs run --job check --write --concurrency "$TEST_CONCURRENCY" <files>`, with the same file list. Add `--full` when `github.event_name` is `schedule`.
  4. Replace the test command of `e2e` (`:66-71`) in the same way with `--job e2e`.
  5. After the test step, add `actions/cache/save@v6` with `if: always()`, the same path and the same key.
  6. Keep every other step and the order of the steps.
- Cite: decision D8; `project-service.impl.md:413`, `:415-416`.
- Verify: `pnpm exec prettier --check .github/workflows/ci.yml` passes. When `actionlint` is on the `PATH`, `actionlint .github/workflows/ci.yml` passes.

### 06.5 Document the record

- Files: `docs/testing.md` (edit)
- Do:
  1. Add the section "The suite pass record". State the key, the store, the always-run list, the flags `--write` and `--full`, the CI cache, the job summary and the nightly run.
  2. State the accepted limits of the ruling of root pull request #275: the test files that load the composed server run for every production change, and a push to `main` runs the selected test files again until `main` reads the records.
  3. Run `pnpm exec prettier --write docs/testing.md`.
- Verify: `pnpm exec prettier --check docs/testing.md` passes.

### 06.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the tests of task 06.1 failed before task 06.2 and pass after it.
- Push the branch. The first CI run of the pull request passes, and each job prints its summary with `Skipped: 0 test files`.
- Re-run the `check` job of the same commit. It skips each test file that passed in the first run, and its summary prints a saved share above 0. Paste both summaries into the pull request body.
- The pull request body states: "Gate files change. Ulrich lands this pull request."
