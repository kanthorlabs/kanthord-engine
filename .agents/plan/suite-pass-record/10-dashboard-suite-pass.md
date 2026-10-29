# Plan 10: Dashboard — the suite pass proposal line

## Status

Stub. This plan starts after Ulrich rules open items O1 and O2 of `00-index.md` and after plan 09 merges. The planner then writes the tasks from the ruled options and the contract of plan 09. No executor starts this plan before that.

## Scope

Repository: `kanthorlabs/kanthord-apps`.

This plan builds the dashboard line of the suite pass proposal (`docs/brainstorm/project-service.impl.md:802`): "A binding with `suite_pass` `absent` and the proposal shows "Add the suite pass record so that CI skips the test files that already passed." and the action `Import setup plan`. The action imports the plan `suite-pass-setup`."

- The `Environment` section of the sheet of a repository binding shows the line and the action.
- `src/api/types.ts` follows the answer of `project.binding.environment.get` with `suite_pass`.
- The action calls the operation that the ruling of O1 names. The ruling of O1 also names the label of the action.
- `mock/` serves the changed answer and the new call.

Out of scope:

- The engine. Plan 09 owns it.

## Model

Sonnet at high effort. The plan adds one line, one action and one resource function to a fixed contract.

## Sources

- `docs/brainstorm/project-service.impl.md:794-804` — the `Environment` section of the binding sheet.
- `apps/AGENTS.md` "Architecture" and "Design" — the api boundary, `mock/`, a destructive or irreversible action guard, both widths.
- Open items O1 and O2 of `00-index.md`, and the rulings.

## Depends on

- Ulrich ruled O1 and O2.
- Plan 09 merged to `main` of the engine.
- Start from `origin/main` of `kanthorlabs/kanthord-apps`.

## Provides

The dashboard of the proposal. No engine seam.

## Tasks

The planner writes the tasks after the rulings. Each task holds its files, a reproducing test first, its verify step, and the gate `10.E` with `pnpm verify` and the browser check at 1280 by 800 and at 390 by 844.
