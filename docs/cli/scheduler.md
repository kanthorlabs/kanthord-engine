# Scheduler CLI specification

This is the proposed `kanthord scheduler` command surface for engine
contributors. See the [CLI index](./README.md) and
[shared conventions](./other.md). The contracts below are self-contained;
provenance links at the end provide design context.

## Status and ownership

**Implemented, inspected 2026-09-23:** the Scheduler group prints help and
accepts `--endpoint`. It has no service subcommands. The
[CLI dispatcher](../../src/apps/cli/index.ts) creates that placeholder; the
[server composition](../../src/apps/server/index.ts) constructs Project,
Worker and Gateway only. There is no Scheduler source directory, operation
declaration, migration or generated Scheduler OpenAPI document.

**Proposed:** every command, operation identifier, route, request field and
response shape below, except the existing group help. These are candidates for
the future Scheduler implementation contract and OpenAPI, not callable APIs.
The ownership and admission requirements stated here come from the service
design. Open recovery decisions remain open, even where a candidate command
shape is otherwise complete.

The Scheduler owns jobs, claims, execution records, leases,
live-execution accounting, delivery admission and observation
obligations. Mission owns nodes, attempts, pinned revisions, evidence,
assessments, outcomes, external objects and accepted observation records.
Worker owns registrations, runtime identities, healthchecks, compatibility
declarations and execution hosting. Project owns bindings, configured counts,
resource authorization and delivery verification.

The proposed public surface has **10 remote commands**: seven read operations
and three mutations. Group/resource help is local and calls no operation.

## Shared input, output and access rules

Every synopsis below starts with `kanthord scheduler`. Every remote command
also accepts the following options; their omission from a compact synopsis
does not remove them.

Shared syntax, types, defaults, and validation are defined by each linked flag.
Only the applicability and Scheduler-specific requirements are listed here.

| Common flag                                                                      | Applies to / Scheduler requirement                                                                                          |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every remote command.                                                                                                       |
| [`--token`](./common-flags.md#--token)                                           | Every remote command requires a resolved token of the identity kind in its access policy. Missing credentials fail locally. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                                                       |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | The three mutations only.                                                                                                   |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Paginated `list` commands only.                                                                                             |
| [`--file`](./common-flags.md#--file)                                             | Required on `work pull` and `execution release`; their sections define the JSON fields.                                     |

Every route follows the [Scheduler operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#operation-contracts): 30 s by default, 120 s with a 90 s wait window on `work pull`, 10 MiB on a body.

These commands accept no `--config`. They open no engine database and do not
read server configuration. Options, positional arguments and JSON fields not
declared here are rejected before sending the request. Optional JSON fields
are omitted when absent unless their table supplies a default; `null` is
invalid unless explicitly allowed. Arrays are ordered JSON arrays, not
comma-separated strings. All request objects are closed, including nested
objects. JSON schemas and their eventual size bounds belong in `contract.ts`.
The [Scheduler operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#operation-contracts) declare the shapes below.

### Identifiers, timestamps and revisions

- `<project-id>` is a required opaque project identity, using the declared
  `project_<ulid>` convention. `<request-id>` uses `request_<ulid>` and a
  client identity uses the declared `client_identity_<ulid>` convention.
  The ULID suffix is canonical uppercase and 26 characters long. Use the
  [shared identity scalar](../../src/kernel/identity.ts), not a bare ULID.
- `<execution-id>` uses `execution_<ulid>` and `<obligation-id>` uses
  `observation_obligation_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service).
  Node IDs, external object IDs and binding IDs use the prefixes of their owners;
  copy them from the owner's response.
  Binding IDs use `binding_<ulid>` under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).
- `runtimeIdentity` is the opaque string returned by Worker registration.
  Current [Worker code](../../src/worker/registrations.ts) generates
  `runtime_identity_<ulid>`, but its
  [published input/output declaration](../../src/worker/contract.ts) only
  validates a nonblank string of at most 128 characters.
  The target prefix is `worker_instance_` under the [Worker identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-identities-of-the-worker-service).
- `attempt` is a positive safe integer counter belonging to the node, not a
  new opaque identity. `pinnedRevision` is a positive safe JSON integer
  revision counter, aligned with the [Mission proposal](./mission.md) and
  pending adoption in its owning contract. Clients never choose either on a pull.
- Every server-defined timestamp below is a nonnegative safe JSON integer
  of **Unix epoch milliseconds in UTC**. A nullable timestamp uses `null`
  when its event has not occurred. A duration is measured with a monotonic clock. JWT timestamps retain their separate seconds unit.
- Neither a timestamp nor a ULID is a general causal-order proof. Queue order
  has its explicit priority/job ordering rule; revision and claim checks
  establish currency elsewhere.

### Access policies

`human` means a Gateway-verified human JWT under the existing equal-human
authority rule. This proposal uses it for project-wide inspection. A human
token does not become a worker by supplying a runtime or execution ID.

`client` means a Gateway-verified machine JWT and a live Worker registration.
Gateway resolves its project and worker binding, and Worker vouches for the
runtime association. A caller-supplied identifier must match that association.
Claim inspection, renewal and release additionally require that the execution
belongs to that client identity and runtime.
Renewal and release declare the live-execution requirement, so the invocation
chain proves it before the handler; `claim get` declares none and its handler
checks ownership, or answers 403 `scheduler.execution.not_owner`. No handler
repeats the proof. A holder whose release answer was lost reads `claim get`
after a refused retry.
They transfer no execution to
another registration. Current access-policy names are defined in the
[operation contract](../../src/kernel/operation.ts).

Delivery ingress uses `delivery` verification, described in [Intake](./intake.md#routes-without-a-command). A
platform signature is neither a human JWT nor an execution identity. No
command here accepts a caller-supplied service identity or linked-human identity.

### Results, pagination, retries and cancellation

Successful reads print one JSON value and exit zero. A successful mutation
prints its result with an additional CLI field `idempotencyKey`, and exits
zero. Help exits zero. Input, authentication, authorization and operation
failures exit nonzero with a diagnostic; an indeterminate result also exits
nonzero and prints the retry key without claiming that no effect occurred.
Tokens and delivery verification material never appear in these outputs.

Every list result is `{ "items": [...], "nextCursor": null | string }`:
both fields are required; `items` contains at most `limit` records and
`nextCursor: null` ends the traversal. An empty list is successful. Each call
reads one page; there is no implicit unbounded traversal or polling loop.
The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) applies; pagination reserves no work.

Mutation requests carry the key in `Idempotency-Key`. On `work pull` and
`execution renew-lease` the CLI also sends body `requestId` equal to `request_`
followed by that key, under the [durable requests](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#durable-requests) of the Scheduler.
`execution release` carries no request identifier; it is idempotent by the
execution identity. The CLI generates `requestId`; it is not an editable
JSON-file field. This preserves one domain request identity when an explicit
key is reused by another CLI process. It is separate from Gateway's
per-transport `X-Request-Id`.

The Scheduler must bind a request identity to its validated payload and caller
scope. Reusing it with different input is a conflict. An accepted work pull
replays its original result before new admission checks inside Scheduler,
without a second execution or count. Gateway authentication still applies.
The scope includes project, claimant binding and runtime identity; another
instance receives no accepted execution. Even an ended claim keeps its
accepted pull result, and replay restores no authority. A no-work result ends
that logical request: a later search uses a new key/request identity. Renewal
and release need their own accepted-request replay to avoid repeated effects.

The [Gateway replay component](../../src/gateway/idempotency.ts) holds records in memory with a TTL.
The [idempotency ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#idempotency-of-a-mutation) also requires handler-owned natural-key idempotency.
Neither mechanism transfers a claim across a runtime-registration boundary.

No command automatically retries. A client can retry an uncertain mutation
with the same inputs and explicit key. A timeout, disconnect or Ctrl-C ends
the wait for a response; it undoes no committed claim, release or renewal.
A cancelled waiting pull leaves no uncommitted reservation.
If acquisition committed before disconnection, the claimant recovers the
original answer by replay rather than issuing a fresh pull. Shutdown stops
new claims, cancels waiting pulls, and preserves accepted obligations.

[scheduler-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery

## Command inventory and proposed operation mapping

The literal service prefix is `/api/scheduler`. Path variables become required
path parameters with the scalar rules above; query fields are only those
listed by a command. Read requests have no body. Every route in this table is
**proposed, pending the owning operation declaration and generated OpenAPI**.

| Command suffix / synopsis                                                        | Operation identifier                                                      | HTTP route                                                                   | Access / effect                                                                                                                                        |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queue list <project-id> [--limit <count>] [--cursor <opaque>]`                  | `scheduler.queue.list` **[blocked][scheduler-contract]**                  | `GET /api/scheduler/project/:projectId/queue`                                | `human`; read                                                                                                                                          |
| `queue peek <project-id>`                                                        | `scheduler.queue.peek` **[blocked][scheduler-contract]**                  | `GET /api/scheduler/project/:projectId/queue/peek`                           | `human`; read                                                                                                                                          |
| `work pull --file <path> [--idempotency-key <key>]`                              | `scheduler.work.pull` **[blocked][scheduler-contract]**                   | `POST /api/scheduler/work/pull`                                              | `client`; mutation, bounded wait                                                                                                                       |
| `claim get <execution-id>`                                                       | `scheduler.claim.get`                                                     | `GET /api/scheduler/claim/:executionId`                                      | `client`; owned claim read; **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery)** |
| `execution list <project-id> [--limit <count>] [--cursor <opaque>]`              | `scheduler.execution.list` **[blocked][scheduler-contract]**              | `GET /api/scheduler/project/:projectId/execution`                            | `human`; read                                                                                                                                          |
| `execution get <execution-id>`                                                   | `scheduler.execution.get`                                                 | `GET /api/scheduler/execution/:executionId`                                  | `human`; read; **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery)**              |
| `execution renew-lease <execution-id> [--idempotency-key <key>]`                 | `scheduler.execution.renew-lease` **[blocked][scheduler-contract]**       | `POST /api/scheduler/execution/:executionId/renew-lease`                     | `client`; owned live execution mutation                                                                                                                |
| `execution release <execution-id> --file <path> [--idempotency-key <key>]`       | `scheduler.execution.release` **[blocked][scheduler-contract]**           | `POST /api/scheduler/execution/:executionId/release`                         | `client`; owned live execution mutation                                                                                                                |
| `observation-obligation list <project-id> [--limit <count>] [--cursor <opaque>]` | `scheduler.observation-obligation.list` **[blocked][scheduler-contract]** | `GET /api/scheduler/project/:projectId/observation-obligation`               | `human`; read                                                                                                                                          |
| `observation-obligation get <project-id> <obligation-id>`                        | `scheduler.observation-obligation.get` **[blocked][scheduler-contract]**  | `GET /api/scheduler/project/:projectId/observation-obligation/:obligationId` | `human`; read                                                                                                                                          |

These read operations are proposed operational visibility, not an existing
authorization to inspect service tables directly. `claim get` provides a
machine-scoped view of the claim held in an execution record; it introduces
neither a separate claim identity nor a second acquisition path.

## Queue discovery

### `queue list`

```text
kanthord scheduler queue list <project-id> [--limit <count>] [--cursor <opaque>]
```

`<project-id>` is required, has no default and maps to path `projectId`.
[`--limit`](./common-flags.md#--limit) and
[`--cursor`](./common-flags.md#--cursor) have the shared definitions. There are
no other query fields or JSON body. The list returns a page of `Job`
records in descending job-identity order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
This inspection order does not change queue selection. Reading changes no job.
The list is a live view of current jobs and holds no history.

### `queue peek`

```text
kanthord scheduler queue peek <project-id>
```

The required positional input maps to path `projectId` and has no default.
No query or body is accepted. Returns the required field
`{ "job": Job | null }`, with `null` for an empty queue. It reads
the first job in priority descending, then job identity ascending order,
and removes nothing. It neither predicts a particular instance's compatible
selection nor reserves a node for a subsequent pull.

### Proposed `Job` result

Every field below is required in a result; none has a client default.

| Field                 | Type and validation / meaning                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------ |
| `jobId`               | `job_<ulid>`; the ULID carries the creation time of the job.                                           |
| `projectId`, `nodeId` | Project and Mission node references. Only an initiative or objective can be queued; never a task.      |
| `priority`            | Safe integer copied from the Mission-owned priority. An absent node priority is Mission's default `0`. |

A priority change preserves the job identity. A release with further work
creates a new job when the node is claimable. Membership means claimable work,
not necessarily Mission state `Available`. Neither priority, age, inspection nor a stale job admits
a claim. Mission state and every admission condition are rechecked at claim.

## Work acquisition

### `work pull`

```text
kanthord scheduler work pull --file <path> [--idempotency-key <key>]
```

There are no positional arguments or query fields. The required file supplies
the following proposed fields. The CLI adds the generated `requestId` defined
above to form the HTTP JSON body.

| JSON file field   | Requiredness / type     | Default and validation                                                                    |
| ----------------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `workerBindingId` | Required opaque string. | No default. Must equal the binding authenticated from the machine JWT.                    |
| `runtimeIdentity` | Required opaque string. | No default. Must equal that client's live Worker registration and belong to that binding. |

The Scheduler parks a pull that finds no work for at most 90 s and then answers with no work. The client chooses no wait. The route timeout is 120 s.

The authenticated binding determines the project. The file accepts no project
override, node/mission selector, priority, claim kind, worker-name override,
declared-state override, health assertion, node format, attempt or revision.
An external harness's orchestrator uses the same pull as any other instance;
it cannot acquire a chosen node or authorize its own claim.

**Admission and effect:**

1. Worker vouches for the runtime association, a fresh instance healthcheck
   and the worker's published compatibility declarations. The instance has
   at most one outstanding pull or one live execution.
2. Scheduler selects the first job that the claimant admits
   in the project's queue order. Compatibility includes exact worker name,
   declared node state and required node format, using the pinned revision
   of an open attempt or the current revision before the first claim.
3. Selection and claim are one atomic acquisition. They recheck Mission
   state, the Mission condition, binding availability and
   count, compatibility and one-claim-per-node exclusion. A node must be
   `Available` for a steps claim (with terminal objectives on an initiative)
   or eligible `Waiting`/`External.Requested`
   for an evaluation claim. A `Blocked`, `Paused`, `Pending`, terminal or
   incompatible node cannot be forced through this path.
4. An accepted claim mints the execution identity and counts one execution
   against the claimant binding. One runtime holds at most one execution;
   the binding admits fewer live executions than its configured count.
   Scheduler adds no project-wide cap or retry budget. Mission performs the
   transition, attempt opening when needed, and revision pin atomically.

A claim serializes with block, pause, graph/import and binding changes. The
worker's declared capability for both kinds gives it no preference to review
its own steps. Hosted reviewers pull independently. All admission conditions
are rechecked after waiting, including a binding disabled during the wait.

**Proposed result:** exactly one of these closed objects:

- `{ "kind": "claimed", "execution": ExecutionRecord }`.
- `{ "kind": "no-work" }`.

Both are successful results, proposed HTTP `200`; the CLI adds its key.
No-work opens no attempt, creates no execution and consumes no live count.
The harness backs off before a new logical pull. Waiting holds no lock,
processor permit or node reservation.
The Scheduler repeats the healthcheck immediately before the claim commits, under [Claims and counts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#claims-and-counts).
A failed check returns the pull empty.

## Claims and execution inspection

### `claim get`

```text
kanthord scheduler claim get <execution-id>
```

Required opaque `<execution-id>` maps to path `executionId`; no default,
query or body. Returns an `ExecutionRecord` for the authenticated client's
own runtime. It can report that the execution has ended while that same
registration remains live; it grants no authority from the historical result.
A different client or runtime cannot use this command to take or renew the
claim. After registration ends, use human execution inspection for history.
This read is a snapshot; every later execution operation rechecks liveness.

### `execution list`

```text
kanthord scheduler execution list <project-id> [--limit <count>] [--cursor <opaque>]
```

Required `<project-id>` maps to path `projectId`, with no default. Only the
shared pagination query is accepted; no body. Returns a page of
`ExecutionRecord` values, including live and ended executions. The list orders
by `executionId` descending under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
This inspection order establishes no causal order. It changes no claim or count.
The list holds every execution of the project for the life of the project,
under the [Scheduler retention](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#retention).

### `execution get`

```text
kanthord scheduler execution get <execution-id>
```

Required opaque `<execution-id>` maps to path `executionId`; no default,
query or body. Returns one `ExecutionRecord`, or a not-found failure. It is
human inspection across registrations and server restarts. It does not
impersonate the recorded claimant or perform an execution operation.

### Proposed `ExecutionRecord` result

All fields below are required unless the row explicitly says optional. Result
fields are server-owned; the caller supplies none when acquiring work.

| Field                                | Type and meaning                                                                                                                                                                                                                                                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionId`, `projectId`, `nodeId` | Opaque references with the identifier rules above.                                                                                                                                                                                                                                                                        |
| `claimant`                           | Object with required `workerBindingId` and `runtimeIdentity` strings. For a registered instance, also requires `clientId` (`client_identity_<ulid>`) and `name` (nonblank string, 1–64 characters) copied at claim acceptance. These two attribution fields are absent for a hosted instance without a registered client. |
| `claimKind`                          | Enum `steps` or `evaluation`, fixed for the entire lifetime of the claim.                                                                                                                                                                                                                                                 |
| `attempt`                            | Positive safe integer counter of the node's attempt.                                                                                                                                                                                                                                                                      |
| `pinnedRevision`                     | Positive safe JSON integer revision counter; proposed scalar pending adoption with Mission.                                                                                                                                                                                                                               |
| `credentials`                        | Array of `credential_<ulid>` strings: the credential revisions that the execution pins, `[]` at the claim.                                                                                                                                                                                                                |
| `claimState`                         | Proposed inspection enum `live`, `released`, `revoked` or `lost`. These are claim lifecycle labels, not new Mission node states. `lost` records the accepted loss declaration. The closed set remains **[blocked][scheduler-contract]** under the request and response schemas (claim state) question.                    |
| `lease`                              | Object with required `expiresAt` timestamp, `renewedAt` timestamp or `null`, and `lossDeclaredAt` timestamp or `null`. Scheduler alone determines expiry.                                                                                                                                                                 |
| `createdAt`                          | Claim acceptance timestamp.                                                                                                                                                                                                                                                                                               |
| `endedAt`                            | End timestamp or `null` while live.                                                                                                                                                                                                                                                                                       |
| `traceId`, `rootSpanId`              | Opaque owner-returned `TraceID` and `SpanID` strings respectively; identity validation remains **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#tracking-service)**.                                                                                                              |

Trace and span validation follows
[Tracking's identity and timestamp rules](./tracking.md#identity-and-timestamp-validation).
OpenTelemetry reuse does not specify their wire representation; this proposal
requires neither W3C hexadecimal IDs nor an invented entity prefix.

The attribution copy follows [Claims and counts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#claims-and-counts) and survives deregistration.
A display name authenticates and groups nothing.

## Lease renewal and release

### `execution renew-lease`

```text
kanthord scheduler execution renew-lease <execution-id> [--idempotency-key <key>]
```

Required opaque `<execution-id>` maps to path `executionId`, with no default.
There is no query or input file. The HTTP body is the closed generated object
`{ "requestId": "request_<same-key-ulid>" }`. No expiry, duration, claimant,
priority or replacement execution is accepted from the caller.

The authenticated holder renews its current live claim. Proposed success is
HTTP `200` with `{ "executionId": string, "lease": Lease }`, both fields
required and `Lease` shaped as the `ExecutionRecord.lease` object. Scheduler
chooses the renewed expiry under its eventual lease policy. Replay of the
same request returns the same accepted renewal rather than extending it
again; a later renewal uses a new key. A key that a later renewal superseded
answers 409 `scheduler.execution.renewal_superseded`. A replayed acknowledgement of an old
renewal does not prove present liveness.

Renewal serializes with loss declaration, release, revocation and completion.
A new renewal of an ended, revoked or lost claim fails. Renewal consumes no
additional count and changes no attempt or claim kind. A hosted execution's
renewal loop runs outside its agent at an interval shorter than lease expiry;
this one-shot command supplies a primitive for an external orchestrator, not
a scheduler loop or a daemon.

### `execution release`

```text
kanthord scheduler execution release <execution-id> --file <path> [--idempotency-key <key>]
```

Required opaque `<execution-id>` maps to path `executionId`, with no default.
No query fields are accepted. The required file supplies the following fields.

| JSON file field | Requiredness / type | Default and validation                                                                                                                                                                                               |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `furtherWork`   | Required boolean.   | No default. `false` declares no further work for this release; it does not assert success, close an attempt or manufacture an assessment. `true` requests the supported further-work path of the current claim kind. |

**Effects and prerequisites:**

- A release durably ends the execution and removes its live-execution count.
  Mission routes the release using its accepted facts. A supported release
  leaves the attempt open; it never opens a replacement attempt by itself.
- A steps release with no further work requires the evidence and task-result
  obligations owned by Mission/Worker. A steps release with further work
  requires the accepted run output and checkpoint/push obligations of
  Worker. Those records are submitted through their owning services; the
  release body contains no evidence, assessment, outcome or shell command.
- A reviewer release is supported only after the current passing assessment
  and the action-performer path allow it: returned items consist solely of
  submitted external objects and actions awaiting prerequisites.
  When all requests are submitted, Mission routes the release to
  `External.Requested` and inserts no job. The transaction that makes the
  continuation condition hold inserts the evaluation job. A passing assessment
  with no required external action already ends the claim; no fresh release
  is needed to declare completion.
- Mission inserts the job of the node in the transaction that makes the node
  claimable, and that is the release itself when the node is claimable at once.
  No job exists while a node waits. The next compatible pull receives the
  continuation; there is no pushed assignment.

Proposed success is HTTP `200` with required fields
`{ "executionId": string, "releasedAt": timestamp }`; the CLI adds its key.
At the handler, a duplicate returns the accepted release without ending a second
execution, double-decrementing a count or creating a second job. A duplicate
with another payload answers 409 `scheduler.execution.release_conflict`.
The invocation chain refuses a retry after the claim ends before the handler;
the holder reads `claim get` for the accepted end. This receipt is not an outcome
record or an assertion that the node is immediately claimable.

There is no `failure`, `cannotProgress`, `retryBudget`, `force` or arbitrary
target-state field. Failure dispositions remain **blocked** under [HANDOFF Cannot progress](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#cannot-progress).

### Liveness, epochs and cancellation boundaries

Lease validity, Worker healthcheck, observed telemetry progress and Mission
readiness are separate facts. A healthcheck and silent logs establish no live
claim and no failed assessment. A provider outage authorizes no substitution
and creates no block condition by itself.

The live execution identity must match the node's current claim. Human pause,
discard and the applicable success override revoke the claim through Mission;
the revocation is accepted before a later operation's admission can read it.
Loss revokes authority at the loss declaration, not at a replacement claim.
Both paths remove the execution from its claimant count. An already-admitted
remote operation follows Project's rules; revocation does not undo it.

Lease duration and renewal cadence remain **[blocked][scheduler-contract]**.
The command exposes no client-selected epoch.
The execution/current-claim comparison and accepted revocation or loss govern liveness under the [Scheduler design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#liveness).

Expiry is not proof that a runtime stopped. A stopped or revoked execution
must publish no later effect, and Mission/Project refuse stale admission.
Physical stop and safe reuse remain **blocked** under [HANDOFF SC5](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service). Inspection, cancellation and renewal commands make no stronger
guarantee. There is no generic Scheduler cancellation command: a transport
cancel is not a release, and a human pauses/discards through Mission.

## Observation-obligation inspection

### `observation-obligation list`

```text
kanthord scheduler observation-obligation list <project-id> [--limit <count>] [--cursor <opaque>]
```

Required `<project-id>` maps to path `projectId`, with no default. Only the
shared pagination query is accepted; no body. Returns a page of
`ObservationObligation` records in descending `obligationId` order under the
shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
This makes outstanding durable work visible
without starting, retrying, completing or taking an observer lease.

### `observation-obligation get`

```text
kanthord scheduler observation-obligation get <project-id> <obligation-id>
```

Both positional IDs are required, with no default, and map to `projectId` and
`obligationId`. No query or body. Returns one `ObservationObligation` in that
project, or a not-found failure. This is a Scheduler obligation; Mission's
accepted observation record remains a different resource.

### Proposed `ObservationObligation` result

All fields are required; nullable fields remain present with `null`.

| Field                                           | Type and meaning                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `obligationId`, `projectId`, `externalObjectId` | Opaque references; the external object determines correlation and service-identity resolution.                                                                                                                                                                              |
| `acceptedAt`                                    | Durable obligation acceptance timestamp.                                                                                                                                                                                                                                    |
| `lease`                                         | Same timestamp shape as `ExecutionRecord.lease`, or `null` before an observer holds it; the lease start remains **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery)**. This lease is not a node claim. |
| `completedAt`                                   | Timestamp or `null` while durable completion has not been established.                                                                                                                                                                                                      |
| `observationId`                                 | Opaque Mission observation reference or `null` while no accepted observation is associated. Its prefix remains Mission-owned.                                                                                                                                               |

The observer has no claimant and no execution ID. It reads through the
[platform connector of the Repository component](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.md#platform-connector-and-platform-implementations)
under the narrowly authorized service identity resolved from the external
object, folds platform state and submits the observation
to Mission. It never decides the node's outcome. This proposal offers no
manual `observe`, `complete`, `retry` or lease-stealing command: observer recovery remains **blocked** under [HANDOFF C1](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service).
The [service identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-operation-and-its-two-entry-adapters) governs observer identity.

## Delivery admission

The Intake Service receives every platform delivery and owns the delivery
record. Its inspection commands live in [Intake](./intake.md#delivery-commands).
The Scheduler owns the delivery admission operation that the Intake Service
calls. Admission records its decision durably before answering and returns one
of four dispositions: `accepted as an observation`, `accepted as a human act`,
`refused`, or `duplicate`. A repeat with the same delivery identity and content
returns the recorded disposition; different content under that identity
receives a refusal.

Acceptance transfers every effect obligation to the Scheduler. Acceptance as
an observation creates an observation obligation; acceptance as a human act
invokes Mission under the linked human identity. Refusal admits no effect,
and a duplicate creates no second effect. The Scheduler preserves every
obligation whose effect lacks durable acceptance and deduplicates effects per
project and per external object across subscription kinds and redeliveries.
Admission needs no live worker and promises no execution. The
[Repository component](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.md#platform-connector-and-platform-implementations)
decodes the platform payload; Scheduler core consumes that decoded delivery
rather than interpreting platform JSON.

The observer resolves the repository binding, object address, node and attempt;
correlation needs no surviving originating runtime. An ambiguous or out-of-order
delivery reconciles against the node's external objects, not automatically its
newest attempt. An observation needs the authorized observer path, not a node
claim. A platform signature grants no authority to edit WHAT, unblock, override
or execute. New WHAT creates no node and is not a scheduling request; its
inbound request contract remains **blocked** under [HANDOFF Scheduler Service and delivery](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery).
A read of admission dispositions remains **blocked** under that same item; this page proposes no command.

### Delivery is an ingress operation, not a generic CLI mutation

No CLI `delivery submit` or `observation submit` exists. A JSON file is not a
signed delivery, and a human or machine token is not delivery verification.
[Intake documents the receipt route](./intake.md#routes-without-a-command).

## Service collaborations and loops excluded from the command surface

- **Queue insert/delete/reorder:** Mission writes affected jobs, including
  dependency and parent effects, within the transaction committing the
  accepted fact. Its public collaboration is a co-location contract, not a
  routable command that can detach queue membership from Mission state.
  Priority edits remain human Mission operations.
- **Direct claim/acquire/assign:** only work pull invokes the atomic claim
  operation. No command chooses a node and creates a claim, rewrites an
  execution record, raises a count, selects a reviewer or bypasses readiness.
- **On-demand request:** a server service may ask to serve an already-queued
  node to the next compatible pull ahead of order. The request owns no claim,
  waits boundedly for a claim and still obeys admission. No external authority
  or CLI operation is declared here; it is not a human `run-node` escape hatch.
- **Wakeups, pool turns and loss sweeps:** these are
  Scheduler-owned processing. An idle project consumes no turn, a waiting
  pull holds no permit, and one execution occupies no scheduling processor.
  There is no public `tick`, `drain`, `force-release`, `declare-loss`,
  `reset-epoch` or `reset-budget`.
- **External action performance:** Worker derives action operands from the
  attempt and evidence, and Mission owns resulting records. It is not
  Scheduler delivery admission or a queue write.
- **Human recovery and outcomes:** unblock, pause, resume, discard, priority
  and override belong to Mission's human authority path. Scheduler inspection
  and machine lease operations cannot take their place.

## Design provenance

- [Scheduler rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md)
  and [vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.vocabulary.md).
- [Architecture implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
  and [Gateway implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md).
- [Worker lifecycle](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.md),
  [Mission transitions](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.md)
  and [Project authority](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.md).
- [Open design handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md),
  especially Scheduler/delivery and B9 failure/recovery.
