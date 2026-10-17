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

Commits, on top of `origin/refactor/flat-nodes`:

- `66676ffc` feat(mission): store flat nodes with work and requires on the revision
- `efcee63a` docs: describe flat nodes in the engine map and the Scheduler CLI page
- `0d068377` docs(plan): widen D31 to every node whose evaluation checks out repositories

The first commit holds all of the code, the tests, the server fixtures, OpenAPI, the CLI and `docs/cli/mission.md`. A smaller split does not pass `tsc --noEmit`, because the type check covers the test files. The other two commits change Markdown only.

Check results at the head:

- `pnpm run verify` passes: prettier, typecheck, lint, build and 3127 of 3127 tests.
- The OpenAPI regeneration leaves `static/` unchanged.
- Both `rg` rows of gate 03 print nothing.

EF03.3: a preview lists a reference violation and answers HTTP 200. Only `import apply` stops at the violation and exits 1 (`docs/brainstorm/mission-service.impl.md:187-190`). The test asserts this.

Remaining work for plan 03:

1. Ruling S4 in the engine. `prepareSnapshot` in `src/worker/unit/workspace.ts` clones the snapshot into the workspace key, so the evidence of an `implement` evaluation lands inside the checkout. Make `prepareSnapshot` clone into `<key>/checkouts/<binding name>/` and return `key`. Place the evidence in `<key>/evidence/` when `key` and the agent root differ. Release `key`. Add a test that the snapshot checkout holds no placed asset.
2. Change row EF03.3 in `03-flat-nodes.md` to "the preview lists the violation; the apply exits 1".
3. Compare each task 03.1 to 03.18 with the commits. Run the full gate row 03.
4. Rebase onto `origin/refactor/flat-nodes`, push, and open the pull request. Then run the Opus review.

## Open follow-ups

- Plan 09b task 09b.6 cites line numbers in `src/worker/unit/evaluation-input.ts` that plan 02 moved. The executor of plan 09b re-anchors them.
- An import retirement strips the tasks of a node, but `node retire` keeps them. This behavior existed before the plan set. Raise it with Ulrich.
- `e2e-worker-app.test.ts:298` failed once in a full run and passed alone ten times. Treat it as flaky until it fails again.
- `docs/brainstorm/HANDOFF.md` of the superrepo holds the open design items.
- The worker still uses old node words outside gate 03: `static/prompt/template/evaluation.md` says "completed objective dependency", and `prepareObjective`, `WorkspaceKind.Objective` and `steps-objective.ts` remain. Plan 04 renames them.
- `worker-pool.test.ts` "a removed binding ends its threads without a restart" failed once in a full run and passed alone three times. Treat it as flaky until it fails again.
