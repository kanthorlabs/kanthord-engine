# Plan 02: Worker unit — the own commands of the live checkout

## Scope

This plan implements the own-command rule of the design pages for items T1 and T3 of the time optimization record (decision D3).

Root cause: the live checkout runs every verification of a unit. `verifyTaskRun` passes `task.content.verifications` (`src/worker/unit/steps-implement.ts:702-707`), and `runTask` checks the pass against the same list (`:482-484`). The node unit of a node with no task holds the node verifications, so it runs every node command live (`:102-108`). The verdict unit runs every node command live (`:385`, `:412-414`). The design runs each node command only at the release gate (`docs/brainstorm/worker-service.impl.md:1369`). In phase 1, the live checkout ran 21 node commands, 4 of them the whole suite, for 39.5 min (`00-index.md`, "Measured savings").

The plan delivers:

- `ownCommandsOf(unit, revision)`: the verifications of the unit whose text equals no verification of the node.
- The live verification of a task unit with its own commands only.
- No live command for the node unit and for the verdict unit. Their live verification passes with an empty list.
- The release gate as before: every node command and every task command, with the result copy of plan 01.

Out of scope:

- The release gate run list and the evaluation run list. Plan 01 owns them.
- The work prompt. It keeps the full verification list of the unit (`static/prompt/template/work.md`).
- `static/prompt/swe@1.md` (`00-index.md`, "Out of scope").
- `src/worker/unit/steps-examine.ts`. An `examine` node keeps its run of the node verifications.

## Model

Opus at medium effort. The change crosses the task loop, the verdict loop, the node unit with no task, the done record and the progress rule. Many steps tests assert the live runs of today.

## Sources

- `docs/brainstorm/worker-service.impl.md:1276` — step 6 of the coder flow: "verify the own commands of the unit in the live checkout".
- `docs/brainstorm/worker-service.impl.md:1368-1370` — the own command, the skip of each node command and the done record.
- `docs/brainstorm/worker-service.impl.md:1409-1411` — the verdict unit and the release gate.
- `docs/brainstorm/worker-service.impl.md:1459-1460` — the steps tests of a node with no task and of a task unit.
- `docs/brainstorm/worker-service.md:403`, `:407` — the skip and the completion of a unit by its own commands.

## Depends on

- Plan 01 merged to `main` of `kanthorlabs/kanthord-engine`. The tests of task 02.1 count one release run of a shared command.
- Start from `origin/main` after that merge.

## Provides

| Item                                  | Shape                                                                                                           |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `ownCommandsOf(unit, revision)`       | `string[]`: the verifications of `unit` in list order whose text is no item of `revision.content.verifications` |
| Live verification of a task unit      | `ownCommandsOf(task, state.revision)`, context `task`                                                           |
| Live verification of the node unit    | the empty list; no `worker.verification` span                                                                   |
| Live verification of the verdict unit | the empty list; no `worker.verification` span                                                                   |
| `task verified` log                   | `exit_codes` of the own commands only                                                                           |

## Tasks

### 02.1 Write the reproducing tests

- Files: `src/worker/unit/steps-implement-verification.test.ts`, `src/worker/unit/steps-implement-verdict.test.ts` (edit)
- Do:
  1. In `steps-implement-verification.test.ts`, add the test "a task unit skips each node command in the live checkout and runs each own command". Give the node the verification `N` and one task the verifications `N` and `T`. `N` and `T` each append one line to their own count file in a temporary directory outside the workspace. Run `runStepsImplement` with one work turn that writes a file. Assert a release with `furtherWork: false`, one line in the count file of `N` and 2 lines in the count file of `T`. Assert with `recordSpans` that no `worker.verification` span with the context `task` runs `N`.
  2. In the same file, add the test "an implement node with no task runs no live verification and runs each node verification once at the release gate". Give the node the verification `N` and no task. Assert a release with `furtherWork: false`, one line in the count file of `N` and no `worker.verification` span with the context `node`.
  3. In `steps-implement-verdict.test.ts`, add the test "a verdict unit runs no node command in the live checkout". Record the done record of the one task as the test "a persistent kill in a node verification of the verdict unit stops with the infrastructure code" does (`src/worker/unit/steps-implement-verification.test.ts:74-103`). Give the node the count-file command `N` and give the task the commands `N` and `true`. Send a verdict with a judged commit and one agent turn that writes a file. Assert a release with `furtherWork: false` and one line in the count file of `N`.
  4. In `steps-implement-verification.test.ts`, add the test "a setup budget end before an empty own list writes no done record and releases further work". Give a stored environment whose setup command reaches the wall deadline, as the setup tests of the file build it (`:164-253`). Give the node the verification `N` and one task the verification `N` only, so the task holds no own command. Assert no `Kanthord-Done` trailer on the node branch and a release with `furtherWork: true`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/steps-implement-verification.test.ts src/worker/unit/steps-implement-verdict.test.ts` fails on the tests of steps 1 to 3 only. Run the test of step 4 again after task 02.2.

### 02.2 Run the own commands in the live checkout

- Files: `src/worker/unit/steps-implement.ts` (edit)
- Do:
  1. Add `export function ownCommandsOf(unit: TaskContent, revision: Pick<Revision, "content">): string[]`. It answers the items of `unit.content.verifications` whose text is no item of `revision.content.verifications`, in list order. For the node unit, every item is a node command, so it answers the empty list.
  2. `verifyTaskRun` (`:702-707`) passes `ownCommandsOf(task, state.revision)` to `verifyCommands`.
  3. `runTask` (`:484`) checks `checked.outcome === VerificationClass.Pass && verificationPassed(verification, checked.commands)`. A setup failure or a setup budget end answers its setup commands in `checked.commands`, so an empty own list never passes it.
  4. `runNodeInstruction` (`:385`) sets `commands` to `ownCommandsOf(unit, state.revision)`. At `:414` it checks `checked.outcome === VerificationClass.Pass && verificationPassed(verification, checked.commands)`, as step 3 does.
  5. Keep `pendingSetup` and the restore sequence of `verifyCommands` (`:747-794`) for an empty list. A pending setup still runs before the first live verification, as `worker-service.impl.md:1512` states.
  6. Change no other code of the done record. `writeDoneRecord` keeps the digest of the unit content.
- Cite: decision D3.
- Verify: the four tests of task 02.1 pass.

### 02.3 Move the steps tests to the own-command rule

- Files: the steps tests that assert a live run of a node command, for example `src/worker/unit/steps-implement.test.ts`, `src/worker/unit/steps-implement-verification.test.ts`, `src/worker/unit/steps-implement-verdict.test.ts`, `src/worker/unit/steps-implement-release.test.ts` and `src/worker/unit/release-gate.test.ts` (edit)
- Do:
  1. Run `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/*.test.ts` and list each failed test.
  2. A test that sets a node verification and expects its failure in the live checkout now meets that failure at the release gate. Keep the asserted end and rename the test to name the release gate. Example: "a persistent kill in a node verification of the verdict unit stops with the infrastructure code" (`src/worker/unit/steps-implement-verification.test.ts:74`) becomes "a persistent kill in a node verification at the release gate stops with the infrastructure code".
  3. A test that counts the live runs of a node command counts them at the release gate. A test of a node with no task asserts no live verification span.
  4. A test of `verifyTaskRun` (`src/worker/unit/steps-implement.test.ts:264`, `:572`) passes a task whose commands the node does not list, or asserts the own-command list.
  5. Keep each assert of a revision route, a done record, a `no_progress` stop and a budget end. Change only the place of the run of a node command.
- Cite: `worker-service.impl.md:1459-1460`.
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/worker/unit/*.test.ts src/apps/worker/*.test.ts` passes.

### 02.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Confirm that the tests of task 02.1 steps 1 to 3 failed before task 02.2, and that the four tests of task 02.1 pass after it.
- Run `rg -n 'content\.verifications' src/worker/unit/steps-implement.ts`. It prints only lines of the function `ownCommandsOf`.
- The pull request body states the saving of `00-index.md` for the live checkout, and names each test that task 02.3 renamed or moved.
