# Plan 00: Index

## Scope

This plan set implements the flat-node model of the Mission Service that Ulrich ruled on 2026-10-17 (`docs/brainstorm/HANDOFF.md:36`). The design pages of the root pull request #87 (branch `design/flat-nodes`, head `1283c7f`) are the rule. The set covers:

- Tasks as content of a node, with `task_<ulid>` identities and no `mission_node` row (`docs/brainstorm/mission-service.md:39-45`, `mission-service.impl.md:17`).
- One node kind: a node holds `work` (`change` or `report`) and `requires` (`mission-service.md:27-37`). No containment, no `parent_id`, no `node move`, no ancestor closure, no wait edges, no initiative steps condition (`mission-service.md:47-68`, `:502-508`).
- The `report` reads of the direct dependencies, `dependency_outcome_ids`, the fix-node proposal and the `mission.execution.dependency.*` reads (`mission-service.md:222-226`, `mission-service.impl.md:258-308`).
- The binding resolution by work with the fallback to the one project binding (`mission-service.md:72-88`, `mission-service.impl.md:49-61`).
- The match of the Scheduler Service: `declared_works`, binding `traits`, `admits`, `unmatchedClaims` and the two coverage refusals (`scheduler-service.md:233-268`, `scheduler-service.impl.md:149-188`, `project-service.md:99-110`).
- The worker methods by work (`worker-service.md:39-40`, `worker-service.impl.md:54-56`).
- The E2E proof against the todoapp plan (`docs/brainstorm/assets/todoapp/`).
- The dashboard (`apps`) and the root reference, explanation and how-to pages.

The decisions D1 to D27 that the plans cite are in [decisions.md](decisions.md).

## Out of scope

- Every alternative that `proposal-v2.md` section 6 closed with `action:NO`: labels, exclusive bindings, a model tier field, node concurrency, trait probes and dependency reads for a `change` node.
- A data migration, a legacy read mapping, a quiescence check and an upgrade report (RULED 2026-10-17, decision D2).
- The open HANDOFF items, also `HANDOFF.md:80` (a node names a worker binding). A task implements the page as written and states a gap in one line (decision D1).
- The Scheduler eligibility report and the on-demand request. Neither exists in code (`src/apps/cli/completeness.test.ts:38-41`, `docs/cli/scheduler.md:559-563`). The plans change their documentation only (decision D23).
- The executed plan sets `erd-01-setup/`, `erd-02-execution/` and `erd-03-integration/`. They stay as a record.
- A live run against a real provider inside `pnpm run verify`. Plan 08 runs `make e2e` by hand as the acceptance step.

## Plans

The plans are numbered in implementation order. Each plan is one pull request and ends green. A plan starts only after its predecessor merges to `main` of its repository.

| Plan | File                             | Repository                    | Component                           | Boundary                                                                                                                                                                                                                                                                                                                                                      |
| ---- | -------------------------------- | ----------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `01-tasks-as-content.md`         | `kanthorlabs/kanthord-engine` | Mission Service — tasks             | No task row in `mission_node`; `task_<ulid>`; tasks written through the node API writes of their owner and through the import; `mission.node.priority_task`, `mission.node.control_task` and the task endpoint reason go away. Initiatives and objectives stay.                                                                                               |
| 02   | `02-report-dependency-reads.md`  | `kanthorlabs/kanthord-engine` | Mission and Worker — report         | The closure is the direct dependencies; readiness reads the closure alone; no ancestor closure, no wait edges, no child readiness rule. The initiative (the later `report` node) reads its direct dependencies: `dependency_outcome_ids`, `mission.execution.dependency.*`, the fix-node proposal fields, the evidence delete scope and the prompt variables. |
| 03   | `03-flat-nodes.md`               | `kanthorlabs/kanthord-engine` | Mission Service — flat nodes        | No `kind`, no `parent_id`, no containment edge, no `node move`; `work` and `requires` on each revision; the node file and task file grammar; the binding rule table by work with the project-binding fallback; `mission.node.work_locked`; `node list --work`; the worker unit selects its method form by `work`.                                             |
| 04   | `04-worker-methods-by-work.md`   | `kanthorlabs/kanthord-engine` | Worker Service — method names       | A refactor with no behavior change: `steps-objective` becomes `steps-change`, `steps-initiative` becomes `steps-report`, the workspace keys and symbols name the node, and `engine/AGENTS.md` follows.                                                                                                                                                        |
| 05   | `05-match-and-coverage.md`       | `kanthorlabs/kanthord-engine` | Scheduler, Worker, Project, Mission | `declared_works` without `required_node_format`; binding `traits` with `project.bindings.worker.traits_invalid`; `claimFacts`, `claimFactsOf`, `admits`, `unmatchedClaims`; the unknown worker answers no work; `mission.node.requires_unmatched` and `project.bindings.worker.node_unmatched`.                                                               |
| 06   | `06-todoapp-e2e.md`              | `kanthorlabs/kanthord-engine` | Gateway composition — E2E           | A byte copy of the 25 todoapp plan files and one E2E journey that runs the planning checks and the dependency order of `kanthord-checks.md` through the CLI.                                                                                                                                                                                                  |
| 07   | `07-dashboard.md`                | `kanthorlabs/kanthord-apps`   | Dashboard                           | `src/api/types.ts`, the flat mission graph without bands, the `Tasks (<count>)` section, the work and trait match of the "no taker" view, the traits field of a worker binding, the proposal copy, `mock/`.                                                                                                                                                   |
| 08   | `08-root-docs-and-acceptance.md` | `kanthorlabs/kanthord` (root) | Reference, explanation, scripts     | `docs/reference/` with the ERD pages, `docs/explanation/`, `docs/how-to-guides/run-on-a-mac-with-tailscale.md`, `docs/README.md:27`, `scripts/e2e/watch.mjs`, the fixture sync check, the HANDOFF item, the submodule pointers, the database discard and the live `make e2e` acceptance.                                                                      |

**Rationale for order.**
Plan 01 removes the task rows first, because every later plan reads a node row as a schedulable node. The old grammar (`kind: task`, `parent:`) still maps onto content, so the product stays usable.
Plan 02 moves every semantic that reads children onto the direct dependencies while containment still exists, so plan 03 deletes containment with no reader left.
Plan 03 deletes the kinds and the containment and adds `work` and `requires`. The worker unit switches from the `tasks` inference to `work` in the same plan, because `nodeKindOf` reads a field that plan 03 removes.
Plan 04 is a pure rename. It follows plan 03 so that its diff holds no semantic change.
Plan 05 needs `work` and `requires` on the revision (plan 03) before the claim walk can read them.
Plan 06 needs the final engine contract of plan 05, because the todoapp import needs covering worker bindings.
Plan 07 follows the engine contract of plan 05. It runs in parallel with plan 06.
Plan 08 needs the merged pull request #87, the merged plans 06 and 07, and the regenerated workbench tool table of the final engine.

An initiative and an objective still exist after plans 01 and 02, and plan 03 removes both. The live `make e2e` run of the root checkout fails from the merge of pull request #87 until plan 08 moves the engine pointer, because the root fixture uses the new grammar and the engine accepts it only from plan 03 on (decision D3).

## Repositories, branches and worktrees

Create each worktree from `origin/main` of its repository after the predecessor merges. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (`CLAUDE.local.md` "Commits").

| Plan | Repository root | Worktree                    | Branch                            | Command                                                                                                  |
| ---- | --------------- | --------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 01   | `engine/`       | `engine/.dev/flat-nodes-01` | `feat/flat-nodes-01-tasks`        | `git -C engine worktree add -b feat/flat-nodes-01-tasks .dev/flat-nodes-01 origin/main`                  |
| 02   | `engine/`       | `engine/.dev/flat-nodes-02` | `feat/flat-nodes-02-report-reads` | `git -C engine worktree add -b feat/flat-nodes-02-report-reads .dev/flat-nodes-02 origin/main`           |
| 03   | `engine/`       | `engine/.dev/flat-nodes-03` | `feat/flat-nodes-03-flat`         | `git -C engine worktree add -b feat/flat-nodes-03-flat .dev/flat-nodes-03 origin/main`                   |
| 04   | `engine/`       | `engine/.dev/flat-nodes-04` | `refactor/flat-nodes-04-methods`  | `git -C engine worktree add -b refactor/flat-nodes-04-methods .dev/flat-nodes-04 origin/main`            |
| 05   | `engine/`       | `engine/.dev/flat-nodes-05` | `feat/flat-nodes-05-match`        | `git -C engine worktree add -b feat/flat-nodes-05-match .dev/flat-nodes-05 origin/main`                  |
| 06   | `engine/`       | `engine/.dev/flat-nodes-06` | `test/flat-nodes-06-todoapp`      | `git -C engine worktree add -b test/flat-nodes-06-todoapp .dev/flat-nodes-06 origin/main`                |
| 07   | `apps/`         | `apps/.dev/flat-nodes-07`   | `feat/flat-nodes-07-dashboard`    | `git -C apps worktree add -b feat/flat-nodes-07-dashboard .dev/flat-nodes-07 origin/main`                |
| 08   | root            | `.dev/flat-nodes-08`        | `docs/flat-nodes-08-reference`    | `git worktree add -b docs/flat-nodes-08-reference .dev/flat-nodes-08 origin/main`, then `make bootstrap` |

An engine worktree runs `pnpm install --frozen-lockfile` and `pnpm run pi-tools:fetch` before its first check (`engine/AGENTS.md:317-318`). An apps worktree runs `pnpm install`.

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

| Plan | Gate                                                                                                                                                                                                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing; `pnpm exec prettier --check docs/cli/mission.md docs/cli/scheduler.md`; `rg -n 'priority_task\|control_task\|NodeKind\.Task\|task_endpoint' src static docs/cli` prints nothing.                            |
| 02   | `pnpm run verify`; the OpenAPI row of plan 01; `pnpm exec prettier --check docs/cli/*.md`; `rg -n 'child_outcome\|child_node_ids\|objective_node_id\|objective_id\|execution\.objective\|objectives_not_terminal\|waitEdges' src static docs/cli` prints nothing.                                                                          |
| 03   | `pnpm run verify`; the OpenAPI row of plan 01; `pnpm exec prettier --check docs/cli/*.md`; `rg -n -i 'NodeKind\|EdgeKind\|parent_id\|containment\|node\.move\|kind_changed\|create_refused' src static docs/cli` prints nothing; `rg -n -i 'initiative\|objective' src/mission static/openapi/mission docs/cli/mission.md` prints nothing. |
| 04   | `pnpm run verify`; `rg -n -i 'initiative\|objective' src/worker AGENTS.md static/prompt` prints nothing; `git diff --stat origin/main -- static` prints nothing.                                                                                                                                                                           |
| 05   | `pnpm run verify`; the OpenAPI row of plan 01; `pnpm exec prettier --check docs/cli/*.md`; `rg -n 'required_node_format\|requiredNodeFormat\|NodeFormatField\|REQUIRED_NODE_FORMAT' src static docs/cli` prints nothing.                                                                                                                   |
| 06   | `pnpm run verify`; `node --test --test-timeout=60000 src/apps/server/e2e-todoapp-plan.test.ts` passes; the copy check of task 06.1 prints nothing.                                                                                                                                                                                         |
| 07   | `pnpm verify` in `apps/`; `rg -n -i 'initiative\|objective\|required_node_format\|child_outcome\|child_node\|parent_id\|containment' src mock` prints nothing; a browser check of the mission graph and the "no taker" view against `pnpm dev:all` at phone and desktop width (root `AGENTS.md:173-174`).                                  |
| 08   | `sh scripts/docs/check.sh`; `node --test scripts/e2e/*.test.mjs`; `rg -n -i 'initiative\|objective' docs/reference docs/explanation docs/how-to-guides docs/README.md` prints nothing; `make e2e` reaches `Completed` on `foundation.md` and reports `RESULT pass` from `make e2e-check`.                                                  |

## Ownership of shared files

| File                                                                                             | Owner plans                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `src/mission/migrations.ts`, `src/apps/server/migrations.test.ts`                                | 01 (`state`, `attempt` not null), 02 (column renames), 03 (`kind`, `parent_id`, `work`, `requires`, `tasks`)      |
| `src/mission/contract.ts`                                                                        | 01, 02, 03, 05 (`claimFacts`, `claimFactsOf`, the unmatched-claims dependency, `RequiresUnmatched`)               |
| `src/mission/service.ts`                                                                         | 01 (priority handler), 02 (execution reads), 03 (node move, edge and node list), 05 (coverage guard, claim facts) |
| `src/scheduler/contract.ts`, `claim.ts`, `service.ts`                                            | 05                                                                                                                |
| `src/project/contract.ts`, `service.ts`, `store.ts`                                              | 03 (`projectBindingsOf`), 05 (`traits`, coverage guard)                                                           |
| `src/worker/catalog.ts`, `src/worker/contract.ts`                                                | 05                                                                                                                |
| `src/worker/unit/*`                                                                              | 01 (task identity fixtures), 02 (dependency reads, prompts), 03 (method selection by work), 04 (renames)          |
| `static/prompt/template/report.md`, `evaluation.md`                                              | 02                                                                                                                |
| `src/apps/server/index.ts`                                                                       | 03 (`projectBindingsOf` wiring), 05 (match wiring)                                                                |
| `src/apps/server/test-support.ts`, `journey-support.ts`, `delivery-support.ts`, `cli-support.ts` | 01, 02, 03, 05                                                                                                    |
| `src/apps/server/openapi-integration.test.ts`, `static/openapi.yaml`, `static/openapi/**`        | Each plan that changes an operation regenerates in its OpenAPI task (`engine/AGENTS.md:454-463`)                  |
| `src/apps/cli/mission.ts`, `mission-execution.ts`, `mission-proposal.ts`                         | 01, 02, 03                                                                                                        |
| `docs/cli/mission.md`                                                                            | 01, 02, 03, 05                                                                                                    |
| `docs/cli/scheduler.md`                                                                          | 01, 02, 03, 05                                                                                                    |
| `docs/cli/worker.md`, `docs/cli/project.md`                                                      | 02 (proposal fields of `worker.md`), 05                                                                           |
| `AGENTS.md` (engine)                                                                             | 03 (`node-move.ts`, `graph.ts`, `edge-read.ts` rows), 04 (method rows) — main session (decision D20)              |

## Seams

Every seam below is a Kind 2 collaboration (`docs/brainstorm/architecture.impl.md:676-692`). A collaboration takes the caller's `tx`, opens no transaction and commits none. The consumer declares the type inline in its own `contract.ts` (`erd-02-execution/00-index.md` "Collaboration-type contract rule").

| Seam                                 | Signature                                                                                                                                                    | Owner     | Plan |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | ---- |
| `MissionBindings.projectBindingsOf`  | `(tx, projectId: string, kind: "repository" \| "storage"): { binding_id: string }[]` — the latest revision of each binding of that kind that is no tombstone | Project   | 03   |
| `MissionCollaborations.claimFacts`   | `(tx, nodeId: string): { work: Work; requires: string[] } \| null` — at the revision that the open attempt pins, else the current revision                   | Mission   | 05   |
| `MissionCollaborations.claimFactsOf` | `(tx, projectId: string): { node_id: string; revision: number; work: Work; requires: string[]; claims: ClaimableState[] }[]`                                 | Mission   | 05   |
| `ProjectBindings.workerBindingsOf`   | `(tx, projectId: string \| null)` — the existing rows of `src/project/service.ts:1201-1225` plus `traits: string[]` (decision D13)                           | Project   | 05   |
| `ProjectBindings.workerBindingOf`    | the existing answer plus `traits: string[]`                                                                                                                  | Project   | 05   |
| `WorkerDeclarations.declarationOf`   | `(workerName: string): { declared_node_states; declared_works; resource_budget; … } \| null`                                                                 | Worker    | 05   |
| `SchedulerMatch.unmatchedClaims`     | `(tx, projectId: string): { node_id: string; revision: number; claim: ClaimableState }[]`                                                                    | Scheduler | 05   |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>` of the root repository at `1283c7f`. After pull request #87 merges, the same lines hold on root `main`.
- An engine citation names a path under the engine root at `54380cd9` (`origin/main` when this set was written). A later plan re-anchors only the lines that an earlier plan of this set shifted (`engine/AGENTS.md:477-479`).
- An apps citation names a path under `apps/`. A root citation names a path under the root repository.

## Error codes

| Status  | Code                                                                                                                                                                                                                                                                    | HTTP  | Condition                                                                                        | Plan                                        |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| new     | `mission.node.work_locked`                                                                                                                                                                                                                                              | 409   | A write changes `work` of a node whose attempt reads 1 or more (`mission-service.impl.md:64`).   | 03                                          |
| new     | `mission.node.requires_unmatched`                                                                                                                                                                                                                                       | 409   | A node write adds an unmatched pair (`mission-service.impl.md:65`).                              | 05                                          |
| new     | `project.bindings.worker.traits_invalid`                                                                                                                                                                                                                                | 400   | A trait list is no list, repeats a key or holds a malformed key (`project-service.impl.md:172`). | 05                                          |
| new     | `project.bindings.worker.node_unmatched`                                                                                                                                                                                                                                | 409   | A binding-set write adds an unmatched pair (`project-service.impl.md:133`).                      | 05                                          |
| new     | `cli.mission.node.list.invalid_work`                                                                                                                                                                                                                                    | local | The `--work` value is not `change` or `report`.                                                  | 03                                          |
| renamed | `cli.mission.execution.dependency.{list,outcome.list,evidence.list}.invalid_execution_id`                                                                                                                                                                               | local | Replaces the `execution.objective.*` codes (`mission-service.impl.md:864-866`).                  | 02                                          |
| removed | `mission.node.priority_task`, `mission.node.control_task`, `scheduler.eligibility.node_task`                                                                                                                                                                            | —     | No task is a node.                                                                               | 01                                          |
| removed | `mission.node.create_refused`, `mission.import.kind_changed`, `cli.mission.node.move.invalid_node_id`, `cli.mission.node.list.invalid_kind`, `cli.mission.node.list.kind_state_conflict`, `cli.mission.node.list.invalid_node_id`, `cli.mission.edge.list.invalid_kind` | —     | No kind, no parent, no move, no edge kind.                                                       | 01 (`kind_state_conflict`), 03 (the others) |

Every new code stands on its design page already. Each plan writes its codes into the error table of its `docs/cli/` page in the same pull request (decision D22).

## Blockers

None at authoring time. The gaps of the design pages are in [decisions.md](decisions.md) D9, D10, D11, D12, D24, D25, D26 and D27. Each one carries a decision, so no plan waits for a ruling. A task that meets a new gap writes one `DEBATE:` line in its report, and the main session brings it to Ulrich as one open item.
