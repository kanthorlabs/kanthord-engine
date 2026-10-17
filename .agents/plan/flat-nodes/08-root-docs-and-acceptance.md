# Plan 08: Root — reference, explanation, scripts and the acceptance run

## Scope

This plan merges pull request #87, moves the root repository `kanthorlabs/kanthord` onto the merged engine and dashboard, and runs the live acceptance. It delivers:

- The merge of pull request #87 after a rebase on root `main` and a review (R14, decision D3).
- The submodule pointers of `engine` and `apps` at the merges of plans 06 and 07.
- The ERD pages `docs/reference/erd/01-setup.md`, `02-execution.md` and the column map of `docs/reference/erd/README.md`.
- The reference pages of `docs/reference/mission/`, `docs/reference/worker/worker.md`, `docs/reference/project/binding.md`, `docs/reference/scheduler/` and the generated `docs/reference/workbench/tools.md`.
- The explanation pages, the Mac how-to and `docs/README.md:27`.
- `scripts/e2e/watch.mjs` and the todoapp fixture sync check.
- The narrowed HANDOFF item `docs/brainstorm/HANDOFF.md:36`.
- The discard of the local and the homelab databases (decision D2).
- The live `make e2e` acceptance run.

Out of scope:

- Every other design page of `docs/brainstorm/`. Pull request #87 owns them.
- The multi-repository `implement` node (plans 09a, 09b and 10). The reference pages state the limit of decision D28 until plan 10.
- The executed plan sets of `.agents/plan/`.

## Model

Opus at medium effort. The plan rewrites prose on many pages and runs a live acceptance with a real provider.

## Sources

- `docs/brainstorm/mission-service.md:27-89` — `work`, `requires`, tasks, the graph and the bindings that a node names.
- `docs/brainstorm/mission-service.md:303-314` — the storage grant and the repository evidence of an `implement` node.
- `docs/brainstorm/mission-service.impl.md:17`, `:49-62` — the task identity and the rule table by work.
- `docs/brainstorm/mission-service.impl.md:261-312` — the dependency reads and the proposal.
- `docs/brainstorm/scheduler-service.md:233-268` — the match.
- `docs/brainstorm/project-service.md:97-109` — the traits.
- `docs/brainstorm/worker-service.md:39-40`; `docs/brainstorm/worker-service.impl.md:54-55`, `:95` — the methods by work and `declared_works`.
- `docs/brainstorm/assets/todoapp/README.md:52-79` — the import preparation and the check after each merge.
- `docs/brainstorm/assets/todoapp/kanthord-checks.md:38-47` — the execution checks.
- Root `AGENTS.md:107-108` — the reference pages move with the code.
- Root `AGENTS.md:162-174` — `make sync`, `make e2e` and the browser check.

## Depends on

- Plans 03b, 06 and 07 merged to `main` of their repositories.
- Pull request #87 open, with the rulings R1 to R14. Task 08.1 merges it.

## Provides

The documented and accepted flat-node product. No seam.

## Tasks

### 08.1 Merge pull request #87 and move the submodule pointers

- Files: `docs/brainstorm/**` (merge of pull request #87), `engine`, `apps` (gitlinks)
- Do:
  1. Rebase the branch `design/flat-nodes` of pull request #87 on root `origin/main`. Push the branch with `--force-with-lease`.
  2. Ask Ulrich for the review. Merge pull request #87 after the review.
  3. Create `.dev/flat-nodes-08-reference` from the new `origin/main` (`00-index.md` "Repositories, branches and worktrees").
  4. Run `git -C engine fetch origin main && git -C engine checkout --detach origin/main`.
  5. Run `git -C apps fetch origin main && git -C apps checkout --detach origin/main`.
  6. Run `pnpm install` and `pnpm verify` in `apps/` against the engine of step 4. Before the run, diff `apps/src/api/types.ts` against `engine/static/openapi/**` of that engine, as task 07.E does. A difference blocks the task.
  7. Stage `engine` and `apps`.
  8. When the rebase changed a file of `docs/brainstorm/assets/todoapp/plan/`, the check of task 08.9 fails. Then copy the file into the engine fixture in a separate engine pull request, as task 06.1 states, and move the engine pointer again.
- Cite: R14; decision D3; root `AGENTS.md:162`.
- Verify: `gh pr view 87 --json state` answers `MERGED`; `git -C engine merge-base --is-ancestor <merge commit of plan 06> HEAD` and the same check for plan 07 in `apps` exit 0.

### 08.2 Rewrite the planning ERD

- Files: `docs/reference/erd/01-setup.md`, `docs/reference/erd/README.md` (edit)
- Do:
  1. `mission_node` (`01-setup.md:105-116`) drops `kind` and `parent_id`. Delete the relation `mission_node |o..o{ mission_node : "FK parent_id"` (`:156`).
  2. `mission_node_revision` (`:118-132`) adds `work "implement | examine"` and `requires "JSON set of trait keys"`. `tasks` reads "JSON task content, `[]` for an examine node". `node_id` reads "node".
  3. `:143` reads "node". `:204`, `:275`, `:278`, `:283`, `:285`, `:290` describe one node kind: a task is content of an `implement` node with a `task_<ulid>` identity, a retirement retires one node, and a dependency relates two nodes of one mission.
  4. `01-setup.md:196` links `mission-service.vocabulary.md#edge-kind`, an anchor that no longer exists. Link `mission-service.vocabulary.md#dependency` with the text "dependency".
  5. Add the rule of `mission.node.work_locked` and the binding rule table by work (`mission-service.impl.md:52-61`) after `01-setup.md:281`. The table states that a node names every binding, that no node takes a binding from the project, and that the storage bindings form an ordered upload list.
  6. Add the table `mission_evidence_upload_failure` of decision D29 to `02-execution.md` next to `mission_evidence_asset`.
  7. `docs/reference/erd/README.md`: the column map names `work`, `requires` and `tasks` and no `kind` or `parent_id`.
- Cite: `mission-service.md:27-89`; `mission-service.impl.md:17`, `:52-66`; decision D29.
- Verify: `rg -n -i 'initiative|objective|parent_id|containment' docs/reference/erd` and `rg -n 'edge-kind' docs/reference` print nothing; `sh scripts/docs/check.sh` passes.

### 08.3 Rewrite the execution ERD

- Files: `docs/reference/erd/02-execution.md` (edit)
- Do:
  1. `:18-19`: "An `implement` node whose attempt requires no external action completes after a current passing assessment." and the same for the requested action.
  2. Each `node_id FK "initiative or objective"` (`:80`, `:91`, `:112`, `:128`) reads `node_id FK "node"`. `:138` reads `"examine node"`.
  3. `:118` becomes `dependency_outcome_ids "JSON set, empty for an implement node and a human assessment"`.
  4. `:141-142` become `content "canonical JSON: dependency_id, name, requirement, criterion, task"` and `created_node_id FK "implement node that the approval creates, nullable"`. `:167` names `FK created_node_id`.
  5. `:195` names the fix-node proposal. `:231` adds the match: the claim admits a node only when the worker declares its state and its work and the binding traits hold its requires list.
- Cite: `mission-service.impl.md:261-312`; `scheduler-service.md:235-259`.
- Verify: `rg -n -i 'initiative|objective|child_outcome' docs/reference/erd` prints nothing.

### 08.4 Rewrite the mission reference pages

- Files: `docs/reference/mission/node.md`, `import.md`, `execution.md`, `dependency.md`, `assessment.md`, `criterion.md`, `node-control.md`, `mission.md`, `attempt.md`, `evidence.md`, `outcome.md` (edit)
- Do:
  1. `node.md`: one node shape with `work`, `requires` and `tasks`; `node list --work`; no `node move`; `mission.node.work_locked` and `mission.node.requires_unmatched` in the failures.
  2. `import.md`: the node file and the task file grammar (`mission-service.impl.md:125-151`); replace the section `#binding-inheritance` with `#bindings-of-a-node`: every node names its bindings, no node takes a binding from the project, and the rule table by work; an `implement` node with no task and the coverage rule of a node with tasks; the preview violation `mission.node.requires_unmatched`.
  3. `evidence.md`: the ordered storage list, the grant of the first working binding, the failed upload check, 409 `mission.evidence.storage_exhausted` when no binding is left (ruling R16), and the pinned read (`mission-service.md#evidence`).
  4. `execution.md`: the `mission.execution.dependency.*` reads replace the objective reads.
  5. `dependency.md`: the closure is the direct dependencies; a dependency edit on a node that left `Pending` and `Available` answers `mission.node.state_conflict`.
  6. `assessment.md`: `dependency_outcome_ids`, `dependency_node_ids`, the proposal fields `dependency_id` and `created_node_id`, and the answer `{ created, proposer }`.
  7. The other pages replace "a runnable node is an initiative or an objective" with "a node", and "an initiative" with "an `examine` node".
- Cite: root `AGENTS.md:107-108`; `engine/docs/cli/mission.md` at the engine pointer of task 08.1.
- Verify: `rg -n -i 'initiative|objective|parent_id|containment|inherit' docs/reference/mission` prints nothing.

### 08.5 Rewrite the worker, project and scheduler reference pages

- Files: `docs/reference/worker/worker.md`, `docs/reference/project/binding.md`, `docs/reference/scheduler/work.md`, `docs/reference/scheduler/execution.md`, `docs/reference/scheduler/queue.md` (edit)
- Do:
  1. `worker.md:32`, `:50`, `:65`, `:84`, `:104`: replace `required_node_format` with `declared_works`, "The works that the worker takes: `implement`, `examine`."
  2. `binding.md:103-113`: add the row `traits`, "Optional. A list of unique trait keys. Each key matches `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` and holds at most 64 bytes. An absent field reads as `[]`." State that a node names zero or more storage bindings as an ordered list and takes no binding from the project (`project-service.md:42-43`). Add the failures `project.bindings.worker.traits_invalid` and `project.bindings.worker.node_unmatched` to the section `### Failures` (`:294`).
  3. `work.md`: the work pull admits a node through the match; an unknown worker answers no work.
- Cite: `project-service.md:98-109`; `worker-service.impl.md:95`; `scheduler-service.md:235-259`.
- Verify: `rg -n 'required_node_format' docs` prints nothing.

### 08.6 Regenerate the workbench tool table

- Files: `docs/reference/workbench/tools.md` (generated)
- Do: run `make docs-tools` after task 08.1.
- Cite: root `.prettierignore:8-9`; `scripts/docs/tools.sh`.
- Verify: `CHECK=1 sh scripts/docs/tools.sh` exits 0; `rg -n -i 'initiative|objective' docs/reference/workbench/tools.md` prints nothing.

### 08.7 Rewrite the explanation pages, the how-to and the docs index

- Files: `docs/explanation/worker.md`, `docs/explanation/coder-worker.md`, `docs/explanation/native-agent.md`, `docs/explanation/architecture.md`, `docs/explanation/README.md`, `docs/how-to-guides/run-on-a-mac-with-tailscale.md`, `docs/README.md`, `docs/reference/README.md` (edit)
- Do:
  1. `worker.md` and `coder-worker.md`: "the life of an objective" becomes "the life of an `implement` node". An `implement` node with no task is its own single work unit. An `examine` node checks out the base-branch head of each repository binding that it names, runs tools and verifications, reads its direct dependencies and submits its findings.
  2. `native-agent.md:268`: "Examine (`coder@1` with `swe@1`). The agent checks out the base-branch head of each repository binding of the node, runs tools and the verifications, reads the outcome and the evidence of each direct dependency, and writes its findings as produced evidence."
  3. `architecture.md:7` keeps "containment" of the Project boundary. `:246` reads "The Mission graph holds nodes and their dependency edges. An `implement` node holds its tasks."
  4. `run-on-a-mac-with-tailscale.md`: add the section `## Run macOS nodes on this Mac` before `## Stop sharing the server`. It sets `traits: ["platform.macos"]` on the worker bindings of the Mac and `requires: [platform.macos]` on a node that needs macOS.
  5. `docs/README.md:27`: delete the paragraph. The binding resolution is implemented.
  6. `docs/reference/README.md:48` names the dependency reads.
- Cite: `worker-service.md:39-40`, `:326-331`, `:422-431`; `project-service.vocabulary.md:52-74`; `scheduler-service.vocabulary.md:56-67`.
- Verify: the `rg` of the gate row 08 prints nothing.

### 08.8 Move the e2e watch script

- Files: `scripts/e2e/watch.mjs` (edit)
- Do: delete `TASK_KIND` (`scripts/e2e/watch.mjs:18`) and the task skip (`:91`). A node list holds no task.
- Cite: `mission-service.md:40-46`.
- Verify: `node --check scripts/e2e/watch.mjs`; `node --test scripts/e2e/*.test.mjs`.

### 08.9 Add the todoapp fixture sync check

- Files: `scripts/docs/todoapp.sh` (create), `scripts/docs/check.sh` (edit)
- Do:
  1. `scripts/docs/todoapp.sh` follows `scripts/docs/prompts.sh`. For each file of `docs/brainstorm/assets/todoapp/plan/*.md`, it compares the file with `engine/src/apps/server/__fixtures__/todoapp/plan/<name>` through `cmp -s`. A difference prints "`docs/brainstorm/assets/todoapp/plan/<name>` differs from `engine/src/apps/server/__fixtures__/todoapp/plan/<name>`. Copy the design text." and exits 1.
  2. It also fails when the engine copy holds a file that the design set lacks.
  3. `scripts/docs/check.sh` runs `sh "$REPO/scripts/docs/todoapp.sh"` after `prompts.sh`.
- Cite: decision D18.
- Verify: `sh scripts/docs/todoapp.sh` exits 0; after a one-byte edit of a temporary copy of the engine fixture it exits 1.

### 08.10 Narrow the HANDOFF item

- Files: `docs/brainstorm/HANDOFF.md` (edit)
- Do: replace the item of `HANDOFF.md:36` with one item "multi-repository implement node (plans 09a, 09b and 10)". Plans 01 to 08 implement the rest of the item. Plan 10 deletes the new item.
- Cite: decision D1.
- Verify: `sh scripts/docs/check.sh` passes; `rg -n 'Implement the flat-node model' docs/brainstorm/HANDOFF.md` prints nothing; `rg -n 'multi-repository implement node' docs/brainstorm/HANDOFF.md` prints one line.

### 08.11 Discard the local and the homelab databases

- Files: none
- Do:
  1. Stop every `make dev` of the main checkout and of other worktrees. Run the steps of tasks 08.11 and 08.12 from `.dev/flat-nodes-08-reference`. Run `make cleanup`, then `make bootstrap` there (decision D2).
  2. On the homelab, export the volume: `podman volume export kanthord-homelab -o .dev/backup/kanthord-homelab-<yymmdd>.tar`.
  3. Run `make homelab-cleanup` and confirm the volume removal.
  4. Run `IMAGE=kanthord-base-path make release-image`, then `IMAGE=kanthord-base-path:latest make homelab-kanthord`.
  5. Create the LLM credential again with `kanthord llm credential login anthropic-subscription --name anthropic-subscription` (`docs/brainstorm/assets/todoapp/README.md:54`).
- Cite: decision D2.
- Verify: `make dev` starts with no `system.config.version_behind`; the homelab dashboard at `http://homelab.kanthorlabs.com/s/kanthord/` opens with an empty project list.

### 08.12 Run the live acceptance

- Files: none
- Do:
  1. From `.dev/flat-nodes-08-reference`, run `make e2e RUN=flat-nodes PAUSED=0`. The default `PAUSED=1` pauses the project, so no worker claims a node (`scripts/e2e/start.sh:7`). It applies the worker bindings before the import (`scripts/e2e/start.mjs:183-222`).
  2. Run `make e2e-watch RUN=flat-nodes` until `foundation` reads `Completed`.
  3. Record the execution checks 1 to 3 and 6 of `kanthord-checks.md:40-45` with their identities, as the report template of `kanthord-checks.md:62-64` states.
  4. Run `make e2e-check RUN=flat-nodes`.
  5. Run `make e2e-stop RUN=flat-nodes`.
- Cite: root `AGENTS.md:163-169`; `docs/brainstorm/assets/todoapp/README.md:77-79`.
- Verify: `foundation` reaches `Completed`; `make e2e-check` prints `RESULT pass`; only `persistence`, `operations` and `contributing` take a job after `foundation`.

### 08.E Run the gate

- Do: run the gate row 08 of `00-index.md`. Open the pull request with the report of task 08.12.
- Verify: every command of the row exits 0, and each `rg` prints nothing.

## E2E

The live acceptance of task 08.12 is the E2E of this plan. It needs a real provider and the tokens of `engine/.env.e2e` (root `AGENTS.md:170`), so it stays outside every automatic gate.

| Id     | Command                              | Expect                                                                                     |
| ------ | ------------------------------------ | ------------------------------------------------------------------------------------------ |
| EF08.1 | `make e2e RUN=flat-nodes PAUSED=0`   | the import applies 8 nodes and 18 tasks; `foundation` takes the only job                   |
| EF08.2 | `make e2e-watch RUN=flat-nodes`      | `foundation` moves `Available` → `Executing` → `Waiting` → `Completed`                     |
| EF08.3 | `kanthord scheduler queue list <id>` | after `foundation` completes, jobs of `persistence`, `operations` and `contributing` alone |
| EF08.4 | `make e2e-check RUN=flat-nodes`      | `RESULT pass`                                                                              |

## Blockers

None.
