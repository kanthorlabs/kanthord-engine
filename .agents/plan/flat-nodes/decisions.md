# Flat-node plan decisions

The plans cite these decisions as D1 to D27. Each decision binds every plan and every task of this set. A decision records only what the design pages of pull request #87 leave open.

## D1 — Source and gaps

The design pages at root `1283c7f` are the rule. A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. The main session brings it to Ulrich as one open item. Cross-plan alignment, a split of a task and a one-line fix are plan work, never a gap.

## D2 — Schema in place and the database discard

RULED 2026-10-17 by Ulrich: kanthord is not deployed, so the refactor keeps no backward compatibility.

- Edit the migration functions of `src/mission/migrations.ts` in place. This overrides `engine/AGENTS.md:421-422` ("Never edit a published migration") for this set alone.
- Keep the four entries of `missionMigrations` and their order (`src/mission/migrations.ts:136-141`). Add no migration.
- Write no data migration and no legacy read mapping. No input accepts a `node_` task identity.
- After each engine plan merges, a developer runs `make cleanup`, then `make bootstrap` and `make dev` (`scripts/engine/cleanup.sh`). Plan 08 discards the homelab volume.

## D3 — Layer order

The order of `00-index.md` "Plans" binds. Plans 01 and 02 ship an intermediate model: initiatives and objectives exist, tasks are content, and the report semantics read direct dependencies. That model is green and usable through the CLI. No plan adds code that a later plan of the set deletes, except the `kind`-keyed branches that plan 03 replaces by `work`-keyed branches.

## D4 — Content, task body and the node read

- `Content` holds `name`, `requirement`, `criterion`, `verifications`, `bindings`, `work` and `requires` (plan 03). Before plan 03 it holds the first five.
- `TaskBody` holds `name`, `requirement`, `criterion`, `verifications` and `bindings`. `bindings` is `[]`; another list answers `mission.node.bindings_invalid` (`mission-service.impl.md:53`).
- `TaskContent` holds `id: TaskId`, `filename: PlanFileName` and `content: TaskBody`.
- `Revision.tasks` is a required list. A `report` node and, before plan 03, an initiative hold `[]`.
- The node read `Node` holds `work` and `requires` at the claim revision (`mission-service.impl.md:488`), and `tasks: TaskContent[]` of the visible revision (decision D9).
- `NodeCreate`, `NodeUpdate` and `UnblockChange` hold a required `tasks: TaskWrite[]`. `TaskWrite` holds an optional `id: TaskId`, `filename` and `content: TaskBody`.
  - On `NodeCreate` a `TaskWrite` with an `id` answers `mission.node.content_invalid`. The service mints `task_<ulid>` for each task.
  - On `NodeUpdate` and `UnblockChange` a `TaskWrite` without an `id` creates a task with a minted identity. An `id` names a current task of the same node, else the write answers `mission.node.content_invalid` (`mission-service.impl.md:68`). A current task that the list omits is removed with `change: retired` (`mission-service.impl.md:609`).
  - The node API never moves a task. Only an import moves a task (`mission-service.md:188`).

## D5 — Task identity

- `TASK_IDENTITY_PREFIX = "task"` in `src/mission/contract.ts`. `identitySchema("task")` validates a task identity.
- `readLastTaskSnapshot` (`src/mission/store.ts:279-293`) becomes `taskOwnerOf(tx, missionId, taskId): { node_id; revision } | null`. It reads the latest revision of any node of the mission that holds the task in `tasks`. The import answers `mission.import.retired_id` for a task identity whose owner revision no longer holds it (`mission-service.impl.md:202`).
- A plan file `id` with the prefix of the other file form answers `mission.import.plan_invalid` (`mission-service.impl.md:145`). Before plan 03 the form is `kind: task`; from plan 03 on it is `node:`.

## D6 — Edge shape

`Edge` is `{ dependent_id: NodeId, depends_on_id: NodeId }` with no `kind` field from plan 03 on. `edge list` takes no `kind` query and the CLI takes no `--kind`. `NodeChange.added_edges`, `removed_edges` and `RetirePreview.removed_edges` use the same shape.

## D7 — Import and export entries

`ImportEntry` and `ExportEntry` are a union of two strict objects, from plan 03 on:

- A node entry: `filename`, `id?`, `work`, `name`, `requirement`, `criterion`, `verifications`, `bindings`, `requires?`, `depends_on?`.
- A task entry: `filename`, `id?`, `node`, `name`, `requirement`, `criterion`, `verifications`, `bindings`.

An export entry requires `id`. A Markdown export writes `requires` on every node file, also `requires: []`, as the vocabulary example does (`mission-service.vocabulary.md:600-660`).

## D8 — Removed codes and fields

- Plan 01 removes `mission.node.priority_task` (`src/mission/contract.ts:265`), `mission.node.control_task` (`ControlError.Task`, `src/mission/control.ts:38-43`), the endpoint reason `task_endpoint` (`src/mission/dependency.ts:34-37`), `cli.mission.node.list.kind_state_conflict` (`src/apps/cli/mission.ts:112`) and the documentation row `scheduler.eligibility.node_task` (`docs/cli/scheduler.md:595`).
- Plan 03 removes `mission.node.create_refused`, `mission.import.kind_changed`, `RevisionWrite.NodeMove`, the operation `mission.node.move`, `EdgeKind`, `NodeKind` and the CLI codes `cli.mission.node.move.invalid_node_id`, `cli.mission.node.list.invalid_kind`, `cli.mission.node.list.invalid_node_id` and `cli.mission.edge.list.invalid_kind`.
- `TaskChange.MovedIn` and `TaskChange.MovedOut` stay, because an import moves a task (`mission-service.impl.md:606`, `:609`).

## D9 — The node read answers the tasks

`Node` holds `tasks: TaskContent[]` of its visible revision. `mission-service.impl.md:624` requires a `Tasks (<count>)` section on each `change` node card, and the node read of `:486-488` names no task field. The dashboard reads the card from `node list` with no read per node.

## D10 — Binding resolution

The Mission Service resolves each binding kind on its own (`mission-service.md:72-81`):

1. The bindings of that kind that the write names.
2. Else, for an existing node, its stored bindings of that kind (`mission-service.md:80`).
3. Else, when the rule table of the work permits one or more bindings of that kind, the one binding of that kind of the project (`mission-service.md:74-75`). Two or more answer `mission.node.bindings_invalid` (`mission-service.md:78`).
4. Else no binding.

Rule 3 is new code. `MissionBindings.projectBindingsOf(tx, projectId, kind)` serves it, and `ProjectService` implements it over `readLatestBinding` rows that are no tombstone. The worker kind is never resolved, because both columns hold 0.

## D11 — Unmatched pair identity

A pair is `(node_id, claim)`. The before read and the after read of a write compare pairs by that key alone. `revision` is reported in `details.claims` and takes no part in the comparison. A revision that a write creates therefore never turns an existing unmatched pair into an added pair (`scheduler-service.vocabulary.md:58`, `mission-service.md:37`).

## D12 — Import preview coverage

The preview runs the write steps of `applyImport` inside a probe transaction that throws to roll back, as the work pull does (`src/scheduler/work-pull.ts:46-60`). It reads `unmatchedClaims` before and after the probe write. The probe runs only when the three validation stages pass (`mission-service.impl.md:185`). The preview answers one violation `mission.node.requires_unmatched` for each node with an added pair, with `filename` and `node_id` as locators (null `node_id` for a new node) and `details: { claims }`.

## D13 — `workerBindingsOf`

`src/project/service.ts:1201-1225` already offers `workerBindingsOf(tx, projectId | null)` to the worker pool (`src/apps/server/index.ts:461-462`). Plan 05 adds `traits` to its rows. The Scheduler declares the narrow type `{ binding_id; worker_name; traits }[]` inline, and the composition root passes the same method. No second method with the same name exists.

## D14 — Unknown worker and the node format

`declarationOf` answers `null` for an unknown worker name. `claimOnce` answers `ClaimOutcome.None` for a `null` declaration (`src/scheduler/claim.ts:170`). `NodeFormatField` (`src/scheduler/contract.ts:40-48`) and `REQUIRED_NODE_FORMAT` (`src/worker/catalog.ts:8-14`) go away.

## D15 — Coverage of the test fixtures

`src/apps/server/test-support.ts` exports `COVERING_WORKER_BINDINGS`: the worker bindings `coder` (`coder@1`) and `reviewer` (`reviewer@1`) with `instance_count: 0` and `traits: []`. Every server fixture and E2E setup that writes a node applies them in its binding set before the first node write. A test that runs an instance names its own binding with its own count. A colocated Mission or Project test injects an `unmatchedClaims` stand-in that answers `[]` by default (`erd-02-execution/decisions.md` D4: every collaboration is required).

## D16 — Prompt template variables

- `report.md` takes `dependencies`, `outcomes`, `evidence` and `verification` (`agent.impl.md:280`).
- `evaluation.md` takes `report` (boolean, replaces `initiative`), `tasks`, `tested_input`, `results`, `evidence`, `dependencies` (replaces `objectives`) and `marker` (`agent.impl.md:279`).
- The proposal JSON of the evaluation template names `dependency_id` (`mission-service.impl.md:260`).

## D17 — Worker unit names

| Before                                      | After                                     |
| ------------------------------------------- | ----------------------------------------- |
| `steps-objective.ts`, `runStepsObjective`   | `steps-change.ts`, `runStepsChange`       |
| `steps-initiative.ts`, `runStepsInitiative` | `steps-report.ts`, `runStepsReport`       |
| `WorkspaceKind.Objective` (`"objective"`)   | `WorkspaceKind.Node` (`"node"`)           |
| `objectiveKey`, `objectiveDirectory`        | `nodeKey`, `nodeDirectory`                |
| `prepareObjective`, `prepareInitiative`     | `prepareChange`, `prepareReport`          |
| `readObjectives`, `ExecutionObjective`      | `readDependencies`, `ExecutionDependency` |
| `NativeAgentInput.nodeKind`                 | `NativeAgentInput.work`                   |

The workspace path stays `workspaces/<node identity>/<repository binding identity>/` (`worker-service.impl.md:574`).

## D18 — The todoapp fixture copy

`src/apps/server/__fixtures__/todoapp/plan/` of the engine holds a byte copy of the 25 files of `docs/brainstorm/assets/todoapp/plan/`. The engine test reads the copy, because the engine repository holds no root document. `.prettierignore:5` excludes `src/**/__fixtures__/`, so no format step rewrites the copy. Plan 08 adds a root check that fails when the two sets differ, as `scripts/docs/prompts.sh` does for the prompts.

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

## D24 — The coverage write list

The coverage check runs in the five node writes that `mission-service.impl.md:65` names: import apply, node create, node update, an unblock with a change and a proposal approval. `node rebind`, `criterion set`, a dependency edit and a retirement run no coverage check.

The check sits in one function `guardCoverage(tx, dependencies, projectId, write)` of `src/mission/coverage.ts`. Each of the five handlers calls it inside its `caller.commit` closure: the before read, the write, the after read, then the refusal of an added pair. `commitGraph` (`src/mission/service.ts:861-883`) stays as it is, because `node.update` does not use it (`src/mission/service.ts:818-831`).

## D25 — The proposal approval answer

`mission.proposal.approve` answers `ProposalApproveResult = { created: NodeChange; proposer: ControlResult }`. `created` is the `NodeChange` of the node that the approval creates. `proposer` is the `ControlResult` of the unblock of the proposer (`mission-service.impl.md:303-305`).

## D26 — The binding cardinality check of the todoapp fixture

The check "Binding cardinality" of `docs/brainstorm/assets/todoapp/kanthord-checks.md:26` adds a second repository binding to the project before it removes the repository binding from one change node. The expected result stays `mission.node.bindings_invalid` (`mission-service.md:78`). Plan 06 tests this form, and plan 08 writes it into `kanthord-checks.md:26`.

## D27 — The traits field of the dashboard

The worker binding form of the dashboard holds a `Traits` field with one key per line, and the worker binding row shows the traits as badges. The draft carries the order of the keys unchanged.
