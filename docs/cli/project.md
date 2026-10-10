# Project CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

This contributor specification covers the implemented `kanthord project` group:
project identity, resource bindings, repository policy and worker binding
entries. [Worker](./worker.md) owns agent enablement and
effective configuration resolution. [LLM](./llm.md), [Repository](./repository.md) and [Storage](./storage.md) cover credentials.
It is self-contained in an engine checkout.

**Status: all 13 Project commands are implemented.**
Root rulings govern the declared operations. Entries
marked **blocked** link open design items in HANDOFF that extend the binding
model; they do not block the implemented commands.

## Implementation baseline

The working tree contains:

- The [Project contract](../../src/project/contract.ts), which declares the 13
  `human` operations of the [command inventory](#command-inventory-and-synopsis).
- A [Project Service](../../src/project/service.ts) that registers those
  operations and resolves worker bindings for machine JWTs.
- [Project migrations](../../src/project/migrations.ts) for the project and
  binding stores.
- A [CLI group](../../src/apps/cli/project.ts) `kanthord project [--endpoint <url>] [--token <token>]`
  with one leaf command for each operation.

The [command inventory](#command-inventory-and-synopsis) lists
**13 leaf commands**. The
[calling convention](#common-calling-convention) defines the shared
options used by those synopses; the resource sections define their inputs,
results, and effects without repeating the command syntax.

All commands on this page belong under `project`. The [command surface](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-command-surface)
declares three global commands, seven service groups and the shared component
groups `llm`, `repository` and `storage`. The CLI also registers the `agent`
group, which the command surface does not list, and does not register `intake`.

## Common calling convention

The rules in [other.md](./other.md) apply to every command. Every synopsis
starts with `kanthord project` and uses the
[common synopsis notation](./common-flags.md#synopsis-markers).

| Named flag set                                                   | Applies to            |
| ---------------------------------------------------------------- | --------------------- |
| [`[R]` — Remote flags](./common-flags.md#remote-flags-r)         | All 14 remote leaves. |
| [`[M]` — Mutation flags](./common-flags.md#mutation-flags-m)     | Mutations only.       |
| [`[L]` — Pagination flags](./common-flags.md#pagination-flags-l) | Paginated lists only. |

### Shared options

Shared syntax, types, defaults, and validation live in
[common flags](./common-flags.md). Project-specific requirements are:

- [`--token`](./common-flags.md#--token): every remote command requires an
  effective human JWT. An empty or blank supplied value or a missing effective
  token fails locally.
- [`--file`](./common-flags.md#--file): required where named in the synopsis;
  the resource section defines the body schema and any secret-file policy.
  The command reads no database or server configuration.
- [`--help`](./common-flags.md#--help): available on the group, every nested
  resource group, and every leaf.

Options are single-use unless explicitly marked repeatable. Only `--kind` in
this specification is a repeatable scalar flag. A repeated single-use option,
unknown option, extra positional argument, missing required input, invalid ID,
or invalid input document fails before a mutation is sent. Service commands
reject `--config`. The `cli.yaml` lookup and private-file checks follow the
shared client rules; it is not a server configuration file.

Unless a resource section says otherwise, a command accepts only the inputs
in its inventory synopsis. Positional arguments map to the named route
parameters; filter flags map to the query fields defined below. A JSON input
file supplies the body, never an identity override. GET requests have no body.
Endpoint selects the server, token supplies the `Authorization` header, and
`--help` is never sent. Read-only commands reject the mutation replay option;
commands without `[L]` reject pagination options.

### Scalar types

- `ProjectId`: opaque `project_<ulid>` string; the ULID suffix is canonical,
  uppercase, and 26 characters. Reject bare ULIDs and other entity prefixes.
- `BindingId`: `binding_<ulid>`, under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).
- `CredentialName`: the name of a custody credential, under the [custody record contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-credential-store-record). A binding names a credential and never a revision.
- A `BindingId` names one revision of a binding, and a record pins it. The latest revision of a binding states its current configuration.
- Binding-set `version`: positive JSON safe integer that the service returns; the caller copies it without arithmetic.
  The binding-set version is 1 plus the number of binding rows of the project, under the [binding store ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-binding-store).
  A new project starts at binding-set version `1`.
  A write raises the version by the number of rows that it inserts.
  `1` is the lower bound of every version.
- Binding `revision`: positive JSON safe integer. A new binding starts at revision `1`, and each revision of the binding increments it.
  A supplied version identifies a value from the server.
  The server rejects a fraction or a numeric string.
- `Timestamp`: JSON safe integer of Unix milliseconds in UTC.
- `WorkerName` and `AgentName`: nonempty exact natural-key
  strings from the relevant supported catalog, not prefixed IDs. Versioned
  names such as `general@1` are whole keys. No alias expansion or latest-version
  default is proposed.

The local [identity helper](../../src/kernel/identity.ts) supplies the prefixed-ULID mechanism; the Project sibling declares the entity prefixes.

### Access and output contract

Every proposed route in the inventory declares **`human` access**. An
authenticated human has server-wide human authority, including all projects
and their binding configuration. No project-member role, owner-only privilege,
or per-project ACL is assumed. A machine JWT does not authorize configuration
or secret selection. A caller-supplied project, binding, or actor field is not
authentication; requests contain no `caller` or `human_identity` override.

Ordinary success prints one JSON value and exits `0`. A list prints one page
with required proposed fields `items` (array) and `next_cursor` (nonempty opaque
string, or `null` on the final page). It fetches no further pages implicitly.
Binding and effective-configuration reads also report `binding_set_version`.
Mutation results include the proposed `idempotency_key` CLI field alongside
the operation result. They contain metadata and credential references, never
credential material.

Failures exit nonzero with a diagnostic that does not echo secrets. Proposed
route failures distinguish invalid input, unauthenticated caller, absent or
wrong-kind resource, and optimistic-concurrency conflict. Exact error codes,
statuses, result envelopes, timeouts, cancellation declarations, and body-size
bounds must be adopted in each operation contract. A transport timeout or
`Indeterminate` result is not proof that a mutation failed. Print its replay
key without secrets so the caller can reconcile or retry.

The existing [client result mechanism](../../src/gateway/client-result.ts)
generates mutation keys and distinguishes completed, failure, and indeterminate
results. The current [Gateway replay implementation](../../src/gateway/idempotency.ts)
is in memory and bounded by its configured TTL; restart loses it. The shared
[same-key retry rules](./other.md#idempotency-and-retries) apply, but that page's
SQLite implementation note predates the in-memory implementation.
This specification promises no exactly-once behavior across restart. A project name is the natural key of project creation: a retry after a restart that names an existing project returns 409 with `project.name.conflict`, and the CLI prints the code and the HTTP status, not the holder identity. A rename targets a project ID and commits in one transaction; the last write wins under the unique name. A retry after a restart checks the name holder again. A binding-set edit has a version precondition,
but a retry after a committed edit and restart can encounter a stale version
instead of replaying the old answer.

[project-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service

## Command inventory and synopsis

Each row is one leaf command; its synopsis follows `kanthord project`
and includes every positional argument, command-specific option, and applicable
shared-option marker. Route parameters are placeholders, and path resource
names are singular.

All 13 commands have `[R]` and `human` access. The three mutations have `[M]`; the four paginated lists have `[L]`.
Blocked commands link their items in [HANDOFF Project Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service).

| #   | Synopsis after `kanthord project`                                         | HTTP route                                                           | Operation ID                                           | Access/status        |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ | -------------------- |
| 1   | `create --name <name> [M] [R]`                                            | `POST /api/project`                                                  | `project.create`                                       | `human`; implemented |
| 2   | `list [L] [R]`                                                            | `GET /api/project`                                                   | `project.list`                                         | `human`; implemented |
| 3   | `get <project-id> [R]`                                                    | `GET /api/project/:project_id`                                       | `project.get`                                          | `human`; implemented |
| 4   | `rename <project-id> --name <name> [M] [R]`                               | `PATCH /api/project/:project_id`                                     | `project.rename`                                       | `human`; implemented |
| 5   | `binding list <project-id> [--kind <kind> ...] [--state <state>] [L] [R]` | `GET /api/project/:project_id/binding`                               | `project.binding.list` **[blocked][project-contract]** | `human`; implemented |
| 6   | `binding get <project-id> <binding-id> [R]`                               | `GET /api/project/:project_id/binding/:binding_id`                   | `project.binding.get` **[blocked][project-contract]**  | `human`; implemented |
| 7   | `binding export <project-id> [R]`                                         | `GET /api/project/:project_id/binding-set`                           | `project.bindingSet.get`                               | `human`; implemented |
| 8   | `binding apply <project-id> --file <path> [M] [R]`                        | `PUT /api/project/:project_id/binding-set`                           | `project.bindingSet.write`                             | `human`; implemented |
| 9   | `binding revision list <project-id> <binding-id> [L] [R]`                 | `GET /api/project/:project_id/binding/:binding_id/revision`          | `project.bindingRevision.list`                         | `human`; implemented |
| 10  | `agent list <project-id> <worker-binding-id> [L] [R]`                     | `GET /api/project/:project_id/binding/:binding_id/agent`             | `project.agentConfiguration.list`                      | `human`; implemented |
| 11  | `agent get <project-id> <worker-binding-id> <agent-name> [R]`             | `GET /api/project/:project_id/binding/:binding_id/agent/:agent_name` | `project.agentConfiguration.get`                       | `human`; implemented |
| 12  | `binding verify <project-id> <binding-id> [R]`                            | `POST /api/project/:project_id/binding/:binding_id/verify`           | `project.binding.verify`                               | `human`; implemented |
| 13  | `binding check <project-id> --file <path> [R]`                            | `POST /api/project/:project_id/binding/check`                        | `project.binding.check`                                | `human`; implemented |
| 14  | `binding instruction-files <project-id> <binding-id> [R]`                 | `GET /api/project/:project_id/binding/:binding_id/instruction_files` | `project.binding.instruction_files.get`                | `human`; implemented |

- Rows 5 and 6 keep their marks under HANDOFF Project Service, not for the storage credential record type.
- Server-wide credential routes belong to `/api/llm/credential`, `/api/repository/credential` and `/api/storage/credential`; provider check belongs to `/api/llm/provider/check`. Neither route is under `/api/project`.
- There are 14 distinct route operations for the 14 CLI leaves.

## Project resource

Inputs:

- `<project-id>`: required `ProjectId` for `get` and `rename`; no default.
  Maps to path `project_id`.
- `--name <name>`: required string of 1 to 63 characters for `create` and `rename`: a lower-case letter first, then lower-case letters, digits and hyphens; no
  default. Preserve the supplied value. Maps to body `name`. The client derives no slug or ID. Rename is a proposed convenience over the stored project name, not an
  already-declared lifecycle operation.
- `list` has only the shared page and client options. No name filter, sort
  override, or current-project inference is implied. Lists use descending
  primary-key order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).

`create` and `rename` each send exactly `{ "name": <string> }`; there are no
other request fields. Read commands have no body. Proposed project metadata is
`id`, `name`, `binding_set_version`, `created_at` and `workspace_directory`, with the scalar types above.
`workspace_directory` is the path of the [workspace directory](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-workspace-directory) of the project, with the home directory written as `~`.
`list.items` holds that metadata; `get` returns one project.

Creation allocates a project identity and an empty binding set at version `1`.
The server returns that version. A mission belongs intrinsically to its project; it is
not a binding. Creation calls the Mission collaboration `createMission` in the same transaction. The mission starts empty at mission version 1. No operation creates or deletes a mission.
A project name is unique on the server and is the natural key of creation. Creation or rename to a name that another project holds returns 409 with code `project.name.conflict` and the holder identity in `error.details`. A retry of creation after a restart returns 409 when the name exists, and the CLI prints the code and the HTTP status. Rename commits in one transaction; the last write wins under the unique name. Rename keeps the same project identity and bindings.

No deletion, archival, project membership, or ownership-transfer command is
declared: those lifecycle policies have no basis in the Project design.

## Binding resource and complete-set edits

Inputs:

- `<project-id>`: required `ProjectId` on every binding command; no default;
  path `project_id`.
- `<binding-id>`: required `BindingId` on `get` and `revision list`;
  no default; path `binding_id`. It must belong to the named project.
- `--kind <kind>`: optional, **repeatable scalar flag** on `binding list`.
  Proposed wire enum `repository | worker | storage`.
  Absent means all supported kinds. Repeated values are ORed; reject duplicate
  values rather than changing their meaning. Maps to repeated query `kind`.
  These are the three binding kinds.
- `--state <state>`: optional enum on `binding list`, proposed values
  `current | removed | all`, default `current`; query `state`.
  The Project Service keeps a removed binding and every revision for the life of the project; `removed` and `all` include retained bindings.
- [`--file`](./common-flags.md#--file): required for `apply`; content is the
  complete `BindingSet` object defined below. No patch, merge, or partial-set mode.

`binding list` returns a page of binding metadata and current configuration.
`binding get` returns one revision of a binding, its configuration, and
proposed metadata `id`, `project_id`, `name`, `kind`, `resource_identity`, `revision`, `created_at`,
and optional `removed_at`. `resource_identity` is a
server-derived normalized string for every kind. Kind and
state filters, `limit`, and `cursor` are the only list query fields.
`binding get` has no kind query.

`binding export` reads one consistent, complete current set and prints exactly
the `BindingSet` shape, ready to save to a named JSON file and
edit. It is not paginated and contains no secret material. It includes the
version used by `apply`. The `bindings` object uses binding names as its keys,
and references use binding-name strings. Output size limits and snapshot consistency need
contracts; concatenating pages of `binding list` is not a substitute for this
read. Shell redirection of this ordinary JSON is permitted.

`binding revision list` returns a page of the revisions of the binding that
`<binding-id>` names, newest first. `binding get` returns any revision by its
identity. Both report retained history, not an
authorization grant. The Project Service keeps a removed binding and every revision for the life of the project. Both commands read the revisions of a removed binding. No sweep deletes them. No revision rollback
command is proposed; copying an old configuration into a new complete-set
write is subject to current validation.

### `BindingSet` request file

The JSON file is the HTTP body. Path `project_id` supplies its project; no body
field can redirect the edit. Required fields have no default. Optional fields
are absent by default, and `null` is invalid unless a future contract explicitly
permits it. Each object is closed except template- or platform-owned objects
whose schemas are explicitly blocked below.

- `version`: **required**, positive safe integer; the exact binding-set version that the client reads. No automatic fetch-and-retry or
  force override on a stale version.
- `bindings`: **required**, object keyed by binding name. A human chooses each
  name, unique inside its project. A name holds 1 to 63 characters: a lower-case
  letter first, then lower-case letters, digits and hyphens. `{}` explicitly
  requests removal of every current binding and succeeds only if all reference
  constraints allow it. There is no default empty object.

Each `BindingEdit` value contains only:

- `kind`: **required**, enum `repository | worker | storage`.
- `config`: **required**, the kind-specific object below.

Every reference between bindings is a binding-name string of the same
submission, for example `"repository": "kanthord-repo"`. A reference holds
no revision and names no different project. The [binding-set write ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-write-of-a-binding-set)
defines the comparison with the stored current set and the resolution of
references to stored identities.

This example uses the proposed kind-specific fields below:

```json
{
  "version": 1,
  "bindings": {
    "kanthord-repo": {
      "kind": "repository",
      "config": {
        "available": true,
        "platform": "github",
        "address": "git@kanthorlabs.github.com:kanthorlabs/kanthord.git",
        "strategy": {
          "base_branch": "main",
          "action": {
            "name": "pull_request",
            "follows": { "type": "assessment_passed" }
          }
        },
        "ssh_credential": "kanthorlabs-github",
        "credential": "github-kanthorlabs"
      }
    },
    "general-main": {
      "kind": "worker",
      "config": {
        "worker": "general@1",
        "instance_count": 1,
        "resource_budget": { "turns": 50, "wall_time_ms": 1800000 },
        "entries": [{ "agent": "swe@1", "reasoning_effort": "high" }]
      }
    }
  }
}
```

The repository credential in this example is an `api_key` of GitHub. The SSH credential is an `ssh` record of the alias `kanthorlabs.github.com`.

Common to every `config`:

- `available` applies to the repository and storage kinds. It is a required boolean with no default.
- `false` prevents subsequent resolution. It revokes no upstream authority and cancels no operation in flight.
- A worker binding holds no `available`; `instance_count: 0` makes it unavailable.

### Repository configuration — proposed fields

- `platform`: **required**, supported platform-name string; no default and no
  inference from the address. The values are `github`, `gitlab` and `bitbucket`.
  `gitlab` and `bitbucket` are git-only platforms: they take no `credential` and
  permit `merge_push` only. The platform set is extensible, not an arbitrary accepted string.
- `address`: **required**, SSH repository address `git@<host>:<owner>/<repository>.git`; no default. An HTTPS address fails. The host can be an SSH alias of `~/.ssh/config`, for example `git@kanthorlabs.github.com:kanthorlabs/kanthord.git`. `ssh -G` must resolve the host to an SSH host of the platform: `github.com` or `ssh.github.com` for `github`, `gitlab.com` or `altssh.gitlab.com` for `gitlab`, and `bitbucket.org` or `altssh.bitbucket.org` for `bitbucket`.
- Unsupported addresses and contradictory platform/address combinations fail.
- `strategy`: **required**, `RepositoryStrategy` object below. It has no inferred base branch, action or trigger.
- `ssh_credential`: **required**, one `CredentialName` of platform `ssh`; no default. Its `host` equals the host of `address`, else the write fails with `project.bindings.repository.ssh_host_mismatch`. It pins the identity that git uses through the SSH configuration of the host.
- `credential`: **optional**, one `CredentialName` of platform `github`; absent by default. A git-only platform refuses it with `project.bindings.repository.action_unsupported`. It serves every platform action of the Intake Service and the check of a request evidence. The action `pull_request` requires it, else the write fails with `project.bindings.repository.credential_required`.
- `project_prompt`: **optional**, string, absent by default. Absence or an empty string is an absent source and contributes no binding-provided prompt to Worker prompt composition.
- `working_layer`: **optional**, object of the booleans `agents_md`, `agents_local_md`, `claude_md`, `claude_local_md` and `project_prompt`. Each key switches one source of the working layer of an execution: `AGENTS.md`, `AGENTS.local.md`, `CLAUDE.md`, `CLAUDE.local.md` of the working directory and the `project_prompt`. A missing object or key means the switch is on, so the default is all five on, and the binding stores the full map. A switch change is a binding revision. A key outside the five refuses the write. The worker receives the stored map as `working_layer` of each repository of its execution setup, and `agent get --project <project-id> --binding <binding-id>` answers the working layer that it selects.
- The project prompt holds at most 32768 UTF-8 bytes. A larger value refuses the write with `project.bindings.repository.project_prompt_too_large`.
- The JSON file holds the prompt text, not a client-side path.

`RepositoryStrategy` contains:

- `base_branch`: **required**, nonblank string accepted as a branch by the
  repository adapter; no default such as `main`. It is the node-branch origin
  and the merge/push target of the configured action.
- `action`: **optional**, one `PolicyAction` object; absence means no repository action. A repository strategy holds at most one action.

Each `PolicyAction` holds only:

- `name`: **required**, enum `pull_request | merge_push`; no default.
- `follows`: **required**, one of two closed shapes; no default:
  - `type: "assessment_passed"`, with no other members.
  - `type: "action_end_state"` and a required `binding` as a binding-name string, with no other members.
- `landing`: optional, enum `human | kanthord`, default `human`. Only a `pull_request` action holds it; another action with `landing` fails validation at the `landing` path. With `kanthord`, the Intake Service merges the pull request when it performs the action, with the tested commit as the head guard. A refused merge leaves the pull request open for a human. With `human`, a human merges.

The action rules follow the [GitHub action catalog](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md).
The key of the action is `<binding name>.<name>`, which the Mission Service freezes at the attempt opening.

- The `action_end_state` shape identifies the configured action of another binding for the same node.
- The binding write refuses the `action_end_state` shape until a retry-safe claim-source contract exists, under the [frozen action rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-attempt). The refusal is one issue of the validation failure of `binding apply`, at the `follows` path.
- Absent references and invalid dependency cycles fail validation.
- `pull_request` opens a pull request from the node branch into the base branch. It requires the platform action capability and expects the merge of that pull request.
- `merge_push` merges the node branch into the base branch and pushes. It requires the network git write capability and expects the push to the base branch.
- Each action implies its expected end state and takes no parameter.

Coverage and suitability follow [Repository configuration and policy](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.md#repository-configuration-and-policy).

- Every repository binding requires one `ssh` record. A binding without `credential` permits no platform action.
- Git operations use the SSH configuration of the host, pinned by the `ssh` record.
- Custody checks that the credential has platform `github`, under [suitability](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#suitability).
- These checks read no secret material and assert no narrower upstream scope.

### Worker and agent configuration — proposed fields

A worker binding's `config` adds:

- `worker`: **required**, `WorkerName`; no default. It must name a registered
  static template. The planned initial native templates are `general@1` and
  `reviewer@1`; examples involving `tdd@1` do not make that worker available.
- `instance_count`: **required**, integer from 0 to 64; no default. The value 0 makes the binding unavailable. An invalid value refuses the write with `project.bindings.worker.instance_count_range`.
- `resource_budget`: **optional** for a native worker, `{ turns, wall_time_ms }`.
  Both fields are required positive safe integers. Absence uses the template
  budget; presence overrides it. [Stop and budget](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#stop-and-budget)
  sets both native defaults to `{ turns: 200, wall_time_ms: 7200000 }`.
  External-harness workers declare no resource budget and reject this field.
- `entries`: **optional**, array of `AgentEntry`, absent by default, meaning
  every native agent uses its enabled global enablement's default configuration.
  Agent names must be unique. An external-harness worker forbids this field:
  its harness selects and authenticates inference.

Each `AgentEntry` has required `agent`, the exact `AgentName` declared by the
worker, and one of the two [entry forms](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.vocabulary.md#entry):

- Tuning: `model_identifier`, `reasoning_effort` or both. It keeps the default
  agent provider and inherits each absent value from the enablement.
- Complete: `agent_provider`, `model_identifier` and `reasoning_effort`, all
  required. It inherits nothing. `agent_provider` names a provider of this
  agent's enablement, not an arbitrary credential.

`model_identifier` is a nonblank string. `reasoning_effort` is one of `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, `max`. An entry holds no `options`.
The write refuses nonempty `options`; the native option schemas are empty.

The [Worker validation contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#agent-configuration-validation)
checks the allowlist before the merge and the whole configuration after it.
The Project write calls `validateEntry` for every agent, including an agent
without an explicit entry, inside the transaction. A write is refused when an
agent of the worker has no enabled enablement; the refusal names the agent.
The proposed code is `agent.enablement.unavailable`. Model and reasoning
validation use the proposed Worker codes in [Worker](./worker.md#error-codes).
The Project Service holds entries and asks the Worker Service for effective
configuration; it resolves none itself. A later disablement refuses resolution
and leaves the worker binding in place.
Two bindings of one worker can have equal configuration and independent counts.

### Storage configuration

A `storage` binding names one S3-compatible bucket for the object evidence of its project.
A project holds any number of storage bindings.
Its `config` holds `available` and these required fields, with no defaults:

- `endpoint`: URL of the S3-compatible service.
- `bucket`: nonblank bucket name, such as `atlas-evidence`.
- `region`: nonblank region.
- `prefix`: text for the server-generated object-key prefix.
- `credential`: `CredentialName` of a custody credential, never inline secret material.

`credential` names a credential of platform `s3` under the [storage configuration contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#storage-configuration).
The [credential record contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/custody.impl.md#the-credential-store-record) defines its key pair, suitability and session-token exclusion.
The service validates field types, the endpoint URL and the custody reference at write and resolution.
Its use check sends `{ credential, platform: s3 }` to custody and compares no
metadata. The endpoint, bucket, region and prefix here serve work; credential
metadata serves the healthcheck. A key for another S3 service can pass the use
check and fail at its first upload.
An absent field or an invalid value refuses the write.
The binding write probes no store capability.
kanthord enforces no object immutability; it records the object version when the store returns one.
A human who disables versioning accepts that choice.
A node without a storage binding accepts only inline evidence content.

The Intake Service signs a presigned grant with the material that custody releases, for one operation on one object.
A PUT grant expires after 1 hour; authorized readers receive a presigned GET through their kanthord component.
The URL is an API answer, never part of the credential handover or the agent context.
The storage credential stays inside the server process.
[Mission upload](./mission.md#host-local-evidence-upload) defines submit, direct PUT and asset complete.

### Write validation and effects

`binding apply` validates the whole submitted set before committing it in one
Project transaction. It compares the supplied version with the current
version and refuses a stale one. No network operation belongs in that
transaction. The target rules are:

- One binding per repository and per storage bucket; any number per worker.
- Resource identity derives from configuration. A repository identity derives from the platform and from the owner and the repository of its SSH address, never from the host. A worker identity derives from its binding name, and a storage identity derives from its endpoint host and its bucket.
- Every repository binding write runs the `ssh` validation of its `ssh_credential` and performs one `git ls-remote` with a 30 s deadline before the transaction.
- A drift of the `ssh` record refuses the write with `repository.credential.ssh_drift`.
- A failed or timed-out read refuses the write with `project.bindings.repository.ssh_unreachable`.
- A strategy with more than one action refuses the write.
- The write refuses a reference to an absent, removed, wrong-kind, or other-project
  binding. A reference names a binding in the submission. Constraints involving
  references that other services own need an explicit contract; the CLI does not
  silently rewrite mission nodes.
- The [binding-set write ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-write-of-a-binding-set)
  defines the revision comparison by binding name.
- The write refuses a change to the worker of an existing worker binding under
  the same binding name, under the [validation ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#validation).
  A human removes the old binding and adds a binding with another name in the
  same edit.
- Removal keeps the binding rows and every revision for the life of the project. No sweep deletes them.
- A write equal to the stored set inserts no row and keeps the binding-set
  version. Empty and no-change submissions are still mutations, not read or
  validation commands.

`binding apply` returns the committed `BindingSet` at its new version, and
`binding export` returns the current `BindingSet`, under the
[binding-set write ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-write-of-a-binding-set).
A stale `version` answers 409 `project.binding_set.version_conflict` with the
current version in `error.details`. Binding identities come from `binding list`
and `binding get`.

Use this one write operation to add repositories, add workers, configure
agent entries, change repository strategy, set resource budgets and instance
counts, enable/disable a binding,
replace a resource or remove a binding. There is no
separate partial-update route for each field. A future convenience command
would still need the same explicit version and atomic complete-set semantics.

### Binding verify

`binding verify` calls `project.binding.verify`, a read under `human` access, under the
[binding verify ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-binding-verify).
The required `ProjectId` and `BindingId` map to `params.project_id` and `params.binding_id`. Query is empty and body absent. The command takes no mutation key and rejects `--idempotency-key`.
It checks one repository binding and stores no result.

- It runs the host resolution and the SSH read of the address of the named revision with the deadline of the resource healthcheck.
- Then it calls the record verify of the `ssh_credential` and of the `credential` of that revision.

HTTP `200` answers `{ address, ssh_credential, credential }`. `credential` is null for a binding without a credential. Each value is the health entry `{ status, capability }`:

- `status` is `healthy`, `unhealthy` or `unknown`.
- The `address` entry has the capability `network git read`. A failed resolution or a failed read answers `unhealthy`. A check that exceeds its deadline answers `unknown`.
- The `ssh_credential` and `credential` entries are the answers of the record verify.

A refusal of the record verify refuses the request with its own code.
A binding that is absent, belongs to another project, is removed or is no repository binding answers `404 project.binding.not_found`.

### Binding instruction files

`binding instruction-files` calls `project.binding.instruction_files.get`, a read under `human` access, under the
[instruction files ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-instruction-files-read).
The required `ProjectId` and `BindingId` map to `params.project_id` and `params.binding_id`. Query is empty and body absent. The command takes no mutation key and rejects `--idempotency-key`.
It reads the instruction files of one repository binding and stores nothing in the database.

- It reads the configuration of the revision that `<binding-id>` names.
- The repository connector resolves the commit of the base branch with `ls-remote`. It fetches that commit at depth 1 with no blobs into a temporary directory, reads the four paths with `git show` and deletes the directory.
- The deadline of the resource healthcheck bounds the read.
- The service caches the answer in memory per binding revision and commit. Each request runs `ls-remote`, so a new commit of the base branch replaces the answer.

HTTP `200` answers `{ commit, read_at, files }`. `commit` is the commit of the base branch. `read_at` is a Unix timestamp in milliseconds. `files` holds four entries in the order `AGENTS.md`, `AGENTS.local.md`, `CLAUDE.md`, `CLAUDE.local.md`. Each entry is `{ source, path, state, reason, text }`:

- `source` is the `working_layer` switch name: `agents_md`, `agents_local_md`, `claude_md` or `claude_local_md`.
- `path` is the file name at the root of the repository.
- `state` is `present`, `absent` or `invalid`. A path that the commit does not hold is `absent`.
- A symlink in the commit resolves inside the repository root, up to 40 links. A dangling link is `absent`. A link that leaves the root is `invalid` with `outside_workspace`. A link loop is `invalid` with `unreadable`. A directory or a submodule is `invalid` with `not_regular_file`.
- A file above 32768 bytes is `invalid` with `too_large`. A file that is not valid UTF-8 is `invalid` with `not_utf8`.
- `reason` is the invalid reason of the working layer text validation, else null.
- `text` is the text of a `present` file, else null.

A failed or timed-out read answers `422 project.bindings.repository.ssh_unreachable`.
A base branch that the remote does not hold answers `422 project.bindings.repository.base_branch_absent`.
A binding that is absent, belongs to another project, is removed or is no repository binding answers `404 project.binding.not_found`.
An absent project answers `404 project.project.not_found`.

### Binding check

`binding check` calls `project.binding.check`, a read under `human` access, under the
[binding check ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-binding-check).
The required `ProjectId` maps to `params.project_id`. The required file supplies the body `{ kind: "repository", config }`, where `config` is a repository configuration of `binding apply`. The command takes no mutation key and rejects `--idempotency-key`.
It checks the unsaved configuration and stores nothing.

- It refuses a static violation with the code of `binding apply`: `credential_required`, `action_unsupported`, `address_invalid` and `ssh_host_mismatch`, and the custody suitability codes of `ssh_credential` and `credential`.
- Then it runs the checks of `binding verify` on the configuration and answers the same `{ address, ssh_credential, credential }`.

An absent project answers `404 project.project.not_found`.

Write-time validation does not reserve future use. Every operation validates
its pinned revision again and authorizes one use only. A pinned revision
cannot bypass a later disablement, removal, revocation, or claim loss.

## Effective agent views

Inputs:

- `<project-id>`: required `ProjectId` on each command, no default; path
  `project_id`.
- `<worker-binding-id>`: required `BindingId` on both agent commands, no
  default; path `binding_id`. Must be a worker binding of this project.
- `<agent-name>`: required `AgentName` on agent `get`, no default; path
  `agent_name`. Must be declared by the selected native worker template.

No command here has a body or mutation/replay option.
Agent views propose read-only inspection of enablement defaults, binding
entries and the effective configuration that the Worker Service supplies. These
are not the global worker/agent catalogs, which belong to the Worker CLI.
The list pages the declared agents of the selected template; `get` selects
one. Proposed item fields are:

- `agent`, `worker`, `worker_binding_id`, and `binding_set_version`.
- `defaults`: the enablement's `agent_provider`, `model_identifier` and `reasoning_effort`, or `null` when no enablement exists.
- `entry`: the binding's tuning or complete entry, or `null` when absent.
- `effective`, present only when the Worker Service resolves and validates it:
  `agent_provider`, `provider`, `credential`, `model_identifier` and `reasoning_effort`.
  An invalid result permits no fallback.
- `revisions`: proposed object with `workerBinding`, `entry` and `enablement`
  revision values supplied by the Worker snapshot. `workerBinding` and `entry` are `BindingId` values.
  `entry` is the binding revision when an entry exists, otherwise `null`.
- `valid`, boolean; and `issues`, an array of proposed `{ path, code }` objects
  describing invalid configuration without secret values. `path` is an array
  of field-name strings and `code` is a nonempty diagnostic-code string.

The operation contracts must settle exact fields, consistent-read behavior,
and the handling of an unavailable or externally hosted worker. Proposed
external-harness behavior is refusal with a diagnostic that Project owns no
effective native-agent configuration for that binding. These views neither
mint an authorization grant nor authorize inference. They make no remote
healthcheck, reserve no capacity, and do not validate a live execution claim.

The [agent provider healthcheck](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md#agent-provider-healthcheck)
belongs to the Worker Service and the Gateway health report. This page specifies
no healthcheck command.

## Service boundaries: effects that are not commands

- Authorization, `resolveWorkerBinding`, per-operation resolution,
  one-use grants, `release(grant)`, and credential-reference validation are
  runtime mechanisms. This page creates no `resolve`, `authorize`, `grant`,
  `release`, or generic execute-with-credential command from them.
- The holder of released material derives the remote destination from the authorized entity. The human provider check belongs to the LLM component and accepts only a credential reference.
- Git operations, platform actions and inference stay in their execution protocols. A local commit, branch and merge are not authenticated capabilities.
- A machine execution must satisfy binding and live-claim checks on each use.
  An external harness also needs the matching authenticated client, live
  registration, worker binding, instance, claim, and node. CLI-supplied IDs
  alone cannot prove that chain.
- The check of a request evidence by the Mission Service is not a human
  administration command. Its identity and association are service-owned; no
  `--service-identity` option exists.
- Webhook verification belongs to the [Intake Service](./intake.md#routes-without-a-command). No
  `project delivery verify` command or caller-supplied human mapping exists.
- Client identities are generated by the existing local `jwt --binding`
  command, and registration belongs to `worker register`. Project stores no
  client-identity secret or list. Project has no client-identity CRUD commands.
- Template installation, worker/agent catalogs, pools, registrations, and
  runtime lifecycle belong to Worker. Project owns bindings and their desired
  configuration; applying a binding does not itself claim work or register a
  caller's instance.

## Error codes

Every remote command can also answer the shared codes of [other.md](other.md#error-codes).

| HTTP  | Code                                                       | Condition                                                                                                                                                                                                      | Commands                                                                                                                               |
| ----- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| local | `cli.project.agent.get.invalid_binding_id`                 | The `<binding-id>` argument is not a canonical `binding_<ulid>` identity.                                                                                                                                      | agent get                                                                                                                              |
| local | `cli.project.agent.get.invalid_project_id`                 | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | agent get                                                                                                                              |
| local | `cli.project.agent.list.invalid_binding_id`                | The `<binding-id>` argument is not a canonical `binding_<ulid>` identity.                                                                                                                                      | agent list                                                                                                                             |
| local | `cli.project.agent.list.invalid_project_id`                | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | agent list                                                                                                                             |
| local | `cli.project.binding.apply.invalid_project_id`             | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding apply                                                                                                                          |
| local | `cli.project.binding.check.invalid_project_id`             | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding check                                                                                                                          |
| local | `cli.project.binding.instruction_files.invalid_binding_id` | The `<binding-id>` argument is not a canonical `binding_<ulid>` identity.                                                                                                                                      | binding instruction-files                                                                                                              |
| local | `cli.project.binding.instruction_files.invalid_project_id` | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding instruction-files                                                                                                              |
| local | `cli.project.binding.verify.invalid_binding_id`            | The `<binding-id>` argument is not a canonical `binding_<ulid>` identity.                                                                                                                                      | binding verify                                                                                                                         |
| local | `cli.project.binding.verify.invalid_project_id`            | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding verify                                                                                                                         |
| local | `cli.project.binding.export.invalid_project_id`            | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding export                                                                                                                         |
| local | `cli.project.binding.get.invalid_binding_id`               | The `<binding-id>` argument is not a canonical `binding_<ulid>` identity.                                                                                                                                      | binding get                                                                                                                            |
| local | `cli.project.binding.get.invalid_project_id`               | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding get                                                                                                                            |
| local | `cli.project.binding.list.invalid_kind`                    | The `--kind` value is not a declared binding kind.                                                                                                                                                             | binding list                                                                                                                           |
| local | `cli.project.binding.list.invalid_project_id`              | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding list                                                                                                                           |
| local | `cli.project.binding.list.invalid_state`                   | The `--state` value is not a declared binding state.                                                                                                                                                           | binding list                                                                                                                           |
| local | `cli.project.binding.revision.list.invalid_binding_id`     | The `<binding-id>` argument is not a canonical `binding_<ulid>` identity.                                                                                                                                      | binding revision list                                                                                                                  |
| local | `cli.project.binding.revision.list.invalid_project_id`     | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | binding revision list                                                                                                                  |
| local | `cli.project.create.invalid_name`                          | The name is not 1–63 characters starting with a lowercase letter and then lowercase letters, digits or hyphens.                                                                                                | create                                                                                                                                 |
| local | `cli.project.get.invalid_project_id`                       | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | get                                                                                                                                    |
| local | `cli.project.rename.invalid_name`                          | The name is not 1–63 characters starting with a lowercase letter and then lowercase letters, digits or hyphens.                                                                                                | rename                                                                                                                                 |
| local | `cli.project.rename.invalid_project_id`                    | The `<project-id>` argument is not a canonical `project_<ulid>` identity.                                                                                                                                      | rename                                                                                                                                 |
| 404   | `project.binding.not_found`                                | The binding is absent or belongs to another project. For agent list and agent get, it is not a worker binding. For binding verify and binding instruction-files, it is removed or is not a repository binding. | binding get, binding revision list, binding verify, binding instruction-files, agent list, agent get                                   |
| 409   | `project.binding_set.version_conflict`                     | The submitted binding-set version differs from the current version.                                                                                                                                            | binding apply                                                                                                                          |
| 400   | `project.bindings.duplicate_resource`                      | Two bindings use the same resource.                                                                                                                                                                            | binding apply                                                                                                                          |
| 400   | `project.bindings.repository.address_invalid`              | The repository address is invalid, or `ssh -G` resolves its host outside the SSH host set of the platform.                                                                                                     | binding apply, binding check                                                                                                           |
| 400   | `project.bindings.repository.action_unsupported`           | A binding of the git-only platform `gitlab` or `bitbucket` names a `credential` or the action `pull_request`.                                                                                                  | binding apply, binding check                                                                                                           |
| 400   | `project.bindings.repository.credential_required`          | The action `pull_request` names no `credential`.                                                                                                                                                               | binding apply, binding check                                                                                                           |
| 400   | `project.bindings.repository.ssh_host_mismatch`            | The host of the address differs from the `host` of the `ssh_credential`.                                                                                                                                       | binding apply, binding check                                                                                                           |
| 400   | `repository.credential.ssh_drift`                          | `ssh -G` resolves the host of the `ssh_credential` to values that differ from its metadata; details name each differing key.                                                                                   | binding apply                                                                                                                          |
| 400   | `project.bindings.repository.project_prompt_too_large`     | The repository project prompt exceeds the limit.                                                                                                                                                               | binding apply                                                                                                                          |
| 422   | `project.bindings.repository.base_branch_absent`           | The remote does not hold the base branch of the binding.                                                                                                                                                       | binding instruction-files                                                                                                              |
| 422   | `project.bindings.repository.ssh_unreachable`              | The repository SSH read fails. For binding instruction-files, the read of the commit or of the files fails or exceeds its deadline.                                                                            | binding apply, binding instruction-files                                                                                               |
| 400   | `project.bindings.worker.agent_unknown`                    | An entry names an agent the worker does not declare.                                                                                                                                                           | binding apply                                                                                                                          |
| 400   | `project.bindings.worker.field_forbidden`                  | A known worker without an agent carries `entries` or `resource_budget`; details `{ binding, field }`. Worker validates the name first (`agent.configuration.invalid` for an unknown worker).                   | binding apply                                                                                                                          |
| 400   | `project.bindings.worker.instance_count_range`             | The instance count is outside the worker limits.                                                                                                                                                               | binding apply                                                                                                                          |
| 409   | `project.bindings.worker.resource_changed`                 | An edit changes the worker resource of a binding.                                                                                                                                                              | binding apply                                                                                                                          |
| 409   | `credential.credential.archived`                           | The credential of the binding is archived.                                                                                                                                                                     | binding verify, binding check                                                                                                          |
| 404   | `credential.credential.not_found`                          | The credential of the binding has no live revision, or it is not a credential of the Repository component.                                                                                                     | binding verify, binding check                                                                                                          |
| 400   | `credential.check.unsupported`                             | The platform of the credential has `verifiable: false`.                                                                                                                                                        | binding verify, binding check                                                                                                          |
| 409   | `project.name.conflict`                                    | Another project already uses the requested name.                                                                                                                                                               | create, rename                                                                                                                         |
| 404   | `project.project.not_found`                                | The project identity does not exist.                                                                                                                                                                           | get, rename, binding list, binding get, binding apply, agent list, agent get, binding verify, binding instruction-files, binding check |

## Design provenance

These optional links explain the target's origin; none is needed to resolve a
local engine source link or understand the contracts proposed above:

- [Project Service design](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.md)
- [Project vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.vocabulary.md)
- [Project implementation rulings](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md)
- [Architecture implementation: command surface and invocation](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
- [Open HANDOFF decisions](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md)
- [Gateway implementation: human access and replay](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/gateway-service.impl.md)
- [Worker implementation: templates and prompt bounds](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/worker-service.impl.md)
