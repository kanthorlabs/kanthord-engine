# New decisions

Reviewer: everyone. Read this before the domain files.

The proposal decided the transport policy and it named most public operations. It did not decide a method, a path, a status code, a version prefix or a paging rule. Everything in this list is therefore new. It is separated from the domain files so that a reviewer argues with the decision rather than discovers it inside a route table.

## Decided here

- **A `/v1` prefix.** The CLI runs on a second machine and can be older than the daemon. The daemon serves one version at a time.
- **Resource plus explicit action.** A command that acts on a resource is `POST /<collection>/:id/<action>`. `unblock`, `waive`, `abandon`, `discard`, `approve`, `publish`, `reconcile` and `rename` are actions. None is a field a client writes.
- **`409` for a precondition.** A stale revision, an illegal transition, a binding in use, a live lease, a divergence and a missing acknowledgement are all `409`, each with its own code, and each returns the current value.
- **`501` for a later phase, `404` for post-MVP.** A route the daemon will implement answers `501 not-implemented` and writes no state. A path that is post-MVP does not exist and answers `404`.
- **One error shape, and the CLI routes on the code.** Block reasons and publish rejection classes are codes.
- **Cursor paging on events.** An offset cannot page an append-only log.
- **`repository.inspect` is a separate route.** Default branch detection writes nothing, and the human confirms in the client. The daemon holds no partial registration.
- **`node.abandon` is one route for a task and an objective.** The node kind decides the behaviour.
- **`plan.validate` exists.** It runs the import validation and writes nothing. A human edits a plan by hand and wants the finding list before a revision moves. It is the only route in this directory with no source line at all, and it is the cheapest to delete if a reviewer disagrees.
- **`worker.list` and `agent.list` are queries.** A client tells a valid `worker` frontmatter value from a rejected one before it imports a plan.
- **`db migrate` does not call HTTP.** It is the one exception to the parity rule of `../phase-1/transport.md`. An unmigrated database stops the daemon from starting, so the route would be unreachable exactly when it is needed. See [system.md](system.md).
- **A blob hash carries its algorithm prefix.** `sha256:<lowercase hex>`, in the column, in every `_blob` field of a response, and in the `blob.show` path. Seven characters buy the visibility the id prefixes buy elsewhere, and a second algorithm becomes a new value rather than a migration of every citing row. See `../database/blob.md`.
- **`blob.show` exists, and large payloads travel as hashes.** Every route returns its small fields inline and a content hash for a prompt, a trace, a diff, a check log, an evidence document or a plan document. One attempt record would otherwise run to megabytes, and a client that wants a verdict would pay for all of it. The route declares its content type, its caching, its `Range` behaviour and its authentication in [system.md](system.md), because a bare "serve the bytes" contract leaves all four undefined.
- **The actor comes from configuration.** `event.actor_id` and `candidate.approved_actor` are stamped from a configured name. No request carries an actor. One token serves one human, so a request-supplied name would be a claim rather than a fact.
- **`node.attempts` scopes to the active run.** `?run=` selects an earlier one. A node holds several task runs after an abandon, and an unscoped route would make P2-E2's "exactly three attempts" untrue the first time a human reran a task.
- **`plan.import` is idempotent by `importId`, and a reuse with a different document is an error.** `409 idempotency-mismatch`. Returning the first result silently would hide a client defect.
- **`system.health` is public and constant.** It needs no bearer token, and it returns `{ "status": "ok" }`. It reads no configuration and no state, so an unauthenticated caller learns only that a daemon answers. The `Origin` rejection and the `Host` allow list still apply. The daemon version and the bind address moved to `system.status`, behind the token.
- **The integration journal is readable.** P3-E1 asserts no incomplete row survives a restart, and the client host cannot open SQLite. The route is read-only.

## Rejected here

- **A precondition token on every mutating route.** A registration has no prior revision. Preconditions are per operation, and the three that carry one are listed in [README.md](README.md).
- **`ETag` and `If-Match` instead of body fields.** The proposal already spells preconditions as body fields, `landingOid` and `expectedRemoteOid`. A CLI reads a body field more easily than a header, and one mechanism beats two.
- **A route for the merge compare-and-swap.** Approval triggers integration. An internal step that uses a compare-and-swap is not a public operation, and a client that could drive it could land a tree no check covered.
- **A lease collection.** A lease is a field of a node and a run. Nothing asks a human to read one directly.
- **A credential route.** The secret is a write-only field of a provider registration. A route that returns it exists only to leak it.
- **A scheduler administration surface.** `run.start` and `run.cancel` are the whole control surface. The daemon runs one worker loop.
- **An invocations subresource.** `agent_invocation` is a table, and invocations nest inside the attempt representation. A normalized schema does not require a normalized route, and a subresource would be a round trip for two rows of hashes.
- **A generic project update, and a generic `bindings/:kind` route.** `project.worker` is a column, and a binding operation may persist to one. One `PATCH /v1/projects/:id` would mix a phase-1 field, a phase-2 field and a post-MVP field under one lifecycle tag, and `bindings/:kind` would leak the storage dispatch key while hiding that a repository set is replaceable and a provider chain is ordered.
- **A `parentRevision` rename.** `plan_revision.parent_id` is a column name. The request field stays `fromRevision`, and only its value type changed.
- **A `candidate-invalidated` code.** It collapses into `stale-revision` with `candidateState` and `invalidatedReason` in `details`. A revision mismatch and an invalidated freeze mean one thing to the human, and two codes would force a client to handle them identically.
- **`auth-failed`, `unsupported-transport` and `insecure-transport` as API codes.** A bad url is `400 invalid-request` with the reason in `details`, because it fails validation before any network call. A forge refusing a token is `422 credential-rejected`, not `401`, because `401` on this API means the caller's own bearer token failed. `auth-failed` stays what `../database/git_operation.md` makes it: a journal outcome.

## Still open

- **The plan document shape in the import body.** A path-and-content pair per file is assumed. A single archive is the alternative, and it is worse to read in a review and worse to diff.
