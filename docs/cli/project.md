# Project CLI specification

[CLI specification index](./README.md) · [Shared conventions](./other.md)

This contributor specification covers the future `kanthord project` group:
project identity, resource bindings, repository policy, provider-account and
agent configuration, credential custody, and source verification secrets.
It is self-contained in an engine checkout.

**Status: no Project operation command is implemented.** All command spellings,
operation IDs, routes, JSON field names, defaults, and output shapes below are
**proposals pending Project contracts and generated OpenAPI**. A design rule
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
**19 leaf commands**, including explicitly blocked credential-rotation and
secret-display commands. The existing help group is not counted. The
[calling convention](#common-proposed-calling-convention) defines the shared
options used by those synopses; the resource sections define their inputs,
results, and effects without repeating the command syntax.

The proposal preserves the existing group spelling and `--endpoint` option.
All additions remain under `project`; the complete top-level set stays
`project`, `mission`, `scheduler`, `worker`, `tracking`, `gateway`, `config`,
`serve`, and `jwt`.

## Common proposed calling convention

The rules in [other.md](./other.md) apply to every command. Every synopsis
starts with `kanthord project` and uses the
[common synopsis notation](./common-flags.md#synopsis-markers).

| Named flag set                                                   | Applies to            |
| ---------------------------------------------------------------- | --------------------- |
| [`[R]` — Remote flags](./common-flags.md#remote-flags-r)         | All 19 remote leaves. |
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
- `BindingId`: opaque server-returned binding identity. The design requires a
  prefixed ULID but **has not declared its prefix**. No example or schema here
  invents one. Kind- and project-membership checks belong to the server. Final
  lexical validation is blocked on the owning contract.
- `CredentialId`: opaque server-returned credential-record identity. A stable
  prefix and its schema have not been declared; do not guess `credential_`.
- `Revision` and binding-set `version`: JSON safe integers returned by the
  service, copied without arithmetic by the caller. Their initial values and
  valid lower bounds remain contract decisions. A supplied revision/version
  must identify a value the server issued. No floating point or numeric string.
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

See the local [identity helper](../../src/kernel/identity.ts) for the current
prefixed-ULID mechanism. The presence of that helper does not declare a
Project entity prefix.

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
This specification promises no exactly-once behavior across restart. Project
create, credential create/rotate, and rename still need their durable natural
key or reconciliation contract. A binding-set edit has a version precondition,
but a retry after a committed edit and restart can encounter a stale version
instead of replaying the old answer.

## Proposed command inventory and synopsis

Every entry below is **proposed and unimplemented**, including the operation ID
and HTTP path. No listed route is published by the current empty Project
contract. Each row is one leaf command; its synopsis follows `kanthord project`
and includes every positional argument, command-specific option, and applicable
shared-option marker. Route parameters are placeholders, and path resource
names are singular.

All 19 commands have `[R]` and `human` access. The five mutations have `[M]`;
the six paginated lists have `[L]`. Commands marked **blocked** additionally
require the design decisions identified in their resource sections.

| #   | Synopsis after `kanthord project`                                         | Proposed HTTP route                                                    | Proposed operation ID             | Access/status                  |
| --- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------- | ------------------------------ |
| 1   | `create --name <name> [M] [R]`                                            | `POST /api/project`                                                    | `project.create`                  | `human`; proposed              |
| 2   | `list [L] [R]`                                                            | `GET /api/project`                                                     | `project.list`                    | `human`; proposed              |
| 3   | `get <project-id> [R]`                                                    | `GET /api/project/:projectId`                                          | `project.get`                     | `human`; proposed              |
| 4   | `rename <project-id> --name <name> [M] [R]`                               | `PATCH /api/project/:projectId`                                        | `project.rename`                  | `human`; proposed              |
| 5   | `binding list <project-id> [--kind <kind> ...] [--state <state>] [L] [R]` | `GET /api/project/:projectId/binding`                                  | `project.binding.list`            | `human`; proposed              |
| 6   | `binding get <project-id> <binding-id> [R]`                               | `GET /api/project/:projectId/binding/:bindingId`                       | `project.binding.get`             | `human`; proposed              |
| 7   | `binding export <project-id> [R]`                                         | `GET /api/project/:projectId/binding-set`                              | `project.bindingSet.get`          | `human`; proposed              |
| 8   | `binding apply <project-id> --file <path> [M] [R]`                        | `PUT /api/project/:projectId/binding-set`                              | `project.bindingSet.write`        | `human`; proposed              |
| 9   | `binding revision list <project-id> <binding-id> [L] [R]`                 | `GET /api/project/:projectId/binding/:bindingId/revision`              | `project.bindingRevision.list`    | `human`; proposed              |
| 10  | `binding revision get <project-id> <binding-id> <revision> [R]`           | `GET /api/project/:projectId/binding/:bindingId/revision/:revision`    | `project.bindingRevision.get`     | `human`; proposed              |
| 11  | `credential create --file <path> [M] [R]`                                 | `POST /api/project/credential`                                         | `project.credential.create`       | `human`; proposed              |
| 12  | `credential list [--type <type>] [--remote-identity <identity>] [L] [R]`  | `GET /api/project/credential`                                          | `project.credential.list`         | `human`; proposed              |
| 13  | `credential get <credential-id> [R]`                                      | `GET /api/project/credential/:credentialId`                            | `project.credential.get`          | `human`; proposed              |
| 14  | `credential rotate <credential-id> --file <path> [M] [R]`                 | `PUT /api/project/credential/:credentialId/material`                   | `project.credential.rotate`       | `human`; proposed, **blocked** |
| 15  | `provider-account list <project-id> [L] [R]`                              | `GET /api/project/:projectId/binding?kind=provider_account`            | `project.binding.list`            | `human`; proposed              |
| 16  | `provider-account get <project-id> <binding-id> [R]`                      | `GET /api/project/:projectId/binding/:bindingId?kind=provider_account` | `project.binding.get`             | `human`; proposed              |
| 17  | `agent list <project-id> <worker-binding-id> [L] [R]`                     | `GET /api/project/:projectId/binding/:bindingId/agent`                 | `project.agentConfiguration.list` | `human`; proposed              |
| 18  | `agent get <project-id> <worker-binding-id> <agent-name> [R]`             | `GET /api/project/:projectId/binding/:bindingId/agent/:agentName`      | `project.agentConfiguration.get`  | `human`; proposed              |
| 19  | `source secret get <project-id> <source-binding-id> [R]`                  | `GET /api/project/:projectId/binding/:bindingId/secret`                | `project.sourceSecret.get`        | `human`; proposed, **blocked** |

The credential routes are server-wide despite their service namespace; they
contain no `projectId`. Contract review must verify that static `/credential`
paths cannot be captured by `/:projectId`. Provider-account views reuse the
binding operations and add a required kind constraint; they create no second
provider-account store. There are 17 distinct proposed route operations for
the 19 CLI leaves.

## Project resource

Inputs:

- `<project-id>`: required `ProjectId` for `get` and `rename`; no default.
  Maps to path `projectId`.
- `--name <name>`: required nonblank string for `create` and `rename`; no
  default. Preserve the supplied value. Maps to body `name`. The maximum size,
  uniqueness, and normalization rules are open; no slug or ID is derived from
  it. Rename is a proposed convenience over the stored project name, not an
  already-declared lifecycle operation.
- `list` has only the shared page and client options. No name filter, sort
  order, or current-project inference is implied. List ordering and cursor
  consistency must be declared in the contract.

`create` and `rename` each send exactly `{ "name": <string> }`; there are no
other request fields. Read commands have no body. Proposed project metadata is
`id`, `name`, `bindingSetVersion`, and `createdAt`, with the scalar types above.
`list.items` holds that metadata; `get` returns one project.

Creation allocates a project identity and proposes an initially empty binding
set. The server returns the initial version rather than making the client
assume it is `0` or `1`. A mission belongs intrinsically to its project; it is
not a binding. The ownership and recovery of any initial Mission creation
must be specified before Project creation promises that effect. Rename keeps
the same project identity and bindings. Its concurrency semantics remain open.

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
  `current | removed | replaced | all`, default `current`; query `state`.
  Historical availability is subject to the unresolved retention policy.
- [`--file`](./common-flags.md#--file): required for `apply`; content is the
  complete `BindingSetWrite` object defined below. No patch, merge, or partial-set mode.

`binding list` returns a page of binding metadata and current configuration.
`binding get` returns one binding, its current revision, configuration, and
proposed metadata `id`, `projectId`, `kind`, `resourceIdentity`, `createdAt`,
optional `removedAt`, and optional `replacedBy`. `resourceIdentity` is a
server-derived normalized string and is absent for worker bindings. Kind and
state filters, `limit`, and `cursor` are the only list query fields; the reused
provider-account views add their kind constraint as described below. Ordinary
`binding get` has no kind query; the provider-account variant supplies one
required enum value and must reject a wrong-kind target.

`binding export` reads one consistent, complete current set and prints exactly
the proposed `BindingSetWrite` shape, ready to save to a named JSON file and
edit. It is not paginated and contains no secret material. It includes the
version used by `apply`. Existing entries receive stable-in-this-document
local keys and their IDs. Output size limits and snapshot consistency need
contracts; concatenating pages of `binding list` is not a substitute for this
read. Shell redirection of this ordinary JSON is permitted.

`binding revision list` returns a page of immutable revision metadata;
`binding revision get` returns the selected configuration and its
`bindingId`, `revision`, and `createdAt`. Both report retained history, not an
authorization grant. Retention duration and whether a retired binding's last
revision is returned through ordinary `get` remain open. No revision rollback
command is proposed; copying an old configuration into a new complete-set
write is subject to current validation.

### `BindingSetWrite` request file — proposed schema

The JSON file is the HTTP body. Path `projectId` supplies its project; no body
field can redirect the edit. Required fields have no default. Optional fields
are absent by default, and `null` is invalid unless a future contract explicitly
permits it. Each object is closed except template- or platform-owned objects
whose schemas are explicitly blocked below.

- `version`: **required**, `Revision`-like safe integer holding the exact
  binding-set version previously read. No automatic fetch-and-retry or force
  override on a stale version.
- `bindings`: **required**, array of `BindingEdit`; `[]` explicitly requests
  removal of every current binding and succeeds only if all reference
  constraints allow it. There is no default empty array.

Each `BindingEdit` contains:

- `key`: **required**, nonblank string, unique within this submission. It is a
  document-local reference label, not a persisted entity identity or a worker
  name. Length and character bounds await the request schema.
- `id`: **optional**, existing current `BindingId` in this project. Use it to
  preserve the identity when the resource is unchanged. No default. Mutually
  exclusive with `replaces`.
- `replaces`: **optional**, current `BindingId` in this project. It explicitly
  identifies the predecessor of a replacement. No default; mutually exclusive
  with `id`. Omitting both proposes a new binding. A predecessor cannot be
  retained or replaced twice in the same set.
- `kind`: **required**, enum `repository | worker | provider_account | source`.
  An existing identity cannot change kind.
- `config`: **required**, the kind-specific object below.

Every reference between bindings is a proposed `BindingRef` object with
**exactly one required member**: `bindingId` (`BindingId` retained in this
submitted set), or `key` (nonblank string matching an entry's local `key`).
There is no default and no revision field. References never identify a
different project. The local-key representation and the allocation/repointing
protocol are **new wire proposals**: the design requires one atomic edit but
has not decided how clients refer to new server-generated binding IDs. This
scheme must be accepted in the contract before implementation.

Common to every `config`:

- `available`: **required**, boolean, no default. This proposed field encodes
  local availability/disablement. `false` must prevent subsequent resolution;
  it does not revoke upstream authority or cancel an operation in flight.

### Repository configuration — proposed fields

- `platform`: **required**, supported platform-name string; no default and no
  inference from the address. Proposed first value `github`; display name
  GitHub. The platform set is extensible, not an arbitrary accepted string.
- `address`: **required**, nonblank repository address in SSH or HTTPS form;
  no default. The adapter validates and normalizes its remote repository.
  Unsupported transports and contradictory platform/address combinations
  fail. Changing SSH to HTTPS for the same repository changes configuration,
  not resource identity.
- `strategy`: **required**, `RepositoryStrategy` object below. No inferred base
  branch, merge behavior, action, trigger, or expected end state.
- `credentials`: **required**, object of conditional credential references.
  Proposed optional members `gitRead`, `gitWrite`, and `platformAction` each
  hold a `CredentialId`, absent by default. Each becomes required exactly when
  the configured strategy and address require that authenticated capability.
  `{}` is valid only when no authenticated capability is needed. Public read
  has no capability and needs no credential reference.
- `projectPrompt`: **optional**, string, absent by default. Absence contributes
  no binding-provided prompt to Worker prompt composition. Its fixed length
  bound, empty-string meaning, and exact validation are **blocked**; no bound
  is invented here. Prompt text is carried inside the JSON file, not loaded
  from a client-side path hidden in the document.

`RepositoryStrategy` contains:

- `baseBranch`: **required**, nonblank string accepted as a branch by the
  repository adapter; no default such as `main`. It is the node-branch origin
  and the merge/push target of the configured action.
- `actions`: **required**, array of `PolicyAction`; no default. An empty array
  is a proposed explicit no-external-action choice only where the final policy
  contract permits it. It must not silently waive a required repository rule.

Each proposed `PolicyAction` contains:

- `key`: **required**, nonblank action key unique on this binding; no default.
- `action`: **required**, supported platform-action natural key; no default.
  Opening a pull request and merge-and-push are design examples, not a closed
  wire enum. The accepted action set is **blocked on the platform schema**.
- `follows`: **required**, one of two proposed closed shapes, with no default:
  - `type`: required enum value `assessment_passed`, with no other members.
  - `type`: required enum value `action_end_state`; required `binding` of type
    `BindingRef`; required nonblank string `actionKey`; no other members. This
    identifies another configured action of the same node. Dangling references
    and invalid dependency cycles fail validation.
- `expectedEndState`: **required**, platform-owned nonempty state string; no
  default. For example, a pull request's merge or the push to the base branch.
  Exact state names and action/state compatibility are **blocked**.
- `parameters`: **optional**, platform-action-specific JSON object, absent by
  default. Its fields and any required parameters are **blocked on the action
  schema**; this is not permission to forward unchecked arbitrary JSON.

Coverage and suitability are the whole credential-reference validation:
SSH git read/write require an SSH key; HTTPS git read/write require a suitable
git-platform API key in the first version. Platform actions require a suitable
git-platform API key under either transport. One record can cover multiple
capabilities. An SSH key cannot satisfy a platform action. General design also
allows OAuth, but the first planned credential registry contains no OAuth type.
These checks read no secret material and do not assert narrowed upstream scope.
The wire representation of an explicit unauthenticated/public-read choice is
still a repository-schema decision; missing credentials alone cannot silently
turn a required authenticated read into a public one.

### Worker and agent configuration — proposed fields

A worker binding's `config` adds:

- `worker`: **required**, `WorkerName`; no default. It must name a registered
  static template. The planned initial native templates are `general@1` and
  `reviewer@1`; examples involving `tdd@1` do not make that worker available.
- `instanceCount`: **required**, safe integer; no default. Proposed range starts
  at `0`, meaning zero instances; the accepted lower bound and maximum are
  contract decisions, so zero is not yet a promised disablement mechanism.
  Local disablement is explicitly `available: false`.
- `entries`: **optional**, array of `AgentEntry`, absent by default, meaning
  every declared native agent uses its template defaults. Agent names must be
  unique. An external-harness worker **forbids** this field: its harness selects
  and authenticates inference outside Project resolution.

Each `AgentEntry` contains:

- `agent`: **required**, exact `AgentName` declared by this worker; no default.
- `providerAccount`: **optional**, `BindingRef` to a provider-account binding;
  absent means use the project's default account for the provider named by
  this agent's template default configuration. It does not mean choose any
  available account.
- `modelIdentifier`: **optional**, nonblank model-identifier string, absent means the
  template default. Selecting an account at a different provider makes this
  field required. Validation checks the effective configuration as a whole.
- `options`: **optional**, JSON object containing only options the template
  permits overriding; absent leaves its defaults intact. The template owns
  each option's type, permitted values, and whole-configuration constraint.
  **Blocked:** actual per-template keys/defaults/bounds have not been declared
  by the Project CLI contract. An example such as reasoning effort `high`
  does not declare a universal `reasoningEffort` flag or schema.

An entry must override something; the proposed schema rejects an entry with
only `agent`. The template has no configuration version of its own; the whole
worker name selects its declaration. A worker binding holds no provider
account at its root. Two bindings of the same worker may have equal
configuration and independent instance counts.

### Provider-account configuration — proposed fields

- `provider`: **required**, supported provider-name natural key, no default.
  `openai` is an example, not an exhaustive provider registry. Supported names,
  model catalogs, and account normalization await the owning declarations.
- `account`: **required**, nonblank remote account identifier, no default.
  The service derives its resource identity, for example
  `openai:account:org-kanthorlabs`; the caller never supplies that derived value.
- `credential`: **required**, `CredentialId` suitable for the model-inference
  capability; no default. First-version material is an API key of that provider.
- `default`: **required**, boolean, no default. A project has at most one
  marked default account per provider. Changing the default is an explicit
  complete-set edit, including clearing the old mark.

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
- `repository`: **required for the proposed GitHub source**, `BindingRef` to
  its repository binding; no default. This field and association are a wire
  proposal pending the source schema, not an established payload contract.
- `webhookSecretRotation`: **required**, integer, no default. Proposed domain
  is a nonnegative safe integer; an initial counter and permitted increment
  rule must be declared. A change produces a new derived secret and a binding
  revision. Ordinary reads reveal the counter, not the secret.

**Blocked request fields:** webhook subscriptions, delivery classification,
inbound work-request behavior, and human-identity mapping have no completed
source-binding schema. This page deliberately defines no permissive
`subscriptions` or `identityMapping` object in their place. The three fields
above cannot be advertised as a complete writable source schema until that
gap is settled. Slack, Telegram, and Jira platform entries are not enabled by
examples or by the generic `source` kind. No secret is accepted inline in the
binding set; the GitHub proposal derives it server-side.

### Write validation and effects

`binding apply` validates the whole submitted set before committing it in one
Project transaction. It compares the supplied version with the current
version and refuses a stale one. No network operation belongs in that
transaction. The target rules are:

- One binding per repository, provider account, and delivery source; any
  number per worker. Resource identity is derived from configuration and
  normalized across SSH/HTTPS addresses of the same repository.
- No reference to an absent, removed, replaced, wrong-kind, or other-project
  binding. Replacements must repoint every dependent binding in the same edit.
  Constraints involving references owned by other services need an explicit
  contract; the CLI must not silently rewrite mission nodes.
- Unchanged configuration keeps its revision. Changed configuration of the
  same resource, including availability or credential reference, creates a
  revision while preserving identity. Canonical JSON property reordering
  creates no revision. Proposed document-local references are resolved to
  server IDs before this comparison and storage; changing a local `key` alone
  must not revise a binding. Read results carry persistent binding references,
  not transient submission keys.
- A changed resource gets a replacement identity. A change of worker name
  must be classified by the contract despite worker bindings having no
  `resourceIdentity`. An entry using `id` cannot disguise a replacement.
- Omitted current bindings are removed and retain their rows. A removed
  binding has no successor; a replacement records its successor. Retention
  duration is unresolved.
- Every committed write increments the binding-set version, even when the
  submitted set is identical. Empty and no-change submissions are still
  mutations, not read or validation commands.

Proposed result fields are `projectId`, the new `bindingSetVersion`, `bindings`
(current binding metadata/configurations), and `changes`. Each `changes` item
has required `kind` (`created | revised | replaced | removed | unchanged`),
required `bindingId`, and optional `previousBindingId` for a replacement.
An optional `key` echoes the submission label for an allocated binding. Exact
result schemas and stable mapping of local keys require contract review.

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
  `ssh_key | api_key`, absent means both supported types; query `type`.
- `--remote-identity <identity>`: optional single-use `RemoteIdentity` on
  `list`, absent means no identity filter; exact-match query `remoteIdentity`.
- [`--file`](./common-flags.md#--file): required on `create` and `rotate`. Its
  proposed secret-file policy is a regular non-symlink file at mode `0600`,
  validated before reading;
  no silent permission repair. This policy needs adoption alongside the
  material schema. The contents are sent to custody and never echoed.

### Credential request files — proposed schemas

Creation body:

- `type`: **required**, enum `ssh_key | api_key`, no default.
- `remoteIdentity`: **required**, `RemoteIdentity`, no default. The platform and
  record type must be consistent with the supported type registry.
- `material`: **required**, closed type-specific object, no default:
  - For `ssh_key`: required `privateKey`, string containing an Ed25519 private
    key in PKCS#8 PEM. No default. Parsing validates the key type/algorithm.
    The proposed input accepts unencrypted PKCS#8; support for encrypted input,
    a passphrase field, or conversion of an OpenSSH-format key is **blocked**.
    No file path or public-key substitute is accepted inside this field.
  - For `api_key`: required `apiKey`, nonempty string containing a supported
    git-platform personal access token or model-provider key. No default;
    preserve exact bytes represented by the JSON string. Provider-specific
    syntax and size bounds require the type schema.

Rotation body:

- `material`: **required**, the same type-specific object dictated by the
  existing record. No default. The body has no `type`, `remoteIdentity`, binding
  reference, or credential ID; the path identifies the record.

**Blocked command scope:** the Project design requires replacement of material
behind a stable credential reference. The architecture defines a server secret as a field of the configuration file; a credential store record is a database row, so that prohibition does not cover resource credential rotation. This proposed command provides no way to rotate `masterKey`.

Creation returns metadata with proposed fields `id`, `type`, `remoteIdentity`,
`createdAt`, and `updatedAt`. `get` returns that metadata and `list.items`
contains it. No result contains material, ciphertext, nonce, authentication
headers, or a reusable grant. These commands do not test upstream access.

Rotation changes material of the same record for the same remote identity;
existing credential references remain valid. It returns the updated metadata
and has no binding-set or binding-revision effect. Custody attributes creation
and each material change to the authenticated human in its log. The intended
runtime boundary is that no credential leaves server-side custody during use;
credential upload is not a credential-export capability.

**Revision conflict:** the vocabulary's revision section says credential
rotation and OAuth refresh create credential-record revisions; its five-change
section says refresh creates none; the implementation sibling says rotation
updates the row in place and creates no revision anywhere. This spec therefore
does not promise a credential revision counter or history command. The clear
shared rule is that material rotation does not revise a binding.

A change of the remote that material authorizes is not rotation. It requires
replacement bindings in every referencing project and rejection of any
unrepointed binding. The marking/quarantine lifecycle, multi-project progress,
input schema, and route for declaring that change are **blocked**. Neither
`rotate` nor a hidden metadata edit can stand in for it. Creating another record
and replacing bindings needs that same lifecycle analysis; this page promises
no atomic multi-project replacement.

There is no credential export, delete, local-revocation, OAuth-login/refresh,
GitHub-App-token mint, or master-key-rotation command. Upstream revocation and
expiry are different events from local disablement and material rotation.
Their failure recording and recovery behavior are still design work, not
commands with invented semantics.

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
same binding records, including explicit `default`, `available`, provider,
account, and credential reference. They do not list provider credentials or
create an independent provider resource.

Agent views propose read-only inspection of template defaults, explicit
overrides, and the resulting configuration for this project binding. These
are not the global worker/agent catalogs, which belong to the Worker CLI.
The list pages the declared agents of the selected template; `get` selects
one. Proposed item fields are:

- `agent`, `worker`, `workerBindingId`, and `bindingSetVersion`.
- `defaults` and `overrides`, whose exact fields are the template's schema.
- `effective`, present only when the configuration can be formed and validated;
  its fields include resolved provider-account binding and model plus declared
  options. The response must not replace an invalid result with a fallback.
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

**Provider healthcheck remains blocked (B9):** no `check`, `test`, auto-disable,
or automatic-failover command is specified. The checking authority, freshness,
failure state, and effects on agents, instances, and in-flight execution remain
undecided. Missing health semantics cannot be replaced by a guessed boolean
in the account result.

## Source verification secret

**Blocked command proposal.** `<project-id>` is a required `ProjectId` with no
default, mapped to path `projectId`. `<source-binding-id>` is a required
`BindingId` with no default, mapped to path `bindingId`; it must identify this
project's supported source kind. There is no body, page option, file option,
or idempotency option.

The design calls for a human-only GET returning the current derived webhook
verification secret so a human can install it at the upstream platform.
Repeated reads would return the current secret without rotating it. The secret
does not enter mutation replay storage. The planned delivery address names the
source binding, conventionally `/hooks/<binding-id>` in the design, and contains
no secret. Its exact public path and ownership must be reconciled with Gateway
contracts rather than inferred from the proposed management route above.

**Blocked result contract:** the implementation proposal explicitly returns
this secret, while the broader no-secret-output/credential-custody rules and
the existing terminal-only JWT exception do not declare a general CLI display
exception for it. Decide whether source-verification material is a distinct
human-exportable class, then declare the response field, terminal or file
policy, redaction, and cache behavior. This page does not silently adopt JWT's
terminal rule or permit unrestricted JSON redirection for this command.

To request a rotation under the target binding model, change the explicit
`webhookSecretRotation` in a complete `binding apply` submission with its
version. Once defined, the read command retrieves the new value for the human
to paste upstream. A rotation revises the binding; the old signature must fail
at the next verification. No overlap/grace window or upstream subscription
update is implied. Those workflows remain blocked with the source schema.

## Service boundaries: effects that are not commands

- Authorization, `resolveWorkerBinding`, per-operation resolution,
  one-use grants, `use(grant, request)`, and credential-reference validation are
  runtime mechanisms. This page creates no `resolve`, `authorize`, `grant`,
  `use`, or generic execute-with-credential command from them.
- Custody derives a remote destination from the checked binding. There is no
  `--destination`, arbitrary URL forwarding, or secret injection flag that
  bypasses that binding. Git operations, platform actions, and inference remain
  in their execution protocols; local commit, branch, and merge are not
  authenticated capabilities by themselves.
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

## Decisions required before implementation

The inventory is a reviewable target, not a replacement for these decisions:

1. **Operations and schemas.** Declare the Project command table, route access,
   contract schemas, status/error codes, body bounds, timeout/cancellation,
   list ordering/cursors, and generated service-scoped OpenAPI. All spellings
   and routes in this page remain proposals until then.
2. **Identity and atomic input.** Declare the binding and credential prefixes,
   version/revision bounds, local-key allocation/replacement protocol,
   worker-name replacement rule, and the treatment of peer-owned references.
   HANDOFF explicitly leaves the binding prefix unresolved.
3. **Lifecycle and replay.** Decide project-name constraints, creation's
   relationship to Mission, rename concurrency, natural keys/reconciliation
   for mutations after restart, retention of retired bindings and revisions,
   and credential rotation concurrency. No destructive cleanup is inferred.
4. **Binding policy and templates.** Complete the repository action/trigger/
   state schemas, policy validation, project-prompt bound, instance-count
   bounds, supported provider catalog, model/option schemas, and static worker
   declarations. Do not turn example values into defaults.
5. **Sources and channels.** Complete webhook subscription/source
   configuration, inbound work classification, Slack human mapping, and the
   distinct channel binding and notification policy. A channel is not an
   accepted fifth binding kind here. Settle source-secret export/display and
   delivery-path contracts before shipping the blocked command.
6. **Credential lifecycle.** Define remote-change quarantine and cross-project repointing;
   settle OpenSSH-to-PKCS#8 conversion and any encrypted-key entry. OAuth,
   GitHub App installation credentials, and non-GitHub platform-specific
   custody are future extensions, not accepted input variants.
7. **Custody implementation.** HANDOFF still leaves the SSH socket/public-key/
   known-hosts creation sequence, required basenames, and orphan-directory
   cleanup unresolved. Both SSH and HTTPS remain required in the first design;
   omitting SSH is not the answer. Master-key replacement has no command or
   completed recovery workflow.
8. **Failure and recovery (B9).** Define provider healthcheck authority,
   freshness and disablement effects, credential-failure recording, uncertain
   repository-action reconciliation, and recovery after revocation or lost
   acknowledgement. A CLI replay key supplies neither those decisions nor a
   guarantee about external effects.

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
