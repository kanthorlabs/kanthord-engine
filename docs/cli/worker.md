# Worker CLI specification

This is the future specification for `kanthord worker`. It contains **12 command leaves: 1 implemented command and 11 proposed commands**. The proposed command
names, routes, operation IDs, access policies, JSON fields and defaults below are
design proposals, not published API or working CLI commands. The behavioral
requirements identified as **target design** come from the Worker design; their
presence here does not establish implementation.

See the [CLI index](./README.md) for shared conventions and
[other commands](./other.md) for `serve worker`, server configuration and local
`jwt` issuance. Worker binding edits, instance counts, availability, agent
overrides and effective configuration resolution belong to [Project](./project.md).
Work pull, claims, execution records, lease renewal and release belong to
[Scheduler](./scheduler.md).

## Current implementation boundary

The [CLI implementation](../../src/apps/cli/worker.ts) and
[Worker operation contract](../../src/worker/contract.ts) declare only `register`.
The [registration implementation](../../src/worker/registrations.ts) holds one
in-memory registration per client identity and mints a runtime identity. Its
`findByClient` and `deregister` functions are internal collaborations, not CLI
commands or published routes.

The normal [server composition](../../src/apps/server/index.ts) currently supplies
no populated Project binding resolver. The default
[Project implementation](../../src/project/service.ts) returns no binding, so
ordinary machine authentication cannot yet resolve a configured worker binding.
Registration integration tests inject binding and registration implementations.
In particular, the production in-memory registration implementation checks the
one-registration-per-client rule but does not implement the design's atomic
binding instance-count admission. A registered command and route therefore do not
establish the complete usable Worker lifecycle.

The [Worker configuration fragment](../../src/worker/index.ts) is empty. Native
workers, their agent loops, the catalog, instance pools, instance healthchecks,
repository actions and MCP are target work. The current Worker service probe
reports registration-component availability; it is not an instance healthcheck.

## Shared input and output contract

Every command below reaches the selected server through a published operation.
It reads no server database. A proposed CLI command ships only together with its
operation declaration and generated OpenAPI route. All commands accept `--help`,
which needs no server or token. Unknown arguments/options and invalid local
inputs fail before a request. No command prompts, reads implicit standard input,
or accepts `--config`.

Shared syntax, types, defaults, and validation are defined by each linked flag.
Only applicability and Worker-specific requirements are listed here.

| Common flag                                                                      | Applies to / Worker requirement                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every command; inherited from the `worker` group.                                       |
| [`--token`](./common-flags.md#--token)                                           | Every operation requires a nonblank resolved token matching its human or client policy. |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Mutations only; implemented registration retains the `<ulid>` help spelling.            |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Each list command.                                                                      |
| [`--file`](./common-flags.md#--file)                                             | Required only for `mcp tool call`; the selected tool's schema is defined below.         |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                   |

The [shared client-file rules](./other.md#cliyaml-and-its-effects) apply.
Commands do not save or rewrite that file.

For proposed commands, all request objects are strict: undeclared fields are
rejected. An omitted optional field takes only its documented default; `null`
does not mean omission. No read accepts an idempotency key. Unless a section says
otherwise, the command has no positional arguments or options beyond its listed
ones and the applicable shared options; its request body is absent, represented
as `body: null` in the service-client envelope.

Proposed successful unary commands print one JSON line and exit `0`. List results
are `{ "items": [...], "nextCursor": null | string }`. Proposed mutations also
print the used `idempotencyKey`. Failures print a diagnostic and exit nonzero;
they do not print tokens. An indeterminate mutation reports its key and does not
assert that the operation had no effect. Repeating the same logical request uses
the same caller, inputs and key; starting another CLI invocation without that key
creates a new invocation. This proposal adds no automatic mutation retry.

The target invocation design limits replay to one process and the configured
TTL; domain handlers still need natural-key idempotency. Current registration's
storage differs, as documented in its section. Replay is not failure recovery,
and an idempotency key alone cannot reconcile an uncertain repository write.

### Names and identities

| Value                      | Type and validation                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkerName`               | Nonempty exact versioned catalog key, such as `general@1`. Required version; no implicit latest version or alias. Unknown names fail lookup. This is a natural key, not a ULID.                                                                              |
| `AgentName`                | Nonempty exact role/version key declared by the selected worker, such as `swe@1`; never a worker name. Unknown or mismatched names fail lookup.                                                                                                              |
| `ProjectId`                | Opaque `project_<ulid>` identity using the declared project prefix.                                                                                                                                                                                          |
| `RuntimeIdentity`          | Opaque server-returned runtime identity. Current generation uses `runtime_identity_<ulid>`, but the current wire schema accepts a nonblank string of length `1..128`; it does not enforce that prefix. Proposed consumers retain the returned value exactly. |
| `BindingId`, `ExecutionId` | `BindingId` uses `binding_<ulid>`. Execution identity validation remains **[blocked][worker-contract]**.                                                                                                                                                     |
| `ToolName`                 | One exact published tool name from the proposed tool catalog below; no arbitrary platform method name.                                                                                                                                                       |

An entity identity follows `<declared-prefix>_<ulid>`, where the ULID is canonical
uppercase and matches `[0-7][0-9A-HJKMNP-TV-Z]{25}`. Validate the expected entity
kind, not just the suffix. A bare ULID is valid for an idempotency key only.
Worker/agent names and MCP session IDs retain their natural-key/protocol forms.
The target runtime identity is `worker_instance_<ulid>` under the [Worker identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-identities-of-the-worker-service).

[worker-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-service

## Command inventory

`P` means proposed; `I` means implemented syntax and operation.
Heartbeat and handover retain their ruled routes; other `P` paths remain proposals, not claims about the current OpenAPI.
`human` authenticates a human JWT. `client` authenticates a machine JWT and requires
a live registration unless an explicit exception is stated.

| Status | Command after `kanthord worker`           | Route                                                   | Operation ID                                                 | Access / registration                                                            |
| ------ | ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| I      | `register`                                | `POST /api/worker/register`                             | `worker.register`                                            | `client`; `requiresRegistration: false`                                          |
| P      | `heartbeat [--token <jwt>]`               | `POST /api/worker/heartbeat`                            | `worker.heartbeat`                                           | `client`; live registration                                                      |
| P      | `handover [--token <jwt>]`                | `POST /api/worker/handover`                             | `worker.handover`                                            | `client`; live registration and live execution                                   |
| P      | `list`                                    | `GET /api/worker/catalog`                               | `worker.catalog.list` **[blocked][worker-contract]**         | `human`                                                                          |
| P      | `get <worker-name>`                       | `GET /api/worker/catalog/:workerName`                   | `worker.catalog.get` **[blocked][worker-contract]**          | `human`                                                                          |
| P      | `agent get <worker-name> <agent-name>`    | `GET /api/worker/catalog/:workerName/agent/:agentName`  | `worker.agent.get` **[blocked][worker-contract]**            | `human`                                                                          |
| P      | `instance list`                           | `GET /api/worker/instance`                              | `worker.instance.list` **[blocked][worker-contract]**        | `human`                                                                          |
| P      | `instance get <runtime-identity>`         | `GET /api/worker/instance/:runtimeIdentity`             | `worker.instance.get` **[blocked][worker-contract]**         | `human`                                                                          |
| P      | `instance healthcheck <runtime-identity>` | `GET /api/worker/instance/:runtimeIdentity/healthcheck` | `worker.instance.healthcheck` **[blocked][worker-contract]** | `human`                                                                          |
| P      | `instance deregister <runtime-identity>`  | `POST /api/worker/instance/:runtimeIdentity/deregister` | `worker.instance.deregister` **[blocked][worker-contract]**  | `client`; proposed `requiresRegistration: false`, with explicit ownership checks |
| P      | `mcp tool list`                           | `GET /api/worker/mcp/tool`                              | `worker.mcp.tool.list` **[blocked][worker-contract]**        | `client`; live registration and own live execution                               |
| P      | `mcp tool call <tool-name> --file <path>` | Three concrete `POST` routes in the tool mapping below  | Three static tool operations; **[blocked][worker-contract]** | `client`; live registration and own live execution; further per-tool checks      |

`credential` runs inside the `worker` application alone and is no CLI command.
Its operation is `worker.credential` at `POST /api/worker/credential`, with `client` access and a live execution requirement.

Catalog and operator inspection routes using `human` are a proposed addition to
the existing client-oriented Worker surface. Every authenticated human has the
server-owner authority of the target design; this table introduces no project
membership or administrator role. Machine inspection/calls remain scoped to the
authenticated client and claim and gain no authority from caller-supplied IDs.

## `register` — implemented

```text
kanthord worker [--endpoint <url>] register [--token <jwt>] [--idempotency-key <ulid>]
```

There are no positional arguments. [`--token`](./common-flags.md#--token),
[`--endpoint`](./common-flags.md#--endpoint),
[`--idempotency-key`](./common-flags.md#--idempotency-key), and
[`--help`](./common-flags.md#--help) use the shared definitions. Registration
requires a machine token; the shared reference records its local preflight.
The command registers a worker instance under the client identity of its machine JWT.
`--token` overrides `KANTHORD_TOKEN` and the `token` field of the client configuration file.
A missing token stops the command without a prompt or a request.
The worker runtime can call the route directly with its machine JWT.
The [registration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#worker-instance-registration) owns JWT verification, instance-count admission and replay.

| Request location         | Requiredness / type / default                                             | Validation                                                                                         |
| ------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Authorization` header   | Required bearer machine JWT; no default                                   | Gateway derives client identity, display name, worker binding and project; a human JWT is refused. |
| `Idempotency-Key` header | Required canonical bare ULID on the wire; generated by the CLI if omitted | Reuse the same key for a retry.                                                                    |
| `params`, `query`        | Empty objects                                                             | No nominated subject, kind, binding, worker, project or runtime identity.                          |
| `body`                   | Absent HTTP body; internal value `null`                                   | JSON `{}` is not an empty request body and is rejected. `--file` is not accepted.                  |

The operation is a mutation, declares a `10,000 ms` timeout and a `40 KiB` body
limit, and returns HTTP `200` with `{ "runtimeIdentity": "..." }`. The body limit
does not permit a registration payload. The runtime identity must be a nonblank
string of length `1..128` under the current output schema.

The CLI prints one JSON line with `runtimeIdentity` and `idempotencyKey`, saves no configuration and prints no token.
Success exits with zero; failure exits with a non-zero status. Registration creates no client identity,
worker definition or human account. The credential comes from local `jwt`
issuance described in [other commands](./other.md).

The implementation permits at most one live registration per client identity. A
new key while that registration remains live returns `409`. The same key under
the same client replays the original identity while that registration remains
live. A recorded replay whose registration has ended is rejected with `409`
`gateway.registration.stale`; it does not recreate or transfer the instance.
Cancellation does not deregister an accepted registration. There is no automatic
CLI retry. Declared failures print their HTTP status and key; indeterminate
results print the key and instruct explicit reuse of it.

**Current/target distinction:** the current
[Gateway idempotency component](../../src/gateway/idempotency.ts) stores completed
responses in memory and sweeps them by TTL every 60 s. The target architecture
requires process-local replay with a TTL. Do not infer the target storage or
restart behavior from this CLI specification. Runtime registrations themselves
are in memory; a stale stored answer grants no renewed registration.

**Target design:** registration must also check the binding's instance count in
the same transaction as acceptance. Binding removal/unavailability and server
restart end the registration. These rules need production integration beyond
the current default collaborators. The current authentication path refuses a
banned JWT or a binding that the Project resolver rejects; that refusal is not
evidence of a completed registration-cleanup implementation. The [Gateway signing
key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
removes the denylist from the target and revokes every JWT after an increment
of `gateway.tokenGeneration` and a restart.

Source checks: [CLI integration tests](../../src/apps/server/cli-worker.test.ts),
[registration integration tests](../../src/apps/server/gateway-registration.test.ts)
and [Worker tests](../../src/worker/service.test.ts). The binding/capacity tests
use injected collaborators and do not establish a production binding store.

## `heartbeat`

```text
kanthord worker [--endpoint <url>] heartbeat [--token <jwt>]
```

The proposed command calls `POST /api/worker/heartbeat`, operation `worker.heartbeat`, with `client` access and an empty body.
The operation requires a live registration and answers 204.
Every authenticated request of the registered client identity renews its heartbeat.
`worker.heartbeatWindow` defaults to 300 s; a sweep every 30 s ends expired registrations and frees their slots.
The [registration heartbeat](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#registration-heartbeat) rules expiry, renewed registration and execution loss.
The [Worker configuration](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration) rules the window default.

## `handover`

```text
kanthord worker [--endpoint <url>] handover [--token <jwt>]
```

The proposed command calls `POST /api/worker/handover`, operation `worker.handover`, with `client` access and an empty body.
The operation requires a live execution and returns an AES-256-GCM envelope.
The command prints only a status and never prints the envelope.
The [credential handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-credential-handover) rules the application call after a claim and before inference.
The [Project handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-credential-handover) rules the envelope and credential report.

## Catalog and agent inspection — proposed

### `list`

```text
kanthord worker list [--limit <count>] [--cursor <opaque>]
```

No positional arguments or filters. Required token: human JWT. Request:
`params: {}`, `query: { limit, cursor? }`, no body. `limit` and `cursor` use the
shared types, requiredness, defaults and validation. Proposed HTTP `200` returns
one page of worker summaries in descending primary-key order by exact name,
under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination). Each item contains
`name: WorkerName`, `host: "kanthord" | "external-harness"`,
`declaredNodeStates: string[]` and `requiredNodeFormat: string[]`.

**Target design:** the catalog describes supplied static templates. It is not a
runtime plugin store, and registration does not add entries. The declared workers
and their capabilities are:

| Worker       | Host                           | Method / agent      | Declared node states                         |
| ------------ | ------------------------------ | ------------------- | -------------------------------------------- |
| `general@1`  | kanthord                       | steps / `swe@1`     | `Available`                                  |
| `reviewer@1` | kanthord                       | evaluation / `re@1` | `Waiting`, `External.Requested`              |
| `claude@1`   | external harness `claude-code` | Harness-owned       | `Available`, `Waiting`, `External.Requested` |
| `opencode@1` | external harness `opencode`    | Harness-owned       | `Available`, `Waiting`, `External.Requested` |

The first native-runtime milestone supplies `general@1` and `reviewer@1`;
external-harness integration follows. These are target declarations, not claims
that the current engine has these templates. All four require goal, steps and
validation criteria; a verification command is optional. No worker named `tdd@1`
is promised by this specification.

### `get <worker-name>`

```text
kanthord worker get <worker-name>
```

`worker-name` is required `WorkerName`, with no default, mapped to
`params.workerName`; query is empty and body absent. Required token: human JWT.
Proposed HTTP `200` returns the summary fields plus:

- `harness: string` for an external worker, naming its hosting harness.
- `method: "steps" | "evaluation"` and `agentName: AgentName` for a native worker.
- `resourceBudget: { turns: integer, wallTimeMs: integer }` for a native worker,
  with positive values taken from its actual declared contract. No numerical
  budget is chosen here.

Absent/inapplicable native fields are omitted for externally hosted workers. The
result changes no registration, pool, project configuration or scheduling state.
An unknown exact worker name returns proposed `404`.

### `agent get <worker-name> <agent-name>`

```text
kanthord worker agent get <worker-name> <agent-name>
```

| Input         | Requiredness / type / default     | Mapping and validation                                |
| ------------- | --------------------------------- | ----------------------------------------------------- |
| `worker-name` | Required `WorkerName`; no default | `params.workerName`; exact native worker declaration. |
| `agent-name`  | Required `AgentName`; no default  | `params.agentName`; must be the agent of that worker. |

Required token: human JWT. Empty query, absent body. Proposed HTTP `200` returns
`workerName`, `agentName` and the following declaration/configuration fields:

| Result field           | Type and meaning                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultConfiguration` | Object with `provider: string`, `modelIdentifier: string`, `reasoningEffort: string` and `options: object`; actual worker-declared defaults, not values invented by this specification.                             |
| `configurationSchema`  | JSON Schema object describing every allowed field, its type, requiredness, default and validation. It must also describe constraints which the template checks as a whole.                                          |
| `overridableFields`    | Array of field paths allowed in a Project override; no wildcard permission to add fields.                                                                                                                           |
| `basePrompt`           | Optional string; the exact worker-declared shared prompt, omitted if absent.                                                                                                                                        |
| `agentPrompt`          | Required string; exact worker-declared role prompt.                                                                                                                                                                 |
| `tools`                | Array of permitted tool declarations; each item has `name: string`, `source` (one of `builtin`, `kanthord-mcp`) and `inputSchema: object`. Project-added tools are inspected through Project configuration instead. |

This is the inspection of the worker's **default** configuration and contract.
It is never the effective configuration of a bare agent name. Inspect a binding's
overrides, resolved provider account, model and revisions through
[Project](./project.md), where configuration is named through a worker binding.
A different provider account requires a compatible model selection; missing,
disabled or revoked selected accounts cannot silently fall back to another.

An external worker declares no native agent configuration or prompts; looking up
a native agent under it returns proposed `404`. Prompt/default changes require a
new worker version. This command neither composes the prompt of an execution nor
reads a local `AGENTS.md`/`CLAUDE.md`. The [Worker configuration](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration) declares `worker.globalPrompt`.
Each global prompt source and project prompt source holds at most 32768 UTF-8 bytes under the [Worker implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md).

## Instance inspection and lifecycle — proposed

**Target design:** an instance is runtime-only, hosts at most one execution and
has at most one outstanding work pull or execution. Server-placement pools are
created from Project bindings. Configuration revisions replace no instance;
count reductions retire idle server instances first and drain busy ones. External
harnesses host their own instances and have no kanthord placement. Starting a
remote application belongs to `serve worker` in [other commands](./other.md).

### `instance list`

```text
kanthord worker instance list [--project <project-id>] [--binding <binding-id>] [--limit <count>] [--cursor <opaque>]
```

| Input                                                                            | Requiredness / type / default                                                 | Mapping and validation                                                                                                   |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `--project <project-id>`                                                         | Optional `ProjectId`; omitted means all projects visible to the human         | `query.projectId`; retain and validate the declared prefix.                                                              |
| `--binding <binding-id>`                                                         | Optional `BindingId`; omitted means all worker bindings in the selected scope | `query.workerBindingId`; must identify a worker binding. If `--project` is also supplied, the binding must belong to it. |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Shared pagination flags                                                       | Shared query mapping.                                                                                                    |

Required token: human JWT. Empty params, absent body. Proposed HTTP `200` returns
one page of the instance records defined below in descending runtime-identity
order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
No ULID ordering is a lifecycle chronology. This is a live inventory, not a
persistent history; subsequent pages reflect pool changes.

### `instance get <runtime-identity>`

```text
kanthord worker instance get <runtime-identity>
```

Required `runtime-identity: RuntimeIdentity`, no default; maps to
`params.runtimeIdentity`. Required token: human JWT. Empty query, absent body.
Proposed HTTP `200` returns one instance record; unknown or ended instances return
proposed `404` rather than a historical execution record.

The proposed instance record contains:

| Field                                                           | Type and presence                                                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeIdentity`, `projectId`, `workerBindingId`, `workerName` | Required identities/natural key of the instance and its owning binding.                                                             |
| `host`                                                          | Required string, one of `kanthord`, `external-harness`.                                                                             |
| `placement`                                                     | String, one of `server`, `worker`, for kanthord-hosted instances; omitted for external harnesses.                                   |
| `clientId`, `name`                                              | Client identity using the declared `client_identity` prefix and display-name string, present for registered instances only. No JWT. |
| `activity`                                                      | Required string, one of `idle`, `pulling`, `executing`, describing known server activity, not proof that a remote process is alive. |
| `draining`                                                      | Required boolean; true when a server-hosted instance is scheduled to retire after its current execution.                            |
| `executionId`                                                   | Present only while executing, naming the Scheduler execution record.                                                                |
| `registered`                                                    | Required boolean; registration state, separate from execution lease state and physical process liveness.                            |

Both commands are read-only. Durable execution and trace attribution are queried
through Scheduler and Tracking. They do not infer a dead process from silence.

### `instance healthcheck <runtime-identity>`

```text
kanthord worker instance healthcheck <runtime-identity>
```

Required `runtime-identity: RuntimeIdentity`, no default; maps to
`params.runtimeIdentity`. Required token: human JWT. Empty query, absent body.
This proposed read evaluates the current Worker instance healthcheck and returns
HTTP `200` with `runtimeIdentity`, `passed: boolean`,
`checkedAt: integer` (Unix milliseconds in UTC), and `checks`, an array of
`{ name: "configuration" | "registration", passed: boolean, reason?: string }`.
The optional reason is a non-secret diagnostic code. No absent check is treated
as successful; inapplicable checks are omitted. Unknown instances return `404`.

The target checks depend on host/placement:

- `server`: the native agent's effective configuration resolves.
- `worker`: that configuration resolves and registration is live.
- External harness: registration is live; kanthord does not validate the
  harness's provider configuration.

The result grants no claim or resource access and proves neither idleness nor
physical liveness. It is not a provider network probe. The Scheduler repeats the healthcheck immediately before the claim commits, under [Claims and counts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.md#claims-and-counts).
Provider-account checks remain **blocked** under [HANDOFF Cannot progress](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#cannot-progress).

### `instance deregister <runtime-identity>`

```text
kanthord worker instance deregister <runtime-identity> [--idempotency-key <key>]
```

Required `runtime-identity: RuntimeIdentity`, no default, maps to
`params.runtimeIdentity`. Empty query and absent body. Required token: machine
JWT. The shared mutation key applies. Proposed HTTP `200` returns
`{ "runtimeIdentity": "...", "registered": false }`; the CLI adds its key.

This proposes a public self-deregistration operation for the design's program
deregistration event. The explicit runtime identity prevents a delayed retry from
ending a newer registration of the same client. The handler must verify that the
target belongs to the authenticated client, binding and project. It cannot end a
server-placement pool instance or another client's instance. Supplying an ID is
not proof of ownership.

The proposed `requiresRegistration: false` exception allows an accepted replay
after deregistration, while authentication still checks the credential and
binding. A first call requires a matching live registration. A missing target
without a replay answer returns proposed `404`; a different live registration
returns proposed `409` and remains intact. A retained same-key accepted answer
can replay only for the same caller and target. A revoked credential or unavailable
binding does not gain an authentication bypass for cleanup.

The effect is to end the registration, preventing later work pulls and execution
operations under it. Scheduler owns any live execution's liveness disposition.
Success does not prove the remote process stopped, release an execution, or
authorize reuse of its workspace. Dead-process cleanup, physical-stop enforcement
and failure recovery are not defined by this proposed command.

## MCP and repository actions — proposed CLI projection

The target server owns one MCP v2 server. Native agents use its permitted reads;
external harnesses authenticate with their machine JWT and present an execution
identity belonging to their own live claim. The approved initial platform reads
are GitHub pull-request retrieval and review-comment listing. The only exposed
write is the action-performer tool, available to external harnesses only. Native
reviewers invoke the action performer from their evaluation method.

The proposed REST projection remains **blocked** under [HANDOFF Worker Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-service).
It preserves the MCP tool allowlist, external-harness restriction and claim checks.

### `mcp tool list`

```text
kanthord worker mcp tool list --execution <execution-id> [--limit <count>] [--cursor <opaque>]
```

`--execution` is required `ExecutionId`, no default, mapped to
`query.executionId`. [`--limit`](./common-flags.md#--limit) and
[`--cursor`](./common-flags.md#--cursor) use the shared list contract.
No positional arguments; empty params, absent body. Required token: machine JWT
of a registered external-harness instance. Scheduler must establish that the
execution is the caller's live claim. A steps claim cannot make the action tool
eligible by naming another execution.

Proposed HTTP `200` returns a page of tools available to that execution in
descending primary-key order by name under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
Each item contains `name: ToolName`, `description: string`,
`inputSchema: object`, `outputSchema: object`, and `mutation: boolean`. Assessment-state filtering remains **blocked** under [HANDOFF Worker Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-service). Listing grants no authority; invocation repeats all admission checks.

### `mcp tool call <tool-name> --file <path>`

```text
kanthord worker mcp tool call <tool-name> --file <path> [--idempotency-key <key>]
```

| Input                                                      | Requiredness / type / default        | Mapping and validation                                                                             |
| ---------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `tool-name`                                                | Required `ToolName`; no default      | Selects exactly one concrete operation below; it is not a body field or arbitrary route parameter. |
| [`--file`](./common-flags.md#--file)                       | Required                             | Object becomes `body`; validate the selected tool's schema.                                        |
| [`--idempotency-key`](./common-flags.md#--idempotency-key) | Only for `repository-action-request` | Required mutation header for that tool. Rejected for read tools.                                   |

Required token: machine JWT of a registered external-harness instance. Empty
params and query. The file has these fields:

| JSON field    | Requiredness / type / default      | Validation                                                                                                                                        |
| ------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executionId` | Required `ExecutionId`; no default | Must belong to the caller's live registration and claim. Action requests additionally require an evaluation claim and current passing assessment. |
| `arguments`   | Required object; no default        | Exact selected tool schema below. The action tool requires the empty object.                                                                      |

The wire operation's mutation declaration cannot depend on unvalidated input.
The three tool calls therefore have separate proposed static operation
declarations at concrete paths:

| Tool / concrete path suffix after `/api/worker/mcp/tool/` | Operation ID                                                                   | Mutation | Access                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------- |
| `github-pull-request-get/call`                            | `worker.mcp.githubPullRequestGet` **[blocked][worker-contract]**               | `false`  | `client`, own live external-harness execution                                       |
| `github-pull-request-review-comment-list/call`            | `worker.mcp.githubPullRequestReviewCommentList` **[blocked][worker-contract]** | `false`  | `client`, own live external-harness execution                                       |
| `repository-action-request/call`                          | `worker.mcp.repositoryActionRequest` **[blocked][worker-contract]**            | `true`   | `client`, own live external-harness evaluation claim and current passing assessment |

All three use `POST` with the strict JSON body above. There is no fourth generic
invocation operation. The one CLI command dispatches to the selected declaration.

| Tool                                      | `arguments` fields and validation                                                                                                                                                                                      | Result / effect                                                                                                                                                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github-pull-request-get`                 | Required `pullRequestNumber: integer`, positive safe integer, no default; no other fields                                                                                                                              | Read the pull request through the permitted GitHub implementation. Derive the repository from the claim's pinned node repository binding; Project authorizes that resource operation before custody. |
| `github-pull-request-review-comment-list` | Required `pullRequestNumber: integer`, positive safe integer, no default; optional `limit: integer`, default `100`, range `1..1000`; optional `cursor: string`, nonempty opaque server cursor, absent means first page | One page of review comments through the same authorized binding. The CLI's file fields carry pagination here because it is a tool invocation, not a CLI list command.                                |
| `repository-action-request`               | Empty object `{}`; no action name, branch, address, commit, repository selector or policy override                                                                                                                     | Pass only the execution identity to the action performer. It derives every operand from the attempt records and evidence snapshot, and requests eligible configured actions.                         |

Proposed read-tool success returns HTTP `200` and
`{ "toolName": "...", "result": ... }`. Pull-request results use the GitHub
method's published result schema; comment results use `items` and `nextCursor`
with the method's published comment schema. These method schemas must be pinned
and included in tool discovery before the tools ship; this document defines no
invented common platform result schema.

Proposed action success returns HTTP `200` with `toolName` and `items`. The
proposed item discriminant is `kind`, with exactly four values:

- `submitted`: `externalObject` is the accepted Mission external-object record.
- `awaiting-prerequisite`: `action` identifies the configured action and
  `observation` identifies the observation it follows; this alone is a wait fact.
- `failed-before-effect`: `action` and `refusal` report a confirmed request failure
  before effect.
- `uncertain`: `action` and `uncertainty: "effect" | "recording" | "both"` retain
  what is unknown.

The action/observation/external-object shapes are owned by their domain contracts
and remain schema dependencies, not arbitrary caller-supplied JSON. There is no
default classification. An accepted tool result containing failure or uncertainty
does not mean repository success; the CLI prints those classes intact. A request
whose own transport outcome is unknown is reported as indeterminate instead.

The action performer serializes invocations by execution identity and never
redispatches an unresolved action. It may reuse an earlier attempt's open remote
object only when the configured action, repository binding and current operands
match; it then performs the necessary network git write without a duplicate
platform write. It owns any independent checkout needed for that operation.

The tool call does not release the execution. The target permits a reviewer
release after a result containing only submitted objects and prerequisite waits;
Scheduler records the corresponding wait fact. Failure release and recovery remain **blocked** under [HANDOFF B9](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#b9-failure-and-recovery).

### MCP transport requirements outside the CLI inventory

The MCP endpoint and declarations remain **blocked** under [HANDOFF Worker Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-service).
Target transport is MCP v2 Streamable HTTP mounted on the Gateway listener:
one endpoint accepts `POST`, `GET` and `DELETE`; each JSON-RPC client message uses
a new `POST`. Responses are JSON or a continuing event stream. Initialization
assigns `Mcp-Session-Id`, later requests carry it, and `Last-Event-ID` resumes a
stream. Disconnect is not cancellation; an explicit `CancelledNotification`
cancels. Worker owns the session and Gateway owns the connection. There is no
WebSocket or deprecated HTTP+SSE transport requirement.

This protocol/session lifecycle is not a set of extra CLI commands. Nor are
model/repository/platform connectors, webhook decoding, prompt composition,
lease/agent loops, workspace cleanup or collaboration functions. The proposed
tool projection exposes no direct platform write and no raw git push, merge,
credential export or caller-selected remote destination.

## Design provenance

Optional design provenance:
[Worker design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.md),
[Worker vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.vocabulary.md),
[Worker implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md),
[architecture rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
