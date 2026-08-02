# 02 — Plan graph

The work tree, and the import that wrote it. Owns [`plan_revision`](../proposal/database/plan_revision.md), [`node`](../proposal/database/node.md) and [`edge`](../proposal/database/edge.md).

Two self-references carry this diagram. `node.parent_id` is containment. `plan_revision.parent_id` is import lineage. They are different trees over different things.

```mermaid
erDiagram
  project {
    TEXT id PK
  }
  repository {
    TEXT id PK
  }
  plan_revision {
    TEXT id PK
    TEXT project_id FK
    TEXT parent_id FK "revision the document was exported from"
    TEXT import_id "client idempotency key"
    TEXT submitted_blob FK "what the human sent"
    TEXT choices_blob FK "the per-node choice set"
    TEXT accepted_blob FK "the resulting graph, canonical"
  }
  node {
    TEXT id PK "initiative_, objective_ or task_"
    TEXT project_id FK
    TEXT kind "initiative, objective or task"
    TEXT parent_id FK "null only on an initiative"
    TEXT title
    TEXT instruction_blob FK
    TEXT acceptance_blob FK "tasks only"
    TEXT worker "overrides project.worker"
    TEXT repository_id FK "objectives only"
    TEXT state
    TEXT block_reason "set only while blocked"
    TEXT discard_reason
    TEXT revision FK "revision that last wrote this row"
    INTEGER updated_at
  }
  edge {
    TEXT id PK
    TEXT from_node FK "the dependent node"
    TEXT to_node FK "must reach done or partial first"
    INTEGER waived_at "readiness then ignores the row"
  }
  blob {
    TEXT hash PK
  }

  project       ||--o{ plan_revision : "project_id"
  project       ||--o{ node : "project_id"
  plan_revision |o--o{ plan_revision : "parent_id"
  plan_revision ||--o{ node : "revision"
  node          |o--o{ node : "parent_id"
  repository    |o--o{ node : "repository_id"
  node          ||--o{ edge : "from_node"
  node          ||--o{ edge : "to_node"
  blob          ||--o{ node : "instruction_blob, acceptance_blob"
  blob          ||--o{ plan_revision : "submitted_blob, choices_blob, accepted_blob"
```

## The containment tree

`node` holds three levels in one table, and the `CHECK` clauses tie each level to its own columns.

```mermaid
erDiagram
  initiative ||--o{ objective : "parent_id"
  objective  ||--o{ task : "parent_id"
  initiative {
    TEXT id "initiative_ULID"
    TEXT parent_id "null, always"
    TEXT repository_id "null"
    TEXT acceptance_blob "null"
  }
  objective {
    TEXT id "objective_ULID"
    TEXT parent_id "an initiative"
    TEXT repository_id "NOT NULL"
    TEXT acceptance_blob "null"
  }
  task {
    TEXT id "task_ULID"
    TEXT parent_id "an objective"
    TEXT repository_id "null"
    TEXT acceptance_blob "NOT NULL"
  }
```

Four `CHECK` clauses hold that shape, and each is an equality rather than an implication.

- `(kind = 'initiative') = (parent_id IS NULL)`
- `(kind = 'objective') = (repository_id IS NOT NULL)`
- `(kind = 'task') = (acceptance_blob IS NOT NULL)`
- `state <> 'awaiting_approval' OR kind = 'objective'`, and `state <> 'partial' OR kind <> 'task'`

The id prefix repeats the kind. A reference to the wrong level is visible in plan frontmatter, in a `depends_on` list and in a log line, with no lookup.

## What the shape says

**`edge` is dependency, never containment.** Containment lives in `parent_id`. `edge` connects two siblings, and no foreign key holds that rule. `UNIQUE (from_node, to_node)` blocks a duplicate, and `CHECK (from_node <> to_node)` blocks a self-edge. Neither blocks a cycle, so the import checks it.

**A waive is a column, not a delete.** `edge.waived_at` keeps the row and removes it from readiness, so the decision stays auditable.

**Every node names the revision that wrote it.** `node.revision` is `NOT NULL`. The concurrency check reads `plan_revision.parent_id`, and `UNIQUE (project_id, import_id)` makes a retry return the same revision.

**`ORDER BY id` is not creation order in `node`.** Three prefixes sort before each other bytewise. Creation order holds inside one kind, which is what the tie-break of the state machine compares. Creation order across kinds comes from `event`.

## Boundary

`project` and `repository` are reference nodes. [01-registration](01-registration.md) owns them. `blob` is a reference node. [05-cross-cutting](05-cross-cutting.md) owns it.
