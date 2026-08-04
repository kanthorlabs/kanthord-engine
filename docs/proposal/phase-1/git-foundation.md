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
git init --bare --template= <staging>
git --git-dir=<staging> remote add origin <url>
git --git-dir=<staging> config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
git --git-dir=<staging> fetch origin --prune --no-tags
U=$(git --git-dir=<staging> rev-parse refs/remotes/origin/<upstream>)
git --git-dir=<staging> update-ref refs/heads/<landing> "$U" ''
rename <staging> -> <home>
```

Every command names `--git-dir`. The bare home has no work tree.

**Seeding is built privately and published by a rename.** `<staging>` is a temporary directory beside the target on the same filesystem. Every step above runs against it, and only a complete home is renamed into place. A POSIX rename is atomic, so a bare home either exists and is complete, or does not exist. A failure at any step leaves only a staging directory, which startup removes. Without this, a crash between `init` and the landing write leaves a half-seeded home that the next registration cannot distinguish from a finished one.

A rename gives visibility atomicity, and it does not give durability on its own. The staging contents are flushed, then the parent directory is flushed after the rename, so a home that is visible after a power loss is also complete on disk. The database row that names the home is committed after the directory is durable. A crash between the two leaves a complete home that no row references, which startup removes as an unreferenced staging result; the reverse order would leave a row naming a home that does not exist, which nothing can repair.

`--no-tags` is required. The refspec alone does not confine the namespace, because tag auto-follow writes `refs/tags/*` on a plain fetch. The fetch also writes `FETCH_HEAD`, and it may write `refs/remotes/origin/HEAD`; both are remote observations that the ref-role table already permits. The daemon never depends on `refs/remotes/origin/HEAD` existing, and sets it explicitly with `remote set-head` when it needs it.

The landing object id is read from the tracking ref **after** the fetch, never from the earlier symref detection. The remote can move between detection, human confirmation and fetch, so the confirmed branch _name_ is the human's decision and the object id is an observation of what the fetch actually retrieved. Registration records that exact object id. When the confirmed branch no longer exists after the fetch, registration fails and changes nothing.

The final `update-ref` names an empty expected value, which asserts that the landing branch does not exist yet.

`kanthord repository register --url <remote> --credential <name>` runs this. It detects the default branch from the `HEAD` symref that `git ls-remote --symref <url> HEAD` reports, prints it, and asks the human to confirm. Detection never applies by itself, because a wrong default sends every later merge to the wrong branch and nothing can notice.

## The git service runs the git binary, so the environment is pinned

The git service invokes the `git` binary directly through `node:child_process.spawn`. `spawn` and not `execFile`: `execFile` does not forward `detached` to `spawn`, so a child started that way keeps the parent's process group and the group cancellation below would signal the daemon itself. It uses no git wrapper library. The service has a small, fixed set of operations, and every one of them needs exact control of the argument vector, the environment, the working directory, the timeout and the cancellation. A wrapper that hides those controls, or that copies a credential into an error object, costs more than the parsing it saves.

`git` reads ambient state from many places, and a daemon that inherits any of it is not reproducible. The binary therefore runs under a pinned environment, never an inherited one.

```
PATH                    the resolved directories of the probed binaries, and nothing else
HOME                    a daemon-owned directory, never the operator's
LC_ALL                  C
GIT_CONFIG_GLOBAL       /dev/null
GIT_CONFIG_SYSTEM       /dev/null
GIT_CONFIG_NOSYSTEM     1
GIT_TERMINAL_PROMPT     0
GIT_CONFIG_COUNT        unset
GIT_DIR, GIT_WORK_TREE  unset; every command names --git-dir or -C explicitly
GIT_TRACE and GIT_TRACE*  unset; a trace writes the environment and the url to a file
```

Every invocation also carries `-c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0`, for the reason the ref-write section gives.

Five decisions follow.

- **The `git` binary is a runtime dependency, and so are `ssh` and `ssh-keyscan`.** Startup resolves each to an absolute path, reads its version, and refuses to start when one is absent or older than the supported minimum. Every invocation names the absolute path, because `PATH` holds only the resolved directories and `git` and `ssh` do not always share one. Resolving at startup prevents `PATH` drift; it does **not** pin the executable, because the operating system resolves the pathname on every call and a package upgrade replaces the file underneath a running daemon. The guarantee is therefore the supported version _range_, verified at startup, not an immutable binary. `../open-items.md` recorded that the product shipped no dependency on `git`; that is no longer true, and the supported range is a release artifact.
- **A remote origin url is HTTPS, ssh, or plain HTTP on a loopback host.** HTTPS is the default. Plain HTTP is accepted only when the host is a loopback address, where there is no network to encrypt, and that exception is what lets a scenario serve a fixture remote on `127.0.0.1`. `ssh://` and `git@host:path` are accepted, and both require a credential of the ssh kind. Any other scheme is refused. A refusal is `400 invalid-request` with the reason in `details`, because it fails before any network call.
- **KanthorD stores the git credential, and nothing ambient participates.** A registration of `kind = 'git'` holds the secret encrypted at rest, and `repository.credential_id` names it. An ssh agent and a credential helper are both login-session artifacts that an unattended daemon does not have. The daemon must also actively suppress them: `credential.helper` is multi-valued, so every invocation passes an empty `-c credential.helper=` entry to reset the inherited chain before it names its own helper. Without the empty entry, an operator's system helper still participates. See `../database/provider.md` and `../database/repository.md`.
- **A secret never reaches the argument vector.** An HTTPS token is delivered by a daemon-owned credential helper that reads it from the environment of the `git` child process. `-c http.extraHeader=Authorization: ...` is forbidden, because the argument vector is readable by any process of the same user and is copied verbatim into most error reports. The environment of a child process is a smaller exposure than its argument vector, not a private channel; the threat model covers a same-user observer reading `argv` and a secret reaching a log, and it does not claim secrecy against a same-user observer reading `/proc`.
- **A transport failure is classified into four outcomes, and the credential helper is the evidence for one of them.** `GIT_TERMINAL_PROMPT=0` makes a rejected credential fail instead of prompting. A failed `git` command is classified as `auth-failed` when the helper observed the `erase` that `git` issues on a rejected credential, `permission-denied` when the credential was accepted and the operation was refused, `transport-failed` for a network, proxy or TLS failure, and `unknown` otherwise. The four are distinct because a valid credential without push permission is a different problem for the human than a wrong token, and neither is a broken network. `unknown` exists so that an unclassified failure is visible rather than mislabelled. `git_operation.outcome` records the verdict, so the human reads the cause rather than "push failed".

Only bare home operations authenticate. An objective clone has no configured remote, so no objective-side process ever holds this credential.

**Repository-local configuration is owned, not inherited.** Suppressing the global and system files leaves `<home>/config` active, and it is the one configuration file that survives every pin. The daemon writes it, and it is a closed set: the remote, the fetch refspec, and nothing else. Registration refuses a home whose config carries an `include`, an `includeIf`, an alternate object database, a filter, or a signing directive. A repository the daemon did not create is not adopted.

### ssh carries its own key material

An ssh credential is a private key, and `ssh` imposes two constraints the daemon cannot argue with.

- **The key is an unencrypted file, mode `0600`.** `ssh` refuses a key file that is group or world readable, and it cannot read a key from a file descriptor, so the daemon writes the key into its own directory. Registration refuses an encrypted key. `BatchMode=yes` means `ssh` never asks for a passphrase, and the alternatives — an ephemeral agent, or an `SSH_ASKPASS` helper — add a second secret-bearing process to protect a key that this table already encrypts at rest. The passphrase would be a second envelope over a secret the daemon must decrypt anyway.
- **The key file is created exclusively and swept at startup.** The parent directory is daemon-owned and mode `0700`. The file is created with `O_CREAT | O_EXCL` and mode `0600`, never through a path a symlink can redirect, and it is removed when the operation ends. A `SIGKILL` leaves one behind, so startup removes every key file in that directory before any operation runs, in the same pass that removes stale locks.
- **The host key is pinned at registration, and verified on every connection after that.** `StrictHostKeyChecking=yes` with a `known_hosts` file that the daemon owns. Registration reads the host key with `ssh-keyscan`, prints the fingerprint, and asks the human to confirm it, exactly as they confirm the default branch. `accept-new` is forbidden, because it records whatever answers and never asks. This is trust on first use with a human in the loop: `ssh-keyscan` reads the key over the same unauthenticated network as the connection it is pinning, so an attacker present at registration can be pinned. The human confirmation is the only defence at that moment, and a human who checks the fingerprint against the forge's published value closes the gap. Every later connection is protected: a mismatch fails the operation and reports the stored fingerprint.

The ssh invocation is pinned in the same spirit as the environment, and it names the absolute `ssh`:

```
GIT_SSH_COMMAND = <abs ssh> -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes
                            -o StrictHostKeyChecking=yes
                            -o UserKnownHostsFile=<daemon known_hosts>
                            -o IdentityAgent=none
                            -i <key file>
```

`-F /dev/null` discards the operator's ssh config, `IdentitiesOnly=yes` stops `ssh` from offering any other key it happens to find, and `IdentityAgent=none` stops it from reaching an inherited agent socket. `git` parses this value with shell quoting rules, so a path containing a space or a shell metacharacter must be quoted; the daemon controls every path here and keeps them free of both.

- **Registration proves the credential against the write advertisement.** A push preflight speaks to `git-receive-pack`, which requires push permission. A fetch cannot prove a credential, because a public repository serves reads to anyone and a garbage token reads it exactly like a good one. The preflight proves that the forge accepted the credential for the advertisement, and no more: it does not prove that a protected branch will accept a later push, and a server-side hook can still refuse one.

## The daemon home is a singleton, and that is what makes a local ref write safe

`git update-ref <ref> <new> <old>` is an atomic compare-and-swap, and it is the primitive every local ref write uses. A compare-and-swap answers a concurrent writer inside one repository; it does not answer two daemons owning one home, nor a crash that leaves a lock behind. Three rules cover the rest, and each answers one failure.

**One daemon owns one home.** At startup the daemon takes an exclusive operating-system lock on the daemon home and holds it for the life of the process. A second daemon against the same home refuses to start and names the holder. The kernel releases the lock when the process dies, however it dies, so there is no stale lock to steal and no ownership protocol to get wrong.

The lock is **a held write transaction on a dedicated SQLite database**, `<home>/daemon.lock.db`, used for nothing else. SQLite takes a POSIX `fcntl` record lock underneath, which is the primitive this rule needs, and Node carries it already. The file is dedicated because a lock held on the application database would block the daemon's own writes.

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

`fcntl` locking is unreliable on NFS, SMB and other network filesystems, and SQLite cannot strengthen a filesystem whose locking is unreliable, so a daemon home on one is refused at startup rather than silently unsupported. Two machines sharing a network mount is outside the guarantee.

The refusal reads the filesystem type of the home. Linux reports a filesystem magic number, and the check refuses a home on NFS, SMB, SMB2, FUSE, 9P, CEPH, Lustre, AFS, GFS2 or OCFS2. Darwin reports a kernel table index rather than a magic number, and Node exposes no filesystem name and no mount table, so the type is unreadable there and startup continues. A network home on Darwin is therefore outside the guarantee rather than refused, and the daemon says nothing about it. Reading the type through the `git` binary or a native addon is refused for the same reasons the lock itself refuses them.

The refusal is effective where the platform reports a type. A deployment that needs it enforced runs the daemon on Linux.

A corrupt or truncated `daemon.lock.db` fails startup closed. It is never deleted and never recreated automatically: unlinking the path while another process holds the old inode is how one home becomes two owners. A `daemon.lock.db-journal` left behind by a killed daemon is normal and is **not** cleaned up by hand — the next start rolls it back and acquires.

**Naming the holder is best effort, and refusing is not.** A second daemon names the holder when the holder has published its identity. A holder that dies or stalls between acquiring the lock and publishing leaves a contender that still refuses, and reports the identity as unavailable. Ownership is never ambiguous; only the message is.

This is the rule that makes the rest correct. A lease that expires no longer implies a second writer, because a second writer cannot exist. An expired lease means a stalled task inside the one process that holds the home.

**A ref write is atomic, because git makes it atomic.** A `refUpdate` primitive in the git service wraps one command:

```
git --git-dir=<home> update-ref <ref> <new-oid> <expected-oid>
```

The third argument is the compare of the compare-and-swap. An empty expected value asserts that the ref does not exist. `git` takes its own lock, verifies the old value and renames the loose ref file, and a reader therefore sees the old oid or the new oid and never a partial file. A human running `git` at the same moment collides on that lock. A human running it just before or just after does not collide, and completes normally — the lock serialises overlapping writes, and it is not a claim of ownership.

A mismatch aborts, and the write does not happen. That much is a guarantee.

The **observed** object id is best effort. `git update-ref` has no machine-readable result channel — there is no `--porcelain` — and the only place the competing value appears is the diagnostic `is at <observed> but expected <expected>` on standard error. Reading it is message parsing, which this document forbids for authentication, and the exception is deliberate and narrower: the string is matched by a regular expression under `LC_ALL=C`, it is covered by a test that runs against every supported git version, and a parse failure degrades to "observed unknown" rather than to a wrong object id. Where authentication has a structured alternative, this has none.

The recompute of `../phase-2/integration-and-publish.md` therefore treats the observed object id as a hint for the human and re-reads the ref for its own decision. A value that was correct at the instant of failure can be stale by the time it is read, and no design here can prevent that.

**A crash leaves lock files, and startup is the only place that removes one.** Startup holds the home lock before it touches anything, so a lock file it finds can only be its own predecessor's. Ownership is what makes removal safe; the file name alone never is, because a lock held by a live process is indistinguishable from a stale one by inspection.

`../phase-3/recovery.md` holds the inventory and the removal rules, and it is the authority. This file states only why removal is confined to startup, because that reason belongs to the single-writer argument above.

Holding the home lock is necessary and it is not sufficient. A `git` child is a separate process, and it outlives the daemon that spawned it: the operating system releases the home lock when the daemon dies, while the child keeps running and keeps holding its ref lock. A replacement daemon that reasoned only from the home lock would delete a lock a live `git` still owns. Startup therefore proves the predecessor's children are gone before it removes anything, which is what `../phase-3/recovery.md` calls the reap. Nothing is ever left behind on the weaker reasoning that "a process may hold it", and nothing is removed on the weaker reasoning that "the lock is mine now".

No running operation ever removes a lock it did not create.

The inventory assumes the `files` ref backend, which is what `git init` produces by default. The daemon pins the repository format at creation and refuses a home using another ref backend, because `reftable` stores no `refs/**/*.lock` and that pass would silently do nothing.

**Git runs no hooks and no background maintenance.** A hook is an executable the daemon did not write, and auto-maintenance is background work that outlives the command that started it. Both break the single-writer guarantee this section exists to defend. Every invocation therefore disables them, and a repository the daemon creates is initialised with an empty template directory so no hook is installed in the first place.

```
git -c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0 ...
git init --bare --template= <home>
```

**An unexpected ref value is caught, and an outside writer is not otherwise detectable.** Nothing outside the daemon may write the bare home. That is a contract, not an enforced boundary: the bare home is a directory, and the same operating-system user can write it whatever the daemon believes.

Before a ref write, the daemon compares the current ref against the last completed `git_operation` for that ref, filtered by intent, because `merge` and `sync` name a local ref while `publish` names a remote one. Registration writes the baseline `sync` row, so a ref always has a recorded expectation. A mismatch refuses the operation, writes an event, and reports both object ids. It does not set `needs-reconcile`, which means a landing-to-upstream divergence and nothing else.

What that check is worth, stated plainly:

- It catches the common accident — a human ran `git` in the bare home and moved a ref — and it names the two object ids so the human can see what happened.
- It does **not** catch a writer who moves a ref and restores it, who writes objects without moving a ref, who edits `packed-refs` or the config, or who repacks or prunes.
- It is not a mutual exclusion. An outside writer can act between the check and the command that follows it. The `update-ref` compare-and-swap closes that window for the one ref being written, and closes nothing else.

The check is therefore a diagnostic, and it is not a security boundary. External writes to the bare home are unsupported, and they are only partly detectable. Nothing downstream may treat a passing check as proof that the home was untouched — a recovery path that assumed that would reconcile against an assumption rather than fail safely.

## Publish is never a force, so it needs no lease on a remote ref

`git push --force-with-lease` exists to make a force push safe, and KanthorD never forces. A non-force push is accepted only as a fast-forward, so the previous remote tip stays an ancestor of the new one and no commit is lost. The server performs its own old-value ref transaction, so a movement during negotiation cannot blindly overwrite.

`expected_remote_oid` is therefore **advisory freshness, not a remote compare-and-swap.** The daemon reads it with `git ls-remote`, asserts with `git merge-base --is-ancestor` that the reviewed `landingOid` descends from it, and reports a rejection it can predict without a round trip. If origin moves inside that window to a commit that is already an ancestor of `landingOid`, the push succeeds although the expectation was stale. That is the intended outcome, and it is the reason the column cannot be described as a precondition the transport enforces.

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

The daemon clones from the bare home path, into a staging directory that it renames into place:

```
git clone --no-hardlinks --no-local --branch <landing> <home> <staging>
git -C <staging> remote remove origin
assert  git -C <staging> remote            is empty
assert  <staging>/.git/objects/info/alternates does not exist
assert  no partial-clone or promisor config
rename  <staging> -> <workspace>
```

None of these is a property of cloning.

`--no-hardlinks` is required. A local clone links object files into the workspace by default, so the objective and the bare home would share the same files on disk, and the isolation this section depends on would exist only on paper. The acceptance for it is the link count of the object files, not the contents of the work tree.

The link count is not the whole of isolation. A shared object store can also arrive through `objects/info/alternates` or through a partial-clone promisor, and both would make the workspace depend on the bare home at read time. Each is asserted absent, rather than assumed absent because the daemon did not ask for it.

`clone` configures an `origin` pointing at the source, so the daemon removes it and asserts that the remote list is empty. That assertion is what keeps a credential and a remote out of every objective-side process. The rename is what makes the assertion meaningful: a crash between `clone` and `remote remove` would otherwise publish a workspace that still has an `origin`, which is exactly the invariant this section claims. A visible workspace is therefore always a finished one, and startup removes any staging directory it finds.

## An objective binds exactly one repository

The binding lives on the objective, not the task. Import rejects a task that names a repository. Node-level worker binding stays legal, because the objective runner dispatches each task in sequence inside the one leased workspace.

## Notes for the implementer

- A clone carries no configured remote, so every ref transfer names an explicit path argument.
- Each commit is attributed to a run and an attempt, which is what makes the recovery rules of `../phase-3/recovery.md` decidable.
- The workspace records a base object id per task. `abandon task` depends on it.
- Every `git` invocation carries a timeout and a cancellation path. The child is spawned detached, so it leads its own process group, and cancellation signals the group rather than the process, because a transport child outlives a killed parent otherwise. The sequence is `SIGTERM`, a grace period, then `SIGKILL` to the same group. The daemon signals a group only while it holds that child's handle, so a reused process id is never signalled. This is a POSIX contract; Windows is not a supported daemon platform.
- Standard output and standard error are bounded per operation, and a command that exceeds its bound is killed and fails rather than filling memory. Bounded is not redacted: a failure carries the argument vector and the output, so the error type that leaves the git service carries neither the environment nor the url userinfo.
- A url is validated before it is used, and validation is not only a scheme check. A url carrying embedded credentials is refused, because the secret belongs in the credential and would otherwise reach the config file and the reflog. A url whose host or path begins with `-` is refused, because it would be read as an option. A url carrying a control character or a newline is refused. HTTPS never follows a redirect to plain HTTP, and never to another host.
- Commit identity comes from the pinned environment, never from configuration. `GIT_AUTHOR_*` and `GIT_COMMITTER_*` are set on every invocation that writes an object, so an object id never depends on a file the daemon does not own.
- A fixture repository is built with plumbing under the pinned environment. `core.autocrlf`, the file mode bits and a clean filter each change the bytes that are hashed, so an object id is reproducible only when the environment that produced it is.
