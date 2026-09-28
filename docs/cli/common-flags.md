# Common CLI flags

[CLI specification index](./README.md) · [Shared conventions](./other.md)

This is the shared flag reference for the internal CLI specification, not a
list of universally available root options. A command accepts only the flags
its owning page declares. That page keeps its access policy, payload schema,
required inputs, implementation status, and command-specific exceptions.

The status labels follow the [CLI index](./README.md#status-and-implementation).
Extracting a proposed flag here does not make it implemented. Link to the
flag-name headings below rather than duplicating their types, defaults, and
validation in command documents. Heading anchors remain usable when lines move.

## Flag index

| Flag                                      | Purpose                                         |
| ----------------------------------------- | ----------------------------------------------- |
| [`--endpoint`](#--endpoint)               | Select the remote server.                       |
| [`--token`](#--token)                     | Supply a bearer credential.                     |
| [`--verbose`](#--verbose)                 | Show extra output where supported.              |
| [`--help`](#--help)                       | Display usage without running the command.      |
| [`--config`](#--config)                   | Select the local server configuration file.     |
| [`--file`](#--file)                       | Read a named structured-input file.             |
| [`--idempotency-key`](#--idempotency-key) | Identify one logical remote mutation for retry. |
| [`--limit`](#--limit)                     | Bound the requested page size.                  |
| [`--cursor`](#--cursor)                   | Continue a paginated read.                      |

## Synopsis markers

These names abbreviate shared flag sets in compact command inventories. They
are documentation notation, not literal CLI arguments, new commands, or global
options. Brackets mean optional syntax; angle brackets mark a required value
when an option is used. An optional flag has no implicit value unless its
reference states a default.

### Remote flags (R)

`[R]` expands to optional [`--endpoint <url>`](#--endpoint),
[`--token <jwt>`](#--token), and [`--help`](#--help).
Remote does not mean read-only. A token option can be omitted when another
source supplies the required credential; the owning command sets the access
policy and any local missing-token check.

### Mutation flags (M)

`[M]` expands to optional [`--idempotency-key <key>`](#--idempotency-key).
A remote mutation includes both `[M]` and `[R]`. A local filesystem write or a
read-only POST does not acquire mutation flags merely because it writes or uses
POST.

### Pagination flags (L)

`[L]` expands to optional [`--limit <count>`](#--limit) and
[`--cursor <opaque>`](#--cursor). Only commands explicitly declaring pagination
accept them, including a paginated query where its owning page specifies one.
A bounded catalogue or single-object read does not inherit them automatically.

## `--verbose`

`--verbose` is a root boolean option with default `false`. Commands with no
verbose output ignore it. `jwt generate` is the one command with verbose
output: it prints claims after the human token or the machine `token` and
`clientSecret` fragment. `jwt inspect` always prints claims.
Place `--verbose` before or after the command.

## `--endpoint`

**Implemented client option:** `--endpoint <url>` is an optional string. It
belongs to service groups and is inherited by their subcommands, not a root
option. Remote commands resolve it independently of the token, using the first
supplied value:

1. `--endpoint <url>`.
2. `KANTHORD_ENDPOINT`.
3. The `endpoint` field of the private [client file](./other.md#cliyaml-and-its-effects).
4. `http://127.0.0.1:31415`.

The effective value must be an absolute HTTP(S) URL without embedded username
or password, query, or fragment. A URL path is accepted by the current schema,
but absolute operation paths replace it and resolve from the URL's origin.
The server's Host allowlist still applies. An invalid chosen value fails rather
than falling back: precedence uses presence, not successful validation.

This flag selects the server, not a project or the server's listener settings.
A local service action such as `gateway openapi` may inherit the parser option
without resolving, validating, or using its value; its command page states that
exception. Worker-application option support is specified separately under
[`serve worker`](./other.md#serve-worker).

## `--token`

**Implemented on `gateway verify` and `worker register`; proposed on other
remote commands that declare it:** `--token <jwt>` is an optional string option,
not a universal root option. Resolve the first supplied value independently of
the endpoint:

1. `--token <jwt>`.
2. `KANTHORD_TOKEN`.
3. The `token` field of the private [client file](./other.md#cliyaml-and-its-effects).
4. Absent; there is no default credential.

The resolved value supplies the bearer credential in `Authorization`, never an
actor or identity-override field in JSON. Gateway verifies signature, claims,
expiry, revocation, and the operation's human/client access policy. Naming an
identity in another flag grants no authority. No prompt, token generation, or
credential-saving fallback occurs; diagnostics must not echo the token.

The stored client-file field must be a nonempty string. The current resolver
does not apply that stored-field check to option/environment values. A blank
higher-priority value does not select a saved token. Local preflight differs:

- `gateway verify` does not require a nonblank token locally. An empty resolved
  token sends no `Authorization` header and normally receives HTTP `401`.
  Other malformed values can fail header construction or authentication; some
  produce an indeterminate-result diagnostic. Strict local validation is not
  current behavior.
- `worker register` requires a nonblank resolved token before sending work.
- Proposed commands state their required identity kind and any missing/blank
  credential rejection on their owning page. Do not infer these checks from
  the optional syntax alone.

Worker-application flag support remains in its
[command contract](./other.md#serve-worker).

## `--help`

**Implemented parser facility:** `-h, --help` is an optional boolean switch,
absent/false by default. It prints usage and exits `0` instead of performing
command work. It is never sent to a server. Help requires no credential,
running server, terminal stdout, input document, or configuration-file read;
it opens no database. It may resolve a configuration path for display.

Every group and leaf has help. The target help contract includes arguments,
requiredness, validation, defaults, and applicable inherited options. See
[help semantics](./other.md#help-semantics) for bare-command exit behavior and
command-specific path annotations. Help is not a separate root command.

## `--config`

**Implemented local server-configuration option:** `--config <path>` is an
optional string with no literal option default. It belongs to `config`,
`serve`, and `jwt generate`, not the root or service commands. Its use by the worker
application is governed by the separate
[`serve worker` contract](./other.md#serve-worker), not inferred from server mode.

Resolve the effective path in this order:

1. `--config <path>` on the appropriate command/group.
2. `KANTHORD_CONFIG`.
3. `kanthord.yaml` in the XDG configuration directory, normally
   `~/.config/kanthord/kanthord.yaml`.

Relative explicit/environment paths resolve against the process working
directory. The CLI performs no shell expansion. A missing option value is a
parsing error. The current resolver does not separately validate a nonempty
path string; filesystem/type checks determine whether the path is usable.
This selects neither `cli.yaml` nor the data/state directories.

[Server configuration](./other.md#server-configuration) owns YAML validation,
field defaults, and private-file permissions. Each command states whether its
selected file must exist or must be absent. The three configuration commands
inherit the option: both `config --config <path> init` and
`config init --config <path>` are accepted.

## `--file`

**Proposed structured-input option:** `--file <path>` names one readable regular
UTF-8 JSON file. The owning command makes it required or optional; it has no
default path, and an omitted optional file supplies no payload unless the
command explicitly declares a default. A relative path resolves against the
CLI working directory. The command reads the file without modifying it.

The input must be a nonempty named filesystem path, not `-`, implicit stdin,
a directory, a special input device, terminal input, inline JSON, or an implicit
editor.
There are no prompts or interactive confirmations. This convention replaces
neither server/client YAML configuration nor a raw append-log format; none of
the global `config`, `serve`, or `jwt generate` forms accepts it.

The command page enumerates the JSON fields, types, requiredness, defaults,
validation, and mapping to operation input. The current proposals require one
JSON object. Invalid UTF-8 or JSON, duplicate object members, unknown fields,
missing required fields, and invalid values fail locally before a request.
Declared schema maps may allow variable keys; "arbitrary JSON" is not a schema.
File input cannot silently override positional identities or duplicate flags;
conflicting inputs are rejected. Byte limits and structured variants are
command-owned, not invented global defaults.

Command-specific rules remain on their pages: Mission imports resolve explicitly
named Markdown files relative to the manifest directory and convert them to a
request body; Project credential inputs impose a proposed private secret-file
policy; Tracking declares its batch bounds; Worker tool calls use the selected
tool's schema. These do not authorize implicit discovery of additional files.

## `--idempotency-key`

**Implemented by `worker register`; proposed for every new remote mutation:**
`--idempotency-key <key>` is an optional string. The implemented registration
help spells the value `<ulid>`; `<key>` is the shared proposed presentation.
Read-only and local commands do not inherit it.

A supplied key must be a canonical bare uppercase ULID: 26 characters matching
`[0-7][0-9A-HJKMNP-TV-Z]{25}`. It has no entity prefix. Reject an invalid key
before sending work. When omitted, generate a fresh key once for this logical
invocation. Send it as the `Idempotency-Key` header, not a body identity.

To retry across CLI invocations, explicitly reuse the key, caller identity,
operation, scope, filters, and validated payload. Do not edit the input file
between attempts. Omitting the key again creates a new invocation, not a replay.
No automatic retry is proposed. Mutation results and safe failure/indeterminate
diagnostics expose the effective key; uncertainty does not prove rollback.

See [idempotency and retries](./other.md#idempotency-and-retries) for replay
lifetime, conflict and recovery rules. A key does not guarantee exactly-once
effects across restart.

## `--limit`

**Proposed pagination option:** `--limit <count>` is an optional decimal integer,
default `100`, inclusive range `1..1000`. Reject fractions, nonnumeric values,
and out-of-range values before sending work. It maps to query field `limit`.

Only commands declaring pagination accept it. Each invocation requests one
page, not an implicit traversal of all pages. Every list uses keyset pagination
in descending primary-key order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination),
so the first page holds the newest records and a refresh shows new records.
See [pagination conventions](./other.md#pagination) for shared result metadata.

## `--cursor`

**Proposed pagination option:** `--cursor <opaque>` is an optional nonempty
string. It is absent by default, selecting the first page. It maps to query
field `cursor` and is accepted only on commands declaring pagination.

Pass the server-returned value unchanged with the same operation, caller
scope, resource, and filters. Do not decode, edit, synthesize, or substitute an
entity ID for it. The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination)
uses descending primary-key order and a base64url last-key cursor that does not
expire; a malformed cursor returns `400`. Lists take no snapshot or work
reservation, and a refresh of the first page shows new records.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                   | Condition                                                                                    | Commands            |
| ----- | -------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| local | `cli.config.invalid_endpoint`          | The resolved endpoint is not an absolute HTTP(S) URL without credentials, query or fragment. | `--endpoint`        |
| local | `cli.file.duplicate_key`               | The JSON input repeats an object key.                                                        | `--file`            |
| local | `cli.file.encoding_invalid`            | The input file is not valid UTF-8.                                                           | `--file`            |
| local | `cli.file.invalid_path`                | The `--file` value is `-`; standard input is not accepted.                                   | `--file`            |
| local | `cli.file.not_found`                   | The `--file` path does not exist.                                                            | `--file`            |
| local | `cli.file.not_json`                    | The input file is not valid JSON.                                                            | `--file`            |
| local | `cli.file.not_object`                  | The JSON input is null, an array or a scalar, not an object.                                 | `--file`            |
| local | `cli.file.not_regular`                 | The `--file` path names a directory, a device or another non-regular file.                   | `--file`            |
| local | `cli.file.schema_invalid`              | The JSON object does not match the command input schema.                                     | `--file`            |
| local | `cli.idempotency_key.invalid`          | The key is not a canonical ULID.                                                             | `--idempotency-key` |
| local | `cli.pagination.limit_invalid`         | The limit is not a positive safe integer.                                                    | `--limit`           |
| local | `cli.pagination.limit_out_of_range`    | The limit exceeds 1000.                                                                      | `--limit`           |
| local | `cli.<group>.<command>.token_required` | No nonblank JWT is available for the command.                                                | `--token`           |
| 400   | `system.pagination.cursor_invalid`     | The `--cursor` value is malformed or belongs to another listing.                             | `--cursor`          |
| local | `system.config.cyclic_alias`           | A YAML alias creates a cycle.                                                                | `--config`          |
| local | `system.config.invalid_field`          | The server configuration contains an unknown or invalid field.                               | `--config`          |
| local | `system.config.invalid_mapping`        | The YAML root is not one mapping, or a nested value is not a plain mapping or array.         | `--config`          |
| local | `system.config.invalid_yaml`           | The YAML cannot be parsed as one mapping with unique string keys.                            | `--config`          |
| local | `system.config.not_found`              | The selected server configuration file is absent.                                            | `--config`          |
| local | `system.config.too_deep`               | The configuration exceeds 32 levels of nesting.                                              | `--config`          |
| local | `system.config.too_large`              | The configuration YAML exceeds 1 MiB.                                                        | `--config`          |
| local | `system.config.too_many_values`        | The configuration exceeds 4096 values.                                                       | `--config`          |
