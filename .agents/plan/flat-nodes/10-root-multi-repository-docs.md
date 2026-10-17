# Plan 10: Root — the multi-repository reference and the engine pointer

## Scope

This plan moves the root repository onto the engine of plan 09b and documents the multi-repository `implement` node. It delivers:

- The `engine` pointer at the merge of plan 09b.
- The reference pages without the limit of decision D28.
- The checkout layout by count on the explanation pages.
- The close of the HANDOFF item that task 08.10 narrowed.

Out of scope:

- Every engine change. Plans 09a and 09b own them.
- A live `make e2e` run. The todoapp fixture names one repository binding on each node, so plan 08 already accepts its path.

## Model

Sonnet at high effort. The plan deletes a limit and adds one layout rule on four pages.

## Sources

- `docs/brainstorm/mission-service.md:73-87` — an `implement` node names one or more repository bindings.
- `docs/brainstorm/mission-service.impl.md:57-61` — the rule table.
- `docs/brainstorm/worker-service.md:289-301` — the workspace layout rule.
- `docs/brainstorm/worker-service.impl.md:580-587` — the checkout path and the agent root.
- Root `AGENTS.md:107-108` — the reference pages move with the code.

A design citation names a line of root `main` after task 08.1, or a section anchor.

## Depends on

- Plan 09b merged to `main` of the engine.

## Provides

The documented multi-repository product. No seam.

## Tasks

### 10.1 Move the engine pointer

- Files: `engine` (gitlink)
- Do:
  1. Create `.dev/flat-nodes-10-multi-repo-docs` from root `origin/main` (`00-index.md` "Repositories, branches and worktrees").
  2. Run `git -C engine fetch origin main && git -C engine checkout --detach origin/main`.
  3. Stage `engine`.
- Cite: root `AGENTS.md:162`.
- Verify: `git -C engine merge-base --is-ancestor <merge commit of plan 09b> HEAD` exits 0.

### 10.2 Delete the limit from the reference pages

- Files: `docs/reference/mission/node.md`, `docs/reference/mission/import.md`, `docs/reference/erd/01-setup.md` (edit)
- Do:
  1. `node.md` and `import.md`: delete the limit sentence of decision D28. State that an `implement` node names one or more repository bindings, and that the convention is one binding.
  2. `01-setup.md`: the rule table of the bindings of a node reads `1 or more` in the cell of the repository kind and the work `implement`.
- Cite: `mission-service.md:77-81`; `mission-service.impl.md:59`.
- Verify: `rg -n 'exactly one repository binding' docs/reference` prints nothing.

### 10.3 Add the checkout layout to the explanation pages

- Files: `docs/explanation/coder-worker.md`, `docs/explanation/worker.md` (edit)
- Do:
  1. State the layout by count: one repository binding uses its checkout as the agent root; two or more use `checkouts/<binding name>/`, and `checkouts/` is the agent root.
  2. State that the task commit of a node with two or more bindings is the set of the heads of its node branches, and that each required action resolves on its own.
- Cite: `worker-service.md:289-292`, `:326-331`; `mission-service.md:569-571`.
- Verify: `sh scripts/docs/check.sh` passes.

### 10.4 Close the HANDOFF item

- Files: `docs/brainstorm/HANDOFF.md` (edit)
- Do: delete the item "multi-repository implement node (plans 09a, 09b and 10)" that task 08.10 wrote.
- Cite: decision D1.
- Verify: `rg -n 'multi-repository implement node' docs/brainstorm/HANDOFF.md` prints nothing.

### 10.E Run the gate

- Do: run the gate row 10 of `00-index.md`.
- Verify: every command of the row exits 0, and each `rg` prints nothing.

## E2E

No E2E row. The rows EF09b.1 to EF09b.5 of plan 09b prove the behavior in the engine.

## Blockers

None.
