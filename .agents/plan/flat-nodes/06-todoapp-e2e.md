# Plan 06: Gateway composition — the todoapp plan E2E

## Scope

This plan proves the final engine contract against the todoapp plan of the root design pages. It adds:

- A byte copy of the 25 files of `docs/brainstorm/assets/todoapp/plan/` (decision D18).
- One E2E journey that runs the planning checks of `kanthord-checks.md:14-35` and the dependency order of `kanthord-checks.md:39`, `:44-45` through the CLI.

Out of scope:

- An execution by a real agent, a review by a real agent and a repository action. Plan 08 runs `make e2e` by hand for these (`kanthord-checks.md:40-43`, `:46`).
- The controlled experiments of `kanthord-checks.md:48-57`, except the work lock of `:55`. Earlier plans prove the other experiments on their own fixtures.
- Every change of `src/` outside the new test, the copy and the CLI support. A failed row is a defect of an earlier plan. The task reports it as one `DEBATE:` line and stops.

## Model

Sonnet at high effort. The check table of the design page states each action and each expected result.

## Sources

- `docs/brainstorm/assets/todoapp/README.md:5`, `:23-34`, `:54-63` — the import set, the graph and the import preparation.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:7-10` — the preconditions.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:14-35` — the planning checks and the twelve dependency edges.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:39`, `:44-45` — the dependency order.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:55` — the work lock.
- `docs/brainstorm/mission-service.md:72-88` — the binding resolution.
- `docs/brainstorm/mission-service.impl.md:49-61` — the rule table by work and the project-binding fallback.
- `docs/brainstorm/mission-service.impl.md:495-502` — `node ready` opens attempt 1.
- `docs/brainstorm/mission-service.md:658-664` — the success override from `Pending` and `Available`.

## Depends on

- Plan 05 merged.
- Pull request #87 merged to root `main`, or its head `1283c7f` as the copy source.

## Provides

The fixture `src/apps/server/__fixtures__/todoapp/plan/` for plan 08 (decision D18). No seam changes.

## Tasks

### 06.1 Copy the todoapp plan files

- Files: `src/apps/server/__fixtures__/todoapp/plan/*.md` (create, 25 files)
- Do:
  1. From the worktree `engine/.dev/flat-nodes-06`, run `git -C ../../.. fetch origin main`.
  2. For each basename `f` of `git -C ../../.. ls-tree --name-only origin/main docs/brainstorm/assets/todoapp/plan/`, write `git -C ../../.. show origin/main:docs/brainstorm/assets/todoapp/plan/$f` to `src/apps/server/__fixtures__/todoapp/plan/$f`.
  3. Do not format the copy. `.prettierignore:5` excludes it (decision D18).
- Cite: decision D18; `docs/brainstorm/assets/todoapp/README.md:5`, `:23`.
- Verify: the copy check prints nothing. The copy check is `for f in $(git -C ../../.. ls-tree --name-only origin/main docs/brainstorm/assets/todoapp/plan/); do git -C ../../.. show "origin/main:$f" | cmp -s - "src/apps/server/__fixtures__/todoapp/plan/$(basename "$f")" || echo "$f"; done`, and `ls src/apps/server/__fixtures__/todoapp/plan | wc -l` prints `25`.

### 06.2 Add the todoapp project setup

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (create)
- Do:
  1. Add a local function `todoappProject(t, fixture)` in the test file. It runs, through `kanthord` of `src/apps/server/cli-support.ts:122`:
     1. `kanthord project create --name <unique name>`.
     2. `kanthord project binding apply <projectId> --file <file>` with the repository binding `todoapp-repo` of `repositoryBinding` (`cli-support.ts:235-259`) and `COVERING_WORKER_BINDINGS` (decision D15). Every worker binding holds `instance_count: 0` (`kanthord-checks.md:8`).
     3. `kanthord mission get <projectId>`.
  2. It answers `{ projectId, missionId, version, bindingId }`.
  3. Add a local function `planFiles(directory, edit?)`. It copies the 25 files into a temporary directory, applies `edit` to the copy and answers the paths in basename order. The fixture copy stays unchanged (`kanthord-checks.md:10`).
  4. Each row that mutates the graph calls `todoappProject` for its own project in one `gatewayFixture` (`src/apps/server/test-support.ts:316`).
- Cite: `docs/brainstorm/assets/todoapp/README.md:54-56`; `kanthord-checks.md:7-10`.
- Verify: `node --test --test-timeout=60000 src/apps/server/e2e-todoapp-plan.test.ts` runs the setup test "a fresh todoapp project holds an empty mission at version 1".

### 06.3 Prove the baseline import

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do: write the rows EF06.1 to EF06.5 of the section E2E.
- Cite: `kanthord-checks.md:16-20`, `:35`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.[1-5] ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.4 Prove the import refusals

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do:
  1. Write the rows EF06.6 to EF06.14 of the section E2E.
  2. Each row asserts that the mission version and `node list` stay unchanged after the refusal.
- Cite: `kanthord-checks.md:21-30`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.([6-9]|1[0-4]) ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.5 Prove the identity-bearing edits

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do: write the rows EF06.15 to EF06.17 of the section E2E. Each row edits the export of `kanthord mission export <missionId> --format markdown`, not the fixture copy.
- Cite: `kanthord-checks.md:31-33`; `docs/brainstorm/assets/todoapp/README.md:61-63`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.1[5-7] ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.6 Prove the dependency order and the coverage

- Files: `src/apps/server/e2e-todoapp-plan.test.ts` (edit)
- Do: write the rows EF06.18 to EF06.22 of the section E2E.
- Cite: `kanthord-checks.md:39`, `:44-45`, `:55`; `project-service.md:107-110`.
- Verify: `node --test --test-timeout=60000 --test-name-pattern 'EF06\.(1[89]|2[0-2]) ' src/apps/server/e2e-todoapp-plan.test.ts`.

### 06.E Run the gate

- Do: run the gate row 06 of `00-index.md`.
- Verify: every command of the row exits 0, and the copy check prints nothing.

## E2E

- Test file: `src/apps/server/e2e-todoapp-plan.test.ts`.
- Harness: `gatewayFixture` of `src/apps/server/test-support.ts:316`, `kanthord` of `src/apps/server/cli-support.ts:122`, and `todoappProject` and `planFiles` of task 06.2. Every act goes through the CLI. The test reads no store.
- `import <set>` means `kanthord mission import preview <missionId> <plan-file...> --file <controls>`, then `kanthord mission import apply` with the `previewDigest` and the `confirmedRetirements` of the preview.
- A refused `import <set>` exits 0 on the preview, and the preview holds the violation of the row. The apply with that digest exits 1, and its stderr starts with the code of the row (`src/mission/import-apply.ts:52-66`). Each refusal row asserts both.

| Id      | Check (`kanthord-checks.md`)                        | Commands                                                                                                                                                       | Exit      | Expect                                                                                                                                                                                                                                            |
| ------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EF06.1  | Baseline preview (`:16`)                            | `import preview` of the 25 files                                                                                                                               | 0         | no violation, no retirement, a `previewDigest`; `node list` holds no node                                                                                                                                                                         |
| EF06.2  | Atomic apply (`:17`, `:35`)                         | `import apply` of the preview; `node list <missionId>`; `edge list <missionId>`; `mission get`                                                                 | 0         | 7 nodes: 1 with `work` `report`, 6 with `work` `change`; the 6 change revisions hold 18 tasks; the 12 edges of `:35`; the mission version reads `MISSION_INITIAL_VERSION + 1`                                                                     |
| EF06.3  | Binding resolution (`:18`)                          | `node get` of each node                                                                                                                                        | 0         | each change revision pins `bindingId`; the report revision holds no binding; each task holds no `bindings`; no revision names a worker binding                                                                                                    |
| EF06.4  | Revision model (`:19`)                              | `node get` of each node                                                                                                                                        | 0         | revision 1 and attempt 0 on each node; each task id matches `^task_[0-9A-HJKMNP-TV-Z]{26}$` and holds no `revision`, `state` or `attempt`                                                                                                         |
| EF06.5  | Export round trip (`:20`)                           | `export --format markdown`; `import` of the export at the current version                                                                                      | 0, 0      | the same node ids, task ids, edges and revisions; no node takes a new revision                                                                                                                                                                    |
| EF06.6  | Unknown grammar (`:21`)                             | `import` with an unknown front-matter field in `todos.md`; then with an unknown H2 in `todos.md`                                                               | 0, 1 each | `mission.import.plan_invalid` names `todos.md`                                                                                                                                                                                                    |
| EF06.7  | Unresolved reference (`:22`)                        | `import` with `missing.md` in `depends_on` of `persistence.md`                                                                                                 | 0, 1      | `mission.import.unresolved_reference`                                                                                                                                                                                                             |
| EF06.8  | Duplicate name (`:23`)                              | `import` with `todos.md` twice                                                                                                                                 | 0, 1      | `mission.import.duplicate_file`                                                                                                                                                                                                                   |
| EF06.9  | Forbidden task key (`:24`)                          | `import` with `depends_on: []` in `todos-crud.md`; then `requires: []`; then `work: change`                                                                    | 0, 1 each | `mission.import.plan_invalid` names `todos-crud.md`                                                                                                                                                                                               |
| EF06.10 | Task on a report node (`:25`)                       | `import` with `node: todo-api.md` in `todos-crud.md`                                                                                                           | 0, 1      | `mission.import.reference_kind_invalid`                                                                                                                                                                                                           |
| EF06.11 | Binding cardinality (`:26`)                         | `binding apply` that adds a second repository binding `todoapp-mirror`; `import` with no `bindings` in `todos.md`                                              | 0; 0, 1   | `mission.node.bindings_invalid` (`mission-service.md:78`)                                                                                                                                                                                         |
| EF06.12 | Uncovered node verification (`:27`)                 | `import` without `npm run lint && npm run format:check` in `foundation-runtime.md`                                                                             | 0, 1      | `mission.import.verification_uncovered` names `foundation.md`                                                                                                                                                                                     |
| EF06.13 | Dependency cycle (`:28`)                            | `import` with `todo-api.md` in `depends_on` of `foundation.md`                                                                                                 | 0, 1      | `mission.import.cycle`                                                                                                                                                                                                                            |
| EF06.14 | Unmatched requirement (`:29`)                       | `import preview` with `requires: [platform.macos]` in `foundation.md`; then `import apply` of that preview                                                     | 0, 1      | the preview holds the violation `mission.node.requires_unmatched` for `foundation.md` with `details.claims`; the apply stderr starts with `mission.node.requires_unmatched:`                                                                      |
| EF06.15 | Stale mission version (`:30`)                       | `node update` of `todos` with a new criterion; `import apply` of an import prepared before it                                                                  | 0, 1      | stderr starts with `mission.version.conflict:`; `node get` of `todos` shows the criterion of the update                                                                                                                                           |
| EF06.16 | Pre-start task edit (`:31`)                         | `import` of the export with a new criterion in one task of `todos.md`                                                                                          | 0         | `todos` reads revision 2; the task keeps its id; no other node changes                                                                                                                                                                            |
| EF06.17 | Task omission and node retirement (`:32-33`)        | `import preview` of the export without `todos-isolation.md`; then without `todo-api.md`; `import apply` of the second preview with `confirmedRetirements`      | 0, 0, 0   | the first preview lists no retirement and no violation; the second lists exactly `todo-api`; after the apply `node get` of `todo-api` reads retired and `edge list` holds 6 edges                                                                 |
| EF06.18 | Initial order (`:39`)                               | `kanthord scheduler queue list <projectId>`                                                                                                                    | 0         | one job, of `foundation`; `todo-api` reads `Pending`; no job names a task id                                                                                                                                                                      |
| EF06.19 | Dependency order (`:44-45`)                         | `node override <foundation> --result success`; `queue list`; repeat for `persistence`, `authentication`, `todos`, `operations`, `acceptance`                   | 0         | after `foundation`, jobs of `persistence` and `operations`; after `persistence`, a job of `authentication`; `acceptance` has a job only after `todos` and `operations` complete; after the sixth override `todo-api` reads `Available` with a job |
| EF06.20 | Work lock (`:55`)                                   | `node ready <foundation>` with `expected_state: Available` and `expected_attempt: 0` in its `--file` body; `node update <foundation>` that sets `work: report` | 0, 1      | stderr starts with `mission.node.work_locked:`; `foundation` keeps its revision                                                                                                                                                                   |
| EF06.21 | Binding-set coverage (`project-service.md:107-110`) | On a fresh imported project, `binding apply` without the binding of `reviewer@1`                                                                               | 1         | stderr starts with `project.bindings.worker.node_unmatched:`; `details.node_ids` holds the seven node ids, because each node claims `Waiting`; the binding-set version does not change                                                            |
| EF06.22 | No task schedules (`:39`)                           | `queue list` after EF06.19                                                                                                                                     | 0         | no job and no execution names a `task_` id                                                                                                                                                                                                        |

## Blockers

- EF06.11 adds a second repository binding before it removes `bindings` from a change node. With one project binding, the fallback of `mission-service.md:74`, `:79` resolves the node, so the action of `kanthord-checks.md:26` writes no refusal. Plan 08 rewrites `kanthord-checks.md:26` to match (decision D26).
