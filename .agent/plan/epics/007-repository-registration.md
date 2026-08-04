# EPIC 007 — Repository registration

Status: **draft**.

## Goal

A human stores a git credential, inspects a remote, confirms the detected default branch, registers the repository, and reads the ref layout back through the public surface. End to end: command, query, route and CLI.

## Non-goals

- No landing-branch change, no reconcile. Both are phase 2 and answer `501`.
- No `provider.rename`, `provider.remove` or `provider.setDefault`. Phase 2.

## Stories

- **Tool probe** — add the `tools.git`, `tools.ssh` and `tools.sshKeyscan` keys to the config service, each with a documented default, resolve them to absolute paths, read the version of `git` and `ssh`, and probe `ssh-keyscan` for presence only because it has no portable version output. A missing tool, or a `git` outside the supported range, refuses startup and names what it found and what it wanted. It runs after the home lock and before anything that invokes a tool, and it builds the `GitPaths` record that EPIC 006's runner takes as a dependency. This story was EPIC 007.5's, and it moved here because this epic is the first consumer: EPIC 006 resolves nothing by design, and `src/services/config/convict.ts` validates with `allowed: "strict"`, so no path can reach the daemon until the keys exist.
- **The provider kind factory** — `kind` dispatches to one zod schema, one serializer, one deserializer and one public projection, and the table carries no column of any single kind. `docs/proposal/database/provider.md` requires it.
- **The credential routes, both kinds** — `provider.register`, `provider.list` and `provider.show`, on the crypto service of EPIC 003. `docs/proposal/database/provider.md` says the MVP registers `llm` and `git`, and `docs/proposal/api/credential.md` declares both payloads, so phase 1 ships both. The `git` payload is a discriminated union on `transport`: `http-basic` carries a forge, a username and a token, and `ssh` carries an unencrypted private key and nothing else. An encrypted key is refused at registration, because `BatchMode=yes` means `ssh` never asks for a passphrase. The `git` projection is the transport, and the forge and username when it has them; the `llm` projection is the provider variant, the default model and the base URL. The secret is write-only; no route reads a credential field back under either kind. `provider.setDefault` refuses `kind = 'git'`.
- **`repository.inspect`** — the default branch read from the `HEAD` symref that `git ls-remote --symref` reports, plus the credential verdict, plus the host key for an ssh url. It writes nothing, and it holds no wizard state.
- **The registration preflight** — `git push --dry-run` against the publish ref, which speaks to `git-receive-pack` and therefore requires push permission. `git ls-remote` cannot serve, because it speaks to `git-upload-pack`. A push needs a local repository and a local object, and before seeding there is neither, so the preflight runs from the staging home after the fetch and before the rename, and pushes the fetched upstream object id at the publish ref. It asserts the remote ref did not move. A wrong token and a read-only credential on a public repository each fail and write no row. `GIT_TERMINAL_PROMPT=0` makes a rejected credential fail instead of prompting. The API returns `422 credential-rejected`, and the refusal is recorded as an **event** on the credential registration — not as a `git_operation` row, because `git_operation.repository_id` is `NOT NULL REFERENCES repository(id)` and a refused registration has no repository to journal against. The preflight proves write-advertisement access and no more.
- **Host key discovery** — `ssh-keyscan` returns several keys in no guaranteed order, so this story fixes what is returned and stored: the accepted algorithm set, the ordering, the `SHA256:` fingerprint encoding, the `[host]:port` `known_hosts` spelling, and the classification of a scan timeout or refusal. Without those pinned, two runs disagree and the confirmation compares nothing.
- **Host key confirmation** — for an ssh url, `inspect` returns the scanned host key and its fingerprint, `register` carries the confirmed `hostFingerprint`, and the route re-scans and compares before it writes anything. A mismatch is `409`. Only a match persists the key into the daemon's `known_hosts`, and every later connection verifies against it under `StrictHostKeyChecking=yes`. The re-scan is what stops a client echoing back any value it likes. `--host-fingerprint` supplies it without a prompt, and the CLI refuses an ssh url when neither a prompt nor the flag answered.
- **Bare home seeding** — the confirmed host key is written into the daemon's `known_hosts` before any ssh connection that is not the scan itself, so the preflight and the fetch both run under `StrictHostKeyChecking=yes`. Then: init bare with an empty template into a staging directory, add the remote, set the fetch refspec, fetch with prune and `--no-tags`, read the upstream object id from the tracking ref, write `refs/heads/<landing>` through `refUpdate` against an empty expected value, then rename the staging directory into place. A bare clone of the remote is forbidden, and a partially seeded home is never visible.
- **`repository.register`** — the three branch fields and `publishOnApproval` from the body, the confirmed `hostFingerprint` for an ssh url, the repeated preflight, the seeding, the baseline `sync` row in `git_operation`, and the event. It writes the **baseline** that EPIC 006's outside-writer verdict later reads, and it is not that verdict's first caller: the check compares a ref against a recorded baseline, and this operation creates the baseline and refuses an existing home, so at registration there is nothing to compare. This epic therefore ships the refusal as a command — `assertNoOutsideWriter`, which reads the baseline and appends the event **inside the same transaction as the state decision**, because the primitive returns a verdict and writes nothing. Its first caller is the first repeat write path on a seeded home, which is the merge and sync work of a later epic; that epic binds it to a route. A missing branch field is `400`, and so is a missing `hostFingerprint` on an ssh url; the daemon infers nothing here.
- **`repository.list` and `repository.show`** — the projection carries the branch fields, the landing tip, the tracking tip, `fetchedUpstreamOid`, the bound credential, and the repository state. P1-E3 asserts the ref layout through this route alone.
- **The CLI commands** — `kanthord credential register`, `kanthord repository register --url --credential --upstream [--host-fingerprint]`, and `kanthord repository show`. `--credential <name>` resolves to an id before the call. The register command refuses when neither a prompt nor `--upstream` answered the confirmation, and refuses an ssh url when neither a prompt nor `--host-fingerprint` answered.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/domain/provider-payload.test.ts \
  src/services/git/probe.test.ts src/services/git/host-key.test.ts \
  src/services/git/remote-info.test.ts src/services/git/preflight.test.ts \
  src/services/git/seed.test.ts src/services/git/binary.test.ts \
  src/commands/provider/**/*.test.ts src/queries/provider/**/*.test.ts \
  src/commands/repository/**/*.test.ts src/queries/repository/**/*.test.ts \
  src/http/server/credential/**/*.test.ts src/http/server/repository/**/*.test.ts \
  src/cli/confirm.test.ts src/cli/credential/**/*.test.ts src/cli/repository/**/*.test.ts \
  && echo "PASS EPIC-007"
```

The Proof names every layer this epic builds, because most of it is neither a repository command nor a repository query. A Proof globbing only `commands/`, `queries/` and `cli/` would print `PASS` while the provider kind factory, the tool probe, host key discovery, the write-advertisement preflight, the seeding sequence, the `Git` assembly and every one of the seven handlers were absent.

The end-to-end gate is separate and is **not** part of this Proof:

```bash
npm run e2e:007
```

It drives every declared scenario against the real remote of `.env.e2e`, and it is outside `npm run verify` because the hermetic suite makes no network call.

Hermetic coverage required beyond the Proof:

- Registration against the fixture remote produces `refs/remotes/origin/*` and exactly one landing branch at the detected default.
- An `ssh://` url registers against the ssh fixture with a confirmed fingerprint, and is refused when the fingerprint does not match, when the credential transport disagrees with the url, and when the key is encrypted.
- `ssh-keyscan` against a host offering several algorithms yields the same ordered list and the same `SHA256:` fingerprints on every run, and the `known_hosts` entry uses the `[host]:port` spelling. A scan that times out is classified, not reported as a mismatch.
- `register` **re-scans** the host and compares, rather than trusting the body: a request carrying a fingerprint the host does not present is `409`, proved by supplying a syntactically valid fingerprint that was never scanned.
- Registration writes no `refs/tags/*` against a tagged fixture repository, and a failure injected after the fetch leaves no visible home, only a staging directory.
- A read-only credential that fetches successfully is refused by the preflight, writes `auth-failed` to the journal, and creates no `repository` row. This is the case a read preflight cannot detect, and it is why the preflight is a write advertisement.
- A plain HTTP url is accepted on a loopback host and refused elsewhere, and a url carrying a password in its userinfo is refused while one carrying only a username is not.
- A wrong token fails with `422 credential-rejected` on the API, exactly one `repository.register.credentialRejected` event on the credential registration, and no `repository` row and no `git_operation` row. A credential whose token is empty never reaches this path: `provider.register` refuses it with `400 invalid-request`, and that refusal is asserted on the credential route instead.
- `repository register` with no `--upstream` and no terminal exits non-zero and names the flag, and an `ssh://` url with no `--host-fingerprint` and no terminal does the same.
- A `provider.show` of each kind returns that kind's public projection and no credential field, asserted field by field rather than by a substring search.
- A missing tool, or a `git` below the supported floor, refuses startup and names both the found and the wanted version. The daemon does not reach a route.
- An outside-writer mismatch refuses the operation and writes **exactly one** event in the same transaction as the state decision, a matching baseline writes none, and neither path sets `needs-reconcile`.
