# Plan 01: Worker unit — the result copy

## Scope

This plan implements the result copy of the design pages for items T1, T2 and T3 of the time optimization record (decision D2).

Root cause: `runVerificationsWithOutput` runs every item of its list (`src/worker/unit/verification.ts:298-333`). The release gate passes the node commands and then every task command (`src/worker/unit/release-gate.ts:118`, `:254-272`), and the evaluation passes the same list (`src/worker/unit/evaluation.ts:325-343`). A command that the node and a task both list runs twice on the same tested input. In phase 1, `e01`, `e02`, `e03` and `e05` ran the whole suite twice at the release gate and twice at the evaluation. The copy saves 36.2 min at the release gate and 36.2 min at the evaluation (`00-index.md`, "Measured savings").

The plan delivers:

- The input `copyRepeated` of `runVerificationsWithOutput`. With `copyRepeated: true`, a repeated command copies the result of its first pass.
- `copyRepeated: true` at the release gate and at the evaluation.
- One `worker.verification` span for each real run.

Out of scope:

- The live checkout. Plan 02 removes the node commands from it.
- The verification memo (`00-index.md`, "Out of scope").
- The Mission Service. `verificationCovers` counts the results by command (`src/mission/evidence-content.ts:265-282`), so it accepts a copied result with no change.

## Model

Sonnet at high effort. The change is one loop of the runner and two call sites, with their tests.

## Sources

- `docs/brainstorm/worker-service.impl.md:1475-1480` — "The result copy".
- `docs/brainstorm/worker-service.impl.md:1388` — step 4 of the release gate.
- `docs/brainstorm/worker-service.impl.md:1461` — "Tests copy the result of a repeated command at the release gate and at the evaluation, and assert one real run in the spans."
- `docs/brainstorm/mission-service.impl.md:236-245` — one result for each item that the execution started or copied.
- `docs/brainstorm/worker-service.md:428` — "A repeated command copies its first result."

## Depends on

- Start from `origin/main` of `kanthorlabs/kanthord-engine`.

## Provides

The contract of plan 02:

| Item                                  | Shape                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------- |
| `VerificationInput.copyRepeated`      | optional `boolean`, default `false`                                          |
| Release gate run list                 | the node commands, then the commands of each task, with `copyRepeated: true` |
| Evaluation run list                   | the same list, with `copyRepeated: true`                                     |
| `worker.verification` spans of a copy | none; the first run writes the only span                                     |

## Tasks

### 01.1 Write the reproducing tests

- Files: `src/worker/unit/verification.test.ts`, `src/worker/unit/release-gate.test.ts`, `src/worker/unit/evaluation.test.ts` (edit)
- Do:
  1. In `verification.test.ts`, add the test "a repeated command copies the result of its first pass when the copy applies". Use a command that appends one line to a count file in a temporary directory, then a second command, then the first command again. Run it with `copyRepeated: true` and an observer that records each attempt. Assert 3 results in list order and the third result equal to the first. Assert one line in the count file and 2 observed attempts, at the indexes 0 and 1.
  2. In the same file, add the test "a repeated command runs again when the copy does not apply". Run the same list with no `copyRepeated`. Assert 2 lines in the count file and 3 observed attempts.
  3. In `release-gate.test.ts`, add the test "a command that the node and a task share runs once at the release gate and holds two results". Give the node and one task the same count-file command. Assert `ReleaseGateKind.Passed`, one line in the count file and one `worker.verification` span with the context `release` and the owner of the node. Assert `passed: true` and `ran: 2` in `h.lastVerification`, which `verificationFactsOf` writes from the results of the gate (`src/worker/unit/progress-rule.ts:31-41`).
  4. In `evaluation.test.ts`, add the test "a command that the node and a task share runs once at the evaluation and the evidence holds two results". Use `reviewOf` with the option `taskCommand` equal to the node command and a count-file command. Assert one line in the count file and one `worker.verification` span with the context `evaluation` and the owner of the node. Assert 2 results with exit code 0 in the submitted verification.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/verification.test.ts src/worker/unit/release-gate.test.ts src/worker/unit/evaluation.test.ts` fails on the tests of steps 1, 3 and 4 only. The test of step 2 passes.

### 01.2 Copy a repeated command in the runner

- Files: `src/worker/unit/verification.ts` (edit)
- Do:
  1. Add `copyRepeated?: boolean` to `VerificationInput` (`:88-101`).
  2. In `runVerificationsWithOutput` (`:298-333`), keep a map from the command text to the index of its first pass. Call `unstartedClass` first, as today. After it, check the map. When `copyRepeated` is true and the map holds the command, push the first result, the first output and `false` to `results`, `outputs` and `flaky`. Then continue with the next item. Call no observer for the copy.
  3. After a run with the class `pass`, add its command to the map when the map does not hold it.
  4. Keep the order of the other rules: the stop at the first failed item, the infrastructure rerun, the flaky reruns and the base rerun of exit 127.
- Cite: decision D2.
- Verify: the tests of task 01.1 steps 1 and 2 pass.

### 01.3 Copy at the release gate and at the evaluation

- Files: `src/worker/unit/release-gate.ts`, `src/worker/unit/evaluation.ts`, `src/worker/unit/release-gate.test.ts`, `src/worker/unit/evaluation.test.ts` (edit)
- Do:
  1. Pass `copyRepeated: true` in `verifyInReleaseClones` (`src/worker/unit/release-gate.ts:254-272`).
  2. Pass `copyRepeated: true` in `evaluate` (`src/worker/unit/evaluation.ts:326-343`).
  3. Pass nothing new in `verifyCommands` of `src/worker/unit/steps-implement.ts`, in `src/worker/unit/affected.ts`, in `src/worker/unit/environment-setup.ts` and in `src/worker/unit/steps-examine.ts`.
  4. Run `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/verification.test.ts src/worker/unit/release-gate.test.ts src/worker/unit/evaluation.test.ts src/worker/unit/steps-implement-release.test.ts src/worker/unit/native-method.test.ts`. List each failed test. Change only its count of runs or of spans, and keep every other assert. Steps 5 to 7 name the known cases.
  5. The test "the verification spans of a release name the owner of each command with the context release" (`src/worker/unit/release-gate.test.ts:370`) shares `true` between the node and a task. Give the task a different command, for example `true && true`, so the test still asserts one span for each owner.
  6. The test "the verification spans of a review name the owner of each command with the context evaluation" (`src/worker/unit/evaluation.test.ts:895`) shares `true` too. Give the task a different command in the same way.
  7. The test "a release failure goes to the owner of the first failed index when the node and a task share one command" (`src/worker/unit/release-gate.test.ts:257`) needs a second run of the shared command to fail. With the copy, that second run never happens. Rewrite it as "a failed command that the node and a task share routes its revision to the node unit". The shared command is `case "$PWD" in */release/*) test -e fixed;; esac`. It passes in the live checkout and fails in the release clone until the agent writes `fixed`. Assert `revisions` equal to `[digestOf(h, nodeUnit)]`, where `nodeUnit` is `nodeUnitOf(h.input.claim.node_id, h.revision)`. Assert a release with `furtherWork: false`.
- Cite: decision D2; `worker-service.impl.md:1480`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/verification.test.ts src/worker/unit/release-gate.test.ts src/worker/unit/evaluation.test.ts src/worker/unit/steps-implement-release.test.ts src/worker/unit/native-method.test.ts` passes.

### 01.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the tests of task 01.1 steps 1, 3 and 4 failed before task 01.2 and pass after task 01.3.
- Run `rg -n 'copyRepeated' src --glob '!*.test.ts'`. It names only `src/worker/unit/verification.ts`, `src/worker/unit/release-gate.ts` and `src/worker/unit/evaluation.ts`.
- The pull request body states the saving of `00-index.md` for the release gate and the evaluation, and names each test that task 01.3 changed.
