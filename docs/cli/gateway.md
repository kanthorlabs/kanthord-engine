# Gateway CLI specification

Gateway owns HTTP transport, authentication, identity forwarding, and OpenAPI
publication. Its command group contains **two implemented commands**: remote
human identity verification and local contract generation. No additional
Gateway command is proposed here.

This is an internal target specification with an implementation snapshot of
2026-09-23, not a released-package guarantee. See the [CLI index](./README.md)
for status definitions and [shared conventions and other commands](./other.md)
for client configuration, output conventions, and the `jwt` group with `generate` and `inspect`.
JWT issuance belongs to that global command, even though Gateway implements
the signing and verification mechanism.

## Complete command table

| Command                                                      | Status      | Execution / operation                            | Access                                         | Effect and result                                                                            |
| ------------------------------------------------------------ | ----------- | ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `kanthord gateway verify [--endpoint <url>] [--token <jwt>]` | Implemented | Remote: `GET /api/auth/verify`, `gateway.verify` | `human`                                        | Read-only verification; prints the authenticated human identity as one JSON line.            |
| `kanthord gateway openapi`                                   | Implemented | Local generator; calls no route                  | Local package filesystem access; no API policy | Writes the package's OpenAPI index and service-scoped files; prints the absolute index path. |

Both commands accept `-h, --help`, take no positional arguments, and run
non-interactively. `kanthord gateway` and `kanthord gateway --help` print group
help and exit successfully. Command help needs no server or configuration
file. Unknown commands, excess arguments, unknown options, and missing option
values fail before the action runs. `--config` is rejected by the group and
both commands.

Neither command is a remote mutation or a list.
[`--idempotency-key`](./common-flags.md#--idempotency-key),
[`--limit`](./common-flags.md#--limit), and
[`--cursor`](./common-flags.md#--cursor) therefore do not apply and are not
accepted here. A local OpenAPI write is not a mutation of the remote API.

## `gateway verify`

```text
kanthord gateway [--endpoint <url>] verify [--token <jwt>] [-h|--help]
```

The inherited `--endpoint` option also works after `verify`.
The command resolves the endpoint and token through the client configuration precedence.
`--token` overrides the environment and operator-supplied client file; `--endpoint` selects the target server.
An invocation without a resolved token receives HTTP 401.

### Arguments, options, and defaults

Shared syntax, defaults, and validation are defined by each linked flag.
The token reference includes the implemented verification preflight exception.

| Input                                        | Gateway-specific meaning                                                                            |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Positional arguments                         | None; any positional is an error. The username comes from the verified token.                       |
| [`--endpoint`](./common-flags.md#--endpoint) | Inherited server selection; the absolute `/api/auth/verify` path replaces any endpoint path.        |
| [`--token`](./common-flags.md#--token)       | A human bearer JWT is required for success; verification does not enforce a nonblank token locally. |
| [`--help`](./common-flags.md#--help)         | Show command help without verification.                                                             |

### Local reads and writes

The only command-owned local configuration read is the optional
[`cli.yaml`](./other.md#cliyaml-and-its-effects), following its shared location,
YAML validation, and private-file checks, even when options override both values.

The command writes no local file, saves no credential, opens no server
database, and reads no server `kanthord.yaml`. `KANTHORD_CONFIG` does not select
the client file. Server-side verification reads authentication state and emits
normal request logs, but creates no account, session, or registration record.

### Request, validation, and access

The CLI sends `GET /api/auth/verify` with no path parameters, query parameters,
or body. Its typed operation input is `{ params: {}, query: {}, body: null }`.
The operation is non-mutating; the CLI exposes no idempotency-key option and
sends no such header. A truthy resolved token becomes
`Authorization: Bearer <jwt>`; redirects are not followed.

Gateway verifies the HS256 signature with the server-derived signing key,
requires safe-integer `iat` and `exp` claims and an unexpired `exp`, validates
the human username and display name as nonblank strings of 1–64 characters,
requires a string `jti` and enforces the `human` access policy. The [Gateway signing key
ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
uses `gateway.token_version` for revocation. The human token cannot carry `binding`. A missing credential, wrong
signature, expired token, or machine token fails with HTTP `401` and
`gateway.authentication.unauthorized`. A username allowlist or
account database is not involved. The identity is established by Gateway,
not by a caller-supplied identity field.

The operation timeout is 10 seconds; the HTTP adapter sets its deadline one
second later (11 seconds). There is no CLI timeout override or automatic retry.
The shared host check can return `403 gateway.http.host_not_allowed` before
authentication; readiness can return `503 gateway.lifecycle.not_ready`.
The route body limit can return `413 gateway.request.body_too_large` before
authentication. On a route that requires a credential, authentication and the
access policy run before request validation. A missing or invalid credential
returns `401` before `gateway.request.unsupported_media_type`,
`gateway.request.invalid_json`, `gateway.request.unexpected_body` and
`gateway.request.validation_failed`.
Unexpected query data or a nonempty body is invalid. The `/api/auth/*` body
limit is 40 KiB, although verification accepts no body.

### Results and exit status

The HTTP `200` response contains the verified JWT's business properties
under their original claim names. Stdout is exactly that validated response
serialized as compact JSON followed by a newline, for example:

```text
{"kind":"human","sub":"kanthorlabs","name":"kanthorlabs"}
```

The response properties are `kind`, `sub`, and `name`, with their exact values
from the verified JWT. `sub` is the human username, not a prefixed entity ID;
`name` is the display name. Neither is trimmed. Do not rename claims or add
aliases such as `accountId`.

The response contains no raw JWT, signing key, or token metadata (`iat`, `exp`,
or `jti`); it is not a dump of all JWT claims. Success exits `0`, permits
redirected stdout, and does not require a terminal.

Failure exits `1`, produces no success JSON, and prints a diagnostic on stderr:

- A well-formed API failure uses its error code with
  `gateway verify: request failed (HTTP <status>).` The API envelope is
  `{"error":{"code":"...","message":"...","details":null},"request_id":"request_<ulid>"}`;
  `details` may instead be structured JSON. The current CLI does not print the
  envelope, its details, or request ID.
- A transport failure, redirect refusal, deadline, invalid JSON, or response
  schema mismatch produces `cli.gateway.verify.indeterminate` with
  `gateway verify: result is indeterminate; the server could not be verified.`
- Invalid local configuration and endpoint values fail before the request
  with their local diagnostic. Diagnostics do not echo the token.

Request IDs are opaque `request_`-prefixed canonical uppercase ULIDs, as
declared by the kernel. They are not accepted as CLI operands here.

## `gateway openapi`

```text
kanthord gateway openapi [-h|--help]
```

### Arguments, options, and defaults

| Input                                                  | Gateway-specific meaning                                                                                                                                              |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Positional arguments                                   | None; any positional is an error.                                                                                                                                     |
| [`--help`](./common-flags.md#--help)                   | Show help without writing files.                                                                                                                                      |
| Inherited [`--endpoint`](./common-flags.md#--endpoint) | Parser accepts a value, but this local action never resolves, validates, or uses it. There is no effective default; it cannot change the contract or output location. |

There are no command-specific flags, destination argument, output-directory
option, or service filter. `--token` belongs to `verify`, so it is rejected for
`openapi`. `--config` is also rejected. `KANTHORD_ENDPOINT`, `KANTHORD_TOKEN`,
the client file, and server configuration are not consulted. A malformed
client file therefore cannot block this local generator.

### Input and local filesystem effects

The command writes OpenAPI files for every operation that the CLI imports from
the Gateway, LLM, Repository, Storage, Worker, Scheduler, Project and Mission contracts, under
the [operation registry ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-operation-registry).
It emits OpenAPI `3.1.0` YAML from their schemas, access policies, timeouts,
mutation flags, responses and parameter definitions. It starts no server,
connects to none, opens no database, and does not discover the operation set
of a running server. The index carries the package version in `info.version`.

Paths are relative to the installed engine package, not the current working
directory. `openapiPath()` resolves the index through the Gateway module's
location. The generated artifact has this layout:

```text
static/
├── openapi.yaml                     # Root index: one relative reference per URL path
└── openapi/
    ├── <service>/
    │   └── <operation>.yaml         # One fragment per URL path
    └── shared/
        └── components.yaml          # bearerAuth, IdempotencyKey, Error
```

A fragment holds the path item of one URL path with every method at that
path, and the full input and output schemas of each of those operations.
`<operation>` is the alphabetically first operation identity at that path
without its service prefix, so a new operation that sorts first renames the
fragment. No fragment shares a domain schema with another fragment. A fragment
has a soft limit of 500 lines; the integration test reports a larger fragment
and never fails on its size.

The files are one multi-file contract. Copy or package the index together with
the referenced directory, retaining its relative layout.

The action creates parent directories as needed, overwrites the generated
destinations, and publishes the referenced files before the root index. It
then walks `static/openapi/`, reading candidate obsolete `.yaml` files. It
removes a candidate only when it is absent from the newly generated set and
starts with the generated-file header
`# Generated from the operation registry by kanthord gateway openapi.`
Other stale assets are preserved; destinations in the current generated set
are overwritten regardless of their previous content. Empty directories are
not removed. This cleanup is the generator's read of existing asset content;
it does not consume the old YAML as its contract input.

The CLI applies umask `077`, so ordinary newly created directories/files have
modes `0700`/`0600`. The generator does not audit or repair existing asset modes
and is not the private configuration-file publication mechanism. Individual
writes are not an atomic publication of the entire tree; a failed write or
cleanup can leave partial updates.

Projection rejects an unsafe service scope, the reserved service name
`shared`, operation IDs not qualified by their service, duplicate operation
IDs, duplicate method/path pairs, and methods at one path assigned to different
services. Schema conversion and filesystem errors also fail the command.
There is no interactive confirmation or runtime asset download.

### Result

After all generation and cleanup succeeds, stdout contains the absolute path
to `static/openapi.yaml` followed by a newline, and the command exits `0`.
It does not print the YAML or one line per file. Redirection is allowed. A
failure exits `1` without the success path; unclassified generator/filesystem
errors currently become `system.operation.unknown: Operation failed.`

## Published routes and command coverage

These are Gateway operation contracts; the current-source difference is noted
under Command scope. The last four rows are HTTP capabilities, not additional
CLI commands. All are non-mutating `GET` operations with success status `200`.

| Route                         | Operation             | Access / timeout | Parameters and result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | CLI coverage                                                    |
| ----------------------------- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `/api/auth/verify`            | `gateway.verify`      | `human`, 10 s    | No parameters or body; JSON human identity described above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `gateway verify`                                                |
| `/api/healthcheck`            | `gateway.healthcheck` | `human`, 120 s   | No parameters or body; [grouped health report](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-resource-healthcheck-report) with entries at `services.<service>.global.<resource>` and `services.<service>.projects.<project>.<resource>`, plus `shared.<component>.global.<resource>` and `shared.<component>.projects.<project>.<resource>` for the components `llm`, `repository` and `storage`, each `{status, capability}`. HTTP 200 when every owner supplies its inventory; 503 with missing owners otherwise. | API only; no health command is declared or proposed.            |
| `/api/liveness`               | `gateway.liveness`    | `public`, 30 s   | No parameters or body; [component healthchecks](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#component-healthchecks) return the server and gateway maps. HTTP 200 when healthy; unavailable components produce `503 gateway.liveness.unhealthy` with the complete map in `error.details`.                                                                                                                                                                                                                              | API only; no liveness command is declared or proposed.          |
| `/api/openapi.yaml`           | `gateway.openapi`     | `public`, 30 s   | No parameters or body; `application/yaml` root index read from package `static/openapi.yaml`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | API only; local `gateway openapi` does not call this operation. |
| `/api/openapi/:service/:file` | `gateway.openapiFile` | `public`, 30 s   | Required path strings `service` and `file`; `application/yaml` scoped/shared artifact read from package `static/openapi/<service>/<file>`.                                                                                                                                                                                                                                                                                                                                                                                                                          | API only; no download command.                                  |

The scoped route validates `service` against `^[a-z][a-z0-9-]*$` and `file`
against `^[A-Za-z][A-Za-z0-9._-]*\.yaml$`. Neither has a default. It accepts no
query parameters or body and only serves filenames derived from the current
operation registry, including `shared/components.yaml`. A schema violation
returns `400`; an unlisted filename returns `404 gateway.openapi.not_found`.
Failure to read a published index or allowed fragment returns
`503 gateway.openapi.unavailable`. Server startup does not regenerate missing
files. The liveness and OpenAPI routes are public but still subject to host,
readiness, validation, and timeout checks.

## Command scope

The target Gateway command table remains the two commands above. The health
endpoint alone does not justify adding a CLI command. Worker registration and
other services' operations retain their owning command groups. Removed login,
logout, and rotation commands are not part of this specification.

| Topic                      | Current source versus design / future decision                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAPI artifact and URLs  | The index `static/openapi.yaml` answers at `/api/openapi.yaml`, and each fragment `static/openapi/<service>/<file>` answers at `/api/openapi/:service/:file`. Source matches the [operation registry ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-operation-registry).                                                   |
| OpenAPI package version    | The index carries the `version` of `package.json` in `info.version`. Compatibility enforcement stays with the worker startup check.                                                                                                                                                                                                                                               |
| Help completeness          | The target requires help to state every default and validation rule. Current `--endpoint` help says only “Server endpoint”; this page specifies behavior that help still needs to expose. The inherited unused endpoint option also appears in local `openapi` help.                                                                                                              |
| Credential validation      | The server verification checks above are implemented. Local validation of option/environment token values is weaker than the client-file schema. The [JWT ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-jwt) declares the closed header and claim contract. Global issuance syntax stays in [other commands](./other.md). |
| User management            | The system holds no user management, and no user, session-list or revoke command exists. The [Gateway signing key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key) revokes every JWT through `gateway.token_version`.                                                                                           |
| Future services in OpenAPI | The CLI assembles the Gateway, LLM, Repository, Storage, Worker, Scheduler, Project and Mission contracts explicitly. A future declared service must be added to the emission set and to server routing; the generator does not scan source directories.                                                                                                                          |

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP | Code | Condition                | Commands          |
| ---- | ---- | ------------------------ | ----------------- |
| —    | —    | No code is declared yet. | proposed commands |

## Implementation references

- [CLI dispatch and options](../../src/apps/cli/index.ts),
  [client resolution](../../src/gateway/client.ts), and
  [CLI tests](../../src/apps/cli/index.test.ts).
- [Gateway contract](../../src/gateway/contract.ts),
  [handlers and published-file allowlist](../../src/gateway/declarations.ts),
  [authentication](../../src/gateway/authentication.ts), and
  [HTTP client](../../src/gateway/client.ts).
- [Local path resolution](../../src/gateway/local.ts),
  [OpenAPI generation and cleanup](../../src/gateway/openapi.ts),
  [projection tests](../../src/gateway/openapi.test.ts), and
  [HTTP publication tests](../../src/apps/server/openapi-integration.test.ts).
- [Private file validation](../../src/kernel/files.ts),
  [configuration paths and YAML validation](../../src/config/index.ts), and
  [opaque identity schemas](../../src/kernel/identity.ts).

Optional design provenance:
[Gateway rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.md),
[vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.vocabulary.md),
[Gateway implementation decisions](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md),
[architecture decisions](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md),
and [open design work](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
