# Agent instructions

The design pages and implementation siblings under `docs/brainstorm/` of the
kanthord repository (`../docs/brainstorm/` in the superrepo) hold the rules.
An engine document never overrides them. A conflict is a defect of the engine
document.

## Layout

- `src/worker/` is the Worker Service of the server. `src/worker/unit/` is the
  run side that every placement hosts. `src/apps/worker/` is the worker
  application around one unit.
- `src/apps/server/index.ts` is the composition root. `src/main.ts` only
  dispatches the CLI.

## Validate

- Run `pnpm run verify` before handoff. Report each failure and each check
  that did not run.
- Run one test file with
  `PATH="$(node scripts/test-path.mjs)" node --test --test-timeout=60000 <file>`.
- Run `pnpm run test:e2e:jwt` after an authentication change. See
  [JWT acceptance checks](docs/testing.md).

## Code rules

- Keep no backward compatibility. The project has no deployment yet.
  `kanthord.yaml` is the one exception. For a breaking change of the
  configuration, append one step to `CONFIG_STEPS` in `src/config/steps.ts`.
  Never edit a published step. Add a case to `src/config/upgrade.test.ts`.
  Update the field list in `docs/cli/other.md`.
- Change a table only in the one migration of its service. Edit its
  `CREATE TABLE` or `CREATE UNIQUE INDEX` text in place. Add no `ALTER TABLE`,
  no `UPDATE` and no second migration.
- Change operation declarations, never the generated YAML under `static/`.
  Regenerate it with `pnpm run build && node bin/kanthord.mjs gateway openapi`.
- A handler that calls a peer for its caller passes `caller.identity` in
  `ClientOptions.identity`. Only a background producer passes its own service
  identity.
- A slot of the server pool logs under `workers/<client_id>/` of the server
  state directory. The server log holds no record of a worker unit.

## Plans

- Before you ask for a ruling on a shared token, list `.agents/plan/` again.
  Search the sibling plans for the token and name each sibling that chose it.
- Re-anchor a drifted `file:line` citation to the sentence or code block that
  the text means, not to the first match. Re-anchor only the citations that
  your own edit shifted, in the files that you edited.
