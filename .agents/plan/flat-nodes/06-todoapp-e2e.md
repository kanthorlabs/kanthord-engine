# Plan 06: Gateway composition — the todoapp plan E2E

## Scope

This plan proves the final engine contract of plans 01 to 05 against the todoapp plan of the root design pages. It adds:

- A byte copy of the 26 files of `docs/brainstorm/assets/todoapp/plan/` (decision D18).
- One E2E journey that runs the planning checks of `kanthord-checks.md:14-36` and the dependency order of `kanthord-checks.md:40`, `:45-46` through the CLI.

Out of scope:

- An execution by a real agent, a review by a real agent and a repository action. Plan 08 runs `make e2e` by hand for these (`kanthord-checks.md:41-44`, `:47`).
- The controlled experiments of `kanthord-checks.md:52-58`, except the work lock of `:56`. Earlier plans prove the other experiments on their own fixtures.
- An `implement` node with two repository bindings (plans 09a and 09b, decision D28).
- Every change of `src/` outside the new test, the copy and the CLI support. A failed row is a defect of an earlier plan. The task reports it as one `DEBATE:` line and stops.

## Model

Sonnet at high effort. The check table of the design page states each action and each expected result.

## Sources

- `docs/brainstorm/assets/todoapp/README.md:5`, `:24-36`, `:56-63` — the import set, the graph and the import preparation.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:7-10` — the preconditions.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:14-36` — the planning checks and the fourteen dependency edges.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:40`, `:45-46` — the dependency order and the node with no task.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:56` — the work lock.
- `docs/brainstorm/mission-service.md:73-87` — every node names its bindings, and no node takes a binding from the project.
- `docs/brainstorm/mission-service.md:45-46`, `:256` — a node with no task and the import coverage rule.
- `docs/brainstorm/mission-service.impl.md:52-61` — the rule table by work.
- `docs/brainstorm/mission-service.impl.md:503`, `:510` — `node ready` opens attempt 1.
- `docs/brainstorm/mission-service.md:673`, `:679` — the success override from `Pending` and `Available`.
- `docs/brainstorm/project-service.md:107`; `docs/brainstorm/project-service.impl.md:133` — the binding-set coverage refusal.

## Depends on

- Plan 05 merged.
- The head of pull request #87 (branch `design/flat-nodes`) as the copy source. Pull request #87 stays open until plan 08 (decision D3).

## Provides

The fixture `src/apps/server/__fixtures__/todoapp/plan/` for plan 08 (decision D18). No seam changes.

## Tasks

### 06.1 Copy the todoapp plan files

- Files: `src/apps/server/__fixtures__/todoapp/plan/*.md` (create, 26 files)
- Do:
  1. From the worktree `engine/.dev/flat-nodes-06-todoapp`, run `git -C ../../.. fetch origin design/flat-nodes`. The head of pull request #87 holds the review v3 change of `contributing.md`: the verification `npm ci && npm run format:check` and the owner `kanthorlabs`.
  2. Run `D=src/apps/server/__fixtures__/todoapp/plan; for p in $(git -C ../../.. ls-tree --name-only origin/design/flat-nodes docs/brainstorm/assets/todoapp/plan/); do f=$(basename "$p"); git -C ../../.. show "origin/design/flat-nodes:$p" > "$D/$f"; done`.
  3. Do not format the copy. `.prettierignore:5` excludes it (decision D18).
  4. Run the copy again before the merge of this plan when the head of pull request #87 changed a file of the set.
- Cite: decision D18; `docs/brainstorm/assets/todoapp/README.md:5`, `:24`.
- Verify: the copy check prints nothing. The copy check is `D=src/apps/server/__fixtures__/todoapp/plan; for p in $(git -C ../../.. ls-tree --name-only origin/design/flat-nodes docs/brainstorm/assets/todoapp/plan/); do git -C ../../.. show "origin/design/flat-nodes:$p" | cmp -s - "$D/$(basename "$p")" || echo "$p"; done`, and `ls src/apps/server/__fixtures__/todoapp/plan | wc -l` prints `26`.

### 06.2 Add the todoapp project setup

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (create)
- Do:
  1. Add a local function `todoappProject(t, fixture)` in the test file. It runs, through `kanthord` of `src/apps/server/cli-support.ts:122`:
     1. `kanthord project create --name <unique name>`.
     2. `kanthord project binding apply <projectId> --file <file>` with the repository binding `todoapp-repo` of `repositoryBinding` (`cli-support.ts:235-259`) and `COVERING_WORKER_BINDINGS` (decision D15). Every worker binding holds `instance_count: 0` (`kanthord-checks.md:8`).
     3. `kanthord mission get <projectId>`.
  2. It answers `{ projectId, missionId, version, bindingId }`.
  3. Add a local function `planFiles(directory, edit?)`. It copies the 26 files into a temporary directory, applies `edit` to the copy and answers the paths in basename order. The fixture copy stays unchanged (`kanthord-checks.md:10`).
  4. Each row that mutates the graph calls `todoappProject` for its own project in one `gatewayFixture` (`src/apps/server/test-support.ts:316`).
- Cite: `docs/brainstorm/assets/todoapp/README.md:56-58`; `kanthord-checks.md:7-10`.
- Verify: `node --test --test-timeout=60000 src/apps/server/e2e-todoapp-plan.test.ts` runs the setup test "a fresh todoapp project holds an empty mission at version 1".

### 06.3 Prove the baseline import

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do: write the rows EF06.1 to EF06.5 of the section E2E.
- Cite: `kanthord-checks.md:16-20`, `:36`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.[1-5] ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.4 Prove the import refusals and the node with no task

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do:
  1. Write the rows EF06.6 to EF06.16 of the section E2E.
  2. Each refusal row asserts that the mission version and `node list` stay unchanged after the refusal.
- Cite: `kanthord-checks.md:21-30`; decision D28.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.([6-9]|1[0-6]) ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.5 Prove the identity-bearing edits

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do: write the rows EF06.17 to EF06.19 of the section E2E. Each row edits the export of `kanthord mission export <missionId> --format markdown`, not the fixture copy.
- Cite: `kanthord-checks.md:31-34`; `docs/brainstorm/assets/todoapp/README.md:63-65`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.1[7-9] ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.6 Prove the dependency order and the coverage

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do: write the rows EF06.20 to EF06.24 of the section E2E.
- Cite: `kanthord-checks.md:40`, `:45-46`, `:56`; `project-service.md:107`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.2[0-4] ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.E Run the gate

- Do: run the gate row 06 of `00-index.md`.
- Verify: every command of the row exits 0, and the copy check prints nothing.

## E2E

- Test file: `src/apps/server/e2e-todoapp-plan.test.ts`.
- Harness: `gatewayFixture` of `src/apps/server/test-support.ts:316`, `kanthord` of `src/apps/server/cli-support.ts:122`, and `todoappProject` and `planFiles` of task 06.2. Every act goes through the CLI. The test reads no store. The CLI prints no `details` of a refusal. A row that asserts `details` reads them from the refused request through `httpClient`. Every other act goes through the CLI.
- `import <set>` means `kanthord mission import preview <missionId> <plan-file...> --file <controls>`, then `kanthord mission import apply` with the `previewDigest` and the `confirmedRetirements` of the preview.
- A refused `import <set>` exits 0 on the preview, and the preview holds the violation of the row. The apply with that digest exits 1, and its stderr starts with the code of the row (`src/mission/import-apply.ts:52-66`). Each refusal row asserts both.

| Id      | Check (`kanthord-checks.md`)                    | Commands                                                                                                                                                        | Exit      | Expect                                                                                                                                                                                                                                                              |
| ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EF06.1  | Baseline preview (`:16`)                        | `import preview` of the 26 files                                                                                                                                | 0         | no violation, no retirement, a `previewDigest`; `node list` holds no node                                                                                                                                                                                           |
| EF06.2  | Atomic apply (`:17`, `:36`)                     | `import apply` of the preview; `node list <missionId>`; `edge list <missionId>`; `mission get`                                                                  | 0         | 8 nodes: 1 with `work` `examine`, 7 with `work` `implement`; six implement revisions hold 18 tasks; the 14 edges of `:36`; the mission version reads `MISSION_INITIAL_VERSION + 1`                                                                                  |
| EF06.3  | Binding resolution (`:18`)                      | `node get` of each node                                                                                                                                         | 0         | each revision, the examine revision included, pins `bindingId`; no task holds a binding; no revision names a worker binding                                                                                                                                         |
| EF06.4  | Revision model (`:19`)                          | `node get` of each node                                                                                                                                         | 0         | revision 1 and attempt 0 on each node; each task id matches `^task_[0-9A-HJKMNP-TV-Z]{26}$` and holds no `revision`, `state` or `attempt`                                                                                                                           |
| EF06.5  | Export round trip (`:20`)                       | `export --format markdown`; `import` of the export at the current version                                                                                       | 0, 0      | the same node ids, task ids, edges and revisions; no node takes a new revision                                                                                                                                                                                      |
| EF06.6  | Unknown grammar (`:21`)                         | `import` with an unknown front-matter field in `todos.md`; then with an unknown H2 in `todos.md`                                                                | 0, 1 each | `mission.import.plan_invalid` names `todos.md`                                                                                                                                                                                                                      |
| EF06.7  | Unresolved reference (`:22`)                    | `import` with `missing.md` in `depends_on` of `persistence.md`                                                                                                  | 0, 1      | `mission.import.unresolved_reference`                                                                                                                                                                                                                               |
| EF06.8  | Duplicate name (`:23`)                          | `import` with `todos.md` twice                                                                                                                                  | 0, 1      | `mission.import.duplicate_file`                                                                                                                                                                                                                                     |
| EF06.9  | Forbidden task key (`:24`)                      | `import` with `depends_on: []` in `todos-crud.md`; then `requires: []`; then `work: implement`                                                                  | 0, 1 each | `mission.import.plan_invalid` names `todos-crud.md`                                                                                                                                                                                                                 |
| EF06.10 | Task on an examine node (`:25`)                 | `import` with `node: todo-api.md` in `todos-crud.md`                                                                                                            | 0, 1      | `mission.import.reference_kind_invalid`                                                                                                                                                                                                                             |
| EF06.11 | Binding cardinality (`:26`)                     | `import` with no `bindings` in `todos.md`                                                                                                                       | 0, 1      | `mission.node.bindings_invalid`; no node takes the project binding                                                                                                                                                                                                  |
| EF06.12 | Uncovered node verification (`:27`)             | `import` without `npm run lint && npm run format:check` in `foundation-runtime.md`                                                                              | 0, 1      | `mission.import.verification_uncovered` names `foundation.md`                                                                                                                                                                                                       |
| EF06.13 | Node with no task (`:28`)                       | `node get` of `contributing` after EF06.2                                                                                                                       | 0         | `tasks` is `[]`; the preview of EF06.1 holds no violation for `contributing.md`                                                                                                                                                                                     |
| EF06.14 | Dependency cycle (`:29`)                        | `import` with `todo-api.md` in `depends_on` of `foundation.md`                                                                                                  | 0, 1      | `mission.import.cycle`                                                                                                                                                                                                                                              |
| EF06.15 | Unmatched requirement (`:30`)                   | `import preview` with `requires: [platform.macos]` in `foundation.md`; then `import apply` of that preview                                                      | 0, 1      | the preview holds the violation `mission.node.requires_unmatched` for `foundation.md` with `details.claims`; the apply stderr starts with `mission.node.requires_unmatched:`                                                                                        |
| EF06.16 | Second repository binding (decision D28)        | `binding apply` that adds a repository binding `todoapp-mirror`; `import` with `bindings: [todoapp-repo, todoapp-mirror]` in `todos.md`                         | 0; 0, 1   | `mission.node.bindings_invalid`                                                                                                                                                                                                                                     |
| EF06.17 | Stale mission version (`:31`)                   | `node update` of `todos` with a new criterion; `import apply` of an import prepared before it                                                                   | 0, 1      | stderr starts with `mission.version.conflict:`; `node get` of `todos` shows the criterion of the update                                                                                                                                                             |
| EF06.18 | Pre-start task edit (`:32`)                     | `import` of the export with a new criterion in one task of `todos.md`                                                                                           | 0         | `todos` reads revision 2; the task keeps its id; no other node changes                                                                                                                                                                                              |
| EF06.19 | Task omission and node retirement (`:33-34`)    | `import preview` of the export without `todos-isolation.md`; then without `todo-api.md`; `import apply` of the second preview with `confirmedRetirements`       | 0, 0, 0   | the first preview lists no retirement and no violation; the second lists exactly `todo-api`; after the apply `node get` of `todo-api` reads retired and `edge list` holds 7 edges                                                                                   |
| EF06.20 | Initial order (`:40`)                           | `kanthord scheduler queue list <projectId>`                                                                                                                     | 0         | one job, of `foundation`; `todo-api` reads `Pending`; no job names a task id                                                                                                                                                                                        |
| EF06.21 | Dependency order (`:45-46`)                     | `node override <foundation> --result success`; `queue list`; repeat for `persistence`, `authentication`, `todos`, `operations`, `contributing`, `acceptance`    | 0         | after `foundation`, jobs of `persistence`, `operations` and `contributing`; after `persistence`, a job of `authentication`; `acceptance` has a job only after `todos` and `operations` complete; after the seventh override `todo-api` reads `Available` with a job |
| EF06.22 | Work lock (`:56`)                               | `node ready <foundation>` with `expected_state: Available` and `expected_attempt: 0` in its `--file` body; `node update <foundation>` that sets `work: examine` | 0, 1      | stderr starts with `mission.node.work_locked:`; `foundation` keeps its revision                                                                                                                                                                                     |
| EF06.23 | Binding-set coverage (`project-service.md:107`) | On a fresh imported project, `binding apply` without the binding of `reviewer@1`                                                                                | 1         | stderr starts with `project.bindings.worker.node_unmatched:`; `details.node_ids` holds the eight node ids, because each node claims `Waiting`; the binding-set version does not change                                                                              |
| EF06.24 | No task schedules (`:40`)                       | `queue list` after EF06.21                                                                                                                                      | 0         | no job and no execution names a `task_` id                                                                                                                                                                                                                          |

## Blockers

None.
