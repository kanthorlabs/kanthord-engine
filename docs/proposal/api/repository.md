# Repository

Reviewer: git or release engineer. Conventions are [README.md](README.md). The decisions are `../phase-1/git-foundation.md` and `../phase-2/integration-and-publish.md`.

Registration, the branch fields, and the repair of a divergence. Publish is delivery, and it lives in [integration.md](integration.md) even though its path is repository-scoped.

## Routes

| operationId            | Method and path                     | introducedIn | status  | Source                                      |
| ---------------------- | ----------------------------------- | ------------ | ------- | ------------------------------------------- |
| `repository.inspect`   | `POST /v1/repository/inspect`       | phase-1      | routed  | git-foundation.md, default branch detection |
| `repository.register`  | `POST /v1/repository`               | phase-1      | routed  | P1-E1, `repository register`                |
| `repository.list`      | `GET /v1/repository`                | phase-1      | routed  | phase-2 onboarding CLI                      |
| `repository.show`      | `GET /v1/repository/:id`            | phase-1      | routed  | P1-E1 and P1-E5, `repository show`          |
| `repository.reconcile` | `POST /v1/repository/:id/reconcile` | phase-2      | stubbed | P2-E3, `repository reconcile`               |

## `repository.inspect`

The body holds the remote URL and a `credentialId`. The response holds the default branch read from the `HEAD` symref, and the verdict of the credential check. For an ssh url it also holds the host key. It writes nothing.

Detection never applies by itself, so registration is two calls. The client shows the detected branch, the human confirms, and `repository.register` carries the confirmed value. The confirmation lives in the client, and the daemon holds no wizard state, because a half-finished registration on the server is a thing a second client can find.

The confirmation is explicit in an automated run as well. `kanthord repository register --branch <branch>` supplies it without a prompt, and the CLI refuses to register when neither a prompt nor the flag answered. P1-E1 passes the flag, which is what keeps its `Human action: none` true while the product rule holds.

### The host key is confirmed the same way

An ssh url adds a second thing the human confirms, and it takes the shape the branch confirmation already has, because one pattern is enough for both.

```
POST /v1/repository/inspect
  -> { defaultBranch, hostKey: { algorithm, fingerprint }, credential: { reachable, refusal } }

POST /v1/repository
  <- { ..., hostFingerprint }
```

`inspect` reads the host key with `ssh-keyscan` and returns its algorithm and `SHA256:` fingerprint. It stores nothing. `register` re-scans, compares against the `hostFingerprint` the body carries, and refuses with `409 host-key-mismatch` when they differ, listing the fingerprints the host did present in `details`. Only on a match does the daemon write the key into its own `known_hosts`, and from then on every connection verifies against it under `StrictHostKeyChecking=yes`.

The re-scan is what makes the confirmation load-bearing rather than decorative. Without it, a client could echo any fingerprint back and the daemon would pin whatever the network offered at register time.

`ssh-keyscan` reads the key over the same unauthenticated network as the connection it pins, so this is trust on first use with a human in the loop. The human comparing the fingerprint against the value their forge publishes is the security decision, and the daemon cannot make it for them. `--host-fingerprint <value>` supplies it without a prompt, and the CLI refuses to register an ssh url when neither a prompt nor the flag answered — the same rule as `--branch`.

An `http-basic` url has no host key, so `hostKey` is absent from the response and `hostFingerprint` is refused in the body.

A host key that changes later is a failed operation, not a silent re-pin. Re-confirmation is an explicit human act, and it reuses this route.

### The credential verdict reports read and write access independently

`inspect` reports whether the credential reached the remote for a **read** and,
when `requiredAccess: "write"` is requested, for a **write-advertisement** as
well. The response carries two members:

```json
"access": {
  "read":  { "allowed": true,  "refusal": null },
  "write": { "allowed": false, "refusal": "auth-failed" }
}
```

`access.read` mirrors `credential` exactly. `access.write` is `null` when
`requiredAccess` is absent or `"read"`, and a full verdict when `"write"` was
requested.

**How the write-advertisement works.** The git service creates a temporary bare
repository, fetches the remote's default branch, calls
`git push --dry-run` at the publish ref of that branch with the fetched object
id, and removes the temporary repository before returning. `inspect` still seeds
no home, and nothing written during the probe survives the call. Credential
files (helper scripts and SSH keys) are written inside the same temporary
directory and are removed with it. The probe's cost is one fetch plus one
dry-run push against the remote.

**A read failure short-circuits the probe.** A credential that cannot reach the
remote via `git ls-remote` cannot fetch the object the probe needs. When
`remoteInfo` fails, `access.write` carries the same refusal as `access.read`
without a network call to the write side.

**A remote with no default branch yields** `access.write:
{ allowed: false, refusal: "empty-remote" }` and no fetch is attempted.

**`reachable: true` is not a statement about push permission.** A public
repository serves `git-upload-pack` to anyone, so a garbage token reads the ref
list exactly like a good one. Use `requiredAccess: "write"` to obtain a
write-advertisement verdict before registration.

**The write-advertisement verdict proves only write-advertisement access.**
Branch protection, a required status check, a signature rule or a server hook
can still reject a later publish to the same ref. The verdict says the credential
authenticates and may push to the repository; it never says a publish will be
accepted. See the caveat at the end of this section.

## `repository.register`

The body holds the remote URL, a name, a `credentialId`, the one branch field of `../phase-1/git-foundation.md` — `branch` — and, for an ssh url, the confirmed `hostFingerprint`. A missing `branch` is `400`, and a missing `hostFingerprint` on an ssh url is the same `400`. The daemon never infers one here, because `repository.inspect` is where inference happens and the human already answered.

**This route repeats the preflight.** `inspect` and `register` are two requests, and between them a credential can be removed or changed, the remote can move, and the client can submit a different `credentialId` than the one it inspected. A successful inspect authorizes nothing. A write-advertisement verdict on `inspect` is evidence that push access exists at the time of the call; it is not a guarantee that a later `repository.register` or publish will succeed.

### The credential check is a write advertisement

The route runs `git push --dry-run` against the publish ref, which contacts `git-receive-pack` and therefore requires push permission. `git ls-remote` cannot serve here: it speaks to `git-upload-pack`, which is the read side. The dry run changes nothing on the remote.

It runs from the staging home, **after** the fetch and **before** the rename, and it pushes the fetched upstream object id at the publish ref. That placement is forced: a push needs a local object, and the fetch is what produces one. It is the only point in the sequence where the credential can be proved against the write side and no visible home exists yet.

A fetch cannot prove a credential. A public repository serves `git-upload-pack` to anyone, so a garbage token reads the ref list exactly like a good one, and a read preflight would register a dead credential and surface it at the first publish, after a human approved work. The write advertisement requires push permission, refuses a wrong token, and answers `401` with no credential.

It proves **write-advertisement access, and nothing more.** Branch protection, a required check, a signature rule or a server hook can still reject a later push to the publish ref. The verdict says the credential authenticates and may push to the repository; it never says a publish will be accepted.

The route then runs the explicit seeding sequence: init a bare repository, add the remote, set the fetch refspec, fetch with prune, and create the landing branch from the tracking ref. A bare clone of the remote is forbidden.

The body also holds `publishOnApproval`, default true. `../phase-2/integration-and-publish.md` makes chaining the default and configurable per repository.

### The credential

`credentialId` names a `provider` row of `kind = 'git'`, and it is mandatory. `repository.credential_id` is `NOT NULL`, because every repository publishes, and a null would move the failure from registration, where a human is watching, to the first publish three phases later.

It is an id and never a name. A name is renameable, and the conventions make a name a filter rather than a reference. The CLI resolves `--credential <name>` to an id before it calls.

`../phase-1/git-foundation.md` reversed the ambient-credential decision: the daemon suppresses the operator's `~/.gitconfig`, the system credential helper and the ssh agent on every invocation, so there is nothing ambient to inherit by design.

### Refused urls

A url is HTTPS, ssh, or plain HTTP on a loopback host. Plain HTTP is accepted only when the host is a loopback address, where there is no network to encrypt, and a plain HTTP url elsewhere is `400 invalid-request`. Any other scheme is the same `400`.

`ssh://` and `git@host:path` are accepted, and each requires a `git` credential whose transport is `ssh`. An HTTPS url, and the loopback HTTP exception, both require a credential whose transport is `http-basic`; the discriminant covers the exception deliberately. A url and a credential that disagree is `400 invalid-request`, because the daemon will not guess which one the human meant.

Four url shapes are refused for a reason of their own, and each is the same `400` with the reason in `details`: a url carrying a **password** in its userinfo, because the secret belongs in the registration and would otherwise reach every log line; a url whose host or path begins with `-`, because it would be read as an option; a url carrying a control character; and a scheme the transport policy does not name.

A userinfo **username** is not a secret and is not refused. `git@host:path` is the ordinary ssh spelling, and the login name has to live in the url because the ssh payload carries only a key. The rule is therefore narrower than "no credentials in urls": a username is data, and a password is a secret.

All of these fail validation before any network call, which is why none is an error code of its own.

A forge that refuses the credential is `422 credential-rejected`, with the forge response in `details`. It is not `401`: on this API `401` means the caller's own bearer token failed.

## `repository.show`

Returns `branch`, the three refs it renders, the landing tip, the upstream tracking tip, the last fetched upstream object id, `publishOnApproval`, the bound credential — its id and its current name — the repository state, and the profile hash when one is bound.

`fetchedUpstreamOid` is the `U` of the last freshness pass, which is what makes the base of an objective attributable.

P1-E4 and P3-E6 assert the ref layout through this route alone, because the client cannot read the daemon file system. The response therefore carries `landingRef`, `trackingRef` and `publishRef` as read-only strings rendered from `branch`, not as a directory listing. They are derived on read and stored nowhere.

The state is `ready` or `needs-reconcile`. A `needs-reconcile` response carries both object ids, because `../phase-1/state-machine.md` requires `status` to name them.

## `repository.reconcile`

Merges the upstream tip into the landing branch in a scratch workspace, runs the unit check against the resulting merge commit, and lands it with a compare-and-swap. A conflict returns `409` and names the files.

The daemon never repairs a divergence by itself, so no scheduler path reaches this behaviour. A human calls this route.
