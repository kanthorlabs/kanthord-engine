# Graph

Reviewer: developer experience. Conventions are [README.md](README.md). The decisions are `../phase-1/plan-format.md` and `../phase-1/state-machine.md`.

The DAG: how a plan enters, how it leaves, and how a human reads the topology. Human controls that change a node outcome are [outcome.md](outcome.md).

## Only an actor mutates the graph

Through this API, or through export, edit and re-import. No agent route exists here, and no route accepts a state field. The daemon owns state, so a client never writes one.

## Routes

| operationId      | Method and path                      | introducedIn | status | Source                                                 |
| ---------------- | ------------------------------------ | ------------ | ------ | ------------------------------------------------------ |
| `plan.validate`  | `POST /v1/project/:id/plan/validate` | phase-1      | routed | new decision, see [new-decisions.md](new-decisions.md) |
| `plan.import`    | `POST /v1/project/:id/plan/import`   | phase-1      | routed | P1-E1, `plan import`                                   |
| `plan.export`    | `GET /v1/project/:id/plan/export`    | phase-1      | routed | P1-E1, `plan export`                                   |
| `plan.revisions` | `GET /v1/project/:id/plan/revision`  | phase-1      | routed | plan-format.md, re-import protocol                     |
| `node.list`      | `GET /v1/node`                       | phase-1      | routed | P1-E1, `status` lists nodes                            |
| `node.show`      | `GET /v1/node/:id`                   | phase-1      | routed | state-machine.md                                       |
| `project.nodes`  | `GET /v1/project/:id/node`           | phase-1      | routed | new decision, see [new-decisions.md](new-decisions.md) |
| `project.graph`  | `GET /v1/project/:id/graph`          | phase-1      | routed | new decision, see [new-decisions.md](new-decisions.md) |
| `edge.list`      | `GET /v1/project/:id/edge`           | phase-1      | routed | plan-format.md, `depends_on`                           |
| `node.create`    | `POST /v1/project/:id/node`          | phase-1      | routed | 013-external-drive-overview.md:23                      |
| `node.update`    | `POST /v1/node/:id/update`           | phase-1      | routed | 013-external-drive-overview.md:23                      |
| `node.delete`    | `POST /v1/node/:id/delete`           | phase-1      | routed | 013-external-drive-overview.md:23                      |

## `plan.validate`

Runs the import validation and writes nothing. It is also the suggestion route of the conflict resolution in `../phase-1/plan-format.md`.

The body is the body of `plan.import` without `importId` and without `choices`. The response holds:

- every validation finding;
- the normalized documents, with provisional identities minted for new nodes, because a choice cannot name a node that has no identity;
- the hash of those normalized documents;
- the topology revision the validation ran against;
- one entry per node of the required choice set: the identity, the suggested choice, the differing field names, the current state for display, the canonical path of the submitted document, and the legality of each choice with its reason and the field values of that side.

The identities it mints are provisional in name only: the client sends the same normalized documents to `plan.import`, and the document hash binds the mapping. The daemon stages nothing, so a validation that is never imported leaves no row.

Each choice branch carries `values`, the field values of the side that branch leaves in place. The six names are `body`, `depends_on`, `parent`, `repo`, `title` and `worker`, spelled exactly as they appear in the `fields` array, so a client indexes `values` by a member of `fields` with no mapping table.

**Presence decides which names appear, not `fields`.** A `both` entry carries exactly the names in `fields` on each branch, so two identical sides carry `{}` on both. A `document-only` entry carries all six names under `submitted` and `{}` under `database`. A `database-only` entry is the mirror: all six names under `database` and `{}` under `submitted`. A single-sided entry has an empty `fields` array by construction, so `{}` never means "no value" — it means "nothing to choose".

**An absent key and a present `null` differ.** An absent key means the name is not represented on that branch, either because it is not in `fields` or because that branch holds no node. A key present with `null` means the branch holds a node and that node has no parent, no repository or no worker. `depends_on` is the normalized list the comparison used, sorted and deduplicated, so a client cannot draw a conflict the daemon did not find.

**A `body` value is a pair of blob hashes, never prose.** It is `{ instructionBlob, acceptanceBlob }`, and `acceptanceBlob` is `null` when that side has no acceptance. The two sides resolve their text differently. The `database` hashes were written at import, so `blob.show` serves them. **A submitted hash is not in the blob store**, because `plan.validate` hashes and writes nothing, so `blob.show` cannot serve it; the submitted text is already in the same response, under `documents`. The entry's `path` member is the join key: it is the **canonical** path of the submitted document for a `both` or `document-only` entry, and `null` for a `database-only` entry, which has no document. It is the canonical path and not the authored one, because `documents` is the normalized set, so only the canonical path names a member of it.

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

A document identity that a different project already owns is `422 plan-invalid`, and `details.conflicts` names each identity with its owning project. A node identity belongs to one project for its whole life, so an import never moves it. Nothing is written.

A node absent from the import set is not deleted. The response lists it as absent, and the human discards it explicitly through [outcome.md](outcome.md).

## `plan.export`

Returns every document plus the revision it was exported from, in the canonical layout of `../phase-1/plan-format.md`, since a path is cosmetic and the daemon stores none. Export renders from the rows rather than from a stored blob. A client replaces its local copy with what this route returns.

**Export writes no status.** A plan document is the revisioned topology and prose, and nothing else. State moves without a new revision, so a status field would change the bytes of a revision that did not move, and one plan revision must have exactly one byte representation. A human reads state through [system.md](system.md) `system.status`, `node.list` and `node.show`.

Export at a revision is therefore byte-identical to the accepted documents that the import of that revision returned. It is not required to equal what the human submitted, which may lack identities, reference by path, and use noncanonical YAML.

## `plan.revisions`

Returns the import lineage of the project: each revision, its parent, its `importId`, and the hashes of the submitted document, the choice set and the accepted document. The newest revision is the one an import must name in `fromRevision`.

The three are hashes, not content. `blob.show` serves them.

## `node.list`

The response holds identity, kind, title, state, block reason, discard reason, the parent, and the dependencies. It never holds the body prose; `node.show` does.

**Phase 1 returns every node, ordered by identity, and takes no filter.** The claim that this API has no query-parameter mechanism was false, and it is corrected here. The mechanism exists: `src/http/contract/operation.ts:41` declares an optional `query` schema on every operation, and `event.list` binds `query: eventListRequest` at `src/http/contract/event.ts:69` over the schema declared at `src/http/contract/event.ts:11-17`. `node.list` takes no filter in phase 1 because no epic had declared one, not because the transport cannot carry one. EPIC 018 declares them. `repository.list` is unfiltered by choice rather than by mechanism, and a human filters it client-side.

The filters this route will take are `project`, `kind`, `state`, `blockReason` and `repository`. They are recorded here so the shape is fixed when the mechanism arrives. **`node.list` is the cross-project overview and it filters an unindexed full read.** **`project.nodes` is the per-project read that filters an indexed project range, so a rich filter belongs on the second.**

## `node.show`

Adds the instruction and the acceptance criteria as blob hashes, the bound worker, the repository on an objective, and the revision that last wrote the node. A task always carries an acceptance hash, because `re@1` judges against it; an initiative and an objective never do.

The response also carries the resolved content beside the hashes: `instruction`, `acceptance` and `repo`, the repository **name**. `node.update` replaces the whole editable field set, so a client that changes one field must resend every other one. One `node.show` read therefore fills the whole update body. The hashes stay, because a client that only compares content reads the hash and skips the body.

`discardReason` is present on a discarded node. It is separate from `blockReason`, and approval evidence lists it for every discarded task.

## `edge.list`

Returns every dependency edge of the project: the edge id, the two node identities, and `waivedAt` when a human waived it.

A waiver is not a deletion. `../database/edge.md` keeps the row and stamps `waived_at`, so the human decision stays readable, and readiness ignores the row. A response that returned only endpoint pairs could not show a waived edge at all.

Containment is not an edge here; a node carries its parent. **`project.graph` returns the same edges, with the same `from`-to-`to` direction, inside one consistent snapshot.**

## `project.nodes`

Returns the node list of one project, in the body shape `node.list` already returns. The response carries identity, kind, title, state, block reason, discard reason, the parent, the dependencies, and the project identity. The project identity in the path scopes the read, so a filter on this route runs over an indexed project range rather than a full-table scan.

**Phase 1 returns every node of the project, ordered by identity, and takes no filter.** The filter mechanism of EPIC 018 binds to this route after it lands, and the five filter names (`project`, `kind`, `state`, `blockReason`, `repository`) minus `project` (which the path carries) become SQL predicates over the `node_project` index.

The path `/v1/project/:id/node` is the same rendered path as `node.create`, but `node.create` is `POST` and `project.nodes` is `GET`, so the two operations do not collide.

An unknown project is `404 not-found`. An empty project returns `200` with an empty array.

## `project.graph`

Returns one atomic snapshot of the project topology — every node, every edge, and the topology revision — read in one transaction. The wire shape is `{ attributes, options, nodes, edges }`:

- `attributes` carries `projectId` and `revision`. `revision` is the topology revision from `plan_revision`; it advances on an import and on a node write. Node `state`, `blockReason`, `discardReason` and `waivedAt` move without a new revision, so two responses can carry one `revision` and differ.
- `options` is fixed to `{ allowSelfLoops: false, multi: false, type: "directed" }`.
- `nodes` is an array of `{ key, attributes }` sorted bytewise by `key`. Every node attribute record emits its keys in bytewise-sorted order. The attribute set is exactly `kind`, `title`, `state`, `blockReason`, `discardReason`, `parentId`, `repositoryId`.
- `edges` is an array of `{ key, source, target, attributes }` sorted bytewise by `key`. Every edge attribute record emits its keys in bytewise-sorted order. The attribute set is exactly `relation` (literal `"depends-on"`) and `waivedAt`. `source` is the dependent (`fromNode`) and `target` is the dependency (`toNode`), which is the same direction `edge.list` returns. A topological order of this graph is reverse execution order.

The serialization runs inside `services/graph`, which builds the value through `graphology` and therefore validates it by construction. The daemon rebuilds the exported object in the canonical key order the contract fixes, so a graphology major version that changed its export shape would be a build failure in one file, never a silent `/v1` change.

An unknown project is `404 not-found`. An empty project returns `200` with empty `nodes`, empty `edges`, and `attributes.revision` of `null`.

`project.graph` returns the same edges as `edge.list`, with the same `from`-to-`to` direction, inside one consistent snapshot.

## `node.create`

Creates one node and appends it to the project graph. The body carries `fromRevision`, the project revision the guard compares, and the kind-specific fields: an initiative declares no `parentId` and no `repo`; an objective declares a `parentId` and a `repo`; a task declares a `parentId`, an `acceptance` and no `repo`. The daemon mints the node identity and the revision identity, renders the whole resulting graph, and stores it as the accepted blob. Readiness applies inside the same write.

The response holds the created node, the new project revision as `revision`, and the completeness findings as `completeness`. A completeness finding commits the write and refuses nothing.

A structural finding is `422 plan-invalid`, with every finding in `details`, and the write commits nothing. A mismatch against the newest project revision is `409 stale-revision`. A parent whose ancestor chain holds a node at `done`, `partial` or `discarded` is `409 illegal-transition`, and the message names that ancestor and its state. A child under a closed parent is never startable, so the daemon refuses the child rather than create one that no actor can claim.

## `node.update`

Updates one node. The body replaces the whole editable field set: `title`, `body`, `acceptance`, `parent`, `repo` and `depends_on`. An omitted field is `400 invalid-request`, so the differing-field computation is exact. The body carries `fromRevision`: the node revision for a field-only update, and the project revision for a topology change. A mismatch is `409 stale-revision`, and `details.guard` names the class. A request that changes the stored kind is `400 invalid-request`.

The response holds the new project revision as `revision` and the completeness findings as `completeness`. A completeness finding commits the write and refuses nothing.

`kanthord node update` fills each omitted field from `node.show`, so a human names only what changes. Two fields need an explicit clear, because an omitted option means "keep": `--no-worker` sends `worker: null`, and `--no-depends-on` sends an empty `dependsOn` list. No value string means a clear, so a worker named `none` stays reachable.

A structural finding is `422 plan-invalid`. A structural edit of a node outside `pending`, `ready` and `blocked` is `409 illegal-transition`. A parent change whose new ancestor chain holds a node at `done`, `partial` or `discarded` is `409 illegal-transition`, and the message names that ancestor and its state. The guard reads the new parent only, so an edit of any other field inside a closed subtree stays legal. A parent or `repo` move of a node that is not containment-movable is `409 binding-in-use`, and `details.blockers` lists what blocks it.

## `node.delete`

Deletes one node and its containment subtree, together with every edge touching the subtree. The body carries `fromRevision`, the project revision the guard compares. The response holds the new project revision as `revision`, the deleted identities as `deleted`, and the completeness findings as `completeness`.

A structural finding is `422 plan-invalid`. A subtree node outside `pending`, `ready` and `blocked` is `409 illegal-transition`, and `details.nodes` names each one. A subtree node that an execution row references, or a subtree edge holding `waived_at`, is `409 binding-in-use`, and `details.blockers` lists what blocks it.

Two concurrency classes exist. A field-only update carries the node revision. A create, a topology change and a delete carry the project revision. A mismatch is `409 stale-revision`, and `details.guard` names the class. A structural finding refuses the write with `422 plan-invalid`. It refuses at `plan.import` and at every per-node write. A completeness finding refuses nothing. It travels in the success body under `completeness`. The two completeness codes are `initiative-without-objective` and `objective-without-task`.
