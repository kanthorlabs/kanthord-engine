# repository

**Question it answers:** where does this code live, which branch lands work, and is the repository safe to clone from right now?

```sql
CREATE TABLE repository (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL UNIQUE,
  remote_url            TEXT NOT NULL,                                                -- HTTPS, ssh, or plain HTTP on a loopback host
  credential_id         TEXT NOT NULL REFERENCES provider(id),                        -- the provider row of kind git this repository authenticates with
  home_path             TEXT NOT NULL,                                                -- bare home on disk; the only clone that has an origin
  upstream_branch       TEXT NOT NULL,                                                -- freshness source, observed at refs/remotes/origin/<this>
  landing_branch        TEXT NOT NULL,                                                -- refs/heads/<this>, where mr@1 accumulates approved work
  publish_ref           TEXT NOT NULL,                                                -- destination ref on remote origin that publish pushes to
  publish_on_approval   INTEGER NOT NULL DEFAULT 1,                                   -- 1 chains a publish onto every approval of this repository
  state                 TEXT NOT NULL CHECK (state IN ('ready', 'needs-reconcile')),  -- needs-reconcile refuses every new objective clone
  diverged_landing_oid  TEXT,                                                         -- landing tip at the divergence, which status prints
  diverged_upstream_oid TEXT,                                                         -- upstream tip at the divergence, which status prints
  fetched_upstream_oid  TEXT,                                                         -- U from the last freshness fetch; it attributes an objective base
  updated_at            INTEGER NOT NULL,                                             -- last branch field or state change
  CHECK (
    (state = 'needs-reconcile')
    = (diverged_landing_oid IS NOT NULL AND diverged_upstream_oid IS NOT NULL)
  )
) STRICT;
```

The three branch fields are the three of [git-foundation.md](../phase-1/git-foundation.md). `publish_on_approval` lives here, because [../phase-2/integration-and-publish.md](../phase-2/integration-and-publish.md) makes the chaining default configurable per repository.

`state` is the repository state of [state-machine.md](../phase-1/state-machine.md), not a node block reason. The `CHECK` clause forces `status` to have both object ids to print whenever the state is `needs-reconcile`.

`fetched_upstream_oid` is the `U` recorded by the last freshness pass, which is what makes the base of an objective attributable.

A change to `landing_branch` is an explicit command, not an update of this row alone. It names the object id the new branch starts at, it writes an event, and it reports the work already landed on the old branch.

## How a fetch and a push authenticate

The git service runs the `git` binary, and the daemon suppresses every ambient source it can reach: the operator's `~/.gitconfig` and the system git config, the inherited credential-helper chain, the operator's `~/.ssh/config`, and the ssh agent. Git configuration and ssh configuration are two separate systems, and each is pinned on its own. There is nothing to inherit by design, so the credential is data this row points at. [../phase-1/git-foundation.md](../phase-1/git-foundation.md) holds the environment policy that makes that true.

`credential_id` names a [provider.md](provider.md) row of `kind = 'git'`. It is `NOT NULL`, because every repository publishes. A null would move the failure from `repository register`, where a human is watching, to the first publish after an approval, three phases later.

The transport of `remote_url` selects how that credential is delivered, and the two paths share nothing but the row.

An HTTPS url runs this sequence:

1. Read `credential_id`, decrypt the payload, and parse it with the `git` schema.
2. Invoke `git` with an empty `-c credential.helper=` entry, to reset any inherited chain, followed by the daemon's own helper.
3. The helper answers from the environment of that one child process. The secret never reaches the argument vector, the repository config, or `remote_url`.
4. On a rejection, `GIT_TERMINAL_PROMPT=0` makes the command fail rather than prompt, so a wrong token fails once instead of locking the account. The helper observes the `erase` that `git` issues, which is what classifies the failure as `auth-failed` rather than as a transport error.

An ssh url runs a different one:

1. Read and decrypt the same way.
2. Write the private key to a daemon-owned file, mode `0600`, because `ssh` refuses a more permissive key and cannot read one from a file descriptor.
3. Invoke `git` with a `GIT_SSH_COMMAND` that names that key, pins `StrictHostKeyChecking=yes` against the daemon's `known_hosts`, and disables the agent.
4. Remove the key file when the operation ends. A crash leaves one behind, and startup sweeps it.

One daemon therefore serves repositories on different forges under different accounts, because the credential is selected per repository rather than per daemon. The token never appears in `remote_url`, because a url that embeds a credential reaches every log line and every error message, and registration refuses such a url outright.

`repository register` runs a preflight before it writes this row, and the preflight is a **write** advertisement against `git-receive-pack` via `git push --dry-run`, not a fetch.

A fetch proves nothing about the credential. A public repository serves `git-upload-pack` to anyone, so a garbage token reads 28 refs exactly like a good one. A read preflight would register a dead credential and surface it at the first publish, after a human approved work. The `git-receive-pack` advertisement requires push permission, refuses a wrong token, and returns 401 with no credential, and it changes nothing on the remote.

`git_operation.outcome` carries `auth-failed` as its own value, so a human never reads "push failed" when the answer is a dead token.

## Example

```
id                     repo_01JQ8Z4A2B
name                   kanthord-verify
remote_url             https://github.com/kanthorlabs/kanthord-verify.git
credential_id          provider_01JQ8ZT5V7
home_path              .data/repos/kanthord-verify.git
upstream_branch        main
landing_branch         main
publish_ref            refs/heads/main
publish_on_approval    1
state                  ready
diverged_landing_oid   (null)
diverged_upstream_oid  (null)
fetched_upstream_oid   a3f19c...
```

`kanthord repository register --url https://github.com/... --credential github-bot` seeds the bare home, detects `main` from the remote `HEAD` that `git ls-remote --symref` reports, prints it, and asks the human to confirm before this row is written. Detection never applies by itself, because a wrong default sends every later merge to the wrong branch.

An `ssh://` or `git@host:path` url is accepted, and it requires a credential whose transport is `ssh`. Plain HTTP is accepted only when the host is a loopback address, because there is no network to encrypt there. Every other url must be HTTPS, and any other scheme is refused at registration rather than failing later inside a fetch.

This row is the merge-into-`main` mode: one branch is the freshness source, the landing branch and the publish destination. The branch mode instead sets `landing_branch` to `kanthord/<name>` and leaves `upstream_branch` at `main`.

After a divergence the state becomes `needs-reconcile` and both `diverged_*` columns hold an object id, which is what `status` prints and why the scheduler creates no new clone for this repository.
