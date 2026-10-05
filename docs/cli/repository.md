# Repository credential CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

This specification covers the implemented `kanthord repository credential` group, with
**11 command leaves**. The Repository component is a shared component, not a service.
It owns the credential routes of its platforms. A credential belongs to no project.
Custody declares no route and keeps the record functions that these routes call.

[Repository](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.md) and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.impl.md)
own the platform rules. The [credential route group](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-credential-route-group-of-a-component)
rules the routes and operations. This page details their CLI surface and introduces no design rule.
The [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface)
declares `repository` as a shared component group. The [operation contracts](../../src/repository/contract.ts), [CLI](../../src/apps/cli/repository.ts) and generated OpenAPI publish the wire names, paths, filters, output shapes and error codes.
The operation IDs have the form `repository.credential.<operation>`.
`repository.credential.update_metadata` is the operation ID for a metadata edit, and `repository.credential.revoke` for a revoke.

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

Success exits `0`. It prints one JSON value. Lists return one page `{ items, nextCursor }`, with a string
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

Each synopsis follows `kanthord repository credential`. All eleven commands have `[R]` and
`human` access; five mutations have `[M]`, and one list has `[L]`.
All paths below are implemented routes under the ruled `/api/repository/credential` prefix.

| #   | Synopsis after `kanthord repository credential`           | HTTP route                                                                  | Operation ID                            | Access/status        |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------- | -------------------- |
| 1   | `create --file <path> [M] [R]`                            | `POST /api/repository/credential`                                           | `repository.credential.create`          | `human`; implemented |
| 2   | `list [--platform <platform>] [L] [R]`                    | `GET /api/repository/credential`                                            | `repository.credential.list`            | `human`; implemented |
| 3   | `get <credential-name> [R]`                               | `GET /api/repository/credential/:credentialName`                            | `repository.credential.get`             | `human`; implemented |
| 4   | `rotate <credential-name> --file <path> [M] [R]`          | `POST /api/repository/credential/:credentialName/revision`                  | `repository.credential.rotate`          | `human`; implemented |
| 5   | `update-metadata <credential-name> --file <path> [M] [R]` | `PUT /api/repository/credential/:credentialName/metadata`                   | `repository.credential.update_metadata` | `human`; implemented |
| 6   | `revoke <credential-name> <revision> [M] [R]`             | `POST /api/repository/credential/:credentialName/revision/:revision/revoke` | `repository.credential.revoke`          | `human`; implemented |
| 7   | `archive <credential-name> [M] [R]`                       | `POST /api/repository/credential/:credentialName/archive`                   | `repository.credential.archive`         | `human`; implemented |
| 8   | `platforms [R]`                                           | `GET /api/repository/credential/platform`                                   | `repository.credential.platform_list`   | `human`; implemented |
| 9   | `check --file <path> [R]`                                 | `POST /api/repository/credential/check`                                     | `repository.credential.check`           | `human`; implemented |
| 10  | `verify <credential-name> [R]`                            | `POST /api/repository/credential/:credentialName/verify`                    | `repository.credential.verify`          | `human`; implemented |
| 11  | `ssh-discover [R]`                                        | `GET /api/repository/credential/ssh/discover`                               | `repository.credential.ssh_discover`    | `human`; proposed    |

The static `/api/repository/credential/platform`, `/api/repository/credential/check` and `/api/repository/credential/ssh/discover` paths take precedence over `/:credentialName`, so custody refuses the names `login`, `platform`, `check` and `ssh`.
These routes have no project identity.

A name whose platform belongs to another component answers `404 credential.credential.not_found` on every command that takes a name.
A `create` with a platform of another component answers `400 credential.platform.unsupported`.

## Record and platform schemas

A credential answer holds `name: CredentialName`, `platform` and `revisions`, an array of revision answers, newest first.
A revision answer holds `id: CredentialId`, `revision: Revision`, `metadata`, `createdAt: Timestamp`
and `endedAt: Timestamp | null`. No answer holds `secret`.
`platform` is the closed enum of the [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.impl.md#platform-validators): `github` and `ssh`. [`platforms`](#platforms) answers the set.
Each platform holds exactly one secret shape from `api_key` and `none`.
The [serialized credential budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#serialized-credential-budget) bounds `api_key` to 48,915 UTF-8 bytes of normalized canonical pi-ai credential JSON, including type, structure and escaping. Creation and rotation reject an oversized value with HTTP 400 `credential.input.invalid` before writing.
The [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.impl.md#platform-validators)
fix the secret shape and the metadata of each platform:

| Platform | Secret shape | Metadata                                                                             |
| -------- | ------------ | ------------------------------------------------------------------------------------ |
| `github` | `api_key`    | None; wire value `null`.                                                             |
| `ssh`    | `none`       | `{ host, hostname, port, identity_file }`; every key required. `port` is an integer. |

An `ssh` record pins the SSH identity of a repository binding. `host` is an alias of `~/.ssh/config`. `hostname`, `port` and `identity_file` equal the `hostname`, `port` and the one `identityfile` that `ssh -G -- <host>` resolves.
Create, rotate and update-metadata of an `ssh` record run `ssh -G` and compare the result with the metadata. `verify` runs the same comparison and answers `unhealthy` for a refusal:

- A resolution with `identitiesonly` other than `yes`, or with a number of `identityfile` lines other than 1, answers `400 repository.credential.ssh_identity_ambiguous`.
- A resolved value that differs from the metadata answers `400 repository.credential.ssh_drift`. `details` names each differing key.

`get` adds `bindings` to the credential answer: the list of `{ projectId, projectName, bindingId, name }` of every binding revision that names the credential and that is a dependent. The Project Service answers that read.

[Suitability](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#suitability)
compares only the platform of the record with the platform of its use, before
any remote call. It compares no metadata.

## `create`

The required file supplies the body; params and query are empty. Required
fields have no default:

- `name`: `CredentialName`.
- `platform`: a platform of the Repository component, `github` or `ssh`.
- `metadata`: the platform schema above, with explicit `null` for no metadata.
- `secret`: a closed object of the secret shape of the platform. For `api_key`, `{ key }`, with a required nonempty
  string whose exact value is preserved. For `none`, `{}`.

Custody validates the local schema and makes no remote call. HTTP
`200` returns the credential answer with revision 1. The name is the natural key of
creation. A taken name answers `409 credential.name.conflict`, with the identity
of its newest revision in `error.details`, including a retry after restart. The CLI prints
that identity, never the submitted secret.

## `list`

No positional arguments and no body. The optional filter maps to query `platform`.
The optional `--include-archived` flag maps to query `includeArchived`, a boolean that defaults to `false`. Without it, the list leaves out an archived name.
It is single-use with no default filter. The platform enum is defined above.
`limit` and optional `cursor` use the shared pagination contract.
HTTP `200` returns one credential answer for each name of this component in `items`, in ascending name
order under [pagination](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
The CLI fetches no further page implicitly. Custody drains unpinned older live revisions of each returned name in the read transaction before projecting the page.

## `platforms`

No positional arguments, no body and no pagination. HTTP `200` returns
`{ items: [{ platform, secretShape, loginModes, metadataFields, verifiable }] }`,
the platforms of the platform table of this component.
`loginModes` is `[]` for a
platform whose secret shape is not `oauth`. `metadataFields` names the required
string fields of the metadata. `verifiable` is `true` when the platform validation
makes a remote call. The command answers only the shared error codes.

## `check`

```text
kanthord repository credential check --file <path> [R]
```

The [pre-save check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-pre-save-check) declares `repository.credential.check`, a read under `human` access, at `POST /api/repository/credential/check`.
It checks a typed secret before a `create` and stores nothing. It takes no mutation key and rejects `--idempotency-key`.
The required `--file` holds the closed object `{ platform, secret, metadata }`, the `create` body without `name`. The secret-file policy of `create` applies: a regular, non-symlink file at mode `0600`.
The component validates the body with the secret shape and the metadata schema of the platform, as `create` does.
The `github` check reads the rate limit with the typed token.
The platform check runs on the typed secret with a 10 s deadline. A check that exceeds its deadline answers `unknown`.
The component drops the secret after the call and logs no material.

HTTP `200` answers `{ status, capability }`, the health entry of the [health report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-resource-healthcheck-report):

- `status` is `healthy`, `unhealthy` or `unknown`.
- `capability` is the capability of the platform check, the same value that the health report shows.

A platform with `verifiable: false` or with the secret shape `oauth` answers `400 credential.check.unsupported`.
A platform of another component answers `400 credential.platform.unsupported`.

## `verify <credential-name>`

```text
kanthord repository credential verify <credential-name> [R]
```

The [record verify](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-record-verify) declares `repository.credential.verify`, a read under `human` access, at `POST /api/repository/credential/:credentialName/verify`.
The required `CredentialName` maps to `params.credentialName`. Query is empty and body absent. The command takes no mutation key and rejects `--idempotency-key`.
It checks one stored record and stores no result.
The `github` check reads the rate limit with the stored token.
The component releases the newest live revision of the record, runs the same platform check as the health report with a 10 s deadline, and drops the material after the call. A check that exceeds its deadline answers `unknown`.
The release outside an execution pins no revision, drains no revision and writes no row.

HTTP `200` answers `{ status, capability }`, the health entry of the [health report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-resource-healthcheck-report):

- `status` is `healthy`, `unhealthy` or `unknown`.
- `capability` is the capability of the platform check, the same value that the health report shows.

An archived record answers `409 credential.credential.archived`.
A platform with `verifiable: false` answers `400 credential.check.unsupported`.
An unknown name, or a name of another component, answers `404 credential.credential.not_found`.

## `get <credential-name>`

The required `CredentialName` has no default and maps to `params.credentialName`.
Query is empty and body absent. HTTP `200` returns one credential answer with the added list `bindings`;
an unknown name, or a name of another component, answers `404 credential.credential.not_found`. The read transaction first drains unpinned older live revisions of that name.

## `rotate <credential-name>`

The required `CredentialName` maps to `params.credentialName`; query is empty.
The required file supplies `{ expectedRevision, secret }` and an optional `metadata`. `expectedRevision` is the newest live revision that the human read. The secret shape of the
platform determines its closed secret schema. `api_key` uses the create schema.
The file has no
name, platform or identity override.

Rotation adds the next revision under the same name and, in the same transaction, drains every older live revision that no live execution pins.
An absent `metadata` copies the metadata of the newest live revision. A supplied `metadata`
matches the platform schema. Rotation makes no remote call and commits in one transaction.
It changes no binding revision. HTTP `200` returns the credential answer
without the secret.
Custody logs the human identity and record identity, never material.
This command does not rotate `masterKey`.

## `update-metadata <credential-name>`

The required `CredentialName` maps to `params.credentialName`; query is empty.
The required file supplies exactly `{ expectedRevision, metadata }`, with the newest live revision that the human read and a complete replacement that
matches the platform schema. It accepts no secret or platform change.
The edit inserts the next revision with the secret of the newest live revision, and the older revisions stay live until custody drains them or a human revokes them. HTTP `200` returns
the credential answer. No metadata exists for `github`, so the replacement is `null`.

## `archive <credential-name>`

The required `CredentialName` maps to `params.credentialName`. Query is empty and body absent.
The archive checks every dependent in one transaction: every agent provider, every binding revision that `bindingsNaming` answers and every inbound that `inboundsNaming` answers.
A dependent refuses the archive with `409 credential.credential.in_use`, and `error.details` lists the dependents as `{ agentProviders: [{ agentName, providerName }], bindings: [{ bindingId, projectId }], inbounds: [{ inboundId }] }`.
Without a dependent, the archive sets `ended_at` on every live revision of the name and keeps the rows, because an execution record references them.
A name with no live revision is archived. An archive is final: an archived name refuses `rotate`, `update-metadata` and `archive` with `409 credential.credential.archived`, and the name stays taken.
HTTP `200` returns the credential answer with every revision ended. An unknown name answers `404 credential.credential.not_found`.

## `revoke <credential-name> <revision>`

The required `CredentialName` maps to `params.credentialName`, and the required
`Revision` maps to `params.revision`. Query is empty and body absent.
The revoke ends that revision at once, and every execution that pins it is refused
at its next use of the credential. A revoke of the newest live revision answers
`409 credential.revision.newest_live`. A revoke of an ended revision answers
`409 credential.revision.ended`. HTTP `200` returns the credential answer after draining other unpinned older live revisions in the same transaction.

## `ssh-discover`

The command takes no params, no query and no body.
It reads the `Host` lines of the top-level `~/.ssh/config` of the server host and follows no `Include`. It skips each pattern that holds `*`, `?` or `!`.
It runs `ssh -G -- <host>` for each alias and keeps an alias whose resolved `hostname` contains `github`, `gitlab` or `bitbucket`.
HTTP `200` answers `{ items }`. Each item holds `host`, `hostname`, `port`, `identity_file`, `state` and `reason`:

- `state` is `ready`, `refused` or `present`.
- `present` means that a live `ssh` record holds the host.
- `reason` holds the refusal code of a `refused` alias, and null otherwise.

The command writes nothing. A human creates each record with `create`.
An unreadable `~/.ssh/config` answers `422 repository.credential.ssh_config_unreadable`.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                | Condition                                                                                      | Commands                                                               |
| ----- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 404   | `credential.credential.not_found`                   | The credential does not exist, or its platform is not a platform of the Repository component.  | get, rotate, update-metadata, revoke, archive, verify, worker handover |
| local | `cli.repository.credential.revoke.invalid_revision` | The `<revision>` argument is not a positive safe integer.                                      | revoke                                                                 |
| 400   | `credential.input.invalid`                          | Secret or metadata validation fails, including the byte budget, or the name is reserved.       | create, rotate, update-metadata, check                                 |
| 409   | `credential.name.conflict`                          | A credential already has this name; details identify the holder.                               | create                                                                 |
| 400   | `credential.platform.mismatch`                      | The requested platform differs from the stored platform.                                       | binding apply (custody collaboration), worker handover                 |
| 400   | `credential.platform.unsupported`                   | The platform is not a platform of the Repository component.                                    | create, check                                                          |
| 400   | `credential.check.unsupported`                      | The platform has `verifiable: false` or the secret shape `oauth`.                              | check, verify                                                          |
| 409   | `credential.revision.conflict`                      | The expected revision is stale.                                                                | rotate, update-metadata                                                |
| 409   | `credential.revision.ended`                         | The revision is already ended, by a revoke or by a drain.                                      | revoke                                                                 |
| 409   | `credential.revision.newest_live`                   | The revoke names the newest live revision.                                                     | revoke                                                                 |
| 409   | `credential.credential.in_use`                      | A dependent names the credential; `details` holds `agentProviders`, `bindings` and `inbounds`. | archive                                                                |
| 409   | `credential.credential.archived`                    | The credential is archived; an archive is final.                                               | rotate, update-metadata, archive, verify                               |
| 404   | `credential.revision.not_found`                     | The revision does not exist.                                                                   | revoke                                                                 |
| 409   | `credential.revision.revoked`                       | A pinned use names a revoked revision.                                                         | worker handover, worker credential (API only)                          |
| 400   | `repository.credential.ssh_identity_ambiguous`      | The SSH host resolves without `identitiesonly yes` or without exactly one `identityfile`.      | create, rotate, update-metadata, binding apply, ssh-discover (reason)  |
| 400   | `repository.credential.ssh_drift`                   | `ssh -G` resolves values that differ from the metadata; details name each differing key.       | create, rotate, update-metadata, binding apply                         |
| 422   | `repository.credential.ssh_config_unreadable`       | The server cannot read `~/.ssh/config`.                                                        | ssh-discover                                                           |

Errors contain no secret. Dependency refusals list dependents in `error.details`.

## Boundaries

The [platform validator](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/repository.impl.md#platform-validators) of `github` validates a record on demand through the health report.
The [credential healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-credential-healthcheck) rules apply.
The probe reads the GitHub rate limit and spends none. Create and rotate make
no remote call.

No command here exports a credential, mints a GitHub App token or rotates the master key.
Dependents prevent an archive, and the dependency check and the archive are atomic.
Secret handover and refresh reports are implemented Worker API operations; the
handover CLI leaf is implemented. None is a
CLI credential-record answer. Handover first pins the newest live revision,
subsequent uses retain that pin, and a revoked pinned revision refuses use.
