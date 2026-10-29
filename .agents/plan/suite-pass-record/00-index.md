# Plan 00: Index

## Scope

Ulrich ruled on 2026-10-29 to run the full suite once for each node execution (root pull request #275). Root pull request #277 wrote the rulings into the design pages. The plan set `dogfood-time/` builds the result copy and the own commands. Ruling O4 of that set (option A) gives every other rule of root pull requests #275 and #277 to this set.

This set plans these rules:

- Plan 01: the verification memo (root `docs/brainstorm/worker-service.impl.md:1482-1495`, test line `:1462`). Done by `kanthorlabs/kanthord-engine` pull request #378, merged as `14c241d6`. Root pull request #280 added two rules of the memo to the design page.
- Plan 02: the affected report version 2 with `floor` at the worker (`worker-service.impl.md:1595-1611`), and the floor span attributes (`docs/brainstorm/tracking-service.impl.md:86-88`). The ruling of root pull request #275 says that the worker accepts version 2 before a repository writes it.
- Plan 03: the measure `test_floor_share` of `tracking.analytics.duration` (`tracking-service.impl.md:347`, `:352`, `:358`).
- Plan 04: the `Test floor share` row of the `Time` section of `/analytics` (`docs/brainstorm/architecture.impl.md:1551`, `:1555`).
- Plan 05: the floor in the report of the engine selector (`worker-service.impl.md:1596-1597`).
- Plan 06: the suite pass record of the engine repository (`docs/brainstorm/project-service.impl.md:403-435`, `worker-service.impl.md:1539-1540`).
- Plan 07: the suite pass record of the apps repository (same sources).
- Plan 08: the remainder of root `docs/brainstorm/HANDOFF.md:89` in the root pages `docs/explanation/worker-contract.md` and `docs/explanation/coder-worker.md`, with the result copy in `docs/explanation/worker.md`.
- Plan 09: the suite pass proposal of the engine: `suite_pass` in `project.binding.environment.get`, the shipped plan `suite-pass-setup` and its read `project.binding.suite_pass.plan.get` with its CLI leaf (`docs/brainstorm/project-service.impl.md:373`, `:633-642` at root pull request #281).
- Plan 10: the dashboard line and the action `Add setup node` (`project-service.impl.md:803` at root pull request #281).

Plans 06 and 07 also add `.kanthord/suite-pass.json` and `.github/workflows/ci.yml` to `gate_files` of the engine and the apps declaration. That is the first part of `HANDOFF.md:89`.

## Out of scope

- The result copy and the own commands. Plans 01 and 02 of `dogfood-time/` own them.
- The engine prompt `static/prompt/swe@1.md`. Plan 03 of `dogfood-time/` owns it.
- The trend of `Test floor share` on the dashboard. The ruling of root pull request #275 says that the dashboard shows it later.
- Records that a developer or KanthorD writes (`project-service.impl.md:413`).
- An import graph for the apps selector. The apps selector gives no import graph, so apps uses one record for the whole tree (decision D9).

## Plans

Each plan is one pull request and ends green. Plan 01 is done. Plans 02, 03 and 07 have no start condition. Plan 04 starts after plan 03 merges. Plan 05 starts after plan 02 merges. Plan 06 starts after plan 05 lands. Plan 08 starts after plans 02, 06 and 07 land. Plan 09 starts after plans 06 and 07 land. Plan 10 starts after plan 09 merges.

| Plan | File                          | Repository                    | Model        | Landing | Start condition            | Component                             | Boundary                                                                                                                                                                                                                                                                  |
| ---- | ----------------------------- | ----------------------------- | ------------ | ------- | -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `01-verification-memo.md`     | `kanthorlabs/kanthord-engine` | Opus, medium | Aelita  | Done: engine #378          | Worker unit — verification run        | One memo for each claim in the steps state; the runner reads and writes it in the contexts `task`, `node` and `release`; a hit writes no span and counts in `ran`; the evaluation reads no memo.                                                                          |
| 02   | `02-affected-report-floor.md` | `kanthorlabs/kanthord-engine` | Sonnet, high | Aelita  | None                       | Worker unit — affected test run       | The strict report schema takes `version` 1 or 2 and the optional `floor` of version 2; the affected span ends with `kanthord.affected.floor_count`, `floor_seconds` and `total_seconds`.                                                                                  |
| 03   | `03-test-floor-share.md`      | `kanthorlabs/kanthord-engine` | Sonnet, high | Aelita  | None                       | Tracking Service — analytics          | `test_floor_share` joins the measure set; its item holds `key`, `bucket_start`, `count` and `share`; the OpenAPI document and `docs/cli/tracking.md` follow.                                                                                                              |
| 04   | `04-dashboard-floor-share.md` | `kanthorlabs/kanthord-apps`   | Sonnet, high | Aelita  | Plan 03 merged             | Dashboard — analytics page            | The measure select holds `Test floor share`; its row shows the count, the share as a percent and one bar from 0 to 1; `mock/` serves the measure.                                                                                                                         |
| 05   | `05-selector-floor.md`        | `kanthorlabs/kanthord-engine` | Sonnet, high | Ulrich  | Plan 02 merged             | Engine repository — affected selector | The reporter writes the test time of each file; the selector writes version 2 with `floor` from its import graph; `floorOf` and the closure of a file become exports for plan 06.                                                                                         |
| 06   | `06-engine-suite-pass.md`     | `kanthorlabs/kanthord-engine` | Opus, medium | Ulrich  | Plan 05 landed             | Engine repository — CI and suite pass | `scripts/suite-pass.mjs` keys, skips and records each test file; `.kanthord/suite-pass.json`; the gitignore exception; `ci.yml` with the record cache, the job summary and the nightly run; `gate_files`.                                                                 |
| 07   | `07-apps-suite-pass.md`       | `kanthorlabs/kanthord-apps`   | Sonnet, high | Ulrich  | None                       | Apps repository — CI and suite pass   | One record for the whole tree; `scripts/suite-pass.mjs`; `.kanthord/suite-pass.json`; the gitignore exception; `ci.yml` with the record cache, the job summary and the nightly run; `gate_files`.                                                                         |
| 08   | `08-explanation-pages.md`     | `kanthorlabs/kanthord`        | Sonnet, high | Aelita  | Plans 02, 06 and 07 landed | Root — explanation and how-to pages   | The floor attributes in `worker-contract.md`; the live run, the result copy, the memo and the release gate in `coder-worker.md`; report version 2 in `declare-affected-tests.md`; the copy in `worker.md`; the `HANDOFF.md:89` item becomes one item for plans 09 and 10. |
| 09   | `09-suite-pass-proposal.md`   | `kanthorlabs/kanthord-engine` | Opus, medium | Aelita  | Plans 06 and 07 landed     | Project Service — suite pass proposal | `suite_pass` in `project.binding.environment.get`; the shipped plan `suite-pass-setup`; the read `project.binding.suite_pass.plan.get`; the CLI leaf `environment suite-pass plan`, the OpenAPI document and `docs/cli/project.md`.                                       |
| 10   | `10-dashboard-suite-pass.md`  | `kanthorlabs/kanthord-apps`   | Sonnet, high | Aelita  | Plan 09 merged             | Dashboard — binding environment       | The line and the action `Add setup node` of `project-service.impl.md:803` in the `Environment` section of the binding sheet; the node create; `mock/`.                                                                                                                    |

"Landing" names the person who merges the pull request. Aelita merges a plan with no gate file change after review. Ulrich lands each plan that changes a gate file of a `.kanthord/affected-tests.json` at its base (decision D10).

**Rationale for order.**
Plan 01 is done by engine pull request #378, after plans 01 and 02 of `dogfood-time/` merged (decision D2). Plan 05 writes version 2, and the worker accepts version 2 only after plan 02 (ruling of root pull request #275). Plan 06 imports `floorOf`, the closure and the test time of plan 05. Plan 04 follows the contract of plan 03. Plan 07 shares no file with another plan. Plan 08 describes the merged behavior of plans 01, 02, 06 and 07, and replaces the `HANDOFF.md:89` item with one item for plans 09 and 10 after both `gate_files` changes land. The shipped plan of plan 09 names the record steps of plans 06 and 07. Plan 10 follows the contract of plan 09.

## Repositories, branches and worktrees

A second session also builds in engine `main`. The first pull request that merges wins. Before each build, fetch engine `main`. If an open pull request or a merged commit covers the same plan, stop and report it.

Create each worktree from `origin/main` of its repository. The worktree directory `.dev/<name>` matches the branch `<type>/<name>`. Never commit to `main`. Push the branch and open a pull request to `main`. Merge only after review (root `CLAUDE.local.md` "Commits"). When a repository rule refuses a push, stop and report it.

| Plan | Repository root | Worktree                            | Branch                       | Command                                                                                                                                                                            |
| ---- | --------------- | ----------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `engine/`       | `engine/.dev/verification-memo`     | `feat/verification-memo`     | `git -C engine fetch origin && git -C engine worktree add -b feat/verification-memo .dev/verification-memo origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch`         |
| 02   | `engine/`       | `engine/.dev/affected-report-floor` | `feat/affected-report-floor` | `git -C engine fetch origin && git -C engine worktree add -b feat/affected-report-floor .dev/affected-report-floor origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch` |
| 03   | `engine/`       | `engine/.dev/test-floor-share`      | `feat/test-floor-share`      | `git -C engine fetch origin && git -C engine worktree add -b feat/test-floor-share .dev/test-floor-share origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch`           |
| 04   | `apps/`         | `apps/.dev/test-floor-share`        | `feat/test-floor-share`      | `git -C apps fetch origin && git -C apps worktree add -b feat/test-floor-share .dev/test-floor-share origin/main`, then `pnpm install`                                             |
| 05   | `engine/`       | `engine/.dev/selector-floor`        | `feat/selector-floor`        | `git -C engine fetch origin && git -C engine worktree add -b feat/selector-floor .dev/selector-floor origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch`               |
| 06   | `engine/`       | `engine/.dev/suite-pass-record`     | `feat/suite-pass-record`     | `git -C engine fetch origin && git -C engine worktree add -b feat/suite-pass-record .dev/suite-pass-record origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch`         |
| 07   | `apps/`         | `apps/.dev/suite-pass-record`       | `feat/suite-pass-record`     | `git -C apps fetch origin && git -C apps worktree add -b feat/suite-pass-record .dev/suite-pass-record origin/main`, then `pnpm install`                                           |
| 08   | root            | `.dev/suite-pass-pages`             | `docs/suite-pass-pages`      | `git fetch origin && git worktree add -b docs/suite-pass-pages .dev/suite-pass-pages origin/main`, then `make bootstrap`                                                           |
| 09   | `engine/`       | `engine/.dev/suite-pass-proposal`   | `feat/suite-pass-proposal`   | `git -C engine fetch origin && git -C engine worktree add -b feat/suite-pass-proposal .dev/suite-pass-proposal origin/main`, then `pnpm install` and `pnpm run pi-tools:fetch`     |
| 10   | `apps/`         | `apps/.dev/suite-pass-proposal`     | `feat/suite-pass-proposal`   | `git -C apps fetch origin && git -C apps worktree add -b feat/suite-pass-proposal .dev/suite-pass-proposal origin/main`, then `pnpm install`                                       |

## Verify gate per plan

Each plan ends with its task `NN.E`. The gate holds every row of its plan. A failed row blocks the pull request.

| Plan | Gate                                                                                                                                                                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01   | `pnpm run verify`; the tests of task 01.1 failed before task 01.2 and pass after task 01.3; `rg -n 'VerificationMemo' src --glob '!*.test.ts'` names only `src/worker/unit/verification-memo.ts`, `verification.ts`, `steps-implement.ts`, `native-method.ts`, `test-support.ts` and `release-gate.ts`. |
| 02   | `pnpm run verify`; the tests of task 02.1 failed before task 02.2 and pass after task 02.3.                                                                                                                                                                                                             |
| 03   | `pnpm run verify`; `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing after the commit of task 03.4; `pnpm exec prettier --check docs/cli/tracking.md`; the tests of task 03.1 failed before task 03.2 and pass after task 03.3.                |
| 04   | `pnpm verify` in `apps/`; the tests of task 04.1 failed before task 04.2 and pass after task 04.3; the browser check of task 04.E at 1280 by 800 and at 390 by 844.                                                                                                                                     |
| 05   | `pnpm run verify`; the tests of task 05.1 failed before task 05.2 and pass after task 05.3; `KANTHORD_AFFECTED_REPORT=<tmp> pnpm --silent run test:affected` on a clean checkout writes a version 2 report with `floor`, and `parseReport` of plan 02 accepts it (task 05.E).                           |
| 06   | `pnpm run verify`; the tests of task 06.1 failed before task 06.2 and pass after it; the first CI run of the pull request prints the job summary; a re-run of the `check` job skips each test file that passed in the first run and prints a saved share above 0.                                       |
| 07   | `pnpm verify` in `apps/`; the tests of task 07.1 failed before task 07.2 and pass after it; the first CI run of the pull request prints the job summary; a re-run of the `check` job skips the test run and prints the saved share `100%`.                                                              |
| 08   | `pnpm exec prettier --check` on each edited page; each changed sentence cites the engine code of plans 01, 02, 06 and 07 in the pull request body; `rg -n 'suite-pass-record' docs/brainstorm/HANDOFF.md` prints only the item of plans 09 and 10.                                                      |
| 09   | `pnpm run verify`; the OpenAPI check; `pnpm exec prettier --check docs/cli/project.md static/plan/suite-pass-setup.md`; the tests of task 09.1 failed before task 09.2 and pass after task 09.4; `node bin/kanthord.mjs project environment suite-pass plan --help` names both arguments.               |
| 10   | `pnpm verify` in `apps/`; the tests of task 10.1 failed before task 10.2 and pass after task 10.3; the browser check of task 10.E at 1280 by 800 and at 390 by 844.                                                                                                                                     |

## Citations

- A design citation names `docs/brainstorm/<page>:<line>` of the root repository at `c8c41e7`. The rulings of 2026-10-29 cite root pull request #281 at head `7c0e114`: `project-service.impl.md:373`, `:633-642` and `:803`, `worker-service.impl.md:1599` and `tracking-service.impl.md:348`. `docs/brainstorm/HANDOFF.md:89` cites root pull request #279 at head `c418936`.
- An engine citation names a path under the engine root at `0f89b527`. Plan 01 cites the code that plans 01 and 02 of `dogfood-time/` change by function name, and re-anchors each line after their merge (decision D2).
- An apps citation names a path under the apps root at `ca73cb0`.
- When `main` moved before the plan starts, re-anchor each citation to the sentence or code block that the text means (`engine/AGENTS.md`, section "Plans").

## Rulings

- O1 — RULED 2026-10-29 by Ulrich: option A. One setup node with `mission.node.create`, the read `project.binding.suite_pass.plan.get` and the action `Add setup node` (decision D12, plans 09 and 10).
- O2 — RULED 2026-10-29 by Ulrich: option A with one change. A failed read gives `suite_pass: null` and keeps the stored environment (decision D13, plan 09).
- O3 — RULED 2026-10-29 by Ulrich: option A. A production file is a file in the import closure of the program entry, `src/main.ts` in the engine (decision D7, plan 05).
- S1 — APPROVED 2026-10-29 by Ulrich: `scripts/suite-pass.mjs` is the third gate file (decisions D8 and D9).
- S8 — APPROVED 2026-10-29 by Ulrich: a span with a total of 0 does not count in `test_floor_share` (decision D6).

Root pull request #281 writes these rulings into the design pages.

The decisions that this set takes are in [decisions.md](decisions.md).
