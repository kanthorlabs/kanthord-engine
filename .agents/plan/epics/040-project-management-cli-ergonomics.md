# EPIC 040 — Project-management CLI ergonomics

Status: **draft**. It follows EPIC 039 by sequence order and closes the CLI gaps found while EPIC
035 was driven as a kanthord project.

## Goal

A human can operate the external project-management loop without guessing a closed vocabulary,
opening SQLite, or manually rewriting `.agents/plan` files:

- `node report` states and locally enforces the four task outcomes and their required fields;
- `node list` states the node-state vocabulary and the distinction between a claimable task and a
  running ancestor;
- a per-node structural refusal prints every `plan-invalid` finding the daemon returned;
- an unknown repository name prints the known names already returned by `repository.list`;
- an HTTP client command falls back to the discovered `kanthord.config.json` HTTP bind, port and
  token when no flag or client environment variable supplies the value;
- `plan convert` turns one expanded `.agents/plan` EPIC into deterministic, importable plan-format
  Markdown without making a network request or minting an identity.

## Non-goals

- **No repository-registration bypass.** `repository register` keeps its fetch and write-advertisement
  preflight. No `--local` or `--no-verify` flag is added, and no repository row is inserted without a
  credential and a seeded home.
- **No force delete.** A node referenced by a lease, run, attempt, workspace, commit, check result,
  git operation or waived edge remains `binding-in-use`. Execution history is not deleted.
- **No `work` node state.** The closed state vocabulary is unchanged. A recovered task is `ready`;
  its objective and initiative may remain `running`, as the state machine already declares.
- **No graph or import semantic change.** The daemon still requires every objective to name a
  registered repository bound to its project. `plan import` still validates the plan format and
  mints missing identities.
- **No automatic import.** `plan convert` writes local files only. It takes no project id, base URL or
  token and calls no operation.
- **No second plan format.** The converter emits the existing format of
  `docs/proposal/phase-1/plan-format.md`; the daemon learns nothing about `.agents/plan`.
- **No title-update change.** `node update --title` already exists and remains a field-only update.
- **No reassignment of EPIC 035's human completion items.** Removing Koa packages and amending the
  locked architecture/toolchain files remain completion work of EPIC 035.

## Decisions

- **`node report` is the task-only CLI over the task branches of `node.report`.** Its admitted
  `--outcome` values are exactly `accepted`, `rejected`, `failed` and `cancelled`, in that order.
  `accepted` requires `--object-id` and refuses `--reason`; `rejected` and `failed` require a
  non-empty `--reason` and refuse `--object-id`; `cancelled` admits an optional non-empty reason and
  refuses `--object-id`. Every branch requires `--id` and a positive integer `--fence`. An object id
  is 40 or 64 lowercase hexadecimal characters. A local mismatch prints one `invalid-request` line,
  calls no operation and exits 1. `node attest` and `node close` remain the two objective spellings.

- **Help names closed sets.** `node report --help` names the four outcomes and each conditional
  requirement. `node list --help` names all eight states in `nodeStates` order and adds exactly this
  clarification: `ready task = claimable; running = active node or ancestor`. It adds no alias and
  changes no query.

- **One renderer owns node-write refusals.** A new `src/cli/node/write-refusal.ts` exports
  `printNodeWriteRefusal(result, stderr)`. It always prints the existing first line
  `kanthord: <code>: <message>`. When `code === "plan-invalid"`, it parses `result.details` through
  `planInvalidDetails` and then prints each finding in response order as
  `kanthord: plan-invalid: <finding.code> <finding.path-or-dash> <finding.message>`. It does not sort,
  omit or combine findings. Malformed declared details throw instead of producing an empty list.
  `node create`, `node update` and `node delete` use the renderer; exit-code routing is unchanged.

- **Known repository names stay client-side.** `project repository` already calls
  `repository.list`. When an exact, case-sensitive name has no match, the one refusal line becomes
  `kanthord: not-found: no repository named <name>; known repositories: <names>`. `<names>` is every
  returned repository name, deduplicated and sorted with `comparePaths`, joined by `,`, or `<none>`.
  The command makes no `project.repositories` call on that refusal.

- **Connection precedence is per value.** Base URL precedence is `--base-url`,
  `KANTHORD_BASE_URL`, discovered config. Token precedence is `--token`, `KANTHORD_TOKEN`,
  `--api-token-file`, `KANTHORD_API_TOKEN_FILE`, discovered config. The existing conflict between a
  non-empty direct token and a non-empty token file remains a local refusal. Config is a fallback,
  so it never conflicts with a higher-precedence source. Empty values are absent.

- **The composition root loads client defaults.** `cli/` imports no config implementation.
  `ProgramDependencies` gains a callback that returns `{ bind, port, token }` from the same
  `ConvictConfig.load` call and search order the daemon uses. `src/main.ts` supplies that callback.
  An ambient search with no file returns no defaults; an explicit `--config` or
  `KANTHORD_CONFIG` miss remains `config-not-found`; an invalid discovered file remains
  `config-invalid` or `config-refused`. The callback is lazy: help, version and a client invocation
  with both values supplied by flags/environment do not read config.

- **A bind address renders one local HTTP base URL.** `127.0.0.1` renders itself; wildcard
  `0.0.0.0` renders `127.0.0.1`; wildcard `::` renders `[::1]`; every other address containing `:` is
  bracketed once; every other non-empty bind is used unchanged. The result is
  `http://<rendered-host>:<port>`. This is a local config fallback, not remote daemon discovery.

- **Top-level help names client environment variables.** It names `KANTHORD_BASE_URL`,
  `KANTHORD_TOKEN` and `KANTHORD_API_TOKEN_FILE`, and states `flags > environment > discovered
config`. The existing `config --help` search-order block changes “at daemon start” to “for daemon
  start and client fallback”.

- **One expanded EPIC becomes one initiative, one objective per Story file and one task per
  objective.** The command is:

  ```text
  kanthord plan convert --from <epic-file> --repo <repository-name> --to <directory>
  ```

  `<epic-file>` must have basename `<epic-slug>.md`, heading
  `# EPIC <number> — <title>`, a non-empty `## Goal`, and a numbered `## Stories` list. Its expanded
  files are read from the sibling directory `.agents/plan/stories/<epic-slug>/`. Files matching
  `NN-*.md` are sorted with `comparePaths`; prefixes must be contiguous from `01`; each file heading
  must be `# Story N — <title>` with the matching number and must hold non-empty `## Change`,
  `## Constraints` and `## Verify` sections. `index.md` and every other file are ignored. The number
  of expanded files must equal the numbered EPIC story count.

- **The converter emits no identity.** Authored plan frontmatter permits an absent `id`, and
  `plan.validate` mints provisional identities in canonical path order. The converter therefore
  emits no random or clock-derived value. Repeating it over the same source and repository name
  produces the same paths, the same document order and the same bytes.

- **The converted topology is serial by Story order.** The initiative path is
  `plan/<epic-slug>/initiative.md`. Story `NN-<slug>.md` produces
  `plan/<epic-slug>/NN-<slug>/objective.md` and
  `plan/<epic-slug>/NN-<slug>/01-implement.md`. Objective 01 has no dependency; every later
  objective has one relative `depends_on` entry naming the previous objective. Each objective names
  `repo: <repository-name>`. Each task names `worker: "tdd@1"` and has no dependency.

- **The converted prose has one exact mapping.** The initiative title is
  `EPIC <number> — <title>` and its instruction is the `## Goal` body. An objective title is the
  Story heading title and its instruction is
  `Source story: .agents/plan/stories/<epic-slug>/<file>.\n`. Its task title is
  `Implement Story <N> — <title>`. The task instruction is the source `## Change` heading and body,
  followed by the source `## Constraints` heading and body. The task acceptance is one
  `## Acceptance criteria` heading followed by the source `## Verify` body. Every document uses the
  canonical frontmatter key order applicable to it, double-quoted scalars, LF and exactly one final
  LF.

- **Conversion refuses replacement.** If `<to>/plan` already holds any Markdown document,
  `plan convert` prints `kanthord: invalid-request: <to>/plan is not empty`, writes nothing and exits
  1. It builds and validates the complete output in memory before the first write. On success it
     writes documents in `comparePaths` order and prints
     `kanthord: converted <story-count> story into <document-count> document under <to>/plan`.

## Stories

Author with `/author`. The order below is dependency order; each story is one commit.

1. **Task outcome and state help are closed and local.** Amend `docs/proposal/api/outcome.md` and
   `docs/proposal/api/graph.md` with the exact CLI vocabulary above. Update `src/cli/node/report.ts`
   to perform the task-branch validation before the call, and update `src/cli/node/list.ts` help with
   the state list and recovery clarification. Extend the two existing CLI tests with exact help and
   zero-call refusal assertions.
2. **Node-write and repository-name refusals carry their details.** Add
   `src/cli/node/write-refusal.ts` and its test. Route the three node-write CLIs through it. Amend the
   repository lookup refusal and its test with the deterministic known-name list. Amend the matching
   failure prose of `docs/proposal/api/graph.md` and `docs/proposal/api/project.md`.
3. **Client commands inherit discovered HTTP configuration.** Amend
   `docs/proposal/phase-1/transport.md`. Extend `src/cli/options.ts`, `src/cli/program.ts` and
   `src/main.ts` with the lazy callback and precedence above. Extend options, program, config-help and
   daemon-backed main tests.
4. **The expanded-EPIC conversion is a deterministic pure mapping.** Amend
   `docs/proposal/api/graph.md` with the local conversion contract. Add
   `src/cli/plan/convert-harness-plan.ts` and its test. The function accepts already-read EPIC and
   Story path/content records plus the repository name and returns the complete plan document array;
   it reads and writes no file itself.
5. **`plan convert` is a registered local command.** Add `src/cli/plan/convert.ts` and its test,
   register it in `src/cli/program.ts`, and add the operation-free command to
   `src/cli/inventory.ts` and the reachability row. It reads the source, refuses a non-empty output,
   invokes the pure mapper once and writes the returned documents once.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/cli/node/report.test.ts \
  src/cli/node/list.test.ts \
  src/cli/node/write-refusal.test.ts \
  src/cli/node/create.test.ts \
  src/cli/node/update.test.ts \
  src/cli/node/delete.test.ts \
  src/cli/project/repository.test.ts \
  src/cli/options.test.ts \
  src/cli/program.test.ts \
  src/cli/config/index.test.ts \
  src/cli/plan/convert-harness-plan.test.ts \
  src/cli/plan/convert.test.ts \
  src/cli/inventory.test.ts \
  src/cli/parity.test.ts \
  src/cli/reachability.test.ts \
  test/helpers/command-recorder.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-040"
```

Hermetic coverage required beyond the Proof:

- Every invalid `node report` option combination records zero client calls and prints one exact
  local-refusal line. Every valid task branch records one `node.report` call whose body parses through
  `nodeReportRequest`.
- `node report --help` names all four task outcomes and their conditional fields. `node list --help`
  names all eight states and contains no `work` state.
- A two-finding `plan-invalid` response prints the generic refusal followed by both findings in
  response order. A non-`plan-invalid` refusal prints only the existing generic line.
- An unknown repository prints distinct, bytewise-sorted names once and calls no write operation.
- Flags override environment and config independently; environment overrides config independently;
  config fills either missing value; direct-token/token-file conflict remains a refusal; a complete
  flag/environment pair does not call the config loader.
- A daemon-backed test starts from a generated config and runs `kanthord status` from the directory
  containing that config with no `--base-url`, `--token` or client environment variable.
- The converter fixture contains two Stories. Its exact output has five documents, the second
  objective depends on the first, every objective names the supplied repository, each task has
  `worker: "tdd@1"`, and no output contains an `id:` key.
- Reordering the input Story records produces byte-identical output. A duplicate, skipped or
  mismatched Story number, a count mismatch, a missing required section and a non-empty output each
  fail before any write.
- `plan convert` records zero HTTP requests, records its plan-document writes as its local effect and is listed once in the CLI inventory.
- No test uses the repository's real `.agents/plan` tree as a mutable fixture. Converter tests use
  in-memory records or their own temporary directory and remove it.
