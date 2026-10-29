# Handoff: suite pass record plan set

This page gives the state of the plan set on 2026-10-30. Every plan of the set is merged. Read `00-index.md` and `decisions.md` first. The design pages in `docs/brainstorm/` of the root repository `main` are the rule.

## The problem

The worker-routing dogfood run on homelab measured the time of one node that lists the whole engine suite:

- One run of the whole suite takes about 8 minutes.
- A coder execution takes 47 to 56 minutes. The verifications take 29 minutes of it.
- A reviewer evaluation takes about 22 minutes. The verifications take 20 minutes of it.
- One node runs the whole suite 6 to 7 times: in the coder task run, the coder release gate, the coder `bash` tool, the reviewer, CI `check` and the host suite after the merge.

The plan set `dogfood-time/` removes the repeated runs inside the worker: the result copy and the own commands. After it, CI `check` still runs every test file on every pull request.

Root pull requests #275 and #277 record the rulings of Ulrich for the rest:

- The suite pass record lets CI skip each test file that passed before on the same inputs.
- The floor is the set of test files whose import closure holds every production file. No selection can skip a floor file, so its test time is the lower bound of a run.
- `test_floor_share` shows the floor time as a share of the whole test time, so a human sees how much time a selection can save.
- The suite pass proposal offers the record to a repository binding that has none.

Ruling O4 of `dogfood-time/` gives these rules to this plan set. These rules are design features of #277. They are not findings of the dogfood run.

## Protocol per plan

1. Before each build, fetch engine and apps `main`. If an open pull request or a merged commit covers the same plan, stop.
2. An executor builds the plan in its worktree from `00-index.md` and opens the pull request. The tests of task `NN.1` fail before the change.
3. An Opus reviewer reviews the pull request against the plan, `decisions.md` and the design pages.
4. The executor applies each `action:YES` finding. A short second review checks the fixes.
5. A plan with no gate file change merges after the review and a green CI. Ulrich lands each plan that changes a gate file (decision D10).

## State

### Merged

- Engine #377 (the plan set), #382 (the dirty-tree rule in D8 and plan 06).
- Plan 01: engine #378, built by another session.
- Plan 02: engine #380. The worker accepts the affected report version 2 with `floor`. The affected span writes `kanthord.affected.floor_count`, `floor_seconds` and `total_seconds`.
- Plan 03: engine #381. The measure `test_floor_share` of `tracking.analytics.duration`, the OpenAPI document and `docs/cli/tracking.md`.
- Plan 04: apps #146. The `Test floor share` row of the `Time` section of `/analytics`.
- Plan 05: engine #383. The engine selector writes the version 2 report with `floor`. The production set is the import closure of `src/main.ts`: 622 files. The floor holds 83 test files.
- Plan 07: apps #145. One record for the whole apps tree, the CI record cache, the job summary and the nightly full run. A dirty tree without `--write` runs every test. The CI re-run on a clean tree skipped the test run and printed `Saved share: 100%`.
- Root #281 (the rulings O1 to O3, S1, S6 and S8 in the design pages) and #282 (a dirty work tree reads no record).
- Plan 06: engine #385. The suite pass record of the engine, the CI record cache and the nightly full run. A file that skips a test gets no record.
- Engine #386 and apps #148: the test fixes of the plan 02, 03 and 04 reviews.
- Apps #147: the plan 07 fixes. The script checks the tree after each write run.
- Engine #387: plan 05 S1. The floor uses the graph of the selection.
- Plan 08: root #285. The explanation pages.
- Root #284: the base branch sentence of `project-service.impl.md`. A pull request cache never reaches the base branch.
- Plan 09: engine #388. The suite pass proposal, its read, its CLI leaf and the shipped plan `suite-pass-setup`. Engine #389: an error with no code of the stored suite pass read fails the read.
- Plan 10: apps #149. The dashboard line and the action `Add setup node`.
- Root #286 (the root handoff item of plans 09 and 10 deleted) and #287 (the root pointers of `engine` and `apps`).

## Open items

- A repository with no `src/main.ts` has an empty production set, so each run test file counts as a floor file (engine #383, review S1, action:NO). Only test fixtures reach this case. A change needs a ruling of Ulrich.
