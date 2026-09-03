# API contract

Reviewer: architect, and every domain owner listed below. Transport policy is `../phase-1/transport.md`. This directory defines the routes that policy carries.

`transport.md` decides the bind address, the bearer token, the browser defences and the payload rule. It names no route. Phase 1 must route every command and query, so the route set is a phase 1 deliverable and it lives here.

## What is normative here, and what is not

These files are the contract at operation level. Each row declares an `operationId`, a method, a path, the precondition the operation carries, the error codes it returns, the phase it starts in, and the proposal file it comes from. A row with no source is a new decision, and it says so.

These files never restate a request or response field schema. The typed route registry in `src/http/contract/` holds every schema on zod, one authored module per domain, and it generates `openapi.yaml`. `npm run verify` asserts that the set of `operationId`, method and path in the registry equals the set declared here. The two artifacts do not overlap, so they cannot drift.

### OpenAPI documents are generated, and they are not committed

The canonical master and each self-contained feature slice use internal `#/components/…` references only. An external `$ref` split is refused for those forms: a generator, a viewer and a publish step each resolve relative file references differently, copying the root alone yields a broken specification, and a consumer bundles it back into one document anyway.

The publication also writes one self-contained document under `features/<namespace>.yaml` for each operation namespace. Each feature document carries its own schemas and references, so a UI client can generate one feature without bundling other files. The master document remains the complete API contract.

Every emitted document holds the transitive closure of its own references, and nothing else. The closure seeds from every root key except `components`, follows a `$ref` that starts with `#/components/schemas/`, follows a nested `$ref` inside a schema body, and follows every value of a `discriminator.mapping` object. A component that no root key reaches is not emitted. A slice therefore drops `#/components/schemas/Error` when every operation of that slice declares its own error envelope.

The generated files are **not committed**, because the reviewable contract change is already the zod module and the table in this directory. A generated diff of expanded schemas is redundant evidence that hides the authored change, and a committed artifact needs a regenerate-and-compare gate that mutates the working tree to check itself.

The root extension `x-kanthord-event-payloads` carries the event payload catalogue. It maps each event type to the component of that type, as one internal `$ref` per entry, and its keys sort bytewise as `components.schemas` does. The extension makes all 37 payload schemas reachable by construction, so the closure rule keeps them.

```yaml
x-kanthord-event-payloads:
  node.created:
    $ref: "#/components/schemas/node.created"
```

A document carries the extension when it holds the operation `event.list`, which is the only route that delivers an event payload. The master carries it and `features/event.yaml` carries it. No other slice carries it, and no other slice holds a payload schema.

`event.list` returns an **unconstrained** payload. The response schema declares the payload as unknown, so the catalogue is advisory to a consumer: it names the shape a consumer can expect per event type, and no emitted document guarantees that shape. A consumer generates its event handlers from the 37 named schemas at its own risk until append-time validation lands.

OpenAPI 3.0.3 is a decision, not an accident. Every contract test pins the `openapi-3.0` mapping of `z.toJSONSchema`. A move to 3.1 changes `nullable`, `exclusiveMinimum` and `examples`, so it costs a fresh parity pass. The version, the artifact topology and the self-contained rule are three independent decisions.

`npm run verify` generates the master document into a temporary directory, validates it with an independent OpenAPI validator, asserts operation parity against the registry, asserts that every reference resolves, and deletes it. `npm run contract:publish -- <output-directory>` publishes the master document, feature documents, examples and the modular `source/` tree. Generation is canonical: fixed path, method and component order, LF endings, one trailing newline. A release publishes the generated documents as a named artifact beside the daemon and the CLI, and a client generator consumes them. Neither the validator nor a client generator ever starts the daemon.

The publication writes two forms of the same contract:

```text
openapi.yaml                    self-contained canonical master
features/<feature>.yaml         self-contained scoped bundles
examples/<operationId>.json     request and response examples
manifest.json                   the publication manifest
source/openapi.yaml             modular root
source/features/<feature>.yaml  operation fragments
source/components/*.yaml        shared schemas and security schemes
```

A consumer that reads `openapi.yaml` sees no change. A consumer that edits, diffs or vendors the
contract reads `source/`, where one schema lives in one place. A `$ref` under `source/` is a relative
path plus a JSON Pointer fragment, and it always resolves to a file inside the publication directory.
`SwaggerParser.bundle` on `source/openapi.yaml` reproduces the master.

### The release gate

A release is a commit that carries the git tag `v<version>`. The `version` field of `package.json` and `KANTHORD_VERSION` in `src/domain/version.ts` hold the same version.

- `npm run contract:publish -- <output-directory>` refuses a dirty working tree. It exits `2` and writes `dirty-tree` to standard error.
- The command refuses a commit that carries no tag `v<version>`. It exits `2` and writes `untagged-commit` to standard error. A commit that carries other tags is untagged for this purpose.
- The dirty refusal comes first. A dirty and untagged tree reports `dirty-tree`.
- `manifest.json` holds `version`, `commit`, `tag`, `source`, `features` and `operations`, in that order. It holds no `dirty` field. `source` is the relative path of the modular root, `source/openapi.yaml`, so a consumer discovers the second form without a guess.
- `--unreleased` skips the tag check and writes `tag: null`. It does not skip the dirty check.
- A client pins an artifact whose `tag` is not `null`. An artifact whose `tag` is `null` is not pinnable.
- The release step is manual. A human bumps `package.json`, bumps `src/domain/version.ts`, commits, writes the tag, then publishes. No workflow does this.

## Domains

One file per domain. A binding route lives in the file of the scope that owns the binding, never in a shared bindings file.

| File                                 | Domain                | Reviewer                     |
| ------------------------------------ | --------------------- | ---------------------------- |
| [actor.md](actor.md)                 | actor                 | platform and security        |
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

Every path starts with `/v1`. The daemon serves one version at a time. **`/v1` is the compatibility contract, and the package version is not.** The package version describes a build, because one repository ships the daemon and the CLI.

Inside `/v1` the daemon may:

- add a response field;
- add a member to an enum;
- add an optional request field;
- add a required request field;
- add an operation.

Inside `/v1` the daemon may never:

- remove or rename a response field;
- change the type of a response field;
- remove a member from an enum;
- change what an error code means, or the status a code maps to.

The list is closed. A change outside it is a `/v2`, and this product has no `/v2`.

**Adding a required request field moved from the second list to the first on 2026-09-03, by a human ruling.** It was forbidden because a client that already sends a valid request starts sending an invalid one, with no signal that anything changed. This product has no deployment and no client the team does not control, so that cost has no bearer, and the rule was buying protection nobody needed against a wire that is still being designed. **The condition is explicit: the item returns to the second list when the first client outside this repository calls `/v1`**, and the epic that admits such a client moves it back. Nothing else about the two lists changed, and a removal of any kind is still forbidden.

**A client must ignore an unknown response field, and it must tolerate an unknown enum member.** A client that refuses either is a client this policy cannot serve.

An older client against a newer daemon always works, so there is no minimum client version and no `mustUpgrade` field. The one real skew is a newer client against an older daemon, and the client asks about it by name: `GET /v1/health` returns `version` and `capabilities`, and a client reads `capabilities` instead of comparing two version strings.

A client sends `X-Kanthord-Client: <version>`. **The daemon never reads that header.** No response body varies by it, no route declares `Vary: X-Kanthord-Client`, and an absent, malformed, prerelease or future-dated value changes nothing. The header is a diagnostic in an operator's log.

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

| Kind        | Meaning                                    | Examples                                                          |
| ----------- | ------------------------------------------ | ----------------------------------------------------------------- |
| resource    | an addressable resource or its collection  | `repository`, `project`, `node`, `event`, `blob`, `provider`      |
| subresource | one value belonging to the preceding scope | `plan`, `profile`, `approval`, `default`, `login`                 |
| action      | an operation on the preceding resource     | `inspect`, `rename`, `reconcile`, `import`, `publish`, `complete` |
| system      | a non-resource daemon segment              | `health`, `db`, `status`                                          |
| parameter   | a locator                                  | `:id`, `:hash`                                                    |

A parameter is a minted prefixed id. `blob/:hash` is the one content-addressed exception, and it is the only one.

**The registry does not accept a free-form path string.** An operation declares a tuple of typed segments, and one renderer turns the tuple into the path. A plural cannot enter through an ordinary route edit, because a new resource noun is a change to the API-owned resource set rather than a string a developer types. `npm run verify` asserts that `/v1` is first and appears once, that each segment is valid in its declared kind, that every parameter declares its identity kind, that only `blob` uses a non-minted locator, that no two installed operations collide on method and rendered path, and that the rendered set equals the tables in this directory.

A closed vocabulary alone would prove spelling and nothing else — it would accept `/v1/project/:id/project` and `/v1/status/status`. The grammar is what makes the rule mean something.

`/v1` is unreleased, so these paths are still free to change. Once it is released, a path spelling is frozen: the CLI runs on a second machine and can be older than the daemon, so renaming a released path is a new API version.

## Command and query

`domain.md` splits `commands/` from `queries/`. The routes follow it.

A query is `GET`. A command that creates a resource is `POST` on the resource. A command that acts on a resource is `POST /<resource>/:id/<action>`. A command that replaces a whole binding is `PUT`.

**Every route answers `200` on success, a creating `POST` included, except a command whose whole result is that the thing is gone: it answers `204` with no body, and `provider.loginCancel` is the only such route.** No route declares `201`. The daemon has one human and one client, the response carries the created resource in full, and no route answers with a bare `Location` header — so a second success status would give a client nothing to branch on. `plan.import` makes the rule load-bearing rather than cosmetic: a retry of a committed `importId` returns the original revision, and that answer cannot be `201` because it created nothing. One success status keeps a retry and a first import indistinguishable, which is what idempotency means here.

`unblock`, `waive`, `abandon`, `discard`, `approve`, `publish`, `reconcile` and `rename` are actions, not resource states. None of them is spelled as a field update, because a state field that a client writes cannot express what the daemon must refuse.

## Preconditions

A precondition is per operation. A registration has no prior revision, so it carries none.

| Operation            | Token it carries    | What the daemon enforces                                                         | Source                                  |
| -------------------- | ------------------- | -------------------------------------------------------------------------------- | --------------------------------------- |
| `plan.import`        | `fromRevision`      | equality against the newest revision, inside the transaction                     | `../phase-1/plan-format.md`             |
| `node.create`        | `fromRevision`      | equality against the newest revision, inside the transaction                     | `graph.md`                              |
| `node.update`        | `fromRevision`      | equality against the node revision, or the newest revision for a topology change | `graph.md`                              |
| `node.delete`        | `fromRevision`      | equality against the newest revision, inside the transaction                     | `graph.md`                              |
| `node.approve`       | `candidateRevision` | equality against the frozen candidate, which must be `open`                      | `../phase-2/gates-and-approval.md`      |
| `repository.publish` | `landingOid`        | equality against the local landing ref                                           | `../phase-2/integration-and-publish.md` |

A mismatch returns `409` and the current value of the token. The client re-reads and retries. The compare-and-swap of the landing branch is internal to integration, and it is not a route.

`repository.publish` carries a fourth mandatory value, `expectedRemoteOid`, and it is **not** a precondition of this kind. `../phase-1/git-foundation.md` calls it advisory freshness: Publish never forces, and the server arbitrates the ref transaction. The daemon asserts that `landingOid` descends from it and predicts a rejection without a round trip, and a stale value that is already an ancestor of `landingOid` still succeeds. A null value means the remote ref must not exist. It is mandatory and it is checked; it is not equality.

## Idempotency

`plan.import` carries a client-minted `importId`. The daemon holds no plan files and the rewritten document travels in the response, so a lost response leaves a client unable to tell a committed import from a rejected one. A retry of the same `importId` returns the original revision and the original document with `200`.

The idempotency lookup runs **before** the `fromRevision` comparison, because a genuine retry must not be rejected as stale.

A reuse of one `importId` with a different submission is a client defect, not a retry. The fingerprint covers the documents, the choice set, `fromRevision` and `validatedRevision`, with the documents normalized and sorted by path so that a reordered array stays a retry. A different fingerprint is `409 idempotency-mismatch`. Returning the first result silently would hide the bug.

### Every other `POST` takes `Idempotency-Key`

A precondition protects a transition from acting twice on stale state. It does not tell a client whether a command it lost the response to actually ran. So a `POST` may carry an `Idempotency-Key` header, and the daemon suppresses a duplicate under that key.

**Idempotency is a policy per operation, declared in the registry**, and it takes one of three values.

| Policy    | Storage                                      | Operations                   |
| --------- | -------------------------------------------- | ---------------------------- |
| `durable` | the database, inside the command transaction | `plan.import` only           |
| `memory`  | a bounded in-process cache, TTL configurable | every other `POST`           |
| `none`    | nothing                                      | every `GET`, `PUT`, `DELETE` |

A single blanket rule was refused. The two mechanisms differ in the properties that matter: `importId` never expires and normalizes the documents before fingerprinting, and it must survive the restart that follows the crash it exists to cover. A memory cache does none of that, so it cannot carry `plan.import`. A supplied `Idempotency-Key` on `plan.import` must equal its `importId`, and a different value is `400 invalid-request`.

Under `memory`: the key is reserved before the command runs, a duplicate arriving while the first is in flight joins it and receives the same answer, a duplicate after completion replays the stored status, body and response headers, and a different fingerprint under the same key is `409 idempotency-mismatch`. A joiner receives the original's answer even when that answer is not retained; releasing joiners to run the command themselves would turn one retry burst into as many concurrent executions.

The cache is bounded, and the join wait is bounded. When every record is in flight at the bound, a new keyed request is `503 service-unavailable` rather than evicting a reservation. When a join outlives its timeout, it is `503` too. Both are answered before the duplicate's own command runs, so the client may send the request again unchanged. **A replayable outcome is declared per operation and never inferred from the status class.** A `409 lease-held` and a `404 not-found` are temporary domain state, and replaying either for the retention window would turn a lease that has since expired into an outage. A command that commits and then fails while writing its response is neither replayable nor safe to re-run, so its key is marked indeterminate and a duplicate receives the same indeterminate answer.

**What this guarantees is bounded, same-process duplicate suppression. It is not exactly-once execution.** A restart empties the cache, a command that reaches a git forge can succeed remotely and fail locally, and a `POST` that outruns the retention window outlives its own record. No document and no message calls a keyed `POST` "safe to retry". EPIC 010.6 holds the design.

The header is not mandatory. A `POST` without one executes as it always did, so the CLI and a human with `curl` are unaffected.

## Large payloads

Every large payload is a `blob`, addressed by its content hash: a rendered prompt, a tool trace, a diff, a check log, a reviewer reason, the approval evidence, a plan document, a profile document and an error detail.

A route returns the small fields inline and the hash of each large one. The client fetches what it needs through `blob.show`. One attempt record holds a rendered prompt, a check log and a diff, three attempts multiply it, and a client that wants only a verdict must not pay megabytes for it. See [system.md](system.md).

## The actor

`event.actor_id` and `candidate.approved_actor` record who decided. The token identifies the actor, and `event.actor_id` records the resolved actor rather than a configured name.

A user model exists. A registered actor is a `human` or a `harness`, and `harness` is the second registered actor kind. `daemon` stays the third actor kind of the event log, and it registers nothing. No request carries an actor field, because a request that names its own actor states a claim rather than a fact: the daemon resolves the actor from the bearer token it authenticated. Every human decision — approve, discard, waive, abandon, unblock — stamps the resolved actor. EPIC 015 lands the enum, the service-interface type and the `CHECK`.

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

| Status | Code                       | Meaning                                                                                           |
| ------ | -------------------------- | ------------------------------------------------------------------------------------------------- |
| 400    | `invalid-request`          | the body failed schema validation                                                                 |
| 401    | `unauthenticated`          | no bearer token, or a wrong one                                                                   |
| 403    | `origin-forbidden`         | the request carried an `Origin` header                                                            |
| 403    | `host-forbidden`           | the `Host` header is outside the allow list                                                       |
| 403    | `actor-forbidden`          | the caller's actor kind is not admitted for the operation                                         |
| 404    | `not-found`                | no such resource, or a `post-mvp` path                                                            |
| 409    | `stale-revision`           | a precondition token no longer matches, or the candidate was invalidated                          |
| 409    | `illegal-transition`       | the node state does not allow the command                                                         |
| 409    | `binding-in-use`           | a removal, a containment move or a delete is refused, and `details.blockers` lists what blocks it |
| 409    | `needs-reconcile`          | the repository diverged, and `details` holds both object ids                                      |
| 409    | `acknowledgement-required` | the projection is `partial` and the request omitted the acknowledgement                           |
| 409    | `lease-held`               | a live lease refuses the operation                                                                |
| 409    | `idempotency-mismatch`     | an `importId` came back with a different document                                                 |
| 409    | `choices-stale`            | topology moved since `plan.validate`, so the required choice set changed                          |
| 409    | `choices-changed`          | a selected outcome is no longer legal against current runtime state                               |
| 409    | `host-key-mismatch`        | the host presented no key matching the confirmed fingerprint                                      |
| 409    | `pair-illegal`             | the node kind and deliverable cannot be claimed together                                          |
| 409    | `assignment-held`          | another worker holds the node assignment                                                          |
| 409    | `unroutable`               | no capable worker is available to claim the node                                                  |
| 409    | `review-head-unavailable`  | the review run has no workspace head to judge                                                     |
| 409    | `objective-busy`           | a sibling task already has an active run                                                          |
| 409    | `subtree-busy`             | an active run already covers the node or its subtree                                              |
| 422    | `plan-invalid`             | the plan failed validation, and `details` lists every finding                                     |
| 422    | `choices-invalid`          | the choice set builds an invalid graph, and `details` names the nodes                             |
| 422    | `identity-kind-mismatch`   | one ULID payload appeared under two kind prefixes                                                 |
| 422    | `credential-rejected`      | the forge refused the credential, and `details` holds its response                                |
| 500    | `internal-error`           | the daemon failed unexpectedly, and the message is a constant                                     |
| 501    | `not-implemented`          | the route ships in a later phase, and it wrote no state                                           |
| 503    | `service-unavailable`      | the daemon declined the work, and it wrote no state                                               |

`stale-revision` covers both ways a frozen candidate stops being approvable. A revision mismatch and a `candidate.state` of `invalidated` mean the same thing to the human — read the evidence again — so they are one code, and `details` carries `candidateState` and `invalidatedReason`. A second code would split one condition into two the client must handle identically.

`internal-error` is the one code this API adds for a fault of its own. An unexpected throw still answers the envelope shape, and its `message` is the constant `internal error` with no `details`, because a caught message is not contract and may name a path, a query or a secret.

`service-unavailable` is the one code that says the daemon refused work it could have done. It is not a fault, and it must not be `internal-error`: the two carry opposite advice. A `500` may follow a command that already committed, so re-running it is unsafe; a `503` is answered before any command runs, so the same request may be sent again unchanged. A client that could not tell them apart would have to treat every `500` as retryable or every `503` as fatal, and both are wrong. Idempotency saturation and a bounded join that timed out are the two conditions that raise it — see [Every other `POST` takes `Idempotency-Key`](#every-other-post-takes-idempotency-key). No other `5xx` exists: the daemon either answers a declared code or it fails.

`host-key-mismatch` is the one code added after the original twenty, and the addition is deliberate. Every other candidate — a block reason, a publish rejection class, a repository state — travels in `details`, because a client needs the shape and not a branch. This one is different: `repository.register` re-scans the host and compares against the fingerprint a human confirmed, and a mismatch may mean the forge rotated its key or may mean something is answering in its place. A client must be able to branch on that without reading `details`, and it must not be told to retry. Reusing `stale-revision` would have said "re-read and try again", which is the wrong reflex for the only condition in phase 1 whose wrong answer has a security consequence. See [repository.md](repository.md).

`credential-rejected` is `422` rather than `401`. A forge refusing a token is a fact about the request payload, and `401` on this API means the caller's own bearer token failed. An `ssh://` url, a `git@host:path` url and plain HTTP on a non-loopback host are all `400 invalid-request` with the reason in `details`, because they fail schema validation before any network call.

Block reasons appear in a node representation as `blockReason`, with the values of `../phase-1/state-machine.md`: `attempt-limit`, `dependency-discarded`, `stale-base`, `dirty-recovery`, `e2e-failed`, `abandoned`. All six, because the `node` table's `CHECK` accepts all six and a response schema that refused one would refuse a row the database holds.

## Security applies to every route

One bearer scheme covers the whole surface, with **no exception**. `../phase-1/transport.md` decides it, and P1-E2 fixes the codes: no token is `401`, a wrong token is `401`, an `Origin` header outside the allow list is `403`, and a `Host` outside the allow list is `403`.

The origin allow list is empty by default, so by default any `Origin` header is `403`. A deployment that names an origin gains a browser client and one anonymous surface: a `CORS` preflight, which a browser sends with no `Authorization` header. The preflight is answered after the `Host` check and before the bearer check, and its answer is a constant that names no route. `../phase-1/transport.md` holds the whole rule and states the disclosure it accepts.

Every route needs the token, `system.health` included. An earlier draft exempted it, on the ground that it returned one constant and therefore revealed nothing. That ground is gone: `system.health` reports the status of every dependency, so it reads state, and an unauthenticated route reveals whatever it returns. A liveness probe that names which subsystem is down is a reconnaissance tool on a private network interface, and the deployment case — a non-loopback bind, where a token is mandatory for every other route — is exactly where it would be read. See [system.md](system.md).

**No route is readable without the token.** An unauthenticated request answers `401` whatever it asks for, and a registered path and an unregistered path answer identically, so the route table is not readable without the token. The cost is that an external monitor must hold the token to probe liveness; the daemon has one token and one human, so that is a configuration line rather than a new mechanism.

A daemon with browser access configured answers one request without a token: the preflight. It names no route and reads no state, and `../phase-1/transport.md` states the disclosure it accepts. A daemon with no configured origin — the default — answers nothing without a token.

The browser defences are a separate control and apply to every route, authenticated or not. The `Host` allow list stops a DNS rebind, which a bearer token does not, because a rebound page carries the victim's credentials by construction. The `Origin` allow list is browser access control, and it is not the rebind defence: a rebound page keeps its own `Host`, and a request with no `Origin` header passes the origin check by design.

## No route names a server path

Every document travels in the body. `plan import` sends its documents, `plan export` returns them, and a profile moves the same way. A path on the daemon file system never appears in a request or a response.

## Identity

Every resource identity is an entity prefix, an underscore and a ULID: `project_01J…`, `repo_01J…`, `task_01J…`. A node takes one prefix per kind, so `initiative_`, `objective_` and `task_` each name their level in a path, in a `depends_on` list and in a log line. See `../database/README.md`.

A path param therefore says what it points at, and a request that names the wrong level is visible without a lookup.

A name is unique where the proposal says so, and it is a query filter, never a path segment, so a rename never changes a URL. A body that references another resource carries its id, never its name, for the same reason.

`blob.show` is the one exception: its path parameter is a content hash rather than a minted id.
