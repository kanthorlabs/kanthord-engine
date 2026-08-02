# Gate and delivery

Reviewer: QA lead, and whoever approves merges. Conventions are [README.md](README.md). The decisions are `../phase-2/gates-and-approval.md` and `../phase-2/integration-and-publish.md`.

The routes that move code. They carry the object ids they expect, because every one of them is irreversible from the human's side.

## Routes

| operationId             | Method and path                   | introducedIn | status  | Source                                   |
| ----------------------- | --------------------------------- | ------------ | ------- | ---------------------------------------- |
| `node.approvalEvidence` | `GET /v1/node/:id/approval`       | phase-2      | stubbed | gates-and-approval.md, approval evidence |
| `node.approve`          | `POST /v1/node/:id/approve`       | phase-2      | stubbed | gates-and-approval.md, approval endpoint |
| `repository.publish`    | `POST /v1/repository/:id/publish` | phase-2      | stubbed | integration-and-publish.md, spelled out  |
| `gitOperation.list`     | `GET /v1/git-operation`           | phase-3      | stubbed | recovery.md, the integration journal     |

## `node.approvalEvidence`

Returns the frozen candidate of one objective in `awaiting_approval`:

- the candidate id, its `revision` and its state — `open`, `approved` or `invalidated`,
- the projected outcome, `done` or `partial`,
- the candidate object id, the landing base object id, and the merge object id when one exists,
- the pinned profile hash and the convention version,
- the frozen evidence document, as a blob hash,
- the check results and the attempt history, joined by id.

The evidence document holds the diff, the commit list, and every discarded task with its title and discard reason. It is **frozen at freeze time, not derived at approval time**: a title changes on the next import, and the client cannot open the clone, so a late derivation would answer a different question than the one the human agreed to. `blob.show` serves it.

The check results and the attempt history stay in their own tables and are joined by id, because they are immutable already.

The evidence is a query, so a human reads it as many times as they want. Approval is a separate call.

## `node.approve`

The body carries `candidateRevision`, `acknowledgePartial` and `publish`.

- `candidateRevision` is mandatory, and it is the `revision` of the frozen candidate rather than a plan revision or a prefixed id. Any change to the workspace invalidates the freeze. The response is `409 stale-revision`, and `details` carries `candidateState` and `invalidatedReason`. A revision mismatch and an invalidated candidate are one code, because both tell the human the same thing: read the evidence again.
- `acknowledgePartial` is mandatory when the projection is `partial`. Without it the response is `409 acknowledgement-required` and returns the discarded tasks again. A human never integrates an incomplete objective by accident.
- `publish` defaults to the repository setting, which itself defaults to true.

The approval runs the integration of `../phase-2/integration-and-publish.md`: freeze, check, compare-and-swap, and a second check against a real merge commit when the update is not a fast-forward. **None of those steps is a route.** The compare-and-swap is internal, and a client that could drive it directly could land a tree no check covered.

A content conflict moves the objective to `blocked` with reason `stale-base`, and the response reports it. An object id mismatch on the landing branch is the normal case and causes a recompute, not an error.

## `repository.publish`

The body carries `landingOid` and `expectedRemoteOid`. Both are mandatory. A bare "push the current tip" publishes something the caller never reviewed.

The two are not the same kind of check.

- `landingOid` is a precondition. The daemon asserts the local landing ref equals it, and refuses with `409 stale-revision` otherwise.
- `expectedRemoteOid` is **advisory freshness, not a remote compare-and-swap.** `isomorphic-git` has no `push --force-with-lease`, and publish never forces, so the server arbitrates its own ref transaction. The daemon reads the remote ref, asserts that `landingOid` descends from `expectedRemoteOid`, and predicts a rejection without a round trip. If origin moves inside that window to a commit already an ancestor of `landingOid`, the push succeeds although the expectation was stale, and that is the intended outcome. A null value means the ref must not exist, which is a first publication.

The push is never a force, so an accepted push is a fast-forward and no commit is lost.

A rejection is classified and reported, and nothing is retried:

- a non-fast-forward rejection returns the ancestry classification and both object ids,
- an authentication failure returns `auth-failed`, so a human reads a dead token rather than "push failed",
- a policy rejection — a protected branch, a required check, a signature rule, a server hook — returns the server message verbatim.

The daemon takes no further action on any of them. Fetching, merging and retrying would turn a publish into an unapproved source integration.

Repairing a remote by force is not a daemon capability. It is a human operation with the `git` CLI.

## `gitOperation.list`

The integration journal of every git ref write, local and remote. Filters are `repository`, `intent` and `state`. Intents are `merge`, `sync`, `publish` and `revert`. States are `open`, `complete` and `discarded`.

Each row carries the ref, the base object id, the head object id it proposed, the head object id observed afterwards, the lease fence that authorized the write, the classified outcome — `fast-forward`, `non-fast-forward`, `auth-failed`, `policy-rejected` or `conflict` — and the verbatim git output as a blob hash.

The proposed head and the observed head are separate. A failed compare-and-swap discards a merge commit and a recompute builds a new one, and what the first attempt intended has to survive that.

The journal is an internal mechanism, and it is exposed for one reason: P3-E1 asserts that no incomplete row survives a restart, and the client host cannot open the daemon's SQLite. A human reading a bad day needs the same view.

The route is read-only. No route completes, discards or retries a row. Startup reconciliation owns that, by reading the real ref state, and it reports rather than retries when the observed value matches neither the base nor the proposed head.
