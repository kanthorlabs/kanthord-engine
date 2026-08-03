# EPIC 007 — Repository registration

Status: **draft**.

## Goal

A human stores a git credential, inspects a remote, confirms the detected default branch, registers the repository, and reads the ref layout back through the public surface. End to end: command, query, route and CLI.

## Non-goals

- No landing-branch change, no reconcile. Both are phase 2 and answer `501`.
- No `provider.rename`, `provider.remove` or `provider.setDefault`. Phase 2.

## Stories

- **The provider kind factory** — `kind` dispatches to one zod schema, one serializer, one deserializer and one public projection, and the table carries no column of any single kind. `docs/proposal/database/provider.md` requires it.
- **The credential routes, both kinds** — `provider.register`, `provider.list` and `provider.show`, on the crypto service of EPIC 003. `docs/proposal/database/provider.md` says the MVP registers `llm` and `git`, and `docs/proposal/api/credential.md` declares both payloads, so phase 1 ships both. The `git` projection is the forge and the username; the `llm` projection is the provider variant, the default model and the base URL. The secret is write-only; no route reads a credential field back under either kind. `provider.setDefault` refuses `kind = 'git'`.
- **`repository.inspect`** — the default branch read from the `HEAD` symref, plus the credential verdict. It writes nothing, and it holds no wizard state.
- **The registration preflight** — `listServerRefs({ forPush: true })`, which speaks to `git-receive-pack`. A wrong token, a missing token and a read-only credential on a public repository each fail and write no row. `onAuthFailure` returns `{ cancel: true }`, so the library throws instead of retrying. The journal records `auth-failed`; the API returns `422 credential-rejected`.
- **Bare home seeding** — init bare, add the remote, set the fetch refspec, fetch with prune, and write `refs/heads/<landing>` through `refUpdate`. A bare clone of the remote is forbidden.
- **`repository.register`** — the three branch fields and `publishOnApproval` from the body, the repeated preflight, the seeding, the baseline `sync` row in `git_operation`, and the event. A missing branch field is `400`; the daemon infers nothing here.
- **`repository.list` and `repository.show`** — the projection carries the branch fields, the landing tip, the tracking tip, `fetchedUpstreamOid`, the bound credential, and the repository state. P1-E3 asserts the ref layout through this route alone.
- **The CLI commands** — `kanthord credential register`, `kanthord repository register --url --credential --upstream`, and `kanthord repository show`. `--credential <name>` resolves to an id before the call. The register command refuses when neither a prompt nor `--upstream` answered the confirmation.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/commands/repository/**/*.test.ts src/queries/repository/**/*.test.ts \
  && echo "PASS EPIC-007"
```

Hermetic coverage required beyond the Proof:

- Registration against the fixture remote produces `refs/remotes/origin/*` and exactly one landing branch at the detected default.
- An `ssh://` url is refused at registration, and a plain HTTP url is accepted on a loopback host and refused elsewhere.
- A wrong token and a missing token each fail with `auth-failed` in the journal, `422 credential-rejected` on the API, and no `repository` row.
- `repository register` with no `--upstream` and no terminal exits non-zero and names the flag.
- A `provider.show` of each kind returns that kind's public projection and no credential field, asserted field by field rather than by a substring search.
