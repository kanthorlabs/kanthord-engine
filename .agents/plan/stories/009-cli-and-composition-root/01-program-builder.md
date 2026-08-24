# Story 01 — the extracted program builder

Epic: `.agents/plan/epics/009-cli-and-composition-root.md`
Depends on: EPIC 008 Story 14 and Story 15 (`src/cli/project/`, `src/cli/plan/`).

`eslint.config.js:314-334` forbids a test from importing `src/main.ts`. The commander program is built inside `src/main.ts:79-405`, so no test can see it. Story 03 asserts parity against the built program, and this story is what makes the program reachable.

## Change

### 1. `src/cli/program.ts` (new) — the one program builder

```ts
import type { Command } from "commander";

import type { ConfirmDependencies } from "./confirm.ts";
import type { AppliedMigrationLine } from "./db/migrate.ts";

export type ServeOptions = Readonly<{
  config: string | undefined;
  home: string | undefined;
}>;

export type ProgramDependencies = Readonly<{
  env: Readonly<Record<string, string | undefined>>;
  fetch: typeof globalThis.fetch;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
  exit: (code: number) => void;
  confirm: ConfirmDependencies;
  readFile: (path: string) => string;
  fs: PlanDirectoryDependencies;
  migrate: (
    input: Readonly<{ home: string | undefined; config: string | undefined }>,
  ) => readonly AppliedMigrationLine[];
  serve: (options: ServeOptions) => Promise<void>;
}>;

export function buildProgram(dependencies: ProgramDependencies): Command;
```

`cwd` and `fs` exist because `.agents/plan/stories/008-project-and-plan/15-plan-cli-handshake.md:101` registers `plan import` and `plan export` with `{ …, cwd: process.cwd(), fs: { … } }`, where the five members are `readdirSync`, `readFileSync`, `writeFileSync`, `mkdirSync` and `rmSync`. `PlanDirectoryDependencies` is the type that story declares at `src/cli/plan/directory.ts`. `readFile` stays a separate member because `registerCredentialRegister` takes it alone (`src/main.ts:384`). **This bag is the complete final shape after EPIC 008. Do not derive it from the current tree.**

`buildProgram` performs, in this order:

1. `new Command().name("kanthord").version(KANTHORD_VERSION).option("--config <path>", "path to the configuration file").option("--home <path>", "override the configured daemon home")` — the four lines moved verbatim from `src/main.ts:79-83`.
2. `registerClientOptions(program)` — moved from `src/main.ts:85`.
3. `program.command("serve").description("run the daemon").action(async () => { const options = program.opts(); await dependencies.serve({ config: options.config, home: options.home }); })`. The whole daemon body of `src/main.ts:90-277` stays in `src/main.ts` and becomes the injected `serve`.
4. The client factory and the `DaemonClient`, moved from `src/main.ts:335-355` with `process.env` replaced by `dependencies.env` and `globalThis.fetch` by `dependencies.fetch`:

```ts
const clientFactory = (): ClientDependencies => {
  const options = resolveClientOptions({ program, env: dependencies.env });
  return {
    baseUrl: requireBaseUrl(options),
    token: options.token,
    fetch: dependencies.fetch,
  };
};
const client: DaemonClient = {
  call: (operationId, body, parameters) =>
    call(clientFactory(), { operationId, body, parameters }),
};
```

5. The eleven `register*` calls, in this exact order, each taking its member of `dependencies` in place of the `process.*` closure `src/main.ts` passes today:

| call                         | input                                                               |
| ---------------------------- | ------------------------------------------------------------------- |
| `registerDbMigrate`          | `{ program, env, stdout, stderr, fail, migrate }`                   |
| `registerDbStatus`           | `{ program, client: clientFactory, stdout, stderr, exit }`          |
| `registerCredentialRegister` | `{ program, client, env, confirm, readFile, stdout, stderr, fail }` |
| `registerRepositoryRegister` | `{ program, client, env, confirm, stdout, stderr, fail }`           |
| `registerRepositoryShow`     | `{ program, client, env, stdout, stderr, fail }`                    |
| `registerProjectCreate`      | `{ program, client, stdout, stderr, fail }`                         |
| `registerProjectList`        | `{ program, client, stdout, stderr, fail }`                         |
| `registerProjectShow`        | `{ program, client, stdout, stderr, fail }`                         |
| `registerProjectRepository`  | `{ program, client, stdout, stderr, fail }`                         |
| `registerPlanImport`         | `{ program, client, confirm, cwd, fs, stdout, stderr, fail }`       |
| `registerPlanExport`         | `{ program, client, cwd, fs, stdout, stderr, fail }`                |

`registerDbStatus` is the one call taking the factory rather than the `DaemonClient`, matching `src/cli/db/status.ts:12`. 6. `return program`. `buildProgram` never calls `parseAsync`.

### 2. `src/cli/db/migrate.ts:16` — widen `MigrateHandler`

Replace

```ts
export type MigrateHandler = (
  input: Readonly<{ home: string | undefined }>,
) => readonly AppliedMigrationLine[];
```

with

```ts
export type MigrateHandler = (
  input: Readonly<{ home: string | undefined; config: string | undefined }>,
) => readonly AppliedMigrationLine[];
```

In the action body, pass `config: input.program.opts().config` beside the existing `home`. `src/main.ts:293` reads `program.opts().config` inside its own closure today; after extraction the closure no longer holds the program, so the value arrives through the handler input instead.

### 3. `src/main.ts:79-406` — replace with a dependency bag and one call

`src/main.ts` keeps: every import of an implementation, the whole `serve` body (now a named `async function serve(options: ServeOptions): Promise<void>` taking `options.config` and `options.home` where it reads `program.opts()` at `:91`), the `migrate` closure of `:289-333` (now reading `input.config` instead of `program.opts().config`), the `confirm` object of `:356-369`, the three writers of `:370-378`, and both `catch` blocks unchanged.

`src/main.ts` then ends with

```ts
const program = buildProgram({
  env: process.env,
  fetch: globalThis.fetch,
  cwd: process.cwd(),
  fs: {
    readDirectory: readdirSync,
    readFile: readFileSync,
    writeFile: writeFileSync,
    makeDirectory: mkdirSync,
    removeFile: rmSync,
  },
  stdout: writeOut,
  stderr: writeErr,
  fail,
  exit: (code) => {
    process.exitCode = code;
  },
  confirm,
  readFile: (path) => readFileSync(path, "utf8"),
  migrate,
  serve,
});
await program.parseAsync(process.argv);
```

inside the existing `try` of `:280-419`.

## Constraints

- `buildProgram` names no implementation, reads no environment variable directly, and touches no `process` member. Every effect arrives through `ProgramDependencies`. This is what makes it constructible in a test.
- The registration order of section 1 step 5 is the help order. Do not reorder it.
- `src/cli/program.ts` imports `commander` and files under `src/cli/` only. `eslint.config.js:158-168` allows `domain`, `http-contract` and `cli`; `KANTHORD_VERSION` comes from `src/domain/version.ts`.
- `src/main.ts` stays the only file that constructs an implementation, and nothing imports it. `eslint.config.js:314-334` enforces both.
- Delete no assertion. Every existing test under `src/cli/` builds its own `Command` and calls one `register*` function directly; none of them goes through `buildProgram`, so none changes except the two named below.

## Verify

```bash
node --test src/cli/program.test.ts src/cli/db/migrate.test.ts src/cli/db/index.test.ts
```

### `src/cli/program.test.ts` (new)

A `fakeDependencies()` factory returns a `ProgramDependencies` whose `fetch` throws, whose `serve` and `migrate` record their input, and whose four writers accumulate.

- `buildProgram(fakeDependencies())` returns a `Command` whose `name()` is `"kanthord"` and whose `version()` is `KANTHORD_VERSION`.
- The top-level subcommand names, sorted bytewise, deep-equal `["credential", "db", "plan", "project", "repository", "run", "serve", "status"]` — after Story 05 and Story 06 land. Before them, the same assertion holds without `"run"` and `"status"`; the two stories each edit this literal, in the order Story 05 then Story 06.
- `parseAsync(["serve"], { from: "user" })` calls the injected `serve` exactly once with `{ config: undefined, home: undefined }`.
- `parseAsync(["--config", "/c.json", "--home", "/h", "serve"], { from: "user" })` calls it once with `{ config: "/c.json", home: "/h" }`.
- `parseAsync(["db", "migrate", "--home", "/h"], { from: "user" })` calls the injected `migrate` exactly once with `{ home: "/h", config: undefined }`.
- `parseAsync(["db", "status"], { from: "user" })` with no `--base-url` and an empty `env` writes `kanthord: cli-base-url-missing: ` to stderr, calls `exit` once with `1`, and never calls `fetch`.
- Two `buildProgram` calls return two distinct `Command` objects. No module-level program.

### `src/cli/db/migrate.test.ts`

- Every recorded-input assertion gains `config: undefined`. The nine existing tests keep their current subjects.
- One new test: a program parsed as `["--config", "/c.json", "db", "migrate", "--home", "/h"]` records `{ home: "/h", config: "/c.json" }`.

### `src/cli/db/index.test.ts`

- Unchanged. It builds its own `Command` and never reaches `buildProgram`.

`npm run verify` exits 0.

Proof: contributes `src/cli/program.test.ts` to `node --test src/cli/**/*.test.ts`, and keeps `src/cli/db/migrate.test.ts` in it.
