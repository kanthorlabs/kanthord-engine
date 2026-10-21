# Other commands and shared CLI conventions

[CLI specification index](./README.md) · [Gateway commands and JWT use](./gateway.md)

This contributor specification owns `config`, `serve`, `auth`, help behavior,
and the conventions inherited by all six service-command pages.
[Common flags](./common-flags.md) owns shared flag syntax, defaults, and
validation; this page links to those definitions. The specification is
self-contained in an engine checkout. It describes the working tree inspected
on 2026-09-23, the future requirements in the design material, and proposed CLI
syntax separately; it is not a claim that the target surface is implemented.

## Status vocabulary

- **Implemented:** verified against the current source linked below.
- **Target requirement:** specified in the architecture or Gateway design
  material, but not necessarily implemented. An unresolved handoff item stays
  unresolved even where a target command needs it.
- **PROPOSED:** a command-line spelling, parameter convention, or rendering
  adopted consistently across these new CLI specifications. It needs adoption
  in the owning operation and implementation before becoming a shipped promise.
- **Open:** the required design decision has no settled answer. No example or
  placeholder supplies approval, a default, or an executable contract for it.

## Command inventory

There are ten application/JWT forms below: three configuration commands,
`upgrade`, two `serve` application forms, the internal `serve slot` mode, two
`auth jwt generate` modes, and `auth jwt inspect`. Help is a parser facility,
not a fifth global command.

1. `kanthord config init [--gateway-allowed-host <host>]... [--gateway-bind <address>] [--gateway-base-path <path>] [--config <path>]` — implemented; local, no route.
2. `kanthord config validate [--config <path>]` — implemented; local, no route.
3. `kanthord config show [--config <path>]` — implemented; local, no route.
4. `kanthord upgrade [--config <path>]` — implemented; local, no route.
5. `kanthord serve [server] [--config <path>]` — implemented; local application
   startup, no outbound API route. Opens the server's HTTP listener.
6. `kanthord serve worker [--instance <name>] [--endpoint <url>]` — implemented; local
   application startup from an instance configuration; the runtime calls public API operations afterward.
7. `kanthord auth jwt generate [username] [--name <display>] [--config <path>]` — implemented
   human issuance; local, no route.
8. `kanthord auth jwt generate --project <project id> --binding <binding name> [--name <display>] [--output [path]] [--endpoint <url>] [--config <path>]` —
   implemented machine issuance; local, no route.
9. `kanthord auth jwt inspect [token]` — implemented local decoding; no route.
10. `kanthord serve slot` — implemented internal mode of the `server` application;
    no route. A human never runs it. Help does not list it.

Service commands, including local `gateway openapi`, are specified by their
owning pages in the [index](./README.md).

## Shared conventions

### Closed root names and option scope

**Implemented and target requirement:** the four global root names are
`config`, `upgrade`, `serve`, and `auth`. The four component root names are `llm`, `repository`,
`storage`, and `agent`. The six service root names are `project`, `mission`,
`scheduler`, `worker`, `tracking`, and `gateway`. These are disjoint, closed sets.
`server` and the application form of `worker` are operands of `serve`, never new
root commands. `cli` is not a `serve` operand.

- [`--config`](./common-flags.md#--config) selects server configuration only
  where the local command declares it; service commands reject it.
- [`--endpoint`](./common-flags.md#--endpoint) selects a remote server;
  inherited parser acceptance does not make a local command remote.
- [`--token`](./common-flags.md#--token) applies only to remote commands that
  declare it, currently `gateway verify` and `worker register`.
- [`--help`](./common-flags.md#--help) is the common help option.
  `--verbose` is the one root option. It defaults to false. Commands without
  verbose output ignore it. No `--json`, `--dry-run`, `--yes`, or `--version`
  root option is declared.
- **PROPOSED:** nested resource names use singular nouns, such as `binding`,
  `instance`, or `trace`. A plural collection in an API path does not change
  the singular CLI resource name.

### Non-interactive inputs

**Implemented and target requirement:** commands read no terminal prompts,
confirmations, passwords, or missing arguments. Missing required values,
unknown options, unknown command names, and excess positional arguments fail
with a diagnostic and a nonzero exit before command work. File and environment
inputs supply only their declared values, with no interactive fallback.

In syntax examples, `<value>` means a required value when that operand or
option is used; `[value]` or `[--option <value>]` means optional input. Each
command's definition establishes whether the option itself is required. Quote
values containing spaces using the invoking shell. Help and argument parsing
need no running server. The JWT stdout terminal requirement is an output
restriction, not an interactive input flow.

### File input

The proposed [`--file`](./common-flags.md#--file) reference defines path
resolution, allowed sources, and local validation. The owning command defines
requiredness, payload fields, bounds, and any explicit conversion such as
[Mission imports](./mission.md#import--2-commands).

### Pagination

**PROPOSED for commands declaring pagination:** use
[`--limit`](./common-flags.md#--limit) and
[`--cursor`](./common-flags.md#--cursor) with their shared definitions.

A list invocation requests one page. Lists use keyset pagination under the shared
[pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
Primary-key lists use descending order and continue below the last key, so the
first page holds the newest records. Group-key lists, including the Worker
catalog, use ascending order and continue above the last key.
The base64url last-key cursor does not expire, a malformed cursor returns `400`,
and a list takes no snapshot. Do not silently traverse all pages. Preserve the
same list scope and filters when using a continuation. The result holds `items`
and `next_cursor`, both required, with `next_cursor: null` on the final page;
the service owns any additional metadata.
These options are not implemented universal flags, and commands that return a
bounded catalogue or a single object do not inherit them automatically.

### Shared identity and time rules

Opaque entity identities retain the complete `<declared-prefix>_<ulid>` value
returned by their owner. Natural keys, protocol identities, and transport
idempotency keys retain their separate formats. An undeclared entity prefix or
protocol mapping is an open contract dependency, not permission to invent one.
Server-defined timestamps are nonnegative safe JSON integers of Unix
milliseconds in UTC; JWT `iat` and `exp` use their protocol's seconds instead.
Neither timestamps nor ULIDs establish causal order. Revision and attempt
counters follow their service's declared ordering rules.

The proposed single-record read verb is `get`; `list` reads a collection.
Existing spellings such as global `config show` and `gateway verify` retain
their command-specific meaning. CLI flags use kebab-case and proposed wire
fields use snake_case, including `execution_id` across service boundaries.

## Client configuration

**Implemented:** remote service commands use
[client.ts](../../src/gateway/client.ts). Server configuration
and client configuration are different files with different precedence rules.
A remote command needs no `kanthord.yaml` and opens no server database.

### Endpoint and token contract

The [`--endpoint`](./common-flags.md#--endpoint) and
[`--token`](./common-flags.md#--token) references define independent resolution,
defaults, validation, and command-specific preflight exceptions. The client
file's fields use those contracts; its location and file checks follow below.

### `cli.yaml` and its effects

The file accepts `endpoint` and `token` under the [client configuration ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-client-configuration-file).
A `client_secret` field or a `master_key` field fails with `cli.config.invalid`.
`serve worker` does not read this file. It reads an instance configuration; see [serve worker](#serve-worker).

The path is `<XDG configuration directory>/kanthord/cli.yaml`, normally
`~/.config/kanthord/cli.yaml`. There is no `--client-config` path option and
`KANTHORD_CONFIG` does not select this file. An absent file is allowed. When
present, it accepts only optional `endpoint` and `token` fields
in one YAML mapping. It shares the bounded YAML parser described under
[server configuration](#server-configuration).

`auth jwt generate --output` in human mode creates an absent file. The operator may
also write it manually. Current file checks require a regular file owned by
the running user with exact mode `0600`, reject symlinks and
special permission bits, and validate the opened descriptor using
`O_NOFOLLOW`. A narrower mode is rejected as well as a wider one. The resolver
reads and validates a present file even when flags override both values, so
an invalid file still fails the invocation.

No command updates or deletes this file. No login, logout or secret-rotation
command exists. The server never reads it. Issuance without `--output` saves
nothing here. Using a token does not save it here. Local service commands that
do not resolve a client, notably `gateway openapi`, do not read it.

The worker application reads no `token` from this file and accepts no
`--token`. Its endpoint comes from `--endpoint`, then `KANTHORD_ENDPOINT`, then
the instance configuration; see [serve worker](#serve-worker).

## Output and exit behavior

**Implemented:** `runCLI` uses exit `0` for success and `1` for handled failures.
A `serve worker` process that another process supersedes exits `3` with
`worker.instance.superseded`.
Commander help exits `0`; parsing failures exit nonzero. A caught CLI or domain
failure writes a diagnostic to stderr. Line 1 of a diagnostic is
`<code>: <message>`, with the code at the start of the line. The message holds
no embedded value. Each value is one `name: value` row after line 1.
The rows align: each value starts in the same column. Line 1 does not take part
in the alignment. The row names are `path`, `key`, `option`, `field`, `config`,
`database`, `old_key`, `new_key`, `config_version`, `supported_version`,
`bind`, `port`, `version`, `server_version`, `tool_version`, `minimum_version`, `variables`,
`tool`, `target`, `license`, `exit_status`, `reason`, `status`,
`idempotency_key`, `command` and `details`.

`system.config.invalid_field` with field issues prints
`<code>: invalid configuration fields`, then the issues as a JSON list in the
`details` row. An operational log record that holds a diagnostic as `reason`
also holds its rows as `fields`, an object of row name to value. The record
holds no `fields` when the diagnostic has no rows.

A declared remote failure of a mutation prints `<code>: request failed`, then
the rows `status: <status>` and `idempotency_key: <key>`. A declared remote
failure of a read prints `<code>: request failed`, then the row
`status: <status>`. `gateway verify`, `gateway liveness`, `worker register` and
`worker handover` put the command name before `request failed`. When the error
body holds non-null `details`, the CLI writes the last row
`details: <compact JSON of details>`. With `details` null, the CLI writes no
`details` row. An indeterminate mutation prints
`<code>: the result is unknown; retry with the same idempotency key`, then the
row `idempotency_key: <key>`. An indeterminate read prints
`<code>: the result is unknown; retry the command`. The CLI does not print the
remote message or the request ID. A file diagnostic puts the file path in the
`path` row. Coded diagnostics use the owning `cli`, `system`, or service
namespace; Commander syntax diagnostics are not a uniform JSON envelope. The
launcher rejects unsupported Node.js versions with one stderr line and a nonzero
exit before loading the application. The supported range is `>=24.15.0 <25`.

Current domain results (`gateway verify`, `gateway liveness`, `worker register`)
are one JSON value followed by a newline on stdout. `worker register` includes
its idempotency key. Local output has explicit exceptions: help is text,
`config init`, `config validate`, `upgrade` and `gateway openapi` print
`name: value` rows, `config show` prints masked YAML, and `auth jwt generate`
without `--output` prints the `token` row or a machine client fragment only to
terminal stdout. With `--output`, it prints the `created` row with the file path
to any stdout. `auth jwt inspect` prints the claim list to any stdout.
`llm credential login` prints rows and an address block. `serve` is long-running
and produces operational logs, not a domain-result JSON object.

Human output that is not JSON is a list of `name: value` rows. A name is lower
snake_case. The rows of one block align: each value starts in the same column.
The CLI omits a row with a null or empty value. A time is ISO 8601 UTC, for
example `2026-10-17T22:33:40.960Z`. A value is bare: no quotes, no trailing
period and no prose. A URL row comes last, after one empty line. Its label line
is `name:` with no value. The next line holds the bare URL at column 0. The CLI
writes no color and no terminal escape sequence.

**PROPOSED:** new unary domain commands follow the existing JSON result style
without requiring a `--json` flag. Their owning pages define the exact result
shape. Diagnostics go to stderr and preserve failure without echoing tokens,
secret file fields, or configuration excerpts. New remote mutations expose the
effective idempotency key in their documented success metadata and in a safe
failure/indeterminate diagnostic, following `worker register`.

**PROPOSED, only where an owning page declares a streaming operation:** an open
stream may render one JSON record per line on stdout so consumers can process
bounded records before the stream ends. This is a CLI rendering choice, not a
change from the API's server-sent-event transport. That page must name record
fields, ordering, end conditions, and partial-output behavior. No universal
watch or stream option is implied. An interrupted stream may already have
written records and must not claim complete output.

### Completed, Failure, and Indeterminate

Both adapters expose the result distinction in
[operation.ts](../../src/kernel/operation.ts) and
[client-result.ts](../../src/gateway/client-result.ts):

- **`Completed`:** the expected response status and a valid operation output
  were received. Print the declared domain result and exit `0`. Completion is
  the operation's completion, not proof that every downstream workflow ended.
- **`Failure`:** a structured failure response was received, or local input
  validation produced one. An answer with the expected status whose body fails
  the operation output schema is the failure `gateway.client.answer_invalid`
  with the received status. Emit a diagnostic and exit nonzero. Its meaning is
  owned by the operation; a failure in a multi-operation workflow does not undo
  a completed peer effect.
- **`Indeterminate`:** no trustworthy result could be established, including
  transport loss, a body that cannot be read as JSON, or an error answer that
  fails the error envelope schema. Emit an explicit
  indeterminate diagnostic and exit nonzero. Do not report either success or
  "nothing happened." A mutation may have committed before its answer was lost.

Current CLI commands map `Failure` and `Indeterminate` to exit `1`; there is no
dedicated indeterminate exit code. These names describe the adapter contract,
not a universal CLI output envelope. Local commands have no remote
`OperationResult`; their command-specific effects and errors apply.

A batch operation can answer a completed response that holds refused records.
For example, the
[Tracking telemetry write](./tracking.md#output-and-failure-conventions) reports
a disposition for each record. The transport result remains `Completed`; it must
not be misreported as an API failure or an indeterminate response.

### Idempotency and retries

The [`--idempotency-key`](./common-flags.md#--idempotency-key) reference owns
key syntax, generation, header mapping, and explicit cross-invocation reuse.
The following rules govern replay and recovery rather than flag parsing.
A changed effect needs a new logical invocation and key, after resolving any
uncertainty about the original effect.

**Implemented:** replay is in memory, scoped to the caller and one
server process, with `gateway.idempotency_ttl` defaulting to `86400` seconds.
An in-progress key or a key reused for a different operation/payload produces
HTTP `409`. A completed record replays within its lifetime, subject to operation rules
such as worker registration still being live. Restart or expiry can run the
handler again; each mutation needs its owner's natural-key idempotence and
recovery rule. Replay is not durable recovery.

The CLI currently performs no automatic request retry. This specification adds
none. On an indeterminate result or an in-progress conflict, inspect the owning
resource or follow its declared reconciliation procedure before proceeding.
Do not blindly retry with a new key, loop indefinitely on 409, assume a timeout
rolled back a mutation, or claim that reusing a key guarantees exactly-once
effects across server restarts.

No domain operation carries a durable `request_id`. The idempotency key is
distinct from Gateway's transport `X-Request-Id`, which identifies one HTTP
request; transport correlation alone never deduplicates a domain effect.

### Cancellation is not revocation

**Target requirement:** cancellation requests an end to waiting or work; it
does not prove cleanup has finished and undoes no committed effect. Cancelling
a work pull releases no committed claim and ends no accepted obligation.
Closing an MCP stream ends the connection, not the domain session. An increment
of `gateway.auth.version` and a server restart invalidate every issued JWT,
but cancel no request already verified.

Stopping the CLI, closing a connection, restarting the server without a
configuration change, and generating another JWT do not revoke a JWT. Domain
cancellation, claim revocation, registration termination, and token revocation
require their owning contract; one does not imply another. The [Gateway signing
key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
defines version-based revocation.

**Current signal behavior:** `serve server` installs graceful-stop handlers.
The one-shot remote CLI commands do not establish a shared signal-handling or
reconciliation protocol. An OS signal can terminate the CLI without a printed
result or the normal handled exit `1`; it does not establish the server-side
outcome. Future wait/stream commands must specify their cancellation behavior
and partial-output rules explicitly.

## Server configuration

The three `config` commands, `serve server`, and `auth jwt generate` share this implemented
configuration contract from [config/index.ts](../../src/config/index.ts).

### Path, values, and permissions

[`--config`](./common-flags.md#--config) defines configuration-path resolution,
defaults, and validation. It does not select `cli.yaml`.

The four XDG roots are `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`, and
`XDG_CACHE_HOME`, defaulting respectively to `~/.config`, `~/.local/share`,
`~/.local/state`, and `~/.cache`; each engine directory appends `kanthord`.
A relative XDG variable is ignored in favor of its default. Changing the
configuration-file path does not move the data or state directories.

Values come from the file, then the schema defaults. There are no environment
bindings or option overrides for server field values. `KANTHORD_ENDPOINT` does
not change `gateway.bind` or `gateway.port`. Configuration is read at startup,
and an edit takes effect on the next start. **Target requirement:** a relative
path-valued field inside the configuration resolves against the data directory.
`agent.prompt.system_file` and `agent.prompt.agent_directory` declare such fields.
`agent.prompt.host_file` holds a boolean and defaults to `true`. `false` locks the `host_file` prompt switch of the `system` scope off.

Reads require a user-owned regular `0600` file and a user-owned `0700` containing
directory. Exact modes are checked, including rejection of special bits and
symlinks at audited paths. Reads validate the descriptor opened with
`O_NOFOLLOW`. Existing objects are never repaired. These are POSIX filesystem
checks, not an audit of every ancestor directory.

### Document and field validation

The file is one YAML mapping with unique string keys. Parsing rejects malformed
YAML, additional documents, warnings, cyclic aliases, and non-mapping roots.
The current parser limits source size to 1 MiB, traversed values to 4096,
container nesting to 32, and YAML alias expansion through a limit of 100.
Unknown schema fields fail strict validation. Diagnostics report field paths
and reasons without field values or YAML excerpts.

The implemented fields are:

- `version`: optional positive safe integer, default `1`. It holds the
  configuration version. A value other than the version of the binary fails
  with `system.config.version_behind` or `system.config.version_ahead`.
- `master_key`: required canonical base64 encoding of exactly 32 bytes. There
  is no usable default. `config init` generates it using `crypto.randomBytes`.
  The first start records a verifier of it in the database. A later start or
  `upgrade` with another value fails with `system.config.master_key_mismatch`.
- `log.level`: optional enum `trace|debug|info|warn|error|fatal`, default `info`.
- `log.destination`: optional enum `stderr|file`, default `stderr`; `file` uses
  `kanthord.log` in the XDG state directory.
- `gateway.bind`: optional IP-address string, default `127.0.0.1`; validation
  accepts any IPv4 or IPv6 address, for example `::` in a container.
- `gateway.port`: optional Convict `port`, default `31415`.
- `gateway.allowed_hosts`: optional array of nonempty strings, default
  `["127.0.0.1:31415", "localhost:31415"]`.
- `gateway.allowed_origins`: optional array of nonempty strings, default
  `["http://127.0.0.1:27182", "http://localhost:27182"]`.
- `gateway.base_path`: optional string, default `/`. A value other than `/`
  matches `^(/[A-Za-z0-9._~-]+)+$` and has no trailing slash, for example
  `/s/kanthord`. The listener serves the API and the embedded dashboard only
  under that prefix. See [Base path](#base-path).
- `gateway.auth.version`: optional positive safe integer, default `1`. It
  versions the signing key and every client secret. An increment and a server
  restart invalidate every issued JWT and change every client secret. Every
  authentication field lives under `gateway.auth`.
- `gateway.auth.token_lifetime`: optional Convict `nat` in seconds, default
  `31536000` (one year). Local issuance additionally requires a nonnegative safe
  integer; zero produces an immediately expiring token.
- The former keys `gateway.token_version` and `gateway.token_lifetime` belong
  to configuration version 1. `kanthord upgrade` moves them.
- `gateway.idempotency_ttl`: optional positive safe integer in seconds, default
  `86400`. The idempotency component uses it as the TTL of an in-memory record.

- `agent.cooldown.rate_limited_ms`, `agent.cooldown.unavailable_ms`,
  `agent.cooldown.quota_exhausted_ms`: optional Convict `nat` in milliseconds,
  defaults `60000`, `60000` and `3600000`. Each holds the base cooldown of a
  credential after that provider failure. Each strike doubles it.
- `agent.cooldown.max_ms`: optional Convict `nat` in milliseconds, default
  `86400000`. It caps a cooldown.
- `mission.consecutive_failure_limit`: optional Convict `nat`, default `3`. It
  holds the consecutive failure limit of the Mission Service.
- `mission.further_work_limit`: optional Convict `nat`, default `3`. It holds
  the number of consecutive releases of one attempt with a `budget_end` stop
  before the Mission Service pauses the node. The value `0`
  turns the limit off.
- `mission.rework_limit`: optional Convict `nat`, default `2`. It holds the
  rework limit of the Mission Service. The value `0` turns rework off.
- `mission.text_max_bytes`: optional Convict `nat` in UTF-8 bytes, default
  `32768`. It bounds every `Text` value of a Mission write; a stored value keeps
  its length after a change of the bound.

- `worker.heartbeat_window`: optional positive safe integer in seconds, default
  `300`. A 30-second sweep ends expired registrations.
- `worker.server_slot_limit`: optional positive safe integer, default `16`. It
  caps the pool slots that the server starts at the `server` and the `container`
  placements. A slot above the cap stays unstarted and the server logs
  `worker.pool.slot_limit`.
- `worker.container_image`: optional image name, default
  `docker.io/kanthorlabs/kanthord`. It holds the name with no tag and no digest.
  The server appends its package version as the tag, so a slot container runs the
  server version. A value with a tag or a digest fails with
  `system.config.invalid_field`. A change takes effect at the next start. When a
  live binding holds the `container` placement and the container runtime is
  unavailable at the server start, the server logs `worker.pool.driver_unavailable`
  with `placement`, `reason` and `detail`, and it still starts. The slots start
  again with a backoff when the runtime recovers.

- `scheduler.release_reserve`: optional positive safe integer in seconds, default
  `600`. A claim adds this reserve after its effective worker wall time.
- `scheduler.stop_backoff`: optional positive safe integer in seconds, default
  `30`. After a counted failure, the claim skips the node for this wait, doubled
  for each further consecutive failure.

The current Project fragment is empty and adds no YAML section.
See [Gateway](./gateway.md) for authentication context.

## Configuration commands

All three commands have **no positional arguments**. Their only command input
is [`--config`](./common-flags.md#--config), inherited from `config` with the
shared path contract. [`--help`](./common-flags.md#--help) prints help instead
of performing the operation. No force/overwrite option exists. Each command is local, calls no API route, starts no server, and opens
no database. None reads or writes `cli.yaml`.

### `config init`

```text
kanthord config init [--gateway-allowed-host <host>]... [--gateway-bind <address>] [--gateway-base-path <path>] [--config <path>]
```

**Implemented; route/access: none, local filesystem.** The destination must be
absent. Build a whole document with every current default and a newly generated
master key, validate it in memory, and then publish it. Each repeatable
`--gateway-allowed-host` value is lowercased and appended to the default
`gateway.allowed_hosts` without duplicates. A value that is not exactly
`<name>` or `<name>:<port>` fails with `cli.config.invalid_allowed_host` before
any file is written. `--gateway-bind` writes its value to `gateway.bind`. The default is `127.0.0.1`. A container runs `config init --gateway-bind ::` once, before the first start. A value that
is not an IP address fails with `system.config.invalid_field` before any file
is written. `--gateway-base-path` writes its value to `gateway.base_path`. A
value that is neither `/` nor a path without a trailing slash fails with
`system.config.invalid_field` before any file is written. The invocation itself
authorizes creation; stdin and stdout may both be redirected.

Create the destination directory at `0700` when absent. Write a same-directory
temporary file at `0600`, flush and close it, hard-link it to the destination
without replacement, and unlink the temporary file. An existing destination
fails without overwriting it; a publication failure does not leave a partially
written destination. A directory created before failure can remain.

On success stdout is exactly `created: <absolute-path>\n` and exit is `0`.
It prints no generated configuration or secret. Invalid permissions, an existing
destination, or a write/publication failure produces a diagnostic and exit `1`.
Output/cleanup failure after publication does not undo an already created file;
inspect the destination instead of assuming a failed invocation wrote nothing.

### Base path

A proxy that forwards the full request path can expose the server under a
prefix, for example `gateway.base_path: /s/kanthord` behind
`https://homelab.kanthorlabs.com/s/kanthord/`. The proxy sends no custom header
and strips no prefix. The Host check and the readiness check run first. Then
the listener answers by request path `P`:

- With `gateway.base_path` set to `/`, the listener serves `P` unchanged.
- With a prefix `B`, a `P` under `B/` is served as the remainder, so
  `/s/kanthord/api/liveness` reaches `/api/liveness` and `/s/kanthord/` reaches
  the dashboard. The CORS preflight check also sees the remainder.
- A `P` equal to `B` answers `301` with `Location: B/` and the original query.
- A `P` outside `B` answers `404 gateway.routing.not_found`. The dashboard
  index never answers it.

The response for the dashboard `index.html` always carries `<base href="/">`
for the root and `<base href="B/">` for a prefix, directly after the opening
`<head>` tag. The server fails the response when the embedded index has no
`<head>` tag. The index keeps `Cache-Control: no-cache`.

### `config validate`

```text
kanthord config validate [--config <path>]
```

**Implemented; route/access: none, local filesystem.** Read and validate the
selected stored configuration with defaults and strict schema validation. The
file must exist. Validation covers its document, field values, and the private
file/containing-directory checks; it is not a startup probe, listener bind test,
database lock check, or remote authentication test.

On success stdout is exactly `valid: <absolute-path>\n` and exit
is `0`. On failure stderr reports the safe parse/permission diagnostic or the
collected invalid fields and exit is `1`. No file is created, repaired, or
modified. An absent file prints `system.config.not_found: configuration is absent`,
then the rows `config: <path>`, `command: kanthord config init --config "<path>"`
and `container: podman run --rm -v <volume>:/var/lib/kanthord docker.io/kanthorlabs/kanthord:<version> config init --gateway-bind :: --gateway-allowed-host localhost:<port> --gateway-allowed-host 127.0.0.1:<port>`.

### `config show`

```text
kanthord config show [--config <path>]
```

**Implemented; route/access: none, local filesystem.** Read and validate the
selected file as for `config validate`. Print effective configuration, including
schema defaults, as YAML on stdout, with sensitive fields replaced by
`[Sensitive]`. There is no reveal-secret option and no terminal requirement.

Exit is `0` after successful output or `1` with a safe diagnostic on failure.
It writes no configuration, client file, or database. This is the effective
configuration of this invocation, not an inspection of a running server's
already loaded configuration.

### `upgrade`

```text
kanthord upgrade [--config <path>]
```

**Implemented; route/access: none, local filesystem and database.** Bring the
selected configuration file, `kanthord.db` and `tracking.db` of the data
directory to the versions of this binary. Stop the server before this command.

- The root field `version` holds the configuration version. A file without it
  is version 1. `config init` writes the version of the binary.
- The binary holds one ordered configuration step per version, in
  `src/config/steps.ts`. Step 1 renames `mission.consecutive_loss_limit`,
  `gateway.token_version` and `gateway.token_lifetime`.
- The database version is the migration history of each service.

The command runs in this order:

1. Read the file and apply the steps from its version in memory. Validate the
   result. A version newer than the binary fails with
   `system.config.version_ahead`. A file that holds both an old key and its new
   key fails with `system.config.rename_conflict`.
2. If `kanthord.db` exists, open it with its exclusive lock and validate its
   migration history, then its schema. Do the same for `tracking.db`. A missing
   `tracking.db` stays missing. A running server makes this fail with
   `system.database.initialization_failed` (`database is locked`). A history
   newer than the binary fails with
   `system.database.migration.incompatible_history`. A database
   of another migration text fails with `system.database.migration.schema_mismatch`.
   A `master_key` that differs from the one in `kanthord.db` fails with
   `system.config.master_key_mismatch`. The command checks both files and the
   master key before it writes a backup or a change.
3. If nothing changes, print `up_to_date: <path>` and write nothing.
4. Write the configuration backup `<path>.bak-<timestamp>` with one UTC
   timestamp when a configuration step applies. Print `backup: <path>`.
5. Take `kanthord.db`, then `tracking.db`. For each file with a pending
   migration, write `VACUUM INTO` to `<file>.bak-<timestamp>` in the data
   directory and print `backup: <path>`. Then apply the pending migrations of
   that file, one transaction for each migration. Print
   `migrated: <service> <a> -> <b>` for each service. An existing backup path
   fails the command.
6. Replace the configuration file atomically. Print
   `renamed: <old key> -> <new key>` for each rename, then
   `upgraded: <path>` and `config_version: <a> -> <b>`.

The command prints each row when its step happens. A later failure or a stop
keeps the earlier rows, for example the backup paths, on stdout. Every value
starts in column 17, after the longest row name `config_version:` and one space.

A rerun after a failure resumes from the recorded state. Steps 1 to 3 write
nothing. Step 4 writes only the configuration backup. Step 5 writes the database
backups and changes the databases. The command prints the backup path of a
database before the `migrated` rows of that database.

## Application startup

### `serve server`

```text
kanthord serve [server] [--config <path>]
```

**Implemented; route/access: none for startup, local runtime.** This invocation
constructs the server rather than calling an API operation.

- `application`: optional positional enum; implemented accepted value `server`,
  default `server`. The value `worker` selects the subcommand below. Any other
  supplied value fails with `cli.serve.unsupported_application`.
- [`--config`](./common-flags.md#--config): the selected file must exist and
  validate.
- [`--help`](./common-flags.md#--help): no runtime is started.

Load configuration, open the operational log, acquire the exclusive operational
database, apply every migration to a database without a recorded migration, compose the currently implemented Project, Worker,
and Gateway services, and open the listener only after domain startup. Starting
the current composition does not establish implementation of the future
Mission, Scheduler, Tracking, or native-worker runtime contracts.

Files/effects: validate or create the XDG configuration, data, and state
directories as needed; read the selected configuration; open/create
`kanthord.db` and its SQLite `-wal`/`-shm` sidecars in the data directory; and
append/create `kanthord.log` in the state directory when `log.destination` is
`file`. Private files/directories follow the `0600`/`0700` ownership rules.
The cache directory has no current server-owned output. The server writes
neither its configuration nor `cli.yaml` and issues no JWT. Future file owners,
including Tracking storage, need their own implemented lifecycle.

Output: operational JSON log records go to stderr by default or the configured
log file. The `info` record `Gateway Service started` carries the fields `bind`
and `port`. For a loopback bind, its message adds "A loopback bind accepts
connections from this host only." Startup prints no token and requires no terminal. A successfully
running process remains alive rather than exiting after readiness. A missing
or invalid configuration, permissions failure, database lock contention,
pending migration on a database with a recorded migration, migration failure, or listener failure stops startup and exits `1`; startup
releases resources already acquired. Committed migrations are not rolled back
by later startup failure.

`SIGINT` and `SIGTERM` request shutdown. A successful graceful stop exits `0`;
a lifecycle/cleanup failure exits `1`. The current stop has a 10-second
watchdog that exits `1` on expiry. `SIGHUP` reopens the configured log destination,
not the configuration; reopen failure initiates shutdown. Fatal uncaught errors
terminate nonzero through the fatal handler rather than normal graceful cleanup.

**Target requirement, not a statement that all phases are implemented:**
shutdown quiesces all producers, drains with peer dependencies available,
joins the invocation chain, and releases resources in reverse construction
order. Stopping preserves accepted obligations and does not revoke tokens or
undo completed work.

### `serve worker`

```text
kanthord serve worker [--instance <name>] [--endpoint <url>]
```

**Implemented; route/access: none for startup, local runtime.** This invocation
starts one worker instance. It calls public API operations over HTTP
only, and it opens no database. It reads no server configuration and no `cli.yaml`.

- `application`: the literal `worker` selects this mode; omitting it selects
  `server`.
- `--instance <name>`: the instance name. Without `KANTHORD_WORKER_CONFIG`, it
  selects the instance file `<XDG configuration directory>/kanthord/workers/<name>.yaml`.
  With `KANTHORD_WORKER_CONFIG`, it must equal the `name` of that configuration.
- [`--endpoint`](./common-flags.md#--endpoint): the server endpoint. It resolves
  the option, then `KANTHORD_ENDPOINT`, then the `endpoint` of the instance configuration.
- `--config` is refused with `cli.serve.worker_config`, because the worker
  application reads no server configuration.
- `--token` is refused with `cli.serve.worker_token`. The instance key is the only credential.
- [`--help`](./common-flags.md#--help): prints help without starting an
  application.

No other option exists. [`worker instance create`](./worker.md#instance-create)
or [`worker instance rotate`](./worker.md#instance-rotate) produces the instance
configuration. Startup reads it from one of two sources:

| Source                   | Form                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `KANTHORD_WORKER_CONFIG` | The unpadded base64url encoding of the canonical JSON `{ name, endpoint, instance_id, private_key }`.                                 |
| Instance file            | `<XDG configuration directory>/kanthord/workers/<name>.yaml` with the same four fields, written by [`worker join`](./worker.md#join). |

A set variable and an existing instance file of the same name fail with
`worker.start.instance_config_conflict`. No source fails with
`worker.start.instance_config_absent`. An invalid configuration fails with
`worker.instance.config_invalid`. The agent processes of the instance do not
receive `KANTHORD_WORKER_CONFIG`, `KANTHORD_TOKEN` or `KANTHORD_ENDPOINT`.

The data directory of the instance is `<XDG data directory>/kanthord/workers/<name>`.
The log directory is `<XDG state directory>/kanthord/workers/<name>`.
The bindings, the worker, the agent configuration and the client secret of each
binding come from the server through the bindings that list the instance.

Output: operational JSON log records go to stderr. Startup prints no token and
requires no terminal. Startup runs these steps in order:

1. Resolve the instance configuration and the endpoint.
2. Refuse an `http` endpoint whose host does not resolve only to loopback or
   private addresses, with `worker.start.endpoint_insecure`. Use `https` for any other host.
3. Install and check the pinned `rg` and `fd` in `<data directory>/pi/bin`.
4. Take a worker token with `worker.instance.token`. The answer is sealed to the
   instance key and carries the server package version. A different version
   fails with `worker.version.mismatch`, with both versions in the diagnostic.
   An indeterminate answer fails with `worker.version.unavailable`.
5. Log one record `Worker instance ready` with `instance`, `worker`,
   `fingerprint`, `connection_name` and `config_source` (`env` or `file`).
   `connection_name` is the host name.
6. Open the connection with `worker.instance.connect`. The sealed answer holds
   the client token and the client secret of each binding that lists the instance.
7. Register each binding. For each registration, log one record
   `Worker application ready` with `runtime_identity`, `resource_identity` and `worker_name`.

A startup failure prints its diagnostic, releases what it acquired and exits `1`.

After startup, the instance calls `worker.instance.heartbeat` at once and then every 15 s. A new
binding version opens the connection again, so the instance adds and drains
bindings without a restart. Every 30 minutes, the instance takes a new worker
token and opens the connection again. A changed client secret of a hosted
binding ends the process with `worker.instance.secret_changed`. A different
server version ends it with `worker.version.mismatch`. A rotated or archived
instance answers `404 worker.instance.not_found` and ends the process.

The heartbeat answer lists the pending OAuth login sessions of the instance in
`login_sessions`. The instance runs each session with pi-ai in `copy_code` or
`device` mode, reports its address and code through
`llm.credential.login_report`, and seals the result to its own key. While a
session is pending, the heartbeat runs every 2 s.

The first heartbeat answer and each new `credential_version` start a check of
the copies of the instance. The instance lists its copies with
`llm.credential.list` and reads each live copy sealed to its current key with
`llm.credential.sealed`. It opens the copy with its own key, runs the provider
check of the platform with a 10-second deadline, and reports the result
through `llm.credential.report`. A report holds `revision`, `status`,
`capability`, `failure_reason` and `models`. The server never calls the
provider with the key of an instance copy. A failed check or report logs
`Worker instance credential check failed` or `Worker instance credential report
failed` with the credential name and no secret.

One connection of an instance is current. A second process of the same
instance takes the connection. The first process then gets
`worker.instance.connection_superseded`, ends with
`worker.instance.superseded`, keeps its registrations and exits `3`. The
diagnostic names the `connection_name` of the other process.

During an execution, the application logs one info record for each task start
(`task started`), task commit (`task committed`), verification result (`task
verified`), task judgement (`task judged`) and node judgement (`node
judged`). The start check of a rework also logs the node verification result
(`node verified`) and the task that the agent chooses for a failed node
verification (`task chosen`). A record holds the execution, node, attempt and
task identities, commits, exit codes and results, and no agent content. The
application appends the transcript of each agent session to
`<data directory>/transcripts/<execution id>.jsonl` with mode 0600, and it keeps the
newest 50 execution transcripts.

When an execution ends, the application logs one record `execution ended`
with `execution_id` and `kind`. The `kind` is `released`, `closed` or `ended`.
For `ended`, the record adds `reason` and `code`. For `released` with a `stop`,
the record adds the `reason` and the `code` of that `stop`. When the stop has a
cause text, the record also adds `detail`. The `detail` holds the provider error
text or the thrown error text, with secrets removed and cut to 300 characters.

An execution that ends with a release or a closure leaves the binding
registered, and the application pulls again. A release with a `stop` is a
release. An execution that ends with no release and no closure exits `1`.

A work pull answer that fails its schema ends the pull loop with
`gateway.client.answer_invalid`. The application then deregisters nothing and
exits `1`. A restart with the same client identity inside the heartbeat window
resumes the same registration, and its first pull returns the same claim.

`SIGINT` and `SIGTERM` stop further startup and further work pulls. A stop
aborts the outstanding work pull. A claim that commits during that abort has no
worker until its lease expires, and settlement then declares it lost. The
application deregisters only a registration whose runtime identity it knows. It
exits `0` after a successful deregistration or after the `404` that ends its
registration, and exits `1` on any other deregistration or cleanup failure,
without a retry. A 10-second watchdog applies only when no execution is live and
no registration waits for its answer. `SIGHUP` reopens nothing.

The [Worker sibling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-worker-application) rules the application, credential handover, workspace, prompt configuration, heartbeat expiry and containment.
Shutdown during a live execution or a registration with no answer, and a stop
deadline in those cases remain **blocked** under [HANDOFF B9](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#b9-failure-and-recovery).

### `serve slot`

```text
kanthord serve slot
```

**Implemented; internal; route/access: none.** The `container` slot driver runs
this mode as the command of a slot container. A human never runs it, and help
does not list it. It takes no option.

- It reads the frames of the slot channel from standard input, one JSON object
  for each line. Its first frame is `init` with the `client_secret` of the slot.
- It writes frames to file descriptor 3 only. The container command moves the
  standard output to file descriptor 3 and points file descriptor 1 at standard
  error, so every other output lands in standard error.
- It creates the `TMPDIR` directory with mode `0700`, then starts the worker
  thread with the operational log on standard error.
- A `control` frame sends `drain` or `stop` to the thread. `SIGTERM` and `SIGINT`
  send `stop`. A thread that does not exit within 5 s after a signal is
  terminated.
- When the thread exits, it flushes file descriptor 3 and exits with the exit
  code of the thread.

It exits `1` with a diagnostic in these cases:

| Code                         | Condition                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- |
| `worker.slot.init_absent`    | No `init` frame arrives within 10 s.                                                                      |
| `worker.slot.frame_invalid`  | A line on standard input is no valid frame, or the first frame is not `init`, or a second `init` arrives. |
| `worker.slot.channel_closed` | Standard input reaches its end, or no frame arrives within 15 s.                                          |

## Local JWT issuance

JWT generation has two mutually exclusive modes under the `auth jwt` group.
`auth` is the group of every authentication command, and `jwt` is its one
mechanism. Both
call **no route**, require **no running server**, and open **no database**.
Without `--output`, they write **no file**. Possession of the validated server
configuration provides the signing material; there is no API access policy
to pass on this local path.
Gateway owns subsequent JWT verification and access policy; see
[Gateway commands and JWT use](./gateway.md).

### Human token

```text
kanthord auth jwt generate [username] [--name <display>] [--output [path]] [--endpoint <url>] [--config <path>]
```

- `username`: optional positional string, default `kanthorlabs`, the exported
  `KANTHORD_AUTH_USERNAME` **constant**. It is not an environment-variable
  fallback. Must be nonblank and 1–64 characters. Current validation uses
  JavaScript string length, checks `trim()` only for blankness, and preserves
  the exact supplied value rather than trimming it.
- `--name <display>`: optional string, default the selected username. Same
  nonblank/1–64-character validation and exact-value preservation. It labels
  the identity and grants no authority.
- [`--config`](./common-flags.md#--config): the selected server configuration
  must exist.
- `--project <project id>` and `--binding <binding name>`: absent in human mode.
  Supplying both selects machine mode; combining them with a username is an error.
- [`--help`](./common-flags.md#--help): displays the default username and
  resolved configuration path.
- `--output [path]`: write a new private client configuration file instead of
  the token on stdout. Without a value, use the default client path,
  `<XDG configuration directory>/kanthord/cli.yaml`, normally
  `~/.config/kanthord/cli.yaml`. Resolve an explicit relative path against the
  working directory. The command creates an absent file only. Readers use only
  the default path; a file at another path is an export.
- `--endpoint <url>`: endpoint written to the `--output` file. It requires
  `--output`. Use an absolute HTTP(S) URL without credentials, query or fragment,
  under the [endpoint rule](./common-flags.md#--endpoint). The command contacts
  no server. It does not copy an endpoint from the environment or an existing
  client file.

Before configuration load or signing, argument-value parsers run first. In
particular, a `--project` value that is no canonical `project_<ulid>` identity
fails with `gateway.authentication.invalid_project` before combination checks. The action then
checks these conditions in order:

1. A username with `--binding` fails with `cli.auth.jwt.username_with_binding`. `--binding` without `--project` fails with `cli.auth.jwt.binding_without_project`, and `--project` without `--binding` fails with `cli.auth.jwt.project_without_binding`.
2. `--endpoint` without `--output` fails with `cli.auth.jwt.endpoint_without_output`.
3. An invalid `--endpoint` fails with `cli.config.invalid_endpoint`.

These failures write no file and print no token. Without `--output`, the
terminal requirement and token output stay unchanged. With `--output`, no
terminal check applies. Validate the document with the client configuration
schema, then serialize it as YAML. A human token file holds only `token`, or
`endpoint` then `token` when `--endpoint` is given. A machine token file holds
the same fields. With `--output`, the command does not print the token.

Create an absent destination directory at `0700`. Write a same-directory
`0600` temporary file, flush and close it, then link it to the destination
without replacement and remove the temporary file. An existing destination
fails with `system.files.publish_failed` and stays byte-identical. When `--output`
has no path, the diagnostic adds the row `hint: pass --output <path> for a second
client file`. No force option exists. A failed publication prints no token.

On success stdout is exactly `created: <absolute path>\n`. With `--verbose`,
the existing claim list follows that line. The token is never printed to
stdout or stderr when `--output` is used.

```sh
kanthord auth jwt generate --output
kanthord auth jwt generate ulrich --output ./ulrich.cli.yaml --endpoint https://tunnel.example
```

Generate claims `kind: "human"`, `sub: <username>`, and `name: <display>`, with
no `project_id` or `resource_identity`. Reissuing for the same username preserves that subject but
generates a fresh `jti`. It creates no account or password record.

### Machine token

```text
kanthord auth jwt generate --project <project id> --binding <binding name> [--name <display>] [--output [path]] [--endpoint <url>] [--config <path>]
```

- `--binding <binding name>`: required in machine mode; 1 to 63 characters,
  a lower-case letter first, then lower-case letters, digits and hyphens.
- `--project <project id>`: required in machine mode; a canonical `project_<ulid>`
  identity under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).
- `username`: forbidden with `--binding`. Even a valid human username produces
  `cli.auth.jwt.username_with_binding` and no token.
- `--name <display>`: optional nonblank string of 1–64 characters; default the
  newly generated client identity. Same validation/preservation as human mode.
- [`--config`](./common-flags.md#--config): the selected file must exist.
- [`--help`](./common-flags.md#--help): no issuance or runtime startup.

Generate claims `kind: "client"`, `sub: "client_identity_<ulid>"`,
`project_id: <project id>`, `resource_identity: worker:kanthord:<binding name>`, and `name: <display>`. Every successful invocation uses a
fresh canonical client-identity ULID and `jti`. It creates no client identity
row and no worker registration. Local issuance cannot check whether
the named binding exists or is available; Gateway checks it on later use, and
a token for an absent/unavailable binding fails verification. Registration is
a separate Worker operation.

Without `--output` or `--verbose`, machine mode prints exactly `token: <JWT>\n`.
The command prints no client secret. The server derives the client secret of a
machine token from its `master_key` and the token `sub`, under the
[client-secret ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-client-secret).
The server stores no client secret.

### Token inspection

```text
kanthord auth jwt inspect [token]
```

Inspect takes the token argument first, then `KANTHORD_TOKEN`, then the `token`
field of private `cli.yaml`. A missing or blank token fails with
`cli.auth.jwt.inspect.token_required`. A malformed token fails with
`cli.auth.jwt.inspect.malformed_token`; the diagnostic never prints the token.
Inspect decodes locally without signature or expiry checks. It needs no server
configuration, route, database, terminal stdout, or `--config` option.
It prints only the payload claims in signed key order. Strings and numbers print
raw; other values print as JSON. Safe integer `iat` and `exp` values append a
UTC ISO 8601 timestamp without milliseconds. For example:

```text
---
sub: ulrich
name: ulrich
kind: human
iat: 1790580900 # 2026-09-28T07:35:00Z
exp: 1822116900 # 2027-09-28T07:35:00Z
jti: 01K6...
---
```

`auth jwt generate --verbose` prints this same claim list after the `token` row,
or after the `created: <absolute path>` row with `--output`.

### Signing, output, errors, and persistence

**Implemented:** both modes read the validated whole server configuration,
derive the signing key using HKDF-SHA-256 with an empty salt and the label
`gateway/jwt-hs256/v<auth_version>`, and sign with HS256. Both include `iat` and `exp` in
JWT Unix seconds and a fresh bare ULID `jti`; `exp = iat + gateway.auth.token_lifetime`.
`auth_version` is `gateway.auth.version`, under the [Gateway signing key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key).
The CLI has no lifetime, algorithm, issuer, audience, custom-claims, subject-ID,
or signing-key override flags.
The [Gateway JWT ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-jwt) declares the closed header and claim contract.

After argument validation and the option conflict checks, stdout must be a
terminal unless `--output` is given. Without `--output`, a file, pipe, command
substitution, or other non-terminal stdout fails with
`cli.output.terminal_required` and exit `1`, before configuration loading and
token signing. The message tells the user to pass `--output <path>`, or to run
the container command with `-t`. Stdin need not be a terminal and is never read.

Without `--output` or `--verbose`, human mode prints exactly `token: <JWT>\n`.
Without `--output`, machine mode prints the same `token` row. Exit is `0`.
With `--verbose`, the claim list follows the `token` row. It adds no client secret to the claims.
No secret is printed to stderr. Invalid inputs, an absent or invalid
configuration, failed terminal check, or signing failure exits nonzero without
a successful token result.

`--output` saves a human or a machine token in
an absent private client configuration file under the [human-token
rules](#human-token). It prints only `created: <absolute path>\n`, followed by
claims when `--verbose` is given. It never prints the token, including on a failed publication. Readers use only
the default client path. Without `--output`, issuance saves no client
configuration. Terminal-only output does not detect a terminal recorder.

Issuance and a server restart without a configuration change revoke no earlier
token. Under the [Gateway signing key
ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key),
an increment of `gateway.auth.version` and a restart invalidate every issued
JWT and change every client secret. The Custody key stays unchanged.
A token remains usable subject to verification, expiry, and, for machines,
binding availability. Replacing
`master_key` invalidates tokens and changes every client secret and every other
key derived from it. This specification adds no secret-rotation command or
recovery workflow. The CLI cannot reissue a lost machine token with the same
client identity;
new issuance creates a new identity and its
registration/capacity consequences belong to Worker.

## Help semantics

The [`--help`](./common-flags.md#--help) reference defines the implemented
parser option and its no-work behavior. Command-specific forms are:

- `kanthord -h` or `kanthord --help`: print root help to stdout and exit `0`.
  List exactly the three global names, four component groups and six service
  groups. There is no
  top-level `help` command; `kanthord help` fails with `error: unknown command 'help'`.
- `kanthord -V` or `kanthord --version`: print the package version to stdout
  and exit `0`. See [`--version`](./common-flags.md#--version).
- `kanthord` with no command: print root help to stdout and exit `1`; start no
  application. This differs deliberately from an explicit help request.
- `kanthord <operand>` or `kanthord <group> <operand>` with an unknown operand: print
  the Commander error `error: unknown command '<operand>'` to stderr, with a
  `Did you mean` line when a similar name exists, and exit `1`. A group with no
  operand prints its help and exits `0`.
- `kanthord <group> --help`: print that group's commands and applicable options
  and exit `0`. A bare `config` or service group also displays group help and
  exits `0`; a bare `auth` or `auth jwt` also prints group help and exits `0`. A bare
  `serve` starts the server.
- `kanthord <group> <command> --help`, `kanthord serve --help`, and
  `kanthord auth jwt generate --help` and `kanthord auth jwt inspect --help`: print command-specific help and exit `0` rather than
  performing the command. There are no additional help operands or required
  credentials.
- `config` and each of `config init`, `validate`, and `show` append
  `Configuration file: <absolute-path>` for this invocation, even if the file
  is absent. `auth jwt generate --help` appends the same line. `serve` help does not
  currently append it. The path is not a claim about a running server.

**Target requirement:** every command's help must declare all positional
arguments and options, requiredness, validation, and defaults, including the
inherited options applicable to it. Current help lacks some detail recorded
here, including client precedence/validation and the unimplemented worker
application. The proposed shared flags must appear only on commands that
implement them. Help is not an extra root name or a reason to load secrets.

## Error codes

| HTTP            | Code                                             | Condition                                                                                                                                                                            | Commands                                                                   |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| local           | `worker.lifecycle.stopped`                       | The Worker Service or application cannot restart after shutdown.                                                                                                                     | server or serve worker                                                     |
| local           | `project.lifecycle.stopped`                      | The Project Service cannot restart after shutdown.                                                                                                                                   | server or serve worker                                                     |
| local           | `mission.lifecycle.stopped`                      | The Mission Service cannot restart after shutdown.                                                                                                                                   | server or serve worker                                                     |
| local           | `intake.lifecycle.stopped`                       | A stopped Intake Service cannot start again.                                                                                                                                         | serve server                                                               |
| local           | `custody.lifecycle.stopped`                      | A stopped Custody component cannot start again.                                                                                                                                      | serve server                                                               |
| local           | `gateway.client.answer_invalid`                  | An answer with the expected status fails the operation output schema; the result is a failure with the received status.                                                              | remote commands, serve worker                                              |
| local           | `gateway.client.version_unavailable`             | The OpenAPI index cannot supply a valid server package version.                                                                                                                      | serve worker                                                               |
| local           | `cli.command.required`                           | No command was supplied.                                                                                                                                                             | kanthord                                                                   |
| local           | `cli.config.invalid`                             | The stored `cli.yaml` fails the client configuration schema.                                                                                                                         | client commands                                                            |
| local           | `cli.config.invalid_endpoint`                    | The resolved endpoint is not an absolute HTTP(S) URL without credentials, query or fragment.                                                                                         | remote commands, serve worker, auth jwt generate                           |
| local           | `cli.config.invalid_allowed_host`                | An `--gateway-allowed-host` value is not exactly `<name>` or `<name>:<port>`.                                                                                                        | config init                                                                |
| local           | `cli.file.duplicate_key`                         | The JSON input repeats an object key.                                                                                                                                                | commands with `--file`                                                     |
| local           | `cli.file.encoding_invalid`                      | The input file is not valid UTF-8.                                                                                                                                                   | commands with `--file`                                                     |
| local           | `cli.file.invalid_path`                          | The `--file` value is `-`; standard input is not accepted.                                                                                                                           | commands with `--file`                                                     |
| local           | `cli.file.not_found`                             | The `--file` path does not exist.                                                                                                                                                    | commands with `--file`                                                     |
| local           | `cli.file.not_json`                              | The input file is not valid JSON.                                                                                                                                                    | commands with `--file`                                                     |
| local           | `cli.file.not_object`                            | The JSON input is null, an array or a scalar, not an object.                                                                                                                         | commands with `--file`                                                     |
| local           | `cli.file.not_regular`                           | The `--file` path names a directory, a device or another non-regular file.                                                                                                           | commands with `--file`                                                     |
| local           | `cli.file.schema_invalid`                        | The JSON object does not match the command input schema. An unrecognized key gets one issue with the key at the end of `path`.                                                       | commands with `--file`                                                     |
| local           | `cli.idempotency_key.invalid`                    | The `--idempotency-key` value is not a canonical ULID.                                                                                                                               | mutations with `--idempotency-key`                                         |
| local           | `cli.auth.jwt.endpoint_without_output`           | `--endpoint` is given without `--output`.                                                                                                                                            | auth jwt generate                                                          |
| local           | `cli.auth.jwt.inspect.malformed_token`           | The token is not three base64url segments with a JSON object header and a JSON object payload.                                                                                       | auth jwt inspect                                                           |
| local           | `cli.auth.jwt.inspect.token_required`            | No argument, KANTHORD_TOKEN or cli.yaml token supplies a token.                                                                                                                      | auth jwt inspect                                                           |
| local           | `cli.auth.jwt.binding_without_project`           | `--binding` is given without `--project`.                                                                                                                                            | auth jwt generate                                                          |
| local           | `cli.auth.jwt.project_without_binding`           | `--project` is given without `--binding`.                                                                                                                                            | auth jwt generate                                                          |
| local           | `cli.auth.jwt.username_with_binding`             | A JWT request names a worker binding and a human username together.                                                                                                                  | auth jwt generate                                                          |
| local           | `cli.option.duplicate`                           | A single-use option appears more than once.                                                                                                                                          | commands with single-use flags                                             |
| local           | `cli.output.terminal_required`                   | JWT output would go to a non-terminal standard output. The message names `--output <path>` and `-t`.                                                                                 | auth jwt generate                                                          |
| local           | `cli.pagination.limit_invalid`                   | The `--limit` value is not a positive safe integer.                                                                                                                                  | list commands with `--limit`                                               |
| local           | `cli.pagination.limit_out_of_range`              | The `--limit` value exceeds 1000.                                                                                                                                                    | list commands with `--limit`                                               |
| local           | `cli.serve.unsupported_application`              | The named `serve` application is neither `worker` nor the default server.                                                                                                            | serve                                                                      |
| local           | `worker.slot.init_absent`                        | No `init` frame arrives within 10 s.                                                                                                                                                 | serve slot                                                                 |
| local           | `worker.slot.frame_invalid`                      | A line on standard input is no valid frame, or the first frame is not `init`, or a second `init` arrives.                                                                            | serve slot                                                                 |
| local           | `worker.slot.channel_closed`                     | Standard input reaches its end, or no frame arrives within 15 s.                                                                                                                     | serve slot                                                                 |
| local           | `cli.serve.worker_config`                        | `serve worker` was given the unsupported `--config` option.                                                                                                                          | serve worker                                                               |
| local           | `cli.serve.worker_token`                         | `serve worker` was given the unsupported `--token` option.                                                                                                                           | serve worker                                                               |
| local           | `gateway.authentication.invalid_binding`         | The binding name is not 1 to 63 characters of a lower-case letter, then lower-case letters, digits and hyphens.                                                                      | auth jwt generate                                                          |
| local           | `gateway.authentication.invalid_lifetime`        | The JWT lifetime is not a nonnegative safe integer.                                                                                                                                  | auth jwt generate                                                          |
| local           | `gateway.authentication.invalid_name`            | The display name is blank or longer than 64 characters.                                                                                                                              | auth jwt generate                                                          |
| local           | `gateway.authentication.invalid_project`         | The `--project` value is not a canonical `project_<ulid>` identity.                                                                                                                  | auth jwt generate                                                          |
| local           | `gateway.authentication.invalid_username`        | The username is blank or longer than 64 characters.                                                                                                                                  | auth jwt generate                                                          |
| 401             | `gateway.authentication.unauthorized`            | A required JWT is absent, has an invalid signature or has the wrong caller kind, or its binding does not resolve.                                                                    | authenticated remote commands                                              |
| 401             | `gateway.jwt.unknown_claim`                      | The token holds an unknown claim.                                                                                                                                                    | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.missing_claim`                      | The token lacks a required claim.                                                                                                                                                    | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.forbidden_claim`                    | The token holds a claim that its kind forbids.                                                                                                                                       | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.invalid_type`                       | A claim has an invalid value, or `kind` is not `human`, `client` or `worker`.                                                                                                        | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.expired`                            | The token expired.                                                                                                                                                                   | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.not_yet_issued`                     | The `iat` of the token is after the verification time.                                                                                                                               | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.instance_ended`                     | The worker instance revision of the token ended.                                                                                                                                     | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.instance_required`                  | A machine token of a binding at the `worker` placement lacks `instance_id` or `connection_id`.                                                                                       | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.connection_superseded`              | Another connection of the worker instance is current.                                                                                                                                | authenticated remote commands, serve worker                                |
| 401             | `gateway.jwt.instance_not_listed`                | The binding does not list the worker instance of the token.                                                                                                                          | authenticated remote commands, serve worker                                |
| 503             | `gateway.healthcheck.inventory_failed`           | A resource owner did not supply its health inventory.                                                                                                                                | GET /api/healthcheck                                                       |
| upstream status | `gateway.http.failed`                            | HTTP middleware raises an HTTP exception other than a timeout.                                                                                                                       | HTTP routes                                                                |
| 403             | `gateway.http.host_not_allowed`                  | The Host header is absent or not on `allowed_hosts`. `details`: `host` (lower-case, at most 255 characters, or `null`) and `field`. Client, worker and public routes skip the check. | HTTP routes                                                                |
| 409             | `gateway.idempotency.conflict`                   | The same caller reuses a key for a different operation or input.                                                                                                                     | remote mutations                                                           |
| 400             | `gateway.idempotency.invalid_key`                | The Idempotency-Key header is not a canonical ULID.                                                                                                                                  | remote mutations                                                           |
| 403             | `gateway.invocation.execution_proof_failed`      | The execution identity of the input is no live claim of the registration of the machine identity.                                                                                    | machine operations that require a live execution                           |
| 503             | `gateway.invocation.cancelled`                   | The request context is cancelled before the operation runs.                                                                                                                          | remote commands                                                            |
| 500             | `gateway.invocation.invalid_response`            | An operation returns data that fails its output schema.                                                                                                                              | remote commands                                                            |
| 503             | `gateway.invocation.stopping`                    | The invocation starts after the server begins stopping.                                                                                                                              | remote commands                                                            |
| 504             | `gateway.invocation.timeout`                     | The operation exceeds its route timeout.                                                                                                                                             | remote commands                                                            |
| 500             | `gateway.invocation.unknown`                     | An operation fails without an explicit safe HTTP error.                                                                                                                              | remote commands                                                            |
| 503             | `gateway.lifecycle.not_ready`                    | An HTTP request arrives before the server is ready.                                                                                                                                  | HTTP routes                                                                |
| local           | `gateway.lifecycle.stopped`                      | A stopped Gateway Service cannot start again.                                                                                                                                        | serve server                                                               |
| local           | `gateway.listener.bind_failed`                   | The server cannot bind its configured listener address.                                                                                                                              | serve server                                                               |
| 503             | `gateway.liveness.unhealthy`                     | A service is unavailable or no healthchecks are registered.                                                                                                                          | GET /api/liveness                                                          |
| 404             | `gateway.openapi.not_found`                      | The requested scoped OpenAPI file does not exist.                                                                                                                                    | GET /api/openapi/:service/:file                                            |
| 503             | `gateway.openapi.unavailable`                    | The published OpenAPI file cannot be read.                                                                                                                                           | GET /api/openapi.yaml, GET /api/openapi/:service/:file                     |
| 403             | `gateway.registration.required`                  | A machine call lacks a live worker registration.                                                                                                                                     | registered machine operations except worker register                       |
| 409             | `gateway.registration.stale`                     | A registration replay names a registration that has ended.                                                                                                                           | worker register                                                            |
| 413             | `gateway.request.body_too_large`                 | The request body exceeds the route byte limit.                                                                                                                                       | HTTP routes with bodies                                                    |
| 400             | `gateway.request.invalid_json`                   | The request body is not valid JSON.                                                                                                                                                  | HTTP routes with JSON bodies                                               |
| 400             | `gateway.request.unexpected_body`                | A body was sent to an operation that accepts none.                                                                                                                                   | HTTP routes without bodies                                                 |
| 415             | `gateway.request.unsupported_media_type`         | A JSON-body route lacks an `application/json` Content-Type.                                                                                                                          | HTTP routes with JSON bodies                                               |
| 400             | `gateway.request.validation_failed`              | The params, query or body fail the operation input schema. An unrecognized key gets one `details` issue with the key at the end of `path`.                                           | remote commands                                                            |
| 404             | `gateway.routing.not_found`                      | No route matches the request path or preflight method, or the path is outside `gateway.base_path`.                                                                                   | unmatched HTTP routes                                                      |
| local           | `system.config.cyclic_alias`                     | A YAML alias creates a cycle.                                                                                                                                                        | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.rename_conflict`                  | The configuration holds both a renamed key and its new name.                                                                                                                         | upgrade                                                                    |
| local           | `system.config.version_ahead`                    | The configuration version is newer than the binary.                                                                                                                                  | config validate, config show, auth jwt generate, serve server, upgrade     |
| local           | `system.config.version_behind`                   | The configuration version is older than the binary. Run `kanthord upgrade`.                                                                                                          | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.invalid_field`                    | The server configuration contains an unknown or invalid field.                                                                                                                       | config init, config validate, config show, auth jwt generate, serve server |
| local           | `system.config.invalid_mapping`                  | The YAML root is not one mapping, or a nested value is not a plain mapping or array.                                                                                                 | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.invalid_yaml`                     | The YAML cannot be parsed as one mapping with unique string keys.                                                                                                                    | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.not_found`                        | The server configuration file is absent.                                                                                                                                             | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.too_deep`                         | The configuration exceeds 32 levels of nesting.                                                                                                                                      | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.too_large`                        | The configuration YAML exceeds 1 MiB.                                                                                                                                                | config validate, config show, auth jwt generate, serve server              |
| local           | `system.config.too_many_values`                  | The configuration exceeds 4096 values.                                                                                                                                               | config validate, config show, auth jwt generate, serve server              |
| local           | `system.context.cancelled`                       | The operation context is cancelled.                                                                                                                                                  | remote commands                                                            |
| local           | `system.context.deadline_exceeded`               | The operation deadline expires.                                                                                                                                                      | remote commands                                                            |
| local           | `system.database.initialization_failed`          | The operational database cannot be initialized. The message names the SQLite reason, for example `database is locked`.                                                               | serve server                                                               |
| local           | `system.database.migration.duplicate_service`    | Two migration lists claim the same service name.                                                                                                                                     | serve server                                                               |
| local           | `system.database.backup_failed`                  | The database backup cannot be written, or its path exists.                                                                                                                           | upgrade                                                                    |
| local           | `system.database.migration.incompatible_history` | Stored migrations differ from the daemon migration list.                                                                                                                             | serve server, upgrade                                                      |
| local           | `system.database.migration.schema_mismatch`      | The schema of a recorded service differs from its migration text. Delete `kanthord.db`, `tracking.db` and their `-wal` and `-shm` files.                                             | serve server, upgrade                                                      |
| local           | `system.database.binding_placement_missing`      | A stored native worker binding holds no `placement`. Delete `kanthord.db`, `tracking.db` and their `-wal` and `-shm` files.                                                          | serve server                                                               |
| local           | `system.database.migration.pending`              | A database with a recorded migration has a pending migration. Run `kanthord upgrade`.                                                                                                | serve server                                                               |
| local           | `system.config.master_key_mismatch`              | `master_key` does not match the database. Restore the configuration file that created it, or the matching backup.                                                                    | serve server                                                               |
| local           | `system.database.open_failed`                    | The operational SQLite store cannot open.                                                                                                                                            | serve server                                                               |
| local           | `system.files.create_failed`                     | A private state or configuration directory cannot be created.                                                                                                                        | config init, serve server, auth jwt generate --output                      |
| local           | `system.files.inspect_failed`                    | The process cannot inspect a required private file or directory.                                                                                                                     | config commands, auth jwt generate, serve server, serve worker             |
| local           | `system.files.invalid_permissions`               | A required private path has the wrong type, owner or POSIX mode.                                                                                                                     | config commands, auth jwt generate, serve server, serve worker             |
| local           | `system.files.open_failed`                       | A private file cannot be opened without following symlinks.                                                                                                                          | config commands, auth jwt generate, serve server, serve worker             |
| local           | `system.files.publish_failed`                    | The private file cannot be published or the destination already exists.                                                                                                              | config init, auth jwt generate --output                                    |
| local           | `system.lifecycle.stopped`                       | A stopped server cannot start again.                                                                                                                                                 | serve server                                                               |
| 409             | `system.operation.unknown`                       | An unknown error escapes a remote operation without a safe domain code.                                                                                                              | remote commands                                                            |
| 400             | `system.pagination.cursor_invalid`               | The `--cursor` value is malformed or belongs to another listing.                                                                                                                     | paginated list commands                                                    |
| local           | `cli.<group>.<command>.token_required`           | No nonblank JWT is available for the command. The message names `--token`, `KANTHORD_TOKEN`, `cli.yaml` and `kanthord auth jwt generate`.                                            | remote commands                                                            |
| local           | `cli.<group>.<command>.indeterminate`            | The client cannot determine whether the request completed.                                                                                                                           | remote commands                                                            |
| local           | `cli.gateway.liveness.indeterminate`             | No usable answer: a refused connection, a transport failure, a deadline, invalid JSON, a redirect, or a non-200 answer with no envelope.                                             | gateway liveness                                                           |
| local           | `repository.connector.tool_missing`              | Bash, git or ssh fails to run or to report a known version, or `ssh-agent`, `ssh-add` or (serve server) `ssh-keyscan` is absent.                                                     | serve server, serve worker                                                 |
| local           | `repository.connector.tool_version`              | Git is older than 2.40 or OpenSSH is older than 9.0.                                                                                                                                 | serve server, serve worker                                                 |
| local           | `repository.connector.git_failed`                | A git operation of the repository connector fails, is aborted or reaches its deadline; the message names the operation.                                                              | serve worker, binding apply                                                |
| local           | `repository.node_branch.missing`                 | A record shows a push of the node branch and the remote holds no such branch; the steps execution stops.                                                                             | serve worker                                                               |

The internal error `system.composition.unwired` means that the composition root's
stand-in was called before its collaboration was implemented. It throws before
performing work. The Gateway exposes it to a remote caller as HTTP 500
`gateway.invocation.unknown` with message `Internal server error.` under the
[unwired collaboration rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#unwired-collaborations).

## Sources

Local implementation references:

- [CLI dispatch](../../src/apps/cli/index.ts),
  [root names and exits](../../src/apps/cli/constants.ts), and
  [CLI behavior tests](../../src/apps/cli/index.test.ts).
- [Client resolution](../../src/gateway/client.ts),
  [Worker registration command](../../src/apps/cli/worker.ts), and
  [HTTP adapter](../../src/gateway/client.ts).
- [Configuration assembly](../../src/config/index.ts),
  [global schema](../../src/config/global.ts),
  [Gateway schema](../../src/gateway/config.ts), and
  [private filesystem handling](../../src/kernel/files.ts).
- [Local JWT generation](../../src/gateway/auth/jwt.ts),
  [authentication configuration](../../src/gateway/auth/config.ts),
  [server composition and lifetime](../../src/apps/server/index.ts), and
  [launcher](../../bin/kanthord.mjs).

Optional provenance, not required reading for this specification:
[architecture implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md),
[Gateway implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md),
and [open design handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
