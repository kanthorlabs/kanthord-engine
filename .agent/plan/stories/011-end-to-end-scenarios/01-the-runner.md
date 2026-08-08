# Story 01 — The runner

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: EPIC 010.6 (sequence order).

## Change

### New — `scripts/e2e/run.mjs`

The entry named by `docs/proposal/README.md:56-58` and by every EPIC Proof. It holds no
logic, because `tsconfig.json:15` includes `scripts/**/*.ts` only, so a `.mjs` file is not
typechecked. Exactly this content:

```js
#!/usr/bin/env node
import { main } from "./lib/main.ts";

process.exitCode = await main(process.argv.slice(2));
```

### New — `scripts/e2e/lib/main.ts`

```ts
export type Invocation = Readonly<{
  scenarioId: ScenarioId;
  tag: string;
  daemonHost: string | null;
  clientHost: string | null;
}>;

export function parseArguments(
  argv: readonly string[],
  mintedTag: string,
): Invocation;

export async function main(argv: readonly string[]): Promise<number>;
```

Argument grammar, exactly:

- one positional, required, the scenario id.
- `--tag <tag>`, optional.
- `--daemon-host <host>`, optional.
- `--client-host <host>`, optional.
- nothing else. Any other token is an error.

`parseArguments` refusals, each thrown as `RunnerError` with the named code:

| condition                                                 | code               | message                          |
| --------------------------------------------------------- | ------------------ | -------------------------------- |
| no positional                                             | `invalid-argument` | `no scenario id`                 |
| two positionals                                           | `invalid-argument` | `more than one scenario id`      |
| positional not in `scenarios`                             | `invalid-argument` | `unknown scenario <id>`          |
| a token starting `--` that is not one of the three        | `invalid-argument` | `unknown option <token>`         |
| an option with no value                                   | `invalid-argument` | `<option> needs a value`         |
| `--tag` value fails `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` | `invalid-argument` | `tag <value> is not a valid tag` |

With no `--tag`, `parseArguments` uses `mintedTag`.

### New — `scripts/e2e/lib/tag.ts`

```ts
export const runRoot = ".data";

export function mintTag(now: Date, entropy: () => string): string;
export function runDirectory(tag: string): string;
export function bundleDirectory(tag: string, scenarioId: ScenarioId): string;
export function claimBundleDirectory(
  tag: string,
  scenarioId: ScenarioId,
): Promise<string>;
```

- `mintTag(now, entropy)` returns `` `${now.toISOString().replaceAll(/[-:.TZ]/g, "")}-${entropy()}` ``
  lowercased. `main` calls it as `mintTag(new Date(), ulid)`. The two seams exist so
  `mintTag` is asserted on an exact value.
- `runDirectory(tag)` returns `.data/acceptance-${tag}`. `.gitignore:146` already ignores
  `.data/acceptance-*/`, and EPIC 012:40 fixes this path.
- `bundleDirectory(tag, id)` returns `${runDirectory(tag)}/${id}`.
- `claimBundleDirectory` calls `mkdir(bundleDirectory(...), { recursive: false })` after
  `mkdir(runDirectory(tag), { recursive: true })`. `EEXIST` on the scenario directory throws
  `RunnerError("tag-reused", \`tag ${tag} already holds a run of ${id}\`)`.

**The refusal is per scenario id, never per tag.** EPIC 012:59-66 runs four scenario ids
under one tag, and EPIC 011:17 requires several invocations of one acceptance run to write
into one place.

### New — `scripts/e2e/lib/command.ts`

```ts
export type CommandRecord = Readonly<{
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

export type CommandInput = Readonly<{
  argv: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: string;
}>;

export type CommandSink = Readonly<{
  print(line: string): void;
  record(entry: CommandRecord): void;
}>;

export function quoteArgv(argv: readonly string[]): string;
export async function runCommand(
  sink: CommandSink,
  input: CommandInput,
): Promise<CommandRecord>;
```

- `quoteArgv` wraps a token in single quotes when it does not match
  `/^[A-Za-z0-9_./:=@-]+$/`, escaping an inner `'` as `'\''`. Joined with one space.
- `runCommand` calls `sink.print(\`e2e: $ ${redact(quoteArgv(input.argv))}\`)`**before**
spawning, then`execFile`-equivalent through `node:child_process.spawn`with`shell: false`, `env: input.env ?? {}`— nothing inherited. It records the result through`sink.record` and returns it. A non-zero exit is returned, never thrown.
- `redact` comes from Story 10. Until Story 10 lands, `redact` is `(text) => text`; Story 10
  replaces the body and this call site does not move.

### New — `scripts/e2e/lib/errors.ts`

```ts
export type RunnerErrorCode =
  "invalid-argument" | "tag-reused" | "unavailable" | "assertion-failed";

export class RunnerError extends Error {
  readonly code: RunnerErrorCode;
  constructor(code: RunnerErrorCode, message: string);
}
```

### `main` control flow, exactly

1. `parseArguments(argv, mintTag(new Date(), ulid))`.
2. `claimBundleDirectory(invocation.tag, invocation.scenarioId)`.
3. Look up the declaration in `scenarios` (Story 06) and call its `run` inside
   `withLedger` (Story 02).
4. Write the bundle (Story 03).
5. Return an exit code from this table, and write one line
   `e2e: <code>: <message>` to stderr for any non-zero:

| outcome                            | exit |
| ---------------------------------- | ---- |
| every assertion passed             | `0`  |
| `assertion-failed`                 | `1`  |
| `invalid-argument` or `tag-reused` | `2`  |
| `unavailable`                      | `3`  |
| any other thrown error             | `4`  |

A bundle is written on every outcome except `invalid-argument` and `tag-reused`, because
neither claimed a bundle directory. A `tag-reused` run must not write into the directory it
just refused to overwrite, and it has no other destination. Both refusals report on stderr
only.

### Changed — `package.json:17`

Add after `"e2e:007"`, keeping the existing entry:

```json
"e2e": "node scripts/e2e/run.mjs",
```

## Constraints

- `scripts/e2e/run.mjs` holds no logic beyond importing `main` and invoking it. It declares
  no function, no branch and no constant. Every future change lands in `scripts/e2e/lib/`.
  `tsc` never sees this file, so a smoke test covers it instead — see Verify.
- Do not touch `scripts/e2e/007/**` or `package.json`'s `e2e:007` entry. The EPIC 007 gate
  is a separate harness and stays as it is.
- The runner never imports from `src/`. It drives the installed binary and speaks HTTP. It
  may import `test/helpers/remote/**` for the fixture remote, which `eslint.config.js:25`
  does not police because the boundaries block covers `src/**/*.ts` and `test/**/*.ts` only.
- `node --test` discovers `scripts/e2e/lib/**/*.test.ts`, so every unit test here runs
  inside `npm run verify`. No test in this EPIC may spawn Podman, open a network socket to
  anything but loopback, or read an ambient `git` configuration.

## Verify

`node --test scripts/e2e/lib/main.test.ts scripts/e2e/lib/tag.test.ts scripts/e2e/lib/command.test.ts`

`scripts/e2e/lib/main.test.ts` asserts:

- `parseArguments(["P1-E1"], "minted")` deep-equals
  `{ scenarioId: "P1-E1", tag: "minted", daemonHost: null, clientHost: null }`.
- `parseArguments(["P1-E3", "--tag", "t1", "--daemon-host", "a", "--client-host", "b"], "m")`
  deep-equals `{ scenarioId: "P1-E3", tag: "t1", daemonHost: "a", clientHost: "b" }`.
- each of the six refusal rows throws `RunnerError` with the exact code and message in the
  table.
- `main(["--tag"])` resolves `2` and writes `e2e: invalid-argument: --tag needs a value\n`
  to the captured stderr.
- `main(["P1-E9"])` resolves `2`.

`scripts/e2e/lib/tag.test.ts` asserts:

- `mintTag(new Date("2026-08-06T12:34:56.789Z"), () => "01ARZ3NDEKTSV4RRFFQ69G5FAV")`
  equals `"20260806123456789-01arz3ndektsv4rrffq69g5fav"`.
- `runDirectory("t1")` equals `".data/acceptance-t1"`.
- `bundleDirectory("t1", "P1-E2")` equals `".data/acceptance-t1/P1-E2"`.
- in a `mkdtemp` cwd: `claimBundleDirectory("t1", "P1-E1")` twice — the first resolves, the
  second rejects with code `tag-reused` and message `tag t1 already holds a run of P1-E1`.
- `claimBundleDirectory("t1", "P1-E1")` then `claimBundleDirectory("t1", "P1-E2")` both
  resolve. This is the EPIC 012 four-scenario case.
- a `tag-reused` run writes no file under `.data/acceptance-t1/P1-E1/` — the directory
  content before and after deep-equals.

`scripts/e2e/lib/shim.test.ts` asserts, because `tsc` does not cover `run.mjs`:

- spawning `[process.execPath, "scripts/e2e/run.mjs", "P1-E9"]` from the repository root
  exits `2` and writes `e2e: invalid-argument: unknown scenario P1-E9\n` to stderr. This
  proves module resolution, the `.ts` import from a `.mjs` file, and top-level await all
  work under the real loader.
- spawning it with no argument exits `2`.
- the file text matches `/^#!\/usr\/bin\/env node\nimport \{ main \} from "\.\/lib\/main\.ts";\n\nprocess\.exitCode = await main\(process\.argv\.slice\(2\)\);\n$/`.

`scripts/e2e/lib/command.test.ts` asserts:

- `quoteArgv(["git", "log", "--format=%H"])` equals `"git log --format=%H"`.
- `quoteArgv(["echo", "a b", "it's"])` equals `"echo 'a b' 'it'\\''s'"`.
- `runCommand` against `[process.execPath, "-e", "process.stdout.write('x')"]` records
  `exitCode: 0`, `stdout: "x"`, and the sink received the printed line
  before the record — asserted by a sink that appends both to one ordered array.
- `runCommand` against a command exiting `3` returns `exitCode: 3` and does not throw.
- `runCommand` passes `env: {}` by default — asserted by a
  `/usr/bin/env` child, invoked with no arguments, whose output is the empty string.

`npm run verify` exits 0.

Proof: this story delivers no `PASS` line on its own. It is the precondition of every
`node scripts/e2e/run.mjs <id>` line in the EPIC 011 Proof block.
