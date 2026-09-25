# Mission CLI specification

[CLI index](./README.md) · [Shared CLI rules](./other.md)

## Status and scope

This is an internal specification for a **future** Mission CLI. Every leaf
command, operation identifier, route, access assignment, JSON spelling and
schema below is a **new proposed contract**, not an approved API or a shipped
guarantee. Domain rules are distinguished from proposed wire representations.
Unresolved contracts are called out explicitly; a placeholder is not an
implementable schema.

The current [CLI dispatcher](../../src/apps/cli/index.ts) implements
`kanthord mission [--endpoint <url>]` as help only. The `project`, `scheduler`
and `tracking` groups are also help-only. Mission currently has no service
implementation, operation declarations or generated OpenAPI routes. The current
help-only group has no `--token` option or mutation commands. Existing command
spellings and options are not aliases for the proposals on this page.

The [operation contract](../../src/kernel/operation.ts),
[identity validator](../../src/kernel/identity.ts),
[caller types](../../src/kernel/caller.ts) and
[client configuration](../../src/gateway/client.ts) supply the existing
mechanical baseline. In particular, current machine identity types do not establish a Mission
execution identity by themselves.

One project has one mission: its initiatives, objectives, tasks and relations.
The proposal contains **66 remote leaf commands**. Group help is not a leaf.
A mission exists from project creation, empty at mission revision 1. No operation creates or deletes a mission. Project discovery
provides a project ID; `mission get` returns that project's mission ID.

## Domain boundaries that every command must preserve

- A mission is a graph with containment and dependency edges. An initiative is
  a root; an objective belongs to exactly one initiative and names exactly one
  repository binding of its project; a task belongs to exactly one objective
  and inherits that objective's repository. Empty parents are allowed.
- A dependency relates initiatives or objectives, never tasks. A dependent
  waits for the named nodes of its own and its ancestors' dependencies, not
  their subtrees. Every write checks this closure for cycles. Only `Completed`
  satisfies a dependency; `Discarded` does not. An unsatisfied dependency
  produces unavailability, not a block.
- Humans own planning, node edits, the criterion and imports. Execution authority
  grants no planning authority. A human edit during an attempt affects a later
  attempt; it does not retarget the open attempt or change state.
- An initiative or objective has revisions, state and attempts. A task has
  none of these independently: its content belongs to its objective's revision,
  and its execution records name the objective's attempt and pinned revision.
  Task order in a plan is not a Mission scheduling order.
- At most one node attempt is open. Its node revision and required external
  actions are frozen at opening. A Project configuration change reaches the
  next attempt. Records never migrate between attempts, and closed attempts
  never reopen. Revision numbers and attempt counters are independent.
- `Completed` and `Discarded` are terminal. No edit, unblock, override or outcome
  correction reaches a terminal node. Follow-up work requires a new node. A
  genuine no-op import of a terminal node is allowed; a substantive change is
  not.
- Execution provides evidence; evaluation provides assessments; Mission records
  outcomes on attempt closure. A command returning successfully establishes
  acceptance of that operation, not success of the node. A passing assessment
  and the observed expected end state of every required external action are
  both necessary for ordinary success. An initiative requires no external action.
- Evidence, assessments and outcomes are historical records. A later record
  does not become current merely because it arrived later. Context, authority
  and order all govern assessment currency. The context uses the pinned
  revision, named evidence subset and selected immutable child outcomes.
- A terminal transition requires no unresolved requested external action.
  Pausing does not cancel a platform action, and blocking does not undo one.
  A request whose end state has not been observed cannot be bypassed by discard
  or a success override.

## Common proposed calling convention

Every synopsis starts with `kanthord mission` and uses the
[common synopsis notation](./common-flags.md#synopsis-markers). Shared flag
syntax, defaults, and validation are defined once in that reference:

| Named flag set                                                   | Applies to               |
| ---------------------------------------------------------------- | ------------------------ |
| [`[M]` — Mutation flags](./common-flags.md#mutation-flags-m)     | Every proposed mutation. |
| [`[L]` — Pagination flags](./common-flags.md#pagination-flags-l) | Paginated lists.         |

[Remote flags](./common-flags.md#remote-flags-r) apply to every remote command.
A resolved [`--token`](./common-flags.md#--token) is required for every
operation here; its identity must satisfy the access legend below.
[`--help`](./common-flags.md#--help) also exists at every group level.
No remote command accepts [`--config`](./common-flags.md#--config).
See [shared rules](./other.md) for client-file handling and errors.

All complex input uses required [`--file`](./common-flags.md#--file), with the
schemas below. Nested plan-file paths are the exception to the shared
working-directory rule: they resolve against the manifest file's directory.
A manifest explicitly names every Markdown file it reads. No directory glob
or implicit discovery expands an authoritative import set.

All optional flags default to absent unless a default is stated. Flags that
filter records map to same-named camelCase query fields (`--attempt` to
`attempt`, `--parent` to `parentId`). Positionals
map to the route parameters shown in the inventory. File contents map to the
request body, except the documented import conversion and generated request ID.
GET requests have no body. `--help` is never sent to the server.

The shared [`--idempotency-key`](./common-flags.md#--idempotency-key) retry
rules apply. Import and unblock additionally need durable domain request
deduplication. This proposal derives their `requestId` as `request_<key>` and
returns it; this mapping is proposed, not an existing Mission contract. A retry
of an accepted unblock must resolve its request before rechecking revision or
attempt, so it cannot charge another attempt. Gateway replay alone does not
settle Mission recovery or remote-effect reconciliation.

### Operation contracts

- Every Mission route follows the [operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#operation-contracts).
- Each route uses the shared error envelope, the default 30 s timeout and the 10 MiB body limit.
- A stale expected revision or mission revision answers 409 `mission.revision_conflict` with the current value in `details`.
- An absent node, mission or record answers 404 `mission.not_found`.

### Scalars and schema notation

In the schema tables, **required** fields have no default. **Optional** fields
are absent by default unless specified otherwise; nullable is stated explicitly.
Arrays contain values of the stated type and reject duplicates when described
as a set. Unknown JSON fields are rejected. Safe integers fit JavaScript's safe
integer range. All server timestamps are integer Unix milliseconds in UTC.
Wall-clock time and ULIDs do not establish causal order.
Every version, revision and `expected*Revision` field holds a positive safe integer.

| Type                                                                                                     | Proposed validation or unresolved boundary                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectId`, `MissionId`                                                                                 | `project_<ulid>` and `mission_<ulid>` respectively; these prefixes are declared by the architecture design. They are not currently Mission schemas.                                                                                                                                                                                             |
| `RequestId`                                                                                              | `request_<ulid>`; used for durable import/unblock request lookup, distinct from an unprefixed transport idempotency key.                                                                                                                                                                                                                        |
| `NodeId`, `EvidenceId`, `EvaluationId`, `AssessmentId`, `OutcomeId`, `ExternalObjectId`, `ObservationId` | `node_<ulid>`, `evidence_<ulid>`, `evaluation_<ulid>`, `assessment_<ulid>`, `outcome_<ulid>`, `external_object_<ulid>` and `observation_<ulid>`, respectively. The [Mission identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-identities-of-the-mission-service) define these prefixes. |
| `ExecutionId`                                                                                            | Prefix declaration remains **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery)**.                                                                                                                                                                                          |
| `BindingId`                                                                                              | `binding_<ulid>` under the [Project identities](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/project-service.impl.md#the-identities-of-the-project-service).                                                                                                                                                               |
| `<ulid>`                                                                                                 | Exactly 26 uppercase Crockford Base32 characters; first character `0..7`, remaining characters `[0-9A-HJKMNP-TV-Z]`. Bare ULIDs are invalid entity IDs.                                                                                                                                                                                         |
| `revision`, `expectedRevision`                                                                           | Positive safe integers; required where shown. A node starts at revision 1 and takes its next node revision on every content change. The [revision rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-revisions) apply. For a task, a revision always means the revision of its objective.     |
| `expectedMissionRevision`                                                                                | Positive safe integer; required where shown. The empty mission holds revision 1. The [revision rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-revisions) list the writes that increment the mission revision and those that leave it unchanged.                                           |
| `attempt`                                                                                                | Positive safe integer naming a node attempt, not an opaque entity ID. `attemptCounter` permits zero, which means no attempt exists. Only `blockedAttempt` explicitly permits zero.                                                                                                                                                              |
| `Text`                                                                                                   | Nonblank string. Text bounds remain **[blocked][mission-contract]**; the command truncates no text.                                                                                                                                                                                                                                             |
| `Key`                                                                                                    | Proposed natural key matching `[A-Za-z0-9][A-Za-z0-9._-]*`, nonempty. Action keys are scoped natural keys, not newly prefixed entity IDs. Project must approve the frozen external-action key format.                                                                                                                                           |
| `SHA256`                                                                                                 | Exactly 64 lower-case hexadecimal characters.                                                                                                                                                                                                                                                                                                   |
| `Timestamp`                                                                                              | Nonnegative safe integer, Unix milliseconds UTC; observation time may precede acceptance time.                                                                                                                                                                                                                                                  |
| `State`                                                                                                  | `Pending`, `Available`, `Executing`, `Waiting`, `Evaluating`, `Blocked`, `Paused`, `Completed`, `Discarded`, `External.Requested`, `External.Success`, `External.Failed`. Tasks reject state filters or state controls aimed at them.                                                                                                           |
| `Result`                                                                                                 | Proposed JSON values `success`, `criterion-not-met`, `undetermined`: success; results do not meet the criterion or default standard; nothing is established. This is a wire encoding proposal, not an added domain result.                                                                                                                      |

### Proposed access legend

No operation in this inventory is anonymous. Project authorization still applies
to the resource named by every operation; guessing an ID conveys no authority.

| Code | Proposed route access and domain check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H    | Existing policy value `human`, with verified human identity and the applicable planning or human-control authority. A client JWT is insufficient, including a client started by a human.                                                                                                                                                                                                                                                                                                                                                                                                    |
| E    | Existing policy value `client` plus live registration, live claim and a validated execution identity belonging to that claim, node and attempt. It also governs the execution-scoped reads below: the server derives the node, the attempt and the revision bound from the live claim, and a read under E never returns a revision newer than the pinned one. Steps/evaluation authority is checked per operation. The invocation chain proves the execution identity against the claimant of its live claim before the handler runs, so the identity in the input self-authorizes nothing. |

No operation accepts both a human and a machine. The read of a human (H) is keyed by a node and returns every revision; the read of a worker (E) is keyed by the execution identity. Both call one domain query with a required bound that the server derives from the caller, and return one record schema; the query rejects a missing bound. A human inspection of the view of an execution is a possible third `human` operation and is not in this inventory.

[mission-contract]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service
[mission-recovery]: https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service-1

## Proposed command inventory and synopsis

All routes below are **proposed and unimplemented**. Each row is one leaf
command. Operation IDs identify proposed Mission operations, not functions
already declared in source. Every mutation has `[M]`; lists have `[L]`.

### Mission, graph, changes, nodes and criterion — 17 commands

| #   | Synopsis after `kanthord mission`                                                                       | Proposed HTTP route                                        | Proposed operation                                           | Access |
| --- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ | ------ |
| 1   | `get <project-id>`                                                                                      | `GET /api/mission/project/:projectId`                      | `mission.get`                                                | H      |
| 2   | `graph get <mission-id>`                                                                                | `GET /api/mission/:missionId/graph`                        | `mission.graph.get` **[blocked][mission-contract]**          | H      |
| 3   | `change list <mission-id> [L]`                                                                          | `GET /api/mission/:missionId/change`                       | `mission.change.list`                                        | H      |
| 4   | `change get <mission-id> <revision>`                                                                    | `GET /api/mission/:missionId/change/:revision`             | `mission.change.get`                                         | H      |
| 5   | `node list <mission-id> [--kind <kind>] [--state <state>] [--parent <node-id>] [--include-retired] [L]` | `GET /api/mission/:missionId/node`                         | `mission.node.list` **[blocked][mission-contract]**          | H      |
| 6   | `node get <node-id>`                                                                                    | `GET /api/mission/node/:nodeId`                            | `mission.node.get` **[blocked][mission-contract]**           | H      |
| 7   | `node create <mission-id> --file <path> [M]`                                                            | `POST /api/mission/:missionId/node`                        | `mission.node.create` **[blocked][mission-contract]**        | H      |
| 8   | `node update <node-id> --file <path> [M]`                                                               | `PUT /api/mission/node/:nodeId`                            | `mission.node.update` **[blocked][mission-contract]**        | H      |
| 9   | `node retire <node-id> --file <path> [M]`                                                               | `POST /api/mission/node/:nodeId/retire`                    | `mission.node.retire` **[blocked][mission-contract]**        | H      |
| 10  | `node move <node-id> --file <path> [M]`                                                                 | `POST /api/mission/node/:nodeId/move`                      | `mission.node.move` **[blocked][mission-contract]**          | H      |
| 11  | `node revision list <node-id> [L]`                                                                      | `GET /api/mission/node/:nodeId/revision`                   | `mission.node.revision.list` **[blocked][mission-contract]** | H      |
| 12  | `node revision get <node-id> <revision>`                                                                | `GET /api/mission/node/:nodeId/revision/:revision`         | `mission.node.revision.get` **[blocked][mission-contract]**  | H      |
| 13  | `edge list <mission-id> [--kind <kind>] [--node <node-id>] [L]`                                         | `GET /api/mission/:missionId/edge`                         | `mission.edge.list`                                          | H      |
| 14  | `dependency add <node-id> <depends-on-id> --file <path> [M]`                                            | `PUT /api/mission/node/:nodeId/dependency/:dependsOnId`    | `mission.dependency.add` **[blocked][mission-contract]**     | H      |
| 15  | `dependency remove <node-id> <depends-on-id> --file <path> [M]`                                         | `DELETE /api/mission/node/:nodeId/dependency/:dependsOnId` | `mission.dependency.remove` **[blocked][mission-contract]**  | H      |
| 16  | `criterion list <node-id> [--revision <revision>] [L]`                                                  | `GET /api/mission/node/:nodeId/criterion`                  | `mission.criterion.list` **[blocked][mission-contract]**     | H      |
| 17  | `criterion set <node-id> --file <path> [M]`                                                             | `PUT /api/mission/node/:nodeId/criterion`                  | `mission.criterion.set` **[blocked][mission-contract]**      | H      |

All positional IDs are required, typed as their names indicate, and have no
default. `<depends-on-id>` is a `NodeId`. `<revision>` is a positive safe integer.
`node list --kind` accepts `initiative|objective|task`; `edge list --kind` accepts
`containment|dependency`. `--state` accepts the exact `State` spelling.
`--parent` selects direct children in that mission; `--node` selects incident
edges. `--include-retired` is boolean, default false. Omitted filters select all
authorized matching records; a state filter selects initiatives/objectives only
and rejects an explicit `--kind task`. `--revision` defaults to the latest revision for a human.
`--include-retired` maps to `includeRetired`; `--node` maps to `nodeId`.
An execution reads no content of another node through the execution-scoped
reads below, except a current child objective of its initiative at the revision
that the current outcome of that objective pins.

**Effects and results:**

- `get` returns `Mission`.
- `graph get` returns `Graph` with containment, dependencies and computed closure and availability explanations.
  This read decides no work allocation.
  The answer holds at most 10 MiB; a larger graph answers 413 `mission.graph.too_large`.
  The error holds the node count and the paged reads `node list` and `edge list` in `details`.
  The client then pages `node list` and `edge list` under the [operation contracts](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#operation-contracts).
- `change list` returns `Page<MissionChange>` under the shared descending [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
  `change get` returns the `MissionChange` at the named mission revision.
  The Mission Service keeps every mission change for the life of the mission.
- `node list` returns `Page<Node>`. For a blocked node, its row includes the
  outcome of the closed attempt and requested external objects with their
  observed states; the cause is read from the outcome's closing event, never
  inferred from record order. `node get` returns `Node` with revision/attempt
  links. Task reads identify their objective and selected objective revision.
- `node create` accepts `NodeCreate`, returns `NodeChange`, and validates the
  complete resulting graph. A root has no parent. New tasks revise their
  objective; no task revision is created. Creation admission remains **blocked** under [HANDOFF Mission Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service).
  It preserves terminal-parent immutability.
- `node update` accepts `NodeUpdate` and returns `NodeChange`. It replaces the
  named node's editable content, preserves identity and records reason/actor/time.
  It does not change kind, parent, dependencies, priority or state. For tasks it
  updates the task inside the objective revision. A node with an attempt remains
  editable by human override authority while nonterminal; import admission
  conditions do not govern this human update.
- `node retire` accepts `Retire`, returns `NodeChange`, removes executable work
  and current inbound references, and preserves records and historical relations.
  It cannot retire a node with an attempt. The proposed closure of affected
  references is explicitly confirmed in the file; it never implicitly discards
  a started child. Retirement admission and confirmation details are proposals.
- `node move` accepts `Move`, returns `NodeChange`, and changes containment
  atomically, including affected child sets. A task can move only to an objective,
  an objective only to an initiative in the same mission; an initiative cannot
  move under a parent. Human edit authority and terminal checks apply to every
  affected content owner. Import moves retain the stricter import conditions.
- `node revision list` returns `Page<Revision>` in descending revision order;
  `get` returns `Revision`. Task calls select the task content within objective
  revisions. Execution-scoped revision reads below enforce the pinned bound.
- `edge list` returns `Page<Edge>`. Edges use endpoint composites, not invented
  opaque edge IDs. `dependency add/remove` accept `GraphEdit` and return
  `NodeChange`; they are graph operations, not arbitrary field updates.
  Addition requires no live claim on the dependent or any node in its subtree;
  removal requires a nonterminal dependent. Terminal edit prohibition still
  applies. These special conditions replace import eligibility for dependency
  edits on both write paths. Same-transaction routing updates all affected
  claim-free nodes between `Pending` and `Available`; an execution-end fact is
  not undone by adding a dependency.
- `criterion list` returns `Page<Text>` with the single criterion text and its content-owner revision.
  `criterion set` accepts `CriterionSet`, returns `NodeChange`, and replaces the criterion and verifications as one human revision.
  It creates no independent criterion revision, state or opaque criterion ID.

### Import — 3 commands

| #   | Synopsis after `kanthord mission`             | Proposed HTTP route                             | Proposed operation                                       | Access |
| --- | --------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------- | ------ |
| 18  | `import preview <mission-id> --file <path>`   | `POST /api/mission/:missionId/import/preview`   | `mission.import.preview` **[blocked][mission-contract]** | H      |
| 19  | `import apply <mission-id> --file <path> [M]` | `POST /api/mission/:missionId/import`           | `mission.import.apply` **[blocked][mission-contract]**   | H      |
| 20  | `import get <mission-id> <request-id>`        | `GET /api/mission/:missionId/import/:requestId` | `mission.import.get` **[blocked][mission-contract]**     | H      |

`<mission-id>` and `<request-id>` are required `MissionId` and `RequestId` values.
Preview accepts `ImportManifest`; apply accepts `ImportApply`. The CLI reads the
named Markdown files and sends a resolved `ImportSnapshot`, not filesystem
paths or a plan syntax for the server to interpret. The Markdown dialect remains **blocked** under [HANDOFF Mission Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service).

Preview is nonmutating despite using POST: it returns `ImportPreview` and stores
no preview receipt. Apply checks the preview digest and exact confirmation of
every retirement against the resulting graph at commit, and returns
`ImportResult`. `import get` retrieves that accepted result and assigned-ID map
using the durable request ID, including after a lost apply response. There is
no interactive confirmation and no automatic write-back of assigned IDs into
Markdown. The CLI reports the map for the human to preserve explicitly.

An import is an authoritative snapshot within its explicit scope: a missing ID
creates, an existing ID updates, omission retires. Unknown IDs, duplicate IDs,
foreign-mission IDs, duplicate file names and unresolved dependency names fail.
Dependencies name a unique plan filename in the set, never a path. A stale
expected mission revision fails, and a preview is not a reservation against
subsequent work.

Creation, update and retirement require `Pending|Available` and attempt counter
zero for each modified owner; task eligibility is its objective's eligibility.
Create checks the parent whose child set changes. Containment moves check the
moved owner, old parent and new parent. Retirement checks affected child sets
and references; explicit dependency edits use the special dependency rule
described above. Dependency-resolution changes count as modifications even if
the Markdown bytes are unchanged. A real no-op skips modification checks.
One failed check aborts the whole import. Validation and commit share the lock
and transaction; unrelated work is not grounds to reject an import. Import
does not unblock, reopen, retarget attempts, carry priority or establish human
authorship/approval. Attribution records the submitting human only.

### Human controls and history — 11 commands

| #   | Synopsis after `kanthord mission`                   | Proposed HTTP route                                | Proposed operation                                             | Access |
| --- | --------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------- | ------ |
| 21  | `node priority set <node-id> --file <path> [M]`     | `POST /api/mission/node/:nodeId/priority`          | `mission.node.priority.set` **[blocked][mission-contract]**    | H      |
| 22  | `node priority list <node-id> [L]`                  | `GET /api/mission/node/:nodeId/priority`           | `mission.node.priority.list` **[blocked][mission-contract]**   | H      |
| 23  | `node pause <node-id> --file <path> [M]`            | `POST /api/mission/node/:nodeId/pause`             | `mission.node.pause` **[blocked][mission-recovery]**           | H      |
| 24  | `node resume <node-id> --file <path> [M]`           | `POST /api/mission/node/:nodeId/resume`            | `mission.node.resume` **[blocked][mission-contract]**          | H      |
| 25  | `node block <node-id> --file <path> [M]`            | `POST /api/mission/node/:nodeId/block`             | `mission.node.block` **[blocked][mission-contract]**           | H      |
| 26  | `node unblock <node-id> --file <path> [M]`          | `POST /api/mission/node/:nodeId/unblock`           | `mission.node.unblock` **[blocked][mission-contract]**         | H      |
| 27  | `node mark-ready <node-id> --file <path> [M]`       | `POST /api/mission/node/:nodeId/mark-ready`        | `mission.node.markReady` **[blocked][mission-contract]**       | H      |
| 28  | `node override-success <node-id> --file <path> [M]` | `POST /api/mission/node/:nodeId/override-success`  | `mission.node.overrideSuccess` **[blocked][mission-contract]** | H      |
| 29  | `node discard <node-id> --file <path> [M]`          | `POST /api/mission/node/:nodeId/discard`           | `mission.node.discard` **[blocked][mission-contract]**         | H      |
| 30  | `unblock list <node-id> [L]`                        | `GET /api/mission/node/:nodeId/unblock`            | `mission.unblock.list` **[blocked][mission-contract]**         | H      |
| 31  | `unblock get <node-id> <request-id>`                | `GET /api/mission/node/:nodeId/unblock/:requestId` | `mission.unblock.get` **[blocked][mission-contract]**          | H      |

`<node-id>` is required; state-changing controls accept initiatives/objectives
only. `<request-id>` is the accepted unblock's required `RequestId`.

- Priority set accepts `PrioritySet`, returns `PriorityAct`, and records actor
  and time outside a node revision. Admission requires a nonterminal node with
  no claim. Priority bounds and task applicability remain **[blocked][mission-contract]**.
  The proposed type is a signed safe integer. Absent priority reads `0`. List returns `Page<PriorityAct>`.
- Pause accepts `HumanAct`, returns `ControlResult`, revokes the live execution
  or reviewer claim if present and keeps the attempt open. Eligible states are
  `Pending`, `Available`, `Executing`, `Waiting`, `Evaluating`,
  `External.Requested`, `External.Success`, `External.Failed`. Physical stop and reuse remain **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service)**.
- Resume accepts `HumanAct`, returns `ControlResult`, and requires `Paused`.
  It reads the frozen action set, requests and accepted observations first:
  a non-success action end selects `External.Failed`; requested actions all at
  expected end select `External.Success`; otherwise any requested action
  selects `External.Requested`; otherwise execution-ended selects `Waiting`;
  otherwise closure selects `Available` or `Pending`. It never opens an attempt
  or invalidates a passing assessment merely by resuming.
- Block accepts `HumanAct`, returns `ControlResult`, and requires `Paused`.
  It records the human reason in an outcome, closes an open attempt and writes
  owed task outcomes. With counter zero it opens/closes no attempt and leaves
  the counter zero. There is no separate block entity. This is the only human
  block path; a generic force-state command is not proposed.
- Unblock accepts `Unblock`, returns `UnblockRecord`, and requires `Blocked`.
  It checks the blocked attempt and current expected revision, optionally
  writes a content change, then opens exactly one next attempt pinned to the
  revision left current. Counter zero opens none. It routes to `Available` or
  `Pending`, never `Waiting`. Directions belong in the content change, not a
  side-channel note in the unblock record. An accepted replay returns before
  stale-attempt/revision checks. List/get expose accepted records, including
  the cleared attempt and the new attempt's pinned revision.
- Mark-ready accepts `HumanAct`, returns `ControlResult`, and means only the
  human assertion that this execution needs no further work. It requires
  `Available` and readiness: every task has a current outcome of the objective's
  open attempt, or every objective of an initiative is terminal, and no action
  is unresolved. Child success is not required. It opens attempt 1 only when
  none exists, freezes its facts and reaches `Waiting`; it does not publish an
  assessment. The counter-zero case remains **blocked** under [HANDOFF Mission Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service).
- Override-success accepts `SuccessOverride`, returns `ControlResult`, and
  creates an outcome with human-assertion basis and `success`, referencing any
  previous outcome it replaces. Eligible states in the current design are
  `Pending`, `Available`, `Executing`, `Waiting`, `Blocked`, `Paused`,
  `External.Success`, `External.Failed`. It is not defined from `Evaluating` or
  `External.Requested`, and cannot reach a terminal node. Any supplied landed
  commit becomes evidence attributed to the human without repository checking.
- Discard accepts `HumanAct`, returns `ControlResult`, and creates a
  human-assertion outcome with `undetermined`, closing an attempt when one is open and writing the task outcomes that the outcome and completion rules of the design require; from `Blocked`, no attempt closes. Eligible states are `Pending`, `Available`,
  `Executing`, `Waiting`, `Evaluating`, `Blocked`, `Paused`, `External.Success`,
  `External.Failed`, subject to no unresolved action. It reaches `Discarded`,
  which satisfies no dependency. No command cancels an unresolved remote request
  merely to make discard admissible.

To redirect an open attempt, a human pauses, blocks, then unblocks with the
changed content. A simple update leaves the old attempt's revision pinned.
All controls recheck admission at commit. Human-control race precedence remains **blocked** under [HANDOFF Mission Service E3](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service-1).

### Attempts, evidence, evaluations and outcomes — 17 commands

| #   | Synopsis after `kanthord mission`                     | Proposed HTTP route                                     | Proposed operation                                             | Access |
| --- | ----------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| 32  | `attempt list <node-id> [L]`                          | `GET /api/mission/node/:nodeId/attempt`                 | `mission.attempt.list` **[blocked][mission-contract]**         | H      |
| 33  | `attempt get <node-id> <attempt>`                     | `GET /api/mission/node/:nodeId/attempt/:attempt`        | `mission.attempt.get` **[blocked][mission-contract]**          | H      |
| 34  | `evidence list <node-id> [--attempt <attempt>] [L]`   | `GET /api/mission/node/:nodeId/evidence`                | `mission.evidence.list` **[blocked][mission-contract]**        | H      |
| 35  | `evidence get <evidence-id>`                          | `GET /api/mission/evidence/:evidenceId`                 | `mission.evidence.get` **[blocked][mission-contract]**         | H      |
| 36  | `evidence submit <node-id> --file <path> [M]`         | `POST /api/mission/node/:nodeId/evidence`               | `mission.evidence.submit` **[blocked][mission-contract]**      | E      |
| 37  | `evidence content get <evidence-id>`                  | `GET /api/mission/evidence/:evidenceId/content`         | `mission.evidence.content.get` **[blocked][mission-contract]** | H      |
| 38  | `run-output list <node-id> [--attempt <attempt>] [L]` | `GET /api/mission/node/:nodeId/run-output`              | `mission.runOutput.list` **[blocked][mission-contract]**       | H      |
| 39  | `run-output get <node-id> <execution-id>`             | `GET /api/mission/node/:nodeId/run-output/:executionId` | `mission.runOutput.get` **[blocked][mission-contract]**        | H      |
| 40  | `run-output submit <node-id> --file <path> [M]`       | `POST /api/mission/node/:nodeId/run-output`             | `mission.runOutput.submit` **[blocked][mission-contract]**     | E      |
| 41  | `evaluation list <node-id> [--attempt <attempt>] [L]` | `GET /api/mission/node/:nodeId/evaluation`              | `mission.evaluation.list` **[blocked][mission-contract]**      | H      |
| 42  | `evaluation get <evaluation-id>`                      | `GET /api/mission/evaluation/:evaluationId`             | `mission.evaluation.get` **[blocked][mission-contract]**       | H      |
| 43  | `assessment list <node-id> [--attempt <attempt>] [L]` | `GET /api/mission/node/:nodeId/assessment`              | `mission.assessment.list` **[blocked][mission-contract]**      | H      |
| 44  | `assessment get <assessment-id>`                      | `GET /api/mission/assessment/:assessmentId`             | `mission.assessment.get` **[blocked][mission-contract]**       | H      |
| 45  | `assessment submit <node-id> --file <path> [M]`       | `POST /api/mission/node/:nodeId/assessment`             | `mission.assessment.submit` **[blocked][mission-contract]**    | E      |
| 46  | `outcome list <node-id> [--attempt <attempt>] [L]`    | `GET /api/mission/node/:nodeId/outcome`                 | `mission.outcome.list` **[blocked][mission-contract]**         | H      |
| 47  | `outcome get <outcome-id>`                            | `GET /api/mission/outcome/:outcomeId`                   | `mission.outcome.get` **[blocked][mission-contract]**          | H      |
| 48  | `task-result submit <task-id> --file <path> [M]`      | `POST /api/mission/node/:taskId/task-result`            | `mission.taskResult.submit` **[blocked][mission-contract]**    | E      |

Every positional is required. `<task-id>` is a `NodeId` of kind task.
`--attempt` and positional `<attempt>` are positive safe integers, scoped to
the node, or to its objective for task records. Omitted `--attempt` means all
authorized attempts, not silently the latest. Task record lists are valid;
attempt/evaluation lists and run-output operations require an initiative or
objective. A task attempt is not manufactured for convenience.

- Attempt list/get return `Page<Attempt>` / `Attempt`, including pinned revision,
  frozen required external actions, execution-end fact, closure and outcome
  references. They never open, close or retry an attempt.
- Evidence list/get return `Page<Evidence>` / `Evidence`. Submit accepts
  `EvidenceSubmit` and returns `Evidence`. The live execution may submit for its
  own node or a task of its objective. A reviewer may submit machine-check
  output for its evaluation. A human uses the explicit success override for a
  human landed-commit assertion, not an execution submission route.
- Produced evidence is stored as addressed bytes; repository evidence stores an
  address, preferably a commit identity. Content get returns `StoredContent`
  for stored produced bytes. For a repository reference it returns a typed
  unavailable-content result pointing to the address, never claims the server
  stores the repository snapshot. Size limits and retention are required but
  not numerically defined. No command silently truncates or alters evidence.
- Two independent observations of identical bytes may produce distinct evidence
  records. Repeating an unchanged address with no new observation does not.
  Corrections append and name the corrected record; they do not overwrite it.
  Redaction precedes hashing and is declared in the record. Outcome-dependent
  retention includes the transitive child evidence a parent assessment weighs.
- Run-output list/get return `Page<RunOutput>` / `RunOutput`. Submit accepts
  `RunOutputSubmit`, returns `RunOutput`, and must occur before release. There
  is at most one accepted record per execution identity. It records attempted
  work, impediments and recommendations, supplies no evidence, changes no state
  and closes no attempt. Failed submission is not reconstructed. It remains
  readable across attempts, with bounded retention after terminal state.
- Evaluation list/get return `Page<Evaluation>` / `Evaluation`. A durable
  evaluation can include several evaluation attempts within one node attempt.
  An unreachable reviewer means incomplete evaluation, not a failing assessment.
  Bounded retry resumes evaluation without repeating execution or repository
  actions, under the **blocked** [HANDOFF evaluation and budget items](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#policy-and-budgets).
- Assessment list/get return `Page<Assessment>` / `Assessment`, including the
  currency decision and reason. Submit accepts `AssessmentSubmit`, returns
  `AssessmentResult`, and requires an evaluation claim for the node. It records
  a conclusion against the pinned criterion, selected evidence and immutable
  child outcomes. The result may trigger ordinary closure/blocking under the
  domain rules; clients cannot submit an ordinary node outcome directly.
- A current assessment that does not pass closes into `Blocked`, whether its
  result is `criterion-not-met` or `undetermined`. A current pass with no required
  external action closes successfully. Otherwise external-action processing
  remains necessary. A stale assessment is historical, not current; stale-assessment recovery remains **blocked** under [HANDOFF B2](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service-1).
- Outcome list/get return `Page<Outcome>` / `Outcome`. An absent assessment
  means the basis carries none; it never means evaluation is pending. Failure
  of an external action produces `undetermined`, retaining the passing
  assessment as basis and naming the failure observation as stopping cause.
- Task-result submit accepts `TaskResultSubmit`, returns `TaskResult`, and
  records the task assessment and task outcome together under the objective's
  live steps execution. This lacks reviewer separation by design. Evidence is
  the task commit when repository work produces one. The parent readiness
  obligation requires each task's current outcome, not success of each task.
  The service fills missing task outcomes at closure; early-task-failure recovery remains **blocked** under [HANDOFF Mission Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#mission-service-1).

Claim acquisition, release and renewal belong to Scheduler. Ordinary evaluation
dispatch is not requested by the steps executor. Attempt closure ends every
execution and evaluation attempt in flight; late submissions cannot gain current
effect. A completed historical record remains attributed to its original attempt.

### External-action records — 6 commands

| #   | Synopsis after `kanthord mission`                          | Proposed HTTP route                                                         | Proposed operation                                            | Access |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------- | ------ |
| 49  | `external-action list <node-id> [--attempt <attempt>] [L]` | `GET /api/mission/node/:nodeId/external-action`                             | `mission.externalAction.list` **[blocked][mission-contract]** | H      |
| 50  | `external-action get <node-id> <attempt> <action-key>`     | `GET /api/mission/node/:nodeId/attempt/:attempt/external-action/:actionKey` | `mission.externalAction.get` **[blocked][mission-contract]**  | H      |
| 51  | `external-object list <node-id> [--attempt <attempt>] [L]` | `GET /api/mission/node/:nodeId/external-object`                             | `mission.externalObject.list` **[blocked][mission-contract]** | H      |
| 52  | `external-object get <external-object-id>`                 | `GET /api/mission/external-object/:externalObjectId`                        | `mission.externalObject.get` **[blocked][mission-contract]**  | H      |
| 53  | `observation list <node-id> [--attempt <attempt>] [L]`     | `GET /api/mission/node/:nodeId/observation`                                 | `mission.observation.list` **[blocked][mission-contract]**    | H      |
| 54  | `observation get <observation-id>`                         | `GET /api/mission/observation/:observationId`                               | `mission.observation.get` **[blocked][mission-contract]**     | H      |

All positionals are required. `<action-key>` is a Project-defined natural key
in that attempt's frozen action set. `--attempt` follows the all-attempts default
above. These records belong to initiatives/objectives; tasks reject these calls.
An initiative's required-action and request sets are empty.

- Action reads return `Page<ExternalAction>` / `ExternalAction`: frozen
  configuration, predecessor, expected end, request and accepted observation
  references. Object reads return `Page<ExternalObject>` / `ExternalObject`.
  Observation reads return `Page<Observation>` / `Observation`, including landing
  commits where applicable. These reads do not inspect a platform or refresh
  observations on demand.
- The Worker action performer owns every configured external write for both
  harnesses and returns accepted Mission external objects. An external harness
  passes only its execution identity to the performer; the performer derives
  the binding, address, action and other operands from authoritative records.
  Worker publishes the representation through an owning Mission operation whose
  caller/dispatch admission and recovery remain to be declared. No direct CLI
  projection of that publication is specified: a live claim alone does not
  authorize an arbitrary human/client write of an external object.
  Action performance requires a current passing assessment and an eligible
  frozen required action; a following action requires its predecessor's accepted
  expected end state before request. Publication and lost-acknowledgement recovery remain **blocked** under [HANDOFF Worker and Project Services](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#worker-and-project-services).
- The record names the action, Project binding, remote address and display
  label. One binding may serve many separately identified external objects.
  Prior objects remain available to the next attempt; recording a representation
  does not authorize a retry, create a second remote object, or resolve the
  action. The Worker action performer owns whether/how to reuse a remote thing
  across attempts.
- Only an accepted observation establishes external end state. Mission does not
  parse platform content or infer state from an object URL. Inspection failure
  leaves the request unresolved and costs no attempt. A landing observation
  adds landed commit evidence; a nonrepository action adds none. No assessment
  retroactively weighs that landed snapshot.

### Execution-scoped reads — 12 commands

The execution identity is the first positional in every synopsis. The server derives the node, the attempt and the pinned revision from the live claim; an execution cannot select another node through these routes.

| #   | Synopsis after `kanthord mission`                             | Proposed HTTP route                                                    | Proposed operation                                                          | Access |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| 55  | `execution pinned-revision get <execution-id>`                | `GET /api/mission/execution/:executionId/pinned-revision`              | `mission.execution.pinnedRevision.get` **[blocked][mission-contract]**      | E      |
| 56  | `execution revision list <execution-id> [L]`                  | `GET /api/mission/execution/:executionId/revision`                     | `mission.execution.revision.list` **[blocked][mission-contract]**           | E      |
| 57  | `execution revision get <execution-id> <revision>`            | `GET /api/mission/execution/:executionId/revision/:revision`           | `mission.execution.revision.get` **[blocked][mission-contract]**            | E      |
| 58  | `execution run-output list <execution-id> [L]`                | `GET /api/mission/execution/:executionId/run-output`                   | `mission.execution.runOutput.list` **[blocked][mission-contract]**          | E      |
| 59  | `execution task-outcome list <execution-id> [L]`              | `GET /api/mission/execution/:executionId/task-outcome`                 | `mission.execution.taskOutcome.list` **[blocked][mission-contract]**        | E      |
| 60  | `execution evidence list <execution-id> [L]`                  | `GET /api/mission/execution/:executionId/evidence`                     | `mission.execution.evidence.list` **[blocked][mission-contract]**           | E      |
| 61  | `execution evidence content get <execution-id> <evidence-id>` | `GET /api/mission/execution/:executionId/evidence/:evidenceId/content` | `mission.execution.evidence.content.get` **[blocked][mission-contract]**    | E      |
| 62  | `execution objective list <execution-id> [L]`                 | `GET /api/mission/execution/:executionId/objective`                    | `mission.execution.objective.list` **[blocked][mission-contract]**          | E      |
| 63  | `execution objective outcome list <execution-id> [L]`         | `GET /api/mission/execution/:executionId/objective/outcome`            | `mission.execution.objective.outcome.list` **[blocked][mission-contract]**  | E      |
| 64  | `execution objective evidence list <execution-id> [L]`        | `GET /api/mission/execution/:executionId/objective/evidence`           | `mission.execution.objective.evidence.list` **[blocked][mission-contract]** | E      |
| 65  | `execution cleared-outcome get <execution-id>`                | `GET /api/mission/execution/:executionId/cleared-outcome`              | `mission.execution.clearedOutcome.get` **[blocked][mission-contract]**      | E      |
| 66  | `execution unblock get <execution-id>`                        | `GET /api/mission/execution/:executionId/unblock`                      | `mission.execution.unblock.get` **[blocked][mission-contract]**             | E      |

The reads return the same record schemas as the human reads and never a revision newer than the pinned one.
The pinned-revision read returns `Revision` with tasks and the complete node content.
Revision list/get return `Page<Revision>` / `Revision` and reject a requested revision above the pinned one.
Run outputs, task outcomes and evidence return `Page<RunOutput>`, `Page<Outcome>` and `Page<Evidence>`.
Evidence content uses the existing `StoredContent` result.
The cleared-attempt outcome and the unblock record of the claimed attempt return the existing `Outcome` and `UnblockRecord` schemas.
The initiative-only objective reads return `Page<Node>`, `Page<Outcome>` and `Page<Evidence>` for its current objectives.
Each objective resolves to the revision that its current outcome pins.
An objective without an outcome carries its identity and its state only.

## Proposed structured input schemas

The following field sets cover all [`--file`](./common-flags.md#--file) inputs
in the inventory. Each file contains one JSON object. They deliberately distinguish fully proposed shapes
from fields whose authoritative schema is still absent.

### Planning content and graph edits

| Schema         | Fields, requiredness and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content`      | Required `name: Text`, `requirement: Text`, `criterion: Text`, `verifications: Text[]`, `bindings: Text[]`. All text fields are nonblank. The name is a title, not an identity, and is not unique. The criterion can hold several checkable statements. Verifications form a nonempty ordered list; each item is a nonblank bash command. Bindings are project binding names; the rule table below decides counts per node kind. The write resolves names to identities. No implicit verification or arbitrary extra field exists. |
| `NodeCreate`   | Required `kind: "initiative" \| "objective" \| "task"`, `content: Content`, `reason: Text`, `expectedMissionRevision: positive integer`. `parentId: NodeId` and `expectedParentRevision: positive integer` required for objectives/tasks and forbidden for initiatives. No supplied new node ID. Dependencies are separate validated graph operations or part of an atomic import.                                                                                                                                                 |
| `NodeUpdate`   | Required `expectedRevision: positive integer`, `content: Content`, `reason: Text`. For a task, expected revision is its objective's. Full content replacement, not a partial merge; omitted content fields are errors. No `state`, `attempt`, `actor` or `priority`.                                                                                                                                                                                                                                                               |
| `GraphEdit`    | Required `expectedMissionRevision: positive integer`, `reason: Text`. Endpoints are required CLI positionals. Duplicate addition/absent removal is proposed as a no-op only after authorization; replay returns the originally accepted result.                                                                                                                                                                                                                                                                                    |
| `Move`         | Required `expectedMissionRevision: positive integer`, `expectedRevision: positive integer`, `newParentId: NodeId`, `expectedOldParentRevision: positive integer`, `expectedNewParentRevision: positive integer`, `reason: Text`. Old parent is read from the graph; no caller-authored old-parent identity overrides it.                                                                                                                                                                                                           |
| `Retire`       | Required `expectedMissionRevision: positive integer`, `expectedRevision: positive integer`, `reason: Text`, `confirmedRetirements: NodeId[]`, `confirmedReferenceRemovals: Edge[]`. Sets must exactly match the service-computed effect, including descendants if any; cascade policy remains **[blocked][mission-contract]**. No force flag.                                                                                                                                                                                      |
| `CriterionSet` | Required `expectedRevision: positive integer`, `criterion: Text`, `verifications: Text[]`, `reason: Text`. The `Content` rules apply. The service preserves other content in a new whole revision.                                                                                                                                                                                                                                                                                                                                 |
| `Edge`         | Discriminated object: containment has required `kind: "containment"`, `parentId: NodeId`, `childId: NodeId`; dependency has required `kind: "dependency"`, `dependentId: NodeId`, `dependsOnId: NodeId`. Endpoint kind/mission/cycle rules apply. No opaque edge ID.                                                                                                                                                                                                                                                               |

The [node content rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-node-content) govern every content write, import and unblock content change.
Identity, kind, revision, state, attempt counter, priority and edges stay outside content.

| Binding kind     | Initiative | Objective | Task |
| ---------------- | ---------- | --------- | ---- |
| Repository       | 0          | Exactly 1 | 0    |
| Worker           | 0          | 0         | 0    |
| Provider account | 0          | 0         | 0    |
| Source           | 0          | 0         | 0    |

A new binding kind adds a row.
An absent, blank or nontext `name`, `requirement` or `criterion` answers `mission.node.content_invalid`.
An absent or empty `verifications` list answers `mission.node.verifications_missing`.
A nonlist `verifications` value or a blank or nontext item answers `mission.node.content_invalid`.
A node with no verification need holds an always-successful command such as `true`.
An absent or nonlist `bindings` value, an unresolved name or a rule-table violation answers `mission.node.bindings_invalid`.

The mission revision is a concurrency precondition; the service still checks the current state, claim and attempt at commit.
The [revision rules](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-revisions) define each increment.
The [mission change contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-mission-change) defines the stored result of each write that increments the mission revision.

### Import files and normalized request

| Schema           | Fields, requiredness and validation                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImportScope`    | Proposed union: required `kind: "mission"`; or required `kind: "subtree"`, `rootId: NodeId`. A subtree root must be an initiative or objective of this mission. Subtree scope and boundary references remain **[blocked][mission-contract]**.                                                                                                                                                                                                           |
| `ImportManifest` | Required `expectedMissionRevision: positive integer`, `scope: ImportScope`, `reason: Text`, `files: PlanFile[]`. Empty files explicitly means an empty authoritative set, not no-op. The preview exposes resulting retirements. No priority field.                                                                                                                                                                                                      |
| `PlanFile`       | Required `name: Text`, `path: Text`. `name` is a unique filename ending `.md`, with no path separator, `.` or `..` name; `path` explicitly locates a readable Markdown file relative to the JSON manifest. It is CLI-only and never a dependency reference or server path.                                                                                                                                                                              |
| `ImportApply`    | Every field of `ImportManifest`, plus required `previewDigest: SHA256`, `confirmedRetirements: NodeId[]` (unique, explicitly `[]` when none). The normalized snapshot, not raw file text alone, is bound to the preview and request ID.                                                                                                                                                                                                                 |
| `ImportSnapshot` | Proposed wire body: required `expectedMissionRevision`, `scope`, `reason`, `entries: ImportEntry[]`; apply additionally requires `previewDigest`, `confirmedRetirements`, and CLI-derived `requestId: RequestId`. Preview omits these three apply-only fields. Paths do not reach Mission.                                                                                                                                                              |
| `ImportEntry`    | Required `name: Text`, `kind: "initiative" \| "objective" \| "task"`, `content: Content`, `dependencyNames: Text[]` (unique; empty for tasks). Optional `id: NodeId`, absent means create. `parentName: Text` required for contained nodes, forbidden for initiatives, subject to a future scoped-root exception. Parent/dependency names resolve in this set. Unknown, duplicate or foreign IDs are rejected; kind cannot change under an existing ID. |

The Markdown grammar remains **[blocked][mission-contract]**; arbitrary Markdown is no accepted import format.

### Human actions

| Schema            | Fields, requiredness and validation                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HumanAct`        | Required `reason: Text`, `expectedState: State`, `expectedAttempt: positive integer \| null`. Null explicitly asserts no attempt ever opened; a positive value identifies the current/latest node attempt, including the closed attempt on a blocked node. The specific command's state rules apply; no default current target.                                           |
| `PrioritySet`     | Required `value: signed safe integer`, `reason: Text`. No expected content revision: priority lives outside it. Numeric bounds beyond safe integer remain a proposal, and the service checks that the node is nonterminal and has no live claim at commit.                                                                                                                |
| `SuccessOverride` | Every field of `HumanAct`, plus optional `landedCommit: RepositoryAddress`. Absence asserts success without landed-commit evidence; it does not infer a commit. A supplied commit is permitted only for the objective's repository binding. Existing evidence remains; the actor/time/basis/result are server-authored.                                                   |
| `Unblock`         | Required `blockedAttempt: nonnegative integer`, `expectedRevision: positive integer`. Zero means the counter-zero blocked case. Optional `change: UnblockChange`; omission preserves current content. CLI supplies the durable `requestId` derived from `[M]`, not the JSON file. No independent direction/recommendation field.                                          |
| `UnblockChange`   | Required `content: Content` with all five fields, `tasks: TaskContent[]` for objectives (forbidden for initiatives), `reason: Text`. This proposed complete revision replacement can change existing task content; the task-ID set must match current containment. Structural graph edits use their own operations. Change does not bypass human edit or terminal checks. |
| `TaskContent`     | Required `id: NodeId` of a current child task and `content: Content` valid for a task. Unique task IDs, all current tasks represented in an objective's `UnblockChange`. Task content holds all five fields, with an empty `bindings` list. No task revision exists.                                                                                                      |

Preconditions in `HumanAct` are proposed concurrency protection, not permission
to invent transitions missing from the design. The counter-zero outcome format remains **[blocked][mission-contract]**.

### Execution submissions

| Schema                 | Fields, requiredness and validation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ExecutionContext`     | Required `executionId: ExecutionId`, `attempt: positive integer`, `nodeRevision: positive integer`. All must match the authenticated live claim. Task calls match its objective's claim and pinned revision; `nodeRevision` never means a task revision. No caller-supplied actor identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `RepositoryAddress`    | Required `kind: "repository"`, `bindingId: BindingId`, `commit: Text`. Commit is a protocol-defined full immutable repository commit identity, not an entity ULID. Repository evidence formats remain **[blocked][mission-contract]**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ProducedAddress`      | Required `kind: "produced"`, `sha256: SHA256`. Hash identifies exact accepted bytes after declared redaction, not claims within the bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Address`              | Exactly one `RepositoryAddress` or `ProducedAddress`; repository content does not require a produced SHA-256 address.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EvidenceSubmit`       | Every field of `ExecutionContext`, plus required `subject: Text`, `scope: "node" \| "task"`, `address: Address`, `observationKey: Key`, `redacted: boolean`. Scope must match the positional node's kind. Required `redactionDescription: Text` when redacted, otherwise forbidden. Optional `correctsEvidenceId: EvidenceId`, same authorized subject/scope. Required `content: ContentBytes` for produced address, forbidden for repository address. Optional `machineCheck: MachineCheck`, required for machine-check result evidence. The proposed observation key distinguishes a genuine new observation from replay; its deduplication domain and retention remain **[blocked][mission-contract]**.                                                |
| `ContentBytes`         | Required `mediaType: Text`, `encoding: "base64"`, `data: string` (canonical base64, empty content allowed). Decoded bytes must match the declared SHA-256. Byte and media-type bounds remain **[blocked][mission-contract]**. The command rejects oversize data and truncates nothing. Local paths are not evidence addresses.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MachineCheck`         | Required `testedInput: TestedInput`, `nodeRevision: positive integer`, `results: { command: Text, exitCode: integer \| null }[]`, `exitCode: integer \| null`, `resultEvidenceDescription: Text`. Results contain one entry per item that ran, in list order. Null means no normal exit status. The machine-check process signal, timeout and failure details remain **[blocked][mission-contract]**. The revision matches the execution's pin; commands match the verifications of that revision. Input names what the verifications read, never their result evidence.                                                                                                                                                                                  |
| `RunOutputSubmit`      | Every field of `ExecutionContext`, plus required `tried: Text`, `stoppedBy: Text`, `recommendations: Text[]` (may be empty). One record per execution, with content bounds still to be declared. A recommendation is history, not binding human direction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AssessmentBody`       | Every field of `ExecutionContext`, plus required `evidenceIds: EvidenceId[]`, `childOutcomeIds: OutcomeId[]`, `method: Text`, `result: Result`, `rationaleEvidenceIds: EvidenceId[]`. All are unique sets; empty rationale set allowed. Referenced evidence/outcomes must be authorized and fit the pinned context; every weighed child outcome is explicitly named. Required `testedInput: TestedInput` and `criterionResult: CriterionResult` for the single pinned criterion. Failed or unrun verifications prohibit `success`. Optional `defaultStandardFindings: Text[]`; required for workers declaring a base prompt, forbidden for external workers declaring none. Standard violations prohibit `success`. No whole-evidence-set equality check. |
| `CriterionResult`      | Required `result: Result`, `evidenceIds: EvidenceId[]`, `rationale: Text`. The result evaluates the whole criterion text of the pinned node or task. Referenced evidence is a subset of the assessment's selected evidence. The aggregate assessment contract remains **[blocked][mission-contract]**.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `AssessmentSubmit`     | Every field of `AssessmentBody`, plus required `evaluationId: EvaluationId`, `evaluationAttempt: positive integer`. Both must identify the evaluation try of the live reviewer claim; no client-generated evaluation identity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `TaskResultSubmit`     | Required `assessment: AssessmentBody`, `outcome: TaskOutcomeAssertion`. A task uses its objective's steps claim, not an evaluation identity. The proposed atomic paired submission preserves the design requirement that the task assessment accompanies its outcome.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `TaskOutcomeAssertion` | Required `result: Result`, `evidenceIds: EvidenceId[]`, `stoppingReason: Text`. Optional `previousOutcomeId: OutcomeId` for an admissible correction within this task/attempt. Basis is the paired assessment and cannot be supplied as human assertion. Result must agree with that assessment; evidence must include the task commit when one exists. Task outcome schemas remain **[blocked][mission-contract]**.                                                                                                                                                                                                                                                                                                                                      |

`TestedInput` is `Address` for an objective or task.
For an initiative with repository bindings from its current objectives, it is `RepositoryAddress[]`, one commit per distinct binding.
The reviewer includes discarded objectives and removes duplicate bindings.
It checks out each base-branch head under a directory named after that binding.
For an initiative whose objectives name no repository, `TestedInput` is `ProducedAddress`.
The reviewer places that produced evidence in the workspace.

The [verification run](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.impl.md#the-verifications) uses list order, one item at a time, never in parallel.
Each verification runs through `bash -c` in the execution workspace root.
The run stops at the first nonzero exit.
The machine check records each command that ran and its exit code.
The overall exit code is that of the failed item, or 0 when every item passes.
The start refuses a host without bash.
No execution infers a verification from prose.
The reviewer runs the verifications of the pinned revision, whatever the node kind.
An assessment does not pass when a verification fails or does not run.
The service refuses an assessment that asserts success with a failed or unrun item with `mission.assessment.verification_failed`.
This gate applies to both task and reviewer assessments.
Judgement decides success only after every verification passes.

The actor, accepted time, record identity, currentness, required-action snapshot
and outcome basis are server-derived. They cannot be forged through extra JSON
fields. Tested-input binding is an attributable executor assertion unless a
clean isolated checkout establishes it; a zero exit code proves only that the
verification returned zero, not adequacy, coverage or absence of suppressed failures.

## Proposed result schemas

All result JSON is written to stdout. Diagnostics go to stderr and failures exit
nonzero; successful reads/mutations exit zero. A successful mutation reports its
effective `idempotencyKey: string` alongside the domain result. Sensitive tokens
are never echoed. The exact transport envelope follows the
[shared rules](./other.md); the names below describe its domain data.

Fields listed below are required unless marked optional or nullable. These are
proposed output fields, with unresolved sub-schemas explicitly identified.
List pages use descending primary-key order under the shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination).
Pagination order establishes no causal record order.

| Result             | Proposed fields and meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Page<T>`          | `items: T[]`, `nextCursor: string \| null`. Optional `missionRevision: positive integer` on graph/content pages. The shared [pagination rule](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#pagination) applies; revisions descend and lists take no snapshot. Limit bounds page size, not the total number of retrievable records.                                                                                                                                                                 |
| `Actor`            | Verified identity attribution; its wire schema remains **[blocked][mission-contract]**. It must identify the authorizing actor, not accept caller-provided provenance as proof. Human account names are natural keys; no fictional human ULID prefix.                                                                                                                                                                                                                                                                                        |
| `Mission`          | `id: MissionId`, `projectId: ProjectId`, `revision: positive integer`. No independent mission state, branch or repository action.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Graph`            | `mission: Mission`, `nodes: Node[]`, `edges: Edge[]`, `dependencyClosures: {nodeId: NodeId, dependsOnIds: NodeId[], unsatisfiedIds: NodeId[]}[]`. Lists are complete within the authorized view or the response fails its bound. Frozen revision content and live dependency routing must be distinguishable.                                                                                                                                                                                                                                |
| `Node`             | `id: NodeId`, `missionId: MissionId`, `kind: "initiative" \| "objective" \| "task"`, `parentId: NodeId \| null`, `contentOwnerId: NodeId`, `visibleRevision: positive integer`, `content: Content`, `retired: boolean`, `pinnedByAttempts: positive integer[]`. Initiatives/objectives also have `state: State`, `attemptCounter: nonnegative integer`, `openAttempt: positive integer \| null`, `priority: signed safe integer`. Tasks omit those four fields. Optional `blockedContext: BlockedContext`, required for blocked node reads.  |
| `BlockedContext`   | `outcome: Outcome \| null`, `externalObjects: ExternalObject[]`, `observations: Observation[]`. Closed-attempt outcome is required when an attempt exists. Counter-zero representation remains **[blocked][mission-contract]**; null denotes no attempt, never a pending evaluation.                                                                                                                                                                                                                                                         |
| `Revision`         | `nodeId: NodeId` (content owner), `revision: positive integer`, `reason: Text`, `actor: Actor`, `createdAt: Timestamp`, `content: Content`, `tasks: TaskContent[]` for objectives only, `change: object`, `pinnedByAttempts: positive integer[]`. `change` describes the node content change and its result; that content change format remains **[blocked][mission-contract]**. No attempt pins an unselected revision; an edit during an attempt need not ever be used.                                                                    |
| `MissionChange`    | `missionId: MissionId`, `missionRevision: positive integer`, `actor: Actor`, `reason: Text`, `createdAt: Timestamp`, `result: NodeChange`.                                                                                                                                                                                                                                                                                                                                                                                                   |
| `NodeChange`       | `missionRevision: positive integer`, `nodes: Node[]`, `revisions: Revision[]`, `retiredNodeIds: NodeId[]`, `addedEdges: Edge[]`, `removedEdges: Edge[]`, `appliesToOpenAttempt: false`. `NodeChange` is the stored result of the mission change. The last field excludes a change to the pinned content, not live availability effects. Empty arrays are explicit.                                                                                                                                                                           |
| `ImportPreview`    | `missionId: MissionId`, `expectedMissionRevision: positive integer`, `scope: ImportScope`, `previewDigest: SHA256`, `creates: Text[]` (plan names), `updates: NodeId[]`, `retirements: NodeId[]`, `removedEdges: Edge[]`, `noOps: NodeId[]`, `violations: object[]`. Violation schemas remain **[blocked][mission-contract]**. The digest follows [canonical JSON](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-canonical-form-and-the-digest). No assigned final IDs are promised by preview. |
| `ImportResult`     | `requestId: RequestId`, `missionId: MissionId`, `missionRevision: positive integer`, `assignedIds: {name: Text, nodeId: NodeId}[]`, `changes: NodeChange`, `actor: Actor`, `acceptedAt: Timestamp`. The map covers the accepted set, including unchanged known nodes.                                                                                                                                                                                                                                                                        |
| `PriorityAct`      | `nodeId: NodeId`, `value: signed safe integer`, `actor: Actor`, `createdAt: Timestamp`. Ordering/correction identification is service-owned; no standalone priority entity prefix is declared.                                                                                                                                                                                                                                                                                                                                               |
| `ControlResult`    | `node: Node`, `attempt: Attempt \| null`, `outcome: Outcome \| null`, `taskOutcomeIds: OutcomeId[]`, `actor: Actor`, `acceptedAt: Timestamp`. Null means this act wrote no such record, not an unfinished implicit evaluation. Counter-zero outcomes remain **[blocked][mission-contract]**.                                                                                                                                                                                                                                                 |
| `UnblockRecord`    | `requestId: RequestId`, `nodeId: NodeId`, `clearedAttempt: positive integer \| null`, `openedAttempt: positive integer \| null`, `pinnedRevision: positive integer \| null`, `resultingRevision: positive integer`, `state: "Pending" \| "Available"`, `actor: Actor`, `createdAt: Timestamp`. The three nullable fields are null in the counter-zero case; no phantom attempt is created.                                                                                                                                                   |
| `Attempt`          | `nodeId: NodeId`, `attempt: positive integer`, `nodeRevision: positive integer`, `requiredExternalActions: FrozenAction[]`, `openedAt: Timestamp`, `closedAt: Timestamp \| null`, `executionEnded: boolean`, `outcomeIds: OutcomeId[]`, optional `unblockRequestId: RequestId`. No live configuration refresh rewrites this record's frozen facts.                                                                                                                                                                                           |
| `FrozenAction`     | `key: Key`, `bindingId: BindingId`, `expectedEndState: object`, `follows: Key \| null`, `configuration: object`. Action schemas remain **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#project-service)**; an execution supplies no arbitrary JSON. Initiative array is empty.                                                                                                                                                                                                                      |
| `Evidence`         | `id: EvidenceId`, `nodeId: NodeId`, `attempt: positive integer`, `nodeRevision: positive integer`, `subject: Text`, `scope: "node" \| "task"`, `address: Address`, `provenance: Actor`, `createdAt: Timestamp`, `redacted: boolean`; optional `redactionDescription: Text`, `correctsEvidenceId: EvidenceId`, `machineCheck: MachineCheck`. The latter fields have the same conditional requiredness as `EvidenceSubmit`. Retention metadata remains **[blocked][mission-contract]**.                                                        |
| `StoredContent`    | `evidenceId: EvidenceId`, `address: ProducedAddress`, `mediaType: Text`, `encoding: "base64"`, `data: string`. Repository-only evidence, expiry and exceptional credential removal require distinguishable typed failures; their status mapping remains **[blocked][mission-contract]**.                                                                                                                                                                                                                                                     |
| `RunOutput`        | All `RunOutputSubmit` fields plus `nodeId: NodeId`, `actor: Actor`, `acceptedAt: Timestamp`. Its natural key is `(nodeId, executionId)`, not an invented run-output ID.                                                                                                                                                                                                                                                                                                                                                                      |
| `Evaluation`       | `id: EvaluationId`, `nodeId: NodeId`, `attempt: positive integer`, `nodeRevision: positive integer`, `status: string`, `tries: EvaluationTry[]`, `assessmentIds: AssessmentId[]`. Evaluation status and retry budgets remain **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#policy-and-budgets)**.                                                                                                                                                                                                 |
| `EvaluationTry`    | `evaluationAttempt: positive integer`, `executionId: ExecutionId`, `startedAt: Timestamp`, `endedAt: Timestamp \| null`, `status: string`. Evaluation lifecycle schemas remain **[blocked][mission-recovery]**. A try never changes the owning node attempt.                                                                                                                                                                                                                                                                                 |
| `Currency`         | `current: boolean`, `contextMatches: boolean`, `authorityAdmits: boolean`, `orderSelected: boolean`, `reasons: Text[]`. These are proposed diagnostics of the three domain checks, not instructions to retry.                                                                                                                                                                                                                                                                                                                                |
| `Assessment`       | `id: AssessmentId`, `nodeId: NodeId`, all `AssessmentBody` fields, `actor: Actor`, `createdAt: Timestamp`, `currency: Currency`; `evaluationId: EvaluationId` and `evaluationAttempt: positive integer` required for node evaluation, absent for task assessment. `workerVersion: Text`, required when a base prompt fixes the default standard, otherwise optional.                                                                                                                                                                         |
| `AssessmentResult` | `assessment: Assessment`, `node: Node`, `outcome: Outcome \| null`. Null means no closure result from this accepted assessment; caller reads action/attempt state rather than fabricating success.                                                                                                                                                                                                                                                                                                                                           |
| `Outcome`          | `id: OutcomeId`, `nodeId: NodeId`, `attempt: positive integer`, `closingEvent: Text`, `stoppingReason: Text`, `result: Result`, `basis: OutcomeBasis`, `evidenceIds: EvidenceId[]`, `createdAt: Timestamp`; optional `previousOutcomeId: OutcomeId`, `observationId: ObservationId`. `observationId` is required when an `External.Failed` observation closes the outcome. The no-attempt form remains **[blocked][mission-contract]**; it uses no attempt 0.                                                                                |
| `OutcomeBasis`     | Either required `kind: "assessment"`, `assessmentId: AssessmentId`, `evaluationContext: object` (context schema **[blocked][mission-contract]**); or required `kind: "human-assertion"`, `actor: Actor`, `decision: Text`. `criterion-not-met` requires assessment basis. No third machinery-failure basis is approved.                                                                                                                                                                                                                      |
| `TaskResult`       | `assessment: Assessment`, `outcome: Outcome`. Both name the task and objective attempt/revision consistently.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ExternalAction`   | `nodeId: NodeId`, `attempt: positive integer`, `action: FrozenAction`, `requested: boolean`, `externalObjectIds: ExternalObjectId[]`, `observationIds: ObservationId[]`, `resolution: "unrequested" \| "unresolved" \| "expected-end" \| "other-end"`. These resolution spellings are proposed encodings.                                                                                                                                                                                                                                    |
| `ExternalObject`   | `id: ExternalObjectId`, `nodeId: NodeId`, `attempt: positive integer`, `actionKey: Key`, `bindingId: BindingId`, `address: Text`, `label: Text`, `actor: Actor`, `createdAt: Timestamp`; optional `reusesExternalObjectId: ExternalObjectId`. Representation is informative; no Mission rule uses it to infer success.                                                                                                                                                                                                                       |
| `Observation`      | `id: ObservationId`, `nodeId: NodeId`, `attempt: positive integer`, `actionKey: Key`, `expectedEndState: object`, `externalObjectId: ExternalObjectId`, `observedState: object`, `observedAt: Timestamp`, `observer: Actor`, `acceptedAt: Timestamp`, `landedCommits: RepositoryAddress[]`. Last array is empty for nonlanding/nonrepository observations. State and attribution schemas remain **[blocked][mission-contract]**.                                                                                                             |

Criterion pages also return required `contentOwnerId: NodeId` and `revision: positive integer` at page level.
Each page identifies the revision of its single criterion text, not an implicit latest human revision.

Task commits are internal evidence while a worker executes its objective; their
resolution is not guaranteed after landing. Landed objective commits, or stored
produced evidence, support the durable objective outcome. An initiative reads
objective outcomes and their evidence sets. Human success without a landed
commit stands on the human assertion, not an invented durable repository address.

## Operations deliberately outside this CLI inventory

These boundaries define legitimate public operations; they are not missing
aliases for internal mechanisms.

- Queue insertion/deletion in Mission's transaction, Scheduler wake-up,
  dependency rerouting, claim serialization, attempt opening/closure,
  assessment currency recomputation and missing-task-outcome completion are
  service responsibilities. There is no `mission reconcile`, `queue insert`,
  `attempt open`, `attempt close`, `evaluation retry` or `set-state` command.
- Claim, lease renewal, release, loss declaration and work pull belong to Scheduler.
  Worker registration and platform action performance belong to their owners.
  Mission records are not platform merge/push/notification commands.
- Accepted observations are written by authorized observers, including after
  release, without an execution claim. They are exposed here for reading. A
  generic human/client `observation submit` would manufacture authority not
  established by the current identity contracts. The observer uses the [service identity contract](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md#the-operation-and-its-two-entry-adapters).
  Background observation is no operator CLI action.
- Evidence retention and exceptional credential removal remain **[blocked][mission-contract]**. No evidence delete,
  purge or retention-sweep command is proposed. Corrections append through the
  authorized submission path and never rewrite history.
- Ordinary node outcomes are written by closing transitions. No unrestricted
  `outcome create/update`, human assessment impersonation, terminal correction
  or human failure override is exposed. The defined success override and discard
  have explicit authority and state restrictions. Non-success override precedence remains **[blocked][mission-recovery]**.
- Planning from external deliveries remains **[blocked](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md#scheduler-service-and-delivery)**. No
  client import or automatic inbound-message-to-node command is introduced.

## Optional design provenance

This specification is readable in a standalone engine checkout. These upstream
links are background provenance, not local runtime dependencies or evidence that
the proposed CLI has shipped:

- [Mission Service](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.md)
- [Mission vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/mission-service.vocabulary.md)
- [Overview](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/overview.md)
- [Overview vocabulary](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/overview.vocabulary.md)
- [Architecture mechanisms](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/architecture.impl.md)
- [Open design handoff](https://github.com/kanthorlabs/kanthord/blob/main/docs/brainstorm/HANDOFF.md)
