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

- In a new worktree, run `pnpm run pi-tools:fetch` after `pnpm install`. The
  tests fail when the `fd` and `rg` tools are absent. The fetch reads
  `$XDG_CACHE_HOME/kanthord/pi-tools/` before a download, and writes a
  downloaded tool to it.
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
- Never declare a SQL `CHECK` constraint. Define a closed value set as an enum
  in code. The owning service validates the value before the write.
- Never declare an index that is not a unique index.
- Change operation declarations, never the generated YAML under `static/`.
  Regenerate it with `pnpm run build && node bin/kanthord.mjs gateway openapi`.
- A handler that calls a peer for its caller passes `caller.identity` in
  `ClientOptions.identity`. Only a background producer passes its own service
  identity.
- A server instance logs under `workers/<instance name>/` of the server
  state directory. The server log holds no record of a worker unit.
- A `require` or `createRequire(...).resolve` specifier names a declared
  dependency. With the pnpm global virtual store, `NODE_PATH` resolves an
  undeclared one in KanthorD and not in a consumer install.

## Tests

1. **Happy-path test first.** Give each public capability one test of its
   normal use. A public capability is a Gateway operation, a CLI command, a
   worker or server lifecycle step, or a cross-service flow. Write the test at
   the composed server under `src/apps/server/`. Write it at the service only
   when the composed server cannot reach the capability. A capability with more
   than one normal mode gets one test per mode.
2. **Security tests.** Give each case of authentication, authorization, secret
   redaction, the credential holder check, a refused path, a host rule and an
   argument guard its own test. A refusal case that asserts the same code on
   the same path as another kept case is a duplicate. Cut the duplicate. Every
   other refusal case is a security case. Never cut a case whose lines hold a
   security token, also as a duplicate. The security tokens are the extended
   regular expression
   `authorization\.refused|AuthorizationRefused|access\.service_refused|unauthori[sz]ed|unauthenticated|caller\.identity|redact|sealed_unopened|sealed\.invalid|HolderMismatch|holder_mismatch|holder_refused|holder_unknown|HolderRefusal|path_refused|host_not_allowed|_forbidden|token_required|token_lifetime|master_key_mismatch|lease_mismatch|sign_refused|placement_refused|key_refused`.
   For example, `src/gateway/host-rule.test.ts` asserts the code
   `gateway.http.host_not_allowed`.
3. **Invariant guards.** Give each write path one test for its rollback, for
   the race of two writers, for an idempotent replay and for data loss, when
   the path has that risk.
4. **Regression tests.** Before you fix a bug that someone found, write a test
   that reproduces it. Start its title with `regression:` and name the bug.
5. **No schema field tests.** Write no test for a field that a zod schema
   checks. One test shows that the Gateway answers
   `gateway.request.validation_failed`.
6. **Mandated tests.** Keep each case of `src/config/upgrade.test.ts`, of each
   `migrations.test.ts`, of `import-boundaries.test.ts`,
   `unwired-import.test.ts`, `unwired.test.ts` and `container-live.test.ts`,
   and of each file of `always_run` of `.kanthord/suite-pass.json`. In each
   other file that calls `startTestSshd`, keep one case that calls it.
7. **No other test.** Write no other test. Assert the observed result and the
   error code. Do not assert the message text, a declaration literal or a mock
   argument that the code copies from its input. Keep each assertion of a
   forwarded `caller.identity`.

## Code shape

1. **Validation in schemas.** Validate a new external input with a zod schema
   at the boundary. Repeat no check of the schema in a service, unless a caller
   reaches the service outside the Gateway or an error table of `docs/cli/`
   names the code of the check.
2. **Parameters.** Give a function at most 3 parameters: at most 2 single
   parameters plus 1 options object. Give the options object a named interface
   or type. Write no object type inline in a parameter list. When a third-party
   type fixes the signature of a callback, take `...args: Parameters<T>` with
   `T` the callback type. For example, the bash tool `execute` of
   `src/worker/unit/tool-table.ts:128-137` takes
   `...args: Parameters<typeof declared.execute>`.
3. **Small functions.** Keep the cyclomatic complexity of a function at 10 or
   below. A function above 10 holds more than one job. Split it. Keep each new
   helper in the file of its caller.
4. **Lint before prompt.** Lint enforces each rule that a tool can measure.
   `eslint-suppressions.json` holds the baseline of the violations at the
   commit that added it. Add no entry to it. Suppress no new violation.

## Plans

- Before you ask for a ruling on a shared token, list `.agents/plan/` again.
  Search the sibling plans for the token and name each sibling that chose it.
- A node whose verification runs a test file that contains `startTestSshd`
  carries the tag `sshd`. Only a worker binding whose host has an executable
  `sshd` binary carries that tag.
- Re-anchor a drifted `file:line` citation to the sentence or code block that
  the text means, not to the first match. Re-anchor only the citations that
  your own edit shifted, in the files that you edited.
