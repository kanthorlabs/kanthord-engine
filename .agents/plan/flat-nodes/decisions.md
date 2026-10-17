# Flat-node plan decisions

The plans cite these decisions as D1 to D29. Each decision binds every plan and every task of this set. A decision records only what the design pages of pull request #87 leave open. A retired decision keeps its identifier and names the page line that now holds the rule.

## D1 — Source and gaps

The design pages at the head of pull request #87, root `5fa6db3`, are the rule. A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. The main session brings it to Ulrich as one open item. Cross-plan alignment, a split of a task and a one-line fix are plan work, never a gap.

## D2 — Schema in place and the database discard

RULED 2026-10-17 by Ulrich: kanthord is not deployed, so the refactor keeps no backward compatibility.

- Edit the migration functions of `src/mission/migrations.ts` in place. This overrides `engine/AGENTS.md:421-422` ("Never edit a published migration") for this set alone.
- Keep the four entries of `missionMigrations` and their order (`src/mission/migrations.ts:136-141`). Add no migration.
- Write no data migration and no legacy read mapping. No input accepts a `node_` task identity.
- After each engine plan merges, a developer runs `make cleanup`, then `make bootstrap` and `make dev` (`scripts/engine/cleanup.sh`). Plan 08 discards the homelab volume.

## D3 — Layer order

The order of `00-index.md` "Plans" binds. Plans 01 and 02 ship an intermediate model: initiatives and objectives exist, tasks are content, and the initiative reads its direct dependencies and its own repository bindings. That model is green and usable through the CLI. No plan adds code that a later plan of the set deletes, except the `kind`-keyed branches that plan 03 replaces by `work`-keyed branches.

RULED 2026-10-17 by Ulrich (R14): pull request #87 stays open until plan 08. Task 08.1 rebases it on root `main`, merges it after review, and then moves the `engine` and `apps` pointers. Plan 06 copies the fixture from the head of pull request #87. No live `make e2e` runs on the new fixture before plan 08.

## D4 — Content, task body and the node read

- `Content` holds `name`, `requirement`, `criterion`, `verifications`, `bindings`, `work` and `requires` (plan 03). Before plan 03 it holds the first five.
- `TaskBody` holds `name`, `requirement`, `criterion`, `verifications` and `bindings`. `bindings` is `[]`; another list answers `mission.node.bindings_invalid` (`mission-service.impl.md:54`).
- `TaskContent` holds `id: TaskId`, `filename: PlanFileName` and `content: TaskBody`.
- `Revision.tasks` is a required list that accepts `[]` on every write path (`mission-service.impl.md:42`). An `examine` node and, before plan 03, an initiative hold `[]`. An `implement` node with `[]` is its own single work unit (`mission-service.md:45-46`).
- The node read `Node` holds `work` and `requires` at the claim revision (`mission-service.impl.md:495`), and `tasks: TaskContent[]` of that revision (`mission-service.impl.md:496`).
- `NodeCreate`, `NodeUpdate` and `UnblockChange` hold a required `tasks: TaskWrite[]` that accepts `[]`. `TaskWrite` holds an optional `id: TaskId`, `filename` and `content: TaskBody`.
  - On `NodeCreate` a `TaskWrite` with an `id` answers `mission.node.content_invalid`. The service mints `task_<ulid>` for each task.
  - On `NodeUpdate` and `UnblockChange` a `TaskWrite` without an `id` creates a task with a minted identity. An `id` names a current task of the same node, else the write answers `mission.node.content_invalid` (`mission-service.impl.md:69`). A current task that the list omits is removed with `change: retired` (`mission-service.impl.md:617`).
  - The node API never moves a task. Only an import moves a task (`mission-service.md:187`).

## D5 — Task identity

- `TASK_IDENTITY_PREFIX = "task"` in `src/mission/contract.ts`. `identitySchema("task")` validates a task identity.
- `readLastTaskSnapshot` (`src/mission/store.ts:279-293`) becomes `taskOwnerOf(tx, missionId, taskId): { node_id; revision } | null`. It reads the latest revision of any node of the mission that holds the task in `tasks`. The import answers `mission.import.retired_id` for a task identity whose owner revision no longer holds it (`mission-service.impl.md:205`).
- A plan file `id` with the prefix of the other file form answers `mission.import.plan_invalid` (`mission-service.impl.md:147`). Before plan 03 the form is `kind: task`; from plan 03 on it is `node:`.

## D6 — Edge shape

`Edge` is `{ dependent_id: NodeId, depends_on_id: NodeId }` with no `kind` field from plan 03 on. `edge list` takes no `kind` query and the CLI takes no `--kind`. `NodeChange.added_edges`, `removed_edges` and `RetirePreview.removed_edges` use the same shape.

## D7 — Import and export entries

`ImportEntry` and `ExportEntry` are a union of two strict objects, from plan 03 on:

- A node entry: `filename`, `id?`, `work`, `name`, `requirement`, `criterion`, `verifications`, `bindings`, `requires?`, `depends_on?`.
- A task entry: `filename`, `id?`, `node`, `name`, `requirement`, `criterion`, `verifications`, `bindings`.

An export entry requires `id`. A Markdown export writes `requires` on every node file, also `requires: []`, as the vocabulary example does (`mission-service.vocabulary.md:606-666`).

## D8 — Removed codes and fields

- Plan 01 removes `mission.node.priority_task` (`src/mission/contract.ts:265`), `mission.node.control_task` (`ControlError.Task`, `src/mission/control.ts:38-43`), the endpoint reason `task_endpoint` (`src/mission/dependency.ts:34-37`), `cli.mission.node.list.kind_state_conflict` (`src/apps/cli/mission.ts:112`) and the documentation row `scheduler.eligibility.node_task` (`docs/cli/scheduler.md:595`).
- Plan 03 removes `mission.node.create_refused`, `mission.import.kind_changed`, `RevisionWrite.NodeMove`, the operation `mission.node.move`, `EdgeKind`, `NodeKind` and the CLI codes `cli.mission.node.move.invalid_node_id`, `cli.mission.node.list.invalid_kind`, `cli.mission.node.list.invalid_node_id` and `cli.mission.edge.list.invalid_kind`.
- `TaskChange.MovedIn` and `TaskChange.MovedOut` stay, because an import moves a task (`mission-service.impl.md:614`, `:617`).

## D9 — Retired

`mission-service.impl.md:496` holds the rule: the node read answers `tasks`.

## D10 — Retired

`mission-service.md:73-74` and `mission-service.impl.md:52` hold the rule: a node names every binding that it uses, and no work takes a binding from the project.

## D11 — Retired

`mission-service.impl.md:66` holds the rule: the before read and the after read compare pairs by node and claim.

## D12 — Retired

`mission-service.impl.md:191-192` holds the rule: the preview runs the write steps in a probe transaction.

## D13 — `workerBindingsOf`

`src/project/service.ts:1201-1225` already offers `workerBindingsOf(tx, projectId | null)` to the worker pool (`src/apps/server/index.ts:461-462`). Plan 05 adds `traits` to its rows. The Scheduler declares the narrow type `{ binding_id; worker_name; traits }[]` inline, and the composition root passes the same method. No second method with the same name exists.

## D14 — Unknown worker and the node format

`declarationOf` answers `null` for an unknown worker name. `claimOnce` answers `ClaimOutcome.None` for a `null` declaration (`src/scheduler/claim.ts:170`). `NodeFormatField` (`src/scheduler/contract.ts:40-48`) and `REQUIRED_NODE_FORMAT` (`src/worker/catalog.ts:8-14`) go away.

## D15 — Coverage of the test fixtures

`src/apps/server/test-support.ts` exports `COVERING_WORKER_BINDINGS`: the worker bindings `coder` (`coder@1`) and `reviewer` (`reviewer@1`) with `instance_count: 0` and `traits: []`. Every server fixture and E2E setup that writes a node applies them in its binding set before the first node write. A test that runs an instance names its own binding with its own count. A colocated Mission or Project test injects an `unmatchedClaims` stand-in that answers `[]` by default (`erd-02-execution/decisions.md` D4: every collaboration is required).

## D16 — Prompt template variables

- `report.md` becomes `examine.md` in plan 02 (task 02.13). `PromptTemplate.Report` becomes `PromptTemplate.Examine`, and the operator override file becomes `prompts/examine.md`. `examine.md` takes `repositories`, `verification`, `dependencies`, `outcomes` and `evidence` (`agent.impl.md:280`).
- `work.md` takes `repositories` from plan 02 on (task 02.12). The list is empty for a node with one repository binding (`agent.impl.md:270`, `:283`).
- `conflict.md` takes `binding`, `directory`, `base_branch` and `files` from plan 09b on (`agent.impl.md:278`).
- `evaluation.md` takes `examine` (boolean, replaces `initiative`), `tasks`, `tested_input`, `results`, `evidence`, `dependencies` (replaces `objectives`) and `marker` (`agent.impl.md:279`).
- The proposal JSON of the evaluation template names `dependency_id` (`mission-service.impl.md:263`).

## D17 — Worker unit names

| Before                                      | After                                     |
| ------------------------------------------- | ----------------------------------------- |
| `steps-objective.ts`, `runStepsObjective`   | `steps-implement.ts`, `runStepsImplement` |
| `steps-initiative.ts`, `runStepsInitiative` | `steps-examine.ts`, `runStepsExamine`     |
| `WorkspaceKind.Objective` (`"objective"`)   | `WorkspaceKind.Node` (`"node"`)           |
| `objectiveKey`, `objectiveDirectory`        | `nodeKey`, `nodeDirectory`                |
| `prepareObjective`, `prepareInitiative`     | `prepareImplement`, `prepareExamine`      |
| `readObjectives`, `ExecutionObjective`      | `readDependencies`, `ExecutionDependency` |
| `NativeAgentInput.nodeKind`                 | `NativeAgentInput.work`                   |

The workspace path of an `implement` node stays `workspaces/<node identity>/<repository binding identity>/` until plan 09b (decision D28).

## D18 — The todoapp fixture copy

`src/apps/server/__fixtures__/todoapp/plan/` of the engine holds a byte copy of the 26 files of `docs/brainstorm/assets/todoapp/plan/` at the head of pull request #87 (`origin/design/flat-nodes`). The engine test reads the copy, because the engine repository holds no root document. `.prettierignore:5` excludes `src/**/__fixtures__/`, so no format step rewrites the copy. Plan 08 adds a root check that fails when the two sets differ, as `scripts/docs/prompts.sh` does for the prompts.

## D19 — Task size and the green state

A task is one commit of fewer than about 400 changed lines, except a fixture task whose diff is a mechanical substitution. A plan holds at most twenty tasks. Each task ends with its focused tests green under `node --test --test-timeout=30000 <files>`, because Node strips types and runs a test without the full typecheck. The task `NN.E` of each plan runs the whole gate of `00-index.md`.

## D20 — Main-session paths

`scripts/lane-check.sh` of the engine and of `apps` denies these paths to every lane role: engine `AGENTS.md`, `static/`, `docs/`, `scripts/*.test.sh`; apps `mock/`, `.claude/`, `.opencode/`, `scripts/*.test.sh`, `AGENTS.md`. A task that edits them carries the mark `Lane: main session`. The root `AGENTS.md:21-24` route sends each plan to a sub-agent outside the lane pipeline, so the mark only names the reviewer duty: the main session reviews each such diff itself.

## D21 — Apps personas

The persona files `apps/.claude/agents/*.md` and `apps/.opencode/agents/*.md` use the vocabulary of the plan pipeline (`.agents/plan/<initiative-slug>/…`), not the Mission node kinds. Plan 07 changes no persona file. `scripts/persona-sync.test.sh` stays green.

## D22 — Error tables and documents move with the code

Each plan writes every code that it adds or removes into the error table of its `engine/docs/cli/<group>.md` page in the same pull request (root `AGENTS.md:107-108`). Each plan regenerates OpenAPI in the task that changes an operation (`engine/AGENTS.md:454-463`).

## D23 — Eligibility report and on-demand request

No code implements `scheduler.eligibility.get` or the on-demand request. Plans 01 and 02 change their rows in `docs/cli/scheduler.md` only: the `node_task` code and the conditions `initiative-steps` and `readiness` go away (`scheduler-service.impl.md:80-93`).

## D24 — The coverage check placement

`mission-service.impl.md:66` names five node writes that run the coverage check. `node rebind` runs it too, because a rebind writes a node revision (`mission-service.impl.md#the-rebind`). The coverage check therefore runs in six handlers.

The check sits in one function `guardCoverage(tx, dependencies, projectId, write)` of `src/mission/coverage.ts`. Each of the six handlers calls it inside its `caller.commit` closure: the before read, the write, the after read, then the refusal of an added pair. `commitGraph` (`src/mission/service.ts:861-883`) stays as it is, because `node.update` does not use it (`src/mission/service.ts:818-831`).

## D25 — Retired

`mission-service.impl.md:307` holds the rule: the approval answers `{ created: NodeChange; proposer: ControlResult }`.

## D26 — Retired

`docs/brainstorm/assets/todoapp/kanthord-checks.md:26` holds the check, and `mission-service.md:78` holds its refusal. No project binding exists to add.

## D27 — Retired

`project-service.impl.md:331-332` holds the rule: the worker binding form holds the `Traits` field.

## D28 — One repository binding on an `implement` node until plan 09b

RULED 2026-10-17 by Ulrich (R13).

- In plans 01 to 09a, the repository range of `implement` in the rule table is exactly one. A second repository binding answers `mission.node.bindings_invalid`.
- An `examine` node names zero or more repository bindings from plan 02 on. It checks out each base-branch head read-only under `checkouts/<binding name>/`.
- The workspace of an `implement` node stays `workspaces/<node identity>/<repository binding identity>/`, and the worker reads `repositories[0]` for it.
- Plan 09a adds the evidence set, the tested input list and the actions of each binding, and keeps the range. Plan 09b lifts the range to one or more. It moves the checkout of an `implement` node to `workspaces/<node identity>/checkouts/<binding name>/` (`worker-service.impl.md:580-584`) and replaces each `repositories[0]` read with a loop.

## D29 — The storage failover

- Plan 03 grants an upload on the first storage binding of the ordered list. It replaces the single-match grant of `bindingOf` (`src/mission/evidence-content.ts:61`) and adds no failover.
- Plan 03b adds the failover: the enabled check, the failover on a refused signing call, the failed upload check and the refusal when no binding is left. It starts after plan 03 and merges before plan 08.
- Pending Ulrich ruling B1: the table `mission_evidence_upload_failure (node_id, attempt, storage_binding_id, asset_id, failed_at)` keys a failed upload check by `(node_id, attempt, storage_binding_id)`. The grant skips a binding that holds a failure row of the open attempt, and a new attempt tries every binding again. `asset_id` names the asset whose check failed.
- Pending Ulrich ruling B2: no binding left answers 409 `mission.evidence.storage_exhausted`. 503 `mission.evidence.storage_unavailable` keeps the meaning "No object storage is wired" (`src/mission/storage-unavailable.ts:5-18`).
- Plan 03b carries both values as "pending Ulrich ruling". Its gate replaces them with the ruled values before the merge.
