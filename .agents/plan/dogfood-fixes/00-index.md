# Plan 00: Index

## Scope

This plan set covers the candidate defects K2 to K7 of the worker-routing dogfood run of 2026-10-29. Aelita recorded them in the dogfood notes, the retry report and the time optimization record of root `.dev/worker-routing-dogfood/`. The planner checked each defect against the code at engine `e5a4ffad`, apps `0c424c5` and root `08f65c9`, and against the run databases of `run-p1`.

Two defects are real and fit the design. The set plans them:

- K5: the worker page shows "Credential copy missing" on a server instance. Plan 01 fixes the engine value.
- K7: the worker page disables Archive on an unlisted instance with a live execution. Plan 02 fixes the dashboard.

## Defects

- K2 — not planned. The budget end works as the design states. `e02` and `e03` each completed task 1, hit the turn budget in task 2, wrote a checkpoint commit and released with `stop: null` (`src/worker/unit/steps-implement.ts:127-131`, `:144-151`). The design requires `stop: null` when a unit completed (`docs/explanation/coder-worker.md:473`, `:506`). The next execution skipped task 1 by its done record and continued task 2 (`src/worker/unit/steps-implement.ts:847-858`). The spans of `run-p1` prove it: trace `67f91e32` runs task 2 only and costs $1.43; trace `34464928` runs task 2 only and costs $0.95. The $10.91 and $14.79 of the first traces paid for the completed task 1, not for lost work. The `worker.task` span holds `kanthord.task.result: budget_end`, and `tracking span list` reads it. No node read and no execution record holds the budget end. That needs a design change: open item O1.
- K3 — not planned. The approval of a fix-node proposal unblocks the proposer into a new attempt (`src/mission/proposal-approve.ts:112-125`). A second approval then fails the check `proposer.state !== NodeState.Blocked || proposer.attempt !== proposal.attempt` with `mission.node.state_conflict` (`:65-69`). The design states both rules (`docs/brainstorm/mission-service.impl.md:332`, `:334`; root `docs/reference/mission/assessment.md:40`). The fix needs a design change: open item O2.
- K4 — not planned. No execution of an `examine` node reads an earlier attempt. `readPrior` runs only for an `implement` node (`src/worker/unit/native-method.ts:137-142`), and the design scopes the unblock reads to the steps method of an `implement` node (`docs/brainstorm/worker-service.impl.md:1415`). The design also treats an unblock as the rejection of an open proposal (`mission-service.impl.md:335`). K4 follows from K3: open item O2.
- K5 — plan 01. `WorkerInstances.list` computes `holder_mismatch` with the instance name as the holder at every placement (`src/worker/instances.ts:536-545`, `src/worker/service.ts:319`). A server instance holds no own copy, so the value is `true`. The design states `false` for a server instance (`docs/brainstorm/worker-service.impl.md:544`).
- K6 — not planned, not a defect. The Bindings section reads the bindings of the current project only (apps `src/features/workers/worker/use-worker-page.ts:44-50`) and keys each row by `binding.id` (apps `src/features/workers/worker/worker-screen.tsx:385`). The design asks for the bindings "in the current project" (`docs/brainstorm/architecture.impl.md:1255`). The dashboard of the gate check had the scratch project selected, so it showed the scratch binding `coder` alone.
- K7 — plan 02. The worker page row passes the live executions to `useInstanceArchive`, and `archiveBlockKindOf` blocks Archive on them (apps `src/features/workers/instance/use-instance-archive.tsx:91-97`, `src/features/workers/worker/components/instance-row-actions.tsx:27-37`). The instance page passes no execution and offers the forced Archive (apps `src/features/workers/instance/instance-screen.tsx:467-472`). The design gives the dialog checkbox `Stop the live execution` to both (`architecture.impl.md:1281-1283`).

## Out of scope

- K2, K3, K4 and K6. The section "Defects" gives the reason of each.
- The plan side of K2: the split of a task that needs more than 150 turns (item T4 of the time optimization record). It changes the dogfood plan text, not the engine.
- The items T1, T2, T3, T5 and T6 of the time optimization record.
- The podman storage finding of `project.onboarding.cache_collection_failed`. It is not verified.
- Root `docs/`. No design page changes in this set.

## Plans

Plans 01 and 02 are independent and run in parallel. Each plan is one pull request and ends green.

| Plan | File                                    | Repository                    | Model        | Component                      | Boundary                                                                                                                           | Defect |
| ---- | --------------------------------------- | ----------------------------- | ------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 01   | `01-holder-mismatch-server-instance.md` | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker Service — instance list | `holder_mismatch` of `worker.instance.list` is `false` at the `server` and the `container` placement; one test; one CLI page line. | K5     |
| 02   | `02-worker-page-forced-archive.md`      | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — worker page        | Archive of a worker page row blocks on a listing binding alone; the dialog offers `Stop the live execution`; the orphan props go.  | K7     |

**Rationale for order.**
Plan 01 changes one value of one engine read. Plan 02 changes one dashboard hook and its row. No file, seam or API shape overlaps, so the two plans start at once. Plan 02 needs no engine change, because the instance page and the mock daemon already serve the forced archive.

## Repositories, branches and worktrees

Create each worktree from `origin/main` of its repository. The worktree directory `.dev/<name>` matches the branch `<type>/<name>`. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (root `CLAUDE.local.md` "Commits"). When a repository rule refuses a push, stop and report it.

| Plan | Repository root | Worktree                                      | Branch                                | Command                                                                                                                                                                 |
| ---- | --------------- | --------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `engine/`       | `engine/.dev/holder-mismatch-server-instance` | `fix/holder-mismatch-server-instance` | `git -C engine fetch origin && git -C engine worktree add -b fix/holder-mismatch-server-instance .dev/holder-mismatch-server-instance origin/main`, then `pnpm install` |
| 02   | `apps/`         | `apps/.dev/worker-page-forced-archive`        | `fix/worker-page-forced-archive`      | `git -C apps fetch origin && git -C apps worktree add -b fix/worker-page-forced-archive .dev/worker-page-forced-archive origin/main`, then `pnpm install`               |

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

| Plan | Gate                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing; `pnpm exec prettier --check docs/cli/worker.md`; the new test of task 01.1 failed before task 01.2 and passes after it.      |
| 02   | `pnpm verify` in `apps/`; `rg -n 'executing' src/features/workers/instance/use-instance-archive.tsx` prints nothing; the new tests of task 02.1 failed before task 02.2 and pass after it; the browser check of task 02.E at 1280 by 800 and at 390 by 844. |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>` or `docs/reference/<page>:<line>` of the root repository at `08f65c9`.
- An engine citation names a path under the engine root at `e5a4ffad`.
- An apps citation names a path under the apps root at `0c424c5`.
- When `main` moved before the plan starts, re-anchor each citation to the sentence or code block that the text means (`engine/AGENTS.md:53-55`).

## Open items for Ulrich

- O1 (K2) — visible budget end on the node. Aelita wants option A: the run report reads the `worker.task` spans of each trace with `tracking span list` and prints each `kanthord.task.result: budget_end`. It needs no engine change and no design change. The other options:
  - B: the release body adds a `budget_end` field, and the Scheduler writes it on the root span and on the execution record. It changes the release API, the ERD page and `docs/reference/scheduler/execution.md`.
  - C: every budget end releases with the stop `budget_end`, and only a release with no completed unit counts toward `mission.further_work_limit`. It changes the stop rule of `docs/explanation/coder-worker.md:473` and the stop meaning of every reader.
- O2 (K3 and K4) — approval of every proposal of one assessment. An assessment holds up to 10 proposals (`mission-service.impl.md:283`), but only the first approval succeeds. Aelita wants option A: a proposal approval also accepts a proposer that is `Pending` in the attempt that the approval of a sibling proposal of the same assessment opened. The approval then creates the fix node and the dependency and runs no second unblock. It changes `mission-service.impl.md:332-334` and root `docs/reference/mission/assessment.md:40`, and it makes K4 moot. The other options:
  - B: `proposal approve` takes a list of proposal identities of one assessment and runs one unblock. It changes the operation shape, the CLI and the dashboard.
  - C: the evaluation of an `examine` node reads the open proposals of the cleared attempt. It adds a read and a prompt part, and it contradicts the rule that an unblock rejects an open proposal (`mission-service.impl.md:335`).

The decisions that this set takes are in [decisions.md](decisions.md).
