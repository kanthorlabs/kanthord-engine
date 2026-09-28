# Other commands and shared CLI conventions

[CLI specification index](./README.md) · [Gateway commands and JWT use](./gateway.md)

This contributor specification owns `config`, `serve`, `jwt`, help behavior,
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

There are seven application/issuance forms below: three configuration commands,
two `serve` application forms, and two modes of the single `jwt` command.
Help is a parser facility, not a fourth global command.

1. `kanthord config init [--config <path>]` — implemented; local, no route.
2. `kanthord config validate [--config <path>]` — implemented; local, no route.
3. `kanthord config show [--config <path>]` — implemented; local, no route.
4. `kanthord serve [server] [--config <path>]` — implemented; local application
   startup, no outbound API route. Opens the server's HTTP listener.
5. `kanthord serve worker [--endpoint <url>] [--token <jwt>]` — implemented; local
   application startup; the runtime calls public API operations afterward.
6. `kanthord jwt [username] [--name <display>] [--config <path>]` — implemented
   human issuance; local, no route.
7. `kanthord jwt --binding <binding> [--name <display>] [--config <path>]` —
   implemented machine issuance; local, no route.

Service commands, including local `gateway openapi`, are specified by their
owning pages in the [index](./README.md).

## Shared conventions

### Closed root names and option scope

**Implemented and target requirement:** the three global root names are
`config`, `serve`, and `jwt`. The six service root names are `project`, `mission`,
`scheduler`, `worker`, `tracking`, and `gateway`. These are disjoint, closed sets.
`server` and the application form of `worker` are operands of `serve`, never new
root commands. `cli` is not a `serve` operand. Current `project`, `mission`,
`scheduler`, and `tracking` groups expose help only.

- [`--config`](./common-flags.md#--config) selects server configuration only
  where the local command declares it; service commands reject it.
- [`--endpoint`](./common-flags.md#--endpoint) selects a remote server;
  inherited parser acceptance does not make a local command remote.
- [`--token`](./common-flags.md#--token) applies only to remote commands that
  declare it, currently `gateway verify` and `worker register`.
- [`--help`](./common-flags.md#--help) is the common help option.
  No universal `--json`, `--dry-run`,
  `--yes`, or `--version` option is declared by this specification or implemented
  by the current CLI.
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

A list invocation requests one page. Every list uses keyset pagination in
descending primary-key order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination),
so the first page holds the newest records and a refresh shows new records.
The base64url last-key cursor does not expire, a malformed cursor returns `400`,
and a list takes no snapshot. Do not silently traverse all pages. Preserve the
same list scope and filters when using a continuation. The result holds `items`
and `nextCursor`, both required, with `nextCursor: null` on the final page;
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
fields use camelCase, including `executionId` across service boundaries.

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

The target file holds `endpoint`, `token` and `masterKey` under the [client configuration ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-client-configuration-file).
Only `serve worker` reads `masterKey`; service-group commands ignore it.
It holds the server's 32-byte key in base64 and accepts no option or environment override.
The source snapshot below does not override that contract.

The path is `<XDG configuration directory>/kanthord/cli.yaml`, normally
`~/.config/kanthord/cli.yaml`. There is no `--client-config` path option and
`KANTHORD_CONFIG` does not select this file. An absent file is allowed. When
present, the current source accepts only optional `endpoint` and `token` fields in one YAML mapping.
The target also accepts `masterKey` as stated above. It shares the bounded YAML
parser described under [server configuration](#server-configuration).

The operator supplies the file manually. Current file checks require a regular
file owned by the running user with exact mode `0600`, reject symlinks and
special permission bits, and validate the opened descriptor using
`O_NOFOLLOW`. A narrower mode is rejected as well as a wider one. The resolver
reads and validates a present file even when flags override both values, so
an invalid file still fails the invocation.

The current CLI reads this file and provides no client-config create, update,
delete, login, logout, credential-saving, or secret-rotation commands. The server never
reads it. Issuing or using a token does not save it here. Local service commands
that do not resolve a client, notably `gateway openapi`, do not read it.

The worker application uses the same
[`--endpoint`](./common-flags.md#--endpoint) and
[`--token`](./common-flags.md#--token) resolution rules; see
[serve worker](#serve-worker).

## Output and exit behavior

**Implemented:** `runCLI` uses exit `0` for success and `1` for handled failures.
Commander help exits `0`; parsing failures exit nonzero. A caught CLI or domain
failure writes a diagnostic to stderr. Coded diagnostics use the owning
`cli`, `system`, or service namespace; Commander syntax diagnostics are not a
uniform JSON envelope. The launcher rejects unsupported Node.js versions with
one stderr line and a nonzero exit before loading the application. The supported
range is `>=24.15.0 <25`.

Current domain results (`gateway verify`, `worker register`) are one JSON value
followed by a newline on stdout. `worker register` includes its idempotency key.
Local output has explicit exceptions: help is text, `config init` and
`config validate` print status/path text, `config show` prints masked YAML, and
`jwt` prints a raw token only to terminal stdout. `serve` is long-running and
produces operational logs, not a domain-result JSON object.

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
  validation produced one. Emit a diagnostic and exit nonzero. Its meaning is
  owned by the operation; a failure in a multi-operation workflow does not undo
  a completed peer effect.
- **`Indeterminate`:** no trustworthy result could be established, including
  transport loss or an unparseable/unexpected response. Emit an explicit
  indeterminate diagnostic and exit nonzero. Do not report either success or
  "nothing happened." A mutation may have committed before its answer was lost.

Current CLI commands map `Failure` and `Indeterminate` to exit `1`; there is no
dedicated indeterminate exit code. These names describe the adapter contract,
not a universal CLI output envelope. Local commands have no remote
`OperationResult`; their command-specific effects and errors apply.

A proposed batch command may declare exit `1` for an unsuccessful domain result
while preserving a valid completed response on stdout. For example,
[Tracking ingestion](./tracking.md#output-and-failure-conventions) reports refused
records this way. The transport result remains `Completed`; it must not be
misreported as an API failure or an indeterminate response.

### Idempotency and retries

The [`--idempotency-key`](./common-flags.md#--idempotency-key) reference owns
key syntax, generation, header mapping, and explicit cross-invocation reuse.
The following rules govern replay and recovery rather than flag parsing.
A changed effect needs a new logical invocation and key, after resolving any
uncertainty about the original effect.

**Implemented:** replay is in memory, scoped to the caller and one
server process, with `gateway.idempotencyTtl` defaulting to `86400` seconds.
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

Some domain operations additionally need a durable `requestId`. The Scheduler work pull and lease renewal derive it as `request_<same-key-ulid>` from the CLI's bare idempotency key. The Scheduler release carries none.
It does not apply to every mutation. It is distinct
from Gateway's transport `X-Request-Id`, which identifies one HTTP request;
transport correlation alone never deduplicates a domain effect.

### Cancellation is not revocation

**Target requirement:** cancellation requests an end to waiting or work; it
does not prove cleanup has finished and undoes no committed effect. Cancelling
a work pull releases no committed claim and ends no accepted obligation.
Closing an MCP stream ends the connection, not the domain session. An increment
of `gateway.tokenVersion` and a server restart invalidate every issued JWT,
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

The three `config` commands, `serve server`, and `jwt` share this implemented
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
path-valued field inside the configuration resolves against the data directory;
the current schema declares no such field.

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

- `masterKey`: required canonical base64 encoding of exactly 32 bytes. There
  is no usable default. `config init` generates it using `crypto.randomBytes`.
- `log.level`: optional enum `trace|debug|info|warn|error|fatal`, default `info`.
- `log.destination`: optional enum `stderr|file`, default `stderr`; `file` uses
  `kanthord.log` in the XDG state directory.
- `gateway.bind`: optional loopback-IP string, default `127.0.0.1`; current
  validation accepts IPv4 `127.*` loopback addresses and `::1`.
- `gateway.port`: optional Convict `port`, default `31415`.
- `gateway.allowedHosts`: optional array of nonempty strings, default
  `["127.0.0.1:31415", "localhost:31415"]`.
- `gateway.allowedOrigins`: optional array of nonempty strings, default `[]`.
- `gateway.tokenLifetime`: optional Convict `nat` in seconds, default
  `31536000` (one year). Local issuance additionally requires a nonnegative safe
  integer; zero produces an immediately expiring token.
- `gateway.idempotencyTtl`: optional positive safe integer in seconds, default
  `86400`. The idempotency component uses it as the TTL of an in-memory record.

- `mission.consecutiveLossLimit`: optional Convict `nat`, default `3`. It
  holds the consecutive loss limit of the Mission Service.
- `mission.textMaxBytes`: optional Convict `nat` in UTF-8 bytes, default
  `32768`. It bounds every `Text` value of a Mission write; a stored value keeps
  its length after a change of the bound.

The current Project and Worker fragments are empty and add no YAML sections.
See [Gateway](./gateway.md) for authentication context.

## Configuration commands

All three commands have **no positional arguments**. Their only command input
is [`--config`](./common-flags.md#--config), inherited from `config` with the
shared path contract. [`--help`](./common-flags.md#--help) prints help instead
of performing the operation. No force/overwrite option exists. Each command is local, calls no API route, starts no server, and opens
no database. None reads or writes `cli.yaml`.

### `config init`

```text
kanthord config init [--config <path>]
```

**Implemented; route/access: none, local filesystem.** The destination must be
absent. Build a whole document with every current default and a newly generated
master key, validate it in memory, and then publish it. The invocation itself
authorizes creation; stdin and stdout may both be redirected.

Create the destination directory at `0700` when absent. Write a same-directory
temporary file at `0600`, flush and close it, hard-link it to the destination
without replacement, and unlink the temporary file. An existing destination
fails without overwriting it; a publication failure does not leave a partially
written destination. A directory created before failure can remain.

On success stdout is exactly `Created <absolute-path>\n` and exit is `0`.
It prints no generated configuration or secret. Invalid permissions, an existing
destination, or a write/publication failure produces a diagnostic and exit `1`.
Output/cleanup failure after publication does not undo an already created file;
inspect the destination instead of assuming a failed invocation wrote nothing.

### `config validate`

```text
kanthord config validate [--config <path>]
```

**Implemented; route/access: none, local filesystem.** Read and validate the
selected stored configuration with defaults and strict schema validation. The
file must exist. Validation covers its document, field values, and the private
file/containing-directory checks; it is not a startup probe, listener bind test,
database lock check, or remote authentication test.

On success stdout is exactly `Valid configuration: <absolute-path>\n` and exit
is `0`. On failure stderr reports the safe parse/permission diagnostic or the
collected invalid fields and exit is `1`. No file is created, repaired, or
modified. An absent file diagnostic includes its resolved path and the
`kanthord config init` command that can create it.

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
database, apply migrations, compose the currently implemented Project, Worker,
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
log file. Startup prints no token and requires no terminal. A successfully
running process remains alive rather than exiting after readiness. A missing
or invalid configuration, permissions failure, database lock contention,
migration failure, or listener failure stops startup and exits `1`; startup
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
kanthord serve worker [--endpoint <url>] [--token <jwt>]
```

**Implemented; route/access: none for startup, local runtime.** This invocation
starts the remote `worker` application. It calls public API operations over HTTP
only, and it opens no database.

- `application`: the literal `worker` selects this mode; omitting it selects
  `server`.
- [`--endpoint`](./common-flags.md#--endpoint): the server endpoint. It resolves
  the option, then `KANTHORD_ENDPOINT`, then `cli.yaml` of the configuration
  directory, and it defaults to `http://127.0.0.1:31415`.
- [`--token`](./common-flags.md#--token): the machine JWT. It resolves the option,
  then `KANTHORD_TOKEN`, then `cli.yaml`.
- `--config` is refused with `cli.serve.worker_config`, because the worker
  application reads no server configuration.
- [`--help`](./common-flags.md#--help): prints help without starting an
  application.

No other option exists. The worker binding, the worker, the agent configuration
and the instance count come from the server through the binding that the machine
token names. `masterKey` comes from `cli.yaml` alone, under the
[client configuration ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-client-configuration-file).
The workspace lives under the XDG state directory of the host.

One process hosts one instance. The machine token carries one client identity,
and a client identity holds at most one live registration. N registration slots
of a worker binding need N processes with N machine tokens.

Output: operational JSON log records go to stderr. Startup prints no token and
requires no terminal. Startup resolves the client configuration, checks
`masterKey`, checks the server package version, registers the instance, and then
logs one record `Worker application ready` with `runtimeIdentity`,
`resourceIdentity` and `workerName`. A version mismatch refuses startup with both
versions in the diagnostic. Until registration is implemented, the record
`Worker application started` is a startup notice, not readiness. A startup
failure prints its diagnostic, releases what it acquired and exits `1`.

`SIGINT` and `SIGTERM` stop further startup and further work pulls. The
application deregisters only a registration whose runtime identity it knows. It
exits `0` after a successful deregistration or after the `404` that ends its
registration, and exits `1` on any other deregistration or cleanup failure,
without a retry. A 10-second watchdog applies only when no execution is live and
no registration or work pull waits for its answer. `SIGHUP` reopens nothing.

The [Worker sibling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-worker-application) rules the application, credential handover, workspace, prompt configuration, heartbeat expiry and containment.
Shutdown during a live execution, a registration or a work pull with no answer,
and a stop deadline in those cases remain **blocked** under [HANDOFF B9](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#b9-failure-and-recovery).

## Local JWT issuance

JWT issuance is one implemented top-level command with two mutually exclusive
modes. Both call **no route**, require **no running server**, open **no database**,
and write **no file**. Possession of the validated server configuration provides
the signing material; there is no API access policy to pass on this local path.
Gateway owns subsequent JWT verification and access policy; see
[Gateway commands and JWT use](./gateway.md).

### Human token

```text
kanthord jwt [username] [--name <display>] [--config <path>]
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
- `--binding <binding>`: absent in human mode. Supplying it selects machine
  mode; combining it with a username is an error, not two issuance requests.
- [`--help`](./common-flags.md#--help): displays the default username and
  resolved configuration path.

Generate claims `kind: "human"`, `sub: <username>`, and `name: <display>`, with
no `binding`. Reissuing for the same username preserves that subject but
generates a fresh `jti`. It creates no account or password record.

### Machine token

```text
kanthord jwt --binding <binding> [--name <display>] [--config <path>]
```

- `--binding <binding>`: required to select machine mode; string, no default;
  currently nonblank and 1–128 characters with the exact value preserved.
  Current local validation does not enforce a binding entity prefix.
  The target requires `--project <project id>` with `--binding <binding name>`, and the token holds
  `project_id` and `resource_identity` (`worker:kanthord:<binding name>`) under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).
- `username`: forbidden with `--binding`. Even a valid human username produces
  `cli.jwt.username_with_binding` and no token.
- `--name <display>`: optional nonblank string of 1–64 characters; default the
  newly generated client identity. Same validation/preservation as human mode.
- [`--config`](./common-flags.md#--config): the selected file must exist.
- [`--help`](./common-flags.md#--help): no issuance or runtime startup.

Generate claims `kind: "client"`, `sub: "client_identity_<ulid>"`,
`binding: <binding>`, and `name: <display>`. Every successful invocation uses a
fresh canonical client-identity ULID and `jti`. It creates no client identity
row and no worker-instance registration. Local issuance cannot check whether
the named binding exists or is available; Gateway checks it on later use, and
a token for an absent/unavailable binding fails verification. Registration is
a separate Worker operation.

### Signing, output, errors, and persistence

**Implemented:** both modes read the validated whole server configuration,
derive the signing key using HKDF-SHA-256 with an empty salt and the label
`gateway/jwt-hs256/v1`, and sign with HS256. Both include `iat` and `exp` in
JWT Unix seconds and a fresh bare ULID `jti`; `exp = iat + gateway.tokenLifetime`.
The [Gateway signing key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
sets the target label to `gateway/jwt-hs256/v<tokenVersion>`.
The CLI has no lifetime, algorithm, issuer, audience, custom-claims, subject-ID,
or signing-key override flags.
The [Gateway JWT ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-jwt) declares the closed header and claim contract.

After argument validation and the username/binding conflict check, stdout must
be a terminal. A file, pipe, command substitution, or other non-terminal stdout
fails with `cli.output.terminal_required` and exit `1`, before configuration
loading and token signing. Stdin need not be a terminal and is never read.

On success stdout contains only `<JWT>\n` and exit is `0`; no JSON envelope,
expiry annotation, or secret is printed to stderr. Invalid inputs, an absent or
invalid configuration, failed terminal check, or signing failure exits nonzero
without a successful token result. There is no output-file option or automatic
client-config persistence. Terminal-only output does not detect a terminal
recorder.

Issuance and a server restart without a configuration change revoke no earlier
token. Under the [Gateway signing key
ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key),
an increment of `gateway.tokenVersion` and a restart invalidate every issued
JWT while other derived keys stay unchanged. A token remains usable subject to
verification, expiry, and, for machines, binding availability. Replacing
`masterKey` invalidates tokens and also affects every other key derived from it;
this specification adds no secret-rotation command or recovery workflow. A lost
machine token cannot be reissued with the same client identity through this CLI;
new issuance creates a new identity and its
registration/capacity consequences belong to Worker.

## Help semantics

The [`--help`](./common-flags.md#--help) reference defines the implemented
parser option and its no-work behavior. Command-specific forms are:

- `kanthord -h` or `kanthord --help`: print root help to stdout and exit `0`.
  List exactly the three global names and six service groups. There is no
  top-level `help` command; `kanthord help` currently fails as excess input.
- `kanthord` with no command: print root help to stdout and exit `1`; start no
  application. This differs deliberately from an explicit help request.
- `kanthord <group> --help`: print that group's commands and applicable options
  and exit `0`. A bare `config` or service group also displays group help and
  exits `0`; a bare `serve` starts the server, and a bare `jwt` attempts default
  human issuance.
- `kanthord <group> <command> --help`, `kanthord serve --help`, and
  `kanthord jwt --help`: print command-specific help and exit `0` rather than
  performing the command. There are no additional help operands or required
  credentials.
- `config` and each of `config init`, `validate`, and `show` append
  `Configuration file: <absolute-path>` for this invocation, even if the file
  is absent. `jwt` currently appends the same line. `serve` help does not
  currently append it. The path is not a claim about a running server.

**Target requirement:** every command's help must declare all positional
arguments and options, requiredness, validation, and defaults, including the
inherited options applicable to it. Current help lacks some detail recorded
here, including client precedence/validation and the unimplemented worker
application. The proposed shared flags must appear only on commands that
implement them. Help is not an extra root name or a reason to load secrets.

## Error codes

| HTTP            | Code                                             | Condition                                                                                    | Commands                                               |
| --------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| local           | `worker.lifecycle.stopped`                       | The Worker Service or application cannot restart after shutdown.                             | server or serve worker                                 |
| local           | `project.lifecycle.stopped`                      | The Project Service cannot restart after shutdown.                                           | server or serve worker                                 |
| local           | `mission.lifecycle.stopped`                      | The Mission Service cannot restart after shutdown.                                           | server or serve worker                                 |
| local           | `gateway.client.version_unavailable`             | The OpenAPI index cannot supply a valid server package version.                              | serve worker                                           |
| local           | `cli.command.required`                           | No command was supplied.                                                                     | kanthord                                               |
| local           | `cli.config.invalid`                             | The stored `cli.yaml` fails the client configuration schema.                                 | client commands, serve worker                          |
| local           | `cli.config.invalid_endpoint`                    | The resolved endpoint is not an absolute HTTP(S) URL without credentials, query or fragment. | remote commands, serve worker                          |
| local           | `cli.file.duplicate_key`                         | The JSON input repeats an object key.                                                        | commands with `--file`                                 |
| local           | `cli.file.encoding_invalid`                      | The input file is not valid UTF-8.                                                           | commands with `--file`                                 |
| local           | `cli.file.invalid_path`                          | The `--file` value is `-`; standard input is not accepted.                                   | commands with `--file`                                 |
| local           | `cli.file.not_found`                             | The `--file` path does not exist.                                                            | commands with `--file`                                 |
| local           | `cli.file.not_json`                              | The input file is not valid JSON.                                                            | commands with `--file`                                 |
| local           | `cli.file.not_object`                            | The JSON input is null, an array or a scalar, not an object.                                 | commands with `--file`                                 |
| local           | `cli.file.not_regular`                           | The `--file` path names a directory, a device or another non-regular file.                   | commands with `--file`                                 |
| local           | `cli.file.schema_invalid`                        | The JSON object does not match the command input schema.                                     | commands with `--file`                                 |
| local           | `cli.idempotency_key.invalid`                    | The `--idempotency-key` value is not a canonical ULID.                                       | mutations with `--idempotency-key`                     |
| local           | `cli.jwt.username_with_binding`                  | A JWT request names a worker binding and a human username together.                          | jwt                                                    |
| local           | `cli.option.duplicate`                           | A single-use option appears more than once.                                                  | commands with single-use flags                         |
| local           | `cli.output.terminal_required`                   | JWT output would go to a non-terminal standard output.                                       | jwt                                                    |
| local           | `cli.pagination.limit_invalid`                   | The `--limit` value is not a positive safe integer.                                          | list commands with `--limit`                           |
| local           | `cli.pagination.limit_out_of_range`              | The `--limit` value exceeds 1000.                                                            | list commands with `--limit`                           |
| local           | `cli.serve.unsupported_application`              | The named `serve` application is neither `worker` nor the default server.                    | serve                                                  |
| local           | `cli.serve.worker_config`                        | `serve worker` was given the unsupported `--config` option.                                  | serve worker                                           |
| local           | `gateway.authentication.invalid_binding`         | The worker binding is blank or longer than 128 characters.                                   | jwt                                                    |
| local           | `gateway.authentication.invalid_lifetime`        | The JWT lifetime is not a nonnegative safe integer.                                          | jwt                                                    |
| local           | `gateway.authentication.invalid_name`            | The display name is blank or longer than 64 characters.                                      | jwt                                                    |
| local           | `gateway.authentication.invalid_username`        | The username is blank or longer than 64 characters.                                          | jwt                                                    |
| 401             | `gateway.authentication.unauthorized`            | A required JWT is absent, invalid, expired or has the wrong caller kind.                     | authenticated remote commands                          |
| 503             | `gateway.healthcheck.inventory_failed`           | A resource owner did not supply its health inventory.                                        | GET /api/healthcheck                                   |
| upstream status | `gateway.http.failed`                            | HTTP middleware raises an HTTP exception other than a timeout.                               | HTTP routes                                            |
| 403             | `gateway.http.host_not_allowed`                  | The request Host header is absent or not on `allowedHosts`.                                  | HTTP routes                                            |
| 409             | `gateway.idempotency.conflict`                   | The same caller reuses a key for a different operation or input.                             | remote mutations                                       |
| 400             | `gateway.idempotency.invalid_key`                | The Idempotency-Key header is not a canonical ULID.                                          | remote mutations                                       |
| 503             | `gateway.invocation.cancelled`                   | The request context is cancelled before the operation runs.                                  | remote commands                                        |
| 500             | `gateway.invocation.invalid_response`            | An operation returns data that fails its output schema.                                      | remote commands                                        |
| 503             | `gateway.invocation.stopping`                    | The invocation starts after the server begins stopping.                                      | remote commands                                        |
| 504             | `gateway.invocation.timeout`                     | The operation exceeds its route timeout.                                                     | remote commands                                        |
| 500             | `gateway.invocation.unknown`                     | An operation fails without an explicit safe HTTP error.                                      | remote commands                                        |
| 503             | `gateway.lifecycle.not_ready`                    | An HTTP request arrives before the server is ready.                                          | HTTP routes                                            |
| local           | `gateway.lifecycle.stopped`                      | A stopped Gateway Service cannot start again.                                                | serve server                                           |
| local           | `gateway.listener.bind_failed`                   | The server cannot bind its configured listener address.                                      | serve server                                           |
| 503             | `gateway.liveness.unhealthy`                     | A service is unavailable or no healthchecks are registered.                                  | GET /api/liveness                                      |
| 404             | `gateway.openapi.not_found`                      | The requested scoped OpenAPI file does not exist.                                            | GET /api/openapi/:service/:file                        |
| 503             | `gateway.openapi.unavailable`                    | The published OpenAPI file cannot be read.                                                   | GET /api/openapi.yaml, GET /api/openapi/:service/:file |
| 409             | `gateway.registration.capacity`                  | The worker binding has no free registration slot in test support.                            | worker register (test support)                         |
| 409             | `gateway.registration.conflict`                  | The client identity already holds a live registration.                                       | worker register                                        |
| 403             | `gateway.registration.required`                  | A machine call lacks a live worker registration.                                             | registered machine operations except worker register   |
| 409             | `gateway.registration.stale`                     | A registration replay names a registration that has ended.                                   | worker register                                        |
| 413             | `gateway.request.body_too_large`                 | The request body exceeds the route byte limit.                                               | HTTP routes with bodies                                |
| 400             | `gateway.request.invalid_json`                   | The request body is not valid JSON.                                                          | HTTP routes with JSON bodies                           |
| 400             | `gateway.request.unexpected_body`                | A body was sent to an operation that accepts none.                                           | HTTP routes without bodies                             |
| 415             | `gateway.request.unsupported_media_type`         | A JSON-body route lacks an `application/json` Content-Type.                                  | HTTP routes with JSON bodies                           |
| 400             | `gateway.request.validation_failed`              | The params, query or body fail the operation input schema.                                   | remote commands                                        |
| 404             | `gateway.routing.not_found`                      | No route matches the request path or preflight method.                                       | unmatched HTTP routes                                  |
| local           | `system.config.cyclic_alias`                     | A YAML alias creates a cycle.                                                                | config validate, config show, jwt, serve server        |
| local           | `system.config.invalid_field`                    | The server configuration contains an unknown or invalid field.                               | config validate, config show, jwt, serve server        |
| local           | `system.config.invalid_mapping`                  | The YAML root is not one mapping, or a nested value is not a plain mapping or array.         | config validate, config show, jwt, serve server        |
| local           | `system.config.invalid_yaml`                     | The YAML cannot be parsed as one mapping with unique string keys.                            | config validate, config show, jwt, serve server        |
| local           | `system.config.not_found`                        | The server configuration file is absent.                                                     | config validate, config show, jwt, serve server        |
| local           | `system.config.too_deep`                         | The configuration exceeds 32 levels of nesting.                                              | config validate, config show, jwt, serve server        |
| local           | `system.config.too_large`                        | The configuration YAML exceeds 1 MiB.                                                        | config validate, config show, jwt, serve server        |
| local           | `system.config.too_many_values`                  | The configuration exceeds 4096 values.                                                       | config validate, config show, jwt, serve server        |
| local           | `system.context.cancelled`                       | The operation context is cancelled.                                                          | remote commands                                        |
| local           | `system.context.deadline_exceeded`               | The operation deadline expires.                                                              | remote commands                                        |
| local           | `system.database.initialization_failed`          | The operational database cannot be initialized.                                              | serve server                                           |
| local           | `system.database.migration.duplicate_service`    | Two migration lists claim the same service name.                                             | serve server                                           |
| local           | `system.database.migration.incompatible_history` | Stored migrations differ from the daemon migration list.                                     | serve server                                           |
| local           | `system.database.open_failed`                    | The operational SQLite store cannot open.                                                    | serve server                                           |
| local           | `system.files.create_failed`                     | A private state or configuration directory cannot be created.                                | config init, serve server                              |
| local           | `system.files.inspect_failed`                    | The process cannot inspect a required private file or directory.                             | config commands, jwt, serve server, serve worker       |
| local           | `system.files.invalid_permissions`               | A required private path has the wrong type, owner or POSIX mode.                             | config commands, jwt, serve server, serve worker       |
| local           | `system.files.open_failed`                       | A private file cannot be opened without following symlinks.                                  | config commands, jwt, serve server, serve worker       |
| local           | `system.files.publish_failed`                    | The private file cannot be published or config init targets an existing file.                | config init                                            |
| local           | `system.lifecycle.stopped`                       | A stopped server cannot start again.                                                         | serve server                                           |
| 409             | `system.operation.unknown`                       | An unknown error escapes a remote operation without a safe domain code.                      | remote commands                                        |
| 400             | `system.pagination.cursor_invalid`               | The `--cursor` value is malformed or belongs to another listing.                             | paginated list commands                                |
| local           | `cli.<group>.<command>.token_required`           | No nonblank JWT is available for the command.                                                | remote commands                                        |
| local           | `cli.<group>.<command>.indeterminate`            | The client cannot determine whether the request completed.                                   | remote commands                                        |
| local           | `repository.connector.tool_missing`              | Bash, git or ssh cannot run, exits with an error or has unrecognized version output.         | serve server                                           |
| local           | `repository.connector.tool_version`              | Git is older than 2.40 or OpenSSH is older than 9.0.                                         | serve server                                           |

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
- [Local JWT generation](../../src/gateway/local.ts),
  [server composition and lifetime](../../src/apps/server/index.ts), and
  [launcher](../../bin/kanthord.mjs).

Optional provenance, not required reading for this specification:
[architecture implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md),
[Gateway implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md),
and [open design handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
