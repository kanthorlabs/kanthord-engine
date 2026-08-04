# Story 04 — ssh fixture remote

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Depends on: Story 01 (`resolveTools`), Story 02 (`seedRepositories`).

## Change

Create `test/helpers/remote/ssh.ts`. It runs `sshd` on a loopback port from a
generated config, with a generated host key pair and a generated client key,
serving the same seeded repositories.

Exports, exactly:

```ts
export type FixtureHostKey = Readonly<{
  algorithm: string;
  publicKey: string;
  fingerprint: string;
}>;

export type SshRemote = Readonly<{
  transport: "ssh";
  port: number;
  username: string;
  hostKeys: readonly FixtureHostKey[];
  privateKeyPath: string;
  wrongHostKey: FixtureHostKey;
  knownHostsLine(hostKey: FixtureHostKey): string;
  writeKnownHosts(hostKeys: readonly FixtureHostKey[]): string;
  sshCommand(
    input: Readonly<{ knownHosts: string; privateKey?: string }>,
  ): string;
  url(repository: string): string;
  seed: SeedRoot;
  log(): string;
  dispose(): Promise<void>;
}>;

export const sshAcceptanceChecks: readonly {
  name: string;
  run(subject: SshRemote): Promise<void> | void;
}[];

export function startSshRemote(
  tools: Tools,
  seed: SeedRoot,
): Promise<SshRemote>;
```

`sshAcceptanceChecks` is typed **structurally** and this file imports nothing from
`acceptance.ts`, for the reason Story 03 gives: a nominal import would invert the
dispatch order.

### Start-up

1. `fs.mkdtempSync(join(tmpdir(), "kanthord-sshd-"))` is the server directory,
   `chmod 0700`.
2. Reserve a port: bind a `node:net` server to `0` on `127.0.0.1`, read
   `address().port`, close it, and use that number. Export nothing for this; it is
   a module-private `reserveLoopbackPort()`.
   **Closing the socket before `sshd` binds is a TOCTOU window**, so the whole
   reserve-and-start sequence retries on failure: up to 5 attempts, each reserving
   a fresh port, and an attempt fails when `sshd` exits non-zero within the
   readiness wait or its log contains `Address already in use`. After the fifth,
   throw an `Error` naming the attempts and the last log tail. Without the retry an
   unlucky port makes the suite fail environmentally rather than deterministically.
3. Generate four keys with `tools.paths.sshKeygen`, each `-N ""` (no passphrase)
   and `chmod 0600`:
   - `host_ed25519`, `-t ed25519`
   - `host_rsa`, `-t rsa -b 2048`
   - `client`, `-t ed25519`
     Also generate `wrong_ed25519`, `-t ed25519`, which backs `wrongHostKey` and is
     **never** given to `sshd`.
4. `authorized_keys` is `client.pub`, `chmod 0600`.
5. Write `sshd_config` with exactly these directives, in this order:

   ```
   Port <port>
   ListenAddress 127.0.0.1
   HostKey <dir>/host_ed25519
   HostKey <dir>/host_rsa
   PidFile <dir>/sshd.pid
   AuthorizedKeysFile <dir>/authorized_keys
   StrictModes no
   UsePAM no
   PasswordAuthentication no
   KbdInteractiveAuthentication no
   PubkeyAuthentication yes
   PermitUserEnvironment no
   AllowAgentForwarding no
   AllowTcpForwarding no
   X11Forwarding no
   LogLevel VERBOSE
   Subsystem sftp internal-sftp
   SetEnv PATH=<tools.execPath>
   ```

   `StrictModes no` is required: the temporary directory sits under
   `/var/folders/...` on darwin, which `sshd` rejects under strict mode. `UsePAM
no` is required to run unprivileged.

   **`SetEnv PATH=<tools.execPath>` is load-bearing.** An ssh git request runs
   `git-upload-pack` on the **server** side, in a session whose `PATH` is `sshd`'s
   default and not this epic's resolved installation. Without the directive the
   fixture may be served by a different `git` than Story 01 probed, or by none, so
   the version probe would not cover the binary that actually serves ssh.
   `tools.execPath` is the `git-core` directory, which holds `git-upload-pack`.

6. Spawn `tools.paths.sshd` with `["-f", configPath, "-E", logPath, "-D"]`,
   `env: {}`, `stdio: ["ignore", "ignore", "ignore"]`, then `child.unref()`.

   **The daemon must not hold the event loop open.** A referenced child keeps
   `node --test` alive after every test of a file has passed, so a fixture that a
   test never disposed turns a green file into a run that never exits, and
   `--test-timeout` cannot help because no test is running. `unref()` lets the
   process exit, which is also what lets the emergency `process.on("exit")` kill
   fire. An unref'd child still emits `"exit"`, so bounded disposal is unaffected.

   **Diagnostics come from `logPath`, never from the pipes.** `sshd -E <log>`
   writes even a bad-configuration error to that file and leaves stderr empty, so
   ignored stdio loses nothing: every readiness and disposal failure names the tail
   of `logPath`.

7. Wait for readiness by connecting a `node:net` socket to the port, retrying
   every 50 ms until a connection is accepted, with a 5000 ms deadline matching
   `test/helpers/daemon.ts:72`. On the deadline, throw an `Error` whose message
   names the port and includes the tail of `logPath`. **Never** resolve without a
   live listener, and never `t.skip`.
8. `username` is `os.userInfo().username`. An unprivileged `sshd` authenticates
   only the invoking user, so the url must carry it.

### Host keys

`hostKeys` is built by reading `host_ed25519.pub` and `host_rsa.pub`, computing
each fingerprint with `ssh-keygen -l -f <pub>` and taking the `SHA256:` field
verbatim, then **sorting bytewise by `algorithm` with `Buffer.compare`**. The
sorted order is therefore `ssh-ed25519` before `ssh-rsa`.

The sort is mandatory. `ssh-keyscan` returned `ssh-rsa` before `ssh-ed25519` on
three consecutive runs against this exact config, so scan order is the server's
negotiation order and not the caller's `-t` order. `EPIC 007` pins an ordering
against this fixture, and an unsorted handle would make that ordering an accident.

- `knownHostsLine(hostKey)` is `` `[127.0.0.1]:${port} ${hostKey.algorithm} ${hostKey.publicKey}` ``,
  the `[host]:port` spelling `docs/proposal/api/repository.md:38` requires.
- `writeKnownHosts(hostKeys)` writes those lines, one per line with a trailing
  newline, into a fresh file under the server directory and returns its path.
- `sshCommand({ knownHosts, privateKey })` returns exactly:

  ```
  <tools.paths.ssh> -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<knownHosts>
    -o IdentityAgent=none -i <privateKey ?? privateKeyPath>
  ```

  matching `docs/proposal/phase-1/git-foundation.md:97-105`. No `-p`; the port
  travels in the url.

  **Every path in the string is single-quoted, and a path containing a single quote
  is refused.** `git` parses `GIT_SSH_COMMAND` with shell quoting rules, and
  `git-foundation.md:105` states the requirement outright. A space-joined string is
  not safe here: `TMPDIR` and a `KANTHORD_TEST_SSH` override are both caller
  controlled, and a space in either breaks the command in a way that varies by
  environment. So wrap `tools.paths.ssh`, `knownHosts` and the key path each in
  `'...'`, and throw an `Error` naming the path when it contains a `'`. The daemon
  keeps its own paths free of both — this fixture must prove it rather than assume
  it.

- `url(repository)` is
  `` `ssh://${username}@127.0.0.1:${port}${join(seed.path, repository)}` ``. The
  path is absolute, so the url carries a leading `/` after the port.

`log()` reads `logPath` as `utf8`. `dispose()` sends `SIGTERM`, awaits `"exit"`,
then removes the server directory with `force: true`.

### The acceptance check list

`sshAcceptanceChecks` is exactly these three rows, in this order:

1. `"ssh: key-authenticated fetch"` — with `writeKnownHosts(hostKeys)`,
   `git ls-remote` against `url("fixture.git")` reports
   `251c92d5a215053aea80432f179653f99072835d` for `refs/heads/main`.
2. `"ssh: refuses a mismatched host key"` — with
   `writeKnownHosts([wrongHostKey])`, the same command exits non-zero and its
   stderr contains `REMOTE HOST IDENTIFICATION HAS CHANGED`. The check fails if
   the command times out instead.
3. `"ssh: refuses a key file that is not mode 0600"` — copy `privateKeyPath` to a
   sibling, `chmod 0644`, and pass it as `privateKey`. The command exits non-zero
   and its stderr contains both `UNPROTECTED PRIVATE KEY FILE` and
   `Permission denied (publickey)`.

## Constraints

- No operator configuration in scope. `-F /dev/null` on the client, a generated
  `sshd_config` on the server, `env: {}` on every spawn, and `IdentityAgent=none`.
- Two host key algorithms, so EPIC 007 can pin an ordered scan. Do not reduce to
  one.
- `wrongHostKey` is a real generated key that the server never offers. Do not
  fabricate a fingerprint string; a syntactically invalid key makes `ssh` fail for
  the wrong reason.
- Every `git` invocation in this file passes `GIT_SSH_COMMAND` from `sshCommand`
  and the pinned environment of Story 02.
- `startSshRemote` returns an **unchecked** handle. The gate belongs to Story 05.

## Verify

`node --test test/helpers/remote/ssh.test.ts`, asserting exactly:

- `port` is above 1024, and `username` equals `os.userInfo().username`.
- `hostKeys` has length 2, and `hostKeys.map((k) => k.algorithm)` deep-equals
  `["ssh-ed25519", "ssh-rsa"]` — the bytewise order, asserted as an exact array.
- Every `fingerprint` starts with `SHA256:` and every `publicKey` is base64 with
  no whitespace.
- `knownHostsLine(hostKeys[0])` starts with `` `[127.0.0.1]:${port} ssh-ed25519 ` ``.
- **A real authenticated fetch**: with `writeKnownHosts(hostKeys)`, a
  `git fetch --no-tags --prune +refs/heads/*:refs/remotes/origin/*` from a
  throwaway repository against `url("fixture.git")` exits 0 and writes
  `refs/remotes/origin/main` at `251c92…835d`, with no `refs/heads/*` and no
  `refs/tags/*`.
- **`ssh-keyscan` order is not the handle order**: run
  `ssh-keyscan -p <port> 127.0.0.1` through `tools.paths.sshKeyscan`, drop `#`
  lines, and assert the scanned algorithm list, when sorted bytewise, deep-equals
  `["ssh-ed25519", "ssh-rsa"]`. Assert also that the scanned public keys are the
  same two strings as `hostKeys`, compared as a sorted array. Do **not** assert the
  raw scan order; it is the server's and it is not a guarantee.
- **Mismatched host key**: with `writeKnownHosts([wrongHostKey])`, `git ls-remote`
  exits non-zero and stderr contains `REMOTE HOST IDENTIFICATION HAS CHANGED`.
  The fingerprint stderr prints is **the key the server offered**, which is
  `hostKeys[0].fingerprint` — the `ssh-ed25519` entry, because `ssh` negotiates the
  algorithm of the `known_hosts` entry it holds and `wrongHostKey` is ed25519.
  Assert `stderr.includes(hostKeys[0].fingerprint)` and
  `!stderr.includes(wrongHostKey.fingerprint)`. Do not write "the counterpart";
  name the value.
- The mismatch **fails fast rather than hanging**: measure the wall clock around
  the call and assert it returned in under 5000 ms. This is the assertion the EPIC
  coverage line asks for, and it is only meaningful because every external command
  carries `timeout: toolTimeoutMilliseconds` from Story 01 — a `node:test` timeout
  cannot interrupt a blocked `execFileSync`.
- **Bad key mode**: a `0644` copy of the private key yields a non-zero exit with
  `UNPROTECTED PRIVATE KEY FILE` and `Permission denied (publickey)` in stderr.
- **The hostile-`HOME` assertion**, and its control must be genuine. Do **not** use
  `StrictHostKeyChecking no` or `IdentityFile` as the hostile directive: the command
  line already passes `-o StrictHostKeyChecking=yes`, `-o UserKnownHostsFile=` and
  `-i`, and a command-line `-o` outranks a config file, so removing `-F /dev/null`
  would change nothing and the "control" would prove nothing.

  Use a directive with **no** command-line counterpart in `sshCommand`: a trap
  `ProxyCommand`. Write a `.ssh/config` under a `mkdtemp` directory containing

  ```
  Host *
    ProxyCommand /bin/sh -c 'echo hostile-proxy-ran >&2; exit 47'
  ```

  and set that directory as `HOME`.
  - With `-F /dev/null`, an authenticated `ls-remote` still exits 0 and stderr does
    **not** contain `hostile-proxy-ran`.
  - **The control**: the identical run with ` -F /dev/null` replaced by
    `-F '<the hostile config>'` exits non-zero and stderr **does** contain
    `hostile-proxy-ran`. OpenSSH 10.2 resolves the default user config from the
    passwd home, never from `$HOME`, so a control that only removes `-F /dev/null`
    reads no trap and cannot fail.
  - **The second control**: `ssh -G -F /dev/null <host>` resolves **no**
    `proxycommand` line, while `ssh -G -F '<the hostile config>' <host>` resolves
    the trap. Together the two controls prove `-F /dev/null` is load-bearing.

- **The ssh-agent assertion**. A hostile `HOME` cannot reach an agent, so test the
  agent separately and by observation, as the EPIC coverage line requires. Create a
  `node:net` unix socket server under the temporary directory that records every
  connection, set `SSH_AUTH_SOCK` to its path in the `git` child environment, and
  run an authenticated `ls-remote`.
  - It exits 0, and the recorded connection count is `0` — `IdentityAgent=none`
    plus `env: {}` kept `ssh` away from it.
  - **The control**: rerun with `-o IdentityAgent=none` removed and
    `-o IdentitiesOnly=no`, and assert the connection count is now above `0`, so
    the trap socket is proved reachable and the first assertion is not vacuous.
    Should the local `ssh` still not connect, assert instead that the child
    environment passed to `git` contains no `SSH_AUTH_SOCK` key, and record in the
    story that the observing form was unavailable — never leave the assertion
    passing for an unknown reason.
- `sshAcceptanceChecks` has length 3 with the three exact `name` strings in order,
  and each `run` resolves without throwing against a live handle.
- `dispose()` resolves, `fs.existsSync` on the server directory is false, and a
  `net` connection to the port is refused afterwards.
- `log()` contains `Accepted publickey for` after the authenticated fetch. Do
  **not** assert the log is otherwise empty: an unprivileged `sshd` on darwin
  writes `BSM audit: bsm_audit_session_setup: setaudit_addr failed: Operation not
permitted`, which is benign.
- **The serving `git` is the probed `git`**: run
  `git ls-remote` through the fixture and assert it succeeds, then assert
  `log()` shows the session ran. Additionally assert that `sshd_config` contains the
  literal `` `SetEnv PATH=${tools.execPath}` ``, so dropping the directive fails the
  test rather than silently letting an unprobed `git` serve the fixture.

`npm run verify` exits 0.

Proof: contributes to `PASS EPIC-005`. Delivers the coverage line "The ssh fixture
refuses a connection whose pinned host key does not match, and the failure names
the mismatch rather than timing out."

## Measured facts

Every item below was run against `/usr/sbin/sshd` (OpenSSH_10.2p1) as an
unprivileged user on **darwin**, with the exact config above, **and re-run on Linux
in a rootless podman container** — Debian 12 bookworm, `git` 2.39.5,
`OpenSSH_9.2p1`, as a non-root `useradd` account. Both platforms agree on every
item below.

Linux results, which confirm the darwin ones rather than qualify them:

- An unprivileged `sshd` starts and serves a real fetch on Linux under the same
  `StrictModes no` plus `UsePAM no` config. **`/run/sshd` does not exist in the
  container and does not matter** — the privilege-separation directory is needed by a
  privilege-separating root `sshd`, not by this one.
- `git --exec-path` is `/usr/lib/git-core`, and `git-http-backend` is present there.
  This is why the path is resolved through `git --exec-path` and never hardcoded: the
  darwin value is an Xcode path and shares no prefix with it.
- The keyscan order was again `ssh-rsa` before `ssh-ed25519`, so the bytewise sort is
  required on both platforms.
- The mismatch refusal, the `0644` key refusal and the `SetEnv PATH` directive all
  behaved exactly as on darwin.
- The seeded object ids in the container are **identical** to the darwin literals, on
  a different `git` version (2.39.5 against 2.50.1) and a different architecture. The
  literals are not an artifact of one installation.
- Debian 12 ships `git` 2.39.5, above the `2.34.0` floor of Story 01.

The readiness wait still fails with the `sshd` **log tail** in its message, because
that log is the only evidence a reviewer on a third platform will have.

Darwin results:

- An unprivileged `sshd` starts and serves a real `git` fetch. `StrictModes no`
  and `UsePAM no` are both required; without them it exits at start-up.
- Login succeeds only as `os.userInfo().username`.
- `ssh://user@127.0.0.1:<port>/abs/path` works with **no** `-p` in
  `GIT_SSH_COMMAND`; `ssh` reads the port from the url.
- `ssh-keyscan -t ed25519,rsa` returned `ssh-rsa` first on three consecutive runs.
  The `-t` order is not the output order.
- A mismatched pin fails immediately with `REMOTE HOST IDENTIFICATION HAS CHANGED`
  and prints the offending `SHA256:` fingerprint. It does not hang.
- A `0644` key yields `Permissions 0644 for '<path>' are too open`,
  `bad permissions`, then `Permission denied (publickey)`.
- `ls-remote` over the fixture reports `HEAD`, `refs/heads/main`, `refs/tags/v1`
  and `refs/tags/v1^{}`, with the Story 02 literals.
