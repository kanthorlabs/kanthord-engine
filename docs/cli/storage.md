# Storage credential CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

This specification covers the implemented `kanthord storage credential` group, with
**10 command leaves**. The Storage component is a shared component, not a service.
It owns the credential routes of its platforms. A credential belongs to no project.
Custody declares no route and keeps the record functions that these routes call.

[Storage](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/storage.md) and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/storage.impl.md)
own the platform rules. The [credential route group](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-credential-route-group-of-a-component)
rules the routes and operations. This page details their CLI surface and introduces no design rule.
The [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface)
declares `storage` as a shared component group. The [operation contracts](../../src/storage/contract.ts), [CLI](../../src/apps/cli/storage.ts) and generated OpenAPI publish the wire names, paths, filters, output shapes and error codes.
The operation IDs have the form `storage.credential.<operation>`.
`storage.credential.update_metadata` is the operation ID for a metadata edit, and `storage.credential.revoke` for a revoke.

## Common calling convention

Every command uses `human` access and the [remote flags `[R]`](./common-flags.md#remote-flags-r).
Mutations use [mutation flags `[M]`](./common-flags.md#mutation-flags-m).
`list` uses [pagination flags `[L]`](./common-flags.md#pagination-flags-l).
Every command is unary and accepts [`--help`](./common-flags.md#--help).
A command reads no database, prompts for no input and rejects `--config`.
Unknown options, extra arguments, missing required inputs and invalid local
values fail before a request. Options are single-use. Inputs have no implicit
default. Request objects are closed; `null` does not mean omission.

The shared [`--endpoint`](./common-flags.md#--endpoint) and
[`--token`](./common-flags.md#--token) rules select the server and human JWT.
Read operations reject [`--idempotency-key`](./common-flags.md#--idempotency-key).
Mutations use that key and print it with their result. An indeterminate mutation
prints its key without claiming that the write failed. Replay lasts only for
the process and configured TTL; the CLI performs no automatic mutation retry.

[`--file`](./common-flags.md#--file) is required where the inventory names it.
For create, rotate and check, the secret-file policy requires a regular,
non-symlink file at mode `0600`, checked before reading, without permission
repair. The contents go to custody and are never echoed. Metadata update uses
the ordinary JSON-file rules and accepts no secret.

Success exits `0`. It prints one JSON value. Lists return one page `{ items, next_cursor }`, with a string
cursor or `null` on the last page. No answer holds a secret, token, ciphertext,
authentication header or reusable grant. Failures exit nonzero and print a
non-secret diagnostic. A supplied identity never proves authorization.

## Names and identities

| Value            | Type and validation                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CredentialId`   | `credential_<ulid>` under the [record contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-credential-store-record). Canonical uppercase ULID matching `[0-7][0-9A-HJKMNP-TV-Z]{25}`; reject a bare ULID or another prefix. |
| `CredentialName` | Human-selected server-wide unique name, 1 to 63 characters: lower-case letter first, then lower-case letters, digits and hyphens.                                                                                                                                      |
| `Timestamp`      | JSON safe integer of Unix milliseconds in UTC.                                                                                                                                                                                                                         |
| `Revision`       | Positive JSON safe integer returned by custody.                                                                                                                                                                                                                        |

## Command inventory

Each synopsis follows `kanthord storage credential`. All ten commands have `[R]` and
`human` access; five mutations have `[M]`, and one list has `[L]`.
All paths below are implemented routes under the ruled `/api/storage/credential` prefix.

| #   | Synopsis after `kanthord storage credential`              | HTTP route                                                                | Operation ID                         | Access/status        |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ | -------------------- |
| 1   | `create --file <path> [M] [R]`                            | `POST /api/storage/credential`                                            | `storage.credential.create`          | `human`; implemented |
| 2   | `list [--platform <platform>] [L] [R]`                    | `GET /api/storage/credential`                                             | `storage.credential.list`            | `human`; implemented |
| 3   | `get <credential-name> [R]`                               | `GET /api/storage/credential/:credential_name`                            | `storage.credential.get`             | `human`; implemented |
| 4   | `rotate <credential-name> --file <path> [M] [R]`          | `POST /api/storage/credential/:credential_name/revision`                  | `storage.credential.rotate`          | `human`; implemented |
| 5   | `update-metadata <credential-name> --file <path> [M] [R]` | `PUT /api/storage/credential/:credential_name/metadata`                   | `storage.credential.update_metadata` | `human`; implemented |
| 6   | `revoke <credential-name> <revision> [M] [R]`             | `POST /api/storage/credential/:credential_name/revision/:revision/revoke` | `storage.credential.revoke`          | `human`; implemented |
| 7   | `archive <credential-name> [M] [R]`                       | `POST /api/storage/credential/:credential_name/archive`                   | `storage.credential.archive`         | `human`; implemented |
| 8   | `platforms [R]`                                           | `GET /api/storage/credential/platform`                                    | `storage.credential.platform_list`   | `human`; implemented |
| 9   | `check --file <path> [R]`                                 | `POST /api/storage/credential/check`                                      | `storage.credential.check`           | `human`; implemented |
| 10  | `verify <credential-name> [R]`                            | `POST /api/storage/credential/:credential_name/verify`                    | `storage.credential.verify`          | `human`; implemented |

The static `/api/storage/credential/platform` and `/api/storage/credential/check` paths take precedence over `/:credential_name`, so custody refuses the names `login`, `platform` and `check`. Custody also reserves `ssh`.
These routes have no project identity.

A name whose platform belongs to another component answers `404 credential.credential.not_found` on every command that takes a name.
A `create` with a platform of another component answers `400 credential.platform.unsupported`.

## Record and platform schemas

A credential answer holds `name: CredentialName`, `platform` and `revisions`, an array of revision answers, newest first.
A revision answer holds `id: CredentialId`, `revision: Revision`, `metadata`, `created_at: Timestamp`
and `ended_at: Timestamp | null`. No answer holds `secret`.
`platform` is the closed enum of the [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/storage.impl.md#platform-validators): `s3`. [`platforms`](#platforms) answers the set.
Each platform holds exactly one secret shape from `s3_access_key`.
The [serialized credential budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#serialized-credential-budget) excludes `s3_access_key`.
The [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/storage.impl.md#platform-validators)
fix the secret shape and the metadata of each platform:

| Platform | Secret shape    | Metadata                                 |
| -------- | --------------- | ---------------------------------------- |
| `s3`     | `s3_access_key` | Required `{ endpoint, bucket, region }`. |

`get` adds `bindings` to the credential answer: the list of `{ project_id, project_name, binding_id, name }` of every binding revision that names the credential and that is a dependent. The Project Service answers that read.

For `s3`, `endpoint` is a required URL; `bucket` and `region` are required
nonblank strings. These fields serve the credential healthcheck.
A storage binding has its own endpoint, bucket, region and prefix for work.
The `s3` credential holds `s3:ListBucket` on the bucket of each binding that uses it.
With that permission, an absent object answers `404`. The object check reads only `404` as an absent object.
[Suitability](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#suitability)
compares only the platform of the record with the platform of its use, before
any remote call. It compares no metadata.

## `create`

The required file supplies the body; params and query are empty. Required
fields have no default:

- `name`: `CredentialName`.
- `platform`: a platform of the Storage component, `s3`.
- `metadata`: the platform schema above, with explicit `null` for no metadata.
- `secret`: a closed object of the secret shape of the platform. For `s3_access_key`, required nonempty
  strings `{ access_key_id, secret_access_key }`; a session token is invalid.

Custody validates the local schema and makes no remote call. HTTP
`200` returns the credential answer with revision 1. The name is the natural key of
creation. A taken name answers `409 credential.name.conflict`, with the identity
of its newest revision in `error.details`, including a retry after restart. The CLI prints
the code and the HTTP status, not that identity, and never the submitted secret.

## `list`

No positional arguments and no body. The optional filter maps to query `platform`.
The optional `--include-archived` flag maps to query `include_archived`, the string `true` or `false` with default `false`. Without it, the list leaves out an archived name.
It is single-use with no default filter. The platform enum is defined above.
`limit` and optional `cursor` use the shared pagination contract.
HTTP `200` returns one credential answer for each name of this component in `items`, in ascending name
order under [pagination](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
The CLI fetches no further page implicitly. Custody drains unpinned older live revisions of each returned name in the read transaction before projecting the page.

## `platforms`

No positional arguments, no body and no pagination. HTTP `200` returns
`{ items: [{ platform, secret_shape, login_modes, metadata_fields, verifiable }] }`,
the platforms of the platform table of this component.
`login_modes` is `[]` for a
platform whose secret shape is not `oauth`. `metadata_fields` names the required
string fields of the metadata. `verifiable` is `true` when the platform validation
makes a remote call. The command answers only the shared error codes.

## `check`

```text
kanthord storage credential check --file <path> [R]
```

The [pre-save check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-pre-save-check) declares `storage.credential.check`, a read under `human` access, at `POST /api/storage/credential/check`.
It checks a typed secret before a `create` and stores nothing. It takes no mutation key and rejects `--idempotency-key`.
The required `--file` holds the closed object `{ platform, secret, metadata }`, the `create` body without `name`. The secret-file policy of `create` applies: a regular, non-symlink file at mode `0600`.
The component validates the body with the secret shape and the metadata schema of the platform, as `create` does.
The `s3` check sends a `HeadBucket` request with the typed key and the metadata.
The platform check runs on the typed secret with a 10 s deadline. A check that exceeds its deadline answers `unknown`.
The component drops the secret after the call and logs no material.

HTTP `200` answers `{ status, capability }`, the health entry of the [health report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-resource-healthcheck-report):

- `status` is `healthy`, `unhealthy` or `unknown`.
- `capability` is the capability of the platform check, the same value that the health report shows.

A platform with `verifiable: false` or with the secret shape `oauth` answers `400 credential.check.unsupported`.
A platform of another component answers `400 credential.platform.unsupported`.

## `verify <credential-name>`

```text
kanthord storage credential verify <credential-name> [R]
```

The [record verify](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-record-verify) declares `storage.credential.verify`, a read under `human` access, at `POST /api/storage/credential/:credential_name/verify`.
The required `CredentialName` maps to `params.credential_name`. Query is empty and body absent. The command takes no mutation key and rejects `--idempotency-key`.
It checks one stored record and stores no result.
The `s3` check sends a `HeadBucket` request with the stored key and the metadata.
The component releases the newest live revision of the record, runs the same platform check as the health report with a 10 s deadline, and drops the material after the call. A check that exceeds its deadline answers `unknown`.
The release outside an execution pins no revision, drains no revision and writes no row.

HTTP `200` answers `{ status, capability }`, the health entry of the [health report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-resource-healthcheck-report):

- `status` is `healthy`, `unhealthy` or `unknown`.
- `capability` is the capability of the platform check, the same value that the health report shows.

An archived record answers `409 credential.credential.archived`.
A platform with `verifiable: false` answers `400 credential.check.unsupported`.
An unknown name, or a name of another component, answers `404 credential.credential.not_found`.

## `get <credential-name>`

The required `CredentialName` has no default and maps to `params.credential_name`.
Query is empty and body absent. HTTP `200` returns one credential answer with the added list `bindings`;
an unknown name, or a name of another component, answers `404 credential.credential.not_found`. The read transaction first drains unpinned older live revisions of that name.

## `rotate <credential-name>`

The required `CredentialName` maps to `params.credential_name`; query is empty.
The required file supplies `{ expected_revision, secret }` and an optional `metadata`. `expected_revision` is the newest live revision that the human read. The secret shape of the
platform determines its closed secret schema. `s3_access_key` uses the create schema.
The file has no
name, platform or identity override.

Rotation adds the next revision under the same name and, in the same transaction, drains every older live revision that no live execution pins.
An absent `metadata` copies the metadata of the newest live revision. A supplied `metadata`
matches the platform schema. Rotation makes no remote call and commits in one transaction.
It changes no binding revision. HTTP `200` returns the credential answer
without the secret.
Custody logs the human identity and record identity, never material.
This command does not rotate `master_key`.

## `update-metadata <credential-name>`

The required `CredentialName` maps to `params.credential_name`; query is empty.
The required file supplies exactly `{ expected_revision, metadata }`, with the newest live revision that the human read and a complete replacement that
matches the platform schema. It accepts no secret or platform change.
The edit inserts the next revision with the secret of the newest live revision, and the older revisions stay live until custody drains them or a human revokes them. HTTP `200` returns
the credential answer. The `s3` metadata `{ endpoint, bucket, region }` is always required.

## `archive <credential-name>`

The required `CredentialName` maps to `params.credential_name`. Query is empty and body absent.
The archive checks every dependent in one transaction: every agent provider, every binding revision that `bindingsNaming` answers and every inbound that `inboundsNaming` answers.
A dependent refuses the archive with `409 credential.credential.in_use`, and `error.details` lists the dependents as `{ agent_providers: [{ agent_name, provider_name }], bindings: [{ binding_id, project_id }], inbounds: [{ inbound_id }] }`.
Without a dependent, the archive sets `ended_at` on every live revision of the name and keeps the rows, because an execution record references them.
A name with no live revision is archived. An archive is final: an archived name refuses `rotate`, `update-metadata` and `archive` with `409 credential.credential.archived`, and the name stays taken.
HTTP `200` returns the credential answer with every revision ended. An unknown name answers `404 credential.credential.not_found`.

## `revoke <credential-name> <revision>`

The required `CredentialName` maps to `params.credential_name`, and the required
`Revision` maps to `params.revision`. Query is empty and body absent.
The revoke ends that revision at once, and every execution that pins it is refused
at its next use of the credential. A revoke of the newest live revision answers
`409 credential.revision.newest_live`. A revoke of an ended revision answers
`409 credential.revision.ended`. HTTP `200` returns the credential answer after draining other unpinned older live revisions in the same transaction.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                             | Condition                                                                                       | Commands                                                               |
| ----- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 404   | `credential.credential.not_found`                | The credential does not exist, or its platform is not a platform of the Storage component.      | get, rotate, update-metadata, revoke, archive, verify, worker handover |
| local | `cli.storage.credential.revoke.invalid_revision` | The `<revision>` argument is not a positive safe integer.                                       | revoke                                                                 |
| 400   | `credential.input.invalid`                       | Secret or metadata validation fails, or the name is reserved.                                   | create, rotate, update-metadata, check                                 |
| 409   | `credential.name.conflict`                       | A credential already has this name; details identify the holder.                                | create                                                                 |
| 400   | `credential.platform.mismatch`                   | The requested platform differs from the stored platform.                                        | binding apply (custody collaboration), worker handover                 |
| 400   | `credential.platform.unsupported`                | The platform is not a platform of the Storage component.                                        | create, check                                                          |
| 400   | `credential.check.unsupported`                   | The platform has `verifiable: false` or the secret shape `oauth`.                               | check, verify                                                          |
| 409   | `credential.revision.conflict`                   | The expected revision is stale.                                                                 | rotate, update-metadata                                                |
| 409   | `credential.revision.ended`                      | The revision is already ended, by a revoke or by a drain.                                       | revoke                                                                 |
| 409   | `credential.revision.newest_live`                | The revoke names the newest live revision.                                                      | revoke                                                                 |
| 409   | `credential.credential.in_use`                   | A dependent names the credential; `details` holds `agent_providers`, `bindings` and `inbounds`. | archive                                                                |
| 409   | `credential.credential.archived`                 | The credential is archived; an archive is final.                                                | rotate, update-metadata, archive, verify                               |
| 404   | `credential.revision.not_found`                  | The revision does not exist, or the credential name is unknown.                                 | revoke                                                                 |
| 409   | `credential.revision.revoked`                    | A pinned use names a revoked revision.                                                          | worker handover, worker credential (API only)                          |

Errors contain no secret. Dependency refusals list dependents in `error.details`.

## Boundaries

The [platform validator](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/storage.impl.md#platform-validators) of `s3` validates a record on demand through the health report.
The [credential healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-credential-healthcheck) rules apply.
Create and rotate make no remote call.
The S3 `HeadBucket` probe maps 200 to `ok`, 404 to a missing bucket and 403 to
`unknown`; a write-only key can work despite a forbidden probe.

No command here exports a credential or rotates the master key.
Dependents prevent an archive, and the dependency check and the archive are atomic.
Secret handover and refresh reports are implemented Worker API operations; the
handover CLI leaf is implemented. None is a
CLI credential-record answer. Handover first pins the newest live revision,
subsequent uses retain that pin, and a revoked pinned revision refuses use.
