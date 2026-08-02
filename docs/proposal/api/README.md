# API contract

Reviewer: architect, and every domain owner listed below. Transport policy is `../phase-1/transport.md`. This directory defines the routes that policy carries.

`transport.md` decides the bind address, the bearer token, the browser defences and the payload rule. It names no route. Phase 1 must route every command and query, so the route set is a phase 1 deliverable and it lives here.

## What is normative here, and what is not

These files are the contract at operation level. Each row declares an `operationId`, a method, a path, the precondition the operation carries, the error codes it returns, the phase it starts in, and the proposal file it comes from. A row with no source is a new decision, and it says so.

These files never restate a request or response field schema. The typed route registry in `src/http/` holds every schema on zod, and it generates `openapi.yaml`. `npm run verify` asserts that the set of `operationId`, method and path in the registry equals the set declared here. The two artifacts do not overlap, so they cannot drift.

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

## Command and query

`domain.md` splits `commands/` from `queries/`. The routes follow it.

A query is `GET`. A command that creates a resource is `POST` on the collection. A command that acts on a resource is `POST /<collection>/:id/<action>`. A command that replaces a whole binding is `PUT`.

`unblock`, `waive`, `abandon`, `discard`, `approve`, `publish`, `reconcile` and `rename` are actions, not resource states. None of them is spelled as a field update, because a state field that a client writes cannot express what the daemon must refuse.

## Preconditions

A precondition is per operation. A registration has no prior revision, so it carries none.

| Operation            | Token it carries    | What the daemon enforces                                     | Source                                  |
| -------------------- | ------------------- | ------------------------------------------------------------ | --------------------------------------- |
| `plan.import`        | `fromRevision`      | equality against the newest revision, inside the transaction | `../phase-1/plan-format.md`             |
| `node.approve`       | `candidateRevision` | equality against the frozen candidate, which must be `open`  | `../phase-2/gates-and-approval.md`      |
| `repository.publish` | `landingOid`        | equality against the local landing ref                       | `../phase-2/integration-and-publish.md` |

A mismatch returns `409` and the current value of the token. The client re-reads and retries. The compare-and-swap of the landing branch is internal to integration, and it is not a route.

`repository.publish` carries a fourth mandatory value, `expectedRemoteOid`, and it is **not** a precondition of this kind. `../phase-1/git-foundation.md` calls it advisory freshness: `isomorphic-git` has no `push --force-with-lease`, publish never forces, and the server arbitrates the ref transaction. The daemon asserts that `landingOid` descends from it and predicts a rejection without a round trip, and a stale value that is already an ancestor of `landingOid` still succeeds. A null value means the remote ref must not exist. It is mandatory and it is checked; it is not equality.

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
| 422    | `plan-invalid`             | the plan failed validation, and `details` lists every finding            |
| 422    | `choices-invalid`          | the choice set builds an invalid graph, and `details` names the nodes    |
| 422    | `identity-kind-mismatch`   | one ULID payload appeared under two kind prefixes                        |
| 422    | `credential-rejected`      | the forge refused the credential, and `details` holds its response       |
| 501    | `not-implemented`          | the route ships in a later phase, and it wrote no state                  |

`stale-revision` covers both ways a frozen candidate stops being approvable. A revision mismatch and a `candidate.state` of `invalidated` mean the same thing to the human — read the evidence again — so they are one code, and `details` carries `candidateState` and `invalidatedReason`. A second code would split one condition into two the client must handle identically.

`credential-rejected` is `422` rather than `401`. A forge refusing a token is a fact about the request payload, and `401` on this API means the caller's own bearer token failed. An `ssh://` url, a `git@host:path` url and plain HTTP on a non-loopback host are all `400 invalid-request` with the reason in `details`, because they fail schema validation before any network call.

Block reasons appear in a node representation as `blockReason`, with the values of `../phase-1/state-machine.md`: `attempt-limit`, `dependency-discarded`, `stale-base`, `dirty-recovery`, `e2e-failed`.

## Security applies to every route

One bearer scheme covers the whole surface. `../phase-1/transport.md` decides it, and P1-E2 fixes the codes: no token is `401`, a wrong token is `401`, an `Origin` header is `403`, and a `Host` outside the allow list is `403`.

`system.health` is the one route with no bearer scheme. It returns a constant and reads nothing, so it reveals nothing. The browser defences still apply to it: authentication and the `Origin` and `Host` checks are separate controls, and a route exempt from the second would reopen the DNS rebind path. See [system.md](system.md).

## No route names a server path

Every document travels in the body. `plan import` sends its documents, `plan export` returns them, and a profile moves the same way. A path on the daemon file system never appears in a request or a response.

## Identity

Every resource identity is an entity prefix, an underscore and a ULID: `project_01J…`, `repo_01J…`, `task_01J…`. A node takes one prefix per kind, so `initiative_`, `objective_` and `task_` each name their level in a path, in a `depends_on` list and in a log line. See `../database/README.md`.

A path param therefore says what it points at, and a request that names the wrong level is visible without a lookup.

A name is unique where the proposal says so, and it is a query filter, never a path segment, so a rename never changes a URL. A body that references another resource carries its id, never its name, for the same reason.

`blob.show` is the one exception: its path parameter is a content hash rather than a minted id.
