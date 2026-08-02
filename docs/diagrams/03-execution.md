# 03 — Execution

One objective, its clone, its runs and its tries. Owns [`workspace`](../proposal/database/workspace.md), [`run`](../proposal/database/run.md), [`attempt`](../proposal/database/attempt.md), [`agent_invocation`](../proposal/database/agent_invocation.md) and [`lease`](../proposal/database/lease.md).

The spine is one chain. An objective gets one clone. A run executes a node in that clone. A task run holds tries. A try holds model calls.

```mermaid
erDiagram
  node {
    TEXT id PK
  }
  repository {
    TEXT id PK
  }
  provider {
    TEXT id PK
  }
  workspace {
    TEXT id PK
    TEXT node_id FK,UK "the objective; its tasks share this clone"
    TEXT repository_id FK
    TEXT path "clone directory"
    TEXT clone_base_oid "landing tip cloned from"
    TEXT upstream_oid_at_clone
    TEXT profile_blob FK "pinned for the whole objective"
    TEXT convention_version "pinned; verified cannot be redefined"
    TEXT ambient_blob FK "repository root ambient file"
    TEXT state
    INTEGER updated_at
  }
  run {
    TEXT id PK
    TEXT kind "objective or task"
    TEXT node_id FK
    TEXT parent_run_id FK "null on an objective run"
    TEXT workspace_id FK
    TEXT worker "what actually resolved"
    INTEGER lease_fence "generation that authorized this epoch"
    INTEGER attempt_limit
    TEXT base_oid "abandon resets here"
    TEXT head_oid
    TEXT state "active or ended"
    TEXT outcome
    INTEGER ended_at
  }
  attempt {
    TEXT id PK
    TEXT run_id FK
    INTEGER attempt_no "from 1"
    TEXT provider_id FK "pinned for the whole try"
    TEXT provider_model "pinned for the whole try"
    INTEGER timeout_ms
    TEXT base_oid
    TEXT head_oid
    TEXT outcome
    INTEGER ended_at
  }
  agent_invocation {
    TEXT id PK
    TEXT attempt_id FK
    TEXT agent "general@1, swe@1, te@1 or re@1"
    TEXT adapter_version
    TEXT prompt_blob FK
    TEXT sources_json "channel to blob hash; not a FK"
    TEXT tool_definitions_blob FK
    TEXT tool_trace_blob FK
    TEXT diff_blob FK "null for a read-only role"
    TEXT verdict "re@1 only"
    TEXT reason_blob FK "re@1 only"
    TEXT usage_json
    TEXT error_blob FK
    INTEGER ended_at
  }
  lease {
    TEXT subject_kind PK "node or repository"
    TEXT subject_id PK "prefixed; no FK"
    TEXT owner "null means released"
    INTEGER fence "never reset"
    INTEGER acquired_at
    INTEGER renewed_at
    INTEGER expires_at
  }
  blob {
    TEXT hash PK
  }

  node       ||--o| workspace : "node_id"
  repository ||--o{ workspace : "repository_id"
  node       ||--o{ run : "node_id"
  workspace  ||--o{ run : "workspace_id"
  run        |o--o{ run : "parent_run_id"
  run        ||--o{ attempt : "run_id"
  provider   ||--o{ attempt : "provider_id"
  attempt    ||--o{ agent_invocation : "attempt_id"
  blob       ||--o{ workspace : "profile_blob, ambient_blob"
  blob       ||--o{ agent_invocation : "6 columns"

  lease }o..o| node : "subject_kind = 'node'"
  lease }o..o| repository : "subject_kind = 'repository'"
```

## The run tree

An objective run schedules task runs. `CHECK ((kind = 'objective') = (parent_run_id IS NULL))` holds that, so a task run always has a parent and an objective run never does.

```mermaid
erDiagram
  objective_run ||--o{ task_run : "parent_run_id"
  objective_run ||--|| workspace_row : "workspace_id, shared"
  task_run      ||--|| workspace_row : "workspace_id, the same clone"
  objective_run {
    TEXT kind "objective"
    TEXT parent_run_id "null, always"
  }
  task_run {
    TEXT kind "task"
    TEXT parent_run_id "an objective run"
  }
  workspace_row {
    TEXT node_id "the objective"
  }
```

Every run under one objective points at the same `workspace` row, because `workspace.node_id` is unique on the objective. No foreign key holds that a task run and its parent share a clone, so application code holds it.

## The fence

`lease` has no foreign key to anything, and two columns elsewhere carry its generation.

| Column                      | Lease it fences                                                 |
| --------------------------- | --------------------------------------------------------------- |
| `run.lease_fence`           | the `node` lease of the objective                               |
| `git_operation.lease_fence` | the `repository` lease, in [04](04-verification-integration.md) |

`fence` never resets, so a stale holder cannot write. The fence is the reason `lease` sits beside execution rather than in a diagram of its own. It is also why the same lease reaches integration.

## What the shape says

**One clone per objective.** `workspace.node_id` is `NOT NULL UNIQUE`. Every task of that objective works in that directory.

**The pin is on the clone, not on the run.** `profile_blob`, `convention_version` and `ambient_blob` freeze at clone time. A later profile edit cannot redefine what verified meant for this objective.

**A try pins one registration and one model.** `attempt.provider_id` and `attempt.provider_model` hold for the whole try. `UNIQUE (run_id, attempt_no)` makes the attempt counter exact, and `run.attempt_limit` is the limit in force for that execution rather than the current configuration.

**Two agents run in one try.** `agent_invocation` exists because one attempt holds more than one model call. `verdict` and `reason_blob` are `re@1` only, and `diff_blob` is null for a read-only role.

**`sources_json` is not a relation.** It maps a channel to a blob hash and a provenance label. No query searches by source blob, so no join table exists and no foreign key is declared.

**One active run per node.** `run.state` is `active` or `ended`, and a partial index holds the rule.

## Boundary

`node` belongs to [02-plan-graph](02-plan-graph.md). `repository` and `provider` belong to [01-registration](01-registration.md). `blob` belongs to [05-cross-cutting](05-cross-cutting.md).

A task-diagnostic `check_result` is attributed to a run through `check_result.run_id`. [04-verification-integration](04-verification-integration.md) owns that table and that edge. `authoritative = 0` marks the diagnostic, and it gates nothing.
