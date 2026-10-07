# Scheduler CLI specification

This is the implemented `kanthord scheduler` command surface for engine
contributors. See the [CLI index](./README.md) and
[shared conventions](./other.md). The contracts below are self-contained;
provenance links at the end provide design context.

## Status and ownership

**Implemented, inspected 2026-10-01:** seven commands below are callable.
**Declared, not implemented:** `eligibility get`, under [the eligibility report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-eligibility-report).
The [Scheduler CLI](../../src/apps/cli/scheduler.ts) and
[execution CLI](../../src/apps/cli/scheduler-execution.ts) use the
[operation contracts](../../src/scheduler/contract.ts), with generated
[OpenAPI](../../static/openapi/scheduler/). The
[server composition](../../src/apps/server/index.ts) wires the Scheduler to
the real Mission transitions, Worker registrations and declarations, Project
bindings, and Gateway execution proof. The Scheduler owns durable jobs and
execution rows, bounded waiting pulls, postcommit wakeups, fixed deadlines,
and the supervised 30-second loss sweep.

**Current boundary:** `TraceIdentity` is a minting stand-in injected by the
composition root; stored telemetry and the tracer await ERD 4. Mission
execution submissions, custody handover, the action performer, native methods
and the worker application loop belong to later ERD 2 plans. Intake and
delivery admission await ERD 3. The Scheduler's credential-pin collaborations
exist, but custody handover does not yet call them. Server-hosted execution
and its in-process abort, on-demand requests, numeric processor/fairness bounds
and B9 recovery are outside Plan03. The design obligations described below
retain those boundaries; they do not imply that these integrations exist.

The Scheduler owns jobs, claims, execution records, fixed deadlines and
live-execution accounting. Mission owns nodes, attempts, pinned revisions,
evidence, assessments, outcomes, request evidence and delivery admission.
Worker owns registrations, runtime identities, healthchecks, compatibility
declarations and execution hosting. Project owns bindings, configured counts,
resource authorization and delivery verification.

The public surface has **8 remote commands**: six read operations
and two mutations. Seven are implemented; the read `eligibility get` is
declared only. Group/resource help is local and calls no operation.

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
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | The two mutations only.                                                                                                     |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Paginated `list` commands only.                                                                                             |
| [`--file`](./common-flags.md#--file)                                             | Required on `work pull` and `execution release`; their sections define the JSON fields.                                     |

Every route follows the [Scheduler operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#operation-contracts): 30 s by default, 120 s with a 90 s wait window on `work pull`, 10 MiB on a body.

These commands accept no `--config`. They open no engine database and do not
read server configuration. Options, positional arguments and JSON fields not
declared here are rejected before sending the request. Optional JSON fields
are omitted when absent unless their table supplies a default; `null` is
invalid unless explicitly allowed. Arrays are ordered JSON arrays, not
comma-separated strings. All request objects are closed, including nested
objects. JSON schemas and their declared field bounds live in `contract.ts`.
The [Scheduler operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#operation-contracts) declare the shapes below.

### Identifiers, timestamps and revisions

- `<project-id>` is a required opaque project identity, using the declared
  `project_<ulid>` convention. A client identity uses the declared
  `client_identity_<ulid>` convention.
  The ULID suffix is canonical uppercase and 26 characters long. Use the
  [shared identity scalar](../../src/kernel/identity.ts), not a bare ULID.
- `<execution-id>` uses `execution_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service).
  Node IDs, evidence IDs and binding IDs use the prefixes of their owners;
  copy them from the owner's response.
  Binding IDs use `binding_<ulid>` under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).
- `runtime_identity` is the `worker_instance_<ulid>` identity returned by
  Worker registration. Both the [Worker contract](../../src/worker/contract.ts)
  and the [Scheduler contract](../../src/scheduler/contract.ts) validate the
  canonical prefixed identity under the [Worker identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-identities-of-the-worker-service).
- `attempt` is a positive safe integer counter belonging to the node, not a
  new opaque identity. `pinned_revision` is a positive safe JSON integer
  revision counter, implemented in the Scheduler contract and aligned with
  [Mission](./mission.md). Clients never choose either on a pull.
- Every server-defined timestamp below is a nonnegative safe JSON integer
  of **Unix epoch milliseconds in UTC**. A nullable timestamp uses `null`
  when its event has not occurred. A duration is measured with a monotonic clock. JWT timestamps retain their separate seconds unit.
- Neither a timestamp nor a ULID is a general causal-order proof. Queue order
  has its explicit priority/job ordering rule; revision and claim checks
  establish currency elsewhere.

### Access policies

`human` means a Gateway-verified human JWT under the existing equal-human
authority rule. Scheduler uses it for project-wide inspection. A human
token does not become a worker by supplying a runtime or execution ID.

`client` means a Gateway-verified machine JWT and a live Worker registration.
Gateway resolves its project and worker binding, and Worker vouches for the
runtime association. A caller-supplied identifier must match that association.
Claim inspection and release additionally require that the execution
belongs to that client identity and runtime. Release declares the live-execution
requirement, so the invocation chain proves it before mutation replay and the
handler. A registered machine whose proof fails receives 403
`gateway.invocation.execution_proof_failed`. Its write
transaction repeats the full proof; failure answers 409
`scheduler.execution.not_running`. `claim get` declares no live-execution
requirement and its handler checks ownership, or answers 403
`scheduler.execution.not_owner`. After a lost release answer and a refused
retry, the holder reads `claim get`, which shows `finished`. Neither command
transfers an execution to another registration. Current access-policy names
are defined in the [operation contract](../../src/kernel/operation.ts).

Delivery ingress uses `delivery` verification, described in [Intake](./intake.md#routes-without-a-command). A
platform signature is neither a human JWT nor an execution identity. No
command here accepts a caller-supplied service identity or linked-human identity.

### Results, pagination, retries and cancellation

Successful reads print one JSON value and exit zero. A successful mutation
prints its result with an additional CLI field `idempotency_key`, and exits
zero. Help exits zero. Input, authentication, authorization and operation
failures exit nonzero with a diagnostic. An indeterminate result also exits
nonzero. For a mutation, the diagnostic supplies the retry key without claiming
that no effect occurred. For a read, it instructs the user to retry the command.
For `execution release`, the diagnostic instead tells the user to run
`kanthord scheduler execution get <execution-id>` before any retry, because a
retry after a committed release fails the execution proof.
Tokens and delivery verification material never appear in these outputs.

Every list result is `{ "items": [...], "next_cursor": null | string }`:
both fields are required; `items` contains at most `limit` records and
`next_cursor: null` ends the traversal. An empty list is successful. Each call
reads one page; there is no implicit unbounded traversal or polling loop.
The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) applies; pagination reserves no work.

Mutation requests carry the key in `Idempotency-Key`. No Scheduler command
carries a domain request identifier. `work pull` is idempotent by the runtime
identity. `execution release` carries no domain request identifier and
stores no release receipt. The key is separate from Gateway's per-transport
`X-Request-Id`.

A work pull is idempotent by the runtime identity. A pull from an instance
that holds a live execution returns that execution before new admission checks
inside Scheduler, without a second execution or count. Gateway authentication
still applies. Another instance never receives that execution. After the
execution ends, a pull selects new work, and an ended claim restores no
authority. A release ends the execution at most once; a retry after the end
meets the refusal of the proof.

The [Gateway replay component](../../src/gateway/idempotency.ts) holds records in memory with a TTL.
The [idempotency ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#idempotency-of-a-mutation) governs replay. Work pull uses runtime identity;
release stores no receipt and a retry after the end is refused. Gateway replay
transfers no claim across a runtime-registration boundary.

No command automatically retries. A client can retry an uncertain mutation
with the same inputs and explicit key. A timeout, disconnect or Ctrl-C ends
the wait for a response; it undoes no committed claim or release.
A cancelled waiting pull leaves no uncommitted reservation.
If acquisition committed before disconnection, the next pull of the same
runtime identity returns the live execution. Shutdown stops new claims,
cancels waiting pulls, and preserves accepted execution obligations.

<a id="command-inventory-and-proposed-operation-mapping"></a>

## Command inventory and operation mapping

The literal service prefix is `/api/scheduler`. Path variables become required
path parameters with the scalar rules above; query fields are only those
listed by a command. Read requests have no body. Every route in this table
except the eligibility route is implemented in the operation declaration and
generated OpenAPI.

| Command suffix / synopsis                                                                              | Operation identifier          | HTTP route                                                    | Access / effect                         |
| ------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------- | --------------------------------------- |
| `queue list <project-id> [--limit <count>] [--cursor <opaque>]`                                        | `scheduler.queue.list`        | `GET /api/scheduler/project/:project_id/queue`                | `human`; read                           |
| `queue peek <project-id>`                                                                              | `scheduler.queue.peek`        | `GET /api/scheduler/project/:project_id/queue/peek`           | `human`; read                           |
| `eligibility get <project-id> <node-id>`                                                               | `scheduler.eligibility.get`   | `GET /api/scheduler/project/:project_id/eligibility/:node_id` | `human`; read                           |
| `work pull --file <path> [--idempotency-key <key>]`                                                    | `scheduler.work.pull`         | `POST /api/scheduler/work/pull`                               | `client`; mutation, bounded wait        |
| `claim get <execution-id>`                                                                             | `scheduler.claim.get`         | `GET /api/scheduler/claim/:execution_id`                      | `client`; owned claim read              |
| `execution list <project-id> [--node <node-id> [--attempt <n>]] [--limit <count>] [--cursor <opaque>]` | `scheduler.execution.list`    | `GET /api/scheduler/project/:project_id/execution`            | `human`; read                           |
| `execution get <execution-id>`                                                                         | `scheduler.execution.get`     | `GET /api/scheduler/execution/:execution_id`                  | `human`; read                           |
| `execution release <execution-id> --file <path> [--idempotency-key <key>]`                             | `scheduler.execution.release` | `POST /api/scheduler/execution/:execution_id/release`         | `client`; owned live execution mutation |

These read operations provide operational visibility through the invocation
chain, with no authorization to inspect service tables directly. `claim get` provides a
machine-scoped view of the claim held in an execution record; it introduces
neither a separate claim identity nor a second acquisition path.

## Queue discovery

### `queue list`

```text
kanthord scheduler queue list <project-id> [--limit <count>] [--cursor <opaque>]
```

`<project-id>` is required, has no default and maps to path `project_id`.
[`--limit`](./common-flags.md#--limit) and
[`--cursor`](./common-flags.md#--cursor) have the shared definitions. There are
no other query fields or JSON body. The list returns a page of `Job`
records in the order of the work queue: priority descending, then job
identity ascending, under the [Scheduler operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#operation-contracts).
The cursor encodes the priority and the job identity of the last job of a page.
The server defines the order across all pages, and a client never re-sorts a
page. Reading changes no job.
The list is a live view of current jobs and holds no history.

### `queue peek`

```text
kanthord scheduler queue peek <project-id>
```

The required positional input maps to path `project_id` and has no default.
No query or body is accepted. Returns the required field
`{ "job": Job | null }`, with `null` for an empty queue. It reads
the first job in priority descending, then job identity ascending order,
and removes nothing. It neither predicts a particular instance's compatible
selection nor reserves a node for a subsequent pull.

### `Job` result

Every field below is required in a result; none has a client default.

| Field                   | Type and validation / meaning                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `job_id`                | `job_<ulid>`; the ULID carries the creation time of the job.                                           |
| `project_id`, `node_id` | Project and Mission node references. Only an initiative or objective can be queued; never a task.      |
| `priority`              | Safe integer copied from the Mission-owned priority. An absent node priority is Mission's default `0`. |

A priority change preserves the job identity. A release with further work
creates a new job when the node is claimable. Membership means claimable work,
not necessarily Mission state `Available`. Neither priority, age, inspection nor a stale job admits
a claim. Mission state and every admission condition are rechecked at claim.

### `eligibility get`

```text
kanthord scheduler eligibility get <project-id> <node-id>
```

Required `<project-id>` maps to path `project_id` and required `<node-id>` maps
to path `node_id`; neither has a default. No query or body is accepted. Returns
one `EligibilityReport` under [the eligibility report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-eligibility-report).
The report answers only the admission checks that need no claimant. It writes
nothing, moves no job and predicts no claim.

| Field                   | Type and meaning                                                                                                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| `project_id`, `node_id` | The path references.                                                                                            |
| `state`                 | The Mission `State` of the node at the read.                                                                    |
| `claimable`             | `true` exactly when no check holds `failed`.                                                                    |
| `checks`                | Four `EligibilityCheck` objects in this order: `node-state`, `mission-condition`, `queue-job`, `no-live-claim`. |

`EligibilityCheck` holds `name`, `result` (`passed`, `failed` or
`not-applicable`) and `condition` (`initiative-steps`, `readiness`,
`continuation` or `null`). Only `mission-condition` holds a non-null
`condition`. `node-state` passes for a node that is not retired in
`Available`, `Waiting` or `External.Requested`. `mission-condition` reads the
initiative steps condition for an initiative in `Available`, the readiness
condition for `Waiting` and the continuation condition for
`External.Requested`; it is `not-applicable` for an objective in `Available`
and when `node-state` fails. `queue-job` passes when the queue holds a job of
the node. `no-live-claim` passes when no execution of the node is `running`.

The report never answers binding availability and instance count, declared
node states, claimant count, the instance healthcheck or the compatibility
match, because each needs a selected claimant. It takes no instance
healthcheck, reads no registration and names no binding, instance or claimant.

## Work acquisition

### `work pull`

```text
kanthord scheduler work pull --file <path> [--idempotency-key <key>]
```

There are no positional arguments or query fields. The required file supplies
the following fields. The file forms the HTTP JSON body.

| JSON file field     | Requiredness / type                | Default and validation                                                                    |
| ------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `resource_identity` | Required nonempty opaque string.   | No default. Must equal the resource identity authenticated from the machine JWT.          |
| `runtime_identity`  | Required `worker_instance_<ulid>`. | No default. Must equal that client's live Worker registration and belong to that binding. |

The Scheduler parks a pull that finds no work for at most 90 s and then answers with no work. The client chooses no wait. The route timeout is 120 s.

Only one waiter is retained per runtime identity. A concurrent duplicate still
probes for a live or new claim; if none is available, it returns `no-work`
instead of parking another waiter. A failed healthcheck or a committed loss
settlement can also produce an earlier empty answer.

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
its own steps. The Worker design requires hosted reviewers to pull independently.
All admission conditions
are rechecked after waiting, including a binding disabled during the wait.

**Result:** exactly one of these closed objects:

- `{ "kind": "claimed", "execution": ExecutionRecord }`.
- `{ "kind": "no-work" }`.

Both are successful results, HTTP `200`; the CLI adds its key.
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

Required opaque `<execution-id>` maps to path `execution_id`; no default,
query or body. Returns an `ExecutionRecord` for the authenticated client's
own runtime. It can report that the execution has ended while that same
registration remains live; it grants no authority from the historical result.
A different client or runtime cannot use this command to take the
claim. After registration ends, use human execution inspection for history.
This read is a snapshot; every later execution operation rechecks liveness.

### `execution list`

```text
kanthord scheduler execution list <project-id> [--node <node-id> [--attempt <n>]] [--limit <count>] [--cursor <opaque>]
```

Required `<project-id>` maps to path `project_id`, with no default. Optional
`--node <node-id>` maps to query `node_id`, with no default. Optional
`--attempt <n>` maps to query `attempt`, a positive integer, with no default.
The shared pagination query is also accepted; no body. Returns a page of
`ExecutionRecord` values, including live and ended executions. Every mode
orders by `execution_id` descending under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
With `node_id`, the list holds the executions of that node only. A `node_id` that
the project does not hold answers an empty page. With `node_id` and `attempt`,
the list holds the executions of that attempt only. An attempt that the node
does not hold answers an empty page. `attempt` without `node_id` answers 400
`gateway.request.validation_failed`.
This inspection order establishes no causal order. It changes no claim or count.
The list holds every execution of the project for the life of the project,
under the [Scheduler retention](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#retention).

### `execution get`

```text
kanthord scheduler execution get <execution-id>
```

Required opaque `<execution-id>` maps to path `execution_id`; no default,
query or body. Returns one `ExecutionRecord`, or a not-found failure. It is
human inspection across registrations and server restarts. It does not
impersonate the recorded claimant or perform an execution operation.

### `ExecutionRecord` result

All fields below are required unless the row explicitly says optional. Result
fields are server-owned; the caller supplies none when acquiring work.

| Field                                   | Type and meaning                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execution_id`, `project_id`, `node_id` | Opaque references with the identifier rules above.                                                                                                                                                                                                                                                                                                                                                                                   |
| `claimant`                              | Object with required `worker_binding_id`, `resource_identity` and `runtime_identity` strings. `worker_binding_id` is the latest binding row at the claim. For a registered instance, also requires `client_id` (`client_identity_<ulid>`) and `name` (nonblank string, 1–64 characters) read from the registration of `runtime_identity`. These two attribution fields are absent for a hosted instance without a registered client. |
| `attempt`                               | Positive safe integer counter of the node's attempt.                                                                                                                                                                                                                                                                                                                                                                                 |
| `pinned_revision`                       | Positive safe JSON integer revision counter from the open Mission attempt.                                                                                                                                                                                                                                                                                                                                                           |
| `credentials`                           | Array of `credential_<ulid>` strings: the credential revisions that the execution pins, `[]` at the claim.                                                                                                                                                                                                                                                                                                                           |
| `claim_state`                           | Derived enum `running`, `lost` or `finished`: `running` when `ended_at` is null and time is before `expired_at`; `lost` when `ended_at` is at or after `expired_at`, or is null and time is at or after `expired_at`; `finished` when `ended_at` is before `expired_at` after release, assessment end or revocation.                                                                                                                 |
| `expired_at`                            | Timestamp. The fixed deadline that the claim sets once.                                                                                                                                                                                                                                                                                                                                                                              |
| `created_at`                            | Claim acceptance timestamp.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ended_at`                              | End timestamp or `null` before a terminal write.                                                                                                                                                                                                                                                                                                                                                                                     |
| `trace_id`, `root_span_id`              | `TraceID` and `SpanID` under the [trace model](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/tracking-service.impl.md#trace-model): 32 and 16 lower-case hexadecimal characters, never all zero. The Scheduler mints both at the claim until the tracer of the Tracking Service exists.                                                                                                                          |

Trace and span validation follows
[Tracking's identity and timestamp rules](./tracking.md#identity-and-timestamp-validation):
the W3C Trace Context representation of the trace model, never an entity prefix.

The attribution comes from the registration of `runtime_identity` and survives deregistration, because the Worker Service keeps the ended registration row.
A display name authenticates and groups nothing.

## Release

### `execution release`

```text
kanthord scheduler execution release <execution-id> --file <path> [--idempotency-key <key>]
```

Required opaque `<execution-id>` maps to path `execution_id`, with no default.
No query fields are accepted. The required file supplies the following fields.

| JSON file field | Requiredness / type | Default and validation                                                                                                                                                                                               |
| --------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `further_work`  | Required boolean.   | No default. `false` declares no further work for this release; it does not assert success, close an attempt or manufacture an assessment. `true` requests the supported further-work path of the current node state. |

**Effects and prerequisites:**

- A release durably ends the execution and removes its live-execution count.
  Mission routes the release using its accepted facts. A supported release
  leaves the attempt open; it never opens a replacement attempt by itself.
- A steps release with no further work enforces Mission's evidence predicate.
  A steps release with further work returns the node to `Available`; the
  checkpoint/push obligations belong to the later Worker methods and are not
  performed by this command. Evidence submission is a later Mission operation;
  the release body contains no evidence, assessment, outcome or shell command.
- A reviewer release is supported only after the current passing assessment
  and the action-performer path allow it: returned items consist solely of
  submitted request evidence and actions awaiting prerequisites.
  Mission routes an admitted reviewer release to `External.Requested` and
  inserts a job only when the continuation condition holds. Assessment and
  request submission, the action-performer path, and assessment-driven claim
  completion belong to later plans. Under that design, a passing assessment
  with no required external action ends the claim without a fresh release.
- Mission checks the release predicate in the release transaction, before the
  terminal write, under [the release admission](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-release-admission).
  A release that fails it answers 409 `mission.release.obligation_unmet` with
  `details.obligation` of `evidence`, `assessment` or `request`, and it changes
  no execution, no node state and no job.
- Mission inserts the job of the node in the transaction that makes the node
  claimable, and that is the release itself when the node is claimable at once.
  No job exists while a node waits. The next compatible pull receives the
  continuation; there is no pushed assignment.

Success is HTTP `200` with required fields
`{ "execution_id": string, "ended_at": timestamp }`; the CLI adds its key.
The invocation chain proves a live execution before the handler. The release
transaction checks the claimant, null `ended_at` and time before `expired_at`
again; failure answers 409 `scheduler.execution.not_running`. Of two terminal
writes only one wins and routes Mission. A release retry after the end meets
the refusal of the proof; after a lost answer the holder reads `claim get`,
which shows `finished`. There is no stored release receipt. A lost claim
cannot release. This answer is not an outcome record or an assertion that the
node is immediately claimable.

There is no `failure`, `cannotProgress`, `retryBudget`, `force` or arbitrary
target-state field. Failure dispositions remain an open design gap under [HANDOFF Cannot progress](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#cannot-progress).

### Liveness, epochs and cancellation boundaries

The deadline of a running claim, Worker healthcheck, observed telemetry
progress and Mission readiness are separate facts. A healthcheck and silent
logs establish no live claim and no failed assessment. A provider outage authorizes no substitution
and creates no block condition by itself.

The live execution identity must match the node's current claim. Human pause,
discard and the applicable success override revoke the claim through Mission;
the revocation is accepted before a later operation's admission can read it.
Loss revokes authority at the expiry, not at a replacement claim.
Revocation before expiry is no loss; revocation of a lost claim takes effect
at the expiry. Both paths remove the execution from its claimant count.
Completion of an already-admitted remote operation belongs to Project's design
and the later action integration; revocation does not undo that operation.

The claim fixes `expired_at` at `created_at` plus effective `wall_time_ms` plus
1000 times `scheduler.release_reserve` (default 600 seconds); a sweep settles
expired unsettled rows every 30 seconds under the [Scheduler design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#liveness).
A claim, work-pull lookup, registration resume or Mission transition settles
an expired unsettled row before checking its own preconditions. Settlement is
part of that transaction and rolls back if the operation refuses. Under the
Worker design, an external execution learns of the end at its first refused
call and must abort then; the native abort behavior belongs to later Worker
methods. Server-hosted execution and its in-process abort are outside ERD 2.

Expiry is not proof that a runtime stopped. A stopped or revoked execution
must publish no later effect. Execution release enforces stale-claim refusal
now; later Mission/Project execution operations consume that same proof.
Physical stop and safe reuse remain an open design gap under [HANDOFF SC5](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service).
Inspection and cancellation make no stronger guarantee. There is no generic
Scheduler cancellation command: a transport cancel is not a release, and a
human pauses/discards through Mission.

## Delivery admission

This section describes the ERD 3 integration boundary; no delivery ingress or
admission path is implemented by Plan03.

The Intake Service receives every platform delivery and owns the delivery
record. Its inspection commands live in [Intake](./intake.md#event-commands).
The Mission Service owns the delivery admission operation that the Intake
Service calls, under [delivery admission and check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.md#delivery-admission-and-check).
The Scheduler holds no admission record, no observation obligation and no
observer. It serves a node after the Mission Service routes it.

### Delivery is an ingress operation, not a generic CLI mutation

No CLI `delivery submit` or end-state submit exists. A JSON file is not a
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
- **On-demand request (design only):** a server service may ask to serve an already-queued
  node to the next compatible pull ahead of order. The request owns no claim,
  waits boundedly for a claim and still obeys admission. No external authority
  or CLI operation is declared here; no ERD 2 service issues one and Plan03
  implements no on-demand request.
- **Wakeups and loss sweeps:** these are implemented Scheduler-owned processing.
  An idle project schedules no wakeup callback, a waiting pull holds no permit,
  and an execution holds no scheduling transaction. Processor-pool sizing and
  numeric fairness/latency bounds remain open design gaps.
  There is no public `tick`, `drain`, `force-release`, `declare-loss`,
  `reset-epoch` or `reset-budget`.
- **External action performance (later integration):** Worker derives action operands from the
  attempt and evidence, the Intake Service performs the action, and Mission
  owns the resulting records. It is not delivery admission or a queue write.
- **Human recovery and outcomes:** unblock, pause, resume, discard, priority
  and override belong to Mission's human authority path. Scheduler inspection
  and machine claim operations cannot take their place.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                   | Condition                                                                                                                                                                                                                                             | Commands                                        |
| ----- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| local | `cli.scheduler.queue.list.invalid_project_id`          | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                                                             | queue list                                      |
| local | `cli.scheduler.queue.peek.invalid_project_id`          | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                                                             | queue peek                                      |
| local | `cli.scheduler.eligibility.get.invalid_project_id`     | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                                                             | eligibility get                                 |
| local | `cli.scheduler.eligibility.get.invalid_node_id`        | The `<node-id>` argument is not a canonical `node_<ulid>` identity.                                                                                                                                                                                   | eligibility get                                 |
| local | `cli.scheduler.claim.get.invalid_execution_id`         | The `<execution-id>` argument is not a canonical `execution_<ulid>` identity.                                                                                                                                                                         | claim get                                       |
| local | `cli.scheduler.execution.get.invalid_execution_id`     | The `<execution-id>` argument is not a canonical `execution_<ulid>` identity.                                                                                                                                                                         | execution get                                   |
| local | `cli.scheduler.execution.release.invalid_execution_id` | The `<execution-id>` argument is not a canonical `execution_<ulid>` identity.                                                                                                                                                                         | execution release                               |
| local | `cli.scheduler.execution.list.invalid_project_id`      | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                                                             | execution list                                  |
| local | `cli.scheduler.execution.list.invalid_node_id`         | The `--node` value is not a canonical `node_<ulid>` identity.                                                                                                                                                                                         | execution list                                  |
| local | `cli.scheduler.execution.list.invalid_attempt`         | The `--attempt` value is not a positive safe integer.                                                                                                                                                                                                 | execution list                                  |
| 403   | `scheduler.work.claimant_mismatch`                     | The `resource_identity` or `runtime_identity` of the pull differs from the machine identity and its live registration.                                                                                                                                | work pull                                       |
| 404   | `scheduler.eligibility.node_not_found`                 | No node of the project holds the identity, or the project is absent.                                                                                                                                                                                  | eligibility get                                 |
| 400   | `scheduler.eligibility.node_task`                      | The node is a task, which is never a unit of scheduling; details `{ node_id }`.                                                                                                                                                                       | eligibility get                                 |
| 404   | `scheduler.execution.not_found`                        | No execution holds the identity.                                                                                                                                                                                                                      | claim get, execution get                        |
| 403   | `scheduler.execution.not_owner`                        | The client does not own the execution.                                                                                                                                                                                                                | claim get                                       |
| 409   | `scheduler.execution.not_running`                      | The execution is no longer running when its write transaction checks the proof.                                                                                                                                                                       | execution release, and every execution mutation |
| 409   | `mission.release.obligation_unmet`                     | The release predicate fails: a steps release with no further work lacks qualifying work evidence, or a reviewer release lacks a current passing assessment or has an eligible unrequested required action. `details.obligation` names the failed one. | execution release                               |
| local | `scheduler.lifecycle.stopped`                          | A stopped Scheduler Service cannot start again.                                                                                                                                                                                                       | serve server                                    |

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
