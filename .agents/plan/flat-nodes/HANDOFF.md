# Handoff: flat-node Mission Service refactor

This page gives the state of the plan set on 2026-10-18 and the steps to continue it. Read `00-index.md` and `decisions.md` (D1 to D31) first. The design pages in `docs/brainstorm/` of the superrepo branch `refactor/flat-nodes` are the rule.

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

- Superrepo: #87 (design pages), #88 (rulings R15 and R16), #89 to #92 (worker thread URL, evidence placement, ruling S4), #93 (rulings of 2026-10-17 on the retirement, the storage failover and the failed transfer), #94 (prettier table alignment), #95 (`match.ts`), #96 (plan 08, tasks 08.1 to 08.10), #97 (no merge call for a contained snapshot), #98 (plan 10).
- Engine: #61 to #69 (plan set, plans 01 and 02, fixes, this page), #70 (plan 03), #71 (an import retirement keeps the tasks of the node), #72 (plan 04), #73 (plan 03b), #74 (plan 05), #75 (plan 06), #76 (this page), #77 (CLI doc fixes), #78 (plan 09a), #79 (plan 09b).
- Apps: #19 (plan 07).

The superrepo `refactor/flat-nodes` points the `engine` at the merge of #79 and the `apps` at the merge of #19.

### Open

- Tasks 08.11 and 08.12 wait for Ulrich.

### Rulings of Ulrich on 2026-10-17

- An import retirement writes no task revision on a node that it retires, also when a task moves out of it. A task of a retired node answers `mission.import.retired_id`.
- The node read keeps D4. A task edit reads the current tasks with `node revision get` at `visible_revision`.
- An unknown `work`, a nonlist `requires` and a bad trait key answer `mission.node.content_invalid` on the node API and on both import formats.
- The storage grant fails over only on `binding_disabled`, `binding_removed` and `storage.platform.s3.*`. `details.bindings` of `mission.evidence.storage_exhausted` lists the bindings with a failed upload check in the open attempt. A failed transfer goes to the complete check, and `worker.evidence_upload.transfer_failed` answers only a file above the size limit.
- D15 stays as written: the covering bindings are `coder@1` and `reviewer@1`, and each fixture enables `swe@1` and `re@1` through `enableCoveringAgents`.

### Rulings of Ulrich on 2026-10-18

- Ulrich reviewed OD1 to OD15 and approved each one, except OD2 and OD8, which the two rulings below replace.
- OD2: the CLI prints the `details` of a refusal. When `details` is not null, the CLI writes a second stderr line `details: <compact JSON>`. When `details` is null, the output does not change.
- OD8: the root `.githooks/pre-commit` does not change. Morning steps 8 to 11 make each root pointer reachable from the `origin/main` of its submodule.

### Overnight decisions

Ulrich slept from about 22:45 on 2026-10-17. The main session decided each open item with an Opus reviewer at high effort and recorded it in `.dev/overnight-decisions.md` of the superrepo main checkout (OD1 and later). Ulrich reviewed them on 2026-10-18.

- OD1 to OD3: plan 06 test rows (the task-omission apply, the `httpClient` read of refusal `details`, the exact unmatched pairs).
- OD4: plan 08 splits. Tasks 08.1 to 08.10 merge overnight. Tasks 08.11 and 08.12 wait for Ulrich.
- OD5 and OD6: the dashboard groups a "no taker" item by state, work and requires, and the scheduler board applies the full match.
- OD7 to OD9: plan 08 review items (the engine doc fixes in #77, no change to the root pre-commit hook, the "may expire" sentence).
- OD10 to OD12: plan 09a (the gateway code for a wrong form, no merge call for a contained snapshot, no contained-snapshot rule in the read-back).
- OD13 to OD15: plan 09b (no identity order for the evidence assets, the `added_files` path base, the change-request `binding_id` and the absent `kanthord.commit`).

## Morning steps for Ulrich

Plan 10 is merged. Run these steps in this order:

1. Review `.dev/overnight-decisions.md` of the superrepo main checkout.
2. In the main checkout, run `git pull --ff-only`. Then run `git submodule update`.
3. Run `git -C engine switch -c flat-nodes-accept` and `git -C apps switch -c flat-nodes-accept`. Without a named branch, `make bootstrap` refuses a submodule commit outside its `origin/main`.
4. Run tasks 08.11 and 08.12 in the main checkout, not in `.dev/flat-nodes-08-reference` of plan 08.
5. Run task 08.11. Stop `make dev`. Run `make cleanup`, then `make bootstrap`. Export and delete the homelab volume. Redeploy the homelab. Log in the LLM credential `anthropic-subscription`.
6. Run task 08.12 once on the final root head, with the engine at the merge of #82 (superrepo #99). This run also covers the CLI details line and plan 10. Plan 10 runs no live acceptance of its own (`10-root-multi-repository-docs.md:15`). If it fails, run it again at the root merge of plan 08 to find the plan that caused it.
7. Open one pull request per repository from `refactor/flat-nodes` to `main`.
8. Merge the `engine` and `apps` pull requests first. Use a merge commit, not a squash or a rebase.
9. In the superrepo, create a branch from `origin/refactor/flat-nodes`. Run `git -C engine switch main && git -C engine pull --ff-only`. Do the same for `apps`.
10. Stage `engine` and `apps`, commit, and open a pull request into `refactor/flat-nodes`. Merge it. The hook accepts this commit, because each submodule is on `main` and each pointer is on its `origin/main`.
11. Run `git fetch origin`, `git -C engine fetch origin` and `git -C apps fetch origin`. Read each pointer with `git rev-parse origin/refactor/flat-nodes:engine` and `git rev-parse origin/refactor/flat-nodes:apps`. Run `git -C engine merge-base --is-ancestor <engine pointer> origin/main`. Run the same check for `apps`.
12. If a check exits 1, do not merge the superrepo pull request. Find the cause first.
13. Merge the superrepo pull request last.

Gate row 08 (`00-index.md:97`) holds the live run. The plan 08 pull request merges before that row runs, as OD4 states.

## Open follow-ups

- `docs/brainstorm/HANDOFF.md` of the superrepo holds the open design items.
- Audit the human output of every CLI command. Some commands print bare values with no names. For example, `llm credential login` prints the session identity, the address, the code, the expiry and the mutation key as five bare lines. Show each value as a `name: value` row. Put each URL on a separate row of its own.
- These tests failed once in a full run and passed alone, so treat them as flaky until they fail again: `e2e-worker-app.test.ts:298`; `worker-pool.test.ts` "a removed binding ends its threads without a restart" and "the pool starts one instance for each slot"; two timing tests of `src/worker/unit/verification.test.ts` under parallel load.
- `docs/brainstorm/worker-service.impl.md` has no test line for the evidence-placement rule on an `implement` node whose evidence names no repository snapshot. This gap existed before ruling S4.
