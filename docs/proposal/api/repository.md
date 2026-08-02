# Repository

Reviewer: git or release engineer. Conventions are [README.md](README.md). The decisions are `../phase-1/git-foundation.md` and `../phase-2/integration-and-publish.md`.

Registration, the branch fields, and the repair of a divergence. Publish is delivery, and it lives in [integration.md](integration.md) even though its path is repository-scoped.

## Routes

| operationId                | Method and path                          | introducedIn | status  | Source                                      |
| -------------------------- | ---------------------------------------- | ------------ | ------- | ------------------------------------------- |
| `repository.inspect`       | `POST /v1/repository/inspect`            | phase-1      | routed  | git-foundation.md, default branch detection |
| `repository.register`      | `POST /v1/repository`                    | phase-1      | routed  | P1-E1, `repository register`                |
| `repository.list`          | `GET /v1/repository`                     | phase-1      | routed  | phase-2 onboarding CLI                      |
| `repository.show`          | `GET /v1/repository/:id`                 | phase-1      | routed  | P1-E1 and P1-E3, `repository show`          |
| `repository.landingBranch` | `POST /v1/repository/:id/landing-branch` | phase-2      | stubbed | git-foundation.md, "an explicit operation"  |
| `repository.reconcile`     | `POST /v1/repository/:id/reconcile`      | phase-2      | stubbed | P2-E3, `repository reconcile`               |

## `repository.inspect`

The body holds the remote URL and a `credentialId`. The response holds the default branch read from the `HEAD` symref, and the verdict of the credential check. It writes nothing.

Detection never applies by itself, so registration is two calls. The client shows the detected branch, the human confirms, and `repository.register` carries the confirmed value. The confirmation lives in the client, and the daemon holds no wizard state, because a half-finished registration on the server is a thing a second client can find.

The confirmation is explicit in an automated run as well. `kanthord repository register --upstream <branch>` supplies it without a prompt, and the CLI refuses to register when neither a prompt nor the flag answered. P1-E1 passes the flag, which is what keeps its `Human action: none` true while the product rule holds.

### The credential check is a write advertisement

The route runs `listServerRefs({ forPush: true })`, which speaks to `git-receive-pack`. It changes nothing on the remote.

A fetch cannot prove a credential. A public repository serves `git-upload-pack` to anyone, so a garbage token reads the ref list exactly like a good one, and a read preflight would register a dead credential and surface it at the first publish, after a human approved work. The write advertisement requires push permission, refuses a wrong token, and answers `401` with no credential.

It proves **write-advertisement access, and nothing more.** Branch protection, a required check, a signature rule or a server hook can still reject a later push to the publish ref. The response says the credential authenticates and may push to the repository; it never says a publish will be accepted.

## `repository.register`

The body holds the remote URL, a name, a `credentialId`, and the three branch fields of `../phase-1/git-foundation.md`: `upstreamBranch`, `landingBranch` and `publishRef`. A missing branch field is `400`. The daemon never infers one here, because `repository.inspect` is where inference happens and the human already answered.

**This route repeats the preflight.** `inspect` and `register` are two requests, and between them a credential can be removed or changed, the remote can move, and the client can submit a different `credentialId` than the one it inspected. A successful inspect authorizes nothing.

The route then runs the explicit seeding sequence: init a bare repository, add the remote, set the fetch refspec, fetch with prune, and create the landing branch from the tracking ref. A bare clone of the remote is forbidden.

The body also holds `publishOnApproval`, default true. `../phase-2/integration-and-publish.md` makes chaining the default and configurable per repository.

### The credential

`credentialId` names a `provider` row of `kind = 'git'`, and it is mandatory. `repository.credential_id` is `NOT NULL`, because every repository publishes, and a null would move the failure from registration, where a human is watching, to the first publish three phases later.

It is an id and never a name. A name is renameable, and the conventions make a name a filter rather than a reference. The CLI resolves `--credential <name>` to an id before it calls.

`../phase-1/git-foundation.md` reversed the ambient-credential decision: `isomorphic-git` runs in process, has no ssh transport, no `~/.gitconfig` and no credential helper, so there is nothing ambient to inherit.

### Refused urls

An `ssh://` or `git@host:path` url is `400 invalid-request`, and `details` says the git service has no ssh transport. Plain HTTP is accepted only when the host is a loopback address, where there is no network to encrypt; every other url must be HTTPS, and a plain HTTP url elsewhere is the same `400`.

Both fail schema validation before any network call, which is why neither is an error code of its own.

A forge that refuses the credential is `422 credential-rejected`, with the forge response in `details`. It is not `401`: on this API `401` means the caller's own bearer token failed.

## `repository.show`

Returns the branch fields, the landing tip, the upstream tracking tip, the last fetched upstream object id, `publishOnApproval`, the bound credential — its id and its current name — the repository state, and the profile hash when one is bound.

`fetchedUpstreamOid` is the `U` of the last freshness pass, which is what makes the base of an objective attributable.

P1-E3 asserts the ref layout through this route alone, because the client host cannot read the daemon file system. The response therefore names the landing branch and the tracking namespace explicitly, not as a directory listing.

The state is `ready` or `needs-reconcile`. A `needs-reconcile` response carries both object ids, because `../phase-1/state-machine.md` requires `status` to name them.

## `repository.landingBranch`

The body names the new branch, the object id it starts at, and what happens to work already landed on the old branch. All three are mandatory. A configuration edit cannot do this, because a wrong landing branch sends every later merge to the wrong place and nothing notices.

## `repository.reconcile`

Merges the upstream tip into the landing branch in a scratch workspace, runs the unit check against the resulting merge commit, and lands it with a compare-and-swap. A conflict returns `409` and names the files.

The daemon never repairs a divergence by itself, so no scheduler path reaches this behaviour. A human calls this route.
