# API contract

Reviewer: architect, and every domain owner listed below. Transport policy is `../phase-1/transport.md`. This directory defines the routes that policy carries.

`transport.md` decides the bind address, the bearer token, the browser defences and the payload rule. It names no route. Phase 1 must route every command and query, so the route set is a phase 1 deliverable and it lives here.

## What is normative here, and what is not

These files are the contract at operation level. Each row declares an `operationId`, a method, a path, the precondition the operation carries, the error codes it returns, the phase it starts in, and the proposal file it comes from. A row with no source is a new decision, and it says so.

These files never restate a request or response field schema. The typed route registry in `src/http/contract/` holds every schema on zod, one authored module per domain, and it generates `openapi.yaml`. `npm run verify` asserts that the set of `operationId`, method and path in the registry equals the set declared here. The two artifacts do not overlap, so they cannot drift.

### `openapi.yaml` is generated, and it is not committed

One self-contained OpenAPI 3.0.3 document, with internal `#/components/…` references only. An external `$ref` split is refused: a generator, a viewer and a publish step each resolve relative file references differently, copying the root alone yields a broken specification, and a consumer bundles it back into one document anyway.

The file is **not committed**, because the reviewable contract change is already the zod module and the table in this directory. A generated diff of expanded schemas is redundant evidence that hides the authored change, and a committed artifact needs a regenerate-and-compare gate that mutates the working tree to check itself.

`npm run verify` generates the document into a temporary directory, validates it with an independent OpenAPI validator, asserts operation parity against the registry, asserts that every reference resolves, and deletes it. Generation is canonical: fixed path, method and component order, LF endings, one trailing newline. A release publishes the generated document as a named artifact beside the daemon and the CLI, and a client generator consumes that artifact. Neither the validator nor a client generator ever starts the daemon.

## Domains

One file per domain. A binding route lives in the file of the scope that owns the binding, never in a shared bindings file.

| File                                 | Domain                | Reviewer                     |
| ------------------------------------ | --------------------- | ---------------------------- |
| [system.md](system.md)               | daemon                | architect                    |
| [credential.md](credential.md)       | global registry       | platform and security        |
| [repository.md](repository.md)       | global git            | git or release engineer      |
| [project.md](project.md)             | project               | architect                    |
| [graph.md](graph.md)                 | DAG                   | developer experience         |
| [outcome.md](outcome.md)             | human controls        | runtime or backend engineer  |
| [execution.md](execution.md)         | worker and run        | runtime or backend engineer  |
| [instruction.md](instruction.md)     | agent and instruction | AI engineer                  |
| [integration.md](integration.md)     | gate and delivery     | QA lead and release engineer |
| [event.md](event.md)                 | event                 | runtime or backend engineer  |
| [new-decisions.md](new-decisions.md) | everything above      | everyone                     |

Read [new-decisions.md](new-decisions.md) before the domain files. It lists every rule below that the proposal did not already decide.

## Versioning

Every path starts with `/v1`. The CLI runs on a second machine, so a client can be older than the daemon. A client sends `X-Kanthord-Client: <version>`, and the daemon reports its own version on `/v1/status`. The daemon serves one version at a time.

## Lifecycle of a row

Each row carries two fields.

| Field          | Values                                      | Meaning                                   |
| -------------- | ------------------------------------------- | ----------------------------------------- |
| `introducedIn` | `phase-1`, `phase-2`, `phase-3`, `post-mvp` | the phase that implements the behaviour   |
| `status`       | `routed`, `stubbed`, `deferred`             | what the route does at the end of phase 1 |

Phase 1 registers every route whose `introducedIn` is `phase-1`, `phase-2` or `phase-3`. A route of a later phase answers `501 not-implemented` and writes no state. A `post-mvp` row has no route at all: it is a matrix entry that records the shape the entity model already holds, and a request to it returns `404`.

The distinction matters at review time. `501` says "this daemon will do it, not yet". `404` says "this daemon does not have this operation".

## Path grammar

**Every resource segment is singular.** `GET /v1/repository` lists repositories, `POST /v1/repository` creates one, and `GET /v1/repository/:id` reads one. Singular describes the spelling, not the cardinality.

A path noun is public contract language. It is deliberately **not** tied to a table name or to an id prefix, and the two would be a bad coupling in both directions: a schema rename would become an API change, and an API naming improvement would become a migration. The counterexample is already in the contract — `repo_01J…` lives at `/v1/repository/:id` and persists in `repository`, and no two of those three words match.

After `/v1`, every literal segment is exactly one of five kinds.

| Kind        | Meaning                                    | Examples                                                     |
| ----------- | ------------------------------------------ | ------------------------------------------------------------ |
| resource    | an addressable resource or its collection  | `repository`, `project`, `node`, `event`, `blob`, `provider` |
| subresource | one value belonging to the preceding scope | `plan`, `profile`, `approval`, `default`, `landing-branch`   |
| action      | an operation on the preceding resource     | `inspect`, `rename`, `reconcile`, `import`, `publish`        |
| system      | a non-resource daemon segment              | `health`, `db`, `status`                                     |
| parameter   | a locator                                  | `:id`, `:hash`                                               |

A parameter is a minted prefixed id. `blob/:hash` is the one content-addressed exception, and it is the only one.

**The registry does not accept a free-form path string.** An operation declares a tuple of typed segments, and one renderer turns the tuple into the path. A plural cannot enter through an ordinary route edit, because a new resource noun is a change to the API-owned resource set rather than a string a developer types. `npm run verify` asserts that `/v1` is first and appears once, that each segment is valid in its declared kind, that every parameter declares its identity kind, that only `blob` uses a non-minted locator, that no two installed operations collide on method and rendered path, and that the rendered set equals the tables in this directory.

A closed vocabulary alone would prove spelling and nothing else — it would accept `/v1/project/:id/project` and `/v1/status/status`. The grammar is what makes the rule mean something.

`/v1` is unreleased, so these paths are still free to change. Once it is released, a path spelling is frozen: the CLI runs on a second machine and can be older than the daemon, so renaming a released path is a new API version.

## Command and query

`domain.md` splits `commands/` from `queries/`. The routes follow it.

A query is `GET`. A command that creates a resource is `POST` on the resource. A command that acts on a resource is `POST /<resource>/:id/<action>`. A command that replaces a whole binding is `PUT`.

`unblock`, `waive`, `abandon`, `discard`, `approve`, `publish`, `reconcile` and `rename` are actions, not resource states. None of them is spelled as a field update, because a state field that a client writes cannot express what the daemon must refuse.

## Preconditions

A precondition is per operation. A registration has no prior revision, so it carries none.

| Operation            | Token it carries    | What the daemon enforces                                     | Source                                  |
| -------------------- | ------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `plan.import`        | `fromRevision`      | equality against the newest revision, inside the transaction | `../phase-1/plan-format.md`             |
| `node.approve`       | `candidateRevision` | equality against the frozen candidate, which must be `open`  | `../phase-2/gates-and-approval.md`      |
| `repository.publish` | `landingOid`        | equality against the local landing ref                       | `../phase-2/integration-and-publish.md` |

A mismatch returns `409` and the current value of the token. The client re-reads and retries. The compare-and-swap of the landing branch is internal to integration, and it is not a route.

`repository.publish` carries a fourth mandatory value, `expectedRemoteOid`, and it is **not** a precondition of this kind. `../phase-1/git-foundation.md` calls it advisory freshness: Publish never forces, and the server arbitrates the ref transaction. The daemon asserts that `landingOid` descends from it and predicts a rejection without a round trip, and a stale value that is already an ancestor of `landingOid` still succeeds. A null value means the remote ref must not exist. It is mandatory and it is checked; it is not equality.

## Idempotency

`plan.import` carries a client-minted `importId`. The daemon holds no plan files and the rewritten document travels in the response, so a lost response leaves a client unable to tell a committed import from a rejected one. A retry of the same `importId` returns the original revision and the original document with `200`.

The idempotency lookup runs **before** the `fromRevision` comparison, because a genuine retry must not be rejected as stale.

A reuse of one `importId` with a different submission is a client defect, not a retry. The fingerprint covers the documents, the choice set, `fromRevision` and `validatedRevision`, with the documents normalized and sorted by path so that a reordered array stays a retry. A different fingerprint is `409 idempotency-mismatch`. Returning the first result silently would hide the bug.

No other route is idempotent by key. Every other command is either a query, or a transition that a precondition already protects.

## Large payloads

Every large payload is a `blob`, addressed by its content hash: a rendered prompt, a tool trace, a diff, a check log, a reviewer reason, the approval evidence, a plan document, a profile document and an error detail.

A route returns the small fields inline and the hash of each large one. The client fetches what it needs through `blob.show`. One attempt record holds a rendered prompt, a check log and a diff, three attempts multiply it, and a client that wants only a verdict must not pay megabytes for it. See [system.md](system.md).

## The actor

`event.actor_id` and `candidate.approved_actor` record who decided. The daemon reads that name from configuration, and no request carries it.

There is no user model, and one token serves one human, so an actor field on a request would be a claim rather than a fact. Every human decision — approve, discard, waive, abandon, unblock — stamps the configured name.

## Errors

Every error is one shape.

```json
{
  "error": {
    "code": "stale-revision",
    "message": "the plan was exported from revision_01JQ8Z7G3H, and the project is at revision_01JQ8ZR9S1",
    "details": {
      "expected": "revision_01JQ8Z7G3H",
      "actual": "revision_01JQ8ZR9S1"
    }
  }
}
```

The CLI routes on `code` and never parses `message`. A block reason, a publish rejection class and a repository state are codes.

| Status | Code                       | Meaning                                                                  |
| ------ | -------------------------- | ------------------------------------------------------------------------ |
| 400    | `invalid-request`          | the body failed schema validation                                        |
| 401    | `unauthenticated`          | no bearer token, or a wrong one                                          |
| 403    | `origin-forbidden`         | the request carried an `Origin` header                                   |
| 403    | `host-forbidden`           | the `Host` header is outside the allow list                              |
| 404    | `not-found`                | no such resource, or a `post-mvp` path                                   |
| 409    | `stale-revision`           | a precondition token no longer matches, or the candidate was invalidated |
| 409    | `illegal-transition`       | the node state does not allow the command                                |
| 409    | `binding-in-use`           | a removal is refused, and `details` lists what blocks it                 |
| 409    | `needs-reconcile`          | the repository diverged, and `details` holds both object ids             |
| 409    | `acknowledgement-required` | the projection is `partial` and the request omitted the acknowledgement  |
| 409    | `lease-held`               | a live lease refuses the operation                                       |
| 409    | `idempotency-mismatch`     | an `importId` came back with a different document                        |
| 409    | `choices-stale`            | topology moved since `plan.validate`, so the required choice set changed |
| 409    | `choices-changed`          | a selected outcome is no longer legal against current runtime state      |
| 409    | `host-key-mismatch`        | the host presented no key matching the confirmed fingerprint             |
| 422    | `plan-invalid`             | the plan failed validation, and `details` lists every finding            |
| 422    | `choices-invalid`          | the choice set builds an invalid graph, and `details` names the nodes    |
| 422    | `identity-kind-mismatch`   | one ULID payload appeared under two kind prefixes                        |
| 422    | `credential-rejected`      | the forge refused the credential, and `details` holds its response       |
| 500    | `internal-error`           | the daemon failed unexpectedly, and the message is a constant            |
| 501    | `not-implemented`          | the route ships in a later phase, and it wrote no state                  |

`stale-revision` covers both ways a frozen candidate stops being approvable. A revision mismatch and a `candidate.state` of `invalidated` mean the same thing to the human — read the evidence again — so they are one code, and `details` carries `candidateState` and `invalidatedReason`. A second code would split one condition into two the client must handle identically.

`internal-error` is the one code this API adds for a fault of its own. An unexpected throw still answers the envelope shape, and its `message` is the constant `internal error` with no `details`, because a caught message is not contract and may name a path, a query or a secret. Every other `5xx` is absent by design: the daemon either answers a declared code or it fails.

`host-key-mismatch` is the one code added after the original twenty, and the addition is deliberate. Every other candidate — a block reason, a publish rejection class, a repository state — travels in `details`, because a client needs the shape and not a branch. This one is different: `repository.register` re-scans the host and compares against the fingerprint a human confirmed, and a mismatch may mean the forge rotated its key or may mean something is answering in its place. A client must be able to branch on that without reading `details`, and it must not be told to retry. Reusing `stale-revision` would have said "re-read and try again", which is the wrong reflex for the only condition in phase 1 whose wrong answer has a security consequence. See [repository.md](repository.md).

`credential-rejected` is `422` rather than `401`. A forge refusing a token is a fact about the request payload, and `401` on this API means the caller's own bearer token failed. An `ssh://` url, a `git@host:path` url and plain HTTP on a non-loopback host are all `400 invalid-request` with the reason in `details`, because they fail schema validation before any network call.

Block reasons appear in a node representation as `blockReason`, with the values of `../phase-1/state-machine.md`: `attempt-limit`, `dependency-discarded`, `stale-base`, `dirty-recovery`, `e2e-failed`.

## Security applies to every route

One bearer scheme covers the whole surface, with **no exception**. `../phase-1/transport.md` decides it, and P1-E2 fixes the codes: no token is `401`, a wrong token is `401`, an `Origin` header is `403`, and a `Host` outside the allow list is `403`.

Every route needs the token, `system.health` included. An earlier draft exempted it, on the ground that it returned one constant and therefore revealed nothing. That ground is gone: `system.health` reports the status of every dependency, so it reads state, and an unauthenticated route reveals whatever it returns. A liveness probe that names which subsystem is down is a reconnaissance tool on a private network interface, and the deployment case — a non-loopback bind, where a token is mandatory for every other route — is exactly where it would be read. See [system.md](system.md).

**The daemon therefore has no anonymous surface.** An unauthenticated request answers `401` whatever it asks for, and a registered path and an unregistered path answer identically, so the route table is not readable without the token. The cost is that an external monitor must hold the token to probe liveness; the daemon has one token and one human, so that is a configuration line rather than a new mechanism.

The browser defences are a separate control and apply to every route, authenticated or not. The `Origin` rejection and the `Host` allow list stop a browser page and a DNS rebind, which a bearer token does not — a rebound page carries the victim's credentials by construction.

## No route names a server path

Every document travels in the body. `plan import` sends its documents, `plan export` returns them, and a profile moves the same way. A path on the daemon file system never appears in a request or a response.

## Identity

Every resource identity is an entity prefix, an underscore and a ULID: `project_01J…`, `repo_01J…`, `task_01J…`. A node takes one prefix per kind, so `initiative_`, `objective_` and `task_` each name their level in a path, in a `depends_on` list and in a log line. See `../database/README.md`.

A path param therefore says what it points at, and a request that names the wrong level is visible without a lookup.

A name is unique where the proposal says so, and it is a query filter, never a path segment, so a rename never changes a URL. A body that references another resource carries its id, never its name, for the same reason.

`blob.show` is the one exception: its path parameter is a content hash rather than a minted id.
