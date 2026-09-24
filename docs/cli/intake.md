# Intake Service CLI specification

This page specifies the future `kanthord intake` command group. Start with
[the CLI specification index](./README.md) and
[shared CLI conventions](./other.md). It is an engine contributor specification,
not a claim that these commands are available today.

## Status and scope

**Implemented, inspected 2026-09-24:** the
[CLI dispatcher](../../src/apps/cli/index.ts) registers no `intake` group at all,
not even help. There is no `src/intake/` implementation, Intake operation
contract, database initialization, or Intake OpenAPI document. The
[server composition](../../src/apps/server/index.ts) constructs Project, Worker,
and Gateway services only.

**Design requirements:** the Intake Service owns the subscription and the
delivery. It receives through a webhook, a poll or a stream and holds the
connection lifetime. It obtains acquisition material only through an acquisition
grant of the Project Service, keeps that material in memory for the session,
and persists none. A passive webhook needs no grant. The Intake Service is
never the verifier: it submits the body, headers and candidate source binding
to the Project Service for verification. It hands every delivery at least once
to the delivery admission operation of the Scheduler Service and performs no
business effect.

**Proposed:** every command below, every command spelling, operation identifier,
route, field name, response projection, HTTP status and numeric value in this
page's contract. Design vocabulary and ownership requirements constrain these
proposals; they do not establish an implemented wire contract.
Blocked contracts link their [HANDOFF items][intake-contract] and supply no implicit defaults. The dated source snapshot above is the only implemented claim.

[intake-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#intake-service
[intake-bounds]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery

## Command table

All names in this table are **Proposed**, all routes are remote, and all access
policies are `human`. The webhook receipt route has no CLI command and uses
`delivery`, as described under [Routes without a command](#routes-without-a-command).
Every authenticated human holds the same server-owner
authority over every source binding; the Intake Service adds no project-membership or role
model. A machine token authorizes no Intake command. An operation serves one
caller kind, so any future machine read needs a separate operation rather than
a second caller kind on these operations.

| Command after `kanthord intake`          | Proposed operation                                           | Proposed HTTP route                                     | Access  | Output and effects                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscription create`                    | `intake.subscription.create` **[blocked][intake-contract]**  | `POST /api/intake/subscription`                         | `human` | Mutation; creates one subscription per source binding and kind, or returns the existing subscription.                                          |
| `subscription list`                      | `intake.subscription.list` **[blocked][intake-contract]**    | `GET /api/intake/subscription`                          | `human` | Bounded page, optionally filtered by source binding and kind.                                                                                  |
| `subscription get <subscription-id>`     | `intake.subscription.get` **[blocked][intake-contract]**     | `GET /api/intake/subscription/:subscriptionId`          | `human` | Desired state, observed state and reason, kind, source binding and kind-specific state.                                                        |
| `subscription enable <subscription-id>`  | `intake.subscription.enable` **[blocked][intake-contract]**  | `POST /api/intake/subscription/:subscriptionId/enable`  | `human` | Mutation; records desired state `enabled` and returns the current observed state without waiting.                                              |
| `subscription disable <subscription-id>` | `intake.subscription.disable` **[blocked][intake-contract]** | `POST /api/intake/subscription/:subscriptionId/disable` | `human` | Mutation; records desired state `disabled` and returns the current observed state without waiting.                                             |
| `subscription retire <subscription-id>`  | `intake.subscription.retire` **[blocked][intake-contract]**  | `POST /api/intake/subscription/:subscriptionId/retire`  | `human` | Mutation; records retirement, with observed state moving through `retiring`; preserves kind-specific state for the audit.                      |
| `delivery list`                          | `intake.delivery.list` **[blocked][intake-contract]**        | `GET /api/intake/delivery`                              | `human` | Bounded page, optionally filtered by subscription and delivery status.                                                                         |
| `delivery get <delivery-id>`             | `intake.delivery.get` **[blocked][intake-contract]**         | `GET /api/intake/delivery/:deliveryId`                  | `human` | One delivery and its verification result, handoff progress and recorded disposition; payload inclusion remains **[blocked][intake-contract]**. |

Every command declares a `unary` lifetime: one request and one answer. A
subscription of kind `stream` does not turn its management command into a
streaming operation. The Intake Service holds the acquisition connection, not
the CLI. The create, enable, disable and retire operations declare
`mutation: true`; lists and gets declare `mutation: false`.

## Synopses

The markers `[R]`, `[M]` and `[L]` use the
[common synopsis definitions](./common-flags.md#synopsis-markers). They are
notation, not literal arguments.

```text
kanthord intake subscription create --file <path> [M] [R]
```

```text
kanthord intake subscription list [--source-binding <id>] [--kind <kind>] [L] [R]
```

```text
kanthord intake subscription get <subscription-id> [R]
```

```text
kanthord intake subscription enable <subscription-id> [M] [R]
```

```text
kanthord intake subscription disable <subscription-id> [M] [R]
```

```text
kanthord intake subscription retire <subscription-id> [M] [R]
```

```text
kanthord intake delivery list [--subscription <id>] [--status <delivery-status>] [L] [R]
```

```text
kanthord intake delivery get <delivery-id> [R]
```

Every group and leaf supports help without a server or credential. Proposed
commands reject unknown arguments and options, missing required values, and
`--config` before work. They read no prompt or implicit standard input. There
is no `poll now`, `stream reconnect`, `delivery retry`, or `delivery ack` command.

## Shared arguments, flags, and scalar types

Shared syntax, types, defaults and validation belong to the linked flag
headings. Intake-specific applicability and requirements are:

| Common flag                                                                      | Applies to / Intake requirement                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every remote command.                                                                                                                                               |
| [`--token`](./common-flags.md#--token)                                           | Every command requires a resolved human JWT; reject a missing or blank token before dispatch. A machine token authorizes no Intake command. Help requires no token. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                                                                                               |
| [`--file`](./common-flags.md#--file)                                             | Required on `subscription create` only; the proposed schema appears below.                                                                                          |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Create, enable, disable and retire only.                                                                                                                            |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | The subscription and delivery lists only.                                                                                                                           |

| Argument or flag             | Requiredness and type                                              | Default                          | Validation and request mapping                                                                                       |
| ---------------------------- | ------------------------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `<subscription-id>`          | Required subscription identity on get, enable, disable and retire. | None                             | Map to `params.subscriptionId`. Prefix validation remains **[blocked][intake-contract]**.                            |
| `<delivery-id>`              | Required delivery identity on get.                                 | None                             | Map to `params.deliveryId`; this names an Intake delivery. Prefix validation remains **[blocked][intake-contract]**. |
| `--source-binding <id>`      | Optional source binding identity on `subscription list`.           | Absent: no source binding filter | Send `query.sourceBindingId`; Project owns the prefix declaration.                                                   |
| `--kind <kind>`              | Optional subscription kind on `subscription list`.                 | Absent: all kinds                | Send `query.kind`; closed set `webhook`, `poll`, `stream`.                                                           |
| `--subscription <id>`        | Optional subscription identity on `delivery list`.                 | Absent: no subscription filter   | Send `query.subscriptionId`; use the subscription identity scalar.                                                   |
| `--status <delivery-status>` | Optional delivery status on `delivery list`.                       | Absent: all statuses             | Send `query.status`; closed set `pending`, `dispatched`, `accepted`, `refused`, `parked`.                            |

Supplied filters combine by AND. A filter grants no authority. An omitted
optional filter stays absent rather than becoming `null`. The commands follow
[client-file rules](./other.md#cliyaml-and-its-effects), open no server database,
and change no client or server configuration.

### Identity and scalar validation

Opaque entity identities have the form `<prefix>_<ulid>`. Validation uses the
[shared identity scalar](../../src/kernel/identity.ts) and checks the exact
entity prefix and canonical uppercase ULID; a bare ULID or another kind's
prefix is invalid.
Subscription and delivery prefixes remain **blocked** under [HANDOFF Intake Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#intake-service).
A source binding uses `binding_<ulid>` under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).

A platform delivery identity and a webhook registration identity retain their
protocol-defined representations, not an invented entity prefix. Checkpoint
and resume position representations remain **[blocked][intake-contract]**. Received time follows the
[shared identity and time rules](./other.md#shared-identity-and-time-rules).
Handoff attempt count is a nonnegative safe JSON integer. Neither received time
nor a ULID establishes causal order.

The closed desired state set is `enabled`, `disabled`. The closed observed
state set is `inactive`, `registering`, `active`, `failed`, `retiring`. Delivery
status is separate from disposition. The Scheduler disposition values are
exactly `accepted as an observation`, `accepted as a human act`, `refused`,
`duplicate`; no fifth value follows from this proposal.

### Proposed create file schema

The file supplies the request body, with no path or query parameters. The
shared file rules apply. The adopted schema must be closed, including each
kind-specific object; its missing field names block implementation rather than
permit arbitrary JSON.

| File field           | Requiredness and type                                     | Default                        | Validation and meaning                                                                                                                                                         |
| -------------------- | --------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sourceBindingId`    | Required source binding identity.                         | None                           | Must resolve to a source binding of the Project Service. The binding determines the project.                                                                                   |
| `kind`               | Required enum string.                                     | None                           | Closed set `webhook`, `poll`, `stream`; selects the acquisition kind.                                                                                                          |
| `desiredState`       | Optional enum string                                      | **[blocked][intake-contract]** | Closed set `enabled`, `disabled`; omission and disabled-source admission await the state contract.                                                                             |
| Kind-specific object | Object selected by `kind`; **[blocked][intake-contract]** | No implicit endpoint or target | The poll interval is 60 seconds. Other configuration fields remain **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#intake-service)**. |

The file accepts no credential, acquisition grant, verification secret,
verification result, observed state, checkpoint, resume position, platform
registration identity, or arbitrary consumer operation. The Project Service
owns custody and grant issuance. Every delivery goes to the delivery admission
of the Scheduler Service; a subscription names no consumer. Adding a consumer
needs a design revision of `intake-service.md`.

## Subscription commands

All request and response shapes and HTTP statuses in this section are
**Proposed**. Mutations return after recording their own effect, not after
acquisition succeeds. The subscription read projection contains
`subscriptionId`, `sourceBindingId`, `kind`, `desiredState`, `observedState`, and
`observedStateReason`. The kind-specific state contains `registrationIdentity` for a webhook, `checkpoint` for a poll, or `resumePosition` for a stream.
Reason and protocol state schemas remain **[blocked][intake-contract]**; they expose no acquisition material.

### `subscription create`

**Request and validation:** send the file object described above. Validate the
source binding and the kind-specific configuration before creating the record.
Desired-state omission and disabled-source admission remain **[blocked][intake-contract]**.

**Effects and idempotency:** create one subscription for one source binding and
one subscription kind. The pair is the proposed natural key, following the
[architecture rule that every mutation handler is idempotent by a natural key](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-operation-and-its-two-entry-adapters)
and the [design rule of at most one subscription per kind per source binding](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.md#subscriptions).
**Proposed:** a repeat returns the existing subscription; it creates no second
subscription and changes no configuration
or desired state. Enable and disable remain explicit commands.
For a newly created enabled subscription, the reconciler obtains any required
acquisition grant and registers or opens the acquisition afterwards.

**Response and statuses:** return the subscription projection with HTTP `201`
for creation or `200` for the existing subscription. Invalid fields receive
`400`; an unknown source binding receives `404`.
Disabled-source and incompatible-create statuses remain **[blocked][intake-contract]**. Shared authentication and replay failures apply below.

### `subscription list`

**Request and validation:** no body or positional argument. Accept only the
source binding and kind filters and shared pagination. Validate identities,
closed-set values and the cursor format; the filters select stored subscriptions,
not live acquisitions alone.

**Effects and idempotency:** read one bounded page and change nothing. Return
`{items, nextCursor}` using the subscription projection; the
[pagination conventions](./other.md#pagination) apply. This read takes no
idempotency key. The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) applies.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.
An empty result means no matching stored subscriptions, not a failed request.

### `subscription get <subscription-id>`

**Request and validation:** map the required identity to `params.subscriptionId`;
accept no query or body. Validate its exact entity kind and existence.

**Effects and idempotency:** read one subscription projection, including desired
state, observed state with its reason, kind, source binding, and its registration
identity, checkpoint or resume position. It changes nothing and takes no
idempotency key. The result reports current recorded state, not a promise that
an acquisition stays active after the read.

**Statuses:** `200` with the subscription, `400` for an invalid identity, or
`404` for an unknown subscription.

### `subscription enable <subscription-id>`

**Request and validation:** use `params.subscriptionId`, with no query or body.
Validate the identity and subscription.
Disabled-source admission remains **[blocked][intake-contract]**.

**Effects and idempotency:** set desired state to `enabled` and return at once
with the recorded desired state and current observed state. The command never
waits for the observed state. A repeat invocation with the same
`--idempotency-key` returns the recorded answer within the process-local replay
TTL. A new invocation without a replayed key records the requested desired
state even when it equals the current one. The reconciler does nothing when
nothing changed; otherwise it moves observed state afterwards. A fresh enable
after a disable records `enabled`, rather than replaying an earlier enable.
A recorded answer is not proof that acquisition has since succeeded; get reads
the latest state.

**Statuses:** `200` with `subscriptionId`, `desiredState`, `observedState` and
`observedStateReason`; `400` for invalid input; `404` for an unknown subscription.
Disabled-source status remains **[blocked][intake-contract]**.

### `subscription disable <subscription-id>`

**Request and validation:** use `params.subscriptionId`, with no query or body.
Validate the identity and subscription. Disabling requires no enabled source
binding.

**Effects and idempotency:** set desired state to `disabled` and return at once
with the recorded desired state and current observed state. The command never
waits for the observed state. A repeat invocation with the same
`--idempotency-key` returns the recorded answer within the process-local replay
TTL. A new invocation without a replayed key records the requested desired
state even when it equals the current one. The reconciler does nothing when
nothing changed. When disabling changes the state, the reconciler deregisters
a webhook and keeps its registration identity,
keeps a poll checkpoint, and closes a stream. Kind-specific state survives the
disable, including the stream resume position.

**Statuses:** `200` with the same response fields as enable, `400` for invalid
input, or `404` for an unknown subscription. A successful command records the
desired state; it does not establish completion of remote deregistration.

### `subscription retire <subscription-id>`

**Request and validation:** use `params.subscriptionId`, with no query or body.
Validate the identity and subscription. No force, purge or replacement
subscription option exists.

**Effects and idempotency:** record retirement once, naturally keyed by the
subscription identity. A repeat returns the recorded retirement answer rather
than starting retirement again. Observed state moves through `retiring`. A
retired subscription keeps its registration identity, checkpoint or resume
position for the audit; retirement deletes neither those records nor unresolved
deliveries. The command does not wait for platform cleanup.

**Statuses:** `200` with the subscription projection, `400` for invalid input,
or `404` for an unknown subscription. Retirement semantics remain **[blocked][intake-contract]**.
There is no invented `retired` observed state in the closed set.

### Reconciler and acquisition grant boundary

The reconciler moves observed state toward desired state, never the reverse.
Enabling obtains any required acquisition grant and registers or opens the
acquisition; successful enabling sets observed state `active`. An uncertain
registration result requires a read of platform registrations before any retry,
so a lost answer creates no second registration. A poll checkpoint advances
only with the commit that stores every delivery of the batch.

The Intake Service calls `project.acquisition_grant` through the direct adapter with its own service identity and the `service` policy.
Grant kinds are `webhook-register`, `poll` and `stream-open`; they differ from the subscription kind enum.
A grant serves one subscription session and has a maximum lifetime of 24 hours.
Session end, binding disablement or removal, credential rotation and expiry end the grant.
The [acquisition grant ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-acquisition-grant) owns its record and revocation.
The reconciler holds the grant and material in memory and calls `project.acquisition_grant_end` when the session ends.
Project calls `intake.grant_revoked` with `service` access; the handler closes acquisition, drops material and answers 204.
The [Intake acquisition ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.impl.md#the-acquisition-grant) governs the next reconciliation.

A revoked grant makes the Intake Service close the acquisition at once and set
observed state `failed` with a reason. Revocation for source binding disablement
disables every subscription under that binding. The CLI cannot override the
grant or reset the observed state.
The composition root mints the service identity; direct calls carry it in `ClientOptions.identity`.
The [service identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.impl.md#the-service-identity) grants no human impersonation.

## Delivery commands

These **Proposed** reads inspect Intake-owned handoff progress. They create no
Scheduler obligation and perform no business effect. The delivery projection
contains `deliveryId`, `subscriptionId`, `platformDeliveryId`, `receivedAt`,
`verificationResult`, `status`, `disposition`, and `handoffAttemptCount`.
Delivery schemas and payload inclusion remain **[blocked][intake-contract]**.
The list returns metadata only. No output contains a credential.

### `delivery list`

**Request and validation:** no positional argument or body. Accept the
subscription and delivery status filters and shared pagination. Validate the
subscription identity, the closed delivery status set and the cursor format.

**Effects and idempotency:** return one bounded `{items, nextCursor}` page of
delivery projections. Read only; take no idempotency key. Parked deliveries
remain visible; filtering does not retry or acknowledge one. The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) applies; read bounds remain **[blocked][intake-bounds]**.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.
No transport failure becomes an empty successful page.

### `delivery get <delivery-id>`

**Request and validation:** map the required Intake delivery identity to
`params.deliveryId`; accept no query or body. A platform delivery identity is
not a substitute for that identity.

**Effects and idempotency:** return the subscription, platform delivery identity,
received time, verification result, delivery status, recorded disposition and
handoff attempt count in the delivery projection. The subscription resolves
its source binding and exactly one project. Read only; take no idempotency key.
Payload inclusion remains **[blocked][intake-contract]**.

**Statuses:** `200` with the delivery, `400` for an invalid identity, or `404`
with `intake.delivery.not_found` when no retained delivery has that identity.
The read does not promise indefinite retention of resolved deliveries.

### Handoff and disposition

The Intake Service deduplicates by subscription and platform delivery identity.
It hands every delivery at least once to Scheduler delivery admission, a unary
operation that records its decision durably before answering. A repeat carries
the same delivery identity and content; admission returns its recorded
disposition. Different content under the same identity receives a refusal.
Scheduler owns effect deduplication across subscription kinds and redeliveries.

Acceptance as an observation or as a human act, and duplication, end the
handoff. A refusal also ends it and remains visible to a human. The Intake
Service retries a declared failure or an indeterminate result with backoff;
a terminal `refused` disposition is not a transient invocation failure. After
a bounded count of failed attempts, it parks the delivery. A parked delivery
never expires.
A human action on a parked delivery remains **[blocked][intake-contract]**; handoff bounds remain **[blocked][intake-bounds]**. After acceptance, the Intake Service asks nothing further about the delivery.

Acceptance transfers every effect obligation to Scheduler; it promises no
execution and needs no live worker. Scheduler invokes Worker payload decoding
and resolves effects; the Intake Service interprets no payload for business meaning.
Acceptance as a human act uses the linked human identity through Mission.
A platform signature itself grants no authority to create nodes, write WHAT,
unblock, execute or override. The
[HANDOFF inbound request contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery)
still defers new work arriving through a source such as Slack. Its parked
recommendation is not an adopted fifth disposition or a CLI command.

## Routes without a command

The webhook receipt uses `POST /hooks/<binding id>` under the [delivery verification ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-verification-of-a-delivery). The route uses access policy `delivery`,
as declared by [Gateway access policy](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#access-policy).
`delivery` means no JWT and verification by the Project Service with the
secret of the source binding named in the path; it mints no human or machine
caller. The Intake Service never acts as verifier; its webhook registration uses the secret that the acquisition grant returns.
The Gateway handler reads the exact bytes and passes the body and headers
unchanged to the Intake Service, following
[Delivery bytes and body limits](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#delivery-bytes-and-body-limits).

The order is verification, then durable storage, then acknowledgement to the
platform. A stream message follows the same order. The Intake Service acknowledges only
what it stores durably. Beyond the unresolved-delivery capacity bound, the
webhook receives a retryable refusal, never an acknowledgement followed by a
drop. Receipt statuses and protocol headers remain **[blocked][intake-contract]**.
The [Gateway body limit](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#delivery-bytes-and-body-limits) is 50 MiB for a delivery operation. No CLI command calls the receipt route or simulates
a platform signature with a human JWT.

A poll and a stream have no receipt route because the Intake Service initiates
them. A poll pauses beyond capacity. A stream closes beyond capacity with
observed state `failed` and reason capacity. The Intake Service never removes an unresolved
delivery and bounds retention of resolved deliveries. It promises durability
for accepted deliveries, not receipt of every update a platform produces.

The [Gateway delivery ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#delivery-bytes-and-body-limits) requires `/hooks/*` support and exact bytes without JSON validation.
Receipt implementation remains **blocked** under the [HANDOFF Intake Service item](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#intake-service).

The receipt operation and verification failure contract remain **[blocked][intake-contract]**.
Scheduler delivery admission is a separate service operation, not this
platform-facing route or a CLI submit command.

## Output and failure conventions

The commands follow [shared output and exit behavior](./other.md#output-and-exit-behavior):
one machine-readable JSON value on standard output and concise diagnostics on
standard error. Proposed successful commands exit `0`; local input, file,
authentication, transport and operation failures exit `1`. A successful delivery
read can report `refused` or `parked` without failing the read. A successful
subscription mutation does not assert observed state `active` or completed
cleanup.

Mutation results include the effective `idempotencyKey`; safe failure and
indeterminate diagnostics expose it for explicit reuse. The
[shared retry rules](./other.md#idempotency-and-retries) apply. Invocation replay
is in memory within one process and its TTL, not durable domain recovery.
Natural-key idempotency remains necessary after restart or expiry. CLI commands
perform no automatic retry; the Intake Service's handoff backoff is separate.
Cancellation ends the client wait and undoes no committed desired state,
retirement or delivery. Preserve `Completed`, `Failure` and `Indeterminate`
rather than claiming rollback after a lost answer.

All commands propose HTTP `401` for missing, invalid or wrong-kind credentials;
a machine token never reaches these human handlers. Mutation replay conflicts
use `409`. Command sections name domain statuses; the owning contracts still
need complete error schemas and timeout mappings. Diagnostics preserve the
server's code and request identity when available, never a token, verification
secret, acquisition material or raw delivery payload.

Error codes follow the architecture rule
`<namespace>.<component>[.<component>...].<error>`: at least three nonempty
parts, lower-case words with underscores within a part, and the owning service
as namespace. Proposed Intake codes are:

| Proposed code                                 | Condition and status                                                                                                                                                                                  |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intake.subscription.duplicate_kind`          | A uniqueness conflict on source binding and kind, proposed `409`; ordinary natural-key repeats return the existing subscription. Incompatible-input admission remains **[blocked][intake-contract]**. |
| `intake.subscription.source_binding_disabled` | Disabled-source admission remains **[blocked][intake-contract]**.                                                                                                                                     |
| `intake.delivery.not_found`                   | No retained Intake delivery matches the get identity; proposed `404`.                                                                                                                                 |

## Optional design provenance

The rules needed to read this page appear above. These links record their
origin and are not required local files in a standalone engine checkout:

- [Intake design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.md)
- [Intake vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.vocabulary.md)
- [Scheduler delivery admission and observation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#delivery-admission-and-observation)
- [Project authorization and credential custody](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.md#authorization-and-credential-custody)
- [Acquisition grant](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.vocabulary.md#acquisition-grant)
  and [source binding](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.vocabulary.md#source-binding)
- [Gateway human authority](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.md#human-authority)
- [Gateway implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md)
- [Architecture implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
- [Open-work handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md)
