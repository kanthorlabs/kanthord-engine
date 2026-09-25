# Project CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

This contributor specification covers the future `kanthord project` group:
project identity, resource bindings, repository policy, provider-account and
agent configuration, credential custody, and source verification secrets.
It is self-contained in an engine checkout.

**Status: no Project operation command is implemented.**
Root rulings govern the declared operations; other spellings, routes, schemas and defaults remain proposals pending contracts and OpenAPI. A design rule
described here is a target invariant, not evidence of a working feature. Entries
marked **blocked** also require a substantive design decision before their
request or response schema can be completed.

## Implementation baseline

The working tree inspected on 2026-09-23 contains:

- [`projectOperations = {}`](../../src/project/contract.ts), with no declared
  public Project operation. `ProjectBindings.resolveWorkerBinding` is a peer
  interface, not a command or a published route.
- A [Project Service](../../src/project/service.ts) whose `declare` method
  registers nothing. Its binding lookup delegates to an injected collaborator
  or returns `null`. Its lifecycle health probe is not a provider healthcheck.
- [No Project migrations or configuration fields](../../src/project/index.ts).
  The target binding store and custody described below are not present here.
- A [CLI help group](../../src/apps/cli/index.ts) with the existing spelling
  `kanthord project [--endpoint <url>]` and Commander `--help`. Invoking the group
  prints help and calls no route. The group currently has no leaf commands and
  accepts no `--token` option of its own.
- A [test of that empty service](../../src/project/service.test.ts), which
  explicitly asserts zero operations and no configured binding resolution.

The [command inventory](#proposed-command-inventory-and-synopsis) proposes
**23 leaf commands**, including the blocked secret-display command. The existing help group is not counted. The
[calling convention](#common-proposed-calling-convention) defines the shared
options used by those synopses; the resource sections define their inputs,
results, and effects without repeating the command syntax.

The proposal preserves the existing group spelling and `--endpoint` option.
All additions remain under `project`; the complete top-level set stays
`project`, `mission`, `scheduler`, `intake`, `worker`, `tracking`, `gateway`, `config`,
`serve`, and `jwt`.

## Common proposed calling convention

The rules in [other.md](./other.md) apply to every command. Every synopsis
starts with `kanthord project` and uses the
[common synopsis notation](./common-flags.md#synopsis-markers).

| Named flag set                                                   | Applies to            |
| ---------------------------------------------------------------- | --------------------- |
| [`[R]` — Remote flags](./common-flags.md#remote-flags-r)         | All 23 remote leaves. |
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
- `CredentialId`: `credential_<ulid>`, under the same ruling.
- `Revision` and binding-set `version`: positive JSON safe integers that the service returns; the caller copies them without arithmetic.
  A new project starts at binding-set version `1`.
  Its first write names version `1` and commits version `2`.
  A new binding starts at revision `1`.
  `1` is the lower bound of every version and revision.
  A supplied revision or version identifies a value from the server.
  The server rejects a fraction or a numeric string.
- `Timestamp`: JSON safe integer of Unix milliseconds in UTC.
- `WorkerName`, `AgentName`, and provider name: nonempty exact natural-key
  strings from the relevant supported catalog, not prefixed IDs. Versioned
  names such as `general@1` are whole keys. No alias expansion or latest-version
  default is proposed.
- `RemoteIdentity`: nonempty string with three nonempty colon-separated parts,
  `<platform>:<identity-kind>:<identifier>`. The identifier is a displayed
  login, slug, or path, not an upstream numeric ID. First-version examples
  include `github:user:ulrich`, `github:repository:kanthorlabs/kanthord`, and
  `openai:organization:org-kanthorlabs`. Supported combinations require a
  platform declaration. This records human intent; the server does not ask the
  remote to confirm it and derives no system authorization from it.

The local [identity helper](../../src/kernel/identity.ts) supplies the prefixed-ULID mechanism; the Project sibling declares the entity prefixes.

### Access and output contract

Every proposed route in the inventory declares **`human` access**. An
authenticated human has server-wide human authority, including all projects
and shared credential metadata. No project-member role, owner-only privilege,
or per-project ACL is assumed. A machine JWT does not authorize configuration
or secret selection. A caller-supplied project, binding, or actor field is not
authentication; requests contain no `caller` or `humanIdentity` override.

Ordinary success prints one JSON value and exits `0`. A list prints one page
with required proposed fields `items` (array) and `nextCursor` (nonempty opaque
string, or `null` on the final page). It fetches no further pages implicitly.
Binding and effective-configuration reads also report `bindingSetVersion`.
Mutation results include the proposed `idempotencyKey` CLI field alongside
the operation result. They contain metadata and credential references, never
credential material. The source-secret command has a separately blocked output
contract.

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
This specification promises no exactly-once behavior across restart. A project name is the natural key of project creation: a retry after a restart that names an existing project returns 409 with `project.name_conflict`, and the CLI prints the holder identity from `error.details`. A rename targets a project ID and commits in one transaction; the last write wins under the unique name. A retry after a restart checks the name holder again. Credential rotation updates its row in one transaction, and the last write wins. The credential name is the natural key of creation.
A retry after a restart that names a taken name returns 409 with `project.credential.name_conflict`.
The CLI prints the holder identity from `error.details`. A binding-set edit has a version precondition,
but a retry after a committed edit and restart can encounter a stale version
instead of replaying the old answer.

[project-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service

## Proposed command inventory and synopsis

Every entry below is **unimplemented**.
The OAuth operation IDs follow the root ruling; their HTTP paths remain proposed.
Other operation IDs and paths remain proposed.
The current empty Project contract publishes none of these routes. Each row is one leaf command; its synopsis follows `kanthord project`
and includes every positional argument, command-specific option, and applicable
shared-option marker. Route parameters are placeholders, and path resource
names are singular.

All 23 commands have `[R]` and `human` access. The seven mutations have `[M]`; the six paginated lists have `[L]`.
Blocked commands link their items in [HANDOFF Project Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service).

| #   | Synopsis after `kanthord project`                                                                      | Proposed HTTP route                                                    | Proposed operation ID                                      | Access/status                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `create --name <name> [M] [R]`                                                                         | `POST /api/project`                                                    | `project.create`                                           | `human`; proposed                                                                                                              |
| 2   | `list [L] [R]`                                                                                         | `GET /api/project`                                                     | `project.list`                                             | `human`; proposed                                                                                                              |
| 3   | `get <project-id> [R]`                                                                                 | `GET /api/project/:projectId`                                          | `project.get`                                              | `human`; proposed                                                                                                              |
| 4   | `rename <project-id> --name <name> [M] [R]`                                                            | `PATCH /api/project/:projectId`                                        | `project.rename`                                           | `human`; proposed                                                                                                              |
| 5   | `binding list <project-id> [--kind <kind> ...] [--state <state>] [L] [R]`                              | `GET /api/project/:projectId/binding`                                  | `project.binding.list` **[blocked][project-contract]**     | `human`; proposed                                                                                                              |
| 6   | `binding get <project-id> <binding-id> [R]`                                                            | `GET /api/project/:projectId/binding/:bindingId`                       | `project.binding.get` **[blocked][project-contract]**      | `human`; proposed                                                                                                              |
| 7   | `binding export <project-id> [R]`                                                                      | `GET /api/project/:projectId/binding-set`                              | `project.bindingSet.get` **[blocked][project-contract]**   | `human`; proposed                                                                                                              |
| 8   | `binding apply <project-id> --file <path> [M] [R]`                                                     | `PUT /api/project/:projectId/binding-set`                              | `project.bindingSet.write` **[blocked][project-contract]** | `human`; proposed                                                                                                              |
| 9   | `binding revision list <project-id> <binding-id> [L] [R]`                                              | `GET /api/project/:projectId/binding/:bindingId/revision`              | `project.bindingRevision.list`                             | `human`; proposed                                                                                                              |
| 10  | `binding revision get <project-id> <binding-id> <revision> [R]`                                        | `GET /api/project/:projectId/binding/:bindingId/revision/:revision`    | `project.bindingRevision.get`                              | `human`; proposed                                                                                                              |
| 11  | `credential create --file <path> [M] [R]`                                                              | `POST /api/project/credential`                                         | `project.credential.create`                                | `human`; proposed                                                                                                              |
| 12  | `credential list [--type <type>] [--remote-identity <identity>] [L] [R]`                               | `GET /api/project/credential`                                          | `project.credential.list`                                  | `human`; proposed                                                                                                              |
| 13  | `credential get <credential-id> [R]`                                                                   | `GET /api/project/credential/:credentialId`                            | `project.credential.get`                                   | `human`; proposed                                                                                                              |
| 14  | `credential rotate <credential-id> --file <path> [M] [R]`                                              | `PUT /api/project/credential/:credentialId/material`                   | `project.credential.rotate`                                | `human`; proposed                                                                                                              |
| 15  | `provider-account list <project-id> [L] [R]`                                                           | `GET /api/project/:projectId/binding?kind=provider_account`            | `project.binding.list`                                     | `human`; proposed                                                                                                              |
| 16  | `provider-account get <project-id> <binding-id> [R]`                                                   | `GET /api/project/:projectId/binding/:bindingId?kind=provider_account` | `project.binding.get`                                      | `human`; proposed                                                                                                              |
| 17  | `agent list <project-id> <worker-binding-id> [L] [R]`                                                  | `GET /api/project/:projectId/binding/:bindingId/agent`                 | `project.agentConfiguration.list`                          | `human`; proposed                                                                                                              |
| 18  | `agent get <project-id> <worker-binding-id> <agent-name> [R]`                                          | `GET /api/project/:projectId/binding/:bindingId/agent/:agentName`      | `project.agentConfiguration.get`                           | `human`; proposed                                                                                                              |
| 19  | `source secret get <project-id> <source-binding-id> [R]`                                               | `GET /api/project/:projectId/binding/:bindingId/secret`                | `project.sourceSecret.get`                                 | `human`; proposed, **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service)** |
| 20  | `credential login <provider> [--mode browser\|device] --name <name> --remote-identity <value> [M] [R]` | `POST /api/project/credential/login`                                   | `project.credential.login`                                 | `human`; proposed route                                                                                                        |
| 21  | `credential login-code <session> <value> [M] [R]`                                                      | `POST /api/project/credential/login/:sessionId/code`                   | `project.credential.login_code`                            | `human`; proposed route                                                                                                        |
| 22  | `credential login-status <session> [R]`                                                                | `GET /api/project/credential/login/:sessionId`                         | `project.credential.login_status`                          | `human`; proposed route                                                                                                        |
| 23  | `provider check --base-url <url> --credential <credential-id> [R]`                                     | `POST /api/project/provider/check`                                     | `project.provider.check`                                   | `human`; proposed route                                                                                                        |

- Rows 5 to 8 remain blocked only because the source configuration awaits the source-binding item.
- The credential routes and the provider check are server-wide; they contain no `projectId`.
- The static path `/api/project/provider/check`, like `/credential`, must not fall under `/:projectId`.
- Provider-account views reuse the binding operations and add a required kind constraint; they create no second provider-account store.
- There are 21 distinct route operations for the 23 CLI leaves.

## Project resource

Inputs:

- `<project-id>`: required `ProjectId` for `get` and `rename`; no default.
  Maps to path `projectId`.
- `--name <name>`: required string of 1 to 63 characters for `create` and `rename`: a lower-case letter first, then lower-case letters, digits and hyphens; no
  default. Preserve the supplied value. Maps to body `name`. The client derives no slug or ID. Rename is a proposed convenience over the stored project name, not an
  already-declared lifecycle operation.
- `list` has only the shared page and client options. No name filter, sort
  override, or current-project inference is implied. Lists use descending
  primary-key order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).

`create` and `rename` each send exactly `{ "name": <string> }`; there are no
other request fields. Read commands have no body. Proposed project metadata is
`id`, `name`, `bindingSetVersion`, and `createdAt`, with the scalar types above.
`list.items` holds that metadata; `get` returns one project.

Creation allocates a project identity and an empty binding set at version `1`.
The server returns that version. A mission belongs intrinsically to its project; it is
not a binding. Creation calls the Mission collaboration `createMission` in the same transaction. The mission starts empty at mission revision 1. No operation creates or deletes a mission.
A project name is unique on the server and is the natural key of creation. Creation or rename to a name that another project holds returns 409 with code `project.name_conflict` and the holder identity in `error.details`. A retry of creation after a restart returns 409 when the name exists, and the CLI prints the holder identity. Rename commits in one transaction; the last write wins under the unique name. Rename keeps the same project identity and bindings.

No deletion, archival, project membership, or ownership-transfer command is
declared: those lifecycle policies have no basis in the Project design.

## Binding resource and complete-set edits

Inputs:

- `<project-id>`: required `ProjectId` on every binding command; no default;
  path `projectId`.
- `<binding-id>`: required `BindingId` on `get` and both revision commands;
  no default; path `bindingId`. It must belong to the named project.
- `<revision>`: required `Revision` on revision `get`; no default; path
  `revision`, encoded as its decimal integer. It must belong to that binding.
- `--kind <kind>`: optional, **repeatable scalar flag** on `binding list`.
  Proposed wire enum `repository | worker | provider_account | source`.
  Absent means all supported kinds. Repeated values are ORed; reject duplicate
  values rather than changing their meaning. Maps to repeated query `kind`.
  These are the four currently designed kinds, not a permanently closed set.
- `--state <state>`: optional enum on `binding list`, proposed values
  `current | removed | all`, default `current`; query `state`.
  The Project Service keeps a removed binding and every revision for the life of the project; `removed` and `all` include retained bindings.
- [`--file`](./common-flags.md#--file): required for `apply`; content is the
  complete `BindingSetWrite` object defined below. No patch, merge, or partial-set mode.

`binding list` returns a page of binding metadata and current configuration.
`binding get` returns one binding, its current revision, configuration, and
proposed metadata `id`, `projectId`, `name`, `kind`, `resourceIdentity`, `createdAt`,
and optional `removedAt`. `resourceIdentity` is a
server-derived normalized string and is absent for worker bindings. Kind and
state filters, `limit`, and `cursor` are the only list query fields; the reused
provider-account views add their kind constraint as described below. Ordinary
`binding get` has no kind query; the provider-account variant supplies one
required enum value and must reject a wrong-kind target.

`binding export` reads one consistent, complete current set and prints exactly
the proposed `BindingSetWrite` shape, ready to save to a named JSON file and
edit. It is not paginated and contains no secret material. It includes the
version used by `apply`. The `bindings` object uses binding names as its keys,
and references use binding-name strings. Output size limits and snapshot consistency need
contracts; concatenating pages of `binding list` is not a substitute for this
read. Shell redirection of this ordinary JSON is permitted.

`binding revision list` returns a page of immutable revision metadata;
`binding revision get` returns the selected configuration and its
`bindingId`, `revision`, and `createdAt`. Both report retained history, not an
authorization grant. The Project Service keeps a removed binding and every revision for the life of the project. Both commands read the revisions of a removed binding. No sweep deletes them. No revision rollback
command is proposed; copying an old configuration into a new complete-set
write is subject to current validation.

### `BindingSetWrite` request file — proposed schema

The JSON file is the HTTP body. Path `projectId` supplies its project; no body
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

- `kind`: **required**, enum `repository | worker | provider_account | source`.
- `config`: **required**, the kind-specific object below.

Every reference between bindings is a binding-name string of the same
submission, for example `"providerAccount": "openai-atlas"`. A reference holds
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
        "address": "git@github.com:kanthorlabs/kanthord.git",
        "strategy": {
          "baseBranch": "main",
          "action": {
            "name": "pull_request",
            "follows": { "type": "assessment_passed" }
          }
        },
        "credential": "credential_01J8Z3N5K7Q2W4E6R8T0Y2V4X7"
      }
    },
    "openai-atlas": {
      "kind": "provider_account",
      "config": {
        "available": true,
        "provider": "openai",
        "account": "org-atlas",
        "credential": "credential_01J8Z3N5K7Q2W4E6R8T0Y2V4X6",
        "default": true
      }
    },
    "atlas-llm": {
      "kind": "provider_account",
      "config": {
        "available": true,
        "provider": "openai-compatible",
        "baseUrl": "https://llm.atlas.internal/v1",
        "models": [
          { "id": "qwen3-coder", "contextWindow": 32768, "maxTokens": 8192 }
        ],
        "credential": "credential_01J8Z3N5K7Q2W4E6R8T0Y2V4X8",
        "default": false
      }
    },
    "general-main": {
      "kind": "worker",
      "config": {
        "worker": "general@1",
        "instanceCount": 1,
        "entries": [{ "agent": "swe@1", "providerAccount": "openai-atlas" }]
      }
    }
  }
}
```

The repository credential in this example is an `api_key` of GitHub.

Common to every `config`:

- `available` applies to the repository, provider account and source kinds. It is a required boolean with no default.
- `false` prevents subsequent resolution. It revokes no upstream authority and cancels no operation in flight.
- A worker binding holds no `available`; `instanceCount: 0` makes it unavailable.

### Repository configuration — proposed fields

- `platform`: **required**, supported platform-name string; no default and no
  inference from the address. Proposed first value `github`; display name
  GitHub. The platform set is extensible, not an arbitrary accepted string.
- `address`: **required**, nonblank SSH repository address; no default. An HTTPS address fails. The adapter validates and normalizes the repository address.
- Unsupported addresses and contradictory platform/address combinations fail.
- `strategy`: **required**, `RepositoryStrategy` object below. It has no inferred base branch, action or trigger.
- `credential`: **required**, one `CredentialId` of type `api_key` of the platform; no default. It serves every platform action and the observer read. Git uses the SSH configuration of the host.
- `projectPrompt`: **optional**, string, absent by default. Absence contributes no binding-provided prompt to Worker prompt composition.
- The project prompt holds at most 32768 UTF-8 bytes. A larger value refuses the write with `project.bindings.repository.project_prompt_too_large`.
- The JSON file holds the prompt text, not a client-side path.

`RepositoryStrategy` contains:

- `baseBranch`: **required**, nonblank string accepted as a branch by the
  repository adapter; no default such as `main`. It is the node-branch origin
  and the merge/push target of the configured action.
- `action`: **optional**, one `PolicyAction` object; absence means no repository action. A repository strategy holds at most one action.

Each `PolicyAction` holds only:

- `name`: **required**, enum `pull_request | merge_push`; no default.
- `follows`: **required**, one of two closed shapes; no default:
  - `type: "assessment_passed"`, with no other members.
  - `type: "action_end_state"` and a required `binding` as a binding-name string, with no other members.

The action rules follow the [GitHub action catalog](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md).

- The `action_end_state` shape identifies the configured action of another binding for the same node.
- Absent references and invalid dependency cycles fail validation.
- `pull_request` opens a pull request from the node branch into the base branch. It requires the platform action capability and expects the merge of that pull request.
- `merge_push` merges the node branch into the base branch and pushes. It requires the network git write capability and expects the push to the base branch.
- Each action implies its expected end state and takes no parameter.

Coverage and suitability follow [Repository configuration and policy](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.md#repository-configuration-and-policy).

- Every repository binding requires one platform API key, even for a repository that permits a public read.
- No public-read input exists, and an absent credential refuses the write.
- Git operations use the SSH configuration of the host and require no credential reference.
- Provider inference accepts `api_key` and `oauth` as the [credential store record](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-credential-store-record) rules.
- These checks read no secret material and assert no narrower upstream scope.

### Worker and agent configuration — proposed fields

A worker binding's `config` adds:

- `worker`: **required**, `WorkerName`; no default. It must name a registered
  static template. The planned initial native templates are `general@1` and
  `reviewer@1`; examples involving `tdd@1` do not make that worker available.
- `instanceCount`: **required**, integer from 0 to 64; no default. The value 0 makes the binding unavailable. An invalid value refuses the write with `project.bindings.worker.instance_count_range`.
- `entries`: **optional**, array of `AgentEntry`, absent by default, meaning
  every declared native agent uses its template defaults. Agent names must be
  unique. An external-harness worker **forbids** this field: its harness selects
  and authenticates inference outside Project resolution.

Each `AgentEntry` contains:

- `agent`: **required**, exact `AgentName` declared by this worker; no default.
- `providerAccount`: **optional**, binding-name string for a provider-account binding;
  absent means use the project's default account for the provider named by
  this agent's template default configuration. It does not mean choose any
  available account.
- `modelIdentifier`: **optional**, nonblank model-identifier string, absent means the
  template default. Selecting an account at a different provider makes this
  field required. Validation checks the effective configuration as a whole.
- `reasoningEffort`: **optional**, enum `off | minimal | low | medium | high | xhigh | max`; absence selects the template default.

The [worker template registry](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-worker-template-registry) defines the override rules.

- An entry must override at least one of `providerAccount`, `modelIdentifier` and `reasoningEffort`.
- The write and the resolution check the reasoning effort against the levels of the effective model.
- An unsupported level refuses use with `project.bindings.worker.reasoning_effort_unsupported` under the [validation rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#validation).
- `general@1` and `reviewer@1` declare no further option; their option schema is empty.
- The template has no configuration version of its own; the whole worker name selects its declaration.
- A worker binding holds no provider account at its root.
- Two bindings of the same worker can have equal configuration and independent instance counts.

### Provider-account configuration — proposed fields

- `provider`: **required**, a pi-ai 0.86.0 built-in provider id or `openai-compatible`; no default.
- `account`: **required** for a built-in provider and forbidden for `openai-compatible`. It is a nonblank string with no default. The service trims it and keeps its case, because provider account ids are case-sensitive.
- `baseUrl`: **required** for `openai-compatible` and forbidden otherwise. It is the server base URL, with scheme `https` or `http`, no query and no fragment.
- `models`: **required** for `openai-compatible` and forbidden otherwise. It is the model list that the human approves after the provider check.
- `credential`: **required**, `CredentialId` suitable for the model inference call; no default. The record type must match an auth type of the provider. `apiKey` maps to `api_key`, and `oauth` maps to `oauth`. The custom provider accepts `api_key` only.
- `default`: **required**, boolean; no default. A project has at most one default account per provider. A complete-set edit changes the default and clears the other mark.

Each custom model entry holds:

- `id`: **required**, a model id from the check answer at approval.
- `contextWindow`: **required**, positive integer; the human enters it at review.
- `maxTokens`: **required**, positive integer, at most `contextWindow`; the human enters it at review.
- `reasoning`: **optional**, boolean, default `false`.
- `input`: **optional**, subset of `text | image`, default `["text"]`.
- No cost field; the resolution sets zero cost rates.

The [provider contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-credential-store-of-an-execution) and the [validation rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#validation) define the catalogs and custom provider.

- A built-in provider id is a member of `getBuiltinProviders()` of `@earendil-works/pi-ai` at 0.86.0.
- The effective `modelIdentifier` is a member of `getBuiltinModels(provider)`, or of `models` of the binding for `openai-compatible`.
- The write and the resolution check both catalogs; a pi version bump changes both catalogs.
- Resource identity examples are `openai:account:org-atlas` and `openai-compatible:account:llm.atlas.internal`.
- The custom provider account is the lower-cased host of its base URL, without the scheme, port, path or version.
- A host change replaces the binding. A change of the scheme, port, path or model list creates a revision.
- Before the `BEGIN IMMEDIATE` transaction, the write calls `GET <baseUrl>/models` once per added or changed `openai-compatible` configuration.
- The call uses custody `use` with a 10 s deadline.
- A connection other than `ok` refuses the write with `project.bindings.provider.unreachable`; the error names the connection value.
- An absent model id refuses the write with `project.bindings.provider.model_unknown`; the error names the id.
- An unchanged binding makes no call. The resolution makes no network call.

The selected provider account determines an agent's effective provider. An
explicitly selected disabled or revoked account prevents use; it authorizes
no fallback. With no explicit account and no applicable default, the effective
configuration is invalid. No implicit choice of the first account is allowed.

### Source configuration — partially blocked

The general design requires one binding per accepted delivery source. The
implementation proposal derives a GitHub verification secret from the source
binding identity and its rotation counter. Proposed `config` fields are:

- `platform`: **required**, supported platform string; no default. Only GitHub
  has a first-version platform design.
- `repository`: **required for the proposed GitHub source**, binding-name string
  for its repository binding; no default. This field and association are a wire
  proposal pending the source schema, not an established payload contract.
- `webhookSecretRotation`: **required**, integer, no default. Proposed domain
  is a nonnegative safe integer; an initial counter and permitted increment
  rule must be declared. A change produces a new derived secret and a binding
  revision. Ordinary reads reveal the counter, not the secret.

The complete source-binding schema remains **[blocked][project-contract]**.
The first version holds the GitHub platform entry alone and accepts no inline secret in the binding set.

### Write validation and effects

`binding apply` validates the whole submitted set before committing it in one
Project transaction. It compares the supplied version with the current
version and refuses a stale one. No network operation belongs in that
transaction. The target rules are:

- One binding per repository, provider account and delivery source; any number per worker.
- Resource identity derives from configuration. A repository identity derives from its SSH address alone.
- Every repository binding write performs one `git ls-remote` with a 30 s deadline before the transaction.
- A failed or timed-out read refuses the write with `project.bindings.repository.ssh_unreachable`.
- A strategy with more than one action refuses the write.
- The write refuses a reference to an absent, removed, wrong-kind, or other-project
  binding. A reference names a binding in the submission. Constraints involving
  references that other services own need an explicit contract; the CLI does not
  silently rewrite mission nodes.
- The [binding-set write ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-write-of-a-binding-set)
  defines identity and revision comparison by binding name. The transaction
  resolves references to identities before configuration comparison and storage.
  Ordinary read results carry persistent binding references; export uses names.
- The write refuses a change to the worker of an existing worker binding under
  the same binding name, under the [validation ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#validation).
  A human removes the old binding and adds a binding with another name in the
  same edit.
- Removal keeps the binding rows and every revision for the life of the project. No sweep deletes them.
- Every committed write increments the binding-set version, even when the
  submitted set is identical. Empty and no-change submissions are still
  mutations, not read or validation commands.

Proposed result fields are `projectId`, the new `bindingSetVersion`, `bindings`
(an object keyed by binding name with current binding metadata/configurations),
and `changes`. Each `bindings` value includes its `id`, so the result maps each
current binding name to its identity. Each `changes` item has required `kind`
(`created | revised | removed | unchanged`) and required `bindingId`.
A resource change produces a removal and a creation. Exact result schemas
require contract review.

Use this one write operation to add repositories, add workers, configure
agents, allocate provider accounts, change repository strategy, switch a
default provider account, set instance counts, enable/disable a binding,
replace a resource, remove a binding, or rotate a source counter. There is no
separate partial-update route for each field. A future convenience command
would still need the same explicit version and atomic complete-set semantics.

Write-time validation does not reserve future use. Every operation resolves
and validates current bindings again, records the revisions it selected, and
authorizes one use only. A previously recorded revision cannot bypass later
disablement, replacement, revocation, or claim loss.

## Credential records and custody

Inputs:

- `<credential-id>`: required `CredentialId` on `get` and `rotate`, no default;
  path `credentialId`. A record is shared server-wide, not scoped by a project.
- `--type <type>`: optional single-use enum on `list`, proposed values
  `api_key | oauth`, absent means both supported types; query `type`.
- `--remote-identity <identity>`: optional single-use `RemoteIdentity` on
  `list`, absent means no identity filter; exact-match query `remoteIdentity`.
- [`--file`](./common-flags.md#--file): required on `create` and `rotate`. Its
  proposed secret-file policy is a regular non-symlink file at mode `0600`,
  validated before reading;
  no silent permission repair. This policy needs adoption alongside the
  material schema. The contents are sent to custody and never echoed.

### OAuth login

```text
kanthord project credential login <provider> [--mode browser|device] --name <name> --remote-identity <value> [M] [R]
kanthord project credential login-code <session> <value> [M] [R]
kanthord project credential login-status <session> [R]
```

The [OAuth login ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-oauth-login) declares all three operations with `human` access.
The inventory proposes their HTTP paths; the operations remain unimplemented.
`login` sends the provider id, mode, credential name and remote identity to `project.credential.login`.
`--name <name>` is required, has no default and uses the credential name form of the creation body below.
The login session checks the credential name at the start and at the commit.
A taken name answers 409 `project.credential.name_conflict` with the holder identity in `error.details`.
The proposed mode mapping sends `device_code` for `device`; `browser` retains its spelling.
A provider with one mode ignores the input mode.
The command prints the session identity, address to open and code, one per line, and exits with zero.
`login-code` sends the session identity and value to `project.credential.login_code`.
The value is a code or a redirect URL, not a record secret, so it travels on the command line.
The operation answers 409 when the session awaits no value.
`login-status` reads `project.credential.login_status` and prints the state, last message and failure reason as JSON.
A session identity has the form `login_session_<ulid>`; a session expires after 15 minutes.
A second pending session for the same provider and human receives 409.
No command reads a prompt or outputs a token.
The shared JSON output convention does not replace the line output of `login`.

### Credential request files — proposed schemas

Creation body:

- `name`: **required**, credential name, 1 to 63 characters; no default. A lower-case letter comes first, then lower-case letters, digits and hyphens.
- `type`: **required**, value `api_key` for direct entry, no default. OAuth entry uses the login session.
- `remoteIdentity`: **required**, `RemoteIdentity`, no default. The platform and
  record type must be consistent with the supported type registry.
- `material`: **required**, closed type-specific object, no default:
  - For `api_key`: required `apiKey`, nonempty string containing a supported
    git-platform personal access token or model-provider key. No default;
    preserve exact bytes represented by the JSON string. Provider-specific
    syntax and size bounds require the type schema.

Rotation body:

- `material`: **required**, the type-specific object that the record type determines. No default.
  The body has no `name`, `type`, `remoteIdentity`, binding reference or credential ID; the path identifies the record.

The [Project lifecycle ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#revision-disablement-and-rotation) permits material replacement behind a stable credential reference.
This command provides no way to rotate `masterKey`.

Creation returns metadata with proposed fields `id`, `name`, `type`, `remoteIdentity`,
`createdAt`, and `updatedAt`. `get` returns that metadata and `list.items`
contains it. No result contains material, ciphertext, nonce, authentication
headers, or a reusable grant. These commands do not test upstream access.

Rotation changes material of the same record for the same remote identity;
existing credential references remain valid. It returns the updated metadata
and has no binding-set or binding-revision effect. Custody attributes creation
and each material change to the authenticated human in its log. A credential leaves the server only through the [credential handover](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-credential-handover) or the direct acquisition grant.
Rotation and OAuth refresh update the record in place and create no revision. Rotation commits in one transaction, and the last write wins.

The remote identity of a credential store record never changes; rotation keeps it.
A credential for another remote is a new record from `credential create`.
Each binding adopts it with a `binding apply` that changes its `credential`, which creates a revision.

There is no credential export, delete, local-revocation, refresh,
GitHub-App-token mint, or master-key-rotation command. Upstream revocation and
expiry are different events from local disablement and material rotation.
Their failure recording and recovery behavior are still design work, not
commands with invented semantics.

## Provider check

The [provider check contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-provider-check) defines `project.provider.check`, a server-wide read with `human` access.
Its proposed route is `POST /api/project/provider/check`, with no project or binding.

Input:

- `--base-url <url>`: required; body field `baseUrl`. The URL scheme is `https` or `http`; a query or a fragment is invalid.
- `--credential <credential-id>`: required `CredentialId`; body field `credential`. The record type is `api_key`.
- The body holds only `{ baseUrl, credential }`. The command uses `[R]` and no `[M]`.

Output and errors:

- HTTP 200 holds `connection`: `ok`, `unauthorized`, `unreachable` or `invalid_response`.
- `ok` means the answer has the OpenAI list shape.
- `unauthorized` means remote HTTP 401 or 403.
- `unreachable` means a network failure or the 10 s deadline.
- `invalid_response` means the answer does not have the OpenAI list shape.
- `models` is present only with `ok`; each entry holds `id`, `ownedBy` and `created`.
- HTTP 400 answers invalid input or a record type other than `api_key`.
- HTTP 404 answers an unknown credential.
- The answer holds no key material.

## Provider accounts and effective agent views

Inputs:

- `<project-id>`: required `ProjectId` on each command, no default; path
  `projectId`.
- `<binding-id>`: required `BindingId` on provider-account `get`, no default;
  path `bindingId`. Must be a provider-account binding of this project.
- `<worker-binding-id>`: required `BindingId` on both agent commands, no
  default; path `bindingId`. Must be a worker binding of this project.
- `<agent-name>`: required `AgentName` on agent `get`, no default; path
  `agentName`. Must be declared by the selected native worker template.

No command here has a body or mutation/replay option. The provider-account
commands inject `kind=provider_account` into the binding routes. Their list
uses `state=current` and exposes no additional filter flags. Results are the
same binding records, with `default`, `available`, provider and credential reference.
A built-in provider has `account`; a custom provider has `baseUrl` and `models`.
These commands list no provider credentials and create no independent provider resource.

Agent views propose read-only inspection of template defaults, explicit
overrides, and the resulting configuration for this project binding. These
are not the global worker/agent catalogs, which belong to the Worker CLI.
The list pages the declared agents of the selected template; `get` selects
one. Proposed item fields are:

- `agent`, `worker`, `workerBindingId`, and `bindingSetVersion`.
- `defaults` and `overrides`, whose exact fields are the template's schema.
- `effective`, present only when the service can form and validate the configuration. It holds the resolved provider-account binding, model and `reasoningEffort`. The response must not replace an invalid result with a fallback.
- `revisions`, an array of `{ bindingId, revision }` for the inspected dependency
  chain, including selected provider account and applicable default account.
- `valid`, boolean; and `issues`, an array of proposed `{ path, code }` objects
  describing invalid configuration without secret values. `path` is an array
  of field-name strings and `code` is a nonempty diagnostic-code string.

The operation contracts must settle exact fields, consistent-read behavior,
and the handling of an unavailable or externally hosted worker. Proposed
external-harness behavior is refusal with a diagnostic that Project owns no
effective native-agent configuration for that binding. These views neither
mint an authorization grant nor authorize inference. They make no remote
healthcheck, reserve no capacity, and do not validate a live execution claim.

Provider healthcheck remains **blocked** under [HANDOFF Cannot progress](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#cannot-progress); this page specifies no healthcheck command.

## Source verification secret

**[Blocked command proposal][project-contract].** `<project-id>` is a required `ProjectId` with no
default, mapped to path `projectId`. `<source-binding-id>` is a required
`BindingId` with no default, mapped to path `bindingId`; it must identify this
project's supported source kind. There is no body, page option, file option,
or idempotency option.

The [delivery verification ruling](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-verification-of-a-delivery) declares the secret GET and the address `/hooks/<binding id>`.
Repeated reads return the current secret without rotation or mutation replay storage.
The CLI display contract remains **blocked** under [HANDOFF Project Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service).

To request a rotation under the target binding model, change the explicit
`webhookSecretRotation` in a complete `binding apply` submission with its
version. Once defined, the read command retrieves the new value for the human
to paste upstream. A rotation revises the binding; the old signature must fail
at the next verification. No overlap/grace window or upstream subscription
update is implied. The source schema and secret display remain **[blocked][project-contract]**.

## Service boundaries: effects that are not commands

- Authorization, `resolveWorkerBinding`, per-operation resolution,
  one-use grants, `use(grant, request)`, and credential-reference validation are
  runtime mechanisms. This page creates no `resolve`, `authorize`, `grant`,
  `use`, or generic execute-with-credential command from them.
- Execution custody derives a remote destination from the checked binding. The human provider check accepts `baseUrl` under its separate contract.
- Git operations, platform actions and inference stay in their execution protocols. A local commit, branch and merge are not authenticated capabilities.
- A machine execution must satisfy binding and live-claim checks on each use.
  An external harness also needs the matching authenticated client, live
  registration, worker binding, instance, claim, and node. CLI-supplied IDs
  alone cannot prove that chain.
- The Scheduler observer's internal read of an external object is not a human
  administration command. Its identity and association are service-owned; no
  `--service-identity` option exists.
- Delivery verification consumes exact bytes and headers, acts on no external
  resource, and mints no requester identity. No `project delivery verify`
  command or caller-supplied human mapping is derived from it. The delivery
  ingress and inbox duplicate effects belong to their owning protocols.
- Client identities are generated by the existing local `jwt --binding`
  command, and registration belongs to `worker register`. Project stores no
  client-identity secret or list. Project has no client-identity CRUD commands.
- Template installation, worker/agent catalogs, pools, registrations, and
  runtime lifecycle belong to Worker. Project owns bindings and their desired
  configuration; applying a binding does not itself claim work or register a
  caller's instance.

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
