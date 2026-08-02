# Graph

Reviewer: developer experience. Conventions are [README.md](README.md). The decisions are `../phase-1/plan-format.md` and `../phase-1/state-machine.md`.

The DAG: how a plan enters, how it leaves, and how a human reads the topology. Human controls that change a node outcome are [outcome.md](outcome.md).

## Only a human mutates the graph

Through this API, or through export, edit and re-import. No agent route exists here, and no route accepts a state field. The daemon owns state, so a client never writes one.

## Routes

| operationId      | Method and path                       | introducedIn | status | Source                                                 |
| ---------------- | ------------------------------------- | ------------ | ------ | ------------------------------------------------------ |
| `plan.validate`  | `POST /v1/projects/:id/plan/validate` | phase-1      | routed | new decision, see [new-decisions.md](new-decisions.md) |
| `plan.import`    | `POST /v1/projects/:id/plan/import`   | phase-1      | routed | P1-E1, `plan import`                                   |
| `plan.export`    | `GET /v1/projects/:id/plan/export`    | phase-1      | routed | P1-E1, `plan export`                                   |
| `plan.revisions` | `GET /v1/projects/:id/plan/revisions` | phase-1      | routed | plan-format.md, re-import protocol                     |
| `node.list`      | `GET /v1/nodes`                       | phase-1      | routed | P1-E1, `status` lists nodes                            |
| `node.show`      | `GET /v1/nodes/:id`                   | phase-1      | routed | state-machine.md                                       |
| `edge.list`      | `GET /v1/projects/:id/edges`          | phase-1      | routed | plan-format.md, `depends_on`                           |

## `plan.import`

The body holds every plan document as a path-and-content pair, plus `fromRevision` and `importId`. The human and the daemon share no file system, so the documents travel in the body and no field names a server path. The relative path stays in the body because `depends_on` resolves against it before identities exist.

The response holds the new revision and the rewritten documents, with minted identities and `depends_on` rewritten to them. An identity carries its kind prefix, so a `depends_on` entry names the level it points at. The client writes the documents over its own copy. The daemon writes no file on the client side, and the client writes no file on the daemon side.

### One transaction, and no staging

The daemon holds no plan files, so there is nothing to stage and nothing to rename. Parse, validate, mint, resolve, compare the parent revision, commit and respond, in one database transaction.

The parent comparison runs **inside** the transaction. A client that reads the current revision first and imports second has a race, and one human with two shells is enough to lose it. So `fromRevision` is a field of this request rather than a read the client performs.

A mismatch is `409 stale-revision`, with the current revision in `details`. P1-E1 asserts it. Revisions are prefixed ids such as `revision_01JQ8Z7G3H`.

### `importId`

A crash or a dropped response after the commit leaves the client unable to tell whether the import landed, and the rewritten document exists only in that response. Every import therefore carries a client-minted `importId`, unique per project.

A retry of the same `importId` returns the original revision and the original rewritten document, with `200`. The lookup runs before the `fromRevision` comparison, so a genuine retry is never rejected as stale.

The same `importId` with a different document is `409 idempotency-mismatch`. That is a client defect, and returning the first result would hide it.

### Failures

A validation failure is `422 plan-invalid`, and `details` lists every finding. Import stops on the first error and writes nothing, so the daemon state is unchanged.

A node absent from the import set is not deleted. The response lists it as absent, and the human discards it explicitly through [outcome.md](outcome.md).

## `plan.export`

Returns every document plus the revision it was exported from. Export renders from the rows, not from the document the last import accepted, because export adds `status` and status changes after an import. Export also chooses the canonical directory layout, since a path is cosmetic and the daemon stores none. A client replaces its local copy with what this route returns.

Import ignores `status`, so a round trip cannot resurrect or discard a node.

## `plan.revisions`

Returns the import lineage of the project: each revision, its parent, its `importId`, and the hashes of the submitted and the accepted document. The newest revision is the one an import must name in `fromRevision`.

The two documents are hashes, not content. `blob.show` serves them.

## `node.list`

Filters are `project`, `kind`, `state`, `blockReason` and `repository`. The response holds identity, kind, title, state, block reason, discard reason, the parent, and the dependencies. It never holds the body prose; `node.show` does.

## `node.show`

Adds the instruction and the acceptance criteria as blob hashes, the bound worker, the repository on an objective, and the revision that last wrote the node. A task always carries an acceptance hash, because `re@1` judges against it; an initiative and an objective never do.

`discardReason` is present on a discarded node. It is separate from `blockReason`, and approval evidence lists it for every discarded task.

## `edge.list`

Returns every dependency edge of the project: the edge id, the two node identities, and `waivedAt` when a human waived it.

A waiver is not a deletion. `../database/edge.md` keeps the row and stamps `waived_at`, so the human decision stays readable, and readiness ignores the row. A response that returned only endpoint pairs could not show a waived edge at all.

Containment is not an edge here; a node carries its parent.
