# Credential CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

This specification covers the implemented `kanthord credential` group, with
**9 implemented command leaves**. Custody is a shared
component, not a service or a part of Project. It owns server-wide credential
records and OAuth login sessions. A credential belongs to no project.

[Custody](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.md)
and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md)
own the rules. This page details their CLI surface and introduces no design rule.
The [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface)
declares `credential` as the shared component group. The [operation contracts](../../src/custody/contract.ts), [CLI](../../src/apps/cli/credential.ts) and generated OpenAPI publish the wire names, paths, filters, output shapes and error codes.
The `credential.create`, `credential.list`, `credential.get`, `credential.rotate`
and OAuth operation IDs follow the root contract. `credential.update_metadata`
is the operation ID for a metadata edit, and `credential.revoke` for a revoke.

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
For create and rotate, the secret-file policy requires a regular,
non-symlink file at mode `0600`, checked before reading, without permission
repair. The contents go to custody and are never echoed. Metadata update uses
the ordinary JSON-file rules and accepts no secret.

Success exits `0`. Except for the login line output specified below, it prints
one JSON value. Lists return one page `{ items, nextCursor }`, with a string
cursor or `null` on the last page. No answer holds a secret, token, ciphertext,
authentication header or reusable grant. Failures exit nonzero and print a
non-secret diagnostic. A supplied identity never proves authorization.

## Names and identities

| Value            | Type and validation                                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CredentialId`   | `credential_<ulid>` under the [record contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-credential-store-record). Canonical uppercase ULID matching `[0-7][0-9A-HJKMNP-TV-Z]{25}`; reject a bare ULID or another prefix. |
| `CredentialName` | Human-selected server-wide unique name, 1 to 63 characters: lower-case letter first, then lower-case letters, digits and hyphens.                                                                                                                                      |
| `LoginSessionId` | `login_session_<ulid>`, with the same canonical ULID validation.                                                                                                                                                                                                       |
| `Timestamp`      | JSON safe integer of Unix milliseconds in UTC.                                                                                                                                                                                                                         |
| `Revision`       | Positive JSON safe integer returned by custody.                                                                                                                                                                                                                        |

## Command inventory

Each synopsis follows `kanthord credential`. All nine commands have `[R]` and
`human` access; six mutations have `[M]`, and one list has `[L]`.
All paths below are implemented routes under the ruled `/api/credential` prefix.

| #   | Synopsis after `kanthord credential`                              | HTTP route                                                       | Operation ID                 | Access/status        |
| --- | ----------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------- | -------------------- |
| 1   | `create --file <path> [M] [R]`                                    | `POST /api/credential`                                           | `credential.create`          | `human`; implemented |
| 2   | `list [--platform <platform>] [L] [R]`                            | `GET /api/credential`                                            | `credential.list`            | `human`; implemented |
| 3   | `get <credential-name> [R]`                                       | `GET /api/credential/:credentialName`                            | `credential.get`             | `human`; implemented |
| 4   | `rotate <credential-name> --file <path> [M] [R]`                  | `POST /api/credential/:credentialName/revision`                  | `credential.rotate`          | `human`; implemented |
| 5   | `update-metadata <credential-name> --file <path> [M] [R]`         | `PUT /api/credential/:credentialName/metadata`                   | `credential.update_metadata` | `human`; implemented |
| 6   | `login <platform> [--mode browser\|device] --name <name> [M] [R]` | `POST /api/credential/login`                                     | `credential.login`           | `human`; implemented |
| 7   | `login-code <session> <value> [M] [R]`                            | `POST /api/credential/login/:sessionId/code`                     | `credential.login_code`      | `human`; implemented |
| 8   | `login-status <session> [R]`                                      | `GET /api/credential/login/:sessionId`                           | `credential.login_status`    | `human`; implemented |
| 9   | `revoke <credential-name> <revision> [M] [R]`                     | `POST /api/credential/:credentialName/revision/:revision/revoke` | `credential.revoke`          | `human`; implemented |

The static `/api/credential/login` path takes precedence over `/:credentialName`, so custody refuses the name `login`.
These routes have no project identity. The proposed provider check is in
[Worker](./worker.md#provider-check--proposed), not this group.

## Record and platform schemas

A credential answer holds `name: CredentialName`, `platform` and `revisions`, an array of revision answers, newest first.
A revision answer holds `id: CredentialId`, `revision: Revision`, `metadata`, `createdAt: Timestamp`
and `endedAt: Timestamp | null`. No answer holds `secret`.
`platform` is the closed enum `github | github-copilot | anthropic | openai-compatible | s3`.
Each platform holds exactly one secret shape from `api_key | oauth | s3_access_key`.
The [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#platform-validators)
fix the secret shape and the metadata of each platform:

| Platform            | Secret shape    | Metadata                                 |
| ------------------- | --------------- | ---------------------------------------- |
| `github`            | `api_key`       | None; wire value `null`.                 |
| `github-copilot`    | `oauth`         | None; wire value `null`.                 |
| `anthropic`         | `api_key`       | None; wire value `null`.                 |
| `openai-compatible` | `api_key`       | Required `{ baseUrl, models }`.          |
| `s3`                | `s3_access_key` | Required `{ endpoint, bucket, region }`. |

For `openai-compatible`:

- `baseUrl` is required, uses `https` or `http`, and has no query or fragment.
  It is fixed for the life of the revision. A rotation can set a different endpoint; a metadata edit cannot.
  An official OpenAI record uses `https://api.openai.com/v1`.
- `models` is required and starts as `[]` at creation. A human adds approved
  models through a metadata revision after `worker provider check`.
- Each model has a required `id` and optional `contextWindow`, `maxTokens` and
  `reasoningLevels`. `id` is a nonblank string. An omitted value takes the pi 0.86.0
  default: `contextWindow` `128000`, `maxTokens` `16384`, `reasoningLevels` `["off"]`.
  Both limits are positive integers, and `maxTokens` is at most `contextWindow`.
- `reasoningLevels` is an array of established levels from `off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`. An omitted list supplies only `off`.
- A model cannot be removed while a default configuration or entry names it.
  The refusal lists the dependents. The dependency check and metadata update
  commit in one transaction. Empty `models` permits no agent model selection.

For `s3`, `endpoint` is a required URL; `bucket` and `region` are required
nonblank strings. These fields serve the credential healthcheck.
A storage binding has its own endpoint, bucket, region and prefix for work.
[Suitability](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#suitability)
compares only the platform of the record with the platform of its use, before
any remote call. It compares no metadata.

## `create`

The required file supplies the body; params and query are empty. Required
fields have no default:

- `name`: `CredentialName`.
- `platform`: one of the four platforms whose secret shape is not `oauth`;
  `github-copilot` requires `login`.
- `metadata`: the platform schema above, with explicit `null` for no metadata.
- `secret`: a closed object of the secret shape of the platform. For `api_key`, `{ key }`, with a required nonempty
  string whose exact value is preserved. For `s3_access_key`, required nonempty
  strings `{ accessKeyId, secretAccessKey }`; a session token is invalid.

Custody validates the local schema and makes no remote call. HTTP
`200` returns the credential answer with revision 1. The name is the natural key of
creation. A taken name answers `409 credential.name.conflict`, with the identity
of its newest revision in `error.details`, including a retry after restart. The CLI prints
that identity, never the submitted secret.

## `list`

No positional arguments and no body. The optional filter maps to query `platform`.
It is single-use with no default filter. The platform enum is defined above.
`limit` and optional `cursor` use the shared pagination contract.
HTTP `200` returns one credential answer for each name in `items`, in ascending name
order under [pagination](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
The CLI fetches no further page implicitly. Custody drains unpinned older live revisions of each returned name in the read transaction before projecting the page.

## `get <credential-name>`

The required `CredentialName` has no default and maps to `params.credentialName`.
Query is empty and body absent. HTTP `200` returns one credential answer;
an unknown name answers `404 credential.credential.not_found`. The read transaction first drains unpinned older live revisions of that name.

## `rotate <credential-name>`

The required `CredentialName` maps to `params.credentialName`; query is empty.
The required file supplies `{ expectedRevision, secret }` and an optional `metadata`. `expectedRevision` is the newest live revision that the human read. The secret shape of the
platform determines its closed secret schema. `api_key` and `s3_access_key` use the create schemas.
An OAuth secret is `{ refresh, access, expires }`, the pi-ai credential shape;
initial OAuth material enters only through a login session. The file has no
name, platform or identity override.

Rotation adds the next revision under the same name and, in the same transaction, drains every older live revision that no live execution pins.
An absent `metadata` copies the metadata of the newest live revision. A supplied `metadata`
matches the platform schema, can set a new `openai-compatible.baseUrl`, and keeps every model
that a default or an entry names. Rotation makes no remote call and commits in one transaction.
It changes no binding revision. HTTP `200` returns the credential answer
without the secret.
Custody logs the human identity and record identity, never material.
This command does not rotate `masterKey`.

## `update-metadata <credential-name>`

The required `CredentialName` maps to `params.credentialName`; query is empty.
The required file supplies exactly `{ expectedRevision, metadata }`, with the newest live revision that the human read and a complete replacement that
matches the platform schema. It accepts no secret or platform change.
The edit inserts the next revision with the secret of the newest live revision, and the older revisions stay live until custody drains them or a human revokes them. HTTP `200` returns
the credential answer. An `openai-compatible.baseUrl` change fails; a rotation sets a new one.
Removal of a model used by a default or entry fails and lists its dependents;
the check and update are atomic. No remote probe supplies approval.

## `revoke <credential-name> <revision>`

The required `CredentialName` maps to `params.credentialName`, and the required
`Revision` maps to `params.revision`. Query is empty and body absent.
The revoke ends that revision at once, and every execution that pins it is refused
at its next use of the credential. A revoke of the newest live revision answers
`409 credential.revision.newest_live`. A revoke of an ended revision answers
`409 credential.revision.ended`. HTTP `200` returns the credential answer after draining other unpinned older live revisions in the same transaction.

## `login <platform>`

The [OAuth login contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-oauth-login)
requires a platform that accepts `oauth`; the implemented platform set permits
`github-copilot` only. The positional platform is required with no default.
`--name` is required `CredentialName` with no default.

The body is `{ platform, mode?, name }`, with empty
params and query. Optional `--mode` is `browser` or `device`, without a CLI
default; absence leaves selection to the platform's supported flow. Custody
maps `device` to pi-ai interaction value `device_code`. A platform with one
mode ignores the requested mode. No terminal prompt is permitted.

The unary mutation starts a session and answers its identity, address, code
and expiry. The command prints those values, one per line, plus the mutation
key, and exits `0`. This line output is an exception to ordinary JSON output.
Expiry falls 15 minutes after start. At most one pending session exists per
platform and human; another start answers 409. A name conflict at start or
commit answers `409 credential.name.conflict` and the holder identity.

The human opens the address and completes the platform interaction. A browser
callback listener belongs to pi-ai and lasts only for the session. Device mode
needs no listener. Completion stores an OAuth record with `metadata: null`.
A failed or expired session stores nothing. The session holds no token; no
answer exposes one. The login flow proves the OAuth record without an extra
validation call.

## `login-code <session> <value>`

Both positional values are required, with no default. `session` is a
`LoginSessionId` and maps to `params.sessionId`. `value` is a nonempty code or
redirect URL, not a record secret. The body is `{ value }`; query is empty.
The unary mutation supplies the value awaited by the session. A remote browser
can use this command when its loopback callback fails. The operation answers
409 when no value is awaited. HTTP `200` returns `{ sessionId }`;
the CLI adds the mutation key. It reads no prompt and outputs no token.

## `login-status <session>`

The required `LoginSessionId` maps to `params.sessionId`; query is empty and
body absent. HTTP `200` prints `{ sessionId, state, lastMessage,
failureReason }` as JSON. `state` is `pending | completed | failed | expired`.
Absent message and failure reason values are `null`. This read does
not poll until completion or change the session. No mutation key is accepted.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                     | Condition                                                        | Commands                                                                     |
| ----- | ---------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 409   | `credential.login.value_not_awaited`     | The session does not await a code.                               | login-code                                                                   |
| 409   | `credential.login.pending`               | Another login is pending for this platform and human.            | login                                                                        |
| 404   | `credential.login.not_found`             | The login session does not exist.                                | login-code, login-status                                                     |
| 400   | `credential.login.mode_unsupported`      | The platform does not support the selected login mode.           | login                                                                        |
| 404   | `credential.credential.not_found`        | The credential does not exist.                                   | get, rotate, update-metadata, revoke, worker handover                        |
| local | `cli.credential.login.invalid_mode`      | The `--mode` value is neither `browser` nor `device`.            | login                                                                        |
| local | `cli.credential.revoke.invalid_revision` | The `<revision>` argument is not a positive safe integer.        | revoke                                                                       |
| 400   | `credential.entry.unsupported`           | The platform does not support this entry method.                 | create, login                                                                |
| 400   | `credential.input.invalid`               | The input secret or metadata fails validation.                   | create, rotate, update-metadata, login, login-code                           |
| 409   | `credential.metadata.base_url_fixed`     | The edit changes `baseUrl` outside rotation.                     | update-metadata                                                              |
| 409   | `credential.metadata.model_in_use`       | A removed model has dependent defaults or entries.               | update-metadata                                                              |
| 409   | `credential.name.conflict`               | A credential already has this name; details identify the holder. | create, login                                                                |
| 400   | `credential.platform.mismatch`           | The requested platform differs from the stored platform.         | binding apply, agent enablement put (custody collaboration), worker handover |
| 400   | `credential.platform.unsupported`        | The platform is not supported.                                   | create, login                                                                |
| 409   | `credential.revision.conflict`           | The expected revision is stale.                                  | rotate, update-metadata                                                      |
| 409   | `credential.revision.ended`              | The revision is already ended, by a revoke or by a drain.        | revoke                                                                       |
| 409   | `credential.revision.newest_live`        | The revoke names the newest live revision.                       | revoke                                                                       |
| 404   | `credential.revision.not_found`          | The revision does not exist.                                     | revoke                                                                       |
| local | `custody.lifecycle.stopped`              | Custody cannot accept a login or restart after shutdown.         | login, serve server                                                          |
| 409   | `credential.revision.revoked`            | A pinned use names a revoked revision.                           | worker handover, worker credential (API only)                                |

Errors contain no secret. Dependency refusals list dependents in `error.details`.

## Boundaries

The [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-resource-healthcheck)
validates a record on demand through the health report. Create and rotate make
no remote call. No check refreshes OAuth; expired access reports `unknown`.
The S3 `HeadBucket` probe maps 200 to `ok`, 404 to a missing bucket and 403 to
`unknown`; a write-only key can work despite a forbidden probe.

No command here exports or removes a credential, refreshes
OAuth, mints a GitHub App token or rotates the master key. Custody's removal
invariant remains in the design: dependents, including agent providers, prevent
removal, and the dependency check and removal are atomic. No removal route is implemented.
Secret handover and refresh reports are implemented Worker API operations; the
handover CLI leaf is pending. Acquisition grants remain later work. None is a
CLI credential-record answer. Handover first pins the newest live revision,
subsequent uses retain that pin, and a revoked pinned revision refuses use.
