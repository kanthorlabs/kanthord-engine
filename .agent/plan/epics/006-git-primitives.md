# EPIC 006 — Git primitives

Status: **draft**.

## Goal

The git service on `isomorphic-git` holds the primitives of `docs/proposal/phase-1/git-foundation.md`: a url policy, an atomic ref write with a compare-and-swap, a fetch confined to the tracking namespace, an outside-writer detection, and an objective clone that carries no remote.

## Non-goals

- No registration. EPIC 007 composes these into the seeding sequence.
- No merge, no publish, no reconcile. Those are phase 2.

## Stories

- **Url policy** — HTTPS always; plain HTTP only when the host is a loopback address; `ssh://` and `git@host:path` refused. All are `400 invalid-request` with the reason in `details`, because they fail before any network call.
- **`refUpdate`** — open `<home>/refs/<name>.lock` with `O_CREAT | O_EXCL`, write the oid and a newline, fsync, re-read the ref and compare it to the expected oid, rename, fsync the directory. A mismatch aborts and returns the observed oid.
- **Fetch confinement** — the refspec `+refs/heads/*:refs/remotes/origin/*`, with prune. A fetch never writes `refs/heads/*`, and a force-push on the remote force-updates the tracking ref and leaves the landing branch untouched.
- **`git_operation` journaling and outside-writer detection** — before a ref write, compare the current ref against the last completed operation for that ref, filtered by intent. A mismatch refuses, writes an event, and reports both object ids. It never sets `needs-reconcile`.
- **Objective clone** — clone from the bare home path, call `deleteRemote`, and assert that `listRemotes` returns an empty array. The removal is an explicit step, and a surviving remote fails the run.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/services/git/**/*.test.ts && echo "PASS EPIC-006"
```

Hermetic coverage required beyond the Proof:

- `refUpdate` against a stale expected oid aborts and returns the observed oid, and the ref file is unchanged.
- A pre-existing `.lock` file makes `refUpdate` fail rather than truncate.
- A force-push on the fixture remote, then a fetch: the tracking ref moved and `refs/heads/<landing>` did not.
