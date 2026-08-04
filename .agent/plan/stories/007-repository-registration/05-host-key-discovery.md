# Story 05 — Host key discovery

Epic: `.agent/plan/epics/007-repository-registration.md`
Depends on: Story 01 (`GitPaths`), EPIC 006 Story 02 (`remoteUrlVerdict`), EPIC 006 Story 04 (`spawnSupervised`).

`ssh-keyscan` returns several keys in no guaranteed order. This story fixes the accepted algorithm set, the ordering, the fingerprint encoding, the `known_hosts` spelling, and the classification of a scan that times out or is refused. Nothing here is stored; Story 08 stores.

## Change

### 1. `src/services/git/index.ts` — widen the failure vocabulary

Add `"host-key-unavailable"` to `GitFailure` (`:44-51`), after `"host-key-mismatch"`. A scan that finds no key is not a mismatch, and reporting it as one would tell a human their host changed identity when it never answered.

### 2. `src/services/git/host-key.ts` (new)

```ts
import { createHash } from "node:crypto";

import type { GitPaths, HostKey } from "./index.ts";

export const ACCEPTED_HOST_KEY_ALGORITHMS = [
  "ecdsa-sha2-nistp256",
  "ssh-ed25519",
  "ssh-rsa",
] as const;

export const KEYSCAN_TIMEOUT_MS = 15_000;
export const DEFAULT_SSH_PORT = 22;

export type ScanTarget = Readonly<{ host: string; port: number }>;

export type ScanOutcome =
  | Readonly<{ scanned: true; hostKeys: readonly HostKey[] }>
  | Readonly<{
      scanned: false;
      failure: "host-key-unavailable" | "timed-out";
      detail: string;
    }>;

export function scanTargetFor(remoteUrl: string): ScanTarget;
export function fingerprintOf(publicKeyBase64: string): string;
export function parseKeyscanOutput(text: string): readonly HostKey[];
export function knownHostsLine(target: ScanTarget, hostKey: HostKey): string;
export type ScanOptions = Readonly<{ timeoutMs?: number }>;

export function scanHostKeys(
  paths: GitPaths,
  remoteUrl: string,
  options?: ScanOptions,
): Promise<ScanOutcome>;
```

**`scanTargetFor`** calls `remoteUrlVerdict(remoteUrl)` from `./url.ts` first. A refusal throws `GitError("url-refused", verdict.reason, "")`. A verdict whose `transport` is not `"ssh"` throws `GitError("unknown", "only an ssh url has a host key", "")`. It returns `verdict.host` with any IPv6 brackets stripped, and the port from the parsed url or `DEFAULT_SSH_PORT`. The scp-like spelling `git@host:path` carries no port and therefore always yields `22`.

**`fingerprintOf`** is `"SHA256:" + createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("base64").replace(/=+$/, "")`. The hash is over the **decoded** key blob, and the trailing base64 padding is removed. Verified against `ssh-keygen -l -f` on the three keys `github.com` presents today:

| algorithm             | fingerprint                                          |
| --------------------- | ---------------------------------------------------- |
| `ssh-rsa`             | `SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s` |
| `ecdsa-sha2-nistp256` | `SHA256:p2QAMXNIC1TJYWeIOttrVc98/R1BUFWu3/LiyKgUfQM` |
| `ssh-ed25519`         | `SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU` |

The three values are measurements and **not** test literals — a forge rotates a host key, and pinning one turns a rotation into a suite failure. They are recorded because they are what proves `node:crypto` reproduces `ssh-keygen`, so the daemon needs no `ssh-keygen` binary and `tools.*` stays three keys.

**`parseKeyscanOutput`** takes the raw stdout of `ssh-keyscan`.

1. Split on `\n`, drop an empty line and a line whose first non-space character is `#`. `ssh-keyscan` writes comment lines to stdout on some versions.
2. Split each remaining line on runs of whitespace. A line with fewer than three fields is dropped.
3. Field 1 is the host spelling, field 2 the algorithm, field 3 the base64 key. Field 1 is discarded — `knownHostsLine` writes the daemon's own spelling.
4. Keep a line only when its algorithm is a member of `ACCEPTED_HOST_KEY_ALGORITHMS`.
5. Drop a duplicate `(algorithm, publicKey)` pair, keeping the first.
6. Sort the result by `Buffer.compare(Buffer.from(algorithm), Buffer.from(algorithm))`, then by the same comparison on `publicKey`.
7. Map each to `{ algorithm, fingerprint: fingerprintOf(publicKey), publicKey }`.

`HostKey` at `src/services/git/index.ts:12` is `{ algorithm, fingerprint }`. Extend it with `publicKey: string`, because `knownHostsLine` needs the blob and a second parallel structure would let the two drift.

The bytewise sort is what makes two runs agree. Measured on `github.com` over three runs, `ssh-keyscan` emitted `ssh-rsa`, `ecdsa-sha2-nistp256`, `ssh-ed25519` in that raw order every time, and EPIC 005 Story 04 measured a different raw order on its own fixture; the raw order is therefore not a contract and is never asserted.

The accepted set is exactly three because that is the union of what the EPIC 005 ssh fixture presents — `ssh-ed25519` and `ssh-rsa` — and what `github.com` presents, which adds `ecdsa-sha2-nistp256`. An algorithm outside the set is dropped rather than refused: `ssh-keyscan` offers what the server advertises, and a fourth algorithm the daemon will not pin is not a failure of the scan.

**`knownHostsLine`** is `` `[${target.host}]:${target.port} ${hostKey.algorithm} ${hostKey.publicKey}` ``. The bracketed spelling is used **always**, including for port 22. `ssh` matches `[host]:22` against a default-port connection, and one spelling means Story 08 never chooses between two.

**`scanHostKeys`** runs `paths.sshKeyscan` through `spawnSupervised` with:

- `args` exactly `["-T", "10", "-p", String(target.port), "--", target.host]`. `-T 10` is `ssh-keyscan`'s own connection timeout in seconds, and `--` ends the option list so a host beginning with `-` cannot become a flag. `remoteUrlVerdict` already refuses that host, and this is the second lock.
- `env` exactly `{ PATH: "", LC_ALL: "C", HOME: paths.home }`. `LC_ALL=C` fixes the diagnostic wording the classification reads.
- `cwd` `paths.runDirectory`, and a minted `pidFile` under `paths.runDirectory` that a `finally` removes with `rmSync({ force: true })`.
- A timer of `options?.timeoutMs ?? KEYSCAN_TIMEOUT_MS` that calls `signalGroup("SIGTERM")`, waits two seconds, then `signalGroup("SIGKILL")`. The process-level timeout is longer than `-T 10` so a hang inside `ssh-keyscan` reports as its own refusal and the timer catches only a wedged process.

`options.timeoutMs` is a declared member rather than a hidden seam, because the wedged-scan case below cannot be reached without it. No production caller sets it.

Outcome, in this order of tests:

1. The timer fired: `{ scanned: false, failure: "timed-out", detail: `ssh-keyscan did not answer within ${KEYSCAN_TIMEOUT_MS}ms` }`.
2. `parseKeyscanOutput(stdout)` is empty: `{ scanned: false, failure: "host-key-unavailable", detail: <the first line of stderr, or the empty string> }`. This is the classification of a refused connection, and it is reached on a non-zero exit and on a zero exit with no usable line alike.
3. Otherwise `{ scanned: true, hostKeys }`.

The exit code is not the discriminant. Measured: `ssh-keyscan -T 3 -p 1 127.0.0.1` exits `1` and writes `write (127.0.0.1): Broken pipe` four times to stderr with nothing on stdout. A parsed-output test covers that and every other unreachable case with one rule.

`scanHostKeys` returns an outcome and never throws for a network condition. It throws only from `scanTargetFor`, which is a url refusal and happens before any process starts.

## Constraints

- The daemon needs no `ssh-keygen`. `fingerprintOf` is `node:crypto`, and `tools.*` stays three keys.
- Never pass `-t` to `ssh-keyscan`. Restricting the scan to the accepted algorithms at the command line would make a rotation to a fourth type read as an unreachable host; the filter belongs in `parseKeyscanOutput`.
- Never call `ssh-keyscan` with a host taken from anywhere but `scanTargetFor`.
- The raw order of `ssh-keyscan` output is never asserted, and the sort is never `Array.prototype.sort` on strings — `Buffer.compare` is the bytewise rule of `AGENTS.md`.
- `host-key.ts` writes no file. Story 08 owns `known_hosts`.
- The file holds no `127.` and no `"localhost"` literal. `scanTargetFor` gets its host from `remoteUrlVerdict`.
- `stderr` reaching a `detail` passes through `stripUserinfo` from `./redact.ts`.

## Verify

`node --test src/services/git/host-key.test.ts`

### `scanTargetFor`

- `scanTargetFor("ssh://git@forge.test/r.git")` deep-equals `{ host: "forge.test", port: 22 }`.
- `scanTargetFor("ssh://git@forge.test:2222/r.git")` yields `port: 2222`.
- `scanTargetFor("git@forge.test:group/r.git")` yields `{ host: "forge.test", port: 22 }`.
- `scanTargetFor("ssh://git@[::1]:2222/r.git")` yields `{ host: "::1", port: 2222 }` — the brackets are stripped.
- `scanTargetFor("https://forge.test/r.git")` throws `GitError` with `failure === "unknown"` and the message `"only an ssh url has a host key"`.
- `scanTargetFor("ssh://git@forge.test/r.git\n")` throws `GitError` with `failure === "url-refused"`. The url policy runs first.

### `fingerprintOf` and `parseKeyscanOutput`

The keys in this section are generated once with `resolveTools().paths.sshKeygen` from `test/helpers/remote/tools.ts` into a `mkdtempSync` directory the test removes: one ed25519, one RSA and one ecdsa-sha2-nistp256 host key.

- For each generated key, `fingerprintOf(<the base64 field of its .pub>)` equals the `SHA256:` field of `resolveTools().paths.sshKeygen -l -f <the .pub>`. Three assertions, three algorithms. This is the whole justification for owning no `ssh-keygen` dependency, and it is proved against the tool rather than against a literal.
- `fingerprintOf` output matches `/^SHA256:[A-Za-z0-9+/]{43}$/` and contains no `=`.
- `parseKeyscanOutput` on a three-line text holding the three generated keys returns three entries whose `algorithm` values deep-equal `["ecdsa-sha2-nistp256","ssh-ed25519","ssh-rsa"]`, whatever order the lines were written in. Run it on all six permutations of the three lines and assert the same array each time — six identical results is what "the same ordered list on every run" means.
- A `#` comment line, an empty line and a two-field line are all dropped.
- A line whose algorithm is `ssh-dss` is dropped, and the remaining entries are unaffected.
- A duplicated line yields one entry.
- Two entries sharing an algorithm and differing in key are both kept and are ordered by `Buffer.compare` on the key. Construct the pair so the bytewise order differs from the `<` order of the two strings, which is what proves the comparator.
- `parseKeyscanOutput("")` returns `[]`.
- `parseKeyscanOutput` on a line with `\r\n` endings parses. A trailing `\r` in the key field would corrupt every fingerprint, so trim each field.

### `knownHostsLine`

- `knownHostsLine({ host: "forge.test", port: 22 }, key)` equals `` `[forge.test]:22 ${key.algorithm} ${key.publicKey}` ``. The bracketed spelling is used at the default port, asserted directly.
- `knownHostsLine({ host: "127.0.0.1", port: 7422 }, key)` equals `[127.0.0.1]:7422 …`. The test may hold the literal; the single-classifier fence covers `src/**` production files only.
- The line contains exactly two spaces and no newline.

### Against the ssh fixture

`await createSshRemote()` from `test/helpers/remote/index.ts`, disposed in `after`. Never name a starter — `.agent/plan/stories/005-test-infrastructure/05-fixture-acceptance-gate.md:139` fails `npm run verify` on any file outside the five fixture files that mentions one.

- `scanHostKeys(paths, remote.url("fixture.git"))` resolves `scanned: true` with two entries whose `algorithm` values deep-equal `["ssh-ed25519","ssh-rsa"]`. The fixture presents exactly two, and EPIC 005 Story 04 forbids reducing it to one.
- **Two runs agree.** Call it twice and `assert.deepEqual` the two `hostKeys` arrays, including the fingerprints. This is the epic coverage line "yields the same ordered list and the same `SHA256:` fingerprints on every run".
- Each returned fingerprint equals the `fingerprint` member of the matching `remote.hostKeys` entry, which EPIC 005 took verbatim from `ssh-keygen -l -f`. The daemon's own computation and the tool agree on the fixture as well as on a real forge.
- `knownHostsLine(scanTargetFor(remote.url("fixture.git")), hostKeys[0])` equals `remote.knownHostsLine(remote.hostKeys[0])`. The two spellings are the same string, which is what lets Story 08 write a file `ssh` accepts.
- **A scan that times out is classified, not reported as a mismatch.** `scanHostKeys` against `ssh://git@127.0.0.1:1/r.git` resolves `{ scanned: false, failure: "host-key-unavailable" }`. Assert `failure !== "host-key-mismatch"` explicitly, and assert the call resolves within ten seconds. EPIC 005 Story 05 records that no fixture offers a scan-timeout seam, so a closed loopback port is the seam, and it is measured to exit `1` with `Broken pipe` on stderr.
- **A wedged scan reports `timed-out`.** Point `paths.sshKeyscan` at a `/bin/sh` script running `sleep 30`, call `scanHostKeys(paths, url, { timeoutMs: 1500 })`, and assert `{ scanned: false, failure: "timed-out" }` within five seconds. Then assert the recorded pid is gone with `process.kill(pid, 0)` throwing `ESRCH`.
- **No pid file survives.** After a successful scan and after each failing one, `fs.readdirSync(paths.runDirectory)` holds no entry beginning with `"git-"` or `"keyscan-"`.
- **Nothing is written.** After a successful scan, `fs.readFileSync(paths.knownHosts, "utf8")` is the empty string. This story stores nothing.

### E2E — scenario `E7-05`, real `github.com`

File `scripts/e2e/007/05-host-key-discovery.e2e.ts`.

- `scanHostKeys(paths, "ssh://git@github.com/" + env.ghRepo + ".git")` resolves `scanned: true`.
- The returned `algorithm` list is bytewise sorted and is a subset of `ACCEPTED_HOST_KEY_ALGORITHMS`, and it contains at least `ssh-ed25519` and `ssh-rsa`. It is asserted as a subset with a floor, not as an exact list: `github.com` presented `ecdsa-sha2-nistp256` as well when this story was written, and a forge may retire an algorithm.
- **Two runs against the real host agree.** Two calls yield deep-equal arrays. This is the assertion the fixture cannot make, because a real forge answers over a real network with whatever raw order it likes.
- Each returned fingerprint equals the `SHA256:` field `ssh-keygen -l` reports for the same key. The scenario writes the scanned lines to a temporary file, runs the host's `ssh-keygen -l -f`, and compares by algorithm. No fingerprint literal appears in the scenario, so a GitHub host-key rotation does not fail the gate.
- `knownHostsLine` for each key renders `[github.com]:22 <algorithm> <key>`, and the rendered file is accepted by `ssh-keygen -l -f`.
- `scanHostKeys` against `ssh://git@127.0.0.1:1/r.git` resolves `host-key-unavailable` on the real host too, and within ten seconds.
- The scenario writes no `known_hosts`, makes no ssh connection, and creates no remote ref.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: contributes `src/services/git/host-key.test.ts`. It is not matched by the epic Proof globs; Story 13 records the widening.
