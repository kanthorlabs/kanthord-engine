# Database

Reviewer: architect or tech lead, with whoever owns the database. Phase 1. This directory expands the storage section of [../phase-1/domain.md](../phase-1/domain.md) to column level.

Read [../phase-1/domain.md](../phase-1/domain.md) first. It names the entities. These files store them.

One file per table. Every table file holds the question the table answers, its `CREATE TABLE` with a comment per column, and the rules that column set implies. This file holds everything that is true across tables.

## Tables

| Table                                     | Question it answers                                                                                                                                             |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`migration`](migration.md)               | is this database at the schema version the binary expects?                                                                                                      |
| [`actor`](actor.md)                       | who may act, and is that principal still allowed to?                                                                                                            |
| [`blob`](blob.md)                         | which exact immutable payload did another row cite — a prompt, a profile, a plan document, a diff, a tool trace, a check log, an evidence document or an error? |
| [`provider`](provider.md)                 | which external accounts are registered, and what does each one need to connect?                                                                                 |
| [`project`](project.md)                   | which worker kind and which end-to-end binding does work under this project inherit?                                                                            |
| [`project_binding`](project_binding.md)   | which globally registered resources does this project use?                                                                                                      |
| [`repository`](repository.md)             | where does this code live, which branch lands work, and is the repository safe to clone from right now?                                                         |
| [`profile`](profile.md)                   | how is this repository verified, and what prose governs an agent that works in it?                                                                              |
| [`node`](node.md)                         | what is the work, where does it sit in the tree, and what state is it in?                                                                                       |
| [`edge`](edge.md)                         | what must finish before this node becomes ready?                                                                                                                |
| [`plan_revision`](plan_revision.md)       | which import produced the graph as it stands now, and did the document in my hand come from that same import?                                                   |
| [`workspace`](workspace.md)               | which clone do the tasks of this objective work in, and what was pinned for them?                                                                               |
| [`lease`](lease.md)                       | is anyone working on this subject right now, and is that claim still valid?                                                                                     |
| [`run`](run.md)                           | which execution of this node is this one — which worker ran it, under which lease generation, from which base commit, and how did it end?                       |
| [`attempt`](attempt.md)                   | which try is this, and which account and provider_model did it use?                                                                                             |
| [`agent_invocation`](agent_invocation.md) | what exactly did one model call receive, and what did it return?                                                                                                |
| [`candidate`](candidate.md)               | what exactly am I approving, and is it still what is there?                                                                                                     |
| [`check_result`](check_result.md)         | which command ran against which commit or manifest, and what did it decide?                                                                                     |
| [`git_operation`](git_operation.md)       | a git ref write did not finish. Did it happen?                                                                                                                  |
| [`event`](event.md)                       | what happened, in order, and who decided it?                                                                                                                    |

## Conventions

- Storage is `node:sqlite`. Every table is `STRICT`, so a column type is enforced rather than advisory.
- `PRAGMA foreign_keys = ON`. `PRAGMA journal_mode = WAL`. `PRAGMA synchronous = FULL`, because the recovery matrix of [../phase-3/recovery.md](../phase-3/recovery.md) kills the process at a durable boundary.
- Every id is an entity prefix, an underscore and a ULID, in a `TEXT` column: `project_01J9Z…`. The only exception is `migration.version`.
- A ULID carries its creation time. No table holds a `created_at` column where the primary key is a ULID, because the id already answers it. A reader decodes the ULID part of the id.
- `ORDER BY id` is creation order in every table that mints one prefix, and a time range filter compares against a constructed boundary id, because the prefix is constant and the ULID encoding sorts lexicographically. `node` mints one prefix per kind and is the one exception. See "Id prefixes" below.
- `blob` is keyed by a content hash and `project_binding` by a composite key, so those two carry `created_at`.
- A row that models an execution starts when it is inserted, so the id is also the start time. `ended_at` stays, because a duration needs both ends.
- Every other timestamp is an integer of epoch milliseconds, and it exists only where a ULID cannot answer: `updated_at`, and every named decision time such as `approved_at` or `waived_at`.
- A column that names a git object holds the full 40-character or 64-character object id. The suffix is `_oid`.
- A column that ends in `_blob` holds a `blob.hash`. A column that ends in `_json` holds a small fixed-shape document.
- One command is one transaction.

## Id prefixes

One prefix per entity. A foreign key column holds the prefixed value, so every id says what it is, in a log line, in an HTTP payload and in plan frontmatter.

| Table              | Prefix                                        |
| ------------------ | --------------------------------------------- |
| `provider`         | `provider_`                                   |
| `project`          | `project_`                                    |
| `repository`       | `repo_`                                       |
| `profile`          | `profile_`                                    |
| `node`             | by kind: `initiative_`, `objective_`, `task_` |
| `edge`             | `edge_`                                       |
| `plan_revision`    | `revision_`                                   |
| `workspace`        | `workspace_`                                  |
| `run`              | `run_`                                        |
| `attempt`          | `attempt_`                                    |
| `agent_invocation` | `invocation_`                                 |
| `candidate`        | `candidate_`                                  |
| `check_result`     | `check_`                                      |
| `git_operation`    | `gitop_`                                      |
| `event`            | `event_`                                      |

`blob` is keyed by a content hash, `migration` by a version, and `project_binding` by a project, a kind and a target, so none of the three mints an id.

`node` takes three prefixes, one per kind. A node id therefore names its level in plan frontmatter, in a `depends_on` list, in a CLI argument and in a log line, so a reference to the wrong level is visible without a lookup. The `kind` column stays, because a `CHECK` clause needs it.

`node` is the one table where `ORDER BY id` is not creation order. A byte comparison puts every `initiative_` before every `objective_` before every `task_`, and each group holds creation order inside itself. Two consequences, both accepted:

- The tie-break of [state-machine.md](../phase-1/state-machine.md) is unaffected. It compares two tasks under one objective, so both ids carry the `task_` prefix, and the sort lands on creation order.
- Creation order across kinds comes from `event`, which keeps one prefix and one total order. No query of this proposal reads creation order across kinds from `node`, and `status` walks containment rather than time.

A prefix makes a polymorphic column self-describing. `lease.subject_id`, `check_result.subject_id`, `event.subject_id` and `project_binding.target_id` keep their kind column for a `CHECK` clause and an index, and the prefix makes a mismatched value visible without a join.

## Verdict on the tables of domain.md

| Table              | Verdict                    | Reason                                                                      |
| ------------------ | -------------------------- | --------------------------------------------------------------------------- |
| `credential`       | **merged into `provider`** | One registration holds one credential, and no other entity holds a secret   |
| `provider`         | keep, generalized          | One external account per row: a name, a kind, and one encrypted payload     |
| `provider_binding` | **removed**                | The global chain is `provider.set_default_at`; narrower scopes are bindings |
| `repository`       | keep                       | Three branch fields, the divergence state, the publish default              |
| `project`          | keep                       | The scope of the provider list, the worker default, the deferred e2e bind   |
| `project_binding`  | **added**                  | A project binds a global resource. `kind = 'git'` binds a repository        |
| `profile`          | keep, points at a blob     | The whole document is content addressed, so a pinned hash stays readable    |
| `blob`             | keep, widened              | The one store for every payload an audit must reproduce                     |
| `node`             | keep                       | Containment through `parent_id`, one repository on an objective             |
| `edge`             | keep                       | Dependency only, and it carries the waive decision                          |
| `plan_revision`    | keep, reshaped             | Import lineage, the concurrency check, and an idempotency key               |
| `workspace`        | keep                       | One per objective, and it pins the profile and the ambient file             |
| `lease`            | keep, generalized          | One mechanism for the objective lease and the repository lock               |
| `run`              | keep, two kinds            | One execution epoch: the resolved worker, the lease fence, the base         |
| `attempt`          | keep, narrowed             | One task try, one pinned registration, one attempt counter                  |
| `agent_invocation` | **added**                  | One model call inside an attempt, because two agents run in one try         |
| `candidate`        | keep, freezes evidence     | The approval subject, with its own revision and its own invalidation        |
| `check_result`     | keep, broadened            | A command run, at any level, with an explicit result value                  |
| `git_operation`    | renamed from `operation`   | The journal of every git ref write, local and remote                        |
| `event`            | keep                       | Append only, ordered by its ULID                                            |
| `migration`        | **added**                  | `db status` is a phase 1 deliverable and `npm run verify` calls it          |

Twenty tables. `migration` is infrastructure and not a domain entity, so the domain count is nineteen.

## Tables that do not exist

| Rejected              | Reason                                                                                                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential`          | A registration holds exactly one credential, and nothing else in the schema holds a secret. The fields live on `provider`.                                                                                                                     |
| `provider_binding`    | A scope table whose global row was always `('global', 'global')`. The global chain is `provider.set_default_at`, a project chain is a `project_binding` row of `kind = 'provider'`, and the agent chain gets `agent_binding` when it is built. |
| `template`            | Templates ship in the code. Only the instantiated profile reaches the database.                                                                                                                                                                |
| `approval`            | An approval is one immutable transition of one candidate. The fields live on `candidate`.                                                                                                                                                      |
| `profile_version`     | The whole profile document is a blob keyed by its own hash, so every version is already immutable.                                                                                                                                             |
| `task_base`           | A task run records its base object id, and one partial index keeps one active run per node.                                                                                                                                                    |
| `attempt_source_blob` | `agent_invocation.sources_json` maps a channel to a blob hash and a provenance label. No query searches by source blob.                                                                                                                        |

## Invariants the schema does not enforce

A `CHECK` clause holds a rule inside one row, and a foreign key holds a rule between two tables. These rules need application code, and each one needs a test:

- `lease.subject_id`, `check_result.subject_id`, `event.subject_id` and `project_binding.target_id` are polymorphic, so they have no foreign key.
- A dependency edge connects two siblings.
- The repository of an objective is bound to the project of that objective, through a `project_binding` row of `kind = 'git'`.
- A task run has an objective run as its parent, and an objective run has none.
- The aggregation table of [state-machine.md](../phase-1/state-machine.md) crosses rows, so the transition command computes a parent state from its children.
- A blob is not deleted while a row references it.
- Every id is minted by the ULID generator of one process, so a creation time is only as good as the clock of the daemon host. That is the same guarantee a `created_at` column had.

## Accepted trade-offs

- **The secret sits on `provider`.** A separate `credential` table would give a narrower access boundary and a place for a re-encryption lifecycle. The MVP has one credential per registration, no rotation, and no second consumer, so the join buys nothing today. The cost is that every read of `provider` must name its columns. Key rotation is deferred, and it will add a key version migration over this table rather than a new table.
- **A creation time is read from the id.** No table repeats it in a column. The cost is that a reader decodes a ULID, and that a time range query constructs a boundary ULID rather than comparing an integer. The gain is one truth for creation order and creation time.
- **`sources_json` is a column, not a table.** Prompt provenance is written once, read whole, and never searched by source. A join table would add a relation with no query behind it.
- **`profile` keeps no derived columns.** Every reader parses the pinned document. That is one parse on a read path in exchange for one truth about what a check command was.
