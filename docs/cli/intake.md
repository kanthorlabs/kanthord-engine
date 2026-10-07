# Intake Service CLI specification

This page specifies the future `kanthord intake` command group. Start with
[the CLI specification index](./README.md) and
[shared CLI conventions](./other.md). It is an engine contributor specification,
not a claim that these commands are available today.

## Status and scope

**Implemented, inspected 2026-10-02:** the
[CLI dispatcher](../../src/apps/cli/index.ts) registers no `intake` group at all,
not even help. There is no `src/intake/` implementation, Intake operation
contract, database initialization, or Intake OpenAPI document.

**Design requirements:** the Intake Service owns the inbound and the inbound
event. An inbound receives through a webhook or a poll. A human creates an
inbound to start its acquisition and deletes it to stop; no field of its
configuration changes after the insert. The create validates before the
insert: a poll performs one request. A webhook names no credential, kanthord
calls no platform for it, and a human sets its address and secret at the
platform. The Intake Service verifies a webhook event with a secret that it
derives from `master_key` and the inbound identity. It hands a pending event
over once to the delivery admission operation of the Mission Service and
retries nothing by itself. A human retries, discards and deletes events. The
Intake Service also performs every outbound operation and check on a platform
for the service that owns its effect, and it decides no business meaning. It
records each outbound write as an outbound request before the call, and a
human lists, reads, discards and deletes outbound requests.

**Proposed:** every command below, every command spelling, operation identifier,
route, field name, response projection and HTTP status that the
[Intake design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.md)
and its [implementation sibling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.impl.md)
do not name. Blocked contracts link their [HANDOFF items][intake-contract] and
supply no implicit defaults. The dated source snapshot above is the only
implemented claim.

[intake-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#intake-service
[intake-bounds]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery

## Command table

All routes are remote, and all access policies are `human`. The webhook
receipt route has no CLI command and uses the `delivery` policy, as described
under [Routes without a command](#routes-without-a-command). Every
authenticated human holds the same server-owner authority over every inbound;
the Intake Service adds no project-membership or role model. A machine token
authorizes no Intake command.

| Command after `kanthord intake`          | Operation                         | Proposed HTTP route                                    | Access  | Output and effects                                                                                       |
| ---------------------------------------- | --------------------------------- | ------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `inbound create`                         | `intake.inbound.create`           | `POST /api/intake/inbound`                             | `human` | Mutation; validates at the platform, then inserts one inbound.                                           |
| `inbound list`                           | `intake.inbound.list`             | `GET /api/intake/inbound`                              | `human` | Bounded page, optionally filtered by project, kind and platform.                                         |
| `inbound get <inbound-id>`               | `intake.inbound.get`              | `GET /api/intake/inbound/:inboundId`                   | `human` | One inbound; for a webhook, its address and its secret, whose display is **[blocked][intake-contract]**. |
| `inbound delete <inbound-id>`            | `intake.inbound.delete`           | `DELETE /api/intake/inbound/:inboundId`                | `human` | Mutation; deletes the inbound and its events, and calls no platform.                                     |
| `event list`                             | `intake.inbound.event.list`       | `GET /api/intake/event`                                | `human` | Bounded page, optionally filtered by inbound and state.                                                  |
| `event get <inbound-event-id>`           | `intake.inbound.event.get`        | `GET /api/intake/event/:inboundEventId`                | `human` | One event with its state and errors; content inclusion is **[blocked][intake-contract]**.                |
| `event retry <inbound-event-id>`         | `intake.inbound.event.retry`      | `POST /api/intake/event/:inboundEventId/retry`         | `human` | Mutation; turns a failed event back to `pending`.                                                        |
| `event discard <inbound-event-id>`       | `intake.inbound.event.discard`    | `POST /api/intake/event/:inboundEventId/discard`       | `human` | Mutation; turns a pending or a failed event to `discarded`.                                              |
| `event delete`                           | `intake.inbound.event.delete`     | `POST /api/intake/event/delete`                        | `human` | Mutation; deletes the succeeded, failed and discarded events that a filter names.                        |
| `outbound list`                          | `intake.outbound.request.list`    | `GET /api/intake/outbound`                             | `human` | Bounded page, optionally filtered by project, state and operation.                                       |
| `outbound get <outbound-request-id>`     | `intake.outbound.request.get`     | `GET /api/intake/outbound/:outboundRequestId`          | `human` | One outbound request with its state, result and errors.                                                  |
| `outbound discard <outbound-request-id>` | `intake.outbound.request.discard` | `POST /api/intake/outbound/:outboundRequestId/discard` | `human` | Mutation; turns a pending request with no running call to `discarded`.                                   |
| `outbound delete`                        | `intake.outbound.request.delete`  | `POST /api/intake/outbound/delete`                     | `human` | Mutation with `--force`; deletes the succeeded, failed and discarded requests that a filter names.       |

Every command declares a `unary` lifetime: one request and one answer. The
create, delete, retry, discard, event delete, outbound discard and outbound
delete operations declare `mutation: true`; lists and gets declare
`mutation: false`.

## Synopses

The markers `[R]`, `[M]` and `[L]` use the
[common synopsis definitions](./common-flags.md#synopsis-markers). They are
notation, not literal arguments.

```text
kanthord intake inbound create --file <path> [M] [R]
```

```text
kanthord intake inbound list [--project <id>] [--kind <kind>] [--platform <platform>] [L] [R]
```

```text
kanthord intake inbound get <inbound-id> [R]
```

```text
kanthord intake inbound delete <inbound-id> [M] [R]
```

```text
kanthord intake event list [--inbound <id>] [--state <state>] [L] [R]
```

```text
kanthord intake event get <inbound-event-id> [R]
```

```text
kanthord intake event retry <inbound-event-id> [M] [R]
```

```text
kanthord intake event discard <inbound-event-id> [M] [R]
```

```text
kanthord intake event delete (--state <state> --from <inbound-event-id> --to <inbound-event-id> | --id <inbound-event-id> ...) [M] [R]
```

```text
kanthord intake outbound list [--project <id>] [--state <state>] [--operation <operation>] [L] [R]
```

```text
kanthord intake outbound get <outbound-request-id> [R]
```

```text
kanthord intake outbound discard <outbound-request-id> [M] [R]
```

```text
kanthord intake outbound delete --force (--state <state> --from <outbound-request-id> --to <outbound-request-id> | --id <outbound-request-id> ...) [M] [R]
```

Every group and leaf supports help without a server or credential. The
commands reject unknown arguments and options, missing required values, and
`--config` before work. They read no prompt or implicit standard input. There
is no `inbound update`, `inbound enable`, `inbound disable`, `poll now` or
`event ack` command.

## Shared arguments, flags, and scalar types

| Common flag                                                                      | Applies to / Intake requirement                                                                                                                                     |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every remote command.                                                                                                                                               |
| [`--token`](./common-flags.md#--token)                                           | Every command requires a resolved human JWT; reject a missing or blank token before dispatch. A machine token authorizes no Intake command. Help requires no token. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                                                                                               |
| [`--file`](./common-flags.md#--file)                                             | Required on `inbound create` only; the schema appears below.                                                                                                        |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Every mutation.                                                                                                                                                     |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | The inbound, event and outbound lists only.                                                                                                                         |
| [`--force`](./common-flags.md#--force)                                           | Required on `outbound delete` only. It accepts that a repeat of a deleted request key calls the write again.                                                        |

| Argument or flag                                           | Requiredness and type                                                                | Default                      | Validation and request mapping                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `<inbound-id>`                                             | Required inbound identity on get and delete.                                         | None                         | Map to `params.inboundId`. Prefix `inbound_`.                                                    |
| `<inbound-event-id>`                                       | Required inbound event identity on get, retry and discard.                           | None                         | Map to `params.inboundEventId`. Prefix `inbound_event_`.                                         |
| `--project <id>`                                           | Optional project identity on `inbound list`.                                         | Absent: no project filter    | Send `query.projectId`; Project owns the prefix declaration.                                     |
| `--kind <kind>`                                            | Optional inbound kind on `inbound list`.                                             | Absent: all kinds            | Send `query.kind`; closed set `webhook`, `poll`.                                                 |
| `--platform <platform>`                                    | Optional platform on `inbound list`.                                                 | Absent: all platforms        | Send `query.platform`; closed set of supported platforms, today `github`.                        |
| `--inbound <id>`                                           | Optional inbound identity on `event list`.                                           | Absent: no inbound filter    | Send `query.inboundId`.                                                                          |
| `--state <state>`                                          | Optional on `event list`; required with `--from` and `--to` on `event delete`.       | Absent on a list: all states | Send `query.state` or `body.state`; closed set `pending`, `succeeded`, `failed`, `discarded`.    |
| `--from`, `--to`                                           | Required together with `--state` on `event delete`.                                  | None                         | Send `body.from` and `body.to`, an inclusive range of inbound event identities.                  |
| `--id <inbound-event-id>`                                  | Repeatable on `event delete`; excludes `--state`, `--from` and `--to`.               | None                         | Send `body.ids`, a nonempty list. Its bound is **[blocked][intake-bounds]**.                     |
| `<outbound-request-id>`                                    | Required outbound request identity on `outbound get` and `outbound discard`.         | None                         | Map to `params.outboundRequestId`. Prefix `outbound_request_`.                                   |
| `--project <id>` on `outbound list`                        | Optional project identity.                                                           | Absent: no project filter    | Send `query.projectId`.                                                                          |
| `--state <state>` on `outbound list` and `outbound delete` | Optional on `outbound list`; required with `--from` and `--to` on `outbound delete`. | Absent on a list: all states | Send `query.state` or `body.state`; closed set `pending`, `succeeded`, `failed`, `discarded`.    |
| `--operation <operation>`                                  | Optional on `outbound list`.                                                         | Absent: all operations       | Send `query.operation`; closed set `github.pull_request`, `git.merge_push`, `s3.delete_object`.  |
| `--from`, `--to` on `outbound delete`                      | Required together with `--state`.                                                    | None                         | Send `body.from` and `body.to`, an inclusive range of outbound request identities.               |
| `--id <outbound-request-id>`                               | Repeatable on `outbound delete`; excludes `--state`, `--from` and `--to`.            | None                         | Send `body.ids`, a nonempty list. Its bound is **[blocked][intake-bounds]**.                     |
| `--force` on `outbound delete`                             | Required boolean switch.                                                             | `false`                      | Send `body.force`. Without it the server answers `400` `intake.outbound.request.force_required`. |

Supplied list filters combine by AND. A filter grants no authority. An omitted
optional filter stays absent rather than becoming `null`. The commands follow
[client-file rules](./other.md#cliyaml-and-its-effects), open no server database,
and change no client or server configuration.

### Identity and scalar validation

Opaque entity identities have the form `<prefix>_<ulid>`. Validation uses the
[shared identity scalar](../../src/kernel/identity.ts) and checks the exact
entity prefix and canonical uppercase ULID; a bare ULID or another kind's
prefix is invalid. The inbound prefix is `inbound_`, and the inbound event
prefix is `inbound_event_`.

A platform event identity keeps its
platform-defined representation, not an invented entity prefix. Creation time
follows the [shared identity and time rules](./other.md#shared-identity-and-time-rules).
The closed inbound event state set is `pending`, `succeeded`, `failed`,
`discarded`. The state records the outcome of the handoff; the disposition of
the Mission Service stays in the span of its admission.

### Create file schema

The file supplies the request body, with no path or query parameters. The
shared file rules apply. The schema is closed.

| File field      | Requiredness and type                             | Default | Validation and meaning                                                                                                                                                              |
| --------------- | ------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectId`     | Required project identity.                        | None    | Must name a project of the Project Service.                                                                                                                                         |
| `kind`          | Required enum string.                             | None    | Closed set `webhook`, `poll`.                                                                                                                                                       |
| `platform`      | Required enum string.                             | None    | Closed set of supported platforms, today `github`.                                                                                                                                  |
| `consumer`      | Required enum string.                             | None    | Closed set of admission operations, today `mission.delivery.admit`.                                                                                                                 |
| `credential`    | Credential name string, or absent.                | Absent  | Required for a poll, refused for a webhook. The name must exist, and its platform must suit `platform`.                                                                             |
| `configuration` | Required object, validated per kind and platform. | None    | Holds `resource` and the options of the kind and the platform. Every property name is snake_case, the stored form. Every field beyond `resource` is **[blocked][intake-contract]**. |

The file accepts no verification secret, checkpoint,
state, error or arbitrary consumer operation.

## Inbound commands

The inbound read projection contains `id`, `projectId`, `kind`, `platform`,
`consumer`, `credential`, `configuration`, `checkpoint` and
`createdAt`. It exposes no credential material.

### `inbound create`

**Request and validation:** send the file object described above. Validate
the fields and the configuration schema, then perform the remote validation of
the kind: one request for a poll, nothing for a webhook. The insert
transaction checks the credential name and its platform.

**Effects and idempotency:** a success inserts exactly one inbound. A platform
refusal inserts nothing.
A repeat with the same `--idempotency-key` returns the recorded answer within
the process-local replay TTL. A new invocation creates another inbound: no
natural key prevents a duplicate, because a duplicate serves a rotation.

**Statuses:** `201` with the inbound projection; `400` for invalid input;
`404` `intake.inbound.project_not_found` for an unknown project; `422`
`intake.inbound.credential_invalid` for an unknown or unsuitable credential;
`422` `intake.inbound.platform_refused` when the platform refuses the
first request of a poll.

### `inbound list`

**Request and validation:** no body or positional argument. Accept the project,
kind and platform filters and shared pagination.

**Effects and idempotency:** read one bounded `{ items, next_cursor }` page and
change nothing. The [pagination conventions](./other.md#pagination) and the
shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) apply.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.

### `inbound get <inbound-id>`

**Request and validation:** map the identity to `params.inboundId`; accept no
query or body.

**Effects and idempotency:** read one inbound projection. For a webhook it
also returns the address `/hooks/<inbound id>` and the secret. A `GET` is no
mutation, so the idempotency middleware records no secret. The display,
redaction and cache contract of the secret remains **[blocked][intake-contract]**.

**Statuses:** `200`; `400` for an invalid identity; `404`
`intake.inbound.not_found` for an unknown inbound.

### `inbound delete <inbound-id>`

**Request and validation:** use `params.inboundId`, with no query or body.

**Effects and idempotency:** refuse while the inbound holds a pending event.
Otherwise one transaction deletes the events of the inbound and the inbound.
The delete calls no platform; a human removes a webhook at the platform. A
repeat after a success answers `404`.

**Statuses:** `204`; `400` for an invalid identity; `404`
`intake.inbound.not_found`; `409` `intake.inbound.events_pending` while a
pending event exists.

## Event commands

The event read projection contains `id`, `inboundId`, `eventId`, `metadata`,
`state`, `error` and `createdAt`. Content inclusion and its size and redaction
remain **[blocked][intake-contract]**. No output contains a credential.
Each item of `error` holds `{ code, message, created_at }`. `code` is the error
code of a declared failure of the consumer, or `indeterminate` when the handoff
ends with no answer.

### `event list`

**Request and validation:** no positional argument or body. Accept the inbound
and state filters and shared pagination.

**Effects and idempotency:** return one bounded `{ items, next_cursor }` page.
Read only. Read bounds remain **[blocked][intake-bounds]**.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.

### `event get <inbound-event-id>`

**Request and validation:** map the identity to `params.inboundEventId`. A
platform event identity is not a substitute for that identity.

**Effects and idempotency:** return one event projection. Read only.

**Statuses:** `200`; `400` for an invalid identity; `404`
`intake.inbound.event.not_found`.

### `event retry <inbound-event-id>`

**Effects and idempotency:** turn a `failed` event to `pending`, so the
dispatcher hands it over once more. A `pending` event answers its current
state. Every write is conditional on the expected state.

**Statuses:** `200` with the event projection; `404`
`intake.inbound.event.not_found`; `409` `intake.inbound.event.state_conflict`
for a `succeeded` or a `discarded` event.

### `event discard <inbound-event-id>`

**Effects and idempotency:** turn a `pending` or a `failed` event to
`discarded`, which is terminal. The dispatcher hands over no discarded event.

**Statuses:** `200` with the event projection; `404`
`intake.inbound.event.not_found`; `409` `intake.inbound.event.in_flight` while
the handoff of a pending event runs; `409` `intake.inbound.event.state_conflict`
for a `succeeded` or a `discarded` event.

### `event delete`

**Request and validation:** send `{ state, from, to }` or `{ ids }`. A body
with neither form, with both forms or with the state `pending` answers `400`
`intake.inbound.event.filter_invalid`.

**Effects and idempotency:** one transaction deletes the matching `succeeded`,
`failed` and `discarded` events and answers `{ count }`. A list that names a
pending event deletes nothing. The bound of rows per call remains
**[blocked][intake-bounds]**.

**Statuses:** `200` with `{ count }`; `400`
`intake.inbound.event.filter_invalid`; `409`
`intake.inbound.event.state_conflict` for a list that names a pending event.

## Outbound commands

The outbound read projection contains `id`, `projectId`, `operation`,
`requestKey`, `state`, `result`, `error` and `createdAt`. No output contains a
credential or the operands of the write. Each item of `error` holds
`{ code, message, created_at }`. `code` is a result class of the Repository
component or the Storage component, the HTTP status, `timeout` or
`cli.exit_<n>`.

### `outbound list`

**Request and validation:** no positional argument or body. Accept the
project, state and operation filters and shared pagination.

**Effects and idempotency:** return one bounded `{ items, next_cursor }` page in
the order of `id`. Read only. Read bounds remain **[blocked][intake-bounds]**.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.

### `outbound get <outbound-request-id>`

**Effects and idempotency:** return one outbound request projection. Read only.

**Statuses:** `200`; `400` for an invalid identity; `404`
`intake.outbound.request.not_found`.

### `outbound discard <outbound-request-id>`

**Effects and idempotency:** turn a `pending` request whose call does not run
to `discarded`, which is terminal. A discard states no absence of the effect.

**Statuses:** `200` with the projection; `404`
`intake.outbound.request.not_found`; `409` `intake.outbound.request.in_flight`
while its call runs; `409` `intake.outbound.request.state_conflict` for a
request that is not `pending`.

### `outbound delete`

**Request and validation:** send `{ force, state, from, to }` or
`{ force, ids }`. A body without `force: true` answers `400`
`intake.outbound.request.force_required`. A body with neither filter, with
both filters or with the state `pending` answers `400`
`intake.outbound.request.filter_invalid`.

**Effects and idempotency:** one transaction deletes the matching
`succeeded`, `failed` and `discarded` requests and answers `{ count }`. A list
that names a pending request deletes nothing. A repeat of a deleted request
key by its caller inserts a new request and calls the write again; `--force`
accepts that risk. No process deletes an outbound request.

**Statuses:** `200` with `{ count }`; `400`
`intake.outbound.request.force_required`; `400`
`intake.outbound.request.filter_invalid`; `409`
`intake.outbound.request.state_conflict` for a list that names a pending
request.

## Routes without a command

The webhook receipt `intake.inbound.event.receive` uses `POST /hooks/<inbound id>`
with the access policy
`delivery`, as declared by
[Gateway access policy](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#access-policy).
`delivery` means no JWT and verification by the Intake Service with the secret
that it derives for the inbound named in the path; it mints no human or
machine caller. The Gateway handler reads the exact bytes and passes the body
and headers unchanged, following
[Delivery bytes and body limits](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#delivery-bytes-and-body-limits).

The order is verification, then durable storage, then acknowledgement to the
platform. A redelivery inside one inbound stores nothing new and answers `2xx`.
A verified handshake answers from the request alone and stores nothing: a
GitHub `ping` answers `204`. A handshake skips the capacity bound.
The receipt answers `404` `intake.inbound.not_found` for an unknown inbound or
a poll inbound, `401` `intake.inbound.event.signature_invalid` for a failed
verification, and `503` `intake.inbound.event.capacity_exceeded` beyond the
capacity bound of pending events. No CLI command calls the receipt route or
simulates a platform signature with a human JWT.

A poll has no receipt route because the Intake Service initiates it. A poll
pauses beyond the capacity bound.

The API operations `intake.action.perform`, `intake.action.read`,
`intake.storage.put`, `intake.storage.check`, `intake.storage.get`,
`intake.execution.storage.get` and `intake.storage.delete` have no CLI command
and no HTTP route. They declare `direct: true`, and the action performer, the
MCP server and the Mission Service reach them through the direct adapter.

The callers of the outbound operations `intake.action.perform` and
`intake.storage.delete`, the action performer and the Mission Service, track a
request by a repeat with the same request key. A repeat
answers `409` `intake.outbound.request.in_flight` while the call runs and
`409` `intake.outbound.request.discarded` for a discarded request.
`intake.action.perform` answers `422` `intake.outbound.request.action_unmapped`
for an action without a row in the action table, and a CLI write answers `503`
`intake.outbound.request.cli_unavailable` when its binary is missing or too
old.

## Output and failure conventions

The commands follow [shared output and exit behavior](./other.md#output-and-exit-behavior):
one machine-readable JSON value on standard output and concise diagnostics on
standard error. Successful commands exit `0`; local input, file,
authentication, transport and operation failures exit `1`. A successful event
read can report `failed` without failing the read.

Mutation results include the effective `idempotency_key`. The
[shared retry rules](./other.md#idempotency-and-retries) apply. CLI commands
perform no automatic retry. Cancellation ends the client wait and undoes no
committed effect. Preserve `Completed`, `Failure` and `Indeterminate` rather
than claiming rollback after a lost answer.

All commands answer HTTP `401` for missing, invalid or wrong-kind credentials;
a machine token never reaches these human handlers. Diagnostics preserve the
server's code and request identity when available, never a token, a
verification secret, credential material or raw event content.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                   | Condition                                                                                                                                                           | Commands                                                                                                                                                                   |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400   | `credential.platform.mismatch`                         | The requested platform differs from the stored platform.                                                                                                            | `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete` |
| 400   | `intake.inbound.event.filter_invalid`                  | The delete names no filter, both filters or the state `pending`.                                                                                                    | event delete                                                                                                                                                               |
| 400   | `intake.outbound.request.filter_invalid`               | The delete names no filter, both filters or the state `pending`.                                                                                                    | outbound delete                                                                                                                                                            |
| 400   | `intake.outbound.request.force_required`               | The delete omits `force: true`.                                                                                                                                     | outbound delete                                                                                                                                                            |
| 400   | `repository.platform.github.cursor_page_size_mismatch` | A review comment read names another `limit` than its cursor.                                                                                                        | `intake.action.read`                                                                                                                                                       |
| 401   | `intake.inbound.event.signature_invalid`               | The webhook post fails verification.                                                                                                                                | receipt route                                                                                                                                                              |
| 403   | `mission.authorization.refused`                        | The Mission Service refuses the protected facility chain; details `{ reason }`.                                                                                     | `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete` |
| 404   | `intake.inbound.event.not_found`                       | No inbound event has that identity.                                                                                                                                 | event get, event retry, event discard                                                                                                                                      |
| 404   | `intake.inbound.not_found`                             | No inbound has that identity, or the receipt names a poll inbound.                                                                                                  | inbound get, inbound delete, receipt route                                                                                                                                 |
| 404   | `intake.inbound.project_not_found`                     | The project of the create does not exist.                                                                                                                           | inbound create                                                                                                                                                             |
| 404   | `intake.outbound.request.not_found`                    | No outbound request has that identity.                                                                                                                              | outbound get, outbound discard                                                                                                                                             |
| 404   | `mission.record.not_found`                             | The evidence asset of a storage operation does not exist.                                                                                                           | `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete`                                                |
| 409   | `credential.revision.revoked`                          | A pinned use names a revoked revision.                                                                                                                              | `intake.action.perform`, `intake.action.read`                                                                                                                              |
| 409   | `intake.inbound.event.in_flight`                       | The handoff of the pending event runs.                                                                                                                              | event discard                                                                                                                                                              |
| 409   | `intake.inbound.event.state_conflict`                  | The event state permits no such transition, or a list names a pending event.                                                                                        | event retry, event discard, event delete                                                                                                                                   |
| 409   | `intake.inbound.events_pending`                        | The inbound holds a pending event.                                                                                                                                  | inbound delete                                                                                                                                                             |
| 409   | `intake.outbound.request.discarded`                    | A repeat names a discarded request.                                                                                                                                 | `intake.action.perform`, `intake.storage.delete`                                                                                                                           |
| 409   | `intake.outbound.request.in_flight`                    | The call of the request runs.                                                                                                                                       | outbound discard, `intake.action.perform`, `intake.storage.delete`                                                                                                         |
| 409   | `intake.outbound.request.state_conflict`               | The request is not `pending`, or a delete list names a pending request.                                                                                             | outbound discard, outbound delete                                                                                                                                          |
| 409   | `intake.storage.object_mismatch`                       | The object check finds no object, or its size or SHA-256 differs from the asset.                                                                                    | `intake.storage.check`                                                                                                                                                     |
| 409   | `mission.evidence.upload_expired`                      | The pending asset expired before its complete.                                                                                                                      | `intake.storage.check`                                                                                                                                                     |
| 409   | `mission.execution.context_mismatch`                   | The execution context differs from the proven claim; details `{ field }`.                                                                                           | `intake.storage.put`, `intake.storage.check`, `intake.execution.storage.get`                                                                                               |
| 422   | `intake.inbound.credential_invalid`                    | The credential name does not exist, or its platform does not suit the inbound.                                                                                      | inbound create                                                                                                                                                             |
| 422   | `intake.inbound.platform_refused`                      | The platform refuses the first request of a poll create.                                                                                                            | inbound create                                                                                                                                                             |
| 422   | `intake.outbound.request.action_unmapped`              | The configured action has no row in the action table.                                                                                                               | `intake.action.perform`                                                                                                                                                    |
| 502   | `repository.platform.github.<class>`                   | A GitHub call of the check answers a result class; `details.status` holds the GitHub HTTP status when the failure carries one, otherwise null.                      | `intake.action.check`                                                                                                                                                      |
| 502   | `storage.platform.s3.<class>`                          | An S3 call of the object check or the object delete answers a result class; `details.status` holds the S3 HTTP status when the failure carries one, otherwise null. | `intake.storage.check`, `intake.storage.delete`                                                                                                                            |
| 503   | `intake.inbound.event.capacity_exceeded`               | The count of pending events is at its bound.                                                                                                                        | receipt route                                                                                                                                                              |
| 503   | `intake.outbound.request.cli_unavailable`              | The binary of a CLI operation is missing or below its minimum version.                                                                                              | a CLI write                                                                                                                                                                |
| local | `cli.intake.<command>.invalid_<argument>`              | A positional identity fails its prefix or ULID form, for example `cli.intake.inbound.get.invalid_inbound_id`.                                                       | every leaf with a positional identity                                                                                                                                      |
| local | `repository.connector.git_failed`                      | A git operation of the repository connector fails, is aborted or reaches its deadline.                                                                              | `intake.action.perform`, `intake.action.check`                                                                                                                             |

## Optional design provenance

The rules needed to read this page appear above. These links record their
origin and are not required local files in a standalone engine checkout:

- [Intake design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.md)
- [Intake vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.vocabulary.md)
- [Intake implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/intake-service.impl.md)
- [Mission delivery admission and check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.md#delivery-admission-and-check)
- [Custody secret use and handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.md#secret-use-and-handover)
- [Gateway human authority](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.md#human-authority)
- [Gateway implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md)
- [Open-work handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md)
