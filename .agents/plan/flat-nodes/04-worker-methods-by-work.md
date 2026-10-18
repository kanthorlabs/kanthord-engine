# Plan 04: Worker Service — the method names follow the work

## Scope

This plan renames the files and the symbols of the worker unit after the work of the node (decision D17). It changes no behavior, no operation, no record and no workspace path.

Out of scope:

- Every semantic change. Plan 03 already selects the method form by `work`.
- `static/`. The prompt templates changed in plan 02.

## Model

Sonnet at high effort. The rename table of decision D17 settles every name.

## Sources

- `docs/brainstorm/worker-service.md:39-40` — each method holds one form for each work.
- `docs/brainstorm/worker-service.md:289-301`, `:310-359`, `:422-433` — the workspace and the steps method of an `implement` node and of an `examine` node.
- `docs/brainstorm/worker-service.impl.md:512`, `:516`, `:580-582` — `startCheck`, the unblock reads and the workspace of an `implement` node.
- `docs/brainstorm/architecture.impl.md:117-120` — the workspace path templates.
- `engine/AGENTS.md:219-221` — the rows of the worker unit files.

## Depends on

- Plan 03 merged.

## Provides

The names of decision D17. No seam changes.

## Tasks

### 04.1 Rename the steps form of an `implement` node

- Files: `src/worker/unit/steps-objective.ts` → `src/worker/unit/steps-implement.ts`; `steps-objective.test.ts`, `steps-objective-check.test.ts`, `steps-objective-release.test.ts` → `steps-implement.test.ts`, `steps-implement-check.test.ts`, `steps-implement-release.test.ts`; `src/worker/unit/native-method.ts`, `src/worker/unit/base-refresh.ts`, `src/worker/unit/steps-initiative.ts` (edit)
- Do:
  1. `git mv` each file.
  2. Rename `runStepsObjective` → `runStepsImplement`, `finishObjective` → `finishImplement`, `settleObjective` → `settleImplement`, `startObjective` → `startImplement`, `objectiveDirectoryOf` → `nodeDirectoryOf` (`src/worker/unit/steps-objective.ts:65`, `:84`, `:192-230`, `:507-508`).
  3. Update the imports of `native-method.ts:33-34`, `base-refresh.ts:14` and `steps-initiative.ts:12`.
- Cite: decision D17; `worker-service.md:310`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/steps-implement.test.ts src/worker/unit/steps-implement-check.test.ts src/worker/unit/steps-implement-release.test.ts`.

### 04.2 Rename the steps form of an `examine` node

- Files: `src/worker/unit/steps-initiative.ts` → `src/worker/unit/steps-examine.ts`; `steps-initiative.test.ts` → `steps-examine.test.ts`; `src/worker/unit/native-method.ts` (edit)
- Do: `git mv` both files. Rename `runStepsInitiative` → `runStepsExamine` (`src/worker/unit/steps-initiative.ts:22`). Update `native-method.ts:114-115`.
- Cite: decision D17; `worker-service.md:422-433`.
- Verify: `node --test --test-timeout=30000 src/worker/unit/steps-examine.test.ts src/worker/unit/native-method.test.ts`.

### 04.3 Rename the workspace kinds and keys

- Files: `src/worker/unit/workspace.ts`, `src/worker/unit/judged-tasks.ts`, `src/worker/unit/steps-implement.ts`, `src/worker/unit/steps-examine.ts`, `src/worker/unit/native-method.ts`, `src/worker/unit/evaluation-input.ts`, `src/worker/unit/index.ts` and their tests (edit)
- Do:
  1. `WorkspaceKind.Objective` (`src/worker/unit/workspace.ts:23-26`) becomes `WorkspaceKind.Node` with the value `"node"`.
  2. `objectiveKey` → `nodeKey`, `objectiveDirectory` → `nodeDirectory`, `prepareObjective({ objectiveId })` → `prepareImplement({ nodeId })`, `prepareInitiative` → `prepareExamine` (`:55-79`, `:149`, `:227`).
  3. The parameter `objectiveDirectory` of `judged-tasks.ts:19-42` becomes `nodeDirectory`.
  4. Keep the path `workspaces/<node identity>/<repository binding identity>/` of an `implement` node. Plan 09b moves it to `checkouts/<binding name>/` (decision D28). A test asserts it.
- Cite: `worker-service.impl.md:580-582`; `architecture.impl.md:117-120`; decision D17.
- Verify: `node --test --test-timeout=30000 src/worker/unit/workspace.test.ts`.

### 04.4 Rename the remaining symbols and texts

- Files: `src/worker/unit/report-facts.ts`, `src/worker/unit/judgement.ts`, `src/worker/unit/evaluation.ts`, `src/worker/unit/node-reads.ts`, `src/worker/unit/method-telemetry.ts`, `src/worker/**/*.test.ts` (edit)
- Do:
  1. Rename each remaining local name, constant, test name and message text that holds `objective` or `initiative` in `src/worker/` to the name of the work or of the node.
  2. Rename no field of a record, a span attribute or an operation.
- Cite: decision D17.
- Verify: `rg -n -i 'initiative|objective' src/worker` prints nothing; `node --test --test-timeout=30000 'src/worker/**/*.test.ts'`.

### 04.5 Update the engine map

- Files: `AGENTS.md` (edit)
- Lane: main session (decision D20).
- Do: rewrite the rows of `AGENTS.md:159` ("Pinned revisions, attempts and direct-dependency outcomes"), `:219` ("Bounded pinned-context and dependency reads"), `:220` (`steps-implement.ts`, "Start checks, task revisions and implement-node publication") and `:221` (`steps-examine.ts`, "Dependency outcome report and examine-node release").
- Cite: `engine/AGENTS.md:219-221`.
- Verify: `pnpm exec prettier --check AGENTS.md`.

### 04.E Run the gate

- Do: run the gate row 04 of `00-index.md`.
- Verify: every command of the row exits 0, and each check prints nothing.

## E2E

No new row. `e2e-native-methods.test.ts` and `e2e-native-runtime.test.ts` run unchanged and prove that the rename keeps the behavior.

## Blockers

None.
