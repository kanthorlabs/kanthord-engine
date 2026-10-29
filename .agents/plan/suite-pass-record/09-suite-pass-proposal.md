# Plan 09: Project Service — the suite pass proposal

## Scope

Repository: `kanthorlabs/kanthord-engine`.

This plan builds the engine side of the suite pass proposal (decisions D12 and D13).

Today `project.binding.environment.get` answers `{ source, commit, environment, reason }` (`src/project/contract.ts:793-798`). A stored source answers with no repository read (`src/project/environment.ts:209-222`). No read gives the body of the setup node, and the engine ships no plan file.

The plan delivers:

- `suite_pass` in the answer of `project.binding.environment.get`: `present`, `absent` or null.
- The shipped node file `static/plan/suite-pass-setup.md`.
- The Mission collaboration `nodeBodyOf` and the `human` read `project.binding.suite_pass.plan.get`.
- The CLI leaf `kanthord project environment suite-pass plan` and the `suite_pass` line of `environment show`.
- The OpenAPI document and `docs/cli/project.md`.

Out of scope:

- The dashboard line. Plan 10 owns it.
- The node create. `mission.node.create` and `kanthord mission node create` exist and do not change.
- The CI of the engine and the apps repository. Plans 06 and 07 own it.

## Model

Opus at medium effort. The plan crosses the Project Service, the repository file read, a Mission collaboration through the composition root, a shipped static file and the CLI.

## Sources

Root pull request #281 at head `7c0e114` is the rule for the proposal:

- `docs/brainstorm/project-service.impl.md:373` — the answer of `project.binding.environment.get` with `suite_pass`.
- `docs/brainstorm/project-service.impl.md:633-642` — "The suite pass proposal": the read at the base commit outside `files`, the state, the null state of a failed read, the binding that gets the proposal, the node create, the setup node and its landing.
- `docs/brainstorm/project-service.vocabulary.md` "suite pass state".
- `docs/brainstorm/mission-service.impl.md:164`, `:226` — `node create` requires `filename` and admits a node at any time.
- Engine `src/project/environment.ts:209-236` (`read`), `:467-517` (`readBase`, `readFiles`); `src/project/contract.ts:793-798`, `:1007-1017`; `src/mission/contract.ts:671-677` (`nodeCreateSchema`); `src/mission/parser.ts:237` (`parsePlanFile`); `src/kernel/assets.ts:31` (`shippedAsset`); `src/apps/server/index.ts:948` (`createMission`).
- The rule of Ulrich: each API has an equivalent CLI command.

## Depends on

- Plans 06 and 07 landed. The shipped node file names the record steps, the always-run list and the CI steps of those plans as its example.
- Start from `origin/main` of `kanthorlabs/kanthord-engine`.

## Provides

The contract of plan 10:

| Item                                     | Shape                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `project.binding.environment.get` answer | adds `suite_pass: "present" \| "absent" \| null`                                                  |
| `project.binding.suite_pass.plan.get`    | `GET /api/project/:project_id/binding/:binding_id/suite-pass/plan`, `human` read                  |
| Answer of the plan read                  | `{ filename, content, tasks: [], reason }`, the body of `mission.node.create` without the version |
| Refusals of the plan read                | 404 `project.binding.not_found`; 409 `project.suite_pass.not_proposed`                            |
| CLI                                      | `kanthord project environment suite-pass plan <project-id> <binding-id>`                          |

## Tasks

### 09.1 Write the reproducing tests

- Files: `src/project/service.test.ts`, `src/mission/service.test.ts`, `src/apps/cli/index.test.ts` (edit)
- Do:
  1. In `src/project/service.test.ts`, add the test "binding.environment.get answers suite_pass present when the base commit holds the suite pass configuration". Use the repository fixture of the test at `:5908`. Commit `.kanthord/suite-pass.json` to the base branch. Assert `suite_pass: "present"` and a digest of the group equal to the digest before the commit.
  2. Add the test "binding.environment.get answers suite_pass absent with no suite pass configuration".
  3. Add the test "binding.environment.get answers suite_pass for a stored environment". Store an environment and commit the file. Assert `source: "stored"`, the stored environment and `suite_pass: "present"`.
  4. Add the test "binding.environment.get keeps the stored environment and answers suite_pass null when the read fails". Make the remote unreachable, as the SSH failure tests of this file do. Assert the stored environment and `suite_pass: null`.
  5. Change the test "binding.environment.get answers the stored environment with no repository read" (`:5884`). It now asserts one base read with the path `.kanthord/suite-pass.json` only. Rename it to "binding.environment.get reads only the suite pass configuration for a stored environment".
  6. Add the test "binding.suite_pass.plan.get answers the node create body of the setup node". Use a binding with a `pull_request` action with `landing: human` and the name `engine`. Assert `filename: "suite-pass-setup-engine.md"`, `content.bindings: ["engine"]`, `content.intent: "implement"`, `content.commit_type: "chore"`, `tasks: []` and `reason: "Add the suite pass record to engine."`.
  7. Add the test "binding.suite_pass.plan.get refuses a binding with no human landing". Use a `pull_request` action with another landing, then a binding with only `merge_push`. Assert 409 `project.suite_pass.not_proposed` for each.
  8. Add the test "binding.suite_pass.plan.get refuses an absent or a non-repository binding" with 404 `project.binding.not_found`.
  9. Add the test "the setup node body creates one node and changes no other node". Pass the answer with the current mission version to `mission.node.create`. Assert one new node, the human actor, and no change of the other nodes.
  10. In `src/mission/service.test.ts`, add the test "nodeBodyOf parses a node file and refuses a task file" with `mission.import.plan_invalid`.
  11. In `src/apps/cli/index.test.ts`, add the test "environment suite-pass plan prints the setup node body". Assert the route, the indented JSON and the local codes `cli.project.environment.suite-pass.plan.invalid_project_id` and `invalid_binding_id`.
  12. In the same file, add the test "environment show prints suite_pass".
- Verify: `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 src/project/service.test.ts src/mission/service.test.ts src/apps/cli/index.test.ts` fails on the tests of steps 1 to 4, 6 to 12 and on the changed test of step 5 only.

### 09.2 Read the suite pass configuration

- Files: `src/project/contract.ts`, `src/project/environment.ts` (edit)
- Do:
  1. Add `SuitePassState = { Present: "present", Absent: "absent" }` to `src/project/contract.ts`. Add `suite_pass: z.enum(SuitePassState).nullable()` to `environmentAnswerSchema` (`:793-798`).
  2. Add `SUITE_PASS_FILE = ".kanthord/suite-pass.json"` to `environment.ts`.
  3. For an unstored source, `read` passes `SUITE_PASS_FILE` with the paths of the base read of the resolution. It takes the entry of that path out of `files` before the resolution builds its answer, so `GroupResolution.files` never holds it. `resolveGroup` passes no such path.
  4. For a stored source, `read` calls `readBase` with `[SUITE_PASS_FILE]` only. A thrown read gives `suite_pass: null` and keeps the stored answer.
  5. `suite_pass` is `present` when the state of the file entry is the present state of `RepositoryFile` (`src/repository/contract.ts:93-100`), else `absent`.
  6. A failed read of an unstored source keeps its refusal of today.
- Cite: decision D13; `project-service.impl.md:636-638`.
- Verify: the tests of task 09.1 steps 1 to 5 pass.

### 09.3 Ship the setup node and give its body

- Files: `static/plan/suite-pass-setup.md` (new), `src/mission/service.ts`, `src/apps/server/index.ts`, `src/project/service.ts`, `src/project/contract.ts` (edit)
- Do:
  1. Write `static/plan/suite-pass-setup.md`: front matter `intent: implement` and `commit_type: chore`, the H1 `Add the suite pass record`, `## Requirement` and `## Criterion`. The requirement states the setup of `project-service.impl.md:641`: `.kanthord/suite-pass.json` with `version: 1` and `always_run`, the `.gitignore` exception `!/.kanthord/suite-pass.json`, the record steps, the CI change with the record cache, the job summary and the nightly full run, and, with an affected test declaration, `.kanthord/suite-pass.json`, the record steps and the CI workflow file in `gate_files`. It names plans 06 and 07 of this set as the example of a repository with and with no import graph.
  2. Give the file `verifications` that check the written files with shell commands only: `test -f .kanthord/suite-pass.json`; `! git check-ignore -q .kanthord/suite-pass.json`; `test ! -f .kanthord/affected-tests.json || grep -q '"\.kanthord/suite-pass\.json"' .kanthord/affected-tests.json`.
  3. In `src/mission/service.ts`, add `nodeBodyOf(filename, text)`. It calls `parsePlanFile`, refuses a task file with `mission.import.plan_invalid`, and answers `{ filename, content, tasks: [] }` in the shape of `nodeCreateSchema` without `reason` and `expected_mission_version`.
  4. Add the dependency `nodeBodyOf` to the Project Service dependencies (`src/project/service.ts:624`). Wire it in `src/apps/server/index.ts` beside `createMission` (`:948`).
  5. Add `ProjectErrorCode.SuitePassNotProposed: "project.suite_pass.not_proposed"` with status 409.
  6. Add the operation `binding.suite_pass.plan.get` with the id `project.binding.suite_pass.plan.get`, the route of section "Provides", `human` access and an output schema with `filename`, `content`, `tasks` and `reason`. Describe it: "Read the body of the node create of the suite pass setup node of one repository binding."
  7. Register the handler. It runs `requireRepositoryBinding`. It refuses a binding with no `pull_request` action with `landing: human`. It reads the shipped file with `shippedAsset("plan/suite-pass-setup.md")`, calls `nodeBodyOf("suite-pass-setup-<binding name>.md", text)`, sets `content.bindings` to `[<binding name>]` and adds `reason`. It reads no repository file.
- Cite: decision D12; `project-service.impl.md:639-642`.
- Verify: the tests of task 09.1 steps 6 to 10 pass.

### 09.4 Add the CLI leaf

- Files: `src/apps/cli/project.ts` (edit)
- Do:
  1. In `addEnvironmentCommands` (`:826`), add the command group `suite-pass` with the leaf `plan <project-id> <binding-id>`. It validates both identities with the local codes of task 09.1 step 11, calls the read and prints the answer as indented JSON.
  2. `environment show` prints `suite_pass` with the other fields of the answer.
- Cite: decision D12.
- Verify: the tests of task 09.1 steps 11 and 12 pass.

### 09.5 Regenerate the OpenAPI document and update the CLI page

- Files: `static/openapi/project/*.yaml` (generated), `docs/cli/project.md` (edit)
- Do:
  1. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. Commit the generated change.
  2. In the command table of `docs/cli/project.md` (`:160-176`), add row 23: `environment suite-pass plan <project-id> <binding-id> [R]`, `GET /api/project/:project_id/binding/:binding_id/suite-pass/plan`, `project.binding.suite_pass.plan.get`, `human`; implemented.
  3. Change the count paragraph (`:178`) to 23 route operations for 23 CLI leaves.
  4. In the environment section (`:566`), state `suite_pass` of `environment show`, the leaf `environment suite-pass plan` and its refusals. Give the two steps of the acceptance: save the answer, add `expected_mission_version`, then run `kanthord mission node create <mission-id> --file <path>`.
  5. Add `project.suite_pass.not_proposed` and the two local codes to the error tables of the page.
  6. Run `pnpm exec prettier --write docs/cli/project.md`.
- Cite: `engine/AGENTS.md` "Code rules" — change the declarations, never the generated YAML.
- Verify: `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/` prints nothing after the commit.

### 09.E Gate

- Run `pnpm run verify`. Report each failure and each check that did not run.
- Run `pnpm run build && node bin/kanthord.mjs gateway openapi && git status --porcelain static/`. It prints nothing.
- Run `pnpm exec prettier --check docs/cli/project.md static/plan/suite-pass-setup.md`.
- Confirm that the tests of task 09.1 failed before task 09.2 and pass after task 09.4.
- Run `node bin/kanthord.mjs project environment suite-pass plan --help`. It names both arguments.
