# Worker CLI specification

This is the future specification for `kanthord worker`. It contains **18 command leaves: 1 implemented command and 17 proposed commands**. The proposed command
names, routes, operation IDs, access policies, JSON fields and defaults below are
design proposals, not published API or working CLI commands. The behavioral
requirements identified as **target design** come from the Worker design; their
presence here does not establish implementation.

See the [CLI index](./README.md) for shared conventions and
[other commands](./other.md) for `serve worker`, server configuration and local
`jwt` issuance. Worker binding edits, instance counts, availability, agent
entries and effective configuration inspection belong to [Project](./project.md).
The Worker Service owns agent enablement and effective configuration resolution.
[Credential](./credential.md) covers credential management.
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

| Common flag                                                                      | Applies to / Worker requirement                                                                |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every command; inherited from the `worker` group.                                              |
| [`--token`](./common-flags.md#--token)                                           | Every operation requires a nonblank resolved token matching its human or client policy.        |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Mutations only; implemented registration retains the `<ulid>` help spelling.                   |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Each list command.                                                                             |
| [`--file`](./common-flags.md#--file)                                             | Required for `agent enablement put` and `agent enablement provider add`; schemas appear below. |
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                          |

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

| Value                      | Type and validation                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerName`               | Nonempty exact versioned catalog key, such as `general@1`. Required version; no implicit latest version or alias. Unknown names fail lookup. This is a natural key, not a ULID.                                                                                                                             |
| `AgentName`                | Nonempty exact role/version key in the agent catalog, such as `swe@1`; never a worker name. Unknown names fail lookup.                                                                                                                                                                                      |
| `ProjectId`                | Opaque `project_<ulid>` identity using the declared project prefix.                                                                                                                                                                                                                                         |
| `RuntimeIdentity`          | Opaque server-returned runtime identity. Current generation uses `runtime_identity_<ulid>`, but the current wire schema accepts a nonblank string of length `1..128`; it does not enforce that prefix. Proposed consumers retain the returned value exactly.                                                |
| `BindingId`, `ExecutionId` | `BindingId` uses `binding_<ulid>`. `ExecutionId` uses `execution_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service), validated with `identitySchema("execution")` of the kernel. |

An entity identity follows `<declared-prefix>_<ulid>`, where the ULID is canonical
uppercase and matches `[0-7][0-9A-HJKMNP-TV-Z]{25}`. Validate the expected entity
kind, not just the suffix. A bare ULID is valid for an idempotency key only.
Worker/agent names and MCP session IDs retain their natural-key/protocol forms.
The target runtime identity is `worker_instance_<ulid>` under the [Worker identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-identities-of-the-worker-service).

## Command inventory

`P` means proposed; `I` means implemented syntax and operation.
Heartbeat, handover, deregistration, the five inspection reads and provider check use their ruled routes. Other `P` paths remain proposals, not current OpenAPI declarations.
`human` authenticates a human JWT. `client` authenticates a machine JWT.
Live registration and execution requirements appear per operation; registration
and deregistration require no live registration.

| Status | Command after `kanthord worker`          | Route                                          | Operation ID                 | Access / registration                                                             |
| ------ | ---------------------------------------- | ---------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| I      | `register`                               | `POST /api/worker/register`                    | `worker.register`            | `client`; no live registration required                                           |
| P      | `heartbeat [--token <jwt>]`              | `POST /api/worker/heartbeat`                   | `worker.heartbeat`           | `client`; live registration                                                       |
| P      | `handover [--token <jwt>]`               | `POST /api/worker/handover`                    | `worker.handover`            | `client`; live registration and live execution                                    |
| P      | `list`                                   | `GET /api/worker/catalog`                      | `worker.catalog.list`        | `human`                                                                           |
| P      | `get <worker-name>`                      | `GET /api/worker/catalog/:workerName`          | `worker.catalog.get`         | `human`                                                                           |
| P      | `agent get <agent-name>`                 | `GET /api/worker/agent/:agentName`             | `worker.agent.get`           | `human`                                                                           |
| P      | `instance list`                          | `GET /api/worker/instance`                     | `worker.instance.list`       | `human`                                                                           |
| P      | `instance get <runtime-identity>`        | `GET /api/worker/instance/:runtimeIdentity`    | `worker.instance.get`        | `human`                                                                           |
| P      | `instance deregister <runtime-identity>` | `DELETE /api/worker/instance/:runtimeIdentity` | `worker.instance.deregister` | `client`; no live registration required; ownership by client, binding and project |

The inventory includes these nine **proposed** commands. `[R]`, `[M]` and
`[L]` use the [common synopsis definitions](./common-flags.md#synopsis-markers).

| Status | Command after `kanthord worker`                                                                        | Route                                                                   | Operation ID                              | Access / registration |
| ------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------- | --------------------- |
| P      | `agent enablement list [L] [R]`                                                                        | `GET /api/worker/agent/enablement`                                      | `worker.agent.enablement.list`            | `human`; proposed     |
| P      | `agent enablement get <agent-name> [R]`                                                                | `GET /api/worker/agent/enablement/:agentName`                           | `worker.agent.enablement.get`             | `human`; proposed     |
| P      | `agent enablement put <agent-name> --file <path> [M] [R]`                                              | `PUT /api/worker/agent/enablement/:agentName`                           | `worker.agent.enablement.put`             | `human`; proposed     |
| P      | `agent enablement enable <agent-name> --expected-revision <revision> [M] [R]`                          | `POST /api/worker/agent/enablement/:agentName/enable`                   | `worker.agent.enablement.enable`          | `human`; proposed     |
| P      | `agent enablement disable <agent-name> --expected-revision <revision> [M] [R]`                         | `POST /api/worker/agent/enablement/:agentName/disable`                  | `worker.agent.enablement.disable`         | `human`; proposed     |
| P      | `agent enablement remove <agent-name> --expected-revision <revision> [M] [R]`                          | `DELETE /api/worker/agent/enablement/:agentName`                        | `worker.agent.enablement.remove`          | `human`; proposed     |
| P      | `agent enablement provider add <agent-name> --file <path> [M] [R]`                                     | `POST /api/worker/agent/enablement/:agentName/provider`                 | `worker.agent.enablement.provider.add`    | `human`; proposed     |
| P      | `agent enablement provider remove <agent-name> <provider-name> --expected-revision <revision> [M] [R]` | `DELETE /api/worker/agent/enablement/:agentName/provider/:providerName` | `worker.agent.enablement.provider.remove` | `human`; proposed     |
| P      | `provider check --credential <credential-name> [R]`                                                    | `POST /api/worker/provider/check`                                       | `worker.provider.check`                   | `human`; proposed     |

The static `/api/worker/agent/enablement` path takes precedence over `/:agentName`.

`credential` runs inside the `worker` application alone and is no CLI command.
Its operation is `worker.credential` at `POST /api/worker/credential`, with `client` access and a live execution requirement.

The five human reads follow [inspection operations](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#inspection-operations).
Each is `unary`, has `mutation: false` and a default timeout of 30 s, and reads
no table of another service. Every authenticated human has the
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
binding that the Project resolver rejects; that refusal is not
evidence of a completed registration-cleanup implementation. The [Gateway signing
key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
revokes every JWT after an increment
of `gateway.tokenVersion` and a restart.

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
The [Custody handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-credential-handover) rules the envelope and credential report.

## Catalog and agent inspection — proposed

### `list`

```text
kanthord worker list [--limit <count>] [--cursor <opaque>]
```

No positional arguments or filters. Required token: human JWT. Request:
`params: {}`, `query: { limit, cursor? }`, no body. `limit` and `cursor` use the
shared types, requiredness, defaults and validation. Proposed HTTP `200` returns
one page of worker summaries in ascending alphabetical order by exact name,
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
that the current engine has these templates. All four require a name, a requirement, a criterion, verifications and bindings. No worker named `tdd@1`
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
- `resourceBudget: { turns: integer, wallTimeMs: integer }` for a native worker.
  `general@1` and `reviewer@1` declare `{ turns: 200, wallTimeMs: 7200000 }`.
  Both fields are positive safe integers. A native worker binding can override
  the default. [Stop and budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#stop-and-budget)
  defines a turn as one `turn_end` event and wall time from claim response to release.
  `claude@1` and `opencode@1` declare no resource budget.

Absent/inapplicable native fields are omitted for externally hosted workers. The
result changes no registration, pool, project configuration or scheduling state.
An unknown exact worker name returns `404 worker.catalog.not_found`.

### `agent get <agent-name>`

```text
kanthord worker agent get <agent-name>
```

`agent-name` is required `AgentName`, with no default, and maps to
`params.agentName`. The key names one catalog declaration, not a worker binding.
Required token: human JWT. Empty query, absent body. HTTP `200` returns
`agentName` and the following declaration/configuration fields:

| Result field          | Type and meaning                                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `configurationSchema` | JSON Schema draft 2020-12 object describing the effective configuration: every allowed field, its type, requiredness and enumeration. Its `description` states the whole-configuration constraint that the Worker Service checks; JSON Schema validates no cross-field lookup. |
| `overridableFields`   | Array of field paths allowed in a Project override; no wildcard permission to add fields. For `swe@1` and `re@1` it is `["agentProvider", "modelIdentifier", "reasoningEffort"]`.                                                                                              |
| `enablement`          | The [agent enablement record](#agent-enablement-record--proposed), or `null` when no record exists.                                                                                                                                                                            |
| `basePrompt`          | Optional string; the exact worker-declared shared prompt, omitted if absent.                                                                                                                                                                                                   |
| `agentPrompt`         | Required string; exact worker-declared role prompt.                                                                                                                                                                                                                            |
| `tools`               | Array of permitted tool declarations; each item has `name: string`, `source` (one of `builtin`, `kanthord-mcp`) and `inputSchema: object`. Project-added tools are inspected through Project configuration instead.                                                            |

The [configuration schema](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration-schema)
is emitted by `z.toJSONSchema` of `zod` at 4.4.3 from the effective-configuration
schema. Its root is an object with `additionalProperties: false` and five required properties:

| Property          | Schema                                                            |
| ----------------- | ----------------------------------------------------------------- |
| `agentProvider`   | `string`; name of an agent provider in the enablement             |
| `provider`        | `string`, enum `github-copilot`, `anthropic`, `openai-compatible` |
| `credential`      | `string`; a credential name                                       |
| `modelIdentifier` | `string`                                                          |
| `reasoningEffort` | enum `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`    |

No property carries a `default`; the schema holds no `options`.
Its `description` requires model membership in `getBuiltinModels(provider)` of
pi-ai 0.86.0 or the `models` metadata of the `openai-compatible` credential.
It also requires effort membership in that model's supported reasoning levels.
JSON Schema validates neither lookup. The Worker Service enforces them at the
enablement write, at the worker binding write through `validateEntry`, and at
resolution. The instance healthcheck reports whether the effective configuration resolves.

This command inspects a catalog declaration and its global enablement, not the
effective configuration of a bare agent name. Inspect binding entries, effective
configuration and revisions through [Project](./project.md). Project asks the
Worker Service for that configuration. An absent or disabled enablement refuses
use, including a complete entry; no fallback selects another credential.

An external worker declares no agent and needs no enablement. An unknown agent
name returns `404 worker.agent.not_found`. Catalog prompt changes require a
new worker version. An enablement default change creates a revision.
This command neither composes the prompt of an execution nor
reads a local `AGENTS.md`/`CLAUDE.md`. The [Worker configuration](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration) declares `worker.globalPrompt`.
Each global prompt source and project prompt source holds at most 32768 UTF-8 bytes under the [Worker implementation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md).

## Agent enablement record — proposed

The [agent configuration rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.md#agent-configuration)
own these records. The following wire fields and command spellings are proposed.
An enablement is global to the server, belongs to no project and is keyed by
`agentName: AgentName`. It holds:

| Field                  | Type and meaning                                                                                                                                                                                                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `agentName`            | Exact catalog key; no separate enablement identity.                                                                                                                                                                                                                                                          |
| `state`                | `enabled` or `disabled`. An absent record also denies use.                                                                                                                                                                                                                                                   |
| `agentProviders`       | Nonempty array of `{ name, provider, credential }`. Each name is nonblank and unique inside this enablement. `provider` is `github-copilot`, `anthropic` or `openai-compatible`. `credential` is a credential name in custody; its platform must equal the provider. No model list or secret is stored here. |
| `defaultConfiguration` | Required `{ agentProvider, modelIdentifier, reasoningEffort }`. The human supplies all three; no catalog default applies. The name selects an agent provider of this enablement.                                                                                                                             |
| `revision`             | Positive safe integer; every change creates a revision.                                                                                                                                                                                                                                                      |

`modelIdentifier` is a nonblank string. The reasoning-effort enum is the one in
`configurationSchema`. All request objects are closed. An agent provider's
`provider` is fixed; another provider needs another agent provider. A change of
its `credential` through `put` creates a revision.

The Worker Service validates the allowlist before merge and the whole effective
configuration after it, under [configuration validation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#agent-configuration-validation).
It checks the provider catalog or credential metadata and the established
reasoning levels. An empty metadata model list permits no model selection.
It reads metadata through custody, never a secret, and makes no write-time
remote call. An entry holds no `options`.

A configuration change checks every dependent worker binding, including those
without an explicit entry. `entriesOfAgent(tx, agentName)` and
`validateEntry(tx, workerName, entry)` keep that check and the write in one
transaction under the [collaboration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-operation-and-its-two-entry-adapters).
A change that invalidates a dependent binding fails and lists those bindings.
A tuning entry follows unchanged default fields at its next resolution.

All commands below use `human` access. Required names have no default.
`<agent-name>` maps to `params.agentName`; `<provider-name>` maps to
`params.providerName`. Mutations use the shared replay key and print it.
Proposed reads and writes are unary. Unless stated otherwise, query is empty,
body is absent and success answers HTTP `200` with the enablement record.

### `agent enablement list`

Uses `[L] [R]`, no positional arguments and no filters. Query holds `limit` and
optional `cursor`. Returns `{ items, nextCursor }`, paged by agent name in
ascending alphabetical order. It lists records, not catalog agents without an enablement.

### `agent enablement get <agent-name>`

Uses `[R]`. Returns one enablement. An absent record answers the proposed
`404 worker.agent.enablement.not_found`; `agent get` instead returns a null
`enablement` for a catalog agent without a record.

### `agent enablement put <agent-name> --file <path>`

Uses `[M] [R]`. The required file supplies exactly
`{ expectedRevision, agentProviders, defaultConfiguration }`. `agentProviders`
and `defaultConfiguration` are required with no default. `expectedRevision` is
the latest revision of the agent that the human read, and it is absent only when
the agent holds no row. It creates or replaces the complete configuration. Proposed creation
sets `state: enabled`; replacement preserves the record's state. The explicit
`enable` and `disable` commands change that state. Omitted agent providers are
removals and must pass the dependency check. A retained name cannot change its
provider. A credential change is a revision. The answer is the saved record.

### `agent enablement enable <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Sets an existing record to `enabled` after configuration
validation. It creates no missing record and selects no default value for the
human. It returns the enabled record.

### `agent enablement disable <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Sets an existing record to `disabled` and returns it.
Disablement is the only stop switch; it is allowed with dependent bindings.
It refuses every later resolution, including a complete entry, so the instance
healthcheck fails and no claim follows. Bindings remain. It recalls no handover
in flight. An agent provider has no independent disablement.

### `agent enablement remove <agent-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Removal fails while any worker binding of a worker that references
this agent exists. The refusal lists those bindings. The dependency check and
removal commit in one transaction. Proposed success is
`{ agentName, removed: true }`, not an enablement record.

### `agent enablement provider add <agent-name> --file <path>`

Uses `[M] [R]`. The required file supplies exactly `{ expectedRevision, name, provider, credential }`,
with all fields required. It adds a named agent provider to an existing record
and returns the revised enablement. A duplicate name fails. Use `put` to revise
a credential reference or default configuration.

### `agent enablement provider remove <agent-name> <provider-name> --expected-revision <revision>`

The required `--expected-revision` names the latest revision of the agent that the human read.
Uses `[M] [R]`. Removes one named agent provider and returns the revised record.
Removal fails while a default configuration or binding entry names it, and the
refusal lists those dependents. The check and removal are atomic. An enablement
must still hold at least one agent provider.

### Agent enablement refusals — proposed

These code spellings and HTTP mappings are proposed; the linked design owns the
refusals. `error.details` names the agent and lists affected bindings or other
dependents when applicable. No error holds secret material.

| HTTP | Proposed code                                             | Condition                                                                                   |
| ---- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 404  | `worker.agent.enablement.not_found`                       | No enablement exists.                                                                       |
| 409  | `worker.agent.enablement.revision_conflict`               | A write names a stale or absent expected revision; details hold the current revision.       |
| 400  | `worker.agent.enablement.unavailable`                     | An agent has no enabled enablement at binding write or resolution; details name that agent. |
| 409  | `worker.agent.enablement.invalidates_bindings`            | A configuration change invalidates dependent worker bindings; details list them.            |
| 409  | `worker.agent.enablement.in_use`                          | Enablement removal has dependent worker bindings; details list them.                        |
| 409  | `worker.agent.enablement.provider.name_conflict`          | Agent provider name already exists.                                                         |
| 404  | `worker.agent.enablement.provider.not_found`              | A selected agent provider is absent.                                                        |
| 409  | `worker.agent.enablement.provider.fixed`                  | A retained agent provider changes its provider.                                             |
| 409  | `worker.agent.enablement.provider.in_use`                 | Removal has dependent defaults or entries; details list them.                               |
| 400  | `worker.agent.enablement.provider.required`               | A write leaves no agent provider.                                                           |
| 400  | `worker.agent.configuration.override_not_allowed`         | Entry has a field outside the allowlist, including nonempty `options`.                      |
| 400  | `worker.agent.configuration.invalid`                      | Configuration shape or entry form is invalid.                                               |
| 400  | `worker.agent.configuration.model_unknown`                | Model is absent from the selected catalog or metadata.                                      |
| 400  | `worker.agent.configuration.reasoning_effort_unsupported` | No source establishes the requested reasoning level for the selected model.                 |
| 400  | `worker.agent.configuration.credential_unsuitable`        | Custody refuses the credential/platform pair.                                               |

Unknown catalog agents use `404 worker.agent.not_found`.

## `provider check` — proposed

```text
kanthord worker provider check --credential <credential-name> [R]
```

The [provider check contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-provider-check)
declares `worker.provider.check`, a server-wide read under `human` access, at
`POST /api/worker/provider/check`. It has no project or binding.
`--credential` is required, with no default, and uses the credential name form
in [Credential](./credential.md#names-and-identities). The body is exactly
`{ credential }`; params and query are empty. No raw key or base URL reaches
this operation. It accepts only an `openai-compatible` credential and reads
`baseUrl` through custody. Custody attaches auth inside `use` and caches nothing.
The call `GET <baseUrl>/models` has a 10 s deadline. No mutation key is accepted.

HTTP `200` answers `connection`:

- `ok`: the remote answers the OpenAI list shape.
- `unauthorized`: the remote answers 401 or 403.
- `unreachable`: a network failure or deadline prevents the answer.
- `invalid_response`: the answer lacks the OpenAI list shape.

Only `ok` holds `models`, an array of `{ id, ownedBy, created }`.
The answer supplies model ids, not approved limits or reasoning levels, and no
key. The human saves approved models through a credential metadata revision.
HTTP 400 answers invalid input or an unsuitable credential; HTTP 404 answers an
unknown credential. Proposed codes are `worker.provider.invalid_input`,
`worker.provider.credential_unsuitable` and `worker.provider.credential_not_found`.

Each agent provider also has a report-only [resource healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#agent-provider-healthcheck).
The health report groups probes by provider endpoint and credential and attributes
each result. `GET /models` proves model-list access only. This check belongs to
neither the liveness answer nor the claim path and changes no instance healthcheck.
No check refreshes OAuth; an expired access token reports `unknown`.

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
A binding outside the supplied project answers HTTP `400`.

### `instance get <runtime-identity>`

```text
kanthord worker instance get <runtime-identity>
```

Required `runtime-identity: RuntimeIdentity`, no default; maps to
`params.runtimeIdentity`. Required token: human JWT. Empty query, absent body.
Proposed HTTP `200` returns one instance record; unknown or ended instances return
`404 worker.instance.not_found` rather than a historical execution record.

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

### `instance deregister <runtime-identity>`

```text
kanthord worker instance deregister <runtime-identity> [--idempotency-key <key>]
```

Required `runtime-identity: RuntimeIdentity`, no default, maps to
`params.runtimeIdentity`. Empty query and absent body. Required token: machine
JWT. The shared mutation key applies. HTTP `200` returns
`{ "runtimeIdentity": "...", "registered": false }`; the CLI adds its key.

The [deregistration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#deregistration)
declares `worker.instance.deregister` as a `client` mutation at
`DELETE /api/worker/instance/:runtimeIdentity`, with `unary` lifetime,
the default 30 s timeout and the default 10 MiB body limit. The explicit runtime
identity prevents a delayed retry from ending a newer registration of the same
client. The handler ends only the live registration whose runtime identity
matches the path and whose client identity, binding and project match the caller.
It frees the slot through the Project instance-count collaboration in the same
transaction. Supplying an ID is not proof of ownership.

This is no execution operation, so it requires no live registration.
Authentication still checks the credential and binding. A retry with the same
`Idempotency-Key`, caller and target replays the recorded answer after the end,
within the TTL and one process. The operation declares no replay guard.
Every target that is no live registration of the caller answers `404`
`worker.instance.not_found`, including an ended registration, another client's
instance, a server-placement instance and a newer registration of the same
client identity, which stays intact. A retry after a restart answers `404`, and
the caller reads it after its own call as the end of its registration. A revoked
credential or unavailable binding gains no authentication bypass for cleanup.

The effect is to end the registration, preventing later work pulls and execution
operations under it. Scheduler owns any live execution's liveness disposition.
Success does not prove the remote process stopped, release an execution, or
authorize reuse of its workspace. Dead-process cleanup, physical-stop enforcement
and capacity reuse stay with B9 SC5 and W5. The same client identity registers
again with a fresh idempotency key after expiry or deregistration.

## MCP and repository actions

The target server owns one MCP v2 server. Every client, native agent or external
harness, receives the same static tools: `github-pull-request-get`,
`github-pull-request-review-comment-list` and `repository-action-request`.
No client kind, claim kind or assessment state changes the list. `tools/list`
needs the live registration, or the hosted execution for a native agent at the
`server` placement, and no execution identity argument. It reads no Mission record.
The action performer is the only exposed write. The evaluation method of
`reviewer@1` also invokes it, with the same checks and serialized calls of one
execution identity, and the performer never dispatches an action twice.

This revision projects no tool to a REST route and gives the CLI no command
that calls a tool. Tools are reached through the MCP server.

### Action performer results

The action tool returns the MCP tool result, not CLI output:

`{ toolName: "repository-action-request", items: ActionResultItem[] }`.
`ActionResultItem` is discriminated on `kind`, with one value per return class:

- `submitted` holds `externalObject`, the `ExternalObject` record that the Mission Service accepted, in the schema that `mission.externalObject.get` answers.
- `awaiting-prerequisite` holds `action: { key, bindingId }`, the waiting action, and `prerequisite: { key, externalObjectId }`, the requested action it follows and its external object.
- `failed-before-effect` holds `action: { key, bindingId }` and `refusal: { class, code, message }`, where `class` is `confirmed_failure`, `retryable_refusal` or `final_refusal`. A final refusal declines the request before any write. `code` and `message` come from the connector that transported the request: the platform implementation for a platform action, the repository connector for a network git write.
- `uncertain` holds `action: { key, bindingId }`, `uncertainty: "effect" | "recording" | "both"` and an optional `address`, present when the remote returned the address and the Mission submission stayed uncertain. An `unknown_outcome` result class produces `effect`.

The external-object shape is the Mission record; the [action performer ruling of `worker-service.impl.md`](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#action-performer) declares the item shapes.
`key` is the `FrozenAction.key` of the attempt, and `bindingId` is the repository binding of the action.
The first version produces no `awaiting-prerequisite` item, because a repository strategy holds at most one action and its `follows` is null.
The answer holds no release instruction, because [B9 items A3, W1, W4 and PR2](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-and-project-services) own what follows a failure or an uncertainty.
There is no default classification. An accepted tool result containing failure or uncertainty
does not mean repository success. A request whose own transport outcome is
unknown is indeterminate instead.

The action performer serializes invocations by execution identity and never
redispatches an unresolved action. It may reuse an earlier attempt's open remote
object only when the configured action, repository binding and current operands
match; it then performs the necessary network git write without a duplicate
platform write. It owns any independent checkout needed for that operation.

The tool call does not release the execution. The target permits a reviewer
release after a result containing only submitted objects and prerequisite waits.
Failure release and recovery remain **blocked** under [HANDOFF B9](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#b9-failure-and-recovery).

### MCP endpoint outside the CLI inventory

The [MCP server contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#mcp-server)
declares three `client` operations at `/api/worker/mcp`. Each requires a live
registration, uses the operational store, a 10 MiB body limit and a 900 s timeout,
and declares `mutation: false` under the [Gateway exemption](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#idempotency-of-a-mutation).
An MCP client carries no `Idempotency-Key`.

| Operation            | Method   | Lifetime | Body and answer                                                                    |
| -------------------- | -------- | -------- | ---------------------------------------------------------------------------------- |
| `worker.mcp.message` | `POST`   | `stream` | One MCP JSON-RPC message; JSON or an open `text/event-stream` response             |
| `worker.mcp.listen`  | `GET`    | `stream` | No body; server-to-client event stream, resumed with `Last-Event-ID` after timeout |
| `worker.mcp.close`   | `DELETE` | `unary`  | No body; ends the named session and answers 204                                    |

The Gateway checks the JWT and live registration before session lookup.
`Mcp-Session-Id` has the form `mcp_session_<ulid>` and binds to the initializing
client identity and registration. After admission, a foreign, ended or absent
session answers 404; the client initializes again. A new registration cannot
reuse a session of its earlier registration. DELETE, registration end and server
stop end the session. A session identity alone authorizes nothing.
Every authenticated MCP request renews the registration heartbeat.

Before each `tools/call`, the MCP server runs the invocation chain's execution
proof component with the required `executionId` argument. A failed proof returns
a JSON-RPC error whose `data` holds the shared error envelope with
`gateway.invocation.execution_proof_failed`. The tool receives the proven node,
attempt and pinned revision, never caller-supplied values for them. A tool refusal
returns `isError: true`. The action tool refuses a steps claim with
`worker.action_performer.claim_not_evaluation` and an evaluation claim without a
current passing assessment with `worker.action_performer.assessment_not_current`.

A native agent at the `server` placement reaches MCP in-process under its hosted
execution; its proof skips the registration comparison. Native agents at the
`worker` placement and external harnesses use HTTP and their machine JWT.
A tool runs under a session context; disconnect ends the response stream only.
The Gateway cancels session contexts in shutdown phase 1. The action performer
owns write idempotency; a restart before its dispatch record stays B9 W2.
MCP bodies follow the MCP specification; tool schemas live in `tools/list`.

Target transport is MCP v2 Streamable HTTP mounted on the Gateway listener:
one endpoint accepts `POST`, `GET` and `DELETE`; each JSON-RPC client message uses
a new `POST`. Responses are JSON or a continuing event stream. Initialization
assigns `Mcp-Session-Id`, later requests carry it, and `Last-Event-ID` resumes a
stream. Disconnect is not cancellation; an explicit `CancelledNotification`
cancels. Worker owns the session and Gateway owns the connection. There is no
WebSocket or deprecated HTTP+SSE transport requirement.

This protocol/session lifecycle is not a set of extra CLI commands. Nor are
model/repository/platform connectors, webhook decoding, prompt composition,
lease/agent loops, workspace cleanup or collaboration functions. The MCP server
exposes no direct platform write and no raw git push, merge, credential export
or caller-selected remote destination.

## Design provenance

Optional design provenance:
[Worker design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.md),
[Worker vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.vocabulary.md),
[Worker implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md),
[architecture rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
