# Worker CLI specification

This specification for `kanthord worker` contains **16 command leaves, all implemented**.
Requirements marked
**target design** describe later runtime behavior and do not establish implementation.

See the [CLI index](./README.md) for shared conventions and
[other commands](./other.md) for `serve worker`, server configuration and local
`auth jwt generate` issuance. Worker binding edits, instance counts, availability, agent
entries and effective configuration inspection belong to [Project](./project.md).
The [Agent](./agent.md) document covers the agent catalog, agent enablement and effective configuration resolution.
[LLM](./llm.md) covers credential management of LLM platforms.
Work pull, claims, execution records and release belong to
[Scheduler](./scheduler.md).

## Current implementation boundary

The [CLI implementation](../../src/apps/cli/worker.ts) and
[Worker operation contract](../../src/worker/contract.ts) provide registration,
heartbeat, handover, catalog reads, the placement list, and registration inspection and lifecycle. The
[registration implementation](../../src/worker/registrations.ts) uses durable
`worker_registration` rows, one live registration per client identity, and atomic
binding instance-count admission. Deregistration is both an internal
collaboration and an owned client operation.
The [instance implementation](../../src/worker/instances.ts) keeps the worker
instance records, their key revisions and their connections.
[`serve worker`](./other.md#serve-worker) starts from an instance configuration
that `instance create` or `instance rotate` produces.

The [server composition](../../src/apps/server/index.ts) wires the real
[Project binding resolver](../../src/project/service.ts), including group
tombstones and transactional registration endings when a binding becomes
unavailable. Scheduler running-execution and activity collaborators use the
implemented Scheduler Service. Custody handover and refresh-report operations
are implemented and wired to Project authorization and Scheduler execution pins.
The `handover` CLI leaf is implemented with its published validation code.

The [Worker configuration fragment](../../src/worker/config.ts) declares
`heartbeat_window`, `server_slot_limit` and `container_image`. The catalog, report-only registration
healthcheck collaboration and registration heartbeat lifecycle are implemented.
The server starts one worker thread for each slot of a binding at the `server`
placement and one container for each slot of a binding at the `container`
placement. The service probe reports registration-component availability
separately from registration healthchecks.

## Shared input and output contract

Every command below except `join` reaches the selected server through a published operation.
It reads no server database. A proposed CLI command ships only together with its
operation declaration and generated OpenAPI route. All commands accept `--help`,
which needs no server or token. Unknown arguments/options and invalid local
inputs fail before a request. No command prompts or accepts `--config`.
Only `join` reads standard input.

Shared syntax, types, defaults, and validation are defined by each linked flag.
Only applicability and Worker-specific requirements are listed here.

| Common flag                                                                      | Applies to / Worker requirement                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| [`--endpoint`](./common-flags.md#--endpoint)                                     | Every command; inherited from the `worker` group.                                       |
| [`--token`](./common-flags.md#--token)                                           | Every operation requires a nonblank resolved token matching its human or client policy. |
| [`--idempotency-key`](./common-flags.md#--idempotency-key)                       | Mutations only.                                                                         |
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

| Value                      | Type and validation                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkerName`               | Nonempty exact versioned catalog key, such as `coder@1`. Required version; no implicit latest version or alias. Unknown names fail lookup. This is a natural key, not a ULID.                                                                                                                                      |
| `AgentName`                | Nonempty exact role/version key in the agent catalog, such as `swe@1`; never a worker name. Unknown names fail lookup.                                                                                                                                                                                             |
| `ProjectId`                | Opaque `project_<ulid>` identity using the declared project prefix.                                                                                                                                                                                                                                                |
| `RuntimeIdentity`          | `worker_registration_<ulid>` under the [Worker identity ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-identities-of-the-worker-service), validated with `identitySchema("worker_registration")` of the kernel. Consumers retain the returned value exactly. |
| `BindingId`, `ExecutionId` | `BindingId` uses `binding_<ulid>`. `ExecutionId` uses `execution_<ulid>` under the [Scheduler identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/scheduler-service.impl.md#the-identities-of-the-scheduler-service), validated with `identitySchema("execution")` of the kernel.        |

An entity identity follows `<declared-prefix>_<ulid>`, where the ULID is canonical
uppercase and matches `[0-7][0-9A-HJKMNP-TV-Z]{25}`. Validate the expected entity
kind, not just the suffix. An idempotency key follows the same rule with the
prefix `idempotency_key`.
Worker and agent names and MCP session IDs retain their natural-key/protocol forms.

## Command inventory

`P` means proposed; `I` means implemented syntax and operation.
`P` routes describe the ruled target and are not current OpenAPI declarations.
`human` authenticates a human JWT. `client` authenticates a machine JWT.
Live registration and execution requirements appear per operation; registration
and deregistration require no live registration.

| Status | Command after `kanthord worker`                   | Route                                                    | Operation ID                     | Access / registration                                                             |
| ------ | ------------------------------------------------- | -------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| I      | `register`                                        | `POST /api/worker/register`                              | `worker.register`                | `client`; no live registration required                                           |
| I      | `heartbeat [--token <jwt>]`                       | `POST /api/worker/heartbeat`                             | `worker.heartbeat`               | `client`; live registration                                                       |
| I      | `handover <execution-id> [M] [--token <jwt>]`     | `POST /api/worker/handover`                              | `worker.handover`                | `client`; live registration and live execution                                    |
| I      | `list`                                            | `GET /api/worker/catalog`                                | `worker.catalog.list`            | `human`                                                                           |
| I      | `get <worker-name>`                               | `GET /api/worker/catalog/:worker_name`                   | `worker.catalog.get`             | `human`                                                                           |
| I      | `placement list`                                  | `GET /api/worker/placement`                              | `worker.placement.list`          | `human`                                                                           |
| I      | `registration list`                               | `GET /api/worker/registration`                           | `worker.registration.list`       | `human`                                                                           |
| I      | `registration get <runtime-identity>`             | `GET /api/worker/registration/:runtime_identity`         | `worker.registration.get`        | `human`                                                                           |
| I      | `registration deregister <runtime-identity>`      | `DELETE /api/worker/registration/:runtime_identity`      | `worker.registration.deregister` | `client`; no live registration required; ownership by client, binding and project |
| I      | `registration resume <runtime-identity>`          | `POST /api/worker/registration/:runtime_identity/resume` | `worker.registration.resume`     | `human`; mutation                                                                 |
| I      | `instance create <name> --worker <worker>`        | `POST /api/worker/instance`                              | `worker.instance.create`         | `human`; mutation                                                                 |
| I      | `instance list`                                   | `GET /api/worker/instance`                               | `worker.instance.list`           | `human`                                                                           |
| I      | `instance get <name>`                             | `GET /api/worker/instance/:instance_name`                | `worker.instance.get`            | `human`                                                                           |
| I      | `instance rotate <name> --expected-revision <n>`  | `POST /api/worker/instance/:instance_name/revision`      | `worker.instance.rotate`         | `human`; mutation                                                                 |
| I      | `instance archive <name> --expected-revision <n>` | `POST /api/worker/instance/:instance_name/archive`       | `worker.instance.archive`        | `human`; mutation                                                                 |
| I      | `join [--force]`                                  | local                                                    | none                             | none; reads the instance configuration from standard input                        |

`credential` runs inside the `worker` application alone and is no CLI command.
Its implemented operation is `worker.credential` at `POST /api/worker/credential`, with `client` access and a live execution requirement. Its body holds `execution_id`, `nonce` and `ciphertext`, the sealed refresh report, and it answers 204 with no HTTP body (`null` through the direct adapter). It is a mutation with a 30-second timeout and a 64 KiB body limit. The worker application caller is later Plan 09 work.
Custody's [serialized credential budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#serialized-credential-budget) limits normalized `api_key` and `oauth` canonical JSON to 48,914 UTF-8 bytes so the compact encrypted report fits. The worker reports once at release even without a refresh. An oversized decrypted credential answers HTTP 400 `custody.handover.report_invalid` without an update; an oversized HTTP body still answers Gateway's 413 before Custody validation.

`worker.ssh.sign` runs inside the `worker` application alone and is no CLI command. It is the [SSH signature relay](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-ssh-signature-relay) of a repository binding whose SSH identity the handover does not carry.
Its route is `POST /api/worker/ssh/sign`, with `client` access and a live execution requirement. Its body holds `execution_id`, `nonce` and `ciphertext`, the sealed `{ binding_id, data, flags }`. It answers 200 with `{ nonce, ciphertext }`, the sealed `{ signature }`.
It is a secret mutation with a 30-second timeout and a 16 KiB body limit. A repeated idempotency key answers 409 with no answer, so a retry uses a new key.
The server signs only a user authentication request with the user name `git` for the key of a repository binding of the node of the execution. A host-bound request must name the pinned host key.
The relay serves only an execution whose worker binding is at the `worker` placement. Another placement answers 403 `worker.ssh.placement_refused`.

The planned `worker.execution.setup.get` runs inside the `worker` application alone and is no CLI command. Its target route is `GET /api/worker/execution/:execution_id/setup`, with `client` access and a live execution requirement. The [execution setup](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#the-execution-setup) rules its answer and its handover prerequisite.

The answer holds `prompt` and `repositories`, among other fields.
`prompt` is `{ final }`. `final` holds `base.md`, `<agent>.md`, the binding prompts and the framing that the server composes. The binding prompts are the non-blank texts of `prompts[<agent>]` of each repository binding of the node at its pinned revision, in binding order. [`agent get`](./agent.md#the-prompt-answer) with `--view final` answers the same composition.
Each item of `repositories` holds `{ binding_id, resource_identity, name, address, ssh_host_key, ssh_public_key, strategy, environment }`.
`ssh_host_key` is `{ known_hosts }`: the line of the pinned host key of the address host. The line has the form `<host> <key>` for port 22 and `[<host>]:<port> <key>` for another port. The answer holds no key.
`ssh_public_key` is the OpenSSH public key of the SSH credential of the binding: the key of the revision that the execution pins, else of the newest live revision. The read creates no pin, and the answer holds no private key. A revision without a generated public key answers 409 `repository.credential.ssh_key_legacy`.
The read refuses an address host outside the SSH host set of the binding platform with `project.bindings.repository.address_invalid`, and an address host without a pin with `repository.host_key.unpinned`.
An invalid override file of the agent directory answers 409 `agent.prompt.template_invalid` with the details `{ file, path, reason }`.
The worker application reads no prompt file of a workspace or of its host. It uses `final` as the system prompt and pins only the work prompt as a message.
The execution setup contract of this version differs from the previous version. Upgrade the server and every worker host together.
[Project](./project.md#repository-configuration--proposed-fields) rules `prompts`.

The steps method of an `implement` node keeps its workspace in `workspaces/<node identity>/` of the state directory.
Each repository binding of the pinned revision has one checkout in `workspaces/<node identity>/checkouts/<binding name>/`.
With one repository binding, the agent works from that checkout.
With two or more, the agent works from `checkouts/`, and each binding is one directory under it.
The execution commits each checkout that holds a change and pushes the node branch of every checkout.
Each commit of the execution has the header `<commit_type>: <subject>` with no scope, and `commit_type` comes from the node content, `feat` when absent.
The subject of a task commit is the task `name`. The subject of a node unit commit and of a verdict commit is the node `name`.
The subject of a merge commit is `merge <base branch>`. The subject of a checkpoint commit is the `name` of the current unit.
The subject starts with a lowercase letter and is cut so that the header holds at most 100 characters. The subject then loses every final full stop and space.
The body holds the unit identity on its own line. A passed unit adds the `Kanthord-Done` trailer after a blank line.
It then submits one evidence with one `repository` asset for each binding in binding order.

The five human reads follow [inspection operations](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#inspection-operations).
Each is `unary`, has `mutation: false` and a default timeout of 30 s, and reads
no table of another service. Every authenticated human has the
server-owner authority of the target design; this table introduces no project
membership or administrator role. Machine inspection/calls remain scoped to the
authenticated client and claim and gain no authority from caller-supplied IDs.

## `register` — implemented

```text
kanthord worker [--endpoint <url>] register [--token <jwt>] [--idempotency-key <key>]
```

There are no positional arguments. [`--token`](./common-flags.md#--token),
[`--endpoint`](./common-flags.md#--endpoint),
[`--idempotency-key`](./common-flags.md#--idempotency-key), and
[`--help`](./common-flags.md#--help) use the shared definitions. Registration
requires a machine token; the shared reference records its local preflight.
The command creates a worker registration under the client identity of its machine JWT.
`--token` overrides `KANTHORD_TOKEN` and the `token` field of the client configuration file.
A missing token stops the command without a prompt or a request.
The worker runtime can call the route directly with its machine JWT.
The [registration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#worker-registration) owns JWT verification, instance-count admission and replay.

| Request location         | Requiredness / type / default                                                  | Validation                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `Authorization` header   | Required bearer machine JWT; no default                                        | Gateway derives client identity, display name, worker binding and project; a human JWT is refused. |
| `Idempotency-Key` header | Required `idempotency_key_<ulid>` on the wire; generated by the CLI if omitted | Reuse the same key for a retry.                                                                    |
| `params`, `query`        | Empty objects                                                                  | No nominated subject, kind, binding, worker, project or runtime identity.                          |
| `body`                   | Absent HTTP body; internal value `null`                                        | JSON `{}` is not an empty request body and is rejected. `--file` is not accepted.                  |

The operation is a mutation, declares a `10,000 ms` timeout and a `40 KiB` body
limit, and returns HTTP `200` with `{ "runtime_identity": "...", "resource_identity": "...", "worker_name": "..." }`. The body limit
does not permit a registration payload. The runtime identity is `worker_registration_<ulid>`.

The CLI prints one JSON line with `runtime_identity`, `resource_identity`, `worker_name` and `idempotency_key`, saves no configuration and prints no token.
Success exits with zero; failure exits with a non-zero status. Registration creates no client identity,
worker definition or human account. The credential comes from local `auth jwt generate`
issuance described in [other commands](./other.md).

A client identity holds at most one live registration. A registration of a
client identity that holds a live registration answers that registration with
any key, so a restarted program keeps its runtime identity. A recorded replay
whose registration has ended is rejected with `409` `gateway.registration.stale`;
it does not recreate or transfer the registration. A binding with no free slot, or
an unavailable binding, answers `409` `worker.registration.slot_unavailable`.
Cancellation does not deregister an accepted registration. There is no automatic
CLI retry. Declared failures print the `status` and `idempotency_key` rows;
indeterminate results print the `idempotency_key` row and instruct explicit reuse of it.

The [Gateway idempotency component](../../src/gateway/idempotency.ts) stores
completed responses in process memory and sweeps them by TTL every 60 s.
Registrations are durable `worker_registration` rows, including retained ended
attribution. A stale stored answer grants no renewed registration.

Registration checks the current binding's instance count in its acceptance
transaction. Binding removal or a change to zero instances ends live
registrations in the binding-write transaction. A server restart retains rows
and resets live heartbeat readings to its start time. The Scheduler claim and
activity collaborations remain stand-ins under D6/D9 until Plan 03; production
calls requiring those unwired collaborators fail explicitly. The [Gateway signing
key ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md#the-signing-key)
revokes every JWT after an increment
of `gateway.auth.version` and a restart.

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
The envelope holds `ssh_identities: [{ binding_id, credential_id, private_key }]` beside `items`, one entry for each repository binding of the pinned node revision. An execution with no repository binding holds `[]`. The handover pins each SSH key revision to the execution.
The worker application takes the handover before the setup read. It builds the SSH access of each repository in memory from the handover entry and `ssh_host_key`, and it writes no private key to a file.

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
`declared_node_states: string[]` and `declared_intents: ("implement" | "examine")[]`.
The Scheduler admits a node only when the declared intents hold the intent of the node.

The catalog describes supplied static templates. It is not a
runtime plugin store, and registration does not add entries. The declared workers
and their capabilities are:

| Worker          | Host                           | Method / agent      | Declared node states                         | Declared intents       |
| --------------- | ------------------------------ | ------------------- | -------------------------------------------- | ---------------------- |
| `coder@1`       | kanthord                       | steps / `swe@1`     | `Available`                                  | `implement`, `examine` |
| `reviewer@1`    | kanthord                       | evaluation / `re@1` | `Waiting`, `External.Requested`              | `implement`, `examine` |
| `claude-code@1` | external harness `claude-code` | Harness-owned       | `Available`, `Waiting`, `External.Requested` | `implement`, `examine` |

All three declarations are in the current catalog; external-harness integration
remains later work. `list` returns only the released native workers `coder@1`
and `reviewer@1`. `get` and binding validation accept all three declarations. No worker named `tdd@1`
is promised by this specification.

### `get <worker-name>`

```text
kanthord worker get <worker-name>
```

`worker-name` is required `WorkerName`, with no default, mapped to
`params.worker_name`; query is empty and body absent. Required token: human JWT.
HTTP `200` returns the summary fields plus:

- `harness: string` for an external worker, naming its hosting harness.
- `method: "steps" | "evaluation"` and `agent_names: AgentName[]` for a native worker, in the order of the declaration. `coder@1` runs the verifications of each task and judges no criterion. `reviewer@1` reviews the whole node after the release.
- `resource_budget` for every worker, with a required positive safe integer
  `wall_time_ms` and an optional positive safe integer `turns`.
  `coder@1` and `reviewer@1` default to
  `{ turns: 200, wall_time_ms: 7200000 }`; `claude-code@1`
  defaults to `{ wall_time_ms: 7200000 }`. Every worker binding may override the
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
  An evaluation judgement with no valid marker line gets one repair turn. A
  second invalid judgement stops the execution with `judgement_invalid`.
  An evaluation judgement of an `examine` node carries `proposals`: one
  fix-node proposal for each defect inside a completed `implement` dependency.
  Each proposal holds `dependency_id`, `name`, `requirement`, `criterion` and
  one `task`. When `proposals` is not empty, the reviewer submits the result
  `undetermined` with the proposals. The reviewer drops `proposals` for an
  `implement` node. See `mission proposal approve` in the [Mission CLI](mission.md).
  A steps execution reads the assessment that caused the latest rework of its
  attempt. When the attempt holds no such assessment, the execution reads the
  change requests of the pull request, then the assessment that the cleared
  outcome names. The verdict is the rationale of the rework assessment, else
  the requested-changes text. When no checkout holds a commit that is not a
  merge commit after the judged commit of the verdict, the node gets a turn
  with the verdict. A cleared assessment that is not `success` gives the node a
  turn with its rationale. A reviewer execution whose
  `criterion-not-met` assessment causes a rework ends with no release, because
  the assessment ends its claim.
  An external harness must release before its `expired_at`.

Absent/inapplicable native fields other than `resource_budget` are omitted for
externally hosted workers. The result changes no registration, pool, project
configuration or scheduling state.
An unknown exact worker name returns `404 worker.catalog.not_found`.

## Placement inspection

### `placement list`

```text
kanthord worker placement list
```

The command takes no input. Required token: human JWT. Empty params, empty
query, absent body. HTTP `200` returns `{ items }` with one item for each
placement, in the order `server`, `container`, `worker`. The read starts no
container and writes no state.

| Field               | Type and presence                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `placement`         | Required string, one of `server`, `container`, `worker`.                                                                         |
| `available`         | Required boolean. True when the server can host an instance at that placement.                                                   |
| `reason`            | One of `server_in_container`, `runtime_absent`, `runtime_failed`, `runtime_rootful` when `available` is false; otherwise `null`. |
| `detail`            | First line of the answer of the container runtime, at most 200 bytes, when the runtime states one; otherwise `null`.             |
| `container_runtime` | One of `podman`, `docker` when the server found a container runtime; otherwise `null`.                                           |

`server` and `worker` always answer `available: true` with `null` in the three
other fields. `container` answers the runtime check of the server:

| `reason`              | Condition                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `server_in_container` | The server runs inside a container, so it cannot start a container for each instance.                              |
| `runtime_absent`      | Neither `podman` nor `docker` resolves on the `PATH` of the server.                                                |
| `runtime_failed`      | The runtime does not answer, or it fails a check. `detail` states why. A stopped Podman machine gives this reason. |
| `runtime_rootful`     | The host is Linux, the runtime is rootful and the server user is not root. Docker Desktop is exempt.               |

The server reuses the newest runtime answer for 10 s.
`runtime_failed` is transient: the slots of a `container` binding start again with a
backoff when the runtime recovers. The other reasons stay until a human changes the host.
[`project binding apply`](./project.md#binding-resource-and-complete-set-edits)
refuses a new `container` binding for the three stable reasons only.
The answer has no error code of its own.

## Registration inspection and lifecycle

**Target design:** an instance is runtime-only, hosts at most one execution and
has at most one outstanding work pull or execution. Pools of the `server` and
the `container` placement are created from Project bindings. Configuration revisions replace no instance;
count reductions retire idle server instances first and drain busy ones. External
harnesses host their own instances and have no kanthord placement. Starting a
remote application belongs to `serve worker` in [other commands](./other.md).

The registration-backed list, get, deregister and resume leaves below are
implemented. The server pool starts, drains and restarts the slot threads of a
binding at the `server` placement and the slot containers of a binding at the
`container` placement. Inspection and ended
resume use the Scheduler collaboration, supplied by the D6/D9 stand-ins in
tests until Plan 03 wires its implementation.

### `registration list`

```text
kanthord worker registration list [--project <project-id>] [--binding <binding-name>] [--limit <count>] [--cursor <opaque>]
```

| Input                                                                            | Requiredness / type / default                                                  | Mapping and validation                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--project <project-id>`                                                         | Optional `ProjectId`; omitted means all projects visible to the human          | `query.project_id`; retain and validate the declared prefix.                                                                        |
| `--binding <binding-name>`                                                       | Optional binding name; omitted means all worker bindings in the selected scope | `query.resource_identity` as `worker:kanthord:<binding-name>`; requires `--project`, and the project must hold that worker binding. |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Shared pagination flags                                                        | Shared query mapping.                                                                                                               |

Required token: human JWT. Empty params, absent body. HTTP `200` returns
one page of the registration records defined below in descending runtime-identity
order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
No ULID ordering is a lifecycle chronology. This is a live inventory, not a
persistent history; subsequent pages reflect pool changes.
A binding outside the supplied project answers HTTP `400`.

### `registration get <runtime-identity>`

```text
kanthord worker registration get <runtime-identity>
```

Required `runtime-identity: RuntimeIdentity`, no default; maps to
`params.runtime_identity`. Required token: human JWT. Empty query, absent body.
HTTP `200` returns one registration record; unknown or ended registrations return
`404 worker.registration.not_found` rather than a historical execution record.

The registration record contains:

| Field                                                                | Type and presence                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `runtime_identity`, `project_id`, `resource_identity`, `worker_name` | Required identities/natural key of the registration and its owning binding.                                                         |
| `host`                                                               | Required string, one of `kanthord`, `external-harness`.                                                                             |
| `placement`                                                          | String, one of `server`, `container`, `worker`, for kanthord-hosted registrations; omitted for external harnesses.                  |
| `client_id`, `name`                                                  | Client identity using the declared `client_identity` prefix and display-name string, present for live registrations only. No JWT.   |
| `activity`                                                           | Required string, one of `idle`, `pulling`, `executing`, describing known server activity, not proof that a remote process is alive. |
| `draining`                                                           | Required boolean; true when a server-hosted registration is scheduled to retire after its current execution.                        |
| `execution_id`                                                       | Present only while executing, naming the Scheduler execution record.                                                                |
| `registered`                                                         | Required boolean; registration state, separate from execution claim state and physical process liveness.                            |

Both commands are read-only. Durable execution and trace attribution are queried
through Scheduler and Tracking. They do not infer a dead process from silence.

### `registration deregister <runtime-identity>`

```text
kanthord worker registration deregister <runtime-identity> [--idempotency-key <key>]
```

Required `runtime-identity: RuntimeIdentity`, no default, maps to
`params.runtime_identity`. Empty query and absent body. Required token: machine
JWT. The shared mutation key applies. HTTP `200` returns
`{ "runtime_identity": "...", "registered": false }`; the CLI adds its key.

The [deregistration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#deregistration)
declares `worker.registration.deregister` as a `client` mutation at
`DELETE /api/worker/registration/:runtime_identity`, with `unary` lifetime,
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
`worker.registration.not_found`, including an ended registration, another client's
registration and a newer registration of the same
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

### `registration resume <runtime-identity>`

```text
kanthord worker registration resume <runtime-identity> [--idempotency-key <key>]
```

Required `runtime-identity: RuntimeIdentity`, no default, maps to
`params.runtime_identity`. Empty query and absent body. Required token: human
JWT. The shared mutation key applies. HTTP `200` returns
`{ "runtime_identity": "...", "registered": true }`; the CLI adds its key.

The [resume contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#resume-of-a-registration)
declares `worker.registration.resume` as a `human` mutation at
`POST /api/worker/registration/:runtime_identity/resume`, with `unary` lifetime, the
default 30 s timeout and the default 10 MiB body limit. It reopens an ended
registration only while that registration is the claimant of a live execution,
and it takes the slot through the Project instance-count collaboration in the
same transaction. The next registration of the client identity answers that
registration, and its work pull returns the live execution. A resume of a live
registration changes nothing. A lost execution is never revived.

## Worker instances

A worker instance is one host that serves the bindings at the `worker` placement that list it.
An instance record holds the instance name, the hosted worker and one X25519 key revision.
[`serve worker`](./other.md#serve-worker) proves the instance with the private key of the live revision.
The server keeps only the public key and its fingerprint.

The instance configuration is the canonical JSON object `{ name, endpoint, instance_id, private_key }`.
Its value is the unpadded base64url encoding of that JSON text.
`instance_id` names the live revision, and `private_key` is the base64url X25519 private key.
The instance file `<XDG configuration directory>/kanthord/workers/<name>.yaml` holds the same four fields as YAML.
The file has mode `0600`.

| Value          | Type and validation                                                                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InstanceName` | 1 to 63 characters: a lower-case letter first, then lower-case letters, digits and hyphens. The names `server`, `token`, `connect` and `heartbeat` are reserved. |
| `InstanceId`   | `worker_instance_<ulid>`. Each key revision has its own identity.                                                                                                |
| `revision`     | Positive integer. `instance create` writes revision 1. Each `instance rotate` writes the next revision.                                                          |

The instance record contains `id`, `name`, `worker`, `revision`, `public_key`, `fingerprint`, `created_at` and `ended_at`.
`ended_at` is `null` for the live revision.
The five operations are `unary`, have the `human` access policy and a 30 s timeout.

### `instance create`

```text
kanthord worker instance create <name> --worker <worker> [--worker-endpoint <url>] [--output [--force]] [--idempotency-key <key>]
```

| Input                     | Requiredness / type / default                   | Mapping and validation                                                                                           |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `<name>`                  | Required `InstanceName`                         | `body.name`. A name outside the form fails locally with `worker.instance.name_invalid`.                          |
| `--worker <worker>`       | Required `WorkerName`                           | `body.worker`. The server accepts only a worker with the `kanthord` host.                                        |
| `--worker-endpoint <url>` | Optional URL; default the resolved `--endpoint` | The `endpoint` of the instance configuration. It is not sent. It follows the `--endpoint` URL validation.        |
| `--output`                | Optional flag                                   | Writes the instance file on this host and prints no instance configuration.                                      |
| `--force`                 | Optional flag; requires `--output`              | Replaces an existing instance file. Without `--output` it fails with `cli.worker.instance.force_without_output`. |
| `--idempotency-key <key>` | Shared mutation key                             | `Idempotency-Key` header.                                                                                        |

The CLI generates the X25519 key pair on this host.
It sends `{ name, worker, public_key }` and never sends the private key.
The operation also accepts `endpoint` instead of `public_key`.
With `endpoint`, the server generates the key pair and answers the instance configuration once.
The CLI does not use that form.

The CLI checks the name, `--force`, the token, the worker endpoint and the instance file before the request.
With `--output`, an existing instance file fails with `cli.worker.join.config_exists`, unless `--force` is given.
Without `--output`, standard output must be a terminal, or the command fails with `cli.output.terminal_required`.

HTTP `200` answers the instance record. The CLI prints one JSON line with the record.
With `--output`, the line adds `created: <path of the instance file>`.
Without `--output`, the line adds `instance_configuration`, the configuration value.
Copy that value to the worker host and run `join` there, or set it as `KANTHORD_WORKER_CONFIG`.
The printed line holds no idempotency key.

The operation is a secret mutation: a repeat of its key answers 409 with no body.
An indeterminate result fails with `cli.worker.instance.create.indeterminate` and prints the key.
Read the instance with `instance get` before a new attempt.
A taken name answers `409 worker.instance.name_conflict`, also when an archived instance holds the name.

### `instance list`

```text
kanthord worker instance list [--worker <worker>] [--include-archived] [--limit <count>] [--cursor <opaque>]
```

| Input                                                                            | Requiredness / type / default | Mapping and validation                             |
| -------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- |
| `--worker <worker>`                                                              | Optional `WorkerName`         | `query.worker`; only the instances of that worker. |
| `--include-archived`                                                             | Optional flag; default false  | `query.include_archived`; adds archived instances. |
| [`--limit`](./common-flags.md#--limit), [`--cursor`](./common-flags.md#--cursor) | Shared pagination flags       | Shared query mapping.                              |

Required token: human JWT. Empty params, absent body. HTTP `200` returns one page in ascending name order.
Each item holds the instance record, `connection`, `binding_count` and `holder_mismatch`.
`connection` is `{ connection_name, connected_at, last_heartbeat_at }` for a current connection whose last heartbeat is at most 60 seconds old, otherwise `null`.
`binding_count` counts the bindings that list the instance.
`holder_mismatch` is true when a binding that lists the instance names a credential with no live copy of the instance sealed to its current key.

### `instance get`

```text
kanthord worker instance get <name>
```

Required `<name>: InstanceName`, mapped to `params.instance_name`. Required token: human JWT.
Empty query, absent body. HTTP `200` returns the live revision, or the latest revision of an archived instance.
The answer adds these fields to the instance record:

| Field           | Type and presence                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------- |
| `connection`    | The current connection, as in `instance list`, or `null`.                                                           |
| `bindings`      | Array of `{ project_id, binding }`, one item for each binding that lists the instance.                              |
| `registrations` | Array of the live registration records of the instance.                                                             |
| `credentials`   | Array of `{ name, revision, platform, sealed_current, health }`, one item for each credential copy of the instance. |

`health` is `{ status, capability, failure_reason, models, reported_at }`, the last check that the instance reported for the newest live revision of the copy.
The server keeps the report in memory. `reported_at` is the Unix time in milliseconds of the report.
A copy with no report since the server start, a copy of another revision, or a copy sealed to an ended key answers `status: unknown`, `failure_reason: held_by_instance`, `models: null` and `reported_at: null`.
`models` holds the model list of a check that reads one, else `null`.

An unknown name answers `404 worker.instance.not_found`.

### `instance rotate`

```text
kanthord worker instance rotate <name> --expected-revision <n> [--worker-endpoint <url>] [--output [--force]] [--idempotency-key <key>]
```

`<name>`, `--worker-endpoint`, `--output`, `--force` and `--idempotency-key` follow [`instance create`](#instance-create).
`--expected-revision <n>` is required and names the live revision as a positive integer.
An absent or invalid value fails locally with `cli.worker.instance.revision_invalid`.
The CLI generates a new key pair and sends `{ public_key, expected_revision }` to `params.instance_name`.

In one transaction, the server writes the next revision with the new key.
It ends the old revision, its worker tokens and its registrations.
The answer, the output and the secret-mutation rule follow `instance create`.
An indeterminate result fails with `cli.worker.instance.rotate.indeterminate`.
The process that holds the old configuration loses its token.
Its next token call answers `404 worker.instance.not_found`, and the process exits `1`.
Write the new configuration on the worker host with `join --force`, then start `serve worker` again.

A stale `--expected-revision` answers `409 worker.instance.revision_conflict` with `details.revision`.
An archived instance answers `409 worker.instance.archived`.

### `instance archive`

```text
kanthord worker instance archive <name> --expected-revision <n> [--idempotency-key <key>]
```

Required `<name>: InstanceName` and `--expected-revision <n>`, as in `instance rotate`.
The request body is `{ expected_revision }`. HTTP `200` returns the archived instance record.
The CLI prints one JSON line with the record and `idempotency_key`.

The server archives the instance only when no binding lists it.
It also refuses when a registration of the instance holds a live execution.
Both refusals answer `409 worker.instance.in_use`.
`details.bindings` lists the bindings, or `details.executions` lists the executions.
The archive ends the registrations of the instance.
An archived name stays taken, and `instance create` cannot use it again.
An indeterminate result fails with `cli.worker.instance.archive.indeterminate` and prints the key.

### `join`

```text
kanthord worker join [--force]
```

`join` is local. It calls no server and needs no token.
It reads the instance configuration value from standard input, decodes it and validates it.
An invalid value fails with `worker.instance.config_invalid`.
It writes the instance file `<XDG configuration directory>/kanthord/workers/<name>.yaml` with mode `0600`.
An existing file fails with `cli.worker.join.config_exists`, unless `--force` is given.
On success stdout is exactly `created: <absolute path>\n`.

```sh
kanthord worker join < instance.txt
kanthord serve worker --instance <name>
```

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

`worker.execution.change_request.get` is an API-only `client` read at `GET /api/worker/execution/:execution_id/change-request`, with `unary` lifetime, no body and a 60 s timeout. It requires a live execution. The steps method of `coder@1` calls it at the start of an attempt after an unblock when the cleared outcome has the closing event `external-failed`. It reads the external actions of the cleared attempt. For each `pull_request` action with the resolution `other-end`, it calls `intake.action.read` with the method `github-pull-request-change-request-get` and the request evidence of that action. It answers 200 with `{ items }`. Each item holds `evidence_id`, `binding_id`, `head_commit` and `change_requests`. `binding_id` names the repository binding of the `pull_request` action. Each change request holds `review_id`, `reviewer`, `body`, `submitted_at`, `commit_id` and `comments`, and each comment holds `path`, `line` and `body`. A claim of attempt 1 answers `{ items: [] }`. A platform failure answers 502 with the code `repository.platform.github.<class>`.

The steps method writes the change requests into one requested-changes text that stops at 4 KiB.
Each change request has the line `Reviewer <reviewer> requests changes on <binding name> at commit <commit>: <body>`.
The binding name is the name of the repository binding that `binding_id` of the item names.
When the pinned revision names no such binding, the line names `binding_id`.

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

A native agent at the `server` or the `container` placement reaches MCP through
the slot channel under the machine identity of its slot. The port transport of the
slot channel carries no `stream` operation yet, so a slot of either placement reaches
no MCP path until the [HANDOFF](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-service)
item that carries it closes. Native agents at the `worker` placement and external
harnesses use HTTP and their machine JWT.
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

| HTTP  | Code                                                          | Condition                                                                                                                                                                                                                         | Commands                                                                                                                      |
| ----- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| local | `worker.version.unavailable`                                  | The server package version is unavailable.                                                                                                                                                                                        | serve worker                                                                                                                  |
| local | `worker.version.mismatch`                                     | The server package version differs.                                                                                                                                                                                               | serve worker                                                                                                                  |
| local | `worker.start.instance_config_absent`                         | `KANTHORD_WORKER_CONFIG` is unset or blank, and no `--instance` names an existing instance file. The diagnostic names the variable, the file path and `XDG_CONFIG_HOME`.                                                          | serve worker                                                                                                                  |
| local | `worker.start.instance_config_conflict`                       | `KANTHORD_WORKER_CONFIG` is set and the instance file of the same name exists.                                                                                                                                                    | serve worker                                                                                                                  |
| local | `worker.instance.config_invalid`                              | The instance configuration is no unpadded base64url JSON object, fails the configuration schema or holds no valid X25519 key. `--instance` differs from its name, or the file name differs from its `name`.                       | serve worker, join                                                                                                            |
| local | `worker.start.endpoint_insecure`                              | The endpoint uses `http` and its host does not resolve only to loopback or private addresses. Use `https` for any other host.                                                                                                     | serve worker                                                                                                                  |
| local | `worker.instance.exchange_unavailable`                        | A connect or heartbeat call of the instance gets an indeterminate answer.                                                                                                                                                         | serve worker                                                                                                                  |
| local | `worker.instance.superseded`                                  | Another process holds the connection of the instance. The process exits `3`; `details` name the other `connection_name`.                                                                                                          | serve worker                                                                                                                  |
| local | `worker.instance.secret_changed`                              | The client secret of a hosted binding changes. Restart the instance.                                                                                                                                                              | serve worker                                                                                                                  |
| local | `worker.start.tool_missing`                                   | The server or the worker cannot install or run the pinned `rg` or `fd` in `pi/bin/` of the state directory: a missing source, a host target outside the manifest, a digest mismatch or a failed `--version` run.                  | serve server, serve worker                                                                                                    |
| local | `worker.runtime.setup_refused`                                | The adapter cannot map the execution setup onto pi; `details.reason` is `model_unknown`, `reasoning_effort_unsupported`, `credential_absent` or `credential_revision_mismatch`.                                                   | serve worker                                                                                                                  |
| local | `worker.start.registration_indeterminate`                     | The registration at startup answers an indeterminate result.                                                                                                                                                                      | serve worker                                                                                                                  |
| local | `worker.stop.execution_live`                                  | A stop signal arrives during a live execution; the application aborts the agent, deregisters nothing and exits 1.                                                                                                                 | serve worker                                                                                                                  |
| local | `worker.stop.deregistration_indeterminate`                    | The deregistration at a stop answers an indeterminate result.                                                                                                                                                                     | serve worker                                                                                                                  |
| local | `worker.handover.decryption_failed`                           | The handover envelope does not open under the handover key of the client secret of the binding.                                                                                                                                   | serve worker                                                                                                                  |
| local | `worker.evidence_upload.path_refused`                         | The path of `evidence-upload` is absolute, leaves the workspace, is a symbolic link, is not a regular file or is replaced during the open; `details.reason` is `outside_workspace`, `symbolic_link`, `not_regular` or `replaced`. | serve worker                                                                                                                  |
| local | `worker.evidence_upload.transfer_failed`                      | The file of `evidence-upload` is above the 5 GiB single-object limit. A failed PUT gives no answer of its own: the helper calls `mission.evidence.asset.complete`, whose check records the storage binding as failed.             | serve worker                                                                                                                  |
| 400   | `worker.ssh.sign_refused`                                     | The relayed payload is no user authentication request (`details.reason` `not_user_authentication`), names another key (`key_mismatch`) or another host key (`host_key_mismatch`).                                                 | worker.ssh.sign (API only)                                                                                                    |
| 400   | `worker.ssh.sign_invalid`                                     | The sealed sign request does not open under the client secret of the binding, or its plaintext does not match the schema.                                                                                                         | worker.ssh.sign (API only)                                                                                                    |
| 403   | `worker.ssh.placement_refused`                                | The worker binding of the execution is not at the `worker` placement (`details.placement`).                                                                                                                                       | worker.ssh.sign (API only)                                                                                                    |
| 409   | `worker.execution.no_native_agent`                            | The setup read names an execution of an externally hosted worker.                                                                                                                                                                 | worker.execution.setup.get (API only)                                                                                         |
| 409   | `worker.execution.credential_not_pinned`                      | The execution pins no revision of the credential name of its effective configuration.                                                                                                                                             | worker.execution.setup.get (API only)                                                                                         |
| local | `cli.worker.registration.list.invalid_project_id`             | The `--project` value is not a canonical `project_<ulid>` identity.                                                                                                                                                               | registration list                                                                                                             |
| local | `cli.worker.registration.list.invalid_binding_name`           | The `--binding` value is not a binding name.                                                                                                                                                                                      | registration list                                                                                                             |
| local | `cli.worker.registration.list.binding_without_project`        | `--binding` is given without `--project`.                                                                                                                                                                                         | registration list                                                                                                             |
| local | `cli.worker.registration.get.invalid_runtime_identity`        | The `<runtime-identity>` argument is not a canonical `worker_registration_<ulid>` identity.                                                                                                                                       | registration get                                                                                                              |
| local | `cli.worker.registration.deregister.invalid_runtime_identity` | The `<runtime-identity>` argument is not a canonical `worker_registration_<ulid>` identity.                                                                                                                                       | registration deregister                                                                                                       |
| local | `cli.worker.registration.resume.invalid_runtime_identity`     | The `<runtime-identity>` argument is not a canonical `worker_registration_<ulid>` identity.                                                                                                                                       | registration resume                                                                                                           |
| local | `cli.worker.handover.invalid_execution_id`                    | The `<execution-id>` argument is not a canonical `execution_<ulid>` identity.                                                                                                                                                     | handover                                                                                                                      |
| local | `cli.worker.handover.token_required`                          | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                   | handover                                                                                                                      |
| local | `cli.worker.handover.indeterminate`                           | The handover result is indeterminate; retry with a new key. The diagnostic prints no key row.                                                                                                                                     | handover                                                                                                                      |
| local | `cli.worker.placement.list.token_required`                    | No option, environment variable or `cli.yaml` supplies a token.                                                                                                                                                                   | placement list                                                                                                                |
| local | `cli.worker.placement.list.indeterminate`                     | The read result is indeterminate.                                                                                                                                                                                                 | placement list                                                                                                                |
| local | `cli.worker.instance.force_without_output`                    | `--force` is given without `--output`.                                                                                                                                                                                            | instance create, instance rotate                                                                                              |
| local | `cli.worker.instance.revision_invalid`                        | `--expected-revision` is absent or is not a positive integer.                                                                                                                                                                     | instance rotate, instance archive                                                                                             |
| local | `cli.worker.join.config_exists`                               | The instance file exists and `--force` is not given.                                                                                                                                                                              | instance create, instance rotate, join                                                                                        |
| local | `cli.worker.instance.<operation>.token_required`              | No option, environment variable or `cli.yaml` supplies a token. `<operation>` is `create`, `list`, `get`, `rotate` or `archive`.                                                                                                  | instance create, instance list, instance get, instance rotate, instance archive                                               |
| local | `cli.worker.instance.<operation>.indeterminate`               | The result is indeterminate. A mutation prints its key.                                                                                                                                                                           | instance create, instance list, instance get, instance rotate, instance archive                                               |
| 400   | `worker.instance.name_invalid`                                | The instance name breaks the binding name form or is reserved. The CLI also checks it before the request.                                                                                                                         | instance create, instance get, instance rotate, instance archive                                                              |
| 400   | `worker.instance.worker_invalid`                              | The worker is unknown or is a worker of an external harness.                                                                                                                                                                      | instance create                                                                                                               |
| 400   | `worker.instance.key_invalid`                                 | The body holds neither or both of a base64url 32-byte X25519 `public_key` and an `endpoint`.                                                                                                                                      | instance create, instance rotate                                                                                              |
| 404   | `worker.instance.not_found`                                   | The instance name or the instance revision is unknown, or the revision ended.                                                                                                                                                     | instance get, instance rotate, instance archive, serve worker                                                                 |
| 409   | `worker.instance.name_conflict`                               | A live or an archived instance holds the name.                                                                                                                                                                                    | instance create                                                                                                               |
| 409   | `worker.instance.key_conflict`                                | An instance revision holds the same key.                                                                                                                                                                                          | instance create, instance rotate                                                                                              |
| 409   | `worker.instance.revision_conflict`                           | `expected_revision` is not the live revision; `details.revision` names the live revision.                                                                                                                                         | instance rotate, instance archive                                                                                             |
| 409   | `worker.instance.archived`                                    | The instance is archived.                                                                                                                                                                                                         | instance rotate, instance archive                                                                                             |
| 409   | `worker.instance.in_use`                                      | A binding lists the instance, or a registration of the instance holds a live execution; `details` hold `bindings` or `executions`.                                                                                                | instance archive                                                                                                              |
| 409   | `worker.instance.connection_superseded`                       | Another connection of the instance is current; `details.connection_name` names it. `serve worker` ends with `worker.instance.superseded`.                                                                                         | worker.instance.connect, worker.instance.heartbeat (API only)                                                                 |
| 403   | `worker.authorization.refused`                                | The chain of the model inference credential breaks; details `{ reason }` with `binding_mismatch`, `binding_removed`, `binding_disabled` or `no_native_agent`.                                                                     | handover                                                                                                                      |
| 403   | `project.authorization.refused`                               | The SSH identity chain of a repository binding breaks; details `{ reason }` with `binding_not_found` (the binding is removed or is not a repository binding), `identity_refused` or `node_mismatch`.                              | handover                                                                                                                      |
| 403   | `mission.authorization.refused`                               | Mission refuses the protected facility chain; details `{ reason }` with `claim_not_live`, `node_mismatch`, `attempt_closed`, `binding_disabled` or `binding_removed`.                                                             | worker.action.request (API only), worker.execution.change_request.get (API only)                                              |
| 502   | `repository.platform.github.<class>`                          | The change request read fails at GitHub; `<class>` is `confirmed_failure`, `retryable_refusal`, `final_refusal` or `unknown_outcome`.                                                                                             | worker.execution.change_request.get (API only)                                                                                |
| 400   | `custody.handover.report_invalid`                             | A refresh report fails its tag, envelope, schema or credential byte budget, names an unpinned revision, or carries a credential type other than the platform's secret shape.                                                      | worker credential (API only)                                                                                                  |
| 409   | `credential.revision.revoked`                                 | A pinned use names a revoked revision.                                                                                                                                                                                            | handover, worker credential (API only), worker.execution.setup.get (API only), worker.execution.change_request.get (API only) |
| 400   | `project.bindings.repository.address_invalid`                 | The address host of a repository binding is outside the SSH host set of its platform.                                                                                                                                             | worker.execution.setup.get (API only)                                                                                         |
| 409   | `repository.host_key.unpinned`                                | The address host of a repository binding holds no pinned host key; details `{ host }`.                                                                                                                                            | handover, worker.execution.setup.get (API only)                                                                               |
| 409   | `repository.credential.ssh_key_legacy`                        | The SSH credential of a repository binding holds no generated key; details `{ credential }`.                                                                                                                                      | handover                                                                                                                      |
| 409   | `worker.action_performer.claim_not_evaluation`                | The action performer runs under a steps claim.                                                                                                                                                                                    | worker.action.request (API only)                                                                                              |
| 409   | `worker.action_performer.assessment_not_current`              | The attempt holds no current passing assessment.                                                                                                                                                                                  | worker.action.request (API only)                                                                                              |
| 409   | `worker.action_performer.snapshot_absent`                     | The current passing assessment names no repository snapshot of the binding of the action.                                                                                                                                         | worker.action.request (API only)                                                                                              |
| 400   | `worker.registration.binding_unknown`                         | `resource_identity` names no current worker binding of `project_id`.                                                                                                                                                              | registration list                                                                                                             |
| 404   | `worker.catalog.not_found`                                    | The worker name is absent from the catalog.                                                                                                                                                                                       | get                                                                                                                           |
| 404   | `worker.registration.not_found`                               | The runtime identity is unknown, ended or not owned.                                                                                                                                                                              | registration get, registration deregister, registration resume                                                                |
| 409   | `worker.registration.no_live_execution`                       | The registration is the claimant of no live execution.                                                                                                                                                                            | registration resume                                                                                                           |
| 409   | `worker.registration.client_live`                             | The client identity holds another live registration.                                                                                                                                                                              | registration resume                                                                                                           |
| 409   | `worker.registration.placement_mismatch`                      | The binding is at the `server` or the `container` placement and the client identity is not a pool slot of that binding.                                                                                                           | register                                                                                                                      |
| 409   | `worker.registration.slot_unavailable`                        | The binding has no free slot or is unavailable.                                                                                                                                                                                   | register, registration resume                                                                                                 |

`error.details` lists affected bindings or other dependents when applicable. No error holds secret material.

## Design provenance

Optional design provenance:
[Worker design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.md),
[Worker vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.vocabulary.md),
[Worker implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md),
[architecture rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
and [open handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md).
