# Plan 00: Index

## Scope

This plan set covers the worker-routing dogfood run of 2026-10-29. It covers the items T1, T2, T3 and T5 of the time optimization record and the live-check candidates C1 and C2. Aelita recorded them in root `.dev/worker-routing-dogfood/time-optimization.md` and `notes.md`. The planner checked each item against the root design pages at `c8c41e7` and the engine at `1b5a1535`. The planner also read the tracking data of `run-p1` and the traces of the `run-p3` server.

Ulrich ruled on 2026-10-29 to run the full suite once for each node execution (root pull request #275). Root pull request #277 wrote the ruling into the design pages. The engine does not implement these rules yet. The set plans them:

- Plan 01: the result copy. At the release gate and at the evaluation, a repeated command of one run list copies the result of its first run.
- Plan 02: the own commands. The live checkout runs only the commands of a unit that the node does not list. The release gate runs each node command once.

These two plans remove the time that T1, T2 and T3 measure, inside the rules of the design pages.

## Items

- T1 — no plan of the literal change. Open item O1. The design requires the release gate run. The release gate runs every node and task command in a clean local clone (root `docs/brainstorm/worker-service.md:428`, `docs/brainstorm/worker-service.impl.md:1384-1388`). "A result never crosses a context. A live result never counts at the release gate, because the live checkout holds ignored files." (`worker-service.impl.md:1490`). A named tested input is an assertion of the executor, "unless a clean isolated checkout establishes it" (`docs/brainstorm/mission-service.md:343`). The cost that T1 measures comes from the live run of node commands, which the design forbids (`worker-service.impl.md:1368-1369`). The engine runs every task command in the live checkout (`src/worker/unit/steps-implement.ts:702-707`) and every listed command at the release gate with no copy (`src/worker/unit/release-gate.ts:118`, `:254-272`). Plans 01 and 02 fix both.
- T2 — no plan of the literal change. Open item O2. The design requires the reviewer run. "The reviewer of an `implement` node runs the verifications of the node and of each current task of the pinned revision" in a clean isolated checkout (`worker-service.md:617-618`, `:629`). "An executor report is attributable evidence, and it is not an independently verified check." (`mission-service.md:344`). "The evaluation reads no memo, so each rerun of the reviewer runs its command." (`worker-service.impl.md:1485`). The engine runs each listed command of the evaluation with no copy (`src/worker/unit/evaluation.ts:325-343`). Plan 01 adds the copy, so a command that the node and a task both list runs once.
- T3 — no plan. Decision D5. The import requires that each node verification equals a verification of one task of the node (`mission-service.md:257`, root `docs/reference/mission/import.md:36`). A plan that lists the whole suite in the node only fails with `mission.import.verification_uncovered`. The ruling of root pull request #275 keeps this rule. Plans 01 and 02 remove the cost of the repeated entry.
- T5 — no plan. Decision D6. The host suite after each merge is a step of the dogfood epic (root `.dev/worker-routing-dogfood/epic.md:143-147`, `:251`), not product code.
- C1 — no plan. Not a defect. Traces `bd3015ac344a8c3b33620bdc70bd47e1` and `188ffed01f8012b22db8edddc00e01a8` each write an `undetermined` assessment with 2 proposals, move the node `Evaluating -> Blocked`, end `revoked` with `kanthord.revoke.cause: assessment`, root status `Ok` and no cause. The design states each value: `revoked` for a revocation at a Mission transition, the revoke cause `assessment` when the assessment of the execution decides the node, `Ok` for that revocation, and "Another assessment result writes no cause." (root `docs/brainstorm/scheduler-service.impl.md:289-294`, `:297`, `:301`).
- C2 — no plan. Not a defect of the code against the design pages. Open item O3 names the design gap. Trace `59701b512f40b83c28b6a1bb37779ad1` holds one model reply: session entry 6, `stopReason: toolUse`, 5470 tokens, cost $0.0089. The reply started a `bash` tool call, and the forced archive revoked the execution during that call. The tracer writes the usage only at `turn_end` (`src/worker/unit/agent-telemetry.ts:337-356`), and a pi turn ends after its tool calls. After the revocation, the gateway refuses every telemetry write of the execution with `gateway.invocation.execution_proof_failed` (`src/gateway/invocation.ts:116-128`). The design wants that refusal: "On revocation or loss, the execution aborts its pi session and dispatches nothing after." (`worker-service.impl.md:1914`). The `agent.turn` span keeps no end, which the design accepts as "a span with no end recorded" (root `docs/brainstorm/tracking-service.impl.md:153`). The trace sums the usage of the spans only (`tracking-service.impl.md:204`), so it answers 0 tokens and $0.

## Measured savings

Source: the 115 `worker.verification` spans of the phase 1 nodes `e01` to `e07` (`run-p1/xdg/data/kanthord/tracking.db`). Each span maps to its command through the index, the context and the owner of the span and the pinned revision of its node. One whole-suite run takes 7.8 to 8.0 min. The verifications of one execution run one after another, so each saved minute is one minute of execution time.

| Item           | Mechanism                                                              | Phase 1 runs removed                            | Phase 1 time saved                   | Each node with the whole suite (`e01`, `e02`, `e03`, `e05`)    |
| -------------- | ---------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| T1, as written | A live pass counts at the release gate on the same commit              | 0                                               | 0 min                                | 0 min                                                          |
| T1, T3         | Plan 02: the live checkout skips each node command                     | 21 of 27 live runs, 4 of them whole-suite       | 39.5 min, 31.5 min of it whole-suite | 8.9 to 9.4 min of the coder                                    |
| T1, T3         | Plan 01: the release gate copies a repeated command                    | 13 of 36 release runs, 4 of them whole-suite    | 36.2 min, 31.5 min of it whole-suite | 8.9 to 9.4 min of the coder                                    |
| T2, T3         | Plan 01: the evaluation copies a repeated command                      | 13 of 36 evaluation runs, 4 of them whole-suite | 36.2 min, 31.6 min of it whole-suite | 8.9 to 9.5 min of the reviewer                                 |
| T2, as written | The reviewer reads the coder evidence and runs only the affected tests | 36 listed evaluation runs                       | 75.7 min; 39.5 min after plan 01     | 17.7 to 18.4 min of the reviewer; 8.8 to 9.2 min after plan 01 |
| T5             | Decision D6: one host suite at the end of the phase                    | 5 of 6 host-suite runs                          | 39 min of project pause              | 7.8 min of pause after each merge                              |

- T1 as written saves nothing. No release run had the commit of a live run, because the done record amends the commit (`worker-service.impl.md:1486`), and a later task changes the tree.
- Plans 01 and 02 save 111.9 min of the 223.3 min of verification time of phase 1. The coder time goes from 132.0 min to 56.3 min. The reviewer time goes from 91.3 min to 55.1 min. That includes 15.6 min of affected runs on each side, which no plan changes.
- A node with the whole suite runs it 2 times instead of 5: once at the release gate and once at the evaluation. Each such node saves 26.6 to 28.3 min.
- T5: the notes record 471 s, 470 s and 470 s for 3 of the 5 runs that paused the project. The estimate uses 7.8 min for each of the 5 runs.

## Out of scope

- T4. It is fixed: `report.mjs` lists each budget end.
- T6 and the text of `static/prompt/swe@1.md`. Root `docs/brainstorm/HANDOFF.md`, section "Worker Service", gives the copy of `docs/brainstorm/assets/prompt/swe@1.md` to the build of the suite pass record. In phase 1, `bash` tool calls of 4 min or more took 67.7 min of the coder executions.
- The verification memo (`worker-service.impl.md:1482-1493`). Phase 1 holds no repeated verification on an unchanged tree, so the memo saves 0 min.
- The restated live run and release gate of root `docs/explanation/coder-worker.md`. Root `HANDOFF.md` gives it to the build of the suite pass record.
- The CI `check` job. It runs once for each pull request, 6 to 7 min.

## Plans

Each plan is one pull request and ends green. Plan 02 starts after plan 01 merges.

| Plan | File                      | Repository                    | Model        | Component                          | Boundary                                                                                                                                                           | Item       |
| ---- | ------------------------- | ----------------------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 01   | `01-result-copy.md`       | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker unit — verification run     | `runVerificationsWithOutput` copies a repeated command of one run list after its pass; the release gate and the evaluation turn it on; one span for each run.      | T1, T2, T3 |
| 02   | `02-live-own-commands.md` | `kanthorlabs/kanthord-engine` | Opus, medium | Worker unit — steps of `implement` | The live checkout runs only the own commands of a task unit; the node unit and the verdict unit run no live command; the release gate runs each node command once. | T1, T3     |

**Rationale for order.**
Plan 02 moves each node command to the release gate. Its tests count one release run of a command that the node and a task both list. Only the result copy of plan 01 gives that count. Plan 01 also changes the release gate tests that plan 02 edits again.

## Repositories, branches and worktrees

Create each worktree from `origin/main` of its repository. The worktree directory `.dev/<name>` matches the branch `<type>/<name>`. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (root `CLAUDE.local.md` "Commits"). When a repository rule refuses a push, stop and report it.

| Plan | Repository root | Worktree                        | Branch                   | Command                                                                                                                                                                    |
| ---- | --------------- | ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `engine/`       | `engine/.dev/result-copy`       | `feat/result-copy`       | `git -C engine fetch origin && git -C engine worktree add -b feat/result-copy .dev/result-copy origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch`             |
| 02   | `engine/`       | `engine/.dev/live-own-commands` | `feat/live-own-commands` | `git -C engine fetch origin && git -C engine worktree add -b feat/live-own-commands .dev/live-own-commands origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch` |

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

| Plan | Gate                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `pnpm run verify`; the new tests of task 01.1 failed before task 01.2 and pass after task 01.3; `rg -n 'copyRepeated' src --glob '!*.test.ts'` names only `src/worker/unit/verification.ts`, `src/worker/unit/release-gate.ts` and `src/worker/unit/evaluation.ts`. |
| 02   | `pnpm run verify`; the new tests of task 02.1 failed before task 02.2 and pass after it; `rg -n 'content\.verifications' src/worker/unit/steps-implement.ts` prints only lines of the function `ownCommandsOf`.                                                     |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>` or `docs/reference/<page>:<line>` of the root repository at `c8c41e7`.
- An engine citation names a path under the engine root at `1b5a1535`.
- When `main` moved before the plan starts, re-anchor each citation to the sentence or code block that the text means (`engine/AGENTS.md`, section "Plans").

## Open items

- O1 (T1) — OPEN for Ulrich. Recommendation: keep the release gate run of every listed command in the clean clone, and build plans 01 and 02. The clean clone is the only proof that the commit holds every file that the verification reads. Plans 01 and 02 already remove the 75.7 min of repeated coder runs. Alternatives:
  - B: a live pass counts at the release gate when the tree ids are the same and the live checkout holds no ignored file. Trade-off: the live checkout always holds `node_modules/`, an ignored directory. The rule almost never applies, and it adds a second proof path.
  - C: the release gate runs only the node commands and trusts the live result of each task command. Trade-off: it saves the remaining task-command runs at release, but a task result then rests on a checkout with ignored files, against `worker-service.impl.md:1490`.
- O2 (T2) — OPEN for Ulrich. Recommendation: keep the reviewer run of every listed command, and build plan 01. The reviewer is the independent check of the coder evidence (`mission-service.md:344`), and plan 01 removes 36.2 min of repeated reviewer runs. Alternatives:
  - B: the reviewer reads the release evidence of the coder for the same commit and runs only the affected tests. Trade-off: it saves 39.5 min more in phase 1. The coder evidence then becomes the only check of the listed commands, and the review loses its independence.
- O3 (C2) — OPEN for Ulrich. Recommendation: state the limit in root `docs/brainstorm/tracking-service.impl.md`: "A revoked or lost execution counts no usage of a turn with no end. The session entry of the reply keeps the usage." The loss is at most one model reply for each revoked or lost execution, $0.0089 in trace `59701b51`. Each other option changes the producer or the summary. Alternatives:
  - B: the tracer keeps the usage at `message_end` and writes it on the `stopped` end of the turn. Trade-off: it fixes a stop and a budget end during a tool call, but not a revocation or a loss, because the gateway refuses those writes.
  - C: the trace summary and the cost analytics add the usage of each assistant session entry whose `agent.turn` span holds no end. Trade-off: it fixes every case, but the usage then has two sources, and the summary must avoid a double count.

The decisions that this set takes are in [decisions.md](decisions.md).
