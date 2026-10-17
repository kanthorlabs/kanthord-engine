# Handoff: flat-node Mission Service refactor

This page gives the state of the plan set on 2026-10-17 and the steps to continue it. Read `00-index.md` and `decisions.md` (D1 to D31) first. The design pages in `docs/brainstorm/` of the superrepo branch `refactor/flat-nodes` are the rule.

## Branch model

Ulrich ruled this model for the refactor. It replaces the `origin/main` base and the pull request to `main` that `00-index.md` names.

- Each of the superrepo, `engine` and `apps` has the integration branch `refactor/flat-nodes`.
- Create each plan worktree from `origin/refactor/flat-nodes` of its repository. Use the worktree and branch names of `00-index.md`.
- Open each pull request with `--base refactor/flat-nodes`. Merge it into that branch after a review.
- Never commit, push or merge to `main`. At the end, open one pull request per repository from `refactor/flat-nodes` to `main`. Ulrich reviews and merges those.
- When a repository rule refuses a push, stop and report it to Ulrich.

## Protocol per plan

1. An executor implements the plan in its worktree and opens the pull request.
2. An Opus reviewer at high effort reviews the pull request against the plan and the design pages.
3. The executor applies every `action:YES` finding.
4. The pull request merges into `refactor/flat-nodes`. The next plan starts.

The order and the model of each plan are in `00-index.md`. Plan 03b starts after plan 03 merges, runs in parallel with plans 04 to 07, and merges before plan 08.

Raise an item that needs a ruling with Ulrich, one item at a time. Do not guess a ruling.

## Worktree setup

- In an engine worktree, run `pnpm install --frozen-lockfile` and `pnpm run pi-tools:fetch` before the first check. Without `.pi-tools/`, two tests in `worker-thread.test.ts` fail with "fd: binary source is absent".
- Run the tests with `TMPDIR` set to a writable directory.
- Use the repository prettier for Markdown.

## State

### Merged into `refactor/flat-nodes`

- Superrepo: #87 (design pages), #88 (rulings R15 and R16), #89 (worker thread URL from the executable), #90 (evidence placement of an `examine` node).
- Engine: #61 (plan set), #62 (plan 01), #63 (rulings R15 and R16 in the plans), #64 (TMPDIR test fix), #65 (plan 02), #66 (cwd of the release bundle test).

### Open

- Superrepo #91, branch `docs/flat-nodes-03-evidence-placement`. It widens the evidence placement rule to every node with repository bindings (ruling S4, decision D31). It has no review yet. Review it, then merge it.
- Engine branch `feat/flat-nodes-03-flat` (plan 03). It is pushed and has no pull request yet.

### Plan 03 on `feat/flat-nodes-03-flat`

Commits:

- `73025c88` feat(mission): store flat nodes with work and requires on the revision
- `0c9ce952` feat(worker): read the work of the pinned revision
- `48a98cee` feat(cli): filter the node list by work and remove node move
- `3f2bf505` feat(openapi): regenerate the flat node operations
- `31dcff2f` docs(cli): describe flat nodes with work and requires
- `ac8456fb` test(server): move the server fixtures to flat nodes, work in progress

The last commit holds task 03.16 in progress and the D31 change for ruling S4. Fold it into its task commits before the merge, so that each commit is green.

Check results at `ac8456fb`:

- `tsc --noEmit` passes.
- The tests give 3122 pass and 3 fail of 3125:
  - `EF03.3 a task file that names an examine node is refused` (`src/apps/server/e2e-mission-service.test.ts:2386`). The import does not refuse that task file.
  - Its parent journey `EF03.1-EF03.8 flat nodes carry their work through the CLI`.
  - `src/apps/server/worker-thread.test.ts` stopped with a V8 fatal error (`Check failed: jit_page_->allocations_.erase(addr) == 1`). Run it again alone before you treat it as a fault.
- The first `rg` row of gate 03 finds `src/apps/server/migrations.test.ts:221`. That line asserts that `kind` and `parent_id` are absent, so adjust the assertion or the gate pattern.
- The second `rg` row finds `objective` and `Initiative` in `docs/cli/mission.md` (for example lines 826 and 916). Task 03.18 is not complete.

Remaining work for plan 03:

1. Fix EF03.3, then complete task 03.16.
2. Complete task 03.18 until the gate `rg` rows print nothing.
3. Ruling S4 in the engine: check that the evaluation of an `implement` node with an evidence snapshot places the produced evidence in `<workspace>/evidence/` and keeps the snapshot checkout clean (`src/worker/unit/evaluation-input.ts`, near the `placement` constant). Add a test for that case.
4. Compare each task 03.1 to 03.18 with the commits. Run the full gate row 03.
5. Fold the work-in-progress commit. Rebase onto `origin/refactor/flat-nodes`, push, and open the pull request.

## Open follow-ups

- Plan 09b task 09b.6 cites line numbers in `src/worker/unit/evaluation-input.ts` that plan 02 moved. The executor of plan 09b re-anchors them.
- An import retirement strips the tasks of a node, but `node retire` keeps them. This behavior existed before the plan set. Raise it with Ulrich.
- `e2e-worker-app.test.ts:298` failed once in a full run and passed alone ten times. Treat it as flaky until it fails again.
- `docs/brainstorm/HANDOFF.md` of the superrepo holds the open design items.
