# EPIC 006 — Git primitives

Status: **draft**.

## Goal

The git service runs the `git` binary through `node:child_process.execFile` and holds the primitives of `docs/proposal/phase-1/git-foundation.md`: a pinned invocation, a url policy, an atomic ref write that is a compare-and-swap, a fetch confined to the tracking namespace, an outside-writer diagnostic, and an objective clone that shares nothing with the bare home and carries no remote.

## Non-goals

- No registration. EPIC 007 composes these into the seeding sequence and owns the host-key confirmation flow.
- No startup recovery. EPIC 007.5 owns the reap, the sweep and the journal reconcile.
- No merge, no publish, no reconcile. Those are phase 2.

## Stories

- **The pinned invocation** — one place builds every `git` argument vector and its environment, and no other file spawns a process. It takes already-resolved absolute paths for `git`, `ssh` and `ssh-keyscan` as a dependency and resolves nothing itself, so the same runner serves a test that injects fixture paths and a daemon that probed them at startup. It pins `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_TERMINAL_PROMPT`, `LC_ALL`, an explicit `PATH`, and unsets `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_COUNT` and every `GIT_TRACE*`. It carries `-c core.hooksPath=/dev/null -c maintenance.auto=false -c gc.auto=0`, a timeout, a bounded stdout and stderr, and a cancellation that signals the child's process group. The error it raises carries neither the environment nor the url userinfo. `docs/proposal/phase-1/git-foundation.md` holds the table.
- **Url policy** — HTTPS always; plain HTTP only when the host is a loopback address; `ssh://` and `git@host:path` accepted and bound to an ssh credential. A url carrying a password in its userinfo, a host or path beginning with `-`, a control character, or any other scheme is refused. A userinfo username is not a secret and is not refused, because `git@host:path` is the ordinary ssh spelling. All refusals are decided before any process starts, and each names its reason.
- **Credential delivery** — an HTTPS token reaches `git` through a daemon-owned credential helper reading the child environment, never through the argument vector, and an empty `-c credential.helper=` entry precedes it so an inherited chain is reset. An ssh key is written mode `0600` into a `0700` daemon directory, created with `O_CREAT | O_EXCL`, used through a pinned `GIT_SSH_COMMAND`, and removed when the operation ends. A failure is classified as `auth-failed`, `permission-denied`, `transport-failed` or `unknown`, and the `auth-failed` verdict comes from the helper observing the `erase` rather than from matching a message.
- **The supervised spawn** — the runner never execs `git` directly. It receives a pid-file path, spawns a launcher that writes its own process id there and then `exec`s `git`, and returns the process id it can then signal. `exec` keeps the process id, so the file names the git process, and the write completes before `git` begins. An absent pid file therefore means `git` never started. The launcher is the only place a process is created, and `docs/proposal/phase-3/recovery.md` depends on that being true of every journaled child.
- **`refUpdate`** — `git update-ref <ref> <new> <old>`, where an empty expected value asserts the ref does not exist. A mismatch aborts and the write does not happen. The observed object id is parsed best effort from the failure diagnostic under `LC_ALL=C`, because `update-ref` has no machine-readable result channel, and a parse failure degrades to "observed unknown" rather than to a wrong object id.
- **Fetch confinement** — the refspec `+refs/heads/*:refs/remotes/origin/*`, with prune and `--no-tags`. A fetch never writes `refs/heads/*`, and it writes no `refs/tags/*` even against a tagged remote, because tag auto-follow ignores the refspec. A force-push on the remote force-updates the tracking ref and leaves the landing branch untouched.
- **Outside-writer diagnostic** — before a ref write, compare the current ref against the last completed `git_operation` for that ref, filtered by intent. A mismatch refuses, writes an event, and reports both object ids. It never sets `needs-reconcile`. It is a diagnostic and not a boundary: it catches a human who ran `git` in the bare home, and it does not catch a writer who restores a ref, writes loose objects, or edits `packed-refs`.
- **Objective clone** — `git clone --no-hardlinks --no-local` from the bare home into a staging directory, then remove `origin`, assert the remote list is empty, assert no `objects/info/alternates` and no promisor configuration, then rename the staging directory into place. The acceptance for isolation is the object-file link count, not the contents of the work tree.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/git/**/*.test.ts && echo "PASS EPIC-006"
```

Hermetic coverage required beyond the Proof:

- `refUpdate` against a stale expected oid aborts and reports the observed oid, and the ref file is unchanged.
- `refUpdate` with an empty expected value against an existing ref fails and leaves the ref unchanged.
- A pre-existing `.lock` file makes `refUpdate` fail rather than truncate.
- A force-push on the HTTP fixture remote, then a fetch: the tracking ref moved and `refs/heads/<landing>` did not.
- A fetch against a tagged fixture repository writes no `refs/tags/*`.
- A clone from a bare home yields object files with a link count of one, and the bare home's own object files are unchanged.
- A killed `git` child is signalled by process group, and no descendant survives the cancellation.
- The pid file names the `git` process and not the launcher, proved by reading the process name of the recorded id while the operation runs.
- A fetch and a `refUpdate` through the ssh fixture succeed with a pinned host key, and the fetch fails with a host-key mismatch when the pin is wrong.
- An HTTPS token never appears in the argument vector, in `<home>/config`, or in the message or fields of a raised error, asserted by construction rather than by a substring search over one sample.
- An ssh key file is mode `0600` while the operation runs and is absent after it, including after a thrown failure.
- Every refusal of the url policy is asserted by reason, and a `git@host:path` url is accepted.
