# Git foundation

Reviewer: git or release engineer. Phase 1. This file defines where code lives. How it moves is `../phase-2/integration-and-publish.md`.

## Three repositories, three roles

- **Remote origin** is the shared repository. Many people work on it through the standard git workflow. It is the source of truth for the team.
- **The bare home** is local to the daemon machine, one per repository, created once. It is the only clone with an `origin`, so it alone fetches from and pushes to remote origin. It is the integration point for agent work.
- **An objective clone** is created per objective from the bare home. It has no configured remote and knows only the bare home.

```
.data/repos/<repo>.git                 bare home, never checked out
.data/workspaces/<objective-id>/       clone, shared by the tasks of that objective
```

## Three ref roles, never blurred

| Role                | Ref                       | Written by                                 | Never written by |
| ------------------- | ------------------------- | ------------------------------------------ | ---------------- |
| Remote observation  | `refs/remotes/origin/*`   | `fetch`, which may force-update            | anything else    |
| Local landing       | `refs/heads/<landing>`    | `mr@1`, reconcile, and a safe fast-forward | `fetch`          |
| Publish destination | the remote `<publishRef>` | `publish`, against an expected object id   | —                |

A remote branch can be force-pushed, so the force flag belongs on remote-tracking refs. It must never reach `refs/heads/*`, where unpublished integrated work lives.

## Seeding the bare home

A bare clone of the remote is forbidden here. It copies remote heads directly into `refs/heads/*`, and a bare repository has no checked-out branch to protect them, so a later fetch or a remote force-push can destroy local integrated work. Seeding is explicit:

```
init({ dir: home, bare: true })
addRemote({ dir: home, remote: 'origin', url })
setConfig({ dir: home, path: 'remote.origin.fetch',
            value: '+refs/heads/*:refs/remotes/origin/*' })
fetch({ dir: home, remote: 'origin', prune: true, onAuth })
writeRef({ dir: home, ref: 'refs/heads/<landing>',
           value: await resolveRef({ ref: 'refs/remotes/origin/<upstream>' }) })
```

`kanthord repository register --url <remote> --credential <name>` runs this. It detects the default branch from the `HEAD` symref that `getRemoteInfo` reports, prints it, and asks the human to confirm. Detection never applies by itself, because a wrong default sends every later merge to the wrong branch and nothing can notice.

## The git service is isomorphic-git, so a credential is stored

`isomorphic-git` runs in process against the file system. It does not shell out, so no `git` binary, no `~/.gitconfig` and no credential helper takes part. Its only transport is HTTP, with Basic authentication supplied by an `onAuth` callback, and no transport reads a local path as a remote.

Three decisions follow.

- **A remote origin url is HTTP or HTTPS.** `ssh://` and `git@host:path` are refused at registration, because the library cannot open them. HTTPS is required, and plain HTTP is accepted only when the host is a loopback address, where there is no network to encrypt. That rule is a product rule with a public reason, not a test exception, and it is what lets a scenario serve a fixture remote on `127.0.0.1`.
- **KanthorD stores the git credential.** A registration of `kind = 'git'` holds a forge, a username and a token, encrypted at rest, and `repository.credential_id` names it. This reverses the earlier decision that git authentication is ambient on the daemon machine. An ssh agent is a login-session artifact that an unattended daemon does not have, and `isomorphic-git` could not use one anyway. See `../database/provider.md` and `../database/repository.md`.
- **An authentication failure fails once.** `onAuthFailure` returns `{ cancel: true }`, so the library throws `UserCanceledError` instead of retrying a credential that the forge already rejected. `git_operation.outcome` records `auth-failed`, so the human reads the cause rather than "push failed".
- **Registration proves the credential against the write advertisement.** `listServerRefs({ forPush: true })` speaks to `git-receive-pack`, which requires push permission. A fetch cannot prove a credential, because a public repository serves reads to anyone and a garbage token reads it exactly like a good one. The write advertisement refuses a wrong token, returns 401 with no credential, and changes nothing on the remote.

Only bare home operations authenticate. An objective clone has no configured remote, so no objective-side process ever holds this token.

## The daemon home is a singleton, and that is what makes a local ref write safe

`git update-ref <ref> <new> <old>` is an atomic compare-and-swap. `writeRef` takes no expected value, and it writes the loose ref file in place, so a crash during the write can leave a truncated ref. The design needs the guarantee back, and it comes from three rules that each answer one failure.

**One daemon owns one home.** At startup the daemon takes an exclusive operating-system lock on the daemon home and holds it for the life of the process. A second daemon against the same home refuses to start and names the holder. The kernel releases the lock when the process dies, however it dies, so there is no stale lock to steal and no ownership protocol to get wrong.

The lock is **a held write transaction on a dedicated SQLite database**, `<home>/daemon.lock.db`, used for nothing else. SQLite takes a POSIX `fcntl` record lock underneath, which is exactly the primitive this rule needs, and it arrives inside Node rather than in an addon this project compiles, prebuilds, versions and maintains.

```
open    <home>/daemon.lock.db, read-write, create if absent, mode 0600
pragma  busy_timeout = 0
pragma  locking_mode = NORMAL
pragma  journal_mode = DELETE
begin   BEGIN IMMEDIATE
hold    the connection, and run no further SQL on it
```

`BEGIN IMMEDIATE` takes a `RESERVED` lock, which excludes a second writer and still admits a reader. SQLite holds it until commit, rollback, connection close or process death. It does not expire, time out or downgrade on its own. `busy_timeout = 0` makes a second daemon fail at once instead of waiting. `locking_mode` stays `NORMAL` because `EXCLUSIVE` would also lock readers out, and `journal_mode` is pinned to `DELETE` because a WAL reader depends on `-wal` and `-shm` availability that this file has no reason to involve.

Only after the lock is held does the daemon publish its identity, to a **separate** file `<home>/daemon.lock.identity`, written to a temporary name and renamed into place:

```json
{
  "version": 1,
  "pid": 16801,
  "host": "devbox",
  "startedAt": "…",
  "instanceId": "…"
}
```

**Identity is diagnostic, never authority.** It is never read to steal, delete or override the lock. Publishing it after acquisition is what makes it truthful: identity committed _before_ the lock can name the loser, because two daemons can both write identity and only then race for the transaction.

A contender that is refused waits briefly for the identity file, reads it, and retries `BEGIN IMMEDIATE` once in case the holder died while it was looking. It then refuses. That retry is the only reason a contender ever touches the lock twice.

Three alternatives were built and run against live processes, and rejected:

- **A lock inside the application database.** `PRAGMA locking_mode = EXCLUSIVE` with a held `BEGIN IMMEDIATE` refuses a second daemon and releases on `SIGKILL`, but it also blocks the daemon's **own** writes — a second connection attempting `BEGIN IMMEDIATE` fails. A lock that deadlocks the application it protects is not a lock. A dedicated file removes this entirely, because the application database is a different file.
- **A unix domain socket** at `<home>/daemon.sock`. It excludes a second daemon and the holder can name itself over the socket, but `SIGKILL` leaves the socket file as a corpse. Reclaiming means unlink then listen, and no portable primitive expresses "replace this path only if it still names the corpse I inspected", so two daemons starting together can both reclaim and both believe they are alone.
- **A native `fcntl` binding.** It is the textbook answer and it was rejected as a product decision: a hand-maintained Node-API addon costs a build toolchain, per-platform prebuilds and a supply-chain surface, and it is a reliability risk of its own. SQLite provides the same kernel primitive with none of that.

`fcntl` locking is unreliable on NFS, SMB and other network filesystems, and SQLite cannot strengthen a filesystem whose locking is unreliable, so a daemon home on one is refused at startup rather than silently unsupported. Two machines sharing a network mount is outside the guarantee.

A corrupt or truncated `daemon.lock.db` fails startup closed. It is never deleted and never recreated automatically: unlinking the path while another process holds the old inode is how one home becomes two owners. A `daemon.lock.db-journal` left behind by a killed daemon is normal and is **not** cleaned up by hand — the next start rolls it back and acquires, which was measured rather than assumed.

**One clause is weakened, and it is named here rather than discovered later.** A second daemon names the holder _when the holder has published its identity_. A holder that dies or stalls between acquiring the lock and publishing leaves a contender that correctly refuses but reports the identity as unavailable. Ownership itself is never ambiguous; only the message is.

This is the rule that makes the rest correct. A lease that expires no longer implies a second writer, because a second writer cannot exist. An expired lease means a stalled task inside the one process that holds the home.

**A ref write is atomic.** A `refUpdate` primitive in the git service replaces `writeRef` for `refs/heads/*`:

```
open    <home>/refs/<name>.lock with O_CREAT | O_EXCL
write   the new oid and a trailing newline, then fsync the file
re-read <home>/refs/<name> and compare it to the expected oid
rename  <home>/refs/<name>.lock -> <home>/refs/<name>
fsync   the directory
```

`O_EXCL` fails rather than truncating anything, so a human running `git` in that directory collides instead of racing. The re-read immediately before the rename is the compare of the compare-and-swap, and a mismatch aborts and returns the observed oid, which drives the recompute of `../phase-2/integration-and-publish.md`. A POSIX rename is atomic, so a reader sees the old oid or the new oid and never a partial file.

**A crash leaves a lock file, and startup is the only place that removes one.** Startup holds the home lock before it touches anything, and it holds it before any operation runs, so a `*.lock` file it finds can only be its own predecessor's. It removes them once, in the same pass that reconciles the journal of `../phase-3/recovery.md`. No running operation ever removes a lock it did not create.

**An outside writer is detected, not assumed away.** Nothing outside the daemon may write the bare home, and that stays a required invariant rather than a hope. Before a ref write, the daemon compares the current ref against the last completed `git_operation` for that ref, filtered by intent, because `merge` and `sync` name a local ref while `publish` names a remote one. Registration writes the baseline `sync` row, so a ref always has a recorded expectation. A mismatch refuses the operation, writes an event, and reports both object ids. It does not set `needs-reconcile`, which means a landing-to-upstream divergence and nothing else.

## Publish is never a force, so it needs no lease on a remote ref

`git push --force-with-lease` exists to make a force push safe, and KanthorD never forces. A non-force push is accepted only as a fast-forward, so the previous remote tip stays an ancestor of the new one and no commit is lost. The server performs its own old-value ref transaction, so a movement during negotiation cannot blindly overwrite.

`expected_remote_oid` is therefore **advisory freshness, not a remote compare-and-swap.** The daemon reads it with `listServerRefs`, asserts with `isDescendent` that the reviewed `landingOid` descends from it, and reports a rejection it can predict without a round trip. If origin moves inside that window to a commit that is already an ancestor of `landingOid`, the push succeeds although the expectation was stale. That is the intended outcome, and it is the reason the column cannot be described as a precondition the transport enforces.

A first publication has no destination ref, so `expected_remote_oid` is null, which means "the ref must not exist". A rejection then says the ref appeared under us.

The one capability genuinely lost is repairing a remote by force. That is a human operation with the `git` CLI, and it is not a daemon capability.

## Three branch fields

A repository declares three, because one field cannot express the branch mode.

| Field            | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `upstreamBranch` | the freshness source, observed at `refs/remotes/origin/<upstreamBranch>`                       |
| `landingBranch`  | `refs/heads/<landingBranch>`, where `mr@1` accumulates approved work and objectives clone from |
| `publishRef`     | the destination ref on remote origin                                                           |

| Mode                               | `upstreamBranch` | `landingBranch`   | `publishRef`                 |
| ---------------------------------- | ---------------- | ----------------- | ---------------------------- |
| Merge into `main`, push `main`     | `main`           | `main`            | `refs/heads/main`            |
| Land on a branch, push that branch | `main`           | `kanthord/<name>` | `refs/heads/kanthord/<name>` |

The branch mode needs the split. `origin/kanthord/<name>` does not exist before the first publish, and objectives still need the latest `origin/main`.

Changing `landingBranch` is an explicit operation, not a configuration edit. It names the object id the new branch starts at, and it states what happens to work already landed on the old branch.

## Clone granularity is the objective

All tasks of one objective share one clone. Tasks in one objective run in sequence, because they share a working tree. One lease covers the whole objective. Concurrency exists between objectives only, and it is deferred past the MVP.

`clone` configures an `origin` pointing at the source. The daemon therefore clones from the bare home path, calls `deleteRemote`, and asserts that `listRemotes` returns an empty array. The removal is an explicit step, not a property of cloning.

## An objective binds exactly one repository

The binding lives on the objective, not the task. Import rejects a task that names a repository. Node-level worker binding stays legal, because the objective runner dispatches each task in sequence inside the one leased workspace.

## Notes for the implementer

- A clone carries no configured remote, so every ref transfer names an explicit path argument.
- Each commit is attributed to a run and an attempt, which is what makes the recovery rules of `../phase-3/recovery.md` decidable.
- The workspace records a base object id per task. `abandon task` depends on it.
