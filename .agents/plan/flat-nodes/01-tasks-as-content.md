# Plan 01: Mission Service — tasks as content

## Scope

This plan delivers:

- No task row in `mission_node`. A task exists only in `tasks` of the revision of its owner node.
- The task identity `task_<ulid>` (decision D5).
- Task writes through the owner: `NodeCreate.tasks`, `NodeUpdate.tasks`, `UnblockChange.tasks` and the import (decision D4). An objective, the later `implement` node, holds zero or more tasks on every write path (R7).
- The import coverage rule applies only to an objective with one or more tasks.
- An objective with no task is its own single work unit in the worker unit, with the node identity as the judged key.
- The node read answers `tasks` of its visible revision (`mission-service.impl.md:496`).
- No `mission.node.priority_task`, no `mission.node.control_task`, no `task_endpoint` reason (decision D8).

Out of scope:

- `kind`, `parent_id`, containment and the old grammar keys `kind` and `parent`. They stay until plan 03. A task plan file keeps `kind: task` and `parent:` in this plan.
- The direct-dependency readiness and the report reads (plan 02).

## Model

Opus at medium effort. The task identity in the import (creates, moves, retirements and `retired_id`) needs judgement over `import-revisions.ts`.

## Sources

- `docs/brainstorm/mission-service.md:40-46` — a task is content of its node, with no edge, state, attempt or priority; zero or more tasks; a node with no task is its own single work unit.
- `docs/brainstorm/mission-service.md:256` — the import coverage rule applies only to a node with one or more tasks.
- `docs/brainstorm/worker-service.md:326-331`; `docs/brainstorm/worker-service.impl.md:512`, `:539`, `:562` — the single work unit of a node with no task, its judged key and its tests.
- `docs/brainstorm/mission-service.md:99-105`, `:119` — the priority of a node; the node API update creates, changes and removes tasks.
- `docs/brainstorm/mission-service.md:163`, `:184-187` — a retirement and the import condition of a task; an import moves a task.
- `docs/brainstorm/mission-service.md:238-241` — a task holds no revision; its content belongs to the revision of its node.
- `docs/brainstorm/mission-service.impl.md:17` — `task_<ulid>`; no task identity takes `node_`.
- `docs/brainstorm/mission-service.impl.md:42`, `:54`, `:69` — `tasks` of a node; a task names no binding; a task of another node answers `mission.node.content_invalid`.
- `docs/brainstorm/mission-service.impl.md:80` — a task holds no priority.
- `docs/brainstorm/mission-service.impl.md:138-141`, `:147` — the task file `id` and the prefix refusal.
- `docs/brainstorm/mission-service.impl.md:161` — a task file name is unique among the node and task file names.
- `docs/brainstorm/mission-service.impl.md:185` — the import result maps each task file name to its task identity.
- `docs/brainstorm/mission-service.impl.md:205` — the identity of a removed task answers `mission.import.retired_id`.
- `docs/brainstorm/mission-service.impl.md:614-617` — `change.tasks` and the task changes.
- `docs/brainstorm/mission-service.impl.md:756`, `:828` — the tests of a foreign task, a task binding list, a removed task and the minted identity.
- `docs/brainstorm/mission-service.vocabulary.md:419-436` — the content owner.
- `docs/brainstorm/scheduler-service.md:110` — a task is never a unit of scheduling.

## Depends on

- Engine `main` at `54380cd9` or later.
- Pull request #87 of the root repository open at `5fa6db3`. Its design pages are the rule, and task 08.1 merges it (R14, decision D3).

## Provides

| Seam or shape                                            | Signature                                                                                | Owner file                | Consumer plans |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------- | -------------- |
| `TASK_IDENTITY_PREFIX`                                   | `"task"`                                                                                 | `src/mission/contract.ts` | 02, 03, 07     |
| `taskBodySchema`, `taskContentSchema`, `taskWriteSchema` | decision D4                                                                              | `src/mission/contract.ts` | 02, 03         |
| `taskOwnerOf`                                            | `(tx, missionId: string, taskId: string): { node_id: string; revision: number } \| null` | `src/mission/store.ts`    | 03             |
| `Node.tasks`                                             | `TaskContent[]` of the visible revision                                                  | `src/mission/contract.ts` | 07             |

## Tasks

### 01.1 Make the node state and attempt required in the schema

- Files: `src/mission/migrations.ts` (edit), `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. In `createMissionTables` (`src/mission/migrations.ts:11-22`) change `state TEXT` to `state TEXT NOT NULL` and `attempt INTEGER` to `attempt INTEGER NOT NULL`. Keep `priority INTEGER` nullable, because an absent priority reads 0 (`mission-service.impl.md:82`).
  2. Edit no other migration (decision D2).
  3. Assert both `NOT NULL` flags through `PRAGMA table_info(mission_node)` in `src/apps/server/migrations.test.ts`.
- Cite: `mission-service.md:42`; decision D2.
- Verify: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts`.

### 01.2 Declare the task identity and the task schemas

- Files: `src/mission/contract.ts` (edit), `src/mission/contract.test.ts` (edit)
- Do:
  1. Add `TASK_IDENTITY_PREFIX = "task"` next to `NODE_IDENTITY_PREFIX`.
  2. Remove `NodeKind.Task` (`src/mission/contract.ts:295-299`). `nodeKindSchema` keeps `initiative` and `objective`.
  3. Add `taskBodySchema = contentSchema` with `bindings: z.array(z.string()).max(0)`. Change `taskContentSchema` (`:535-540`) to `{ id: identitySchema("task"), filename, content: taskBodySchema }`. Add `taskWriteSchema = { id: identitySchema("task").optional(), filename, content: taskBodySchema }`.
  4. Change the `id` of each item of `revisionChangeSchema.tasks` (`:545-553`) to `identitySchema("task")`.
  5. Make `revisionSchema.tasks` (`:583`) a required `z.array(taskContentSchema)`.
  6. Add a required `tasks: z.array(taskWriteSchema)` to `nodeCreateSchema` (`:472-480`) and `nodeUpdateSchema` (`:482-488`). Make `unblockChangeSchema.tasks` (`:988`) required with `taskWriteSchema` items.
  7. Delete the `Task` arm of `nodeSchema` (`:1034-1037`). Add `tasks: z.array(taskContentSchema)` to `nodeBase` (`:1002-1011`).
  8. Delete the refine `kind !== Task || state === undefined` of the `node.list` query (`:1998`).
  9. Delete `MissionErrorCode.PriorityTask` (`:265`).
  10. Assert each schema in `src/mission/contract.test.ts`: a `node_` task identity fails, a task body with a binding fails, a `NodeCreate` without `tasks` fails.
- Cite: `mission-service.impl.md:17`, `:42`, `:54`; decisions D4, D5, D8; `mission-service.impl.md:496`.
- Verify: `node --test --test-timeout=30000 src/mission/contract.test.ts`.

### 01.3 Remove the task row from the store and the guards

- Files: `src/mission/store.ts`, `src/mission/routing.ts`, `src/mission/conditions.ts`, `src/mission/transitions.ts`, `src/mission/execution.ts`, `src/mission/control.ts`, `src/mission/record-store.ts`, `src/mission/frozen-action.ts`, `src/mission/currency.ts`, `src/mission/dependency.ts`, `src/mission/node-rebind.ts` (edit)
- Do:
  1. In `insertNode` (`src/mission/store.ts:132-163`) delete the `task` branch. Every row takes `NodeState.Pending` and `INITIAL_ATTEMPT`. Make `NodeRow.state` and `NodeRow.attempt` non-null (`:24-35`).
  2. Replace `readLastTaskSnapshot` (`:279-293`) by `taskOwnerOf(tx, missionId, taskId)` (decision D5). It joins `mission_node` on `mission_id` and reads the newest revision whose `tasks` holds the identity.
  3. Delete each `NodeKind.Task` test: `routing.ts:32`, `:60`; `conditions.ts:59-73`; `transitions.ts:57-64` (keep the `state` and `declaredStates` checks); `execution.ts:74`, `:95`; `control.ts:115`, `:151`, `:182`; `record-store.ts:91`; `frozen-action.ts:28`; `currency.ts:49-61`; `node-rebind.ts:84-106`, `:140-164`.
  4. Delete `ControlError.Task` and `requireRunnable` task branch (`src/mission/control.ts:38-55`).
  5. Delete `EndpointReason.Task` and its check (`src/mission/dependency.ts:34-54`). `validateEndpoints` keeps `cross_mission`.
  6. Delete the task filter of `validateCycle` (`src/mission/dependency.ts:56-84`).
- Cite: `mission-service.md:42-44`, `:92`, `:765`; `scheduler-service.md:110`; decision D8.
- Verify: `node --test --test-timeout=30000 src/mission/transitions.test.ts src/mission/control.test.ts src/mission/conditions.test.ts src/mission/record-store.test.ts`.

### 01.4 Write the tasks through node create

- Files: `src/mission/node-create.ts` (edit), `src/mission/content.ts` (edit)
- Do:
  1. Delete the task branch of `createdRevision` (`src/mission/node-create.ts:153-211`) and the `Task` row of `requireParent` (`:62-122`). An objective names an initiative parent; an initiative names none.
  2. Mint `task_<ulid>` for each `TaskWrite` of `NodeCreate.tasks`. A `TaskWrite` with an `id` answers `mission.node.content_invalid` (decision D4).
  3. Validate each task body with `validateNodeContent` and refuse a nonempty task `bindings` list with `mission.node.bindings_invalid` (`mission-service.impl.md:54`).
  4. An initiative with a nonempty `tasks` list answers `mission.node.content_invalid`. An objective accepts `tasks: []` (`mission-service.md:45`).
  5. Check each task file name against the node and task file names of the current nodes of the mission (`mission-service.impl.md:161-162`); a used name answers `mission.node.filename_conflict`.
  6. Write `change.tasks` with `created` for each task (`mission-service.impl.md:617`).
  7. Delete the `Task` row of `bindingRules` (`src/mission/content.ts:36-55`).
- Cite: `mission-service.md:45`, `:119`; `mission-service.impl.md:54`, `:161-162`, `:617`, `:828`; decision D4.
- Verify: a new test in `src/mission/service.test.ts` "node create mints a task identity for each task and writes it in revision 1"; `node --test --test-timeout=30000 src/mission/service.test.ts`.

### 01.5 Write the tasks through node update and criterion set

- Files: `src/mission/node-update.ts` (edit)
- Do:
  1. Delete `contentOwner` (`src/mission/node-update.ts:58-73`). Every update names the node itself.
  2. In `updatedRevision` (`:132-186`) diff `NodeUpdate.tasks` against the current tasks: a `TaskWrite` without `id` is `created`, a changed task is `updated` with its `changed_fields`, an omitted task is `retired` with empty `changed_fields`. A task `id` that the current revision does not hold answers `mission.node.content_invalid`.
  3. `setCriterion` (`:268-295`) keeps the task list unchanged.
- Cite: `mission-service.md:119`; `mission-service.impl.md:69`, `:617`; decision D4.
- Verify: new tests in `src/mission/service.test.ts` "node update creates, changes and removes tasks" and "node update refuses a task of another node with mission.node.content_invalid".

### 01.6 Write the tasks through an unblock change

- Files: `src/mission/control-unblock.ts` (edit)
- Do:
  1. Delete `renameTasks` (`src/mission/control-unblock.ts:51-74`).
  2. Replace `tasksOfChange` (`:98-139`) by the diff of task 01.5. An initiative with a nonempty list answers `mission.node.content_invalid`.
- Cite: `mission-service.impl.md:39`, `:69`; decision D4.
- Verify: `node --test --test-timeout=30000 src/mission/control-unblock.test.ts` with a case "unblock change adds and removes a task".

### 01.7 Answer the tasks on the node read

- Files: `src/mission/node-read.ts` (edit), `src/mission/service.ts` (edit)
- Do:
  1. Delete `ownerId` (`src/mission/node-read.ts:89-93`) and the task branch of `nodeRecord` (`:95-142`). `nodeRecord` answers `tasks` of the visible revision.
  2. Delete the `PriorityTask` refusal of the `node.priority.set` handler (`src/mission/service.ts:760-766`).
- Cite: `mission-service.md:100`; `mission-service.impl.md:80`, `:496`.
- Verify: a test in `src/mission/service.test.ts` "node get answers the tasks of the visible revision".

### 01.8 Retire a task through its owner alone

- Files: `src/mission/node-retire.ts` (edit)
- Do:
  1. Delete the task branch of `checkRetirement` (`src/mission/node-retire.ts:80-98`), `retireTasks` (`:171-206`) and the task grouping of `retireRows` (`:208-234`).
  2. The retirement set of `retirementSet` (`:44-78`) holds node rows alone. The tasks leave the work with their node (`mission-service.md:163`).
- Cite: `mission-service.md:163`; `mission-service.impl.md:561`.
- Verify: `node --test --test-timeout=30000 src/mission/service.test.ts` with the case "node retire of an objective keeps its tasks in its last revision".

### 01.9 Map the task plan files onto content in the import and the export

- Files: `src/mission/parser.ts`, `src/mission/import.ts`, `src/mission/import-apply.ts`, `src/mission/import-revisions.ts`, `src/mission/export.ts` (edit)
- Do:
  1. A task entry (still `kind: task` with `parent:`) takes an `id` with the prefix `task`; a node entry takes `node`. Another prefix answers `mission.import.plan_invalid` (decision D5).
  2. `resolveIdentity` (`src/mission/import.ts:268-275`) resolves a task identity with `taskOwnerOf`. An identity that no current owner revision holds answers `mission.import.retired_id`; an unknown identity answers `mission.import.unknown_id`.
  3. `assignIdentities` and `writeNodes` (`src/mission/import-apply.ts:99`, `:212-242`) insert no row for a task entry and mint `task_<ulid>` for a new task.
  4. `taskList` (`src/mission/import-revisions.ts:60-108`) keeps `created`, `updated`, `moved-in`, `moved-out` and `retired`. A moved task revises both owners with `write: import` (`mission-service.impl.md:614`).
  5. `checkImportCondition` (`src/mission/import.ts:619-660`) reads the condition of the old owner and of the new owner of a moved task (`mission-service.md:187`).
  6. The import result maps each task file name to its task identity (`mission-service.impl.md:185`).
  7. `checkVerificationCoverage` (`src/mission/import.ts:352-373`) skips an objective with no task file in the import set (`mission-service.md:256`, `mission-service.impl.md:190`).
  8. `exportEntry` (`src/mission/export.ts:35-67`) writes a task entry from the owner revision with its `task_` identity.
- Cite: `mission-service.md:184-187`; `mission-service.impl.md:147`, `:185`, `:205`, `:614`.
- Verify: `node --test --test-timeout=30000 src/mission/import.test.ts src/mission/parser.test.ts` with the cases "import mints task identities", "import refuses a node prefix on a task file", "import refuses a removed task identity with mission.import.retired_id", and "export and import round trip keeps every task identity" and "import accepts an objective with no task file".

### 01.10 Update the colocated Mission tests

- Files: `src/mission/*.test.ts`, `src/mission/test-support.ts` (edit)
- Do:
  1. Replace each task node fixture by a task in `tasks` of its objective: `service.test.ts`, `import.test.ts`, `content.test.ts`, `control-*.test.ts`, `transitions.test.ts`, `conditions.test.ts`, `currency.test.ts`, `record-*.test.ts`, `evidence-*.test.ts`, `execution*.test.ts`, `admission.test.ts`, `proposal.test.ts`, `delivery-match.test.ts`, `frozen-action.test.ts`.
  2. Delete the tests of the removed codes `mission.node.priority_task` and `mission.node.control_task`.
- Cite: decision D19.
- Verify: `node --test --test-timeout=30000 'src/mission/*.test.ts'`.

### 01.11 Change the Mission CLI leaves

- Files: `src/apps/cli/mission.ts` (edit)
- Do:
  1. Delete `KIND_STATE_CONFLICT` (`src/apps/cli/mission.ts:112`) and its check (`:177-181`).
  2. Change the help text of `--kind` (`:647-650`) to "Filter by initiative or objective" and of `--state` (`:652-655`) to drop "(not tasks)".
- Cite: decision D8.
- Verify: `node --test --test-timeout=30000 src/apps/cli/index.test.ts src/apps/cli/completeness.test.ts`.

### 01.12 Move the server fixtures to task content

- Files: `src/apps/server/journey-support.ts`, `src/apps/server/test-support.ts`, `src/apps/server/delivery-support.ts`, `src/apps/server/e2e-*.test.ts`, `src/apps/server/*-integration.test.ts` (edit)
- Do:
  1. `createJourneyNode` (`src/apps/server/journey-support.ts:63-113`) drops the `"task"` kind. Add `createJourneyTask(cli, objectiveId, filename)`, which reads the objective and sends `node update` with the task appended.
  2. `seedUnresolvedRequest` (`src/apps/server/test-support.ts:1178-1197`) inserts the objective row with a non-null state and attempt.
  3. Replace every `node create` of a task in the E2E and integration tests by `tasks` on the objective create or by `createJourneyTask`. Replace each task identity assertion by a `task_` assertion.
  4. Delete the E2E rows of `mission.node.control_task` (`e2e-mission-attempts-controls.test.ts` E01.16) and of `mission.node.priority_task`.
- Lane: none.
- Cite: decision D15 (fixtures stay in the server test support).
- Verify: `node --test --test-timeout=60000 'src/apps/server/e2e-mission-*.test.ts' src/apps/server/scheduler-integration.test.ts`.

### 01.13 Move the worker unit fixtures to task identities

- Files: `src/worker/unit/test-support.ts`, `src/worker/unit/*.test.ts` (edit)
- Do: replace each `node_` task identity of a worker unit fixture by a `task_` identity. Keep the judged-task keys (`src/worker/unit/judged-tasks.ts:15-16`), because the method keys on the task `id`.
- Cite: `mission-service.impl.md:17`.
- Verify: `node --test --test-timeout=30000 'src/worker/unit/*.test.ts'`.

### 01.14 Regenerate OpenAPI

- Files: `static/openapi.yaml`, `static/openapi/mission/*.yaml` (generated), `src/apps/server/openapi-integration.test.ts` (edit)
- Lane: main session (decision D20).
- Do:
  1. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`.
  2. In `assertBlockedNode` (`src/apps/server/openapi-integration.test.ts:898-915`) expect the variants `[Initiative, Objective]`.
- Cite: `engine/AGENTS.md:454-463`; decision D22.
- Verify: `node --test --test-timeout=60000 src/apps/server/openapi-integration.test.ts`.

### 01.15 Update the CLI pages

- Files: `docs/cli/mission.md`, `docs/cli/scheduler.md` (edit)
- Lane: main session (decision D20).
- Do:
  1. `docs/cli/mission.md`: rewrite the task rules of `node create` and `node update` (`:240-249`), the rows `NodeCreate`, `NodeUpdate`, `UnblockChange`, `TaskContent` (`:720-721`, `:781-782`), `Node` (`:905`, add `tasks`, drop the task variant) and `Revision` (`:907`). Add `TaskBody` and `TaskWrite`. Delete the error rows `mission.node.control_task` (`:1101`) and `mission.node.priority_task` (`:1107`), the local row `cli.mission.node.list.kind_state_conflict` (`:990`) and the `task_endpoint` reason of `mission.dependency.endpoint_invalid` (`:1059`).
  2. `docs/cli/scheduler.md`: change `:235` to "Only a node is queued"; delete the row `scheduler.eligibility.node_task` (`:595`).
- Cite: root `AGENTS.md:107-108`; decisions D8, D22, D23.
- Verify: `pnpm exec prettier --check docs/cli/mission.md docs/cli/scheduler.md`.

### 01.16 Run an objective with no task as one work unit

- Files: `src/worker/unit/steps-objective.ts`, `src/worker/unit/judged-tasks.ts`, `src/worker/unit/evaluation.ts`, `src/worker/unit/steps-objective-check.test.ts`, `src/worker/unit/steps-objective.test.ts` (edit)
- Do:
  1. Add `workUnitsOf(nodeId, revision)` in `src/worker/unit/steps-objective.ts`. It answers the tasks of the revision, or one unit `{ id: <node identity>, filename, content }` from the node content when the revision holds no task.
  2. `startCheck` (`:587-620`), the task loop (`:498-536`) and the verification of a unit (`:455-497`) read `workUnitsOf`. The single unit runs the node verifications and judges the node criterion.
  3. `recordJudged` and `judgedAt` (`src/worker/unit/judged-tasks.ts:28-50`) take the node identity as the key of the single unit.
  4. The task choice (`:568-585`) sends no `task-choice` instruction for the single unit. The unit stays pending with the failure text (`worker-service.impl.md:539`).
  5. The single unit commits its changes with a commit message that names the node identity, before the release with no further work.
  6. The evaluation of an objective with no task judges the node criterion alone.
- Cite: `mission-service.md:45-46`; `worker-service.md:326-331`, `worker-service.md#executions` (the commit message of the single work unit); `worker-service.impl.md:512`, `:539`, `:562`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/steps-objective.test.ts src/worker/unit/steps-objective-check.test.ts` with "an objective with no task runs the node verifications under the node identity as the judged key", "an objective with no task commits its change with the node identity in the message before it releases" and "a failed node verification sends no task-choice instruction".

### 01.E Run the gate

- Do: run the gate row 01 of `00-index.md`.
- Verify: every command of the row exits 0, and each `rg` prints nothing.

## E2E

The E2E suites of task 01.12 prove the plan through the CLI. `e2e-mission-service.test.ts` adds these rows:

| Id     | Commands                                                                                                                                                    | Exit | Expect                                                                                               |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------------------------------- |
| EF01.1 | `kanthord mission node create <missionId> --file objective.json` with two `tasks` without `id`                                                              | 0    | `revisions[0].tasks[*].id` match `^task_[0-9A-HJKMNP-TV-Z]{26}$`; `change.tasks[*].change` `created` |
| EF01.2 | `kanthord mission node get <objectiveId>`                                                                                                                   | 0    | `tasks` holds both tasks                                                                             |
| EF01.3 | `kanthord mission node update <objectiveId> --file update.json` that omits the first task                                                                   | 0    | `change.tasks` holds `{ id: <first>, change: "retired", changed_fields: [] }`                        |
| EF01.4 | `kanthord mission node get <taskId>`                                                                                                                        | 1    | stderr starts with `cli.mission.node.get.invalid_node_id:`                                           |
| EF01.5 | `kanthord mission export <missionId> --format json`, then `kanthord mission import apply` of that payload                                                   | 0, 0 | the same task identities, no new revision                                                            |
| EF01.6 | `kanthord mission node create <missionId> --file objective.json` with `tasks: []`; `kanthord mission import preview` of an objective file with no task file | 0, 0 | the revision holds `tasks: []`; the preview holds no `mission.import.verification_uncovered`         |

## Blockers

None.
