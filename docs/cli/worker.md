# Worker CLI specification

This specification for `kanthord worker` contains **9 command leaves, all implemented**.
Requirements marked
**target design** describe later runtime behavior and do not establish implementation.

See the [CLI index](./README.md) for shared conventions and
[other commands](./other.md) for `serve worker`, server configuration and local
`jwt generate` issuance. Worker binding edits, instance counts, availability, agent
entries and effective configuration inspection belong to [Project](./project.md).
The [Agent](./agent.md) document covers the agent catalog, agent enablement and effective configuration resolution.
[LLM](./llm.md) covers credential management of LLM platforms.
Work pull, claims, execution records and release belong to
[Scheduler](./scheduler.md).

## Current implementation boundary

The [CLI implementation](../../src/apps/cli/worker.ts) and
[Worker operation contract](../../src/worker/contract.ts) provide registration,
heartbeat, handover, catalog reads, and registration-backed instance inspection and lifecycle. The
[registration implementation](../../src/worker/registrations.ts) uses durable
`worker_instance` rows, one live registration per client identity, and atomic
binding instance-count admission. Deregistration is both an internal
collaboration and an owned client operation.

The [server composition](../../src/apps/server/index.ts) wires the real
[Project binding resolver](../../src/project/service.ts), including group
tombstones and transactional registration endings when a binding becomes
unavailable. Scheduler running-execution and activity collaborators use the
implemented Scheduler Service. Custody handover and refresh-report operations
are implemented and wired to Project authorization and Scheduler execution pins.
The `handover` CLI leaf is implemented with its published validation code.

The [Worker configuration fragment](../../src/worker/config.ts) declares
`heartbeat_window`. The catalog, report-only instance
healthcheck collaboration and registration heartbeat lifecycle are implemented.
Native agent loops, server-placement pools, prompt consumption, repository
actions and MCP remain later runtime work. The service probe reports
registration-component availability separately from instance healthchecks.

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
| [`--help`](./common-flags.md#--help)                                             | Every group and leaf.                                                                   |

The [shared client-file rules](./other.md#cliyaml-and-its-effects) apply.
Commands do not save or rewrite that file.

Request objects are strict: undeclared fields are
rejected. An omitted optional field takes only its documented default; `null`
does not mean omission. No read accepts an idempotency key. Unless a section says
otherwise, the command has no positional arguments or options beyond its listed
ones and the applicable shared options; its request body is absent, represented
as `body: null` in the service-client envelope.

Successful unary commands print one JSON line and exit `0`. List results
are `{ "items": [...], "next_cursor": null | string }`. Mutations also
print the used `idempotency_key`. Failures print a diagnostic and exit nonzero;
they do not print tokens. An indeterminate mutation reports its key and does not
assert that the operation had no effect. Repeating the same logical request uses
the same caller, inputs and key; starting another CLI invocation without that key
creates a new invocation. There is no automatic mutation retry.

Invocation replay is limited to one process and the configured
TTL; domain handlers still need natural-key idempotency. Durable registration
rows are separate from replay records. Replay is not failure recovery,
and an idempotency key alone cannot reconcile an uncertain repository write.

### Names and identities

| Value                      | Type and validation                                                                                                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkerName`               | Nonempty exact versioned catalog key, such as `general@1`. Required version; no implicit latest version or alias. Unknown names fail lookup. This is a natural key, not a ULID.                                                                                                                             |
| `AgentName`                | Nonempty exact role/version key in the agent catalog, such as `swe@1`; never a worker name. Unknown names fail lookup.                                                                                                                                                                                      |
| `ProjectId`                | Opaque `project_<ulid>` identity using the declared project prefix.                                                                                                                                                                                                                                         |
| `RuntimeIdentity`          | `worker_instance_<ulid>` under the [Worker identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-identities-of-the-worker-service), validated with `identitySchema("worker_instance")` of the kernel. Consumers retain the returned value exactly.  |
| `BindingId`, `ExecutionId` | `BindingId` uses `binding_<ulid>`. `ExecutionId` uses `execution_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service), validated with `identitySchema("execution")` of the kernel. |

An entity identity follows `<declared-prefix>_<ulid>`, where the ULID is canonical
uppercase and matches `[0-7][0-9A-HJKMNP-TV-Z]{25}`. Validate the expected entity
kind, not just the suffix. A bare ULID is valid for an idempotency key only.
Worker and agent names and MCP session IDs retain their natural-key/protocol forms.

## Command inventory

`P` means proposed; `I` means implemented syntax and operation.
`P` routes describe the ruled target and are not current OpenAPI declarations.
`human` authenticates a human JWT. `client` authenticates a machine JWT.
Live registration and execution requirements appear per operation; registration
and deregistration require no live registration.

| Status | Command after `kanthord worker`               | Route                                                | Operation ID                 | Access / registration                                                             |
| ------ | --------------------------------------------- | ---------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| I      | `register`                                    | `POST /api/worker/register`                          | `worker.register`            | `client`; no live registration required                                           |
| I      | `heartbeat [--token <jwt>]`                   | `POST /api/worker/heartbeat`                         | `worker.heartbeat`           | `client`; live registration                                                       |
| I      | `handover <execution-id> [M] [--token <jwt>]` | `POST /api/worker/handover`                          | `worker.handover`            | `client`; live registration and live execution                                    |
| I      | `list`                                        | `GET /api/worker/catalog`                            | `worker.catalog.list`        | `human`                                                                           |
| I      | `get <worker-name>`                           | `GET /api/worker/catalog/:worker_name`               | `worker.catalog.get`         | `human`                                                                           |
| I      | `instance list`                               | `GET /api/worker/instance`                           | `worker.instance.list`       | `human`                                                                           |
| I      | `instance get <runtime-identity>`             | `GET /api/worker/instance/:runtime_identity`         | `worker.instance.get`        | `human`                                                                           |
| I      | `instance deregister <runtime-identity>`      | `DELETE /api/worker/instance/:runtime_identity`      | `worker.instance.deregister` | `client`; no live registration required; ownership by client, binding and project |
| I      | `instance resume <runtime-identity>`          | `POST /api/worker/instance/:runtime_identity/resume` | `worker.instance.resume`     | `human`; mutation                                                                 |

`credential` runs inside the `worker` application alone and is no CLI command.
Its implemented operation is `worker.credential` at `POST /api/worker/credential`, with `client` access and a live execution requirement. Its body holds `execution_id`, `nonce` and `ciphertext`, the sealed refresh report, and it answers 204 with no HTTP body (`null` through the direct adapter). It is a mutation with a 30-second timeout and a 64 KiB body limit. The worker application caller is later Plan 09 work.
Custody's [serialized credential budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#serialized-credential-budget) limits normalized `api_key` and `oauth` canonical JSON to 48,914 UTF-8 bytes so the compact encrypted report fits. The worker reports once at release even without a refresh. An oversized decrypted credential answers HTTP 400 `custody.handover.report_invalid` without an update; an oversized HTTP body still answers Gateway's 413 before Custody validation.

The planned `worker.execution.setup.get` runs inside the `worker` application alone and is no CLI command. Its target route is `GET /api/worker/execution/:execution_id/setup`, with `client` access and a live execution requirement. The [execution setup](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-execution-setup) rules its answer and its handover prerequisite.

The answer holds `prompt` and `repositories`, among other fields.
`prompt` is `{ final }`. `final` holds the system layer, the agent layer and the framing that the server composes, as [`agent get`](./agent.md#the-prompt-answer) with `--view final` answers them.
Each item of `repositories` holds `{ binding_id, name, address, ssh_identity, strategy, project_prompt, working_layer }`.
`working_layer` is the map of the booleans `agents_md`, `agents_local_md`, `claude_md`, `claude_local_md` and `project_prompt` of the pinned binding revision, with all five keys present.
The worker application appends the working layer of each workspace. It reads the agent files whose switch is on and the project prompt when `project_prompt` is on.
[Project](./project.md#binding-resource-and-complete-set-edits) rules the switches.

The four human reads follow [inspection operations](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#inspection-operations).
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
limit, and returns HTTP `200` with `{ "runtime_identity": "...", "resource_identity": "...", "worker_name": "..." }`. The body limit
does not permit a registration payload. The runtime identity is `worker_instance_<ulid>`.

The CLI prints one JSON line with `runtime_identity`, `resource_identity`, `worker_name` and `idempotency_key`, saves no configuration and prints no token.
Success exits with zero; failure exits with a non-zero status. Registration creates no client identity,
worker definition or human account. The credential comes from local `jwt generate`
issuance described in [other commands](./other.md).

A client identity holds at most one live registration. A registration of a
client identity that holds a live registration answers that registration with
any key, so a restarted program keeps its runtime identity. A recorded replay
whose registration has ended is rejected with `409` `gateway.registration.stale`;
it does not recreate or transfer the instance. A binding with no free slot, or
an unavailable binding, answers `409` `worker.instance.slot_unavailable`.
Cancellation does not deregister an accepted registration. There is no automatic
CLI retry. Declared failures print their HTTP status and key; indeterminate
results print the key and instruct explicit reuse of it.

The [Gateway idempotency component](../../src/gateway/idempotency.ts) stores
completed responses in process memory and sweeps them by TTL every 60 s.
Registrations are durable `worker_instance` rows, including retained ended
attribution. A stale stored answer grants no renewed registration.

Registration checks the current binding's instance count in its acceptance
transaction. Binding removal or a change to zero instances ends live
registrations in the binding-write transaction. A server restart retains rows
and resets live heartbeat readings to its start time. The Scheduler claim and
activity collaborations remain stand-ins under D6/D9 until Plan 03; production
calls requiring those unwired collaborators fail explicitly. The [Gateway signing
key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
revokes every JWT after an increment
of `gateway.token_version` and a restart.

Source checks: [CLI integration tests](../../src/apps/server/cli-worker.test.ts),
[registration integration tests](../../src/apps/server/gateway-registration.test.ts)
and [Worker tests](../../src/worker/service.test.ts). The
[binding integration tests](../../src/apps/server/worker-binding-registration.test.ts)
exercise the real Project and Worker stores, while the
[registration CLI journey](../../src/apps/server/e2e-worker-registration.test.ts)
uses a real loopback server with the authorized Scheduler stand-ins.

## `heartbeat`

```text
kanthord worker [--endpoint <url>] heartbeat [--token <jwt>]
```

The command calls `POST /api/worker/heartbeat`, operation `worker.heartbeat`, with `client` access and an empty body.
The operation requires a live registration and answers 204.
Every authenticated request of the registered client identity renews its heartbeat.
`worker.heartbeat_window` defaults to 300 s; a sweep every 30 s ends expired registrations and frees their slots.
The [registration heartbeat](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#registration-heartbeat) rules expiry, renewed registration and execution loss.
The [Worker configuration](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#configuration) rules the window default.

## `handover`

```text
kanthord worker [--endpoint <url>] handover <execution-id> [--token <jwt>] [--idempotency-key <key>]
```

The command calls `POST /api/worker/handover`, operation `worker.handover`, with `client` access and the body `{ execution_id }`, which names the execution that the invocation chain proves. It is a secret mutation with `[M]`: a repeat of its key answers 409 without the envelope, and a lost answer takes a new key.
The operation is implemented, requires a live execution and returns the strict AES-256-GCM envelope `{ nonce, ciphertext }` as canonical base64. It has a 30-second timeout and a 1 KiB body limit. Registration and execution proof precede replay lookup; the handler repeats execution liveness in its one write transaction before authorization, pinning and encryption.
The command prints only `{ "received": true, "idempotency_key": "<key>" }` and never prints the envelope.
The [credential handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-credential-handover) rules the application call after a claim and before inference.
The [Custody handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-credential-handover) rules the envelope and credential report.

## Catalog inspection

### `list`

```text
kanthord worker list [--limit <count>] [--cursor <opaque>]
```

No positional arguments or filters. Required token: human JWT. Request:
`params: {}`, `query: { limit, cursor? }`, no body. `limit` and `cursor` use the
shared types, requiredness, defaults and validation. HTTP `200` returns
one page of released worker summaries in ascending alphabetical order by exact name,
under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination). Each item contains
`name: WorkerName`, `host: "kanthord" | "external-harness"`,
`declared_node_states: string[]` and `required_node_format: string[]`.

The catalog describes supplied static templates. It is not a
runtime plugin store, and registration does not add entries. The declared workers
and their capabilities are:

| Worker        | Host                           | Method / agent                   | Declared node states                         |
| ------------- | ------------------------------ | -------------------------------- | -------------------------------------------- |
| `general@1`   | kanthord                       | steps / `swe@1`                  | `Available`                                  |
| `reviewer@1`  | kanthord                       | evaluation / `re@1`              | `Waiting`, `External.Requested`              |
| `developer@1` | kanthord                       | reviewed_steps / `swe@1`, `re@1` | `Available`                                  |
| `claude@1`    | external harness `claude-code` | Harness-owned                    | `Available`, `Waiting`, `External.Requested` |
| `opencode@1`  | external harness `opencode`    | Harness-owned                    | `Available`, `Waiting`, `External.Requested` |

All five declarations are in the current catalog; native runtime execution and
external-harness integration remain later work. `list` returns only the released
workers `developer@1` and `reviewer@1`. `get` and binding validation accept all five declarations. All five require a name, a requirement, a criterion, verifications and bindings. No worker named `tdd@1`
is promised by this specification.

### `get <worker-name>`

```text
kanthord worker get <worker-name>
```

`worker-name` is required `WorkerName`, with no default, mapped to
`params.worker_name`; query is empty and body absent. Required token: human JWT.
HTTP `200` returns the summary fields plus:

- `harness: string` for an external worker, naming its hosting harness.
- `method: "steps" | "evaluation" | "reviewed_steps"` and `agent_names: AgentName[]` for a native worker, in the order of the declaration. The first agent does the work, and `re@1` of `developer@1` reviews each task commit against the task criterion, every node criterion item that the task touches, and the default standard.
- `resource_budget` for every worker, with a required positive safe integer
  `wall_time_ms` and an optional positive safe integer `turns`.
  `general@1`, `reviewer@1` and `developer@1` default to
  `{ turns: 200, wall_time_ms: 7200000 }`; `claude@1` and `opencode@1`
  default to `{ wall_time_ms: 7200000 }`. Every worker binding may override the
  default. [Stop and budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#stop-and-budget)
  defines a turn as one `turn_end` event of the pi agent loop and measures wall
  time from the execution's `created_at`. After budget end, execution code
  checkpoints, pushes and releases, with cleanup bounded by `expired_at`.
  A stop for a reason other than a revocation aborts the agent and runs the
  same cleanup under a fresh context bounded by `expired_at`. A steps execution
  writes the checkpoint commit when the workspace holds uncommitted work,
  pushes and releases with `further_work: true` and
  `stop: { reason, code }`. A reviewer execution writes no commit and releases
  with the `stop`. A failed push still releases with the `stop`. A failed
  release ends the execution with no release.
  A reply with no valid marker line gets one repair turn, for the task
  judgement, the evaluation judgement and the review reply. A second invalid
  judgement stops the execution with `judgement_invalid`, and a second invalid
  review reply ends the review of that task.
  An evaluation judgement of an initiative may carry `proposals`: one
  fix-objective proposal for each defect inside a completed objective. Each
  proposal holds `objective_id`, `name`, `requirement`, `criterion` and one
  `task`. When `proposals` is not empty, the reviewer submits the result
  `undetermined` with the proposals. The reviewer drops `proposals` for an
  objective. See `mission proposal approve` in the [Mission CLI](mission.md).
  A steps execution reads the assessment that caused the latest rework of its
  attempt. When the attempt holds no such assessment, the execution reads the
  assessment that the cleared outcome names. The task judgement at the start
  carries the rationale of the first assessment that exists. A task that the
  agent judges unmet starts its work with a revision instruction that holds the
  rationale. A reviewer execution whose
  `criterion-not-met` assessment causes a rework ends with no release, because
  the assessment ends its claim.
  An external harness must release before its `expired_at`.

Absent/inapplicable native fields other than `resource_budget` are omitted for
externally hosted workers. The result changes no registration, pool, project
configuration or scheduling state.
An unknown exact worker name returns `404 worker.catalog.not_found`.

## Instance inspection and lifecycle

**Target design:** an instance is runtime-only, hosts at most one execution and
has at most one outstanding work pull or execution. Server-placement pools are
created from Project bindings. Configuration revisions replace no instance;
count reductions retire idle server instances first and drain busy ones. External
harnesses host their own instances and have no kanthord placement. Starting a
remote application belongs to `serve worker` in [other commands](./other.md).

The registration-backed list, get, deregister and resume leaves below are
implemented. Server-placement pools remain later work. Inspection and ended
resume use the Scheduler collaboration, supplied by the D6/D9 stand-ins in
tests until Plan 03 wires its implementation.

### `instance list`

```text
kanthord worker instance list [--project <project-id>] [--binding <binding-name>] [--limit <count>] [--cursor <opaque>]
```

| Input                                                                            | Requiredness / type / default                                                  | Mapping and validation                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--project <project-id>`                                                         | Optional `ProjectId`; omitted means all projects visible to the human          | `query.project_id`; retain and validate the declared prefix.                                                                        |
| `--binding <binding-name>`                                                       | Optional binding name; omitted means all worker bindings in the selected scope | `query.resource_identity` as `worker:kanthord:<binding-name>`; requires `--project`, and the project must hold that worker binding. |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Shared pagination flags                                                        | Shared query mapping.                                                                                                               |

Required token: human JWT. Empty params, absent body. HTTP `200` returns
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
`params.runtime_identity`. Required token: human JWT. Empty query, absent body.
HTTP `200` returns one instance record; unknown or ended instances return
`404 worker.instance.not_found` rather than a historical execution record.

The instance record contains:

| Field                                                                | Type and presence                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runtime_identity`, `project_id`, `resource_identity`, `worker_name` | Required identities/natural key of the instance and its owning binding.                                                             |
| `host`                                                               | Required string, one of `kanthord`, `external-harness`.                                                                             |
| `placement`                                                          | String, one of `server`, `worker`, for kanthord-hosted instances; omitted for external harnesses.                                   |
| `client_id`, `name`                                                  | Client identity using the declared `client_identity` prefix and display-name string, present for registered instances only. No JWT. |
| `activity`                                                           | Required string, one of `idle`, `pulling`, `executing`, describing known server activity, not proof that a remote process is alive. |
| `draining`                                                           | Required boolean; true when a server-hosted instance is scheduled to retire after its current execution.                            |
| `execution_id`                                                       | Present only while executing, naming the Scheduler execution record.                                                                |
| `registered`                                                         | Required boolean; registration state, separate from execution claim state and physical process liveness.                            |

Both commands are read-only. Durable execution and trace attribution are queried
through Scheduler and Tracking. They do not infer a dead process from silence.

### `instance deregister <runtime-identity>`

```text
kanthord worker instance deregister <runtime-identity> [--idempotency-key <key>]
```

Required `runtime-identity: RuntimeIdentity`, no default, maps to
`params.runtime_identity`. Empty query and absent body. Required token: machine
JWT. The shared mutation key applies. HTTP `200` returns
`{ "runtime_identity": "...", "registered": false }`; the CLI adds its key.

The [deregistration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#deregistration)
declares `worker.instance.deregister` as a `client` mutation at
`DELETE /api/worker/instance/:runtime_identity`, with `unary` lifetime,
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
client identity, which stays intact. A retry after a restart runs the handler
again: it ends a registration that is still live and answers `404` for one that
already ended. The caller reads that `404` after its own call as the end of its
registration. A revoked credential or unavailable binding gains no
authentication bypass for cleanup.

The effect is to end the registration, preventing later work pulls and execution
operations under it. Scheduler owns any live execution's liveness disposition.
Success does not prove the remote process stopped, release an execution, or
authorize reuse of its workspace. Dead-process cleanup, physical-stop enforcement
and capacity reuse stay with B9 SC5 and W5. The same client identity registers
again with a fresh idempotency key after expiry or deregistration.

### `instance resume <runtime-identity>`

```text
kanthord worker instance resume <runtime-identity> [--idempotency-key <key>]
```

Required `runtime-identity: RuntimeIdentity`, no default, maps to
`params.runtime_identity`. Empty query and absent body. Required token: human
JWT. The shared mutation key applies. HTTP `200` returns
`{ "runtime_identity": "...", "registered": true }`; the CLI adds its key.

The [resume contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#resume-of-a-registration)
declares `worker.instance.resume` as a `human` mutation at
`POST /api/worker/instance/:runtime_identity/resume`, with `unary` lifetime, the
default 30 s timeout and the default 10 MiB body limit. It reopens an ended
registration only while that registration is the claimant of a live execution,
and it takes the slot through the Project instance-count collaboration in the
same transaction. The next registration of the client identity answers that
registration, and its work pull returns the live execution. A resume of a live
registration changes nothing. A lost execution is never revived.

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

`worker.action.request` is an API-only `client` mutation at `POST /api/worker/execution/:execution_id/action/request`, with `unary` lifetime, no body and a 900 s timeout. It requires a live execution and the admission of the action performer. The evaluation method of `reviewer@1` calls it, and it answers 200 with the action result below. It calls the action performer and not the MCP server.

### Action performer results

The operation and the action tool return this result, not CLI output:

`{ tool_name: "repository-action-request", items: ActionResultItem[] }`.
`ActionResultItem` is discriminated on `kind`, with one value per return class:

- `submitted` holds `evidence`, the request evidence that `mission.evidence.request` answers.
- `awaiting-prerequisite` holds `action: { key, binding_id }`, the waiting action, and `prerequisite: { key, evidence_id }`, the requested action it follows and its request evidence.
- `failed-before-effect` holds `action: { key, binding_id }` and `refusal: { class, code, message }`, where `class` is `confirmed_failure`, `retryable_refusal` or `final_refusal`. A final refusal declines the request before any write. `code` and `message` come from the connector that transported the request: the platform implementation for a platform action, the repository connector for a network git write.
- `uncertain` holds `action: { key, binding_id }`, `uncertainty: "effect" | "recording" | "both"` and an optional `address`, present when the remote returned the address and the Mission submission stayed uncertain. An `unknown_outcome` result class produces `effect`.

The request evidence shape is the Mission `Evidence` record; the [action performer ruling of `worker-service.impl.md`](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#action-performer) declares the item shapes.
`key` is the `FrozenAction.key` of the attempt, and `binding_id` is the repository binding of the action.
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
proof component with the required `execution_id` argument. A failed proof returns
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
The Gateway cancels session contexts in shutdown phase 1.
The action performer derives the request key of its write, and the Intake outbound request holds the idempotency of that key.
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
agent loops, workspace cleanup or collaboration functions. The MCP server
exposes no direct platform write and no raw git push, merge, credential export
or caller-selected remote destination.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                      | Condition                                                                                                                                                                                                                         | Commands                                                                      |
| ----- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| local | `worker.version.unavailable`                              | The server package version is unavailable.                                                                                                                                                                                        | serve worker                                                                  |
| local | `worker.version.mismatch`                                 | The server package version differs.                                                                                                                                                                                               | serve worker                                                                  |
| local | `worker.start.client_secret_invalid`                      | The client_secret is not a canonical 32-byte base64 value.                                                                                                                                                                        | serve worker                                                                  |
| local | `worker.start.client_secret_absent`                       | The worker has no client_secret in cli.yaml.                                                                                                                                                                                      | serve worker                                                                  |
| local | `worker.start.tool_missing`                               | `rg`, or `fd` (`fdfind`), cannot run on the worker host.                                                                                                                                                                          | serve worker                                                                  |
| local | `worker.runtime.setup_refused`                            | The adapter cannot map the execution setup onto pi; `details.reason` is `model_unknown`, `reasoning_effort_unsupported`, `credential_absent` or `credential_revision_mismatch`.                                                   | serve worker                                                                  |
| local | `worker.start.registration_indeterminate`                 | The registration at startup answers an indeterminate result.                                                                                                                                                                      | serve worker                                                                  |
| local | `worker.stop.execution_live`                              | A stop signal arrives during a live execution; the application aborts the agent, deregisters nothing and exits 1.                                                                                                                 | serve worker                                                                  |
| local | `worker.stop.deregistration_indeterminate`                | The deregistration at a stop answers an indeterminate result.                                                                                                                                                                     | serve worker                                                                  |
| local | `worker.handover.decryption_failed`                       | The handover envelope does not open under the handover key of the client_secret.                                                                                                                                                  | serve worker                                                                  |
| local | `worker.evidence_upload.path_refused`                     | The path of `evidence-upload` is absolute, leaves the workspace, is a symbolic link, is not a regular file or is replaced during the open; `details.reason` is `outside_workspace`, `symbolic_link`, `not_regular` or `replaced`. | serve worker                                                                  |
| local | `worker.evidence_upload.transfer_failed`                  | The PUT to the presigned destination fails or answers a status outside 2xx.                                                                                                                                                       | serve worker                                                                  |
| 409   | `worker.execution.no_native_agent`                        | The setup read names an execution of an externally hosted worker.                                                                                                                                                                 | worker.execution.setup.get (API only)                                         |
| 409   | `worker.execution.credential_not_pinned`                  | The execution pins no revision of the credential name of its effective configuration.                                                                                                                                             | worker.execution.setup.get (API only)                                         |
| local | `cli.worker.instance.list.invalid_project_id`             | The `--project` value is not a canonical `project_<ulid>` identity.                                                                                                                                                               | instance list                                                                 |
| local | `cli.worker.instance.list.invalid_binding_name`           | The `--binding` value is not a binding name.                                                                                                                                                                                      | instance list                                                                 |
| local | `cli.worker.instance.list.binding_without_project`        | `--binding` is given without `--project`.                                                                                                                                                                                         | instance list                                                                 |
| local | `cli.worker.instance.get.invalid_runtime_identity`        | The `<runtime-identity>` argument is not a canonical `worker_instance_<ulid>` identity.                                                                                                                                           | instance get                                                                  |
| local | `cli.worker.instance.deregister.invalid_runtime_identity` | The `<runtime-identity>` argument is not a canonical `worker_instance_<ulid>` identity.                                                                                                                                           | instance deregister                                                           |
| local | `cli.worker.instance.resume.invalid_runtime_identity`     | The `<runtime-identity>` argument is not a canonical `worker_instance_<ulid>` identity.                                                                                                                                           | instance resume                                                               |
| local | `cli.worker.handover.invalid_execution_id`                | The `<execution-id>` argument is not a canonical `execution_<ulid>` identity.                                                                                                                                                     | handover                                                                      |
| local | `cli.worker.handover.token_required`                      | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                   | handover                                                                      |
| local | `cli.worker.handover.indeterminate`                       | The handover result is indeterminate; retry with a new key.                                                                                                                                                                       | handover                                                                      |
| 403   | `worker.authorization.refused`                            | The chain of the model inference credential breaks; details `{ reason }` with `binding_mismatch`, `binding_removed`, `binding_disabled` or `no_native_agent`.                                                                     | handover                                                                      |
| 403   | `mission.authorization.refused`                           | Mission refuses the protected facility chain; details `{ reason }` with `claim_not_live`, `node_mismatch`, `attempt_closed`, `binding_disabled` or `binding_removed`.                                                             | worker.action.request (API only)                                              |
| 400   | `custody.handover.report_invalid`                         | A refresh report fails its tag, envelope, schema or credential byte budget, names an unpinned revision, or carries a credential type other than the platform's secret shape.                                                      | worker credential (API only)                                                  |
| 409   | `credential.revision.revoked`                             | A pinned use names a revoked revision.                                                                                                                                                                                            | handover, worker credential (API only), worker.execution.setup.get (API only) |
| local | `cli.worker.register.invalid_idempotency_key`             | The `--idempotency-key` value is not a canonical ULID.                                                                                                                                                                            | register                                                                      |
| 409   | `worker.action_performer.claim_not_evaluation`            | The action performer runs under a steps claim.                                                                                                                                                                                    | worker.action.request (API only)                                              |
| 409   | `worker.action_performer.assessment_not_current`          | The attempt holds no current passing assessment.                                                                                                                                                                                  | worker.action.request (API only)                                              |
| 409   | `worker.action_performer.snapshot_absent`                 | The current passing assessment names no repository snapshot of the binding of the action.                                                                                                                                         | worker.action.request (API only)                                              |
| 400   | `worker.instance.binding_unknown`                         | `resource_identity` names no current worker binding of `project_id`.                                                                                                                                                              | instance list                                                                 |
| 404   | `worker.catalog.not_found`                                | The worker name is absent from the catalog.                                                                                                                                                                                       | get                                                                           |
| 404   | `worker.instance.not_found`                               | The runtime identity is unknown, ended, not owned or at the server placement.                                                                                                                                                     | instance get, instance deregister, instance resume                            |
| 409   | `worker.instance.no_live_execution`                       | The registration is the claimant of no live execution.                                                                                                                                                                            | instance resume                                                               |
| 409   | `worker.instance.client_live`                             | The client identity holds another live registration.                                                                                                                                                                              | instance resume                                                               |
| 409   | `worker.instance.slot_unavailable`                        | The binding has no free slot or is unavailable.                                                                                                                                                                                   | register, instance resume                                                     |

`error.details` lists affected bindings or other dependents when applicable. No error holds secret material.

## Design provenance

Optional design provenance:
[Worker design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.md),
[Worker vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.vocabulary.md),
[Worker implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md),
[architecture rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
