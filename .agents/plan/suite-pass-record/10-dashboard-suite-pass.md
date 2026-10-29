# Plan 10: Dashboard — the suite pass proposal line

## Scope

Repository: `kanthorlabs/kanthord-apps`.

This plan builds the dashboard line of the suite pass proposal (decisions D12 and D14).

Today `BindingEnvironment` holds no `suite_pass` (`src/api/types.ts:449-454`). The `Environment` section of the binding sheet shows no proposal (`src/features/projects/view/components/environment-section.tsx`). No resource function reads the setup node body or calls `mission.node.create` (`src/api/resources/mission.ts`).

The plan delivers:

- `suite_pass` in `BindingEnvironment`, the type of the setup node body and the type of `mission.node.create`.
- `readSuitePassPlan` and `createMissionNode` in `src/api/resources/`.
- The hook `src/features/projects/view/use-suite-pass-proposal.ts`, beside `use-binding-environment.ts`: the proposal rule and the two calls.
- The line "Add the suite pass record so that CI skips the test files that already passed." and the action `Add setup node` in the `Environment` section.
- `mock/` serves `suite_pass`, the plan read and the node create.

Out of scope:

- The engine. Plan 09 owns it.
- Any other action of the `Environment` section.

## Model

Sonnet at high effort. The plan adds one line, one action, two resource functions and one hook to a fixed contract.

## Sources

Root pull request #281 at head `7c0e114` is the rule:

- `docs/brainstorm/project-service.impl.md:803` — the line, the action `Add setup node` and its node create.
- `docs/brainstorm/project-service.impl.md:638-640` — the null state, the binding that gets the proposal and the node create.
- `docs/brainstorm/project-service.impl.md:794-806` — the `Environment` section of the binding sheet; `:801` gives the toast pattern of `Run onboarding again`.
- `apps/AGENTS.md` "Architecture" — `src/api` is the only place that calls a server, a component holds no business logic, `mock/` follows each new operation.
- `apps/AGENTS.md` "Design" — both widths and the browser check.

## Depends on

- Plan 09 merged to `main` of the engine.
- Start from `origin/main` of `kanthorlabs/kanthord-apps`.

## Provides

The dashboard of the proposal. No engine seam.

## Tasks

### 10.1 Write the reproducing tests

- Files: `src/features/projects/view/components/bindings-panel.test.tsx`, `src/api/resources/projects.test.ts`, `src/api/resources/mission.test.ts` (edit)
- Do:
  1. In `bindings-panel.test.tsx`, add the test "shows the suite pass proposal for a binding with suite_pass absent and a human landing". Open the sheet of a repository binding with a `pull_request` action with `landing: human`. Answer `suite_pass: "absent"`. Assert the line "Add the suite pass record so that CI skips the test files that already passed." and the button `Add setup node`.
  2. Add the test "shows no proposal for suite_pass present, for suite_pass null and for another landing". Assert no line and no button in each case.
  3. Add the test "Add setup node creates the setup node with the mission version". Answer the plan read with a body and the mission read with `mission_version: 3`. Click `Add setup node`. Assert one call of `createMissionNode` with the mission identity and the body plus `expected_mission_version: 3`, and the toast "Setup node of <binding> added.".
  4. Add the test "a refused node create shows an error toast with Retry". Answer 409 `mission.version.conflict` (engine `src/mission/contract.ts:404`). Assert the error toast and `Retry`.
  5. In `projects.test.ts`, add the test "readSuitePassPlan reads the suite pass plan route". Assert `/api/project/<project>/binding/<binding>/suite-pass/plan` with encoded identities.
  6. In `mission.test.ts`, add the test "createMissionNode posts the body to the node route of the mission". Assert `POST /api/mission/<mission>/node`.
- Verify: `pnpm exec vitest run src/features/projects/view/components/bindings-panel.test.tsx src/api/resources/projects.test.ts src/api/resources/mission.test.ts` fails on the new tests only.

### 10.2 Add the types and the resource functions

- Files: `src/api/types.ts`, `src/api/resources/projects.ts`, `src/api/resources/mission.ts` (edit)
- Do:
  1. Add `readonly suite_pass: "present" | "absent" | null` to `BindingEnvironment` (`src/api/types.ts:449-454`).
  2. Add `MissionNodeCreateBody` with `filename`, `content`, `tasks` and `reason`, and `MissionNodeCreate` with the body and `expected_mission_version`, as `nodeCreateSchema` of the engine (`src/mission/contract.ts:671-677`) holds them. Add the answer type of the node create as the engine contract holds it.
  3. Add `readSuitePassPlan(projectId, bindingId)` beside `readBindingEnvironment` (`src/api/resources/projects.ts:186-196`).
  4. Add `createMissionNode(missionId, body)` to `src/api/resources/mission.ts`. It sends `POST /api/mission/:mission_id/node`.
- Cite: decision D12; `apps/AGENTS.md` — `src/api/types.ts` follows the contract.
- Verify: the tests of task 10.1 steps 5 and 6 pass.

### 10.3 Show the proposal and its action

- Files: `src/features/projects/view/use-suite-pass-proposal.ts` (new), `src/features/projects/view/components/environment-section.tsx`, `mock/environments.mjs`, `mock/daemon.mjs` (edit)
- Do:
  1. In `use-suite-pass-proposal.ts`, answer `proposed`: true when `suite_pass` is `absent` and the binding configuration holds a `pull_request` action with `landing: human` (decision D14). Answer `add()`: it calls `readSuitePassPlan`, then `readMission` of the project for its version, then `createMissionNode` with the body and `expected_mission_version`. It shows the toast "Setup node of <binding> added." on success. It shows an error toast with `Retry` on a refusal, as `Run onboarding again` does (`project-service.impl.md:801`).
  2. In `environment-section.tsx`, when `proposed` is true, show the line of `project-service.impl.md:803` and the button `Add setup node` beside the actions of the section. The button is disabled while `add()` runs.
  3. In `mock/environments.mjs`, answer `suite_pass` for each binding: `absent` for one binding with a human landing, `present` for another binding. Serve the plan read with a fixed body.
  4. In `mock/daemon.mjs`, serve `POST /api/mission/:mission_id/node`. It adds the node to the mock mission and raises its version.
- Cite: decisions D12 and D14; `project-service.impl.md:803`.
- Verify: the tests of task 10.1 pass.

### 10.E Gate

- Run `pnpm verify` in `apps/`.
- Confirm that the tests of task 10.1 failed before task 10.2 and pass after task 10.3.
- Run `pnpm dev:all`. Open the sheet of the binding with `suite_pass` `absent` at its `Environment` section, at 1280 by 800 and at 390 by 844. Check the line and the button, click `Add setup node`, and check the toast and the new node in the mission panel, with no horizontal scroll. Attach both screenshots to the pull request body.
