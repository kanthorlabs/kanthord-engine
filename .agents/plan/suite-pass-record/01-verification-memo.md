# Plan 01: Worker unit — the verification memo

Status: done by `kanthorlabs/kanthord-engine` pull request #378, merged as `14c241d6` on 2026-10-29. Do not build this plan.

## Scope

Repository: `kanthorlabs/kanthord-engine`.

This plan implements the verification memo of the design pages (decision D3).

Today each live verification and each release gate runs every command of its list again, also on a tree that an earlier run of the same claim already tested. `runVerificationsWithOutput` keeps no result across calls (`src/worker/unit/verification.ts:298-333`). `verifyCommands` (`src/worker/unit/steps-implement.ts:747-795`) and `verifyInReleaseClones` (`src/worker/unit/release-gate.ts:240-320`) call it with no shared state.

The plan delivers:

- `VerificationMemo` in the new file `src/worker/unit/verification-memo.ts`: the key, the keep rule and the lookup.
- The input `memo` of `runVerificationsWithOutput`. A hit adds the stored result, calls no observer and writes no span.
- One memo in `StepsState`, which the live verification and the release gate share.

Out of scope:

- The evaluation. "The evaluation reads no memo, so each rerun of the reviewer runs its command." (`docs/brainstorm/worker-service.impl.md:1485`).
- The affected test run, the environment setup and `src/worker/unit/steps-examine.ts`.
- A whole suite that the agent runs inside its turn (`worker-service.impl.md:1493`).

## Model

Opus at medium effort. The memo crosses the runner, the live verification, the release gate, the progress rule and the span writer. The keep rule differs per context, and the result copy of `dogfood-time/` plan 01 shares the runner loop.

## Sources

- `docs/brainstorm/worker-service.impl.md:1482-1493` — "The verification memo".
- `docs/brainstorm/worker-service.impl.md:1462` — "Tests reuse a memo pass on an unchanged tree, and run again after a timeout, a cancellation or a live failure."
- `docs/brainstorm/worker-service.impl.md:1444` — the classes of a command result.
- `docs/brainstorm/worker-service.impl.md:1475-1480` — the result copy, which decides first inside one run list.
- `.agents/plan/dogfood-time/01-result-copy.md` and `02-live-own-commands.md` — the code that this plan starts from (decision D2).

## Depends on

- Plans 01 and 02 of `dogfood-time/` merged to `main` of `kanthorlabs/kanthord-engine`.
- Start from `origin/main` after that merge. Re-anchor each line of this plan to the function that it names.
- Plan 02 of this set also edits `src/worker/unit/test-support.ts`. The plan that merges second rebases on the first.

## Provides

| Item                                                    | Shape                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `VerificationMemo`                                      | `lookup(key): MemoEntry \| null`, `keep(key, entry)`; `MemoEntry` is `{ run: CommandRun, outcome: VerificationClass }`         |
| `memoKeyOf(input)`                                      | the canonical JSON of `[context, command, treeIds, digests]`; `digests` is the sorted list of `[identity, digest]` pairs       |
| `VerificationInput.memo`                                | optional `{ store: VerificationMemo; context: "task" \| "node" \| "release"; treeIds: string[]; digests: [string, string][] }` |
| `StepsState.memo`                                       | one `VerificationMemo` for each execution, created where the state is built                                                    |
| `treeIdOf(env, directory, commit, context, deadlineMs)` | the tree id of `commit`                                                                                                        |
| `worker.verification` spans of a hit                    | none                                                                                                                           |

## Tasks

### 01.1 Write the reproducing tests

- Files: `src/worker/unit/verification.test.ts`, `src/worker/unit/steps-implement-release.test.ts` (edit)
- Do:
  1. In `verification.test.ts`, add the test "a memo pass on an unchanged tree runs no command and writes no span". Use a command that appends one line to a count file in a temporary directory. Run it twice with one `VerificationMemo`, the context `task` and the same tree ids. Assert one line in the count file, one observed attempt and two equal results.
  2. Add the test "a memo in the context task runs a failed command again". Use a count-file command that exits 1. Run it twice with the context `task`. Assert 2 lines.
  3. Add the test "a memo in the context release reuses a code failure". Run the command of step 2 twice with the context `release`. Assert one line and two results with exit code 1.
  4. Add the test "a memo in the context release runs a timed out command again". Use a count-file command that sleeps past `commandLimitMs: 200`. Run it twice with the context `release`. Assert 2 lines.
  5. Add the test "a memo runs a cancelled command again". Use the context `release`. Cancel the operation context of the first run during the command, as the cancellation tests of this file do. Run it again with a live context and the same key. Assert 2 lines.
  6. Add the test "a memo keeps no exit 127". Use `printf x >> <count>; exit 127` with a `baseline` that answers 0. Run it twice with the context `release`. Assert 2 lines.
  7. Add the test "a memo never crosses a context or a tree". Run the pass command of step 1 with the context `task`, then `release`, then `task` with another tree id. Assert 3 lines.
  8. In `steps-implement-release.test.ts`, add the test "a release gate on an unchanged tree reuses its code failure and stops with no_progress". Give the node a count-file command that exits 1 in the release clone and 0 in the live checkout: `printf x >> <count>; case "$PWD" in */release/*) exit 1;; esac`. Let every revision turn change no file. Assert the stop `no_progress` and one line in the count file. Assert `passed: false` and `ran: 1` in `h.lastVerification`.
  9. In the same file, add the test "a second execution of one claim runs every command again". Run `runStepsImplement` twice with the same pass command. Build a new state with the steps helper of `src/worker/unit/test-support.ts:330-366` for each run, so that each run gets its own memo. Assert 2 release lines in the count file.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/verification.test.ts src/worker/unit/steps-implement-release.test.ts` fails. `verification.test.ts` fails to load, because `verification-memo.ts` does not exist. In `steps-implement-release.test.ts`, the test of step 8 fails and the test of step 9 passes.

### 01.2 Add the memo to the runner

- Files: `src/worker/unit/verification-memo.ts` (new), `src/worker/unit/verification.ts` (edit)
- Do:
  1. In `verification-memo.ts`, export `VerificationMemo`, `MemoEntry` and `memoKeyOf`. The key is `JSON.stringify([context, command, treeIds, digests])`. The store is a `Map`.
  2. Export `keepsInMemo(context, entry)`. It answers true for the class `pass` in every context. In the context `release`, it also answers true for the class `code_failure` with `timed_out: false` and an end that is not `CommandEnd.Cancelled`. It answers false for exit code 127, `budget_end` and `infrastructure`.
  3. Add `memo?` to `VerificationInput` (`src/worker/unit/verification.ts:88-101`) with the shape of section "Provides".
  4. In `runVerificationsWithOutput`, after `unstartedClass` and after the result copy of `copyRepeated`, look up the key of the item. On a hit, push the stored result, the stored output and `false`. Set the outcome to the stored class. Continue on `pass`, and break on every other class. Call no observer.
  5. After a real run of an item, keep the run when `keepsInMemo` answers true. Keep the class of `classifiedCommand`, after its infrastructure rerun.
  6. Keep the order of the other rules: the stop at the first failed item, the flaky reruns and the base rerun of exit 127.
- Cite: decision D3; `worker-service.impl.md:1487-1491`.
- Verify: the tests of task 01.1 steps 1 to 7 pass.

### 01.3 Share one memo in the steps state

- Files: `src/worker/unit/steps-implement.ts`, `src/worker/unit/native-method.ts`, `src/worker/unit/test-support.ts`, `src/worker/unit/release-gate.ts`, `src/worker/unit/local-git.ts` (edit)
- Do:
  1. Add `memo: VerificationMemo` to `StepsState` (`src/worker/unit/steps-implement.ts:528-547`).
  2. Create one new memo where each state is built: the state literal of the native method (`src/worker/unit/native-method.ts:158-169`) and the steps helper (`src/worker/unit/test-support.ts:330-366`). `runStepsImplement` receives the memo with the state.
  3. Add `treeIdOf(env, directory, commit, context, deadlineMs)` to `local-git.ts`. It runs `git rev-parse <commit>^{tree}` under the isolated git environment and the deadline rule of the other functions of that file.
  4. `verifyCommands` passes `memo` with the context `node` for the node unit and `task` for a task unit, the tree id of `checkout.head` of each checkout of `state.checkouts`, and the sorted `[identity, digest]` pairs of `state.input.setup.repositories`. It reads the tree ids after `pendingSetup`.
  5. `verifyInReleaseClones` passes `memo` with the context `release`, the tree id of `checkout.head` of each checkout, and the same digests.
  6. Pass no `memo` in `src/worker/unit/evaluation.ts`, `affected.ts`, `environment-setup.ts` and `steps-examine.ts`.
  7. Run `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/*.test.ts src/apps/worker/*.test.ts`. List each failed test. A test that counts the runs of a command on an unchanged tree in one execution now counts one run. Change only that count, and keep every other assert. Name each changed test in the pull request body.
- Cite: decision D3; `worker-service.impl.md:1484`, `:1486`, `:1492`.
- Verify: the tests of task 01.1 steps 8 and 9 pass. `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/*.test.ts src/apps/worker/*.test.ts` passes.

### 01.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the tests of task 01.1 failed before task 01.2 as task 01.1 states, and that every test of task 01.1 passes after task 01.3.
- Run `rg -n 'VerificationMemo' src --glob '!*.test.ts'`. It names only `src/worker/unit/verification-memo.ts`, `src/worker/unit/verification.ts`, `src/worker/unit/steps-implement.ts`, `src/worker/unit/native-method.ts`, `src/worker/unit/test-support.ts` and `src/worker/unit/release-gate.ts`.
- The pull request body names each test that task 01.3 step 7 changed.
