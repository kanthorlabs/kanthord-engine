# Recovery

Reviewer: runtime or backend engineer. Phase 3. The states are `../phase-1/state-machine.md`. This file is what happens when execution stops in the middle.

## Attribution, not idempotence

Agent work is attributed, not idempotent. A model call is not repeatable. The invariant is that every side effect is attributed to a run and an attempt, and that recovery detects it. Recovery reads the workspace head, the dirty state of the tree and the lease owner, then resumes or abandons.

Execution is at-least-once. Recovery follows the attribution rule and the integration journal, not an idempotency claim.

## Lease expiry

A `running` node found at startup whose lease has expired: the workspace is clean and its head equals the recorded base, so the task returns to `ready`; otherwise it moves to `blocked` with reason `dirty-recovery`, and the human abandons or inspects.

This replaces the manual stale-lease clearing of phase 2. See `../phase-2/agents-and-workers.md`.

## Startup order

Startup takes the exclusive lock on the daemon home before it reads anything. Everything below runs while holding it, and no operation starts until it finishes.

1. Take the home lock. A second daemon refuses to start and names the holder when it can.
2. Resolve `git`, `ssh` and `ssh-keyscan` from configuration, and refuse to start when one is missing or outside the supported range. The paths come from configuration rather than from an ambient `PATH`, for the reason `../phase-1/git-foundation.md` pins the whole environment.
3. Reap the orphans below. Nothing may be removed before this finishes.
4. Sweep the remnants below.
5. Reconcile the journal below.
6. Recover expired leases.

## The home lock does not prove that git stopped

The daemon owns the home. It does not own the processes it started.

A `git` child is a separate process, and killing the daemon does not kill it. The operating system releases the home lock the moment the daemon dies, while the child keeps running, keeps holding its ref lock and keeps writing. A replacement daemon then acquires the home lock legitimately, and every rule that concludes "this remnant belongs to a dead predecessor" is wrong. Deleting a lock that a live `git` still owns turns a recoverable crash into a corrupted repository.

This is the cost of running git as a subprocess. An in-process library stopped when the daemon stopped, and the home lock alone was proof. It is not proof now, so startup establishes the fact instead of assuming it.

**A spawn is recorded before it happens, and a process id cannot be.** A process id does not exist until the process does, so the thing committed in advance is the path of a pid file, on the in-flight `git_operation` row. The daemon then spawns a launcher rather than `git` directly. The launcher writes its own process id into that path and `exec`s `git`; `exec` keeps the process id, so the recorded value is the git process itself, and the write completes before `git` begins.

That ordering is what makes the record trustworthy. An absent pid file means `git` never started, because the launcher writes before it execs. There is no window in which a git process exists unrecorded.

**Writing before the exec is not enough on its own, because a startup observation must also be final.** A launcher spawned a moment before the daemon died has not reached its write yet. A replacement daemon would find no pid file, conclude that `git` never started, and begin removing remnants while that launcher went on to write its pid file and exec `git`. The launcher therefore waits for one byte from the daemon between the write and the exec, and a launcher whose daemon is gone reads end-of-file and exits without touching anything. A dead daemon can start no new git process, so "no pid file" is a conclusion a later startup may act on.

**The handshake runs in two directions, and the order of the two bytes is what makes it work.** A daemon that sends its byte at spawn time proves nothing: the byte stays in the pipe after the daemon dies, so a launcher delayed before its pid write still reads it and still execs. The launcher therefore reports first. It writes its pid file, then writes one byte on a dedicated descriptor, then closes that descriptor and waits. The daemon sends the release byte only when that report arrives. The release byte is therefore always later than the pid file, so a pid file that does not exist proves no release byte was ever sent, and a dead daemon sends none.

**A spawn before its repository row exists is recorded by the pid file alone.** Registration seeds a bare home before it commits the `repository` row, and the journal row cannot precede it: `repository_id` references that row, and `ref`, `base_oid` and `proposed_head_oid` are not null and are unknown until after the fetch. The pid file is the whole record for such a spawn. It sits in the daemon's own run directory, created at mode `0700` inside a home the daemon holds an exclusive lock on, so every name in that directory is the daemon's own and the reap takes each of them as a candidate. A name that encodes a repository or an operation id adds attribution to the report; it never decides whether a candidate is reaped. Seeding also spawns commands the caller supplies no path for, and those carry a generated name — so a reap that filtered by name would leave a live child holding a staging directory the sweep then removes.

**Startup reaps before it sweeps.** For every in-flight row carrying a token, and for every pid file in the run directory, startup reads the pid file and decides liveness. A pid belongs to this row when it is alive **and** its operating-system start time precedes the creation time of the pid file: a process that reused the number necessarily started after that file existed.

Both times are read at one-second resolution, because `ps -o lstart=` reports whole seconds. A number reused inside the same second as the pid-file write is therefore read as the original child, and the reap signals it. The comparison keeps the safe direction — a real child is never mistaken for a reused number — and the daemon accepts the reverse error, which needs a pid reused within one second of the crash.

| Finding                      | Action                                                                        |
| ---------------------------- | ----------------------------------------------------------------------------- |
| no pid file                  | `git` never started; the remnants of that row are stale                       |
| pid absent, or started later | the child is dead and the number was reused; its remnants are stale           |
| a matching process is alive  | it is an orphan; signal its process group, wait for it to exit, then continue |
| the orphan does not exit     | refuse to start, and name the process and the repository                      |
| liveness cannot be read      | refuse to start; leave the token and the file, and name the process           |

Only after this pass does any removal happen. A daemon that cannot establish the fact refuses to start rather than guessing, because the failure it is guessing about is silent data loss.

## The startup sweep

A crash leaves three kinds of remnant — a git lock file, a staging directory, and decrypted key material — and startup is the only place that removes one. Removal is safe because the reap above established that no predecessor process survives, and because a second daemon cannot exist. No running operation ever removes a remnant it did not create. This table is the authority; `../phase-1/git-foundation.md` states the rules that create these files and defers to it.

| Remnant                                                                             | Action                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `refs/**/*.lock`, `packed-refs.lock`, `HEAD.lock`, `FETCH_HEAD.lock`, `config.lock` | remove; a stale ref lock blocks every later ref write        |
| `shallow.lock`, `gc.pid`, `commit-graph*.lock`, `objects/**/*.lock`                 | remove; no daemon operation is running at startup            |
| `index.lock` in an objective workspace                                              | remove; the workspace is rebuilt from the bare home anyway   |
| a staging directory from an unfinished seed or clone                                | remove; a visible home or workspace is always a finished one |
| an ssh key file in the daemon key directory                                         | remove; a `SIGKILL` leaves decrypted key material on disk    |

Removal is bounded by three checks, and a remnant failing any of them is left alone and reported. It must sit inside a directory the daemon created and records as its own. It must be a regular file, or a directory in the staging case. It must not be, or be reached through, a symbolic link. A sweep that follows a link deletes something outside the home, which is the one mistake this pass must never make.

The ssh key sweep is a confidentiality step rather than an availability one, and it runs before anything else touches the network. `../phase-1/git-foundation.md` holds the rule that creates these files.

The lock list assumes the `files` ref backend. The daemon pins the repository format at creation and refuses a home using another backend, because `reftable` stores no `refs/**/*.lock` and this pass would silently do nothing.

## The integration journal

Intents are `merge`, `sync`, `publish` and `revert`.

The write order is the crash boundary, so it is exact. The daemon commits the `git_operation` row, carrying the intent, the ref, the base and the proposed head object ids, and the pid-file path the launcher will write, **before** it spawns git. It runs the operation. It then durably marks the row complete, clears the token and removes the pid file. A row that exists without a completion is the only signal recovery has, and it is only reliable because it is committed first.

Startup reconciles every incomplete row by reading the real ref state. The ref is read once, and the row is resolved against the reading:

| Observed ref             | `merge`, `sync`, `revert`                                     |
| ------------------------ | ------------------------------------------------------------- |
| equals the proposed head | the operation completed; complete the row                     |
| equals the base          | the operation did not happen; discard the row                 |
| absent                   | discard the row, and report when the base was not null        |
| neither                  | complete nothing; report, and the repository refuses new work |
| unreadable               | refuse to start, and name the repository                      |

`sync` moves tracking refs and writes objects before the landing ref changes, so a discarded `sync` row does not mean the fetch left nothing behind. It means no landing ref moved. Objects and tracking refs are remote observations, and the next fetch reconciles them; the ref-role table is what makes that safe to say.

`revert` reconciles exactly as `merge` does. It moves the landing ref to a recorded object id, and the same three outcomes apply.

`publish` names a remote ref, so its reconcile needs the network and startup does not wait for it. Local rows reconcile at startup, because they read only the disk. A `publish` row is left open and marked for reconcile, and the daemon starts. The repository owning that row refuses new work until the reconcile succeeds, so a remote outage costs one repository rather than the whole daemon. When it runs, the reconcile compares `git ls-remote <url> <publishRef>` against the recorded proposed head. A blind retry is not a recovery procedure, because the push may have succeeded before the crash. A value that matches neither the base nor the proposed head means an outside actor moved the ref, and that is reported rather than retried. An empty answer means the ref is absent, which for a first publication is the recorded base.

Reconciling a local row is subject to the limit `../phase-1/git-foundation.md` states: a ref that matches the recorded head proves the recorded operation is consistent with what is on disk now, and it does not prove the home was untouched. Recovery therefore completes or discards a row, and it never concludes from a matching ref that no outside writer acted.

## Import

Import is one database transaction, because the daemon holds no plan files. A crash before the commit changes nothing, and the client sends the request again. A crash after the commit loses the response, and the client cannot tell whether the import committed. A retry of the same client-minted `import_id` returns the original revision and the original rewritten document, and it never writes a second revision. See `../phase-1/plan-format.md`.

## Divergence with upstream

A landing branch that diverged from upstream moves the repository to `needs-reconcile` and refuses new objective clones. The daemon never repairs it by resetting or force-updating. Reconciliation is an explicit, verified operation. See `../phase-2/integration-and-publish.md`.

## Races

A discard that races a worker is serialized by the objective lease. The eligibility check runs while holding it.
