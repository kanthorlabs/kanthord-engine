# 00 — Overview

Every table, and every table-to-table dependency. A column-level edge belongs to a detail diagram. Read this one for orientation.

Two tables hold no relation to the others. `migration` records the schema version. `event` names any entity through a polymorphic column, so it appears in [05-cross-cutting](05-cross-cutting.md).

```mermaid
erDiagram
  provider      ||--o{ repository : "credential_id"
  provider      ||--o{ attempt : "provider_id"
  project       ||--o{ project_binding : "project_id"
  project       ||--o{ node : "project_id"
  project       ||--o{ plan_revision : "project_id"
  repository    ||--o| profile : "repository_id"
  repository    |o--o{ node : "repository_id"
  repository    ||--o{ workspace : "repository_id"
  repository    ||--o{ git_operation : "repository_id"
  plan_revision ||--o{ node : "revision"
  plan_revision |o--o{ plan_revision : "parent_id"
  node          |o--o{ node : "parent_id"
  node          ||--o{ edge : "from_node, to_node"
  node          ||--o| workspace : "node_id"
  node          ||--o{ run : "node_id"
  node          ||--o{ candidate : "node_id"
  node          |o--o{ check_result : "node_id"
  node          |o--o{ git_operation : "node_id"
  workspace     ||--o{ run : "workspace_id"
  workspace     ||--o{ candidate : "workspace_id"
  run           |o--o{ run : "parent_run_id"
  run           ||--o{ attempt : "run_id"
  run           ||--o{ candidate : "run_id"
  run           |o--o{ check_result : "run_id"
  run           |o--o{ git_operation : "run_id"
  attempt       ||--o{ agent_invocation : "attempt_id"
  candidate     |o--o{ git_operation : "candidate_id"
  blob          ||--o{ profile : "1 column"
  blob          ||--o{ node : "2 columns"
  blob          ||--o{ plan_revision : "3 columns"
  blob          ||--o{ workspace : "2 columns"
  blob          ||--o{ agent_invocation : "6 columns"
  blob          ||--o{ candidate : "2 columns"
  blob          ||--o{ check_result : "3 columns"
  blob          ||--o{ git_operation : "1 column"
  migration {
    INTEGER version PK
  }
  lease {
    TEXT subject_kind PK
    TEXT subject_id PK
  }
  event {
    TEXT id PK
  }
```

## The four relations with no foreign key

The diagram above draws foreign keys only. Four relations are real, and the database enforces none of them. Each one needs a test.

```mermaid
erDiagram
  lease           }o..o| node : "subject_kind = 'node'"
  lease           }o..o| repository : "subject_kind = 'repository'"
  project_binding }o..o| repository : "kind = 'git'"
  project_binding }o..o| provider : "kind = 'provider'"
  check_result    }o..o| candidate : "subject_kind = 'candidate'"
  check_result    }o..o| git_operation : "subject_kind = 'merge'"
  event           }o..o| node : "subject_id, any entity"
```

A prefixed id makes each polymorphic value self-describing. `lease.subject_id` holds `node_`-kind or `repo_`. `project_binding.target_id` holds `repo_` or `provider_`. `check_result.subject_id` holds `candidate_` or `gitop_`. `event.subject_id` holds any prefix, and `event.subject_kind` carries no `CHECK` clause.

## Where each table is owned

| Table                                                             | Owner                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `provider`, `project`, `project_binding`, `repository`, `profile` | [01-registration](01-registration.md)                         |
| `plan_revision`, `node`, `edge`                                   | [02-plan-graph](02-plan-graph.md)                             |
| `workspace`, `run`, `attempt`, `agent_invocation`, `lease`        | [03-execution](03-execution.md)                               |
| `candidate`, `check_result`, `git_operation`                      | [04-verification-integration](04-verification-integration.md) |
| `blob`, `event`                                                   | [05-cross-cutting](05-cross-cutting.md)                       |
| `migration`                                                       | this file; it holds no relation                               |
