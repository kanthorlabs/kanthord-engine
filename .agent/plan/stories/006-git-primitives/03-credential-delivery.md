# Story 03 — Credential delivery

Epic: `.agent/plan/epics/006-git-primitives.md`
Depends on: Story 01 (`gitEnvironment`, `createGitRunner`), Story 02 (`remoteUrlVerdict`).

Two transports, sharing nothing but the row that holds them. An HTTPS token reaches `git` through a helper reading the child environment. An ssh key reaches `ssh` through a file that exists only while the operation runs.

## Change

### 1. `src/services/git/index.ts` — the forge conventions

Append:

```ts
export type ForgeConvention = Readonly<{ username: string | null }>;

export const forgeConventions: Readonly<Record<string, ForgeConvention>>;
```

`forgeConventions` is exactly:

| `forge`     | username sent           |
| ----------- | ----------------------- |
| `github`    | the credential username |
| `gitlab`    | `oauth2`                |
| `bitbucket` | `x-token-auth`          |

`{ username: null }` means "send the credential's own username". `docs/proposal/database/provider.md:48` fixes the three. An unknown `forge` sends the credential's own username, which is the `github` convention, and it is not a refusal here — `provider.register` of EPIC 007 owns the accepted forge set.

### 2. `src/services/git/credential.ts` (new)

```ts
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  forgeConventions,
  type GitCredential,
  type GitFailure,
  type GitPaths,
} from "./index.ts";

export const HELPER_FILE_NAME = "credential-helper.sh";

export const HELPER_SCRIPT: string;

export type CredentialSession = Readonly<{
  extraEnv: Readonly<Record<string, string>>;
  dispose(): void;
  eraseObserved(): boolean;
}>;

export function installHelper(paths: GitPaths): string;

export function openCredentialSession(
  paths: GitPaths,
  credential: GitCredential,
): CredentialSession;

export function credentialArgs(
  paths: GitPaths,
  credential: GitCredential,
): readonly string[];

export function shellQuote(value: string): string;

export function installSshWrapper(paths: GitPaths): string;

export function classifyFailure(
  input: Readonly<{ code: number; stderr: string; eraseObserved: boolean }>,
): GitFailure;
```

`stripUserinfo` is **not** here. Story 01 owns it in `src/services/git/redact.ts`, because `clone.ts` needs it and must not import this file.

**The helper.** `HELPER_SCRIPT` is a POSIX shell script, one string literal:

```sh
#!/bin/sh
printf '%s\n' "$1" >> "$KANTHORD_HELPER_LOG"
if [ "$1" = get ]; then
  printf 'username=%s\npassword=%s\n' "$KANTHORD_GIT_USERNAME" "$KANTHORD_GIT_PASSWORD"
fi
exit 0
```

`installHelper(paths)` creates `paths.keyDirectory` with `mkdirSync({ recursive: true, mode: 0o700 })`, writes `HELPER_SCRIPT` to `join(paths.keyDirectory, HELPER_FILE_NAME)` with mode `0o700`, and returns that path. It is idempotent, and it overwrites an existing file so a stale script from an older daemon cannot survive.

The helper reads the secret from **its own environment**, which is the environment of the `git` child that ran it. The secret is in no argument vector and in no file.

**The log is the evidence, and it is evidence rather than proof.** The helper appends every operation name to `$KANTHORD_HELPER_LOG`. `eraseObserved()` reads that file and returns `true` when any line is exactly `erase`. `git` issues `erase` when the forge rejects a credential it had supplied, so an `erase` is a positive observation and not a message match. Measured against a live forge: a rejected token produced `get` then `erase`, and an accepted one produced `get` alone.

State the limit, because the classification depends on it. An **absent** `erase` does not prove the credential was accepted. Whether `git` reaches the `erase` depends on where the failure happened in the protocol, and a forge can reject a request in a way that produces no rejection `git` attributes to the credential. So `eraseObserved === true` decides `auth-failed`, and `eraseObserved === false` decides nothing: the verdict falls through to the message rules and finally to `unknown`. `unknown` is the honest answer, and it is why the value exists.

The live-forge measurement is not a test. The hermetic re-proof is the fixture case below, against EPIC 005's HTTP remote, which is what the suite actually asserts.

**One log per session.** `logPath` carries a fresh `randomUUID` and reaches only the one child that session authenticates, so two concurrent operations sharing one helper script cannot read each other's log. The helper script is shared; the log is not.

**`credentialArgs`** returns, for an `http-basic` credential:

```ts
[
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=${join(paths.keyDirectory, HELPER_FILE_NAME)}`,
];
```

and `[]` for an `ssh` credential. The empty entry comes first. `credential.helper` is multi-valued, and an empty value resets the accumulated list, so entries **after** it survive and entries before it do not. Measured: with `bad`, then empty, then `good`, only `good` is invoked.

**`openCredentialSession`** dispatches on `credential.transport`.

For `http-basic`:

1. `installHelper(paths)`.
2. Mint `logPath = join(paths.keyDirectory, `helper-${randomUUID()}.log`)` and create it empty with mode `0o600`.
3. Resolve the username: `forgeConventions[credential.forge]?.username ?? credential.username`.
4. `extraEnv` is `{ KANTHORD_HELPER_LOG: logPath, KANTHORD_GIT_USERNAME: username, KANTHORD_GIT_PASSWORD: credential.token }`.
5. `dispose()` removes `logPath` with `rmSync({ force: true })`.

For `ssh`:

1. `mkdirSync(paths.keyDirectory, { recursive: true, mode: 0o700 })`.
2. `keyPath = join(paths.keyDirectory, `key-${randomUUID()}`)`. Create it with `openSync(keyPath, "wx", 0o600)`, `writeSync` the private key, then `closeSync`. `"wx"` is `O_CREAT | O_EXCL | O_WRONLY`, so a symlink already at the path is a failure rather than a redirect.
3. Append one newline when `credential.privateKey` does not end with one. `ssh` refuses a key file whose last line has no terminator.
4. `extraEnv` is `{ GIT_SSH_COMMAND: sshCommand(paths, keyPath) }`.
5. `dispose()` removes `keyPath` with `rmSync({ force: true })`.

**`GIT_SSH_COMMAND` names a wrapper, and no path is interpolated into a shell string.** `git` shell-parses the value of `GIT_SSH_COMMAND`, so any path put inside it can carry a space, a double quote, a `$`, a backtick or a backslash and change what runs. Quoting one interpolation is not a general defence. Instead:

`installSshWrapper(paths)` writes this script to `join(paths.keyDirectory, "ssh-wrapper.sh")` with mode `0o700`, and returns the path:

```sh
#!/bin/sh
exec "$KANTHORD_SSH" \
  -F /dev/null \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$KANTHORD_KNOWN_HOSTS" \
  -o IdentityAgent=none \
  -i "$KANTHORD_SSH_KEY" \
  "$@"
```

`extraEnv` for an ssh session is then `{ GIT_SSH_COMMAND: shellQuote(wrapperPath), KANTHORD_SSH: paths.ssh, KANTHORD_KNOWN_HOSTS: paths.knownHosts, KANTHORD_SSH_KEY: keyPath }`. Three of the four paths never reach a shell parser at all — the wrapper reads them from its own environment, and a shell variable expansion inside double quotes is not re-split. The one value `git` still parses is the wrapper path, and it goes through `shellQuote`.

`shellQuote(value)` wraps `value` in single quotes and replaces every `'` with `'\''`. That is the total POSIX quoting rule: inside single quotes nothing is special, and the only character that needs handling is the terminator. `docs/proposal/phase-1/git-foundation.md:105` says the daemon keeps its paths free of a space and a metacharacter; this makes that a convenience rather than a correctness requirement, which matters because `paths.keyDirectory` is derived from operator configuration.

The wrapper is one more file in the key directory, so EPIC 007.5's sweep must not remove it while the daemon runs. It is created by `installSshWrapper` on every session and named `ssh-wrapper.sh`, not `key-*`, which is the prefix the sweep matches.

`eraseObserved()` returns `false` for an ssh session. ssh authentication has no credential helper, and a key rejection is classified from the exit code and the diagnostic.

**`classifyFailure`** returns, in this order of tests:

1. `"auth-failed"` when `input.eraseObserved` is `true`.
2. `"host-key-mismatch"` when `stderr` includes `"REMOTE HOST IDENTIFICATION HAS CHANGED"` or includes `"Host key verification failed"`.
3. `"auth-failed"` when `stderr` includes `"Permission denied (publickey"` or includes `"Authentication failed"`.
4. `"permission-denied"` when `stderr` includes `"pre-receive hook declined"`, `"protected branch"`, `"deny updating"`, or `"You are not allowed to push code"`.
5. `"transport-failed"` when `stderr` includes `"Could not resolve host"`, `"Connection refused"`, `"Connection timed out"`, `"SSL certificate problem"`, `"unable to access"`, or `"Connection closed by remote host"`.
6. `"unknown"` otherwise.

Rule 1 precedes every message match, which is what makes the HTTPS verdict evidence rather than parsing. Rules 2 to 5 are the ssh and network cases, where there is no structured channel. `"unknown"` exists so an unclassified failure is visible.

**`stripUserinfo`** replaces every match of `/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g` with `"$1"`. It runs over every `stderr` that reaches a `GitError.detail` raised by this story or by Stories 06 and 08. It removes a username as well as a password: a username is not a secret, and a redaction that keeps it needs a second rule to decide which half to drop.

### 3. `src/services/git/authenticated.ts` (new)

```ts
import type { GitCredential, GitPaths } from "./index.ts";
import type { GitRunRequest, GitRunResult, GitRunner } from "./run.ts";

export type AuthenticatedRequest = GitRunRequest &
  Readonly<{ credential: GitCredential }>;

export type AuthenticatedOutcome = GitRunResult &
  Readonly<{ eraseObserved: boolean }>;

export function runAuthenticated(
  runner: GitRunner,
  paths: GitPaths,
  request: AuthenticatedRequest,
): Promise<AuthenticatedOutcome>;
```

It opens a session, prepends `credentialArgs(paths, credential)` to `request.args`, merges `session.extraEnv` into `request.extraEnv`, awaits the runner, reads `eraseObserved()`, and calls `dispose()` in a `finally`. The `finally` runs on a throw as well, which is why a `timed-out` operation leaves no key file behind.

## Constraints

- The token never enters an argument vector, `<home>/config`, or a `GitError`. The only three places it exists are the decrypted credential object, the `KANTHORD_GIT_PASSWORD` entry of one child environment, and the helper's answer on that child's standard output.
- Never write `-c http.extraHeader=`. `docs/proposal/phase-1/git-foundation.md:80` forbids it.
- Never write a credential into `remote.origin.url` and never call `git config` with a secret.
- `dispose()` is in a `finally`, never after an `await` that can reject.
- Never use `writeFileSync` for the key. `openSync(path, "wx", 0o600)` is the exclusive create, and `writeFileSync` with a `mode` option does not fail on an existing file.
- Never pass `-o StrictHostKeyChecking=accept-new` or `-o UserKnownHostsFile=/dev/null`. Both are asserted absent by construction.
- `classifyFailure` reads `stderr` only. It never reads `stdout`, which can carry repository content.

## Verify

`node --test src/services/git/credential.test.ts src/services/git/authenticated.test.ts` — two new files.

### Unit cases, no process

- `credentialArgs` for an `http-basic` credential deep-equals the four-element array above, and `credentialArgs[1]` is the empty string. For an `ssh` credential it is `[]`.
- The forge table: a `github` credential with username `bot` sends `bot`; `gitlab` sends `oauth2`; `bitbucket` sends `x-token-auth`; an unknown forge `codeberg` sends `bot`. Assert through `openCredentialSession(...).extraEnv.KANTHORD_GIT_USERNAME`.
- `classifyFailure` table, each asserted exactly:

| `eraseObserved` | `stderr` fragment                                   | verdict             |
| --------------- | --------------------------------------------------- | ------------------- |
| `true`          | `""`                                                | `auth-failed`       |
| `true`          | `"Connection refused"`                              | `auth-failed`       |
| `false`         | `"REMOTE HOST IDENTIFICATION HAS CHANGED"`          | `host-key-mismatch` |
| `false`         | `"Host key verification failed."`                   | `host-key-mismatch` |
| `false`         | `"git@h: Permission denied (publickey)."`           | `auth-failed`       |
| `false`         | `"remote: error: pre-receive hook declined"`        | `permission-denied` |
| `false`         | `"remote: error: You are not allowed to push code"` | `permission-denied` |
| `false`         | `"ssh: Could not resolve host: forge.test"`         | `transport-failed`  |
| `false`         | `"fatal: unable to access 'https://f/r.git/'"`      | `transport-failed`  |
| `false`         | `"fatal: the remote end hung up unexpectedly"`      | `unknown`           |

The second row is the precedence assertion: the helper's evidence outranks a network-looking message.

- `stripUserinfo("fatal: unable to access 'https://user:tok@forge.test/r.git/'")` equals `"fatal: unable to access 'https://forge.test/r.git/'"`. `stripUserinfo("ssh://git@forge.test/r.git")` equals `"ssh://forge.test/r.git"`. `stripUserinfo("no url here")` is unchanged. A string with two urls has both stripped.
- `HELPER_SCRIPT` does not include `KANTHORD_GIT_PASSWORD` on the same line as `printf '%s\n' "$1"`, and the script contains no `set -x`.
- `sshCommand` output includes `-o StrictHostKeyChecking=yes`, `-o BatchMode=yes`, `-o IdentitiesOnly=yes`, `-o IdentityAgent=none`, `-F /dev/null`, and does **not** include `accept-new` or `UserKnownHostsFile=/dev/null`. The `known_hosts` path and the key path each appear wrapped in `"`.

### The key file lifecycle

- `openCredentialSession` for an ssh credential creates the key file with mode `0600` — `(fs.statSync(keyPath).mode & 0o777).toString(8)` is `"600"` — and the parent directory with mode `0700`. After `dispose()`, `fs.existsSync(keyPath)` is `false`.
- The key file content ends with exactly one `\n` for a key given with a trailing newline and for one given without.
- A pre-existing file at the minted path is impossible by construction, so assert the guard directly: call `openSync(path, "wx", 0o600)` twice on one path and assert the second throws `EEXIST`.
- **A thrown operation still removes the key.** Call `runAuthenticated` with an ssh credential and `timeoutMs: 500` against a `GIT_SSH_COMMAND`-driven sleep, assert it rejects, then assert `fs.readdirSync(paths.keyDirectory)` contains no entry beginning with `"key-"`. This is the epic coverage line "An ssh key file is mode `0600` while the operation runs and is absent after it, including after a thrown failure." The mode half is asserted from inside the operation: the fake ssh script copies `ls -l` of the key path into a file the test reads afterwards.

### Against the fixtures

Both fixtures come from the gated factories in `test/helpers/remote/index.ts` (EPIC 005 Story 05): `await createHttpRemote()` and `await createSshRemote()`. Never import a starter — `.agent/plan/stories/005-test-infrastructure/05-fixture-acceptance-gate.md:139` fails `npm run verify` on any file outside the five fixture files that mentions one, and a starter hands out an ungated fixture. `after` awaits `remote.dispose()`.

The credential matrix is the fixture's, not this story's. `remote.credentials.writer` is `{ username: "writer", token: "w-tok", write: true }`, `remote.credentials.reader` is read-only, and `remote.wrongCredential` is `{ username: "writer", token: "bad-tok" }`. Map each into a `GitCredential` of transport `http-basic` with `forge: "github"`, so the username travels unchanged. `remote.url("fixture.git")` is the remote url, `remote.authenticatedUrl(repository, credential)` embeds the userinfo, and `remote.seed` reaches the served repository.

For ssh: `remote.hostKeys` is sorted bytewise by algorithm, so `hostKeys[0]` is `ssh-ed25519`; `remote.wrongHostKey` is a key the server never presents; `remote.writeKnownHosts(keys)` writes a `known_hosts` file in the `[127.0.0.1]:<port>` spelling and returns its path; `remote.privateKeyPath` is the client key; `remote.url("fixture.git")` carries the port.

- **A write-capable credential fetches.** With `remote.credentials.writer`, `runAuthenticated` with `["--git-dir=<home>", "fetch", "origin", "--prune", "--no-tags"]` resolves `code === 0` and `eraseObserved === false`.
- **A wrong token is `auth-failed` through the erase, not through a message.** The same call with `remote.wrongCredential` resolves non-zero, `eraseObserved === true`, and `classifyFailure` returns `auth-failed`. Then repeat the classification with the observed exit code and `stderr: ""`, and assert the verdict is still `auth-failed`. The second assertion is what proves the verdict does not depend on the fixture's wording.
- **A missing credential fails and writes nothing.** With no helper configured, the fetch fails and `git rev-parse --verify refs/remotes/origin/<upstream>` on the home still fails — no ref was written.
- **The token appears nowhere, asserted by construction.** For one successful authenticated fetch, assert: `result.args` contains no element that includes the token; `fs.readFileSync(join(home, "config"), "utf8")` does not include the token; the helper script text does not include the token. Then force a failure, catch the `GitError`, and assert neither `error.message` nor `error.detail` includes the token. The four assertions are on four named surfaces, which is the epic coverage line "An HTTPS token never appears in the argument vector, in `<home>/config`, or in the message or fields of a raised error, asserted by construction rather than by a substring search over one sample."
- **ssh with a correct pin.** Copy `remote.writeKnownHosts(remote.hostKeys)` over `paths.knownHosts`, read `remote.privateKeyPath` as the credential's `privateKey`, then `runAuthenticated` a fetch over `ssh://` and assert `code === 0` and that `refs/remotes/origin/<upstream>` now resolves. Follow it with a `refUpdate` (Story 05) of `refs/heads/<landing>` from that value and assert it succeeds. This is the epic coverage line "A fetch and a `refUpdate` through the ssh fixture succeed with a pinned host key".
- **ssh with a wrong pin.** Replace `paths.knownHosts` with `remote.writeKnownHosts([remote.wrongHostKey])`, run the same fetch, and assert it resolves non-zero and `classifyFailure` returns `host-key-mismatch`. EPIC 005 measured that this fails at once with `REMOTE HOST IDENTIFICATION HAS CHANGED` and does not hang, so assert that verdict and pass an explicit `timeoutMs` well below the default. A regression to a hang then fails as `timed-out` instead of stalling the suite.

`npm run verify` exits 0.

Proof: contributes `src/services/git/credential.test.ts` and `src/services/git/authenticated.test.ts` to `node --test src/services/git/**/*.test.ts`.
