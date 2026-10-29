# Plan 00: Index

## Scope

This plan set covers the candidate defects K2 to K7 of the worker-routing dogfood run of 2026-10-29. Aelita recorded them in the dogfood notes, the retry report and the time optimization record of root `.dev/worker-routing-dogfood/`. The planner checked each defect against the code at engine `e5a4ffad`, apps `0c424c5` and root `08f65c9`, and against the run databases of `run-p1`.

The set plans these fixes:

- K5: the worker page shows "Credential copy missing" on a server instance. Plan 01 fixes the engine value.
- K7: the worker page disables Archive on an unlisted instance with a live execution. Plan 02 fixes the dashboard.
- K3 and K4: only the first proposal of an assessment can be approved. Plan 03 adds one decision for each assessment in the engine, and plan 04 moves the dashboard to it (decision D6).
- K6: the worker pages ignore the project of `?project=`. Plan 05 fixes the dashboard.

## Defects

- K2 — not planned. RULED (decision D5). The budget end works as the design states. `e02` and `e03` each completed task 1, hit the turn budget in task 2, wrote a checkpoint commit and released with `stop: null` (`src/worker/unit/steps-implement.ts:127-131`, `:144-151`). The design requires `stop: null` when a unit completed (`docs/explanation/coder-worker.md:473`, `:506`; `docs/brainstorm/worker-service.impl.md:1301`). The next execution skipped task 1 by its done record and continued task 2 (`src/worker/unit/steps-implement.ts:847-858`). The first traces paid for task 1 and for the first part of task 2. The checkpoint commit kept that work, and the next execution continued task 2 from it. Trace `73240159` spent $7.79 in 160 turns on task 1 and $3.11 in 40 turns on task 2. Trace `a3ea8159` spent $2.69 in 68 turns on task 1 and $12.10 in 132 turns on task 2. The checkpoint commits held 11 and 42 files. The next executions cost $1.43 and $0.95, with a prepare phase of 0.3 min. The `worker.task` span holds `kanthord.task.result: budget_end`, and `tracking span list` reads it.
- K3 — plan 03. The approval of a fix-node proposal unblocks the proposer into a new attempt (`src/mission/proposal-approve.ts:112-125`). A second approval then fails the check `proposer.state !== NodeState.Blocked || proposer.attempt !== proposal.attempt` with `mission.node.state_conflict` (`:65-69`). The design stated both rules (root `docs/brainstorm/mission-service.impl.md:332`, `:334` at `08f65c9`). Ulrich ruled one decision for each assessment (decision D6). Root pull request #276 holds the new design.
- K4 — plan 03. No execution of an `examine` node reads an earlier attempt (`src/worker/unit/native-method.ts:137-142`; `docs/brainstorm/worker-service.impl.md:1415`). After plan 03, no proposal stays open when the proposer leaves `Blocked`: the decision approves or rejects each one, and an unblock or a discard rejects the open ones.
- K5 — plan 01. `WorkerInstances.list` computes `holder_mismatch` with the instance name as the holder at every placement (`src/worker/instances.ts:536-545`, `src/worker/service.ts:319`). A server instance holds no own copy, so the value is `true`. The design states `false` for a server instance (`docs/brainstorm/worker-service.impl.md:544`).
- K6 — plan 05. The dashboard has no project selector. `ProjectProvider` takes the first project of the project list (apps `src/features/projects/project-context.tsx:23`), and `project.list` orders the projects newest first (engine `src/project/store.ts:176`). The newest project, the scratch project of the gate check, was the current project. The design link `Open workers` opens `/workers?project=<project>` (`docs/brainstorm/architecture.impl.md:1657`, apps `src/features/projects/view/use-project-readiness.ts:219`). `useWorkers` (apps `src/features/workers/catalogue/use-workers.ts:29`) and `useWorkerPage` (apps `src/features/workers/worker/use-worker-page.ts:31`) read `useProjectId()` and ignore `?project=`. Only the Overview and the scheduler board read it, through `useScopedProject`.
- K7 — plan 02. The worker page row passes the live executions to `useInstanceArchive`, and `archiveBlockKindOf` blocks Archive on them (apps `src/features/workers/instance/use-instance-archive.tsx:91-97`, `src/features/workers/worker/components/instance-row-actions.tsx:27-37`). The instance page passes no execution and offers the forced Archive (apps `src/features/workers/instance/instance-screen.tsx:467-472`). The design gives the dialog checkbox `Stop the live execution` to both (`architecture.impl.md:1281-1283`).

## Out of scope

- K2. Decision D5 gives the reason.
- The plan side of K2: the split of a task that needs more than 150 turns (item T4 of the time optimization record). It changes the dogfood plan text, not the engine.
- The items T1, T2, T3, T5 and T6 of the time optimization record.
- The podman storage finding of `project.onboarding.cache_collection_failed`. It is not verified.
- Root design pages. Root pull request #276 holds the design of plans 03 and 04.

## Plans

Each plan is one pull request and ends green. Plans 01, 02 and 03 start at once. Plan 05 starts after plan 02 merges. Plan 04 starts after plan 03 merges.

| Plan | File                                    | Repository                    | Model        | Component                      | Boundary                                                                                                                                                                    | Defect |
| ---- | --------------------------------------- | ----------------------------- | ------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 01   | `01-holder-mismatch-server-instance.md` | `kanthorlabs/kanthord-engine` | Sonnet, high | Worker Service — instance list | `holder_mismatch` of `worker.instance.list` is `false` at the `server` and the `container` placement; one test; one CLI page line.                                          | K5     |
| 02   | `02-worker-page-forced-archive.md`      | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — worker page        | Archive of a worker page row blocks on a listing binding alone; the dialog offers `Stop the live execution`; the orphan props go.                                           | K7     |
| 03   | `03-proposal-decision.md`               | `kanthorlabs/kanthord-engine` | Opus, medium | Mission Service — proposals    | `mission.proposal.decide` replaces `mission.proposal.approve`; `rejected_at`; the rejection at unblock and discard; the act, the CLI, the OpenAPI document and `docs/cli/`. | K3, K4 |
| 04   | `04-dashboard-proposal-decision.md`     | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — fix proposals      | `decideProposals`; one `Decide` dialog with a checkbox for each open proposal on the node sheet and on the Overview; the badges `open`, `approved`, `rejected`; `mock/`.    | K3, K4 |
| 05   | `05-workers-project-scope.md`           | `kanthorlabs/kanthord-apps`   | Sonnet, high | Dashboard — worker pages       | `/workers` and the worker page read `?project=` and fall back to the current project; the links to a worker page keep it.                                                   | K6     |

**Rationale for order.**
Plans 01, 02 and 03 touch separate files, so they start at once. Plan 03 waits only for the approval of root pull request #276, its design source (decision D7). Plan 04 needs the contract of plan 03 in engine `main`, because its API types follow the OpenAPI document. Plan 05 waits for plan 02, because both edit `use-worker-page.ts`.

## Follow-up after plan 03

Root `docs/reference/workbench/tools.md` is generated from the engine operations. After plan 03 merges, the root moves its `engine` pointer and runs `make docs-tools`, so the table lists `mission--proposal--decide` and no `mission--proposal--approve`.

## Repositories, branches and worktrees

Create each worktree from `origin/main` of its repository. The worktree directory `.dev/<name>` matches the branch `<type>/<name>`. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (root `CLAUDE.local.md` "Commits"). When a repository rule refuses a push, stop and report it.

| Plan | Repository root | Worktree                                      | Branch                                | Command                                                                                                                                                                 |
| ---- | --------------- | --------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `engine/`       | `engine/.dev/holder-mismatch-server-instance` | `fix/holder-mismatch-server-instance` | `git -C engine fetch origin && git -C engine worktree add -b fix/holder-mismatch-server-instance .dev/holder-mismatch-server-instance origin/main`, then `pnpm install` |
| 02   | `apps/`         | `apps/.dev/worker-page-forced-archive`        | `fix/worker-page-forced-archive`      | `git -C apps fetch origin && git -C apps worktree add -b fix/worker-page-forced-archive .dev/worker-page-forced-archive origin/main`, then `pnpm install`               |
| 03   | `engine/`       | `engine/.dev/proposal-decision`               | `feat/proposal-decision`              | `git -C engine fetch origin && git -C engine worktree add -b feat/proposal-decision .dev/proposal-decision origin/main`, then `pnpm install`                            |
| 04   | `apps/`         | `apps/.dev/proposal-decision`                 | `feat/proposal-decision`              | `git -C apps fetch origin && git -C apps worktree add -b feat/proposal-decision .dev/proposal-decision origin/main`, then `pnpm install`                                |
| 05   | `apps/`         | `apps/.dev/workers-project-scope`             | `fix/workers-project-scope`           | `git -C apps fetch origin && git -C apps worktree add -b fix/workers-project-scope .dev/workers-project-scope origin/main`, then `pnpm install`                         |

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

| Plan | Gate                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing; `pnpm exec prettier --check docs/cli/worker.md`; the new test of task 01.1 failed before task 01.2 and passes after it.                                                                                                                                                                                                      |
| 02   | `pnpm verify` in `apps/`; `rg -n 'executing' src/features/workers/instance/use-instance-archive.tsx` prints nothing; `rg -n 'liveExecutionsOf' src/features/workers/worker` prints nothing; the new tests of task 02.1 failed before task 02.2 and pass after it; the browser check of task 02.E at 1280 by 800 and at 390 by 844.                                                                                                                          |
| 03   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing after the commit of task 03.8; `pnpm exec prettier --check docs/cli/mission.md docs/cli/worker.md`; `rg -n 'proposal\.approve\|proposalApprove\|ProposalApprove\|already_approved\|ApproveProposal\|proposal approve' src static docs/cli` prints nothing; the test of task 03.1 failed before task 03.4 and passes after it. |
| 04   | `pnpm verify` in `apps/`; `rg -n 'approveProposal\|ProposalApprove\|use-proposal-approve\|proposal-approve-dialog\|already_approved' src mock` prints nothing; the tests of task 04.1 failed before task 04.5 and pass after it; the type check of task 04.2 step 5; the browser check of task 04.E at 1280 by 800 and at 390 by 844.                                                                                                                       |
| 05   | `pnpm verify` in `apps/`; `rg -n 'useProjectId' src/features/workers --glob '!*.test.*'` prints nothing; the tests of task 05.1 failed before task 05.2 and pass after it; the browser check of task 05.E at 1280 by 800 and at 390 by 844.                                                                                                                                                                                                                 |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>`, `docs/reference/<page>:<line>` or `docs/explanation/<page>:<line>` of the root repository at `08f65c9`. Plans 03 and 04 cite the pages of root pull request #276 by section (decision D7).
- An engine citation names a path under the engine root at `e5a4ffad`.
- An apps citation names a path under the apps root at `0c424c5`.
- When `main` moved before the plan starts, re-anchor each citation to the sentence or code block that the text means (`engine/AGENTS.md:53-55`).

## Rulings

- O1 (K2) — RULED 2026-10-29 by Ulrich: option A, the budget end in the run report. Aelita did it outside this set. No plan (decision D5).
- O2 (K3 and K4) — RULED 2026-10-29 by Ulrich: option B, one decision for each assessment. Root pull request #276 holds the design, and plans 03 and 04 implement it (decisions D6 and D7).

The decisions that this set takes are in [decisions.md](decisions.md).
