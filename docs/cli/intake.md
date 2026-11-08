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
insert: a poll performs each request of one poll cycle. A webhook names no credential, kanthord
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

## Command table

All routes are remote, and all access policies are `human`. The webhook
receipt route has no CLI command and uses the `delivery` policy, as described
under [Routes without a command](#routes-without-a-command). Every
authenticated human holds the same server-owner authority over every inbound;
the Intake Service adds no project-membership or role model. A machine token
authorizes no Intake command.

| Command after `kanthord intake`                                | Operation                           | Proposed HTTP route                                                      | Access  | Output and effects                                                                                       |
| -------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------- |
| `inbound create`                                               | `intake.inbound.create`             | `POST /api/intake/inbound`                                               | `human` | Mutation; validates at the platform, then inserts one inbound.                                           |
| `inbound list`                                                 | `intake.inbound.list`               | `GET /api/intake/inbound`                                                | `human` | Bounded page, optionally filtered by project, kind and platform.                                         |
| `inbound get <inbound-id>`                                     | `intake.inbound.get`                | `GET /api/intake/inbound/:inbound_id`                                    | `human` | One inbound; for a webhook, its address and its secret, whose display is **[blocked][intake-contract]**. |
| `inbound delete <inbound-id>`                                  | `intake.inbound.delete`             | `DELETE /api/intake/inbound/:inbound_id`                                 | `human` | Mutation; deletes the inbound and its events, and calls no platform.                                     |
| `event list`                                                   | `intake.inbound.event.list`         | `GET /api/intake/event`                                                  | `human` | Bounded page, optionally filtered by inbound and state.                                                  |
| `event get <inbound-event-id>`                                 | `intake.inbound.event.get`          | `GET /api/intake/event/:inbound_event_id`                                | `human` | One event with its state, errors and redacted `event` text.                                              |
| `event retry <inbound-event-id>`                               | `intake.inbound.event.retry`        | `POST /api/intake/event/:inbound_event_id/retry`                         | `human` | Mutation; turns a failed event back to `pending`.                                                        |
| `event discard <inbound-event-id>`                             | `intake.inbound.event.discard`      | `POST /api/intake/event/:inbound_event_id/discard`                       | `human` | Mutation; turns a pending or a failed event to `discarded`.                                              |
| `event delete`                                                 | `intake.inbound.event.delete`       | `POST /api/intake/event/delete`                                          | `human` | Mutation; deletes the succeeded, failed and discarded events that a filter names.                        |
| `outbound list`                                                | `intake.outbound.request.list`      | `GET /api/intake/outbound`                                               | `human` | Bounded page, optionally filtered by project, state and operation.                                       |
| `outbound get <outbound-request-id>`                           | `intake.outbound.request.get`       | `GET /api/intake/outbound/:outbound_request_id`                          | `human` | One outbound request with its state, result and errors.                                                  |
| `outbound discard <outbound-request-id>`                       | `intake.outbound.request.discard`   | `POST /api/intake/outbound/:outbound_request_id/discard`                 | `human` | Mutation; turns a pending request with no running call to `discarded`.                                   |
| `outbound delete`                                              | `intake.outbound.request.delete`    | `POST /api/intake/outbound/delete`                                       | `human` | Mutation with `--force`; deletes the succeeded, failed and discarded requests that a filter names.       |
| `credential create --file <path>`                              | `intake.credential.create`          | `POST /api/intake/credential`                                            | `human` | Mutation; stores a credential with its first revision.                                                   |
| `credential list [--platform <platform>] [--include-archived]` | `intake.credential.list`            | `GET /api/intake/credential`                                             | `human` | Bounded page of the credentials of the Intake Service.                                                   |
| `credential get <credential-name>`                             | `intake.credential.get`             | `GET /api/intake/credential/:credential_name`                            | `human` | One credential with its revisions and the bindings that name it.                                         |
| `credential rotate <credential-name> --file <path>`            | `intake.credential.rotate`          | `POST /api/intake/credential/:credential_name/revision`                  | `human` | Mutation; adds the next revision with a new secret.                                                      |
| `credential update-metadata <credential-name> --file <path>`   | `intake.credential.update_metadata` | `PUT /api/intake/credential/:credential_name/metadata`                   | `human` | Mutation; adds the next revision with new metadata.                                                      |
| `credential revoke <credential-name> <revision>`               | `intake.credential.revoke`          | `POST /api/intake/credential/:credential_name/revision/:revision/revoke` | `human` | Mutation; ends an older revision.                                                                        |
| `credential archive <credential-name>`                         | `intake.credential.archive`         | `POST /api/intake/credential/:credential_name/archive`                   | `human` | Mutation; archives a credential that no dependent names.                                                 |
| `credential platforms`                                         | `intake.credential.platform_list`   | `GET /api/intake/credential/platform`                                    | `human` | The credential platforms of the Intake Service.                                                          |
| `credential check --file <path>`                               | `intake.credential.check`           | `POST /api/intake/credential/check`                                      | `human` | Read; checks a typed secret before the save, stores nothing.                                             |
| `credential verify <credential-name>`                          | `intake.credential.verify`          | `POST /api/intake/credential/:credential_name/verify`                    | `human` | Read; checks one stored credential at the platform.                                                      |

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

```text
kanthord intake credential create --file <path> [M] [R]
```

```text
kanthord intake credential list [--platform <platform>] [--include-archived] [L] [R]
```

```text
kanthord intake credential get <credential-name> [R]
```

```text
kanthord intake credential rotate <credential-name> --file <path> [M] [R]
```

```text
kanthord intake credential update-metadata <credential-name> --file <path> [M] [R]
```

```text
kanthord intake credential revoke <credential-name> <revision> [M] [R]
```

```text
kanthord intake credential archive <credential-name> [M] [R]
```

```text
kanthord intake credential platforms [R]
```

```text
kanthord intake credential check --file <path> [R]
```

```text
kanthord intake credential verify <credential-name> [R]
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
| [`--file`](./common-flags.md#--file)                                             | Required on `inbound create`, `credential create`, `credential rotate`, `credential update-metadata` and `credential check`; the inbound schema appears below.      |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Every mutation.                                                                                                                                                     |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | The inbound, event, outbound and credential lists only.                                                                                                             |
| [`--force`](./common-flags.md#--force)                                           | Required on `outbound delete` only. It accepts that a repeat of a deleted request key calls the write again.                                                        |

| Argument or flag                                           | Requiredness and type                                                                | Default                      | Validation and request mapping                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<inbound-id>`                                             | Required inbound identity on get and delete.                                         | None                         | Map to `params.inbound_id`. Prefix `inbound_`.                                                                                                                |
| `<inbound-event-id>`                                       | Required inbound event identity on get, retry and discard.                           | None                         | Map to `params.inbound_event_id`. Prefix `inbound_event_`.                                                                                                    |
| `--project <id>`                                           | Optional project identity on `inbound list`.                                         | Absent: no project filter    | Send `query.project_id`; Project owns the prefix declaration.                                                                                                 |
| `--kind <kind>`                                            | Optional inbound kind on `inbound list`.                                             | Absent: all kinds            | Send `query.kind`; closed set `webhook`, `poll`.                                                                                                              |
| `--platform <platform>`                                    | Optional platform on `inbound list`.                                                 | Absent: all platforms        | Send `query.platform`; closed set of supported platforms, `github`, `jira` and `slack`.                                                                       |
| `--inbound <id>`                                           | Optional inbound identity on `event list`.                                           | Absent: no inbound filter    | Send `query.inbound_id`.                                                                                                                                      |
| `--state <state>`                                          | Optional on `event list`; required with `--from` and `--to` on `event delete`.       | Absent on a list: all states | Send `query.state` or `body.state`; closed set `pending`, `succeeded`, `failed`, `discarded`.                                                                 |
| `--from`, `--to`                                           | Required together with `--state` on `event delete`.                                  | None                         | Send `body.from` and `body.to`, an inclusive range of inbound event identities.                                                                               |
| `--id <inbound-event-id>`                                  | Repeatable on `event delete`; excludes `--state`, `--from` and `--to`.               | None                         | Send `body.ids`, a nonempty list of at most 1000 identities.                                                                                                  |
| `<outbound-request-id>`                                    | Required outbound request identity on `outbound get` and `outbound discard`.         | None                         | Map to `params.outbound_request_id`. Prefix `outbound_request_`.                                                                                              |
| `--project <id>` on `outbound list`                        | Optional project identity.                                                           | Absent: no project filter    | Send `query.project_id`.                                                                                                                                      |
| `--state <state>` on `outbound list` and `outbound delete` | Optional on `outbound list`; required with `--from` and `--to` on `outbound delete`. | Absent on a list: all states | Send `query.state` or `body.state`; closed set `pending`, `succeeded`, `failed`, `discarded`.                                                                 |
| `--operation <operation>`                                  | Optional on `outbound list`.                                                         | Absent: all operations       | Send `query.operation`; closed set `github.pull_request`, `git.push`, `github.issue_comment`, `jira.issue_comment`, `slack.thread_reply`, `s3.delete_object`. |
| `--from`, `--to` on `outbound delete`                      | Required together with `--state`.                                                    | None                         | Send `body.from` and `body.to`, an inclusive range of outbound request identities.                                                                            |
| `--id <outbound-request-id>`                               | Repeatable on `outbound delete`; excludes `--state`, `--from` and `--to`.            | None                         | Send `body.ids`, a nonempty list of at most 1000 identities.                                                                                                  |
| `--force` on `outbound delete`                             | Required boolean switch.                                                             | `false`                      | Send `body.force`. Without it the server answers `400` `intake.outbound.request.force_required`.                                                              |

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

| File field      | Requiredness and type                             | Default | Validation and meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project_id`    | Required project identity.                        | None    | Must name a project of the Project Service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `kind`          | Required enum string.                             | None    | Closed set `webhook`, `poll`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `platform`      | Required enum string.                             | None    | Closed set of supported platforms, `github`, `jira` and `slack`. `jira` and `slack` take the kind `webhook` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `consumer`      | Required enum string.                             | None    | Closed set of admission operations, today `mission.delivery.admit`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `credential`    | Credential name string, or absent.                | Absent  | Required for a poll and for a `slack` webhook, refused for every other webhook. The name must exist, and its platform must suit `platform`: `github` for a poll, `slack_signing_secret` for a `slack` webhook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `configuration` | Required object, validated per kind and platform. | None    | Holds the required `resource_kind`, the required `resource` and the options of the kind and the platform. `resource_kind` has no default and takes `repository` or `conversation`. An absent or another value answers `400` `gateway.request.validation_failed`. The resource identity is `<resource_kind>:<platform>:<resource>`. A `jira` inbound takes `resource_kind: conversation` and the `resource` `<site>/<project_key>`, with a lower-case site that ends with `.atlassian.net` and an upper-case key that matches `^[A-Z][A-Z0-9_]{1,9}$`, for example `acme.atlassian.net/KD`. A `slack` inbound takes `resource_kind: conversation` and the `resource` `<team_id>`, a Slack workspace id that matches `^T[A-Z0-9]{2,31}$`, for example `T01ABCDEF`. Every property name is snake_case, the stored form. Every field beyond `resource_kind` and `resource` is **[blocked][intake-contract]**. |

The file accepts no verification secret, checkpoint,
state, error or arbitrary consumer operation.

## Inbound commands

The inbound read projection contains `id`, `project_id`, `kind`, `platform`,
`consumer`, `credential`, `configuration`, `checkpoint` and
`created_at`. It exposes no credential material.

### `inbound create`

**Request and validation:** send the file object described above. Validate
the fields and the configuration schema, then perform the remote validation of
the kind: one poll cycle for a poll, nothing for a webhook. A GitHub
repository poll cycle reads the events and the closed pull requests of the
resource, so a credential without pull request read access refuses the create.
A GitHub conversation poll cycle reads the issue comments of the resource, so
a credential without the fine-grained permission "Issues: read" refuses the
create. The insert transaction checks the credential name and its platform.

**Effects and idempotency:** a success inserts exactly one inbound. A platform
refusal inserts nothing.
A repeat with the same `--idempotency-key` returns the recorded answer within
the process-local replay TTL. A new invocation creates another inbound: no
natural key prevents a duplicate, because a duplicate serves a rotation.

A `jira` inbound is a webhook that names no credential. A `jira` poll create answers `400` `gateway.request.validation_failed` with the issue path `body.platform`, and inserts nothing. A Jira administrator registers an admin webhook at the platform with the address `/hooks/<inbound id>` and the derived secret of the inbound.

A `slack` inbound is a webhook that names exactly one credential of platform `slack_signing_secret`. It is the one webhook inbound that names a credential. A missing credential, an unknown credential and a credential of another platform answer `422` `intake.inbound.credential_invalid` and insert nothing. The create makes no platform call. A `slack` poll create answers `400` `gateway.request.validation_failed` with the issue path `body.platform`, and inserts nothing. A Slack administrator sets the address `/hooks/<inbound id>` as the request URL of the Events API of the Slack app. The signing secret of the app is the secret of the named credential. The inbound names the credential, so `credential archive` of the signing secret answers `409` `credential.credential.in_use` with the inbound in `details.inbounds`.

**Statuses:** `201` with the inbound projection; `400` for invalid input;
`404` `intake.inbound.project_not_found` for an unknown project; `422`
`intake.inbound.credential_invalid` for an unknown or unsuitable credential, and for a missing credential of a `slack` webhook;
`422` `intake.inbound.platform_refused` when the platform refuses a
validation request of a poll.

### `inbound list`

**Request and validation:** no body or positional argument. Accept the project,
kind and platform filters and shared pagination.

**Effects and idempotency:** read one bounded `{ items, next_cursor }` page and
change nothing. The [pagination conventions](./other.md#pagination) and the
shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) apply.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.

### `inbound get <inbound-id>`

**Request and validation:** map the identity to `params.inbound_id`; accept no
query or body.

**Effects and idempotency:** read one inbound projection. For a webhook it
also returns the address `/hooks/<inbound id>` and the secret. A `GET` is no
mutation, so the idempotency middleware records no secret. The display,
redaction and cache contract of the secret remains **[blocked][intake-contract]**.

**Statuses:** `200`; `400` for an invalid identity; `404`
`intake.inbound.not_found` for an unknown inbound.

### `inbound delete <inbound-id>`

**Request and validation:** use `params.inbound_id`, with no query or body.

**Effects and idempotency:** refuse while the inbound holds a pending event.
Otherwise one transaction deletes the events of the inbound and the inbound.
The delete calls no platform; a human removes a webhook at the platform. A
repeat after a success answers `404`.

**Statuses:** `204`; `400` for an invalid identity; `404`
`intake.inbound.not_found`; `409` `intake.inbound.events_pending` while a
pending event exists.

## Event commands

The event read projection contains `id`, `inbound_id`, `event_id`, `metadata`,
`state`, `error` and `created_at`. `event get` adds `event`, the stored event
bytes as UTF-8 text. The sensitive text rule set of the engine redacts `event`;
no read cuts it. No output contains a credential.
Each item of `error` holds `{ code, message, created_at }`. `code` is the error
code of a declared failure of the consumer, or `indeterminate` when the handoff
ends with no answer.

### `event list`

**Request and validation:** no positional argument or body. Accept the inbound
and state filters and shared pagination.

**Effects and idempotency:** return one bounded `{ items, next_cursor }` page.
Read only. The `limit` accepts 1 to 1000 and defaults to 100.

**Statuses:** `200`, including an empty page; `400` for invalid input or cursor.

### `event get <inbound-event-id>`

**Request and validation:** map the identity to `params.inbound_event_id`. A
platform event identity is not a substitute for that identity.

**Effects and idempotency:** return one event projection with the redacted
`event` text. Read only.

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
pending event deletes nothing. A range that matches more than 1000 events
answers `400` `intake.inbound.event.filter_invalid` and deletes nothing; the
caller narrows the range.

**Statuses:** `200` with `{ count }`; `400`
`intake.inbound.event.filter_invalid`; `409`
`intake.inbound.event.state_conflict` for a list that names a pending event.

## Outbound commands

The outbound read projection contains `id`, `project_id`, `operation`,
`request_key`, `state`, `result`, `error` and `created_at`. No output contains a
credential or the operands of the write. Each item of `error` holds
`{ code, message, created_at }`. `code` is a result class of the Repository
component or the Storage component, the HTTP status, `timeout` or
`cli.exit_<n>`.

### `outbound list`

**Request and validation:** no positional argument or body. Accept the
project, state and operation filters and shared pagination.

**Effects and idempotency:** return one bounded `{ items, next_cursor }` page in
the order of `id`. Read only. The `limit` accepts 1 to 1000 and defaults to 100.

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
accepts that risk. A range that matches more than 1000 requests answers `400`
`intake.outbound.request.filter_invalid` and deletes nothing; the caller
narrows the range. No process deletes an outbound request.

**Statuses:** `200` with `{ count }`; `400`
`intake.outbound.request.force_required`; `400`
`intake.outbound.request.filter_invalid`; `409`
`intake.outbound.request.state_conflict` for a list that names a pending
request.

## Credential commands

The Intake Service declares the credential route group `/api/intake/credential`
with the ten commands of `kanthord intake credential`, as the
[storage credential page](./storage.md) describes them for the Storage
component. The operation IDs have the form `intake.credential.<operation>`. The
route group has no project identity. A credential belongs to no project. The
module `src/intake/credential-platform.ts` declares the platforms. Custody
declares no route and keeps the record functions that these routes call.

Every command uses `human` access. The file rules, the secret-file mode `0600`,
the mutation key, the pagination, the reserved names, the pre-save check, the
record verify and the archive rules of the
[storage credential page](./storage.md) apply without change. A name whose
platform belongs to another component answers `404 credential.credential.not_found`
on every command that takes a name. A `create` with a platform of another
component answers `400 credential.platform.unsupported`.

The platforms of the Intake Service:

| Platform               | Secret shape | Metadata                                                          |
| ---------------------- | ------------ | ----------------------------------------------------------------- |
| `jira`                 | `api_key`    | Required `{ site, cloud_id, email }`, all strings; closed object. |
| `slack`                | `api_key`    | None; `metadata` is `null`.                                       |
| `slack_signing_secret` | `api_key`    | None; `metadata` is `null`.                                       |

The `jira` credential holds a scoped Jira API token with the scopes
`read:jira-work`, `write:jira-work` and `read:jira-user`. The secret is
`{ key }`. `site` names the Jira Cloud site, for example `example.atlassian.net`.
`cloud_id` is the cloud identity of the site; it holds letters, digits and
hyphens only. `email` is the account of the token. `platforms` answers
`metadata_fields` `["site", "cloud_id", "email"]` and `verifiable: true`.

Each call of the platform goes to `https://api.atlassian.com/ex/jira/<cloud_id>`
with the header `Authorization: Basic` and the value `email:token` in base64.
The validator of `check`, `verify` and the health report calls
`GET /rest/api/3/myself` there. Its capability is `myself read`. HTTP `200`
answers `healthy`, `401` answers `unhealthy` with `unauthorized`, and `403`
answers `unknown` with `forbidden`. The Intake Service owns the healthcheck of
its records: the health report lists each live `jira` record under the owner
`intake`, in the global scope. `create` and `rotate` make no remote call.

The `slack` credential holds the user token `xoxp-` of the developer. The secret is
`{ key }`. `platforms` answers `metadata_fields` `[]` and `verifiable: true`.
The validator of `check`, `verify` and the health report calls
`POST https://slack.com/api/auth.test` with the header `Authorization: Bearer`
and reads the JSON field `ok`. Its capability is `auth test`. `ok: true` answers
`healthy` and `ok: false` answers `unhealthy` with `unauthorized`. The platform
answers HTTP `200` with `ok: false` for a refused token.

The `slack_signing_secret` credential holds the signing secret of the Slack app. The secret is
`{ key }`. `platforms` answers `metadata_fields` `[]` and `verifiable: false`.
`check` and `verify` answer `400` `credential.check.unsupported`, and the health
report lists each live record with the status `unknown` and the capability
`signing secret`. `create` and `rotate` make no remote call.

The custody operation of an inbound release is `poll`, `link_read` or `receipt`.
Only the Intake Service takes such a release, and each release is single-use.

A platform call of the Intake Service that fails answers `502` with the code
`intake.platform.<platform>.<class>`. `<class>` is `confirmed_failure`,
`retryable_refusal`, `final_refusal` or `unknown_outcome`. `details.status`
holds the HTTP status of the platform when the failure carries one, otherwise
null.

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
A GitHub webhook inbound with `resource_kind: conversation` stores its
`issue_comment` deliveries under the same receipt.
A `slack` webhook inbound verifies with the signing secret of its credential, not with the derived secret.
Each receipt takes one single-use custody release of that secret, with the operation `receipt`,
under the service identity of the Intake Service, and drops the material in `finally`,
after a success and after a failure. The receipt requires exactly one `X-Slack-Signature` of the form
`v0=<64 hex>` and exactly one `X-Slack-Request-Timestamp` of decimal seconds. A timestamp
more than 300 seconds from the server time answers `401` `intake.inbound.event.signature_invalid`.
The HMAC SHA-256 covers `v0:<timestamp>:<exact bytes>`, and the receipt compares two 32-byte
digests with `timingSafeEqual`. A missing header, a repeated header, a header of another form,
a stale or future timestamp and a wrong digest answer `401` `intake.inbound.event.signature_invalid`
and store nothing. A verified `url_verification` body answers `200` with `{ "challenge": <challenge> }`
and stores nothing. A verified `event_callback` body stores one event under its `event_id`
with the metadata `{ "event": <event.type> }`, and a repeated `event_id` stores one row.
The receipt stores a body of another team, and the decoder answers null for it.
A signed body of another shape, or a body with no `event_id` or no `challenge`, answers `400`
`gateway.request.validation_failed` and stores nothing.
A `jira` webhook inbound takes the signature from the header `X-Hub-Signature`.
The receipt requires exactly one such header of the form `sha256=<64 hex>`. It
computes HMAC SHA-256 over the exact bytes with the derived secret and compares two
32-byte digests with `timingSafeEqual`. A missing header, a repeated header, a
header of another form and a wrong digest answer `401`
`intake.inbound.event.signature_invalid` and store nothing. The event identity is
the header `X-Atlassian-Webhook-Identifier`. A signed delivery with no such
header, or with a body that holds no `webhookEvent`, answers `400`
`gateway.request.validation_failed` and stores nothing. The stored `metadata` is
`{ "event": <webhookEvent> }`. A Jira `ping` handshake does not exist, so every
verified delivery stores one event, and a repeated identity stores one row.
The receipt answers `404` `intake.inbound.not_found` for an unknown inbound or
a poll inbound, `401` `intake.inbound.event.signature_invalid` for a failed
verification, `400` `gateway.request.validation_failed` for a Jira delivery with no identity or a Slack delivery of another shape, and `503` `intake.inbound.event.capacity_exceeded` beyond the
capacity bound of pending events. No CLI command calls the receipt route or
simulates a platform signature with a human JWT.

The check of an open pull request reads the rules of its base branch, the check runs and the statuses of its head commit. A fine-grained token needs `Checks: read` and `Commit statuses: read`.

A poll has no receipt route because the Intake Service initiates it. A poll
pauses beyond the capacity bound. A repository poll requests GitHub only while
its project holds an unresolved request evidence on its resource. Each cycle
reads the events, then the closed pull requests of the resource. It waits at
least 60 seconds between two cycles, and longer when GitHub names a wait
through `X-Poll-Interval`, `Retry-After` or `x-ratelimit-reset`. The
`checkpoint` of a GitHub repository poll holds `etag` and `pulls_etag`, one
ETag for each read. The create and the delete of a poll inbound are the only
switch of its poll.

The conversation poll of a GitHub repository requests GitHub only while a node
of its project links an issue of the repository, or while the current revision
of the conversation binding of the resource holds `inbox`. The demand answer of
the Mission Service is `{ count, link_count, inbox }`, and the poll requests
while `link_count` is above zero or `inbox` is true. Each cycle runs one read: one
page of the issue comments, sorted by update time, newest first. It follows
the same wait rules as the repository poll. The credential of a conversation
inbound needs the fine-grained permission "Issues: read". The batch and the
`comments_etag` commit in one transaction. A page that exceeds the room below
the capacity bound stores the items that fit and writes a `null`
`comments_etag`. The `checkpoint` of a GitHub
conversation holds `comments_etag`, a text or `null`. The `metadata` of a
comment from this read is `{ "event": "issue_comment_listed" }`, and its event
id is `issue_comment:<comment id>`. A webhook comment has the `metadata` value
`issue_comment` and the same key, so one comment makes one update.

The API operations `intake.action.perform`, `intake.action.read`,
`intake.storage.put`, `intake.storage.check`, `intake.storage.get`,
`intake.execution.storage.get`, `intake.execution.gate_files.read` and
`intake.storage.delete` have no CLI command
and no HTTP route. They declare `direct: true`, and the action performer, the
MCP server and the Mission Service reach them through the direct adapter.

`intake.action.read` takes the query field `method` with one of these values:

- `github-pull-request-get` answers the pull request body unchanged.
- `github-pull-request-review-comment-list` answers one page of the review
  comments and takes `limit` and `cursor`.
- `github-pull-request-change-request-get` answers
  `{ head_commit, change_requests }`. A change request is the latest
  `APPROVED`, `CHANGES_REQUESTED` or `DISMISSED` review of its reviewer when it
  is `CHANGES_REQUESTED` and its `commit_id` is the head commit. This is the
  rule of the pull request check. A review counts only when its author passes
  the trust rule: `user.type` is `User`, and the account ID of the author is in
  `link_trust.actor_ids` of the repository binding revision that the frozen
  action of the request names. A binding with no `link_trust` trusts no
  reviewer, and a review of a bot never counts. The pull request check applies
  the same rule, so a change request of an untrusted reviewer gives no `other`
  end state. Each change request holds `review_id`,
  `reviewer`, `body`, `submitted_at`, `commit_id` and the `comments` of that
  review, each with `path`, `line` and `body`. The read calls GitHub once for
  the pull request, once for each page of the reviews and once for each page of
  the comments of each change request. `next_cursor` is `null`.
- `github-pull-request-required-check-get` answers
  `{ head_commit, base_branch, pending, failed }`. `pending` and `failed` name
  the required checks of the base branch that have not ended and that failed on
  the head commit. `next_cursor` is `null`.

The callers of the outbound operations `intake.action.perform` and
`intake.storage.delete`, the action performer and the Mission Service, track a
request by a repeat with the same request key. Intake scopes a request key to
its project and its operation. A repeat
answers `409` `intake.outbound.request.in_flight` while the call runs and
`409` `intake.outbound.request.discarded` for a discarded request.
`intake.action.perform` answers `422` `intake.outbound.request.action_unmapped`
for an action without a row in the action table, and a CLI write answers `503`
`intake.outbound.request.cli_unavailable` when its binary is missing or too
old.

For a `pull_request` action, the pull request title is `<commit_type>: <node name>`.
`commit_type` comes from the pinned revision of the node, `feat` when absent.
The title follows the header rules of the [worker commits](./worker.md).

For a `pull_request` action with the landing `kanthord`, `intake.action.perform`
merges the pull request after it creates the pull request or pushes the snapshot
to a reused pull request. The merge sends the tested commit as the head guard.
The merge uses the first method that the repository allows, in the order
`merge`, `squash`, `rebase`. A refused or failed merge leaves the pull request
open and changes no answer.

For a `reply` action of a conversation binding of platform `github`,
`intake.action.perform` runs the outbound operation `github.issue_comment`. The
input carries `commit: null` and `comment`, the body that the action performer
composes. The request key is `<node_id>:<attempt>:<link>`, where `<link>` is the
canonical JSON of the external link. A request key of another form answers
`400` `gateway.request.validation_failed`. Intake posts `comment` to the issue of
the link with `postIssueComment` and the credential of the conversation binding
revision, and it answers the address `{ kind: "comment", resource_identity,
update_key }`. The stored result is `{ update_key, actor_id }`. Before the first
post on a link with no succeeded reply of any project, Intake reads the token
account once with `readTokenAccount` and records `{ actor_id }` in the result of
the pending request. A reply has no read-back, and its body holds no hidden
marker. A call that ends with no answer sets the request `failed`. A repeat of a
`failed` request, and a repeat of a `pending` request with no running call,
posts again. A repeat of a `succeeded` request answers the stored address and
posts nothing.

For a `reply` action of a conversation binding of platform `jira`,
`intake.action.perform` runs the outbound operation `jira.issue_comment`. The
request key, the input and the repeat rules are those of `github.issue_comment`.
Intake posts `comment` as an Atlassian document body with `POST
/rest/api/3/issue/{key}/comment`, where `key` is the `key` of the `jira_issue`
link, and it uses the credential of the conversation binding revision. The stored
result is `{ update_key, actor_id }`, where `update_key` is `jira_comment:<site>:<id>`
of the created comment. Before the first post on a link with no succeeded reply of
any project, Intake reads `accountId` with `GET /rest/api/3/myself` and records
`{ actor_id }` in the result of the pending request. A reply has no read-back, and
its body holds no hidden marker. A call that ends with no answer sets the request
`failed`. A failed call answers a result class with the code
`intake.platform.jira.<class>`.
A Jira reply refuses a credential whose `site` differs from the `site` of the
binding, compared with no regard to case. It calls no Jira URL and answers the
result class `final_refusal` with the code `intake.platform.jira.final_refusal`.

For a `reply` action of a conversation binding of platform `slack`,
`intake.action.perform` runs the outbound operation `slack.thread_reply`. The
request key, the input and the repeat rules are those of `github.issue_comment`.
Intake posts `comment` with `POST https://slack.com/api/chat.postMessage` and the JSON body
`{ channel, thread_ts, text }`, where `channel` and `thread_ts` come from the `slack_thread`
link. It sends the header `Authorization: Bearer` with the user token of the credential of the
conversation binding revision. The stored result is `{ update_key, actor_id }`, where
`update_key` is `slack_message:<team_id>:<channel>:<ts>` of the posted message and `actor_id` is
`message.user` of the answer, else the recorded account. Before the first post on a link with no
succeeded reply of any project, Intake reads `user_id` with `POST https://slack.com/api/auth.test` and
records `{ actor_id }` in the result of the pending request. A reply has no read-back, and its
text holds no footer. A call that ends with no answer sets the request `failed`. A failed call
answers a result class with the code `intake.platform.slack.<class>`. A Slack answer with
`ok: false` is a refusal: `ratelimited` answers `retryable_refusal`, a server error of Slack
answers `unknown_outcome`, and every other error answers `final_refusal`.

`intake.outbound.reply.match` is a `service` operation with no CLI command and
no HTTP route. Only the Mission Service calls it; another caller fails an
assertion. It takes `{ update_key, external_link }` and answers
`{ succeeded, pending_actor_ids }`. It reads the `github.issue_comment`, `jira.issue_comment` and `slack.thread_reply` requests
of every project and finds the requests of a link by the suffix
`:<canonical link>` of the request key. `succeeded` is true when the `update_key`
of the result of a `succeeded` reply request equals `update_key`, on any link.
`pending_actor_ids` is empty while no reply request of the link is `pending`.
Otherwise it holds the reply account: `actor_id` of the last `succeeded` reply
on the link, else the `actor_id` that each `pending` request recorded. It writes
no row and calls no platform. Admission of the Mission Service uses it to refuse
the own reply and the reply account during a pending reply.

`intake.action.check` answers a `comment` request evidence with `expected` when
its outbound request is `succeeded`, and with `none` while the request is
`pending` or `failed`. It calls no platform.

`intake.action.merge` is a service operation that only the Mission Service
calls. It takes `{ evidence_id, commit, request_key }` and merges the pull
request of the request evidence with no execution claim. It merges only while
the node is `External.Requested` on the open attempt of the evidence, the
action is a `pull_request` with the landing `kanthord`, the current assessment
of the attempt is `success` with no changed gate file, and `commit` is the
tested commit of the binding. A removed binding, a disabled binding and a
paused project get no merge. The merge call and the read-back are the call and
the read-back of `github.pull_request_merge` that `intake.action.perform` uses.
It answers the pull request address, or a result class answer with the code
`repository.platform.github.<class>`. Intake stores the request under the key `service_merge/<request_key>`. `intake.action.perform` answers `400` `gateway.request.validation_failed` for a `request_key` that starts with `service_merge/`. A stored answer that names another pull request answers `final_refusal` and calls no merge.

Before the merge, the action performer reads the required checks with `github-pull-request-required-check-get`. While a required check of the head commit is pending or failed, it requests no merge. When the read fails or answers an unexpected body, it requests no merge. The deferred check of the Mission Service can then request the merge.

Only the Mission Service calls it, for the execution caller of `mission.assessment.submit`. `intake.execution.gate_files.read` runs for an execution caller and takes `{ binding_id, base_branch, commit }`. Intake keeps one bare repository for each binding at `intake/repositories/<binding id>.git` of the server state directory and reuses it. It fetches the commits of the base branch and the commit with `--filter=tree:0` and the SSH identity of the binding. It fetches each tree and blob that a read needs on demand. It reads `.kanthord/affected-tests.json` at the base branch. A path of its `gate_files` is changed when its mode or its object at the merge base differs from its mode or its object at the commit. A new path and a removed path are changed. A declared directory is changed when any entry below it changes. The answer is `{ paths }`. A git failure answers `502` with the git code and removes the bare repository, except after a deadline. A declaration that does not match the declaration shape of the worker, or that holds a path of `gate_files` that is not canonical, answers `502` `repository.gate_declaration.invalid`. The Intake Service keeps the bare repository for this error.

`intake.inbound.event.describe` is a `service` operation with no CLI command
and no HTTP route. The Worker Service and the Mission Service call it; another
caller fails an assertion. The Mission Service calls it for `mission inbox-item
list` and `mission inbox-item done`, outside its own transaction. It takes `{ inbound_event_id }`, reads the stored event and its
inbound in one read transaction, and calls the description of the platform
implementation of the inbound: `describeGitHubEvent` for `github`, `describeJiraEvent` for `jira` and `describeSlackEvent` for `slack`. It answers
`{ author, body, url, occurred_at }`. It applies the sensitive text rule set of
the engine to `body` and cuts no text. It takes no credential, calls no platform
and writes no row. A `jira` description answers `comment.author.displayName` as `author`, the body of the
comment as plain text, `https://<site>/browse/<key>` as `url` and `comment.created`
as `occurred_at`. A text body stays as it is. An Atlassian document body becomes the
text of its text nodes, with a newline between blocks. An event that the platform
implementation does not describe answers four `null` fields. An unknown or deleted event answers `404`
`intake.inbound.event.not_found`.

The Jira decoder of `src/intake/jira.ts` decodes only the event `comment_created`.
It answers the link `{ kind: "jira_issue", resource_identity, key }` with the key
`issue.key` of the issue, the `update_key` `jira_comment:<site>:<comment.id>`, the
`actor_id` `comment.author.accountId`, `actor_automated` true when `accountType` is
`app`, `occurred_at` as the Unix milliseconds of `comment.created`, and an empty
`mentions` list. A comment without a valid `comment.created`, another event, a
comment of another project and a broken body decode to null, and admission refuses
such an event with the reason `undecodable`.

The Slack decoder of `src/intake/slack.ts` decodes only a `message` event whose `thread_ts`
differs from its `ts`. It answers the link `{ kind: "slack_thread", resource_identity, channel, thread_ts }`,
the `update_key` `slack_message:<team_id>:<channel>:<ts>`, the `actor_id` `event.user`,
`actor_automated` true when `bot_id` or `app_id` is present or `subtype` is other than
`thread_broadcast` or `file_share`, `occurred_at` as the Unix milliseconds of `event.ts`, and an empty
`mentions` list. A parent message, `message_changed`, `message_deleted`, a body of another team,
a channel outside `^[CG][A-Z0-9]{2,31}$` and a broken body decode to null, and admission refuses
such an event with the reason `undecodable`. A `slack` description answers `event.user` as `author`,
`event.text` as `body`, the permalink
`https://slack.com/archives/<channel>/p<ts without the dot>?thread_ts=<thread_ts>&cid=<channel>` as `url`
and the time of `event.ts` as `occurred_at`. A message that does not decode has four `null` fields.

`intake.link.read` is a `service` operation with no CLI command and no HTTP
route. Only the Mission Service calls it, for `mission.node.check`. It takes
`{ project_id, external_link, binding_id }`, where `binding_id` is the binding
revision that the node pins for the link resource. It stores each item under
the newest inbound of the link resource in the project and answers
`{ items: { inbound_event_id }[] }`. The call takes one custody release of the
`credential` of that binding revision and records no outbound request. For
`github_issue` it calls `listIssueCommentsOf` of the GitHub implementation.
Each item maps to the event id `issue_comment:<id>` and the metadata
`{ "event": "issue_comment_listed" }`. An item with an existing event id keeps
its stored row, and the answer holds the `inbound_event_id` of that row. A link
resource with no inbound in the project answers `409`
`intake.link.inbound_missing` with details `{ external_link }` before any
release. A failed GitHub call answers `502` `repository.platform.github.<class>`
and stores no row. For `jira_issue` it calls `GET /rest/api/3/issue/{key}/comment`
with `orderBy=-created` and `maxResults=100`, one page, with the credential
metadata `{ site, cloud_id, email }`. Each item maps to the event id
`jira_comment:<site>:<id>` and the metadata `{ "event": "comment_listed" }`. A
failed Jira call answers `502` `intake.platform.jira.<class>` and stores no row.
A Jira read refuses a credential whose `site` differs from the `site` of the
binding, compared with no regard to case. It calls no Jira URL, answers `502`
`intake.platform.jira.final_refusal` and stores no row.
For `slack_thread` it calls `GET https://slack.com/api/conversations.replies` with `channel`, `ts` set to
`thread_ts` and `limit=200`, one page, with the user token of the credential of the binding revision.
It stores each reply other than the parent, the message whose `ts` equals `thread_ts`, as the event id
`slack_message:<team_id>:<channel>:<ts>` and the metadata `{ "event": "reply_listed" }`. The stored
event is an `event_callback` body that holds the team and the reply with its channel, so the Slack
decoder reads it like a delivery. A Slack answer with `ok: false` and a failed call answer `502`
`intake.platform.slack.<class>` and store no row, with `details.status` null for `ok: false`.
The Mission Service hands each item to
`mission.delivery.admit` through the handoff of the Intake Service. The event
state records the result, and the dispatcher hands no item twice.

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
server's code, the HTTP status and the idempotency key of a mutation, never a token, a
verification secret, credential material or raw event content.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                   | Condition                                                                                                                                                                                                                                                                                                                                         | Commands                                                                                                                                                                                          |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400   | `credential.check.unsupported`                         | The platform has `verifiable: false` or the secret shape `oauth`.                                                                                                                                                                                                                                                                                 | credential check, credential verify                                                                                                                                                               |
| 400   | `credential.input.invalid`                             | Secret or metadata validation fails, or the name is reserved.                                                                                                                                                                                                                                                                                     | credential create, credential rotate, credential update-metadata, credential check                                                                                                                |
| 400   | `credential.platform.mismatch`                         | The requested platform differs from the stored platform.                                                                                                                                                                                                                                                                                          | `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete`                        |
| 400   | `credential.platform.unsupported`                      | The platform is not a platform of the Intake Service.                                                                                                                                                                                                                                                                                             | credential create, credential check                                                                                                                                                               |
| 400   | `intake.inbound.event.filter_invalid`                  | The delete names no filter, both filters or the state `pending`, or its range matches more than 1000 rows.                                                                                                                                                                                                                                        | event delete                                                                                                                                                                                      |
| 400   | `intake.outbound.request.filter_invalid`               | The delete names no filter, both filters or the state `pending`, or its range matches more than 1000 rows.                                                                                                                                                                                                                                        | outbound delete                                                                                                                                                                                   |
| 400   | `intake.outbound.request.force_required`               | The delete omits `force: true`.                                                                                                                                                                                                                                                                                                                   | outbound delete                                                                                                                                                                                   |
| 400   | `project.bindings.repository.address_invalid`          | The repository address does not have the form `git@<host>:<owner>/<repository>.git`. No git process starts.                                                                                                                                                                                                                                       | `intake.action.check`, `intake.action.perform`                                                                                                                                                    |
| 400   | `repository.platform.github.cursor_page_size_mismatch` | A review comment read names another `limit` than its cursor.                                                                                                                                                                                                                                                                                      | `intake.action.read`                                                                                                                                                                              |
| 401   | `intake.inbound.event.signature_invalid`               | The webhook post fails verification; for a `jira` inbound, the header `X-Hub-Signature` is missing, repeated, malformed or wrong; for a `slack` inbound, the header `X-Slack-Signature` or `X-Slack-Request-Timestamp` is missing, repeated or malformed, the timestamp is more than 300 seconds from the server time, or the signature is wrong. | receipt route                                                                                                                                                                                     |
| 403   | `mission.authorization.refused`                        | The Mission Service refuses the protected facility chain; details `{ reason }`.                                                                                                                                                                                                                                                                   | `intake.action.merge`, `intake.action.perform`, `intake.action.read`, `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete` |
| 404   | `credential.credential.not_found`                      | The credential does not exist, or its platform is not a platform of the Intake Service.                                                                                                                                                                                                                                                           | credential get, credential rotate, credential update-metadata, credential revoke, credential archive, credential verify                                                                           |
| 404   | `credential.revision.not_found`                        | The revision does not exist, or the credential name is unknown.                                                                                                                                                                                                                                                                                   | credential revoke                                                                                                                                                                                 |
| 404   | `intake.inbound.event.not_found`                       | No inbound event has that identity.                                                                                                                                                                                                                                                                                                               | event get, event retry, event discard, `intake.inbound.event.describe`                                                                                                                            |
| 404   | `intake.inbound.not_found`                             | No inbound has that identity, or the receipt names a poll inbound.                                                                                                                                                                                                                                                                                | inbound get, inbound delete, receipt route                                                                                                                                                        |
| 404   | `intake.inbound.project_not_found`                     | The project of the create does not exist.                                                                                                                                                                                                                                                                                                         | inbound create                                                                                                                                                                                    |
| 404   | `intake.outbound.request.not_found`                    | No outbound request has that identity.                                                                                                                                                                                                                                                                                                            | outbound get, outbound discard                                                                                                                                                                    |
| 404   | `mission.record.not_found`                             | The evidence asset of a storage operation does not exist.                                                                                                                                                                                                                                                                                         | `intake.storage.put`, `intake.storage.check`, `intake.storage.get`, `intake.execution.storage.get`, `intake.storage.delete`                                                                       |
| 409   | `credential.credential.archived`                       | The credential is archived; an archive is final.                                                                                                                                                                                                                                                                                                  | credential rotate, credential update-metadata, credential archive, credential verify                                                                                                              |
| 409   | `credential.credential.in_use`                         | A dependent names the credential; `details` holds `agent_providers`, `bindings` and `inbounds`.                                                                                                                                                                                                                                                   | credential archive                                                                                                                                                                                |
| 409   | `credential.name.conflict`                             | A credential already has this name; details identify the holder.                                                                                                                                                                                                                                                                                  | credential create                                                                                                                                                                                 |
| 409   | `credential.revision.conflict`                         | The expected revision is stale.                                                                                                                                                                                                                                                                                                                   | credential rotate, credential update-metadata                                                                                                                                                     |
| 409   | `credential.revision.ended`                            | The revision is already ended, by a revoke or by a drain.                                                                                                                                                                                                                                                                                         | credential revoke                                                                                                                                                                                 |
| 409   | `credential.revision.newest_live`                      | The revoke names the newest live revision.                                                                                                                                                                                                                                                                                                        | credential revoke                                                                                                                                                                                 |
| 409   | `credential.revision.revoked`                          | A pinned use names a revoked revision.                                                                                                                                                                                                                                                                                                            | `intake.action.merge`, `intake.action.perform`, `intake.action.read`                                                                                                                              |
| 409   | `intake.inbound.event.in_flight`                       | The handoff of the pending event runs.                                                                                                                                                                                                                                                                                                            | event discard                                                                                                                                                                                     |
| 409   | `intake.inbound.event.state_conflict`                  | The event state permits no such transition, or a list names a pending event.                                                                                                                                                                                                                                                                      | event retry, event discard, event delete                                                                                                                                                          |
| 409   | `intake.inbound.events_pending`                        | The inbound holds a pending event.                                                                                                                                                                                                                                                                                                                | inbound delete                                                                                                                                                                                    |
| 409   | `intake.link.inbound_missing`                          | The project holds no inbound of the link resource; details `{ external_link }`.                                                                                                                                                                                                                                                                   | `intake.link.read`, `mission.node.check`                                                                                                                                                          |
| 409   | `intake.outbound.request.discarded`                    | A repeat names a discarded request.                                                                                                                                                                                                                                                                                                               | `intake.action.merge`, `intake.action.perform`, `intake.storage.delete`                                                                                                                           |
| 409   | `intake.outbound.request.in_flight`                    | The call of the request runs.                                                                                                                                                                                                                                                                                                                     | outbound discard, `intake.action.merge`, `intake.action.perform`, `intake.storage.delete`                                                                                                         |
| 409   | `intake.outbound.request.state_conflict`               | The request is not `pending`, or a delete list names a pending request.                                                                                                                                                                                                                                                                           | outbound discard, outbound delete                                                                                                                                                                 |
| 409   | `intake.storage.object_mismatch`                       | The object check finds no object, or its size or SHA-256 differs from the asset.                                                                                                                                                                                                                                                                  | `intake.storage.check`                                                                                                                                                                            |
| 409   | `mission.evidence.upload_expired`                      | The pending asset expired before its complete.                                                                                                                                                                                                                                                                                                    | `intake.storage.check`                                                                                                                                                                            |
| 409   | `mission.execution.context_mismatch`                   | The execution context differs from the proven claim; details `{ field }`.                                                                                                                                                                                                                                                                         | `intake.storage.put`, `intake.storage.check`, `intake.execution.storage.get`                                                                                                                      |
| 409   | `repository.credential.ssh_key_legacy`                 | The `ssh_credential` of the binding holds no generated key; details `{ credential }`. No git process starts.                                                                                                                                                                                                                                      | `intake.action.check`, `intake.action.perform`                                                                                                                                                    |
| 409   | `repository.host_key.unpinned`                         | The address host of the binding holds no pinned host key; details `{ host }`. No git process starts.                                                                                                                                                                                                                                              | `intake.action.check`, `intake.action.perform`                                                                                                                                                    |
| 422   | `intake.inbound.credential_invalid`                    | The credential name does not exist, its platform does not suit the inbound, or a `slack` webhook names no credential.                                                                                                                                                                                                                             | inbound create                                                                                                                                                                                    |
| 422   | `intake.inbound.platform_refused`                      | The platform refuses a validation request of a poll create.                                                                                                                                                                                                                                                                                       | inbound create                                                                                                                                                                                    |
| 422   | `intake.outbound.request.action_unmapped`              | The configured action has no row in the action table.                                                                                                                                                                                                                                                                                             | `intake.action.perform`                                                                                                                                                                           |
| 502   | `intake.platform.<platform>.<class>`                   | A call to a platform of the Intake Service answers a result class; `details.status` holds the HTTP status of the platform when the failure carries one, otherwise null.                                                                                                                                                                           | a command that calls Jira or Slack                                                                                                                                                                |
| 502   | `repository.connector.git_failed`                      | A git operation fails, is aborted or reaches its deadline. `intake.action.perform` answers it with `200` and stores it in the request `error` message.                                                                                                                                                                                            | `intake.action.check`, `intake.action.perform`, `intake.execution.gate_files.read`                                                                                                                |
| 502   | `repository.connector.ssh_agent_failed`                | The private SSH agent of a git operation does not start, or `ssh-add` refuses the key. `intake.action.perform` answers it with `200` and stores it in the request `error` message.                                                                                                                                                                | `intake.action.check`, `intake.action.perform`, `intake.execution.gate_files.read`                                                                                                                |
| 502   | `system.context.deadline_exceeded`                     | The SSH agent of a git operation reaches its deadline before the git work starts. `intake.action.perform` answers it with `200` and stores it in the request `error` message.                                                                                                                                                                     | `intake.action.check`, `intake.action.perform`, `intake.execution.gate_files.read`                                                                                                                |
| 502   | `repository.gate_declaration.invalid`                  | The gate declaration of the base branch does not match the declaration shape of the worker, or a path of `gate_files` is not canonical. The Intake Service keeps the bare repository for this error.                                                                                                                                              | `intake.execution.gate_files.read`                                                                                                                                                                |
| 502   | `repository.platform.github.<class>`                   | A GitHub call of the check answers a result class; `details.status` holds the GitHub HTTP status when the failure carries one, otherwise null.                                                                                                                                                                                                    | `intake.action.check`, `intake.link.read`                                                                                                                                                         |
| 502   | `storage.platform.s3.<class>`                          | An S3 call of the object check or the object delete answers a result class; `details.status` holds the S3 HTTP status when the failure carries one, otherwise null.                                                                                                                                                                               | `intake.storage.check`, `intake.storage.delete`                                                                                                                                                   |
| 503   | `intake.inbound.event.capacity_exceeded`               | The count of pending events is at its bound.                                                                                                                                                                                                                                                                                                      | receipt route                                                                                                                                                                                     |
| 503   | `intake.outbound.request.cli_unavailable`              | The binary of a CLI operation is missing or below its minimum version.                                                                                                                                                                                                                                                                            | a CLI write                                                                                                                                                                                       |
| local | `cli.intake.<command>.invalid_<argument>`              | A positional identity fails its prefix or ULID form, for example `cli.intake.inbound.get.invalid_inbound_id`.                                                                                                                                                                                                                                     | every leaf with a positional identity                                                                                                                                                             |
| local | `cli.intake.credential.revoke.invalid_revision`        | The `<revision>` argument is not a positive safe integer.                                                                                                                                                                                                                                                                                         | credential revoke                                                                                                                                                                                 |

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
