# Story 12 — The CLI commands

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 11 (the projection), EPIC 004 Story 07 (`src/cli/client.ts`, `src/cli/options.ts`, `src/cli/exit-code.ts`).

`kanthord credential register`, `kanthord repository register` and `kanthord repository show`. `--credential <name>` resolves to an id before the call. The register command refuses when neither a prompt nor a flag answered a confirmation.

`cli/` imports `domain/`, `http/contract/` and `cli/` only, enforced by `eslint.config.js:158-168`. It reaches the daemon over HTTP and imports no command and no query.

## Change

### 1. `src/cli/confirm.ts` (new) — the confirmation rule, once

```ts
export type ConfirmDependencies = Readonly<{
  isTty: boolean;
  prompt: (question: string) => Promise<string>;
}>;

export type ConfirmInput = Readonly<{
  flagName: string;
  flagValue: string | undefined;
  question: string;
  suggestion: string | null;
}>;

export class ConfirmationRequiredError extends Error {
  readonly flagName: string;
  constructor(flagName: string);
}

export function confirmValue(
  dependencies: ConfirmDependencies,
  input: ConfirmInput,
): Promise<string>;
```

1. A non-empty `flagValue` is returned unchanged, and no prompt is shown. The flag always wins.
2. Otherwise, when `dependencies.isTty` is `false`, throw `ConfirmationRequiredError(input.flagName)` whose message is `` `${input.flagName} is required when there is no terminal to confirm on` ``.
3. Otherwise show `input.question`, with `input.suggestion` rendered as `` ` [${input.suggestion}]` `` when it is not `null`. An empty answer returns the suggestion; an empty answer with a `null` suggestion re-asks. A non-empty answer is returned trimmed.

One function serves both confirmations, so `--upstream` and `--host-fingerprint` cannot diverge. `docs/proposal/api/repository.md:24` and `:42` state them as the same rule.

`isTty` is `process.stdout.isTTY === true && process.stdin.isTTY === true`, computed in `src/main.ts` and injected. A command module reads no `process` member.

### 2. `src/cli/credential/register.ts` (new)

```ts
export type RegisterCredentialInput = Readonly<{
  program: Command;
  client: DaemonClient;
  env: Readonly<Record<string, string | undefined>>;
  confirm: ConfirmDependencies;
  readFile: (path: string) => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerCredentialRegister(
  input: RegisterCredentialInput,
): void;
```

`kanthord credential register` with these options:

| option                      | meaning                                               |
| --------------------------- | ----------------------------------------------------- |
| `--name <name>`             | required                                              |
| `--kind <kind>`             | required, `llm` or `git`                              |
| `--transport <transport>`   | `git` only, `http-basic` or `ssh`                     |
| `--forge <forge>`           | `git` / `http-basic` only                             |
| `--username <username>`     | `git` / `http-basic` only                             |
| `--token-file <path>`       | `git` / `http-basic` only                             |
| `--private-key-file <path>` | `git` / `ssh` only                                    |
| `--provider <provider>`     | `llm` only                                            |
| `--model <model>`           | `llm` only                                            |
| `--base-url <url>`          | `llm` only, the provider's base url, not the daemon's |
| `--api-key-file <path>`     | `llm` only                                            |

**A secret arrives by file path, never as a flag value.** `argv` is readable by any process of the same user, and `docs/proposal/phase-1/git-foundation.md:80` states the rule for the daemon's own children; a CLI that put a token in `argv` would leak it before the daemon ever ran. `--token-file`, `--private-key-file` and `--api-key-file` are read with `input.readFile` and trimmed of a single trailing newline. There is no `--token`, no `--private-key` and no `--api-key` option, and their absence is asserted.

The command assembles the payload, `POST`s to `provider.register`, and prints one line per field of the returned projection:

```
kanthord: registered <name> <id>
kanthord: transport <transport>
kanthord: forge <forge>
```

A refusal writes `kanthord: <error.code>: <error.message>\n` to stderr and calls `fail()`. The `--kind` and `--transport` combinations the CLI can check itself are checked before the request: a `git` kind with no `--transport` writes `kanthord: invalid-request: --transport is required for --kind git\n` and calls `fail()` without a request. A flag belonging to another kind is the same shape.

### 3. `src/cli/repository/register.ts` (new)

```ts
export function registerRepositoryRegister(
  input: RegisterRepositoryCliInput,
): void;
```

`kanthord repository register` with `--name <name>`, `--url <url>`, `--credential <name>`, `--upstream <branch>`, `--landing <branch>`, `--publish-ref <ref>`, `--host-fingerprint <value>` and `--no-publish-on-approval`.

Sequence:

1. **`--credential <name>` resolves to an id.** `GET provider.list`, then find the single item whose `name` equals the value. No match writes `kanthord: not-found: no credential named <name>\n` and calls `fail()`. The resolution is client-side because `docs/proposal/api/repository.md:70` says `credentialId` is an id and never a name, and `:18` of `api/credential.md` gives the CLI `provider.list` for exactly this.

   An item whose `kind` is not `git` writes `kanthord: invalid-request: the credential <name> is of kind <kind>\n` and calls `fail()`.

2. **`POST repository.inspect`** with the url and the resolved id. It prints the detected default branch and, for an ssh url, the host key:

   ```
   kanthord: default branch <defaultBranch>
   kanthord: host key <algorithm> <fingerprint>
   kanthord: credential <reachable|refused: auth-failed>
   ```

3. **The upstream confirmation.** `confirmValue({ flagName: "--upstream", flagValue: options.upstream, question: "upstream branch?", suggestion: inspect.defaultBranch })`. A `ConfirmationRequiredError` writes `kanthord: confirmation-required: --upstream is required when there is no terminal to confirm on\n` and calls `fail()` **without** calling `repository.register`.
4. **The host-key confirmation, ssh only.** When the url's scheme is `ssh://` or the url matches the scp-like spelling, `confirmValue({ flagName: "--host-fingerprint", flagValue: options.hostFingerprint, question: "host key fingerprint?", suggestion: inspect.hostKey?.fingerprint ?? null })`. The refusal is the same shape with `--host-fingerprint` named.

   The classifier is `src/cli/repository/transport.ts` (new), exporting `remoteTransport(value: string): "http-basic" | "ssh" | null`. It reproduces the scheme half of EPIC 006 Story 02's policy and nothing else: `https:` and `http:` yield `http-basic`, `ssh:` yields `ssh`, the scp-like pattern `/^([A-Za-z0-9._~+-]+)@([^:/@]+):(.+)$/` yields `ssh`, and anything else yields `null`, which writes `kanthord: invalid-request: <url> names no supported transport\n` and calls `fail()`.

   The duplication is deliberate and bounded: `cli/` may not import a service implementation, and the CLI must know before it prompts whether a host-key confirmation is needed. The daemon's own refusal is still authoritative — a url the CLI classifies and the daemon refuses answers `400`, and the CLI prints it.

5. **Defaults.** `--landing` defaults to the confirmed upstream value, and `--publish-ref` defaults to `"refs/heads/" + the confirmed upstream value`. `docs/proposal/database/repository.md:88` calls that the merge-into-`main` mode, and it is the mode a bare `repository register` means.
6. **`POST repository.register`** with the assembled body, and print the projection:

   ```
   kanthord: registered <name> <id>
   kanthord: upstream <upstreamBranch>
   kanthord: landing <landingRef> <landingOid>
   kanthord: tracking <trackingRef> <trackingOid>
   kanthord: publish <publishRef>
   kanthord: state <state>
   ```

### 4. `src/cli/repository/show.ts` (new)

`kanthord repository show --id <id>` prints the same six lines plus `kanthord: credential <name> <id>`. A `404` writes `kanthord: not-found: <message>\n` and calls `fail()`.

### 5. `src/main.ts` — register three programs

Call `registerCredentialRegister`, `registerRepositoryRegister` and `registerRepositoryShow` beside `registerDbMigrate` (`:67`), injecting `client`, `env: process.env`, the two output sinks, `fail: () => { process.exitCode = 1 }`, `readFile: (p) => readFileSync(p, "utf8")`, and `confirm: { isTty: process.stdout.isTTY === true && process.stdin.isTTY === true, prompt: <a readline/promises question> }`.

The `prompt` implementation lives in `src/main.ts`, not in `src/cli/`, so no command module imports `node:readline`.

## Constraints

- `cli/` imports no command, no query and no service implementation. Only `src/main.ts` names one.
- No secret is ever a flag value. There is no `--token`, `--private-key` or `--api-key` option.
- A command module reads no `process` member and no environment variable directly. `env` is injected, as `src/cli/db/migrate.ts:17` establishes.
- Every output line begins `kanthord: ` and ends `\n`, written at the call site.
- Every error line is `kanthord: <code>: <message>\n`, matching `src/main.ts:58`.
- Failure is `fail()`, never `process.exit`. `src/cli/db/migrate.ts:20` establishes it.
- The flag always beats the prompt. `confirmValue` returns a non-empty `flagValue` without touching the terminal.
- No `127.` and no `"localhost"` literal in any new `src/cli/**` file. `transport.ts` classifies by scheme and never by host.

## Verify

`node --test src/cli/confirm.test.ts src/cli/repository/transport.test.ts src/cli/credential/register.test.ts src/cli/repository/register.test.ts src/cli/repository/show.test.ts`

Every CLI test builds a fresh `new Command()`, registers into it, and drives it with `program.parseAsync([...args], { from: "user" })`, asserting accumulated stdout, accumulated stderr, recorded client calls and a `fail` call count. That is the harness `src/cli/db/migrate.test.ts:16-63` establishes, and the `client` is a hand-written Mock recording `(operationId, body)` and returning the values each case names.

### `src/cli/confirm.test.ts`

- A non-empty `flagValue` is returned and the prompt is never called, asserted with a prompt that throws.
- An empty-string `flagValue` is treated as absent.
- `isTty: false` with no `flagValue` throws `ConfirmationRequiredError`, `error.flagName` equals the input, and the prompt was never called.
- `isTty: true` with no `flagValue` calls the prompt once. The question text includes the suggestion in `[...]` when one is given and does not when the suggestion is `null`.
- An empty answer with a suggestion returns the suggestion. An empty answer with a `null` suggestion re-asks, and a second empty answer re-asks again — assert the prompt was called three times before a non-empty answer resolves.
- A whitespace-padded answer is returned trimmed.

### `src/cli/repository/transport.test.ts`

- `https://github.com/o/r.git` and `http://127.0.0.1:9/r.git` yield `http-basic`.
- `ssh://git@github.com/o/r.git` and `git@github.com:o/r.git` yield `ssh`.
- `file:///tmp/r.git`, `rsync://h/r`, `not a url` and `""` yield `null`.
- `git@github.com` with no colon-path yields `null` — the scp-like pattern requires a path.

### `src/cli/credential/register.test.ts`

- `credential register --name gh --kind git --transport http-basic --forge github --username x-access-token --token-file <a written file>` records one `provider.register` call whose body's `payload` deep-equals `{ transport: "http-basic", forge: "github", username: "x-access-token", token: "<the file content>" }`, and stdout holds the three named lines.
- The written token file ends with `\n`; the recorded token does not. A single trailing newline is trimmed, and a token containing an interior `\n` keeps it — two cases.
- `--kind git` with no `--transport` calls `fail()` once, records no client call, and stderr starts `kanthord: invalid-request:`.
- `--kind git --transport ssh --private-key-file <file>` records a payload of `{ transport: "ssh", privateKey: <content> }` and no `forge` or `username` key, asserted with `Object.keys`.
- `--kind llm --provider anthropic --model claude-opus-5 --api-key-file <file>` records `{ provider, apiKey, defaultModel, baseUrl: null }`.
- A daemon `400` writes `kanthord: invalid-request: <message>\n` and calls `fail()` once, and stdout is empty.
- **No secret option exists.** Assert `program.commands` for `credential register` has no option whose long flag is `--token`, `--private-key` or `--api-key`, and read the module source and assert it contains none of those three strings.

### `src/cli/repository/register.test.ts`

- **The happy path resolves the credential to an id.** With a `provider.list` returning two items, `--credential gh` records a `repository.register` whose `credentialId` equals the matching item's `id` and never its name. Assert the recorded call order is `provider.list`, `repository.inspect`, `repository.register`.
- An unknown `--credential` calls `fail()` once, records only the `provider.list` call, and stderr starts `kanthord: not-found:`.
- A `--credential` naming an `llm` registration calls `fail()` and records no `repository.inspect` call.
- **`--upstream` wins over the prompt.** With `isTty: true`, a prompt that throws, and `--upstream main`, the register call carries `upstreamBranch: "main"`.
- **No `--upstream` and no terminal refuses and names the flag.** With `isTty: false` and no `--upstream`, `fail()` is called once, stderr equals `"kanthord: confirmation-required: --upstream is required when there is no terminal to confirm on\n"`, and **no** `repository.register` call is recorded. This is the epic coverage line "exits non-zero and names the flag" — the exit code is `fail()`'s, and the end-to-end exit code is asserted in the scenario below.
- **An ssh url with no `--host-fingerprint` and no terminal does the same.** With `--url ssh://git@github.com/o/r.git`, `--upstream main` supplied, `isTty: false` and no `--host-fingerprint`, `fail()` is called once, stderr names `--host-fingerprint`, and no register call is recorded.
- **An https url needs no `--host-fingerprint`.** The same arguments with an `https` url and no `--host-fingerprint` register successfully, and the recorded body's `hostFingerprint` is `null`.
- **An ssh url with `--host-fingerprint` registers without a prompt.** `isTty: true` with a throwing prompt still succeeds, and the recorded `hostFingerprint` equals the flag value.
- **The prompt suggests the inspected value.** With `isTty: true` and an `inspect` returning `defaultBranch: "trunk"`, the prompt question includes `[trunk]`, and an empty answer registers `upstreamBranch: "trunk"`.
- `--landing` defaults to the confirmed upstream, and `--publish-ref` defaults to `"refs/heads/" + it`. Assert both from one call with neither flag, then assert an explicit `--landing kanthord/main` overrides only the landing.
- `--no-publish-on-approval` records `publishOnApproval: false`; its absence records `true`.
- A url whose transport is unsupported calls `fail()` and records no call at all — not even `provider.list`. Assert the classification runs first.
- A daemon `409 host-key-mismatch` writes `kanthord: host-key-mismatch: <message>\n` and calls `fail()`. A `422` writes `kanthord: credential-rejected: <message>\n`.
- **The CLI routes on `code`, never on `message`.** Feed two `400` responses with different messages and assert both produce a `fail()` and a line beginning with the same `kanthord: invalid-request:` prefix. `docs/proposal/api/README.md:143` states the rule.

### `src/cli/repository/show.test.ts`

- `repository show --id repo_…` prints the seven named lines in that order, and stderr is empty.
- A `404` calls `fail()` once and stdout is empty.

### E2E — scenario `E7-12`, real `github.com` through the real binary

File `scripts/e2e/007/12-cli-commands.e2e.ts`. It runs the CLI as a child process with `runCli` from `test/helpers/cli.ts`, against a live daemon from `launchDaemon`, so the exit code is the process's own.

- `kanthord credential register --name gh-<runId> --kind git --transport http-basic --forge github --username x-access-token --token-file <a mode-0600 file holding env.ghToken>` exits `0`, and stdout holds `kanthord: registered gh-<runId> provider_…`. The token reaches the daemon through a file, and the scenario asserts `result.stdout` and `result.stderr` do not contain `env.ghToken`.
- `kanthord repository register --name r-<runId> --url <httpsUrl> --credential gh-<runId> --upstream <env.ghBaseBranch> --publish-ref <scratchRef>` exits `0`. Stdout holds a `kanthord: landing refs/heads/<base> <oid>` line whose object id equals `remoteRefValue` for the base branch, read independently.
- **No terminal, no `--upstream`: non-zero and named.** The same command without `--upstream` exits **non-zero** — `runCli` spawns with `stdio: ["ignore","pipe","pipe"]`, so `process.stdin.isTTY` is `undefined` and the refusal path is real, not simulated. `result.code` is `1`, `result.stdout` is empty, and `result.stderr` starts `kanthord: confirmation-required:` and contains `--upstream`. This is the epic coverage line, proved through a real process exit code.
- **No terminal, an ssh url, no `--host-fingerprint`: non-zero and named.** With `--url ssh://git@github.com/<repo>.git`, an ssh credential registered from a generated key, and `--upstream <base>` supplied, the run exits `1` and stderr contains `--host-fingerprint`. The command reached the daemon for `inspect` and stopped before `register` — assert by reading the database after the daemon exits and finding no second `repository` row.
- **`--credential <name>` really resolves.** `kanthord repository register … --credential does-not-exist` exits `1` with stderr starting `kanthord: not-found:`.
- `kanthord repository show --id <the registered id>` exits `0` and its `kanthord: landing` line matches the one `register` printed.
- **The remote is unchanged.** `listRemoteRefs` reports no ref of this run, and the base branch object id is equal before and after the whole scenario.
- The temporary home is removed and `deleteScratchRefs` runs in an `after` hook.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/cli/credential/register.test.ts` and `src/cli/repository/register.test.ts` and `src/cli/repository/show.test.ts` to the epic Proof globs `src/cli/credential/**/*.test.ts` and `src/cli/repository/**/*.test.ts`.
