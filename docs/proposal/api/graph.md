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

## `plan.validate`

Runs the import validation and writes nothing. It is also the suggestion route of the conflict resolution in `../phase-1/plan-format.md`.

The body is the body of `plan.import` without `importId` and without `choices`. The response holds:

- every validation finding;
- the normalized documents, with provisional identities minted for new nodes, because a choice cannot name a node that has no identity;
- the hash of those normalized documents;
- the topology revision the validation ran against;
- one entry per node of the required choice set: the identity, the suggested choice, the differing field names, the current state for display, and the legality of each choice with its reason.

The identities it mints are provisional in name only: the client sends the same normalized documents to `plan.import`, and the document hash binds the mapping. The daemon stages nothing, so a validation that is never imported leaves no row.

## `plan.import`

The body holds every plan document as a path-and-content pair, plus `fromRevision`, `importId` and `choices`. The human and the daemon share no file system, so the documents travel in the body and no field names a server path. The relative path stays in the body because `depends_on` resolves against it before identities exist.

```json
{
  "fromRevision": null,
  "importId": "import_01JQ8Z7G3H",
  "documents": [{ "path": "plan/…/initiative.md", "content": "---\n…\n" }],
  "choices": [{ "id": "task_01JQ8ZAN9P", "take": "submitted" }],
  "validatedRevision": "revision_01JQ8Z7G3H",
  "documentsHash": "sha256:…"
}
```

`fromRevision` is null on a first import. `documents` is a non-empty array, and its order carries no meaning. A submitted path is a relative POSIX path that starts with `plan/`, ends in `.md`, holds no empty, `.` or `..` segment, and holds no backslash and no NUL. It is compared case-sensitively, and a duplicate path is `422 plan-invalid`. A `depends_on` path resolves against these submitted paths, before any canonical path is assigned. No archive form is accepted: an archive is worse to read in a review and worse to diff.

`choices` carries one entry per node of the union of the document identities and the database identities. A missing entry, an extra entry and a duplicate entry are each `400 invalid-request`. `validatedRevision` and `documentsHash` come from `plan.validate` and bind the choices to what the human actually saw.

The response holds the new revision and the accepted documents, in the canonical layout of `../phase-1/plan-format.md` rather than the submitted paths. The accepted set is the **whole resulting graph**, so it contains database-only nodes that were never in the submission and omits document-only nodes that took `database`. The client replaces its local plan directory with it, and removes every `plan/**/*.md` the response does not name. The daemon writes no file on the client side, and the client writes no file on the daemon side.

### One transaction, and no staging

The daemon holds no plan files, so there is nothing to stage and nothing to rename. Parse, validate, mint, resolve, compare the parent revision, commit and respond, in one database transaction.

The parent comparison runs **inside** the transaction. A client that reads the current revision first and imports second has a race, and one human with two shells is enough to lose it. So `fromRevision` is a field of this request rather than a read the client performs.

A mismatch is `409 stale-revision`, with the current revision in `details`. P1-E1 asserts it. Revisions are prefixed ids such as `revision_01JQ8Z7G3H`.

### `importId`

A crash or a dropped response after the commit leaves the client unable to tell whether the import landed, and the rewritten document exists only in that response. Every import therefore carries a client-minted `importId`, unique per project.

A retry of the same `importId` returns the original revision and the original accepted documents, with `200`. The lookup runs before the `fromRevision` comparison, so a genuine retry is never rejected as stale.

The fingerprint covers the documents, the choices, `fromRevision` and `validatedRevision`. The documents are normalized and sorted by path first, so a reordered array is a retry rather than a mismatch. The same `importId` with a different fingerprint is `409 idempotency-mismatch`. That is a client defect, and returning the first result would hide it.

### Failures

A validation failure is `422 plan-invalid`, and `details` lists every finding. Validation collects every finding rather than stopping at the first, because a human editing by hand wants one round trip. Nothing is written, so the daemon state is unchanged.

A choice set that builds an invalid graph is `422 choices-invalid`, and `details` names the nodes and the graph findings. The daemon never repairs a choice by itself. See `../phase-1/plan-format.md`.

Topology that moved since `plan.validate` is `409 choices-stale`. A selected outcome that is no longer legal against current leases, workspaces, commits or descendants is `409 choices-changed`. Both carry a fresh conflict set, and both write nothing.

A node absent from the import set is not deleted. The response lists it as absent, and the human discards it explicitly through [outcome.md](outcome.md).

## `plan.export`

Returns every document plus the revision it was exported from, in the canonical layout of `../phase-1/plan-format.md`, since a path is cosmetic and the daemon stores none. Export renders from the rows rather than from a stored blob. A client replaces its local copy with what this route returns.

**Export writes no status.** A plan document is the revisioned topology and prose, and nothing else. State moves without a new revision, so a status field would change the bytes of a revision that did not move, and one plan revision must have exactly one byte representation. A human reads state through [system.md](system.md) `system.status`, `node.list` and `node.show`.

Export at a revision is therefore byte-identical to the accepted documents that the import of that revision returned. It is not required to equal what the human submitted, which may lack identities, reference by path, and use noncanonical YAML.

## `plan.revisions`

Returns the import lineage of the project: each revision, its parent, its `importId`, and the hashes of the submitted document, the choice set and the accepted document. The newest revision is the one an import must name in `fromRevision`.

The three are hashes, not content. `blob.show` serves them.

## `node.list`

Filters are `project`, `kind`, `state`, `blockReason` and `repository`. The response holds identity, kind, title, state, block reason, discard reason, the parent, and the dependencies. It never holds the body prose; `node.show` does.

## `node.show`

Adds the instruction and the acceptance criteria as blob hashes, the bound worker, the repository on an objective, and the revision that last wrote the node. A task always carries an acceptance hash, because `re@1` judges against it; an initiative and an objective never do.

`discardReason` is present on a discarded node. It is separate from `blockReason`, and approval evidence lists it for every discarded task.

## `edge.list`

Returns every dependency edge of the project: the edge id, the two node identities, and `waivedAt` when a human waived it.

A waiver is not a deletion. `../database/edge.md` keeps the row and stamps `waived_at`, so the human decision stays readable, and readiness ignores the row. A response that returned only endpoint pairs could not show a waived edge at all.

Containment is not an edge here; a node carries its parent.
