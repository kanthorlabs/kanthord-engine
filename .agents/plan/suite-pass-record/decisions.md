# Suite pass record plan decisions

The plans cite these decisions as D1 to D14. Each decision binds every plan and every task of this set.

## D1 — Source and gaps

The design pages under `docs/brainstorm/` of the root repository at `c8c41e7` are the rule (`engine/AGENTS.md:3-6`). `docs/brainstorm/HANDOFF.md:89` follows root pull request #279 at head `c418936`. The rulings of 2026-10-29 on O1, O2, O3, S1 and S8 follow root pull request #281 at head `2d6587f`. A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. Aelita brings it to Ulrich as one open item.

## D2 — The base of plan 01

Done by engine #378. The rule is `worker-service.impl.md:1482-1495`. Plan 01 started from engine `main` after plans 01 and 02 of `dogfood-time/` merged.

## D3 — The verification memo

Done by engine #378. The rule is `worker-service.impl.md:1482-1495`:

- The memo belongs to one execution. The code that builds the steps state creates it. No memo crosses a claim.
- The memo key is the context, the command text, the tree id of each checkout head in the order of the checkouts, and the sorted `[identity, digest]` pairs of the environment of each repository binding.
- The tree id of a checkout is `git rev-parse <head>^{tree}` of the head that the run tests.
- The contexts are `task`, `node` and `release`. The evaluation, the affected test run, the environment setup and the `examine` steps read and write no memo.
- In the contexts `task` and `node`, the memo keeps a result with the class `pass` only.
- In the context `release`, the memo keeps a result with the class `pass`, and a result with the class `code_failure` that has `timed_out: false` and no cancellation.
- The memo keeps no result with the class `budget_end` or `infrastructure`, and no result with exit code 127.
- A memo entry holds the result, the output and the class of the run.
- A memo hit adds the stored result and output to the run list, with the flaky value `false`. It calls no observer, so it writes no `worker.verification` span. It counts in `ran` of the `no_progress` detail.
- A memo hit with the class `code_failure` ends the run list as a real failure does.
- Inside one run list, the result copy of `dogfood-time/` D2 decides first.

## D4 — The affected report version 2 at the worker

The rule of `docs/brainstorm/worker-service.impl.md:1595-1598`:

- `version` is `1` or `2`. A version 1 report keeps every rule of today.
- A version 2 report takes the optional key `floor`. A version 1 report with `floor` is an invalid report.
- `floor` is a strict object of `tests`, `seconds` and `total_seconds`. `tests` is a nonnegative integer. `seconds` is a finite nonnegative number. `total_seconds` is a finite nonnegative number or null.
- A non-null `total_seconds` with a `selection` other than `all` is an invalid report.
- Every other key keeps its version 1 rule. The evidence keeps the parsed report, `floor` included.

## D5 — The floor span attributes

The rule of `docs/brainstorm/tracking-service.impl.md:86-88`. The end of an `affected` span adds:

- `kanthord.affected.floor_count`: `floor.tests`, when the valid report holds `floor`.
- `kanthord.affected.floor_seconds`: `floor.seconds`, when the valid report holds `floor`.
- `kanthord.affected.total_seconds`: `floor.total_seconds`, when it is not null.

An `affected_base` span and an `affected` span with no valid report hold none of them.

## D6 — The measure `test_floor_share`

The rule of `docs/brainstorm/tracking-service.impl.md:348`, `:353` and `:358-359` at root pull request #281 head `2d6587f`. The total above 0 is part of that rule (S8, approved by Ulrich on 2026-10-29):

- A matching span is a `worker.verification` span with `kanthord.verification.kind` `affected`, `kanthord.verification.context` `release`, a finite `kanthord.affected.floor_seconds` and a finite `kanthord.affected.total_seconds` above 0.
- The group key and the bucket follow the duration read. A span counts in the bucket of its `start_time`.
- The latest span of a group and bucket has the largest `start_time`. On a tie, the larger span identity decides.
- An item holds `key`, `bucket_start`, `count`, the matching spans of the group and bucket, and `share`, `floor_seconds` divided by `total_seconds` of the latest span. It holds no percentile.
- The order measure is `count`.
- `group_by` takes the values of the duration read. `worker_instance` refuses with 400 `gateway.request.validation_failed`, as for every measure other than `instance_busy_ratio`.

## D7 — The floor of the engine selector

RULED 2026-10-29 by Ulrich (O3). The rule of `docs/brainstorm/worker-service.impl.md:1599` at root pull request #281 head `2d6587f`: "A production file is a file in the import closure of the entry that the program runs. The engine entry is `src/main.ts`."

- A production file is a file of the import closure of the program entry. The engine entry is `src/main.ts`.
- The import closure of a file is the file and each file that it reaches through the forward edges of the selector graph: the import edges and the data edges of `DATA_TABLE` and of `new URL(..., import.meta.url)`.
- A floor test file is a run test file whose import closure holds every production file. `floor.tests` counts every floor test file of the repository, also when the selection runs none of them.
- The test time of a file is `duration_ms / 1000` of the `test:summary` event of the node test runner that holds `data.file` of that file.
- `floor.seconds` is the sum of the test time of the floor test files that the run ran.
- `floor.total_seconds` is the sum of the test time of every file of `tests` when `selection` is `all`, else null.
- The selector writes `version: 2` and `floor` in every report.
- The apps selector keeps version 1. It gives no import graph, so it writes no `floor`.

## D8 — The suite pass record of the engine

The rule of `docs/brainstorm/project-service.impl.md:403-435`:

- `scripts/suite-pass.mjs` holds the record steps. It imports the graph, the closure and the test run of `scripts/affected-tests.mjs`. No second map exists.
- The key of a test file is the SHA-256 hex of the canonical JSON of: the Node.js version, the pnpm version, the sorted pairs of path and blob id of the global inputs and of `gate_files`, and the sorted pairs of path and blob id of the import closure of the test file.
- The global inputs are `GLOBAL_INPUTS` of the selector and `static/pi-tools.json`.
- `gate_files` comes from `.kanthord/affected-tests.json` of the checkout.
- The blob ids come from `git ls-tree -r HEAD`. A global input that the tree does not hold pairs with null.
- The record store is the file `node_modules/.cache/suite-pass/records.json`. It maps each key to `{ file, seconds, written_at }`. A write keeps the 20000 newest records.
- The script writes records only with the flag `--write`. With `--write`, it refuses a run when `git status --porcelain --untracked-files=all` prints a line before or after the tests. CI passes `--write` only after `pnpm install --frozen-lockfile`.
- A test file passes when the run ran it, holds no failed test id and holds a test time.
- CI runs each test file with no matching record and each file of `always_run`. The flag `--full` runs every test file and still writes records.
- `actions/cache/restore` restores the newest record store of the job, and `actions/cache/save` saves it with `if: always()`. The cache key holds the job name, the run identity and the run attempt. The restore key is the prefix of the job name. The restore runs after `pnpm install --frozen-lockfile`, because the store lives under `node_modules/`.
- The jobs `check` and `e2e` keep separate record stores.
- The job summary prints the floor count, the floor seconds of the run and the saved share. The saved share is the record time of the skipped test files divided by the sum of the record time of the skipped files and the test time of the files that ran.
- The schedule trigger `cron: "0 3 * * *"` runs the workflow on `main` with `--full`.
- `.kanthord/suite-pass.json` holds `version: 1` and `always_run`. `always_run` lists each test file that bundles code, reaches `bin/` or `dist/`, or reads a path that it builds at run time.
- `.gitignore` adds `!/.kanthord/suite-pass.json` after `!/.kanthord/comments.json`.
- `gate_files` adds `.kanthord/suite-pass.json`, `.github/workflows/ci.yml` and `scripts/suite-pass.mjs`, the record steps (S1, approved by Ulrich on 2026-10-29; `docs/brainstorm/project-service.impl.md:435` at root pull request #281).

## D9 — The suite pass record of the apps repository

The apps selector runs `vitest related` and gives no import graph (apps `scripts/affected-tests.mjs:207-211`). The rule of `project-service.impl.md:414` applies:

- One record covers the whole tree. Its key is the SHA-256 hex of the canonical JSON of the tree id of `HEAD`, the Node.js version and the pnpm version.
- `scripts/suite-pass.mjs` holds the record steps. On a hit, CI runs only the files of `always_run`. On a miss, CI runs `vitest run`.
- The record store, `--write`, `--full`, the cache steps, the schedule trigger and the clean-tree rule follow D8.
- The job summary prints "Floor: none" and the saved share. The saved share is `100%` on a hit with an empty `always_run`, and `0%` on a miss. On a hit with a nonempty `always_run`, it is the record time minus the test time of the `always_run` files, divided by the record time, with 0 as its lower bound.
- The environment variable `SUITE_PASS_TEST_COMMAND` replaces the vitest command in the tests of the script. CI never sets it.
- `.kanthord/suite-pass.json` holds `version: 1` and `always_run: []`, unless a test file of apps meets the rule of `project-service.impl.md:433`.
- `.gitignore` adds `!/.kanthord/suite-pass.json`.
- `gate_files` adds `.kanthord/suite-pass.json`, `.github/workflows/ci.yml` and `scripts/suite-pass.mjs`, the record steps (S1, approved by Ulrich on 2026-10-29; `docs/brainstorm/project-service.impl.md:435` at root pull request #281).
- The `check` job runs `typecheck`, `lint`, `format:check` and `build` as steps, and the test run as the suite pass step.

## D10 — Gate files and the landing

A gate file is a path of `gate_files` of `.kanthord/affected-tests.json` at the base branch of the repository (`docs/brainstorm/project-service.impl.md:399`, `worker-service.impl.md:1539`). A plan that changes a gate file lands with Ulrich. The executor pushes the branch and opens the pull request. Aelita reviews it. Only Ulrich merges it. Plans 05, 06 and 07 land with Ulrich.

## D11 — Orphans

A plan removes each field, prop and helper that only fed the code that the plan removes. A plan removes no other dead code. It names other dead code in its pull request body.

## D12 — The setup node of the suite pass proposal

RULED 2026-10-29 by Ulrich (O1). The rule of `docs/brainstorm/project-service.impl.md:639-645` and `:806` at root pull request #281 head `2d6587f`:

- A human accepts the proposal with one `mission.node.create`.
- The engine ships `static/plan/suite-pass-setup.md`, one node file with `intent: implement`, `commit_type: chore`, no task and no `bindings` key.
- The front matter quotes each verification as a YAML double-quoted string. The verifications are, in order: `test -f .kanthord/suite-pass.json`, `! git check-ignore -q .kanthord/suite-pass.json` and `test ! -f .kanthord/affected-tests.json || grep -qF .kanthord/suite-pass.json .kanthord/affected-tests.json`.
- The `human` read `project.binding.suite_pass.plan.get` at `GET /api/project/:project_id/binding/:binding_id/suite-pass/plan` answers `{ filename, content, tasks, reason }`, the body of `mission.node.create` without `expected_mission_version`. The client adds the current mission version.
- `filename` is `suite-pass-setup-<binding name>.md`. `content` is the parsed node file with `bindings: [<binding name>]`, with no `filename` and no `depends_on` key, so that it matches the strict `contentWriteSchema` (`src/mission/contract.ts:645`). `tasks` is `[]`. `reason` is `Add the suite pass record to <binding name>.`
- The Project Service imports only `contract.ts` of the Mission Service. The composition root gives it the Mission collaboration `nodeBodyOf(filename, text)`, as it gives `createMission` (`src/apps/server/index.ts:948`). The Mission Service parses the text with `parsePlanFile` of `src/mission/parser.ts`. It refuses a task file, an `id` and a nonempty `depends_on` with `mission.import.plan_invalid`.
- The read refuses a binding that is absent, removed or no repository binding with 404 `project.binding.not_found`. It refuses a binding with no `pull_request` action with `landing: human` with 409 `project.suite_pass.not_proposed`. An absent `landing` reads as `human` (`project-service.impl.md:23`, `:639`; `src/project/service.ts:1656`). It reads no repository file.
- The CLI leaf `kanthord project environment suite-pass plan <project-id> <binding-id>` calls the read and prints the answer as indented JSON. A human adds `expected_mission_version` and passes the file to `kanthord mission node create <mission-id> --file <path>`.
- The dashboard action is `Add setup node`. It reads the mission of the project for its version, then calls `mission.node.create` with the body of the read. A 409 `mission.node.filename_conflict` shows the info toast "Setup node of <binding> exists." with no `Retry`.

## D13 — The read of the suite pass configuration

RULED 2026-10-29 by Ulrich (O2). The rule of `docs/brainstorm/project-service.impl.md:636-638` at root pull request #281 head `2d6587f`:

- `project.binding.environment.get` reads `.kanthord/suite-pass.json` with `repositoryFiles.readFilesAtCommit` at the base commit, for every source.
- For an unstored source, the path joins the paths of the base read of the resolution. `read` removes it from `files` before it builds the answer, so it never enters `GroupResolution.files` and never changes the digest. `resolveGroup` of the Onboarding run reads no such file.
- For a stored source, `read` runs one base read with that path only.
- `suite_pass` is `absent` only for the `RepositoryFileState` `absent`. It is `present` for `present`, `too_large` and `not_utf8`.
- When the SSH read or the base-branch read of a stored source fails, `suite_pass` is null and the answer keeps the stored environment. An aborted `caller.context.signal` rethrows. A failed read of an unstored source refuses the request as it does today.
- A binding with `suite_pass` null gets no proposal.

## D14 — The proposal on the dashboard

The dashboard shows the proposal when `suite_pass` is `absent` and the binding configuration holds a `pull_request` action with `landing: human` (`project-service.impl.md:639`, `:806`). An absent `landing` reads as `human` (`project-service.impl.md:23`, `:639`). The dashboard derives it from the binding configuration. No answer field carries it.
