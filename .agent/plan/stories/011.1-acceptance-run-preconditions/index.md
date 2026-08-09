# EPIC 011.1 — Acceptance run preconditions — stories

Epic: `.agent/plan/epics/011.1-acceptance-run-preconditions.md`
Prereq: EPIC 011 (sequence order) — the runner, the bundle format, the four scenarios and the
cleanup ledger already exist.

Every rule EPIC 012 rests on gains a mechanism: the runner mints the tag, records the regression
suite, records the human signature, and returns one exit status over a scenario axis and an
acceptance axis.

## Dispatch order

`00 → 01 → 02 → 03 → 04 → 05 → 06 → 07 → 08 → 09`

- **00** and **05** are independent of everything else and may run at any point.
- **01 → 02 → 03 → 04** is a chain. Each adds one option to `parseArguments` in
  `scripts/e2e/lib/main.ts`, and each extends the mutual-exclusion checks the previous one added.
  Do not reorder them; the refusal blocks are position-sensitive.
- **06** and **07** are independent of the chain and of each other.
- **08** and **09** are documentation and ship last. **09** names flags that **01 → 04** must have
  landed.

## Stories

- 00 — the table inventory closes both ways → `00-the-table-inventory-closes-both-ways.md`
- 01 — `--mint-tag` prints one portable tag → `01-the-runner-mints-the-tag.md`
- 02 — `--record-verify` writes `verify.json` → `02-the-verify-record.md`
- 03 — `--record-acceptance` writes `acceptance.json` → `03-the-acceptance-record.md`
- 04 — `--verdict` returns one exit status over two axes → `04-the-verdict-command.md`
- 05 — no scenario file imports from `src/` → `05-scenario-surface-discipline.md`
- 06 — the fixture rows are proved before the journey → `06-the-fixture-acceptance-rows.md`
- 07 — the real profile reads `.env.e2e` → `07-the-real-profile-reads-env-e2e.md`
- 08 — the proposal states what a human confirms → `08-the-proposal-states-what-a-human-confirms.md`
- 09 — the driver matches the mechanism → `09-the-driver-matches-the-mechanism.md`

## Facts (needed for implementation)

**The runner**

- `scripts/e2e/run.mjs` is a four-line shim, pinned verbatim by `scripts/e2e/lib/shim.test.ts:32-39`.
  Never edit it. Every option lands in `scripts/e2e/lib/main.ts`.
- `parseArguments` (`main.ts:53-143`) accepts four value-taking options only (`main.ts:68-73`). No
  option is valueless today, and no `--x=y` form is supported. Story 01 adds the flag branch.
- Exit codes come from `exitCodeFor` (`main.ts:176-186`): `assertion-failed` → 1,
  `invalid-argument` and `tag-reused` → 2, `unavailable` → 3. A non-`RunnerError` throw → 4.
- `RunnerError` and `RunnerErrorCode` live in `scripts/e2e/lib/errors.ts`.
- `mintTag(now, entropy)` (`tag.ts:10-13`) emits `YYYYMMDDHHMMSSmmm-<lowercased ulid>`, matching
  `/^\d{17}-[0-9a-z]{26}$/`. `main.ts:223` already calls it on every invocation.
- `runDirectory(tag)` is `.data/acceptance-<tag>` (`tag.ts:16-18`); `bundleDirectory(tag, id)` adds
  the scenario id. `.gitignore:146` ignores `.data/acceptance-*/`.
- `knownScenarioIds` is `["P1-E1", "P1-E2", "P1-E3", "P1-E4"]` (`main.ts:29-34`). That order is the
  verdict's check order.
- `serializeBundle` (`bundle.ts:234-259`) is the canonical-JSON pattern the two new records copy:
  explicit key order, `JSON.stringify(ordered, null, 2)`, `redact(...)`, trailing newline.
- `readCommit(sink, git)` (`bundle.ts:312-318`) runs `git rev-parse HEAD`. Story 02 adds
  `readProposalRevision` beside it.
- `main`'s second parameter (`main.ts:220`) is the dependency-injection seam every new command test
  uses. It carries `execute?: PodmanExecutor` today.

**Greenfield gaps**

- Nothing under `scripts/e2e/` reads a proposal revision. Story 02 defines it as
  `git log -1 --format=%H -- docs/proposal`.
- `scripts/e2e/env.ts` `loadE2eEnv` (`env.ts:50`) exists but is used only by the legacy
  `scripts/e2e/007/*.e2e.ts` suite. The `lib/` runner never imports it. Story 07 makes P1-E3 its
  second consumer. `.env.e2e` is gitignored (`.gitignore:70`) and present on Ulrich's machine.
- `ExecutionDriver` (`driver/index.ts:40-67`) has no generic command execution. Story 06 adds
  `probeOrigin` rather than a generic `exec`, so a scenario still cannot reach past the CLI and HTTP.
- The podman network is `--internal` and `topology.fixtureOrigin` is `http://127.0.0.1:7422` **inside
  the pod** (`podman/topology.ts:40`, `:113-131`). The runner host cannot reach it. The daemon
  container shares the pod with the fixture container and can.
- `test/helpers/remote/http.ts:336-479` already holds the three rows as `httpAcceptanceChecks`, and
  `createHttpRemote` gates on them (`remote/index.ts:35-48`). They run against a live `HttpRemote`
  handle, which the podman branch does not have — which is why Story 06 writes shell-script rows
  instead of reusing them.

**Gotchas**

- `context.assert` (`bundle.ts:151-164`) records the row and **then** throws `assertion-failed`.
  Story 06 depends on that order to record a failed fixture row before raising `unavailable`.
- `context.note` accepts only the eight keys of `noteKeys` (`bundle.ts:82-91`). Story 06 records its
  rows through `assert`, not `note`.
- `driver.name ===` is forbidden in `scenario/` and `profile/` by
  `scripts/e2e/lib/scenario/index.test.ts:53-73`. The `originSources` lookup table
  (`profile/fixture.ts:28-50`) is the dispatch.
- `driverMethodNames` (`driver/index.ts:69-84`) is asserted against a duplicate literal in
  `driver/interface.test.ts:12-26`. Story 06 edits both.
- `runCommand` spawns with `shell: false` and `env: input.env ?? {}` (`command.ts:44-56`). A shell
  script needs an explicit `["/bin/sh", "-c", script]` argv and an explicit `PATH`.
- `Object.keys(rows)` (`src/domain/rows.ts:21-43`) is already lexicographic, so a
  `sqlite_master … ORDER BY name` query matches it with no re-sort. Migration 4 creates three
  indexes, so `type = 'table'` is required in that query.
- `docs/proposal/phase-1/domain.md` declares all nineteen tables on **one prose line**, line 35,
  under the marker line `` `node:sqlite`. Tables: `` at line 33. There is no per-table heading and no
  markdown table. Lines 22, 37 and 10-11 carry backticked identifiers that are not tables, so the
  parser must read line 35 alone.
- `docs/proposal/` prose is one unwrapped paragraph per line. `.claude/commands/e2e.md` is hard
  wrapped at ~80. `npm run verify` does not lint markdown; the pre-commit hook runs
  `prettier --write`.

## Blockers and suggestions

- B1 - action:YES - epic-proof-expects-the-wrong-exit-status - **Resolved.** The EPIC Proof block read
  `test $? -eq 1`, but under that Proof the first failing condition is an absent `P1-E3` bundle,
  which the EPIC's own rule maps to exit `3`. The EPIC now reads `test $? -eq 3` and its sentence
  names `3`. Nothing is left to do.
- S1 - action:NO - verify-json-is-overwritable - The EPIC pins "refuses to overwrite" for the
  acceptance record only, and gives the reason (a signature is not edited). Story 02 therefore lets
  `--record-verify` overwrite, so a tag can carry a re-run of the regression suite. `--verdict`
  still enforces one commit across every record.
- S2 - action:NO - real-plan-inputs-stay-environment-variables - The EPIC says the plan path and the
  two counts "stay explicit options". Story 07 keeps them as the three surviving
  `KANTHORD_E2E_REAL_*` environment variables rather than adding three CLI options, so
  `parseArguments` is untouched by that story.
- S3 - action:NO - the-four-judgment-subjects-are-unsourced - `.claude/commands/e2e.md:75-79` and
  EPIC 012 line 72 both attribute the four product-acceptance subjects to `docs/proposal/README.md`,
  which does not state them. Story 08 is scoped to two amendments and does not add them. Worth a
  later proposal amendment.
