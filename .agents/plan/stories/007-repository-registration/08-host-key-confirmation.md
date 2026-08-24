# Story 08 — Host key confirmation

Epic: `.agents/plan/epics/007-repository-registration.md`
Depends on: Story 05 (`scanHostKeys`, `knownHostsLine`), Story 06 (`inspect` returns the key).

`inspect` returns the scanned key. `register` carries the confirmed `hostFingerprint`, and the route **re-scans** and compares before it writes anything. A mismatch is `409`. Only a match writes the key into the daemon's `known_hosts`.

## Change

### 1. `src/services/git/host-key.ts` — confirmation and trust

Append:

```ts
export type ConfirmOutcome =
  | Readonly<{ confirmed: true; hostKey: HostKey }>
  | Readonly<{
      confirmed: false;
      reason: "fingerprint-mismatch" | "scan-failed";
      presented: readonly string[];
      detail: string;
    }>;

export function confirmHostKey(
  paths: GitPaths,
  remoteUrl: string,
  hostFingerprint: string,
): Promise<ConfirmOutcome>;

export function trustHostKey(
  paths: GitPaths,
  input: Readonly<{ remoteUrl: string; hostKey: HostKey }>,
): Promise<void>;

export function parseKnownHosts(text: string): readonly string[];
```

**`confirmHostKey`** calls `scanHostKeys(paths, remoteUrl)` — a fresh scan, never a cached one and never a value from a request body.

- A `scanned: false` outcome yields `{ confirmed: false, reason: "scan-failed", presented: [], detail: outcome.detail }`.
- A scan whose `hostKeys` holds an entry with `fingerprint === hostFingerprint` yields `{ confirmed: true, hostKey: <that entry> }`. The match is on the whole `SHA256:…` string with `===`. No prefix match, no case fold, no truncation.
- Otherwise `{ confirmed: false, reason: "fingerprint-mismatch", presented: <the fingerprints of the scanned keys, in the sorted order>, detail: "" }`.

The re-scan is what stops a client echoing back any value it likes. `docs/proposal/api/repository.md:40` states it, and the mechanism is that `confirmHostKey` takes a url and a fingerprint and has no channel through which a caller can supply a key.

**The confirmed key is one of the scanned keys, not the one `inspect` returned.** A forge can rotate between the two requests, and the object written to `known_hosts` must be the object the daemon just observed. `confirmHostKey` therefore returns the scanned entry, and Story 10 writes that.

**`trustHostKey`** appends `knownHostsLine(scanTargetFor(input.remoteUrl), input.hostKey)` plus `"\n"` to `paths.knownHosts`.

1. `mkdirSync(dirname(paths.knownHosts), { recursive: true, mode: 0o700 })`.
2. Read the current file, or the empty string when it is absent.
3. When `parseKnownHosts(text)` already contains the exact line, return without writing. The operation is idempotent, so a re-registration of the same host does not grow the file.
4. Otherwise append with `appendFileSync(paths.knownHosts, line + "\n", { mode: 0o600 })`.
5. `chmodSync(paths.knownHosts, 0o600)`.

`parseKnownHosts` splits on `\n`, trims each line, and drops an empty line and a line beginning with `#`.

**The write is an append, not a replace.** One daemon serves repositories on several hosts, and replacing the file would unpin every other host. It is also why Story 01's `buildGitPaths` never truncates the file.

`trustHostKey` writes only after `confirmHostKey` returned `confirmed: true`. The two are separate functions so the ordering is visible at the one call site, which is Story 10's command.

### 2. `src/services/git/index.ts` — the interface member

`Git.trustHostKey` at `:97-99` already takes `{ remoteUrl, hostKey }`. No change. Add `confirmHostKey` to the interface:

```ts
  confirmHostKey(
    input: Readonly<{ remoteUrl: string; hostFingerprint: string }>,
  ): Promise<ConfirmOutcome>;
```

`Git` grows from eleven members to twelve. The eleven today are `remoteUrlVerdict`, `scanHostKeys`, `trustHostKey`, `seedHome`, `remoteInfo`, `canPush`, `fetch`, `resolveRef`, `refUpdate`, `checkOutsideWriter` and `clone`, at `src/services/git/index.ts:95-119`. `src/domain/layout.test.ts:115-131` asserts no `src/services/*/index.ts` contains `implements `, which is unaffected.

### 3. `src/http/server/repository/refusals.ts` — two rows

| thrown                                            | `httpError` call                                                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `RegisterRepositoryError("host-key-mismatch")`    | `httpError("host-key-mismatch", error.message, { presented: error.presented, confirmed: error.confirmed })` |
| `RegisterRepositoryError("host-key-unavailable")` | `httpError("invalid-request", error.message, { refusal: "host-key-unavailable", detail: error.detail })`    |

`409` is spelled `host-key-mismatch`, and it is the **twenty-first** error code. `docs/proposal/api/README.md` now declares it after `choices-changed`, and `docs/proposal/api/repository.md:38` names it. Reusing `stale-revision` was rejected: its declared meaning is "a precondition token no longer matches", which tells a client to re-read and retry, and a host presenting an unexpected key is the one phase-1 condition where retrying is the wrong reflex. `errors.ts` makes `details` mandatory for every `409`, so both sides of the comparison travel there.

### 4. `src/http/contract/errors.ts` — the twenty-first code

Add one entry to `errorStatuses`, **after** `"choices-changed"` and before `"plan-invalid"`, so the record keeps the proposal's table order:

```ts
    "host-key-mismatch": 409,
```

`src/http/contract/errors.test.ts` pins that order, and it needs exactly three edits:

- `:12-33` — insert `"host-key-mismatch"` after `"choices-changed"` in the `deepEqual` list, and rename the test to `"pins the twenty-one codes in table order"`.
- `:44-53` — append `"host-key-mismatch"` to the `groups[409]` list.
- `:69` — `assert.equal(sum, 21)`.

Nothing else moves. `PreconditionCode` is derived from the status, so the new code joins it automatically and `httpError("host-key-mismatch", …)` will not compile without `details` — which is what forces both fingerprints into the response.

`details.presented` is the array of scanned fingerprints and `details.confirmed` is the value the body carried. A human reading the error can compare the two without a second request.

## Constraints

- `confirmHostKey` never reads `paths.knownHosts`. A stored key is not evidence about the host's current key; the scan is.
- `trustHostKey` never truncates, never rewrites and never sorts the file. It appends one line or nothing.
- The comparison is `===` on the whole fingerprint. No `startsWith`, no `toLowerCase`, no `slice`.
- Never pass `-o StrictHostKeyChecking=accept-new` anywhere. EPIC 006 Story 03's ssh wrapper pins `yes`, and this story is the only writer of the file it verifies against.
- `trustHostKey` is called only on a `confirmed: true` outcome, and only from Story 10's command.
- No `127.` and no `"localhost"` literal in `host-key.ts`.

## Verify

`node --test src/services/git/host-key.test.ts` — the file Story 05 created gains these cases.

### `confirmHostKey`, against the ssh fixture

`await createSshRemote()`, disposed in `after`.

- A fingerprint taken from `remote.hostKeys[0].fingerprint` yields `{ confirmed: true }` and `outcome.hostKey.fingerprint` equal to it, with `outcome.hostKey.publicKey` equal to `remote.hostKeys[0].publicKey`.
- A fingerprint taken from `remote.hostKeys[1].fingerprint` also yields `confirmed: true`, and the returned key is the second entry. Either presented key confirms; the daemon does not insist on one algorithm.
- **A syntactically valid fingerprint the host never presented is refused.** Use `remote.wrongHostKey.fingerprint`, which EPIC 005 generates from a real key the server never offers. The outcome is `{ confirmed: false, reason: "fingerprint-mismatch" }`, `presented` deep-equals the two fixture fingerprints in the sorted order, and `detail` is the empty string. This is the epic coverage line "proved by supplying a syntactically valid fingerprint that was never scanned".
- A truncated fingerprint — the first twenty characters of a real one — is refused. The comparison is whole-string.
- The same fingerprint with `SHA256:` lower-cased to `sha256:` is refused.
- A scan against `ssh://git@127.0.0.1:1/r.git` yields `{ confirmed: false, reason: "scan-failed" }` with a non-empty `detail`, and `reason !== "fingerprint-mismatch"`. A host that does not answer is not a host that changed identity.
- **The confirmation re-scans.** Call `confirmHostKey` twice and assert the fixture's `log()` grew between the two calls, or — because `ssh-keyscan` does not authenticate and may not log — assert instead that `confirmHostKey` still returns `confirmed: true` after `paths.knownHosts` has been overwritten with `remote.writeKnownHosts([remote.wrongHostKey])`. The stored file cannot change the verdict, which is what "re-scans rather than trusting stored state" means and what a call-count assertion cannot show.
- **Nothing is written by a confirmation.** `fs.readFileSync(paths.knownHosts, "utf8")` is unchanged across a `confirmed: true` outcome and across both refusals.

### `trustHostKey` and `parseKnownHosts`

- `parseKnownHosts("# c\n\n[h]:22 a k\n")` deep-equals `["[h]:22 a k"]`.
- `trustHostKey` on an empty `known_hosts` writes exactly one line ending in `\n`, and the line equals `remote.knownHostsLine(remote.hostKeys[0])`. The daemon's spelling and the fixture's are the same string.
- The file mode after the write is `"600"`, and the parent directory mode is `"700"`.
- **Idempotent.** Call `trustHostKey` with the same key twice and assert the file holds one line.
- **Additive.** Call it with `remote.hostKeys[0]`, then with `remote.hostKeys[1]`. The file holds two lines in call order, and the first line is unchanged.
- **A second host does not unpin the first.** Write a line for a fabricated `[other.test]:22` target, then `trustHostKey` for the fixture, and assert both lines survive.
- `trustHostKey` against a `paths.knownHosts` whose parent directory does not exist creates the directory and the file.
- **The pinned file works.** After `trustHostKey` for both fixture keys, copy `paths.knownHosts` into a fresh `GitPaths` and run an authenticated `fetch` over `remote.url("fixture.git")` with `remote.privateKeyPath` as the credential's `privateKey`. It resolves `code === 0`. This is the assertion that the written spelling is one `ssh` accepts under `StrictHostKeyChecking=yes`, and a wrong bracket form would fail it.
- **A wrong pin still fails.** Replace `paths.knownHosts` with a file holding only the `wrongHostKey` line and run the same fetch. It resolves non-zero and `classifyFailure` returns `host-key-mismatch`. Pass an explicit `timeoutMs` well below the default, so a regression to a hang fails as `timed-out` instead of stalling the suite — EPIC 005 measured that this fails at once.

### E2E — scenario `E7-08`, real `github.com`

File `scripts/e2e/007/08-host-key-confirmation.e2e.ts`.

- `scanHostKeys` against `ssh://git@github.com/<repo>.git` yields the presented keys, and `confirmHostKey` with the fingerprint of the first entry yields `confirmed: true` with that entry returned. No fingerprint literal appears in the scenario; the confirmed value comes from the scan, which is what keeps a GitHub host-key rotation from failing the gate.
- **A fabricated fingerprint is refused against the real host.** Generate a key with `resolveTools().paths.sshKeygen` in the scenario's temporary directory, compute its fingerprint with `fingerprintOf`, and assert `confirmHostKey` yields `{ confirmed: false, reason: "fingerprint-mismatch" }` with `presented` equal to the scanned fingerprints. It is a syntactically valid fingerprint of a real key `github.com` has never presented.
- **The re-scan is load-bearing against the real host.** Write the fabricated key into `paths.knownHosts` with `trustHostKey`, then call `confirmHostKey` with a real scanned fingerprint and assert `confirmed: true`. The stored file did not change the verdict.
- `trustHostKey` for every scanned key writes a `known_hosts` the host's own `ssh-keygen -l -f` reads without error, and the file mode is `"600"`.
- **The pinned file authenticates the real host.** With that `known_hosts`, run `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<file> -o IdentityAgent=none -i <the generated key> -T git@github.com` through the harness. GitHub answers `Permission denied (publickey)` because the generated key is not registered, and the scenario asserts the stderr contains `Permission denied` and does **not** contain `Host key verification failed`. That distinction is the whole assertion: the host key was accepted and the credential was not.
- **An unpinned host fails host-key verification.** The same command with an empty `known_hosts` yields stderr containing `Host key verification failed`. The two runs differ in one file, which is what proves the pin does the work.
- The scenario creates no remote ref and registers no repository.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: extends `src/services/git/host-key.test.ts`.
