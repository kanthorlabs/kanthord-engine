# Credential CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

This specification covers the proposed `kanthord credential` group, with
**8 proposed command leaves**. None is implemented. Custody is a shared
component, not a service or a part of Project. It owns server-wide credential
records and OAuth login sessions. A credential belongs to no project.

[Custody](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.md)
and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md)
own the rules. This page details their CLI surface and introduces no design rule.
The [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface)
declares `credential` as the shared component group. Proposed wire names, paths,
filters, output shapes and error codes need operation contracts and OpenAPI.
The `credential.create`, `credential.list`, `credential.get`, `credential.rotate`
and OAuth operation IDs follow the root contract. `credential.update_metadata`
is a proposed operation ID for a metadata revision.

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
the process and configured TTL; no automatic mutation retry is proposed.

[`--file`](./common-flags.md#--file) is required where the inventory names it.
For create and rotate, the proposed secret-file policy requires a regular,
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
| `RemoteIdentity` | Three nonempty parts, `<namespace>:<identity kind>:<identifier>`. The identifier is the displayed login, slug or path, not a numeric identity.                                                                                                                         |
| `Timestamp`      | JSON safe integer of Unix milliseconds in UTC.                                                                                                                                                                                                                         |
| `Revision`       | Positive JSON safe integer returned by custody.                                                                                                                                                                                                                        |

[Remote identity](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-remote-identity-of-a-record)
records human intent. It neither routes validation nor proves authorization.
Its namespace can differ from the credential platform: `copilot-login` has
platform `github-copilot` and remote identity `github:user:ulrich`.
Custody asks no remote to confirm this value. Rotation preserves it.

## Command inventory

Each synopsis follows `kanthord credential`. All eight commands have `[R]` and
`human` access; five mutations have `[M]`, and one list has `[L]`.
All paths below are proposed routes under the ruled `/api/credential` prefix.

| #   | Synopsis after `kanthord credential`                                                        | Proposed HTTP route                          | Operation ID                 | Access/status     |
| --- | ------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- | ----------------- |
| 1   | `create --file <path> [M] [R]`                                                              | `POST /api/credential`                       | `credential.create`          | `human`; proposed |
| 2   | `list [--platform <platform>] [--type <type>] [--remote-identity <identity>] [L] [R]`       | `GET /api/credential`                        | `credential.list`            | `human`; proposed |
| 3   | `get <credential-id> [R]`                                                                   | `GET /api/credential/:credentialId`          | `credential.get`             | `human`; proposed |
| 4   | `rotate <credential-id> --file <path> [M] [R]`                                              | `PUT /api/credential/:credentialId/material` | `credential.rotate`          | `human`; proposed |
| 5   | `update-metadata <credential-id> --file <path> [M] [R]`                                     | `PUT /api/credential/:credentialId/metadata` | `credential.update_metadata` | `human`; proposed |
| 6   | `login <platform> [--mode browser\|device] --name <name> --remote-identity <value> [M] [R]` | `POST /api/credential/login`                 | `credential.login`           | `human`; proposed |
| 7   | `login-code <session> <value> [M] [R]`                                                      | `POST /api/credential/login/:sessionId/code` | `credential.login_code`      | `human`; proposed |
| 8   | `login-status <session> [R]`                                                                | `GET /api/credential/login/:sessionId`       | `credential.login_status`    | `human`; proposed |

The static `/api/credential/login` path takes precedence over `/:credentialId`.
These routes have no project identity. The proposed provider check is in
[Worker](./worker.md#provider-check--proposed), not this group.

## Record and platform schemas

Every record answer holds `id: CredentialId`, `name: CredentialName`, `platform`,
`type`, `metadata`, `remoteIdentity: RemoteIdentity`, `createdAt: Timestamp`,
`updatedAt: Timestamp` and `revision: Revision`. It never holds `secret`.
`platform` is the closed enum `github | github-copilot | openai | anthropic | openai-compatible | s3`.
`type` is the closed enum `api_key | oauth | s3_access_key`.
The [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#platform-validators)
fix accepted pairs and metadata:

| Platform            | Accepted type   | Metadata                                 |
| ------------------- | --------------- | ---------------------------------------- |
| `github`            | `api_key`       | None; proposed wire value `null`.        |
| `github-copilot`    | `oauth`         | None; proposed wire value `null`.        |
| `openai`            | `api_key`       | None; proposed wire value `null`.        |
| `anthropic`         | `api_key`       | None; proposed wire value `null`.        |
| `openai-compatible` | `api_key`       | Required `{ baseUrl, models }`.          |
| `s3`                | `s3_access_key` | Required `{ endpoint, bucket, region }`. |

For `openai-compatible`:

- `baseUrl` is required, uses `https` or `http`, and has no query or fragment.
  It is fixed for the life of the record. A different endpoint needs a new record.
- `models` is required and starts as `[]` at creation. A human adds approved
  models through a metadata revision after `worker provider check`.
- Each model has required `id`, `contextWindow`, `maxTokens` and `reasoningLevels`.
  `id` is a nonblank string. Both limits are positive integers, and `maxTokens`
  is at most `contextWindow`.
- `reasoningLevels` is an array of established levels from `off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`. No implicit reasoning level is supplied.
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
- `platform`: one of the five platforms that accept direct entry; OAuth-only
  `github-copilot` requires `login`.
- `type`: `api_key` or `s3_access_key`, as the platform table permits.
- `metadata`: the platform schema above, with explicit `null` for no metadata.
- `remoteIdentity`: `RemoteIdentity`.
- `secret`: a closed object. For `api_key`, `{ key }`, with a required nonempty
  string whose exact value is preserved. For `s3_access_key`, required nonempty
  strings `{ accessKeyId, secretAccessKey }`; a session token is invalid.

Custody validates the local schema and makes no remote call. Proposed HTTP
`200` returns the record without the secret. The name is the natural key of
creation. A taken name answers `409 credential.name_conflict`, with the holder
identity in `error.details`, including a retry after restart. The CLI prints
that identity, never the submitted secret.

## `list`

No positional arguments and no body. Optional filters map to query `platform`,
`type` and `remoteIdentity`. Each is single-use with no default filter.
The platform and type enums are defined above; remote identity uses exact match.
`limit` and optional `cursor` use the shared pagination contract.
Proposed HTTP `200` returns record answers in `items`, in descending primary-key
order under [pagination](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
The CLI fetches no further page implicitly.

## `get <credential-id>`

The required `CredentialId` has no default and maps to `params.credentialId`.
Query is empty and body absent. Proposed HTTP `200` returns one record answer;
an unknown identity answers proposed `404 credential.not_found`.

## `rotate <credential-id>`

The required `CredentialId` maps to `params.credentialId`; query is empty.
The required file supplies exactly `{ secret }`. The record's type determines
its closed secret schema. `api_key` and `s3_access_key` use the create schemas.
An OAuth secret is `{ refresh, access, expires }`, the pi-ai credential shape;
initial OAuth material enters only through a login session. The file has no
name, platform, type, metadata, remote identity or identity override.

Rotation preserves record identity, name and remote identity. It makes no
remote call, commits in one transaction and uses last-write-wins semantics.
It changes no binding revision. Proposed HTTP `200` returns the record answer
without the secret. A credential for another remote identity needs a new record.
Custody logs the human identity and record identity, never material.
This command does not rotate `masterKey`.

## `update-metadata <credential-id>`

The required `CredentialId` maps to `params.credentialId`; query is empty.
The required file supplies exactly `{ metadata }`, a complete replacement that
matches the platform schema. It accepts no secret or platform change.
A metadata change increments the record revision. Proposed HTTP `200` returns
the updated record answer. An `openai-compatible.baseUrl` change fails.
Removal of a model used by a default or entry fails and lists its dependents;
the check and update are atomic. No remote probe supplies approval.

## `login <platform>`

The [OAuth login contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-oauth-login)
requires a platform that accepts `oauth`; the implemented platform set permits
`github-copilot` only. The positional platform is required with no default.
`--name` is required `CredentialName`; `--remote-identity` is required
`RemoteIdentity`. Both have no default.

The proposed body is `{ platform, mode?, name, remoteIdentity }`, with empty
params and query. Optional `--mode` is `browser` or `device`, without a CLI
default; absence leaves selection to the platform's supported flow. Custody
maps `device` to pi-ai interaction value `device_code`. A platform with one
mode ignores the requested mode. No terminal prompt is permitted.

The unary mutation starts a session and answers its identity, address, code
and expiry. The command prints those values, one per line, plus the mutation
key, and exits `0`. This line output is an exception to ordinary JSON output.
Expiry falls 15 minutes after start. At most one pending session exists per
platform and human; another start answers 409. A name conflict at start or
commit answers `409 credential.name_conflict` and the holder identity.

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
409 when no value is awaited. Proposed HTTP `200` returns `{ sessionId }`;
the CLI adds the mutation key. It reads no prompt and outputs no token.

## `login-status <session>`

The required `LoginSessionId` maps to `params.sessionId`; query is empty and
body absent. Proposed HTTP `200` prints `{ sessionId, state, lastMessage,
failureReason }` as JSON. `state` is `pending | completed | failed | expired`.
Proposed absent message and failure reason values are `null`. This read does
not poll until completion or change the session. No mutation key is accepted.

## Refusals

The name-conflict code is ruled; the other code spellings and mappings below
are proposed. Errors contain no secret. Dependency refusals list dependents in
`error.details`.

| HTTP | Code                                 | Condition                                                 |
| ---- | ------------------------------------ | --------------------------------------------------------- |
| 409  | `credential.name_conflict`           | Name already held; details identify the holder.           |
| 404  | `credential.not_found`               | Unknown credential identity or reference.                 |
| 400  | `credential.invalid_input`           | Invalid local schema, secret or metadata.                 |
| 400  | `credential.platform_unsupported`    | Platform is outside the closed set.                       |
| 400  | `credential.type_unsupported`        | Platform does not accept this type or entry method.       |
| 400  | `credential.platform_mismatch`       | Use requests a platform other than the record's platform. |
| 409  | `credential.metadata.base_url_fixed` | Metadata update changes `baseUrl`.                        |
| 409  | `credential.metadata.model_in_use`   | Removed model has dependent defaults or entries.          |
| 404  | `credential.login.not_found`         | Unknown login session.                                    |
| 409  | `credential.login.pending`           | Another session is pending for this platform and human.   |
| 409  | `credential.login.value_not_awaited` | Session awaits no value.                                  |
| 400  | `credential.login.mode_unsupported`  | Platform offers multiple modes but not the selected one.  |

## Boundaries

The [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-resource-healthcheck)
validates a record on demand through the health report. Create and rotate make
no remote call. No check refreshes OAuth; expired access reports `unknown`.
The S3 `HeadBucket` probe maps 200 to `ok`, 404 to a missing bucket and 403 to
`unknown`; a write-only key can work despite a forbidden probe.

No command here exports, removes or locally revokes a credential, refreshes
OAuth, mints a GitHub App token or rotates the master key. Custody's removal
invariant remains in the design: dependents, including agent providers, prevent
removal, and the dependency check and removal are atomic. This page proposes
no removal route. Secret handover and acquisition grants remain runtime
operations, not CLI record answers.
