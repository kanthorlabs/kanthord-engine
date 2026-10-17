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

- Superrepo: #87 (design pages), #88 (rulings R15 and R16), #89 (worker thread URL from the executable), #90 and #91 (evidence placement, ruling S4), #92 (review wording of #91).
- Engine: #61 (plan set), #62 (plan 01), #63 (rulings R15 and R16 in the plans), #64 (TMPDIR test fix), #65 (plan 02), #66 (cwd of the release bundle test), #67 and #68 (this page).

### Open

- Engine branch `feat/flat-nodes-03-flat` (plan 03). It is pushed, complete and green, and has no pull request yet.

### Plan 03 on `feat/flat-nodes-03-flat`

Commits, on top of `origin/refactor/flat-nodes`:

- `66676ffc` feat(mission): store flat nodes with work and requires on the revision
- `efcee63a` docs: describe flat nodes in the engine map and the Scheduler CLI page
- `0d068377` docs(plan): widen D31 to every node whose evaluation checks out repositories
- `2a50324c` feat(worker): place the evidence of a snapshot evaluation outside its checkout
- `8c53fea8` docs(plan): state the preview and apply answers of row EF03.3

The first commit holds all of the code, the tests, the server fixtures, OpenAPI, the CLI and `docs/cli/mission.md`. A smaller split does not pass `tsc --noEmit`, because the type check covers the test files.

Check results at `8c53fea8`:

- `pnpm run verify` passes: prettier, typecheck, lint, build and 3128 of 3128 tests.
- The OpenAPI regeneration leaves `static/` unchanged.
- `pnpm exec prettier --check docs/cli/*.md` passes.
- Both `rg` rows of gate 03 print nothing.

Deviations from the plan text:

- `workOf(tx, nodeId, revision)` replaces the `nodeKindOf` seam of D30, as D30 permits.
- The node read answers `tasks` at the claim revision, together with `work` and `requires` (D4).
- EF03.3: the preview lists a reference violation and answers HTTP 200. Only `import apply` exits 1 (`docs/brainstorm/mission-service.impl.md:187-190`).

Next steps:

1. Rebase onto `origin/refactor/flat-nodes` if it moved, and open the pull request with `--base refactor/flat-nodes`.
2. Run the Opus review, apply every `action:YES` finding, and merge.
3. Start plan 03b and plan 04.

## Open follow-ups

- Plan 09b task 09b.6 cites line numbers in `src/worker/unit/evaluation-input.ts` that plan 02 moved. The executor of plan 09b re-anchors them.
- `e2e-worker-app.test.ts:298` failed once in a full run and passed alone ten times. Treat it as flaky until it fails again.
- `docs/brainstorm/HANDOFF.md` of the superrepo holds the open design items.
- The worker still uses old node words outside gate 03: `static/prompt/template/evaluation.md` says "completed objective dependency", and `prepareObjective`, `WorkspaceKind.Objective` and `steps-objective.ts` remain. Plan 04 renames them.
- `worker-pool.test.ts` "a removed binding ends its threads without a restart" failed once in a full run and passed alone three times. Treat it as flaky until it fails again.
- `docs/brainstorm/worker-service.impl.md` has no test line for the evidence-placement rule on an `implement` node whose evidence names no repository snapshot. This gap existed before ruling S4.
