# Plan 07: Apps repository — the suite pass record

## Scope

Repository: `kanthorlabs/kanthord-apps`. Landing: Ulrich (decision D10). The plan changes the gate files `.kanthord/affected-tests.json` and `package.json`, and it adds the gate files `.kanthord/suite-pass.json`, `.github/workflows/ci.yml` and `scripts/suite-pass.mjs`.

This plan builds the suite pass record of the apps repository with one record for the whole tree (decision D9), and adds `.kanthord/suite-pass.json` and `.github/workflows/ci.yml` to `gate_files` (root `docs/brainstorm/HANDOFF.md:89`).

Today the `check` job runs `pnpm run verify`, which runs every test file, and then `pnpm run build` (`.github/workflows/ci.yml:17-36`). The apps selector runs `vitest related` (`scripts/affected-tests.mjs:207-211`), so it gives no import graph.

The plan delivers:

- `scripts/suite-pass.mjs` and `scripts/suite-pass.test.mjs`.
- `.kanthord/suite-pass.json` with the always-run list.
- The gitignore exception and the three new paths in `gate_files`.
- `ci.yml`: the record store through `actions/cache/restore` and `actions/cache/save`, the suite pass step, the job summary and the nightly full run.

Out of scope:

- An import graph for the apps selector, and a key for each test file.
- The `floor` of the apps report. The apps selector keeps version 1 (decision D7).
- The engine repository. Plan 06 owns it.

## Model

Sonnet at high effort. One key for the whole tree keeps the script small, and the CI change follows the steps of plan 06.

## Sources

- `docs/brainstorm/project-service.impl.md:414` — "A repository with no selector, or whose selector gives no import graph, uses one record for the whole tree. Its key is the tree id and the toolchain."
- `docs/brainstorm/project-service.impl.md:403-435` — the other rules of the record and of its configuration.
- `docs/brainstorm/worker-service.impl.md:1539-1540` — the gate files and the CI rule before the landing.
- Root `docs/brainstorm/HANDOFF.md:89` at `c418936` — the two paths in `gate_files`.

## Depends on

- Plan 02 of `dogfood-time/` merged to engine `main`, the start of this set.
- Start from `origin/main` of `kanthorlabs/kanthord-apps`. No file overlaps with plan 04.

## Provides

| Item                              | Shape                                                                             |
| --------------------------------- | --------------------------------------------------------------------------------- |
| `node scripts/suite-pass.mjs run` | `--job <name>`, `[--write]`, `[--full]`; exit 0 exactly when the run passes       |
| `treeKeyOf(treeId, toolchain)`    | SHA-256 hex of decision D9                                                        |
| Record store                      | `node_modules/.cache/suite-pass/records.json`, the shape of plan 06               |
| Job summary                       | the lines `Floor: none`, `Record: hit` or `Record: miss`, and `Saved share: <p>%` |

## Tasks

### 07.1 Write the reproducing tests

- Files: `scripts/suite-pass.test.mjs` (new)
- Do:
  1. Add the test "a tree with a matching record runs no test". Build a fixture git repository in a temporary directory with one commit, a `.gitignore` with `node_modules/` and a `.kanthord/suite-pass.json`. Give the script a test command that appends one line to a count file outside the fixture. Run `run --write` twice. Assert one line, and a saved share of `100%` on the second run.
  2. Add the test "a new commit runs the tests again". Commit one change between the runs. Assert 2 lines.
  3. Add the test "a file of always_run runs on a matching record". List one test file. Assert that the second run runs only that file.
  4. Add the test "a dirty or untracked tree writes no record".
  5. Add the test "a failed run writes no record".
  6. Add the test "the full flag runs the tests and writes a record".
  7. Add the test "the key changes with the Node.js version and the pnpm version".
- Verify: `pnpm exec vitest run scripts/suite-pass.test.mjs` fails, because `scripts/suite-pass.mjs` does not exist.

### 07.2 Write the record steps

- Files: `scripts/suite-pass.mjs` (new)
- Do:
  1. Read `.kanthord/suite-pass.json`: a strict object of `version: 1` and `always_run`. Another shape exits 2 with the parse error.
  2. Read the tree id with `git rev-parse HEAD^{tree}`, and the toolchain from `process.versions.node` and `pnpm --version`. Build the key of decision D9.
  3. Read the record store. An absent or invalid store reads as empty.
  4. With `--write`, refuse with exit 2 when `git status --porcelain --untracked-files=all` prints a line.
  5. On a miss or with `--full`, run `vitest run`. On a hit, run `vitest run` with the files of `always_run`, or no test when the list is empty.
  6. Read the test time from the JSON reporter of vitest, as `runVitest` of `scripts/affected-tests.mjs:128-139` does.
  7. With `--write`, check the git status again. After a pass of a full run on a clean tree, write the record `{ file: ".", seconds, written_at }`. Keep the 20000 newest records.
  8. Write the job summary of section "Provides" to `$GITHUB_STEP_SUMMARY` when it is set, and to the standard output. The saved share follows decision D9.
  9. Exit 0 on a pass, 1 on a failed test and 2 on a refusal.
- Cite: decision D9; `project-service.impl.md:412-416`.
- Verify: the tests of task 07.1 pass.

### 07.3 Add the configuration and the gate files

- Files: `.kanthord/suite-pass.json` (new), `.kanthord/affected-tests.json`, `.gitignore`, `package.json` (edit)
- Do:
  1. Check each test file of `src/` and `scripts/` against `project-service.impl.md:433`. List each match in `always_run`, sorted. With no match, write `always_run: []`. Name the result in the pull request body.
  2. Write `.kanthord/suite-pass.json` with `version: 1` and the list.
  3. Add `!/.kanthord/suite-pass.json` to `.gitignore`.
  4. Add `.kanthord/suite-pass.json`, `.github/workflows/ci.yml` and `scripts/suite-pass.mjs` to `gate_files` of `.kanthord/affected-tests.json`.
  5. Add the script `test:suite-pass` with the value `node scripts/suite-pass.mjs run` to `package.json`.
- Cite: decision D9; `project-service.impl.md:420`, `:435`.
- Verify: `git check-ignore .kanthord/suite-pass.json` prints nothing.

### 07.4 Use the record in CI

- Files: `.github/workflows/ci.yml` (edit)
- Do:
  1. Add the trigger `schedule: - cron: "0 3 * * *"`.
  2. Replace `pnpm run verify` (`:32`) with the steps `pnpm run typecheck`, `pnpm run lint` and `pnpm run format:check`, then the suite pass step. Keep `pnpm run build` last.
  3. After `pnpm install --frozen-lockfile` and before the suite pass step, add `actions/cache/restore@v6` with the path `node_modules/.cache/suite-pass`, the key `suite-pass-check-${{ runner.os }}-${{ github.run_id }}-${{ github.run_attempt }}` and the restore key `suite-pass-check-${{ runner.os }}-`.
  4. The suite pass step runs `pnpm run test:suite-pass --job check --write`. It adds `--full` when `github.event_name` is `schedule`.
  5. After the suite pass step, add `actions/cache/save@v6` with `if: always()`, the same path and the same key.
- Cite: decision D9; `project-service.impl.md:413`, `:415-416`.
- Verify: `pnpm exec prettier --check .github/workflows/ci.yml` passes. When `actionlint` is on the `PATH`, `actionlint .github/workflows/ci.yml` passes.

### 07.E Gate

- Run `pnpm verify` in `apps/`.
- Confirm that the tests of task 07.1 failed before task 07.2 and pass after it.
- Push the branch. The first CI run of the pull request passes, and its summary prints `Record: miss` and `Saved share: 0%`.
- Re-run the `check` job of the same commit. Its summary prints `Record: hit` and `Saved share: 100%`, unless `always_run` lists a file. Paste both summaries into the pull request body.
- The pull request body states: "Gate files change. Ulrich lands this pull request."
