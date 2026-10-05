# LLM credential CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

## Scope

This specification covers the `kanthord llm credential` group and the `kanthord llm provider` group, with
**14 command leaves, all implemented**. The LLM component is a shared component, not a service.
It owns the credential routes of its platforms and OAuth login sessions. A credential belongs to no project.
Custody declares no route and keeps the record functions that these routes call.

[LLM](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.md) and its [implementation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md)
own the platform rules. The [credential route group](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-credential-route-group-of-a-component)
rules the routes and operations. This page details their CLI surface and introduces no design rule.
The [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface)
declares `llm` as a shared component group. The [operation contracts](../../src/llm/contract.ts), [CLI](../../src/apps/cli/llm.ts) and generated OpenAPI publish the wire names, paths, filters, output shapes and error codes.
The operation IDs have the form `llm.credential.<operation>`.
`llm.credential.update_metadata` is the operation ID for a metadata edit, and `llm.credential.revoke` for a revoke.

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

Each synopsis follows `kanthord llm credential`. All thirteen commands have `[R]` and
`human` access; seven mutations have `[M]`, and one list has `[L]`.
All paths below are implemented routes under the ruled `/api/llm/credential` prefix.

| #   | Synopsis after `kanthord llm credential`                          | HTTP route                                                           | Operation ID                     | Access/status        |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- | -------------------- |
| 1   | `create --file <path> [M] [R]`                                    | `POST /api/llm/credential`                                           | `llm.credential.create`          | `human`; implemented |
| 2   | `list [--platform <platform>] [L] [R]`                            | `GET /api/llm/credential`                                            | `llm.credential.list`            | `human`; implemented |
| 3   | `get <credential-name> [R]`                                       | `GET /api/llm/credential/:credentialName`                            | `llm.credential.get`             | `human`; implemented |
| 4   | `rotate <credential-name> --file <path> [M] [R]`                  | `POST /api/llm/credential/:credentialName/revision`                  | `llm.credential.rotate`          | `human`; implemented |
| 5   | `update-metadata <credential-name> --file <path> [M] [R]`         | `PUT /api/llm/credential/:credentialName/metadata`                   | `llm.credential.update_metadata` | `human`; implemented |
| 6   | `login <platform> [--mode browser\|device] --name <name> [M] [R]` | `POST /api/llm/credential/login`                                     | `llm.credential.login`           | `human`; implemented |
| 7   | `login-code <session> <value> [M] [R]`                            | `POST /api/llm/credential/login/:sessionId/code`                     | `llm.credential.login_code`      | `human`; implemented |
| 8   | `login-status <session> [R]`                                      | `GET /api/llm/credential/login/:sessionId`                           | `llm.credential.login_status`    | `human`; implemented |
| 9   | `revoke <credential-name> <revision> [M] [R]`                     | `POST /api/llm/credential/:credentialName/revision/:revision/revoke` | `llm.credential.revoke`          | `human`; implemented |
| 10  | `archive <credential-name> [M] [R]`                               | `POST /api/llm/credential/:credentialName/archive`                   | `llm.credential.archive`         | `human`; implemented |
| 11  | `platforms [R]`                                                   | `GET /api/llm/credential/platform`                                   | `llm.credential.platform_list`   | `human`; implemented |
| 12  | `check --file <path> [R]`                                         | `POST /api/llm/credential/check`                                     | `llm.credential.check`           | `human`; implemented |
| 13  | `verify <credential-name> [R]`                                    | `POST /api/llm/credential/:credentialName/verify`                    | `llm.credential.verify`          | `human`; implemented |

The static `/api/llm/credential/login`, `/api/llm/credential/platform` and `/api/llm/credential/check` paths take precedence over `/:credentialName`, so custody refuses the names `login`, `platform` and `check`.
These routes have no project identity.

The [`provider check`](#provider-check) is a server-wide read under `human` access with the `[R]` flags.
Its synopsis follows `kanthord llm provider`.

| #   | Synopsis after `kanthord llm provider`     | HTTP route                     | Operation ID         | Access/status |
| --- | ------------------------------------------ | ------------------------------ | -------------------- | ------------- |
| 14  | `check --credential <credential-name> [R]` | `POST /api/llm/provider/check` | `llm.provider.check` | `human`       |

A name whose platform belongs to another component answers `404 credential.credential.not_found` on every command that takes a name.
A `create` with a platform of another component answers `400 credential.platform.unsupported`.

## Record and platform schemas

A credential answer holds `name: CredentialName`, `platform` and `revisions`, an array of revision answers, newest first.
A revision answer holds `id: CredentialId`, `revision: Revision`, `metadata`, `createdAt: Timestamp`
and `endedAt: Timestamp | null`. No answer holds `secret`.
`platform` is the closed enum of the [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#platform-validators): `openai-compatible` and every `KnownProvider` of pi-ai 0.86.0. [`platforms`](#platforms) answers the set.
Each platform holds exactly one secret shape from `api_key | oauth`.
The [serialized credential budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#serialized-credential-budget) bounds `api_key` and `oauth` to 48,915 UTF-8 bytes of normalized canonical pi-ai credential JSON, including type, structure and escaping. Creation and rotation reject an oversized value with HTTP 400 `credential.input.invalid` before writing. Oversized OAuth login material follows the sanitized failed-session path and stores nothing.
The [platform validators](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#platform-validators)
fix the secret shape and the metadata of each platform:

| Platform                 | Secret shape | Metadata                               |
| ------------------------ | ------------ | -------------------------------------- |
| `github-copilot`         | `oauth`      | None; wire value `null`.               |
| `openai-codex`           | `oauth`      | None; wire value `null`.               |
| `anthropic`              | `api_key`    | None; wire value `null`.               |
| `openai-compatible`      | `api_key`    | Required `{ baseUrl, models }`.        |
| `openrouter`             | `api_key`    | None; wire value `null`.               |
| `openai`                 | `api_key`    | None; wire value `null`.               |
| `amazon-bedrock`         | `api_key`    | Required `{ region }`.                 |
| `google-vertex`          | `api_key`    | Required `{ project, location }`.      |
| `azure-openai-responses` | `api_key`    | Required `{ resource_name }`.          |
| `cloudflare-workers-ai`  | `api_key`    | Required `{ account_id }`.             |
| `cloudflare-ai-gateway`  | `api_key`    | Required `{ account_id, gateway_id }`. |
| Every other platform     | `api_key`    | None; wire value `null`.               |

`get` adds `agentProviders` to the credential answer: the list of `{ agent, name }` of every agent provider that names the credential. The Worker Service answers that read.

For `openai-compatible`:

- `baseUrl` is required, uses `https` or `http`, and has no query, no fragment and no trailing slash.
  It is fixed for the life of the revision. A rotation can set a different endpoint; a metadata edit cannot.
- `models` is required and starts as `[]` at creation. A human adds approved
  models through a metadata revision after `llm provider check`.
- Each model has a required `id` and optional `contextWindow`, `maxTokens` and
  `reasoningLevels`. `id` is a nonblank string, unique inside `models`. An omitted value takes the pi 0.86.0
  default: `contextWindow` `128000`, `maxTokens` `16384`, `reasoningLevels` `["off"]`.
  Both limits are positive integers, and `maxTokens` is at most `contextWindow`.
- `reasoningLevels` is an array of established levels from `off`, `minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`. An omitted list supplies only `off`.
- A model cannot be removed while a default configuration or entry names it.
  The refusal lists the dependents. The dependency check and metadata update
  commit in one transaction. Empty `models` permits no agent model selection.

[Suitability](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#suitability)
compares only the platform of the record with the platform of its use, before
any remote call. It compares no metadata.

## `create`

The required file supplies the body; params and query are empty. Required
fields have no default:

- `name`: `CredentialName`.
- `platform`: an LLM platform whose secret shape is not `oauth`;
  `github-copilot` and `openai-codex` require `login`.
- `metadata`: the platform schema above, with explicit `null` for no metadata.
- `secret`: a closed object of the secret shape of the platform. For `api_key`, `{ key }`, with a required nonempty
  string whose exact value is preserved.

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
string fields of the metadata. `verifiable` is `true` exactly for a platform with an [LLM provider](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-llm-provider). The command answers only the shared error codes.

## `check`

```text
kanthord llm credential check --file <path> [R]
```

The [pre-save check](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-pre-save-check) declares `llm.credential.check`, a read under `human` access, at `POST /api/llm/credential/check`.
It checks a typed secret before a `create` and stores nothing. It takes no mutation key and rejects `--idempotency-key`.
The required `--file` holds the closed object `{ platform, secret, metadata }`, the `create` body without `name`. The secret-file policy of `create` applies: a regular, non-symlink file at mode `0600`.
The component validates the body with the secret shape and the metadata schema of the platform, as `create` does.
The check runs through the LLM provider of the platform, and the connection maps to the status as the healthcheck does: `ok` to `healthy`, `unauthorized` to `unhealthy`, and `unreachable` and `invalid_response` to `unknown`.
The platform check runs on the typed secret with a 10 s deadline. A check that exceeds its deadline answers `unknown`.
The component drops the secret after the call and logs no material.

HTTP `200` answers `{ status, capability }`, the health entry of the [health report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-resource-healthcheck-report):

- `status` is `healthy`, `unhealthy` or `unknown`.
- `capability` is the capability of the platform check, the same value that the health report shows.

A platform with `verifiable: false` or with the secret shape `oauth` answers `400 credential.check.unsupported`.
A platform of another component answers `400 credential.platform.unsupported`.

## `verify <credential-name>`

```text
kanthord llm credential verify <credential-name> [R]
```

The [record verify](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-record-verify) declares `llm.credential.verify`, a read under `human` access, at `POST /api/llm/credential/:credentialName/verify`.
The required `CredentialName` maps to `params.credentialName`. Query is empty and body absent. The command takes no mutation key and rejects `--idempotency-key`.
It checks one stored record and stores no result.
The check runs through the LLM provider of the platform, and the connection maps to the status as the healthcheck does.
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
Query is empty and body absent. HTTP `200` returns one credential answer with the added list `agentProviders` of `{ agent, name }`;
an unknown name, or a name of another component, answers `404 credential.credential.not_found`. The read transaction first drains unpinned older live revisions of that name.

## `rotate <credential-name>`

The required `CredentialName` maps to `params.credentialName`; query is empty.
The required file supplies `{ expectedRevision, secret }` and an optional `metadata`. `expectedRevision` is the newest live revision that the human read. The secret shape of the
platform determines its closed secret schema. `api_key` uses the create schema.
An OAuth secret is `{ refresh, access, expires }`, the pi-ai credential shape;
initial OAuth material enters only through a login session.
The file has no
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
the credential answer. An `openai-compatible.baseUrl` change fails with `409 llm.metadata.base_url_fixed`; a rotation sets a new one.
Removal of a model used by a default or entry fails with `409 llm.metadata.model_in_use` and lists its dependents;
the check and update are atomic. No remote probe supplies approval.

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

## `login <platform>`

The [OAuth login contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-oauth-login)
requires a platform that accepts `oauth`; the implemented platform set permits
`github-copilot` and `openai-codex`. The positional platform is required with no default.
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

## `provider check`

```text
kanthord llm provider check --credential <credential-name> [R]
```

The [provider check contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-provider-check) declares `llm.provider.check`, a server-wide read under `human` access, at `POST /api/llm/provider/check`.
It has no project or binding.
`--credential` is required, with no default, and uses the `CredentialName` form of [Names and identities](#names-and-identities).
The body is exactly `{ credential }`; params and query are empty.
No raw key or base URL reaches this operation. No mutation key is accepted.

The operation accepts a credential of every platform with an LLM provider: `github-copilot`, `openai-codex`, `anthropic`, `openai-compatible`, `openrouter`, `openai` and `opencode-go`.
A credential of another LLM platform answers 400 `llm.provider.check_unsupported`.
The component calls the check with the material that custody releases, caches nothing and drops the material after the call.
Each call has a 10 s deadline.

HTTP `200` answers `{ connection, models }`:

- `connection` is `ok`, `unauthorized`, `unreachable` or `invalid_response`.
- `ok`: the remote answers. `unauthorized`: the remote answers 401 or 403.
- `unreachable`: a network failure or the deadline prevents the answer.
- `invalid_response`: every other answer.
- `models` is an array of `{ id, ownedBy, created }` for `openai-compatible` and `openai`, which read the OpenAI list shape of `GET /models`. `ownedBy` and `created` are `null` when the remote leaves them out. Every other platform answers `models: null`.

The answer supplies model ids, not limits or reasoning levels, and no key.
The human saves approved models through a credential metadata revision.
The `openai-codex` check and the `opencode-go` check make a model call; the `opencode-go` check calls `deepseek-v4-flash`.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                         | Condition                                                                                      | Commands                                                               |
| ----- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 409   | `credential.login.value_not_awaited`         | The session does not await a code.                                                             | login-code                                                             |
| 409   | `credential.login.pending`                   | Another login is pending for this platform and human.                                          | login                                                                  |
| 404   | `credential.login.not_found`                 | The login session does not exist.                                                              | login-code, login-status                                               |
| 400   | `credential.login.mode_unsupported`          | The platform does not support the selected login mode.                                         | login                                                                  |
| 404   | `credential.credential.not_found`            | The credential does not exist, or its platform is not an LLM platform.                         | get, rotate, update-metadata, revoke, archive, verify, worker handover |
| local | `cli.llm.credential.login.invalid_mode`      | The `--mode` value is neither `browser` nor `device`.                                          | login                                                                  |
| local | `cli.llm.credential.revoke.invalid_revision` | The `<revision>` argument is not a positive safe integer.                                      | revoke                                                                 |
| 400   | `credential.entry.unsupported`               | The platform does not support this entry method.                                               | create, login                                                          |
| 400   | `credential.input.invalid`                   | Secret or metadata validation fails, including the byte budget, or the name is reserved.       | create, rotate, update-metadata, login, login-code, check              |
| 409   | `llm.metadata.base_url_fixed`                | The edit changes `baseUrl` outside rotation.                                                   | update-metadata                                                        |
| 409   | `llm.metadata.model_in_use`                  | A removed model has dependent defaults or entries. Details: `{ models: [{ model, agents }] }`. | update-metadata, rotate                                                |
| 409   | `credential.name.conflict`                   | A credential already has this name; details identify the holder.                               | create, login                                                          |
| 400   | `credential.platform.mismatch`               | The requested platform differs from the stored platform.                                       | agent enablement put (custody collaboration), worker handover          |
| 400   | `credential.platform.unsupported`            | The platform is not an LLM platform.                                                           | create, login, check                                                   |
| 400   | `credential.check.unsupported`               | The platform has `verifiable: false` or the secret shape `oauth`.                              | check, verify                                                          |
| 409   | `credential.revision.conflict`               | The expected revision is stale.                                                                | rotate, update-metadata                                                |
| 409   | `credential.revision.ended`                  | The revision is already ended, by a revoke or by a drain.                                      | revoke                                                                 |
| 409   | `credential.revision.newest_live`            | The revoke names the newest live revision.                                                     | revoke                                                                 |
| 409   | `credential.credential.in_use`               | A dependent names the credential; `details` holds `agentProviders`, `bindings` and `inbounds`. | archive                                                                |
| 409   | `credential.credential.archived`             | The credential is archived; an archive is final.                                               | rotate, update-metadata, archive, verify                               |
| 404   | `credential.revision.not_found`              | The revision does not exist.                                                                   | revoke                                                                 |
| local | `llm.lifecycle.stopped`                      | The LLM component cannot accept a login or restart after shutdown.                             | login, serve server                                                    |
| 400   | `llm.provider.invalid_input`                 | The provider check input fails validation.                                                     | provider check                                                         |
| 400   | `llm.provider.check_unsupported`             | The platform of the credential has no LLM provider.                                            | provider check                                                         |
| 404   | `llm.provider.credential_not_found`          | The credential does not exist, or its platform belongs to another component.                   | provider check                                                         |
| 409   | `credential.revision.revoked`                | A pinned use names a revoked revision.                                                         | worker handover, worker credential (API only)                          |

Errors contain no secret. Dependency refusals list dependents in `error.details`.

## Boundaries

The [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/llm.impl.md#the-resource-healthcheck)
validates a record on demand through the health report. Create and rotate make
no remote call. The platforms with an LLM provider are exactly the `verifiable` platforms.
The `opencode-go` check makes one model call to `deepseek-v4-flash`.
No check refreshes OAuth; expired access reports `unknown`.

No command here exports a credential, refreshes
OAuth or rotates the master key. Dependents, including agent providers, prevent
an archive, and the dependency check and the archive are atomic.
Secret handover and refresh reports are implemented Worker API operations; the
handover CLI leaf is implemented. Acquisition grants remain later work. None is a
CLI credential-record answer. Handover first pins the newest live revision,
subsequent uses retain that pin, and a revoked pinned revision refuses use.
