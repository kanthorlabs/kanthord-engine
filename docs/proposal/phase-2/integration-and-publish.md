# Integration and publish

Reviewer: git or release engineer. Phase 2. Where code lives is `../phase-1/git-foundation.md`. This file is how it moves.

## Freshness, before every objective clone

The daemon holds the repository lock and runs:

1. `git fetch --prune origin`.
2. Classify `L`, the landing tip, against `U`, the upstream tracking tip, with `git merge-base --is-ancestor`.
3. Record the fetched `U`, so the base of every objective is attributable.

| Relation                  | Meaning                   | Action                                                       |
| ------------------------- | ------------------------- | ------------------------------------------------------------ |
| `L == U`                  | synchronized              | clone                                                        |
| `L` is an ancestor of `U` | upstream advanced         | `refUpdate refs/heads/<landing>` from `L` to `U`, then clone |
| `U` is an ancestor of `L` | local work is unpublished | clone                                                        |
| neither                   | divergence                | refuse the clone                                             |

"Holds unpublished commits" is not a git predicate. The ancestry test is, and it stays correct after a remote force-push.

A divergence moves the repository to `needs-reconcile`. The scheduler creates no new objective clone for that repository, the objective stays `ready`, and `status` names the repository and both object ids. The daemon never repairs a divergence by resetting or force-updating the landing branch.

## Reconciliation is an explicit operation

`kanthord repository reconcile` merges `U` into `L` in a scratch workspace, runs the unit check against the resulting merge commit, and lands it with the compare-and-swap below. A conflict blocks and names the files.

The daemon never merges a divergence by itself. A conflict-free merge is not evidence of a correct result. Such a merge was no objective's frozen candidate, no unit check covered it, and it may combine several unpublished objectives with upstream changes. It is an integration event, and it is gated like one.

## The objective is the integration unit

Tasks contribute commits, normally one commit per task. Only a completed objective integrates to the bare home.

A dependent objective starts from the landing branch. Objective Y depends on objective X. Y stays `pending` until X integrates. A dependency edge therefore forces sequence.

## Delivery is `mr@1`

A completed objective integrates from its `feature/<node id>` branch to `refs/heads/<branch>` of the bare home after human confirmation.

1. Freeze candidate `C`. Run the unit check against `C`. See `gates-and-approval.md`.
2. Take the repository lock. Read the landing tip `B`.
3. When the parent of `C` is `B`, the update is a fast-forward, and the result recorded against `C` stands.
4. Otherwise build merge commit `M` from `B` and `C` in a scratch workspace, and run the unit check against `M`. The tree of `M` is not the tree of `C`, and `M` is what lands.
5. `refUpdate refs/heads/<landing>` from `B` to `M`. See `../phase-1/git-foundation.md` for why that call is a compare-and-swap without `git update-ref`.
6. A failure means `B` moved. Discard `M`, because its first parent is stale, and recompute from step 2.

An object id mismatch is the normal case for an objective that started from an older base, and it causes a recompute, not a block. The objective moves to `blocked` with reason `stale-base` only on a content conflict, or after the retry limit.

## Publish

Publish is a distinct operation with its own API. It carries the object ids it expects, because a bare "push the current tip" publishes something the caller never reviewed.

`POST /repositories/:id/publish` with `landingOid` and `expectedRemoteOid`:

1. Take the repository lock. Assert that `refs/heads/<branch>` equals `landingOid`.
2. Push `<landingOid>` to the remote `refs/heads/<branch>`. Never with force, so the server accepts a fast-forward and rejects anything else. `expectedRemoteOid` is advisory freshness rather than a remote compare-and-swap, and a null value means the ref must not exist yet.

An approval carries `publish: true` by default, and the default is configurable per repository. Chaining keeps the landing branch equal to upstream, which keeps divergence rare, and divergence refuses new objective clones.

A rejection is classified and reported. It is never resolved automatically. A non-fast-forward rejection runs the freshness classification and reports the ancestry. A policy rejection — a protected branch, a required check, a signature rule, a server hook — reports the server message, and the daemon takes no further action. "The server message" is the remote-sent payload of the push report, kept as the daemon received it, with two stated exceptions: a url userinfo is removed, and the payload is bounded, because a secret and an unbounded payload cannot cross the API. The daemon never rewrites the message to explain it, and it never matches on its text to decide a class. Fetching, merging and retrying would turn a publish into an unapproved source integration, and origin can move again immediately after any retry.

A branch protection rule on `<branch>` is not satisfied by landing somewhere else, because there is nowhere else to land: one field names both the landing branch and the publish destination. See the branch field in `../phase-1/git-foundation.md`.

## The integration journal

Git and SQLite cannot share a transaction. The daemon writes a `git_operation` row with intent, base and head object ids before it touches git, and marks the row complete after. Intents are `merge`, `sync`, `publish` and `revert`.

Startup reconciliation of incomplete rows is phase 3. See `../phase-3/recovery.md`.

## Deferred: `pr@1`

The objective clone creates a branch, pushes it to remote origin with an explicit URL, opens a pull request, and watches only for the merged state. CI gates and approval policy belong to the hosting side, and KanthorD does not model them. A merged pull request makes the objective `done`, and the bare home fetches.

This grants the objective-side process network and credential access that no other objective process has. That is a distinct capability boundary, designed when `pr@1` lands.
