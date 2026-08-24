# EPIC 001 — Runtime foundation — stories

Epic: `.agents/plan/epics/001-runtime-foundation.md`
Prereq: none. This is the first epic. The repository holds `src/main.ts` with one `console.log` and nothing else.

The daemon starts from `kanthord serve`, reads a discovered JSON configuration file, and holds an exclusive lock on its home until the process dies.

## Dispatch order

```
01 → 02 → 03 → 04 → 05 → 06 → 08 → 07 → 09
```

- `01` and `02` are a coupled pair: `02` adds discovery and the entry point around the loader `01` writes.
- `03` follows `02`, because its lint cases name `src/services/config/*.ts`, `src/domain/version.ts` and `src/main.ts`, and every path a case names must be a real file. It must land before `05`, which is the first capability the current single-element pattern cannot police.
- `05`, `06` and `07` are a coupled run on one capability: `06` adds the identity file to the handle `05` returns, and `07` adds the startup sequence to that same handle and calls all three from `src/main.ts`.
- `08` precedes `07`, because `07`'s child-process tests are written against `test/helpers/daemon.ts`.
- `09` is last and touches `package.json` only, so the gate every earlier story ran is the gate this epic leaves behind.

## Stories

- 01 — the convict loader and the settings shape → `01-config-service.md`
- 02 — the search order, `bin`, `--version` → `02-config-discovery-and-entry-point.md`
- 03 — one element per capability, and the lint-config test → `03-layer-boundaries.md`
- 04 — the two refusals inside `load()` → `04-startup-refusal-rules.md`
- 05 — `services/home-lock` and the held `BEGIN IMMEDIATE` → `05-home-lock-service.md`
- 06 — `daemon.lock.identity` and the contender protocol → `06-holder-identity.md`
- 07 — the startup sequence → `07-startup-sequence.md`
- 08 — `test/helpers/` and the daemon launcher → `08-harness-helpers.md`
- 09 — `npm run verify` without the `db status` step → `09-staged-verify.md`

## Facts (needed for implementation)

Greenfield. `src/main.ts:1` is `console.log("Hello, World!");` and is the only production file. `src/domain/`, `src/services/`, `src/commands/`, `src/queries/`, `src/http/`, `src/cli/` and `test/` do not exist.

- Node is `v24.17.0`. It runs `.ts` by type stripping, so a relative import carries `.ts`, and `node --test src/**/*.test.ts` needs no flag. A `bin` target may be a `.ts` file with a `#!/usr/bin/env node` shebang — verified.
- `tsconfig.json:18` is `"include": ["src/**/*.ts"]`. `test/` is outside the type check until story 03 adds it.
- `eslint.config.js` exists and encodes the AGENTS.md matrix. Four facts about it, each measured against `eslint-plugin-boundaries@7.0.2`:
  - `eslint.config.js:32` declares `{ type: "service", pattern: "src/services", partialMatch: false }` — one element for every capability, so a cross-capability implementation import is not caught.
  - `eslint.config.js:55` declares the `test` file category as `src/**/*.test.ts` only, so a file under `test/helpers/` is not in that category and the composition-root ban does not reach it.
  - The relaxed test block bans the composition root only for the `test` file category, so a non-test file under `test/helpers/` may import `src/main.ts`. It needs a policy of its own.
  - The plugin resolves element patterns against `settings["boundaries/root-path"]`, defaulting to the ESLint `cwd`. `npm run lint` runs at the repository root, so no `root-path` setting is needed.
  - A same-element import is allowed with no policy, and a capture-templated same-capability policy matches every pair instead. The `capability` capture alone is the fix.
- `node:sqlite` measurements, all on Node 24.17.0 (story 05 and story 06 depend on each one):
  - `PRAGMA busy_timeout = 0` then `BEGIN IMMEDIATE` on a second connection throws `Error` with `code: "ERR_SQLITE_ERROR"`, `errcode: 5`, `errstr: "database is locked"`.
  - The same call on a file that is not a database throws `errcode: 26`, `errstr: "file is not a database"`.
  - `BEGIN IMMEDIATE` under `journal_mode = DELETE` creates a 512-byte `<db>-journal` immediately, and a `SIGKILL` leaves it behind. The next `BEGIN IMMEDIATE` from a new process rolls it back, removes the journal and succeeds. Journal creation is a canary on our own pragma set, never a product invariant: only the recovery is asserted through a child process.
  - `new DatabaseSync(path)` creates a missing file with mode `0644`.
  - `fs.statfsSync` reports `type: 26` for APFS on Darwin, which is a table index and not a filesystem magic number. The magic-number deny set is meaningful on Linux only. `docs/proposal/phase-1/git-foundation.md:90-94` states that scope: the refusal is effective where the platform reports a type, and a Darwin home starts.
  - `fs.openSync(path, "a", 0o600)` applies its mode only when the call creates the file. An existing `0644` file keeps `0644`, so `fs.fchmodSync` follows it.
  - `DatabaseSync.close()` twice throws `ERR_INVALID_STATE`, so an idempotent `release()` needs its own flag.
- `convict@6.2.5` measurements, which decide Story 01's schema:
  - `String` accepts `""`, `Array` accepts `[]`, and `"nat"` accepts `0`. Every non-empty and positive rule is therefore a custom format function.
  - An `Array` format with an `env` mapping splits the environment value on `,` by itself, but trims nothing and drops nothing: `"x:1, y:2 ,,z:3"` arrives as `["x:1", " y:2 ", "", "z:3"]`.
- Platform assumption: Linux and Darwin. Every rule here needs POSIX — a `fcntl` record lock, a file mode, `SIGTERM`, `SIGKILL` — so a test asserts a signal name and an octal mode with no platform branch.
- The vendor packages are installed already: `convict@^6.2.5`, `zod@^4.4.3`, `commander@15.0.0`, `ulid@3.0.2`. No dependency is added by this epic.
- `package.json:12` declares `"verify": "npm run typecheck && npm test && npm run lint && node src/main.ts db status"`. Story 09 removes the last step.
- Sources: `docs/proposal/phase-1/git-foundation.md:55-112` (the home lock and the identity file), `docs/proposal/phase-1/transport.md:12-21` (the bind address and the token), `docs/proposal/phase-2/providers-and-credentials.md:11` (the master key and mode `0600`), `docs/proposal/api/README.md:120-124` (the actor from configuration).
