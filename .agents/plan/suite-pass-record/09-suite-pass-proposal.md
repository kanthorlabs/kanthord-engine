# Plan 09: Project Service — the suite pass proposal

## Status

Stub. This plan starts after Ulrich rules open items O1 and O2 of `00-index.md`. The planner then writes the tasks from the ruled options and the design lines that the rulings change. No executor starts this plan before that.

## Scope

Repository: `kanthorlabs/kanthord-engine`.

This plan builds the engine side of the suite pass proposal (`docs/brainstorm/project-service.impl.md:633-641`):

- `suite_pass` in the answer of `project.binding.environment.get` (`:373`, `:636-637`): `present` when `.kanthord/suite-pass.json` exists at the base-branch head, else `absent`, for every source.
- The read of that file outside `files` of the resolution, so the environment digest does not change (`:636`).
- The shipped plan `suite-pass-setup` and the read that gives it to a client (`:639-641`). The setup node writes `.kanthord/suite-pass.json`, the `.gitignore` exception, the record steps and the CI change. With an affected test declaration, it adds `.kanthord/suite-pass.json` and the CI workflow file to `gate_files`. Its verification checks the written files. It lands with `human`.
- The proposal rule: only a binding with the action `pull_request` with `landing: human` gets the proposal (`:638`).
- The CLI `environment show`, `docs/cli/project.md` and the OpenAPI document.

Out of scope:

- The dashboard line. Plan 10 owns it.
- The CI of the engine and the apps repository. Plans 06 and 07 own it.

## Model

Opus at medium effort. The plan crosses the Project Service, the repository file read, the Mission node write and a shipped static file.

## Sources

- `docs/brainstorm/project-service.impl.md:373`, `:633-641`.
- `docs/brainstorm/project-service.vocabulary.md` "suite pass state".
- `docs/brainstorm/mission-service.impl.md:164`, `:226` — `node create` requires `filename` and admits a node at any time.
- Engine `src/project/environment.ts:209-236` (`read`), `:467-517` (`readBase`, `readFiles`); `src/project/contract.ts:793-798` (`environmentAnswerSchema`); `src/mission/contract.ts:671-677` (`nodeCreateSchema`).
- Open items O1 and O2 of `00-index.md`, and the rulings.

## Depends on

- Ulrich ruled O1 and O2.
- Plans 06 and 07 landed, so the shipped plan can copy the record steps of the engine and the apps repository.
- Start from `origin/main` of `kanthorlabs/kanthord-engine`.

## Provides

The contract of plan 10. The rulings of O1 and O2 fix its shape.

## Tasks

The planner writes the tasks after the rulings. Each task holds its files, a reproducing test first, its verify step, and the gate `09.E` with `pnpm run verify`, the OpenAPI check and `prettier --check` of each edited page.
